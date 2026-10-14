import type { Aggregation, DateRange, Granularity, Series, SeriesPoint } from './types.ts'

// Date ranges, bucketing and aggregation shared by every source. All times are UTC (the Analytics
// Query API buckets in UTC).

const DAY = 86_400_000

export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

export function dayStart(ms: number): number {
  return Math.floor(ms / DAY) * DAY
}

export function parseTime(text: string): number {
  const t = /^\d{4}-\d{2}-\d{2}$/.test(text) ? Date.parse(text + 'T00:00:00Z') : Date.parse(text)
  if (Number.isNaN(t)) throw new Error(`Not a date: ${text}`)
  return t
}

// Range syntax for tools and IPC:
//   "7d" | "28d" | "90d"            the last N complete UTC days (ending at the start of today)
//   "12w" | "6m"                    weeks / 30-day months, same anchoring
//   "2026-09-01..2026-09-30"        inclusive start and inclusive end day
//   { start, end }                  inclusive start, exclusive end (already resolved)
// `lagDays` moves the end back (the dashboard and API are usually 1-2 days behind).
export function resolveRange(spec: string | DateRange | undefined, now: number, lagDays = 0): DateRange {
  if (spec && typeof spec === 'object') return { start: spec.start, end: spec.end }
  const text = (spec ?? '28d').trim().toLowerCase()
  const end = dayStart(now) - lagDays * DAY
  const rel = /^(\d+)\s*([dwm])$/.exec(text)
  if (rel) {
    const n = Number(rel[1])
    const days = rel[2] === 'd' ? n : rel[2] === 'w' ? n * 7 : n * 30
    if (days <= 0 || days > 1468) throw new Error(`Range ${spec} is out of bounds (1..1468 days)`)
    return { start: isoDay(end - days * DAY), end: isoDay(end) }
  }
  const abs = /^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|\/)\s*(\d{4}-\d{2}-\d{2})$/.exec(text)
  if (abs) {
    const s = parseTime(abs[1])
    const e = parseTime(abs[2]) + DAY
    if (e <= s) throw new Error(`Range ${spec} ends before it starts`)
    return { start: isoDay(s), end: isoDay(e) }
  }
  throw new Error(`Unrecognised range "${spec}". Use e.g. "7d", "28d", "12w" or "2026-09-01..2026-09-30".`)
}

// The range of equal length immediately before `range`.
export function previousRange(range: DateRange): DateRange {
  const s = parseTime(range.start)
  const e = parseTime(range.end)
  return { start: isoDay(s - (e - s)), end: isoDay(s) }
}

// Range covering both, for one query that is split locally (saves rate-limited API calls).
export function unionRange(a: DateRange, b: DateRange): DateRange {
  return {
    start: parseTime(a.start) <= parseTime(b.start) ? a.start : b.start,
    end: parseTime(a.end) >= parseTime(b.end) ? a.end : b.end
  }
}

export function inRange(t: string, range: DateRange): boolean {
  const ms = parseTime(t)
  return ms >= parseTime(range.start) && ms < parseTime(range.end)
}

export function sliceSeries(series: Series, range: DateRange): Series {
  return { ...series, points: series.points.filter((p) => inRange(p.t, range)) }
}

// Start of the bucket containing `ms`. Weeks start on Monday (ISO), months on the 1st.
export function bucketStart(ms: number, granularity: Granularity): number {
  switch (granularity) {
    case 'minute':
      return Math.floor(ms / 60_000) * 60_000
    case 'halfhour':
      return Math.floor(ms / 1_800_000) * 1_800_000
    case 'hour':
      return Math.floor(ms / 3_600_000) * 3_600_000
    case 'day':
      return dayStart(ms)
    case 'week': {
      const d = dayStart(ms)
      const dow = (new Date(d).getUTCDay() + 6) % 7 // Monday = 0
      return d - dow * DAY
    }
    case 'month': {
      const date = new Date(ms)
      return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
    }
    case 'total':
      return 0
  }
}

export function formatBucket(ms: number, granularity: Granularity): string {
  if (granularity === 'minute' || granularity === 'halfhour' || granularity === 'hour') return new Date(ms).toISOString().slice(0, 16) + 'Z'
  return isoDay(ms)
}

export function aggregate(values: number[], how: Aggregation): number | null {
  if (!values.length) return null
  switch (how) {
    case 'sum':
      return values.reduce((a, b) => a + b, 0)
    case 'mean':
      return values.reduce((a, b) => a + b, 0) / values.length
    case 'last':
      return values[values.length - 1]
    case 'max':
      return Math.max(...values)
  }
}

// Re-buckets a finer series into a coarser granularity using the metric's aggregation.
export function rebucket(series: Series, granularity: Granularity, range?: DateRange): Series {
  if (series.granularity === granularity) return series
  const groups = new Map<number, SeriesPoint[]>()
  for (const p of [...series.points].sort((a, b) => parseTime(a.t) - parseTime(b.t))) {
    const key = granularity === 'total' ? 0 : bucketStart(parseTime(p.t), granularity)
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }
  const points: SeriesPoint[] = []
  for (const [key, list] of [...groups.entries()].sort((a, b) => a[0] - b[0])) {
    const v = aggregate(list.map((p) => p.v), series.aggregation)
    if (v === null) continue
    const t = granularity === 'total' ? (range?.start ?? list[0].t) : formatBucket(key, granularity)
    const flagged = list.find((p) => p.flag)
    points.push(flagged ? { t, v, flag: flagged.flag } : { t, v })
  }
  return { ...series, granularity, points }
}

// The API omits days with no activity. For additive metrics, fill interior gaps with 0 so sums and
// week-over-week math are right; never pad the tail (that is usually data not landed yet).
export function fillInteriorGaps(series: Series): Series {
  if (series.aggregation !== 'sum' || series.granularity !== 'day' || series.points.length < 2) return series
  const sorted = [...series.points].sort((a, b) => parseTime(a.t) - parseTime(b.t))
  const out: SeriesPoint[] = []
  for (let i = 0; i < sorted.length; i++) {
    out.push(sorted[i])
    if (i + 1 < sorted.length) {
      for (let t = parseTime(sorted[i].t) + DAY; t < parseTime(sorted[i + 1].t); t += DAY) out.push({ t: isoDay(t), v: 0 })
    }
  }
  return { ...series, points: out }
}

// One number for a series over its points, using the metric's aggregation.
export function summarise(series: Series): number | null {
  return aggregate(series.points.map((p) => p.v), series.aggregation)
}

// Rounds for compact output: 3 significant decimals for small values, integers for big ones.
export function round(v: number): number {
  if (!Number.isFinite(v)) return v
  const abs = Math.abs(v)
  if (abs >= 1000) return Math.round(v)
  if (abs >= 10) return Math.round(v * 10) / 10
  if (abs >= 1) return Math.round(v * 100) / 100
  return Math.round(v * 10000) / 10000
}

export function pct(change: number | null): string {
  if (change === null || !Number.isFinite(change)) return 'n/a'
  const p = change * 100
  return `${p >= 0 ? '+' : ''}${Math.abs(p) >= 10 ? p.toFixed(0) : p.toFixed(1)}%`
}

// Compact text for agents: one header line and the values in order, with the start date and step
// instead of a date per point. Gaps ("_") and flagged points ("~" projected, "?" insignificant) are
// marked so nothing is silently invented.
export function compactSeries(series: Series, range?: DateRange): string {
  const label = series.breakdown ? ` [${Object.entries(series.breakdown).map(([k, v]) => `${k}=${v}`).join(',')}]` : ''
  const total = summarise(series)
  const head = `${series.metric}${label} ${series.granularity} src=${series.source} unit=${series.unit} agg=${series.aggregation} n=${series.points.length}${total === null ? '' : ` ${series.aggregation}=${round(total)}`}`
  if (!series.points.length) return `${head}\n(no data${range ? ` for ${range.start}..${range.end}` : ''})`
  if (series.granularity === 'total') return `${head}\n${series.points.map((p) => round(p.v) + mark(p)).join(' ')}`
  const sorted = [...series.points].sort((a, b) => parseTime(a.t) - parseTime(b.t))
  const step = stepMs(series.granularity)
  const values: string[] = []
  let expected = parseTime(sorted[0].t)
  for (const p of sorted) {
    const at = parseTime(p.t)
    if (step) {
      while (expected < at && values.length < 5000) {
        values.push('_')
        expected = nextBucket(expected, series.granularity)
      }
      expected = nextBucket(at, series.granularity)
    }
    values.push(round(p.v) + mark(p))
  }
  return `${head}\nfrom ${sorted[0].t} every ${series.granularity}: ${values.join(' ')}`
}

function mark(p: SeriesPoint): string {
  return p.flag === 'projected' ? '~' : p.flag === 'insignificant' ? '?' : ''
}

function stepMs(g: Granularity): number {
  return g === 'minute' ? 60_000 : g === 'halfhour' ? 1_800_000 : g === 'hour' ? 3_600_000 : g === 'day' ? DAY : g === 'week' ? 7 * DAY : g === 'month' ? 1 : 0
}

function nextBucket(ms: number, g: Granularity): number {
  if (g === 'month') {
    const d = new Date(ms)
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
  }
  return ms + stepMs(g)
}
