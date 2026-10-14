// Per-principle scores: parsing the critic's "principles" list, merging it with the code checks,
// the weighted principle score (catalogue base x the user's learned weight), the blend with a lab's
// rubric score, the focus (lowest-scoring, highest-weight principles) and putting the changes that
// raise the focus principles first so the refine loops fix those before anything else.

import { principle } from './catalog.ts'
import type { PrincipleCheck, PrincipleScore, PrincipleWeights } from './types.ts'

const r1 = (x: number) => Math.round(x * 10) / 10
const clamp10 = (x: number) => Math.max(0, Math.min(10, x))
const wOf = (weights: PrincipleWeights | undefined, id: string) => (weights && Number.isFinite(weights[id]) ? weights[id] : 1)

// How much of the overall score comes from the principles (the rest is the lab's rubric).
export const PRINCIPLE_SHARE = 0.5
// Principles at or above this are not refine targets.
export const FOCUS_BELOW = 8

function extractJson(raw: string): Record<string, unknown> | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

// The critic's "principles": [{id, score, note, fix}] (from raw text or parsed JSON). Unknown ids and
// ids outside `allowed` (when given) are dropped; scores are clamped to 0..10.
export function parsePrincipleScores(raw: string | Record<string, unknown> | null | undefined, allowed?: string[]): PrincipleCheck[] {
  const data = typeof raw === 'string' ? extractJson(raw) : raw
  const list = data && Array.isArray((data as { principles?: unknown }).principles) ? ((data as { principles: unknown[] }).principles as Record<string, unknown>[]) : []
  const out: PrincipleCheck[] = []
  for (const x of list) {
    if (!x || typeof x !== 'object') continue
    const id = String(x.id ?? '').trim()
    if (!principle(id) || (allowed && !allowed.includes(id)) || out.some((o) => o.id === id)) continue
    const s = Number(x.score)
    if (!Number.isFinite(s)) continue
    out.push({ id, score: r1(clamp10(s)), note: String(x.note ?? '').slice(0, 300), ...(x.fix ? { fix: String(x.fix).slice(0, 300) } : {}) })
  }
  return out.slice(0, 16)
}

// Critic and code scores per principle. When both judged one, the score is their mean (a vision
// critic cannot see an arc it was not shown; the numbers cannot see appeal) and the note keeps both.
export function mergePrincipleScores(critic: PrincipleCheck[], code: PrincipleCheck[]): PrincipleScore[] {
  const out = new Map<string, PrincipleScore>()
  for (const c of critic) out.set(c.id, { id: c.id, score: c.score, note: c.note, ...(c.fix ? { fix: c.fix } : {}), source: 'critic' })
  for (const m of code) {
    const prev = out.get(m.id)
    if (!prev) {
      out.set(m.id, { id: m.id, score: r1(m.score), note: m.note, ...(m.fix ? { fix: m.fix } : {}), source: 'code' })
      continue
    }
    out.set(m.id, { id: m.id, score: r1((prev.score + m.score) / 2), note: prev.note ? `${prev.note} · measured: ${m.note}` : m.note, ...(prev.fix || m.fix ? { fix: prev.fix ?? m.fix } : {}), source: 'both', measured: r1(m.score) })
  }
  return [...out.values()]
}

// Effective weight of a principle: catalogue base x the user's learned weight.
export function principleWeight(id: string, weights?: PrincipleWeights): number {
  return (principle(id)?.base ?? 1) * wOf(weights, id)
}

// Weighted mean of the principle scores (null when there are none).
export function principleOverall(scores: Pick<PrincipleScore, 'id' | 'score'>[], weights?: PrincipleWeights): number | null {
  let s = 0
  let w = 0
  for (const x of scores) {
    const k = principleWeight(x.id, weights)
    s += x.score * k
    w += k
  }
  return w > 0 ? r1(s / w) : null
}

export function blendOverall(rubric: number, principles: number | null, share = PRINCIPLE_SHARE): number {
  return principles == null ? rubric : r1(rubric * (1 - share) + principles * share)
}

// What to fix first: the principles with the largest weighted shortfall ((10 - score) x weight),
// below FOCUS_BELOW, most urgent first.
export function focusPrinciples(scores: Pick<PrincipleScore, 'id' | 'score'>[], weights?: PrincipleWeights, n = 3): string[] {
  return scores
    .filter((s) => s.score < FOCUS_BELOW)
    .map((s) => ({ id: s.id, need: (10 - s.score) * principleWeight(s.id, weights) }))
    .sort((a, b) => b.need - a.need || a.id.localeCompare(b.id))
    .slice(0, n)
    .map((x) => x.id)
}

// Changes that raise a focus principle come first (in focus order), then the untagged ones, then the
// rest; stable within each group.
export function orderChanges<T extends { principle?: string }>(changes: T[], focus: string[]): T[] {
  const rank = (c: T) => {
    if (!c.principle) return focus.length
    const i = focus.indexOf(c.principle)
    return i >= 0 ? i : focus.length + 1
  }
  return changes.map((c, i) => ({ c, i, r: rank(c) })).sort((a, b) => a.r - b.r || a.i - b.i).map((x) => x.c)
}

// The principle id a change names ("principle": "arcs"), when it is a known one.
export function changePrinciple(c: Record<string, unknown>): string | undefined {
  const id = typeof c.principle === 'string' ? c.principle.trim() : ''
  return principle(id) ? id : undefined
}

export interface PrincipleResult {
  principles: PrincipleScore[]
  principleScore: number | null
  focus: string[]
  overall: number
}

// One step for a lab's critique: merge critic + code scores, weigh them, blend into the overall,
// pick the focus.
export function scorePrinciples(rubricOverall: number, critic: PrincipleCheck[], code: PrincipleCheck[], weights?: PrincipleWeights): PrincipleResult {
  const principles = mergePrincipleScores(critic, code)
  const principleScore = principleOverall(principles, weights)
  return { principles, principleScore, focus: focusPrinciples(principles, weights), overall: blendOverall(rubricOverall, principleScore) }
}

// Compact one-line summary for prompts and memory ("arcs 4.2, timing 6.0, ...").
export function scoresLine(scores: Pick<PrincipleScore, 'id' | 'score'>[], max = 8): string {
  return [...scores].sort((a, b) => a.score - b.score).slice(0, max).map((s) => `${s.id} ${s.score.toFixed(1)}`).join(', ')
}
