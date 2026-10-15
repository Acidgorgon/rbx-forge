// "Restate first" in main: the setting, the decision, writing the restatement on the cheap tier and
// recording confirmations. Corrections that change the meaning are kept (setting restate.corrections,
// fed back into the restate prompt) and summarised in one memory note per scope through the existing
// memory system, so Forge learns how the person phrases goals. No Electron imports (tested directly).

import { decideRestate, type RestateDecision } from '../../shared/restate/heuristic.ts'
import { correctionNote, isSubstantialEdit, parseRestatement, restatePrompt, restateSystem, sameRestatement, type RestateCorrection } from '../../shared/restate/prompt.ts'
import {
  normalizeRestatement,
  normalizeRestateSettings,
  RESTATE_SETTING,
  type RestateKind,
  type RestateLab,
  type RestateSettings,
  type Restatement
} from '../../shared/restate/types.ts'
import type { RestateBriefResult, RestateConfirmInput, RestateConfirmResult } from '../../shared/restate/api.ts'

export const CORRECTIONS_SETTING = 'restate.corrections'
const MAX_CORRECTIONS = 20

export interface RestaterDeps {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  // Tool-less answer on the Labs cheap tier.
  oneShot?: (system: string, prompt: string) => Promise<string>
  // The memory service's remember (MemoryService.remember); absent in tests that do not check it.
  remember?: (input: { scope: 'user'; kind: 'memory'; type: 'feedback'; name: string; description: string; body: string }, source: 'user') => Promise<unknown>
  log?: (text: string, stream?: 'info' | 'stderr') => void
}

export class Restater {
  private deps: RestaterDeps

  constructor(deps: RestaterDeps) {
    this.deps = deps
  }

  settings(): RestateSettings {
    return normalizeRestateSettings(this.deps.getSetting(RESTATE_SETTING, {}))
  }

  setSettings(patch: Partial<RestateSettings>): RestateSettings {
    const next = normalizeRestateSettings({ ...this.settings(), ...(patch && typeof patch === 'object' ? patch : {}) })
    this.deps.setSetting(RESTATE_SETTING, next)
    return next
  }

  decide(kind: RestateKind, request: string, opts: { effort?: string; force?: boolean } = {}): RestateDecision {
    const s = this.settings()
    return decideRestate(request, { mode: kind === 'chat' ? s.chat : s.labs, kind, effort: opts.effort, force: opts.force })
  }

  corrections(kind?: RestateKind): RestateCorrection[] {
    const raw = this.deps.getSetting<unknown>(CORRECTIONS_SETTING, [])
    const list = Array.isArray(raw) ? (raw as RestateCorrection[]) : []
    const scope = kind === undefined ? null : kind === 'chat' ? 'chat' : 'labs'
    return list.filter((c) => c && typeof c.request === 'string' && c.draft && c.confirmed && (!scope || (c.kind === 'chat' ? 'chat' : 'labs') === scope))
  }

  // Writes the restatement (cheap tier). Throws when there is no model or the answer is unusable.
  async generate(kind: RestateKind, request: string): Promise<Restatement> {
    if (!this.deps.oneShot) throw new Error('no model for restating')
    const raw = await this.deps.oneShot(restateSystem(kind, this.corrections(kind)), restatePrompt(request))
    const r = parseRestatement(raw)
    if (!r) throw new Error('the restatement could not be read')
    return r
  }

  // Labs: the card for a brief, or why it was skipped (the setting, a simple brief, no model).
  async brief(lab: RestateLab, brief: string, opts: { force?: boolean } = {}): Promise<RestateBriefResult> {
    const text = String(brief ?? '').trim()
    const d = this.decide(lab, text, { force: opts.force })
    if (!d.restate) return { skipped: d.reason }
    try {
      return { restatement: await this.generate(lab, text), reason: d.reason }
    } catch (e) {
      this.deps.log?.(`restate: ${lab} brief skipped (${(e as Error).message})`, 'stderr')
      return { skipped: `could not restate: ${(e as Error).message}` }
    }
  }

  // A yes (maybe after an edit). A substantial edit is remembered as a correction.
  async confirm(input: RestateConfirmInput): Promise<RestateConfirmResult> {
    const draft = normalizeRestatement(input.draft)
    const confirmed = normalizeRestatement(input.confirmed) ?? draft
    if (!draft || !confirmed) throw new Error('nothing to confirm')
    const edited = !sameRestatement(draft, confirmed)
    const substantial = edited && isSubstantialEdit(draft, confirmed)
    let noted = false
    if (substantial) {
      const entry: RestateCorrection = { kind: input.kind, request: String(input.request ?? '').slice(0, 600), draft, confirmed, at: Date.now() }
      const all = [...this.corrections(), entry].slice(-MAX_CORRECTIONS)
      this.deps.setSetting(CORRECTIONS_SETTING, all)
      if (this.deps.remember) {
        const scope = input.kind === 'chat' ? 'chat' : 'labs'
        const note = correctionNote(this.corrections(input.kind), scope)
        try {
          await this.deps.remember({ scope: 'user', kind: 'memory', type: 'feedback', ...note }, 'user')
          noted = true
        } catch (e) {
          this.deps.log?.(`restate: memory note not saved (${(e as Error).message})`, 'stderr')
        }
      }
    }
    return { confirmed, edited, substantial, noted }
  }
}
