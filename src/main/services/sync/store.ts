// Forge Sync base store: per (placeKey, file), the content that place's Studio and the disk last
// agreed on. Lives in <project>/.forge/sync/ (index.json + content-addressed blobs), gitignored.
// Hashes are sha1 of the normalised text, the same digest the legacy tools/studio-sync.py kept in
// .studio-sync/state.json, so legacy state migrates without content where the file has moved on.

import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalise } from './merge.ts'

export type SyncFs = Pick<typeof nodeFs, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'readdir' | 'stat' | 'lstat' | 'rm' | 'rmdir' | 'realpath'>

export const SYNC_DIR = '.forge/sync'
export const INDEX_FILE = '.forge/sync/index.json'
export const BLOB_DIR = '.forge/sync/blobs'
export const TRASH_DIR = '.forge/sync/trash'
export const LEGACY_STATE = '.studio-sync/state.json'

export function hashText(text: string): string {
  return createHash('sha1').update(normalise(text), 'utf8').digest('hex')
}

// Write to a temp file in the same directory, then rename over the target (atomic on one volume).
// The temp name ends in .forge-tmp so Rojo's watcher ignores it (no sync rule matches).
export async function atomicWrite(fs: SyncFs, file: string, data: string): Promise<void> {
  await fs.mkdir(dirname(file), { recursive: true })
  const base = file.split(/[\\/]/).pop()
  const temp = join(dirname(file), `.${base}.${process.pid}-${randomBytes(4).toString('hex')}.forge-tmp`)
  try {
    await fs.writeFile(temp, data, 'utf8')
    await fs.rename(temp, file)
  } catch (err) {
    await fs.rm(temp, { force: true }).catch(() => undefined)
    throw err
  }
}

export interface BaseEntry {
  hash: string
  // null when only the digest is known (migrated from the legacy state).
  text: string | null
}

interface IndexFile {
  version: 1
  places: Record<string, Record<string, string>>
  legacyMigrated?: boolean
}

export class BaseStore {
  readonly root: string
  private readonly fs: SyncFs
  private index: IndexFile = { version: 1, places: {} }
  private loaded = false
  private dirty = false
  private readonly blobCache = new Map<string, string | null>()

  constructor(root: string, fs: SyncFs = nodeFs) {
    this.root = root
    this.fs = fs
  }

  async load(): Promise<void> {
    try {
      const parsed = JSON.parse(await this.fs.readFile(join(this.root, INDEX_FILE), 'utf8')) as IndexFile
      this.index = parsed && parsed.version === 1 && parsed.places ? parsed : { version: 1, places: {} }
    } catch {
      this.index = { version: 1, places: {} }
    }
    this.loaded = true
    this.dirty = false
  }

  private async ready(): Promise<void> {
    if (!this.loaded) await this.load()
  }

  get legacyMigrated(): boolean {
    return this.index.legacyMigrated === true
  }

  private blobPath(hash: string): string {
    return join(this.root, BLOB_DIR, hash.slice(0, 2), `${hash}.txt`)
  }

  async get(placeKey: string, file: string): Promise<BaseEntry | null> {
    await this.ready()
    const hash = this.index.places[placeKey]?.[file]
    if (!hash) return null
    if (!this.blobCache.has(hash)) {
      const text = await this.fs.readFile(this.blobPath(hash), 'utf8').catch(() => null)
      this.blobCache.set(hash, text)
    }
    return { hash, text: this.blobCache.get(hash) ?? null }
  }

  async set(placeKey: string, file: string, text: string): Promise<void> {
    await this.ready()
    const body = normalise(text)
    const hash = hashText(body)
    if (this.blobCache.get(hash) == null) {
      const path = this.blobPath(hash)
      const exists = await this.fs.stat(path).then(() => true, () => false)
      if (!exists) await atomicWrite(this.fs, path, body)
      this.blobCache.set(hash, body)
    }
    this.setHash(placeKey, file, hash)
  }

  // Digest-only base (legacy migration).
  setHash(placeKey: string, file: string, hash: string): void {
    const place = (this.index.places[placeKey] ??= {})
    if (place[file] !== hash) {
      place[file] = hash
      this.dirty = true
    }
  }

  async has(placeKey: string, file: string): Promise<boolean> {
    await this.ready()
    return Boolean(this.index.places[placeKey]?.[file])
  }

  async delete(placeKey: string, file: string): Promise<void> {
    await this.ready()
    const place = this.index.places[placeKey]
    if (place && file in place) {
      delete place[file]
      this.dirty = true
    }
  }

  // Moves bases for `from` (a file, or a directory and everything below it) to `to`.
  async rename(placeKey: string, from: string, to: string): Promise<void> {
    await this.ready()
    const place = this.index.places[placeKey]
    if (!place) return
    for (const key of Object.keys(place)) {
      let next: string | null = null
      if (key === from) next = to
      else if (key.startsWith(from + '/')) next = to + key.slice(from.length)
      if (next !== null) {
        place[next] = place[key]
        delete place[key]
        this.dirty = true
      }
    }
  }

  async files(placeKey: string): Promise<string[]> {
    await this.ready()
    return Object.keys(this.index.places[placeKey] ?? {})
  }

  async placeKeys(): Promise<string[]> {
    await this.ready()
    return Object.keys(this.index.places)
  }

  markLegacyMigrated(): void {
    this.index.legacyMigrated = true
    this.dirty = true
  }

  async save(): Promise<void> {
    if (!this.dirty) return
    const first = !(await this.fs.stat(join(this.root, INDEX_FILE)).then(() => true, () => false))
    await atomicWrite(this.fs, join(this.root, INDEX_FILE), JSON.stringify(this.index, null, 1) + '\n')
    this.dirty = false
    if (first) await ensureSyncIgnored(this.root, this.fs)
  }

  // Deletes blobs no base points at.
  async gc(): Promise<number> {
    await this.ready()
    const used = new Set(Object.values(this.index.places).flatMap((p) => Object.values(p)))
    let removed = 0
    const top = join(this.root, BLOB_DIR)
    for (const shard of await this.fs.readdir(top).catch(() => [] as string[])) {
      for (const name of await this.fs.readdir(join(top, shard)).catch(() => [] as string[])) {
        const hash = name.replace(/\.txt$/, '')
        if (!used.has(hash)) {
          await this.fs.rm(join(top, shard, name), { force: true })
          this.blobCache.delete(hash)
          removed++
        }
      }
    }
    return removed
  }
}

// Adds `.forge/sync/` to the project's .gitignore when no line covers it yet. Returns true if added.
export async function ensureSyncIgnored(root: string, fs: SyncFs = nodeFs): Promise<boolean> {
  const file = join(root, '.gitignore')
  const text = await fs.readFile(file, 'utf8').catch(() => '')
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const covered = ['.forge/sync/', '.forge/sync', '/.forge/sync/', '/.forge/sync', '.forge/sync/*', '/.forge/sync/*']
  if (lines.some((l) => covered.includes(l))) return false
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  const prefix = text && !text.endsWith('\n') ? eol : ''
  await atomicWrite(fs, file, `${text}${prefix}# Forge Sync local state (per-machine)${eol}.forge/sync/${eol}`)
  return true
}

// Imports .studio-sync/state.json (keys "file" or "placeId|file" -> sha1 of normalised text).
// Where the file on disk still matches the digest its content becomes the base (so merges work);
// otherwise only the digest is kept. Bare keys apply to `defaultPlaceKeys` (legacy placeless posts
// came from the default project). Existing Forge bases win. Returns the number of bases imported.
export async function migrateLegacy(root: string, store: BaseStore, defaultPlaceKeys: string[] = [], fs: SyncFs = nodeFs): Promise<number> {
  if (store.legacyMigrated) return 0
  let state: Record<string, unknown>
  try {
    state = JSON.parse(await fs.readFile(join(root, LEGACY_STATE), 'utf8'))
  } catch {
    store.markLegacyMigrated()
    await store.save()
    return 0
  }
  let count = 0
  const entries = Object.entries(state ?? {}).filter((e): e is [string, string] => typeof e[1] === 'string' && /^[0-9a-f]{40}$/.test(e[1]))
  // Place-specific keys first so they win over bare ones.
  entries.sort((a, b) => Number(b[0].includes('|')) - Number(a[0].includes('|')))
  for (const [key, hash] of entries) {
    const bar = key.indexOf('|')
    const file = (bar >= 0 ? key.slice(bar + 1) : key).replace(/\\/g, '/')
    if (!file || file.split('/').some((s) => s === '..' || s === '')) continue
    const placeKeys = bar >= 0 ? [key.slice(0, bar)] : defaultPlaceKeys
    const disk = await fs.readFile(join(root, file), 'utf8').catch(() => null)
    for (const placeKey of placeKeys) {
      if (await store.has(placeKey, file)) continue
      if (disk !== null && hashText(disk) === hash) await store.set(placeKey, file, disk)
      else store.setHash(placeKey, file, hash)
      count++
    }
  }
  store.markLegacyMigrated()
  await store.save()
  return count
}
