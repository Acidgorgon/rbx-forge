// The user's thumbnail taste (pure): which measurable traits their liked / shipped / high-CTR
// thumbnails have more of than the disliked / low-CTR ones. Thumbs up / down count 1, "would ship"
// 1.5 and CTR labels 1..4 (ctr.ts), so real click data outweighs opinions. The weights rank
// variations in pick-best-of-N and become a short "taste" line in the generation prompt; the
// per-principle weights are learned separately by the principles service from the same ratings.

import { codeOverall } from './checks.ts'
import { ctrLabels } from './ctr.ts'
import type { TasteView, Thumb } from './types.ts'

export const TASTE_FEATURES: Record<string, { label: string; more: string; less: string }> = {
  saturation: { label: 'saturation', more: 'more saturated colour', less: 'calmer, less saturated colour' },
  contrast: { label: 'contrast', more: 'harder value contrast', less: 'softer contrast' },
  colorfulness: { label: 'colourfulness', more: 'more colourful palettes', less: 'fewer colours' },
  clutter: { label: 'clutter', more: 'busier, detailed scenes', less: 'cleaner, simpler backgrounds' },
  centre: { label: 'centred subject', more: 'the subject in the centre', less: 'off-centre compositions' },
  legible: { label: 'small-size legibility', more: 'bold shapes that read at phone size', less: '' },
  focal: { label: 'focal contrast', more: 'one strongly separated subject', less: '' },
  pop: { label: 'page pop', more: 'colours that pop off the page', less: '' }
}

export function tasteFeatures(t: Pick<Thumb, 'stats' | 'report'>): Record<string, number> {
  const s = t.stats
  const r = t.report
  return {
    saturation: s.saturation,
    contrast: Math.min(1, s.contrast / 0.3),
    colorfulness: s.colorfulness,
    clutter: Math.min(1, s.edgeDensity / 0.3),
    centre: Math.min(1, Math.max(0, (s.centerFocus - 0.8) / 0.8)),
    legible: r.legibility160 / 10,
    focal: r.focal160 / 10,
    pop: Math.min(r.popDark, r.popLight)
  }
}

export interface TasteSample {
  features: Record<string, number>
  label: 1 | -1
  weight: number
  ctr?: boolean
}

export interface TasteProfile {
  samples: number
  ctrSamples: number
  // Feature -> preference (-1..1): positive = the user prefers more of it.
  weights: Record<string, number>
}

export function tasteSamples(thumbs: Thumb[]): TasteSample[] {
  const out: TasteSample[] = []
  for (const t of thumbs) {
    const f = tasteFeatures(t)
    if (t.rating) out.push({ features: f, label: t.rating === 'up' ? 1 : -1, weight: 1 })
    if (t.ship) out.push({ features: f, label: 1, weight: 1.5 })
  }
  const byId = new Map(thumbs.map((t) => [t.id, t]))
  for (const c of ctrLabels(thumbs)) {
    const t = byId.get(c.id)
    if (t) out.push({ features: tasteFeatures(t), label: c.label, weight: c.weight, ctr: true })
  }
  return out
}

// Weighted mean of the liked minus the disliked, per feature, scaled to -1..1 and shrunk toward 0
// while there are few samples (k / (k + 4)).
export function learnTaste(samples: TasteSample[]): TasteProfile {
  const weights: Record<string, number> = {}
  const pos = samples.filter((s) => s.label > 0)
  const neg = samples.filter((s) => s.label < 0)
  const wmean = (list: TasteSample[], k: string) => {
    const w = list.reduce((a, s) => a + s.weight, 0)
    return w ? list.reduce((a, s) => a + s.weight * (s.features[k] ?? 0), 0) / w : null
  }
  const all = samples.reduce((a, s) => a + s.weight, 0)
  const shrink = all / (all + 4)
  for (const k of Object.keys(TASTE_FEATURES)) {
    const p = wmean(pos, k)
    const n = wmean(neg, k)
    // Only liked (or only disliked) examples: use the difference from a neutral 0.5 at half strength.
    const diff = p != null && n != null ? p - n : p != null ? (p - 0.5) * 0.5 : n != null ? (0.5 - n) * 0.5 : 0
    const v = Math.max(-1, Math.min(1, diff * 3 * shrink))
    if (Math.abs(v) >= 0.02) weights[k] = Math.round(v * 100) / 100
  }
  return { samples: samples.length, ctrSamples: samples.filter((s) => s.ctr).length, weights }
}

// -1..1: how well a thumbnail matches the taste (0 when nothing is learned).
export function tasteScore(t: Pick<Thumb, 'stats' | 'report'>, taste: TasteProfile): number {
  const f = tasteFeatures(t)
  let s = 0
  let w = 0
  for (const [k, v] of Object.entries(taste.weights)) {
    s += v * ((f[k] ?? 0.5) - 0.5) * 2
    w += Math.abs(v)
  }
  return w ? Math.max(-1, Math.min(1, s / w)) : 0
}

export function tasteLines(taste: TasteProfile, max = 3): string[] {
  return Object.entries(taste.weights)
    .filter(([, v]) => Math.abs(v) >= 0.15)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([k, v]) => (v > 0 ? TASTE_FEATURES[k]?.more : TASTE_FEATURES[k]?.less))
    .filter((x): x is string => !!x)
    .slice(0, max)
    .map((x) => `prefers ${x}`)
}

export function tasteView(taste: TasteProfile): TasteView {
  return { samples: taste.samples, ctrSamples: taste.ctrSamples, weights: taste.weights, lines: tasteLines(taste, 6) }
}

// The ranking score of a variation: the critique (or the code checks when there is none), plus up to
// one point of taste; anything the copy guard flagged drops out of contention.
export function rankScore(t: Thumb, taste: TasteProfile, codeChecks?: { score: number }[]): number {
  const base = t.critique?.overall ?? (codeChecks ? codeOverall(codeChecks.map((c, i) => ({ id: String(i), note: '', score: c.score }))) : 5)
  const flagged = (t.critique?.copyFlags.length ?? 0) > 0 ? 4 : 0
  return Math.round((base + tasteScore(t, taste) - flagged) * 100) / 100
}

export function pickBest(thumbs: Thumb[], taste: TasteProfile): string | undefined {
  let best: Thumb | undefined
  let bestScore = -Infinity
  for (const t of thumbs) {
    const s = rankScore(t, taste)
    if (s > bestScore) (best = t), (bestScore = s)
  }
  return best?.id
}
