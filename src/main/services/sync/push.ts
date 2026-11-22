// Direct 2-way Forge Sync: disk -> Studio push engine.
// Watches mapped $path roots (including Packages/), deduplicates via sha256 content hashes,
// suppresses Studio->disk echoes, respects 3-way conflict & gate locks, and emits chunked SyncPushBatch
// payloads pulled by ForgeBridge.luau v15.

import { createHash, randomUUID } from 'node:crypto'
import { watch, type FSWatcher } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { basename, join, relative, resolve } from 'node:path'
import type { SyncPushAck, SyncPushBatch, SyncPushOp } from '../../../shared/sync/protocol.ts'
import type { PlacePushStats, StudioNode, SyncEntry, SyncValue } from '../../../shared/sync/types.ts'
import { fromDisk, parseFileName, rojoIgnored, toDisk, type PlaceMap } from './mapping.ts'
import { normalise } from './merge.ts'

export type PushMapLike = {
  projectFile: string
  placeIds: number[]
  roots: { instance: string[]; path: string; isFile?: boolean; ignoreUnknown?: boolean }[]
  skipped?: { instance: string[]; path?: string }[]
} & Partial<Omit<PlaceMap, 'roots' | 'skipped'>>

const MAX_BATCH_BYTES = 1024 * 1024
const IGNORE_DIRS = new Set(['.git', '.forge', 'node_modules'])

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
}

interface QueuedPlace {
  placeKey: string
  projectFile: string
  ops: SyncPushOp[]
  inflight?: SyncPushBatch
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
  isFileConflicted: (placeKey: string, file: string) => boolean
  onEntries?: (placeKey: string, entries: SyncEntry[]) => void
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
  private readonly queues = new Map<string, QueuedPlace>() // placeKey -> queue
  private readonly activePlaceKeys = new Map<string, string>() // projectFile -> placeKey
  private readonly echoSuppression = new Map<string, { hash: string; at: number }>() // relFile -> { hash, at }
  private watchers: FSWatcher[] = []
  private timer: ReturnType<typeof setTimeout> | null = null
  private pendingScan = false
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
    let hashes = this.knownStudioHashes.get(placeKey)
    if (!hashes) {
      hashes = new Map()
      this.knownStudioHashes.set(placeKey, hashes)
    }
    hashes.clear()
    for (const node of nodes) {
      const mapped = toDisk(map, { path: node.path, className: node.className, runContext: node.runContext })
      if (!mapped || mapped.kind === 'folder') continue
      if (node.className === 'ModuleScript' || node.className === 'Script' || node.className === 'LocalScript') {
        if (typeof node.source === 'string') {
          const runContext = node.runContext
          const keyStr = runContext ? `${normalise(node.source)}\u0000${runContext}` : normalise(node.source)
          hashes.set(mapped.file, sha256Text(keyStr))
        }
      } else {
        hashes.set(mapped.file, stableModelDigest(node.className, node.properties, node.attributes, node.tags))
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

  unbindPlace(placeKey: string): void {
    for (const [pf, pk] of this.activePlaceKeys) {
      if (pk === placeKey) this.activePlaceKeys.delete(pf)
    }
    this.queues.delete(placeKey)
    this.knownStudioHashes.delete(placeKey)
  }

  hasPending(placeKey: string): boolean {
    if (!this.opts.canPushPlace(placeKey)) return false
    const q = this.queues.get(placeKey)
    if (!q) return false
    if (q.inflight) return true
    return q.ops.some((op) => !('file' in op) || !op.file || !this.opts.isFileConflicted(placeKey, op.file))
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

  async syncPlace(placeKey: string, rawMap: PushMapLike): Promise<SyncPushOp[]> {
    if (this.closed) return []
    const map = this.normalizeMap(rawMap)
    this.activePlaceKeys.set(map.projectFile, placeKey)
    const snap = await this.scanMap(map)
    const prevHashes = this.knownStudioHashes.get(placeKey) ?? new Map<string, string>()
    this.knownStudioHashes.set(placeKey, prevHashes)

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
        continue
      }
      if (knownHash === newHash) continue

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

    // Detect deletions (previously known on Studio, now gone from disk under this map)
    for (const [rel] of prevHashes) {
      if (snap.hashes.has(rel)) continue
      if (this.opts.isFileConflicted(placeKey, rel)) continue
      const instPath = instancePathForPush(map, rel)
      if (!instPath || instPath.length < 2) continue
      ops.push({ kind: 'delete', path: instPath, file: rel })
    }

    const folderOps: SyncPushOp[] = [...neededFolders]
      .map((k) => k.split('\u0000'))
      .sort((a, b) => a.length - b.length || a.join('.').localeCompare(b.join('.')))
      .map((path) => ({ kind: 'upsert-folder' as const, path }))

    const upsertOps = ops
      .filter((o) => o.kind !== 'delete')
      .sort((a, b) => a.path.length - b.path.length || a.path.join('.').localeCompare(b.path.join('.')))
    const deleteOps = ops
      .filter((o) => o.kind === 'delete')
      .sort((a, b) => b.path.length - a.path.length || b.path.join('.').localeCompare(a.path.join('.')))

    // Only emit upsert-folder ops if there are actual file upserts/empty folders and no previous batch redundant noise
    const combined = upsertOps.length > 0 ? [...folderOps, ...upsertOps, ...deleteOps] : [...deleteOps]

    const q = this.ensureQueue(placeKey, map.projectFile)
    q.ops = combined
    if (combined.length > 0) this.opts.onChange?.()
    return combined
  }

  pullNextBatch(placeKey: string): SyncPushBatch | undefined {
    if (!this.opts.canPushPlace(placeKey)) return undefined
    const q = this.queues.get(placeKey)
    if (!q) return undefined
    if (q.inflight) return q.inflight

    // Filter out any ops that became conflicted in the meantime
    q.ops = q.ops.filter((op) => !('file' in op) || !op.file || !this.opts.isFileConflicted(placeKey, op.file))
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
    return batch
  }

  ackBatch(placeKey: string, ack: SyncPushAck): SyncEntry[] {
    const q = this.queues.get(placeKey)
    if (!q || !q.inflight || q.inflight.batchId !== ack.batchId) {
      return []
    }
    const batch = q.inflight
    q.inflight = undefined

    const hashes = this.knownStudioHashes.get(placeKey) ?? new Map<string, string>()
    this.knownStudioHashes.set(placeKey, hashes)

    const appliedSet = new Set(ack.applied)
    const entries: SyncEntry[] = []
    const ts = this.now()

    for (const op of batch.ops) {
      if (!('file' in op) || !op.file) continue
      if (!appliedSet.has(op.file)) continue
      if (op.kind === 'delete') {
        hashes.delete(op.file)
      } else if (op.kind === 'upsert-script' || op.kind === 'upsert-instance') {
        hashes.set(op.file, op.sha256)
      }
      entries.push({
        file: op.file,
        action: 'pushed',
        instancePath: op.path,
        at: ts
      })
      q.pushed++
    }

    q.lastPushAt = ts
    if (ack.errors?.length) {
      q.lastError = ack.errors.map((e) => `${e.path.join('.')}: ${e.message}`).join('; ').slice(0, 300)
    } else {
      q.lastError = undefined
    }

    if (entries.length) this.opts.onEntries?.(placeKey, entries)
    this.opts.onChange?.()
    return entries
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
    const seenReal = new Set<string>()

    const walk = async (absDir: string) => {
      const real = await fsp.realpath(absDir).catch(() => null)
      if (!real || seenReal.has(real)) return
      if (!real.startsWith(this.root)) return
      seenReal.add(real)

      let entries
      try {
        entries = await fsp.readdir(absDir, { withFileTypes: true })
      } catch {
        return
      }

      for (const e of entries) {
        if (IGNORE_DIRS.has(e.name) || e.name.endsWith('.forge-tmp')) continue
        const childAbs = join(absDir, e.name)
        const childRel = relative(this.root, childAbs).replace(/\\/g, '/')
        if (e.isSymbolicLink()) continue

        if (e.isDirectory()) {
          await walk(childAbs)
          continue
        }
        if (!e.isFile()) continue
        if (e.name === '.gitkeep') {
          const dirRel = relative(this.root, absDir).replace(/\\/g, '/')
          const instPath = instancePathForPush(map, dirRel)
          if (instPath && instPath.length >= 2) folders.set(dirRel, instPath)
          continue
        }
        if (rojoIgnored({ roots: map.roots, ignoreGlobs: (map as Partial<PlaceMap>).ignoreGlobs ?? [] }, childRel)) continue

        if (e.name.endsWith('.meta.json')) continue

        const info = parseFileName(e.name, map.emitLegacyScripts)
        const instPath = instancePathForPush(map, childRel, info)
        if (!instPath || instPath.length < 2) continue

        if (info?.kind === 'script') {
          const sourceRaw = await fsp.readFile(childAbs, 'utf8').catch(() => null)
          if (sourceRaw === null) continue
          const source = sourceRaw.replace(/\r\n/g, '\n')
          const metaName = info.stem === null ? 'init.meta.json' : `${info.stem}.meta.json`
          const meta = await readJsonObj(join(absDir, metaName))
          const runContext = parseMetaRunContext(meta)
          const digestInput = runContext && runContext !== 'Legacy' ? `${normalise(source)}\u0000${runContext}` : normalise(source)
          const sha256 = sha256Text(digestInput)
          hashes.set(childRel, sha256)
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
          const model = await readJsonObj(childAbs)
          if (!model) continue
          const className = typeof (model.ClassName ?? model.className) === 'string' ? String(model.ClassName ?? model.className) : 'Folder'
          const properties = (model.Properties ?? model.properties) as Record<string, SyncValue> | undefined
          const attributes = (model.Attributes ?? model.attributes) as Record<string, SyncValue> | undefined
          const tags = Array.isArray(model.Tags ?? model.tags) ? ((model.Tags ?? model.tags) as unknown[]).filter((t): t is string => typeof t === 'string') : undefined
          const sha256 = stableModelDigest(className, properties, attributes, tags)
          hashes.set(childRel, sha256)
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
        } else if (e.name.endsWith('.json') && !e.name.endsWith('.project.json')) {
          const rawJson = await fsp.readFile(childAbs, 'utf8').catch(() => null)
          if (rawJson === null) continue
          const source = `return game:GetService("HttpService"):JSONDecode(${JSON.stringify(normalise(rawJson))})\n`
          const sha256 = sha256Text(source)
          hashes.set(childRel, sha256)
          opsByFile.set(childRel, {
            kind: 'upsert-script',
            path: instPath,
            className: 'ModuleScript',
            source,
            sha256,
            file: childRel
          })
        } else if (e.name.endsWith('.txt')) {
          const rawTxt = await fsp.readFile(childAbs, 'utf8').catch(() => null)
          if (rawTxt === null) continue
          const properties: Record<string, SyncValue> = { Value: normalise(rawTxt) }
          const sha256 = stableModelDigest('StringValue', properties)
          hashes.set(childRel, sha256)
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
    }

    for (const r of [...map.roots, ...map.skipped]) {
      const targetAbs = resolve(this.root, r.path)
      const stat = await fsp.stat(targetAbs).catch(() => null)
      if (!stat) continue
      if (stat.isDirectory()) {
        await walk(targetAbs)
      } else if (stat.isFile()) {
        const rel = relative(this.root, targetAbs).replace(/\\/g, '/')
        const info = parseFileName(basename(targetAbs), map.emitLegacyScripts)
        if (info?.kind === 'script') {
          const sourceRaw = await fsp.readFile(targetAbs, 'utf8').catch(() => '')
          const source = sourceRaw.replace(/\r\n/g, '\n')
          const sha256 = sha256Text(normalise(source))
          hashes.set(rel, sha256)
          opsByFile.set(rel, {
            kind: 'upsert-script',
            path: r.instance,
            className: scriptClassOf(info.className),
            source,
            sha256,
            file: rel
          })
        }
      }
    }

    return { opsByFile, folders, hashes }
  }

  private resetWatchers(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.closed) return

    const dirs = new Set<string>()
    for (const m of this.maps) {
      for (const r of m.roots) dirs.add(resolve(this.root, r.path))
      for (const s of m.skipped) dirs.add(resolve(this.root, s.path))
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
    if (this.pendingScan) return
    this.pendingScan = true
    try {
      for (const [projectFile, placeKey] of this.activePlaceKeys) {
        const map = this.maps.find((m) => m.projectFile === projectFile)
        if (!map) continue
        await this.syncPlace(placeKey, map).catch((e) => this.opts.onError?.(e as Error))
      }
    } finally {
      this.pendingScan = false
    }
  }

  close(): void {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    for (const w of this.watchers) w.close()
    this.watchers = []
    this.queues.clear()
    this.knownStudioHashes.clear()
    this.activePlaceKeys.clear()
  }
}
