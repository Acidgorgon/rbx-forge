// Forge Sync wire protocol between the Forge Bridge plugin (resources/studio/ForgeBridge.luau) and
// Forge's bridge server (main/services/studio/bridge.ts):
//
//   GET  /forge-bridge/sync/config?placeId=&gameId=&place=  -> SyncConfig ({ enabled:false } when off)
//   POST /forge-bridge/sync/snapshot  SnapshotBody  -> SyncReply   (chunked: seq 0.., last has final)
//   POST /forge-bridge/sync/changes   ChangesBody   -> SyncReply   (debounced by the plugin)
//   POST /forge-bridge/sync/outline   OutlineBody   -> SyncReply   (plugin v5: Game-tab outline of the
//        config's `outline` containers outside the synced roots; debounced, re-sent only when changed)
//
// SyncReply is { ok: true } or { ok: false, error, resend?: true }; resend asks the plugin for a fresh
// full snapshot. Everything that arrives is checked here (pure, no I/O) before main sees it: shapes,
// sizes and bounds, so a broken or hostile client cannot hand the engine odd paths or huge strings.

import type { StudioChange, StudioNode, StudioOutlineNode, SyncPlace, SyncRef, SyncValue } from './types.ts'

export interface SyncConfigQuery {
  placeId: number
  gameId?: number
  place?: string
  // Plugin v8: the place's ForgeSyncLink attribute (unpublished places linked in Forge), and a random
  // id per plugin run so two unlinked places with the same name are told apart.
  link?: string
  probe?: string
}

export interface SyncConfig {
  enabled: boolean
  sessionToken?: string
  roots?: string[][]
  skip?: string[][]
  // Plugin v5: containers (top-level services the project maps) to outline for the Game tab, and the
  // most nodes to send. Older plugins ignore both.
  outline?: string[][]
  outlineMax?: number
  // Plugin v8, with enabled false: the user linked this (unpublished) place in Forge; the plugin stores
  // this id as ServerStorage's ForgeSyncLink attribute and asks for config again.
  stampLink?: string
}

export interface OutlineBody {
  session: string
  place: SyncPlace
  nodes: StudioOutlineNode[]
  // The plugin stopped at outlineMax nodes (or its depth limit).
  truncated?: boolean
}

export interface SnapshotBody {
  session: string
  place: SyncPlace
  seq: number
  final: boolean
  nodes: StudioNode[]
  // Instance-reference properties seen (not synced). A snapshot's chunks add up; refsTotal (sent with
  // the final chunk) counts every one found, including those over the plugin's cap.
  refs?: SyncRef[]
  refsTotal?: number
}

export interface ChangesBody {
  session: string
  place: SyncPlace
  changes: StudioChange[]
  // When present: the place's complete current list of references (replaces the previous one).
  refs?: SyncRef[]
  refsTotal?: number
}

export type SyncReply = { ok: true } | { ok: false; error: string; resend?: true }

export interface SyncHandler {
  config(q: SyncConfigQuery): Promise<SyncConfig>
  snapshot(body: SnapshotBody): Promise<SyncReply>
  changes(body: ChangesBody): Promise<SyncReply>
  outline?(body: OutlineBody): Promise<SyncReply>
}

// ---- bounds ----
export const SYNC_LIMITS = {
  // A single script's Source (UTF-8 bytes). Larger scripts are sent with `oversize: true` and no source.
  maxSource: 2 * 1024 * 1024,
  // Request body for /sync/* (the plugin aims for ~200 KB chunks; one big script may travel alone).
  maxBody: 6 * 1024 * 1024,
  maxDepth: 64,
  maxName: 256,
  maxId: 64,
  maxSession: 128,
  maxNodes: 5000,
  maxChanges: 5000,
  maxKeys: 200,
  maxKey: 128,
  maxValue: 64 * 1024,
  maxTags: 100,
  maxTag: 128,
  maxPlaceName: 200,
  maxRefs: 500,
  // Game-tab outline nodes per body (the plugin is asked for OUTLINE_MAX, see service.ts).
  maxOutline: 5000,
  maxOutlineProps: 8,
  maxOutlineProp: 1024
} as const

const CLASS_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/
const RUN_CONTEXTS = new Set(['Server', 'Client', 'Plugin'])

export class SyncProtocolError extends Error {}

const fail = (msg: string): never => {
  throw new SyncProtocolError(msg)
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

function str(v: unknown, what: string, max: number, min = 1): string {
  if (typeof v !== 'string') return fail(`${what} must be a string`)
  if (v.length < min || v.length > max) return fail(`${what} must be ${min}-${max} characters`)
  return v
}

function int(v: unknown, what: string, min = 0): number {
  if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min) return fail(`${what} must be an integer >= ${min}`)
  return v
}

export function parsePath(v: unknown, what = 'path'): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > SYNC_LIMITS.maxDepth) return fail(`${what} must be 1-${SYNC_LIMITS.maxDepth} names`)
  return v.map((n, i) => {
    const name = str(n, `${what}[${i}]`, SYNC_LIMITS.maxName)
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f]/.test(name)) fail(`${what}[${i}] has control characters`)
    return name
  })
}

export function utf8Length(s: string): number {
  let n = 0
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    if (c < 0x80) n += 1
    else if (c < 0x800) n += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      n += 4
      i++
    } else n += 3
  }
  return n
}

function parseValue(v: unknown, what: string): SyncValue {
  if (typeof v === 'string') {
    if (v.length > SYNC_LIMITS.maxValue) fail(`${what} is too long`)
    return v
  }
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) fail(`${what} must be finite`)
    return v
  }
  if (isObj(v)) {
    const keys = Object.keys(v)
    if (keys.length !== 1 || !CLASS_RE.test(keys[0])) fail(`${what} must be { <RojoType>: value }`)
    if (JSON.stringify(v).length > SYNC_LIMITS.maxValue) fail(`${what} is too large`)
    return v as SyncValue
  }
  return fail(`${what} has an unsupported type`)
}

function parseValues(v: unknown, what: string): Record<string, SyncValue> {
  if (!isObj(v)) return fail(`${what} must be an object`)
  const keys = Object.keys(v)
  if (keys.length > SYNC_LIMITS.maxKeys) fail(`${what} has too many keys`)
  const out: Record<string, SyncValue> = {}
  for (const k of keys) {
    str(k, `${what} key`, SYNC_LIMITS.maxKey)
    out[k] = parseValue(v[k], `${what}.${k}`)
  }
  return out
}

export function parseNode(v: unknown, what = 'node'): StudioNode {
  if (!isObj(v)) return fail(`${what} must be an object`)
  const node: StudioNode = {
    id: str(v.id, `${what}.id`, SYNC_LIMITS.maxId),
    path: parsePath(v.path, `${what}.path`),
    className: CLASS_RE.test(String(v.className)) && typeof v.className === 'string' ? v.className : fail(`${what}.className is not a class name`)
  }
  if (v.source !== undefined) {
    if (typeof v.source !== 'string') fail(`${what}.source must be a string`)
    const source = v.source as string
    // Cheap upper bound first (UTF-8 is at most 3 bytes per UTF-16 unit).
    if (source.length > SYNC_LIMITS.maxSource || (source.length * 3 > SYNC_LIMITS.maxSource && utf8Length(source) > SYNC_LIMITS.maxSource)) {
      fail(`${what}.source is over ${SYNC_LIMITS.maxSource / 1024 / 1024} MB`)
    }
    node.source = source
  }
  if (v.oversize !== undefined) {
    if (v.oversize !== true) fail(`${what}.oversize must be true`)
    if (node.source !== undefined) fail(`${what} is oversize but has a source`)
    node.oversize = true
  }
  if (v.runContext !== undefined) {
    if (!RUN_CONTEXTS.has(v.runContext as string)) fail(`${what}.runContext must be Server, Client or Plugin`)
    node.runContext = v.runContext as StudioNode['runContext']
  }
  if (v.properties !== undefined) node.properties = parseValues(v.properties, `${what}.properties`)
  if (v.attributes !== undefined) node.attributes = parseValues(v.attributes, `${what}.attributes`)
  if (v.tags !== undefined) {
    if (!Array.isArray(v.tags) || v.tags.length > SYNC_LIMITS.maxTags) fail(`${what}.tags must be up to ${SYNC_LIMITS.maxTags} strings`)
    node.tags = (v.tags as unknown[]).map((t, i) => str(t, `${what}.tags[${i}]`, SYNC_LIMITS.maxTag))
  }
  return node
}

function parseNodes(v: unknown, what: string, max: number): StudioNode[] {
  if (!Array.isArray(v) || v.length > max) return fail(`${what} must be an array of up to ${max} nodes`)
  return v.map((n, i) => parseNode(n, `${what}[${i}]`))
}

export function parsePlace(v: unknown): SyncPlace {
  if (!isObj(v)) return fail('place must be an object')
  const place: SyncPlace = { placeId: int(v.placeId, 'place.placeId') }
  if (v.gameId !== undefined) place.gameId = int(v.gameId, 'place.gameId')
  if (v.name !== undefined) place.name = str(v.name, 'place.name', SYNC_LIMITS.maxPlaceName, 0)
  return place
}

export function parseChange(v: unknown, what = 'change'): StudioChange {
  if (!isObj(v)) return fail(`${what} must be an object`)
  switch (v.kind) {
    case 'source':
    case 'props':
      return { kind: v.kind, node: parseNode(v.node, `${what}.node`) }
    case 'added': {
      const change: StudioChange = { kind: 'added', node: parseNode(v.node, `${what}.node`) }
      if (v.descendants !== undefined) change.descendants = parseNodes(v.descendants, `${what}.descendants`, SYNC_LIMITS.maxNodes)
      return change
    }
    case 'removed':
      return { kind: 'removed', id: str(v.id, `${what}.id`, SYNC_LIMITS.maxId), path: parsePath(v.path, `${what}.path`) }
    case 'renamed':
    case 'moved':
      return { kind: v.kind, id: str(v.id, `${what}.id`, SYNC_LIMITS.maxId), from: parsePath(v.from, `${what}.from`), node: parseNode(v.node, `${what}.node`) }
    default:
      return fail(`${what}.kind is unknown`)
  }
}

const PROP_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/

export function parseRefs(v: unknown, what = 'refs'): SyncRef[] {
  if (!Array.isArray(v) || v.length > SYNC_LIMITS.maxRefs) return fail(`${what} must be an array of up to ${SYNC_LIMITS.maxRefs}`)
  return v.map((r, i) => {
    if (!isObj(r)) return fail(`${what}[${i}] must be an object`)
    if (typeof r.property !== 'string' || !PROP_RE.test(r.property)) fail(`${what}[${i}].property is not a property name`)
    return { path: parsePath(r.path, `${what}[${i}].path`), property: r.property as string }
  })
}

// Optional refs / refsTotal on a snapshot or changes body.
function withRefs<T extends { refs?: SyncRef[]; refsTotal?: number }>(out: T, v: Record<string, unknown>): T {
  if (v.refs !== undefined) out.refs = parseRefs(v.refs)
  if (v.refsTotal !== undefined) {
    out.refsTotal = int(v.refsTotal, 'refsTotal')
    if (out.refs && out.refsTotal < out.refs.length) fail('refsTotal is smaller than refs')
  }
  return out
}

export function parseSnapshotBody(v: unknown): SnapshotBody {
  if (!isObj(v)) return fail('body must be an object')
  if (typeof v.final !== 'boolean') fail('final must be a boolean')
  return withRefs<SnapshotBody>(
    {
      session: str(v.session, 'session', SYNC_LIMITS.maxSession),
      place: parsePlace(v.place),
      seq: int(v.seq, 'seq'),
      final: v.final as boolean,
      nodes: parseNodes(v.nodes, 'nodes', SYNC_LIMITS.maxNodes)
    },
    v
  )
}

export function parseChangesBody(v: unknown): ChangesBody {
  if (!isObj(v)) return fail('body must be an object')
  if (!Array.isArray(v.changes) || v.changes.length > SYNC_LIMITS.maxChanges) fail(`changes must be an array of up to ${SYNC_LIMITS.maxChanges}`)
  let total = 0
  const changes = (v.changes as unknown[]).map((c, i) => {
    const change = parseChange(c, `changes[${i}]`)
    if (change.kind === 'added') total += change.descendants?.length ?? 0
    return change
  })
  if (total > SYNC_LIMITS.maxNodes) fail(`changes carry more than ${SYNC_LIMITS.maxNodes} descendants`)
  return withRefs<ChangesBody>({ session: str(v.session, 'session', SYNC_LIMITS.maxSession), place: parsePlace(v.place), changes }, v)
}

function parseOutlineNode(v: unknown, what: string): StudioOutlineNode {
  if (!isObj(v)) return fail(`${what} must be an object`)
  const node: StudioOutlineNode = {
    path: parsePath(v.path, `${what}.path`),
    className: typeof v.className === 'string' && CLASS_RE.test(v.className) ? v.className : fail(`${what}.className is not a class name`)
  }
  if (v.props !== undefined) {
    if (!isObj(v.props)) fail(`${what}.props must be an object`)
    const keys = Object.keys(v.props as object)
    if (keys.length > SYNC_LIMITS.maxOutlineProps) fail(`${what}.props has too many keys`)
    const props: Record<string, string> = {}
    for (const k of keys) {
      if (!PROP_RE.test(k)) fail(`${what}.props key is not a property name`)
      props[k] = str((v.props as Record<string, unknown>)[k], `${what}.props.${k}`, SYNC_LIMITS.maxOutlineProp, 0)
    }
    if (keys.length) node.props = props
  }
  return node
}

export function parseOutlineBody(v: unknown): OutlineBody {
  if (!isObj(v)) return fail('body must be an object')
  if (!Array.isArray(v.nodes) || v.nodes.length > SYNC_LIMITS.maxOutline) fail(`nodes must be an array of up to ${SYNC_LIMITS.maxOutline}`)
  const body: OutlineBody = {
    session: str(v.session, 'session', SYNC_LIMITS.maxSession),
    place: parsePlace(v.place),
    nodes: (v.nodes as unknown[]).map((n, i) => parseOutlineNode(n, `nodes[${i}]`))
  }
  if (v.truncated !== undefined) {
    if (typeof v.truncated !== 'boolean') fail('truncated must be a boolean')
    if (v.truncated) body.truncated = true
  }
  return body
}

// Link ids and probe ids: GUID-ish tokens (HttpService:GenerateGUID(false) / randomUUID()).
export const LINK_ID_RE = /^[A-Za-z0-9-]{8,64}$/

// Query string of GET /sync/config. placeId is required (0 for an unpublished place).
export function parseConfigQuery(params: URLSearchParams): SyncConfigQuery {
  const raw = params.get('placeId')
  const placeId = raw === null || raw === '' ? NaN : Number(raw)
  if (!Number.isSafeInteger(placeId) || placeId < 0) return fail('placeId must be an integer >= 0')
  const q: SyncConfigQuery = { placeId }
  const gameRaw = params.get('gameId')
  if (gameRaw !== null && gameRaw !== '') {
    const gameId = Number(gameRaw)
    if (!Number.isSafeInteger(gameId) || gameId < 0) fail('gameId must be an integer >= 0')
    q.gameId = gameId
  }
  const place = params.get('place')
  if (place) q.place = place.slice(0, SYNC_LIMITS.maxPlaceName)
  const link = params.get('link')
  if (link && LINK_ID_RE.test(link)) q.link = link
  const probe = params.get('probe')
  if (probe && LINK_ID_RE.test(probe)) q.probe = probe
  return q
}

// What the bridge sends back for config; strips anything the plugin does not need and keeps it sane.
export function sanitizeConfig(c: SyncConfig): SyncConfig {
  if (!c.enabled) return c.stampLink && LINK_ID_RE.test(c.stampLink) ? { enabled: false, stampLink: c.stampLink } : { enabled: false }
  const paths = (list: string[][] | undefined) => (list ?? []).filter((p) => Array.isArray(p) && p.length > 0 && p.every((n) => typeof n === 'string'))
  const out: SyncConfig = { enabled: true, sessionToken: String(c.sessionToken ?? ''), roots: paths(c.roots), skip: paths(c.skip) }
  if (c.outline?.length) {
    out.outline = paths(c.outline)
    out.outlineMax = Math.max(1, Math.min(SYNC_LIMITS.maxOutline, Math.floor(Number(c.outlineMax) || SYNC_LIMITS.maxOutline)))
  }
  return out
}
