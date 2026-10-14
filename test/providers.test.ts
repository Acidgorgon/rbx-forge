// Providers: the OpenAI-compatible agent loop against a fake fetch, per-provider credentials,
// provider readiness and model lists, tool schema conversion, and chat/test agents on openai.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/shared/types.ts'
import { fakeContext } from './agentFake.ts'
import { mergeToolCall, runOpenAiLoop, trimHistory, type OaiMessage, type OaiToolCall } from '../src/main/agent/openaiLoop.ts'
import { gentreeTools, toFunctionSpecs, toolJsonSchema } from '../src/main/agent/tools.ts'
import { Credentials, keySetting } from '../src/main/agent/credentials.ts'
import { Providers, PROVIDERS } from '../src/main/agent/providers.ts'
import { CodexService } from '../src/main/agent/codex/service.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { TestAgentRunner } from '../src/main/agent/testAgents.ts'
import { z } from 'zod'

// ---- fake fetch ----

type Reply = { sse: string[] } | { status: number; json: unknown } | { slow: true }

interface FakeFetch {
  fetch: typeof fetch
  requests: { url: string; body: any; headers: Record<string, string> }[]
}

function sse(chunks: unknown[], opts: { comment?: boolean } = {}): string[] {
  const out: string[] = []
  if (opts.comment) out.push(': OPENROUTER PROCESSING\n\n')
  for (const c of chunks) out.push(`data: ${JSON.stringify(c)}\n\n`)
  out.push('data: [DONE]\n\n')
  return out
}

const text = (t: string) => ({ choices: [{ index: 0, delta: { content: t } }] })

function fakeFetch(replies: Reply[] | ((i: number) => Reply)): FakeFetch {
  const requests: FakeFetch['requests'] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const i = requests.length
    requests.push({ url: String(url), body: init.body ? JSON.parse(String(init.body)) : null, headers: (init.headers ?? {}) as Record<string, string> })
    const reply = typeof replies === 'function' ? replies(i) : replies[i]
    if (!reply) throw new Error(`unexpected request ${i}`)
    if ('status' in reply) {
      return new Response(JSON.stringify(reply.json), { status: reply.status, headers: { 'content-type': 'application/json' } })
    }
    const signal = init.signal
    const enc = new TextEncoder()
    if ('slow' in reply) {
      // Streams one chunk, then waits until aborted.
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(text('Thinking'))}\n\n`))
          signal?.addEventListener('abort', () => controller.error(Object.assign(new Error('aborted'), { name: 'AbortError' })))
        }
      })
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    // Split the SSE text at odd places to exercise line buffering.
    const all = reply.sse.join('')
    const parts: string[] = []
    for (let k = 0; k < all.length; k += 7) parts.push(all.slice(k, k + 7))
    const stream = new ReadableStream<Uint8Array>({
      async pull(controller) {
        const p = parts.shift()
        if (p === undefined) controller.close()
        else controller.enqueue(enc.encode(p))
      }
    })
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetch: fn, requests }
}

function loopBase(fake: ReturnType<typeof fakeContext>, f: FakeFetch, emitted: ChatMessage[]) {
  return {
    baseUrl: 'https://api.example.com/v1/',
    headers: { Authorization: 'Bearer k' },
    model: 'm-1',
    system: 'SYS',
    tools: gentreeTools(fake.ctx, { fs: fake.fs }),
    maxTurns: 10,
    signal: new AbortController().signal,
    agentId: 'main',
    emit: (m: ChatMessage) => void emitted.push(m),
    fetchFn: f.fetch,
    throttleMs: 0
  }
}

// ---- openaiLoop ----

test('loop streams text under one stable id and skips SSE comments', async () => {
  const fake = fakeContext()
  const f = fakeFetch([{ sse: sse([text('Hel'), text('lo '), text('there.'), { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }], { comment: true }) }])
  const emitted: ChatMessage[] = []
  const r = await runOpenAiLoop({ ...loopBase(fake, f, emitted), history: [{ role: 'user', content: 'hi' }] })
  assert.equal(r.outcome, 'done')
  assert.equal(f.requests[0].url, 'https://api.example.com/v1/chat/completions')
  assert.equal(f.requests[0].body.stream, true)
  assert.equal(f.requests[0].body.model, 'm-1')
  assert.deepEqual(f.requests[0].body.messages[0], { role: 'system', content: 'SYS' })
  assert.equal(f.requests[0].headers.Authorization, 'Bearer k')
  const ids = new Set(emitted.map((m) => m.id))
  assert.equal(ids.size, 1, 'all updates share one id')
  assert.ok(emitted.length >= 2, 'text arrived in several updates')
  assert.equal(emitted[emitted.length - 1].text, 'Hello there.')
  assert.deepEqual(r.history[r.history.length - 1], { role: 'assistant', content: 'Hello there.' })
})

test('loop runs a tool call round trip with streamed argument fragments', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'local x = 1\nreturn x\n' } })
  const call = (delta: unknown) => ({ choices: [{ index: 0, delta: { tool_calls: [delta] } }] })
  const f = fakeFetch([
    {
      sse: sse([
        text('Reading it.'),
        call({ index: 0, id: 'call_1', type: 'function', function: { name: 'read_script', arguments: '' } }),
        call({ index: 0, function: { arguments: '{"path":"src/sh' } }),
        call({ index: 0, function: { arguments: 'ared/a.luau"}' } }),
        { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] }
      ])
    },
    { sse: sse([text('It returns x.')]) }
  ])
  const emitted: ChatMessage[] = []
  const r = await runOpenAiLoop({ ...loopBase(fake, f, emitted), history: [{ role: 'user', content: 'read a' }] })
  assert.equal(r.outcome, 'done')
  assert.equal(r.turns, 2)
  // Tools are offered as JSON Schema functions.
  const spec = f.requests[0].body.tools.find((t: any) => t.function.name === 'read_script')
  assert.equal(spec.type, 'function')
  assert.equal(spec.function.parameters.properties.path.type, 'string')
  // Second request carries the assistant tool call and the tool result.
  const msgs = f.requests[1].body.messages as any[]
  const assistant = msgs.find((m) => m.role === 'assistant')
  assert.equal(assistant.content, 'Reading it.')
  assert.deepEqual(assistant.tool_calls[0], { id: 'call_1', type: 'function', function: { name: 'read_script', arguments: '{"path":"src/shared/a.luau"}' } })
  const toolMsg = msgs.find((m) => m.role === 'tool')
  assert.equal(toolMsg.tool_call_id, 'call_1')
  assert.match(toolMsg.content, /1\|local x = 1/)
  // UI: text segment, tool chip (input then result, same id), final text with a new id.
  const chip = emitted.filter((m) => m.role === 'tool')
  assert.equal(chip.length, 2)
  assert.equal(chip[0].id, chip[1].id)
  assert.deepEqual(chip[0].tool, { name: 'read_script', input: 'path=src/shared/a.luau' })
  assert.match(chip[1].text, /local x = 1/)
  const texts = emitted.filter((m) => m.role === 'assistant')
  assert.notEqual(texts[0].id, texts[texts.length - 1].id)
  assert.equal(texts[texts.length - 1].text, 'It returns x.')
})

test('loop write tools keep the gentree write rules', async () => {
  const fake = fakeContext()
  const call = (args: unknown) => ({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'write_script', arguments: JSON.stringify(args) } }] } }] })
  const f = fakeFetch([{ sse: sse([call({ path: 'Packages/Janitor.luau', contents: 'x' })]) }, { sse: sse([text('ok')]) }])
  const emitted: ChatMessage[] = []
  await runOpenAiLoop({ ...loopBase(fake, f, emitted), history: [{ role: 'user', content: 'w' }] })
  assert.equal(fake.files.size, 0)
  const toolMsg = (f.requests[1].body.messages as any[]).find((m) => m.role === 'tool')
  assert.match(toolMsg.content, /^Error: refused: Packages/)
})

test('loop validates arguments with the zod schema', async () => {
  const fake = fakeContext()
  const f = fakeFetch([
    { sse: sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'read_script', arguments: '{"from":0}' } }] } }] }]) },
    { sse: sse([text('ok')]) }
  ])
  await runOpenAiLoop({ ...loopBase(fake, f, []), history: [{ role: 'user', content: 'x' }] })
  const toolMsg = (f.requests[1].body.messages as any[]).find((m) => m.role === 'tool')
  assert.match(toolMsg.content, /invalid arguments for read_script/)
})

test('Gemini-style tool calls without index keep extra_content for the next turn', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'x' } })
  const extra = { google: { thought_signature: 'sig==' } }
  const f = fakeFetch([
    {
      sse: sse([
        { choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ id: 'g1', type: 'function', function: { name: 'read_script', arguments: '{"path":"src/shared/a.luau"}' }, extra_content: extra }] } }] },
        { choices: [{ index: 0, delta: { tool_calls: [{ id: 'g2', type: 'function', function: { name: 'project_overview', arguments: '{}' } }] } }] }
      ])
    },
    { sse: sse([text('done')]) }
  ])
  const r = await runOpenAiLoop({ ...loopBase(fake, f, []), history: [{ role: 'user', content: 'x' }] })
  assert.equal(r.outcome, 'done')
  const assistant = (f.requests[1].body.messages as any[]).find((m) => m.role === 'assistant')
  assert.equal(assistant.tool_calls.length, 2)
  assert.deepEqual(assistant.tool_calls[0].extra_content, extra)
  assert.deepEqual((f.requests[1].body.messages as any[]).filter((m) => m.role === 'tool').map((m) => m.tool_call_id), ['g1', 'g2'])
})

test('mergeToolCall never doubles a repeated name', () => {
  const calls: OaiToolCall[] = []
  mergeToolCall(calls, { index: 0, id: 'a', function: { name: 'read_script', arguments: '{"pa' } })
  mergeToolCall(calls, { index: 0, function: { name: 'read_script', arguments: 'th":"x"}' } })
  assert.equal(calls[0].function.name, 'read_script')
  assert.equal(calls[0].function.arguments, '{"path":"x"}')
})

test('loop stops on abort mid-stream', async () => {
  const fake = fakeContext()
  const f = fakeFetch([{ slow: true }])
  const abort = new AbortController()
  const emitted: ChatMessage[] = []
  const p = runOpenAiLoop({ ...loopBase(fake, f, emitted), signal: abort.signal, history: [{ role: 'user', content: 'x' }] })
  await new Promise((r) => setTimeout(r, 20))
  abort.abort()
  const r = await p
  assert.equal(r.outcome, 'aborted')
  assert.ok(!emitted.some((m) => m.role === 'system'), 'no error message on abort')
})

test('loop enforces max turns', async () => {
  const fake = fakeContext()
  const f = fakeFetch(() => ({ sse: sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c', function: { name: 'project_overview', arguments: '{}' } }] } }] }]) }))
  const emitted: ChatMessage[] = []
  const r = await runOpenAiLoop({ ...loopBase(fake, f, emitted), maxTurns: 3, history: [{ role: 'user', content: 'loop' }] })
  assert.equal(r.outcome, 'max_turns')
  assert.equal(f.requests.length, 3)
  assert.match(emitted[emitted.length - 1].text, /max turns/)
  // History stays valid: every tool call has a result.
  const calls = r.history.filter((m) => m.role === 'assistant').length
  assert.equal(r.history.filter((m) => m.role === 'tool').length, calls)
})

test('loop reports HTTP and mid-stream errors as system messages', async () => {
  const fake = fakeContext()
  const f = fakeFetch([{ status: 401, json: { error: { message: 'Incorrect API key' } } }])
  const emitted: ChatMessage[] = []
  const r = await runOpenAiLoop({ ...loopBase(fake, f, emitted), history: [{ role: 'user', content: 'x' }] })
  assert.equal(r.outcome, 'error')
  assert.match(r.error!, /HTTP 401: Incorrect API key \(check the API key/)
  assert.equal(emitted[0].role, 'system')

  const g = fakeFetch([{ sse: sse([text('partial'), { error: { message: 'Provider overloaded' }, choices: [{ index: 0, delta: {}, finish_reason: 'error' }] }]) }])
  const r2 = await runOpenAiLoop({ ...loopBase(fake, g, []), history: [{ role: 'user', content: 'x' }] })
  assert.equal(r2.outcome, 'error')
  assert.equal(r2.error, 'Provider overloaded')
})

test('trimHistory starts at a user message', () => {
  const h: OaiMessage[] = [
    { role: 'user', content: '1' },
    { role: 'assistant', content: null, tool_calls: [{ id: 'a', type: 'function', function: { name: 'x', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'a', content: 'r' },
    { role: 'assistant', content: 'ok' },
    { role: 'user', content: '2' },
    { role: 'assistant', content: 'ok2' }
  ]
  assert.deepEqual(trimHistory(h, 4).map((m) => m.role), ['user', 'assistant'])
})

// ---- tool schema conversion ----

test('tool schemas convert to JSON Schema for function calling', () => {
  const schema = toolJsonSchema({ path: z.string(), from: z.number().int().min(1).optional(), realm: z.enum(['shared', 'server']).optional() })
  assert.equal(schema.$schema, undefined)
  assert.equal(schema.type, 'object')
  assert.deepEqual(schema.required, ['path'])
  assert.deepEqual((schema.properties as any).from, { type: 'integer', minimum: 1 })
  assert.deepEqual((schema.properties as any).realm, { type: 'string', enum: ['shared', 'server'] })
  const specs = toFunctionSpecs(gentreeTools(fakeContext().ctx))
  assert.equal(specs.length, 13)
  for (const s of specs) {
    assert.equal(s.function.parameters.type, 'object', s.function.name)
    assert.ok(s.function.description.length > 10)
    assert.doesNotThrow(() => JSON.stringify(s))
  }
  const empty = specs.find((s) => s.function.name === 'project_overview')!
  assert.deepEqual(empty.function.parameters.properties, {})
})

// ---- credentials ----

const plainSafe = async () => null

test('keys are stored per provider, with env fallback', async () => {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, { OPENAI_API_KEY: 'sk-env-openai' })
  assert.equal(keySetting('anthropic'), 'anthropicApiKey')
  assert.equal(keySetting('gemini'), 'geminiApiKey')
  assert.equal(await creds.getKey('openai'), 'sk-env-openai')
  assert.equal(await creds.keySource('openai'), 'env')
  await creds.setKey('openai', ' sk-stored ')
  assert.equal(await creds.getKey('openai'), 'sk-stored')
  assert.equal(await creds.keySource('openai'), 'stored')
  await creds.setKey('gemini', 'g-key')
  assert.equal(await creds.getKey('gemini'), 'g-key')
  assert.equal(await creds.getKey('openrouter'), null)
  await creds.setKey('openai', '')
  assert.equal(await creds.getKey('openai'), 'sk-env-openai', 'clearing falls back to the env key')
  assert.equal(await creds.getKey('anthropic'), null)
})

test('anthropic uses the Claude login only when opted in', async () => {
  const fake = fakeContext()
  const env = { CLAUDE_CODE_OAUTH_TOKEN: 'oauth-tok', CLAUDE_CONFIG_DIR: '/nonexistent' }
  const creds = new Credentials(fake.ctx, plainSafe, env)
  const off = await creds.anthropicAuth()
  if (process.platform !== 'darwin') assert.equal(off.ready, false)
  assert.match(off.error ?? '', /API key/)
  creds.setUseClaudeLogin(true)
  const on = await creds.anthropicAuth()
  assert.equal(on.ready, true)
  assert.equal(on.source, 'claudeLogin')
  assert.equal(on.env?.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-tok')
  // A key wins over the login and the OAuth token is withheld.
  await creds.setKey('anthropic', 'sk-ant')
  const keyed = await creds.anthropicAuth()
  assert.equal(keyed.source, 'key')
  assert.equal(keyed.env?.ANTHROPIC_API_KEY, 'sk-ant')
  assert.equal(keyed.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined)
})

// ---- providers ----

test('providers report readiness, endpoints and model lists', async () => {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, {})
  const seen: string[] = []
  const fetchFn = (async (url: string) => {
    seen.push(String(url))
    if (String(url).startsWith('http://localhost:11434')) return new Response(JSON.stringify({ data: [{ id: 'qwen3.8:latest' }] }), { status: 200 })
    if (String(url).includes('generativelanguage')) {
      return new Response(JSON.stringify({ data: [{ id: 'models/gemini-3.8-flash' }, { id: 'models/gemini-embedding-001' }, { id: 'models/imagen-4' }, { id: 'models/gemini-3.9-pro' }] }), { status: 200 })
    }
    if (String(url).includes('openai.com')) return new Response('{}', { status: 500 })
    throw new Error('offline')
  }) as unknown as typeof fetch
  // Codex: no CLI on this machine (agent/codex; covered in codex.test.ts).
  const providers = new Providers(fake.ctx, creds, fetchFn, () => new CodexService({ findBin: () => null }))
  let list = await providers.list()
  const by = (id: string) => list.find((p) => p.id === id)!
  assert.deepEqual(list.map((p) => p.id), ['anthropic', 'openai', 'openrouter', 'gemini', 'ollama', 'custom', 'codex'])
  assert.equal(by('codex').ready, false)
  assert.equal(by('anthropic').ready, false)
  assert.equal(by('openai').ready, false)
  assert.equal(by('ollama').ready, true, 'ollama is reachable without a key')
  assert.deepEqual(by('ollama').models, ['qwen3.8:latest'])
  assert.equal(by('custom').ready, false)
  assert.deepEqual(by('anthropic').models, ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'])
  assert.equal(by('gemini').baseUrl, 'https://generativelanguage.googleapis.com/v1beta/openai')

  await creds.setKey('gemini', 'g-123456789')
  await creds.setKey('openrouter', 'or-123456789')
  providers.setConfig('custom', { baseUrl: 'http://127.0.0.1:1234/v1/' })
  assert.throws(() => providers.setConfig('openai', { baseUrl: 'http://x' }))
  assert.throws(() => providers.setConfig('custom', { baseUrl: 'ftp://x' }))
  list = await providers.list()
  assert.equal(by('gemini').ready, true)
  assert.equal(by('gemini').keyHint, '…6789')
  assert.equal(by('custom').ready, true)
  assert.equal(by('custom').baseUrl, 'http://127.0.0.1:1234/v1')

  const gemini = await providers.models('gemini')
  assert.ok(gemini.includes('gemini-3.9-pro'), 'fetched ids, prefix stripped')
  assert.ok(!gemini.some((m) => /embedding|imagen/.test(m)), 'non-chat models filtered')
  assert.ok(gemini.includes(PROVIDERS.gemini.defaults[0]))
  // Errors fall back to defaults.
  await creds.setKey('openai', 'sk-1234567890')
  assert.deepEqual(await providers.models('openai'), PROVIDERS.openai.defaults)

  const ep = await providers.endpoint('openrouter')
  assert.ok(!('error' in ep))
  if (!('error' in ep)) {
    assert.equal(ep.baseUrl, 'https://openrouter.ai/api/v1')
    assert.equal(ep.headers.Authorization, 'Bearer or-123456789')
  }
  await providers.models('openrouter')
  assert.ok(seen.includes('https://openrouter.ai/api/v1/models?supported_parameters=tools'))
  const noKey = await new Providers(fake.ctx, new Credentials(fakeContext().ctx, plainSafe, {}), fetchFn).endpoint('openai')
  assert.ok('error' in noKey)

  // Default model: legacy 'model' setting, then the explicit default.
  fake.settings.set('model', 'claude-sonnet-5-5')
  assert.deepEqual(providers.defaultModel(), { provider: 'anthropic', model: 'claude-sonnet-5-5' })
  providers.setDefaultModel('gemini', 'gemini-3.8-flash')
  assert.deepEqual(providers.defaultModel(), { provider: 'gemini', model: 'gemini-3.8-flash' })
})

// ---- chat and test agents on an OpenAI-compatible provider ----

test('chat on openai streams, keeps its history and switches models per chat', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'return 1' } })
  const creds = new Credentials(fake.ctx, plainSafe, {})
  await creds.setKey('openai', 'sk-openai')
  const f = fakeFetch([
    { sse: sse([{ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_script', arguments: '{"path":"src/shared/a.luau"}' } }] } }] }]) },
    { sse: sse([text('It returns '), text('1.')]) },
    { sse: sse([text('Sure.')]) }
  ])
  const providers = new Providers(fake.ctx, creds, f.fetch)
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn: f.fetch, toolFs: fake.fs })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  assert.equal(chat.provider, 'openai')
  await chats.send(chat.id, 'What does a.luau return?')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  const msgs = chats.messages(chat.id)!
  assert.deepEqual(msgs.map((m) => m.role), ['user', 'tool', 'assistant'])
  assert.equal(msgs[2].text, 'It returns 1.')
  assert.equal(f.requests[0].url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(f.requests[0].body.model, 'gpt-6-astra')
  assert.match(f.requests[0].body.messages[0].content, /GenTree dev harness/)
  // Follow-up continues the stored history.
  await chats.send(chat.id, 'thanks')
  while (chats.busy(chat.id)) await new Promise((r) => setTimeout(r, 5))
  const roles = (f.requests[2].body.messages as any[]).map((m) => m.role)
  assert.deepEqual(roles, ['system', 'user', 'assistant', 'tool', 'assistant', 'user'])
  // Per-chat model choice persists.
  chats.setModel(chat.id, 'gemini', 'gemini-3.8-flash')
  assert.deepEqual(
    chats.list().map((c) => [c.provider, c.model]),
    [['gemini', 'gemini-3.8-flash']]
  )
  // Not ready: a clear message instead of a request.
  await chats.send(chat.id, 'hello gemini')
  assert.match(chats.messages(chat.id)!.at(-1)!.text, /Add a Google Gemini API key/)
  assert.equal(f.requests.length, 3)
})

test('test agents run on openai and report_result decides the verdict', async () => {
  const fake = fakeContext()
  fake.settings.set('studioMcp', { command: 'studio-mcp', args: [] })
  const creds = new Credentials(fake.ctx, plainSafe, {})
  await creds.setKey('openrouter', 'or-key')
  const f = fakeFetch(() => ({
    sse: sse([
      text('Checked the shop.'),
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'r', function: { name: 'report_result', arguments: '{"status":"failed","summary":"price check missing"}' } }] } }] }
    ])
  }))
  const runner = new TestAgentRunner(fake.ctx, { credentials: creds, providers: new Providers(fake.ctx, creds, f.fetch), fetchFn: f.fetch })
  const [a] = runner.run(['buy with 0 coins'], { provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' })
  assert.equal(a.provider, 'openrouter')
  await runner.idle()
  const done = runner.list()[0]
  assert.equal(done.state, 'failed')
  assert.equal(done.summary, 'price check missing')
  // Stops after report_result: one request only, read-only tools, no Studio.
  assert.equal(f.requests.length, 1)
  const names = (f.requests[0].body.tools as any[]).map((t) => t.function.name)
  assert.ok(names.includes('report_result'))
  assert.ok(!names.includes('write_script'))
  assert.ok(!names.some((n: string) => n.startsWith('mcp__')))
  assert.match(f.requests[0].body.messages[0].content, /static reviewer/)
  assert.ok(runner.messages(done.id)!.some((m) => m.role === 'assistant' && m.text === 'Checked the shop.'))
})
