import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { anomaly, comparePeriods, conversionRates, formatSignals, meanStd, relChange, releaseImpact, retentionDelta, severityOf, signalsFor, weekOverWeek } from '../src/main/services/analytics/insights.ts'
import { fetchPublicStats, historySeries, PublicStatsPoller, readHistory } from '../src/main/services/analytics/publicStats.ts'
import { compactSeries, fillInteriorGaps, previousRange, rebucket, resolveRange } from '../src/main/services/analytics/series.ts'
import { metricInfo, parseGranularity, resolveMetricName } from '../src/main/services/analytics/metrics.ts'
import type { Series } from '../src/main/services/analytics/types.ts'
import { fakeClock, fakeFetch } from './analyticsFake.test.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function daily(metric: string, start: string, values: number[]): Series {
  const info = metricInfo(metric)
  const t0 = Date.parse(start + 'T00:00:00Z')
  return { metric, source: 'api', granularity: 'day', unit: info.unit, aggregation: info.aggregation, points: values.map((v, i) => ({ t: new Date(t0 + i * 86_400_000).toISOString().slice(0, 10), v })) }
}

// ---------------------------------------------------------------- series helpers

test('ranges resolve to complete UTC days with lag', () => {
  const now = Date.parse('2026-10-13T15:00:00Z')
  assert.deepEqual(resolveRange('7d', now), { start: '2026-10-06', end: '2026-10-13' })
  assert.deepEqual(resolveRange('7d', now, 1), { start: '2026-10-05', end: '2026-10-12' })
  assert.deepEqual(resolveRange('2w', now), { start: '2026-09-29', end: '2026-10-13' })
  assert.deepEqual(resolveRange('2026-09-01..2026-09-30', now), { start: '2026-09-01', end: '2026-10-01' })
  assert.deepEqual(previousRange({ start: '2026-10-06', end: '2026-10-13' }), { start: '2026-09-29', end: '2026-10-06' })
  assert.throws(() => resolveRange('yesterday', now), /Unrecognised range/)
})

test('rebucket uses the metric aggregation; weeks start Monday', () => {
  // 2026-10-05 is a Monday.
  const visits = daily('Visits', '2026-10-04', [1, 2, 3, 4, 5, 6, 7, 8, 9])
  assert.deepEqual(rebucket(visits, 'week').points, [
    { t: '2026-09-28', v: 1 },
    { t: '2026-10-05', v: 35 },
    { t: '2026-10-12', v: 9 }
  ])
  const dau = daily('DailyActiveUsers', '2026-10-05', [10, 20, 30])
  assert.deepEqual(rebucket(dau, 'total', { start: '2026-10-05', end: '2026-10-08' }).points, [{ t: '2026-10-05', v: 20 }])
  const mau = daily('MonthlyActiveUsers', '2026-09-29', [5, 6, 7, 8])
  assert.deepEqual(rebucket(mau, 'month').points, [
    { t: '2026-09-01', v: 6 },
    { t: '2026-10-01', v: 8 }
  ])
})

test('interior gaps are zero-filled for counts only, and compact output marks gaps', () => {
  const visits: Series = { ...daily('Visits', '2026-10-01', []), points: [{ t: '2026-10-01', v: 5 }, { t: '2026-10-04', v: 7 }] }
  assert.deepEqual(fillInteriorGaps(visits).points.map((p) => p.v), [5, 0, 0, 7])
  const rate: Series = { ...daily('ForwardD1Retention', '2026-10-01', []), points: [{ t: '2026-10-01', v: 0.3 }, { t: '2026-10-03', v: 0.2, flag: 'projected' }] }
  assert.equal(fillInteriorGaps(rate).points.length, 2)
  assert.equal(compactSeries(rate), 'ForwardD1Retention day src=api unit=rate agg=mean n=2 mean=0.25\nfrom 2026-10-01 every day: 0.3 _ 0.2~')
})

test('metric names, aliases and granularity words resolve', () => {
  assert.equal(resolveMetricName('dau'), 'DailyActiveUsers')
  assert.equal(resolveMetricName('Day 7 Retention'), 'ForwardD7Retention')
  assert.equal(resolveMetricName('Avg. Session Time'), 'AverageSessionLengthMinutes')
  assert.equal(resolveMetricName('dailyrevenue'), 'DailyRevenue')
  assert.equal(resolveMetricName('No such thing'), undefined)
  assert.equal(metricInfo('ClientFpsP90').aggregation, 'mean')
  assert.equal(metricInfo('ClientFpsP90').retentionDays, 28)
  assert.equal(metricInfo('CustomEventMaxValue').category, 'custom')
  assert.equal(parseGranularity('weekly'), 'week')
  assert.equal(parseGranularity('None'), 'total')
  assert.equal(parseGranularity(undefined, 'hour'), 'hour')
})

// ---------------------------------------------------------------- insights

test('relative change and severity respect which direction is good', () => {
  assert.equal(relChange(110, 100), 0.1)
  assert.equal(relChange(5, 0), null)
  assert.equal(relChange(0, 0), 0)
  assert.equal(severityOf('DailyActiveUsers', -0.2), 'bad')
  assert.equal(severityOf('DailyActiveUsers', -0.08), 'warn')
  assert.equal(severityOf('DailyActiveUsers', 0.08), 'good')
  assert.equal(severityOf('DailyActiveUsers', 0.02), 'info')
  assert.equal(severityOf('ClientCrashRate15m', 0.3), 'bad')
  assert.equal(severityOf('ClientCrashRate15m', -0.3), 'good')
  assert.equal(severityOf('EconomyTransactionAmount', -0.5), 'info')
})

test('week over week anchors on the last data point', () => {
  const visits = daily('Visits', '2026-09-28', [...Array(7).fill(100), ...Array(7).fill(80)])
  const s = weekOverWeek(visits)!
  assert.equal(s.severity, 'bad')
  assert.deepEqual(s.evidence, { current: 560, previous: 700, change: -0.2, currentStart: '2026-10-05', currentEnd: '2026-10-11', previousStart: '2026-09-28' })
  assert.match(s.text, /Visits -20% week over week \(700 -> 560/)
  assert.equal(weekOverWeek(daily('Visits', '2026-10-01', [1, 2, 3])), null)
})

test('period comparison uses mean for DAU and sum for revenue', () => {
  const dau = daily('DailyActiveUsers', '2026-10-01', [100, 100, 200, 200])
  assert.deepEqual(comparePeriods(dau, { start: '2026-10-03', end: '2026-10-05' }, { start: '2026-10-01', end: '2026-10-03' }), { a: 200, b: 100, change: 1 })
  const rev = daily('DailyRevenue', '2026-10-01', [10, 10, 30, 30])
  assert.deepEqual(comparePeriods(rev, { start: '2026-10-03', end: '2026-10-05' }, { start: '2026-10-01', end: '2026-10-03' }), { a: 60, b: 20, change: 2 })
})

test('retention cohort delta excludes immature cohorts', () => {
  const values = [...Array(7).fill(0.1), ...Array(7).fill(0.08), 0.01, 0.01]
  const d7 = daily('ForwardD7Retention', '2026-09-22', values)
  // Without a clock all points count: recent 7 include the two 0.01 tail values.
  const naive = retentionDelta(d7, 7)!
  assert.ok((naive.evidence.recent as number) < 0.08)
  // With now = 2026-10-13, cohorts after 2026-10-05 are immature (D7 not fully observed) and excluded.
  const s = retentionDelta(d7, 7, 7, Date.parse('2026-10-13T00:00:00Z'))!
  assert.deepEqual([s.evidence.recent, s.evidence.previous, s.evidence.change], [0.08, 0.1, -0.2])
  assert.equal(s.severity, 'bad')
  assert.equal(s.evidence.lastCohort, '2026-10-05')
})

test('anomaly needs history and a 3-sigma move', () => {
  const base = Array.from({ length: 28 }, (_, i) => 100 + (i % 2 ? 2 : -2))
  assert.equal(anomaly(daily('Visits', '2026-09-01', [...base, 101])), null)
  const a = anomaly(daily('Visits', '2026-09-01', [...base, 40]))!
  assert.equal(a.severity, 'bad')
  assert.equal(a.evidence.at, '2026-09-29')
  assert.equal(anomaly(daily('Visits', '2026-09-01', [1, 2, 300])), null)
  const { mean, std } = meanStd([2, 4, 4, 4, 5, 5, 7, 9])
  assert.equal(mean, 5)
  assert.ok(Math.abs(std - 2.138) < 0.001)
})

test('release impact compares the days before and after a release', () => {
  const d1 = daily('ForwardD1Retention', '2026-09-28', [...Array(7).fill(0.3), ...Array(7).fill(0.24)])
  const [s] = releaseImpact(d1, [{ tag: 'v1.4.0', at: '2026-10-05T18:00:00Z' }])
  assert.deepEqual(s.evidence, { release: 'v1.4.0', releaseDay: '2026-10-05', before: 0.3, after: 0.24, change: -0.2, daysBefore: 7, daysAfter: 7 })
  assert.equal(s.severity, 'bad')
  assert.equal(releaseImpact(d1, [{ tag: 'v0.1.0', at: '2026-01-01' }]).length, 0)
})

test('conversion rates and the combined signal list', () => {
  assert.deepEqual(conversionRates({ impressions: 1000, plays: 50, qualifiedPlays: 25, dau: 200, payers: 10, revenue: 500 }), {
    playsPerImpressionUser: 0.05,
    qualifiedShareOfPlays: 0.5,
    payerConversion: 0.05,
    revenuePerDau: 2.5,
    revenuePerPayer: 50
  })
  assert.equal(conversionRates({ plays: 5 }).playsPerImpressionUser, null)
  const signals = signalsFor(
    [daily('Visits', '2026-09-28', [...Array(7).fill(100), ...Array(7).fill(130)]), daily('ClientCrashRate15m', '2026-09-28', [...Array(7).fill(0.01), ...Array(7).fill(0.02)])],
    [{ tag: 'v2.0.0', at: '2026-10-05' }]
  )
  assert.equal(signals[0].severity, 'bad')
  assert.equal(signals[0].metric, 'ClientCrashRate15m')
  assert.ok(signals.some((s) => s.id === 'release:v2.0.0:ClientCrashRate15m'))
  const text = formatSignals(signals)
  assert.match(text, /^signals:\n\[!!\] Client crash rate/)
  assert.equal(formatSignals([]), 'signals: none (not enough data or nothing moved 5%+)')
})

// ---------------------------------------------------------------- public stats + poller

test('public stats merge games and votes responses', async () => {
  const f = fakeFetch()
    .on('GET', /\/v1\/games\?universeIds=1,2$/, { body: { data: [{ id: 1, rootPlaceId: 10, name: 'A', visits: 100, playing: 3, favoritedCount: 7, maxPlayers: 20 }, { id: 2, visits: 5, playing: 0, favoritedCount: 0 }] } })
    .on('GET', /\/v1\/games\/votes\?universeIds=1,2$/, { body: { data: [{ id: 1, upVotes: 9, downVotes: 1 }] } })
  const stats = await fetchPublicStats([1, 2], { fetch: f.fetch })
  assert.deepEqual(stats[0], { universeId: 1, rootPlaceId: 10, name: 'A', visits: 100, playing: 3, favorites: 7, upVotes: 9, downVotes: 1, maxPlayers: 20, updated: undefined })
  assert.equal(stats[1].upVotes, undefined)
})

test('public stats retry 429 then fail clearly', async () => {
  const clock = fakeClock()
  const f = fakeFetch().on('GET', /\/v1\/games\?/, { status: 429, body: {} }, { body: { data: [{ id: 1, visits: 1, playing: 1, favoritedCount: 1 }] } }).on('GET', /votes/, { body: { data: [] } })
  const [s] = await fetchPublicStats([1], { fetch: f.fetch, sleep: clock.sleep })
  assert.equal(s.visits, 1)
  assert.deepEqual(clock.sleeps, [2000])
  const g = fakeFetch().on('GET', /\/v1\/games\?/, { status: 500, body: {} }).on('GET', /votes/, { body: { data: [] } })
  await assert.rejects(fetchPublicStats([1], { fetch: g.fetch, sleep: clock.sleep }), /returned 500/)
})

test('poller snapshots into a JSONL history, skips too-frequent polls, and derives trends', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-poll-'))
  dirs.push(dir)
  const file = join(dir, '42', 'public.jsonl')
  const clock = fakeClock(Date.parse('2026-10-10T10:00:00Z'))
  let visits = 1000
  let favs = 50
  const f = fakeFetch()
    .on('GET', /\/v1\/games\?universeIds=42/, () => ({ body: { data: [{ id: 42, visits, playing: Math.round(visits / 100), favoritedCount: favs }] } }))
    .on('GET', /votes/, () => ({ body: { data: [{ id: 42, upVotes: 80, downVotes: 20 }] } }))
  let timer: (() => void) | undefined
  const seen: string[] = []
  const poller = new PublicStatsPoller({
    universeId: 42,
    historyFile: file,
    fetch: f.fetch,
    now: clock.now,
    intervalMinutes: 60,
    setInterval: (fn) => ((timer = fn), 'h'),
    clearInterval: () => (timer = undefined),
    onSnapshot: (s) => seen.push(s.at)
  })
  poller.start()
  assert.equal(poller.running, true)
  await new Promise((r) => setImmediate(r))
  assert.equal(seen.length, 1)
  // Too soon: skipped.
  clock.advance(60_000)
  assert.equal(await poller.pollNow(), undefined)
  // Day 1 evening, day 2, day 3.
  for (const [hours, v, fv] of [
    [10, 1500, 52],
    [14, 2600, 55],
    [24, 4000, 60]
  ] as const) {
    clock.advance(hours * 3_600_000)
    visits = v
    favs = fv
    await poller.pollNow()
  }
  // The interval tick right after a poll is skipped by the minimum gap.
  timer?.()
  await new Promise((r) => setImmediate(r))
  poller.stop()
  assert.equal(poller.running, false)
  appendFileSync(file, '{"torn": ')
  const history = readHistory(file)
  assert.equal(history.length, 4)
  assert.deepEqual(history[0], { at: '2026-10-10T10:00:00.000Z', visits: 1000, playing: 10, favorites: 50, up: 80, down: 20 })
  const dayVisits = historySeries(history, 'public.visits', 'day')
  // 2026-10-10 has no baseline; 10-11 = 2600-1500, 10-12 = 4000-2600.
  assert.deepEqual(dayVisits.points, [
    { t: '2026-10-11', v: 1100 },
    { t: '2026-10-12', v: 1400 }
  ])
  assert.deepEqual(historySeries(history, 'public.playingPeak', 'day').points.map((p) => p.v), [15, 26, 40])
  assert.deepEqual(historySeries(history, 'public.likeRatio', 'day').points.map((p) => p.v), [0.8, 0.8, 0.8])
  assert.deepEqual(historySeries(history, 'public.newFavorites', 'total').points, [{ t: '2026-10-11', v: 8 }])
  assert.throws(() => historySeries(history, 'public.nope', 'day'), /Unknown public metric/)
})
