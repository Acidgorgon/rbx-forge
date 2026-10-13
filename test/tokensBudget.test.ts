// Budget guard and model router (budget/budget.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BudgetGuard,
  checkAgent,
  checkChat,
  countTokens,
  DEFAULT_LIMITS,
  readLimits,
  routeModel,
  type RouteSettings
} from '../src/main/agent/budget/budget.ts'
import { UsageLedger, type SettingsStore, type Usage } from '../src/main/agent/budget/usage.ts'

function store(init: Record<string, unknown> = {}): SettingsStore {
  const data = new Map(Object.entries(init))
  return {
    getSetting: <T,>(k: string, fb: T) => (data.has(k) ? (data.get(k) as T) : fb),
    setSetting: (k, v) => void data.set(k, v)
  }
}

const u = (input: number, output = 0, cacheRead = 0, cacheWrite = 0, costUsd = 0): Usage => ({ input, output, cacheRead, cacheWrite, costUsd })

test('countTokens: effective counts cache reads at 10%', () => {
  assert.equal(countTokens(u(100, 50, 10_000, 20)), 100 + 50 + 20 + 1000)
  assert.equal(countTokens(u(100, 50, 10_000, 20), 'total'), 10_170)
})

test('readLimits: defaults, overrides, disabling', () => {
  assert.deepEqual(readLimits(store().getSetting), DEFAULT_LIMITS)
  const l = readLimits(store({ budget: { agentMaxCostUsd: 0.25, chatSoftTokens: 0, dailyMaxCostUsd: 5, tokenMetric: 'total', bogus: 'x' } }).getSetting)
  assert.equal(l.agentMaxCostUsd, 0.25)
  assert.equal(l.chatSoftTokens, undefined)
  assert.equal(l.dailyMaxCostUsd, 5)
  assert.equal(l.tokenMetric, 'total')
})

test('agent caps are hard: ok -> warn -> stop', () => {
  const limits = { agentMaxTokens: 1000, agentMaxCostUsd: 1, warnAt: 0.8 }
  assert.equal(checkAgent(u(100), limits).level, 'ok')
  const w = checkAgent(u(850), limits)
  assert.equal(w.level, 'warn')
  assert.match(w.reason!, /850 of 1k tokens/)
  const s = checkAgent(u(10, 0, 0, 0, 1.2), limits)
  assert.equal(s.level, 'stop')
  assert.match(s.reason!, /spent \$1\.20 of \$1\.00/)
  assert.ok(s.fraction >= 1.2 - 1e-9)
})

test('the worst cap wins and explains itself', () => {
  const r = checkAgent(u(900, 0, 0, 0, 1.5), { agentMaxTokens: 1000, agentMaxCostUsd: 1 })
  assert.equal(r.level, 'stop')
  assert.match(r.reason!, /\$1\.50/)
})

test('chat soft caps only warn; hard chat and daily caps stop', () => {
  const limits = { chatSoftTokens: 1000, chatSoftCostUsd: 1 }
  assert.equal(checkChat(u(5000), limits).level, 'warn')
  assert.match(checkChat(u(5000), limits).reason!, /consider a new chat/)
  assert.equal(checkChat(u(10, 0, 0, 0, 3), { ...limits, chatMaxCostUsd: 2 }).level, 'stop')
  const day = checkChat(u(10), { ...limits, dailyMaxCostUsd: 5 }, 5.01)
  assert.equal(day.level, 'stop')
  assert.match(day.reason!, /daily spend/)
  assert.equal(checkChat(u(10), {}).level, 'ok')
})

test('BudgetGuard uses ledger totals plus live usage', () => {
  const ledger = new UsageLedger(store(), { saveDelayMs: 0 })
  const guard = new BudgetGuard(ledger, { agentMaxTokens: 1000, agentMaxCostUsd: 10, chatSoftTokens: 1000 })
  ledger.record({ at: Date.now(), provider: 'anthropic', model: 'claude-haiku-5-5', agentId: 'a', input: 700, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.001, costSource: 'estimate' })
  assert.equal(guard.check({ agentId: 'a' }).level, 'ok')
  assert.equal(guard.check({ agentId: 'a' }, u(150)).level, 'warn')
  let live = u(0)
  const stop = guard.stopWhen({ agentId: 'a' }, () => live)
  assert.equal(stop(), false)
  live = u(400)
  assert.equal(stop(), true)
  assert.equal(guard.check({ chatId: 'none' }).level, 'ok')
  assert.deepEqual(guard.sdkOptions('agent'), { maxBudgetUsd: 10 })
  assert.deepEqual(guard.sdkOptions('chat'), {})
})

// --- router ---------------------------------------------------------------------------------

const anthropic: RouteSettings = { provider: 'anthropic', model: 'claude-sonnet-5-5' }

test('router: override and auto-route off always win', () => {
  assert.deepEqual(routeModel({ task: 'chat', text: 'refactor everything', settings: anthropic, override: 'claude-sonnet-5-5' }), {
    provider: 'anthropic',
    model: 'claude-sonnet-5-5',
    tier: 'chosen',
    reason: 'user override'
  })
  assert.equal(routeModel({ task: 'agent', text: 'x', settings: { ...anthropic, autoRoute: false } }).model, 'claude-sonnet-5-5')
})

test('router: test agents and summaries go cheap', () => {
  const a = routeModel({ task: 'agent', text: 'Buying an item reduces coins', settings: anthropic })
  assert.equal(a.model, 'claude-haiku-5-5')
  assert.equal(a.tier, 'cheap')
  assert.equal(routeModel({ task: 'summary', text: '', settings: { provider: 'openai', model: 'gpt-6-astra' } }).model, 'gpt-6-luna')
  assert.equal(routeModel({ task: 'agent', text: 'Think hard about race conditions in trading', settings: anthropic }).tier, 'big')
})

test('router: big for think hard, refactors and multi-file work', () => {
  for (const text of [
    'think hard about why the inventory desyncs',
    'Refactor the InventoryService to use ProfileStore',
    'migrate all controllers to the new janitor API',
    'update src/server/A.luau, src/server/B.luau and src/client/C.luau to share one config'
  ]) {
    const r = routeModel({ task: 'chat', text, settings: anthropic })
    assert.equal(r.model, 'claude-opus-5-5', text)
    assert.ok(r.reason.length > 0)
  }
})

test('router: cheap for short simple questions, chosen model otherwise', () => {
  const q = routeModel({ task: 'chat', text: 'where is AddItem defined?', settings: anthropic })
  assert.equal(q.model, 'claude-haiku-5-5')
  assert.equal(q.reason, 'short, simple question')
  const mid = routeModel({ task: 'chat', text: 'Add a sell button to the shop UI that calls the server and shows a toast', settings: anthropic })
  assert.equal(mid.model, 'claude-sonnet-5-5')
  assert.equal(mid.tier, 'chosen')
})

test('router: never downgrades mid-chat (prompt cache is per model)', () => {
  const r = routeModel({ task: 'chat', text: 'what does Init do?', settings: anthropic, previousModel: 'claude-opus-5-5' })
  assert.equal(r.model, 'claude-opus-5-5')
  assert.match(r.reason, /prompt cache/)
  const up = routeModel({ task: 'chat', text: 'now refactor it', settings: anthropic, previousModel: 'claude-haiku-5-5' })
  assert.equal(up.model, 'claude-opus-5-5')
})

test('router: per-provider defaults, overrides and providers without tiers', () => {
  assert.equal(routeModel({ task: 'agent', text: '', settings: { provider: 'gemini', model: 'gemini-3.8-flash' } }).model, 'gemini-3.5-flash-lite')
  assert.equal(routeModel({ task: 'chat', text: 'refactor it', settings: { provider: 'openrouter', model: 'x' } }).model, 'anthropic/claude-opus-5.5')
  const ollama = routeModel({ task: 'agent', text: '', settings: { provider: 'ollama', model: 'qwen3.8' } })
  assert.equal(ollama.model, 'qwen3.8')
  assert.match(ollama.reason, /no cheap\/big models/)
  const custom = routeModel({ task: 'agent', text: '', settings: { provider: 'openai', model: 'gpt-6-astra', tiers: { openai: { cheap: 'gpt-6.1-sol' } } } })
  assert.equal(custom.model, 'gpt-6.1-sol')
})
