// Chat subagents (the Agent SDK's Agent tool): options per mode, the named subagents, the gating a
// subagent inherits (Ask never writes, project bounds hold), the chat chips and the usage meter.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import { fakeContext, type Fake } from './agentFake.ts'
import type { ServiceTool } from '../src/main/context.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Meter } from '../src/main/agent/meter.ts'
import { SubagentChips, subagentSummary, toChatMessages, type QueryFn } from '../src/main/agent/sdk.ts'
import { gentreeTools } from '../src/main/agent/tools.ts'
import { chatSubagents, modeNote, sdkModeOptions, subagentDenial, toolCatalog } from '../src/main/agent/modes.ts'
import type { ChatMode } from '../src/shared/chatModes.ts'

const ok = (text: string) => ({ content: [{ type: 'text' as const, text }] })
const svc = (name: string): ServiceTool => ({ name, description: name, inputSchema: { x: z.string().optional() }, handler: async () => ok(`${name} ran`) })

function withServices(fake: Fake): Fake {
  fake.ctx.serviceTools = () => ({ read: [svc('project_map')], tests: [svc('run_tests')], write: [svc('add_blink_event')], chat: [svc('run_in_terminal')] })
  return fake
}

async function until(fn: () => boolean, ms = 10000): Promise<void> {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

type Script = (options: any) => AsyncGenerator<any>

function sdk(script: Script = async function* () {}) {
  const calls: { prompt: string; options: any }[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    calls.push({ prompt: String(prompt), options })
    return (async function* () {
      yield { type: 'system', subtype: 'init', session_id: 's0' } as any
      yield* script(options)
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's0', message: { content: [{ type: 'text', text: 'Done.' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: 'Done.', session_id: 's0' } as any
    })()
  }
  return { calls, queryFn }
}

function manager(fake: Fake, queryFn: QueryFn, extra: Record<string, unknown> = {}) {
  const credentials = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-test' })
  return new ChatManager(fake.ctx, { queryFn, credentials, toolFs: fake.fs, checkpoints: null, ...extra } as any)
}

async function optionsFor(mode: ChatMode, extra: Record<string, unknown> = {}): Promise<{ o: any; fake: Fake }> {
  const fake = withServices(fakeContext({ files: { 'src/shared/a.luau': 'return 1' } }))
  const s = sdk()
  const chats = manager(fake, s.queryFn, extra)
  const c = chats.create()
  chats.setMode(c.id, mode)
  await chats.send(c.id, 'look at a.luau')
  await until(() => !chats.busy(c.id) && s.calls.length === 1)
  return { o: s.calls[0].options, fake }
}

const can = (o: any, name: string, input: Record<string, unknown> = {}) => o.canUseTool(name, input, { signal: new AbortController().signal, toolUseID: 't' })
const hook = (o: any, name: string, input: Record<string, unknown> = {}) =>
  o.hooks.PreToolUse[0].hooks[0]({ hook_event_name: 'PreToolUse', tool_name: name, tool_input: input, tool_use_id: 't', agent_id: 'sub1', agent_type: 'explorer' }, 't', { signal: new AbortController().signal })

test('subagents: the Agent tool is offered in every mode; Ask / Plan only get the read-only agents', async () => {
  for (const mode of ['ask', 'plan', 'edit', 'auto'] as ChatMode[]) {
    const { o } = await optionsFor(mode)
    assert.ok(o.tools.includes('Agent'), `${mode}: Agent offered`)
    assert.ok(!(o.disallowedTools ?? []).includes('Agent'), `${mode}: Agent not disallowed`)
    const names = Object.keys(o.agents).sort()
    assert.deepEqual(names, mode === 'ask' || mode === 'plan' ? ['explorer', 'reviewer'] : ['builder', 'explorer', 'reviewer'])
    for (const n of ['explorer', 'reviewer']) {
      const tools: string[] = o.agents[n].tools
      assert.ok(tools.includes('Read') && tools.includes('mcp__gentree__read_script') && tools.includes('mcp__gentree__project_map'), `${n} reads`)
      for (const w of ['Edit', 'Write', 'Bash', 'Agent', 'mcp__gentree__write_script', 'mcp__gentree__edit_script', 'mcp__gentree__add_blink_event', 'mcp__gentree__update_todos']) assert.ok(!tools.includes(w), `${mode}: ${n} has no ${w}`)
    }
    if (o.agents.builder) {
      assert.equal(o.agents.builder.tools, undefined, 'builder inherits the chat tools')
      assert.ok(o.agents.builder.disallowedTools.includes('Agent'), 'no nested subagents')
    }
    // Foreground only (the turn waits, Stop ends them), and the CLI's own Explore / Plan agents are off.
    assert.equal(o.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS, '1')
    assert.equal(o.env.CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS, '1')
    assert.match(o.systemPrompt, /# Subagents/)
    assert.match(o.systemPrompt, /\/team/)
  }
})

test('subagents: Ask / Plan refuse write-capable agents and isolation; Edit starts any without a card', async () => {
  for (const mode of ['ask', 'plan'] as ChatMode[]) {
    const { o } = await optionsFor(mode)
    for (const type of ['builder', 'general-purpose', 'fork', undefined]) {
      const input = { description: 'x', prompt: 'y', ...(type ? { subagent_type: type } : {}) }
      assert.equal((await can(o, 'Agent', input)).behavior, 'deny', `${mode}: ${type}`)
      assert.equal((await can(o, 'Task', input)).behavior, 'deny', `${mode}: Task ${type}`)
      assert.equal((await hook(o, 'Agent', input)).hookSpecificOutput?.permissionDecision, 'deny', `${mode}: hook ${type}`)
    }
    for (const type of ['explorer', 'reviewer']) {
      assert.equal((await can(o, 'Agent', { description: 'x', prompt: 'y', subagent_type: type })).behavior, 'allow')
      assert.deepEqual(await hook(o, 'Agent', { description: 'x', prompt: 'y', subagent_type: type }), {})
    }
  }
  const { o } = await optionsFor('edit')
  assert.equal((await can(o, 'Agent', { description: 'x', prompt: 'y', subagent_type: 'builder' })).behavior, 'allow', 'no approval card for starting one')
  assert.equal((await can(o, 'Agent', { description: 'x', prompt: 'y', isolation: 'worktree' })).behavior, 'deny')
  assert.equal((await hook(o, 'Agent', { description: 'x', prompt: 'y', isolation: 'remote' })).hookSpecificOutput?.permissionDecision, 'deny')
  assert.match(subagentDenial('ask', { subagent_type: 'builder' })!, /explorer, reviewer/)
})

test('subagents: a subagent\'s own tool calls hit the same gating (Ask cannot write, bounds hold in Auto)', async () => {
  // The SDK routes a subagent's permission requests to the session canUseTool and fires the
  // session PreToolUse hooks with agent_id set: both are the chat's own, built per mode.
  const ask = (await optionsFor('ask')).o
  for (const w of ['Write', 'Edit', 'Bash', 'mcp__gentree__write_script', 'mcp__gentree__add_blink_event', 'mcp__studio__run_code']) {
    assert.equal((await can(ask, w, { file_path: '/fake/project/src/a.luau', path: 'src/a.luau', contents: 'x', command: 'ls' })).behavior, 'deny', `ask canUseTool ${w}`)
    assert.equal((await hook(ask, w, { file_path: '/fake/project/src/a.luau' })).hookSpecificOutput?.permissionDecision, 'deny', `ask hook ${w}`)
  }
  const auto = (await optionsFor('auto')).o
  for (const p of ['/etc/passwd', '/fake/project/../outside.luau', '/fake/project/Packages/x.lua']) {
    assert.equal((await hook(auto, 'Write', { file_path: p, content: 'x' })).hookSpecificOutput?.permissionDecision, 'deny', `auto hook keeps ${p} out`)
    assert.equal((await can(auto, 'Edit', { file_path: p, old_string: 'a', new_string: 'b' })).behavior, 'deny', `auto canUseTool keeps ${p} out`)
  }
  assert.deepEqual(await hook(auto, 'Write', { file_path: '/fake/project/src/shared/b.luau', content: 'x' }), {})
  // Edit mode: a subagent's write goes to the same approval card flow.
  const fake = withServices(fakeContext({ files: { 'src/shared/a.luau': 'return 1' } }))
  let decided = false
  const s = sdk(async function* (options) {
    const r = await options.canUseTool('mcp__gentree__write_script', { path: 'src/shared/a.luau', contents: 'return 2' }, { signal: new AbortController().signal, toolUseID: 'sub-tool', agentID: 'sub1' })
    decided = r.behavior === 'allow'
  })
  const chats = manager(fake, s.queryFn)
  const c = chats.create()
  chats.setMode(c.id, 'edit')
  await chats.send(c.id, 'change a')
  await until(() => chats.messages(c.id)!.some((m) => m.diff?.state === 'pending'))
  const card = chats.messages(c.id)!.find((m) => m.diff?.state === 'pending')!
  await chats.reviewEdit(c.id, card.id, { accept: true })
  await until(() => !chats.busy(c.id))
  assert.ok(decided)
})

test('subagents: prompts carry the project rules and layout', async () => {
  const { o } = await optionsFor('edit', { rules: async () => '\n\n# Project instructions\nRULE-NO-COMMENTS: no comments in game scripts' })
  for (const n of ['explorer', 'reviewer', 'builder']) {
    assert.match(o.agents[n].prompt, /RULE-NO-COMMENTS/, `${n} has the rules`)
    assert.match(o.agents[n].prompt, /Rojo/, `${n} has the layout`)
    assert.ok(o.agents[n].description.length > 20)
  }
  // Direct: the read agents use the read tool names only.
  const fake = withServices(fakeContext())
  const read = gentreeTools(fake.ctx, { readOnly: true, fs: fake.fs })
  const a = chatSubagents('plan', read.map((t) => t.name))
  assert.equal(a.builder, undefined)
  const opts = sdkModeOptions({ mode: 'ask', catalog: toolCatalog(read), serverTools: read.map((t) => t.name), allowBash: false, studio: false, bounds: async (_n, i) => ({ behavior: 'allow', updatedInput: i }), approve: async () => ({ behavior: 'deny', message: 'x' }), onPlan: () => {} })
  assert.deepEqual(Object.keys(opts.agents!).sort(), ['explorer', 'reviewer'])
  assert.equal(modeNote('edit', false), '', 'no subagent note off the SDK')
  assert.match(modeNote('ask', true), /read-only subagents/)
})

test('subagents: one chip per subagent with its description, tool count and summary', () => {
  const subs = new SubagentChips()
  const start = toChatMessages({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Looking in parallel.' }, { type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Find coin logic', prompt: 'long prompt', subagent_type: 'explorer' } }, { type: 'tool_use', id: 'tu2', name: 'Agent', input: { description: 'Review shop', prompt: 'p', subagent_type: 'reviewer' } }] } } as any, 'main', subs)
  assert.equal(start.length, 3)
  assert.equal(start[0].role, 'assistant')
  const [c1, c2] = [start[1], start[2]]
  assert.deepEqual(c1.tool, { name: 'agent:explorer', input: 'Find coin logic' })
  assert.equal(c2.tool!.name, 'agent:reviewer')
  // Subagent traffic: only the chip updates (same id), no messages of its own.
  const p1 = toChatMessages({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'x1', name: 'mcp__gentree__search_code', input: {} }, { type: 'tool_use', id: 'x2', name: 'Read', input: {} }] } } as any, 'main', subs)
  assert.equal(p1.length, 1)
  assert.equal(p1[0].id, c1.id)
  assert.equal(p1[0].tool!.input, 'Find coin logic · 2 tool calls')
  assert.deepEqual(toChatMessages({ type: 'user', parent_tool_use_id: 'tu1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'lots of code' }] } } as any, 'main', subs), [])
  assert.deepEqual(toChatMessages({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'text', text: 'thinking aloud' }] } } as any, 'main', subs), [])
  // Results: summary without the CLI trailer; an error shows as failed.
  const done = toChatMessages({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Coins live in src/server/Features/Coins.\nagentId: abc123\n<usage>subagent_tokens: 900\ntool_uses: 2</usage>' }] }, { type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: 'aborted' }] } } as any, 'main', subs)
  assert.equal(done.length, 2)
  assert.equal(done[0].id, c1.id)
  assert.equal(done[0].text, 'Coins live in src/server/Features/Coins.')
  assert.equal(done[0].tool!.input, 'Find coin logic · 2 tool calls')
  assert.equal(done[1].id, c2.id)
  assert.match(done[1].text, /^Error: aborted/)
  // Without chip state the old behaviour holds: subagent traffic is skipped.
  assert.deepEqual(toChatMessages({ type: 'assistant', parent_tool_use_id: 'tu1', message: { content: [{ type: 'tool_use', id: 'x', name: 'Read', input: {} }] } } as any, 'main'), [])
  assert.equal(subagentSummary('a'.repeat(5000)).length, 4000)
})

test('subagents: ChatManager shows one chip and counts subagent usage in the meter', async () => {
  const fake = withServices(fakeContext())
  const store = new Map<string, unknown>()
  const meter = new Meter({ getSetting: (k, f) => (store.has(k) ? (store.get(k) as any) : f), setSetting: (k, v) => void store.set(k, v), emit: () => undefined }, { saveDelayMs: 0 })
  const queryFn: QueryFn = ({ options }) =>
    (async function* () {
      void options
      yield { type: 'system', subtype: 'init', session_id: 'sx' } as any
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'sx', message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: 'tool_use', id: 'tu1', name: 'Agent', input: { description: 'Map the shop', prompt: 'p', subagent_type: 'explorer' } }] } } as any
      yield { type: 'assistant', parent_tool_use_id: 'tu1', session_id: 'sx', message: { id: 'm2', model: 'claude-haiku-5-5', usage: { input_tokens: 400, output_tokens: 40 }, content: [{ type: 'tool_use', id: 'x1', name: 'Grep', input: {} }] } } as any
      yield { type: 'user', parent_tool_use_id: 'tu1', session_id: 'sx', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x1', content: 'hits' }] } } as any
      yield { type: 'user', parent_tool_use_id: null, session_id: 'sx', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'Shop is in ShopService.' }] }] } } as any
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 'sx', message: { id: 'm3', model: 'claude-opus-5-5', usage: { input_tokens: 20, output_tokens: 8 }, content: [{ type: 'text', text: 'The shop lives in ShopService.' }] } } as any
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'x',
        session_id: 'sx',
        usage: { input_tokens: 30, output_tokens: 13 },
        modelUsage: {
          'claude-opus-5-5': { inputTokens: 30, outputTokens: 13, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.001 },
          'claude-haiku-5-5': { inputTokens: 400, outputTokens: 40, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, costUSD: 0.0005 }
        }
      } as any
    })()
  const chats = manager(fake, queryFn, { meter })
  const c = chats.create()
  chats.setMode(c.id, 'edit')
  await chats.send(c.id, 'where is the shop?')
  await until(() => !chats.busy(c.id))
  const msgs = chats.messages(c.id)!
  const chips = msgs.filter((m) => m.role === 'tool')
  assert.equal(chips.length, 1, 'one chip, no subagent Grep chip')
  assert.equal(chips[0].tool!.name, 'agent:explorer')
  assert.equal(chips[0].tool!.input, 'Map the shop · 1 tool call')
  assert.equal(chips[0].text, 'Shop is in ShopService.')
  assert.ok(msgs.some((m) => m.role === 'assistant' && m.text === 'The shop lives in ShopService.'))
  const totals = meter.ledger.chat(c.id)
  assert.equal(totals.input, 430, 'ledger has main + subagent input')
  assert.equal(totals.output, 53)
  const row = (chats.list().find((x) => x.id === c.id) as any).usage?.[0]
  assert.equal(row.input, 430, 'chat usage row includes the subagent')
  assert.equal(row.output, 53)
})
