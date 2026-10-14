// Learned decision models for the lab gates: one small logistic-regression classifier per decision
// type, trained on Forge's own gate log (features the gates computed + what the code heuristic
// decided + the outcome observed afterwards). Serialised as a small versioned JSON file per type.
//
// Activation rule: a model may override the heuristic only when it has at least `minExamples`
// labelled examples AND beats the heuristic's accuracy on held-out examples (every 5th example by
// time, never trained on for the comparison). Otherwise the heuristic decides.
//
// Primitives: yesNo (probability of the positive class), choice (softmax over options) and score
// (probability-weighted position over ordered levels).

import { applyPlatt, fitPlatt, fitSoftmax, fitStandardizer, predictProba, standardize, type Platt, type SoftmaxModel, type Standardizer } from './logistic.ts'

export const MODEL_VERSION = 1

export interface Example {
  id: string
  at: number
  features: Record<string, number>
  // What the code heuristic predicted, as a class index (same space as `label`).
  heuristic: number
  // Observed outcome (class index); undefined while pending.
  label?: number
}

export interface DecisionModelFile {
  version: number
  type: string
  classes: string[]
  features: string[]
  scaler: Standardizer
  model: SoftmaxModel
  platt?: Platt
  // Labelled examples used for the final model.
  n: number
  holdout: { n: number; modelAcc: number; heuristicAcc: number }
  trainedAt: number
}

export const HOLDOUT_EVERY = 5

const vec = (names: string[], f: Record<string, number>) => names.map((k) => (Number.isFinite(f[k]) ? f[k] : 0))

function fitAll(names: string[], rows: Example[], k: number): { scaler: Standardizer; model: SoftmaxModel; platt?: Platt } {
  const raw = rows.map((r) => vec(names, r.features))
  const scaler = fitStandardizer(raw)
  const X = raw.map((x) => standardize(scaler, x))
  const y = rows.map((r) => r.label as number)
  const model = fitSoftmax(X, y, k, { l2: 0.02, iterations: 400, rate: 0.5 })
  if (k !== 2) return { scaler, model }
  const ps = X.map((x) => predictProba(model, x)[1])
  return { scaler, model, platt: fitPlatt(ps, y) }
}

export function probabilities(file: Pick<DecisionModelFile, 'features' | 'scaler' | 'model' | 'platt' | 'classes'>, features: Record<string, number>): number[] {
  const p = predictProba(file.model, standardize(file.scaler, vec(file.features, features)))
  if (file.classes.length !== 2 || !file.platt) return p
  const p1 = applyPlatt(p[1], file.platt)
  return [1 - p1, p1]
}

// Trains on the labelled examples (oldest first). null when there is nothing to learn from yet
// (fewer than 10 labelled, or only one class seen).
export function trainDecisionModel(type: string, classes: string[], examples: Example[], now: number): DecisionModelFile | null {
  const rows = examples.filter((e) => e.label !== undefined && e.label >= 0 && e.label < classes.length).sort((a, b) => a.at - b.at)
  if (rows.length < 10 || new Set(rows.map((r) => r.label)).size < 2) return null
  const names = [...new Set(rows.flatMap((r) => Object.keys(r.features)))].sort()
  const test = rows.filter((_, i) => i % HOLDOUT_EVERY === HOLDOUT_EVERY - 1)
  const train = rows.filter((_, i) => i % HOLDOUT_EVERY !== HOLDOUT_EVERY - 1)
  let modelAcc = 0
  let heuristicAcc = 0
  if (test.length && new Set(train.map((r) => r.label)).size >= 2) {
    const part = fitAll(names, train, classes.length)
    const f = { features: names, classes, ...part }
    modelAcc = test.filter((r) => argmax(probabilities(f, r.features)) === r.label).length / test.length
    heuristicAcc = test.filter((r) => r.heuristic === r.label).length / test.length
  }
  const all = fitAll(names, rows, classes.length)
  return { version: MODEL_VERSION, type, classes, features: names, ...all, n: rows.length, holdout: { n: test.length, modelAcc: r3(modelAcc), heuristicAcc: r3(heuristicAcc) }, trainedAt: now }
}

const r3 = (x: number) => Math.round(x * 1000) / 1000

export function argmax(p: number[]): number {
  let best = 0
  for (let i = 1; i < p.length; i++) if (p[i] > p[best]) best = i
  return best
}

// May this model override the heuristic?
export function isActive(file: DecisionModelFile | null | undefined, minExamples: number): boolean {
  return !!file && file.n >= minExamples && file.holdout.n > 0 && file.holdout.modelAcc > file.holdout.heuristicAcc
}

// Validates a stored file (wrong version or shape -> null, so a stale file is retrained, not used).
export function parseModelFile(raw: unknown): DecisionModelFile | null {
  const f = raw as DecisionModelFile
  if (!f || typeof f !== 'object' || f.version !== MODEL_VERSION || !Array.isArray(f.classes) || !Array.isArray(f.features)) return null
  const k = f.classes.length
  const d = f.features.length
  const okNum = (a: unknown, n: number) => Array.isArray(a) && a.length === n && a.every((v) => typeof v === 'number' && Number.isFinite(v))
  if (k < 2 || !f.model || !Array.isArray(f.model.W) || f.model.W.length !== k || !f.model.W.every((w) => okNum(w, d)) || !okNum(f.model.b, k)) return null
  if (!f.scaler || !okNum(f.scaler.mean, d) || !okNum(f.scaler.std, d)) return null
  if (!f.holdout || typeof f.holdout.modelAcc !== 'number' || typeof f.holdout.heuristicAcc !== 'number') return null
  return f
}

// ------------------------------------------------------------------ primitives

export function yesNo(file: DecisionModelFile, features: Record<string, number>): number {
  return probabilities(file, features)[1]
}

export function choice(file: DecisionModelFile, features: Record<string, number>): { choice: string; probabilities: Record<string, number> } {
  const p = probabilities(file, features)
  return { choice: file.classes[argmax(p)], probabilities: Object.fromEntries(file.classes.map((c, i) => [c, r3(p[i])])) }
}

// classes are ordered levels; the score is the probability-weighted level index.
export function score(file: DecisionModelFile, features: Record<string, number>): number {
  return Math.round(probabilities(file, features).reduce((s, p, i) => s + p * i, 0) * 100) / 100
}
