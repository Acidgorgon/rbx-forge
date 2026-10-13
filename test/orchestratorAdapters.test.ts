// Orchestrator runAgent adapters: Claude Agent SDK message mapping/options and the OpenAI-style
// loop adapter, including one full orchestration over the loop adapter.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { z } from 'zod'
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import {
  Orchestrator,
  sdkRunAgent,
  sdkToEvents,
  SdkUsageDelta,
  openAiRunAgent,
  channel,
  type AgentEvent,
  type AgentSpec,
  type OrchTool
} from '../src/main/agent/orchestrator/index.ts'

function spec(over: Partial<AgentSpec> = {}): AgentSpec {
  return { runId: 'r', taskId: 't', role: 'scout', model: 'claude-haiku-5-5', system: 'SYS', prompt: 'P', tools: [], maxTurns: 7, signal: new AbortController().signal, ...over }
}

async function collect(it: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = []
  for await (const e of it) out.push(e)
  return out
}

const assistant = (id: string, content: unknown[], usage: Record<string, number>, parent: string | null = null) =>
  ({ type: 'assistant', parent_tool_use_id: parent, uuid: `u-${id}`, session_id: 'S1', message: { id, content, usage } }) as unknown as SDKMessage

test('sdkToEvents maps text, tool calls, errors, results and usage deltas; skips subagent traffic', () => {
  const u = new SdkUsageDelta()
  let ev = sdkToEvents(assistant('m1', [{ type: 'text', text: 'hi' }], { input_tokens: 100, output_tokens: 5, cache_read_input_tokens: 1000 }), u)
  assert.deepEqual(ev, [
    { type: 'text', text: 'hi', id: 'm1:0' },
    { type: 'usage', usage: { input: 100, output: 5, cacheRead: 1000, cacheWrite: 0 } }
  ])
  // Same message id, later block with grown output: only the growth.
  ev = sdkToEvents(assistant('m1', [{ type: 'tool_use', name: 'mcp__forge__read_script', input: { path: 'a' } }], { input_tokens: 100, output_tokens: 25, cache_read_input_tokens: 1000 }), u)
  assert.deepEqual(ev, [
    { type: 'tool_call', name: 'read_script', input: { path: 'a' } },
    { type: 'usage', usage: { input: 0, output: 20, cacheRead: 0, cacheWrite: 0 } }
  ])
  assert.deepEqual(sdkToEvents(assistant('m9', [{ type: 'text', text: 'sub' }], { input_tokens: 5 }, 'toolu_1'), u), [])
  const tr = sdkToEvents({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', is_error: true, content: 'refused: x' }] } } as unknown as SDKMessage, u)
  assert.deepEqual(tr, [{ type: 'tool_result', text: 'refused: x', isError: true }])
  const done = sdkToEvents({ type: 'result', subtype: 'success', is_error: false, result: 'final', total_cost_usd: 0.03 } as unknown as SDKMessage, u)
  assert.deepEqual(done, [{ type: 'usage', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0.03 } }, { type: 'done', text: 'final' }])
  const err = sdkToEvents({ type: 'result', subtype: 'error_max_turns', is_error: true, errors: [], total_cost_usd: 0.03 } as unknown as SDKMessage, u)
  assert.deepEqual(err, [{ type: 'error', message: 'error_max_turns' }])
})

test('sdkRunAgent builds per-task options: role model, stable system prompt, no SDK subagents or built-in writes', async () => {
  const calls: { prompt: string; options: Options }[] = []
  const tools: OrchTool<any>[] = [{ name: 'submit_result', description: 'd', inputSchema: {}, handler: async () => ({ content: [{ type: 'text', text: 'ok' }] }) }]
  const run = sdkRunAgent({
    query: (p) => {
      calls.push(p)
      return (async function* () {
        yield assistant('m1', [{ type: 'text', text: 'working' }], { input_tokens: 10, output_tokens: 1 })
        yield { type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.001, session_id: 'S1' } as unknown as SDKMessage
      })()
    },
    makeServer: (t) => ({ type: 'sdk', name: 'forge', instance: { tools: t.map((x) => x.name) } }) as any,
    baseOptions: () => ({ cwd: '/proj', env: { ANTHROPIC_API_KEY: 'k' } }),
    resumeThreads: true
  })
  const ev = await collect(run(spec({ tools, thread: 'lead:r', role: 'lead', model: 'claude-opus-5-5' })))
  assert.equal(ev.at(-1)!.type, 'done')
  const o = calls[0].options
  assert.equal(calls[0].prompt, 'P')
  assert.equal(o.model, 'claude-opus-5-5')
  assert.equal(o.systemPrompt, 'SYS')
  assert.equal(o.maxTurns, 7)
  assert.equal(o.cwd, '/proj')
  assert.deepEqual((o.mcpServers!.forge as any).instance.tools, ['submit_result'])
  for (const t of ['Agent', 'Task', 'Edit', 'Write', 'Bash']) assert.ok(o.disallowedTools!.includes(t), t)
  assert.deepEqual(o.tools, ['Read', 'Glob', 'Grep'])
  assert.equal(o.settingSources!.length, 0)
  const deny = await o.canUseTool!('Write', {}, { signal: new AbortController().signal, toolUseID: 'x', requestId: 'y' } as any)
  assert.equal(deny?.behavior, 'deny')
  assert.equal(o.resume, undefined)
  // Same thread again: resumes the SDK session.
  await collect(run(spec({ tools, thread: 'lead:r', role: 'lead' })))
  assert.equal(calls[1].options.resume, 'S1')
  // Abort propagates to the SDK abort controller.
  const ac = new AbortController()
  const it = run(spec({ signal: ac.signal }))[Symbol.asyncIterator]()
  const first = it.next()
  ac.abort()
  await first
  assert.ok(calls[2].options.abortController!.signal.aborted)
})

test('openAiRunAgent adapts a callback loop, forwards usage, and ends after submit_result', async () => {
  let stopChecks: boolean[] = []
  const run = openAiRunAgent({
    endpoint: async () => ({ baseUrl: 'http://x', headers: { a: 'b' } }),
    systemSuffix: ' NOTE',
    loop: async (o) => {
      assert.equal(o.system, 'SYS NOTE')
      assert.deepEqual(o.history, [{ role: 'user', content: 'P' }])
      o.emit({ id: 'a1', role: 'assistant', text: 'thinking', at: 0, agentId: o.agentId })
      o.emit({ id: 't1', role: 'tool', text: 'read_script', tool: { name: 'read_script', input: 'path=a' }, at: 0, agentId: o.agentId })
      o.onUsage?.({ input: 50, output: 5, cacheRead: 0, cacheWrite: 0 })
      stopChecks.push(o.stop!())
      await o.tools.find((t) => t.name === 'submit_result')!.handler({ status: 'done', summary: 's' }, {})
      stopChecks.push(o.stop!())
      return { outcome: 'stopped' }
    }
  })
  let submitted = false
  const tools: OrchTool<any>[] = [{ name: 'submit_result', description: 'd', inputSchema: { status: z.string(), summary: z.string() }, handler: async () => ((submitted = true), { content: [{ type: 'text', text: 'ok' }] }) }]
  const ev = await collect(run(spec({ tools })))
  assert.ok(submitted)
  assert.deepEqual(stopChecks, [false, true])
  assert.deepEqual(ev, [
    { type: 'text', text: 'thinking', id: 'a1' },
    { type: 'tool_call', name: 'read_script', input: 'path=a' },
    { type: 'usage', usage: { input: 50, output: 5, cacheRead: 0, cacheWrite: 0 } },
    { type: 'done' }
  ])
  const bad = openAiRunAgent({ endpoint: async () => ({ error: 'No API key' }), loop: async () => ({ outcome: 'done' }) })
  await assert.rejects(collect(bad(spec())), /No API key/)
})

test('channel yields pushed values in order and ends', async () => {
  const ch = channel<number>()
  setTimeout(() => {
    ch.push(1)
    ch.push(2)
    ch.end()
  }, 5)
  const got: number[] = []
  for await (const v of ch.iterable) got.push(v)
  assert.deepEqual(got, [1, 2])
})

test('full orchestration over the OpenAI loop adapter', async () => {
  const files = new Map<string, string>()
  const writeTool: OrchTool<any> = {
    name: 'write_script',
    description: 'w',
    inputSchema: { path: z.string(), contents: z.string() },
    handler: async (a) => (files.set(String(a.path), String(a.contents)), { content: [{ type: 'text', text: 'wrote' }] })
  }
  // A "model" per task id, driven through the loop's tools.
  const loop: Parameters<typeof openAiRunAgent>[0]['loop'] = async (o) => {
    const call = (n: string, args: unknown) => o.tools.find((t) => t.name === n)!.handler(args as any, {})
    const task = o.agentId.split(':')[2]
    o.onUsage?.({ input: 10, output: 2, cacheRead: 0, cacheWrite: 0, costUsd: 0.001 })
    if (task === 'lead-plan') await call('submit_plan', { tasks: [{ id: 'b', role: 'builder', goal: 'write a', files: ['src/a.luau'] }] })
    else if (task === 'b') {
      await call('write_script', { path: 'src/a.luau', contents: 'A' })
      await call('submit_result', { status: 'done', summary: 'wrote a' })
    } else o.emit({ id: 'x', role: 'assistant', text: 'Integrated.', at: 0, agentId: o.agentId })
    return { outcome: 'done' }
  }
  const orch = new Orchestrator({ runAgent: openAiRunAgent({ loop, endpoint: async () => ({ baseUrl: 'http://x' }) }), tools: () => [writeTool] })
  const res = await orch.start({ request: 'make a', model: 'gpt-x', provider: 'openai' }).done
  assert.equal(res.state, 'done')
  assert.equal(res.answer, 'Integrated.')
  assert.equal(files.get('src/a.luau'), 'A')
  assert.equal(res.board.tokens, 36)
  assert.ok(Math.abs(res.board.costUsd - 0.003) < 1e-9)
})
