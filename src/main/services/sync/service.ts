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
  SyncAction,
  SyncConflictInfo,
  SyncEntry,
  SyncNotice,
  SyncPlace,
  SyncRef,
  SyncStatus
} from '../../../shared/sync/types.ts'
import { SYNC_ENGINE_SETTING, SYNC_GATE_SETTING, UNSYNCED_REFS_MAX } from '../../../shared/sync/types.ts'
import type { ForgeSyncSettings, SyncCommitResult } from '../../../shared/sync/api.ts'
import { PLUGIN_VERSION } from '../../../shared/studio/plugin.ts'
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
}

export interface PlaceMapLike {
  projectFile: string
  placeIds: number[]
  roots: { instance: string[]; path: string; isFile?: boolean; ignoreUnknown?: boolean }[]
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
  // The Forge Bridge plugin file in Studio's plugins folder (null: no plugins folder on this OS).
  plugin?: () => Promise<{ installed: boolean; version?: number } | null>
  // Gate per project file, for the supervisor (rojo serve waits while 'checking' / 'blocked').
  onGate?: (projectFile: string, gate: GateState, detail?: string) => void
  emit: (event: 'sync:status' | 'sync:entry', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Tests: how long a snapshot may stall before the hold is released (default SNAPSHOT_STALE_MS).
  staleMs?: number
}

const RECENT_MAX = 200
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
  // Mapped roots the last snapshot did not have (instance paths).
  missingRoots: string[][]
}

interface ConfigSeen {
  at: number
  placeId: number
  name?: string
  reason?: string
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
  // The plugin's last /sync/config request (refused ones carry the reason).
  private lastConfig: ConfigSeen | null = null

  constructor(deps: SyncServiceDeps) {
    this.deps = deps
    this.root = deps.root
    this.now = deps.now ?? Date.now
    deps.engine?.on('changed', () => this.refresh())
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
  }

  // ---- Bridge handler ----

  readonly handler: SyncHandler = {
    config: (q) => this.config(q),
    snapshot: (body) => this.snapshot(body),
    changes: (body) => this.changes(body)
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
    this.sessions.set(token, { token, placeKey, nextSeq: 0, ready: false, rootsSeen: new Set() })
    const state = this.placeState(placeKey, map.projectFile, place)
    state.lastSeen = this.now()
    const roots = map.roots.filter((r) => !PACKAGES.test(r.path)).map((r) => r.instance)
    const skip = map.roots.filter((r) => PACKAGES.test(r.path)).map((r) => r.instance)
    this.deps.log?.(`sync: Studio session for ${map.projectFile} (${placeKey}), ${roots.length} roots`)
    this.refresh()
    return { enabled: true, sessionToken: token, roots, skip }
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
          session.rootsSeen = new Set()
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
      for (const c of changes) {
        if (c.kind === 'added') state.missingRoots = state.missingRoots.filter((r) => r.join('\u0000') !== c.node.path.join('\u0000'))
        else if (c.kind === 'removed' && this.rootsOf(state.projectFile).some((r) => r.join('\u0000') === c.path.join('\u0000')) && !state.missingRoots.some((r) => r.join('\u0000') === c.path.join('\u0000'))) state.missingRoots = [...state.missingRoots, c.path]
      }
      const entries = changes.length ? await this.serial(() => this.deps.engine!.applyChanges(session.placeKey, changes)) : []
      await this.record(session.placeKey, entries)
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
      const viaBridge = !!studio?.connected && this.isStudioPlace(studio, state.place)
      out.push({
        placeKey: state.placeKey,
        projectFile: state.projectFile,
        place: state.place,
        gate: this.gate(state.placeKey),
        connected: viaBridge || this.now() - state.lastSeen < SEEN_MS,
        ...(state.lastSnapshot ? { lastSnapshot: state.lastSnapshot } : {}),
        counts: { ...state.counts },
        conflicts: this.conflictsFor(state.placeKey).length,
        ...(state.lastSnapshot && state.missingRoots.length ? { missingRoots: state.missingRoots.map((r) => r.join('.')) } : {})
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
    if (v > 0 && v < PLUGIN_VERSION) return { level: 'info', action: 'restart-studio', text: `Studio runs Forge Bridge v${v}; restart Studio to load v${PLUGIN_VERSION} (syncs folders Rojo creates after Studio opened, and Script Editor text in unpublished places).` }
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

  private async record(placeKey: string, entries: SyncEntry[]): Promise<void> {
    const state = this.placeStates.get(placeKey)
    const shown: SyncEntry[] = []
    const writes: string[] = []
    for (const entry of entries) {
      if (entry.action === 'unmapped') continue
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

function firstLine(text: string): string {
  return text.trim().split(/\r?\n/)[0] ?? ''
}
