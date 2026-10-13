import { join } from 'node:path'
import { lookupUniverseId } from '../release/openCloud.ts'
import { projectScope, readSecret } from '../release/secrets.ts'
import { listAlertIncidents, listDeveloperProducts, listGamePasses, type AlertIncident } from './catalog.ts'
import { ImportStore } from './csvImport.ts'
import { comparePeriods, conversionRates, relChange, signalsFor, valueIn } from './insights.ts'
import { METRICS, metricInfo, OVERVIEW_METRICS, PUBLIC_METRICS, RETENTION_MATURITY_DAYS } from './metrics.ts'
import { describeSnapshotSpan, fetchPublicStats, historySeries, PublicStatsPoller, readHistory } from './publicStats.ts'
import { AnalyticsApiError, AnalyticsQueryClient } from './queryClient.ts'
import { isoDay, parseTime, previousRange, rebucket, resolveRange, sliceSeries, unionRange } from './series.ts'
import type {
  AnalyticsStatus,
  CatalogItem,
  CsvImportResult,
  DateRange,
  FetchLike,
  Granularity,
  KpiDelta,
  MetricFilter,
  PublicSnapshot,
  PublicStats,
  ReleaseMarker,
  SecretStore,
  Series,
  SeriesSource,
  Signal,
  Sleep
} from './types.ts'

// Analytics facade: picks the best source per metric (Open Cloud API > imported dashboard CSV > Forge's
// public-stats history), and builds the overview / compare / acquisition reports the agent tools and
// the UI use. Main process only; no electron imports.

const DAY = 86_400_000

export const ANALYTICS_SECRET = 'openCloudAnalyticsKey'

export function analyticsSecretKey(root?: string): string {
  return root ? `analytics.${ANALYTICS_SECRET}.${projectScope(root)}` : `analytics.${ANALYTICS_SECRET}`
}

export interface AnalyticsServiceDeps {
  secrets: SecretStore
  // Per-user data directory for analytics (app userData/analytics). History and imports go in
  // <dataDir>/<universeId>/.
  dataDir: string
  // Project root, for project-scoped secrets.
  root?: string
  placeId?: number
  universeId?: number
  fetch?: FetchLike
  sleep?: Sleep
  now?: () => number
  // Release tags with dates (newest last), for release-impact signals and series annotations.
  getReleases?: () => Promise<ReleaseMarker[]>
  pollIntervalMinutes?: number
  // Called after each public-stats snapshot (wire to the analytics:snapshot event).
  onSnapshot?: (snapshot: PublicSnapshot) => void
  // Days the API/dashboard usually lags (default 1): relative ranges end this many days before today.
  lagDays?: number
}

export interface SeriesRequest {
  metric: string
  range?: string | DateRange
  granularity?: Granularity
  breakdown?: string[]
  filter?: MetricFilter[]
  limit?: number
  source?: 'auto' | SeriesSource
}

export interface SeriesResult {
  range: DateRange
  source: SeriesSource | null
  series: Series[]
  notes: string[]
  releases: ReleaseMarker[]
}

export interface OverviewResult {
  range: DateRange
  previous: DateRange
  kpis: KpiDelta[]
  signals: Signal[]
  live?: PublicStats
  notes: string[]
}

export interface CompareResult {
  a: DateRange
  b: DateRange
  rows: { metric: string; label: string; unit: string; source: SeriesSource | null; a: number | null; b: number | null; change: number | null }[]
  notes: string[]
}

export interface AcquisitionRow {
  source: string
  impressions: number | null
  impressionsPrev: number | null
  plays: number | null
  playsPrev: number | null
  qualifiedPlays: number | null
  playsPerImpression: number | null
  playsPerImpressionPrev: number | null
}

export interface AcquisitionResult {
  range: DateRange
  previous: DateRange
  bySource: AcquisitionRow[]
  totals: { impressions: number | null; plays: number | null; qualifiedPlays: number | null; impressionsChange: number | null; playsChange: number | null }
  homeRecs: { metric: string; label: string; current: number | null; previous: number | null; change: number | null }[]
  newVsReturning: { segment: string; dau: number | null; change: number | null }[]
  publicTrend: { newVisits: number | null; newVisitsChange: number | null; newFavorites: number | null; likeRatio: number | null }
  rates: Record<string, number | null>
  signals: Signal[]
  notes: string[]
}

// API-only metrics that have a rough public-history stand-in when there is no key.
const PUBLIC_FALLBACK: Record<string, string> = {
  Visits: 'public.visits',
  PeakConcurrentPlayers: 'public.playingPeak'
}

export class AnalyticsService {
  readonly client: AnalyticsQueryClient
  private readonly deps: AnalyticsServiceDeps
  private universe: number | undefined
  private poller: PublicStatsPoller | undefined
  private imports: ImportStore | undefined

  constructor(deps: AnalyticsServiceDeps) {
    this.deps = deps
    this.universe = deps.universeId
    this.client = new AnalyticsQueryClient({ getApiKey: () => this.apiKey(), fetch: deps.fetch, sleep: deps.sleep, now: deps.now })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  // ------------------------------------------------------------ config and secrets

  configure(next: { placeId?: number; universeId?: number; root?: string }): void {
    const changed = next.universeId !== this.universe || next.placeId !== this.deps.placeId
    Object.assign(this.deps, next)
    if (changed) {
      this.universe = next.universeId
      this.poller?.stop()
      this.poller = undefined
      this.imports = undefined
      this.client.clearCache()
    }
  }

  // Analytics key (project, then global), then the Release key (one key can carry both scopes).
  async apiKey(): Promise<string | undefined> {
    const s = this.deps.secrets
    if (this.deps.root) {
      const v = await s.get(analyticsSecretKey(this.deps.root))
      if (v) return v
    }
    return (await s.get(analyticsSecretKey())) ?? (this.deps.root ? await readSecret(s, 'openCloudApiKey', this.deps.root) : await s.get('release.openCloudApiKey'))
  }

  async setApiKey(key: string, scope: 'project' | 'global' = 'project'): Promise<void> {
    await this.deps.secrets.set(analyticsSecretKey(scope === 'project' ? this.deps.root : undefined), key.trim())
    this.client.clearCache()
  }

  async clearApiKey(scope: 'project' | 'global' = 'project'): Promise<void> {
    await this.deps.secrets.delete(analyticsSecretKey(scope === 'project' ? this.deps.root : undefined))
    this.client.clearCache()
  }

  async universeId(): Promise<number> {
    if (this.universe) return this.universe
    if (!this.deps.placeId) throw new Error('No experience configured. Set publish.placeId (or universeId) in .forge/project.json, or enter the place ID in the Analytics panel.')
    this.universe = await lookupUniverseId(this.deps.placeId, { fetch: this.deps.fetch, sleep: this.deps.sleep })
    return this.universe
  }

  private async dir(): Promise<string> {
    return join(this.deps.dataDir, String(await this.universeId()))
  }

  async importStore(): Promise<ImportStore> {
    if (!this.imports) this.imports = new ImportStore(join(await this.dir(), 'imports'), () => this.now())
    return this.imports
  }

  async publicPoller(): Promise<PublicStatsPoller> {
    if (!this.poller) {
      this.poller = new PublicStatsPoller({
        universeId: await this.universeId(),
        historyFile: join(await this.dir(), 'public.jsonl'),
        intervalMinutes: this.deps.pollIntervalMinutes,
        fetch: this.deps.fetch,
        sleep: this.deps.sleep,
        now: () => this.now(),
        onSnapshot: (snapshot) => this.deps.onSnapshot?.(snapshot)
      })
    }
    return this.poller
  }

  async status(): Promise<AnalyticsStatus> {
    let universeId: number | null = null
    try {
      universeId = await this.universeId()
    } catch {
      universeId = null
    }
    const hasApiKey = !!(await this.apiKey())
    const base: AnalyticsStatus = {
      universeId,
      placeId: this.deps.placeId ?? null,
      hasApiKey,
      poller: { running: false, intervalMinutes: this.deps.pollIntervalMinutes ?? 15, snapshots: 0 },
      imports: []
    }
    if (this.client.lastAuthProblem) base.apiProblem = this.client.lastAuthProblem
    if (universeId === null) return base
    const poller = await this.publicPoller()
    const history = poller.history()
    base.poller = { running: poller.running, intervalMinutes: poller.intervalMinutes, snapshots: history.length, lastAt: history[history.length - 1]?.at }
    base.imports = (await this.importStore()).list()
    return base
  }

  async releases(): Promise<ReleaseMarker[]> {
    try {
      return (await this.deps.getReleases?.()) ?? []
    } catch {
      return []
    }
  }

  // ------------------------------------------------------------ series

  resolveRange(range: string | DateRange | undefined): DateRange {
    return resolveRange(range, this.now(), this.deps.lagDays ?? 1)
  }

  async series(req: SeriesRequest): Promise<SeriesResult> {
    const range = this.resolveRange(req.range)
    const granularity = req.granularity ?? 'day'
    const notes: string[] = []
    const releases = (await this.releases()).filter((r) => {
      const t = parseTime(r.at)
      return t >= parseTime(range.start) && t < parseTime(range.end)
    })
    const want = req.source ?? 'auto'
    const metric = req.metric

    // Public snapshots are live, so relative ranges for them run up to today.
    const liveRange = resolveRange(req.range, this.now(), 0)
    if (metric.startsWith('public.') || want === 'public') {
      const m = metric.startsWith('public.') ? metric : PUBLIC_FALLBACK[metric]
      if (!m) throw new Error(`${metric} has no public-stats equivalent. Public metrics: ${PUBLIC_METRICS.join(', ')}`)
      return { range: liveRange, source: 'public', series: [await this.publicSeries(m, liveRange, granularity, notes)], notes, releases }
    }
    if (metric.startsWith('csv.') || want === 'csv') {
      return { range, source: 'csv', series: await this.csvSeries(metric, range, granularity, notes), notes, releases }
    }

    const info = metricInfo(metric)
    if (!info.known) notes.push(`${metric} is not in Forge's catalog; passed to the API as is (names are case-sensitive).`)
    if (!info.granularities.includes(granularity) && info.known) notes.push(`${metric} supports ${info.granularities.join('/')}; ${granularity} may be rejected.`)
    const oldest = this.now() - info.retentionDays * DAY
    if (parseTime(range.start) < oldest) notes.push(`${metric} keeps ${info.retentionDays} days of history; earlier days will be missing or rejected.`)

    if (await this.apiKey()) {
      try {
        const series = await this.client.metrics(await this.universeId(), { metric, range, granularity, breakdown: req.breakdown, filter: req.filter, limit: req.limit })
        return { range, source: 'api', series, notes, releases }
      } catch (error) {
        if (want === 'api' || !(error instanceof AnalyticsApiError) || !['no-key', 'unauthorized', 'forbidden'].includes(error.kind)) throw error
        notes.push(`API unavailable (${error.kind}): ${error.message}`)
      }
    } else if (want === 'api') {
      throw new AnalyticsApiError('no-key', 'No Open Cloud API key with universe.analytics:read is set for this experience.')
    } else {
      notes.push('No analytics API key set; using imported dashboard CSVs / public stats.')
    }

    const csv = await this.csvSeries(metric, range, granularity, notes)
    if (csv.some((s) => s.points.length)) return { range, source: 'csv', series: csv, notes, releases }
    const fallback = PUBLIC_FALLBACK[metric]
    if (fallback) {
      notes.push(`Using ${fallback} from Forge's public-stats snapshots as a stand-in for ${metric}.`)
      return { range: liveRange, source: 'public', series: [await this.publicSeries(fallback, liveRange, granularity, notes)], notes, releases }
    }
    notes.push(`No data for ${metric}: add an API key with universe.analytics:read, or export the chart from the Creator Dashboard and import the CSV.`)
    return { range, source: null, series: [], notes, releases }
  }

  private async publicSeries(metric: string, range: DateRange, granularity: Granularity, notes: string[]): Promise<Series> {
    const poller = await this.publicPoller()
    const history = poller.history()
    if (!history.length) notes.push('No public snapshots yet; start the poller (analytics poller) so Forge records visits/playing/favorites over time.')
    const g: Granularity = granularity === 'minute' || granularity === 'halfhour' ? 'hour' : granularity
    const daily = historySeries(history, metric, g === 'total' ? 'day' : g)
    const sliced = sliceSeries(daily, range)
    if (history.length) notes.push(`public history: ${describeSnapshotSpan(history)}`)
    return g === 'total' ? rebucket(sliced, 'total', range) : sliced
  }

  private async csvSeries(metric: string, range: DateRange, granularity: Granularity, notes: string[]): Promise<Series[]> {
    let store: ImportStore
    try {
      store = await this.importStore()
    } catch {
      return []
    }
    const all = store.get(metric)
    if (!all.length) return []
    return all.map((s) => {
      const sliced = sliceSeries(s, range)
      if (sliced.granularity === granularity) return sliced
      const order: Granularity[] = ['minute', 'halfhour', 'hour', 'day', 'week', 'month', 'total']
      if (order.indexOf(granularity) < order.indexOf(sliced.granularity)) {
        notes.push(`Imported ${metric} is ${sliced.granularity}ly; cannot split it into ${granularity}.`)
        return sliced
      }
      return rebucket(sliced, granularity, range)
    })
  }

  // ------------------------------------------------------------ reports

  private async daily(metric: string, range: DateRange, notes: string[], breakdown?: string[]): Promise<{ source: SeriesSource | null; series: Series[] }> {
    try {
      const r = await this.series({ metric, range, granularity: 'day', breakdown })
      for (const n of r.notes) if (!notes.includes(n)) notes.push(n)
      return { source: r.source, series: r.series }
    } catch (error) {
      notes.push(`${metric}: ${(error as Error).message}`)
      return { source: null, series: [] }
    }
  }

  async overview(options: { range?: string | DateRange; metrics?: string[] } = {}): Promise<OverviewResult> {
    const range = this.resolveRange(options.range ?? '7d')
    const previous = previousRange(range)
    const notes: string[] = []
    const metrics = options.metrics?.length ? options.metrics : OVERVIEW_METRICS
    const kpis: KpiDelta[] = []
    const forSignals: Series[] = []
    const releases = await this.releases()
    for (const metric of metrics) {
      const info = metricInfo(metric)
      // Retention cohorts need to mature: shift both windows back.
      const shift = (RETENTION_MATURITY_DAYS[metric] ?? 0) * DAY
      const cur = shift ? shiftRange(range, shift) : range
      const prev = shift ? shiftRange(previous, shift) : previous
      // One query for both windows plus a little history for signals.
      const span = unionRange({ start: isoDay(parseTime(prev.start) - 14 * DAY), end: prev.end }, cur)
      if (info.retentionDays < 1000 && parseTime(span.start) < this.now() - info.retentionDays * DAY) span.start = isoDay(this.now() - (info.retentionDays - 1) * DAY)
      const { source, series } = await this.daily(metric, span, notes)
      const main = series.find((s) => !s.breakdown) ?? series[0]
      if (!main) continue
      const c = valueIn(main, cur)
      const p = valueIn(main, prev)
      kpis.push({ metric, label: info.label, unit: main.unit, source: source ?? main.source, current: c, previous: p, change: relChange(c, p) })
      forSignals.push(main)
    }
    let live: PublicStats | undefined
    try {
      ;[live] = await fetchPublicStats([await this.universeId()], { fetch: this.deps.fetch, sleep: this.deps.sleep })
    } catch (error) {
      notes.push(`public stats: ${(error as Error).message}`)
    }
    if (!kpis.length) {
      for (const m of ['public.visits', 'public.playing', 'public.newFavorites']) {
        const { source, series } = await this.daily(m, unionRange(previous, range), notes)
        const s = series[0]
        if (!s || !s.points.length) continue
        const c = valueIn(s, range)
        const p = valueIn(s, previous)
        kpis.push({ metric: m, label: metricInfo(m).label, unit: s.unit, source: source ?? 'public', current: c, previous: p, change: relChange(c, p) })
        forSignals.push(s)
      }
    }
    return { range, previous, kpis, signals: signalsFor(forSignals, releases, this.now()), live, notes: dedupe(notes) }
  }

  async compare(options: { metrics: string[]; a: string | DateRange; b?: string | DateRange }): Promise<CompareResult> {
    const a = this.resolveRange(options.a)
    const b = options.b ? this.resolveRange(options.b) : previousRange(a)
    const notes: string[] = []
    const rows: CompareResult['rows'] = []
    const adjacent = a.start === b.end || b.start === a.end
    for (const metric of options.metrics) {
      const info = metricInfo(metric)
      let sa: Series | undefined
      let sb: Series | undefined
      let source: SeriesSource | null = null
      if (adjacent) {
        const r = await this.daily(metric, unionRange(a, b), notes)
        source = r.source
        sa = sb = r.series.find((s) => !s.breakdown) ?? r.series[0]
      } else {
        const ra = await this.daily(metric, a, notes)
        const rb = await this.daily(metric, b, notes)
        source = ra.source ?? rb.source
        sa = ra.series.find((s) => !s.breakdown) ?? ra.series[0]
        sb = rb.series.find((s) => !s.breakdown) ?? rb.series[0]
      }
      const va = sa ? valueIn(sa, a) : null
      const vb = sb ? valueIn(sb, b) : null
      rows.push({ metric, label: info.label, unit: sa?.unit ?? info.unit, source, a: va, b: vb, change: relChange(va, vb) })
    }
    return { a, b, rows, notes: dedupe(notes) }
  }

  async acquisition(options: { range?: string | DateRange } = {}): Promise<AcquisitionResult> {
    const range = this.resolveRange(options.range ?? '7d')
    const previous = previousRange(range)
    const notes: string[] = []
    const both = unionRange(previous, range)
    const totalBy = async (metric: string, r: DateRange) => {
      try {
        const res = await this.series({ metric, range: r, granularity: 'total', breakdown: ['AcquisitionSource'] })
        for (const n of res.notes) notes.push(n)
        return res.series
      } catch (error) {
        notes.push(`${metric}: ${(error as Error).message}`)
        return []
      }
    }
    const [imp, impPrev, plays, playsPrev, qual] = [
      await totalBy('UniqueUsersWithImpressions', range),
      await totalBy('UniqueUsersWithImpressions', previous),
      await totalBy('UniqueUsersWithPlaySessions', range),
      await totalBy('UniqueUsersWithPlaySessions', previous),
      await totalBy('QualifiedUniqueUsersWithPlaySessions', range)
    ]
    const bySourceValue = (list: Series[]) => {
      const m = new Map<string, number>()
      for (const s of list) {
        const key = s.breakdown?.AcquisitionSourceLabel ?? s.breakdown?.AcquisitionSource ?? 'All'
        m.set(key, (m.get(key) ?? 0) + s.points.reduce((x, p) => x + p.v, 0))
      }
      return m
    }
    const mi = bySourceValue(imp)
    const mip = bySourceValue(impPrev)
    const mp = bySourceValue(plays)
    const mpp = bySourceValue(playsPrev)
    const mq = bySourceValue(qual)
    const sources = [...new Set([...mi.keys(), ...mp.keys(), ...mip.keys(), ...mpp.keys()])]
    const div = (x?: number, y?: number) => (x === undefined || !y ? null : x / y)
    const bySource: AcquisitionRow[] = sources
      .map((source) => ({
        source,
        impressions: mi.get(source) ?? null,
        impressionsPrev: mip.get(source) ?? null,
        plays: mp.get(source) ?? null,
        playsPrev: mpp.get(source) ?? null,
        qualifiedPlays: mq.get(source) ?? null,
        playsPerImpression: div(mp.get(source), mi.get(source)),
        playsPerImpressionPrev: div(mpp.get(source), mip.get(source))
      }))
      .sort((x, y) => (y.plays ?? 0) - (x.plays ?? 0))
    const sum = (m: Map<string, number>) => (m.size ? [...m.values()].reduce((x, y) => x + y, 0) : null)
    const totals = {
      impressions: sum(mi),
      plays: sum(mp),
      qualifiedPlays: sum(mq),
      impressionsChange: relChange(sum(mi), sum(mip)),
      playsChange: relChange(sum(mp), sum(mpp))
    }
    if (bySource.length) notes.push('Unique-user counts per source are for the whole period (users seen via several sources count in each).')

    const homeRecs: AcquisitionResult['homeRecs'] = []
    const signalSeries: Series[] = []
    for (const metric of ['RFYPlayThroughRate', 'RFYQualifiedPTR', 'RFYDeepEngagementRate']) {
      const { series } = await this.daily(metric, both, notes)
      const s = series[0]
      if (!s) continue
      const cmp = comparePeriods(s, range, previous)
      homeRecs.push({ metric, label: METRICS[metric].label, current: cmp.a, previous: cmp.b, change: cmp.change })
      signalSeries.push(s)
    }

    const newVsReturning: AcquisitionResult['newVsReturning'] = []
    const dau = await this.daily('DailyActiveUsers', both, notes, ['IsNewUser'])
    for (const s of dau.series.filter((x) => x.breakdown?.IsNewUser !== undefined)) {
      const cmp = comparePeriods(s, range, previous)
      const raw = s.breakdown!.IsNewUserLabel ?? s.breakdown!.IsNewUser
      newVsReturning.push({ segment: /^(true|1|new)/i.test(raw) ? 'new' : /^(false|0|return)/i.test(raw) ? 'returning' : raw, dau: cmp.a, change: cmp.change })
      signalSeries.push(s)
    }

    const publicTrend = { newVisits: null as number | null, newVisitsChange: null as number | null, newFavorites: null as number | null, likeRatio: null as number | null }
    try {
      const history = readHistory(join(await this.dir(), 'public.jsonl'))
      if (history.length) {
        const visits = historySeries(history, 'public.visits', 'day')
        publicTrend.newVisits = valueIn(visits, range)
        publicTrend.newVisitsChange = relChange(publicTrend.newVisits, valueIn(visits, previous))
        publicTrend.newFavorites = valueIn(historySeries(history, 'public.newFavorites', 'day'), range)
        publicTrend.likeRatio = valueIn(historySeries(history, 'public.likeRatio', 'day'), range)
      }
    } catch {
      // no universe: nothing to read
    }

    const rates = conversionRates({ impressions: totals.impressions, plays: totals.plays, qualifiedPlays: totals.qualifiedPlays })
    return { range, previous, bySource, totals, homeRecs, newVsReturning, publicTrend, rates, signals: signalsFor(signalSeries, await this.releases(), this.now()), notes: dedupe(notes) }
  }

  async catalog(): Promise<{ items: CatalogItem[]; notes: string[] }> {
    const key = await this.apiKey()
    if (!key) return { items: [], notes: ['Listing game passes and developer products needs an API key with game-pass:read and developer-product:read.'] }
    const universeId = await this.universeId()
    const notes: string[] = []
    const items: CatalogItem[] = []
    for (const [load, what] of [
      [listGamePasses, 'game passes'],
      [listDeveloperProducts, 'developer products']
    ] as const) {
      try {
        items.push(...(await load(universeId, { apiKey: key, fetch: this.deps.fetch, sleep: this.deps.sleep })))
      } catch (error) {
        notes.push(`${what}: ${(error as Error).message}`)
      }
    }
    return { items, notes }
  }

  async incidents(days = 7): Promise<{ incidents: AlertIncident[]; notes: string[] }> {
    const key = await this.apiKey()
    if (!key) return { incidents: [], notes: ['Alert incidents need an API key with universe.analytics.alert:read.'] }
    const end = this.now()
    const range = { start: new Date(end - Math.min(30, days) * DAY).toISOString(), end: new Date(end).toISOString() }
    try {
      return { incidents: await listAlertIncidents(await this.universeId(), range, { apiKey: key, fetch: this.deps.fetch, sleep: this.deps.sleep }), notes: [] }
    } catch (error) {
      return { incidents: [], notes: [(error as Error).message] }
    }
  }

  async importCsv(input: { path?: string; text?: string; fileName?: string; metricHint?: string }): Promise<CsvImportResult> {
    const store = await this.importStore()
    if (input.path) return store.importFile(input.path, { metricHint: input.metricHint })
    if (input.text !== undefined) return store.importText(input.text, { metricHint: input.metricHint, fileName: input.fileName })
    throw new Error('importCsv needs a path or text')
  }

  stopPoller(): void {
    this.poller?.stop()
  }
}

function shiftRange(r: DateRange, ms: number): DateRange {
  return { start: isoDay(parseTime(r.start) - ms), end: isoDay(parseTime(r.end) - ms) }
}

function dedupe(list: string[]): string[] {
  return [...new Set(list)]
}
