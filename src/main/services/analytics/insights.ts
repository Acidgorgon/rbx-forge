import { metricInfo } from './metrics.ts'
import { aggregate, isoDay, parseTime, pct, round } from './series.ts'
import type { DateRange, ReleaseMarker, Series, Signal, SignalSeverity } from './types.ts'

// Simple, explainable signals computed without an LLM. Every signal carries the numbers it is based on
// so an agent (or person) can check it, and the thresholds are fixed and stated here:
//  - change below 5% is noise (info), 5-15% is notable (warn/good), 15%+ is strong (bad/good)
//  - an anomaly is a last point 3+ standard deviations from the trailing 28-point mean (needs 14+ points)
//  - a release impact compares the mean of N days before and after a release (needs 3+ points each side)

const DAY = 86_400_000
export const NOTABLE = 0.05
export const STRONG = 0.15

export function relChange(current: number | null | undefined, previous: number | null | undefined): number | null {
  if (current === null || current === undefined || previous === null || previous === undefined) return null
  if (previous === 0) return current === 0 ? 0 : null
  return (current - previous) / Math.abs(previous)
}

export function valueIn(series: Series, range: DateRange): number | null {
  const s = parseTime(range.start)
  const e = parseTime(range.end)
  return aggregate(series.points.filter((p) => {
    const t = parseTime(p.t)
    return t >= s && t < e
  }).map((p) => p.v), series.aggregation)
}

// Severity of a change for a metric, using which direction is good for it.
export function severityOf(metric: string, change: number | null): SignalSeverity {
  if (change === null || Math.abs(change) < NOTABLE) return 'info'
  const better = metricInfo(metric).better
  if (better === 'none') return 'info'
  const good = better === 'up' ? change > 0 : change < 0
  if (good) return 'good'
  return Math.abs(change) >= STRONG ? 'bad' : 'warn'
}

// Last 7 points vs the 7 before, anchored on the last data point (not today), so dashboard lag does not
// read as a drop. Daily series only.
export function weekOverWeek(series: Series): Signal | null {
  if (series.granularity !== 'day' || series.points.length < 8) return null
  const last = parseTime(series.points[series.points.length - 1].t)
  const cur: DateRange = { start: isoDay(last - 6 * DAY), end: isoDay(last + DAY) }
  const prev: DateRange = { start: isoDay(last - 13 * DAY), end: isoDay(last - 6 * DAY) }
  const c = valueIn(series, cur)
  const p = valueIn(series, prev)
  const change = relChange(c, p)
  if (change === null) return null
  const info = metricInfo(series.metric)
  return {
    id: `wow:${series.metric}${breakdownKey(series)}`,
    metric: series.metric,
    severity: severityOf(series.metric, change),
    text: `${info.label}${breakdownLabel(series)} ${pct(change)} week over week (${round(p!)} -> ${round(c!)}, ${series.aggregation} of ${cur.start}..${isoDay(last)} vs the 7 days before).`,
    evidence: { current: round(c!), previous: round(p!), change: round(change), currentStart: cur.start, currentEnd: isoDay(last), previousStart: prev.start }
  }
}

export function comparePeriods(series: Series, a: DateRange, b: DateRange): { a: number | null; b: number | null; change: number | null } {
  const va = valueIn(series, a)
  const vb = valueIn(series, b)
  return { a: va, b: vb, change: relChange(va, vb) }
}

// Mean and sample standard deviation.
export function meanStd(values: number[]): { mean: number; std: number } {
  const mean = values.reduce((x, y) => x + y, 0) / (values.length || 1)
  const variance = values.length > 1 ? values.reduce((x, y) => x + (y - mean) ** 2, 0) / (values.length - 1) : 0
  return { mean, std: Math.sqrt(variance) }
}

export function anomaly(series: Series, window = 28, threshold = 3): Signal | null {
  const pts = series.points.filter((p) => p.flag !== 'insignificant')
  if (pts.length < 15) return null
  const last = pts[pts.length - 1]
  const base = pts.slice(-1 - window, -1).map((p) => p.v)
  if (base.length < 14) return null
  const { mean, std } = meanStd(base)
  if (std === 0) return null
  const z = (last.v - mean) / std
  if (Math.abs(z) < threshold) return null
  const change = relChange(last.v, mean)
  const info = metricInfo(series.metric)
  const sev = severityOf(series.metric, change)
  return {
    id: `anomaly:${series.metric}${breakdownKey(series)}:${last.t}`,
    metric: series.metric,
    severity: sev === 'info' ? 'warn' : sev,
    text: `${info.label}${breakdownLabel(series)} on ${last.t} is unusual: ${round(last.v)} vs a ${base.length}-point mean of ${round(mean)} (z=${z.toFixed(1)}).`,
    evidence: { value: round(last.v), mean: round(mean), std: round(std), z: round(z), at: last.t }
  }
}

// Retention: recent cohorts vs the cohorts before them. The API's forward retention for day t is the
// cohort that first played on t; a cohort is only final after `maturity` days, so the newest
// `maturity` days are excluded (callers may already have dropped them).
export function retentionDelta(series: Series, maturity: number, cohortDays = 7, now?: number): Signal | null {
  // Cohort day t is final once day t + maturity has fully passed.
  const cutoff = now !== undefined ? now - (maturity + 1) * DAY : Infinity
  const pts = series.points.filter((p) => parseTime(p.t) <= cutoff)
  if (pts.length < cohortDays * 2) return null
  const recent = pts.slice(-cohortDays).map((p) => p.v)
  const before = pts.slice(-cohortDays * 2, -cohortDays).map((p) => p.v)
  const c = recent.reduce((a, b) => a + b, 0) / recent.length
  const p = before.reduce((a, b) => a + b, 0) / before.length
  const change = relChange(c, p)
  const info = metricInfo(series.metric)
  return {
    id: `retention:${series.metric}`,
    metric: series.metric,
    severity: severityOf(series.metric, change),
    text: `${info.label}: last ${cohortDays} matured cohorts average ${round(c)} vs ${round(p)} for the ${cohortDays} before (${pct(change)}; cohorts ${pts[pts.length - cohortDays].t}..${pts[pts.length - 1].t}).`,
    evidence: { recent: round(c), previous: round(p), change: change === null ? null : round(change), firstRecentCohort: pts[pts.length - cohortDays].t, lastCohort: pts[pts.length - 1].t }
  }
}

// Mean before vs after each release. Uses the release day itself as the first "after" day.
export function releaseImpact(series: Series, releases: ReleaseMarker[], windowDays = 7): Signal[] {
  if (series.granularity !== 'day') return []
  const out: Signal[] = []
  for (const r of releases) {
    const at = Math.floor(parseTime(r.at) / DAY) * DAY
    const before = series.points.filter((p) => {
      const t = parseTime(p.t)
      return t >= at - windowDays * DAY && t < at
    })
    const after = series.points.filter((p) => {
      const t = parseTime(p.t)
      return t >= at && t < at + windowDays * DAY
    })
    if (before.length < 3 || after.length < 3) continue
    const b = before.reduce((x, p) => x + p.v, 0) / before.length
    const a = after.reduce((x, p) => x + p.v, 0) / after.length
    const change = relChange(a, b)
    const info = metricInfo(series.metric)
    out.push({
      id: `release:${r.tag}:${series.metric}`,
      metric: series.metric,
      severity: severityOf(series.metric, change),
      text: `${info.label} averaged ${round(b)} in the ${before.length} days before ${r.tag} (${isoDay(at)}) and ${round(a)} in the ${after.length} days after (${pct(change)}).`,
      evidence: { release: r.tag, releaseDay: isoDay(at), before: round(b), after: round(a), change: change === null ? null : round(change), daysBefore: before.length, daysAfter: after.length }
    })
  }
  return out
}

export interface FunnelNumbers {
  impressions?: number | null
  plays?: number | null
  qualifiedPlays?: number | null
  dau?: number | null
  payers?: number | null
  revenue?: number | null
  newUsers?: number | null
}

// Derived conversion rates from period totals. Rates are null when a denominator is missing or 0.
export function conversionRates(n: FunnelNumbers): Record<string, number | null> {
  const div = (a?: number | null, b?: number | null) => (a === null || a === undefined || !b ? null : a / b)
  return {
    playsPerImpressionUser: div(n.plays, n.impressions),
    qualifiedShareOfPlays: div(n.qualifiedPlays, n.plays),
    payerConversion: div(n.payers, n.dau),
    revenuePerDau: div(n.revenue, n.dau),
    revenuePerPayer: div(n.revenue, n.payers)
  }
}

// Signals for a set of daily series (keyed by metric).
export function signalsFor(series: Series[], releases: ReleaseMarker[] = [], now?: number): Signal[] {
  const out: Signal[] = []
  for (const s of series) {
    if (s.metric in { ForwardD1Retention: 1, ForwardD7Retention: 1, ForwardD30Retention: 1 }) {
      const maturity = s.metric === 'ForwardD1Retention' ? 1 : s.metric === 'ForwardD7Retention' ? 7 : 30
      const r = retentionDelta(s, maturity, 7, now)
      if (r) out.push(r)
    } else {
      const w = weekOverWeek(s)
      if (w) out.push(w)
    }
    const a = anomaly(s)
    if (a) out.push(a)
    out.push(...releaseImpact(s, releases).filter((sig) => sig.severity !== 'info'))
  }
  const rank: Record<SignalSeverity, number> = { bad: 0, warn: 1, good: 2, info: 3 }
  return out.sort((x, y) => rank[x.severity] - rank[y.severity])
}

export function formatSignals(signals: Signal[], max = 12): string {
  if (!signals.length) return 'signals: none (not enough data or nothing moved 5%+)'
  const icon: Record<SignalSeverity, string> = { bad: '[!!]', warn: '[!]', good: '[+]', info: '[i]' }
  const lines = signals.slice(0, max).map((s) => `${icon[s.severity]} ${s.text}`)
  if (signals.length > max) lines.push(`(+${signals.length - max} more)`)
  return 'signals:\n' + lines.join('\n')
}

function breakdownKey(s: Series): string {
  return s.breakdown ? ':' + Object.values(s.breakdown).join('/') : ''
}

function breakdownLabel(s: Series): string {
  return s.breakdown ? ` (${Object.entries(s.breakdown).filter(([k]) => !k.endsWith('Label')).map(([, v]) => v).join(', ')})` : ''
}
