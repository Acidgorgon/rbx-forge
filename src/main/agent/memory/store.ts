// One memory store on disk: user memory (userData/memory) or project memory (.forge/memory).
//
//   <dir>/<name>.md                 a memory: frontmatter (name, description, type, created,
//                                   lastUsed, uses) + markdown body
//   <dir>/skills/<name>/SKILL.md    a skill: frontmatter (name, description = when to use, created,
//                                   lastUsed, uses) + steps (agentskills.io / Hermes layout)
//   <dir>/MEMORY.md                 the index: one line per memory/skill, regenerated on every write
//
// Usage counters and pins are kept in a local UsageBook (userData), not rewritten into the files on
// every recall: project memory is committed, and bumping `uses` on each read would churn git for
// the whole team. The frontmatter carries the counters as of the last save.
//
// The files are the source of truth: people (and git pulls) may edit them by hand. No electron.

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { formatFrontmatter, parseFrontmatter } from './frontmatter.ts'
import { similarity } from './rank.ts'
import { unsafeReason } from './safety.ts'
import type { MemoryEntry, MemoryInput, MemoryKind, MemoryScope, MemoryType, SaveResult } from './types.ts'
import { renameRetry } from '../../services/fs/renameRetry.ts'

export const INDEX_FILE = 'MEMORY.md'
export const SKILLS_DIR = 'skills'
export const SKILL_FILE = 'SKILL.md'
export const LIMITS = { name: 60, description: 200, memoryBody: 3000, skillBody: 8000 }
// name + description Jaccard at or above this is "the same memory": update instead of adding.
export const DEDUPE_THRESHOLD = 0.5
const TYPES: MemoryType[] = ['user', 'project', 'feedback', 'reference']

export class MemoryError extends Error {}

export function slugify(name: string): string {
  return name
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, LIMITS.name)
    .replace(/-+$/, '')
}

export interface UsageRecord {
  uses: number
  lastUsed: number
  pinned?: boolean
}

// Local per-user usage counters and pins, keyed by store + kind + name. Persisted by the owner.
export interface UsageBook {
  get(key: string): UsageRecord | undefined
  set(key: string, rec: UsageRecord | undefined): void
}

export function memoryUsageBook(initial: Record<string, UsageRecord> = {}, onChange?: (all: Record<string, UsageRecord>) => void): UsageBook & { all(): Record<string, UsageRecord> } {
  const map: Record<string, UsageRecord> = { ...initial }
  return {
    get: (k) => map[k],
    set: (k, rec) => {
      if (rec) map[k] = rec
      else delete map[k]
      onChange?.(map)
    },
    all: () => map
  }
}

export class MemoryStore {
  readonly scope: MemoryScope
  readonly dir: string
  private usage: UsageBook
  private usageKey: string
  private cache: { at: number; entries: MemoryEntry[] } | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private now: () => number

  // usageKey distinguishes stores in the shared UsageBook (e.g. 'user' or 'project:<root>').
  constructor(opts: { scope: MemoryScope; dir: string; usage?: UsageBook; usageKey?: string; now?: () => number }) {
    this.scope = opts.scope
    this.dir = opts.dir
    this.usage = opts.usage ?? memoryUsageBook()
    this.usageKey = opts.usageKey ?? opts.scope
    this.now = opts.now ?? Date.now
  }

  private key(kind: MemoryKind, name: string): string {
    return `${this.usageKey}|${kind}:${name}`
  }

  private fileOf(kind: MemoryKind, name: string): string {
    return kind === 'skill' ? join(SKILLS_DIR, name, SKILL_FILE) : `${name}.md`
  }

  // Serializes writes so two tools saving at once cannot interleave.
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn)
    this.queue = run.catch(() => undefined)
    return run
  }

  invalidate(): void {
    this.cache = null
  }

  async list(): Promise<MemoryEntry[]> {
    // Short TTL: files can change under us (git pull, hand edits).
    if (this.cache && this.now() - this.cache.at < 2000) return this.cache.entries
    const out: MemoryEntry[] = []
    let names: string[] = []
    try {
      names = await readdir(this.dir)
    } catch {
      names = []
    }
    for (const f of names) {
      if (!f.endsWith('.md') || f === INDEX_FILE || f.startsWith('.')) continue
      const e = await this.readEntry('memory', f.slice(0, -3))
      if (e) out.push(e)
    }
    let skills: string[] = []
    try {
      skills = await readdir(join(this.dir, SKILLS_DIR))
    } catch {
      skills = []
    }
    for (const s of skills) {
      if (s.startsWith('.')) continue
      const e = await this.readEntry('skill', s)
      if (e) out.push(e)
    }
    out.sort((a, b) => a.kind.localeCompare(b.kind) || a.name.localeCompare(b.name))
    this.cache = { at: this.now(), entries: out }
    return out
  }

  private async readEntry(kind: MemoryKind, name: string): Promise<MemoryEntry | null> {
    const file = this.fileOf(kind, name)
    let text: string
    try {
      text = await readFile(join(this.dir, file), 'utf8')
    } catch {
      return null
    }
    const { data, body } = parseFrontmatter(text)
    let created = Number(data.created) || 0
    if (!created) {
      try {
        created = (await stat(join(this.dir, file))).mtimeMs
      } catch {
        created = 0
      }
    }
    const rec = this.usage.get(this.key(kind, name))
    const type = TYPES.includes(data.type as MemoryType) ? (data.type as MemoryType) : undefined
    const e: MemoryEntry = {
      id: `${this.scope}:${kind}:${name}`,
      scope: this.scope,
      kind,
      name,
      description: String(data.description ?? '').trim(),
      body,
      created: Math.round(created),
      updated: Math.round(Number(data.updated) || created),
      lastUsed: Math.max(Number(data.lastUsed) || 0, rec?.lastUsed ?? 0),
      uses: Math.max(Number(data.uses) || 0, rec?.uses ?? 0),
      file: file.replace(/\\/g, '/')
    }
    if (kind === 'memory') e.type = type ?? (this.scope === 'user' ? 'user' : 'project')
    if (rec?.pinned) e.pinned = true
    return e
  }

  async get(kind: MemoryKind, name: string): Promise<MemoryEntry | null> {
    return (await this.list()).find((e) => e.kind === kind && e.name === slugify(name)) ?? null
  }

  // Validates, refuses secrets, deduplicates, writes the file and the index.
  save(input: MemoryInput, opts: { dedupe?: boolean } = {}): Promise<SaveResult> {
    return this.serial(async () => {
      const kind: MemoryKind = input.kind ?? 'memory'
      const name = slugify(input.name)
      if (!name) throw new MemoryError('name is empty; use a short kebab-case name')
      const description = input.description.replace(/\s+/g, ' ').trim()
      if (!description) throw new MemoryError('description is empty; give one line saying what it is (or when to use the skill)')
      if (description.length > LIMITS.description) throw new MemoryError(`description is ${description.length} chars; keep it to one line under ${LIMITS.description}`)
      const body = input.body.replace(/\r\n/g, '\n').trim()
      const max = kind === 'skill' ? LIMITS.skillBody : LIMITS.memoryBody
      if (!body) throw new MemoryError('body is empty')
      if (body.length > max) throw new MemoryError(`body is ${body.length} chars (limit ${max}); condense it to the durable facts`)
      const unsafe = unsafeReason(`${input.name}\n${description}\n${body}`)
      if (unsafe) throw new MemoryError(unsafe)
      const type = kind === 'memory' ? (TYPES.includes(input.type as MemoryType) ? input.type : this.scope === 'user' ? 'user' : 'project') : undefined

      this.invalidate()
      const all = (await this.list()).filter((e) => e.kind === kind)
      let target = all.find((e) => e.name === name) ?? null
      let action: SaveResult['action'] = target ? 'updated' : 'created'
      let mergedFrom: string | undefined
      if (!target && opts.dedupe !== false) {
        let best: { e: MemoryEntry; s: number } | null = null
        for (const e of all) {
          const s = similarity({ name, description }, e)
          if (s >= DEDUPE_THRESHOLD && (!best || s > best.s)) best = { e, s }
        }
        if (best) {
          target = best.e
          action = 'merged'
          mergedFrom = name
        }
      }
      const finalName = target?.name ?? name
      const now = this.now()
      const rec = this.usage.get(this.key(kind, finalName))
      const created = target?.created || now
      const fm: Record<string, string | number | undefined> = {
        name: finalName,
        description,
        ...(kind === 'memory' ? { type } : {}),
        created,
        // Last content change; device sync resolves conflicts by the newest one.
        updated: now,
        lastUsed: target ? Math.max(target.lastUsed, rec?.lastUsed ?? 0) || now : now,
        uses: target ? Math.max(target.uses, rec?.uses ?? 0) : 0
      }
      const file = this.fileOf(kind, finalName)
      await mkdir(join(this.dir, kind === 'skill' ? join(SKILLS_DIR, finalName) : ''), { recursive: true })
      await atomicWrite(join(this.dir, file), formatFrontmatter(fm, body))
      this.usage.set(this.key(kind, finalName), { uses: Number(fm.uses) || 0, lastUsed: Number(fm.lastUsed) || now, ...(rec?.pinned ? { pinned: true } : {}) })
      this.invalidate()
      await this.writeIndex()
      const entry = (await this.get(kind, finalName))!
      return { entry, action, ...(mergedFrom ? { mergedFrom } : {}) }
    })
  }

  remove(kind: MemoryKind, name: string): Promise<boolean> {
    return this.serial(async () => {
      const slug = slugify(name)
      const e = (await this.list()).find((x) => x.kind === kind && x.name === slug)
      if (!e) return false
      await rm(join(this.dir, kind === 'skill' ? join(SKILLS_DIR, slug) : `${slug}.md`), { recursive: true, force: true })
      this.usage.set(this.key(kind, slug), undefined)
      this.invalidate()
      await this.writeIndex()
      return true
    })
  }

  // Counts a use (recall hit, use_skill). Local only; see the header.
  touch(kind: MemoryKind, name: string): void {
    const k = this.key(kind, name)
    const rec = this.usage.get(k)
    const cached = this.cache?.entries.find((e) => e.kind === kind && e.name === name)
    const uses = Math.max(rec?.uses ?? 0, cached?.uses ?? 0) + 1
    this.usage.set(k, { ...rec, uses, lastUsed: this.now() })
    if (cached) {
      cached.uses = uses
      cached.lastUsed = this.now()
    }
  }

  setPinned(kind: MemoryKind, name: string, pinned: boolean): void {
    const k = this.key(kind, name)
    const rec = this.usage.get(k) ?? { uses: 0, lastUsed: 0 }
    const next: UsageRecord = { uses: rec.uses, lastUsed: rec.lastUsed }
    if (pinned) next.pinned = true
    this.usage.set(k, next)
    this.invalidate()
  }

  // MEMORY.md: a human-readable index (and what teammates see in the repo).
  async writeIndex(): Promise<void> {
    const entries = await this.list()
    const mem = entries.filter((e) => e.kind === 'memory')
    const skills = entries.filter((e) => e.kind === 'skill')
    const lines = [
      `# ${this.scope === 'project' ? 'Project' : 'User'} memory`,
      '',
      this.scope === 'project'
        ? 'Learned by RBX Forge agents and shared with the team (committed). One file per memory; skills/<name>/SKILL.md are reusable procedures. Edit or delete freely; this index is regenerated.'
        : 'Learned by RBX Forge agents about you; follows you across projects. This index is regenerated.',
      ''
    ]
    if (mem.length) lines.push('## Memories', '', ...mem.map((e) => `- [${e.name}](${e.file}) (${e.type}) — ${e.description}`), '')
    if (skills.length) lines.push('## Skills', '', ...skills.map((e) => `- [${e.name}](${e.file}) — ${e.description}`), '')
    if (!entries.length) {
      try {
        await rm(join(this.dir, INDEX_FILE), { force: true })
      } catch {
        // nothing to remove
      }
      return
    }
    await mkdir(this.dir, { recursive: true })
    await atomicWrite(join(this.dir, INDEX_FILE), lines.join('\n'))
  }
}

async function atomicWrite(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`
  await writeFile(tmp, text, 'utf8')
  try {
    await renameRetry(tmp, path)
  } catch (e) {
    await rm(tmp, { force: true })
    throw e
  }
}
