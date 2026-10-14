// Principle priorities: the feedback log (one line per thumbs up / down with the rated result's
// per-principle scores and the user's notes) and the weights learned from it (shared/principles/
// learn.ts). Stored in userData/principles (feedback.json, profile.json) and registered as a pack
// section, so it travels in .forgepack files and device sync like the lab libraries; the top
// priorities are also written to memory ("principle-priorities") so the assistant knows them.
// No electron imports.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ALL_PRINCIPLES } from '../../../shared/principles/catalog.ts'
import { emptyProfile, learnProfile, MAX_FEEDBACK, prioritiesText } from '../../../shared/principles/learn.ts'
import type { PrincipleFeedback, PrincipleHooks, PrincipleProfile, PrincipleView, PrincipleWeights } from '../../../shared/principles/types.ts'

export interface PrincipleMemoryLike {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<unknown>
}

export interface PrincipleServiceDeps {
  // userData/principles
  dir: string
  memory?: PrincipleMemoryLike
  emit?: (event: 'principles:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Lab gating shadow mode (services/gating): learned weights reach the critics only when applied;
  // every rating's would-be weight change is logged as a decision.
  gate?: PrincipleGate
}

export interface PrincipleGate {
  weightsApplied(): boolean
  logWeightChange(lab: PrincipleFeedback['lab'], entryId: string, before: PrincipleWeights, after: PrincipleWeights): Promise<void>
}

export const FEEDBACK_FILE = 'feedback.json'
export const PROFILE_FILE = 'profile.json'

export class PrincipleService implements PrincipleHooks {
  private deps: PrincipleServiceDeps
  private now: () => number
  private queue: Promise<unknown> = Promise.resolve()

  constructor(deps: PrincipleServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  get dir(): string {
    return this.deps.dir
  }

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.deps.dir, file), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true })
    const tmp = join(this.deps.dir, `.${file}.tmp`)
    await writeFile(tmp, JSON.stringify(data, null, 1), 'utf8')
    await rename(tmp, join(this.deps.dir, file))
  }

  async feedback(): Promise<PrincipleFeedback[]> {
    const raw = await this.readJson<unknown>(FEEDBACK_FILE, [])
    return Array.isArray(raw) ? (raw as PrincipleFeedback[]).filter((f) => f && (f.rating === 'up' || f.rating === 'down') && f.scores && typeof f.scores === 'object') : []
  }

  // The learned profile, read fresh each time (sync or a pack import may have replaced the files);
  // recomputed from the feedback when the stored one is missing or does not match it.
  async profile(): Promise<PrincipleProfile> {
    const fb = await this.feedback()
    const stored = await this.readJson<PrincipleProfile | null>(PROFILE_FILE, null)
    const latest = fb.reduce((m, f) => Math.max(m, f.at), 0)
    return stored && stored.version === 1 && stored.ratings === fb.length && stored.updatedAt >= latest ? stored : fb.length ? learnProfile(fb, latest) : emptyProfile(this.now())
  }

  // The weights the critics use: the learned ones, or neutral while gating keeps them in shadow.
  async weights(): Promise<PrincipleWeights> {
    if (this.deps.gate && !this.deps.gate.weightsApplied()) return {}
    return (await this.profile()).weights
  }

  // One rating. Ignored when it carries no principle scores. Serialised so two quick ratings do
  // not lose each other's line.
  record(input: Omit<PrincipleFeedback, 'at'>): Promise<void> {
    const run = this.queue.then(() => this.recordNow(input))
    this.queue = run.catch(() => undefined)
    return run
  }

  private async recordNow(input: Omit<PrincipleFeedback, 'at'>): Promise<void> {
    const scores = Object.fromEntries(Object.entries(input.scores ?? {}).filter(([, v]) => Number.isFinite(v)))
    if (!Object.keys(scores).length) return
    const at = this.now()
    const before = this.deps.gate ? (await this.profile()).weights : {}
    const fb = (await this.feedback()).filter((f) => !(f.lab === input.lab && f.entryId === input.entryId))
    fb.push({ at, lab: input.lab, entryId: input.entryId, ...(input.name ? { name: input.name.slice(0, 80) } : {}), rating: input.rating, scores, ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 600) } : {}) })
    const kept = fb.sort((a, b) => a.at - b.at).slice(-MAX_FEEDBACK)
    const profile = learnProfile(kept, at)
    await this.writeJson(FEEDBACK_FILE, kept)
    await this.writeJson(PROFILE_FILE, profile)
    this.deps.emit?.('principles:changed', { at })
    await this.deps.gate?.logWeightChange(input.lab, input.entryId, before, profile.weights).catch((e) => this.deps.log?.(`principles: gate log: ${(e as Error).message}`, 'stderr'))
    await this.saveMemory(profile)
  }

  // Unrating an entry drops its line.
  async forget(lab: PrincipleFeedback['lab'], entryId: string): Promise<void> {
    const run = this.queue.then(async () => {
      const fb = await this.feedback()
      const kept = fb.filter((f) => !(f.lab === lab && f.entryId === entryId))
      if (kept.length === fb.length) return
      const profile = kept.length ? learnProfile(kept, this.now()) : emptyProfile(this.now())
      await this.writeJson(FEEDBACK_FILE, kept)
      await this.writeJson(PROFILE_FILE, profile)
        this.deps.emit?.('principles:changed', { at: this.now() })
    })
    this.queue = run.catch(() => undefined)
    return run
  }

  async view(): Promise<PrincipleView> {
    const fb = await this.feedback()
    return {
      profile: await this.profile(),
      catalogue: ALL_PRINCIPLES.map((p) => ({ id: p.id, domain: p.domain, name: p.name, rule: p.rule, measured: !!p.measure })),
      recent: fb.slice(-8).reverse()
    }
  }

  async reset(): Promise<PrincipleView> {
    await this.writeJson(FEEDBACK_FILE, [])
    await this.writeJson(PROFILE_FILE, emptyProfile(this.now()))
    this.deps.emit?.('principles:changed', { at: this.now() })
    return this.view()
  }

  private async saveMemory(profile: PrincipleProfile): Promise<void> {
    if (!this.deps.memory) return
    await this.deps.memory
      .remember({ scope: 'user', kind: 'memory', type: 'feedback', name: 'principle-priorities', description: 'Which animation and VFX principles the user cares most about (learned from Labs ratings)', body: prioritiesText(profile) }, 'style')
      .catch((e) => this.deps.log?.(`principles: memory: ${(e as Error).message}`, 'stderr'))
  }
}
