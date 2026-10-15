// Settings > Labs model dropdowns (renderer pages/settings/LabModelSelect.tsx): the option list,
// tier hints, how a stored value shows (Auto / a listed model / "Custom: <id>"), recent rejections,
// and main's labModelInfo (what each tier's Auto resolves to now).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  labModelGroups,
  labModelHint,
  labModelSelection,
  labRejection,
  normalizeLabModels,
  shortModelId,
  smallModelHint,
  type LabModelInfo
} from '../src/shared/labModels.ts'
import { labModelInfo } from '../src/main/agent/index.ts'
import { TIER_DEFAULTS } from '../src/main/agent/budget/budget.ts'
import type { ProviderId } from '../src/shared/types.ts'

const providers = [
  { id: 'anthropic' as ProviderId, label: 'Anthropic', ready: true, models: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'] },
  { id: 'openai' as ProviderId, label: 'OpenAI', ready: true, models: ['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna'] },
  { id: 'gemini' as ProviderId, label: 'Gemini', ready: false, models: ['gemini-3.8-flash'] },
  { id: 'ollama' as ProviderId, label: 'Ollama', ready: true, models: ['qwen3.8', 'llama3.2:1b'] },
  { id: 'codex' as ProviderId, label: 'Codex (ChatGPT plan)', ready: true, models: ['codex-default', 'gpt-6.1-sol'] }
]

function info(over: Partial<LabModelInfo> = {}): LabModelInfo {
  return {
    provider: 'openai',
    auto: { cheap: 'gpt-6-luna', default: 'gpt-5.6-terra', critic: 'gpt-6-astra' },
    tiers: { anthropic: TIER_DEFAULTS.anthropic!, openai: TIER_DEFAULTS.openai! },
    rejected: [],
    ...over
  }
}

test('tier hints: the provider pair first, then by name; no guess for tier-less providers', () => {
  const a = TIER_DEFAULTS.anthropic!
  assert.equal(labModelHint('claude-haiku-5-5', a), 'cheap')
  assert.equal(labModelHint('claude-opus-5-5', a), 'flagship')
  assert.equal(labModelHint('claude-sonnet-5-5', a), 'balanced')
  assert.equal(labModelHint('gpt-6-luna', TIER_DEFAULTS.openai), 'cheap')
  assert.equal(labModelHint('gpt-6-astra', TIER_DEFAULTS.openai), 'flagship')
  assert.equal(labModelHint('gemini-3.1-pro-preview', TIER_DEFAULTS.gemini), 'flagship')
  assert.equal(labModelHint('gemini-3.8-flash', TIER_DEFAULTS.gemini), 'balanced')
  assert.equal(labModelHint('gemini-3.5-flash-lite', null), 'cheap')
  // Ollama / custom: only small models get a hint.
  assert.equal(labModelHint('qwen3.8', null), null)
  assert.equal(labModelHint('llama3.2:1b', null), 'cheap')
})

test('groups: ready providers only, default provider first, Codex left out, hints attached', () => {
  const groups = labModelGroups(providers, info())
  assert.deepEqual(
    groups.map((g) => [g.provider, g.primary]),
    [
      ['openai', true],
      ['anthropic', false],
      ['ollama', false]
    ]
  )
  assert.deepEqual(
    groups[0].options.map((o) => [o.model, o.hint]),
    [
      ['gpt-6-astra', 'flagship'],
      ['gpt-5.6-terra', 'balanced'],
      ['gpt-6-luna', 'cheap']
    ]
  )
  assert.deepEqual(
    groups.find((g) => g.provider === 'anthropic')!.options.map((o) => o.hint),
    ['flagship', 'balanced', 'cheap']
  )
  // A fetched /models list replaces the provider's defaults (as the chat picker does).
  const fetched = labModelGroups(providers, info(), { ollama: ['qwen3.8', 'mistral-large'] })
  assert.deepEqual(fetched.find((g) => g.provider === 'ollama')!.options.map((o) => o.model), ['qwen3.8', 'mistral-large'])
  // No info yet (main not answered): the order is the providers' own, nothing is primary.
  assert.deepEqual(labModelGroups(providers, null).map((g) => g.provider), ['anthropic', 'openai', 'ollama'])
  // Nothing ready: no groups (the dropdown still has Auto and Custom…).
  assert.deepEqual(labModelGroups(providers.map((p) => ({ ...p, ready: false })), info()), [])
  assert.deepEqual(labModelGroups(null, info()), [])
})

test('recent rejections mark that provider\'s entry only, and expire', () => {
  const now = Date.now()
  const i = info({
    provider: 'anthropic',
    rejected: [
      { provider: 'anthropic', model: 'claude-opus-5-5', message: 'API Error: 403 not available on this account', until: now + 60_000 },
      { provider: 'anthropic', model: 'claude-sonnet-5-5', message: 'old', until: now - 1 }
    ]
  })
  const groups = labModelGroups(providers, i)
  const anthropic = groups.find((g) => g.provider === 'anthropic')!
  assert.match(anthropic.options.find((o) => o.model === 'claude-opus-5-5')!.rejected!, /403/)
  assert.equal(anthropic.options.find((o) => o.model === 'claude-sonnet-5-5')!.rejected, undefined)
  assert.ok(groups.flatMap((g) => g.options).filter((o) => o.rejected).length === 1)
  // The Auto entry: a rejection of what auto resolves to on the default provider.
  assert.match(labRejection(i, 'claude-opus-5-5')!, /403/)
  assert.equal(labRejection(i, 'claude-sonnet-5-5'), null)
  assert.equal(labRejection(i, 'claude-opus-5-5', 'openai'), null)
  assert.equal(labRejection(null, 'claude-opus-5-5'), null)
})

test('a stored value shows as Auto, a listed model, or Custom: <id> (stored values unchanged)', () => {
  const groups = labModelGroups(providers, info())
  assert.deepEqual(labModelSelection('', groups), { kind: 'auto' })
  assert.deepEqual(labModelSelection(undefined, groups), { kind: 'auto' })
  assert.deepEqual(labModelSelection('   ', groups), { kind: 'auto' })
  const sel = labModelSelection('claude-sonnet-5-5', groups)
  assert.equal(sel.kind, 'model')
  assert.equal(sel.kind === 'model' && sel.option.provider, 'anthropic')
  assert.deepEqual(labModelSelection('my-finetune-v2', groups), { kind: 'custom', model: 'my-finetune-v2' })
  // Codex models are not listed for the Labs, so a stored Codex id is a custom id.
  assert.deepEqual(labModelSelection('codex-default', groups), { kind: 'custom', model: 'codex-default' })
  // With no providers ready every non-empty value is custom.
  assert.deepEqual(labModelSelection('claude-opus-5-5', []), { kind: 'custom', model: 'claude-opus-5-5' })
  // The settings shape the dropdown writes is the one main always read.
  assert.deepEqual(normalizeLabModels({ cheap: '', default: 'claude-sonnet-5-5', critic: ' my-finetune-v2 ' }), { default: 'claude-sonnet-5-5', critic: 'my-finetune-v2' })
})

test('small-model hint follows what a tier resolves to (Auto included)', () => {
  const auto = info({ provider: 'anthropic', auto: { cheap: 'claude-haiku-5-5', default: 'claude-haiku-5-5', critic: 'claude-opus-5-5' } })
  assert.match(smallModelHint('default', auto.auto.default)!, /small model \(claude-haiku-5-5\)/)
  assert.equal(smallModelHint('critic', auto.auto.critic), null)
  assert.equal(smallModelHint('cheap', auto.auto.cheap), null)
  assert.match(smallModelHint('critic', 'gpt-6-mini')!, /Critiquing on a small model/)
})

test('shortModelId: the chat picker\'s short form', () => {
  assert.equal(shortModelId('claude-haiku-5-5'), 'haiku-5-5')
  assert.equal(shortModelId('anthropic/claude-opus-5.5'), 'opus-5.5')
  assert.equal(shortModelId('claude-sonnet-4-5-20250929'), 'sonnet-4-5')
  assert.equal(shortModelId('gpt-6-luna'), 'gpt-6-luna')
})

test('labModelInfo: Auto per tier on the default model, tier overrides, Codex and tier-less providers', () => {
  const settings = new Map<string, unknown>()
  const ctx = { getSetting: <T>(k: string, f: T): T => (settings.has(k) ? (settings.get(k) as T) : f) }
  const a = labModelInfo(ctx, { provider: 'anthropic', model: 'claude-sonnet-5-5' })
  assert.equal(a.provider, 'anthropic')
  assert.deepEqual(a.auto, { cheap: 'claude-haiku-5-5', default: 'claude-sonnet-5-5', critic: 'claude-opus-5-5' })
  assert.deepEqual(a.tiers.openai, TIER_DEFAULTS.openai)
  assert.equal(a.tiers.ollama, undefined)
  // Settings > Budgets tier overrides change what Auto means.
  settings.set('modelTiers', { anthropic: { big: 'claude-sonnet-5-5' } })
  assert.equal(labModelInfo(ctx, { provider: 'anthropic', model: 'claude-haiku-5-5' }).auto.critic, 'claude-sonnet-5-5')
  // No tier pair (Ollama): every tier's auto is the chat model.
  assert.deepEqual(labModelInfo(ctx, { provider: 'ollama', model: 'qwen3.8' }).auto, { cheap: 'qwen3.8', default: 'qwen3.8', critic: 'qwen3.8' })
  // Codex: Labs calls always run on the Codex model itself.
  assert.deepEqual(labModelInfo(ctx, { provider: 'codex', model: 'codex-default' }).auto, { cheap: 'codex-default', default: 'codex-default', critic: 'codex-default' })
})
