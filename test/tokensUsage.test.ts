// Usage normalization, pricing, SDK tracking and the ledger (budget/usage.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  canonicalModel,
  dayKey,
  estimateCost,
  formatUsd,
  fromAnthropicUsage,
  fromModelUsage,
  fromOpenAiUsage,
  priceFor,
  priced,
  SdkUsageTracker,
  UsageLedger,
  type SettingsStore,
  type UsageRecord
} from '../src/main/agent/budget/usage.ts'

function memoryStore(): SettingsStore & { data: Map<string, unknown>; writes: number } {
  const data = new Map<string, unknown>()
  const s = {
    data,
    writes: 0,
    getSetting<T>(k: string, fb: T): T {
      return data.has(k) ? (JSON.parse(JSON.stringify(data.get(k))) as T) : fb
    },
    setSetting(k: string, v: unknown) {
      s.writes++
      data.set(k, JSON.parse(JSON.stringify(v)))
    }
  }
  return s
}

const close = (a: number | undefined, b: number) => assert.ok(a !== undefined && Math.abs(a - b) < 1e-9, `${a} != ${b}`)

test('Anthropic usage normalization', () => {
  assert.deepEqual(fromAnthropicUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 200 }), {
    input: 10,
    output: 5,
    cacheRead: 1000,
    cacheWrite: 200
  })
  assert.deepEqual(fromAnthropicUsage({ input_tokens: 3, cache_read_input_tokens: null } as any), { input: 3, output: 0, cacheRead: 0, cacheWrite: 0 })
  assert.deepEqual(fromAnthropicUsage(undefined), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 })
})

test('SDK modelUsage normalization keeps costUSD', () => {
  assert.deepEqual(
    fromModelUsage({ inputTokens: 1, outputTokens: 2, cacheReadInputTokens: 3, cacheCreationInputTokens: 4, costUSD: 0.5, webSearchRequests: 0, contextWindow: 1, maxOutputTokens: 1 }),
    { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, costUsd: 0.5 }
  )
})

test('OpenAI usage: prompt_tokens includes cached tokens', () => {
  const u = fromOpenAiUsage({ prompt_tokens: 2000, completion_tokens: 300, total_tokens: 2300, prompt_tokens_details: { cached_tokens: 1536 }, completion_tokens_details: { reasoning_tokens: 100 } })
  assert.deepEqual(u, { input: 464, output: 300, cacheRead: 1536, cacheWrite: 0 })
  const w = fromOpenAiUsage({ prompt_tokens: 2000, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 0, cache_write_tokens: 1500 } })
  assert.deepEqual(w, { input: 500, output: 1, cacheRead: 0, cacheWrite: 1500 })
  // OpenRouter: usage.cost in USD.
  assert.equal(fromOpenAiUsage({ prompt_tokens: 10, completion_tokens: 1, cost: 0.0042 })?.costUsd, 0.0042)
  // Ollama/Gemini minimal form, and garbage.
  assert.deepEqual(fromOpenAiUsage({ prompt_tokens: 7, completion_tokens: 3 }), { input: 7, output: 3, cacheRead: 0, cacheWrite: 0 })
  assert.equal(fromOpenAiUsage(null), null)
  assert.equal(fromOpenAiUsage({ foo: 1 }), null)
})

test('canonicalModel handles provider spellings', () => {
  assert.equal(canonicalModel('anthropic/claude-sonnet-5.5'), 'claude-sonnet-5-5')
  assert.equal(canonicalModel('claude-opus-5-5[1m]'), 'claude-opus-5-5')
  assert.equal(canonicalModel('claude-haiku-4-5-20251001'), 'claude-haiku-4-5')
  assert.equal(canonicalModel('us.anthropic.claude-opus-5-5'), 'claude-opus-5-5')
  assert.equal(canonicalModel('models/gemini-3.8-flash'), 'gemini-3.8-flash')
  assert.equal(canonicalModel('openai/gpt-6-luna'), 'gpt-6-luna')
})

test('price lookup: exact, dated snapshots, unknown models are unknown', () => {
  assert.equal(priceFor('claude-opus-5-5')?.input, 4)
  assert.equal(priceFor('gpt-6-luna-2026-09-01')?.input, 0.1)
  assert.equal(priceFor('gpt-5.6-terra'), undefined)
  assert.equal(priceFor('gemini-3.5-flash'), undefined, 'not a prefix match of gemini-3.5-flash-lite')
  assert.equal(priceFor('llama3.1'), undefined)
  assert.equal(estimateCost('qwen3.8', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }), undefined)
  assert.equal(estimateCost('qwen3.8', { input: 1e6, output: 1e6, cacheRead: 0, cacheWrite: 0 }, { provider: 'ollama' }), 0)
})

test('cost estimates per the official tables', () => {
  const M = 1_000_000
  // Opus 5.5: $4 in, $20 out, $0.20 cache read, $5 cache write (5m).
  close(estimateCost('claude-opus-5-5', { input: M, output: M, cacheRead: M, cacheWrite: M }), 4 + 20 + 0.2 + 5)
  // Sonnet 5.5 cache read is $0.10.
  close(estimateCost('claude-sonnet-5-5', { input: 0, output: 0, cacheRead: M, cacheWrite: 0 }), 0.1)
  // Haiku 5.5 long-context tier above 100k prompt tokens.
  close(estimateCost('claude-haiku-5-5', { input: 50_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 0.005)
  close(estimateCost('claude-haiku-5-5', { input: 150_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 0.075)
  close(estimateCost('claude-haiku-5-5', { input: 10_000, output: 0, cacheRead: 95_000, cacheWrite: 0 }), (10_000 * 0.5 + 95_000 * 0.05) / M)
  // OpenAI flagship and mini.
  close(estimateCost('gpt-6-astra', { input: M, output: M, cacheRead: M, cacheWrite: 0 }), 10 + 50 + 1)
  close(estimateCost('gpt-6-luna', { input: M, output: M, cacheRead: 0, cacheWrite: M }), 0.1 + 0.5 + 0.125)
  // Gemini Pro long tier and the 2027 Flash price change.
  close(estimateCost('gemini-3.1-pro-preview', { input: 300_000, output: 0, cacheRead: 0, cacheWrite: 0 }), 1.2)
  const jan2027 = Date.UTC(2027, 0, 2)
  close(estimateCost('gemini-3.8-flash', { input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, { at: Date.UTC(2026, 9, 13) }), 0.75)
  close(estimateCost('gemini-3.8-flash', { input: M, output: 0, cacheRead: 0, cacheWrite: 0 }, { at: jan2027 }), 1.5)
  // A cache write with no write price costs the input price.
  close(estimateCost('gemini-3.5-flash-lite', { input: 0, output: 0, cacheRead: 0, cacheWrite: M }), 0.3)
})

test('priced(): provider cost wins, then estimate, else unknown', () => {
  assert.equal(priced('gpt-6-luna', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, costUsd: 9 }).costSource, 'provider')
  assert.equal(priced('gpt-6-luna', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }).costSource, 'estimate')
  const u = priced('mystery-model', { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 })
  assert.equal(u.costSource, 'unknown')
  assert.equal(u.usage.costUsd, undefined)
})

// --- SDK tracking ----------------------------------------------------------------------------

function assistant(id: string, usage: Record<string, number>, model = 'claude-opus-5-5'): SDKMessage {
  return { type: 'assistant', message: { id, model, content: [], usage }, parent_tool_use_id: null, uuid: id + '-u', session_id: 's' } as unknown as SDKMessage
}

function result(modelUsage: Record<string, any>, total = 0): SDKMessage {
  return {
    type: 'result',
    subtype: 'success',
    is_error: false,
    result: 'ok',
    total_cost_usd: total,
    usage: { input_tokens: 0, output_tokens: 0 },
    modelUsage,
    session_id: 's'
  } as unknown as SDKMessage
}

const mu = (i: number, o: number, r: number, w: number, cost: number) => ({
  inputTokens: i,
  outputTokens: o,
  cacheReadInputTokens: r,
  cacheCreationInputTokens: w,
  costUSD: cost,
  webSearchRequests: 0,
  contextWindow: 1_000_000,
  maxOutputTokens: 128_000
})

test('SdkUsageTracker: dedupes streamed assistant messages for the live meter', () => {
  const t = new SdkUsageTracker('claude-opus-5-5')
  const u = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0 }
  t.onMessage(assistant('msg_1', u))
  t.onMessage(assistant('msg_1', u))
  t.onMessage(assistant('msg_2', { input_tokens: 10, output_tokens: 5 }))
  const live = t.live()
  assert.equal(live.input, 110)
  assert.equal(live.output, 55)
  assert.equal(live.cacheRead, 1000)
  close(live.costUsd, (110 * 4 + 55 * 20 + 1000 * 0.2) / 1e6)
})

test('SdkUsageTracker: result modelUsage is authoritative, deltas against a resumed baseline', () => {
  const t = new SdkUsageTracker('claude-opus-5-5', { 'claude-opus-5-5': { input: 100, output: 10, cacheRead: 0, cacheWrite: 50, costUsd: 0.01 } })
  t.onMessage(assistant('m', { input_tokens: 999, output_tokens: 999 }))
  const recs = t.onMessage(result({ 'claude-opus-5-5': mu(300, 60, 5000, 50, 0.05), 'claude-haiku-5-5': mu(1000, 100, 0, 0, 0.00015) }), 1000)
  assert.equal(recs.length, 2)
  const opus = recs.find((r) => r.model === 'claude-opus-5-5')!
  assert.deepEqual([opus.input, opus.output, opus.cacheRead, opus.cacheWrite], [200, 50, 5000, 0])
  close(opus.costUsd, 0.04)
  assert.equal(opus.costSource, 'provider')
  // Provisional usage is dropped once a result covered it.
  assert.deepEqual(t.finish(), [])
  assert.equal(t.live().input, 0)
  // A second result in the same query (streaming input) is a delta against the first.
  const recs2 = t.onMessage(result({ 'claude-opus-5-5': mu(310, 61, 5000, 50, 0.051) }))
  assert.equal(recs2.length, 1)
  assert.equal(recs2[0].input, 10)
  assert.deepEqual(t.snapshot()['claude-opus-5-5'].input, 310)
})

test('SdkUsageTracker: totals that went down (a /clear) count as fresh', () => {
  const t = new SdkUsageTracker('claude-opus-5-5', { 'claude-opus-5-5': { input: 1000, output: 0, cacheRead: 0, cacheWrite: 0 } })
  const recs = t.onMessage(result({ 'claude-opus-5-5': mu(20, 5, 0, 0, 0.001) }))
  assert.equal(recs[0].input, 20)
})

test('SdkUsageTracker: costBasis unknown is re-priced or marked unknown', () => {
  const t = new SdkUsageTracker('x')
  const recs = t.onMessage(result({ 'my-gateway-model': { ...mu(10, 1, 0, 0, 0.5), costBasis: 'unknown' } }))
  assert.equal(recs[0].costSource, 'unknown')
  assert.equal(recs[0].costUsd, undefined)
})

test('SdkUsageTracker: aborted query keeps provisional usage via finish()', () => {
  const t = new SdkUsageTracker('claude-haiku-5-5')
  t.onMessage(assistant('a', { input_tokens: 1000, output_tokens: 100 }, 'claude-haiku-5-5'))
  const recs = t.finish(5)
  assert.equal(recs.length, 1)
  assert.equal(recs[0].costSource, 'estimate')
  close(recs[0].costUsd, (1000 * 0.1 + 100 * 0.5) / 1e6)
  assert.equal(t.sawResult, false)
})

// --- Ledger ----------------------------------------------------------------------------------

function rec(over: Partial<UsageRecord>): UsageRecord {
  return { at: Date.UTC(2026, 9, 13, 12), provider: 'anthropic', model: 'claude-opus-5-5', input: 100, output: 10, cacheRead: 1000, cacheWrite: 0, costUsd: 0.01, costSource: 'provider', ...over }
}

test('ledger aggregates per chat, agent, day and model and persists', () => {
  const store = memoryStore()
  const l = new UsageLedger(store, { saveDelayMs: 0 })
  l.record(rec({ chatId: 'c1' }))
  l.record(rec({ chatId: 'c1', costUsd: undefined, costSource: 'unknown', model: 'mystery' }))
  l.record(rec({ agentId: 't-1', provider: 'openai', model: 'gpt-6-luna', costUsd: 0.002, costSource: 'estimate' }))
  const c = l.chat('c1')
  assert.equal(c.requests, 2)
  assert.equal(c.input, 200)
  close(c.costUsd, 0.01)
  assert.equal(c.unpricedRequests, 1)
  assert.equal(l.agent('t-1').requests, 1)
  const day = l.day(dayKey(Date.UTC(2026, 9, 13, 12)))
  assert.equal(day.requests, 3)
  close(day.costUsd, 0.012)
  assert.deepEqual(Object.keys(l.models()).sort(), ['anthropic:claude-opus-5-5', 'anthropic:mystery', 'openai:gpt-6-luna'])
  // Reload from the store.
  const l2 = new UsageLedger(store, { saveDelayMs: 0 })
  assert.deepEqual(l2.chat('c1'), c)
  assert.equal(store.writes, 3)
})

test('ledger: recordOpenAi, listeners, days() window, sdk baselines', () => {
  const l = new UsageLedger(memoryStore(), { saveDelayMs: 0 })
  const seen: UsageRecord[] = []
  const off = l.onRecord((r) => seen.push(r))
  const r = l.recordOpenAi({ prompt_tokens: 2000, completion_tokens: 100, prompt_tokens_details: { cached_tokens: 1000 } }, { provider: 'openai', model: 'gpt-6-luna', chatId: 'c', at: Date.UTC(2026, 9, 13, 12) })
  assert.ok(r)
  assert.equal(r.costSource, 'estimate')
  close(r.costUsd, (1000 * 0.1 + 1000 * 0.01 + 100 * 0.5) / 1e6)
  assert.equal(l.recordOpenAi(undefined, { provider: 'openai', model: 'gpt-6-luna' }), null)
  off()
  l.record(rec({}))
  assert.equal(seen.length, 1)
  const week = l.days(7, Date.UTC(2026, 9, 13, 12))
  assert.equal(week.length, 7)
  assert.equal(week[6].totals.requests, 2)
  l.setSdkBaseline('sess', { m: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 } })
  assert.equal(l.sdkBaseline('sess').m.output, 2)
  assert.deepEqual(l.sdkBaseline('none'), {})
})

test('ledger prunes old days and chats on save; debounced saves', async () => {
  const store = memoryStore()
  const l = new UsageLedger(store, { saveDelayMs: 5, maxDays: 2, maxChats: 1 })
  for (let d = 1; d <= 4; d++) l.record(rec({ chatId: `c${d}`, at: Date.UTC(2026, 9, d, 12) }))
  assert.equal(store.writes, 0)
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(store.writes, 1)
  const saved = store.data.get('usage') as { days: object; chats: object }
  assert.equal(Object.keys(saved.days).length, 2)
  assert.deepEqual(Object.keys(saved.chats), ['c4'])
})

test('formatUsd', () => {
  assert.equal(formatUsd(undefined), '$?')
  assert.equal(formatUsd(0), '$0')
  assert.equal(formatUsd(0.004), '<$0.01')
  assert.equal(formatUsd(1.234), '$1.23')
  assert.equal(formatUsd(12.34), '$12.3')
})
