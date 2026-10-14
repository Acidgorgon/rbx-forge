// Lab gating service: runs the code gates (shared/gating/gates.ts) before big-model calls in the
// VFX Lab, Animation Lab and Ability Composer, consults the learned decision models
// (shared/decide), logs every decision, keeps the labelled examples the models train on, and
// accounts tokens + cost per lab run for "cost per kept".
//
// Modes (Settings > Labs): gates shadow (default) / on / off; decision models off / shadow
// (default) / on. In shadow the gates decide and log but the labs behave exactly as before, which is
// also what labels the examples (a critique that would have been skipped still runs, so Forge sees
// whether it mattered).
//
// Stored in userData/labs-gating as small JSON files. No electron imports.

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chargeRun, costRows, markKept, type UsageCharge } from '../../../shared/gating/costs.ts'
import { framesDiff, frameSig, type FrameSig } from '../../../shared/gating/frames.ts'
import { classifyFailure, criticSkipVerdict, estimateComposeTokens, estimateCriticTokens, legacyRetry, plateauVerdict, PLATEAU, retryVerdict, type FailureKind, type RetryOutcome } from '../../../shared/gating/gates.ts'
import type { LabGate } from '../../../shared/gating/hooks.ts'
import { DECISION_TYPES, normalizeGatingSettings, type CostTier, type DecisionModelStatus, type DecisionType, type GateDecision, type GateMode, type GatingSettings, type GatingView, type LabId, type LabRun } from '../../../shared/gating/types.ts'
import { criticSkipFeatures, plateauFeatures, retryFeatures } from '../../../shared/decide/features.ts'
import { isActive, parseModelFile, trainDecisionModel, yesNo, type DecisionModelFile, type Example } from '../../../shared/decide/model.ts'
import { decodePng } from './png.ts'
import { renameRetry } from '../fs/renameRetry.ts'

export const MAX_DECISIONS = 600
export const MAX_EXAMPLES = 2000
// Retrain automatically after this many new labels.
export const RETRAIN_EVERY = 10
const CLASSES = ['no', 'yes']

export interface GatingServiceDeps {
  dir: string
  settings: () => GatingSettings
  emit?: (event: 'labs:gating', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

interface RunState {
  sigs: (FrameSig | null)[] | null
  scores: number[]
  changes: number
  critic?: { exampleId: string; prevScore: number }
  plateau?: { exampleId: string; last: number }
}

interface RunCtx {
  lab: LabId
  entryId?: string
  // Charges before the entry id is known (compose) wait here.
  buffered: { tier: CostTier; u: UsageCharge }[]
}

interface Stores {
  decisions: GateDecision[]
  runs: LabRun[]
  examples: Record<DecisionType, Example[]>
  models: Partial<Record<DecisionType, DecisionModelFile>>
  // Labels added since the last training, per type (a count, not "labelled now - labelled then":
  // past MAX_EXAMPLES the labelled total stops growing and retraining would never trigger).
  newLabels: Partial<Record<DecisionType, number>>
}

export class GatingService implements LabGate {
  private deps: GatingServiceDeps
  private now: () => number
  private als = new AsyncLocalStorage<RunCtx>()
  private state = new Map<string, RunState>()
  private stores: Stores | null = null
  private loading: Promise<Stores> | null = null
  private queue: Promise<unknown> = Promise.resolve()
  private seq = 0

  constructor(deps: GatingServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  get dir(): string {
    return this.deps.dir
  }

  settings(): GatingSettings {
    return normalizeGatingSettings(this.deps.settings())
  }

  // ------------------------------------------------------------ storage

  private async readJson<T>(file: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(join(this.deps.dir, file), 'utf8')) as T
    } catch {
      return fallback
    }
  }

  private async load(): Promise<Stores> {
    if (this.stores) return this.stores
    this.loading ??= (async () => {
      const decisions = await this.readJson<GateDecision[]>('decisions.json', [])
      const runs = await this.readJson<LabRun[]>('costs.json', [])
      const examples = {} as Record<DecisionType, Example[]>
      const models: Stores['models'] = {}
      const newLabels: Stores['newLabels'] = {}
      for (const t of DECISION_TYPES) {
        const ex = await this.readJson<Example[]>(`examples-${t}.json`, [])
        examples[t] = Array.isArray(ex) ? ex.filter((e) => e && typeof e.id === 'string' && e.features && typeof e.features === 'object') : []
        const m = parseModelFile(await this.readJson<unknown>(`model-${t}.json`, null))
        if (m && m.type === t) models[t] = m
        newLabels[t] = Math.max(0, examples[t].filter((e) => e.label !== undefined).length - (models[t]?.n ?? 0))
      }
      this.stores = { decisions: Array.isArray(decisions) ? decisions : [], runs: Array.isArray(runs) ? runs : [], examples, models, newLabels }
      return this.stores
    })()
    return this.loading
  }

  private async writeJson(file: string, data: unknown): Promise<void> {
    await mkdir(this.deps.dir, { recursive: true })
    const tmp = join(this.deps.dir, `.${file}.tmp`)
    await writeFile(tmp, JSON.stringify(data), 'utf8')
    await renameRetry(tmp, join(this.deps.dir, file))
  }

  // Serialised writes so two quick decisions never lose each other.
  private save(files: string[]): Promise<void> {
    const run = this.queue.then(async () => {
      const s = await this.load()
      for (const f of files) {
        if (f === 'decisions.json') await this.writeJson(f, s.decisions)
        else if (f === 'costs.json') await this.writeJson(f, s.runs)
        else {
          const m = /^(examples|model)-(.+)\.json$/.exec(f)
          if (m?.[1] === 'examples') await this.writeJson(f, s.examples[m[2] as DecisionType] ?? [])
          else if (m?.[1] === 'model') await this.writeJson(f, s.models[m[2] as DecisionType] ?? null)
        }
      }
    })
    this.queue = run.catch((e) => this.deps.log?.(`gating: save: ${(e as Error).message}`, 'stderr'))
    return run.catch(() => undefined)
  }

  // Waits for pending writes (tests, shutdown).
  async flush(): Promise<void> {
    await this.queue
  }

  private id(prefix: string): string {
    return `${prefix}-${this.now().toString(36)}-${(this.seq++).toString(36)}`
  }

  private changed(lab?: LabId, entryId?: string): void {
    this.deps.emit?.('labs:gating', { lab, entryId, at: this.now() })
  }

  private async record(d: Omit<GateDecision, 'id' | 'at'>): Promise<GateDecision> {
    const s = await this.load()
    const full: GateDecision = { id: this.id('d'), at: this.now(), ...d }
    s.decisions = [...s.decisions, full].slice(-MAX_DECISIONS)
    void this.save(['decisions.json'])
    this.changed(d.lab, d.entryId)
    return full
  }

  // ------------------------------------------------------------ decision models

  private async addExample(type: DecisionType, features: Record<string, number>, heuristic: number): Promise<string> {
    const s = await this.load()
    const ex: Example = { id: this.id('x'), at: this.now(), features, heuristic }
    s.examples[type] = [...s.examples[type], ex].slice(-MAX_EXAMPLES)
    void this.save([`examples-${type}.json`])
    return ex.id
  }

  private async label(type: DecisionType, exampleId: string, label: number): Promise<void> {
    const s = await this.load()
    const list = s.examples[type]
    const i = list.findIndex((e) => e.id === exampleId)
    if (i < 0 || list[i].label !== undefined) return
    list[i] = { ...list[i], label }
    void this.save([`examples-${type}.json`])
    s.newLabels[type] = (s.newLabels[type] ?? 0) + 1
    if ((s.newLabels[type] ?? 0) >= RETRAIN_EVERY) await this.train(type)
  }

  private async train(type: DecisionType): Promise<void> {
    const s = await this.load()
    const m = trainDecisionModel(type, CLASSES, s.examples[type], this.now())
    s.newLabels[type] = 0
    if (!m) return
    s.models[type] = m
    void this.save([`model-${type}.json`])
    this.deps.log?.(`gating: ${type} model retrained on ${m.n} examples (held-out ${Math.round(m.holdout.modelAcc * 100)}% vs heuristic ${Math.round(m.holdout.heuristicAcc * 100)}%)`)
  }

  async retrain(): Promise<void> {
    for (const t of DECISION_TYPES) await this.train(t)
    this.changed()
  }

  // P(positive class) and whether the model decides (models on + active).
  private async consult(type: DecisionType, features: Record<string, number>): Promise<{ p?: number; decides: boolean }> {
    const set = this.settings()
    if (set.models === 'off') return { decides: false }
    const m = (await this.load()).models[type]
    if (!m) return { decides: false }
    const p = Math.round(yesNo(m, features) * 1000) / 1000
    return { p, decides: set.models === 'on' && isActive(m, set.minExamples) }
  }

  async modelStatus(): Promise<DecisionModelStatus[]> {
    const s = await this.load()
    const needed = this.settings().minExamples
    return DECISION_TYPES.map((type) => {
      const ex = s.examples[type]
      const labelled = ex.filter((e) => e.label !== undefined).length
      const m = s.models[type]
      const state: DecisionModelStatus['state'] = isActive(m, needed) ? 'active' : m && m.n >= needed ? 'not-better' : 'learning'
      return { type, state, labelled, pending: ex.length - labelled, needed, ...(m ? { modelAcc: m.holdout.modelAcc, heuristicAcc: m.holdout.heuristicAcc, holdout: m.holdout.n, trainedAt: m.trainedAt } : {}) }
    })
  }

  // ------------------------------------------------------------ gates (LabGate)

  private run(lab: LabId, entryId: string): RunState {
    const key = `${lab}:${entryId}`
    let st = this.state.get(key)
    if (!st) this.state.set(key, (st = { sigs: null, scores: [], changes: 0 }))
    return st
  }

  endRun(lab: LabId, entryId: string): void {
    this.state.delete(`${lab}:${entryId}`)
  }

  async beforeCritique(i: { lab: LabId; entryId: string; iteration: number; frames: Uint8Array[]; previousScore: number | null; changes: number; threshold: number; previousFrames?: Uint8Array[] }): Promise<{ skip: boolean; reason?: string }> {
    const set = this.settings()
    if (set.gates === 'off') return { skip: false }
    const st = this.run(i.lab, i.entryId)
    const sig = (f: Uint8Array) => {
      const img = decodePng(f)
      return img ? frameSig(img) : null
    }
    const sigs = i.frames.map(sig)
    const prev = st.sigs ?? (i.previousFrames?.length ? i.previousFrames.map(sig) : null)
    st.sigs = sigs
    st.changes = i.changes
    const hasPrevious = i.previousScore !== null && !!prev
    if (!hasPrevious) return { skip: false }
    const d = framesDiff(prev, sigs)
    const criticTokens = estimateCriticTokens({ images: i.frames.length + 1 })
    const v = criticSkipVerdict(d, { hasPrevious, criticTokens })
    const prevGain = st.scores.length >= 2 ? st.scores[st.scores.length - 1] - st.scores[st.scores.length - 2] : null
    const features = criticSkipFeatures({ lab: i.lab, diff: d.diff, hash: d.hash, comparable: d.comparable, iteration: i.iteration, prevScore: i.previousScore, prevGain, changes: i.changes, threshold: i.threshold, heuristicSkip: v.outcome === 'skip' })
    const m = await this.consult('critic-skip', features)
    const modelOutcome = m.p === undefined ? undefined : m.p >= 0.5 ? 'critique' : 'skip'
    const outcome = m.decides && modelOutcome ? modelOutcome : v.outcome
    const skip = set.gates === 'on' && outcome === 'skip'
    await this.record({
      lab: i.lab,
      entryId: i.entryId,
      gate: 'critic-skip',
      mode: set.gates,
      inputs: `${v.reason}; round ${i.iteration}, prev ${i.previousScore?.toFixed(1)}`,
      outcome: outcome === 'skip' ? (skip ? 'skipped critic' : 'would skip critic') : 'critique',
      acted: skip,
      by: m.decides ? 'model' : 'code',
      ...(v.sure ? {} : { unsure: true }),
      ...(m.p !== undefined ? { modelP: m.p } : {}),
      ...(modelOutcome && modelOutcome !== outcome ? { modelSays: modelOutcome } : {}),
      tokensSaved: outcome === 'skip' ? criticTokens : 0
    })
    if (!skip) {
      // The critique runs: its score change labels the example ("did it matter?").
      const exampleId = await this.addExample('critic-skip', features, v.outcome === 'critique' ? 1 : 0)
      st.critic = { exampleId, prevScore: i.previousScore! }
    }
    return skip ? { skip, reason: v.reason } : { skip }
  }

  async afterCritique(i: { lab: LabId; entryId: string; iteration: number; score: number; threshold: number; remaining: number; changes: number; summary?: string }): Promise<{ stop: boolean; reason?: string }> {
    const set = this.settings()
    const st = this.run(i.lab, i.entryId)
    // Labels: the critique that just ran, and the "another round" decision of the previous round.
    if (st.critic) {
      await this.label('critic-skip', st.critic.exampleId, Math.abs(i.score - st.critic.prevScore) >= PLATEAU.minGain ? 1 : 0)
      st.critic = undefined
    }
    if (st.plateau) {
      await this.label('plateau', st.plateau.exampleId, i.score - st.plateau.last >= PLATEAU.minGain ? 1 : 0)
      st.plateau = undefined
    }
    st.scores.push(i.score)
    if (set.gates === 'off') return { stop: false }
    // The loop stops by itself at the target or on the last round: nothing to decide.
    if (i.remaining <= 0 || i.score >= i.threshold) return { stop: false }
    const criticTokens = estimateCriticTokens({ images: 5 })
    const v = plateauVerdict(st.scores, { threshold: i.threshold, remaining: i.remaining, criticTokens })
    const features = plateauFeatures({ lab: i.lab, scores: st.scores, threshold: i.threshold, remaining: i.remaining, changes: i.changes, summary: i.summary })
    const m = await this.consult('plateau', features)
    const modelOutcome = m.p === undefined ? undefined : m.p >= 0.5 ? 'continue' : 'stop'
    const outcome = m.decides && modelOutcome ? modelOutcome : v.outcome
    const stop = set.gates === 'on' && outcome === 'stop'
    await this.record({
      lab: i.lab,
      entryId: i.entryId,
      gate: 'plateau',
      mode: set.gates,
      inputs: `${v.reason}; ${i.remaining} round${i.remaining === 1 ? '' : 's'} left`,
      outcome: outcome === 'stop' ? (stop ? 'stopped early' : 'would stop') : 'continue',
      acted: stop,
      by: m.decides ? 'model' : 'code',
      ...(v.sure ? {} : { unsure: true }),
      ...(m.p !== undefined ? { modelP: m.p } : {}),
      ...(modelOutcome && modelOutcome !== outcome ? { modelSays: modelOutcome } : {}),
      tokensSaved: outcome === 'stop' ? Math.max(0, i.remaining) * criticTokens : 0
    })
    if (!stop) st.plateau = { exampleId: await this.addExample('plateau', features, v.outcome === 'continue' ? 1 : 0), last: i.score }
    return stop ? { stop, reason: v.reason } : { stop }
  }

  async retry(i: { lab: LabId; entryId?: string; message: string; repairs: number; lastMessage?: string; kind?: FailureKind; legacy?: RetryOutcome }): Promise<{ outcome: RetryOutcome; ticket: string }> {
    const set = this.settings()
    // The caller's kind drives the v0.5 behaviour; the gate also reads the message (a recorded
    // "script error" that is really a Lune timeout is not worth a repair).
    const given = i.kind ?? classifyFailure(i.message)
    const legacy = i.legacy ?? legacyRetry(given, i.repairs)
    const read = classifyFailure(i.message)
    const kind: FailureKind = given === 'script-error' && (read === 'timeout' || read === 'runtime-missing') ? read : given
    if (set.gates === 'off') return { outcome: legacy, ticket: '' }
    const sameAsLast = !!i.lastMessage && i.lastMessage.trim() === i.message.trim()
    const v = retryVerdict({ kind, repairs: i.repairs, sameAsLast }, estimateComposeTokens())
    const features = retryFeatures({ lab: i.lab, kind, repairs: i.repairs, sameAsLast, message: i.message })
    const m = await this.consult('retry', features)
    let outcome: RetryOutcome = v.outcome
    if (m.decides && m.p !== undefined) outcome = m.p < 0.5 ? 'give-up' : v.outcome !== 'give-up' ? v.outcome : kind === 'no-script' || kind === 'parse' ? 'rephrase' : 'retry'
    // Hard bound whatever the model says.
    if (i.repairs >= 2) outcome = 'give-up'
    const taken = set.gates === 'on' ? outcome : legacy
    await this.record({
      lab: i.lab,
      ...(i.entryId ? { entryId: i.entryId } : {}),
      gate: 'retry',
      mode: set.gates,
      inputs: `${kind}: ${i.message.slice(0, 100)}; ${i.repairs} repair${i.repairs === 1 ? '' : 's'} so far`,
      outcome: set.gates === 'on' ? outcome : outcome === legacy ? legacy : `would ${outcome} (did ${legacy})`,
      acted: set.gates === 'on' && outcome !== legacy,
      by: m.decides ? 'model' : 'code',
      ...(v.sure ? {} : { unsure: true }),
      ...(m.p !== undefined ? { modelP: m.p } : {}),
      tokensSaved: outcome === 'give-up' && legacy !== 'give-up' ? estimateComposeTokens() : 0
    })
    const ticket = taken === 'give-up' ? '' : await this.addExample('retry', features, v.outcome !== 'give-up' ? 1 : 0)
    return { outcome: taken, ticket }
  }

  retryResult(ticket: string, ok: boolean): void {
    if (ticket) void this.label('retry', ticket, ok ? 1 : 0)
  }

  // ------------------------------------------------------------ principle weights (shadow)

  // Learned principle weights reach the critics only when gates are on (off = the v0.5 behaviour:
  // applied directly). In shadow the would-be change is logged.
  weightsApplied(): boolean {
    return this.settings().gates !== 'shadow'
  }

  async logWeightChange(lab: LabId, entryId: string, before: Record<string, number>, after: Record<string, number>): Promise<void> {
    const mode: GateMode = this.settings().gates
    if (mode === 'off') return
    const ids = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    const moved = ids
      .map((id) => ({ id, a: before[id] ?? 1, b: after[id] ?? 1 }))
      .filter((x) => Math.abs(x.b - x.a) >= 0.01)
      .sort((x, y) => Math.abs(y.b - y.a) - Math.abs(x.b - x.a))
    if (!moved.length) return
    await this.record({
      lab,
      entryId,
      gate: 'principle-weights',
      mode,
      inputs: moved.slice(0, 4).map((x) => `${x.id} ${x.a.toFixed(2)}→${x.b.toFixed(2)}`).join(', ') + (moved.length > 4 ? ` +${moved.length - 4}` : ''),
      outcome: mode === 'on' ? 'applied' : 'would apply',
      acted: mode === 'on',
      by: 'code',
      tokensSaved: 0
    })
  }

  // ------------------------------------------------------------ cost accounting

  // Runs fn as one lab run: model calls inside (also background work it starts) charge this run.
  withRun<T>(lab: LabId, entryId: string | undefined, fn: () => T): T {
    return this.als.run({ lab, entryId, buffered: [] }, fn)
  }

  // The entry id of the current run became known (compose): buffered charges move to it.
  attach(entryId: string): void {
    const ctx = this.als.getStore()
    if (!ctx || ctx.entryId) return
    ctx.entryId = entryId
    const pending = ctx.buffered.splice(0)
    for (const p of pending) void this.charge(p.tier, p.u)
  }

  // One model call's usage (tokens + cost) for the current run; outside a run it is ignored.
  async charge(tier: CostTier, u: UsageCharge): Promise<void> {
    const ctx = this.als.getStore()
    if (!ctx) return
    if (!ctx.entryId) {
      ctx.buffered.push({ tier, u })
      return
    }
    const s = await this.load()
    s.runs = chargeRun(s.runs, ctx.lab, ctx.entryId, tier, u, this.now())
    void this.save(['costs.json'])
    this.changed(ctx.lab, ctx.entryId)
  }

  async kept(lab: LabId, entryId: string, kept: boolean): Promise<void> {
    const s = await this.load()
    const before = s.runs.find((r) => r.lab === lab && r.entryId === entryId)?.kept ?? false
    if (before === kept) return
    s.runs = markKept(s.runs, lab, entryId, kept, this.now())
    void this.save(['costs.json'])
    this.changed(lab, entryId)
  }

  // ------------------------------------------------------------ view

  async view(filter: { lab?: LabId; entryId?: string; limit?: number } = {}): Promise<GatingView> {
    const s = await this.load()
    const limit = Math.max(1, Math.min(200, filter.limit ?? 40))
    const decisions = s.decisions.filter((d) => (!filter.lab || d.lab === filter.lab) && (!filter.entryId || d.entryId === filter.entryId)).slice(-limit).reverse()
    return { settings: this.settings(), models: await this.modelStatus(), costs: costRows(s.runs, s.decisions), decisions }
  }

  async reset(): Promise<void> {
    const s = await this.load()
    s.decisions = []
    s.runs = []
    await this.save(['decisions.json', 'costs.json'])
    this.changed()
  }
}
