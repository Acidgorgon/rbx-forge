// Insert jobs (Forge Bridge plugin v14): a Roblox model file (.rbxm / .rbxmx) that an agent dropped in
// the model inbox (<id>.insert.json, main/services/art/modelInsert.ts) is put into the linked Studio
// place by the plugin, inside a ChangeHistoryService recording (Ctrl+Z in Studio undoes it).
//
// How the file gets into Studio: a plugin cannot read files from disk, and the ways Studio can load a
// local file itself do not fit (InsertService:LoadLocalAsset is not available to plugins;
// game:GetObjects only takes asset ids or rbxasset:// paths inside Studio's own install folder).
// So Forge serves the file's bytes on the bridge it already runs on 127.0.0.1 (GET
// /forge-bridge/blob/<jobId>/bytes/<i>, base64 chunks: HttpService bodies are text, and one poll answer
// cannot hold a 20 MB model) and the plugin turns them into instances with
// SerializationService:DeserializeInstancesAsync(buffer), which reads Roblox's binary model format.
// For an .rbxmx Forge also reads the XML here into InstanceJson nodes (blob "tree"): the plugin tries
// the raw XML with SerializationService first and, when Studio refuses XML, builds those nodes with
// Instance.new (the way anim jobs already build KeyframeSequences). Animation saves (KeyframeSequence
// > Keyframe > Pose) survive that path whole; property types it cannot carry are listed in the result.
//
// Pure code: request fields, the parent path, which Studio window gets it, the XML reader, the job and
// the plugin's report (tested in test/modelInsert.test.ts).

import { decodeAttributes, parseXml, type XmlEl } from '../vfx/rbxmx.ts'
import { BRIDGE_VERSION, type BridgeJob, type InstanceJson, type PropJson } from './protocol.ts'
import type { StudioTarget } from './target.ts'

// The first plugin version that knows insert jobs (an older one would treat it as an effect job).
export const INSERT_PLUGIN_VERSION = 14
// Model files Forge sends to Studio: up to 20 MB (Roblox's own model upload cap).
export const INSERT_MAX_BYTES = 20 * 1024 * 1024
// Raw bytes per blob chunk (about 1 MB of base64 text per request).
export const INSERT_CHUNK_BYTES = 768 * 1024
// JSON text per "tree" chunk.
export const INSERT_TREE_CHUNK = 1024 * 1024
// Instances one .rbxmx may hold (a whole map exported by mistake stops here).
export const INSERT_MAX_NODES = 100_000
export const DEFAULT_PARENT = 'ServerStorage'
// Where an insert may go: the services a game's content lives in. Never CoreGui, the plugin's own
// space, or services Studio manages.
export const INSERT_SERVICES = [
  'Workspace',
  'ServerStorage',
  'ReplicatedStorage',
  'ReplicatedFirst',
  'ServerScriptService',
  'StarterGui',
  'StarterPack',
  'StarterPlayer',
  'Lighting',
  'SoundService',
  'Teams',
  'TextChatService',
  'MaterialService'
] as const

type Check<T> = { ok: true; value: T } | { ok: false; error: string }

// "ServerStorage.RBX_ANIMSAVES" -> ['ServerStorage', 'RBX_ANIMSAVES']. The first name is a service.
export function parseParentPath(raw: string | undefined): Check<string[]> {
  const text = (raw ?? '').trim() || DEFAULT_PARENT
  const parts = text.split('.').map((p) => p.trim())
  if (parts.some((p) => !p)) return { ok: false, error: `Bad parent "${text}": empty name in the dot path` }
  if (parts.length > 32) return { ok: false, error: `Bad parent "${text}": more than 32 levels` }
  if (parts.some((p) => p.length > 100 || /[\u0000-\u001f]/.test(p))) return { ok: false, error: `Bad parent "${text}": names are up to 100 characters, no control characters` }
  // "game.ServerStorage" and "Workspace"/"workspace" read the way Luau writes them.
  if (parts[0] === 'game' && parts.length > 1) parts.shift()
  const service = INSERT_SERVICES.find((s) => s.toLowerCase() === parts[0].toLowerCase())
  if (!service) return { ok: false, error: `Bad parent "${text}": it must start with one of ${INSERT_SERVICES.join(', ')}` }
  parts[0] = service
  return { ok: true, value: parts }
}

// A request's "place": a PlaceId (number or digits) or a place name.
export function parsePlace(raw: unknown): Check<StudioTarget | null> {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null }
  if (typeof raw === 'number') return Number.isSafeInteger(raw) && raw > 0 ? { ok: true, value: { placeId: raw } } : { ok: false, error: `Bad place ${raw}: a PlaceId is a positive whole number` }
  if (typeof raw !== 'string') return { ok: false, error: 'Bad place: give a place name or a PlaceId' }
  const t = raw.trim()
  if (!t || t.length > 100 || /[\u0000-\u001f]/.test(t)) return { ok: false, error: 'Bad place: a place name is 1 to 100 characters' }
  if (/^\d+$/.test(t) && Number.isSafeInteger(Number(t)) && Number(t) > 0) return { ok: true, value: { placeId: Number(t) } }
  return { ok: true, value: { place: t } }
}

export interface StudioWindow {
  place?: string
  placeId?: number
  pluginVersion?: number
  // Plugin v12+: an unpublished place's ForgeSyncLink id (how Source Control links it).
  link?: string
}

// A place of the open Forge project, and how its Studio windows are recognised: by PlaceId
// (servePlaceIds, or published places linked in Source Control) or, for an unpublished place linked in
// Source Control, by the link id the plugin reports. Never by Studio's place name: "Place1" and every
// downloaded .rbxlx share PlaceId 0.
export interface InsertProjectPlace {
  // The project file's "name" (display, and what a request's "place" may say).
  name: string
  // "menu.project.json".
  file: string
  placeIds: number[]
  linkIds?: string[]
}

// The project place a Studio window has open, or null when it is not one of the project's places.
export function projectPlaceOf(w: StudioWindow, places: InsertProjectPlace[]): InsertProjectPlace | null {
  const id = w.placeId && w.placeId > 0 ? w.placeId : 0
  if (id) return places.find((p) => p.placeIds.includes(id)) ?? null
  if (w.link) return places.find((p) => p.linkIds?.includes(w.link!)) ?? null
  return null
}

const windowText = (w: StudioWindow) => `${w.place ?? 'a place'}${w.placeId ? ` (${w.placeId})` : ''}`
const placeText = (p: InsertProjectPlace) =>
  `"${p.name}" (${p.placeIds.length ? `PlaceId ${p.placeIds.join(', ')}` : p.linkIds?.length ? 'linked unpublished place' : 'no PlaceId in servePlaceIds and not linked yet'})`
const sameName = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase()

// projectPlace: the project place the window has open; null for a window named explicitly that is
// not one of them.
export type PickResult<W> = { window: W; projectPlace: InsertProjectPlace | null } | { error: string; wait?: true }

// Which connected Studio window gets the insert.
//   - Without "place": only windows that have one of the open project's places open are eligible (a
//     model must never land in a place the request did not name and that is not the project's: a game
//     file opened just to look at it, another project's place). Exactly one must be connected.
//   - With "place" (a PlaceId, a project place name or file, or the Studio window's place name): a
//     project place first; else exactly one connected window with that PlaceId or Studio name, project
//     place or not (an explicit name is clear intent, e.g. a scratch test place). Nothing matching waits,
//     then fails: a named place is never swapped for another window.
//   - With a PlaceId and a name: the window with that PlaceId, and it must also carry that name.
// `wait`: Studio may still connect / open the place, so the request can wait; otherwise it fails now.
export function pickWindow<W extends StudioWindow>(windows: W[], want: StudioTarget | null, places: InsertProjectPlace[] | null): PickResult<W> {
  const list = places?.length ? places.map(placeText).join(', ') : ''
  const placeOf = (w: StudioWindow) => (places ? projectPlaceOf(w, places) : null)
  const connected = `connected: ${windows.length ? windows.map((w) => `${windowText(w)}${placeOf(w) ? '' : ' [not in this project]'}`).join(', ') : 'none'}`
  const one = (hits: W[], what: string): PickResult<W> => {
    if (hits.length === 1) return { window: hits[0], projectPlace: placeOf(hits[0]) }
    if (!hits.length) return { error: `No Studio window with ${what} is connected (${connected})${list ? `; this project's places: ${list}` : ''}`, wait: true }
    return { error: `${hits.length} Studio windows have ${what} open (${hits.map(windowText).join(', ')}); close one, or give its PlaceId as "place"` }
  }
  if (want?.placeId) {
    const r = one(windows.filter((w) => w.placeId === want.placeId), `PlaceId ${want.placeId}`)
    if ('error' in r) {
      // A window that has the place's name but not its PlaceId is usually a local copy (a .rbxl opened
      // from disk reports PlaceId 0): say so instead of only "not connected".
      const named = want.place ? windows.filter((w) => w.place && sameName(w.place, want.place!)) : []
      return named.length ? { ...r, error: `${r.error}. ${named.map(windowText).join(', ')} has the name "${want.place}" but not PlaceId ${want.placeId}: open the published place (File > Open from Roblox), or drop "placeId"` } : r
    }
    // A name given too must be that window's (its Studio name, or its project place's name or file).
    if (want.place) {
      const p = placeOf(r.window)
      const names = [r.window.place, p?.name, p?.file, p?.file.replace(/\.project\.json$/i, '')].filter((x): x is string => !!x)
      if (!names.some((n) => sameName(n, want.place!))) return { error: `The Studio window with PlaceId ${want.placeId} is ${windowText(r.window)}, not "${want.place}"; check which place you meant` }
    }
    return r
  }
  if (want?.place) {
    const name = want.place
    // The project's own name for the place ("menu", "menu.project.json") first, then Studio's.
    const p = places?.find((x) => sameName(x.name, name) || sameName(x.file, name) || sameName(x.file.replace(/\.project\.json$/i, ''), name))
    const ofPlace = p ? windows.filter((w) => placeOf(w) === p) : []
    if (p && (ofPlace.length || !windows.some((w) => w.place === name))) return one(ofPlace, `project place ${placeText(p)}`)
    return one(windows.filter((w) => w.place === name), `"${name}"`)
  }
  if (!places) return { error: 'No Forge project is open: without "place", models are only inserted into a Studio place of the open project', wait: true }
  if (!places.length) return { error: 'The open project has no *.project.json place, so no Studio place is linked to it; say which window with "place"' }
  if (!windows.length) return { error: `Studio is not connected: open a place of this project (${list}) in Roblox Studio with the Forge Bridge plugin on`, wait: true }
  const linked = windows.filter((w) => placeOf(w))
  if (linked.length === 1) return { window: linked[0], projectPlace: placeOf(linked[0]) }
  if (!linked.length) return { error: `No Studio window of this project is connected (${connected}). Open one of this project's places in Studio, or say which with "place": ${list}`, wait: true }
  return { error: `${linked.length} Studio windows of this project are connected (${linked.map((w) => `${windowText(w)} = ${placeOf(w)!.name}`).join(', ')}); say which one with "place" (a project place name or PlaceId): ${list}` }
}

// ---------------------------------------------------------------- .rbxmx -> InstanceJson

// Properties Studio writes that are not settable or only Studio's own bookkeeping: left out quietly.
const INTERNAL = new Set(['UniqueId', 'HistoryId', 'ScriptGuid', 'SourceAssetId', 'PhysicsData', 'InitialSize', 'MeshData', 'LODData', 'ModelMeshData', 'ModelMeshSize', 'ModelMeshCFrame', 'NeedsPivotMigration', 'Capabilities', 'DefinesCapabilities', 'formFactorRaw', 'PhysicalConfigData', 'AeroMeshData', 'FluidFidelityInternal', 'CollisionGroupId'])
// Serialized names that differ from the property scripts set.
const ALIASES: Record<string, string> = { size: 'Size', shape: 'Shape', Color3uint8: 'Color', BrickColor: 'BrickColor' }

const num = (s: string | undefined): number => {
  const v = Number((s ?? '').trim())
  return Number.isFinite(v) ? v : 0
}
const nums = (s: string): number[] =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .map((x) => (Number.isFinite(x) ? x : 0))
const child = (el: XmlEl, name: string): XmlEl | undefined => el.children.find((c) => c.name === name)

function readProp(el: XmlEl): PropJson | undefined {
  const comp = (k: string) => num(child(el, k)?.text)
  switch (el.name) {
    case 'string':
    case 'ProtectedString':
      return { t: 'string', v: el.text }
    case 'bool':
      return { t: 'bool', v: el.text.trim() === 'true' }
    case 'float':
    case 'double':
    case 'int':
    case 'int64':
      return { t: 'number', v: num(el.text) }
    case 'token':
      return { t: 'token', v: num(el.text) }
    case 'Content':
    case 'ContentId': {
      if (child(el, 'null')) return undefined
      const inner = child(el, 'url') ?? child(el, 'uri')
      const v = (inner ? inner.text : el.text).trim()
      return v ? { t: 'string', v } : undefined
    }
    case 'CoordinateFrame':
    case 'CFrame':
      return { t: 'cframe', v: ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map(comp) }
    case 'Vector3':
      return { t: 'vector3', v: [comp('X'), comp('Y'), comp('Z')] }
    case 'Vector2':
      return { t: 'vector2', v: [comp('X'), comp('Y')] }
    case 'Color3':
      return { t: 'color3', v: [comp('R'), comp('G'), comp('B')] }
    case 'Color3uint8': {
      const v = num(el.text) >>> 0
      return { t: 'color3', v: [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255] }
    }
    case 'UDim':
      return { t: 'udim', v: [comp('S'), comp('O')] }
    case 'UDim2':
      return { t: 'udim2', v: [comp('XS'), comp('XO'), comp('YS'), comp('YO')] }
    case 'NumberRange': {
      const v = nums(el.text)
      return { t: 'range', v: [v[0] ?? 0, v[1] ?? v[0] ?? 0] }
    }
    case 'NumberSequence': {
      const v = nums(el.text)
      const keys: [number, number, number][] = []
      for (let i = 0; i + 2 < v.length; i += 3) keys.push([v[i], v[i + 1], v[i + 2]])
      return keys.length >= 2 ? { t: 'nseq', v: keys } : undefined
    }
    case 'ColorSequence': {
      const v = nums(el.text)
      const keys: [number, number, number, number][] = []
      for (let i = 0; i + 3 < v.length; i += 5) keys.push([v[i], v[i + 1], v[i + 2], v[i + 3]])
      return keys.length >= 2 ? { t: 'cseq', v: keys } : undefined
    }
    case 'Ref': {
      const r = el.text.trim()
      return r && r !== 'null' ? { t: 'ref', v: r } : undefined
    }
    default:
      return undefined
  }
}

// Tags (a BinaryString): the tag names, NUL-separated.
function readTags(b64: string): string[] {
  let text: string
  try {
    const bin = atob(b64.replace(/\s+/g, ''))
    text = new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)))
  } catch {
    return []
  }
  return text.split('\0').filter((t) => t.length > 0 && t.length <= 100)
}

export interface RbxmxTree {
  roots: InstanceJson[]
  count: number
  // "Class.Property (XmlType)" the nodes cannot carry (the plugin uses them only when Studio will not
  // read the XML itself).
  unsupported: string[]
}

export class InsertFileError extends Error {}

// Reads an .rbxmx into InstanceJson nodes. Refs keep only targets inside the file.
export function readRbxmxTree(xml: string): RbxmxTree {
  let doc: XmlEl
  try {
    doc = parseXml(xml)
  } catch (e) {
    throw new InsertFileError(`The .rbxmx is not valid XML: ${(e as Error).message}`)
  }
  const top = doc.children.find((c) => c.name === 'roblox')
  if (!top) throw new InsertFileError('The .rbxmx has no <roblox> element; it is not a Roblox model file')
  const unsupported = new Set<string>()
  const referents = new Set<string>()
  let count = 0
  const convert = (item: XmlEl): InstanceJson => {
    if (++count > INSERT_MAX_NODES) throw new InsertFileError(`The .rbxmx has more than ${INSERT_MAX_NODES} instances`)
    const className = item.attrs.class ?? ''
    if (!/^\w{1,100}$/.test(className)) throw new InsertFileError(`The .rbxmx has an Item with a bad class "${className.slice(0, 40)}"`)
    const node: InstanceJson = { className, name: className, props: {}, children: [] }
    if (item.attrs.referent) {
      node.ref = item.attrs.referent
      referents.add(item.attrs.referent)
    }
    for (const p of child(item, 'Properties')?.children ?? []) {
      let key = p.attrs.name ?? ''
      if (!key || INTERNAL.has(key)) continue
      if (key in ALIASES) key = ALIASES[key]
      if (key === 'Name') {
        node.name = p.text
        continue
      }
      if (key === 'AttributesSerialize') {
        const a = decodeAttributes(p.text)
        if (Object.keys(a).length) node.attributes = a
        continue
      }
      if (key === 'Tags' && p.name === 'BinaryString') {
        const tags = readTags(p.text)
        if (tags.length) node.tags = tags
        continue
      }
      // Part.Color3uint8 is written next to the BrickColor it overrides: keep the colour.
      if (key === 'BrickColor' && p.name === 'int') continue
      const v = readProp(p)
      if (v === undefined) {
        if (!['Content', 'ContentId', 'Ref', 'NumberSequence', 'ColorSequence'].includes(p.name)) unsupported.add(`${className}.${key} (${p.name})`)
        continue
      }
      node.props[key] = v
    }
    node.children = item.children.filter((c) => c.name === 'Item').map(convert)
    return node
  }
  const roots = top.children.filter((c) => c.name === 'Item').map(convert)
  if (!roots.length) throw new InsertFileError('The .rbxmx holds no instances')
  // A Ref to something outside the file (or nothing) cannot be resolved in Studio: drop it.
  const prune = (n: InstanceJson) => {
    for (const [k, v] of Object.entries(n.props)) if (v.t === 'ref' && !referents.has(v.v)) delete n.props[k]
    n.children.forEach(prune)
  }
  roots.forEach(prune)
  return { roots, count, unsupported: [...unsupported].slice(0, 50) }
}

// ---------------------------------------------------------------- file, job, report

export const RBXM_MAGIC = '<roblox!'

// The file's format from its name, checked against its first bytes.
export function modelFormat(fileName: string, head: Uint8Array): Check<'rbxm' | 'rbxmx'> {
  const text = String.fromCharCode(...head.subarray(0, 512))
  if (/\.rbxm$/i.test(fileName)) {
    if (!text.startsWith(RBXM_MAGIC)) return { ok: false, error: `${fileName} is not a binary Roblox model (it does not start with ${RBXM_MAGIC})` }
    return { ok: true, value: 'rbxm' }
  }
  if (/\.rbxmx$/i.test(fileName)) {
    if (text.startsWith(RBXM_MAGIC)) return { ok: false, error: `${fileName} is a binary model; name it .rbxm` }
    if (!/<roblox[\s>]/.test(text)) return { ok: false, error: `${fileName} is not a Roblox XML model (no <roblox> element at the start)` }
    return { ok: true, value: 'rbxmx' }
  }
  return { ok: false, error: `${fileName}: only .rbxm and .rbxmx files are inserted` }
}

function base64(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(bin)
}

// Base64 per chunk (each chunk decodes on its own); size is a multiple of 3 so only the last pads.
export function chunkBase64(bytes: Uint8Array, size = INSERT_CHUNK_BYTES): string[] {
  const out: string[] = []
  for (let i = 0; i < bytes.length; i += size) out.push(base64(bytes.subarray(i, i + size)))
  return out
}

export function chunkText(text: string, size = INSERT_TREE_CHUNK): string[] {
  const out: string[] = []
  // Split on code points so no chunk ends in half a surrogate pair.
  let i = 0
  while (i < text.length) {
    let end = Math.min(i + size, text.length)
    if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1])) end--
    out.push(text.slice(i, end))
    i = end
  }
  return out
}

export interface InsertJobInput {
  id: string
  file: string
  parent: string[]
  replace: boolean
  format: 'rbxm' | 'rbxmx'
  size: number
  blobs: { bytes: number; tree?: number }
  // Seconds: fetching and deserialising a large file takes a while.
  timeout?: number
}

export function insertJob(input: InsertJobInput): BridgeJob {
  return {
    id: input.id,
    version: BRIDGE_VERSION,
    kind: 'insert',
    mode: 'realtime',
    name: input.file.slice(0, 200),
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: { pos: [0, 0, 0], target: [0, 0, 0], fov: 70 },
    modules: [],
    calibrate: false,
    key: [0, 0, 0],
    linger: 0,
    timeout: input.timeout ?? 120,
    insert: { parent: [...input.parent], replace: input.replace, format: input.format, file: input.file, size: input.size, blobs: { ...input.blobs } }
  }
}

export interface InsertReport {
  // Full names of the inserted roots ("ServerStorage.RBX_ANIMSAVES.Run").
  paths: string[]
  // Same-name children removed first (replace).
  replaced: number
  // How Studio read it: 'serialization' (SerializationService, the whole file) or 'tree' (Forge's XML
  // reading, built with Instance.new).
  via: 'serialization' | 'tree'
  // Parents the plugin created on the way ("ServerStorage.RBX_ANIMSAVES").
  created: string[]
  // Properties Studio would not take (tree path).
  skipped: string[]
}

// The plugin's 'log' event: {"inserted": [...], "replaced": n, "via": "...", "created": [...], "skipped": [...]}.
export function parseInsertReport(message: string): InsertReport | null {
  let raw: unknown
  try {
    raw = JSON.parse(message)
  } catch {
    return null
  }
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (!Array.isArray(r.inserted)) return null
  const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').slice(0, max).map((s) => s.slice(0, 500)) : [])
  return {
    paths: strings(r.inserted, 1000),
    replaced: typeof r.replaced === 'number' && Number.isFinite(r.replaced) && r.replaced >= 0 ? Math.floor(r.replaced) : 0,
    via: r.via === 'tree' ? 'tree' : 'serialization',
    created: strings(r.created, 32),
    skipped: strings(r.skipped, 50)
  }
}
