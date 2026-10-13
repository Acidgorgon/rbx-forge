// The memory + skills layer for Forge's agents: two stores (user, project), the prompt block, the
// agent tools' backend, background reflection after chats, the Luau style profile, and the data
// behind the Memory page. No model fine-tuning: everything is retrieval and prompting.
// No electron imports (main/index.ts wires IPC through ipc.ts).

import { randomUUID } from 'node:crypto'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { bm25Rank, type Ranked } from './rank.ts'
import { buildMemoryBlock, capIndex } from './prompt.ts'
import { parseProposals, REFLECTION_SYSTEM, reflectionPrompt, worthReflecting, type TranscriptMessage } from './reflection.ts'
import { MemoryError, MemoryStore, memoryUsageBook, slugify, LIMITS, type UsageRecord } from './store.ts'
import { analyzeLuauStyle, isStyleSource, STYLE_FILE_LIMIT, STYLE_MEMORY_NAME, type SourceFile } from './style.ts'
import type { MemoryEntry, MemoryFeedItem, MemoryInput, MemoryKind, MemoryListing, MemoryProposal, MemoryScope, MemorySettings, SaveResult, StyleProfile } from './types.ts'

export const PROJECT_MEMORY_DIR = '.forge/memory'
export const DEFAULT_SETTINGS: MemorySettings = { reflection: 'ask', styleOnOpen: false }
const FEED_MAX = 60
const PROPOSALS_MAX = 20
// Reflection runs this long after a chat goes idle (a new turn restarts the timer).
export const REFLECT_DELAY_MS = 45_000

export type OneShot = (system: string, prompt: string) => Promise<string>

export interface MemoryServiceDeps {
  // userData/memory
  userDir: string
  projectRoot: () => string | null
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  emit?(event: 'memory:changed' | 'memory:proposals', payload: unknown): void
  log?(text: string, stream?: 'info' | 'stderr'): void
  now?: () => number
  // Reads the project's Luau for the style profile (default: walks the project root on disk).
  readProjectLuau?: (root: string) => Promise<SourceFile[]>
  reflectDelayMs?: number
}

export class MemoryService {
  private deps: MemoryServiceDeps
  readonly user: MemoryStore
  private projectStore: { root: string; store: MemoryStore } | null = null
  private usage: ReturnType<typeof memoryUsageBook>
  private usageTimer: NodeJS.Timeout | null = null
  private oneShot: OneShot | null = null
  private timers = new Map<string, NodeJS.Timeout>()
  private reflected = new Map<string, number>()
  private reflecting = new Set<string>()
  private proposals: MemoryProposal[]
  private now: () => number

  constructor(deps: MemoryServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.usage = memoryUsageBook(deps.getSetting<Record<string, UsageRecord>>('memory.usage', {}), () => this.saveUsageSoon())
    this.user = new MemoryStore({ scope: 'user', dir: deps.userDir, usage: this.usage, usageKey: 'user', now: this.now })
    const stored = deps.getSetting<MemoryProposal[]>('memory.proposals', [])
    this.proposals = Array.isArray(stored) ? stored : []
  }

  // ------------------------------------------------------------ stores

  project(): MemoryStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) {
      this.projectStore = { root, store: new MemoryStore({ scope: 'project', dir: join(root, ...PROJECT_MEMORY_DIR.split('/')), usage: this.usage, usageKey: `project:${root}`, now: this.now }) }
    }
    return this.projectStore.store
  }

  store(scope: MemoryScope): MemoryStore {
    if (scope === 'user') return this.user
    const p = this.project()
    if (!p) throw new MemoryError('no project open: project memory needs an open project (use scope "user")')
    return p
  }

  async list(): Promise<MemoryListing> {
    const p = this.project()
    return { user: await this.user.list(), project: p ? await p.list() : [], projectRoot: this.deps.projectRoot() }
  }

  private async all(): Promise<MemoryEntry[]> {
    const l = await this.list()
    return [...l.project, ...l.user]
  }

  settings(): MemorySettings {
    const s = this.deps.getSetting<Partial<MemorySettings>>('memory.settings', {})
    return {
      reflection: s.reflection === 'auto' || s.reflection === 'off' || s.reflection === 'ask' ? s.reflection : DEFAULT_SETTINGS.reflection,
      styleOnOpen: s.styleOnOpen === true
    }
  }

  setSettings(patch: Partial<MemorySettings>): MemorySettings {
    const next = { ...this.settings(), ...patch }
    if (!['ask', 'auto', 'off'].includes(next.reflection)) next.reflection = 'ask'
    next.styleOnOpen = next.styleOnOpen === true
    this.deps.setSetting('memory.settings', next)
    if (next.reflection === 'off') this.cancelReflections()
    return next
  }

  // ------------------------------------------------------------ prompt

  // Appended after the base prompt and the project rules (see prompt.ts for the caching rules).
  async promptBlock(): Promise<string> {
    try {
      const l = await this.list()
      return buildMemoryBlock({ user: l.user, project: l.project })
    } catch (e) {
      this.deps.log?.(`memory: prompt block: ${(e as Error).message}`, 'stderr')
      return ''
    }
  }

  // ------------------------------------------------------------ agent tool backend

  async recall(query: string, opts: { scope?: MemoryScope | 'all'; kind?: MemoryKind | 'all'; limit?: number } = {}): Promise<Ranked[]> {
    let entries = await this.all()
    if (opts.scope && opts.scope !== 'all') entries = entries.filter((e) => e.scope === opts.scope)
    if (opts.kind && opts.kind !== 'all') entries = entries.filter((e) => e.kind === opts.kind)
    const hits = bm25Rank(query, entries, { now: this.now(), limit: opts.limit ?? 5 })
    for (const h of hits) this.store(h.entry.scope).touch(h.entry.kind, h.entry.name)
    return hits
  }

  // Exact name (project scope wins), else the best-ranked skill for the text.
  async skill(name: string): Promise<MemoryEntry | null> {
    const slug = slugify(name)
    const skills = (await this.all()).filter((e) => e.kind === 'skill')
    const hit = skills.find((e) => e.name === slug) ?? bm25Rank(name, skills, { limit: 1 })[0]?.entry ?? null
    if (hit) this.store(hit.scope).touch('skill', hit.name)
    return hit
  }

  async remember(input: MemoryInput, source: MemoryFeedItem['source'] = 'agent'): Promise<SaveResult> {
    const r = await this.store(input.scope).save(input)
    const action: MemoryFeedItem['action'] = input.kind === 'skill' && r.action === 'created' ? 'skill' : r.action === 'created' ? 'saved' : r.action
    this.feed({ action, scope: input.scope, kind: input.kind ?? 'memory', name: r.entry.name, description: r.entry.description, source })
    this.changed()
    return r
  }

  // Removes by name; when both stores hold the name, scope must say which.
  async forget(name: string, opts: { scope?: MemoryScope; kind?: MemoryKind } = {}, source: MemoryFeedItem['source'] = 'agent'): Promise<MemoryEntry> {
    const slug = slugify(name)
    const hits = (await this.all()).filter((e) => e.name === slug && (!opts.scope || e.scope === opts.scope) && (!opts.kind || e.kind === opts.kind))
    if (!hits.length) throw new MemoryError(`no memory or skill named "${slug}"`)
    if (hits.length > 1) throw new MemoryError(`"${slug}" exists in ${hits.map((h) => `${h.scope} ${h.kind}`).join(' and ')}; pass scope (and kind) to choose`)
    const e = hits[0]
    await this.store(e.scope).remove(e.kind, e.name)
    this.feed({ action: 'forgot', scope: e.scope, kind: e.kind, name: e.name, description: e.description, source })
    this.changed()
    return e
  }

  // ------------------------------------------------------------ Memory page

  // Edit from the page: may rename or change scope (old file removed). No dedupe: the person chose.
  async update(input: MemoryInput, previous?: { scope: MemoryScope; kind: MemoryKind; name: string }): Promise<SaveResult> {
    const kind = input.kind ?? 'memory'
    const r = await this.store(input.scope).save({ ...input, kind }, { dedupe: false })
    if (previous && (previous.scope !== input.scope || slugify(previous.name) !== r.entry.name || previous.kind !== kind)) {
      await this.store(previous.scope).remove(previous.kind, previous.name)
    }
    this.feed({ action: 'updated', scope: input.scope, kind, name: r.entry.name, description: r.entry.description, source: 'user' })
    this.changed()
    return r
  }

  async remove(scope: MemoryScope, kind: MemoryKind, name: string): Promise<boolean> {
    const ok = await this.store(scope).remove(kind, name)
    if (ok) {
      this.feed({ action: 'forgot', scope, kind, name, source: 'user' })
      this.changed()
    }
    return ok
  }

  pin(scope: MemoryScope, kind: MemoryKind, name: string, pinned: boolean): void {
    this.store(scope).setPinned(kind, slugify(name), pinned)
    this.changed()
  }

  // Moves a user memory/skill into the project (shared with the team), deduplicating there.
  async promote(kind: MemoryKind, name: string): Promise<SaveResult> {
    const e = await this.user.get(kind, name)
    if (!e) throw new MemoryError(`no user ${kind} named "${name}"`)
    const type = e.type === 'user' ? 'project' : e.type
    const r = await this.store('project').save({ scope: 'project', kind, name: e.name, description: e.description, body: e.body, ...(kind === 'memory' ? { type } : {}) })
    await this.user.remove(kind, e.name)
    this.feed({ action: 'promoted', scope: 'project', kind, name: r.entry.name, description: r.entry.description, source: 'user' })
    this.changed()
    return r
  }

  async search(query: string): Promise<MemoryEntry[]> {
    if (!query.trim()) return this.all()
    return bm25Rank(query, await this.all(), { now: this.now() }).map((r) => r.entry)
  }

  recentFeed(): MemoryFeedItem[] {
    const f = this.deps.getSetting<MemoryFeedItem[]>('memory.feed', [])
    return Array.isArray(f) ? f : []
  }

  private feed(item: Omit<MemoryFeedItem, 'at'>): void {
    const next = [{ at: this.now(), ...item }, ...this.recentFeed()].slice(0, FEED_MAX)
    this.deps.setSetting('memory.feed', next)
  }

  private changed(): void {
    this.deps.emit?.('memory:changed', { at: this.now() })
  }

  private saveUsageSoon(): void {
    if (this.usageTimer) return
    this.usageTimer = setTimeout(() => {
      this.usageTimer = null
      this.deps.setSetting('memory.usage', this.usage.all())
    }, 1500)
    this.usageTimer.unref?.()
  }

  // ------------------------------------------------------------ reflection

  setModel(oneShot: OneShot | null): void {
    this.oneShot = oneShot
  }

  // A chat went idle: reflect on it after a quiet period (debounced per chat).
  onChatIdle(sessionId: string, messages: () => TranscriptMessage[] | null): void {
    if (this.settings().reflection === 'off' || !this.oneShot) return
    const old = this.timers.get(sessionId)
    if (old) clearTimeout(old)
    const t = setTimeout(() => {
      this.timers.delete(sessionId)
      const msgs = messages()
      if (msgs) void this.reflect(sessionId, msgs).catch((e) => this.deps.log?.(`memory: reflection failed: ${(e as Error).message}`, 'stderr'))
    }, this.deps.reflectDelayMs ?? REFLECT_DELAY_MS)
    t.unref?.()
    this.timers.set(sessionId, t)
  }

  // A chat turn started: hold reflection until it is idle again.
  onChatBusy(sessionId: string): void {
    const t = this.timers.get(sessionId)
    if (t) clearTimeout(t)
    this.timers.delete(sessionId)
  }

  private cancelReflections(): void {
    for (const t of this.timers.values()) clearTimeout(t)
    this.timers.clear()
  }

  // One reflection pass over the messages added since the last pass (with a little context).
  async reflect(sessionId: string, messages: TranscriptMessage[]): Promise<MemoryProposal[]> {
    const mode = this.settings().reflection
    if (mode === 'off' || !this.oneShot || this.reflecting.has(sessionId)) return []
    const from = this.reflected.get(sessionId) ?? 0
    const fresh = messages.slice(Math.max(0, from))
    if (!worthReflecting(fresh)) return []
    this.reflecting.add(sessionId)
    try {
      this.reflected.set(sessionId, messages.length)
      const context = messages.slice(Math.max(0, from - 2), from)
      const l = await this.list()
      const index = [capIndex(l.user, 1200), capIndex(l.project, 1200)].filter(Boolean).join('\n')
      const raw = await this.oneShot(REFLECTION_SYSTEM, reflectionPrompt([...context, ...fresh], index))
      const existing = [...l.user, ...l.project]
      const parsed = parseProposals(raw).filter((p) => !existing.some((e) => e.name === p.input.name && e.kind === (p.input.kind ?? 'memory') && e.body.trim() === p.input.body.trim()))
      if (!parsed.length) return []
      // No project open: project-scoped proposals become user ones only if they are about the person.
      const usable = parsed.filter((p) => p.input.scope === 'user' || this.project())
      if (mode === 'auto') {
        for (const p of usable) {
          try {
            await this.remember(p.input, 'reflection')
          } catch (e) {
            this.deps.log?.(`memory: reflection save skipped (${p.input.name}): ${(e as Error).message}`, 'stderr')
          }
        }
        return []
      }
      const proposals: MemoryProposal[] = usable.map((p) => ({ id: randomUUID(), sessionId, createdAt: this.now(), input: p.input, ...(p.reason ? { reason: p.reason } : {}) }))
      this.proposals = [...proposals, ...this.proposals].slice(0, PROPOSALS_MAX)
      this.saveProposals()
      for (const p of proposals) this.feed({ action: 'proposed', scope: p.input.scope, kind: p.input.kind ?? 'memory', name: p.input.name, description: p.input.description, source: 'reflection' })
      this.deps.emit?.('memory:proposals', { sessionId, proposals: this.pending(sessionId) })
      return proposals
    } finally {
      this.reflecting.delete(sessionId)
    }
  }

  pending(sessionId?: string): MemoryProposal[] {
    return sessionId ? this.proposals.filter((p) => p.sessionId === sessionId) : [...this.proposals]
  }

  async accept(id: string, edited?: MemoryInput): Promise<SaveResult> {
    const p = this.proposals.find((x) => x.id === id)
    if (!p) throw new MemoryError('that proposal is gone')
    const input = edited ? { ...p.input, ...edited } : p.input
    const r = await this.remember(input, 'reflection')
    this.dropProposal(p)
    return r
  }

  dismiss(id: string): void {
    const p = this.proposals.find((x) => x.id === id)
    if (!p) return
    this.feed({ action: 'dismissed', scope: p.input.scope, kind: p.input.kind ?? 'memory', name: p.input.name, source: 'user' })
    this.dropProposal(p)
  }

  private dropProposal(p: MemoryProposal): void {
    this.proposals = this.proposals.filter((x) => x.id !== p.id)
    this.saveProposals()
    this.deps.emit?.('memory:proposals', { sessionId: p.sessionId, proposals: this.pending(p.sessionId) })
  }

  private saveProposals(): void {
    this.deps.setSetting('memory.proposals', this.proposals)
  }

  // ------------------------------------------------------------ style profile

  async analyzeStyle(): Promise<{ profile: StyleProfile; result: SaveResult | null }> {
    const root = this.deps.projectRoot()
    if (!root) throw new MemoryError('open a project first')
    const files = await (this.deps.readProjectLuau ?? readProjectLuau)(root)
    const profile = analyzeLuauStyle(files)
    if (!profile.files) return { profile, result: null }
    let body = profile.body
    if (body.length > LIMITS.memoryBody) body = body.slice(0, LIMITS.memoryBody - 20).trimEnd() + '\n…'
    const r = await this.store('project').save(
      { scope: 'project', kind: 'memory', type: 'project', name: STYLE_MEMORY_NAME, description: 'Luau code style of this project (indentation, naming, modules, comments, Vide UI): follow it when writing code', body },
      { dedupe: false }
    )
    this.feed({ action: 'style', scope: 'project', kind: 'memory', name: r.entry.name, description: `${profile.files} files analyzed`, source: 'style' })
    this.changed()
    return { profile, result: r }
  }

  // Project opened: build the style profile once when asked to and none exists yet.
  async onProjectOpen(): Promise<void> {
    if (!this.settings().styleOnOpen) return
    const p = this.project()
    if (!p || (await p.get('memory', STYLE_MEMORY_NAME))) return
    await this.analyzeStyle().catch((e) => this.deps.log?.(`memory: style analysis failed: ${(e as Error).message}`, 'stderr'))
  }

  dispose(): void {
    this.cancelReflections()
    if (this.usageTimer) {
      clearTimeout(this.usageTimer)
      this.usageTimer = null
      this.deps.setSetting('memory.usage', this.usage.all())
    }
  }
}

const SKIP_DIRS = new Set(['.git', 'node_modules', 'Packages', 'ServerPackages', 'DevPackages', '.forge', 'out', 'build', 'dist'])

// Walks the project for Luau sources (src/ first), up to STYLE_FILE_LIMIT files.
export async function readProjectLuau(root: string): Promise<SourceFile[]> {
  const out: SourceFile[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (out.length >= STYLE_FILE_LIMIT || depth > 12) return
    let ents: import('node:fs').Dirent[]
    try {
      ents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    ents.sort((a, b) => a.name.localeCompare(b.name))
    for (const e of ents) {
      if (out.length >= STYLE_FILE_LIMIT) return
      const abs = join(dir, e.name)
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name) && !e.name.startsWith('.')) await walk(abs, depth + 1)
        continue
      }
      const rel = relative(root, abs).replace(/\\/g, '/')
      if (!e.isFile() || !isStyleSource(rel)) continue
      try {
        const text = await readFile(abs, 'utf8')
        if (text.length < 400_000) out.push({ path: rel, text })
      } catch {
        // unreadable: skip
      }
    }
  }
  await walk(join(root, 'src'), 0)
  if (!out.length) await walk(root, 0)
  return out
}
