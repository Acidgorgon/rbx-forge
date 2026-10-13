import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { ImportStore, normaliseCsv, parseCsv, parseDateCell, parseNumberCell } from '../src/main/services/analytics/csvImport.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'forge-csv-'))
  dirs.push(d)
  return d
}

test('tokeniser handles BOM, quotes, CRLF and delimiters', () => {
  const { rows, delimiter } = parseCsv('﻿Date,"Name, with comma","Say ""hi"""\r\n2026-10-01,1,2\r\n')
  assert.equal(delimiter, ',')
  assert.deepEqual(rows, [
    ['Date', 'Name, with comma', 'Say "hi"'],
    ['2026-10-01', '1', '2']
  ])
  assert.equal(parseCsv('a;b\n1;2').delimiter, ';')
  assert.equal(parseCsv('a\tb\n1\t2').delimiter, '\t')
})

test('date and number cells in dashboard formats', () => {
  const d = (s: string, dayFirst = false) => {
    const t = parseDateCell(s, dayFirst)
    return t === undefined ? undefined : new Date(t).toISOString()
  }
  assert.equal(d('2026-10-01'), '2026-10-01T00:00:00.000Z')
  assert.equal(d('2026-10-01T05:30:00Z'), '2026-10-01T05:30:00.000Z')
  assert.equal(d('2026-10-01 05:00:00'), '2026-10-01T05:00:00.000Z')
  assert.equal(d('10/01/2026'), '2026-10-01T00:00:00.000Z')
  assert.equal(d('01/10/2026', true), '2026-10-01T00:00:00.000Z')
  assert.equal(d('13/10/2026'), '2026-10-13T00:00:00.000Z')
  assert.equal(d('Oct 1, 2026'), '2026-10-01T00:00:00.000Z')
  assert.equal(d('1 Sept 2026'), '2026-09-01T00:00:00.000Z')
  assert.equal(d('Daily Active Users'), undefined)
  assert.deepEqual(parseNumberCell('1,234'), { value: 1234, percent: false })
  assert.deepEqual(parseNumberCell('12.5%'), { value: 12.5, percent: true })
  assert.deepEqual(parseNumberCell('R$ 1,200'), { value: 1200, percent: false })
  assert.deepEqual(parseNumberCell('1.2K'), { value: 1200, percent: false })
  assert.deepEqual(parseNumberCell('1.234,5', true), { value: 1234.5, percent: false })
  assert.equal(parseNumberCell('—'), undefined)
  assert.equal(parseNumberCell('Phone'), undefined)
})

test('wide KPI export maps headers to API metric names', () => {
  const csv = `Daily Active Users,,,
Experience: My Game,,,
Date,Daily Active Users,Day 1 Retention,Avg. Session Time
2026-10-01,"1,000",12.5%,7.2
2026-10-02,"1,100",13%,7.0
2026-10-03,"1,050",—,6.8
Total,"3,150",,
`
  const r = normaliseCsv(csv)
  const ids = r.series.map((s) => s.metric).sort()
  assert.deepEqual(ids, ['AverageSessionLengthMinutes', 'DailyActiveUsers', 'ForwardD1Retention'])
  const dau = r.series.find((s) => s.metric === 'DailyActiveUsers')!
  assert.equal(dau.source, 'csv')
  assert.equal(dau.granularity, 'day')
  assert.deepEqual(dau.points.map((p) => p.v), [1000, 1100, 1050])
  const d1 = r.series.find((s) => s.metric === 'ForwardD1Retention')!
  assert.equal(d1.unit, '%')
  assert.deepEqual(d1.points.map((p) => p.v), [12.5, 13])
  assert.ok(r.warnings.some((w) => /without a date/.test(w)))
})

test('long export with a breakdown column becomes one series per value', () => {
  const csv = `Date,Platform,Value
2026-10-01,Phone,600
2026-10-01,Computer,400
2026-10-02,Phone,650
2026-10-02,Computer,380
`
  const r = normaliseCsv(csv, { metricHint: 'DAU' })
  assert.equal(r.series.length, 2)
  const phone = r.series.find((s) => s.breakdown?.Platform === 'Phone')!
  assert.equal(phone.metric, 'DailyActiveUsers')
  assert.deepEqual(phone.points, [
    { t: '2026-10-01', v: 600 },
    { t: '2026-10-02', v: 650 }
  ])
})

test('wide export with series columns uses the hint metric as breakdown', () => {
  const csv = `Date,Phone,Computer,Tablet
10/01/2026,600,400,50
10/02/2026,650,380,55
`
  const r = normaliseCsv(csv, { fileName: '/downloads/Daily_Active_Users.csv' })
  assert.deepEqual(r.series.map((s) => [s.metric, s.breakdown?.Series]), [
    ['DailyActiveUsers', 'Phone'],
    ['DailyActiveUsers', 'Computer'],
    ['DailyActiveUsers', 'Tablet']
  ])
})

test('unknown headers become csv.<slug>, weekly and hourly granularity are inferred', () => {
  const weekly = normaliseCsv('Week,Creator Rewards (Robux)\n2026-09-07,10\n2026-09-14,12\n2026-09-21,15\n')
  assert.equal(weekly.series[0].metric, 'csv.creator_rewards_robux')
  assert.equal(weekly.series[0].granularity, 'week')
  const hourly = normaliseCsv('Time,Concurrent Users\n2026-10-01 00:00,10\n2026-10-01 01:00,12\n2026-10-01 02:00,8\n')
  assert.equal(hourly.series[0].metric, 'PeakConcurrentPlayers')
  assert.equal(hourly.series[0].granularity, 'hour')
  assert.equal(hourly.series[0].points[0].t, '2026-10-01T00:00Z')
})

test('sales transaction log is summed per day and item', () => {
  const csv = `Date,Item Name,Item Type,Buyer Id,Robux Earned,Place
2026-10-01 10:00:00,VIP,Game Pass,1,175,Main
2026-10-01 11:00:00,VIP,Game Pass,2,175,Main
2026-10-01 12:00:00,100 Coins,Developer Product,3,17,Main
2026-10-02 09:00:00,VIP,Game Pass,4,175,Main
`
  const r = normaliseCsv(csv)
  const vipRobux = r.series.find((s) => s.metric === 'csv.salesRobux' && s.breakdown?.Item === 'VIP')!
  assert.deepEqual(vipRobux.points, [
    { t: '2026-10-01', v: 350 },
    { t: '2026-10-02', v: 175 }
  ])
  const vipCount = r.series.find((s) => s.metric === 'csv.salesCount' && s.breakdown?.Item === 'VIP')!
  assert.deepEqual(vipCount.points.map((p) => p.v), [2, 1])
  assert.ok(r.warnings.some((w) => /transaction log/.test(w)))
})

test('files without dates are rejected with a hint', () => {
  const r = normaliseCsv('Name,Value\nA,1\nB,2\n')
  assert.equal(r.series.length, 0)
  assert.match(r.warnings[0], /No date column/)
})

test('import store merges re-imports and lists summaries', () => {
  const dir = tempDir()
  const store = new ImportStore(join(dir, 'imports'), () => Date.parse('2026-10-13T00:00:00Z'))
  store.importText('Date,DAU\n2026-10-01,100\n2026-10-02,110\n', { fileName: 'a.csv' })
  const file = join(dir, 'b.csv')
  writeFileSync(file, 'Date,DAU\n2026-10-02,115\n2026-10-03,120\n')
  const res = store.importFile(file)
  assert.equal(res.series[0].points, 3)
  const [s] = store.get('DailyActiveUsers')
  assert.deepEqual(s.points.map((p) => [p.t, p.v]), [
    ['2026-10-01', 100],
    ['2026-10-02', 115],
    ['2026-10-03', 120]
  ])
  const [summary] = store.list()
  assert.deepEqual({ ...summary }, { metric: 'DailyActiveUsers', label: 'DAU', points: 3, importedAt: '2026-10-13T00:00:00.000Z', first: '2026-10-01', last: '2026-10-03', file: 'b.csv' })
  assert.match(store.importFile(join(dir, 'sales.zip')).warnings[0], /Unzip/)
  assert.equal(store.remove('DailyActiveUsers'), true)
  assert.equal(store.list().length, 0)
})
