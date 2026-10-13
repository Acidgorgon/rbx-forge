import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { MemorySecretStore } from '../src/main/services/release/secrets.ts'
import { AnalyticsApiError, AnalyticsQueryClient, ANALYTICS_BASE } from '../src/main/services/analytics/queryClient.ts'
import { AnalyticsService, analyticsSecretKey } from '../src/main/services/analytics/service.ts'
import { createAnalyticsTools } from '../src/main/services/analytics/tools.ts'
import { listDeveloperProducts, listGamePasses, listAlertIncidents } from '../src/main/services/analytics/catalog.ts'
import { apiValues, done, fakeClock, fakeFetch } from './analyticsFake.test.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'forge-analytics-'))
  dirs.push(d)
  return d
}

const METRICS_URL = /analytics-query-api\/v1\/universes\/42\/metrics$/
const range = { start: '2026-10-01', end: '2026-10-08' }

test('query client posts the documented body and normalises the series', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { body: done([apiValues('2026-10-01', [100, 120, 130])]) })
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key-123', fetch: f.fetch, sleep: clock.sleep, now: clock.now })
  const [s] = await client.metrics(42, { metric: 'DailyActiveUsers', range, granularity: 'day', breakdown: ['Platform'], filter: [{ dimension: 'Platform', values: ['Phone'] }] })
  assert.equal(f.calls[0].url, `${ANALYTICS_BASE}/v1/universes/42/metrics`)
  assert.equal(f.calls[0].headers['x-api-key'], 'key-123')
  assert.deepEqual(f.calls[0].body, {
    metric: 'DailyActiveUsers',
    granularity: 'OneDay',
    startTime: '2026-10-01T00:00:00Z',
    endTime: '2026-10-08T00:00:00Z',
    breakdown: ['Platform'],
    filter: [{ dimension: 'Platform', values: ['Phone'], operation: 'In' }]
  })
  assert.equal(s.source, 'api')
  assert.equal(s.aggregation, 'mean')
  assert.deepEqual(s.points, [
    { t: '2026-10-01', v: 100 },
    { t: '2026-10-02', v: 120 },
    { t: '2026-10-03', v: 130 }
  ])
})

test('query client polls async operations, flags projected points and fills interior gaps for counts', async () => {
  const pending = { path: 'v1/universes/42/operations/metrics/abc', done: false }
  const f = fakeFetch()
    .on('POST', METRICS_URL, { status: 202, body: pending })
    .on(
      'GET',
      /operations\/metrics\/abc$/,
      { status: 202, body: pending },
      {
        body: done([
          {
            breakdowns: [{ dimension: 'Platform', value: 'Phone', displayValue: 'Phone' }],
            dataPoints: [
              { time: '2026-10-01T00:00:00Z', value: 5 },
              { time: '2026-10-03T00:00:00Z', value: 7, status: 'Projected' }
            ]
          }
        ])
      }
    )
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'k'.repeat(30), fetch: f.fetch, sleep: clock.sleep, now: clock.now })
  const [s] = await client.metrics(42, { metric: 'Visits', range, granularity: 'day' })
  assert.equal(f.calls[1].url, `${ANALYTICS_BASE}/v1/universes/42/operations/metrics/abc`)
  assert.equal(f.calls.length, 3)
  assert.deepEqual(s.breakdown, { Platform: 'Phone' })
  assert.deepEqual(s.points, [
    { t: '2026-10-01', v: 5 },
    { t: '2026-10-02', v: 0 },
    { t: '2026-10-03', v: 7, flag: 'projected' }
  ])
})

test('query client caches results within the TTL', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { body: done([apiValues('2026-10-01', [1])]) })
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch, sleep: clock.sleep, now: clock.now })
  const q = { metric: 'DailyActiveUsers', range, granularity: 'day' as const }
  await client.metrics(42, q)
  await client.metrics(42, q)
  assert.equal(f.calls.length, 1)
  clock.advance(16 * 60_000)
  await client.metrics(42, q)
  assert.equal(f.calls.length, 2)
})

test('query client retries 429 with backoff but not the data-point budget error', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { status: 429, body: { code: 4 } }, { status: 429, body: {}, headers: { 'retry-after': '3' } }, { body: done([apiValues('2026-10-01', [9])]) })
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch, sleep: clock.sleep, now: clock.now })
  const [s] = await client.metrics(42, { metric: 'Visits', range, granularity: 'day' })
  assert.equal(s.points[0].v, 9)
  assert.deepEqual(clock.sleeps, [1000, 3000])

  const g = fakeFetch().on('POST', METRICS_URL, { status: 429, body: { code: 3000, message: 'too many data points' } })
  const client2 = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: g.fetch, sleep: clock.sleep, now: clock.now })
  await assert.rejects(client2.metrics(42, { metric: 'Visits', range, granularity: 'day' }), (e: AnalyticsApiError) => e.kind === 'budget' && /too many data points/.test(e.message))
  assert.equal(g.calls.length, 1)
})

test('query client maps auth errors to the missing scope and records the problem', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { status: 403, body: { message: 'Insufficient scope' } })
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch, sleep: clock.sleep, now: clock.now })
  await assert.rejects(client.metrics(42, { metric: 'Visits', range, granularity: 'day' }), (e: AnalyticsApiError) => e.kind === 'forbidden' && /universe\.analytics:read/.test(e.message))
  assert.match(client.lastAuthProblem ?? '', /Insufficient scope/)
  const none = new AnalyticsQueryClient({ getApiKey: async () => undefined, fetch: f.fetch })
  await assert.rejects(none.metrics(42, { metric: 'Visits', range, granularity: 'day' }), (e: AnalyticsApiError) => e.kind === 'no-key')
})

test('query client surfaces failed operations', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { body: { path: 'p', done: true, error: { code: 2001, message: 'unsupported granularity' } } })
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch })
  await assert.rejects(client.metrics(42, { metric: 'MonthlyActiveUsers', range, granularity: 'week' }), (e: AnalyticsApiError) => e.kind === 'invalid-request')
})

test('client-side limiter spaces POSTs to 30 per minute', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, { body: done([]) })
  const clock = fakeClock()
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch, sleep: clock.sleep, now: clock.now, postsPerMinute: 2 })
  for (let i = 0; i < 3; i++) await client.metrics(42, { metric: 'Visits', range: { start: '2026-10-01', end: `2026-10-0${i + 2}` }, granularity: 'day' })
  assert.equal(f.calls.length, 3)
  assert.deepEqual(clock.sleeps, [60_000])
  const strict = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch, sleep: clock.sleep, now: clock.now, postsPerMinute: 1, maxQueueWaitMs: 1000 })
  await strict.metrics(42, { metric: 'Visits', range, granularity: 'total' })
  await assert.rejects(strict.metrics(42, { metric: 'DailyActiveUsers', range, granularity: 'total' }), (e: AnalyticsApiError) => e.kind === 'rate-limited')
})

test('dimension values endpoint', async () => {
  const f = fakeFetch().on('POST', /dimension-values$/, { body: { path: 'p', done: true, response: { values: [{ dimension: 'AcquisitionSource', values: [{ value: 'Search' }, { value: 'HomeRecommendations', displayValue: 'Home recommendations' }] }] } } })
  const client = new AnalyticsQueryClient({ getApiKey: async () => 'key', fetch: f.fetch })
  const out = await client.dimensionValues(42, 'UniqueUsersWithImpressions', ['AcquisitionSource'], range)
  assert.equal(out.AcquisitionSource.length, 2)
  assert.deepEqual((f.calls[0].body as Record<string, unknown>).dimensions, ['AcquisitionSource'])
})

// ---------------------------------------------------------------- catalog

test('catalog lists passes and products across pages and reads prices', async () => {
  const f = fakeFetch()
    .on(
      'GET',
      /game-passes\/v1\/universes\/42\/game-passes\/creator/,
      { body: { gamePasses: [{ gamePassId: 1, name: 'VIP', isForSale: true, priceInformation: { defaultPriceInRobux: 250 } }], nextPageToken: 'n2' } },
      { body: { gamePasses: [{ gamePassId: 2, name: 'Radio', isForSale: false, priceInformation: null }], nextPageToken: '' } }
    )
    .on('GET', /developer-products\/v2\/universes\/42\/developer-products\/creator/, { body: { developerProducts: [{ productId: 9, name: '100 Coins', isForSale: true, priceInformation: { defaultPriceInRobux: 25 } }] } })
  const passes = await listGamePasses(42, { apiKey: 'key', fetch: f.fetch })
  assert.deepEqual(passes.map((p) => [p.id, p.name, p.priceRobux, p.isForSale]), [
    [1, 'VIP', 250, true],
    [2, 'Radio', undefined, false]
  ])
  assert.match(f.calls[1].url, /pageToken=n2/)
  const products = await listDeveloperProducts(42, { apiKey: 'key', fetch: f.fetch })
  assert.equal(products[0].priceRobux, 25)
  const denied = fakeFetch().on('GET', /game-passes/, { status: 403, body: {} })
  await assert.rejects(listGamePasses(42, { apiKey: 'key', fetch: denied.fetch }), /game-pass:read/)
})

test('alert incidents are flattened', async () => {
  const f = fakeFetch().on('GET', /alerts\/incidents\?startTime=/, {
    body: [{ id: 'i1', status: 'Open', openedAt: '2026-10-12T01:00:00Z', alertConfig: { name: 'Crash spike', metric: 'ClientCrashRate15m', severity: 'SEV_1' }, latestFiringMetadata: { firingCondition: { firingValue: 0.04 } } }]
  })
  const out = await listAlertIncidents(42, { start: '2026-10-06T00:00:00Z', end: '2026-10-13T00:00:00Z' }, { apiKey: 'key', fetch: f.fetch })
  assert.deepEqual(out[0], { id: 'i1', status: 'Open', alert: 'Crash spike', metric: 'ClientCrashRate15m', severity: 'SEV_1', openedAt: '2026-10-12T01:00:00Z', resolvedAt: undefined, firingValue: 0.04 })
})

// ---------------------------------------------------------------- service

function service(f: ReturnType<typeof fakeFetch>, opts: { key?: string; placeId?: number; universeId?: number } = {}) {
  const secrets = new MemorySecretStore()
  if (opts.key) secrets.data.set(analyticsSecretKey('/game'), opts.key)
  const clock = fakeClock()
  const svc = new AnalyticsService({
    secrets,
    dataDir: tempDir(),
    root: '/game',
    placeId: opts.placeId,
    universeId: opts.universeId,
    fetch: f.fetch,
    sleep: clock.sleep,
    now: clock.now,
    getReleases: async () => [{ tag: 'v1.4.0', at: '2026-10-05T18:00:00Z' }]
  })
  return { svc, secrets, clock }
}

const days = (start: string, n: number, fn: (i: number) => number) => apiValues(start, Array.from({ length: n }, (_, i) => fn(i)))

test('service resolves the universe from the place id and falls back to the release key', async () => {
  const f = fakeFetch()
    .on('GET', /universes\/v1\/places\/777\/universe$/, { body: { universeId: 42 } })
    .on('POST', METRICS_URL, { body: done([apiValues('2026-10-01', [10])]) })
  const { svc, secrets } = service(f, { placeId: 777 })
  secrets.data.set('release.openCloudApiKey', 'release-key')
  assert.equal(await svc.universeId(), 42)
  const r = await svc.series({ metric: 'dau'.replace('dau', 'DailyActiveUsers'), range: '7d' })
  assert.equal(r.source, 'api')
  assert.equal(f.calls.find((c) => c.method === 'POST')!.headers['x-api-key'], 'release-key')
  assert.deepEqual(r.range, { start: '2026-10-05', end: '2026-10-12' })
  assert.deepEqual(r.releases.map((x) => x.tag), ['v1.4.0'])
})

test('service falls back to imported CSV when the API is not available', async () => {
  const f = fakeFetch()
  const { svc } = service(f, { universeId: 42 })
  await svc.importCsv({ text: 'Date,Daily Active Users\n2026-10-05,100\n2026-10-06,110\n2026-10-07,90\n', fileName: 'dau.csv' })
  const r = await svc.series({ metric: 'DailyActiveUsers', range: '2026-10-01..2026-10-10' })
  assert.equal(r.source, 'csv')
  assert.equal(r.series[0].points.length, 3)
  assert.ok(r.notes.some((n) => /No analytics API key/.test(n)))
  const weekly = await svc.series({ metric: 'DailyActiveUsers', range: '2026-10-01..2026-10-10', granularity: 'week' })
  assert.deepEqual(weekly.series[0].points, [{ t: '2026-10-05', v: 100 }])
  await assert.rejects(svc.series({ metric: 'DailyActiveUsers', source: 'api' }), /universe\.analytics:read/)
})

test('service uses public snapshots as a Visits stand-in and says so', async () => {
  const f = fakeFetch().on('GET', /games\.roblox\.com\/v1\/games\?universeIds=42/, { body: { data: [{ id: 42, visits: 1000, playing: 5, favoritedCount: 10 }] } }, { body: { data: [{ id: 42, visits: 1300, playing: 9, favoritedCount: 12 }] } }).on('GET', /votes/, { body: { data: [] } })
  const { svc, clock } = service(f, { universeId: 42 })
  const poller = await svc.publicPoller()
  clock.advance(-2 * 86_400_000)
  await poller.pollNow()
  clock.advance(86_400_000)
  await poller.pollNow()
  clock.advance(86_400_000)
  const r = await svc.series({ metric: 'Visits', range: '7d' })
  assert.equal(r.source, 'public')
  assert.equal(r.series[0].metric, 'public.visits')
  assert.deepEqual(r.series[0].points, [{ t: '2026-10-12', v: 300 }])
  assert.ok(r.notes.some((n) => /stand-in/.test(n)))
})

test('overview: one query per KPI, period deltas, matured retention windows and signals', async () => {
  const bodies: Record<string, unknown>[] = []
  const f = fakeFetch()
    .on('POST', METRICS_URL, (call) => {
      const body = call.body as { metric: string; startTime: string; endTime: string }
      bodies.push(body)
      const start = body.startTime.slice(0, 10)
      const n = Math.round((Date.parse(body.endTime) - Date.parse(body.startTime)) / 86_400_000)
      if (body.metric === 'DailyActiveUsers') return { body: done([days(start, n, (i) => (i < n - 7 ? 1000 : 800))]) }
      if (body.metric === 'ForwardD1Retention') return { body: done([days(start, n, () => 0.3)]) }
      return { body: done([]) }
    })
    .on('GET', /games\.roblox\.com\/v1\/games\?/, { body: { data: [{ id: 42, visits: 5, playing: 2, favoritedCount: 1 }] } })
    .on('GET', /votes/, { body: { data: [{ id: 42, upVotes: 90, downVotes: 10 }] } })
  const { svc } = service(f, { key: 'key', universeId: 42 })
  const r = await svc.overview({ range: '7d', metrics: ['DailyActiveUsers', 'ForwardD1Retention', 'ForwardD7Retention'] })
  assert.equal(bodies.length, 3)
  const dau = r.kpis.find((k) => k.metric === 'DailyActiveUsers')!
  assert.equal(dau.source, 'api')
  assert.ok(dau.change! < -0.1)
  // D7 retention windows are shifted back 7 days.
  const d7 = bodies.find((b) => b.metric === 'ForwardD7Retention') as { endTime: string }
  assert.equal(d7.endTime, '2026-10-05T00:00:00Z')
  assert.equal(r.live?.playing, 2)
  assert.ok(r.signals.some((s) => s.metric === 'DailyActiveUsers' && s.severity === 'bad'))
  const text = (await createAnalyticsTools(svc).find((t) => t.name === 'analytics_overview')!.handler({ range: '7d', metrics: ['dau'] }, {})).content[0].text
  assert.match(text, /DAU: 800 \(prev 1000, -20%\) \[DailyActiveUsers, api\]/)
  assert.match(text, /live \(public\): playing=2 .* likes=90%/)
})

test('acquisition report splits by source and computes plays per impression', async () => {
  const bySource = (pairs: [string, number][]) => done(pairs.map(([src, v]) => ({ breakdowns: [{ dimension: 'AcquisitionSource', value: src }], dataPoints: [{ time: '2026-10-05T00:00:00Z', value: v }] })))
  const f = fakeFetch()
    .on('POST', METRICS_URL, (call) => {
      const body = call.body as { metric: string; startTime: string; granularity: string }
      const current = body.startTime.startsWith('2026-10-05')
      switch (body.metric) {
        case 'UniqueUsersWithImpressions':
          return { body: current ? bySource([['HomeRecommendations', 10000], ['Search', 2000]]) : bySource([['HomeRecommendations', 20000], ['Search', 2000]]) }
        case 'UniqueUsersWithPlaySessions':
          return { body: current ? bySource([['HomeRecommendations', 500], ['Search', 300]]) : bySource([['HomeRecommendations', 1000], ['Search', 250]]) }
        case 'QualifiedUniqueUsersWithPlaySessions':
          return { body: bySource([['HomeRecommendations', 250], ['Search', 200]]) }
        case 'RFYPlayThroughRate':
          return { body: done([days('2026-09-28', 14, (i) => (i < 7 ? 0.05 : 0.04))]) }
        case 'DailyActiveUsers':
          return {
            body: done([
              { breakdowns: [{ dimension: 'IsNewUser', value: 'true' }], dataPoints: days('2026-09-28', 14, (i) => (i < 7 ? 300 : 200)).dataPoints },
              { breakdowns: [{ dimension: 'IsNewUser', value: 'false' }], dataPoints: days('2026-09-28', 14, () => 700).dataPoints }
            ])
          }
        default:
          return { body: done([]) }
      }
    })
  const { svc } = service(f, { key: 'key', universeId: 42 })
  const r = await svc.acquisition({ range: '7d' })
  assert.deepEqual(r.range, { start: '2026-10-05', end: '2026-10-12' })
  const home = r.bySource.find((x) => x.source === 'HomeRecommendations')!
  assert.equal(home.impressions, 10000)
  assert.equal(home.playsPerImpression, 0.05)
  assert.equal(r.totals.impressions, 12000)
  assert.equal(Math.round(r.totals.impressionsChange! * 100), -45)
  assert.equal(r.homeRecs[0].metric, 'RFYPlayThroughRate')
  assert.ok(Math.abs(r.homeRecs[0].change! + 0.2) < 1e-9)
  assert.deepEqual(r.newVsReturning.map((s) => s.segment), ['new', 'returning'])
  const text = (await createAnalyticsTools(svc).find((t) => t.name === 'acquisition_report')!.handler({ range: '7d' }, {})).content[0].text
  assert.match(text, /HomeRecommendations \| 10000 \(20000\) \| 500 \(1000\) \| 0\.05 \(0\.05\) \| 250/)
})

test('compare tool and series tool produce compact text', async () => {
  const f = fakeFetch().on('POST', METRICS_URL, (call) => {
    const body = call.body as { startTime: string; endTime: string }
    const s = Date.parse(body.startTime)
    const e = Date.parse(body.endTime)
    const n = Math.round((e - s) / 86_400_000)
    return { body: done([days(body.startTime.slice(0, 10), n, (i) => 100 + i)]) }
  })
  const { svc } = service(f, { key: 'key', universeId: 42 })
  const tools = createAnalyticsTools(svc)
  const cmp = (await tools.find((t) => t.name === 'analytics_compare')!.handler({ metrics: ['Visits'], a: '2026-10-08..2026-10-11', b: '2026-10-04..2026-10-07' }, {})).content[0].text
  assert.match(cmp, /Visits: A=422 B=406 \+3\.9% \[Visits, api\]/)
  const series = (await tools.find((t) => t.name === 'analytics_series')!.handler({ metric: 'visits', range: '2026-10-01..2026-10-03' }, {})).content[0].text
  assert.match(series, /^range 2026-10-01\.\.2026-10-04 source=api\nVisits day src=api unit=visits agg=sum n=3 sum=303\nfrom 2026-10-01 every day: 100 101 102/)
})

test('tool errors come back as isError text, not exceptions', async () => {
  const f = fakeFetch()
  const { svc } = service(f, {})
  const r = await createAnalyticsTools(svc).find((t) => t.name === 'analytics_series')!.handler({ metric: 'Visits', range: 'last tuesday' }, {})
  assert.equal(r.isError, true)
  assert.match(r.content[0].text, /Unrecognised range/)
})

test('instrument tool returns GenTree files and call sites', async () => {
  const { svc } = service(fakeFetch(), { universeId: 42 })
  const t = createAnalyticsTools(svc).find((x) => x.name === 'analytics_instrument')!
  const setup = (await t.handler({ kind: 'setup' }, {})).content[0].text
  assert.match(setup, /--- src\/server\/Features\/Telemetry\/TelemetryService\.luau/)
  assert.match(setup, /--- src\/shared\/Features\/Telemetry\/init\.luau/)
  const funnel = (await t.handler({ kind: 'funnel', funnelName: 'Armory', steps: ['Open', 'Buy'] }, {})).content[0].text
  assert.match(funnel, /TelemetryService\.FunnelStep\(player, "Armory", 2, "Buy"\)/)
  const eco = (await t.handler({ kind: 'economy', flow: 'Sink', currency: 'Gems', transactionType: 'Shop', itemSku: 'Sword' }, {})).content[0].text
  assert.match(eco, /TelemetryService\.Spend\(player, "Gems", amount, newBalance, Enum\.AnalyticsEconomyTransactionType\.Shop\.Name, "Sword"\)/)
})

test('status and catalog through the tool', async () => {
  const f = fakeFetch()
    .on('GET', /game-passes/, { body: { gamePasses: [{ gamePassId: 1, name: 'VIP', isForSale: true, priceInformation: { defaultPriceInRobux: 250 } }] } })
    .on('GET', /developer-products/, { status: 403, body: {} })
    .on('GET', /alerts\/incidents/, { body: [] })
  const { svc } = service(f, { key: 'key', universeId: 42 })
  const text = (await createAnalyticsTools(svc).find((x) => x.name === 'analytics_status')!.handler({}, {})).content[0].text
  assert.match(text, /universe=42 .* apiKey=set/)
  assert.match(text, /pass 1 "VIP" 250R\$ on sale/)
  assert.match(text, /developer products: .*developer-product:read/)
  assert.match(text, /alert incidents \(7d\): none/)
})

test('every tool has a JSON-schema-able zod shape and a description', async () => {
  const { z } = await import('zod')
  const { svc } = service(fakeFetch(), {})
  for (const t of createAnalyticsTools(svc)) {
    assert.ok(t.description.length > 80, t.name)
    const schema = z.toJSONSchema(z.object(t.inputSchema)) as { type: string }
    assert.equal(schema.type, 'object')
  }
})
