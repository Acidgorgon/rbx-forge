// Labs model resolution with a Claude subscription sign-in: the Labs (VFX, Animation, Ability,
// Thumbnail, UI Motion) call agent/index.ts oneShot through visionShot with a tier. They used to
// resolve only from the Settings default model (unset = claude-opus-5-5) and the provider's tier ids,
// never from the model chat actually answers on, and every failure was swallowed into the built-in
// draft / numbers-only check. These tests reproduce that with a fake Agent SDK query function and a
// "signed in with Claude, no API key" credentials state.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { createAgentLayer, labModelInfo, lastChatModel, resetLabModelFailures, shotAttempts } from '../src/main/agent/index.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { LAST_CHAT_MODEL_SETTING, resolveLabModel } from '../src/shared/labModels.ts'
import { TIER_DEFAULTS } from '../src/main/agent/budget/budget.ts'
import { PROVIDERS } from '../src/main/agent/providers.ts'
import { VfxService, draftedWithout, visionFailed, scriptName } from '../src/main/services/vfx/service.ts'
import { shortTitle } from '../src/shared/vfx/spec.ts'
import { draftSpec } from '../src/shared/vfx/draft.ts'
import { heuristicCritique } from '../src/shared/vfx/critique.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { AUTH_PROBE_SYSTEM } from '../src/main/accounts/authHealth.ts'

const PLAN_REJECTS = 'API Error: 403 {"type":"error","error":{"type":"permission_error","message":"claude-opus-5-5 is not available on this account"}}'

// The Claude CLI behind a subscription that answers on some models and rejects others (an error
// result, as the Agent SDK reports a failed request).
function subscriptionSdk(works: (model: string) => boolean, answer: (model: string, prompt: string) => string = () => 'ok') {
  const calls: { model: string; chat: boolean; env?: Record<string, string | undefined> }[] = []
  // Sign-in checks after a per-model 403 (accounts/authHealth.ts), kept apart from the lab calls.
  const probes: string[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    const model = String(options.model)
    if (options.systemPrompt === AUTH_PROBE_SYSTEM) probes.push(model)
    else calls.push({ model, chat: Array.isArray(options.tools) && options.tools.length > 0, env: options.env })
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's' } as any
      if (!works(model)) {
        yield { type: 'result', subtype: 'success', is_error: true, result: PLAN_REJECTS, session_id: 's' } as any
        return
      }
      const text = answer(model, typeof prompt === 'string' ? prompt : '')
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: text, session_id: 's' } as any
    })()
  }
  return { calls, probes, queryFn }
}

// Signed in with Claude (claude auth login --claudeai): the login setting on, the CLI reports a
// login, no Anthropic API key anywhere.
function signedInWithClaude() {
  const fake = fakeContext()
  fake.settings.set('anthropicUseClaudeLogin', true)
  const credentials = new Credentials(fake.ctx, async () => null, { HOME: '/nonexistent' })
  credentials.setLoginProbe(() => true)
  return { fake, credentials }
}

async function until(fn: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('tier defaults are current Claude model ids, and the Anthropic model list matches them', () => {
  assert.deepEqual(TIER_DEFAULTS.anthropic, { cheap: 'claude-haiku-5-5', big: 'claude-opus-5-5' })
  for (const id of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) assert.ok(PROVIDERS.anthropic.defaults.includes(id), id)
  assert.equal(resolveLabModel('critic', {}, 'claude-haiku-5-5', TIER_DEFAULTS.anthropic!), 'claude-opus-5-5')
  assert.equal(resolveLabModel('cheap', {}, 'claude-haiku-5-5', TIER_DEFAULTS.anthropic!), 'claude-haiku-5-5')
  assert.equal(resolveLabModel('default', {}, 'claude-haiku-5-5', TIER_DEFAULTS.anthropic!), 'claude-haiku-5-5')
})

test('shotAttempts: tier model, then the base model, per base, without repeats', () => {
  const pick = (b: { provider: string; model: string }) => (b.provider === 'anthropic' ? 'claude-opus-5-5' : b.model)
  assert.deepEqual(
    shotAttempts([{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'anthropic', model: 'claude-haiku-5-5' }], pick as never),
    [{ provider: 'anthropic', model: 'claude-opus-5-5' }, { provider: 'anthropic', model: 'claude-haiku-5-5' }]
  )
  assert.deepEqual(
    shotAttempts([{ provider: 'codex', model: 'codex-default' }, { provider: 'anthropic', model: 'claude-haiku-5-5' }], pick as never).map((a) => `${a.provider}:${a.model}`),
    ['codex:codex-default', 'anthropic:claude-opus-5-5', 'anthropic:claude-haiku-5-5']
  )
})

test('signed in with Claude, no API key: Labs calls use the model chat answers on (repro: they fell back to "no model")', async () => {
  resetLabModelFailures()
  const { fake, credentials } = signedInWithClaude()
  // The subscription answers on Haiku 5.5 (what chat uses) and rejects the flagship tier.
  const sdk = subscriptionSdk((m) => m !== 'claude-opus-5-5')
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  try {
    // Chat on Haiku 5.5 works, through the Claude login (no ANTHROPIC_API_KEY in the CLI's env).
    const chat = layer.chats.create({ provider: 'anthropic', model: 'claude-haiku-5-5' })
    await layer.chats.send(chat.id, 'hello')
    await until(() => !!fake.settings.get(LAST_CHAT_MODEL_SETTING))
    const chatCall = sdk.calls.find((c) => c.chat)!
    assert.equal(chatCall.model, 'claude-haiku-5-5')
    assert.equal(chatCall.env?.ANTHROPIC_API_KEY, undefined)
    assert.deepEqual(lastChatModel(fake.ctx), { provider: 'anthropic', model: 'claude-haiku-5-5' })

    // Labs settings all automatic, no default model set: critic -> claude-opus-5-5, default -> the
    // Settings default (claude-opus-5-5). Both are rejected; the call now goes on to chat's model.
    sdk.calls.length = 0
    assert.equal(await layer.visionShot('critic', 'rate it', [{ mime: 'image/png', base64: 'AA==' }], { tier: 'critic' }), 'ok')
    assert.deepEqual(sdk.calls.map((c) => c.model), ['claude-opus-5-5', 'claude-haiku-5-5'])
    // The rejected model is remembered for a while: the next calls go straight to the working one.
    sdk.calls.length = 0
    assert.equal(await layer.visionShot('compose', 'write it', [], { tier: 'default' }), 'ok')
    assert.equal(await layer.visionShot('tag', 'tag it', [], { tier: 'cheap' }), 'ok')
    assert.deepEqual(sdk.calls.map((c) => c.model), ['claude-haiku-5-5', 'claude-haiku-5-5'])
    // The per-model 403 did not mark the Claude login expired: a probe on Haiku answered.
    await until(() => sdk.probes.length > 0)
    assert.deepEqual(sdk.probes, ['claude-haiku-5-5'])
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(credentials.health.failed('claudeLogin'), false)
  } finally {
    layer.dispose()
    resetLabModelFailures()
  }
})

test('when no model answers, the error says what failed (never a silent "no model")', async () => {
  resetLabModelFailures()
  const { fake, credentials } = signedInWithClaude()
  const sdk = subscriptionSdk(() => false)
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  try {
    fake.settings.set(LAST_CHAT_MODEL_SETTING, { provider: 'anthropic', model: 'claude-sonnet-5-5' })
    await assert.rejects(layer.visionShot('s', 'p', [], { tier: 'critic' }), (e: Error) => {
      assert.match(e.message, /no model answered/)
      assert.match(e.message, /claude-opus-5-5: API Error: 403/)
      assert.match(e.message, /claude-sonnet-5-5: API Error: 403/)
      return true
    })
    // Not signed in at all: the credentials' own message comes through.
    resetLabModelFailures()
    fake.settings.set('anthropicUseClaudeLogin', false)
    fake.settings.delete(LAST_CHAT_MODEL_SETTING)
    await assert.rejects(layer.visionShot('s', 'p', [], { tier: 'default' }), /Sign in with Claude or add an Anthropic API key/)
  } finally {
    layer.dispose()
    resetLabModelFailures()
  }
})

test('a signed-in Codex default with a broken Codex falls back to the Claude chat model', async () => {
  resetLabModelFailures()
  const { fake, credentials } = signedInWithClaude()
  const { setCodexService, codexService } = await import('../src/main/agent/codex/service.ts')
  const before = codexService()
  setCodexService({ oneShot: async () => { throw new Error('Codex is not signed in. Use "Sign in with ChatGPT (Codex)" in Settings > Accounts > OpenAI.') } } as never)
  const sdk = subscriptionSdk(() => true)
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  try {
    fake.settings.set('defaultModel', { provider: 'codex', model: 'codex-default' })
    fake.settings.set(LAST_CHAT_MODEL_SETTING, { provider: 'anthropic', model: 'claude-haiku-5-5' })
    assert.equal(await layer.visionShot('s', 'p', [], { tier: 'critic' }), 'ok')
    assert.deepEqual(sdk.calls.map((c) => c.model), ['claude-opus-5-5'])
  } finally {
    layer.dispose()
    setCodexService(before)
    resetLabModelFailures()
  }
})

test('fallback names are a short title, not the CamelCased prompt', () => {
  const p = 'quick dash forward with a wind streak trail and a burst of sparks at the start'
  assert.equal(shortTitle(p), 'DashForward')
  assert.equal(scriptName('return function(fx) end', p), 'DashForward')
  assert.equal(draftSpec(p).name, 'DashForward')
  assert.equal(shortTitle('make a blue fireball effect'), 'BlueFireball')
  assert.equal(shortTitle('a fireball that charges, flies forward and explodes'), 'Fireball')
  assert.equal(shortTitle('!!!'), 'Effect')
  assert.ok(shortTitle('supercalifragilistic expialidocious lightning tornado').length <= 24)
})

test('a numbers-only critique after a failed vision call names the error', () => {
  const c = visionFailed(heuristicCritique(draftSpecEffect(), null, []), 'claude-opus-5-5: API Error: 403')
  assert.match(c.summary, /^Numbers-only check \(the vision model call failed: claude-opus-5-5: API Error: 403/)
  assert.doesNotMatch(c.summary, /no vision model/)
  assert.equal(draftedWithout('boom\n  bang'), 'Drafted without a model because: boom bang')
})

function draftSpecEffect() {
  return { name: 'X', roots: [], cues: [], duration: 1 } as never
}

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()

test('VFX Lab compose with a subscription that rejects the flagship: the model writes it; when every model fails, the entry says why', { skip: !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  resetLabModelFailures()
  const script = '```lua\n-- Name: Wind Dash\nreturn function(fx)\n\tfx:stage("dash")\n\tfx:spawn("orb", { name = "Core", color = Color3.new(0.8, 1, 1) })\n\tfx:wait(0.3)\n\tfx:stage("trail")\n\tfx:wait(0.3)\nend\n```'
  const { fake, credentials } = signedInWithClaude()
  let works: (m: string) => boolean = (m) => m === 'claude-haiku-5-5'
  const sdk = subscriptionSdk((m) => works(m), () => script)
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  const make = async () =>
    new VfxService({
      userDir: await mkdtemp(join(tmpdir(), 'forge-labfix-user-')),
      projectRoot: () => null,
      lune: async () => ({ path: lune! }),
      runtimeDir: () => runtime,
      // As main/index.ts wires it (labModel): the agent layer's visionShot with the Labs tier.
      vision: (tier) => (system, prompt, images) => layer.visionShot(system, prompt, images, { tier: tier ?? 'default' })
    })
  try {
    fake.settings.set(LAST_CHAT_MODEL_SETTING, { provider: 'anthropic', model: 'claude-haiku-5-5' })
    const prompt = 'quick dash forward with a wind streak trail and a burst of sparks at the start'
    const r = await (await make()).compose(prompt, { refine: false })
    assert.equal(r.source, 'model')
    assert.equal(r.entry!.name, 'WindDash')
    assert.equal(r.entry!.modelNote, undefined)
    // Every model fails: the built-in draft, with the actual error on the entry and the result.
    resetLabModelFailures()
    works = () => false
    const d = await (await make()).compose(prompt, { refine: false })
    assert.equal(d.source, 'draft')
    assert.equal(d.entry!.name, 'DashForward')
    assert.match(d.modelError!, /claude-haiku-5-5: API Error: 403/)
    assert.match(d.entry!.modelNote!, /^Drafted without a model because: no model answered \(claude-opus-5-5: API Error: 403/)
  } finally {
    layer.dispose()
    resetLabModelFailures()
  }
})

test('Settings > Labs sees a model the account rejected (labModelInfo.rejected), not a transient error', async () => {
  resetLabModelFailures()
  const { fake, credentials } = signedInWithClaude()
  const sdk = subscriptionSdk((m) => m !== 'claude-opus-5-5')
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  try {
    fake.settings.set(LAST_CHAT_MODEL_SETTING, { provider: 'anthropic', model: 'claude-haiku-5-5' })
    assert.deepEqual(labModelInfo(fake.ctx, layer.providers.defaultModel()).rejected, [])
    assert.equal(await layer.visionShot('critic', 'rate it', [], { tier: 'critic' }), 'ok')
    const info = labModelInfo(fake.ctx, layer.providers.defaultModel())
    assert.deepEqual(info.rejected.map((r) => `${r.provider}:${r.model}`), ['anthropic:claude-opus-5-5'])
    assert.match(info.rejected[0].message, /403/)
    assert.ok(info.rejected[0].until > Date.now())
    assert.equal(info.auto.critic, 'claude-opus-5-5')
    resetLabModelFailures()
    assert.deepEqual(labModelInfo(fake.ctx, layer.providers.defaultModel()).rejected, [])
  } finally {
    layer.dispose()
    resetLabModelFailures()
  }
})

test('shotReady: true only when a provider a Labs call would try is set up (no model call)', async () => {
  resetLabModelFailures()
  const { fake, credentials } = signedInWithClaude()
  const sdk = subscriptionSdk(() => true)
  const layer = createAgentLayer(fake.ctx, { queryFn: sdk.queryFn, credentials, meterSaveDelayMs: 0 })
  try {
    assert.equal(await layer.shotReady(), true)
    // Not signed in, no key, no other provider: the Labs draft and check without a model.
    fake.settings.set('anthropicUseClaudeLogin', false)
    assert.equal(await layer.shotReady(), false)
    // The last chat model on Custom counts once Custom has a base URL.
    fake.settings.set(LAST_CHAT_MODEL_SETTING, { provider: 'custom', model: 'fake' })
    assert.equal(await layer.shotReady(), false)
    layer.providers.setConfig('custom', { baseUrl: 'http://127.0.0.1:9/v1' })
    assert.equal(await layer.shotReady(), true)
    assert.equal(sdk.calls.length, 0)
  } finally {
    layer.dispose()
    resetLabModelFailures()
  }
})
