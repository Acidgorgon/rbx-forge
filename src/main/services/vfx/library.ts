// The VFX library on disk. Two stores with the same layout:
//
//   user     <userData>/vfx/library/<id>/        follows the person across projects (and is part of
//                                                .forgepack export / device sync: one folder per entry)
//   project  <root>/.forge/vfx/library/<id>/     committed with the game, shared with the team
//
//   <id>/entry.json      the VfxEntry (normalised parameters, tags, description, iterations)
//   <id>/thumbs/*.png    preview thumbnails
//   <id>/frames/*.png    rendered frames of refine iterations
//   <id>/media/*         reference images / gifs / videos, and the original .rbxm(x)
//   .trash/<batch>/<id>  deleted entries until the next start (Undo restores them)
//
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { basename, join, resolve, sep } from 'node:path'
import type { VfxEntry, VfxScope } from '../../../shared/vfx/types.ts'
import { renameRetry } from '../fs/renameRetry.ts'

export const PROJECT_VFX_DIR = '.forge/vfx'
export const ENTRY_FILE = 'entry.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export class VfxLibraryError extends Error {}

export function entryId(name: string): string {
  const slug =
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'effect'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

export class VfxStore {
  readonly scope: VfxScope
  readonly dir: string
  private cache: { at: number; entries: VfxEntry[] } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scope: VfxScope, dir: string) {
    this.scope = scope
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  entryDir(id: string): string {
    if (!ID_RE.test(id)) throw new VfxLibraryError(`bad entry id "${id}"`)
    return join(this.dir, id)
  }

  // A file inside an entry folder (no escaping it).
  filePath(id: string, file: string): string {
    const base = this.entryDir(id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new VfxLibraryError('path escapes the entry folder')
    return p
  }

  async list(): Promise<VfxEntry[]> {
    if (this.cache && Date.now() - this.cache.at < 1500) return this.cache.entries
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      names = []
    }
    const out: VfxEntry[] = []
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.conflict') || !ID_RE.test(n)) continue
      const e = await this.read(n)
      if (e) out.push(e)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), entries: out }
    return out
  }

  async read(id: string): Promise<VfxEntry | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.entryDir(id), ENTRY_FILE), 'utf8')) as VfxEntry
      if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null
      return { ...raw, id, scope: this.scope, tags: Array.isArray(raw.tags) ? raw.tags : [], thumbs: Array.isArray(raw.thumbs) ? raw.thumbs : [] }
    } catch {
      return null
    }
  }

  save(entry: VfxEntry): Promise<VfxEntry> {
    return this.serial(async () => {
      const dir = this.entryDir(entry.id)
      await mkdir(dir, { recursive: true })
      const e = { ...entry, scope: this.scope }
      const tmp = join(dir, `${ENTRY_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(e, null, 1), 'utf8')
      await renameRetry(tmp, join(dir, ENTRY_FILE))
      this.cache = null
      return e
    })
  }

  async writeFile(id: string, file: string, data: Buffer | string): Promise<string> {
    const p = this.filePath(id, file)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, data)
    return p
  }

  async readFile(id: string, file: string): Promise<Buffer> {
    return readFile(this.filePath(id, file))
  }

  async exists(id: string, file: string): Promise<boolean> {
    return stat(this.filePath(id, file)).then(
      (s) => s.isFile(),
      () => false
    )
  }

  // Moves entries to the trash (one batch per delete action); returns the ids moved.
  trash(ids: string[], batch: string): Promise<string[]> {
    if (!BATCH_RE.test(batch)) throw new VfxLibraryError('bad trash batch')
    return this.serial(async () => {
      const moved: string[] = []
      const to = join(this.dir, TRASH_DIR, batch)
      for (const id of ids) {
        let dir: string
        try {
          dir = this.entryDir(id)
        } catch {
          continue
        }
        const ok = await stat(dir).then(
          (st) => st.isDirectory(),
          () => false
        )
        if (!ok) continue
        await mkdir(to, { recursive: true })
        await renameRetry(dir, join(to, id))
        moved.push(id)
      }
      this.cache = null
      return moved
    })
  }

  // Moves a trash batch back (entries whose id was taken again meanwhile stay in the trash).
  restore(batch: string): Promise<string[]> {
    if (!BATCH_RE.test(batch)) throw new VfxLibraryError('bad trash batch')
    return this.serial(async () => {
      const from = join(this.dir, TRASH_DIR, batch)
      const names = await readdir(from).catch(() => [] as string[])
      const back: string[] = []
      for (const id of names) {
        if (!ID_RE.test(id)) continue
        const dest = join(this.dir, id)
        const taken = await stat(dest).then(
          () => true,
          () => false
        )
        if (taken) continue
        await renameRetry(join(from, id), dest)
        back.push(id)
      }
      await rm(from, { recursive: true, force: true }).catch(() => undefined)
      this.cache = null
      return back
    })
  }

  // Empties the trash (at start: deletes are final once Forge restarts).
  purgeTrash(): Promise<void> {
    return this.serial(async () => {
      await rm(join(this.dir, TRASH_DIR), { recursive: true, force: true }).catch(() => undefined)
    })
  }

  remove(id: string): Promise<boolean> {
    return this.serial(async () => {
      const dir = this.entryDir(id)
      const ok = await stat(dir).then(
        () => true,
        () => false
      )
      if (ok) await rm(dir, { recursive: true, force: true })
      this.cache = null
      return ok
    })
  }
}

// Deleted entries wait in <library>/.trash/<batch>/<id> until the next start (Undo moves them back).
export const TRASH_DIR = '.trash'
const BATCH_RE = /^[a-z0-9-]{1,64}$/

export function safeFileName(name: string): string {
  return basename(name).replace(/[^\w.-]+/g, '_').slice(-80) || 'file'
}
