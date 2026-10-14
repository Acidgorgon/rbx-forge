// The Thumbnail Lab library on disk. Two stores with the same layout, like the VFX texture library:
//
//   user     <userData>/thumbs/        follows the person (part of .forgepack export and Brain Sync)
//   project  <root>/.forge/thumbs/     committed with the game, shared with the team
//
//   refs/<id>/item.json + image.png               reference thumbnails and their style cards
//   profiles/<id>/item.json                       named style profiles
//   bases/<id>/item.json + image.png              base images from the game (screenshots, Studio)
//   thumbs/<id>/item.json + image.png s256.png s160.png   generated variations (CTR in item.json)
//
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import type { ThumbScope } from '../../../shared/thumbs/types.ts'

export const PROJECT_THUMB_DIR = '.forge/thumbs'
export const META = 'item.json'
export type ThumbKind = 'refs' | 'profiles' | 'bases' | 'thumbs'
export const KINDS: readonly ThumbKind[] = ['refs', 'profiles', 'bases', 'thumbs']
export const ID_RE = /^[a-z0-9][a-z0-9-]{2,63}$/

export class ThumbError extends Error {}

export function newId(prefix: string, name = ''): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 24)
  return `${prefix}${slug ? `-${slug}` : ''}-${randomBytes(3).toString('hex')}`
}

export function newBatchId(now: number): string {
  return `tb-${now.toString(36)}${randomBytes(2).toString('hex')}`
}

export class ThumbStore {
  readonly scope: ThumbScope
  readonly dir: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scope: ThumbScope, dir: string) {
    this.scope = scope
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  itemDir(kind: ThumbKind, id: string): string {
    if (!KINDS.includes(kind)) throw new ThumbError(`bad kind ${kind}`)
    if (!ID_RE.test(id)) throw new ThumbError(`bad id "${id}"`)
    return join(this.dir, kind, id)
  }

  filePath(kind: ThumbKind, id: string, file: string): string {
    const base = this.itemDir(kind, id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new ThumbError('path escapes the item folder')
    return p
  }

  async list<T>(kind: ThumbKind): Promise<T[]> {
    const root = join(this.dir, kind)
    const names = await readdir(root).catch(() => [] as string[])
    const out: T[] = []
    for (const n of names) {
      if (!ID_RE.test(n)) continue
      const raw = await readFile(join(root, n, META), 'utf8').catch(() => null)
      if (!raw) continue
      try {
        out.push({ ...(JSON.parse(raw) as T), scope: this.scope })
      } catch {
        // a half-written or conflicted file: skip
      }
    }
    return out
  }

  async read<T>(kind: ThumbKind, id: string): Promise<T | null> {
    const raw = await readFile(join(this.itemDir(kind, id), META), 'utf8').catch(() => null)
    if (!raw) return null
    try {
      return { ...(JSON.parse(raw) as T), scope: this.scope }
    } catch {
      return null
    }
  }

  save<T extends { id: string }>(kind: ThumbKind, item: T): Promise<T> {
    return this.serial(async () => {
      const dir = this.itemDir(kind, item.id)
      await mkdir(dir, { recursive: true })
      const out = { ...item, scope: this.scope }
      const tmp = join(dir, `${META}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(out, null, 2) + '\n')
      await rename(tmp, join(dir, META))
      return out
    })
  }

  async writeFile(kind: ThumbKind, id: string, file: string, bytes: Uint8Array): Promise<void> {
    const p = this.filePath(kind, id, file)
    await mkdir(join(p, '..'), { recursive: true })
    await writeFile(p, bytes)
  }

  readFile(kind: ThumbKind, id: string, file: string): Promise<Buffer> {
    return readFile(this.filePath(kind, id, file))
  }

  async remove(kind: ThumbKind, id: string): Promise<boolean> {
    const dir = this.itemDir(kind, id)
    const exists = await readFile(join(dir, META)).then(
      () => true,
      () => false
    )
    if (!exists) return false
    await rm(dir, { recursive: true, force: true })
    return true
  }
}
