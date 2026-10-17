// Forge Sync base store: per (placeKey, file), the content that place's Studio and the disk last
// agreed on. Lives in <project>/.forge/sync/ (index.json + content-addressed blobs), gitignored.
// Hashes are sha1 of the normalised text, the same digest the legacy tools/studio-sync.py kept in
// .studio-sync/state.json, so legacy state migrates without content where the file has moved on.

import { createHash, randomBytes } from 'node:crypto'
import * as nodeFs from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalise } from './merge.ts'

export type SyncFs = Pick<typeof nodeFs, 'readFile' | 'writeFile' | 'rename' | 'mkdir' | 'readdir' | 'stat' | 'lstat' | 'rm' | 'rmdir' | 'realpath'>

export const INDEX_FILE = '.forge/sync/index.json'
export const BLOB_DIR = '.forge/sync/blobs'
export const TRASH_DIR = '.forge/sync/trash'
export const LEGACY_STATE = '.studio-sync/state.json'
// Superseded base digests kept per file (BaseStore.superseded).
const HISTORY_KEEP = 16

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
  // Places whose first sync is still undecided: nothing is written or trashed for them until the user
  // picks a side (Studio wins / Disk wins / per file).
  firstSync?: string[]
}

export class BaseStore {
  readonly root: string
  private readonly fs: SyncFs
  private index: IndexFile = { version: 1, places: {} }
  private loaded = false
  private dirty = false
  private readonly blobCache = new Map<string, string | null>()
  // Per (place, file): digests the base moved on from (newest last), in memory. A Studio copy equal to
  // one of them is a copy that Studio already had and then confirmed a newer one over (a stale
  // DataModel, a script editor tab written back after a playtest): never a Studio edit to pull.
  private readonly history = new Map<string, string[]>()

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

  // caughtUp: Studio just confirmed a copy the disk had first (Rojo delivered a disk edit): the base it
  // moves on from is remembered as superseded. Not for a copy pulled from Studio (an undo in Studio
  // that goes back to it is a real edit).
  async set(placeKey: string, file: string, text: string, caughtUp = false): Promise<void> {
    await this.ready()
    const body = normalise(text)
    const hash = hashText(body)
    if (this.blobCache.get(hash) == null) {
      const path = this.blobPath(hash)
      const exists = await this.fs.stat(path).then(() => true, () => false)
      if (!exists) await atomicWrite(this.fs, path, body)
      this.blobCache.set(hash, body)
    }
    const old = this.index.places[placeKey]?.[file]
    if (old && old !== hash) this.supersede(placeKey, file, old, hash, caughtUp)
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

  // The base of a file moves from `old` to `next`: `next` is current again (never superseded), `old`
  // is superseded when Studio caught up with the disk.
  private supersede(placeKey: string, file: string, old: string, next: string, caughtUp: boolean): void {
    const key = `${placeKey}\u0000${file}`
    const list = (this.history.get(key) ?? []).filter((h) => h !== old && h !== next)
    if (caughtUp) list.push(old)
    if (list.length) this.history.set(key, list.slice(-HISTORY_KEEP))
    else this.history.delete(key)
  }

  // True when `hash` is a copy this place's base already moved on from (see history).
  superseded(placeKey: string, file: string, hash: string): boolean {
    return this.history.get(`${placeKey}\u0000${file}`)?.includes(hash) ?? false
  }

  // The base's digest only (no blob read), or null.
  async hashOf(placeKey: string, file: string): Promise<string | null> {
    await this.ready()
    return this.index.places[placeKey]?.[file] ?? null
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
        const h = this.history.get(`${placeKey}\u0000${key}`)
        if (h) {
          this.history.set(`${placeKey}\u0000${next}`, h)
          this.history.delete(`${placeKey}\u0000${key}`)
        }
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

  // Any base at all for the place (a place with none has never been reconciled here).
  async hasPlace(placeKey: string): Promise<boolean> {
    await this.ready()
    return Object.keys(this.index.places[placeKey] ?? {}).length > 0
  }

  isFirstSync(placeKey: string): boolean {
    return (this.index.firstSync ?? []).includes(placeKey)
  }

  setFirstSync(placeKey: string, on: boolean): void {
    const list = this.index.firstSync ?? []
    if (on === list.includes(placeKey)) return
    this.index.firstSync = on ? [...list, placeKey] : list.filter((k) => k !== placeKey)
    this.dirty = true
  }

  // Forgets every base of a place (sync state of a place that is not linked to the project).
  async dropPlace(placeKey: string): Promise<void> {
    await this.ready()
    if (placeKey in this.index.places) {
      delete this.index.places[placeKey]
      this.dirty = true
    }
    this.setFirstSync(placeKey, false)
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
// The trash ignores itself (a '*' .gitignore inside it), so copies Forge keeps there are never
// committed, whatever the project's .gitignore says (or a rewind puts back).
export async function ensureTrashIgnored(root: string, fs: SyncFs = nodeFs): Promise<void> {
  const file = join(root, ...TRASH_DIR.split('/'), '.gitignore')
  if (await fs.stat(file).then(() => true, () => false)) return
  await fs.mkdir(dirname(file), { recursive: true })
  await fs.writeFile(file, '*\n', 'utf8')
}

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
