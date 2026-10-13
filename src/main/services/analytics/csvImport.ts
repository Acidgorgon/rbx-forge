import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { metricInfo, resolveMetricName } from './metrics.ts'
import { isoDay, parseTime } from './series.ts'
import type { CsvImportResult, Granularity, ImportSummary, Series, SeriesPoint } from './types.ts'

// Creator Dashboard CSV import, for data the Analytics Query API does not expose (or for creators
// without an API key). What the dashboard exports (create.roblox.com/docs/production/analytics/analytics-dashboard):
//  - KPI charts: the chart's Export button saves a .csv with "timestamps and values of each datapoint
//    per KPI". The exact column layout is not documented, so the parser is layout-tolerant: it finds the
//    header row, the date column, and treats every numeric column as a series (wide) or splits by
//    text columns (long / breakdown).
//  - Sales: a .zip of .csv sales data, regenerated every 48 hours. Its columns are not documented
//    either; rows with repeated dates are treated as a transaction log and summed per day and item
//    into csv.salesRobux and csv.salesCount (Unzip first; Forge does not read .zip).
// Header text is mapped to API metric names where it matches a known label or alias
// ("Daily Active Users" -> DailyActiveUsers); anything else becomes "csv.<slug>".

// ---------------------------------------------------------------- CSV tokenising

export function parseCsv(text: string): { rows: string[][]; delimiter: string } {
  const clean = text.replace(/^﻿/, '')
  const firstLines = clean.split(/\r?\n/).slice(0, 10).join('\n')
  const counts = [',', ';', '\t'].map((d) => [d, countOutsideQuotes(firstLines, d)] as const)
  const delimiter = counts.sort((a, b) => b[1] - a[1])[0][1] > 0 ? counts[0][0] : ','
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i]
    if (quoted) {
      if (ch === '"') {
        if (clean[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
      continue
    }
    if (ch === '"' && cell === '') quoted = true
    else if (ch === delimiter) {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && clean[i + 1] === '\n') i++
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
    } else cell += ch
  }
  if (cell !== '' || row.length) {
    row.push(cell)
    rows.push(row)
  }
  return { rows: rows.map((r) => r.map((c) => c.trim())).filter((r) => r.some((c) => c !== '')), delimiter }
}

function countOutsideQuotes(text: string, d: string): number {
  let n = 0
  let q = false
  for (const ch of text) {
    if (ch === '"') q = !q
    else if (!q && ch === d) n++
  }
  return n
}

// ---------------------------------------------------------------- value parsing

const MONTHS: Record<string, number> = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, sept: 8, oct: 9, nov: 10, dec: 11 }

// Returns UTC ms, or undefined. `dayFirst` resolves 01/02/2026 ambiguity (default month-first, as the
// dashboard's US locale writes it; the importer flips it when a first part > 12 is seen).
export function parseDateCell(raw: string, dayFirst = false): number | undefined {
  const s = raw.trim().replace(/^"|"$/g, '')
  if (!s) return undefined
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?\s*(Z|UTC|[+-]\d{2}:?\d{2})?$/i.exec(s)
  if (m) {
    const [, y, mo, d, h = '0', mi = '0', se = '0', tz] = m
    const base = Date.UTC(+y, +mo - 1, +d, +h, +mi, +se)
    return valid(+mo, +d) ? base - tzOffset(tz) : undefined
  }
  m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2,4})(?:[ T,]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(am|pm)?)?$/i.exec(s)
  if (m) {
    let [, a, b, y, h = '0', mi = '0', se = '0', ampm] = m
    const year = y.length === 2 ? 2000 + Number(y) : Number(y)
    let month = Number(a)
    let day = Number(b)
    if (dayFirst || month > 12) [month, day] = [day, month]
    let hour = Number(h)
    if (ampm) hour = (hour % 12) + (ampm.toLowerCase() === 'pm' ? 12 : 0)
    return valid(month, day) ? Date.UTC(year, month - 1, day, hour, Number(mi), Number(se)) : undefined
  }
  m = /^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{4})$/.exec(s)
  if (m && MONTHS[m[1].slice(0, 3).toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[1].slice(0, 3).toLowerCase()], +m[2])
  m = /^(\d{1,2})\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})$/.exec(s)
  if (m && MONTHS[m[2].slice(0, 3).toLowerCase()] !== undefined) return Date.UTC(+m[3], MONTHS[m[2].slice(0, 3).toLowerCase()], +m[1])
  return undefined
}

function valid(month: number, day: number): boolean {
  return month >= 1 && month <= 12 && day >= 1 && day <= 31
}

function tzOffset(tz: string | undefined): number {
  if (!tz || /^(z|utc)$/i.test(tz)) return 0
  const m = /^([+-])(\d{2}):?(\d{2})$/.exec(tz)
  if (!m) return 0
  return (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) * 60_000
}

// Numbers as the dashboard writes them: "1,234", "12.5%", "R$ 1,200", "$3.40", "1.2K", "—".
export function parseNumberCell(raw: string, europeanDecimal = false): { value: number; percent: boolean } | undefined {
  let s = raw.trim().replace(/^"|"$/g, '')
  if (!s || /^(—|–|-|n\/a|na|null|none)$/i.test(s)) return undefined
  const percent = s.endsWith('%')
  s = s.replace(/%$/, '').replace(/^(R\$|\$|€|£)\s*/, '').replace(/\s*(robux|R\$)$/i, '').replace(/\s/g, '')
  let mult = 1
  const suffix = /^(-?[\d.,]+)([kKmMbB])$/.exec(s)
  if (suffix) {
    s = suffix[1]
    mult = { k: 1e3, m: 1e6, b: 1e9 }[suffix[2].toLowerCase() as 'k' | 'm' | 'b']
  }
  if (europeanDecimal) s = s.replace(/\./g, '').replace(',', '.')
  else s = s.replace(/,/g, '')
  if (!/^-?\d*\.?\d+(e-?\d+)?$/i.test(s)) return undefined
  const value = Number(s) * mult
  return Number.isFinite(value) ? { value, percent } : undefined
}

// ---------------------------------------------------------------- normalising

export interface ParsedCsv {
  series: Series[]
  labels: Record<string, string>
  warnings: string[]
}

export interface CsvOptions {
  // Metric to use when headers do not name one (e.g. the chart the person exported).
  metricHint?: string
  fileName?: string
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 60) || 'value'
}

function inferGranularity(times: number[]): Granularity {
  const uniq = [...new Set(times)].sort((a, b) => a - b)
  if (uniq.length < 2) return 'day'
  const diffs = uniq.slice(1).map((t, i) => t - uniq[i]).sort((a, b) => a - b)
  const median = diffs[Math.floor(diffs.length / 2)]
  const hours = median / 3_600_000
  if (hours < 0.75) return hours <= 1 / 60 + 1e-9 ? 'minute' : 'halfhour'
  if (hours < 12) return 'hour'
  const days = hours / 24
  if (days < 4) return 'day'
  if (days < 20) return 'week'
  return 'month'
}

function formatT(ms: number, g: Granularity): string {
  return g === 'minute' || g === 'halfhour' || g === 'hour' ? new Date(ms).toISOString().slice(0, 16) + 'Z' : isoDay(ms)
}

export function normaliseCsv(text: string, options: CsvOptions = {}): ParsedCsv {
  const warnings: string[] = []
  const { rows, delimiter } = parseCsv(text)
  if (rows.length < 2) return { series: [], labels: {}, warnings: ['The file has no data rows.'] }
  const european = delimiter === ';'

  // Day-first if any slash date has a first part > 12.
  const dayFirst = rows.some((r) => r.some((c) => /^(1[3-9]|2\d|3[01])[/.]\d{1,2}[/.]\d{2,4}/.test(c)))
  const isDate = (c: string) => parseDateCell(c, dayFirst) !== undefined

  // Header row: the last row before the first data row whose date column is not itself a date.
  let header = -1
  let dateCol = -1
  for (let i = 0; i < Math.min(rows.length - 1, 30); i++) {
    const next = rows[i + 1]
    const col = next.findIndex(isDate)
    if (col >= 0 && !isDate(rows[i][col] ?? '') && rows[i].filter(Boolean).length >= 2) {
      header = i
      dateCol = col
      break
    }
  }
  if (header < 0) {
    const col = rows[0].findIndex(isDate)
    if (col < 0) return { series: [], labels: {}, warnings: ['No date column found. Export the chart from the Creator Dashboard (Export button) and import that .csv.'] }
    dateCol = col
    rows.unshift(rows[0].map((_, i) => (i === col ? 'Date' : `Value${i === 0 ? '' : ' ' + i}`)))
    header = 0
    warnings.push('No header row; columns were named Value, Value 1, ...')
  }
  const headers = rows[header].map((h, i) => h || `Column ${i + 1}`)
  const data = rows.slice(header + 1).filter((r) => isDate(r[dateCol] ?? ''))
  const skipped = rows.length - header - 1 - data.length
  if (skipped > 0) warnings.push(`${skipped} row(s) without a date were skipped (totals or notes).`)

  // Column kinds.
  const numericCols: number[] = []
  const textCols: number[] = []
  headers.forEach((_, c) => {
    if (c === dateCol) return
    const cells = data.map((r) => r[c] ?? '').filter((v) => v !== '')
    if (!cells.length) return
    const numeric = cells.filter((v) => parseNumberCell(v, european) !== undefined).length
    if (numeric / cells.length >= 0.6) numericCols.push(c)
    else textCols.push(c)
  })
  if (!numericCols.length) return { series: [], labels: {}, warnings: [...warnings, 'No numeric columns found.'] }

  const times = data.map((r) => parseDateCell(r[dateCol], dayFirst)!)
  const hint = options.metricHint ? (resolveMetricName(options.metricHint) ?? options.metricHint) : options.fileName ? resolveMetricName(basename(options.fileName).replace(/\.[a-z]+$/i, '').replace(/[_-]+/g, ' ')) : undefined

  // Transaction log (sales export): repeated dates with text columns.
  const dayKeys = times.map((t) => isoDay(t))
  const repeatedDays = dayKeys.length - new Set(dayKeys).size
  const metricCol = textCols.find((c) => /^(metric|kpi|measure|series)$/i.test(headers[c]))
  const breakdownCols = textCols.filter((c) => c !== metricCol)
  const isLog = repeatedDays > 0 && breakdownCols.length > 0 && (breakdownCols.length > 2 || !breakdownCols.some((c) => uniqueDims(data, c) <= 50))
  const labels: Record<string, string> = {}
  const out = new Map<string, Series>()

  const push = (metric: string, label: string, breakdown: Record<string, string> | undefined, t: number, v: number, g: Granularity, unit?: string, agg?: Series['aggregation']) => {
    const key = metric + (breakdown ? JSON.stringify(breakdown) : '')
    let s = out.get(key)
    if (!s) {
      const info = metricInfo(metric)
      s = { metric, source: 'csv', granularity: g, unit: unit ?? info.unit, aggregation: agg ?? info.aggregation, points: [] }
      if (breakdown) s.breakdown = breakdown
      out.set(key, s)
      labels[metric] = label
    }
    s.points.push({ t: formatT(t, g), v })
  }

  if (isLog) {
    const g: Granularity = 'day'
    const itemCol = breakdownCols.find((c) => /(item|product|pass|asset)\s*(name)?$/i.test(headers[c]) || /^name$/i.test(headers[c])) ?? breakdownCols[0]
    const amountCol = numericCols.find((c) => /robux|revenue|earn|proceeds|amount|price/i.test(headers[c])) ?? numericCols[0]
    const sums = new Map<string, { t: number; item: string; robux: number; count: number }>()
    data.forEach((r, i) => {
      const day = Date.parse(dayKeys[i] + 'T00:00:00Z')
      const item = r[itemCol] || '(unknown)'
      const n = parseNumberCell(r[amountCol] ?? '', european)
      const key = `${day}|${item}`
      const agg = sums.get(key) ?? { t: day, item, robux: 0, count: 0 }
      agg.robux += n?.value ?? 0
      agg.count += 1
      sums.set(key, agg)
    })
    for (const s of sums.values()) {
      push('csv.salesRobux', `Sales (${headers[amountCol]})`, { Item: s.item }, s.t, s.robux, g, 'robux', 'sum')
      push('csv.salesCount', 'Sales count', { Item: s.item }, s.t, s.count, g, 'sales', 'sum')
    }
    warnings.push(`Read as a transaction log: summed "${headers[amountCol]}" per day per "${headers[itemCol]}". Check the columns if this is not a sales export.`)
  } else {
    const g = inferGranularity(times)
    for (const c of numericCols) {
      const resolved = resolveMetricName(headers[c])
      const wide = !metricCol && breakdownCols.length === 0
      // Column header names the metric; else a single value column takes the hint; else the column is a breakdown of the hint.
      let metric = resolved ?? (numericCols.length === 1 && hint ? hint : undefined)
      let colBreakdown: Record<string, string> | undefined
      if (!metric && hint && wide && numericCols.length > 1) {
        metric = hint
        colBreakdown = { Series: headers[c] }
      }
      metric ??= `csv.${slug(headers[c])}`
      let percentSeen = false
      data.forEach((r, i) => {
        const n = parseNumberCell(r[c] ?? '', european)
        if (!n) return
        percentSeen ||= n.percent
        const rowMetric = metricCol !== undefined ? (resolveMetricName(r[metricCol]) ?? `csv.${slug(r[metricCol])}`) : metric!
        const bd: Record<string, string> = { ...(colBreakdown ?? {}) }
        for (const b of breakdownCols) if (r[b]) bd[headers[b]] = r[b]
        if (metricCol !== undefined && numericCols.length > 1) bd.Column = headers[c]
        push(rowMetric, metricCol !== undefined ? r[metricCol] : headers[c], Object.keys(bd).length ? bd : undefined, times[i], n.value, g)
      })
      if (percentSeen) for (const s of out.values()) if (s.metric === metric && s.unit !== '%') s.unit = '%'
    }
  }

  // Duplicate timestamps within one series (re-exports, overlapping rows): keep the last.
  const series = [...out.values()].map((s) => {
    const byT = new Map<string, SeriesPoint>()
    for (const p of s.points) byT.set(p.t, p)
    return { ...s, points: [...byT.values()].sort((a, b) => parseTime(a.t) - parseTime(b.t)) }
  })
  if (!series.length) warnings.push('No values could be read.')
  return { series, labels, warnings }
}

function uniqueDims(data: string[][], c: number): number {
  return new Set(data.map((r) => r[c])).size
}

// ---------------------------------------------------------------- local store

interface StoredSeries extends Series {
  label: string
  importedAt: string
  file?: string
}

// Imported series live in the app's userData (per experience), never in the repo: dashboard numbers
// are private to the creator. One JSON file per metric+breakdown; re-imports merge by timestamp with
// the newer file winning.
export class ImportStore {
  private readonly dir: string
  private readonly now: () => number

  constructor(dir: string, now: () => number = Date.now) {
    this.dir = dir
    this.now = now
  }

  private fileFor(s: Pick<Series, 'metric' | 'breakdown'>): string {
    const b = s.breakdown ? '__' + slug(Object.entries(s.breakdown).map(([k, v]) => `${k}_${v}`).join('_')) : ''
    return join(this.dir, `${slug(s.metric)}${b}.json`)
  }

  importText(text: string, options: CsvOptions = {}): CsvImportResult {
    const parsed = normaliseCsv(text, options)
    const summaries: ImportSummary[] = []
    mkdirSync(this.dir, { recursive: true })
    for (const s of parsed.series) {
      const path = this.fileFor(s)
      const existing = this.readFile(path)
      const merged = new Map<string, SeriesPoint>()
      if (existing && existing.granularity === s.granularity) for (const p of existing.points) merged.set(p.t, p)
      for (const p of s.points) merged.set(p.t, p)
      const stored: StoredSeries = {
        ...s,
        points: [...merged.values()].sort((a, b) => parseTime(a.t) - parseTime(b.t)),
        label: parsed.labels[s.metric] ?? s.metric,
        importedAt: new Date(this.now()).toISOString(),
        file: options.fileName ? basename(options.fileName) : undefined
      }
      const temp = path + '.tmp'
      writeFileSync(temp, JSON.stringify(stored))
      renameSync(temp, path)
      summaries.push(summary(stored))
    }
    return { series: summaries, warnings: parsed.warnings }
  }

  importFile(path: string, options: Omit<CsvOptions, 'fileName'> = {}): CsvImportResult {
    if (/\.zip$/i.test(path)) return { series: [], warnings: ['Unzip the sales export first and import the .csv inside.'] }
    return this.importText(readFileSync(path, 'utf8'), { ...options, fileName: path })
  }

  private readFile(path: string): StoredSeries | undefined {
    try {
      return JSON.parse(readFileSync(path, 'utf8')) as StoredSeries
    } catch {
      return undefined
    }
  }

  all(): StoredSeries[] {
    if (!existsSync(this.dir)) return []
    return readdirSync(this.dir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => this.readFile(join(this.dir, f)))
      .filter((s): s is StoredSeries => !!s)
  }

  list(): ImportSummary[] {
    return this.all().map(summary)
  }

  // Series for a metric (all breakdowns, or the unbroken one when `breakdown` is false).
  get(metric: string): Series[] {
    return this.all()
      .filter((s) => s.metric === metric)
      .map(({ label: _l, importedAt: _i, file: _f, ...s }) => s)
  }

  remove(metric: string, breakdown?: Record<string, string>): boolean {
    const path = this.fileFor({ metric, breakdown })
    if (!existsSync(path)) return false
    rmSync(path)
    return true
  }
}

function summary(s: StoredSeries): ImportSummary {
  const out: ImportSummary = { metric: s.metric, label: s.label, points: s.points.length, importedAt: s.importedAt }
  if (s.points.length) {
    out.first = s.points[0].t
    out.last = s.points[s.points.length - 1].t
  }
  if (s.breakdown) out.breakdown = s.breakdown
  if (s.file) out.file = s.file
  return out
}
