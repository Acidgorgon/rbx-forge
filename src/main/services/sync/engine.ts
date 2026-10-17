// Forge Sync engine: reconciles a place's Studio snapshot / change stream with the disk, per place,
// against the base store, and decides the Rojo gate. Forge never writes into Studio: disk -> Studio
// stays Rojo's job once the gate is clear. No electron imports; the SyncService (service.ts) wires
// this to the bridge and the UI.
//
// Per file with Studio S, disk D, base B (compared normalised):
//   S==D same | S==B,D!=B disk-ahead | D==B,S!=B pulled | else diff3(B,D,S) merged or conflict
//   no base and S!=D -> conflict (first-run); Studio-only -> created; disk-only with base -> trashed
//   (deleted in Studio; conflict if the disk copy changed since), disk-only without base -> disk-ahead.
// A file another place maps too: a snapshot's pull/merge is held as a conflict when that place's base
// or Studio copy differs from what would be written, and a Studio delete never trashes it.
// Delete guard: a large script (more than GUARD_LINES lines) or one another synced script requires is
// never removed on its own. A Studio delete of it, a disk delete Rojo would carry into Studio, or a
// file gone from both sides without Forge doing it (Rojo two-way sync, another tool) is held as a
// conflict; the last synced copy of a file gone from both sides is saved under RECOVERED_DIR.
// Same-name siblings: one file can hold only one instance, and Rojo keeps one and deletes the rest
// when it connects. Forge never picks one silently: the group is held as a 'duplicate' conflict
// (rojo serve waits) until the user picks a side. A new file for a script made in Studio is written
// with rojo serve paused (options.guardNewFile): Rojo adds its own instance for a file that appears
// while it serves (a second sibling next to the Studio one) but adopts the Studio one on connect.
// drift(): how many files a place's Studio is behind the disk (its base vs the disk now).

import * as nodeFs from 'node:fs/promises'
import { join, resolve as resolvePath } from 'node:path'
import type { GateState, PlaceSyncStatus, StudioChange, StudioNode, StudioOnlyScript, SyncAction, SyncConflictInfo, SyncEntry, SyncPlace } from '../../../shared/sync/types.ts'
import { matchPlace, PlaceLinks } from './links.ts'
import { cleanRel, type DiskProbe, findRoot, fromDisk, insideMappedRoots, isProjectNode, isScriptClass, isSkipped, loadPlaces, PACKAGE_DIRS, parseFileName, type PlaceMap, placeFor, saveTarget, type SaveTarget, sharedWith, type SyncRoot, toDisk, unsafeName } from './mapping.ts'
import { diff3, normalise, toFileText } from './merge.ts'
import { canonicalJson, canonicalModel, detectStyle, modelFromStudio, readModel, writeMeta, writeModel } from './modelJson.ts'
import { atomicWrite, BaseStore, ensureTrashIgnored, hashText, migrateLegacy, type SyncFs, TRASH_DIR } from './store.ts'
import { GUARD_LINES, lineCount, moduleName, requiredNames } from './deleteGuard.ts'

export { GUARD_LINES } from './deleteGuard.ts'

export type { SyncFs } from './store.ts'

export interface SyncEngineOptions {
  root: string
  fs?: SyncFs
  now?: () => number
  // Runs a live write of a NEW file (a script or model made in Studio while rojo may serve the place)
  // with rojo serve for that place file paused, so Rojo, on reconnect, adopts the Studio instance
  // instead of adding a second same-name sibling for the new file. Absent: written as is (tests).
  guardNewFile?: <T>(projectFile: string, file: string, fn: () => Promise<T>) => Promise<T>
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
  // A script changing form (single file <-> init file in its own folder, because Studio added or
  // removed its children): the other form's file still on disk. A base for this file is from an older
  // form and does not mean "deleted on disk".
  formFrom?: string
}

// Same-name siblings (ignoring case) under one parent, and the file the name maps to when Forge can
// write one of them (a script or a model file). render: the member's file text.
interface DuplicateGroup {
  nodes: { node: StudioNode; render?: (disk: string | null) => string }[]
  file?: string
  kind?: UnitKind
}

interface Plan {
  units: Unit[]
  refused: { path: string[]; note: string }[]
  duplicates: DuplicateGroup[]
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
  // Held because another place maps the file and has a different copy (see sharedDiffers).
  shared: boolean
  // Gone from disk and from Studio, not by Forge: "disk" restores the last synced copy (base),
  // "studio" confirms the delete.
  lost?: boolean
  // Same-name siblings in Studio: the group's signature (accepted once the user picks a side).
  duplicate?: string
}

// Last synced copies of files that left disk and Studio without Forge removing them.
export const RECOVERED_DIR = '.forge/sync/recovered'

// Why removing `file` needs the user's word ("1587 lines", "required by src/x.luau"), or null.
type DeleteGuard = (file: string, text: string) => Promise<string | null>



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
  // Bumped when the tree's shape changes (snapshot, add, remove, rename, move): the Game tab rebuilds
  // only then, not on script edits.
  version: number
  // Studio-only children of $ignoreUnknownInstances roots that the last pass left in Studio.
  leftInStudio: string[][]
  // The place file this place is linked to (the service decides; placeFor's fallback is never used
  // when it is set).
  projectFile?: string
  // First sync, undecided: nothing is written or trashed; every difference waits as a 'first-run'
  // conflict for the user's "which side" choice.
  firstSync: boolean
  // Scripts only in Studio (no file on disk, no conflict held) that Rojo would delete when it connects.
  // hold: found by a snapshot, a resolve or a pull (a "checkpoint"), so rojo serve waits for them.
  studioOnly: HeldStudioOnly[]
  // "Pull to disk" in progress: these instance paths are written even where the base says the disk
  // deleted them.
  restore: string[][]
  // Parent id per node id where known. Paths alone cannot tell two same-name siblings apart (Studio's
  // Ctrl+D makes a copy with the original's name, children included): renames, moves and removes
  // carry a subtree by these ids.
  parents: Map<string, string>
  // Duplicate groups the user decided (file -> group signature): not held again while unchanged.
  dupAccepted: Map<string, string>
}

interface HeldStudioOnly extends StudioOnlyScript {
  hold: boolean
}

// Why plan() leaves a Studio-only instance of an $ignoreUnknownInstances root alone.
export const LEFT_IN_STUDIO = 'left in Studio ($ignoreUnknownInstances): Rojo leaves it alone; right-click it in the Game tab > Save to repo to track it'

const KEY = '\u0000'
const pkey = (path: string[]): string => path.join(KEY)
const startsWith = (path: string[], prefix: string[]): boolean => prefix.length <= path.length && prefix.every((p, i) => path[i] === p)
const related = (a: string[], b: string[]): boolean => startsWith(a, b) || startsWith(b, a)
const dirOf = (rel: string): string => (rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '')
const isInitFile = (rel: string): boolean => /(^|\/)init(\.server|\.client|\.plugin)?\.luau?$/.test(rel)
const SCRIPT_SUFFIXES = ['', '.server', '.client', '.plugin']

function canon(kind: UnitKind | 'meta', text: string): string {
  if (kind === 'model') return canonicalModel(text) ?? normalise(text)
  if (kind === 'meta') return canonicalJson(text) ?? normalise(text)
  return normalise(text)
}

// Lines in one text and not the other (a multiset difference), for "N lines differ".
function changedLines(a: string, b: string): number {
  const count = new Map<string, number>()
  for (const l of a.split('\n')) count.set(l, (count.get(l) ?? 0) + 1)
  let only = 0
  for (const l of b.split('\n')) {
    const n = count.get(l) ?? 0
    if (n > 0) count.set(l, n - 1)
    else only++
  }
  for (const n of count.values()) only += n
  return only
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
  private readonly projectFiles = new Map<string, string>()
  private readonly recentEntries: SyncEntry[] = []
  private readonly listeners = new Set<(placeKey: string) => void>()
  private queue: Promise<unknown> = Promise.resolve()
  // Per place: guarded files whose delete the user confirmed (resolved "disk" for a disk delete), so
  // the next pass lets Rojo carry it into Studio instead of holding it again.
  private readonly confirmedDeletes = new Map<string, Set<string>>()
  // Recovery copies already saved (place, file, base hash): a re-held loss is not copied again.
  private readonly recovered = new Map<string, string>()
  private readonly guardNewFile?: SyncEngineOptions['guardNewFile']
  // drift(): disk digests by absolute path, reused while size and mtime are unchanged.
  private readonly diskHashes = new Map<string, { size: number; mtime: number; hash: string }>()

  constructor(options: SyncEngineOptions) {
    this.root = resolvePath(options.root)
    this.fs = options.fs ?? nodeFs
    this.now = options.now ?? Date.now
    this.store = new BaseStore(this.root, this.fs)
    this.guardNewFile = options.guardNewFile
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
      for (const s of this.sessions.values()) s.map = this.mapFor(s.place, s.projectFile) ?? s.map
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

  // projectFile: the place file the place is linked to (service.ts matches places; required for a
  // place linked in Forge, which is not in any servePlaceIds).
  beginSnapshot(placeKey: string, place: SyncPlace, projectFile?: string): void {
    if (projectFile) this.projectFiles.set(placeKey, projectFile)
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
      s.map = this.mapFor(s.place, s.projectFile) ?? s.map
      // A place with no shared version yet (newly linked): its first sync waits for a decision.
      if (!(await this.store.hasPlace(placeKey))) this.store.setFirstSync(placeKey, true)
      s.firstSync = this.store.isFirstSync(placeKey)
      const tree = new Map<string, StudioNode>()
      const nodes = s.buffer.filter((node) => node && typeof node.id === 'string' && Array.isArray(node.path))
      for (const node of nodes) tree.set(node.id, node)
      s.buffer = null
      s.tree = tree
      s.parents = new Map()
      this.linkParents(s, nodes)
      s.version++
      s.protect.clear()
      s.conflicts.clear()
      s.studioOnly = []
      const entries = await this.reconcile(s, null, true)
      this.settleFirstSync(s, entries)
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
      if (changes.some((c) => c.kind !== 'source' && c.kind !== 'props')) s.version++
      for (const change of changes) {
        if (change.kind === 'renamed' || change.kind === 'moved') {
          entries.push(...(await this.applyRename(s, change)))
          scope.push(change.from, change.node.path)
        } else if (change.kind === 'removed') {
          this.removeSubtree(s, change.id, change.path)
          scope.push(change.path)
        } else if (change.kind === 'added') {
          const nodes = [change.node, ...(change.descendants ?? [])]
          for (const node of nodes) s.tree.set(node.id, node)
          this.linkParents(s, nodes)
          scope.push(change.node.path)
        } else {
          const old = s.tree.get(change.node.id)
          if (old && pkey(old.path) !== pkey(change.node.path)) this.removeSubtree(s, old.id, old.path)
          // Unknown id (e.g. the plugin's table was rebuilt): the one node at that path with that class is
          // the same instance. With two or more there (same-name siblings) Forge cannot tell which one it
          // is, and must not drop one silently: the new id is kept next to them (a duplicate, held).
          if (!old) {
            const same = [...s.tree].filter(([, n]) => pkey(n.path) === pkey(change.node.path) && n.className === change.node.className)
            if (same.length === 1) s.tree.delete(same[0][0])
          }
          s.tree.set(change.node.id, change.node)
          if (!old || pkey(old.path) !== pkey(change.node.path)) this.linkParents(s, [change.node])
          scope.push(change.node.path)
        }
      }
      // A name freed by a remove / rename / move: a sibling refused as its duplicate (same name ignoring
      // case) is writable now.
      for (const change of changes) {
        if (change.kind !== 'removed' && change.kind !== 'renamed' && change.kind !== 'moved') continue
        const old = change.kind === 'removed' ? change.path : change.from
        if (!old.length) continue
        const parent = pkey(old.slice(0, -1))
        const lower = old[old.length - 1].toLowerCase()
        for (const n of s.tree.values()) if (n.path.length === old.length && n.path[n.path.length - 1].toLowerCase() === lower && pkey(n.path.slice(0, -1)) === parent) scope.push(n.path)
      }
      if (scope.length) entries.push(...(await this.reconcile(s, scope)))
      this.settleFirstSync(s, entries)
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
    s.studioOnly = []
    s.parents.clear()
    s.gate = 'idle'
    s.version++
    this.emit(placeKey)
  }

  // ---- Game tab ----

  // The place's live Studio instances under the mapped roots (null without a snapshot), and a counter
  // that changes when their shape does.
  liveTree(placeKey: string): { nodes: StudioNode[]; version: number } | null {
    const s = this.sessions.get(placeKey)
    if (!s?.tree) return null
    return { nodes: [...s.tree.values()], version: s.version }
  }

  treeVersion(placeKey: string): number | null {
    const s = this.sessions.get(placeKey)
    return s?.tree ? s.version : null
  }

  leftInStudio(placeKey: string): string[][] {
    return this.sessions.get(placeKey)?.leftInStudio.map((p) => [...p]) ?? []
  }

  // Scripts only in Studio that Rojo would delete when it connects, and whether rojo serve is held for
  // them (see Session.studioOnly).
  studioOnly(placeKey: string): { items: StudioOnlyScript[]; holds: boolean } {
    const list = this.sessions.get(placeKey)?.studioOnly ?? []
    return { items: list.map(({ hold: _hold, ...i }) => ({ ...i, instancePath: [...i.instancePath] })), holds: list.some((i) => i.hold) }
  }

  // "Pull to disk": writes every Studio-only script Forge can write (and what it needs: its folder,
  // its meta file, its children), even where the base says the disk deleted it. From then on Rojo
  // has them on disk and never proposes deleting them from Studio.
  pullStudioOnly(placeKey: string): Promise<SyncEntry[]> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const s = this.sessions.get(placeKey)
      if (!s?.tree) throw new Error('Studio is not connected to Forge Sync for this place')
      const paths = s.studioOnly.filter((i) => i.canPull).map((i) => i.instancePath)
      if (!paths.length) return []
      s.restore = paths
      let entries: SyncEntry[]
      try {
        entries = await this.reconcile(s, paths, true)
      } finally {
        s.restore = []
      }
      this.updateGate(s)
      return this.finish(s, entries)
    })
  }

  // Where "Save to repo" would write a Studio-only instance of this place, or why it cannot.
  async saveTarget(placeKey: string, path: string[]): Promise<SaveTarget & { className?: string }> {
    await this.ensureLoaded()
    const s = this.sessions.get(placeKey)
    if (!s) return { reason: 'No Studio session for this place' }
    const found = this.findForSave(s, path)
    const probe = this.ciProbe(await this.scan(s.map))
    // Not in the synced tree (an outline node outside the roots, or no snapshot yet): the mapping's
    // reason first, it says what to do.
    if ('reason' in found) {
      const t = saveTarget(s.map, { path, className: 'Folder' }, probe)
      return 'reason' in t ? t : found
    }
    return { ...saveTarget(s.map, found, probe), className: found.className }
  }

  // Writes a Studio-only, non-script instance (and its non-script descendants) as a Rojo .model.json
  // at its mapped place. From then on Rojo owns it and Forge Sync keeps it in step like any other file.
  saveToRepo(placeKey: string, path: string[]): Promise<SyncEntry> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const s = this.sessions.get(placeKey)
      if (!s?.tree) throw new Error('Studio is not connected to Forge Sync for this place')
      const found = this.findForSave(s, path)
      const probe = this.ciProbe(await this.scan(s.map))
      if ('reason' in found) {
        const t = saveTarget(s.map, { path, className: 'Folder' }, probe)
        throw new Error('reason' in t ? t.reason : found.reason)
      }
      const target = saveTarget(s.map, found, probe)
      if ('reason' in target) throw new Error(target.reason)
      const subtree = [...s.tree.values()].filter((n) => n.path.length > path.length && startsWith(n.path, path))
      const text = writeModel(modelFromStudio(found.node, subtree))
      await this.writeNew(s.map, target.file, () => this.writeFile(s.map, target.file, toFileText(text)))
      await this.store.set(s.placeKey, target.file, canon('model', text))
      const entry = this.entry(target.file, 'created', [...path], { note: 'saved to repo from Studio' })
      // Settle the rest of the pass (base, gate) for that subtree.
      await this.reconcile(s, [path])
      s.version++
      this.updateGate(s)
      return (await this.finish(s, [entry]))[0]
    })
  }

  private findForSave(s: Session, path: string[]): { node: StudioNode; path: string[]; className: string; hasScriptDescendants: boolean } | { reason: string } {
    const k = pkey(path)
    const hits = [...(s.tree?.values() ?? [])].filter((n) => pkey(n.path) === k)
    if (hits.length === 0) return { reason: 'Not in the synced Studio tree' }
    const lower = path[path.length - 1].toLowerCase()
    const parent = pkey(path.slice(0, -1))
    const twins = [...s.tree!.values()].filter((n) => n.path.length === path.length && pkey(n.path.slice(0, -1)) === parent && n.path[n.path.length - 1].toLowerCase() === lower)
    if (hits.length > 1 || twins.length > 1) return { reason: 'Another instance with the same name (ignoring case) sits next to it; rename one in Studio first' }
    const node = hits[0]
    if (isScriptClass(node.className)) return { reason: 'Scripts sync on their own' }
    const hasScriptDescendants = [...s.tree!.values()].some((n) => n.path.length > path.length && startsWith(n.path, path) && isScriptClass(n.className))
    return { node, path: node.path, className: node.className, hasScriptDescendants }
  }

  // Case-insensitive probe over a scan: on Windows and macOS "Sword.model.json" and "sword.model.json"
  // are one file, and a repo cloned there must not get both.
  private ciProbe(disk: { files: Set<string>; dirs: Set<string> }): DiskProbe {
    const files = new Set([...disk.files].map((f) => f.toLowerCase()))
    const dirs = new Set([...disk.dirs].map((f) => f.toLowerCase()))
    return { isFile: (rel) => files.has(rel.toLowerCase()), isDir: (rel) => dirs.has(rel.toLowerCase()) }
  }

  gate(placeKey: string): GateState {
    return this.sessions.get(placeKey)?.gate ?? 'idle'
  }

  // How far this place's Studio is behind the disk: the place file's mapped files whose disk copy
  // differs from the place's base (what its Studio and the disk last agreed on), files new on disk
  // (no base: its Studio never had them) and files deleted on disk that it still has. Conflicts held
  // for the place are not counted (they are shown as conflicts). Newest first. null: the place has no
  // shared version yet (never synced, or its first sync is undecided), so nothing can be said.
  // Disk digests are cached by size and mtime, so a status refresh only reads files that changed.
  drift(projectFile: string, placeKey: string): Promise<{ behind: number; files: { file: string; mtime: number }[] } | null> {
    return this.serial(async () => {
      await this.ensureLoaded()
      const map = this.maps.find((m) => m.projectFile === projectFile)
      if (!map || !(await this.store.hasPlace(placeKey)) || this.store.isFirstSync(placeKey)) return null
      const held = new Set(this.sessions.get(placeKey)?.conflicts.keys() ?? [])
      const rootMeta = new Set(map.roots.filter((r) => !r.isFile).map((r) => `${r.path}/init.meta.json`))
      const disk = await this.scan(map)
      const out: { file: string; mtime: number }[] = []
      for (const file of [...disk.files].sort()) {
        const kind = kindOfFile(file)
        if (!kind || isGitkeep(file) || rootMeta.has(file) || held.has(file)) continue
        const abs = this.abs(file)
        const info = await this.fs.stat(abs).catch(() => null)
        if (!info) continue
        const base = await this.store.hashOf(placeKey, file)
        if (!base) {
          if (fromDisk(map, file)) out.push({ file, mtime: info.mtimeMs })
          continue
        }
        let cached = this.diskHashes.get(abs)
        if (!cached || cached.size !== info.size || cached.mtime !== info.mtimeMs) {
          const text = await this.read(file)
          if (text === null) continue
          cached = { size: info.size, mtime: info.mtimeMs, hash: hashText(canon(kind, text)) }
          this.diskHashes.set(abs, cached)
        }
        if (cached.hash !== base) out.push({ file, mtime: info.mtimeMs })
      }
      for (const file of (await this.store.files(placeKey)).sort()) {
        if (disk.files.has(file) || held.has(file) || isGitkeep(file) || rootMeta.has(file) || !kindOfFile(file) || !insideMappedRoots(map, file)) continue
        out.push({ file, mtime: 0 })
      }
      out.sort((a, b) => b.mtime - a.mtime || a.file.localeCompare(b.file))
      return { behind: out.length, files: out }
    })
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
      this.settleFirstSync(s, 'decided')
      await this.store.save()
      await this.refreshStudioOnly(s)
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
      this.settleFirstSync(s, 'decided')
      await this.store.save()
      await this.refreshStudioOnly(s)
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
    if (this.loaded) return this.loaded
    const loading = (async () => {
      this.maps = await loadPlaces(this.root)
      await this.store.load()
      const def = this.maps.find((m) => m.projectFile === 'default.project.json') ?? this.maps[0]
      await migrateLegacy(this.root, this.store, (def?.placeIds ?? []).map(String), this.fs)
    })()
    this.loaded = loading
    // A failure (e.g. index.json locked for a moment on Windows) must not stick: retry next time,
    // or every snapshot would fail and the place would stay "checking" with rojo held.
    loading.catch(() => {
      if (this.loaded === loading) this.loaded = null
    })
    return loading
  }

  // The place's map: the place file it is linked to, else (older callers) by PlaceId.
  private mapFor(place: SyncPlace, projectFile?: string): PlaceMap | null {
    if (projectFile) return this.maps.find((m) => m.projectFile === projectFile) ?? null
    return placeFor(this.maps, place.placeId)
  }

  // The first sync is decided once a pass compared files and nothing waits for the first-run choice
  // (all equal, or the user picked a side for every difference).
  private settleFirstSync(s: Session, entries: SyncEntry[] | 'decided'): void {
    if (!s.firstSync) return
    if ([...s.conflicts.values()].some((c) => c.info.reason === 'first-run')) return
    if (entries !== 'decided' && !entries.some((e) => e.action === 'same' || e.action === 'conflict')) return
    s.firstSync = false
    this.store.setFirstSync(s.placeKey, false)
  }

  private session(placeKey: string, place: SyncPlace): Session {
    let s = this.sessions.get(placeKey)
    const projectFile = this.projectFiles.get(placeKey)
    const map = this.mapFor(place, projectFile) ?? { projectFile: 'default.project.json', name: '', root: this.root, placeIds: [], emitLegacyScripts: true, roots: [], skipped: [], virtual: [], skipGlobs: [] }
    if (!s) {
      s = { placeKey, place, map, gate: 'idle', connected: false, buffer: null, tree: null, counts: {}, conflicts: new Map(), protect: new Set(), version: 0, leftInStudio: [], projectFile, firstSync: false, studioOnly: [], restore: [], parents: new Map(), dupAccepted: new Map() }
      this.sessions.set(placeKey, s)
    } else {
      s.place = place
      s.projectFile = projectFile
    }
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
    else s.gate = s.conflicts.size || s.studioOnly.some((i) => i.hold) ? 'blocked' : 'clear'
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

  // A file or directory that is new on disk for an instance Studio already has. Rojo, if it serves the
  // place right now, would add its own instance for it next to Studio's (two same-name siblings): the
  // write runs with rojo serve paused (guardNewFile), and Rojo adopts Studio's instance on reconnect.
  private async writeNew(map: PlaceMap, rel: string, fn: () => Promise<void>): Promise<void> {
    if (this.guardNewFile) await this.guardNewFile(map.projectFile, rel, fn)
    else await fn()
  }

  // Moves a project file into .forge/sync/trash/<stamp>/ (never a hard delete); returns where it went.
  private async trash(map: PlaceMap, rel: string, stamp: string): Promise<string> {
    const from = await this.guard(map, rel)
    const dest = `${TRASH_DIR}/${stamp}/${rel}`
    const to = join(this.root, ...dest.split('/'))
    await this.fs.mkdir(join(to, '..'), { recursive: true })
    await ensureTrashIgnored(this.root, this.fs).catch(() => undefined)
    await this.fs.rename(from, to)
    await this.pruneEmpty(map, dirOf(rel))
    return dest
  }

  private confirmed(placeKey: string): Set<string> {
    let set = this.confirmedDeletes.get(placeKey)
    if (!set) this.confirmedDeletes.set(placeKey, (set = new Set()))
    return set
  }

  // The delete guard for one pass. `requirers`: the scripts that stay (on disk and in Studio); a
  // script one of them requires (by name on a require line) is guarded. Built lazily: most passes
  // remove nothing.
  // `staying`: every file this pass keeps or writes (Studio has it).
  private deleteGuard(requirers: string[], staying: Iterable<string> = requirers): DeleteGuard {
    const names = new Map<string, string[]>()
    for (const f of staying) {
      const n = moduleName(f)
      if (n) (names.get(n) ?? names.set(n, []).get(n)!).push(f)
    }
    let index: Promise<Map<string, string[]>> | null = null
    const build = async (): Promise<Map<string, string[]>> => {
      const out = new Map<string, string[]>()
      for (const f of requirers) {
        if (kindOfFile(f) !== 'script') continue
        const text = await this.read(f)
        if (!text) continue
        for (const name of requiredNames(text)) {
          const list = out.get(name) ?? []
          if (list.length < 4) list.push(f)
          out.set(name, list)
        }
      }
      return out
    }
    return async (file, text) => {
      const lines = lineCount(text)
      if (lines > GUARD_LINES) return `${lines} lines`
      const name = moduleName(file)
      if (!name) return null
      // Another staying script has this name (a moved copy, Legacy/Old twins): the require may well
      // mean that one, so only the size counts.
      // (A script changing form keeps its name: X.luau -> X/init.luau.)
      if ((names.get(name) ?? []).some((f) => f !== file)) return null
      const by = (await (index ??= build())).get(name)?.filter((f) => f !== file) ?? []
      return by.length ? `required by ${by[0]}` : null
    }
  }

  // Saves the last synced copy of a file that left disk and Studio without Forge (once per content).
  private async saveRecovered(placeKey: string, rel: string, text: string, stamp: string): Promise<string> {
    const key = `${placeKey}\u0000${rel}\u0000${hashText(text)}`
    const saved = this.recovered.get(key)
    if (saved) return saved
    const dest = `${RECOVERED_DIR}/${stamp}/${rel}`
    await atomicWrite(this.fs, join(this.root, ...dest.split('/')), normalise(text) + '\n')
    this.recovered.set(key, dest)
    return dest
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
    const plan: Plan = { units: [], refused: [], duplicates: [], present: [], keep: new Set() }

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
      const own = init ? dirOf(file) : `${dirOf(file) ? dirOf(file) + '/' : ''}${leaf}`
      const otherForms = SCRIPT_SUFFIXES.flatMap((sfx) => (init ? [`${own}${sfx}.luau`, `${own}${sfx}.lua`] : [`${own}/init${sfx}.luau`, `${own}/init${sfx}.lua`]))
      const formFrom = node.path.length > 0 && !map.roots.some((r) => pkey(r.instance) === pkey(node.path)) ? otherForms.find((f) => f !== file && probe.isFile(f)) : undefined
      plan.units.push({ kind: 'script', file, instancePath: node.path, primary: true, anchor, meta: !init && hasMeta ? adjacent : undefined, render: () => source, ...(formFrom ? { formFrom } : {}) })
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
      const groups = new Map<string, StudioNode[]>()
      for (const c of children) {
        const name = c.path[c.path.length - 1]
        const unsafe = unsafeName(name)
        if (unsafe) {
          plan.refused.push({ path: c.path, note: `unsafe name: ${unsafe}` })
          continue
        }
        if ((counts.get(name.toLowerCase()) ?? 0) > 1) {
          plan.refused.push({ path: c.path, note: 'duplicate sibling name' })
          const lower = name.toLowerCase()
          ;(groups.get(lower) ?? groups.set(lower, []).get(lower)!).push(c)
          continue
        }
        planNode(c)
      }
      for (const nodes of groups.values()) plan.duplicates.push(duplicateGroup(nodes))
    }

    // What one file would hold for each member of a same-name group (the first member Forge can write
    // names the file): reconcile holds the group as a 'duplicate' conflict on it.
    const duplicateGroup = (nodes: StudioNode[]): DuplicateGroup => {
      const group: DuplicateGroup = { nodes: [] }
      for (const node of nodes) {
        const hasChildren = childrenOf(node.path).length > 0
        const script = isScriptClass(node.className)
        const m = toDisk(map, { path: node.path, className: node.className, runContext: node.runContext, hasChildren, hasScriptDescendants: script ? undefined : hasScripts(node) }, probe)
        let render: ((disk: string | null) => string) | undefined
        let kind: UnitKind | undefined
        if (m?.kind === 'script' && typeof node.source === 'string' && !node.oversize) {
          const source = node.source
          render = () => source
          kind = 'script'
        } else if (m?.kind === 'model' && !m.modelPath && !script) {
          const model = modelFromStudio(node, subtree(node))
          render = (disk) => writeModel(model, detectStyle(disk))
          kind = 'model'
        } else if (m?.kind === 'folder') kind = 'folder'
        group.nodes.push({ node, ...(render ? { render } : {}) })
        // A script or model file names the group; a folder only when no member is one.
        if (m && kind && (!group.file || (group.kind === 'folder' && kind !== 'folder'))) {
          group.file = m.file
          group.kind = kind
        }
      }
      if (group.file) plan.keep.add(group.file)
      return group
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
          plan.refused.push({ path: node.path, note: LEFT_IN_STUDIO })
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

  // checkpoint: a snapshot, a resolve or a pull. Studio-only scripts it finds hold rojo serve; a live
  // pass (the change stream) only lists new ones (Rojo is usually connected then, and a disk delete
  // it is about to carry into Studio must not stop the serve).
  private async reconcile(s: Session, scope: string[][] | null, checkpoint = false): Promise<SyncEntry[]> {
    const map = s.map
    const disk = await this.scan(map)
    const probe: DiskProbe = { isFile: (rel) => disk.files.has(rel), isDir: (rel) => disk.dirs.has(rel) }
    const plan = this.plan(s, probe)
    s.leftInStudio = plan.refused.filter((r) => r.note === LEFT_IN_STUDIO).map((r) => r.path)
    const inScope = (path: string[]): boolean => !scope || scope.some((p) => related(p, path))
    const entries: SyncEntry[] = []
    const stamp = this.stamp()

    // Same-name siblings: held as one 'duplicate' conflict per group (their refusals say nothing more).
    const dupHeld = new Set<string>()
    for (const group of plan.duplicates) {
      const path = group.nodes[0].node.path
      if (!inScope(path) || !group.file || !group.kind) continue
      try {
        const e = await this.holdDuplicate(s, group)
        entries.push(e)
        if (e.action === 'conflict') for (const m of group.nodes) dupHeld.add(pkey(m.node.path))
      } catch (err) {
        entries.push(this.entry(group.file, 'unmapped', path, { note: `refused: ${(err as Error).message}` }))
      }
    }
    for (const r of plan.refused) if (inScope(r.path) && !(r.note === 'duplicate sibling name' && dupHeld.has(pkey(r.path)))) entries.push(this.entry('', 'unmapped', r.path, { note: r.note }))

    const claimed = new Set<string>()
    for (const u of plan.units) claimed.add(u.file)
    // Scripts that stay this pass (on disk and in Studio): what they require is guarded.
    const guard = this.deleteGuard([...disk.files].filter((f) => claimed.has(f)).sort(), claimed)
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
          entries.push(await this.reconcileUnit(s, pick.unit, pick.conflict, checkpoint, guard))
          continue
        }
        if (u.kind === 'folder') {
          // First sync undecided: no folder is created (its files wait for the decision).
          if (!disk.dirs.has(u.file) && !s.firstSync) {
            await this.guard(map, u.file + '/x')
            // Present under another case (case-insensitive disk): not a new folder.
            const existed = await this.fs.lstat(this.abs(u.file)).then((i) => i.isDirectory(), () => false)
            if (existed) await this.fs.mkdir(this.abs(u.file), { recursive: true })
            else await this.writeNew(map, u.file, async () => void (await this.fs.mkdir(this.abs(u.file), { recursive: true })))
            disk.dirs.add(u.file)
            if (!existed) entries.push(this.entry(u.file, 'created', u.instancePath))
          }
          continue
        }
        entries.push(await this.reconcileUnit(s, u, undefined, checkpoint, guard))
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
      if (twin && !s.firstSync && (await this.sameFile(file, twin))) {
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
        entries.push(await this.diskOnly(s, file, kind, inst, stamp, guard))
      } catch (err) {
        entries.push(this.entry(file, 'unmapped', inst, { note: `refused: ${(err as Error).message}` }))
      }
    }

    // Bases of files neither side has any more: removed from disk and from Studio without Forge Sync
    // doing it (Forge's own removals drop the base). Typical: Rojo two-way sync deleting the file when
    // the instance was deleted in Studio, or a disk delete Rojo carried into Studio. The last synced
    // copy is saved; a guarded file is held until the user restores it or confirms the delete.
    if (!s.firstSync) {
      const diskLower = new Set([...disk.files].map((f) => f.toLowerCase()))
      // Instances Studio still has (a base from a script's other form is not a loss).
      const live = new Set(plan.units.map((u) => pkey(u.instancePath)))
      for (const file of (await this.store.files(s.placeKey)).sort()) {
        if (disk.files.has(file) || diskLower.has(file.toLowerCase()) || claimed.has(file) || claimedLower.has(file.toLowerCase()) || plan.keep.has(file) || s.protect.has(file) || isGitkeep(file)) continue
        if (s.conflicts.has(file) || [...s.protect].some((p) => file.startsWith(p + '/'))) continue
        const kind = kindOfFile(file)
        if (!kind) continue
        const inst = fromDisk(map, file)
        if (!inst || !inScope(inst) || live.has(pkey(inst))) continue
        const hit = findRoot(map, inst)
        if (!hit?.root || !present.has(hit.root.path)) continue
        if (refusedPaths.some((p) => related(p, inst))) continue
        try {
          const e = await this.goneBoth(s, file, kind, inst, stamp, guard)
          if (e) entries.push(e)
        } catch (err) {
          entries.push(this.entry(file, 'unmapped', inst, { note: `refused: ${(err as Error).message}` }))
        }
      }
    }

    // After trashing (which prunes directories left empty): keep empty Studio folders on disk.
    for (const u of plan.units) {
      if (s.firstSync || u.kind !== 'folder' || !inScope(u.instancePath)) continue
      try {
        const e = await this.keepFolder(s, u, stamp)
        if (e) entries.push(e)
      } catch (err) {
        entries.push(this.entry(`${u.file}/${GITKEEP}`, 'unmapped', u.instancePath, { note: `refused: ${(err as Error).message}` }))
      }
    }
    await this.updateStudioOnly(s, plan, disk, checkpoint, entries)
    return entries
  }

  private async refreshStudioOnly(s: Session): Promise<void> {
    if (!s.tree) return
    const disk = await this.scan(s.map)
    const plan = this.plan(s, { isFile: (rel) => disk.files.has(rel), isDir: (rel) => disk.dirs.has(rel) })
    await this.updateStudioOnly(s, plan, disk, true, [])
  }

  // Instance paths (keys) the disk builds for this place: every mapped file and directory.
  private diskInstances(map: PlaceMap, disk: { files: Set<string>; dirs: Set<string> }): Set<string> {
    const out = new Set<string>()
    for (const f of disk.files) {
      if (isGitkeep(f)) continue
      const p = fromDisk(map, f)
      if (p) out.add(pkey(p))
    }
    for (const d of disk.dirs) {
      let best: SyncRoot | null = null
      for (const r of map.roots) if (!r.isFile && (d === r.path || d.startsWith(r.path + '/')) && (!best || r.path.length > best.path.length)) best = r
      if (best) out.add(pkey(d === best.path ? best.instance : [...best.instance, ...d.slice(best.path.length + 1).split('/')]))
    }
    return out
  }

  // Every script Studio has under a mapped root that has no file on disk and no conflict held for it,
  // and that Rojo would delete from Studio when it connects. Forge writes Studio-only scripts as soon
  // as it sees them; what is left here was refused (unsafe name, duplicate, oversize, inside a model
  // file), failed to write, or has a base saying the disk deleted it (a git checkout, a delete on
  // disk while Studio was closed, or "Disk" chosen for a script only Studio had). Before this list
  // existed such a script passed as "disk ahead", the gate cleared, and Rojo's connect offered to
  // delete it from Studio.
  private async updateStudioOnly(s: Session, plan: Plan, disk: { files: Set<string>; dirs: Set<string> }, checkpoint: boolean, entries: SyncEntry[]): Promise<void> {
    const map = s.map
    const units = new Map<string, Unit>()
    for (const u of plan.units) if (u.primary && u.kind === 'script') units.set(pkey(u.instancePath), u)
    const notes = new Map<string, string>()
    for (const r of plan.refused) notes.set(pkey(r.path), r.note)
    const present = new Set(plan.present.map((r) => r.path))
    const candidates: { node: StudioNode; root: SyncRoot; unit?: Unit }[] = []
    // Same-name siblings (and what is under them) are the duplicate conflict's business.
    const dups = new Set(plan.duplicates.filter((g) => g.file).flatMap((g) => g.nodes.map((m) => pkey(m.node.path))))
    const inDup = (path: string[]): boolean => dups.size > 0 && path.some((_, i) => dups.has(pkey(path.slice(0, i + 1))))
    for (const node of s.tree?.values() ?? []) {
      if (!isScriptClass(node.className)) continue
      if (inDup(node.path)) continue
      const hit = findRoot(map, node.path)
      if (!hit?.root || !present.has(hit.root.path)) continue
      const unit = units.get(pkey(node.path))
      if (unit && (disk.files.has(unit.file) || s.conflicts.has(unit.file))) continue
      candidates.push({ node, root: hit.root, unit })
    }
    const before = new Map(s.studioOnly.map((i) => [pkey(i.instancePath), i]))
    const next: HeldStudioOnly[] = []
    if (candidates.length) {
      // This pass may have written some of them: judge against the disk as it is now.
      const now = await this.scan(map)
      const onDisk = this.diskInstances(map, now)
      const seen = new Set<string>()
      for (const { node, root, unit } of candidates) {
        const k = pkey(node.path)
        if (seen.has(k)) continue
        seen.add(k)
        if (unit ? now.files.has(unit.file) : onDisk.has(k)) continue
        // Rojo leaves a Studio-only child of an $ignoreUnknownInstances root alone (only that level).
        let top = node.path
        for (let i = root.instance.length + 1; i <= node.path.length; i++) {
          if (!onDisk.has(pkey(node.path.slice(0, i)))) {
            top = node.path.slice(0, i)
            break
          }
        }
        if (root.ignoreUnknown && top.length === root.instance.length + 1) continue
        let reason: string
        if (unit) {
          const failed = entries.find((e) => e.file === unit.file && e.action === 'unmapped' && e.note)
          const base = await this.store.get(s.placeKey, unit.file)
          reason = failed ? `could not be written (${failed.note!.replace(/^refused: /, '')})` : base ? 'its file was removed from disk (or "Disk" was chosen for it) while Studio kept it' : before.get(k)?.reason ?? 'not written to disk yet'
        } else {
          let note: string | undefined
          for (let i = node.path.length; i > root.instance.length && !note; i--) note = notes.get(pkey(node.path.slice(0, i)))
          reason = `Forge cannot write it: ${note ?? 'unmapped'}`
        }
        next.push({ instancePath: [...node.path], ...(unit ? { file: unit.file } : {}), reason, canPull: !!unit, hold: checkpoint || !!before.get(k)?.hold })
      }
    }
    next.sort((a, b) => a.instancePath.join('.').localeCompare(b.instancePath.join('.')))
    s.studioOnly = next
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
    const trashPath = await this.trash(map, keep, stamp)
    return this.entry(keep, 'trashed', u.instancePath, { note: 'folder has children now: .gitkeep removed', trashPath })
  }

  // A same-name group in Studio: one file can hold only one of them, and Rojo keeps one and deletes
  // the others when it connects. Held as a 'duplicate' conflict (rojo serve waits) unless the user
  // already decided this exact group. Studio's side is the copy edited since the base (or, without a
  // base, the one that differs from the disk).
  private async holdDuplicate(s: Session, group: DuplicateGroup): Promise<SyncEntry> {
    const file = group.file!
    const kind = group.kind!
    const first = group.nodes[0].node
    const path = first.path
    const diskText = kind === 'folder' ? null : await this.read(file)
    const texts = group.nodes.map((m) => (m.render ? m.render(diskText) : null))
    const sig = `${kind}|` + group.nodes.map((m, i) => `${m.node.className}:${texts[i] === null ? '-' : hashText(canon(kind, texts[i]!))}`).sort().join('|')
    s.conflicts.delete(file)
    const parent = path.slice(0, -1).join('.') || 'the place'
    const name = path[path.length - 1]
    const classes = [...new Set(group.nodes.map((m) => m.node.className))]
    const what = classes.length === 1 ? `${group.nodes.length} ${classes[0]}s named ${name}` : `${group.nodes.length} instances named ${name} (${classes.join(', ')})`
    if (s.dupAccepted.get(file) === sig) return this.entry(file, 'unmapped', path, { note: `duplicate sibling name: ${what} in ${parent}; you picked a side, Rojo keeps one when it connects` })
    const base = kind === 'folder' ? null : await this.store.get(s.placeKey, file)
    const diskCanon = diskText === null ? null : canon(kind, diskText)
    const hashes = texts.map((t) => (t === null ? null : hashText(canon(kind, t))))
    const reference = base?.hash ?? (diskCanon === null ? null : hashText(diskCanon))
    const edited = texts.map((_, i) => i).filter((i) => hashes[i] !== null && hashes[i] !== reference)
    const pick = edited.length ? edited[0] : texts.findIndex((t) => t !== null)
    const studioText = pick >= 0 ? texts[pick]! : ''
    const describe = group.nodes.map((m, i) => {
      const t = texts[i]
      const label = `copy ${i + 1} (${m.node.className})`
      if (t === null) return label
      if (diskCanon !== null && hashes[i] === hashText(diskCanon)) return `${label} = disk`
      if (base && hashes[i] === base.hash) return `${label} = last synced, ${diskCanon === null ? 'no file on disk' : `${changedLines(canon(kind, t), diskCanon)} line(s) differ from disk`}`
      return `${label}: ${diskCanon === null ? 'no file on disk' : `${changedLines(canon(kind, t), diskCanon)} line(s) differ from disk`}`
    })
    const take = kind === 'folder' ? 'Rename or delete the extra one in Studio' : `Take Studio writes copy ${pick + 1} to disk, Take disk keeps the file; then delete the extra copy in Studio (or accept Rojo's dialog, which deletes it)`
    const note = `Studio has ${what} in ${parent} (one file, ${file}, can hold only one; Rojo would keep one and delete the rest): ${describe.join('; ')}. ${take}`
    s.conflicts.set(file, {
      info: { placeKey: s.placeKey, file, instancePath: path, base: base?.text ?? null, disk: diskText ?? '', studio: studioText, reason: 'duplicate', note, copies: group.nodes.length },
      kind,
      studioText,
      studioCanon: kind === 'folder' ? '' : canon(kind, studioText),
      studioDeleted: false,
      diskDeleted: diskText === null && kind !== 'folder',
      shared: false,
      duplicate: sig
    })
    return this.entry(file, 'conflict', path, { note })
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

  // checkpoint: see reconcile. Only then is a shared file's pull checked against the other places: a
  // live edit was just made in this Studio, and Rojo carries it to them.
  private async reconcileUnit(s: Session, u: Unit, mountConflict?: string, checkpoint = false, guard?: DeleteGuard): Promise<SyncEntry> {
    const map = s.map
    // A shared-file conflict stays held until the user picks a side, live edits included.
    const checkShared = checkpoint || !!s.conflicts.get(u.file)?.shared
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
      if (s.firstSync) {
        this.hold(s, u, studioText, cS, '', base?.text ?? null, 'first-run', { diskDeleted: true })
        return this.entry(u.file, 'conflict', u.instancePath, { note: 'first sync: only in Studio, waits for your choice' })
      }
      if (!base) {
        await this.writeNew(map, u.file, () => this.writeFile(map, u.file, toFileText(studioText)))
        await this.store.set(s.placeKey, u.file, cS)
        return this.entry(u.file, 'created', u.instancePath)
      }
      if (hashText(cS) === base.hash) {
        // "Pull to disk": the user wants Studio's copy back on disk. A form change: the script is on
        // disk in its other form (trashed below), so this base is stale.
        if (u.formFrom || s.restore.some((p) => startsWith(u.instancePath, p))) {
          await this.writeNew(map, u.file, () => this.writeFile(map, u.file, toFileText(studioText)))
          await this.store.set(s.placeKey, u.file, cS)
          return this.entry(u.file, 'created', u.instancePath, { note: u.formFrom ? `form changed in Studio (was ${u.formFrom})` : 'pulled to disk (only Studio had it)' })
        }
        // Rojo carries a disk delete into Studio: a guarded script waits for the user's word first.
        const why = guard && !this.confirmed(s.placeKey).has(u.file) ? await guard(u.file, studioText) : null
        if (why) {
          const note = `deleted on disk, not by Forge Sync (${why}): Take Studio writes it back to disk, Take disk deletes it from Studio too`
          this.hold(s, u, studioText, cS, '', base.text, 'deleted-vs-edited', { diskDeleted: true, note })
          return this.entry(u.file, 'conflict', u.instancePath, { note })
        }
        return this.entry(u.file, 'disk-ahead', u.instancePath, { note: 'deleted on disk' })
      }
      this.hold(s, u, studioText, cS, '', base.text, 'deleted-vs-edited', { diskDeleted: true })
      return this.entry(u.file, 'conflict', u.instancePath, { note: 'deleted on disk, edited in Studio' })
    }
    this.confirmedDeletes.get(s.placeKey)?.delete(u.file)
    const cD = canon(u.kind, diskText)
    if (cS === cD) {
      await this.store.set(s.placeKey, u.file, cS)
      return this.entry(u.file, 'same', u.instancePath)
    }
    if (!base || s.firstSync) {
      this.hold(s, u, studioText, cS, diskText, null, 'first-run')
      return this.entry(u.file, 'conflict', u.instancePath, { note: 'first run: Studio and disk differ' })
    }
    if (hashText(cS) === base.hash) return this.entry(u.file, 'disk-ahead', u.instancePath)
    if (hashText(cD) === base.hash) {
      const shared = checkShared ? await this.sharedDiffers(s, u, cS) : null
      if (shared) {
        this.hold(s, u, studioText, cS, diskText, base.text, 'both-changed', { note: shared, shared: true })
        return this.entry(u.file, 'conflict', u.instancePath, { note: shared })
      }
      await this.writeFile(map, u.file, toFileText(studioText, diskText))
      await this.store.set(s.placeKey, u.file, cS)
      return this.entry(u.file, 'pulled', u.instancePath)
    }
    if (base.text !== null) {
      const merged = diff3(base.text, cD, cS)
      const out = merged.clean ? this.renderMerged(u.kind, merged.text, diskText) : null
      const shared = out !== null && checkShared ? await this.sharedDiffers(s, u, canon(u.kind, out)) : null
      if (shared) {
        this.hold(s, u, studioText, cS, diskText, base.text, 'both-changed', { note: shared, shared: true })
        return this.entry(u.file, 'conflict', u.instancePath, { note: shared })
      }
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

  // Writing `canonText` to a file another place maps too would leave that place's copy behind: why
  // ("shared with Menu: copies differ"), or null when every such place has exactly this copy (for a
  // script, its live Studio source; otherwise the base it last synced) or has never synced the file.
  private async sharedDiffers(s: Session, u: Unit, canonText: string): Promise<string | null> {
    const hash = hashText(canonText)
    const differ: string[] = []
    for (const other of sharedWith(this.maps, s.map, u.file)) {
      for (const key of await this.placeKeysFor(other.projectFile)) {
        const live = this.sessions.get(key)
        const inst = u.kind === 'script' && live?.tree ? fromDisk(live.map, u.file) : null
        const node = inst ? [...live!.tree!.values()].find((n) => pkey(n.path) === pkey(inst) && isScriptClass(n.className) && typeof n.source === 'string') : undefined
        const copy = node ? hashText(node.source!) : (await this.store.get(key, u.file))?.hash
        if (copy && copy !== hash) {
          differ.push(other.name && other.name !== s.map.name ? other.name : other.projectFile)
          break
        }
      }
    }
    return differ.length ? `shared with ${differ.join(', ')}: copies differ` : null
  }

  // Base-store keys of the places synced with a place file: its sessions, configured PlaceIds and
  // places linked in Source Control (links.json).
  private async placeKeysFor(projectFile: string): Promise<string[]> {
    const links = new PlaceLinks(this.root, this.fs as never)
    await links.load()
    const out = new Set<string>()
    for (const s of this.sessions.values()) if (s.map.projectFile === projectFile) out.add(s.placeKey)
    for (const key of await this.store.placeKeys()) {
      const place = /^\d+$/.test(key) ? { placeId: Number(key) } : key.startsWith('local:') ? { placeId: 0, linkId: key.slice('local:'.length) } : null
      if (place && matchPlace(this.maps, links.all(), place)?.projectFile === projectFile) out.add(key)
    }
    return [...out]
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

  private hold(s: Session, u: { kind: UnitKind; file: string; instancePath: string[] }, studioText: string, studioCanon: string, disk: string, base: string | null, reason: SyncConflictInfo['reason'], flags: { studioDeleted?: boolean; diskDeleted?: boolean; note?: string; shared?: boolean } = {}): void {
    s.conflicts.set(u.file, {
      info: { placeKey: s.placeKey, file: u.file, instancePath: u.instancePath, base, disk, studio: studioText, reason, ...(flags.note ? { note: flags.note } : {}) },
      kind: u.kind,
      studioText,
      studioCanon,
      studioDeleted: flags.studioDeleted ?? false,
      diskDeleted: flags.diskDeleted ?? false,
      shared: flags.shared ?? false
    })
  }

  private async diskOnly(s: Session, file: string, kind: UnitKind, inst: string[], stamp: string, guard?: DeleteGuard): Promise<SyncEntry> {
    s.conflicts.delete(file)
    const base = await this.store.get(s.placeKey, file)
    // First sync undecided: nothing is trashed.
    if (!base || s.firstSync) return this.entry(file, 'disk-ahead', inst)
    // Another place still maps the file: the delete only means this place no longer has it.
    const others = sharedWith(this.maps, s.map, isGitkeep(file) ? `${dirOf(file)}/init.meta.json` : file)
    if (others.length) {
      await this.store.delete(s.placeKey, file)
      return this.entry(file, 'disk-ahead', inst, { note: `kept: shared with ${others.map((m) => m.name || m.projectFile).join(', ')}, which still maps it` })
    }
    const text = (await this.read(file)) ?? ''
    if (hashText(canon(kind, text)) === base.hash) {
      const why = guard ? await guard(file, text) : null
      if (why) {
        const note = `deleted in Studio (${why}): keep or delete? Take disk keeps it (Rojo puts it back in Studio), Take Studio moves it to ${TRASH_DIR}`
        this.hold(s, { kind, file, instancePath: inst }, '', '', text, base.text, 'deleted-vs-edited', { studioDeleted: true, note })
        return this.entry(file, 'conflict', inst, { note })
      }
      const trashPath = await this.trash(s.map, file, stamp)
      await this.store.delete(s.placeKey, file)
      return this.entry(file, 'trashed', inst, { trashPath })
    }
    this.hold(s, { kind, file, instancePath: inst }, '', '', text, base.text, 'deleted-vs-edited', { studioDeleted: true })
    return this.entry(file, 'conflict', inst, { note: 'deleted in Studio, edited on disk' })
  }

  // A base whose file is on neither side: removed outside Forge Sync. Saves the last synced copy under
  // RECOVERED_DIR; a guarded file is held ("restore or delete?"), any other base is dropped. A delete
  // the user already confirmed only drops the base.
  private async goneBoth(s: Session, file: string, kind: UnitKind, inst: string[], stamp: string, guard: DeleteGuard): Promise<SyncEntry | null> {
    const confirmed = this.confirmedDeletes.get(s.placeKey)
    const base = await this.store.get(s.placeKey, file)
    if (!base) return null
    if (confirmed?.has(file) || base.text === null) {
      // Confirmed, or a digest-only base (migrated from the legacy state): nothing to recover.
      if (confirmed?.delete(file)) await this.store.delete(s.placeKey, file)
      return null
    }
    const trashPath = await this.saveRecovered(s.placeKey, file, base.text, stamp)
    const why = await guard(file, base.text)
    if (why) {
      const note = `gone from disk and from Studio, not removed by Forge Sync (${why}): Take disk restores the last synced copy (also saved to ${trashPath}), Take Studio confirms the delete`
      s.conflicts.set(file, {
        info: { placeKey: s.placeKey, file, instancePath: inst, base: base.text, disk: base.text, studio: '', reason: 'deleted-vs-edited', note },
        kind,
        studioText: '',
        studioCanon: '',
        studioDeleted: true,
        diskDeleted: true,
        shared: false,
        lost: true
      })
      return this.entry(file, 'conflict', inst, { note, trashPath })
    }
    await this.store.delete(s.placeKey, file)
    return this.entry(file, 'disk-ahead', inst, { note: `gone from disk and from Studio, not removed by Forge Sync; last synced copy saved to ${trashPath}`, trashPath })
  }

  private async resolveOne(s: Session, held: HeldConflict, take: 'studio' | 'disk' | 'merged', text?: string): Promise<void> {
    const file = held.info.file
    const map = s.map
    const current = await this.read(file)
    let trashPath: string | undefined
    if (held.duplicate) {
      // Same-name siblings: the file gets the side picked; Studio keeps both copies until the user (or
      // Rojo's connect dialog) removes the extra one. Not held again while the group stays the same.
      if (take !== 'disk') {
        if (held.kind === 'folder') throw new Error(`Studio has several instances named ${held.info.instancePath.join('.')}: rename or delete the extra one in Studio`)
        const out = take === 'merged' ? text : held.studioText
        if (typeof out !== 'string') throw new Error('merged resolution needs text')
        await this.writeFile(map, file, toFileText(out, current))
        await this.store.set(s.placeKey, file, canon(held.kind, out))
      }
      s.dupAccepted.set(file, held.duplicate)
      s.conflicts.delete(file)
      this.recentEntries.unshift(this.entry(file, take === 'disk' ? 'disk-ahead' : 'pulled', held.info.instancePath, { note: `resolved duplicate: ${take}; delete the extra copy in Studio` }))
      this.recentEntries.splice(RECENT_LIMIT)
      return
    }
    if (held.lost) {
      // Gone from both sides: "disk" restores the last synced copy (Rojo then puts it back in
      // Studio), "studio" confirms the delete, "merged" writes the given text.
      if (take === 'studio') await this.store.delete(s.placeKey, file)
      else {
        const out = take === 'merged' ? text : held.info.base
        if (typeof out !== 'string') throw new Error(take === 'merged' ? 'merged resolution needs text' : `no synced copy of ${file} to restore`)
        await this.writeFile(map, file, toFileText(out))
        await this.store.set(s.placeKey, file, canon(held.kind, out))
      }
      s.conflicts.delete(file)
      this.recentEntries.unshift(this.entry(file, take === 'studio' ? 'disk-ahead' : 'created', held.info.instancePath, { note: take === 'studio' ? 'resolved: delete confirmed' : 'resolved: restored to disk' }))
      this.recentEntries.splice(RECENT_LIMIT)
      return
    }
    if (take === 'studio') {
      if (held.studioDeleted) {
        if (current !== null) trashPath = await this.trash(map, file, this.stamp())
        await this.store.delete(s.placeKey, file)
      } else {
        await this.writeFile(map, file, toFileText(held.studioText, current))
        await this.store.set(s.placeKey, file, held.studioCanon)
      }
    } else if (take === 'disk') {
      // Disk stays; Rojo pushes it. Base = Studio's side so the next pass reads it as disk-ahead.
      if (held.studioDeleted) await this.store.delete(s.placeKey, file)
      else await this.store.set(s.placeKey, file, held.studioCanon)
      // A disk delete the user confirmed: the guard does not hold it again (Rojo deletes it in Studio).
      if (held.diskDeleted && current === null) this.confirmed(s.placeKey).add(file)
    } else {
      if (typeof text !== 'string') throw new Error('merged resolution needs text')
      const out = held.kind === 'model' || held.kind === 'meta' ? this.renderMerged(held.kind, canon(held.kind, text), current ?? '') : text
      if (out === null) throw new Error('merged text is not valid JSON')
      await this.writeFile(map, file, toFileText(out, current))
      if (held.studioDeleted) await this.store.delete(s.placeKey, file)
      else await this.store.set(s.placeKey, file, held.studioCanon)
    }
    s.conflicts.delete(file)
    this.recentEntries.unshift(this.entry(file, take === 'disk' ? 'disk-ahead' : take === 'merged' ? 'merged' : held.studioDeleted ? 'trashed' : 'pulled', held.info.instancePath, { note: `resolved: ${take}`, ...(trashPath ? { trashPath } : {}) }))
    this.recentEntries.splice(RECENT_LIMIT)
  }

  // ---- internals: tree edits ----

  // Records parents for nodes that arrive depth first (the plugin's snapshot walk; an 'added' node and
  // its GetDescendants): a node's parent is the nearest earlier node whose path is its parent path. A
  // node with no such node before it (the top of an 'added') gets the one instance at its parent path,
  // if there is exactly one.
  private linkParents(s: Session, nodes: StudioNode[]): void {
    const stack: StudioNode[] = []
    for (const n of nodes) {
      const parent = pkey(n.path.slice(0, -1))
      while (stack.length && pkey(stack[stack.length - 1].path) !== parent) stack.pop()
      let pid = stack.length ? stack[stack.length - 1].id : undefined
      if (!pid && n.path.length) {
        const at = [...s.tree!.values()].filter((x) => x.id !== n.id && pkey(x.path) === parent)
        if (at.length === 1) pid = at[0].id
      }
      if (pid) s.parents.set(n.id, pid)
      else s.parents.delete(n.id)
      stack.push(n)
    }
  }

  // The id of `node`'s ancestor at depth `depth` through recorded parents, or undefined if unknown.
  private ancestorAt(s: Session, node: StudioNode, depth: number): string | undefined {
    let cur: StudioNode | undefined = node
    while (cur && cur.path.length > depth) {
      const pid = s.parents.get(cur.id)
      cur = pid ? s.tree!.get(pid) : undefined
    }
    return cur && cur.path.length === depth ? cur.id : undefined
  }

  // Ids of the nodes below instance `id` (at `path`). With a same-name sibling at that path, only the
  // nodes known to descend from `id` (a descendant of unknown parentage stays: it may be the twin's).
  private subtreeOf(s: Session, id: string, path: string[]): string[] {
    const tree = s.tree!
    const twin = [...tree.values()].some((n) => n.id !== id && pkey(n.path) === pkey(path))
    const out: string[] = []
    for (const n of tree.values()) {
      if (n.path.length <= path.length || !startsWith(n.path, path)) continue
      if (!twin || this.ancestorAt(s, n, path.length) === id) out.push(n.id)
    }
    return out
  }

  private removeSubtree(s: Session, id: string, path: string[]): void {
    const tree = s.tree!
    const below = this.subtreeOf(s, id, path)
    tree.delete(id)
    s.parents.delete(id)
    for (const k of below) {
      tree.delete(k)
      s.parents.delete(k)
    }
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
    const moving = this.subtreeOf(s, change.id, from)
    tree.delete(change.id)
    for (const k of moving) {
      const n = tree.get(k)!
      n.path = [...to, ...n.path.slice(from.length)]
    }
    tree.set(change.id, change.node)
    this.linkParents(s, [change.node])
    // First sync undecided: no file moves; the new path is held like any other difference.
    if (!before || s.firstSync) return []
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
