// The Model Lab library on disk: one folder per model.
//
//   project  <root>/.forge/models/library/<id>/   committed with the game (the Lab's default)
//   none     <userData>/models/library/<id>/       when no project is open
//
//   <id>/entry.json   the ModelEntry          <id>/build.json   the last preview build (cache)
//   <id>/refs/*.png   reference images        <id>/frames/*.png critic frames   <id>/thumb.png
// Files ending in ".conflict" (left by sync) are ignored. No electron imports.

import { randomBytes } from 'node:crypto'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve, sep } from 'node:path'
import { MODEL_TEMPLATE_IDS, type ModelEntry } from '../../../shared/model/types.ts'
import { renameRetry } from '../fs/renameRetry.ts'

export const PROJECT_MODEL_DIR = '.forge/models'
const ENTRY_FILE = 'entry.json'
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

export class ModelLibraryError extends Error {}

export function modelId(name: string): string {
  const slug =
    name
      .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'model'
  return `${slug}-${randomBytes(3).toString('hex')}`
}

export function normalizeEntry(raw: any, id: string): ModelEntry | null {
  if (!raw || typeof raw !== 'object' || typeof raw.script !== 'string' || typeof raw.name !== 'string') return null
  const now = Date.now()
  return {
    ...raw,
    id,
    name: raw.name.slice(0, 80) || 'Block Model',
    prompt: typeof raw.prompt === 'string' ? raw.prompt : '',
    template: MODEL_TEMPLATE_IDS.includes(raw.template) ? raw.template : 'creature',
    parts: Number(raw.parts) || 0,
    refs: Array.isArray(raw.refs) ? raw.refs.filter((r: unknown) => typeof r === 'string') : [],
    origin: raw.origin === 'ai' || raw.origin === 'template' || raw.origin === 'edit' ? raw.origin : 'edit',
    createdAt: Number(raw.createdAt) || now,
    updatedAt: Number(raw.updatedAt) || now
  }
}

export class ModelStore {
  readonly dir: string
  private queue: Promise<unknown> = Promise.resolve()

  constructor(dir: string) {
    this.dir = dir
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  entryDir(id: string): string {
    if (!ID_RE.test(id)) throw new ModelLibraryError(`bad model id "${id}"`)
    return join(this.dir, id)
  }

  filePath(id: string, file: string): string {
    const base = this.entryDir(id)
    const p = resolve(base, file)
    if (!p.startsWith(resolve(base) + sep)) throw new ModelLibraryError('path escapes the entry folder')
    return p
  }

  async list(): Promise<ModelEntry[]> {
    const names = await readdir(this.dir).catch(() => [] as string[])
    const out: ModelEntry[] = []
    for (const n of names) {
      if (n.startsWith('.') || n.endsWith('.conflict') || !ID_RE.test(n)) continue
      const e = await this.read(n)
      if (e) out.push(e)
    }
    return out.sort((a, b) => b.updatedAt - a.updatedAt || a.name.localeCompare(b.name))
  }

  async read(id: string): Promise<ModelEntry | null> {
    try {
      return normalizeEntry(JSON.parse(await readFile(join(this.entryDir(id), ENTRY_FILE), 'utf8')), id)
    } catch {
      return null
    }
  }

  save(entry: ModelEntry): Promise<ModelEntry> {
    return this.serial(async () => {
      const dir = this.entryDir(entry.id)
      await mkdir(dir, { recursive: true })
      const tmp = join(dir, `${ENTRY_FILE}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`)
      await writeFile(tmp, JSON.stringify(entry, null, 1), 'utf8')
      await renameRetry(tmp, join(dir, ENTRY_FILE))
      return entry
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

  async removeFile(id: string, file: string): Promise<void> {
    await rm(this.filePath(id, file), { recursive: true, force: true })
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
