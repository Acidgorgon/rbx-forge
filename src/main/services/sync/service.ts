// SyncService: Forge Sync for one open project. Owns the SyncEngine, answers the Forge Bridge sync
// routes (config / chunked snapshot / changes), turns the engine's per-place gate into "may rojo serve
// this place" for the supervisor, tracks which files Forge wrote from Studio (so they can be committed
// as "Studio edits: ..." and so a git pull or branch switch can warn first), and reports SyncStatus
// to the renderer. No electron imports (tested in test/syncService.test.ts with a fake engine).

import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type {
  GateState,
  PlaceFingerprint,
  PlaceSyncStatus,
  StudioChange,
  StudioNode,
  StudioOutlineNode,
  SyncAction,
  SyncConflictInfo,
  SyncEntry,
  SyncNotice,
  SyncPlace,
  StudioOnlyScript,
  SyncRef,
  SyncStatus,
  UnlinkedPlace,
  WaitReason
} from '../../../shared/sync/types.ts'
import { STUDIO_ONLY_MAX, SYNC_ENGINE_SETTING, SYNC_GATE_SETTING, UNSYNCED_REFS_MAX } from '../../../shared/sync/types.ts'
import type { ForgeSyncSettings, SyncCommitResult } from '../../../shared/sync/api.ts'
import { PLUGIN_VERSION, SYNC_GATE_PLUGIN_VERSION } from '../../../shared/studio/plugin.ts'
import { disableLegacyPlugins, findLegacyPlugins } from './legacy.ts'
import { isLinkedKey, linkKey, matchPlace, PlaceLinks } from './links.ts'
import { BaseStore } from './store.ts'
import { findHeldDeletions } from '../gitSync.ts'
import { LIVE_FOLDER } from '../../../shared/vfx/live.ts'
import { collisionLabels, fingerprintText } from '../../../shared/sync/labels.ts'

// ---- What the service needs from the engine worker's modules (engine.ts, mapping.ts) ----
// Structural copies of the contract's Engine API, so this file builds and is tested before they land.

export interface SyncEngineLike {
  reload(): unknown
  beginSnapshot(placeKey: string, place: SyncPlace, projectFile?: string): unknown
  addSnapshot(placeKey: string, nodes: StudioNode[]): unknown
  finishSnapshot(placeKey: string): Promise<SyncEntry[]>
  applyChanges(placeKey: string, changes: StudioChange[]): Promise<SyncEntry[]>
  conflicts(): SyncConflictInfo[]
  resolve(placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string): Promise<void>
  resolveAll(placeKey: string, take: 'studio' | 'disk', reason?: SyncConflictInfo['reason']): unknown
  gate(placeKey: string): GateState
  // Studio went away mid-snapshot: gate back to 'idle'.
  endSession?(placeKey: string): unknown
  on(event: 'changed', fn: () => void): unknown
  // Game tab (optional so older fakes still fit): the live Studio tree under the mapped roots, the
  // Studio-only instances an $ignoreUnknownInstances root keeps in Studio, and "Save to repo".
  liveTree?(placeKey: string): { nodes: StudioNode[]; version: number } | null
  // Cheap: the tree's shape counter, null without a snapshot.
  treeVersion?(placeKey: string): number | null
  leftInStudio?(placeKey: string): string[][]
  saveTarget?(placeKey: string, path: string[]): Promise<{ file: string } | { reason: string }>
  saveToRepo?(placeKey: string, path: string[]): Promise<SyncEntry>
  // Scripts only in Studio that Rojo would delete on connect (and whether they hold rojo serve), and
  // "Pull to disk" for them.
  studioOnly?(placeKey: string): { items: StudioOnlyScript[]; holds: boolean }
  pullStudioOnly?(placeKey: string): Promise<SyncEntry[]>
}

export interface PlaceMapLike {
  projectFile: string
  placeIds: number[]
  roots: { instance: string[]; path: string; isFile?: boolean; ignoreUnknown?: boolean }[]
  skipped?: { instance: string[] }[]
  // Project nodes without $path (services, $className containers).
  virtual?: string[][]
}

export interface SyncMapping {
  loadPlaces(root: string): Promise<PlaceMapLike[]>
  placeFor(maps: PlaceMapLike[], placeId: number): PlaceMapLike | null
}

// ---- Bridge side (bridge.setSyncHandler) ----

export interface SyncConfigQuery {
  placeId: number
  gameId?: number
  place?: string
  // Plugin v8: the place's ForgeSyncLink attribute (unpublished, linked) and a random id per plugin run.
  link?: string
  probe?: string
  // Plugin v11: what is in the place (display only).
  fp?: PlaceFingerprint
}

export interface SyncConfigAnswer {
  enabled: boolean
  sessionToken: string
  roots: string[][]
  skip: string[][]
  reason?: string
  outline?: string[][]
  outlineMax?: number
  // Plugin v8: store this link id in the (unpublished) place; the user linked it in Forge.
  stampLink?: string
  // Plugin v11: show this label in that Studio window (the user pressed Identify).
  identify?: string
}

export interface OutlineBody {
  session: string
  place: SyncPlace
  nodes: StudioOutlineNode[]
  truncated?: boolean
}

// One instance of the Game tab's live Studio tree (flat; project.ts nests it).
export interface LiveStudioNode {
  path: string[]
  className: string
  props?: Record<string, string | number | boolean>
}

export interface SnapshotBody {
  session: string
  place: SyncPlace
  seq: number
  final: boolean
  nodes: StudioNode[]
  refs?: SyncRef[]
  refsTotal?: number
}

export interface ChangesBody {
  session: string
  place: SyncPlace
  changes: StudioChange[]
  // Present: the place's whole current list of unsynced references.
  refs?: SyncRef[]
  refsTotal?: number
}

export type SyncAnswer = { ok: true } | { ok: false; error: string; resend?: true }

export interface SyncHandler {
  config(q: SyncConfigQuery): Promise<SyncConfigAnswer>
  snapshot(body: SnapshotBody): Promise<SyncAnswer>
  changes(body: ChangesBody): Promise<SyncAnswer>
  outline?(body: OutlineBody): Promise<SyncAnswer>
}

export interface GitRun {
  (args: string[]): Promise<{ code: number; stdout: string; stderr: string }>
}

export interface SyncServiceDeps {
  root: string
  // null until the engine is wired in (sync stays off and every place serves normally).
  engine: SyncEngineLike | null
  mapping: SyncMapping | null
  settings: { get<T>(key: string, fallback: T): T }
  git: GitRun
  pluginsDir: () => string | null
  // The Forge Bridge's view of Studio (the plugin long-polls), to show "connected" per place.
  studio?: () => { placeId?: number; place?: string; pluginVersion?: number; connected: boolean } | null
  // Every Studio window polling the bridge right now (several places can be open at once), with the
  // Forge Bridge plugin version it runs.
  studios?: () => { placeId?: number; place?: string; pluginVersion?: number }[]
  // The Forge Bridge plugin file in Studio's plugins folder (null: no plugins folder on this OS).
  plugin?: () => Promise<{ installed: boolean; version?: number } | null>
  // Gate per project file, for the supervisor (rojo serve waits while 'waiting' / 'checking' /
  // 'blocked'; reason says why a file is 'waiting').
  onGate?: (projectFile: string, gate: GateState, detail?: string, reason?: WaitReason) => void
  emit: (event: 'sync:status' | 'sync:entry', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Tests: how long a snapshot may stall before the hold is released (default SNAPSHOT_STALE_MS).
  staleMs?: number
  // The live Studio tree changed shape (throttled to one call per TREE_THROTTLE_MS): the Game tab
  // re-reads liveTree(). Not called for script edits or heartbeats.
  onStudioTree?: () => void
  // Tests: throttle for onStudioTree (default TREE_THROTTLE_MS).
  treeThrottleMs?: number
}

const RECENT_MAX = 200
// Game-tab outline: the plugin sends at most this many instances outside the synced roots.
export const OUTLINE_MAX = 3000
export const TREE_THROTTLE_MS = 1000
const SEEN_MS = 60_000
// A snapshot that stops arriving (Studio closed or crashed mid-send) releases the rojo hold after this.
export const SNAPSHOT_STALE_MS = 30_000
// A linked session whose Studio stopped talking to Forge (no sync request, no bridge poll) for this
// long is over: its gate goes back to idle (rojo is not held for a Studio that is gone).
export const SESSION_EXPIRE_MS = 120_000
// Unlinked places are listed while their plugin keeps asking for config (v8 every 5 s, older 20 s).
const UNLINKED_SHOW_MS = 60_000
// Unsynced references kept per place (a snapshot may arrive in many chunks).
const SYNC_REFS_KEEP = 2000
const WRITTEN_FILE = join('.forge', 'sync', 'forge-written.json')
const PACKAGES = /^(Server|Dev)?Packages(\/|$)/
// Written from Studio: the file (and, for renames, its old path) is Forge's change, not the user's.
const WRITES: SyncAction[] = ['pulled', 'merged', 'created', 'renamed', 'trashed']
const GATE_RANK: Record<GateState, number> = { idle: 0, clear: 1, waiting: 2, checking: 3, blocked: 4 }

interface Session {
  token: string
  placeKey: string
  nextSeq: number
  ready: boolean
  // Root instance paths (joined with \0) seen in the snapshot being received.
  rootsSeen: Set<string>
}

interface PlaceState {
  placeKey: string
  projectFile: string
  place: SyncPlace
  counts: Partial<Record<SyncAction, number>>
  lastSnapshot?: number
  lastSeen: number
  // "Serve anyway": treat a blocked gate as clear until the next snapshot.
  override: boolean
  // Instance references the plugin reported (not synced), and those of a snapshot still arriving.
  refs: SyncRef[]
  refsTotal: number
  snapshotRefs?: SyncRef[]
  // Game-tab outline from the plugin (v5) and its signature, so an unchanged resend is a no-op.
  outline?: { nodes: StudioOutlineNode[]; truncated: boolean; sig: string }
  // Engine tree version last pushed to the Game tab (null: no tree).
  treeVersion?: number | null
  // Last "left in Studio" line logged, so it is logged once per change.
  leftNote?: string
  // Same for the Studio-only scripts line.
  studioOnlyNote?: string
  // Mapped roots the last snapshot did not have (instance paths).
  missingRoots: string[][]
}

interface UnlinkedEntry extends UnlinkedPlace {
  probe?: string
}

// An Identify press waits this long for that Studio window's next config request (plugin v11 asks
// every 5 s while its place is not linked).
export const IDENTIFY_WAIT_MS = 20_000

interface ConfigSeen {
  at: number
  placeId: number
  name?: string
  reason?: string
}

export function placeKeyOf(place: SyncPlace, projectFile?: string): string {
  if (place.placeId) return String(place.placeId)
  if (place.linkId) return `local:${place.linkId}`
  const name = place.name || (projectFile ? projectFile.replace(/\.project\.json$/, '') : 'Place')
  return `unpublished:${name}`
}

export function engineSetting(settings: { get<T>(key: string, fallback: T): T }): ForgeSyncSettings {
  const engine = settings.get<string>(SYNC_ENGINE_SETTING, 'forge')
  return {
    engine: engine === 'project' || engine === 'off' ? engine : 'forge',
    gateRojo: settings.get<boolean>(SYNC_GATE_SETTING, true) !== false
  }
}

export function gateDetail(gate: GateState, conflicts: number, studioOnly = 0): string | undefined {
  if (gate === 'checking') return 'Waiting for Studio sync check'
  if (gate !== 'blocked') return undefined
  const parts: string[] = []
  if (conflicts || !studioOnly) parts.push(`${conflicts} conflict${conflicts === 1 ? '' : 's'}`)
  if (studioOnly) parts.push(`${studioOnly} Studio-only script${studioOnly === 1 ? '' : 's'} not on disk`)
  return `${parts.join(', ')}: ${studioOnly ? (conflicts ? 'resolve, pull to disk' : 'pull to disk') : 'resolve'} or serve anyway`
}

// "Studio edits: Attack.luau, Dash.luau and 3 more"
export function commitMessage(files: string[]): string {
  const names = [...new Set(files.map((f) => basename(f)))]
  const shown = names.slice(0, 3).join(', ')
  return `Studio edits: ${shown}${names.length > 3 ? ` and ${names.length - 3} more` : ''}`
}

// `git status --porcelain -z`: "XY path\0" entries; renames/copies add "\0orig".
export function parsePorcelainZ(out: string): string[] {
  const parts = out.split('\0')
  const files: string[] = []
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    files.push(entry.slice(3))
    if (xy[0] === 'R' || xy[0] === 'C') {
      const orig = parts[++i]
      if (orig) files.push(orig)
    }
  }
  return files
}

export class SyncService {
  readonly root: string
  readonly links: PlaceLinks
  private deps: SyncServiceDeps
  private now: () => number
  private sessions = new Map<string, Session>()
  private placeStates = new Map<string, PlaceState>()
  private maps: PlaceMapLike[] = []
  private recent: SyncEntry[] = []
  private written = new Set<string>()
  private writtenLoaded = false
  private pushedGates = new Map<string, string>()
  private queue: Promise<unknown> = Promise.resolve()
  private legacy: string[] = []
  private warning: string | undefined
  private refreshQueued = false
  private closed = false
  // The plugin's last /sync/config request (refused ones carry the reason).
  private lastConfig: ConfigSeen | null = null
  // Studio places that asked for sync but are not linked to this project (never applied).
  private unlinked = new Map<string, UnlinkedEntry>()
  // Unpublished places the user linked: plugin probe id -> link id to stamp into the place.
  private stamps = new Map<string, string>()
  // Identify presses not delivered yet: unlinked place id -> the label to show and when it was asked.
  private identifies = new Map<string, { label: string; at: number }>()
  // Plugin v11: the fingerprint each linked place sent when its check started (placeKey -> one line).
  private fingerprints = new Map<string, string>()
  // One-time note: sync state of never-linked places was dropped at startup.
  private discarded: { id: string; text: string } | undefined
  private expireTimer: ReturnType<typeof setInterval> | null = null
  // Place files the user chose to serve without a Studio check ("Serve without Studio check"). Taken
  // back as soon as a Studio session for that file starts its check.
  private noCheck = new Set<string>()

  constructor(deps: SyncServiceDeps) {
    this.deps = deps
    this.root = deps.root
    this.links = new PlaceLinks(deps.root)
    this.now = deps.now ?? Date.now
    deps.engine?.on('changed', () => {
      this.refresh()
      this.checkTree()
    })
  }

  settings(): ForgeSyncSettings {
    return engineSetting(this.deps.settings)
  }

  // Forge Sync answers the plugin only with the setting on 'forge' and an engine wired in.
  active(): boolean {
    return !!this.deps.engine && !!this.deps.mapping && this.settings().engine === 'forge'
  }

  async start(): Promise<void> {
    try {
      await this.loadWritten()
      await this.links.load()
      if (this.deps.mapping) {
        this.maps = await this.deps.mapping.loadPlaces(this.root).catch(() => [])
        await this.recoverUnlinked().catch((e) => this.deps.log?.(`sync: could not clean up unlinked places: ${(e as Error).message}`, 'stderr'))
      }
      await this.reload()
      await this.checkLegacyPlugin()
      if (!this.expireTimer && !this.closed) {
        this.expireTimer = setInterval(() => this.expireSessions(), 15_000)
        ;(this.expireTimer as { unref?: () => void }).unref?.()
      }
    } finally {
      // The supervisor has every place file's gate before the project's services start (main awaits
      // this before startAll), so rojo serve never starts ahead of the Studio check.
      if (!this.closed) this.pushGates()
    }
  }

  // Once per project after the place-linking update: Forge Sync used to take any Studio place (an
  // unpublished one, or any place when no servePlaceIds were set) as the default place. Its base
  // state is dropped (never applied again); files it already wrote stay for git to show.
  private async recoverUnlinked(): Promise<void> {
    // Without the place files (unreadable for a moment) every place would look unlinked: try next start.
    if (this.links.recovered || !this.maps.length) return
    const store = new BaseStore(this.root)
    await store.load()
    const dropped: string[] = []
    for (const key of await store.placeKeys()) {
      if (isLinkedKey(this.maps, this.links.all(), key)) continue
      await store.dropPlace(key)
      dropped.push(key)
    }
    if (dropped.length) {
      await store.save()
      const names = dropped.map((k) => (k.startsWith('unpublished:') ? `"${k.slice('unpublished:'.length)}"` : /^\d+$/.test(k) ? `place ${k}` : k))
      const text = `Forge Sync now only syncs Studio places linked to this project. Discarded the sync session of ${names.join(', ')} (not linked): nothing from it is applied any more. Files it already wrote are left as they are; check Source Control to discard them.`
      this.discarded = { id: `discarded:${dropped.join(',')}`, text }
      this.deps.log?.(`sync: ${text}`, 'stderr')
    }
    await this.links.markRecovered()
  }

  // Project files changed (a *.project.json was added/edited): re-read the place maps.
  async reload(): Promise<void> {
    if (this.deps.mapping) {
      this.maps = await this.deps.mapping.loadPlaces(this.root).catch((e) => {
        this.deps.log?.(`sync: could not read the places: ${(e as Error).message}`, 'stderr')
        return []
      })
    }
    if (this.deps.engine) await this.serial(async () => this.deps.engine?.reload())
    // A place no longer listed (servePlaceIds edited) stops syncing right away.
    for (const state of [...this.placeStates.values()]) {
      const linkId = state.placeKey.startsWith('local:') ? state.placeKey.slice('local:'.length) : undefined
      const match = matchPlace(this.maps, this.links.all(), { placeId: state.place.placeId, linkId })
      if (match && match.projectFile === state.projectFile) continue
      this.dropSession(state.placeKey, 'no longer linked to this project')
    }
    this.refresh()
  }

  private dropSession(placeKey: string, why: string): void {
    for (const [token, s] of this.sessions) if (s.placeKey === placeKey) this.sessions.delete(token)
    this.placeStates.delete(placeKey)
    this.deps.log?.(`sync: stopped syncing ${placeKey}: ${why}`)
    void this.serial(async () => this.deps.engine?.endSession?.(placeKey))
  }

  // Studio went away without saying so (window closed, crash): release what its session holds.
  expireSessions(): void {
    if (this.closed) return
    const now = this.now()
    const polling = this.deps.studios?.() ?? []
    const single = this.deps.studio?.() ?? null
    let changed = false
    for (const state of this.placeStates.values()) {
      if (now - state.lastSeen < SESSION_EXPIRE_MS) continue
      const live = polling.some((p) => this.isStudioPlace(p, state.place)) || (!!single?.connected && this.isStudioPlace(single, state.place))
      if (live) continue
      if (![...this.sessions.values()].some((x) => x.placeKey === state.placeKey)) continue
      for (const [token, s] of this.sessions) if (s.placeKey === state.placeKey) this.sessions.delete(token)
      this.deps.log?.(`sync: Studio session for ${state.projectFile} (${state.placeKey}) ended: no word from Studio for ${Math.round(SESSION_EXPIRE_MS / 1000)} s`)
      void this.serial(async () => this.deps.engine?.endSession?.(state.placeKey))
      changed = true
    }
    for (const [id, u] of this.unlinked) if (now - u.lastSeen > UNLINKED_SHOW_MS) this.unlinked.delete(id)
    // Gates also follow the bridge's view of Studio (plugin version, unlinked places going away).
    if (this.pushGates() || changed) this.refresh()
  }

  close(): void {
    this.closed = true
    this.sessions.clear()
    if (this.expireTimer) clearInterval(this.expireTimer)
    this.expireTimer = null
    if (this.treeTimer) clearTimeout(this.treeTimer)
    this.treeTimer = null
  }

  // ---- Bridge handler ----

  readonly handler: SyncHandler = {
    config: (q) => this.config(q),
    snapshot: (body) => this.snapshot(body),
    changes: (body) => this.changes(body),
    outline: (body) => this.outline(body)
  }

  private async config(q: SyncConfigQuery): Promise<SyncConfigAnswer> {
    const seen: ConfigSeen = { at: this.now(), placeId: Number(q.placeId) || 0, ...(q.place ? { name: String(q.place) } : {}) }
    this.lastConfig = seen
    const off = (reason: string): SyncConfigAnswer => {
      seen.reason = reason
      this.refresh()
      return { enabled: false, sessionToken: '', roots: [], skip: [], reason }
    }
    if (!this.active()) return off(this.settings().engine === 'forge' ? 'Forge Sync is not available in this build' : `Studio sync is set to "${this.settings().engine}"`)
    if (!this.maps.length) await this.reload()
    await this.links.load()
    const placeId = Number(q.placeId) || 0
    // Only a place linked to this project syncs: its PlaceId in a servePlaceIds / studio-sync.json
    // placeIds, or linked in Source Control (by PlaceId, or by the link id the plugin keeps in an
    // unpublished place). Never by name and never "the default place": every unpublished place and
    // local .rbxlx file has PlaceId 0, and any open place used to land in default.project.json,
    // writing its scripts into the repo and holding rojo on its "conflicts".
    const linkId = placeId ? undefined : q.link
    const match = matchPlace(this.maps, this.links.all(), { placeId, ...(linkId ? { linkId } : {}) })
    if (!match) {
      const stamp = q.probe && !placeId ? this.stamps.get(q.probe) : undefined
      if (stamp) return { ...off('linking: the plugin stores the link in the place'), stampLink: stamp }
      const entry = this.noteUnlinked(q, placeId)
      const ask = this.identifies.get(entry.id)
      this.identifies.delete(entry.id)
      return { ...off(entry.why), ...(ask && this.now() - ask.at <= IDENTIFY_WAIT_MS ? { identify: ask.label } : {}) }
    }
    if (q.probe) this.stamps.delete(q.probe)
    this.unlinked.delete(this.unlinkedId(q, placeId))
    this.identifies.delete(this.unlinkedId(q, placeId))
    const fp = fingerprintText(q.fp)
    if (fp) this.fingerprints.set(match.placeKey, fp)
    else this.fingerprints.delete(match.placeKey)
    const map = this.maps.find((m) => m.projectFile === match.projectFile)
    if (!map) return off('No *.project.json maps this place')
    const place: SyncPlace = { placeId, ...(q.gameId ? { gameId: Number(q.gameId) } : {}), ...(q.place ? { name: String(q.place) } : {}), ...(linkId ? { linkId } : {}) }
    const placeKey = match.placeKey
    for (const [token, s] of this.sessions) if (s.placeKey === placeKey) this.sessions.delete(token)
    const token = randomUUID()
    // Unready until its snapshot is reconciled: the place is 'checking' from now on, so a rojo serve
    // still running from an earlier session stops before Studio's Rojo plugin can (re)connect to it.
    this.sessions.set(token, { token, placeKey, nextSeq: 0, ready: false, rootsSeen: new Set() })
    const state = this.placeState(placeKey, map.projectFile, place)
    state.lastSeen = this.now()
    state.override = false
    // A Studio check starts: "Serve without Studio check" is over for this place file.
    this.noCheck.delete(map.projectFile)
    this.watchSnapshot(token, placeKey, false)
    const roots = map.roots.filter((r) => !PACKAGES.test(r.path)).map((r) => r.instance)
    // The VFX Lab's live Studio preview folder never syncs.
    const skip = [...map.roots.filter((r) => PACKAGES.test(r.path)).map((r) => r.instance), ['Workspace', LIVE_FOLDER]]
    this.deps.log?.(`sync: Studio session for ${map.projectFile} (${placeKey}), ${roots.length} roots`)
    this.refresh()
    return { enabled: true, sessionToken: token, roots, skip, outline: outlineContainers(map), outlineMax: OUTLINE_MAX }
  }

  // Game-tab outline (plugin v5): names and classes of the mapped services' instances outside the roots.
  private async outline(body: OutlineBody): Promise<SyncAnswer> {
    if (!this.active()) return { ok: false, error: 'Forge Sync is off' }
    const session = this.sessions.get(body.session)
    // resend: the plugin starts over with a fresh config + snapshot. Without it a plugin whose token
    // Forge dropped (project reopened, a newer config for the place) kept posting outlines nobody took,
    // and the Game tab kept showing instances long deleted in Studio.
    if (!session) return { ok: false, error: 'unknown session', resend: true }
    const state = this.placeStates.get(session.placeKey)
    if (!state || !samePlace(state.place, body.place)) return { ok: false, error: 'this session belongs to another place', resend: true }
    state.lastSeen = this.now()
    const nodes = (Array.isArray(body.nodes) ? body.nodes : []).filter((n) => !(Array.isArray(n?.path) && n.path[0] === 'Workspace' && n.path[1] === LIVE_FOLDER))
    const sig = JSON.stringify([nodes, !!body.truncated])
    if (state.outline?.sig === sig) return { ok: true }
    state.outline = { nodes, truncated: !!body.truncated, sig }
    this.scheduleTree()
    this.refresh()
    return { ok: true }
  }

  private async snapshot(body: SnapshotBody): Promise<SyncAnswer> {
    if (!this.active()) return { ok: false, error: 'Forge Sync is off' }
    const session = this.sessions.get(body.session)
    if (!session) return { ok: false, error: 'unknown session', resend: true }
    const engine = this.deps.engine!
    const state = this.placeStates.get(session.placeKey)
    if (!state || !samePlace(state.place, body.place)) return { ok: false, error: 'this session belongs to another place', resend: true }
    state.lastSeen = this.now()
    try {
      return await this.serial(async () => {
        if (body.seq === 0) {
          // A (re)starting snapshot: gate goes 'checking', so a running rojo serve for this place stops.
          session.nextSeq = 0
          session.ready = false
          session.rootsSeen = new Set()
          state.override = false
          this.noCheck.delete(state.projectFile)
          state.counts = {}
          state.snapshotRefs = []
          await engine.beginSnapshot(session.placeKey, state.place, state.projectFile)
          this.refresh()
        }
        if (body.seq !== session.nextSeq) {
          const expected = session.nextSeq
          session.nextSeq = 0
          return { ok: false, error: `snapshot chunk ${body.seq} out of order (expected ${expected})`, resend: true } as SyncAnswer
        }
        const nodes = Array.isArray(body.nodes) ? body.nodes : []
        await engine.addSnapshot(session.placeKey, nodes)
        const rootKeys = new Set(this.rootsOf(state.projectFile).map((r) => r.join('\u0000')))
        for (const n of nodes) {
          const k = n.path.join('\u0000')
          if (rootKeys.has(k)) session.rootsSeen.add(k)
        }
        if (Array.isArray(body.refs)) (state.snapshotRefs ??= []).push(...body.refs)
        session.nextSeq++
        this.watchSnapshot(session.token, session.placeKey, !!body.final)
        if (body.final) {
          const entries = await engine.finishSnapshot(session.placeKey)
          this.checkTree()
          session.ready = true
          state.lastSnapshot = this.now()
          state.missingRoots = this.rootsOf(state.projectFile).filter((r) => !session.rootsSeen.has(r.join('\u0000')))
          this.setRefs(state, state.snapshotRefs ?? [], body.refsTotal)
          state.snapshotRefs = undefined
          await this.record(session.placeKey, entries)
          const conflicts = engine.conflicts().filter((c) => c.placeKey === session.placeKey).length
          this.deps.log?.(`sync: ${state.projectFile} reconciled, ${entries.length} files, ${conflicts} conflict${conflicts === 1 ? '' : 's'}`)
        }
        this.refresh()
        return { ok: true } as SyncAnswer
      })
    } catch (e) {
      this.deps.log?.(`sync: snapshot failed: ${(e as Error).message}`, 'stderr')
      return { ok: false, error: (e as Error).message }
    }
  }

  private snapshotTimers = new Map<string, ReturnType<typeof setTimeout>>()

  private watchSnapshot(token: string, placeKey: string, done: boolean): void {
    const old = this.snapshotTimers.get(placeKey)
    if (old) clearTimeout(old)
    this.snapshotTimers.delete(placeKey)
    if (done) return
    const timer = setTimeout(() => {
      this.snapshotTimers.delete(placeKey)
      const session = this.sessions.get(token)
      if (session?.ready) return
      // A new config for the place (Studio reopened) drops the old token; until the new session sends
      // its first chunk nothing else would release the gate, so a missing token still releases it.
      if ([...this.sessions.values()].some((x) => x.placeKey === placeKey && x.ready)) return
      if (session) this.sessions.delete(token)
      this.deps.log?.(`sync: Studio stopped sending the snapshot for ${placeKey}; rojo serve waits for a new Studio check`, 'stderr')
      void this.serial(async () => {
        await this.deps.engine?.endSession?.(placeKey)
        this.refresh()
      })
    }, this.deps.staleMs ?? SNAPSHOT_STALE_MS)
    ;(timer as { unref?: () => void }).unref?.()
    this.snapshotTimers.set(placeKey, timer)
  }

  private async changes(body: ChangesBody): Promise<SyncAnswer> {
    if (!this.active()) return { ok: false, error: 'Forge Sync is off' }
    const session = this.sessions.get(body.session)
    if (!session) return { ok: false, error: 'unknown session', resend: true }
    if (!session.ready) return { ok: false, error: 'no complete snapshot yet', resend: true }
    const state = this.placeStates.get(session.placeKey)
    if (!state || !samePlace(state.place, body.place)) return { ok: false, error: 'this session belongs to another place', resend: true }
    state.lastSeen = this.now()
    try {
      if (Array.isArray(body.refs)) this.setRefs(state, body.refs, body.refsTotal)
      const changes = Array.isArray(body.changes) ? body.changes : []
      for (const c of changes) {
        if (c.kind === 'added') state.missingRoots = state.missingRoots.filter((r) => r.join('\u0000') !== c.node.path.join('\u0000'))
        else if (c.kind === 'removed' && this.rootsOf(state.projectFile).some((r) => r.join('\u0000') === c.path.join('\u0000')) && !state.missingRoots.some((r) => r.join('\u0000') === c.path.join('\u0000'))) state.missingRoots = [...state.missingRoots, c.path]
      }
      const entries = changes.length ? await this.serial(() => this.deps.engine!.applyChanges(session.placeKey, changes)) : []
      this.checkTree()
      await this.record(session.placeKey, entries, true)
      this.refresh()
      return { ok: true }
    } catch (e) {
      this.deps.log?.(`sync: changes failed: ${(e as Error).message}`, 'stderr')
      return { ok: false, error: (e as Error).message, resend: true }
    }
  }

  // ---- UI actions ----

  async resolve(placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string): Promise<SyncStatus> {
    const engine = this.requireEngine()
    if (take === 'merged' && typeof text !== 'string') throw new Error('A merged resolution needs the merged text')
    await this.serial(() => engine.resolve(placeKey, file, take, text))
    if (take !== 'disk') await this.markWritten([file])
    this.refresh()
    return this.status()
  }

  async resolveAll(placeKey: string, take: 'studio' | 'disk', reason?: SyncConflictInfo['reason']): Promise<SyncStatus> {
    const engine = this.requireEngine()
    const files = engine.conflicts().filter((c) => c.placeKey === placeKey && (!reason || c.reason === reason)).map((c) => c.file)
    await this.serial(async () => engine.resolveAll(placeKey, take, reason))
    if (take === 'studio') await this.markWritten(files)
    this.refresh()
    return this.status()
  }

  // "Link this place to <project>": persisted in .forge/sync/links.json. A published place by PlaceId;
  // an unpublished one by a new link id the plugin (v8) stores in the place on its next config request.
  async linkPlace(id: string, projectFile?: string): Promise<SyncStatus> {
    const entry = this.unlinked.get(id)
    if (!entry) throw new Error('That Studio place is not connected any more; open it in Studio and try again')
    if (!entry.canLink) throw new Error(entry.why)
    await this.links.load()
    const file = projectFile ?? (this.maps.find((m) => m.projectFile === 'default.project.json') ?? this.maps[0])?.projectFile
    if (!file || !this.maps.some((m) => m.projectFile === file)) throw new Error(`No ${projectFile ?? '*.project.json'} in this project`)
    const link = { projectFile: file, ...(entry.name ? { name: entry.name } : {}), at: this.now() }
    if (entry.placeId > 0) await this.links.set(linkKey({ placeId: entry.placeId })!, link)
    else {
      const linkId = randomUUID()
      await this.links.set(linkKey({ placeId: 0, linkId })!, link)
      this.stamps.set(entry.probe!, linkId)
    }
    this.unlinked.delete(id)
    this.identifies.delete(id)
    this.deps.log?.(`sync: linked Studio place "${entry.name}"${entry.placeId ? ` (${entry.placeId})` : ''} to ${file}; its first sync waits for your choice`)
    this.refresh()
    return this.status()
  }

  // "Identify": the Studio window of this unlinked place shows its label (e.g. "Place1 #2") on its next
  // config request, within about 5 s. Plugin v11; older plugins have no fingerprint and no Identify.
  identifyPlace(id: string): { label: string } {
    const entry = this.shownUnlinked().find((u) => u.id === id)
    if (!entry) throw new Error('That Studio place is not connected any more; open it in Studio and try again')
    if (!entry.canIdentify) throw new Error(`Restart Studio to load Forge Bridge v${PLUGIN_VERSION}, which can identify its window`)
    const label = entry.label ?? entry.name
    this.identifies.set(id, { label, at: this.now() })
    return { label }
  }

  // Unlinked places still talking to Forge, oldest first, labelled "Place1 #1 / #2" when names collide.
  private shownUnlinked(): UnlinkedEntry[] {
    const now = this.now()
    const list = [...this.unlinked.values()].filter((u) => now - u.lastSeen <= UNLINKED_SHOW_MS)
    const labels = collisionLabels(list.map((u) => u.name))
    return list.map((u, i) => ({ ...u, label: labels[i] }))
  }

  private unlinkedId(q: SyncConfigQuery, placeId: number): string {
    if (placeId) return `place:${placeId}`
    return q.probe ? `probe:${q.probe}` : `name:${String(q.place ?? '')}`
  }

  private noteUnlinked(q: SyncConfigQuery, placeId: number): UnlinkedEntry {
    const id = this.unlinkedId(q, placeId)
    const name = String(q.place ?? '') || (placeId ? `Place ${placeId}` : 'Unpublished place')
    const canLink = placeId > 0 || !!q.probe
    const why = placeId
      ? `Place ${placeId} is not linked to this project (not in any *.project.json servePlaceIds or tools/studio-sync.json placeIds)`
      : canLink
        ? 'Unpublished place, not linked to this project'
        : `Unpublished place, not linked to this project. Restart Studio to load Forge Bridge v${PLUGIN_VERSION}, which can link it`
    const fingerprint = fingerprintText(q.fp)
    const entry: UnlinkedEntry = {
      id,
      name,
      placeId,
      lastSeen: this.now(),
      canLink,
      why,
      ...(fingerprint ? { fingerprint } : {}),
      ...(q.fp && q.probe ? { canIdentify: true } : {}),
      ...(q.probe ? { probe: q.probe } : {})
    }
    const known = this.unlinked.has(id)
    // Map.set keeps an existing key's place, so "#1 / #2" numbering stays put while both are open.
    this.unlinked.set(id, entry)
    if (!known) this.deps.log?.(`sync: Studio place "${name}" is not linked to this project; nothing from it is synced (Source Control > Link to sync it)`)
    return entry
  }

  // "Pull to disk": writes the place's Studio-only scripts Forge can write, so Rojo never offers to
  // delete them from Studio.
  async pullStudioOnly(placeKey: string): Promise<SyncStatus> {
    const engine = this.requireEngine()
    if (!engine.pullStudioOnly) throw new Error('Pull to disk is not available in this build')
    const entries = await this.serial(() => engine.pullStudioOnly!(placeKey))
    await this.record(placeKey, entries, true)
    const written = entries.filter((e) => e.action === 'created').length
    this.deps.log?.(`sync: pulled ${written} Studio-only file${written === 1 ? '' : 's'} to disk for ${placeKey}`)
    this.refresh()
    return this.status()
  }

  // "Serve without Studio check": rojo serves these place files (all of them without one) although no
  // Studio check cleared them, until a Studio session for one starts its check. The user's call: an
  // unchecked Studio place may get Rojo's "delete Studio-only scripts" dialog.
  async serveWithoutCheck(projectFile?: string): Promise<SyncStatus> {
    const files = projectFile ? [projectFile] : this.maps.map((m) => m.projectFile)
    if (projectFile && !this.maps.some((m) => m.projectFile === projectFile)) throw new Error(`No ${projectFile} in this project`)
    for (const file of files) this.noCheck.add(file)
    this.deps.log?.(`sync: serving ${files.join(', ')} without a Studio check (you chose it); Rojo may offer to delete scripts that exist only in Studio, so check its dialog before you accept`, 'stderr')
    this.refresh()
    return this.status()
  }

  async serveAnyway(placeKey: string): Promise<SyncStatus> {
    const state = this.placeStates.get(placeKey)
    if (!state) throw new Error(`No Studio session for ${placeKey}`)
    state.override = true
    this.deps.log?.(`sync: serving ${state.projectFile} with ${this.conflictsFor(placeKey).length} held conflict(s) (serve anyway)`)
    this.refresh()
    return this.status()
  }

  // Stages and commits ONLY the files Forge wrote from Studio that git still shows as changed.
  async commitStudioEdits(message?: string): Promise<SyncCommitResult> {
    // A guarded script that left the disk outside Forge is not committed as deleted (gitSync.ts).
    const held = new Set((await findHeldDeletions(this.root, (args) => this.deps.git(args)).catch(() => [])).map((h) => h.path))
    const files = (await this.pendingStudioEdits()).filter((f) => !held.has(f))
    if (!files.length) return { committed: [], error: 'No uncommitted Studio edits' }
    const text = message?.trim() || commitMessage(files)
    // Paths are literal (a Roblox name like "Sword [Gold]" is not a glob). Many paths go through a
    // file: Windows refuses command lines over ~32K characters (a first sync can touch hundreds).
    let spec = ['--', ...files]
    if (files.reduce((n, f) => n + f.length + 3, 0) > 8000) {
      const list = join(this.root, '.forge', 'sync', 'commit-paths.txt')
      await mkdir(dirname(list), { recursive: true })
      await writeFile(list, files.join('\0'))
      spec = [`--pathspec-from-file=${list}`, '--pathspec-file-nul']
    }
    const added = await this.deps.git(['--literal-pathspecs', 'add', '-A', ...spec])
    if (added.code !== 0) return { committed: [], error: firstLine(added.stderr) || 'git add failed' }
    const committed = await this.deps.git(['--literal-pathspecs', 'commit', '-m', text, '--only', ...spec])
    if (committed.code !== 0) return { committed: [], error: firstLine(committed.stderr || committed.stdout) || 'git commit failed' }
    for (const f of files) this.written.delete(f)
    await this.saveWritten()
    this.warning = undefined
    this.deps.log?.(`sync: committed ${files.length} Studio edit${files.length === 1 ? '' : 's'} (${text})`)
    this.refresh()
    return { committed: files, message: text }
  }

  // Before a Forge-initiated git pull or branch switch. With uncommitted Studio edits: commits them
  // first when autoCommit is on (so they land as "Studio edits: ..." and not inside "harness: sync"),
  // otherwise returns a warning (the pull's --autostash keeps them, but they are not in history).
  async guardGitOp(op: 'pull' | 'switch', opts: { autoCommit: boolean }): Promise<{ pending: string[]; committed?: string[]; warning?: string }> {
    const pending = await this.pendingStudioEdits()
    if (!pending.length) return { pending }
    if (opts.autoCommit) {
      const result = await this.commitStudioEdits()
      if (!result.error) return { pending: [], committed: result.committed }
    }
    const n = pending.length
    this.warning = `${n} teammate edit${n === 1 ? '' : 's'} from Studio ${n === 1 ? 'is' : 'are'} not committed. Commit ${n === 1 ? 'it' : 'them'} before the ${op === 'pull' ? 'pull' : 'branch switch'} so ${n === 1 ? 'it stays' : 'they stay'} in history.`
    this.deps.log?.(`sync: ${this.warning}`, 'stderr')
    this.refresh()
    return { pending, warning: this.warning }
  }

  async disableLegacyPlugin(): Promise<SyncStatus> {
    const done = await disableLegacyPlugins(this.deps.pluginsDir())
    if (done.length) this.deps.log?.(`sync: disabled ${done.map((f) => basename(f)).join(', ')} (renamed to *.disabled); restart Studio to unload it`)
    await this.checkLegacyPlugin()
    return this.status()
  }

  async checkLegacyPlugin(): Promise<void> {
    this.legacy = await findLegacyPlugins(this.deps.pluginsDir())
  }

  // ---- Status ----

  conflicts(): SyncConflictInfo[] {
    return this.deps.engine && this.settings().engine === 'forge' ? this.deps.engine.conflicts() : []
  }

  private conflictsFor(placeKey: string): SyncConflictInfo[] {
    return this.conflicts().filter((c) => c.placeKey === placeKey)
  }

  gate(placeKey: string): GateState {
    const state = this.placeStates.get(placeKey)
    if (!this.active() || !state) return 'idle'
    // Config answered, snapshot not reconciled yet: checking (rojo stops before Studio's Rojo plugin
    // can reach it).
    if ([...this.sessions.values()].some((s) => s.placeKey === placeKey && !s.ready)) return 'checking'
    const gate = this.deps.engine!.gate(placeKey)
    if (state.override && gate === 'blocked') return 'clear'
    // A check by a plugin older than the gate trusts does not clear it ("Restart Studio").
    if (gate === 'clear' && !state.override && this.settings().gateRojo && this.pluginBehind(state.place)) return 'waiting'
    return gate
  }

  // The Forge Bridge plugin version the Studio window of this place runs (its bridge poll), if known.
  private pluginVersionOf(place: SyncPlace): number | undefined {
    const hit = (this.deps.studios?.() ?? []).find((p) => this.isStudioPlace(p, place) && p.pluginVersion)
    if (hit) return hit.pluginVersion
    const single = this.deps.studio?.() ?? null
    return single?.connected && this.isStudioPlace(single, place) ? single.pluginVersion : undefined
  }

  private pluginBehind(place: SyncPlace): number | null {
    const v = this.pluginVersionOf(place)
    return v !== undefined && v > 0 && v < SYNC_GATE_PLUGIN_VERSION ? v : null
  }

  // Per project file: the strictest gate over the Studio sessions mapped to it. With Forge Sync gating
  // rojo, a file no Studio check has cleared (no session, session over, or an old plugin's) is
  // 'waiting', unless the user chose "Serve without Studio check" for it.
  gateFor(projectFile: string): { gate: GateState; detail?: string; reason?: WaitReason } {
    let gate: GateState = 'idle'
    let conflicts = 0
    let studioOnly = 0
    let behind: number | null = null
    for (const state of this.placeStates.values()) {
      if (state.projectFile !== projectFile) continue
      const g = this.gate(state.placeKey)
      if (GATE_RANK[g] > GATE_RANK[gate]) gate = g
      if (g === 'waiting') behind = this.pluginBehind(state.place) ?? behind
      if (g === 'blocked') {
        conflicts += this.conflictsFor(state.placeKey).length
        const only = this.deps.engine?.studioOnly?.(state.placeKey)
        if (only?.holds) studioOnly += only.items.length
      }
    }
    if (gate === 'idle' || gate === 'waiting') {
      if (!this.active() || !this.settings().gateRojo) return { gate: 'idle' }
      if (this.noCheck.has(projectFile)) return { gate: 'idle', detail: 'Serving without a Studio check (your choice)' }
      const wait = this.waitFor(behind)
      return { gate: 'waiting', detail: wait.text, reason: wait.reason }
    }
    return { gate, detail: gateDetail(gate, conflicts, studioOnly) }
  }

  // Why a place file waits for its Studio check, in one line.
  private waitFor(behind: number | null): { reason: WaitReason; text: string } {
    const polling = this.deps.studios?.() ?? []
    const single = this.deps.studio?.() ?? null
    const old = behind ?? [...polling, ...(single?.connected ? [single] : [])].map((p) => p.pluginVersion ?? 0).find((v) => v > 0 && v < SYNC_GATE_PLUGIN_VERSION) ?? null
    if (old !== null) {
      return { reason: 'plugin', text: `Restart Studio to update the Forge Bridge plugin (v${old} → v${PLUGIN_VERSION}): rojo serve waits so Rojo cannot delete scripts that exist only in Studio` }
    }
    const unlinked = this.shownUnlinked()
    if (unlinked.length) {
      const quoted = unlinked.map((u) => `"${u.label ?? u.name}"`)
      const names = quoted.length <= 2 ? quoted.join(' and ') : `${quoted.slice(0, 2).join(', ')} and ${quoted.length - 2} more`
      const one = unlinked.length === 1
      return {
        reason: 'unlinked',
        text: `Studio has ${names} open, but ${one ? "it isn't" : "they aren't"} linked to this project: link ${one ? 'it' : "this project's place"} in Studio sync so Forge checks it first, or serve without a Studio check. Rojo serve waits so Rojo cannot delete scripts that exist only in Studio`
      }
    }
    if (polling.length || single?.connected) return { reason: 'studio', text: "Waiting for Studio's first sync check (Studio is connected; its Forge Sync check has not started yet)" }
    return { reason: 'studio', text: "Waiting for Studio's first sync check: open the place in Studio with the Forge Bridge plugin, or serve without a Studio check" }
  }

  places(): PlaceSyncStatus[] {
    const out: PlaceSyncStatus[] = []
    const studio = this.deps.studio?.() ?? null
    // A place with no checked session shows its file's gate ('waiting' and why, or 'idle').
    const shown = (gate: GateState, projectFile: string): Pick<PlaceSyncStatus, 'gate' | 'waitReason' | 'gateDetail'> => {
      if (gate !== 'idle' && gate !== 'waiting') return { gate }
      const file = this.gateFor(projectFile)
      if (file.gate !== 'waiting') return { gate: 'idle', ...(file.detail ? { gateDetail: file.detail } : {}) }
      return { gate: 'waiting', ...(file.reason ? { waitReason: file.reason } : {}), ...(file.detail ? { gateDetail: file.detail } : {}) }
    }
    for (const state of this.placeStates.values()) {
      const viaBridge = !!studio?.connected && this.isStudioPlace(studio, state.place)
      const pluginVersion = this.pluginVersionOf(state.place)
      out.push({
        placeKey: state.placeKey,
        projectFile: state.projectFile,
        place: state.place,
        ...shown(this.gate(state.placeKey), state.projectFile),
        ...(pluginVersion ? { pluginVersion } : {}),
        ...(this.fingerprints.has(state.placeKey) ? { fingerprint: this.fingerprints.get(state.placeKey)! } : {}),
        connected: viaBridge || this.now() - state.lastSeen < SEEN_MS,
        ...(state.lastSnapshot ? { lastSnapshot: state.lastSnapshot } : {}),
        counts: { ...state.counts },
        conflicts: this.conflictsFor(state.placeKey).length,
        ...this.studioOnlyLine(state),
        ...this.leftLine(state),
        ...(state.lastSnapshot && state.missingRoots.length ? { missingRoots: state.missingRoots.map((r) => r.join('.')) } : {})
      })
    }
    // Places no Studio session has opened yet ('waiting' for one with Forge Sync gating rojo).
    for (const map of this.maps) {
      if (out.some((p) => p.projectFile === map.projectFile)) continue
      const placeId = map.placeIds[0] ?? 0
      out.push({ placeKey: placeKeyOf({ placeId }, map.projectFile), projectFile: map.projectFile, ...shown('idle', map.projectFile), connected: false, counts: {}, conflicts: 0 })
    }
    return out.sort((a, b) => a.projectFile.localeCompare(b.projectFile))
  }

  async status(): Promise<SyncStatus> {
    await this.checkLegacyPlugin()
    const status: SyncStatus = {
      engine: this.settings().engine,
      places: this.settings().engine === 'forge' ? this.places() : [],
      recent: this.recent.slice(0, 50),
      pendingStudioEdits: await this.pendingStudioEdits(),
      legacyPluginInstalled: this.legacy.length > 0
    }
    if (this.legacy.length) status.legacyPlugins = this.legacy.map((f) => basename(f))
    const refs = this.unsyncedRefs(status.places)
    if (refs.total) {
      status.unsyncedRefs = refs.list
      status.unsyncedRefsTotal = refs.total
    }
    if (this.warning && status.pendingStudioEdits.length) status.warning = this.warning
    if (status.engine === 'forge') {
      const unlinked = this.shownUnlinked().map(({ probe: _probe, ...u }) => u)
      if (unlinked.length) status.unlinked = unlinked
      if (this.discarded) status.discarded = this.discarded
    }
    if (status.engine === 'forge') {
      const notice = await this.notice(status.places)
      if (notice) status.notice = notice
    }
    return status
  }

  // Unpublished places share PlaceId 0: the place name tells them apart.
  private isStudioPlace(studio: { placeId?: number; place?: string }, place: SyncPlace): boolean {
    const id = studio.placeId ?? 0
    if (id !== (place.placeId ?? 0)) return false
    return id !== 0 || !studio.place || !place.name || studio.place === place.name
  }

  private rootsOf(projectFile: string): string[][] {
    const map = this.maps.find((m) => m.projectFile === projectFile)
    return (map?.roots ?? []).filter((r) => !PACKAGES.test(r.path)).map((r) => r.instance)
  }

  // Why Studio edits are not reaching disk, when they are not. Shown in the Sync view and the status bar.
  async notice(places: PlaceSyncStatus[] = this.places()): Promise<SyncNotice | undefined> {
    if (!this.active()) return undefined
    const studio = this.deps.studio?.() ?? null
    if (!studio?.connected) {
      // A place the plugin talked to in the last minute is live even if the poll is between beats.
      if (places.some((p) => p.connected)) return undefined
      const plugin = this.deps.plugin ? await this.deps.plugin().catch(() => null) : null
      if (plugin && !plugin.installed) {
        return { level: 'warn', action: 'install-plugin', text: 'Not syncing: the Forge Bridge plugin is not installed in Roblox Studio. Install it, then restart Studio. Until it connects, Studio edits do not reach disk.' }
      }
      return { level: 'warn', text: 'Not syncing: no Forge Bridge plugin connected. Open the place in Roblox Studio (restart Studio after installing or updating the plugin, and allow HTTP requests to 127.0.0.1 when it asks). Until it connects, Studio edits do not reach disk.' }
    }
    const v = studio.pluginVersion ?? 0
    if (v > 0 && v < 2) return { level: 'warn', action: 'restart-studio', text: `Studio connected, place not synced: Studio runs Forge Bridge v${v}, which has no Forge Sync. Restart Studio to load v${PLUGIN_VERSION}.` }
    const name = studio.place ? `"${studio.place}"` : 'the place'
    const cfg = this.lastConfig
    if (cfg?.reason && this.isStudioPlace(studio, { placeId: cfg.placeId, name: cfg.name }) && this.now() - cfg.at < 5 * 60_000) {
      // Not linked: not a sync failure, that place is simply not this project's.
      if (/not linked to this project/.test(cfg.reason)) {
        if (places.some((p) => p.connected)) return undefined
        if (this.settings().gateRojo) {
          return { level: 'warn', text: `Studio has ${name} open, but it isn't linked to this project: nothing from it is synced, and rojo serve waits so Rojo cannot delete scripts that exist only in Studio. Link it below so Forge checks it first, or serve without a Studio check.` }
        }
        return { level: 'info', text: `Studio connected, ${name} is not linked to this project: nothing from it is synced. Link it in Source Control to sync it.` }
      }
      return { level: 'warn', text: `Studio connected, ${name} not synced: ${cfg.reason}.` }
    }
    const state = [...this.placeStates.values()].find((s) => this.isStudioPlace(studio, s.place))
    if (!state) {
      return { level: 'warn', text: `Studio connected, ${name} not synced yet: the Forge Bridge plugin has not started Forge Sync for it.${v < PLUGIN_VERSION ? ` Restart Studio to load plugin v${PLUGIN_VERSION}.` : ''}`, ...(v < PLUGIN_VERSION ? { action: 'restart-studio' as const } : {}) }
    }
    const roots = this.rootsOf(state.projectFile)
    if (state.lastSnapshot && state.missingRoots.length) {
      const list = state.missingRoots.map((r) => r.join('.')).join(', ')
      const all = state.missingRoots.length >= roots.length
      const later = v >= PLUGIN_VERSION ? 'Forge picks them up as soon as they appear.' : `Restart Studio to load plugin v${PLUGIN_VERSION}, which picks them up when they appear (v${v} does not).`
      return {
        level: 'warn',
        text: all
          ? `Studio connected, ${name} not synced: none of the mapped folders exist in Studio yet (${list}). Connect Rojo in Studio to build them. ${later}`
          : `Studio connected; not synced in ${name}: ${list} (not in Studio yet). ${later}`,
        ...(v < PLUGIN_VERSION ? { action: 'restart-studio' as const } : {})
      }
    }
    if (v > 0 && v < SYNC_GATE_PLUGIN_VERSION && this.settings().gateRojo) {
      return { level: 'warn', action: 'restart-studio', text: `Restart Studio to update the Forge Bridge plugin (v${v} → v${PLUGIN_VERSION}). Until then rojo serve waits: an older plugin's check could let Rojo delete scripts that exist only in Studio.` }
    }
    if (v > 0 && v < PLUGIN_VERSION) return { level: 'info', action: 'restart-studio', text: `Studio runs Forge Bridge v${v}; restart Studio to load v${PLUGIN_VERSION} (syncs folders Rojo creates after Studio opened, Script Editor text in unpublished places, and Ctrl+D copies of scripts).` }
    return undefined
  }

  // References reported by connected Studio sessions, de-duplicated across places, capped.
  private unsyncedRefs(places: PlaceSyncStatus[]): { list: SyncRef[]; total: number } {
    const live = new Set(places.filter((p) => p.connected).map((p) => p.placeKey))
    const seen = new Set<string>()
    const list: SyncRef[] = []
    let total = 0
    for (const state of this.placeStates.values()) {
      if (!live.has(state.placeKey) || !state.refsTotal) continue
      let fresh = 0
      for (const r of state.refs) {
        const key = `${r.path.join('\u0000')}\u0001${r.property}`
        if (seen.has(key)) continue
        seen.add(key)
        fresh++
        if (list.length < UNSYNCED_REFS_MAX) list.push({ path: [...r.path], property: r.property })
      }
      // Over the plugin's cap: count the unseen rest too (another place may share some of them).
      total += fresh + Math.max(0, state.refsTotal - state.refs.length)
    }
    return { list, total }
  }

  private setRefs(state: PlaceState, refs: SyncRef[], total?: number): void {
    state.refs = refs.slice(0, SYNC_REFS_KEEP)
    state.refsTotal = Math.max(refs.length, typeof total === 'number' ? total : 0)
  }

  // Files Forge wrote from Studio that git still shows as modified / untracked / deleted.
  async pendingStudioEdits(): Promise<string[]> {
    await this.loadWritten()
    if (!this.written.size) return []
    // Judge only the files known before git status ran: a file written while it ran is not in its
    // output yet and must not be forgotten.
    const known = [...this.written]
    const result = await this.deps.git(['--no-optional-locks', '-c', 'core.quotepath=false', 'status', '--porcelain', '-z', '--untracked-files=all'])
    if (result.code !== 0) return []
    const dirty = parsePorcelainZ(result.stdout)
    const pending = new Set<string>()
    const still = new Set<string>()
    for (const w of known) {
      for (const d of dirty) {
        if (d === w || d.startsWith(w.endsWith('/') ? w : `${w}/`)) {
          pending.add(d)
          still.add(w)
        }
      }
    }
    // Committed (by the user or by Forge) or reverted: forget it.
    if (still.size !== known.length) {
      for (const w of known) if (!still.has(w)) this.written.delete(w)
      await this.saveWritten()
    }
    return [...pending].sort()
  }

  // Coalesces status pushes: gates to the supervisor, status to the renderer.
  refresh(): void {
    if (this.refreshQueued || this.closed) return
    this.refreshQueued = true
    queueMicrotask(() => {
      this.refreshQueued = false
      if (this.closed) return
      this.pushGates()
      void this.status().then(
        (status) => this.deps.emit('sync:status', status),
        () => undefined
      )
    })
  }

  // Pushes changed per-file gates to the supervisor; true when one changed.
  private pushGates(): boolean {
    const files = new Set([...this.maps.map((m) => m.projectFile), ...[...this.placeStates.values()].map((s) => s.projectFile)])
    let changed = false
    for (const file of files) {
      const { gate, detail, reason } = this.gateFor(file)
      const key = `${gate}|${detail ?? ''}|${reason ?? ''}`
      if (this.pushedGates.get(file) === key) continue
      this.pushedGates.set(file, key)
      changed = true
      this.deps.onGate?.(file, gate, detail, reason)
    }
    return changed
  }

  // ---- Game tab ----

  // The live Studio tree for a place file (the session seen most recently), or null when no Studio
  // session has sent a snapshot: the synced roots from the engine plus the plugin's outline of the
  // rest of the mapped services. Kept after Studio disconnects (last known), like tree.json was.
  liveTree(projectFile: string): { nodes: LiveStudioNode[]; truncated: boolean } | null {
    if (!this.active()) return null
    const state = this.stateFor(projectFile)
    if (!state) return null
    const live = this.deps.engine?.liveTree?.(state.placeKey) ?? null
    if (!live && !state.outline) return null
    const nodes: LiveStudioNode[] = []
    for (const n of live?.nodes ?? []) {
      const props = displayProps(n.properties)
      nodes.push(props ? { path: n.path, className: n.className, props } : { path: n.path, className: n.className })
    }
    for (const n of state.outline?.nodes ?? []) nodes.push(n.props ? { path: n.path, className: n.className, props: n.props } : { path: n.path, className: n.className })
    return { nodes, truncated: !!state.outline?.truncated }
  }

  // Where "Save to repo" would write a Studio-only instance, or why it cannot.
  async saveTarget(projectFile: string, path: string[]): Promise<{ file: string } | { reason: string }> {
    const state = this.active() ? this.stateFor(projectFile) : null
    const engine = this.deps.engine
    if (!state || !engine?.saveTarget) return { reason: 'Connect Studio with Forge Sync on (Settings > Sync) to save Studio-only instances' }
    return engine.saveTarget(state.placeKey, path)
  }

  async saveToRepo(projectFile: string, path: string[]): Promise<SyncEntry> {
    const state = this.active() ? this.stateFor(projectFile) : null
    const engine = this.deps.engine
    if (!state || !engine?.saveToRepo) throw new Error('Connect Studio with Forge Sync on (Settings > Sync) to save Studio-only instances')
    const entry = await this.serial(() => engine.saveToRepo!(state.placeKey, path))
    await this.markWritten([entry.file])
    this.recent = [entry, ...this.recent].slice(0, RECENT_MAX)
    this.deps.emit('sync:entry', [entry])
    this.deps.log?.(`sync: saved ${path.join('.')} to ${entry.file}`)
    this.checkTree()
    this.refresh()
    return entry
  }

  // Why the Game tab's "Delete in Studio" must not run for this instance path, or null when it may
  // (the plugin checks again against the live DataModel: same-name siblings, what it streams).
  deleteRefusal(projectFile: string, path: string[]): string | null {
    if (!this.active()) return 'Turn Forge Sync on (Settings > Sync) to delete Studio-only instances from Forge'
    const state = this.stateFor(projectFile)
    if (!state) return 'Studio has not sent this place yet; open it in Studio with the Forge Bridge plugin on'
    const map = this.maps.find((m) => m.projectFile === state.projectFile)
    if (!map) return 'No *.project.json maps this place'
    return deleteRefusal(map, path)
  }

  private stateFor(projectFile: string): PlaceState | null {
    let best: PlaceState | null = null
    for (const state of this.placeStates.values()) {
      if (state.projectFile !== projectFile) continue
      const has = this.deps.engine?.treeVersion?.(state.placeKey) != null || !!state.outline
      if (!has) continue
      if (!best || state.lastSeen > best.lastSeen) best = state
    }
    return best
  }

  // Engine tree shape changed for some place (snapshot, add/remove/rename): Game tab rebuild.
  private checkTree(): void {
    for (const state of this.placeStates.values()) {
      const v = this.deps.engine?.treeVersion?.(state.placeKey) ?? null
      if (v === (state.treeVersion ?? null)) continue
      state.treeVersion = v
      this.scheduleTree()
    }
  }

  private treeTimer: ReturnType<typeof setTimeout> | null = null
  private treeAt = 0

  // At most one onStudioTree per throttle window; the last change in a window is never dropped.
  private scheduleTree(): void {
    if (!this.deps.onStudioTree || this.treeTimer || this.closed) return
    const wait = Math.max(0, this.treeAt + (this.deps.treeThrottleMs ?? TREE_THROTTLE_MS) - this.now())
    this.treeTimer = setTimeout(() => {
      this.treeTimer = null
      if (this.closed) return
      this.treeAt = this.now()
      this.deps.onStudioTree?.()
    }, wait)
    ;(this.treeTimer as { unref?: () => void }).unref?.()
  }

  // One line on what stays in Studio for a place: top-level Studio-only instances outside every $path
  // (from the outline) and Studio-only children of $ignoreUnknownInstances roots (from the engine).
  private leftLine(state: PlaceState): { leftInStudio?: PlaceSyncStatus['leftInStudio'] } {
    const map = this.maps.find((m) => m.projectFile === state.projectFile)
    const ignored = this.deps.engine?.leftInStudio?.(state.placeKey) ?? []
    const outside = map && state.outline ? outsideTops(map, state.outline.nodes) : []
    const count = ignored.length + outside.length
    if (!count) {
      state.leftNote = undefined
      return {}
    }
    const examples = [...outside, ...ignored].slice(0, 3).map((p) => p.join('.'))
    const why: string[] = []
    if (outside.length) why.push(`${outside.length} outside every Rojo $path`)
    if (ignored.length) why.push(`${ignored.length} under $ignoreUnknownInstances`)
    const note = `${count} Studio-only instance${count === 1 ? ' stays' : 's stay'} in Studio (${why.join(', ')}): ${examples.join(', ')}${count > examples.length ? ', …' : ''}. Rojo leaves ${count === 1 ? 'it' : 'them'} alone; right-click in the Game tab > Save to repo to track one.`
    if (state.leftNote !== note) {
      state.leftNote = note
      this.deps.log?.(`sync: ${state.projectFile}: ${note}`)
    }
    return { leftInStudio: { count, examples, note } }
  }

  private studioOnlyLine(state: PlaceState): { studioOnly?: PlaceSyncStatus['studioOnly'] } {
    const only = this.active() ? this.deps.engine?.studioOnly?.(state.placeKey) : undefined
    if (!only?.items.length) {
      state.studioOnlyNote = undefined
      return {}
    }
    const { items, holds } = only
    const note = `${items.length} Studio-only script${items.length === 1 ? '' : 's'} not on disk${holds ? ' (rojo serve held)' : ''}: ${items.slice(0, 3).map((i) => i.instancePath.join('.')).join(', ')}${items.length > 3 ? ', …' : ''}`
    if (state.studioOnlyNote !== note) {
      state.studioOnlyNote = note
      this.deps.log?.(`sync: ${state.projectFile}: ${note}`, 'stderr')
    }
    return { studioOnly: { count: items.length, pullable: items.filter((i) => i.canPull).length, holds, items: items.slice(0, STUDIO_ONLY_MAX) } }
  }

  // ---- internals ----

  private requireEngine(): SyncEngineLike {
    if (!this.deps.engine) throw new Error('Forge Sync is not available in this build')
    return this.deps.engine
  }

  private placeState(placeKey: string, projectFile: string, place: SyncPlace): PlaceState {
    let state = this.placeStates.get(placeKey)
    if (!state) {
      state = { placeKey, projectFile, place, counts: {}, lastSeen: 0, override: false, refs: [], refsTotal: 0, missingRoots: [] }
      this.placeStates.set(placeKey, state)
    }
    state.projectFile = projectFile
    state.place = place
    return state
  }

  private serial<T>(fn: () => Promise<T> | T): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  // live: entries of the change stream (a single new Studio-only instance gets its one-line note in
  // the feed); a snapshot's are summed up in the place's leftInStudio line instead.
  private async record(placeKey: string, entries: SyncEntry[], live = false): Promise<void> {
    const state = this.placeStates.get(placeKey)
    const shown: SyncEntry[] = []
    const writes: string[] = []
    for (const entry of entries) {
      if (entry.action === 'unmapped') {
        if (live && entry.note?.startsWith('left in Studio')) shown.push(entry)
        continue
      }
      if (state) state.counts[entry.action] = (state.counts[entry.action] ?? 0) + 1
      if (entry.action === 'same') continue
      // Every file leaving the project, and every delete the guard holds, is in the output panel.
      if (entry.action === 'trashed') this.deps.log?.(`sync: ${entry.file}: deleted in Studio, moved to ${entry.trashPath ?? '.forge/sync/trash'}${entry.note ? ` (${entry.note})` : ''}`)
      else if (entry.trashPath || (entry.action === 'conflict' && /keep or delete|not by Forge Sync|not removed by Forge Sync/.test(entry.note ?? ''))) this.deps.log?.(`sync: ${entry.file}: ${entry.note ?? `copy saved to ${entry.trashPath}`}`, 'stderr')
      shown.push(entry)
      if (WRITES.includes(entry.action)) {
        writes.push(entry.file)
        if (entry.from) writes.push(entry.from)
      }
    }
    if (writes.length) await this.markWritten(writes)
    if (!shown.length) return
    this.recent = [...shown.slice().reverse(), ...this.recent].slice(0, RECENT_MAX)
    this.deps.emit('sync:entry', shown)
  }

  private async markWritten(files: string[]): Promise<void> {
    await this.loadWritten()
    for (const f of files) this.written.add(f.replace(/\\/g, '/'))
    await this.saveWritten()
  }

  private async loadWritten(): Promise<void> {
    if (this.writtenLoaded) return
    this.writtenLoaded = true
    try {
      const data = JSON.parse(await readFile(join(this.root, WRITTEN_FILE), 'utf8'))
      if (Array.isArray(data?.files)) for (const f of data.files) if (typeof f === 'string') this.written.add(f)
    } catch {
      // first run
    }
  }

  private async saveWritten(): Promise<void> {
    const file = join(this.root, WRITTEN_FILE)
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify({ files: [...this.written].sort() }, null, 2))
    } catch (e) {
      this.deps.log?.(`sync: could not save ${WRITTEN_FILE}: ${(e as Error).message}`, 'stderr')
    }
  }
}

// Top-level services the place maps (first name of every project node): what the plugin outlines.
export function outlineContainers(map: PlaceMapLike): string[][] {
  const tops = new Set<string>()
  for (const p of [...map.roots.map((r) => r.instance), ...(map.skipped ?? []).map((s) => s.instance), ...(map.virtual ?? [])]) if (p.length) tops.add(p[0])
  return [...tops].sort().map((t) => [t])
}

// Outline instances that are the topmost Studio-only ones outside every $path: their parent is a
// project node (a service or a $className container) and they are not one themselves. Default
// service children named after their class (StarterCharacterScripts ...) are not counted.
export function outsideTops(map: PlaceMapLike, nodes: StudioOutlineNode[]): string[][] {
  const key = (p: string[]) => p.join('\u0000')
  const project = new Set<string>()
  for (const p of [...map.roots.map((r) => r.instance), ...(map.skipped ?? []).map((s) => s.instance), ...(map.virtual ?? [])]) {
    for (let i = 1; i <= p.length; i++) project.add(key(p.slice(0, i)))
  }
  const out: string[][] = []
  for (const n of nodes) {
    if (n.path.length < 2 || project.has(key(n.path)) || !project.has(key(n.path.slice(0, -1)))) continue
    if (n.className === n.path[n.path.length - 1]) continue
    out.push(n.path)
  }
  return out
}

// Delete in Studio is only for Studio-only instances: not a service, not a project node (a $path root,
// a skipped folder such as Packages, a $className container) or anything above or inside a $path.
export function deleteRefusal(map: PlaceMapLike, path: string[]): string | null {
  const dotted = path.join('.')
  if (path.length < 2) return `${dotted || 'That'} is a service; services cannot be deleted`
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])
  const under = (p: string[], prefix: string[]) => p.length > prefix.length && prefix.every((x, i) => x === p[i])
  for (const r of [...map.roots, ...(map.skipped ?? [])]) {
    if (same(path, r.instance) || under(path, r.instance)) return `${dotted} is synced to files (Rojo $path); delete the file in Forge instead`
    if (under(r.instance, path)) return `${dotted} holds ${r.instance.join('.')}, which Rojo maps to files; delete those files in Forge instead`
  }
  for (const v of map.virtual ?? []) {
    if (same(path, v) || under(v, path)) return `${dotted} is defined by the project file; edit the *.project.json instead`
  }
  return null
}

// A few display props (asset ids, sizes as text) for the Game tab; Rojo-typed values are skipped.
function displayProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!props) return undefined
  let out: Record<string, string | number | boolean> | undefined
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') (out ??= {})[k] = v
  }
  return out
}

// A plugin request for a session must come from that session's place.
function samePlace(a: SyncPlace, b: SyncPlace | undefined): boolean {
  return !!b && (Number(b.placeId) || 0) === (a.placeId || 0)
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}
