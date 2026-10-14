// Spending cap: local day / month windows and their rollover, warn at 80%, hard stop at 100%, the
// "raise cap for today" override (and that it expires at local midnight), alerts once per window,
// the service (persistence, refusal, events) and the hooks into the agent layer (meter stop,
// orchestrator charges, ledger record sources).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { alertText, emptyBook, evaluateSpend, localDay, localMonth, monthSpent, newAlerts, normalizeBook, normalizeSettings, parseUsd, raiseStep, raiseToday, recordSpend, refusal, spendState } from '../src/shared/spend/cap.ts'
import { isSpendCapMessage, type SpendSettings } from '../src/shared/spend/types.ts'
import { fileStore, SpendCapError, SpendService } from '../src/main/services/spend/service.ts'
import { assertSpend, chargeSpend, setSpendCap, sourceOfRecord, spendBlock } from '../src/main/services/spend/gate.ts'
import { createSpendWiring } from '../src/main/services/spend/wire.ts'
import { Meter } from '../src/main/agent/meter.ts'
import { orchestratorCharge, withSpendCharges } from '../src/main/agent/index.ts'

// Local wall-clock time (the cap's windows are local).
const at = (y: number, mo: number, d: number, h = 12, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime()
const caps = (dailyUsd: number | null, monthlyUsd: number | null, warnAt = 0.8): SpendSettings => ({ dailyUsd, monthlyUsd, warnAt })

test('day window rolls over at local midnight', () => {
  const book = emptyBook()
  recordSpend(book, { at: at(2026, 10, 14, 23, 59), provider: 'anthropic', source: 'chat', costUsd: 4 })
  recordSpend(book, { at: at(2026, 10, 15, 0, 1), provider: 'anthropic', source: 'chat', costUsd: 1 })
  assert.equal(evaluateSpend(book, caps(5, null), at(2026, 10, 14, 23, 59)).day.spent, 4)
  assert.equal(evaluateSpend(book, caps(5, null), at(2026, 10, 15, 0, 2)).day.spent, 1)
  assert.equal(localDay(at(2026, 10, 15, 0, 0)), '2026-10-15')
})

test('day keys follow the local timezone, not UTC', () => {
  const prev = process.env.TZ
  process.env.TZ = 'America/Los_Angeles'
  try {
    const utcLate = Date.UTC(2026, 9, 15, 3, 0) // 2026-10-14 20:00 in Los Angeles
    assert.equal(localDay(utcLate), '2026-10-14')
    assert.equal(localMonth(Date.UTC(2026, 10, 1, 5, 0)), '2026-10') // Oct 31 22:00 local
    const book = recordSpend(emptyBook(), { at: utcLate, provider: 'openai', source: 'images', costUsd: 2 })
    assert.deepEqual(Object.keys(book.days), ['2026-10-14'])
  } finally {
    if (prev === undefined) delete process.env.TZ
    else process.env.TZ = prev
  }
})

test('month window sums the local month and rolls over on the 1st', () => {
  const book = emptyBook()
  recordSpend(book, { at: at(2026, 9, 30, 22), provider: 'openai', source: 'labs', costUsd: 10 })
  recordSpend(book, { at: at(2026, 10, 1, 9), provider: 'openai', source: 'labs', costUsd: 3 })
  recordSpend(book, { at: at(2026, 10, 20, 9), provider: 'anthropic', source: 'chat', costUsd: 4 })
  assert.equal(monthSpent(book, at(2026, 9, 30, 23)), 10)
  assert.equal(monthSpent(book, at(2026, 10, 25)), 7)
  const e = evaluateSpend(book, caps(null, 8), at(2026, 10, 25))
  assert.equal(e.month.key, '2026-10')
  assert.equal(e.month.level, 'warn') // 7 / 8 = 87.5%
  assert.equal(evaluateSpend(book, caps(null, 8), at(2026, 11, 1, 0, 1)).month.spent, 0)
})

test('warn at 80%, stop at 100%, no cap = never', () => {
  const book = emptyBook()
  const now = at(2026, 10, 14)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 3.9 })
  assert.equal(evaluateSpend(book, caps(5, null), now).level, 'ok')
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 0.1 })
  assert.equal(evaluateSpend(book, caps(5, null), now).level, 'warn')
  assert.equal(refusal(book, caps(5, null), now), null)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 1 })
  const e = evaluateSpend(book, caps(5, null), now)
  assert.equal(e.level, 'stop')
  assert.match(e.reason ?? '', /today \$5\.00 of \$5\.00/)
  const msg = refusal(book, caps(5, null), now)
  assert.ok(msg && isSpendCapMessage(msg))
  assert.match(msg!, /daily cap/)
  assert.equal(evaluateSpend(book, caps(null, null), now).level, 'ok')
  // The monthly cap alone can stop too.
  assert.match(refusal(book, caps(null, 4), now) ?? '', /monthly cap/)
})

test('raise cap for today lifts both windows for today only', () => {
  const book = emptyBook()
  const now = at(2026, 10, 14, 15)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 6 })
  const s = caps(5, 20)
  assert.ok(refusal(book, s, now))
  const step = raiseStep(book, s, now)
  assert.equal(step, 3.5) // half the daily cap + the $1 overage
  raiseToday(book, step, now)
  assert.equal(refusal(book, s, now), null)
  assert.equal(evaluateSpend(book, s, now).day.effectiveCap, 8.5)
  // Tomorrow the plain caps apply again and old overrides are dropped on the next raise.
  const tomorrow = at(2026, 10, 15, 9)
  assert.equal(evaluateSpend(book, s, tomorrow).day.effectiveCap, 5)
  raiseToday(book, 1, tomorrow)
  assert.deepEqual(Object.keys(book.overrides), ['2026-10-15'])
})

test('raise step clears a monthly overage', () => {
  const book = emptyBook()
  const now = at(2026, 10, 20)
  recordSpend(book, { at: at(2026, 10, 2), provider: 'openai', source: 'labs', costUsd: 30 })
  const s = caps(null, 25)
  const step = raiseStep(book, s, now)
  assert.equal(step, 7.5) // 10% of the monthly cap + $5 over
  raiseToday(book, step, now)
  assert.equal(evaluateSpend(book, s, now).level, 'warn')
})

test('alerts fire once per window and level', () => {
  const book = emptyBook()
  const now = at(2026, 10, 14)
  const s = caps(1, null)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 0.85 })
  const a = newAlerts(book, s, now)
  assert.equal(a.length, 1)
  assert.equal(a[0].level, 'warn')
  assert.match(alertText('warn', a[0].window), /85%/)
  assert.equal(newAlerts(book, s, now).length, 0)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 0.2 })
  const b = newAlerts(book, s, now)
  assert.deepEqual(b.map((x) => x.level), ['stop'])
})

test('state: per-provider and per-source breakdown, history, normalisation', () => {
  const book = emptyBook()
  const now = at(2026, 10, 14)
  recordSpend(book, { at: now, provider: 'anthropic', source: 'chat', costUsd: 1 })
  recordSpend(book, { at: now, provider: 'openai', source: 'images', costUsd: 0.5 })
  recordSpend(book, { at: at(2026, 10, 2), provider: 'openai', source: 'labs', costUsd: 2 })
  recordSpend(book, { at: now, provider: 'ollama', source: 'chat', costUsd: NaN })
  const st = spendState(book, caps(10, 100), now)
  assert.deepEqual(st.byProvider.find((r) => r.provider === 'openai'), { provider: 'openai', day: 0.5, month: 2.5 })
  assert.deepEqual(st.bySource.find((r) => r.source === 'images'), { source: 'images', day: 0.5, month: 0.5 })
  assert.equal(st.history.length, 14)
  assert.equal(st.history[13].total, 1.5)
  assert.equal(book.days['2026-10-14'].requests, 3)
  assert.deepEqual(normalizeSettings({ dailyUsd: -1, monthlyUsd: '5', warnAt: 2 }), { dailyUsd: null, monthlyUsd: null, warnAt: 0.8 })
  assert.deepEqual(normalizeBook({ days: { bad: {}, '2026-10-14': { total: 1 } }, overrides: { '2026-10-14': -3 } }).overrides, {})
})

test('service: refuses at the cap, emits alerts, raise + persist across restarts', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'spend-'))
  const file = join(dir, 'spend.json')
  let now = at(2026, 10, 14, 10)
  const events: { event: string; payload: any }[] = []
  const svc = new SpendService({ store: fileStore(file), now: () => now, saveDelayMs: 0, emit: (event, payload) => events.push({ event, payload }) })
  await svc.ready()
  await svc.setSettings({ dailyUsd: 2 })
  svc.record({ provider: 'anthropic', source: 'chat', costUsd: 1.7 })
  assert.ok(events.some((e) => e.event === 'spend:alert' && e.payload.level === 'warn'))
  svc.assert('labs')
  svc.record({ provider: 'anthropic', source: 'labs', costUsd: 0.4 })
  assert.throws(() => svc.assert('labs'), (e: unknown) => e instanceof SpendCapError && isSpendCapMessage((e as Error).message))
  assert.ok(events.some((e) => e.event === 'spend:alert' && e.payload.refused))
  const raised = await svc.raiseToday()
  assert.equal(raised.level, 'ok') // $2.10 of $3.10
  svc.assert('labs')
  await svc.flush()
  const saved = JSON.parse(await readFile(file, 'utf8'))
  assert.equal(saved.settings.dailyUsd, 2)
  assert.equal(saved.book.days['2026-10-14'].total, 2.1)
  // A new process reads the same book; tomorrow the override no longer applies.
  now = at(2026, 10, 15, 8)
  const again = new SpendService({ store: fileStore(file), now: () => now, saveDelayMs: 0 })
  await again.ready()
  assert.equal(again.state().day.spent, 0)
  assert.equal(again.state().month.spent, 2.1)
  assert.equal(again.state().overrideToday, 0)
})

test('gate + wiring: no cap set = no-op; meter turns the cap into a hard stop', async () => {
  setSpendCap(null)
  assert.equal(spendBlock(), null)
  assertSpend('chat')
  chargeSpend({ provider: 'x', source: 'chat', costUsd: 1 })

  const dir = await mkdtemp(join(tmpdir(), 'spend-w-'))
  const w = createSpendWiring({ userDataDir: dir, emit: () => undefined })
  try {
    await w.handlers.spendSetSettings({ dailyUsd: 1 })
    const store = new Map<string, unknown>()
    const meter = new Meter({ getSetting: (k, f) => (store.has(k) ? (store.get(k) as any) : f), setSetting: (k, v) => void store.set(k, v), emit: () => undefined }, { saveDelayMs: 0 })
    assert.equal(meter.checkChat('c1').level, 'ok')
    chargeSpend({ provider: 'anthropic', source: 'chat', costUsd: 1.2 })
    const check = meter.checkChat('c1')
    assert.equal(check.level, 'stop')
    assert.ok(isSpendCapMessage(check.reason))
    assert.equal(meter.checkAgent('a1').level, 'stop')
    assert.throws(() => assertSpend('images'), SpendCapError)
    const st = (await w.handlers.spendRaiseToday()) as { level: string }
    assert.notEqual(st.level, 'stop')
  } finally {
    await w.dispose()
  }
  assert.equal(spendBlock(), null)
})

test('agent hooks: ledger record sources and orchestrator charges', async () => {
  assert.equal(sourceOfRecord({ chatId: 'c' }), 'chat')
  assert.equal(sourceOfRecord({ agentId: 'orch:r1:t1' }), 'orchestrator')
  assert.equal(sourceOfRecord({ agentId: 'summary' }), 'labs')
  assert.equal(sourceOfRecord({ agentId: 'agent-7' }), 'agents')
  assert.equal(sourceOfRecord({}), 'labs')
  // Anthropic: tokens without cost do not count (the result carries the cost); others are priced.
  assert.equal(orchestratorCharge('anthropic', 'claude-opus-5-5', { input: 1000, output: 1000, cacheRead: 0, cacheWrite: 0 }), 0)
  assert.equal(orchestratorCharge('anthropic', 'claude-opus-5-5', { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.3 }), 0.3)
  assert.ok(orchestratorCharge('openai', 'gpt-6-luna', { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }) > 0)

  const dir = await mkdtemp(join(tmpdir(), 'spend-o-'))
  const w = createSpendWiring({ userDataDir: dir, emit: () => undefined })
  try {
    const run = () => ({
      async *[Symbol.asyncIterator]() {
        yield { type: 'usage' as const, usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.25 } }
        yield { type: 'done' as const }
      }
    })
    const seen: string[] = []
    for await (const e of withSpendCharges(run as never, { provider: 'anthropic', model: 'claude-opus-5-5' } as never)) seen.push(e.type)
    assert.deepEqual(seen, ['usage', 'done'])
    const st = w.service.state()
    assert.equal(st.day.spent, 0.25)
    assert.deepEqual(st.bySource.map((s) => s.source), ['orchestrator'])
  } finally {
    await w.dispose()
  }
})

test('cap field: dollar sign, decimal comma and thousands separators are read', () => {
  assert.equal(parseUsd(''), null)
  assert.equal(parseUsd('  '), null)
  assert.equal(parseUsd('25'), 25)
  assert.equal(parseUsd('$25'), 25)
  assert.equal(parseUsd('12,50'), 12.5)
  assert.equal(parseUsd('0.75'), 0.75)
  assert.equal(parseUsd('.5'), 0.5)
  assert.equal(parseUsd('1,000'), 1000)
  assert.equal(parseUsd('1 000'), 1000)
  assert.ok(Number.isNaN(parseUsd('ten') as number))
  assert.ok(Number.isNaN(parseUsd('-5') as number))
})

test('service: saves never overlap, and the last one written holds the newest state', async () => {
  let active = 0
  let maxActive = 0
  const written: unknown[] = []
  const store = {
    load: async () => null,
    save: async (data: unknown) => {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 5))
      written.push(data)
      active--
    }
  }
  const s = new SpendService({ store, saveDelayMs: 0 })
  await s.ready()
  s.record({ provider: 'anthropic', source: 'chat', costUsd: 1 })
  s.record({ provider: 'anthropic', source: 'chat', costUsd: 2 })
  await s.setSettings({ dailyUsd: 10 })
  await s.flush()
  assert.equal(maxActive, 1)
  const last = written.at(-1) as { settings: SpendSettings; book: { days: Record<string, { total: number }> } }
  assert.equal(last.settings.dailyUsd, 10)
  assert.equal(Object.values(last.book.days)[0].total, 3)
})
