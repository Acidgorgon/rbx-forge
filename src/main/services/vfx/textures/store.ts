// The texture library on disk. Two stores with the same layout, like the effect library:
//
//   user     <userData>/vfx/textures/<id>/         follows the person (part of .forgepack and sync)
//   project  <root>/.forge/vfx/textures/<id>/      committed with the game, shared with the team
//
//   <id>/texture.json   the VfxTexture (recipe or prompt, tint, flipbook, rating, upload state)
//   <id>/texture.png    the texture itself (straight alpha, square, power of two)
//   <id>/preview.png    premultiplied on black (what it looks like drawn additively)
//
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { TEX_ID_RE, type TextureScope, type VfxTexture } from '../../../../shared/vfx/tex/textures.ts'
import { renameRetry } from '../../fs/renameRetry.ts'

export const PROJECT_TEXTURE_DIR = '.forge/vfx/textures'
export const META_FILE = 'texture.json'

export class TextureError extends Error {}

export function textureId(name: string): string {
  const slug =
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'texture'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

export class TextureStore {
  readonly scope: TextureScope
  readonly dir: string
  private cache: { at: number; items: VfxTexture[] } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(scope: TextureScope, dir: string) {
    this.scope = scope
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  itemDir(id: string): string {
    if (!TEX_ID_RE.test(id)) throw new TextureError(`bad texture id "${id}"`)
    return join(this.dir, id)
  }

  filePath(id: string, file: string): string {
    const base = this.itemDir(id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new TextureError('path escapes the texture folder')
    return p
  }

  async list(): Promise<VfxTexture[]> {
    if (this.cache && Date.now() - this.cache.at < 1500) return this.cache.items
    const names = await readdir(this.dir).catch(() => [] as string[])
    const out: VfxTexture[] = []
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.conflict') || !TEX_ID_RE.test(n)) continue
      const t = await this.read(n)
      if (t) out.push(t)
    }
    out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
    this.cache = { at: Date.now(), items: out }
    return out
  }

  async read(id: string): Promise<VfxTexture | null> {
    try {
      const raw = JSON.parse(await readFile(join(this.itemDir(id), META_FILE), 'utf8')) as VfxTexture
      if (!raw || typeof raw !== 'object' || typeof raw.name !== 'string') return null
      return { ...raw, id, scope: this.scope, tags: Array.isArray(raw.tags) ? raw.tags : [], file: raw.file || 'texture.png', preview: raw.preview || 'preview.png' }
    } catch {
      return null
    }
  }

  save(item: VfxTexture): Promise<VfxTexture> {
    return this.serial(async () => {
      const dir = this.itemDir(item.id)
      await mkdir(dir, { recursive: true })
      const t = { ...item, scope: this.scope }
      const tmp = join(dir, `${META_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(t, null, 1), 'utf8')
      await renameRetry(tmp, join(dir, META_FILE))
      this.cache = null
      return t
    })
  }

  async writeFile(id: string, file: string, data: Buffer): Promise<string> {
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
      const dir = this.itemDir(id)
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
