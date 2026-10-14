// Forge Sync engine: reconciles a place's Studio snapshot / change stream with the disk, per place,
// against the base store, and decides the Rojo gate. Forge never writes into Studio: disk -> Studio
// stays Rojo's job once the gate is clear. No electron imports; the SyncService (service.ts) wires
// this to the bridge and the UI.
//
// Per file with Studio S, disk D, base B (compared normalised):
//   S==D same | S==B,D!=B disk-ahead | D==B,S!=B pulled | else diff3(B,D,S) merged or conflict
//   no base and S!=D -> conflict (first-run); Studio-only -> created; disk-only with base -> trashed
//   (deleted in Studio; conflict if the disk copy changed since), disk-only without base -> disk-ahead.

import * as nodeFs from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import type { GateState, PlaceSyncStatus, StudioChange, StudioNode, SyncAction, SyncConflictInfo, SyncEntry, SyncPlace } from '../../../shared/sync/types.ts'
import { cleanRel, type DiskProbe, findRoot, fromDisk, insideMappedRoots, isProjectNode, isScriptClass, isSkipped, loadPlaces, PACKAGE_DIRS, parseFileName, type PlaceMap, placeFor, type SyncRoot, toDisk, unsafeName } from './mapping.ts'
import { diff3, normalise, toFileText } from './merge.ts'
import { canonicalJson, canonicalModel, detectStyle, modelFromStudio, readModel, writeMeta, writeModel } from './modelJson.ts'
import { atomicWrite, BaseStore, hashText, migrateLegacy, type SyncFs, TRASH_DIR } from './store.ts'

export type { SyncFs } from './store.ts'

export interface SyncEngineOptions {
  root: string
  fs?: SyncFs
  now?: () => number
}

// Thrown by applyChanges when the engine has no tree for the place (e.g. after a restart):
// the bridge answers { ok: false, resend: true } and the plugin sends a full snapshot.
export class SyncResendError extends Error {
  constructor(message = 'no snapshot for this place: resend a full snapshot') {
    super(message)
    this.name = 'SyncResendError'
  }
}

export function placeKeyFor(place: SyncPlace): string {
  return place.placeId ? String(place.placeId) : `unpublished:${place.name ?? 'Place'}`
}

type UnitKind = 'script' | 'model' | 'meta' | 'folder'

interface Unit {
  kind: UnitKind
  file: string
  instancePath: string[]
  // The instance's own file/dir (not its meta file).
  primary: boolean
  // What a rename moves: the file, or the directory for init scripts and folders.
  anchor: string
  // Adjacent X.meta.json that moves along with a non-init script.
  meta?: string
  // Desired file content given the current disk text.
  render: (disk: string | null) => string
  oversize?: boolean
}

interface Plan {
  units: Unit[]
  refused: { path: string[]; note: string }[]
  present: SyncRoot[]
  // Files never trashed/written this pass (Rojo-owned, oversize, root meta ...).
  keep: Set<string>
}

interface HeldConflict {
  info: SyncConflictInfo
  kind: UnitKind
  // Rendered Studio content for the file ('' and studioDeleted when Studio removed it).
  studioText: string
  studioCanon: string
  studioDeleted: boolean
  diskDeleted: boolean
}

interface Session {
  placeKey: string
  place: SyncPlace
  map: PlaceMap
  gate: GateState
  connected: boolean
  buffer: StudioNode[] | null
  tree: Map<string, StudioNode> | null
  lastSnapshot?: number
  counts: Partial<Record<SyncAction, number>>
  conflicts: Map<string, HeldConflict>
  protect: Set<string>
}

const KEY = '\u0000'
const pkey = (path: string[]): string => path.join(KEY)
const startsWith = (path: string[], prefix: string[]): boolean => prefix.length <= path.length && prefix.every((p, i) => path[i] === p)
const related = (a: string[], b: string[]): boolean => startsWith(a, b) || startsWith(b, a)
const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const isInitFile = (rel: string): boolean => /(^|\/)init(\.server|\.client|\.plugin)?\.luau?$/.test(rel)

function canon(kind: UnitKind | 'meta', text: string): string {
  if (kind === 'model') return canonicalModel(text) ?? normalise(text)
  if (kind === 'meta') return canonicalJson(text) ?? normalise(text)
  return normalise(text)
}

function kindOfFile(rel: string): UnitKind | null {
  const info = parseFileName(rel.split('/').pop()!)
  if (!info) return null
  if (info.kind === 'script' || info.kind === 'model' || info.kind === 'meta') return info.kind
  return null
}

const RECENT_LIMIT = 200

// Git keeps no empty directories, so a Folder that is empty in Studio would vanish on the next clone
// and Rojo would then delete it from Studio. Forge drops an empty .gitkeep into such a directory and
// removes it once the folder has real children. Rojo 7 ignores it: a file no sync rule matches
// snapshots to nothing (rojo v7.7.0 src/snapshot_middleware/mod.rs, snapshot_from_path -> Ok(None)),
// and fromDisk/parseFileName map it to no instance.
export const GITKEEP = '.gitkeep'
const isGitkeep = (rel: string): boolean => rel === GITKEEP || rel.endsWith('/' + GITKEEP)

export class SyncEngine {
  readonly root: string
  private readonly fs: SyncFs
  private readonly now: () => number
  private readonly store: BaseStore
  private maps: PlaceMap[] = []
  private loaded: Promise<void> | null = null
  private readonly sessions = new Map<string, Session>()
  private readonly recentEntries: SyncEntry[] = []
  private readonly listeners = new Set<(placeKey: string) => void>()
  private queue: Promise<unknown> = Promise.resolve()

  constructor(options: SyncEngineOptions) {
    this.root = resolvePath(options.root)
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? Date.now
    this.store = new BaseStore(this.root, this.fs)
  }

  // ---- public API ----

  on(event: 'changed', fn: (placeKey: string) => void): () => void {
    if (event !== 'changed') throw new Error(`unknown event ${event}`)
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  // Re-reads the project files (mapping) and the base store.
  reload(): Promise<void> {
    return this.serial(async () => {
      this.loaded = null
      await this.ensureLoaded()
      for (const s of this.sessions.values()) s.map = placeFor(this.maps, s.place.placeId) ?? s.map
    })
  }

  async places(): Promise<PlaceMap[]> {
    await this.ensureLoaded()
    return this.maps
  }

  // What the plugin should watch for a place (GET /forge-bridge/sync/config).
  async configFor(place: SyncPlace): Promise<{ projectFile: string; roots: string[][]; skip: string[][] } | null> {
    await this.ensureLoaded()
    const map = placeFor(this.maps, place.placeId)
    if (!map) return null
    return { projectFile: map.projectFile, roots: map.roots.map((r) => r.instance), skip: map.skipped.map((s) => s.instance) }
  }

  beginSnapshot(placeKey: string, place: SyncPlace): void {
    const s = this.session(placeKey, place)
    s.buffer = []
    s.connected = true
    s.gate = 'checking'
    this.emit(placeKey)
  }

  addSnapshot(placeKey: string, nodes: StudioNode[]): void {
    const s = this.sessions.get(placeKey)
    if (!s || !s.buffer) throw new SyncResendError('snapshot chunk without beginSnapshot')
    s.buffer.push(...nodes)
  }

  finishSnapshot(placeKey: string): Promise<SyncEntry[]> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const s = this.sessions.get(placeKey)
      if (!s || !s.buffer) throw new SyncResendError('finishSnapshot without beginSnapshot')
      s.map = placeFor(this.maps, s.place.placeId) ?? s.map
      const tree = new Map<string, StudioNode>()
      for (const node of s.buffer) if (node && typeof node.id === 'string' && Array.isArray(node.path)) tree.set(node.id, node)
      s.buffer = null
      s.tree = tree
      s.protect.clear()
      s.conflicts.clear()
      const entries = await this.reconcile(s, null)
      s.lastSnapshot = this.now()
      this.updateGate(s)
      return this.finish(s, entries)
    })
  }

  applyChanges(placeKey: string, changes: StudioChange[]): Promise<SyncEntry[]> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const s = this.sessions.get(placeKey)
      if (!s || !s.tree) throw new SyncResendError()
      const entries: SyncEntry[] = []
      const scope: string[][] = []
      for (const change of changes) {
        if (change.kind === 'renamed' || change.kind === 'moved') {
          entries.push(...(await this.applyRename(s, change)))
          scope.push(change.from, change.node.path)
        } else if (change.kind === 'removed') {
          this.removeSubtree(s, change.id, change.path)
          scope.push(change.path)
        } else if (change.kind === 'added') {
          for (const node of [change.node, ...(change.descendants ?? [])]) s.tree.set(node.id, node)
          scope.push(change.node.path)
        } else {
          const old = s.tree.get(change.node.id)
          if (old && pkey(old.path) !== pkey(change.node.path)) this.removeSubtree(s, old.id, old.path)
          // Unknown id (e.g. the plugin's table was rebuilt): the node at that path is the same instance.
          if (!old) for (const [id, n] of s.tree) if (pkey(n.path) === pkey(change.node.path) && n.className === change.node.className) s.tree.delete(id)
          s.tree.set(change.node.id, change.node)
          scope.push(change.node.path)
        }
      }
      if (scope.length) entries.push(...(await this.reconcile(s, scope)))
      this.updateGate(s)
      return this.finish(s, entries)
    })
  }

  // Studio session ended (plugin gone): the gate goes back to idle.
  endSession(placeKey: string): void {
    const s = this.sessions.get(placeKey)
    if (!s) return
    s.connected = false
    s.tree = null
    s.buffer = null
    s.conflicts.clear()
    s.gate = 'idle'
    this.emit(placeKey)
  }

  gate(placeKey: string): GateState {
    return this.sessions.get(placeKey)?.gate ?? 'idle'
  }

  conflicts(placeKey?: string): SyncConflictInfo[] {
    const out: SyncConflictInfo[] = []
    for (const s of this.sessions.values()) if (!placeKey || s.placeKey === placeKey) for (const c of s.conflicts.values()) out.push(c.info)
    return out
  }

  statuses(): PlaceSyncStatus[] {
    return [...this.sessions.values()].map((s) => ({ placeKey: s.placeKey, projectFile: s.map.projectFile, place: s.place, gate: s.gate, connected: s.connected, lastSnapshot: s.lastSnapshot, counts: { ...s.counts }, conflicts: s.conflicts.size }))
  }

  recent(): SyncEntry[] {
    return [...this.recentEntries]
  }

  resolve(placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string): Promise<void> {
    return this.serial(async () => {
      const s = this.sessions.get(placeKey)
      const held = s?.conflicts.get(file)
      if (!s || !held) throw new Error(`no conflict for ${file} in ${placeKey}`)
      await this.resolveOne(s, held, take, text)
      await this.store.save()
      this.updateGate(s)
      this.emit(placeKey)
    })
  }

  // Every held conflict of the place, or only those with `reason` (the first-run "Studio wins" /
  // "Disk wins" choice must not also decide files both sides edited).
  resolveAll(placeKey: string, take: 'studio' | 'disk', reason?: SyncConflictInfo['reason']): Promise<number> {
    return this.serial(async () => {
      const s = this.sessions.get(placeKey)
      if (!s) return 0
      const held = [...s.conflicts.values()].filter((c) => !reason || c.info.reason === reason)
      for (const c of held) await this.resolveOne(s, c, take)
      await this.store.save()
      this.updateGate(s)
      this.emit(placeKey)
      return held.length
    })
  }

  // ---- internals: plumbing ----

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private ensureLoaded(): Promise<void> {
    this.loaded ??= (async () => {
      this.maps = await loadPlaces(this.root)
      await this.store.load()
      const def = this.maps.find((m) => m.projectFile === 'default.project.json') ?? this.maps[0]
      await migrateLegacy(this.root, this.store, (def?.placeIds ?? []).map(String), this.fs)
    })()
    return this.loaded
  }

  private session(placeKey: string, place: SyncPlace): Session {
    let s = this.sessions.get(placeKey)
    const map = placeFor(this.maps, place.placeId) ?? { projectFile: 'default.project.json', name: '', root: this.root, placeIds: [], emitLegacyScripts: true, roots: [], skipped: [], virtual: [], skipGlobs: [] }
    if (!s) {
      s = { placeKey, place, map, gate: 'idle', connected: false, buffer: null, tree: null, counts: {}, conflicts: new Map(), protect: new Set() }
      this.sessions.set(placeKey, s)
    } else s.place = place
    if (this.maps.length) s.map = map
    return s
  }

  private emit(placeKey: string): void {
    for (const fn of this.listeners) {
      try {
        fn(placeKey)
      } catch {
        // listeners must not break the engine
      }
    }
  }

  private updateGate(s: Session): void {
    if (!s.connected) s.gate = 'idle'
    else if (s.buffer) s.gate = 'checking'
    else s.gate = s.conflicts.size ? 'blocked' : 'clear'
  }

  private async finish(s: Session, entries: SyncEntry[]): Promise<SyncEntry[]> {
    await this.store.save()
    for (const e of entries) {
      s.counts[e.action] = (s.counts[e.action] ?? 0) + 1
      // Routine "left alone" notes would flood the feed on every snapshot; refusals stay visible.
      if (e.action !== 'same' && !(e.action === 'unmapped' && !/^(unsafe name|duplicate|refused|script too large)/.test(e.note ?? ''))) this.recentEntries.unshift(e)
    }
    this.recentEntries.splice(RECENT_LIMIT)
    this.emit(s.placeKey)
    return entries
  }

  private entry(file: string, action: SyncAction, instancePath: string[], extra: Partial<SyncEntry> = {}): SyncEntry {
    return { file, action, instancePath, at: this.now(), ...extra }
  }

  // ---- internals: safe disk access ----

  private abs(rel: string): string {
    return join(this.root, ...rel.split('/'))
  }

  // Refuses anything that is not a clean relative path inside one of the place's mapped roots, or
  // that goes through a symbolic link (a link could point anywhere outside the project).
  private async guard(map: PlaceMap, rel: string): Promise<string> {
    const clean = cleanRel(rel)
    if (!clean || clean !== rel || !insideMappedRoots(map, rel)) throw new Error(`refusing to write outside mapped roots: ${rel}`)
    const parts = rel.split('/')
    for (let i = 1; i <= parts.length; i++) {
      const info = await this.fs.lstat(this.abs(parts.slice(0, i).join('/'))).catch(() => null)
      if (!info) break
      if (info.isSymbolicLink()) throw new Error(`refusing to write through a symbolic link: ${parts.slice(0, i).join('/')}`)
    }
    return this.abs(rel)
  }

  private async read(rel: string): Promise<string | null> {
    try {
      const info = await this.fs.lstat(this.abs(rel))
      if (!info.isFile()) return null
      return await this.fs.readFile(this.abs(rel), 'utf8')
    } catch {
      return null
    }
  }

  private async writeFile(map: PlaceMap, rel: string, text: string): Promise<void> {
    await atomicWrite(this.fs, await this.guard(map, rel), text)
  }

  private async trash(map: PlaceMap, rel: string, stamp: string): Promise<void> {
    const from = await this.guard(map, rel)
    const to = join(this.root, ...TRASH_DIR.split('/'), stamp, ...rel.split('/'))
    await this.fs.mkdir(join(to, '..'), { recursive: true })
    await this.fs.rename(from, to)
    await this.pruneEmpty(map, dirOf(rel))
  }

  private async pruneEmpty(map: PlaceMap, dir: string): Promise<void> {
    while (dir && !map.roots.some((r) => r.path === dir) && insideMappedRoots(map, dir + '/x')) {
      const entries = await this.fs.readdir(this.abs(dir)).catch(() => null)
      if (!entries || entries.length) return
      await this.fs.rmdir(this.abs(dir)).catch(() => undefined)
      dir = dirOf(dir)
    }
  }

  private stamp(): string {
    return new Date(this.now()).toISOString().replace(/[:.]/g, '-')
  }

  // Every file and directory under the place's mapped roots (no symlinks followed).
  private async scan(map: PlaceMap): Promise<{ files: Set<string>; dirs: Set<string> }> {
    const files = new Set<string>()
    const dirs = new Set<string>()
    const walk = async (rel: string): Promise<void> => {
      if (dirs.has(rel)) return
      dirs.add(rel)
      const entries = await this.fs.readdir(this.abs(rel), { withFileTypes: true }).catch(() => [])
      for (const e of entries) {
        const child = `${rel}/${e.name}`
        if (PACKAGE_DIRS.has(e.name) || isSkipped(map.skipGlobs, child) || e.name.endsWith('.forge-tmp')) continue
        if (e.isDirectory()) await walk(child)
        else if (e.isFile()) files.add(child)
      }
    }
    for (const r of map.roots) {
      if (r.isFile) {
        if (await this.fs.lstat(this.abs(r.path)).then((i) => i.isFile(), () => false)) files.add(r.path)
      } else await walk(r.path)
    }
    return { files, dirs }
  }

  // ---- internals: planning (Studio tree -> files) ----

  private plan(s: Session, probe: DiskProbe): Plan {
    const map = s.map
    const kids = new Map<string, StudioNode[]>()
    const byPath = new Map<string, StudioNode[]>()
    for (const node of s.tree!.values()) {
      const k = pkey(node.path)
      ;(byPath.get(k) ?? byPath.set(k, []).get(k)!).push(node)
      if (node.path.length) {
        const parent = pkey(node.path.slice(0, -1))
        ;(kids.get(parent) ?? kids.set(parent, []).get(parent)!).push(node)
      }
    }
    const childrenOf = (path: string[]): StudioNode[] => (kids.get(pkey(path)) ?? []).filter((c) => !isProjectNode(map, c.path))
    const scriptMemo = new Map<string, boolean>()
    const hasScripts = (node: StudioNode): boolean => {
      const k = pkey(node.path)
      let v = scriptMemo.get(k)
      if (v === undefined) {
        v = childrenOf(node.path).some((c) => isScriptClass(c.className) || hasScripts(c))
        scriptMemo.set(k, v)
      }
      return v
    }
    const subtree = (node: StudioNode): StudioNode[] => {
      const out: StudioNode[] = []
      const visit = (n: StudioNode): void => {
        for (const c of kids.get(pkey(n.path)) ?? []) {
          out.push(c)
          visit(c)
        }
      }
      visit(node)
      return out
    }
    const plan: Plan = { units: [], refused: [], present: [], keep: new Set() }

    const scriptUnits = (node: StudioNode, file: string, metaFile: string | undefined, runContext: string | undefined, hasChildren: boolean): void => {
      const init = isInitFile(file)
      const anchor = init ? dirOf(file) : file
      const leaf = node.path[node.path.length - 1]
      const adjacent = metaFile ?? (init ? `${dirOf(file)}/init.meta.json` : `${dirOf(file) ? dirOf(file) + '/' : ''}${leaf}.meta.json`)
      if (node.oversize || typeof node.source !== 'string') {
        plan.keep.add(file)
        plan.keep.add(adjacent)
        plan.refused.push({ path: node.path, note: node.oversize ? 'script too large to sync (oversize)' : 'script without source' })
        return
      }
      const source = node.source
      const hasMeta = Boolean(metaFile) || probe.isFile(adjacent)
      plan.units.push({ kind: 'script', file, instancePath: node.path, primary: true, anchor, meta: !init && hasMeta ? adjacent : undefined, render: () => source })
      if (hasMeta) plan.units.push({ kind: 'meta', file: adjacent, instancePath: node.path, primary: false, anchor: adjacent, render: (disk) => writeMeta(disk, { runContext: runContext ?? null }, true) })
      if (hasChildren && !init) for (const c of childrenOf(node.path)) plan.refused.push({ path: c.path, note: 'parent script is a single file' })
    }

    const folderUnits = (node: StudioNode, dir: string): void => {
      plan.units.push({ kind: 'folder', file: dir, instancePath: node.path, primary: true, anchor: dir, render: () => '' })
      const meta = `${dir}/init.meta.json`
      const needs = node.className !== 'Folder' || Object.keys(node.properties ?? {}).length > 0 || Object.keys(node.attributes ?? {}).length > 0 || (node.tags?.length ?? 0) > 0
      if (needs || probe.isFile(meta)) plan.units.push({ kind: 'meta', file: meta, instancePath: node.path, primary: false, anchor: meta, render: (disk) => writeMeta(disk, { className: node.className, properties: node.properties, attributes: node.attributes, tags: node.tags }, false) })
    }

    const planChildren = (parent: string[]): void => {
      const children = childrenOf(parent)
      const counts = new Map<string, number>()
      for (const c of children) {
        const name = c.path[c.path.length - 1].toLowerCase()
        counts.set(name, (counts.get(name) ?? 0) + 1)
      }
      for (const c of children) {
        const name = c.path[c.path.length - 1]
        const unsafe = unsafeName(name)
        if (unsafe) {
          plan.refused.push({ path: c.path, note: `unsafe name: ${unsafe}` })
          continue
        }
        if ((counts.get(name.toLowerCase()) ?? 0) > 1) {
          plan.refused.push({ path: c.path, note: 'duplicate sibling name' })
          continue
        }
        planNode(c)
      }
    }

    const planNode = (node: StudioNode): void => {
      const hasChildren = childrenOf(node.path).length > 0
      const script = isScriptClass(node.className)
      const m = toDisk(map, { path: node.path, className: node.className, runContext: node.runContext, hasChildren, hasScriptDescendants: script ? undefined : hasScripts(node) }, probe)
      if (!m) {
        plan.refused.push({ path: node.path, note: 'unmapped' })
        return
      }
      if (m.kind === 'other') {
        plan.keep.add(m.file)
        plan.refused.push({ path: node.path, note: 'Rojo-owned file, not synced' })
        return
      }
      if (m.kind === 'script') {
        scriptUnits(node, m.file, m.metaFile, m.runContext, hasChildren)
        if (isInitFile(m.file)) planChildren(node.path)
        return
      }
      if (m.kind === 'folder') {
        folderUnits(node, m.file)
        planChildren(node.path)
        return
      }
      // Studio-only children of an $ignoreUnknownInstances root are place content Rojo leaves
      // alone: only scripts (and containers holding scripts) are captured there.
      if (!script && !hasScripts(node) && !probe.isFile(m.file) && !probe.isDir(m.file)) {
        const parent = node.path.slice(0, -1)
        if (map.roots.some((r) => r.ignoreUnknown && pkey(r.instance) === pkey(parent))) {
          plan.refused.push({ path: node.path, note: 'left in Studio ($ignoreUnknownInstances)' })
          return
        }
      }
      if (m.kind === 'model' && !m.modelPath) {
        const model = modelFromStudio(node, subtree(node))
        plan.units.push({ kind: 'model', file: m.file, instancePath: node.path, primary: true, anchor: m.file, render: (disk) => writeModel(model, detectStyle(disk)) })
        for (const d of subtree(node)) if (isScriptClass(d.className)) plan.refused.push({ path: d.path, note: 'script inside a model file' })
      }
    }

    for (const root of map.roots) {
      const nodes = byPath.get(pkey(root.instance))
      if (!nodes?.length) continue
      plan.present.push(root)
      const node = nodes[0]
      if (root.isFile) {
        const info = parseFileName(root.path.split('/').pop()!, map.emitLegacyScripts)
        if (info?.kind === 'script' && isScriptClass(node.className)) scriptUnits(node, root.path, undefined, undefined, false)
        else if (info?.kind === 'model' && !isScriptClass(node.className)) {
          const model = modelFromStudio(node, subtree(node))
          plan.units.push({ kind: 'model', file: root.path, instancePath: node.path, primary: true, anchor: root.path, render: (disk) => writeModel(model, detectStyle(disk)) })
        } else plan.keep.add(root.path)
        continue
      }
      // A directory root's own class comes from the project file; its init.meta.json is the user's.
      plan.keep.add(`${root.path}/init.meta.json`)
      if (isScriptClass(node.className)) {
        const m = toDisk(map, { path: node.path, className: node.className, runContext: node.runContext, hasChildren: true }, probe)
        if (m?.kind === 'script') scriptUnits(node, m.file, m.metaFile, m.runContext, true)
      }
      planChildren(node.path)
    }
    return plan
  }

  // ---- internals: reconcile ----

  private async reconcile(s: Session, scope: string[][] | null): Promise<SyncEntry[]> {
    const map = s.map
    const disk = await this.scan(map)
    const probe: DiskProbe = { isFile: (rel) => disk.files.has(rel), isDir: (rel) => disk.dirs.has(rel) }
    const plan = this.plan(s, probe)
    const inScope = (path: string[]): boolean => !scope || scope.some((p) => related(p, path))
    const entries: SyncEntry[] = []
    const stamp = this.stamp()

    for (const r of plan.refused) if (inScope(r.path)) entries.push(this.entry('', 'unmapped', r.path, { note: r.note }))

    const claimed = new Set<string>()
    for (const u of plan.units) claimed.add(u.file)
    // Directories some unit owns (folders, init-script dirs): their .gitkeep is not a deletion.
    const dirsClaimed = new Set<string>()
    for (const u of plan.units) if (u.kind === 'folder' || u.anchor !== u.file) dirsClaimed.add(u.anchor)
    // One file mapped from several instances (the same directory mounted twice in a place): the copies
    // are reconciled as one, or the last copy reconciled would overwrite an edit made to another.
    const mounts = new Map<string, Unit[]>()
    for (const u of plan.units) if (u.kind !== 'folder' && inScope(u.instancePath)) (mounts.get(u.file) ?? mounts.set(u.file, []).get(u.file)!).push(u)
    // Folders first so files have a parent; then files.
    for (const u of plan.units) {
      if (!inScope(u.instancePath)) continue
      try {
        const copies = mounts.get(u.file)
        if (u.kind !== 'folder' && copies && copies.length > 1) {
          if (copies[0] !== u) continue
          const pick = await this.pickMount(s, copies)
          entries.push(await this.reconcileUnit(s, pick.unit, pick.conflict))
          continue
        }
        if (u.kind === 'folder') {
          if (!disk.dirs.has(u.file)) {
            await this.guard(map, u.file + '/x')
            // Present under another case (case-insensitive disk): not a new folder.
            const existed = await this.fs.lstat(this.abs(u.file)).then((i) => i.isDirectory(), () => false)
            await this.fs.mkdir(this.abs(u.file), { recursive: true })
            disk.dirs.add(u.file)
            if (!existed) entries.push(this.entry(u.file, 'created', u.instancePath))
          }
          continue
        }
        entries.push(await this.reconcileUnit(s, u))
      } catch (err) {
        entries.push(this.entry(u.file, 'unmapped', u.instancePath, { note: `refused: ${(err as Error).message}` }))
      }
    }

    // Disk-only files: deleted in Studio (trash) or not yet in Studio (Rojo will create them).
    const present = new Set(plan.present.map((r) => r.path))
    const refusedPaths = plan.refused.map((r) => r.path)
    const refusedParents = new Set(plan.refused.filter((r) => /^(unsafe name|duplicate)/.test(r.note)).map((r) => pkey(r.path.slice(0, -1))))
    // On a case-insensitive disk (Windows, macOS) a file whose name differs from a claimed one only in
    // case IS that file: trashing it would delete the script Studio still has.
    const claimedLower = new Map<string, string>()
    for (const f of claimed) claimedLower.set(f.toLowerCase(), f)
    const caseFixed = new Set<string>()
    for (const file of [...disk.files].sort()) {
      if (claimed.has(file) || plan.keep.has(file) || s.protect.has(file)) continue
      const twin = claimedLower.get(file.toLowerCase())
      if (twin && (await this.sameFile(file, twin))) {
        try {
          entries.push(await this.fixCase(s, file, twin, caseFixed))
        } catch (err) {
          entries.push(this.entry(file, 'unmapped', fromDisk(map, twin) ?? [], { note: `refused: ${(err as Error).message}` }))
        }
        continue
      }
      // A .gitkeep stands for its (empty) directory's Folder: kept while Studio has the folder.
      const keep = isGitkeep(file)
      if (keep && (dirsClaimed.has(dirOf(file)) || map.roots.some((r) => r.path === dirOf(file)))) continue
      const kind = keep ? 'folder' : kindOfFile(file)
      if (!kind) continue
      const inst = fromDisk(map, keep ? `${dirOf(file)}/init.meta.json` : file)
      if (!inst || !inScope(inst)) continue
      const hit = findRoot(map, inst)
      // Only trash under roots Studio actually sent: a missing root means "not loaded", not "deleted".
      if (!hit?.root || !present.has(hit.root.path)) continue
      if (hit.root.isFile ? false : file === `${hit.root.path}/init.meta.json`) continue
      if (refusedParents.has(pkey(inst.slice(0, -1))) || refusedPaths.some((p) => related(p, inst))) {
        entries.push(this.entry(file, 'disk-ahead', inst, { note: 'kept: Studio has an instance here Forge cannot write' }))
        continue
      }
      if ([...s.protect].some((p) => file.startsWith(p + '/'))) continue
      try {
        entries.push(await this.diskOnly(s, file, kind, inst, stamp))
      } catch (err) {
        entries.push(this.entry(file, 'unmapped', inst, { note: `refused: ${(err as Error).message}` }))
      }
    }

    // After trashing (which prunes directories left empty): keep empty Studio folders on disk.
    for (const u of plan.units) {
      if (u.kind !== 'folder' || !inScope(u.instancePath)) continue
      try {
        const e = await this.keepFolder(s, u, stamp)
        if (e) entries.push(e)
      } catch (err) {
        entries.push(this.entry(`${u.file}/${GITKEEP}`, 'unmapped', u.instancePath, { note: `refused: ${(err as Error).message}` }))
      }
    }
    return entries
  }

  // True when two paths name the same file on disk (case-insensitive file systems).
  private async sameFile(a: string, b: string): Promise<boolean> {
    try {
      const [x, y] = await Promise.all([this.fs.lstat(this.abs(a), { bigint: true }), this.fs.lstat(this.abs(b), { bigint: true })])
      return x.ino === y.ino && x.dev === y.dev
    } catch {
      return false
    }
  }

  // `file` and the claimed `twin` differ only in case and are one file. When this place knew the old
  // name, Studio renamed the instance: the disk name follows (directory segments too), or Rojo would
  // rename it back. Otherwise the disk was renamed (e.g. by git): left for Rojo.
  private async fixCase(s: Session, file: string, twin: string, done: Set<string>): Promise<SyncEntry> {
    const inst = fromDisk(s.map, twin) ?? []
    if (!(await this.store.get(s.placeKey, file))) return this.entry(file, 'disk-ahead', inst, { note: `name differs from Studio only in case (${twin})` })
    const a = file.split('/')
    const b = twin.split('/')
    for (let i = 0; i < b.length; i++) {
      if (a[i] === b[i]) continue
      const to = b.slice(0, i + 1).join('/')
      if (done.has(to)) continue
      done.add(to)
      const src = await this.guard(s.map, [...b.slice(0, i), a[i]].join('/'))
      const dst = await this.guard(s.map, to)
      // Through a temp name outside the mapped roots: a case-only rename in one step is a no-op on some systems.
      const temp = join(this.root, ...TRASH_DIR.split('/'), `.case-${this.stamp()}-${i}`)
      await this.fs.mkdir(join(temp, '..'), { recursive: true })
      await this.fs.rename(src, temp)
      try {
        await this.fs.rename(temp, dst)
      } catch (err) {
        await this.fs.rename(temp, src).catch(() => undefined)
        throw err
      }
    }
    await this.store.delete(s.placeKey, file)
    return this.entry(twin, 'renamed', inst, { from: file, note: 'name case changed in Studio' })
  }

  // A Studio folder's directory: present, and holding a .gitkeep exactly while it has nothing else.
  private async keepFolder(s: Session, u: Unit, stamp: string): Promise<SyncEntry | null> {
    const map = s.map
    const dir = u.file
    const keep = `${dir}/${GITKEEP}`
    let names = await this.fs.readdir(this.abs(dir)).catch(() => null)
    if (names === null) {
      // Pruned after its last child was trashed or moved away; the folder is still in Studio.
      await this.guard(map, keep)
      await this.fs.mkdir(this.abs(dir), { recursive: true })
      names = []
    }
    const real = names.filter((n) => n !== GITKEEP && !n.endsWith('.forge-tmp'))
    const has = names.includes(GITKEEP)
    if (!real.length) {
      // Base: Studio and disk agree the folder exists, so a later Studio delete trashes the .gitkeep.
      await this.store.set(s.placeKey, keep, '')
      if (has) return null
      await this.writeFile(map, keep, '')
      return this.entry(keep, 'created', u.instancePath, { note: 'empty folder: .gitkeep so git keeps it' })
    }
    if (!has) return null
    await this.store.delete(s.placeKey, keep)
    // Real children now: Forge's (empty) .gitkeep goes to the trash; one with content is the user's.
    if ((await this.read(keep))?.trim() !== '') return null
    await this.trash(map, keep, stamp)
    return this.entry(keep, 'trashed', u.instancePath, { note: 'folder has children now: .gitkeep removed' })
  }

  // The Studio copy that stands for a file several mapped instances share: the one edited since the
  // base (or, without a base, the one that differs from the disk). Copies edited differently conflict.
  private async pickMount(s: Session, copies: Unit[]): Promise<{ unit: Unit; conflict?: string }> {
    const diskText = await this.read(copies[0].file)
    const base = await this.store.get(s.placeKey, copies[0].file)
    const unchanged = base ? base.hash : diskText === null ? null : hashText(canon(copies[0].kind, diskText))
    const changed = new Map<string, Unit>()
    for (const u of copies) {
      const hash = hashText(canon(u.kind, u.render(diskText)))
      if (hash !== unchanged && !changed.has(hash)) changed.set(hash, u)
    }
    const picked = [...changed.values()]
    if (picked.length === 0) return { unit: copies[0] }
    if (picked.length === 1) return { unit: picked[0] }
    return { unit: picked[0], conflict: `mapped ${copies.length} times in Studio and the copies differ (${copies.map((c) => c.instancePath.join('.')).join(', ')})` }
  }

  private async reconcileUnit(s: Session, u: Unit, mountConflict?: string): Promise<SyncEntry> {
    const map = s.map
    s.conflicts.delete(u.file)
    const diskText = await this.read(u.file)
    const studioText = u.render(diskText)
    const cS = canon(u.kind, studioText)
    const base = await this.store.get(s.placeKey, u.file)
    if (mountConflict) {
      this.hold(s, u, studioText, cS, diskText ?? '', base?.text ?? null, base ? 'both-changed' : 'first-run', { diskDeleted: diskText === null })
      return this.entry(u.file, 'conflict', u.instancePath, { note: mountConflict })
    }
    if (diskText === null) {
      if (!base) {
        await this.writeFile(map, u.file, toFileText(studioText))
        await this.store.set(s.placeKey, u.file, cS)
        return this.entry(u.file, 'created', u.instancePath)
      }
      if (hashText(cS) === base.hash) return this.entry(u.file, 'disk-ahead', u.instancePath, { note: 'deleted on disk' })
      this.hold(s, u, studioText, cS, '', base.text, 'deleted-vs-edited', { diskDeleted: true })
      return this.entry(u.file, 'conflict', u.instancePath, { note: 'deleted on disk, edited in Studio' })
    }
    const cD = canon(u.kind, diskText)
    if (cS === cD) {
      await this.store.set(s.placeKey, u.file, cS)
      return this.entry(u.file, 'same', u.instancePath)
    }
    if (!base) {
      this.hold(s, u, studioText, cS, diskText, null, 'first-run')
      return this.entry(u.file, 'conflict', u.instancePath, { note: 'first run: Studio and disk differ' })
    }
    if (hashText(cS) === base.hash) return this.entry(u.file, 'disk-ahead', u.instancePath)
    if (hashText(cD) === base.hash) {
      await this.writeFile(map, u.file, toFileText(studioText, diskText))
      await this.store.set(s.placeKey, u.file, cS)
      return this.entry(u.file, 'pulled', u.instancePath)
    }
    if (base.text !== null) {
      const merged = diff3(base.text, cD, cS)
      const out = merged.clean ? this.renderMerged(u.kind, merged.text, diskText) : null
      if (out !== null) {
        await this.writeFile(map, u.file, toFileText(out, diskText))
        // Base stays at Studio's text until Studio receives the merge (through Rojo) and they agree.
        await this.store.set(s.placeKey, u.file, cS)
        return this.entry(u.file, 'merged', u.instancePath)
      }
    }
    this.hold(s, u, studioText, cS, diskText, base.text, 'both-changed')
    return this.entry(u.file, 'conflict', u.instancePath)
  }

  // Merged canonical text back to file form; null when the merge broke the JSON.
  private renderMerged(kind: UnitKind, text: string, diskText: string): string | null {
    if (kind === 'model') {
      try {
        return writeModel(readModel(text), detectStyle(diskText))
      } catch {
        return null
      }
    }
    if (kind === 'meta') {
      try {
        return JSON.stringify(JSON.parse(text), null, 2) + '\n'
      } catch {
        return null
      }
    }
    return text
  }

  private hold(s: Session, u: { kind: UnitKind; file: string; instancePath: string[] }, studioText: string, studioCanon: string, disk: string, base: string | null, reason: SyncConflictInfo['reason'], flags: { studioDeleted?: boolean; diskDeleted?: boolean } = {}): void {
    s.conflicts.set(u.file, {
      info: { placeKey: s.placeKey, file: u.file, instancePath: u.instancePath, base, disk, studio: studioText, reason },
      kind: u.kind,
      studioText,
      studioCanon,
      studioDeleted: flags.studioDeleted ?? false,
      diskDeleted: flags.diskDeleted ?? false
    })
  }

  private async diskOnly(s: Session, file: string, kind: UnitKind, inst: string[], stamp: string): Promise<SyncEntry> {
    s.conflicts.delete(file)
    const base = await this.store.get(s.placeKey, file)
    if (!base) return this.entry(file, 'disk-ahead', inst)
    const text = (await this.read(file)) ?? ''
    if (hashText(canon(kind, text)) === base.hash) {
      await this.trash(s.map, file, stamp)
      await this.store.delete(s.placeKey, file)
      return this.entry(file, 'trashed', inst)
    }
    this.hold(s, { kind, file, instancePath: inst }, '', '', text, base.text, 'deleted-vs-edited', { studioDeleted: true })
    return this.entry(file, 'conflict', inst, { note: 'deleted in Studio, edited on disk' })
  }

  private async resolveOne(s: Session, held: HeldConflict, take: 'studio' | 'disk' | 'merged', text?: string): Promise<void> {
    const file = held.info.file
    const map = s.map
    const current = await this.read(file)
    if (take === 'studio') {
      if (held.studioDeleted) {
        if (current !== null) await this.trash(map, file, this.stamp())
        await this.store.delete(s.placeKey, file)
      } else {
        await this.writeFile(map, file, toFileText(held.studioText, current))
        await this.store.set(s.placeKey, file, held.studioCanon)
      }
    } else if (take === 'disk') {
      // Disk stays; Rojo pushes it. Base = Studio's side so the next pass reads it as disk-ahead.
      if (held.studioDeleted) await this.store.delete(s.placeKey, file)
      else await this.store.set(s.placeKey, file, held.studioCanon)
    } else {
      if (typeof text !== 'string') throw new Error('merged resolution needs text')
      const out = held.kind === 'model' || held.kind === 'meta' ? this.renderMerged(held.kind, canon(held.kind, text), current ?? '') : text
      if (out === null) throw new Error('merged text is not valid JSON')
      await this.writeFile(map, file, toFileText(out, current))
      if (held.studioDeleted) await this.store.delete(s.placeKey, file)
      else await this.store.set(s.placeKey, file, held.studioCanon)
    }
    s.conflicts.delete(file)
    this.recentEntries.unshift(this.entry(file, take === 'disk' ? 'disk-ahead' : take === 'merged' ? 'merged' : held.studioDeleted ? 'trashed' : 'pulled', held.info.instancePath, { note: `resolved: ${take}` }))
    this.recentEntries.splice(RECENT_LIMIT)
  }

  // ---- internals: tree edits ----

  private removeSubtree(s: Session, id: string, path: string[]): void {
    const tree = s.tree!
    tree.delete(id)
    const twin = [...tree.values()].some((n) => pkey(n.path) === pkey(path))
    if (twin) return
    for (const [k, n] of tree) if (startsWith(n.path, path)) tree.delete(k)
  }

  private async applyRename(s: Session, change: Extract<StudioChange, { kind: 'renamed' | 'moved' }>): Promise<SyncEntry[]> {
    const map = s.map
    const tree = s.tree!
    const disk = await this.scan(map)
    const probe: DiskProbe = { isFile: (rel) => disk.files.has(rel), isDir: (rel) => disk.dirs.has(rel) }
    const before = this.plan(s, probe).units.find((u) => u.primary && pkey(u.instancePath) === pkey(change.from))
    // Re-path the subtree.
    const from = change.from
    const to = change.node.path
    const twin = [...tree.values()].some((n) => n.id !== change.id && pkey(n.path) === pkey(from))
    tree.delete(change.id)
    if (!twin) for (const n of tree.values()) if (n.path.length > from.length && startsWith(n.path, from)) n.path = [...to, ...n.path.slice(from.length)]
    tree.set(change.id, change.node)
    if (!before) return []
    const after = this.plan(s, probe).units.find((u) => u.primary && pkey(u.instancePath) === pkey(to))
    if (!after) {
      // Renamed to something Forge cannot write (unsafe name, unmapped place): keep the old files.
      s.protect.add(before.anchor)
      if (before.meta) s.protect.add(before.meta)
      return []
    }
    if (after.kind !== before.kind || after.anchor === before.anchor) return []
    const oldExists = disk.files.has(before.anchor) || disk.dirs.has(before.anchor)
    const newExists = disk.files.has(after.anchor) || disk.dirs.has(after.anchor)
    if (!oldExists || newExists) return []
    try {
      const src = await this.guard(map, before.anchor)
      const dst = await this.guard(map, after.anchor)
      await this.fs.mkdir(join(dst, '..'), { recursive: true })
      await this.fs.rename(src, dst)
    } catch {
      return []
    }
    await this.store.rename(s.placeKey, before.anchor, after.anchor)
    if (before.meta && disk.files.has(before.meta)) {
      // RunContext meta follows the script (init form: inside the moved directory already).
      const metaTo = after.meta ?? (after.anchor === after.file ? `${dirOf(after.file) ? dirOf(after.file) + '/' : ''}${to[to.length - 1]}.meta.json` : `${after.anchor}/init.meta.json`)
      if (metaTo !== before.meta && !metaTo.startsWith(after.anchor + '/')) await this.moveMeta(s, before.meta, metaTo).catch(() => undefined)
    }
    await this.pruneEmpty(map, dirOf(before.anchor))
    return [this.entry(after.file, 'renamed', to, { from: before.file })]
  }

  private async moveMeta(s: Session, from: string, to: string): Promise<void> {
    const src = await this.guard(s.map, from)
    const dst = await this.guard(s.map, to)
    if (await this.fs.stat(dst).then(() => true, () => false)) return
    await this.fs.rename(src, dst)
    await this.store.rename(s.placeKey, from, to)
  }
}
