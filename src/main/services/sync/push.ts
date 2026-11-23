// Direct 2-way Forge Sync: disk -> Studio push engine.
// Watches mapped $path roots (including Packages/), deduplicates via sha256 content hashes,
// suppresses Studio->disk echoes, respects 3-way conflict & gate locks, and emits chunked SyncPushBatch
// payloads pulled by ForgeBridge.luau v15.

import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { SyncPushAck, SyncPushBatch, SyncPushOp } from '../../../shared/sync/protocol.ts'
import type { PlacePushStats, StudioNode, SyncEntry, SyncValue } from '../../../shared/sync/types.ts'
import { fromDisk, isSkipped, PACKAGE_DIRS, parseFileName, rojoGlob, rojoIgnored, toDisk, type PlaceMap } from './mapping.ts'
import { normalise } from './merge.ts'
import { atomicWrite } from './store.ts'

export type PushMapLike = {
  projectFile: string
  placeIds: number[]
  roots: { instance: string[]; path: string; isFile?: boolean; ignoreUnknown?: boolean }[]
  skipped?: { instance: string[]; path?: string }[]
} & Partial<Omit<PlaceMap, 'roots' | 'skipped'>>

const MAX_BATCH_BYTES = 1024 * 1024
const INFLIGHT_RETRY_MS = 15_000
const IGNORE_DIRS = new Set(['.git', '.forge', 'node_modules'])
const PACKAGES_PATH_RE = /^(Server|Dev)?Packages(\/|$)/
const PACKAGE_META_SKIP = new Set(['sourcemap.json', 'package.json', 'tsconfig.json', 'wally.toml', 'wally.lock'])
const PUSHED_PACKAGES_FILE = join('.forge', 'sync', 'pushed-packages.json')

function isPackageSkip(s: { instance: string[]; path: string }): boolean {
  const last = s.instance[s.instance.length - 1]
  if (last && PACKAGE_DIRS.has(last)) return true
  return PACKAGES_PATH_RE.test(s.path.replace(/\\/g, '/'))
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(normalise(text), 'utf8').digest('hex')
}

function stableModelDigest(className: string, props?: Record<string, SyncValue>, attrs?: Record<string, SyncValue>, tags?: string[]): string {
  return sha256Text(JSON.stringify({ className, properties: props ?? {}, attributes: attrs ?? {}, tags: tags ?? [] }))
}

function scriptClassOf(c: string | undefined): 'Script' | 'LocalScript' | 'ModuleScript' {
  if (c === 'Script' || c === 'LocalScript') return c
  return 'ModuleScript'
}

function instancePathForPush(map: PlaceMap, childRel: string, fileInfo?: ReturnType<typeof parseFileName>): string[] | null {
  const fromRoot = fromDisk(map, childRel)
  if (fromRoot) return fromRoot
  for (const s of map.skipped) {
    const prefix = s.path.replace(/\\/g, '/')
    if (childRel !== prefix && !childRel.startsWith(prefix + '/')) continue
    const rest = childRel === prefix ? [] : childRel.slice(prefix.length + 1).split('/').filter(Boolean)
    if (!rest.length) return [...s.instance]
    const last = rest[rest.length - 1]
    const info = fileInfo ?? parseFileName(last, map.emitLegacyScripts)
    if (info && info.stem === null) return [...s.instance, ...rest.slice(0, -1)]
    if (info && info.stem !== null) return [...s.instance, ...rest.slice(0, -1), info.stem]
    return [...s.instance, ...rest]
  }
  return null
}

interface DiskSnapshot {
  opsByFile: Map<string, SyncPushOp>
  folders: Map<string, string[]> // relDir -> instancePath
  hashes: Map<string, string> // relFile -> sha256
  paths: Map<string, string[]> // relFile -> instancePath
}

interface QueuedPlace {
  placeKey: string
  projectFile: string
  ops: SyncPushOp[]
  inflight?: SyncPushBatch
  inflightAt?: number
  seq: number
  pushed: number
  lastPushAt?: number
  lastError?: string
}

export interface DirectPushOptions {
  root: string
  debounceMs?: number
  now?: () => number
  canPushPlace: (placeKey: string) => boolean
  canDeletePlace?: (placeKey: string) => boolean
  isFileConflicted: (placeKey: string, file: string) => boolean
  onEntries?: (placeKey: string, entries: SyncEntry[]) => void
  onQueued?: (placeKey: string) => void
  onChange?: () => void
  onError?: (err: Error) => void
}

async function readJsonObj(file: string): Promise<Record<string, unknown> | null> {
  try {
    const raw = await fsp.readFile(file, 'utf8')
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null
  } catch {
    return null
  }
}

function parseMetaRunContext(meta: Record<string, unknown> | null): 'Legacy' | 'Server' | 'Client' | undefined {
  const props = meta?.properties
  if (!props || typeof props !== 'object') return undefined
  const rc = (props as Record<string, unknown>).RunContext
  if (rc === 'Legacy' || rc === 'Server' || rc === 'Client') return rc
  return undefined
}

function opByteSize(op: SyncPushOp): number {
  if (op.kind === 'upsert-script') return Buffer.byteLength(op.source, 'utf8') + op.path.join('.').length + 128
  if (op.kind === 'upsert-instance') return Buffer.byteLength(JSON.stringify(op), 'utf8')
  return op.path.join('.').length + 96
}

export class DirectPushEngine {
  private readonly root: string
  private readonly debounceMs: number
  private readonly now: () => number
  private readonly opts: DirectPushOptions

  private maps: PlaceMap[] = []
  private readonly knownStudioHashes = new Map<string, Map<string, string>>() // placeKey -> relFile -> sha256
  private readonly knownInstancePaths = new Map<string, Map<string, string[]>>() // placeKey -> relFile -> instancePath
  private readonly queues = new Map<string, QueuedPlace>() // placeKey -> queue
  private readonly activePlaceKeys = new Map<string, string>() // projectFile -> placeKey
  private readonly echoSuppression = new Map<string, { hash: string; at: number }>() // relFile -> { hash, at }
  private persistedPkgHashes: Record<string, Record<string, string>> = {}
  private packageHashesLoaded = false
  private packageSaveChain: Promise<void> = Promise.resolve()
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingScan = false
  private rescanNeeded = false
  private closed = false

  constructor(opts: DirectPushOptions) {
    this.root = resolve(opts.root)
    this.debounceMs = opts.debounceMs ?? 100
    this.now = opts.now ?? Date.now
    this.opts = opts
  }

  /** Called right before/when Studio->disk pull writes a file so fs.watch never echoes it back. */
  markFromStudio(relPath: string, content: string, placeKey?: string): void {
    const normRel = relPath.replace(/\\/g, '/')
    const hash = sha256Text(content)
    this.echoSuppression.set(normRel, { hash, at: this.now() })
    if (placeKey) {
      let placeHashes = this.knownStudioHashes.get(placeKey)
      if (!placeHashes) {
        placeHashes = new Map()
        this.knownStudioHashes.set(placeKey, placeHashes)
      }
      placeHashes.set(normRel, hash)
      const q = this.queues.get(placeKey)
      if (q) {
        q.ops = q.ops.filter((op) => !('file' in op) || op.file !== normRel)
      }
    }
  }

  /** Called when Studio->disk trashed/removed a file so we don't re-push a deletion. */
  markDeletedFromStudio(relPath: string, placeKey?: string): void {
    const normRel = relPath.replace(/\\/g, '/')
    this.echoSuppression.delete(normRel)
    if (placeKey) {
      this.knownStudioHashes.get(placeKey)?.delete(normRel)
      const q = this.queues.get(placeKey)
      if (q) q.ops = q.ops.filter((op) => !('file' in op) || op.file !== normRel)
    }
  }

  private normalizeMap(m: PushMapLike): PlaceMap {
    return {
      root: this.root,
      projectFile: m.projectFile,
      name: m.name ?? m.projectFile.replace(/\.project\.json$/, ''),
      placeIds: m.placeIds,
      ...(m.servePort !== undefined ? { servePort: m.servePort } : {}),
      emitLegacyScripts: m.emitLegacyScripts ?? true,
      roots: m.roots.map((r) => ({
        instance: r.instance,
        path: r.path,
        isFile: r.isFile ?? false,
        ignoreUnknown: r.ignoreUnknown ?? false
      })),
      skipped: (m.skipped ?? []).filter((s): s is { instance: string[]; path: string } => typeof s.path === 'string' && s.path.length > 0),
      virtual: m.virtual ?? [],
      skipGlobs: m.skipGlobs ?? [],
      ignoreGlobs: m.ignoreGlobs ?? []
    }
  }

  /** Populates initial Studio hashes from a snapshot so unchanged files aren't pushed redundantly. */
  recordStudioSnapshot(placeKey: string, rawMap: PushMapLike, nodes: StudioNode[]): void {
    const map = this.normalizeMap(rawMap)
    this.activePlaceKeys.set(map.projectFile, placeKey)
    this.clearInflight(placeKey)

    let hashes = this.knownStudioHashes.get(placeKey)
    if (!hashes) {
      hashes = new Map()
      this.knownStudioHashes.set(placeKey, hashes)
    }
    for (const k of [...hashes.keys()]) {
      if (!PACKAGES_PATH_RE.test(k)) hashes.delete(k)
    }

    let paths = this.knownInstancePaths.get(placeKey)
    if (!paths) {
      paths = new Map()
      this.knownInstancePaths.set(placeKey, paths)
    }
    for (const k of [...paths.keys()]) {
      if (!PACKAGES_PATH_RE.test(k)) paths.delete(k)
    }

    const parentKeys = new Set<string>()
    for (const node of nodes) {
      if (node.path.length > 1) parentKeys.add(node.path.slice(0, -1).join('\u0000'))
    }
    for (const node of nodes) {
      const mapped = toDisk(map, {
        path: node.path,
        className: node.className,
        runContext: node.runContext,
        hasChildren: parentKeys.has(node.path.join('\u0000'))
      })
      if (!mapped || mapped.kind === 'folder') continue
      if (node.className === 'ModuleScript' || node.className === 'Script' || node.className === 'LocalScript') {
        if (typeof node.source === 'string') {
          const runContext = node.runContext
          const keyStr = runContext ? `${normalise(node.source)}\u0000${runContext}` : normalise(node.source)
          hashes.set(mapped.file, sha256Text(keyStr))
          paths.set(mapped.file, node.path)
        }
      } else {
        hashes.set(mapped.file, stableModelDigest(node.className, node.properties, node.attributes, node.tags))
        paths.set(mapped.file, node.path)
      }
    }
  }

  seedKnownHashes(placeKey: string, entries: Record<string, string>): void {
    let hashes = this.knownStudioHashes.get(placeKey)
    if (!hashes) {
      hashes = new Map()
      this.knownStudioHashes.set(placeKey, hashes)
    }
    for (const [k, v] of Object.entries(entries)) {
      hashes.set(k.replace(/\\/g, '/'), v)
    }
  }

  setPlaces(maps: PushMapLike[]): void {
    if (this.closed) return
    this.maps = maps.map((m) => this.normalizeMap(m))
    this.resetWatchers()
  }

  bindPlace(placeKey: string, projectFile: string): void {
    this.activePlaceKeys.set(projectFile, placeKey)
  }

  clearInflight(placeKey: string): void {
    const q = this.queues.get(placeKey)
    if (!q) return
    q.inflight = undefined
    q.inflightAt = undefined
  }

  unbindPlace(placeKey: string): void {
    for (const [pf, pk] of this.activePlaceKeys) {
      if (pk === placeKey) this.activePlaceKeys.delete(pf)
    }
    this.queues.delete(placeKey)
    this.knownStudioHashes.delete(placeKey)
    this.knownInstancePaths.delete(placeKey)
  }

  private canDelete(placeKey: string): boolean {
    return (this.opts.canDeletePlace ?? this.opts.canPushPlace)(placeKey)
  }

  hasPending(placeKey: string): boolean {
    if (!this.opts.canPushPlace(placeKey)) return false
    const q = this.queues.get(placeKey)
    if (!q) return false
    if (q.inflight) return this.now() - (q.inflightAt ?? 0) >= INFLIGHT_RETRY_MS
    return q.ops.some(
      (op) =>
        (op.kind !== 'delete' || this.canDelete(placeKey)) &&
        (!('file' in op) || !op.file || !this.opts.isFileConflicted(placeKey, op.file))
    )
  }

  stats(placeKey: string): PlacePushStats | undefined {
    const q = this.queues.get(placeKey)
    if (!q) return undefined
    const pending = q.ops.length + (q.inflight?.ops.length ?? 0)
    return {
      pushed: q.pushed,
      pending,
      ...(q.lastPushAt ? { lastPushAt: q.lastPushAt } : {}),
      ...(q.lastError ? { lastError: q.lastError } : {})
    }
  }

  private async ensurePackageHashesLoaded(): Promise<void> {
    if (this.packageHashesLoaded) return
    this.packageHashesLoaded = true
    const parsed = await readJsonObj(join(this.root, PUSHED_PACKAGES_FILE))
    const places = parsed?.places
    if (!places || typeof places !== 'object' || Array.isArray(places)) return
    for (const [pk, entries] of Object.entries(places as Record<string, unknown>)) {
      if (!entries || typeof entries !== 'object' || Array.isArray(entries)) continue
      const map: Record<string, string> = {}
      for (const [file, hash] of Object.entries(entries as Record<string, unknown>)) {
        if (typeof hash === 'string') map[file.replace(/\\/g, '/')] = hash
      }
      this.persistedPkgHashes[pk] = map
    }
  }

  private queueSavePackageHashes(): void {
    const snapshot = JSON.stringify({ version: 1, places: this.persistedPkgHashes })
    const target = join(this.root, PUSHED_PACKAGES_FILE)
    this.packageSaveChain = this.packageSaveChain
      .then(async () => {
        await atomicWrite(fsp, target, snapshot)
      })
      .catch(() => undefined)
  }

  async syncPlace(placeKey: string, rawMap: PushMapLike): Promise<SyncPushOp[]> {
    if (this.closed) return []
    const map = this.normalizeMap(rawMap)
    this.activePlaceKeys.set(map.projectFile, placeKey)
    await this.ensurePackageHashesLoaded()

    const snap = await this.scanMap(map)
    const prevHashes = this.knownStudioHashes.get(placeKey) ?? new Map<string, string>()
    this.knownStudioHashes.set(placeKey, prevHashes)
    for (const [file, hash] of Object.entries(this.persistedPkgHashes[placeKey] ?? {})) {
      if (!prevHashes.has(file)) prevHashes.set(file, hash)
    }
    const prevPaths = this.knownInstancePaths.get(placeKey) ?? new Map<string, string[]>()
    this.knownInstancePaths.set(placeKey, prevPaths)

    const ops: SyncPushOp[] = []
    const neededFolders = new Set<string>()

    // Detect creations & updates
    for (const [rel, op] of snap.opsByFile) {
      if (this.opts.isFileConflicted(placeKey, rel)) continue
      const newHash = snap.hashes.get(rel)!
      const knownHash = prevHashes.get(rel)
      const suppressed = this.echoSuppression.get(rel)
      if (suppressed && suppressed.hash === newHash && this.now() - suppressed.at < 10_000) {
        prevHashes.set(rel, newHash)
        const p = snap.paths.get(rel)
        if (p) prevPaths.set(rel, p)
        continue
      }
      if (knownHash === newHash) {
        const p = snap.paths.get(rel)
        if (p) prevPaths.set(rel, p)
        continue
      }

      // Ensure parent folders along mapped path exist before script/instance upsert
      for (let i = 2; i < op.path.length; i++) {
        const prefix = op.path.slice(0, i)
        neededFolders.add(prefix.join('\u0000'))
      }
      ops.push(op)
    }

    for (const [, folderPath] of snap.folders) {
      if (folderPath.length >= 2) neededFolders.add(folderPath.join('\u0000'))
    }

    const diskInstanceKeys = new Set<string>()
    for (const op of snap.opsByFile.values()) diskInstanceKeys.add(op.path.join('\u0000'))
    for (const folderPath of snap.folders.values()) diskInstanceKeys.add(folderPath.join('\u0000'))

    // Detect deletions (previously known on Studio, now gone from disk under this map)
    for (const [rel] of prevHashes) {
      if (snap.hashes.has(rel)) continue
      if (!this.canDelete(placeKey)) continue
      if (this.opts.isFileConflicted(placeKey, rel)) continue
      const instPath = prevPaths.get(rel) ?? instancePathForPush(map, rel)
      if (!instPath || instPath.length < 2) continue
      if (diskInstanceKeys.has(instPath.join('\u0000'))) {
        prevHashes.delete(rel)
        prevPaths.delete(rel)
        continue
      }
      ops.push({ kind: 'delete', path: instPath, file: rel })
    }

    for (const [rel, p] of snap.paths) prevPaths.set(rel, p)

    const opInstanceKeys = new Set<string>()
    for (const o of ops) {
      if (o.kind !== 'delete') opInstanceKeys.add(o.path.join('\u0000'))
    }

    const pkgInstancePrefixes = map.skipped.filter(isPackageSkip).map((s) => s.instance)
    const isPackageOp = (op: SyncPushOp): boolean => {
      if ('file' in op && op.file && PACKAGES_PATH_RE.test(op.file.replace(/\\/g, '/'))) return true
      return pkgInstancePrefixes.some((pref) => op.path.length >= pref.length && pref.every((seg, i) => op.path[i] === seg))
    }

    const folderOps: SyncPushOp[] = [...neededFolders]
      .filter((k) => !opInstanceKeys.has(k))
      .map((k) => k.split('\u0000'))
      .sort((a, b) => a.length - b.length || a.join('.').localeCompare(b.join('.')))
      .map((path) => ({ kind: 'upsert-folder' as const, path }))

    const upsertOps = ops
      .filter((o) => o.kind !== 'delete')
      .sort((a, b) => a.path.length - b.path.length || a.path.join('.').localeCompare(b.path.join('.')))
    const deleteOps = ops
      .filter((o) => o.kind === 'delete')
      .sort((a, b) => b.path.length - a.path.length || b.path.join('.').localeCompare(a.path.join('.')))

    const srcFolders = folderOps.filter((o) => !isPackageOp(o))
    const pkgFolders = folderOps.filter((o) => isPackageOp(o))
    const srcUpserts = upsertOps.filter((o) => !isPackageOp(o))
    const pkgUpserts = upsertOps.filter((o) => isPackageOp(o))
    const srcDeletes = deleteOps.filter((o) => !isPackageOp(o))
    const pkgDeletes = deleteOps.filter((o) => isPackageOp(o))

    // Prioritize user source changes before package dependencies; omit redundant folders if no upserts
    const hasSrc = srcUpserts.length > 0
    const hasPkg = pkgUpserts.length > 0
    const combined: SyncPushOp[] = [
      ...(hasSrc ? srcFolders : []),
      ...srcUpserts,
      ...srcDeletes,
      ...(hasPkg ? pkgFolders : []),
      ...pkgUpserts,
      ...pkgDeletes
    ]

    const q = this.ensureQueue(placeKey, map.projectFile)
    q.ops = combined
    if (combined.length > 0) {
      this.opts.onQueued?.(placeKey)
      this.opts.onChange?.()
    }
    return combined
  }

  pullNextBatch(placeKey: string): SyncPushBatch | undefined {
    if (!this.opts.canPushPlace(placeKey)) return undefined
    const q = this.queues.get(placeKey)
    if (!q) return undefined
    if (q.inflight) {
      q.inflightAt = this.now()
      return q.inflight
    }

    // Filter out any ops that became conflicted or restricted in the meantime
    q.ops = q.ops.filter(
      (op) =>
        (op.kind !== 'delete' || this.canDelete(placeKey)) &&
        (!('file' in op) || !op.file || !this.opts.isFileConflicted(placeKey, op.file))
    )
    if (!q.ops.length) return undefined

    const batchOps: SyncPushOp[] = []
    let bytes = 0
    while (q.ops.length > 0) {
      const next = q.ops[0]
      const size = opByteSize(next)
      if (batchOps.length > 0 && bytes + size > MAX_BATCH_BYTES) break
      q.ops.shift()
      batchOps.push(next)
      bytes += size
    }

    const batch: SyncPushBatch = {
      batchId: randomUUID(),
      placeKey,
      seq: ++q.seq,
      ops: batchOps
    }
    q.inflight = batch
    q.inflightAt = this.now()
    return batch
  }

  ackBatch(placeKey: string, ack: SyncPushAck): SyncEntry[] {
    return this.ackBatchWithOps(placeKey, ack).entries
  }

  ackBatchWithOps(placeKey: string, ack: SyncPushAck): { entries: SyncEntry[]; appliedOps: SyncPushOp[] } {
    const q = this.queues.get(placeKey)
    if (!q || !q.inflight || q.inflight.batchId !== ack.batchId) {
      return { entries: [], appliedOps: [] }
    }
    const batch = q.inflight
    q.inflight = undefined
    q.inflightAt = undefined

    const hashes = this.knownStudioHashes.get(placeKey) ?? new Map<string, string>()
    this.knownStudioHashes.set(placeKey, hashes)

    const appliedSet = new Set(ack.applied)
    const entries: SyncEntry[] = []
    const appliedOps: SyncPushOp[] = []
    const ts = this.now()
    let pkgTouched = false

    for (const op of batch.ops) {
      if (!('file' in op) || !op.file) continue
      if (!appliedSet.has(op.file)) continue
      const isPkg = PACKAGES_PATH_RE.test(op.file)
      if (op.kind === 'delete') {
        hashes.delete(op.file)
        this.knownInstancePaths.get(placeKey)?.delete(op.file)
        if (isPkg && this.persistedPkgHashes[placeKey]) {
          delete this.persistedPkgHashes[placeKey][op.file]
          pkgTouched = true
        }
      } else if (op.kind === 'upsert-script' || op.kind === 'upsert-instance') {
        hashes.set(op.file, op.sha256)
        this.knownInstancePaths.get(placeKey)?.set(op.file, op.path)
        if (isPkg) {
          ;(this.persistedPkgHashes[placeKey] ??= {})[op.file] = op.sha256
          pkgTouched = true
        }
      }
      appliedOps.push(op)
      entries.push({
        file: op.file,
        action: 'pushed',
        instancePath: op.path,
        at: ts
      })
      q.pushed++
    }

    if (pkgTouched) this.queueSavePackageHashes()

    q.lastPushAt = ts
    if (ack.errors?.length) {
      q.lastError = ack.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ').slice(0, 300)
    } else {
      q.lastError = undefined
    }

    if (entries.length) this.opts.onEntries?.(placeKey, entries)
    this.opts.onChange?.()
    return { entries, appliedOps }
  }

  private ensureQueue(placeKey: string, projectFile: string): QueuedPlace {
    let q = this.queues.get(placeKey)
    if (!q) {
      q = { placeKey, projectFile, ops: [], seq: 0, pushed: 0 }
      this.queues.set(placeKey, q)
    }
    q.projectFile = projectFile
    return q
  }

  private async scanMap(map: PlaceMap): Promise<DiskSnapshot> {
    const opsByFile = new Map<string, SyncPushOp>()
    const folders = new Map<string, string[]>()
    const hashes = new Map<string, string>()
    const paths = new Map<string, string[]>()
    const seenReal = new Set<string>()
    const realRoot = await fsp.realpath(this.root).catch(() => this.root)

    const isInsideRoot = async (absPath: string): Promise<string | null> => {
      const real = await fsp.realpath(absPath).catch(() => null)
      if (!real) return null
      const relReal = relative(realRoot, real)
      if (relReal === '..' || relReal.startsWith('..' + sep) || isAbsolute(relReal)) return null
      return real
    }

    const addFile = async (
      fileAbs: string,
      fileName: string,
      instPath: string[],
      isPackageTree: boolean,
      emitLegacyScripts: boolean,
      siblingNames: Set<string> | null
    ) => {
      if (instPath.length < 2) return
      const childRel = relative(this.root, fileAbs).replace(/\\/g, '/')
      if (!isPackageTree && isSkipped(map.skipGlobs, childRel)) return
      if (rojoIgnored({ roots: map.roots, ignoreGlobs: (map as Partial<PlaceMap>).ignoreGlobs ?? [] }, childRel)) return
      if (fileName.endsWith('.meta.json')) return
      if (isPackageTree && (PACKAGE_META_SKIP.has(fileName) || fileName.endsWith('.project.json'))) return

      const info = parseFileName(fileName, emitLegacyScripts)
      if (info?.kind === 'script') {
        const sourceRaw = await fsp.readFile(fileAbs, 'utf8').catch(() => null)
        if (sourceRaw === null) return
        const source = sourceRaw.replace(/\r\n/g, '\n')
        const metaName = info.stem === null ? 'init.meta.json' : `${info.stem}.meta.json`
        const meta = siblingNames === null || siblingNames.has(metaName) ? await readJsonObj(join(dirname(fileAbs), metaName)) : null
        const runContext = parseMetaRunContext(meta)
        const digestInput = runContext && runContext !== 'Legacy' ? `${normalise(source)}\u0000${runContext}` : normalise(source)
        const sha256 = sha256Text(digestInput)
        hashes.set(childRel, sha256)
        paths.set(childRel, instPath)
        opsByFile.set(childRel, {
          kind: 'upsert-script',
          path: instPath,
          className: scriptClassOf(info.className),
          source,
          ...(runContext && runContext !== 'Legacy' ? { runContext } : {}),
          sha256,
          file: childRel
        })
      } else if (info?.kind === 'model') {
        const model = await readJsonObj(fileAbs)
        if (!model) return
        const className = typeof (model.ClassName ?? model.className) === 'string' ? String(model.ClassName ?? model.className) : 'Folder'
        const properties = (model.Properties ?? model.properties) as Record<string, SyncValue> | undefined
        const attributes = (model.Attributes ?? model.attributes) as Record<string, SyncValue> | undefined
        const tags = Array.isArray(model.Tags ?? model.tags) ? ((model.Tags ?? model.tags) as unknown[]).filter((t): t is string => typeof t === 'string') : undefined
        const sha256 = stableModelDigest(className, properties, attributes, tags)
        hashes.set(childRel, sha256)
        paths.set(childRel, instPath)
        opsByFile.set(childRel, {
          kind: 'upsert-instance',
          path: instPath,
          className,
          ...(properties && Object.keys(properties).length ? { properties } : {}),
          ...(attributes && Object.keys(attributes).length ? { attributes } : {}),
          ...(tags?.length ? { tags } : {}),
          sha256,
          file: childRel
        })
      } else if (fileName.endsWith('.json') && !fileName.endsWith('.project.json')) {
        const rawJson = await fsp.readFile(fileAbs, 'utf8').catch(() => null)
        if (rawJson === null) return
        const source = `return game:GetService("HttpService"):JSONDecode(${JSON.stringify(normalise(rawJson))})\n`
        const sha256 = sha256Text(source)
        hashes.set(childRel, sha256)
        paths.set(childRel, instPath)
        opsByFile.set(childRel, {
          kind: 'upsert-script',
          path: instPath,
          className: 'ModuleScript',
          source,
          sha256,
          file: childRel
        })
      } else if (fileName.endsWith('.txt')) {
        const rawTxt = await fsp.readFile(fileAbs, 'utf8').catch(() => null)
        if (rawTxt === null) return
        const properties: Record<string, SyncValue> = { Value: normalise(rawTxt) }
        const sha256 = stableModelDigest('StringValue', properties)
        hashes.set(childRel, sha256)
        paths.set(childRel, instPath)
        opsByFile.set(childRel, {
          kind: 'upsert-instance',
          path: instPath,
          className: 'StringValue',
          properties,
          sha256,
          file: childRel
        })
      }
    }

    const walkEntries = async (
      absDir: string,
      realDir: string,
      instPrefix: string[],
      isPackageTree: boolean,
      emitLegacyScripts: boolean,
      allowNested: boolean,
      nestedIgnores: RegExp[] = [],
      nestedRootAbs?: string
    ): Promise<void> => {
      let entries
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }
      const entryNames = new Set(entries.map((e) => e.name))

      // Honor nested default.project.json inside package subdirectories (e.g. Wally _Index)
      if (allowNested && absDir !== this.root && entryNames.has('default.project.json')) {
        const proj = await readJsonObj(join(absDir, 'default.project.json'))
        if (proj && proj.tree && typeof proj.tree === 'object' && !Array.isArray(proj.tree)) {
          const nestedLegacy = proj.emitLegacyScripts !== undefined ? proj.emitLegacyScripts !== false : emitLegacyScripts
          const extraIgnores = [
            ...nestedIgnores,
            ...(Array.isArray(proj.globIgnorePaths) ? proj.globIgnorePaths : [])
              .filter((g): g is string => typeof g === 'string' && !!g.trim())
              .map(rojoGlob)
              .filter((r): r is RegExp => !!r)
          ]
          const projBaseAbs = extraIgnores.length ? absDir : nestedRootAbs
          const resolveNestedNode = async (nodeObj: Record<string, unknown>, nodeInstPrefix: string[]) => {
            let rawPath = nodeObj.$path
            if (rawPath && typeof rawPath === 'object' && !Array.isArray(rawPath)) {
              rawPath = (rawPath as Record<string, unknown>).optional
            }
            if (typeof rawPath === 'string' && rawPath.trim()) {
              const targetAbs = resolve(absDir, rawPath)
              const realTarget = await isInsideRoot(targetAbs)
              if (realTarget) {
                const st = await fsp.stat(targetAbs).catch(() => null)
                if (st?.isDirectory()) {
                  if (realTarget === realDir) {
                    await walkEntries(absDir, realDir, nodeInstPrefix, isPackageTree, nestedLegacy, false, extraIgnores, projBaseAbs)
                  } else {
                    await walk(targetAbs, nodeInstPrefix, isPackageTree, nestedLegacy, false, extraIgnores, projBaseAbs)
                  }
                } else if (st?.isFile()) {
                  await addFile(targetAbs, basename(targetAbs), nodeInstPrefix, isPackageTree, nestedLegacy, null)
                }
              }
            }
            for (const [k, child] of Object.entries(nodeObj)) {
              if (k.startsWith('$') || !child || typeof child !== 'object' || Array.isArray(child)) continue
              await resolveNestedNode(child as Record<string, unknown>, [...nodeInstPrefix, k])
            }
          }
          await resolveNestedNode(proj.tree as Record<string, unknown>, instPrefix)
          return
        }
      }

      const isNestedIgnored = (absPath: string): boolean => {
        if (!nestedIgnores.length || !nestedRootAbs) return false
        const relToNested = relative(nestedRootAbs, absPath).replace(/\\/g, '/')
        return !!relToNested && !relToNested.startsWith('..') && nestedIgnores.some((re) => re.test(relToNested))
      }

      for (const e of entries) {
        if (IGNORE_DIRS.has(e.name) || e.name.endsWith('.forge-tmp') || e.name === '.DS_Store') continue
        const childAbs = join(absDir, e.name)
        const childRel = relative(this.root, childAbs).replace(/\\/g, '/')
        if (e.isSymbolicLink()) continue
        if (isNestedIgnored(childAbs)) continue
        if (rojoIgnored({ roots: map.roots, ignoreGlobs: (map as Partial<PlaceMap>).ignoreGlobs ?? [] }, childRel)) continue
        if (!isPackageTree && (PACKAGE_DIRS.has(e.name) || isSkipped(map.skipGlobs, childRel))) continue

        if (e.isDirectory()) {
          await walk(childAbs, [...instPrefix, e.name], isPackageTree, emitLegacyScripts, true, nestedIgnores, nestedRootAbs)
          continue
        }
        if (!e.isFile()) continue
        if (e.name === '.gitkeep') {
          const dirRel = relative(this.root, absDir).replace(/\\/g, '/')
          const instPath = isPackageTree ? instPrefix : instancePathForPush(map, dirRel)
          if (instPath && instPath.length >= 2) folders.set(dirRel, instPath)
          continue
        }
        if (e.name.endsWith('.meta.json')) continue
        if (isPackageTree && (PACKAGE_META_SKIP.has(e.name) || e.name.endsWith('.project.json'))) continue

        const info = parseFileName(e.name, emitLegacyScripts)
        const instPath = isPackageTree
          ? info
            ? info.stem === null
              ? [...instPrefix]
              : [...instPrefix, info.stem]
            : null
          : instancePathForPush(map, childRel, info)
        if (!instPath || instPath.length < 2) continue

        await addFile(childAbs, e.name, instPath, isPackageTree, emitLegacyScripts, entryNames)
      }
    }

    const walk = async (
      absDir: string,
      instPrefix: string[],
      isPackageTree: boolean,
      emitLegacyScripts: boolean,
      allowNested = true,
      nestedIgnores: RegExp[] = [],
      nestedRootAbs?: string
    ): Promise<void> => {
      const real = await isInsideRoot(absDir)
      if (!real || seenReal.has(real)) return
      seenReal.add(real)
      await walkEntries(absDir, real, instPrefix, isPackageTree, emitLegacyScripts, allowNested, nestedIgnores, nestedRootAbs)
    }

    for (const r of [...map.roots, ...map.skipped.filter(isPackageSkip)]) {
      const targetAbs = resolve(this.root, r.path)
      const stat = await fsp.stat(targetAbs).catch(() => null)
      if (!stat) continue
      const isPkg = PACKAGES_PATH_RE.test(r.path.replace(/\\/g, '/')) || PACKAGE_DIRS.has(r.instance[r.instance.length - 1] ?? '')
      if (stat.isDirectory()) {
        await walk(targetAbs, r.instance, isPkg, map.emitLegacyScripts, true)
      } else if (stat.isFile()) {
        await addFile(targetAbs, basename(targetAbs), r.instance, isPkg, map.emitLegacyScripts, null)
      }
    }

    return { opsByFile, folders, hashes, paths }
  }

  private resetWatchers(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.closed) return

    const dirs = new Set<string>()
    for (const m of this.maps) {
      for (const r of m.roots) dirs.add(resolve(this.root, r.path))
      for (const s of m.skipped) if (isPackageSkip(s)) dirs.add(resolve(this.root, s.path))
    }

    for (const dir of dirs) {
      try {
        const w = watch(dir, { recursive: process.platform === 'win32' || process.platform === 'darwin', persistent: false }, (_ev, filename) => {
          const name = typeof filename === 'string' ? filename.replace(/\\/g, '/') : ''
          if (name.endsWith('.forge-tmp') || name.startsWith('.git/') || name.startsWith('.forge/')) return
          this.scheduleScan()
        })
        ;(w as { unref?: () => void }).unref?.()
        w.on('error', () => {
          // Directory might be deleted/recreated
        })
        this.watchers.push(w)
      } catch {
        // Ignore missing root dir until created
      }
    }
  }

  private scheduleScan(): void {
    if (this.closed) return
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      void this.scanActivePlaces()
    }, this.debounceMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  async scanActivePlaces(): Promise<void> {
    if (this.closed) return
    if (this.pendingScan) {
      this.rescanNeeded = true
      return
    }
    this.pendingScan = true
    try {
      for (const [projectFile, placeKey] of this.activePlaceKeys) {
        const map = this.maps.find((m) => m.projectFile === projectFile)
        if (!map) continue
        await this.syncPlace(placeKey, map).catch((e) => this.opts.onError?.(e as Error))
      }
    } finally {
      this.pendingScan = false
      if (this.rescanNeeded && !this.closed) {
        this.rescanNeeded = false
        this.scheduleScan()
      }
    }
  }

  close(): void {
    this.closed = true
    this.rescanNeeded = false
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.queues.clear()
    this.knownStudioHashes.clear()
    this.knownInstancePaths.clear()
    this.activePlaceKeys.clear()
  }
}
