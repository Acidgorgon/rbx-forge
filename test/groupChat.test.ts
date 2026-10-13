// Group chat: model-name resolution and @mentions, the Responses API loop (gpt-6.1-sol) against
// SSE fixtures, guest tool restrictions, the context pack cap, roundtables, and ChatManager routing.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import type { ChatMessage, GroupParticipant, ModelChoice } from '../src/shared/types.ts'
import { fakeContext } from './agentFake.ts'
import { consultPhrase, makeParticipant, modelAlias, modelLabel, parseMentions, resolveModel } from '../src/shared/modelResolve.ts'
import { runResponsesLoop, toResponsesInput, usesResponsesApi } from '../src/main/agent/responsesLoop.ts'
import { buildContextPack, GroupChat, GUEST_READ_LINES, GUEST_TOOLS, planChecklist, type Room } from '../src/main/agent/groupChat.ts'
import { gentreeTools, WRITE_TOOLS } from '../src/main/agent/tools.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'

const fixture = (name: string) => readFileSync(new URL(`./fixtures/responses/${name}`, import.meta.url), 'utf8')

// ---- fake fetch: replies chosen per request by URL and body ----

type Reply = { sse: string } | { json: unknown; status?: number }
interface Req {
  url: string
  body: any
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  const parts: string[] = []
  for (let k = 0; k < text.length; k += 11) parts.push(text.slice(k, k + 11))
  const stream = new ReadableStream<Uint8Array>({
    pull(c) {
      const p = parts.shift()
      if (p === undefined) c.close()
      else c.enqueue(enc.encode(p))
    }
  })
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

function fakeFetch(route: (req: Req, n: number) => Reply) {
  const requests: Req[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const req = { url: String(url), body: init.body ? JSON.parse(String(init.body)) : null }
    // Model lists: nothing extra.
    if (req.url.endsWith('/models') || req.url.includes('/models?')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    requests.push(req)
    const r = route(req, requests.length - 1)
    if ('sse' in r) return sseResponse(r.sse)
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: fn, requests }
}

// Chat Completions SSE.
const ccText = (t: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\ndata: [DONE]\n\n`
const ccCall = (name: string, args: unknown) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'tc1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`
// Responses SSE with one text message.
const rsText = (t: string) =>
  [
    { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: t },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: t }] } },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 500, output_tokens: 50 } } }
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')

const plainSafe = async () => null

async function setup(opts: { files?: Record<string, string>; queryFn?: QueryFn; route: (req: Req, n: number) => Reply; ready?: ('openai' | 'gemini' | 'anthropic')[] }) {
  const fake = fakeContext({ files: opts.files })
  const creds = new Credentials(fake.ctx, plainSafe, {})
  for (const p of opts.ready ?? ['openai', 'anthropic']) await creds.setKey(p, `key-${p}`)
  const f = fakeFetch(opts.route)
  const providers = new Providers(fake.ctx, creds, f.fetch)
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn: f.fetch, toolFs: fake.fs, queryFn: opts.queryFn })
  return { fake, creds, f, providers, chats }
}

async function idle(chats: ChatManager, id: string) {
  while (chats.busy(id)) await new Promise((r) => setTimeout(r, 5))
}

const CANDIDATES: ModelChoice[] = [
  ...['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ provider: 'anthropic' as const, model })),
  ...['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra-mini'].map((model) => ({ provider: 'openai' as const, model })),
  ...['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'].map((model) => ({ provider: 'gemini' as const, model })),
  ...['anthropic/claude-opus-5.5', 'openai/gpt-6.1-sol', 'google/gemini-3.1-pro-preview'].map((model) => ({ provider: 'openrouter' as const, model }))
]

// ---- names, mentions, intent ----

test('fuzzy model resolution maps everyday names to ready models', () => {
  const pick = (p: string) => {
    const r = resolveModel(p, CANDIDATES)
    return r.kind === 'ok' ? `${r.choice.provider}/${r.choice.model}` : r.kind
  }
  assert.equal(pick('openai sol 6.1'), 'openai/gpt-6.1-sol', 'native provider beats OpenRouter')
  assert.equal(pick('gpt 6.1 sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('GPT-6.1 Sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('gemini pro'), 'gemini/gemini-3.1-pro-preview')
  assert.equal(pick('opus'), 'anthropic/claude-opus-5-5')
  assert.equal(pick('sonnet 5.5'), 'anthropic/claude-sonnet-5-5')
  assert.equal(pick('openrouter opus'), 'openrouter/anthropic/claude-opus-5.5')
  assert.equal(pick('terra'), 'openai/gpt-5.6-terra', 'base id over its -mini variant')
  assert.equal(pick('openai/gpt-6-astra'), 'openai/gpt-6-astra')
  assert.equal(pick('native'), 'none', 'Luau attributes are not models')
  const g = resolveModel('gemini', CANDIDATES)
  assert.equal(g.kind, 'ambiguous')
  assert.ok(g.kind === 'ambiguous' && g.options.length === 3)
  assert.equal(resolveModel('claude', CANDIDATES).kind, 'ambiguous')
  // Participants resolve by alias first.
  const people = [makeParticipant({ provider: 'gemini', model: 'gemini-3.1-pro-preview' }, 'guest')]
  const r = resolveModel('gemini', people)
  assert.ok(r.kind === 'ok' && r.choice.model === 'gemini-3.1-pro-preview')
})

test('labels, aliases, mentions and "talk to X" phrasing', () => {
  assert.equal(modelLabel('gpt-6.1-sol'), 'GPT-6.1 Sol')
  assert.equal(modelLabel('claude-opus-5-5'), 'Claude Opus 5.5')
  assert.equal(modelLabel('gemini-3.1-pro-preview'), 'Gemini 3.1 Pro')
  assert.equal(modelLabel('anthropic/claude-sonnet-5.5'), 'Claude Sonnet 5.5')
  assert.equal(modelAlias('gpt-6.1-sol'), 'sol')
  assert.equal(modelAlias('claude-opus-5-5'), 'opus')
  assert.equal(modelAlias('gemini-3.8-flash'), 'gemini')
  assert.equal(makeParticipant({ provider: 'openrouter', model: 'openai/gpt-6.1-sol' }, 'guest', ['sol']).alias, 'sol2')
  assert.deepEqual(parseMentions('@sol what do you think? mail a@b.com, (@gemini-pro) and @Opus.'), ['sol', 'gemini-pro', 'opus'])
  assert.equal(consultPhrase('Communicate with openai sol 6.1 and come up with a plan'), 'openai sol 6.1')
  assert.equal(consultPhrase('talk to sol about the shop'), 'sol')
  assert.equal(consultPhrase('ask gemini pro what it thinks'), 'gemini pro')
  assert.equal(consultPhrase("get opus's opinion on this"), 'opus')
  assert.equal(consultPhrase('Add a feature called Inventory'), null)
  assert.equal(consultPhrase('Ask me before editing anything'), null)
})

// ---- Responses API ----

test('Responses API: which models use it, and history conversion', () => {
  assert.equal(usesResponsesApi('openai', 'gpt-6.1-sol'), true)
  assert.equal(usesResponsesApi('openai', 'gpt-6-astra'), false)
  assert.equal(usesResponsesApi('openrouter', 'openai/gpt-6.1-sol'), false)
  const input = toResponsesInput([
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'read_script', arguments: '{"path":"a"}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'file' },
    { role: 'assistant', content: 'done' }
  ])
  assert.deepEqual(input, [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'checking' },
    { type: 'function_call', call_id: 'c1', name: 'read_script', arguments: '{"path":"a"}' },
    { type: 'function_call_output', call_id: 'c1', output: 'file' },
    { role: 'assistant', content: 'done' }
  ])
})

test('Responses API: streaming text and a function call round trip (fixtures)', async () => {
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'local x = 1\nreturn x\n' } })
  const f = fakeFetch((_req, n) => ({ sse: fixture(n === 0 ? 'tool-call.sse' : 'text.sse') }))
  const emitted: ChatMessage[] = []
  const usage: unknown[] = []
  const r = await runResponsesLoop({
    baseUrl: 'https://api.openai.com/v1/',
    headers: { Authorization: 'Bearer k' },
    model: 'gpt-6.1-sol',
    system: 'SYS',
    history: [{ role: 'user', content: 'what does a return?' }],
    tools: gentreeTools(fake.ctx, { fs: fake.fs, readOnly: true }),
    maxTurns: 5,
    signal: new AbortController().signal,
    agentId: 'main',
    emit: (m) => void emitted.push(m),
    // luna's Chat Completions-only field must not leak into a Responses request.
    extraBody: { reasoning_effort: 'none', stream_options: { include_usage: true }, max_completion_tokens: 900 },
    fetchFn: f.fetch,
    throttleMs: 0,
    onUsage: (u) => void usage.push(u)
  })
  assert.equal(r.outcome, 'done')
  assert.equal(r.turns, 2)
  const [a, b] = f.requests
  assert.equal(a.url, 'https://api.openai.com/v1/responses')
  assert.equal(a.body.model, 'gpt-6.1-sol')
  assert.equal(a.body.instructions, 'SYS')
  assert.equal(a.body.stream, true)
  assert.equal(a.body.reasoning_effort, undefined)
  assert.equal(a.body.reasoning, undefined)
  assert.equal(a.body.stream_options, undefined)
  assert.equal(a.body.max_output_tokens, 900)
  assert.deepEqual(a.body.input, [{ role: 'user', content: 'what does a return?' }])
  // Flat function tools, strict off (optional properties).
  const spec = a.body.tools.find((t: any) => t.name === 'read_script')
  assert.equal(spec.type, 'function')
  assert.equal(spec.strict, false)
  assert.equal(spec.parameters.properties.path.type, 'string')
  assert.equal(spec.function, undefined)
  // Second request: all output items echoed (reasoning included), then the function output.
  const types = (b.body.input as any[]).map((i) => i.type ?? i.role)
  assert.deepEqual(types, ['user', 'reasoning', 'message', 'function_call', 'function_call_output'])
  const out = (b.body.input as any[]).at(-1)
  assert.equal(out.call_id, 'call_1')
  assert.match(out.output, /1\|local x = 1/)
  // UI: streamed text under one id, a tool chip (input then result), final text.
  const texts = emitted.filter((m) => m.role === 'assistant')
  assert.equal(texts.find((m) => m.text === 'Let me check that file.')?.role, 'assistant')
  assert.equal(new Set(texts.filter((m) => m.text.startsWith('Let')).map((m) => m.id)).size, 1)
  const chips = emitted.filter((m) => m.role === 'tool')
  assert.equal(chips[0].tool?.name, 'read_script')
  assert.match(chips.at(-1)!.text, /return x/)
  assert.equal(emitted.at(-1)!.text, 'It returns x.')
  // Usage reported per response.
  assert.equal(usage.length, 2)
  assert.equal((usage[0] as any).input_tokens_details.cached_tokens, 1000)
  // Stored history in chat format, so the chat can switch loops.
  assert.deepEqual(
    r.history.map((m) => m.role),
    ['user', 'assistant', 'tool', 'assistant']
  )
  assert.equal((r.history[1] as any).tool_calls[0].id, 'call_1')
})

test('Responses API: response.failed ends the run with an error message', async () => {
  const fake = fakeContext()
  const f = fakeFetch(() => ({ sse: fixture('failed.sse') }))
  const emitted: ChatMessage[] = []
  const r = await runResponsesLoop({
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-6.1-sol',
    system: 'S',
    history: [{ role: 'user', content: 'x' }],
    tools: [],
    maxTurns: 3,
    signal: new AbortController().signal,
    agentId: 'main',
    emit: (m) => void emitted.push(m),
    fetchFn: f.fetch
  })
  assert.equal(r.outcome, 'error')
  assert.match(emitted.at(-1)!.text, /The model failed to generate a response/)
  void fake
})

// ---- guests ----

test('guests get only cheap read tools, with read_script capped', async () => {
  const long = Array.from({ length: 500 }, (_, i) => `local v${i} = ${i}`).join('\n')
  const fake = fakeContext({ files: { 'src/shared/big.luau': long } })
  const group = new GroupChat(fake.ctx, { credentials: new Credentials(fake.ctx, plainSafe, {}), toolFs: fake.fs })
  const tools = group.guestTools()
  const names = tools.map((t) => t.name)
  for (const n of names) assert.ok((GUEST_TOOLS as readonly string[]).includes(n), n)
  for (const w of WRITE_TOOLS) assert.ok(!names.includes(w), `no ${w}`)
  assert.ok(names.includes('read_script') && names.includes('project_overview'))
  const read = tools.find((t) => t.name === 'read_script')!
  const r = await read.handler({ path: 'src/shared/big.luau' }, {})
  const lines = r.content[0].text.split('\n').filter((l) => /^\s*\d+\|/.test(l))
  assert.equal(lines.length, GUEST_READ_LINES)
  const r2 = await read.handler({ path: 'src/shared/big.luau', from: 10, to: 499 }, {})
  assert.equal(r2.content[0].text.split('\n').filter((l) => /^\s*\d+\|/.test(l)).length, GUEST_READ_LINES)
})

test('guest calls: SDK guests have no built-in tools and every permission is denied; OpenAI guests see only read tools', async () => {
  const seen: any[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    seen.push({ prompt, options })
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'Opus advice.' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 300, output_tokens: 40 } } as any
    })()
  }
  const { chats, f } = await setup({ queryFn, route: () => ({ sse: ccText('Astra advice.') }) })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
  chats.addGuest(chat.id, { provider: 'anthropic', model: 'claude-opus-5-5' })
  chats.addGuest(chat.id, { provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, '@opus @astra how should saving work?')
  await idle(chats, chat.id)
  // SDK guest.
  const o = seen[0].options
  assert.deepEqual(o.tools, [])
  assert.deepEqual(Object.keys(o.mcpServers), ['gentree'])
  assert.equal(o.persistSession, false)
  assert.ok(o.maxTurns <= 6)
  assert.deepEqual(await o.canUseTool('Write', { file_path: 'src/x.luau' }, {} as any), { behavior: 'deny', message: 'guests are read-only' })
  assert.equal(o.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '4000')
  // OpenAI guest: read tools only, output capped.
  const req = f.requests[0]
  assert.match(req.url, /chat\/completions$/)
  const tools = (req.body.tools as any[]).map((t) => t.function.name)
  for (const n of tools) assert.ok((GUEST_TOOLS as readonly string[]).includes(n), n)
  assert.equal(req.body.max_completion_tokens, 4000)
  // The host (sol) never ran: direct mentions only.
  assert.ok(!f.requests.some((r) => r.url.endsWith('/responses')))
  const msgs = chats.messages(chat.id)!
  assert.deepEqual(
    msgs.filter((m) => m.role === 'assistant').map((m) => [m.speaker?.label, m.text]),
    [
      ['Claude Opus 5.5', 'Opus advice.'],
      ['GPT-6 Astra', 'Astra advice.']
    ]
  )
  // Per-model usage.
  const usage = chats.list()[0].usage!
  assert.deepEqual(
    usage.map((u) => [u.label, u.input, u.output]),
    [['Claude Opus 5.5', 300, 40]]
  )
  // Guest tools off: no tools at all.
  chats.setGuestTools(chat.id, false)
  await chats.send(chat.id, '@astra and now?')
  await idle(chats, chat.id)
  assert.equal(f.requests.at(-1)!.body.tools, undefined)
})

test('context pack stays under its cap and keeps the newest messages', () => {
  const host = { provider: 'openai' as const, model: 'gpt-6-astra', label: 'GPT-6 Astra' }
  const transcript: ChatMessage[] = Array.from({ length: 60 }, (_, i) => ({
    id: `m${i}`,
    role: i % 2 ? 'assistant' : 'user',
    text: `message ${i} ` + 'x'.repeat(900),
    at: i,
    agentId: 'main',
    ...(i % 4 === 3 ? { speaker: { provider: 'gemini' as const, model: 'gemini-3.1-pro-preview', label: 'Gemini 3.1 Pro' } } : {})
  }))
  transcript.push({ id: 'tool', role: 'tool', text: 'y'.repeat(5000), at: 99, agentId: 'main' })
  const pack = buildContextPack({ ask: 'Plan the shop. ' + 'z'.repeat(5000), projectSummary: 'Roblox project "Fake"', transcript, host, recent: 8, maxChars: 3000 })
  assert.ok(pack.length <= 3000, `pack is ${pack.length} chars`)
  assert.match(pack, /## Ask\nPlan the shop/)
  assert.match(pack, /## Project\nRoblox project "Fake"/)
  assert.match(pack, /\[Gemini 3.1 Pro\]: message 59/)
  assert.match(pack, /\[User\]: message 58/)
  const roomy = buildContextPack({ ask: 'q', transcript, host, recent: 8, maxChars: 20_000, messageChars: 300 })
  assert.match(roomy, /\[GPT-6 Astra\]: message 57/)
  assert.match(roomy, /message 52 /)
  assert.doesNotMatch(roomy, /message 51 /, 'only the last K messages')
  assert.doesNotMatch(pack, /message 51 /, 'only the last K messages')
  assert.doesNotMatch(pack, /yyyy/, 'tool output is never included')
  // Default budget with a huge history.
  const big = buildContextPack({ ask: 'q', transcript, host })
  assert.ok(big.length <= 8000)
})

// ---- roundtable, routing ----

test('roundtable: turn order host then guests per round, then a plan card from the host', async () => {
  const order: string[] = []
  const prompts: string[] = []
  const queryFn: QueryFn = ({ prompt }) => {
    order.push('opus')
    prompts.push(prompt)
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: `Opus turn ${order.length}` }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 10, output_tokens: 5 } } as any
    })()
  }
  const plan = '## Agreements\n- Use ProfileStore\n## Disagreements\n- Sol wants autosave every 60s\n## Recommendation\n1. Add src/server/Data/PlayerData.luau\n2. Wire InventoryService:Give\n'
  const { chats, f } = await setup({
    queryFn,
    route: (req) => {
      if (req.url.endsWith('/responses')) {
        order.push('sol')
        prompts.push(req.body.input[0].content)
        return { sse: rsText(`Sol turn ${order.length}`) }
      }
      const last = req.body.messages.at(-1).content as string
      prompts.push(last)
      if (/## Agreements/.test(last)) {
        order.push('host:plan')
        return { sse: ccText(plan) }
      }
      order.push('host')
      return { sse: ccText(`Astra turn ${order.length}`) }
    }
  })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  chats.addGuest(chat.id, { provider: 'openai', model: 'gpt-6.1-sol' })
  chats.addGuest(chat.id, { provider: 'anthropic', model: 'claude-opus-5-5' })
  await chats.roundtable(chat.id, 'How should we save player data?', 2)
  await idle(chats, chat.id)
  assert.deepEqual(order, ['host', 'sol', 'opus', 'host', 'sol', 'opus', 'host:plan'])
  // Each turn sees the earlier ones; the host's turns run without write tools.
  assert.match(prompts[2], /\[GPT-6 Astra\]: Astra turn 1/)
  assert.match(prompts[2], /\[GPT-6.1 Sol\]: Sol turn 2/)
  assert.match(prompts[3], /Round 2 of 2/)
  const hostTools = (f.requests[0].body.tools as any[]).map((t) => t.function.name)
  for (const w of WRITE_TOOLS) assert.ok(!hostTools.includes(w))
  assert.equal(f.requests.at(-1)!.body.tools, undefined, 'synthesis has no tools')
  // Plan card.
  const msgs = chats.messages(chat.id)!
  const card = msgs.find((m) => m.card === 'plan')!
  assert.equal(card.speaker?.label, 'GPT-6 Astra')
  assert.match(card.text, /## Recommendation/)
  // Make it a task list.
  chats.planToChecklist(chat.id, card.id)
  const list = chats.messages(chat.id)!.at(-1)!
  assert.equal(list.card, 'checklist')
  assert.equal(list.text, '- [ ] Add src/server/Data/PlayerData.luau\n- [ ] Wire InventoryService:Give')
  // The host hears about the roundtable on its next turn.
  await chats.send(chat.id, 'ok, do step 1')
  await idle(chats, chat.id)
  const next = (f.requests.at(-1)!.body.messages as any[]).at(-1).content as string
  assert.match(next, /Group chat since your last turn/)
  assert.match(next, /Sol turn/)
  assert.match(next, /ok, do step 1$/)
})

test('"communicate with openai sol 6.1 and come up with a plan" invites Sol and the host consults it', async () => {
  const { chats, f } = await setup({
    files: { 'src/shared/a.luau': 'return 1' },
    route: (req) => {
      if (req.url.endsWith('/responses')) return { sse: rsText('Sol: use a debounce and a server-side price check.') }
      const msgs = req.body.messages as any[]
      if (msgs.at(-1).role === 'tool') return { sse: ccText('Plan: debounce + server check (agreed with Sol).') }
      return { sse: ccCall('consult_model', { model: 'sol', message: 'Plan for the shop bug?', mode: 'debate' }) }
    }
  })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, 'Communicate with openai sol 6.1 and come up with a plan for the shop bug')
  await idle(chats, chat.id)
  const session = chats.list()[0]
  assert.deepEqual(
    session.guests!.map((g: GroupParticipant) => [g.provider, g.model, g.alias, g.role]),
    [['openai', 'gpt-6.1-sol', 'sol', 'guest']]
  )
  // Host got the hint and the tools.
  const first = f.requests[0]
  assert.match(first.body.messages.at(-1).content, /consult_model tool with model "sol"/)
  assert.ok((first.body.tools as any[]).some((t) => t.function.name === 'consult_model'))
  // Sol got a context pack (not the chat history) in debate mode.
  const sol = f.requests[1]
  assert.match(sol.url, /\/responses$/)
  assert.equal(sol.body.input.length, 1)
  assert.match(sol.body.input[0].content, /## Ask\nPlan for the shop bug\?/)
  assert.match(sol.body.input[0].content, /Challenge it/)
  assert.match(sol.body.instructions, /You are GPT-6.1 Sol, a guest adviser/)
  // Tool result handed back to the host.
  const toolMsg = (f.requests[2].body.messages as any[]).find((m) => m.role === 'tool')
  assert.match(toolMsg.content, /GPT-6.1 Sol \(@sol\) replied:\nSol: use a debounce/)
  // Transcript: speakers on everything after the user message.
  const msgs = chats.messages(chat.id)!
  const said = msgs.filter((m) => m.role === 'assistant').map((m) => m.speaker?.label)
  assert.deepEqual(said, ['GPT-6.1 Sol', 'GPT-6 Astra'])
  assert.ok(msgs.some((m) => m.role === 'system' && /joined the chat/.test(m.text)))
})

test('ambiguous names are asked about in the chat instead of guessed', async () => {
  const { chats, f } = await setup({ ready: ['openai', 'gemini'], route: () => ({ sse: ccText('x') }) })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, 'talk with gemini about the map layout')
  await idle(chats, chat.id)
  const last = chats.messages(chat.id)!.at(-1)!
  assert.equal(last.role, 'system')
  assert.match(last.text, /Which model did you mean by “gemini”\? .*gemini\/gemini-3.1-pro-preview/)
  assert.equal(f.requests.length, 0)
})

test('planChecklist falls back to every list item', () => {
  assert.equal(planChecklist('Do this:\n- a\n- b'), '- [ ] a\n- [ ] b')
  assert.equal(planChecklist('## Plan\n1. **First** step\n2) second'), '- [ ] First step\n- [ ] second')
})

void ({} as Room)
