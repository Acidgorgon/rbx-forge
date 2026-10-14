// Features for the decision models, built from numbers the gates already compute. Every feature is
// a plain number; names are stable (a renamed feature means a retrain, which the version check and
// the feature list in the model file handle). Text-shaped inputs (the critique summary, the compose
// error) become keyword / regex counts: no embeddings, no downloads.

import type { FailureKind } from '../gating/gates.ts'
import type { LabId } from '../gating/types.ts'

const DONE = /\b(polished|shippable|ship it|excellent|front-page|strong|great|clean|reads (well|clearly)|well[- ]timed|solid|convincing|nailed)\b/gi
const PROBLEM = /\b(lacks?|missing|weak|muddy|pops?( out| off)?|floaty|flat|stiff|blown out|noisy|unclear|mushy|uniform blob|too (much|little|fast|slow|long|short|big|small))\b/gi
const MINOR = /\b(minor|small|slight(ly)?|tweak|nudge|a touch)\b/gi
const NEG = /\b(not|no|never|without)\b/gi

const count = (re: RegExp, text: string) => (text.match(re) ?? []).length

export function textFeatures(text: string | undefined, prefix: string): Record<string, number> {
  const t = String(text ?? '')
  return {
    [`${prefix}_done`]: count(DONE, t),
    [`${prefix}_problem`]: count(PROBLEM, t),
    [`${prefix}_minor`]: count(MINOR, t),
    [`${prefix}_neg`]: count(NEG, t),
    [`${prefix}_len`]: Math.min(1, t.length / 600)
  }
}

function labFeatures(lab: LabId): Record<string, number> {
  return { lab_vfx: lab === 'vfx' ? 1 : 0, lab_anim: lab === 'anim' ? 1 : 0, lab_ability: lab === 'ability' ? 1 : 0 }
}

// "Is this critique worth running?" (before the critic).
export function criticSkipFeatures(i: { lab: LabId; diff: number; hash: number; comparable: boolean; iteration: number; prevScore: number | null; prevGain: number | null; changes: number; threshold: number; heuristicSkip: boolean }): Record<string, number> {
  return {
    ...labFeatures(i.lab),
    diff: Math.min(1, i.diff),
    diff_log: Math.log10(Math.max(1e-4, i.diff)),
    hash: i.hash / 64,
    comparable: i.comparable ? 1 : 0,
    iteration: i.iteration,
    prev_score: (i.prevScore ?? 5) / 10,
    prev_gain: (i.prevGain ?? 0) / 10,
    changes: i.changes,
    gap: (i.threshold - (i.prevScore ?? 0)) / 10,
    heuristic_skip: i.heuristicSkip ? 1 : 0
  }
}

// "Will another round help?" (after a critique).
export function plateauFeatures(i: { lab: LabId; scores: number[]; threshold: number; remaining: number; changes: number; summary?: string }): Record<string, number> {
  const s = i.scores
  const n = s.length
  const last = s[n - 1] ?? 0
  let flat = 0
  for (let k = n - 1; k > 0 && Math.abs(s[k] - s[k - 1]) < 0.25; k--) flat++
  return {
    ...labFeatures(i.lab),
    score: last / 10,
    gain1: n >= 2 ? (last - s[n - 2]) / 10 : 0,
    gain2: n >= 3 ? (s[n - 2] - s[n - 3]) / 10 : 0,
    flat_rounds: flat,
    gap: (i.threshold - last) / 10,
    iteration: n,
    remaining: i.remaining,
    changes: i.changes,
    ...textFeatures(i.summary, 'sum')
  }
}

// "Will a repair work?" (a failed compose).
export function retryFeatures(i: { lab: LabId; kind: FailureKind; repairs: number; sameAsLast: boolean; message: string }): Record<string, number> {
  const m = i.message
  return {
    ...labFeatures(i.lab),
    k_no_script: i.kind === 'no-script' ? 1 : 0,
    k_parse: i.kind === 'parse' ? 1 : 0,
    k_script: i.kind === 'script-error' ? 1 : 0,
    k_infra: i.kind === 'timeout' || i.kind === 'runtime-missing' || i.kind === 'model-error' ? 1 : 0,
    repairs: i.repairs,
    same: i.sameAsLast ? 1 : 0,
    has_line: /line \d+|:\d+:/.test(m) ? 1 : 0,
    nil_index: /attempt to (index|call) (a )?nil|nil value/i.test(m) ? 1 : 0,
    unknown_name: /unknown|not a valid member|undefined|no such/i.test(m) ? 1 : 0,
    msg_len: Math.min(1, m.length / 300)
  }
}
