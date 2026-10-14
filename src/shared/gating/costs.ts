// Cost per kept result: every lab run (one entry: compose + refine, or a critique) collects the
// tokens and cost of its model calls per tier; the run counts as kept when the user rates the result
// up, saves or exports it. "Cost per kept" = all the lab's spend / kept results, so failed and
// discarded runs are paid for by the ones that were kept. Pure (test/gating.test.ts).

import { COST_TIERS, LAB_IDS, type CostTier, type GateDecision, type LabCostRow, type LabId, type LabRun, type TierUsage } from './types.ts'

export const MAX_RUNS = 600

export interface UsageCharge {
  input: number
  output: number
  // undefined = no price known (tokens still counted).
  costUsd?: number
}

export function emptyTier(): TierUsage {
  return { calls: 0, input: 0, output: 0, costUsd: 0, unpriced: 0 }
}

// Adds one call to a run (new run when missing). Returns a new list (oldest dropped past MAX_RUNS).
export function chargeRun(runs: LabRun[], lab: LabId, entryId: string, tier: CostTier, u: UsageCharge, at: number): LabRun[] {
  const i = runs.findIndex((r) => r.lab === lab && r.entryId === entryId)
  const run: LabRun = i >= 0 ? { ...runs[i], tiers: { ...runs[i].tiers } } : { lab, entryId, at, updatedAt: at, tiers: {}, kept: false }
  const t = { ...(run.tiers[tier] ?? emptyTier()) }
  t.calls++
  t.input += Math.max(0, Math.round(u.input || 0))
  t.output += Math.max(0, Math.round(u.output || 0))
  if (u.costUsd === undefined || !Number.isFinite(u.costUsd)) t.unpriced++
  else t.costUsd = Math.round((t.costUsd + Math.max(0, u.costUsd)) * 1e8) / 1e8
  run.tiers[tier] = t
  run.updatedAt = at
  const next = i >= 0 ? runs.map((r, j) => (j === i ? run : r)) : [...runs, run]
  return next.slice(-MAX_RUNS)
}

// Marks a run kept (or not). Unknown entries get an empty run so a kept result without model calls
// (a built-in example, a hand-made move) still counts.
export function markKept(runs: LabRun[], lab: LabId, entryId: string, kept: boolean, at: number): LabRun[] {
  const i = runs.findIndex((r) => r.lab === lab && r.entryId === entryId)
  if (i < 0) return kept ? [...runs, { lab, entryId, at, updatedAt: at, tiers: {}, kept: true, keptAt: at }].slice(-MAX_RUNS) : runs
  return runs.map((r, j) => (j === i ? { ...r, kept, ...(kept ? { keptAt: r.keptAt ?? at } : { keptAt: undefined }), updatedAt: at } : r))
}

const tokensOf = (t: TierUsage | undefined) => (t ? t.input + t.output : 0)
const per = (x: number, kept: number) => (kept ? Math.round((x / kept) * 1e6) / 1e6 : null)

// One row per lab: spend, kept count, cost per kept (overall and per tier), gate savings.
export function costRows(runs: LabRun[], decisions: GateDecision[] = []): LabCostRow[] {
  return LAB_IDS.map((lab) => {
    const mine = runs.filter((r) => r.lab === lab)
    const kept = mine.filter((r) => r.kept).length
    const tiers: LabCostRow['tiers'] = {}
    let cost = 0
    let tokens = 0
    let unpriced = 0
    for (const tier of COST_TIERS) {
      const all = mine.map((r) => r.tiers[tier]).filter((t): t is TierUsage => !!t)
      if (!all.length) continue
      const c = all.reduce((s, t) => s + t.costUsd, 0)
      const tk = all.reduce((s, t) => s + tokensOf(t), 0)
      const calls = all.reduce((s, t) => s + t.calls, 0)
      unpriced += all.reduce((s, t) => s + t.unpriced, 0)
      cost += c
      tokens += tk
      tiers[tier] = { calls, costUsd: Math.round(c * 1e6) / 1e6, tokens: tk, costPerKept: per(c, kept) }
    }
    const ds = decisions.filter((d) => d.lab === lab)
    return {
      lab,
      runs: mine.length,
      kept,
      costUsd: Math.round(cost * 1e6) / 1e6,
      tokens,
      costPerKept: per(cost, kept),
      tokensPerKept: kept ? Math.round(tokens / kept) : null,
      tiers,
      saved: ds.filter((d) => d.acted).reduce((s, d) => s + d.tokensSaved, 0),
      wouldSave: ds.filter((d) => !d.acted && d.mode === 'shadow').reduce((s, d) => s + d.tokensSaved, 0),
      decisions: ds.length,
      unpriced
    }
  })
}

export function formatUsd(n: number | null | undefined): string {
  if (n === null || n === undefined) return '—'
  if (n === 0) return '$0'
  if (n < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

export function formatTokens(n: number): string {
  return n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}
