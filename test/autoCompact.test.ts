// Auto-compact (shared/autoCompact.ts): the setting's threshold on the OpenAI-compatible loop (the
// "Compacted" divider and the summary), off = never, the Agent SDK env override and its
// compact_boundary divider, /compact's divider, and the context meter on the chat session.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fakeContext } from './agentFake.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { SUMMARY_INSTRUCTIONS } from '../src/main/agent/budget/compact.ts'
import { AUTO_COMPACT_DEFAULT, clampCompactPct, compactLabel, compactTarget, compactTrigger, contextWindow, readAutoCompact, sdkCompactEnv } from '../src/shared/autoCompact.ts'

async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

test('threshold: default 80% on, clamped 50..95, trigger and target from the window', () => {
  assert.deepEqual(AUTO_COMPACT_DEFAULT, { enabled: true, pct: 80 })
  const settings = new Map<string, unknown>()
  const get = <T,>(k: string, f: T) => (settings.has(k) ? (settings.get(k) as T) : f)
  assert.deepEqual(readAutoCompact(get), { enabled: true, pct: 80 })
  settings.set('autoCompactPct', 120)
  assert.equal(readAutoCompact(get).pct, 95)
  settings.set('autoCompactPct', 'x')
  assert.equal(readAutoCompact(get).pct, 80)
  settings.set('autoCompact', false)
  assert.equal(readAutoCompact(get).enabled, false)
  assert.equal(clampCompactPct(10), 50)
  assert.equal(compactTrigger(200_000, { enabled: true, pct: 80 }), 160_000)
  assert.equal(compactTarget(160_000), 80_000)
  assert.equal(compactTrigger(200_000, { enabled: false, pct: 80 }), null)
  assert.equal(compactTrigger(null, { enabled: true, pct: 80 }), null)
  assert.equal(contextWindow('codex', 'any'), null, 'the Codex CLI keeps its own window')
  assert.equal(contextWindow('anthropic', 'some-model'), 200_000)
  assert.equal(contextWindow('anthropic', 'some-model[1m]'), 1_000_000)
  assert.equal(contextWindow('openrouter', 'x/y', { reported: 64_000, fallback: 120_000 }), 64_000)
  assert.equal(contextWindow('openai', 'x', { fallback: 90_000 }), 90_000)
  assert.deepEqual(sdkCompactEnv({ enabled: true, pct: 70 }), { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '70' })
  assert.deepEqual(sdkCompactEnv({ enabled: false, pct: 70 }), { DISABLE_AUTO_COMPACT: '1' })
  assert.equal(compactLabel(142_000, 48_000), 'Compacted · 142k → 48k tokens')
  assert.equal(compactLabel(1_500_000), 'Compacted · 1.5M tokens')
})

// An OpenAI-compatible chat on a fake endpoint: answers 'ok', the summarizer answers SUMMARY.
async function oaiChat(settings: Record<string, unknown>) {
  const bodies: any[] = []
  const sse = (content: string) => new Response(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content } }] })}\n\ndata: [DONE]\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  const f = (async (url: string, init: RequestInit = {}) => {
    if (String(url).includes('/models')) return new Response(JSON.stringify({ data: [] }), { status: 200 })
    const body = JSON.parse(String(init.body))
    bodies.push(body)
    return sse(body.messages[0]?.content === SUMMARY_INSTRUCTIONS ? '- SUMMARY: the user sent two long notes' : 'ok')
  }) as unknown as typeof fetch
  const fake = fakeContext()
  for (const [k, v] of Object.entries(settings)) fake.settings.set(k, v)
  const creds = new Credentials(fake.ctx, async () => null, {})
  await creds.setKey('openai', 'key-openai')
  const providers = new Providers(fake.ctx, creds, f)
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn: f, toolFs: fake.fs, checkpoints: null })
  const c = chats.create({ provider: 'openai', model: 'test-model' })
  const turn = async (text: string) => {
    await chats.send(c.id, text)
    await until(() => !chats.busy(c.id))
  }
  return { chats, c, bodies, turn, fake }
}

const long = (tag: string) => `${tag} ${'lorem ipsum dolor sit amet '.repeat(220)}`

test('OpenAI loop: compacts at the setting share of the window and posts the divider with the summary', async () => {
  // 4000-token window at 50%: compaction once the history passes 2000 tokens.
  const { chats, c, bodies, turn } = await oaiChat({ compactWindowTokens: 4000, autoCompactPct: 50 })
  await turn(long('one'))
  await turn(long('two'))
  assert.ok(!chats.messages(c.id)!.some((m) => m.compact), 'no compaction below the threshold')
  await turn('three')
  const div = chats.messages(c.id)!.find((m) => m.compact)
  assert.ok(div, 'a divider was posted')
  assert.equal(div!.role, 'system')
  assert.equal(div!.compact!.trigger, 'auto')
  assert.ok(div!.compact!.before > 2000 && div!.compact!.after! < div!.compact!.before, JSON.stringify(div!.compact))
  assert.match(div!.text, /^Compacted · [\d.]+k → [\d.]+k? tokens$/)
  assert.match(div!.compact!.summary ?? '', /SUMMARY/)
  // The request for "three" carries the summary instead of turn one.
  const last = bodies.at(-1)
  const sent = JSON.stringify(last.messages)
  assert.match(sent, /SUMMARY: the user sent two long notes/)
  assert.doesNotMatch(sent, /one lorem/)
  // The divider never goes to a model.
  assert.doesNotMatch(sent, /Compacted ·/)
  // The meter starts again from the compacted size (the fake reports no usage).
  assert.deepEqual(chats.list().find((s) => s.id === c.id)!.context, { tokens: div!.compact!.after, window: 4000, trigger: 2000 })
})

test('OpenAI loop: a higher threshold waits longer; auto-compact off never compacts', async () => {
  const high = await oaiChat({ compactWindowTokens: 4000, autoCompactPct: 95 })
  await high.turn(long('one'))
  await high.turn(long('two'))
  await high.turn('three')
  assert.ok(!high.chats.messages(high.c.id)!.some((m) => m.compact), '95% of 4000 is not reached by ~2.9k tokens')
  assert.ok(!high.bodies.some((b) => b.messages[0]?.content === SUMMARY_INSTRUCTIONS))

  const off = await oaiChat({ compactWindowTokens: 4000, autoCompactPct: 50, autoCompact: false })
  await off.turn(long('one'))
  await off.turn(long('two'))
  await off.turn('three')
  assert.ok(!off.chats.messages(off.c.id)!.some((m) => m.compact))
  assert.match(JSON.stringify(off.bodies.at(-1).messages), /one lorem/, 'the whole history is sent')
})

// An SDK stub that reports usage and, on the second query, compacts.
function sdkStub() {
  const calls: { prompt: string; options: any }[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt: String(prompt), options })
    const o = options as any
    const n = calls.length
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's1' } as any
      if (n === 2) {
        await o.hooks.PostCompact[0].hooks[0]({ hook_event_name: 'PostCompact', trigger: 'auto', compact_summary: '- goal: shop UI' }, undefined, { signal: new AbortController().signal })
        yield { type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'auto', pre_tokens: 142_000, post_tokens: 48_000 }, session_id: 's1' } as any
      }
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's1', message: { content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1000, cache_read_input_tokens: 60_000, output_tokens: 10 } } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's1', usage: { input_tokens: 1000, output_tokens: 10 } } as any
    })()
  }
  return { calls, queryFn }
}

test('Agent SDK: the threshold goes to the CLI, its compaction becomes a divider with the summary, the meter shows the window use', async () => {
  const fake = fakeContext()
  fake.settings.set('autoCompactPct', 70)
  const s = sdkStub()
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-test' })
  const chats = new ChatManager(fake.ctx, { queryFn: s.queryFn, credentials, toolFs: fake.fs, checkpoints: null })
  const c = chats.create()
  await chats.send(c.id, 'hi')
  await until(() => !chats.busy(c.id))
  assert.equal(s.calls[0].options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, '70')
  assert.equal(s.calls[0].options.env.DISABLE_AUTO_COMPACT, undefined)
  assert.ok(s.calls[0].options.hooks.PreToolUse, 'the mode guard hook is kept')
  const ctxUse = chats.list().find((x) => x.id === c.id)!.context
  assert.deepEqual(ctxUse, { tokens: 61_000, window: 200_000, trigger: 140_000 })

  await chats.send(c.id, 'go on')
  await until(() => !chats.busy(c.id))
  const divs = chats.messages(c.id)!.filter((m) => m.compact)
  assert.equal(divs.length, 1)
  assert.equal(divs[0].text, 'Compacted · 142k → 48k tokens')
  assert.deepEqual(divs[0].compact, { trigger: 'auto', before: 142_000, after: 48_000, summary: '- goal: shop UI' })

  fake.settings.set('autoCompact', false)
  await chats.send(c.id, 'again')
  await until(() => !chats.busy(c.id))
  assert.equal(s.calls[2].options.env.DISABLE_AUTO_COMPACT, '1')
  assert.equal(s.calls[2].options.env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE, undefined)
  assert.equal(chats.list().find((x) => x.id === c.id)!.context?.trigger, undefined, 'off: no trigger on the meter')
})

test('/compact posts a manual divider with the summary and resets the meter', async () => {
  const fake = fakeContext()
  const s = sdkStub()
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-test' })
  const chats = new ChatManager(fake.ctx, { queryFn: s.queryFn, credentials, toolFs: fake.fs, checkpoints: null, oneShot: async () => '- goal: keep the UI decisions' })
  const c = chats.create()
  await chats.send(c.id, 'build the shop UI')
  await until(() => !chats.busy(c.id))
  await chats.command(c.id, 'compact', 'keep the UI decisions')
  const div = chats.messages(c.id)!.at(-1)!
  assert.equal(div.command, '/compact keep the UI decisions')
  assert.equal(div.compact?.trigger, 'manual')
  assert.equal(div.compact?.before, 61_000, 'before = the last request\'s real context')
  assert.equal(div.compact?.summary, '- goal: keep the UI decisions')
  assert.match(div.text, /^Compacted: ~61k → ~\d+ tokens/)
  assert.equal(chats.list().find((x) => x.id === c.id)!.context, undefined)
})
