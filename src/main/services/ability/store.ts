// The ability library on disk, same layout as the VFX library:
//
//   user     <userData>/abilities/library/<id>/      follows the person (part of .forgepack export / sync)
//   project  <root>/.forge/abilities/library/<id>/   committed with the game
//
//   <id>/entry.json   the AbilityEntry      <id>/frames/*.png   critique frames      <id>/thumbs/*.png
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { AbilityEntry, AbilityScope } from '../../../shared/ability/types.ts'

export const PROJECT_ABILITY_DIR = '.forge/abilities'
const ENTRY_FILE = 'entry.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export class AbilityLibraryError extends Error {}

export function abilityId(name: string): string {
  const slug =
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'ability'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

export class AbilityStore {
  readonly scope: AbilityScope
  readonly dir: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scope: AbilityScope, dir: string) {
    this.scope = scope
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  entryDir(id: string): string {
    if (!ID_RE.test(id)) throw new AbilityLibraryError(`bad ability id "${id}"`)
    return join(this.dir, id)
  }

  filePath(id: string, file: string): string {
    const base = this.entryDir(id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new AbilityLibraryError('path escapes the entry folder')
    return p
  }

  async list(): Promise<AbilityEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const out: AbilityEntry[] = []
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.conflict') || !ID_RE.test(n)) continue
      const e = await this.read(n)
      if (e) out.push(e)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  }

  async read(id: string): Promise<AbilityEntry | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.entryDir(id), ENTRY_FILE), 'utf8')) as AbilityEntry
      if (!raw || typeof raw !== 'object' || !raw.ability || typeof raw.name !== 'string') return null
      return { ...raw, id, scope: this.scope, tags: Array.isArray(raw.tags) ? raw.tags : [], thumbs: Array.isArray(raw.thumbs) ? raw.thumbs : [] }
    } catch {
      return null
    }
  }

  save(entry: AbilityEntry): Promise<AbilityEntry> {
    return this.serial(async () => {
      const dir = this.entryDir(entry.id)
      await mkdir(dir, { recursive: true })
      const e = { ...entry, scope: this.scope }
      const tmp = join(dir, `${ENTRY_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(e, null, 1), 'utf8')
      await rename(tmp, join(dir, ENTRY_FILE))
      return e
    })
  }

  async writeFile(id: string, file: string, data: Buffer | string): Promise<string> {
    const p = this.filePath(id, file)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, data)
    return p
  }

  readFile(id: string, file: string): Promise<Buffer> {
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
      return ok
    })
  }
}
