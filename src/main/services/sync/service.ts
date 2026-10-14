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
  PlaceSyncStatus,
  StudioChange,
  StudioNode,
  StudioOutlineNode,
  SyncAction,
  SyncConflictInfo,
  SyncEntry,
  SyncPlace,
  SyncRef,
  SyncStatus
} from '../../../shared/sync/types.ts'
import { SYNC_ENGINE_SETTING, SYNC_GATE_SETTING, UNSYNCED_REFS_MAX } from '../../../shared/sync/types.ts'
import type { ForgeSyncSettings, SyncCommitResult } from '../../../shared/sync/api.ts'
import { disableLegacyPlugins, findLegacyPlugins } from './legacy.ts'

// ---- What the service needs from the engine worker's modules (engine.ts, mapping.ts) ----
// Structural copies of the contract's Engine API, so this file builds and is tested before they land.

export interface SyncEngineLike {
  reload(): unknown
  beginSnapshot(placeKey: string, place: SyncPlace): unknown
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
}

export interface SyncConfigAnswer {
  enabled: boolean
  sessionToken: string
  roots: string[][]
  skip: string[][]
  reason?: string
  outline?: string[][]
  outlineMax?: number
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
  studio?: () => { placeId?: number; connected: boolean } | null
  // Gate per project file, for the supervisor (rojo serve waits while 'checking' / 'blocked').
  onGate?: (projectFile: string, gate: GateState, detail?: string) => void
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
// Unsynced references kept per place (a snapshot may arrive in many chunks).
const SYNC_REFS_KEEP = 2000
const WRITTEN_FILE = join('.forge', 'sync', 'forge-written.json')
const PACKAGES = /^(Server|Dev)?Packages(\/|$)/
// Written from Studio: the file (and, for renames, its old path) is Forge's change, not the user's.
const WRITES: SyncAction[] = ['pulled', 'merged', 'created', 'renamed', 'trashed']
const GATE_RANK: Record<GateState, number> = { idle: 0, clear: 1, checking: 2, blocked: 3 }

interface Session {
  token: string
  placeKey: string
  nextSeq: number
  ready: boolean
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
}

export function placeKeyOf(place: SyncPlace, projectFile?: string): string {
  if (place.placeId) return String(place.placeId)
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

export function gateDetail(gate: GateState, conflicts: number): string | undefined {
  if (gate === 'checking') return 'Waiting for Studio sync check'
  if (gate === 'blocked') return `${conflicts} conflict${conflicts === 1 ? '' : 's'}: resolve or serve anyway`
  return undefined
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

  constructor(deps: SyncServiceDeps) {
    this.deps = deps
    this.root = deps.root
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
    await this.loadWritten()
    await this.reload()
    await this.checkLegacyPlugin()
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
    this.refresh()
  }

  close(): void {
    this.closed = true
    this.sessions.clear()
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
    const off = (reason: string): SyncConfigAnswer => ({ enabled: false, sessionToken: '', roots: [], skip: [], reason })
    if (!this.active()) return off(this.settings().engine === 'forge' ? 'Forge Sync is not available in this build' : `Studio sync is set to "${this.settings().engine}"`)
    if (!this.maps.length) await this.reload()
    const placeId = Number(q.placeId) || 0
    // Like Rojo's servePlaceIds: once the project lists its places, another published place (a test
    // copy, an unrelated game) is not this project. Without this it fell back to default.project.json,
    // wrote its Studio-only instances into the repo and held that place's rojo serve on its conflicts.
    if (placeId && this.maps.some((m) => m.placeIds.length) && !this.maps.some((m) => m.placeIds.includes(placeId))) {
      this.deps.log?.(`sync: off for Studio place ${placeId}: not in any *.project.json servePlaceIds (or tools/studio-sync.json placeIds); add it there to sync this place`)
      return off(`Place ${placeId} is not in any *.project.json servePlaceIds`)
    }
    const map = this.deps.mapping!.placeFor(this.maps, placeId)
    if (!map) return off('No *.project.json maps this place')
    const place: SyncPlace = { placeId, ...(q.gameId ? { gameId: Number(q.gameId) } : {}), ...(q.place ? { name: String(q.place) } : {}) }
    const placeKey = placeKeyOf(place, map.projectFile)
    for (const [token, s] of this.sessions) if (s.placeKey === placeKey) this.sessions.delete(token)
    const token = randomUUID()
    this.sessions.set(token, { token, placeKey, nextSeq: 0, ready: false })
    const state = this.placeState(placeKey, map.projectFile, place)
    state.lastSeen = this.now()
    const roots = map.roots.filter((r) => !PACKAGES.test(r.path)).map((r) => r.instance)
    const skip = map.roots.filter((r) => PACKAGES.test(r.path)).map((r) => r.instance)
    this.deps.log?.(`sync: Studio session for ${map.projectFile} (${placeKey}), ${roots.length} roots`)
    this.refresh()
    return { enabled: true, sessionToken: token, roots, skip, outline: outlineContainers(map), outlineMax: OUTLINE_MAX }
  }

  // Game-tab outline (plugin v5): names and classes of the mapped services' instances outside the roots.
  private async outline(body: OutlineBody): Promise<SyncAnswer> {
    if (!this.active()) return { ok: false, error: 'Forge Sync is off' }
    const session = this.sessions.get(body.session)
    if (!session) return { ok: false, error: 'unknown session' }
    const state = this.placeStates.get(session.placeKey)!
    state.lastSeen = this.now()
    const nodes = Array.isArray(body.nodes) ? body.nodes : []
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
    const state = this.placeStates.get(session.placeKey)!
    state.lastSeen = this.now()
    try {
      return await this.serial(async () => {
        if (body.seq === 0) {
          // A (re)starting snapshot: gate goes 'checking', so a running rojo serve for this place stops.
          session.nextSeq = 0
          session.ready = false
          state.override = false
          state.counts = {}
          state.snapshotRefs = []
          await engine.beginSnapshot(session.placeKey, state.place)
          this.refresh()
        }
        if (body.seq !== session.nextSeq) {
          const expected = session.nextSeq
          session.nextSeq = 0
          return { ok: false, error: `snapshot chunk ${body.seq} out of order (expected ${expected})`, resend: true } as SyncAnswer
        }
        await engine.addSnapshot(session.placeKey, Array.isArray(body.nodes) ? body.nodes : [])
        if (Array.isArray(body.refs)) (state.snapshotRefs ??= []).push(...body.refs)
        session.nextSeq++
        this.watchSnapshot(session.token, session.placeKey, !!body.final)
        if (body.final) {
          const entries = await engine.finishSnapshot(session.placeKey)
          this.checkTree()
          session.ready = true
          state.lastSnapshot = this.now()
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
      this.deps.log?.(`sync: Studio stopped sending the snapshot for ${placeKey}; rojo may serve again`, 'stderr')
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
    const state = this.placeStates.get(session.placeKey)!
    state.lastSeen = this.now()
    try {
      if (Array.isArray(body.refs)) this.setRefs(state, body.refs, body.refsTotal)
      const changes = Array.isArray(body.changes) ? body.changes : []
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
    const files = await this.pendingStudioEdits()
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
    const gate = this.deps.engine!.gate(placeKey)
    return state.override && gate === 'blocked' ? 'clear' : gate
  }

  // Per project file: the strictest gate over the Studio sessions mapped to it.
  gateFor(projectFile: string): { gate: GateState; detail?: string } {
    let gate: GateState = 'idle'
    let conflicts = 0
    for (const state of this.placeStates.values()) {
      if (state.projectFile !== projectFile) continue
      const g = this.gate(state.placeKey)
      if (GATE_RANK[g] > GATE_RANK[gate]) gate = g
      if (g === 'blocked') conflicts += this.conflictsFor(state.placeKey).length
    }
    return { gate, detail: gateDetail(gate, conflicts) }
  }

  places(): PlaceSyncStatus[] {
    const out: PlaceSyncStatus[] = []
    const studio = this.deps.studio?.() ?? null
    for (const state of this.placeStates.values()) {
      const viaBridge = !!studio?.connected && studio.placeId === state.place.placeId
      out.push({
        placeKey: state.placeKey,
        projectFile: state.projectFile,
        place: state.place,
        gate: this.gate(state.placeKey),
        connected: viaBridge || this.now() - state.lastSeen < SEEN_MS,
        ...(state.lastSnapshot ? { lastSnapshot: state.lastSnapshot } : {}),
        counts: { ...state.counts },
        conflicts: this.conflictsFor(state.placeKey).length,
        ...this.leftLine(state)
      })
    }
    // Places no Studio session has opened yet (idle: rojo serves them normally).
    for (const map of this.maps) {
      if (out.some((p) => p.projectFile === map.projectFile)) continue
      const placeId = map.placeIds[0] ?? 0
      out.push({ placeKey: placeKeyOf({ placeId }, map.projectFile), projectFile: map.projectFile, gate: 'idle', connected: false, counts: {}, conflicts: 0 })
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
    return status
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

  private pushGates(): void {
    const files = new Set([...this.maps.map((m) => m.projectFile), ...[...this.placeStates.values()].map((s) => s.projectFile)])
    for (const file of files) {
      const { gate, detail } = this.gateFor(file)
      const key = `${gate}|${detail ?? ''}`
      if (this.pushedGates.get(file) === key) continue
      this.pushedGates.set(file, key)
      this.deps.onGate?.(file, gate, detail)
    }
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

  // ---- internals ----

  private requireEngine(): SyncEngineLike {
    if (!this.deps.engine) throw new Error('Forge Sync is not available in this build')
    return this.deps.engine
  }

  private placeState(placeKey: string, projectFile: string, place: SyncPlace): PlaceState {
    let state = this.placeStates.get(placeKey)
    if (!state) {
      state = { placeKey, projectFile, place, counts: {}, lastSeen: 0, override: false, refs: [], refsTotal: 0 }
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

// A few display props (asset ids, sizes as text) for the Game tab; Rojo-typed values are skipped.
function displayProps(props: Record<string, unknown> | undefined): Record<string, string | number | boolean> | undefined {
  if (!props) return undefined
  let out: Record<string, string | number | boolean> | undefined
  for (const [k, v] of Object.entries(props)) {
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') (out ??= {})[k] = v
  }
  return out
}

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}
