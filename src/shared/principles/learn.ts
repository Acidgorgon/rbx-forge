// Learning which principles the user cares about from their thumbs up / down and notes.
//
// Each rating comes with the rated result's per-principle scores. Within one result, a principle that
// scored below that result's own mean is one of its weak points. A thumbs down on a result whose weak
// point was arcs is evidence the user cares about arcs (its weight goes up); a thumbs up on a result
// with weak arcs is evidence they do not mind (it goes down a little, and its strong points go up).
// That is an online estimate of the correlation between "this principle was weak" and "the user
// disliked it", relative to the other principles. Mentions in the user's notes ("floaty", "pops at
// the end") push the matching principles up directly. Weights stay in [MIN_WEIGHT, MAX_WEIGHT]; the
// profile is recomputed from the stored feedback, so it is deterministic and survives sync merges.

import { ALL_PRINCIPLES, principle } from './catalog.ts'
import type { PrincipleEvidence, PrincipleFeedback, PrincipleProfile, PrincipleWeights } from './types.ts'

export const MIN_WEIGHT = 0.4
export const MAX_WEIGHT = 2.5
export const LEARN_RATE = 0.6
export const NOTE_BOOST = { down: 0.25, up: 0.12 }
export const MAX_FEEDBACK = 300

const r2 = (x: number) => Math.round(x * 100) / 100

// Principle ids the user's notes point at (by the catalogue's words).
export function noteMentions(text: string | undefined, ids?: string[]): string[] {
  if (!text?.trim()) return []
  const pool = ids ? ids.map((id) => principle(id)).filter((p): p is NonNullable<typeof p> => !!p) : ALL_PRINCIPLES
  return pool.filter((p) => p.words.test(text)).map((p) => p.id)
}

// Mentions limited to the domains of the rated result's principles (a thumbnail note about "colour"
// does not move the VFX hue principle, and the other way round).
function feedbackMentions(fb: Pick<PrincipleFeedback, 'scores' | 'notes'>): string[] {
  const domains = new Set(Object.keys(fb.scores).map((id) => principle(id)?.domain).filter(Boolean))
  const hits = noteMentions(fb.notes)
  return domains.size ? hits.filter((id) => domains.has(principle(id)?.domain)) : hits
}

export function emptyProfile(at = 0): PrincipleProfile {
  return { version: 1, updatedAt: at, ratings: 0, weights: {}, evidence: {} }
}

// One rating's update of the weights (in place).
export function applyFeedback(weights: PrincipleWeights, fb: Pick<PrincipleFeedback, 'rating' | 'scores' | 'notes'>): void {
  const ids = Object.keys(fb.scores).filter((id) => principle(id) && Number.isFinite(fb.scores[id]))
  const sign = fb.rating === 'down' ? 1 : -1
  if (ids.length >= 2) {
    const mean = ids.reduce((s, id) => s + fb.scores[id], 0) / ids.length
    for (const id of ids) {
      const weak = (mean - fb.scores[id]) / 10
      weights[id] = (weights[id] ?? 1) + sign * LEARN_RATE * weak
    }
  }
  // Notes: mentioned principles count for this user (whichever way they rated).
  for (const id of feedbackMentions(fb)) weights[id] = (weights[id] ?? 1) + (fb.rating === 'down' ? NOTE_BOOST.down : NOTE_BOOST.up)
  for (const id of Object.keys(weights)) weights[id] = Math.max(MIN_WEIGHT, Math.min(MAX_WEIGHT, weights[id]))
}

// The whole profile from the stored feedback (oldest first).
export function learnProfile(feedback: PrincipleFeedback[], now = Date.now()): PrincipleProfile {
  const sorted = [...feedback].sort((a, b) => a.at - b.at).slice(-MAX_FEEDBACK)
  const weights: PrincipleWeights = {}
  const ev: Record<string, PrincipleEvidence & { upSum: number; downSum: number }> = {}
  const get = (id: string) => (ev[id] ??= { n: 0, up: 0, down: 0, mentions: 0, upMean: null, downMean: null, upSum: 0, downSum: 0 })
  for (const fb of sorted) {
    applyFeedback(weights, fb)
    for (const [id, s] of Object.entries(fb.scores)) {
      if (!principle(id) || !Number.isFinite(s)) continue
      const e = get(id)
      e.n++
      if (fb.rating === 'up') (e.up++, (e.upSum += s))
      else (e.down++, (e.downSum += s))
    }
    for (const id of feedbackMentions(fb)) get(id).mentions++
  }
  const evidence: Record<string, PrincipleEvidence> = {}
  for (const [id, e] of Object.entries(ev)) evidence[id] = { n: e.n, up: e.up, down: e.down, mentions: e.mentions, upMean: e.up ? r2(e.upSum / e.up) : null, downMean: e.down ? r2(e.downSum / e.down) : null }
  const rounded: PrincipleWeights = {}
  for (const [id, w] of Object.entries(weights)) if (Math.abs(w - 1) >= 0.005) rounded[id] = r2(w)
  return { version: 1, updatedAt: sorted.length ? Math.max(now, sorted[sorted.length - 1].at) : now, ratings: sorted.length, weights: rounded, evidence }
}

// The user's top priorities as text (memory note and the assistant).
export function prioritiesText(profile: PrincipleProfile, max = 6): string {
  const ws = Object.entries(profile.weights).sort((a, b) => b[1] - a[1])
  const up = ws.filter(([, w]) => w > 1.05).slice(0, max)
  const down = ws.filter(([, w]) => w < 0.95).slice(-3).reverse()
  const name = (id: string) => `${principle(id)?.name ?? id} (${id}, x${profile.weights[id].toFixed(2)})`
  const lines = [`Principle priorities learned from ${profile.ratings} rating${profile.ratings === 1 ? '' : 's'} in the VFX Lab, Animation Lab and Ability Composer.`]
  lines.push(up.length ? `The user cares most about: ${up.map(([id]) => name(id)).join('; ')}.` : 'No strong priorities yet (all principles count equally).')
  if (down.length) lines.push(`They mind less about: ${down.map(([id]) => name(id)).join('; ')}.`)
  lines.push('The lab critics weigh principle scores by these weights and the refine loops fix the highest-weight low scores first.')
  return lines.join('\n')
}
