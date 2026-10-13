// The Animation Lab library on disk. Two stores with the same layout as the VFX library:
//
//   user     <userData>/anim/library/<id>/       follows the person across projects (part of the
//                                                .forgepack export / device sync)
//   project  <root>/.forge/anim/library/<id>/    committed with the game, shared with the team
//
//   <id>/entry.json      the AnimEntry (clip keys, tags, rating, notes, stats, iterations)
//   <id>/thumbs/*.png    preview thumbnails
//   <id>/frames/*.png    rendered frames of critique iterations
//   <id>/media/*         the original .rbxm / .rbxmx / .bvh
//
// The learned style profile lives next to the user library: <userData>/anim/style.json.
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { AnimEntry, AnimScope } from '../../../shared/anim/model.ts'

export const PROJECT_ANIM_DIR = '.forge/anim'
export const ANIM_ENTRY_FILE = 'entry.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export class AnimLibraryError extends Error {}

export function animEntryId(name: string): string {
  const slug =
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'anim'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

export class AnimStore {
  readonly scope: AnimScope
  readonly dir: string
  private cache: { at: number; entries: AnimEntry[] } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scope: AnimScope, dir: string) {
    this.scope = scope
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  entryDir(id: string): string {
    if (!ID_RE.test(id)) throw new AnimLibraryError(`bad entry id "${id}"`)
    return join(this.dir, id)
  }

  filePath(id: string, file: string): string {
    const base = this.entryDir(id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new AnimLibraryError('path escapes the entry folder')
    return p
  }

  async list(): Promise<AnimEntry[]> {
    if (this.cache && Date.now() - this.cache.at < 1500) return this.cache.entries
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      names = []
    }
    const out: AnimEntry[] = []
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.conflict') || !ID_RE.test(n)) continue
      const e = await this.read(n)
      if (e) out.push(e)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), entries: out }
    return out
  }

  async read(id: string): Promise<AnimEntry | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.entryDir(id), ANIM_ENTRY_FILE), 'utf8')) as AnimEntry
      if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string' || !raw.clip || typeof raw.clip !== 'object') return null
      return {
        ...raw,
        id,
        scope: this.scope,
        tags: Array.isArray(raw.tags) ? raw.tags : [],
        thumbs: Array.isArray(raw.thumbs) ? raw.thumbs : [],
        notes: typeof raw.notes === 'string' ? raw.notes : '',
        clip: { ...raw.clip, markers: Array.isArray(raw.clip.markers) ? raw.clip.markers : [], tracks: raw.clip.tracks ?? {} }
      }
    } catch {
      return null
    }
  }

  save(entry: AnimEntry): Promise<AnimEntry> {
    return this.serial(async () => {
      const dir = this.entryDir(entry.id)
      await mkdir(dir, { recursive: true })
      const e = { ...entry, scope: this.scope }
      const tmp = join(dir, `${ANIM_ENTRY_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(e), 'utf8')
      await rename(tmp, join(dir, ANIM_ENTRY_FILE))
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
