// Manual CTR per uploaded thumbnail (pure): validating an entry (impressions, clicks from Creator
// Hub analytics or a thumbnail A/B result), totals, a confidence-aware lower bound, and the label it
// gives the taste model. A CTR label is stronger than a thumbs up: real players clicked.

import type { CtrRecord, Thumb } from './types.ts'

export class CtrError extends Error {}

export function normalizeCtr(input: { impressions: unknown; clicks: unknown; period?: unknown; note?: unknown }, at: number): CtrRecord {
  const impressions = Number(input.impressions)
  const clicks = Number(input.clicks)
  if (!Number.isFinite(impressions) || !Number.isInteger(impressions) || impressions <= 0) throw new CtrError('Impressions must be a whole number above 0.')
  if (!Number.isFinite(clicks) || !Number.isInteger(clicks) || clicks < 0) throw new CtrError('Clicks must be a whole number, 0 or more.')
  if (clicks > impressions) throw new CtrError('Clicks cannot be more than impressions.')
  if (impressions > 1e11) throw new CtrError('Impressions look too large.')
  const period = String(input.period ?? '').trim().slice(0, 40)
  const note = String(input.note ?? '').trim().slice(0, 200)
  return { at, impressions, clicks, ...(period ? { period } : {}), ...(note ? { note } : {}) }
}

export function ctrOf(r: Pick<CtrRecord, 'impressions' | 'clicks'>): number {
  return r.impressions > 0 ? r.clicks / r.impressions : 0
}

export function ctrTotals(records: CtrRecord[]): { impressions: number; clicks: number; ctr: number | null } {
  const impressions = records.reduce((s, r) => s + r.impressions, 0)
  const clicks = records.reduce((s, r) => s + r.clicks, 0)
  return { impressions, clicks, ctr: impressions ? clicks / impressions : null }
}

// Wilson score interval (95%) for a click rate.
export function wilson(clicks: number, impressions: number, z = 1.96): { low: number; high: number } {
  if (impressions <= 0) return { low: 0, high: 1 }
  const p = clicks / impressions
  const d = 1 + (z * z) / impressions
  const c = p + (z * z) / (2 * impressions)
  const m = z * Math.sqrt((p * (1 - p)) / impressions + (z * z) / (4 * impressions * impressions))
  return { low: Math.max(0, (c - m) / d), high: Math.min(1, (c + m) / d) }
}

export function formatCtr(rate: number | null): string {
  return rate == null ? '–' : `${(rate * 100).toFixed(rate < 0.1 ? 2 : 1)}%`
}

// Labels from CTR across the user's thumbnails: above the median (by the interval, not the point
// estimate) is +1, below is -1; weight grows with impressions (1..4, vs 1 for a thumbs up / down).
// Needs at least two thumbnails with data to compare; thin data (under 200 impressions) is skipped.
export function ctrLabels(thumbs: Pick<Thumb, 'id' | 'ctr'>[]): { id: string; label: 1 | -1; weight: number; ctr: number }[] {
  const rows = thumbs
    .map((t) => ({ id: t.id, ...ctrTotals(t.ctr) }))
    .filter((r) => r.impressions >= 200 && r.ctr != null) as { id: string; impressions: number; clicks: number; ctr: number }[]
  if (rows.length < 2) return []
  const sorted = rows.map((r) => r.ctr).sort((a, b) => a - b)
  const mid = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2
  const out: { id: string; label: 1 | -1; weight: number; ctr: number }[] = []
  for (const r of rows) {
    const w = wilson(r.clicks, r.impressions)
    const weight = Math.round(Math.min(4, 1 + Math.log10(r.impressions / 100)) * 100) / 100
    if (w.low > mid) out.push({ id: r.id, label: 1, weight, ctr: r.ctr })
    else if (w.high < mid) out.push({ id: r.id, label: -1, weight, ctr: r.ctr })
  }
  return out
}
