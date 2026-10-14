// Group chat v2: consult triggers, fuzzy/flagship/not-set-up model resolution, the converging
// consult loop (fake models) and its Conclusion card, the read-only guard (a guest never writes),
// patch proposals (parse, apply, atomic), cross-check reviews, the Board (persistence and context
// pack), and settings.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage, ModelChoice } from '../src/shared/types.ts'
import { fakeContext } from './agentFake.ts'
import { pickFlagship, resolveConsultModel, unconfiguredText } from '../src/shared/modelResolve.ts'
import { checksFrom, conclusionMarkdown, consultTranscript, converged, looksLikeModel, parseConclusion, parseConsultTrigger, parseStance, stripStance } from '../src/shared/group/consult.ts'
import { applyFileDiff, extractDiff, parseDiff, parsePatchProposal, safePatchPath } from '../src/shared/group/patch.ts'
import { boardFromConclusion, boardFromPlan, boardPack, normalizeBoard } from '../src/shared/group/board.ts'
import { editedFiles, parseReview, pickReviewer } from '../src/shared/group/review.ts'
import { mergeGroupSettings, normalizeGroupSettings } from '../src/shared/group/settings.ts'
import { runConsult, type SpeakResult } from '../src/main/agent/group/consult.ts'
import { applyPatch } from '../src/main/agent/group/patches.ts'
import { groupReadTools, guardReadOnly, isWriteTool, type GroupIo } from '../src/main/agent/group/readTools.ts'
import { buildDiff } from '../src/main/agent/group/crossCheck.ts'
import { GroupChat, GUEST_TOOLS } from '../src/main/agent/groupChat.ts'
import { defineTool, WRITE_TOOLS } from '../src/main/agent/tools.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { Providers } from '../src/main/agent/providers.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'
import { z } from 'zod'

// ---- fake providers (fetch) ----

type Reply = { sse: string } | { json: unknown; status?: number }
interface Req {
  url: string
  body: any
}

function sseResponse(text: string): Response {
  const enc = new TextEncoder()
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(text))
        c.close()
      }
    }),
    { status: 200, headers: { 'content-type': 'text/event-stream' } }
  )
}

function fakeFetch(route: (req: Req, n: number) => Reply) {
  const requests: Req[] = []
  const fn = (async (url: string, init: RequestInit = {}) => {
    const req = { url: String(url), body: init.body ? JSON.parse(String(init.body)) : null }
    if (req.url.endsWith('/models') || req.url.includes('/models?')) return new Response(JSON.stringify({ data: [] }), { status: 200, headers: { 'content-type': 'application/json' } })
    requests.push(req)
    const r = route(req, requests.length - 1)
    if ('sse' in r) return sseResponse(r.sse)
    return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
  return { fetch: fn, requests }
}

const usageChunk = `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 400, completion_tokens: 60 } })}\n\n`
const ccText = (t: string) => `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: t } }] })}\n\n${usageChunk}data: [DONE]\n\n`
const ccCall = (name: string, args: unknown, id = 'tc1') =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }] })}\n\ndata: [DONE]\n\n`
const rsText = (t: string) =>
  [
    { type: 'response.output_text.delta', item_id: 'm', output_index: 0, content_index: 0, delta: t },
    { type: 'response.output_item.done', output_index: 0, item: { type: 'message', id: 'm', role: 'assistant', content: [{ type: 'output_text', text: t }] } },
    { type: 'response.completed', response: { output: [], usage: { input_tokens: 500, output_tokens: 50 } } }
  ]
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join('')

const plainSafe = async () => null
const lastUser = (req: Req): string => {
  if (req.body.input) return String(req.body.input.at(-1)?.content ?? '')
  const m = (req.body.messages as any[]).filter((x) => x.role === 'user').at(-1)
  return typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? '')
}

async function setup(opts: { files?: Record<string, string>; queryFn?: QueryFn; route: (req: Req, n: number) => Reply; ready?: ('openai' | 'gemini' | 'anthropic')[]; groupIo?: GroupIo }) {
  const fake = fakeContext({ files: opts.files })
  const creds = new Credentials(fake.ctx, plainSafe, {})
  for (const p of opts.ready ?? ['openai', 'anthropic']) await creds.setKey(p, `key-${p}`)
  const f = fakeFetch(opts.route)
  const providers = new Providers(fake.ctx, creds, f.fetch)
  const deps = { credentials: creds, providers, fetchFn: f.fetch, toolFs: fake.fs, queryFn: opts.queryFn, ...(opts.groupIo ? { groupIo: opts.groupIo } : {}) }
  const chats = new ChatManager(fake.ctx, deps)
  return { fake, creds, f, providers, chats, deps }
}

async function until(cond: () => boolean, ms = 3000) {
  const end = Date.now() + ms
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

async function idle(chats: ChatManager, id: string) {
  await until(() => !chats.busy(id))
  await new Promise((r) => setTimeout(r, 20))
  await until(() => !chats.busy(id))
}

const CANDIDATES: ModelChoice[] = [
  ...['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'].map((model) => ({ provider: 'anthropic' as const, model })),
  ...['gpt-6-astra', 'gpt-5.6-terra', 'gpt-6-luna', 'gpt-6.1-sol', 'gpt-5.6-terra-mini'].map((model) => ({ provider: 'openai' as const, model })),
  ...['gemini-3.8-flash', 'gemini-3.5-flash-lite', 'gemini-3.1-pro-preview'].map((model) => ({ provider: 'gemini' as const, model }))
]

// ---------------------------------------------------------------- triggers

test('trigger parsing: "ask X ... report back" and friends converge; "talk to X" consults', () => {
  const t = (s: string) => parseConsultTrigger(s)
  assert.deepEqual(t('ask gpt 6.1 sol and come up with a conclusion and report back'), { phrase: 'gpt 6.1 sol', converge: true })
  assert.deepEqual(t('Ask sol whether the lock is enough and report back'), { phrase: 'sol', converge: true })
  assert.deepEqual(t('check with gemini about the datastore schema'), { phrase: 'gemini', converge: true })
  assert.deepEqual(t('get a second opinion from opus on this refactor'), { phrase: 'opus', converge: true })
  assert.deepEqual(t("get opus's second opinion"), { phrase: 'opus', converge: true })
  assert.deepEqual(t('double-check with gpt 6.1 sol before you edit'), { phrase: 'gpt 6.1 sol', converge: true })
  assert.deepEqual(t('run it by gemini pro first'), { phrase: 'gemini pro', converge: true })
  assert.deepEqual(t('talk to sol about the shop'), { phrase: 'sol', converge: false })
  assert.deepEqual(t('communicate with openai sol 6.1 and come up with a plan'), { phrase: 'openai sol 6.1', converge: false })
  assert.equal(t('fix the shop button'), null)
  assert.equal(t('ask me before deleting files'), null)
  assert.ok(looksLikeModel('gpt 9') && looksLikeModel('opus') && !looksLikeModel('the server'))
})

// ---------------------------------------------------------------- resolution

test('fuzzy model resolution: everyday names, flagship for a bare family, not-set-up providers', () => {
  const pick = (p: string, ready = CANDIDATES, known: ModelChoice[] = []) => {
    const r = resolveConsultModel(p, ready, known)
    return r.kind === 'ok' ? `${r.choice.provider}/${r.choice.model}` : r.kind === 'unconfigured' ? `unconfigured:${r.choice.provider}/${r.choice.model}` : r.kind
  }
  assert.equal(pick('gpt 6.1 sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('GPT-6.1 Sol'), 'openai/gpt-6.1-sol')
  assert.equal(pick('opus'), 'anthropic/claude-opus-5-5')
  assert.equal(pick('gemini'), 'gemini/gemini-3.1-pro-preview', 'bare family -> flagship')
  assert.equal(pick('claude'), 'anthropic/claude-opus-5-5', 'bare family -> flagship')
  assert.equal(pick('gemini flash'), 'gemini/gemini-3.8-flash')
  assert.equal(pick('gpt 6'), 'ambiguous', 'Astra and Luna are peers: ask')
  // Only Anthropic is set up: OpenAI and Gemini models are known but not ready.
  const anthropic = CANDIDATES.filter((c) => c.provider === 'anthropic')
  assert.equal(pick('gpt 6.1 sol', anthropic, CANDIDATES), 'unconfigured:openai/gpt-6.1-sol')
  assert.equal(pick('gemini', anthropic, CANDIDATES), 'unconfigured:gemini/gemini-3.1-pro-preview')
  assert.equal(pick('mistral large', anthropic, CANDIDATES), 'none')
  assert.match(unconfiguredText({ provider: 'openai', model: 'gpt-6.1-sol' }), /GPT-6.1 Sol is an OpenAI model, and OpenAI isn't set up.*Settings → Providers/)
  assert.equal(pickFlagship([{ provider: 'openai', model: 'gpt-6-astra' }, { provider: 'openai', model: 'gpt-6-luna' }]), null)
})

test('"ask <model> and report back" for a provider that is not set up says so with the Settings link', async () => {
  const { chats, f } = await setup({ ready: ['openai'], route: () => ({ sse: ccText('x') }) })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, 'ask gemini pro about the map layout and report back')
  await idle(chats, chat.id)
  const last = chats.messages(chat.id)!.at(-1)!
  assert.equal(last.role, 'system')
  assert.equal(last.settingsLink, 'gemini')
  assert.match(last.text, /Gemini 3.1 Pro is a Google Gemini model, and Google Gemini isn't set up/)
  assert.equal(f.requests.length, 0, 'nothing ran silently')
  // A model name that matches nothing at all is reported too.
  await chats.send(chat.id, 'ask gpt 9 turbo and report back')
  await idle(chats, chat.id)
  assert.match(chats.messages(chat.id)!.at(-1)!.text, /No model called “gpt 9 turbo” is set up\. Ready: /)
})

// ---------------------------------------------------------------- stance + conclusion parsing

test('stance lines, convergence rule and conclusion parsing', () => {
  assert.equal(parseStance('Fine.\nSTANCE: agree'), 'agree')
  assert.equal(parseStance('**Stance:** disagree — the lock leaks'), 'disagree')
  assert.equal(parseStance('stance = partial'), 'partial')
  assert.equal(parseStance('I still disagree about retries.'), 'disagree')
  assert.equal(parseStance('Here is my answer.'), null)
  assert.equal(stripStance('A\nSTANCE: agree'), 'A')
  assert.ok(converged(1, { guest: null, host: 'agree' }))
  assert.ok(!converged(2, { guest: 'partial', host: 'agree' }))
  assert.ok(converged(2, { guest: 'agree', host: 'agree' }))
  assert.ok(!converged(1, { guest: null, host: 'partial' }))

  const c = parseConclusion(
    '## Answer\nLock per player, deduct before saving.\n## Agreed\n- The race is in Purchase\n- Prices are read on the server\n## Disagreed\n- Retry count: **GPT-6.1 Sol**: 3; **GPT-6 Astra**: 5\n## Confidence\nHigh: both read ShopService.luau',
    [{ label: 'GPT-6.1 Sol', alias: 'sol' }, { label: 'GPT-6 Astra', alias: 'astra' }]
  )
  assert.equal(c.answer, 'Lock per player, deduct before saving.')
  assert.deepEqual(c.agreed.map((p) => p.text), ['The race is in Purchase', 'Prices are read on the server'])
  assert.deepEqual(c.disagreed[0].by, ['GPT-6.1 Sol', 'GPT-6 Astra'])
  assert.equal(c.confidence, 'high')
  assert.equal(c.confidenceWhy, 'both read ShopService.luau')
  assert.deepEqual(parseConclusion('## Answer\nx\n## Disagreed\n- none').disagreed, [])
  assert.equal(parseConclusion('Just text, no sections').answer, 'Just text, no sections')
  const checks = checksFrom(
    [
      { label: 'A', tool: 'mcp__gentree__read_script', input: 'path=src/a.luau' },
      { label: 'A', tool: 'read_script', input: 'path=src/a.luau' },
      { label: 'B', tool: 'search_code', input: 'query=Purchase' }
    ],
    [
      { label: 'A', provider: 'openai', model: 'a' },
      { label: 'B', provider: 'gemini', model: 'b' }
    ]
  )
  assert.deepEqual(checks, [
    { label: 'A', checked: ['read_script src/a.luau'] },
    { label: 'B', checked: ['search_code Purchase'] }
  ])
  assert.match(conclusionMarkdown({ ...c, checks }), /## Checked\n- \*\*A\*\*: read_script src\/a\.luau/)
  assert.ok(consultTranscript([{ label: 'X', text: 'a'.repeat(5000) }, { label: 'Y', text: 'b\nSTANCE: agree' }], 3000).endsWith('[Y]: b'))
})

// ---------------------------------------------------------------- convergence loop (fake models)

function scripted(replies: Record<'host' | 'guest', (string | Partial<SpeakResult>)[]>) {
  const calls: { who: 'host' | 'guest'; prompt: string; silent?: boolean }[] = []
  const idx = { host: 0, guest: 0 }
  const speak = async (who: 'host' | 'guest', prompt: string, o: { tools: boolean; silent?: boolean }): Promise<SpeakResult> => {
    calls.push({ who, prompt, ...(o.silent ? { silent: true } : {}) })
    const r = replies[who][idx[who]++] ?? ''
    const base: SpeakResult = { text: '', tokens: 1000, costUsd: 0.01, tools: [] }
    return typeof r === 'string' ? { ...base, text: r } : { ...base, ...r }
  }
  return { speak, calls }
}

const SIDES = {
  host: { label: 'Claude Opus 5.5', provider: 'anthropic' as const, model: 'claude-opus-5-5', alias: 'opus' },
  guest: { label: 'GPT-6.1 Sol', provider: 'openai' as const, model: 'gpt-6.1-sol', alias: 'sol' }
}
const LIMITS = { maxTurns: 3, maxTokens: 100_000, maxUsd: 1, tools: true }
const CONCLUSION = '## Answer\nUse a lock.\n## Agreed\n- lock\n## Disagreed\n- none\n## Confidence\nhigh: checked'

test('consult loop: stops as soon as both agree, then the host concludes silently', async () => {
  const s = scripted({
    guest: [{ text: 'Use a per-player lock in ShopService.', tools: [{ name: 'read_script', input: 'path=src/server/Shop.luau' }] }, 'Fair, deduct first too.\nSTANCE: agree'],
    host: ['Mostly, but deduct before the save.\nSTANCE: partial', 'Good.\nSTANCE: agree', CONCLUSION]
  })
  const out = await runConsult({ ...SIDES, speak: s.speak, signal: new AbortController().signal }, 'How to fix the shop race?', '## Ask\nHow to fix the shop race?', LIMITS)
  assert.deepEqual(
    s.calls.map((c) => c.who + (c.silent ? '(silent)' : '')),
    ['guest', 'host', 'guest', 'host', 'host(silent)']
  )
  assert.equal(out.conclusion!.ended, 'agreed')
  assert.equal(out.conclusion!.turns, 2)
  assert.deepEqual(out.stances.map((x) => [x.guest, x.host]), [[null, 'partial'], ['agree', 'agree']])
  assert.equal(out.conclusion!.answer, 'Use a lock.')
  assert.deepEqual(out.conclusion!.checks, [
    { label: 'Claude Opus 5.5', checked: [] },
    { label: 'GPT-6.1 Sol', checked: ['read_script src/server/Shop.luau'] }
  ])
  assert.equal(out.conclusion!.tokens, 5000)
  assert.equal(out.conclusion!.costUsd, 0.05)
  // The guest's first prompt is the pack (no host position); later prompts carry the consult so far.
  assert.match(s.calls[0].prompt, /^## Ask/)
  assert.doesNotMatch(s.calls[0].prompt, /Consult so far/)
  assert.match(s.calls[2].prompt, /Consult so far:\n\[GPT-6.1 Sol\]: Use a per-player lock[\s\S]*\[Claude Opus 5\.5\]: Mostly, but deduct/)
  assert.doesNotMatch(s.calls[2].prompt, /deduct before the save\.\s*STANCE/, 'stance lines are stripped from the transcript')
})

test('consult loop: agreement in the first exchange, the turn cap, and the token cap', async () => {
  const first = scripted({ guest: ['Answer.'], host: ['Agreed.\nSTANCE: agree', CONCLUSION] })
  const a = await runConsult({ ...SIDES, speak: first.speak, signal: new AbortController().signal }, 'q', 'pack', LIMITS)
  assert.equal(a.conclusion!.ended, 'agreed')
  assert.equal(a.conclusion!.turns, 1)

  const stubborn = scripted({ guest: ['A', 'no\nSTANCE: disagree', 'still no\nSTANCE: disagree', 'x'], host: ['no\nSTANCE: disagree', 'no\nSTANCE: disagree', 'no\nSTANCE: disagree', CONCLUSION] })
  const b = await runConsult({ ...SIDES, speak: stubborn.speak, signal: new AbortController().signal }, 'q', 'pack', LIMITS)
  assert.equal(b.conclusion!.ended, 'cap')
  assert.equal(b.conclusion!.turns, 3)
  assert.equal(stubborn.calls.filter((c) => c.who === 'guest').length, 3, 'never more than maxTurns guest replies')
  assert.equal(stubborn.calls.filter((c) => c.who === 'host' && !c.silent).length, 3)

  const pricey = scripted({ guest: [{ text: 'A', tokens: 60_000 }, { text: 'B', tokens: 60_000 }], host: [{ text: 'no\nSTANCE: disagree', tokens: 10_000 }, CONCLUSION] })
  const c = await runConsult({ ...SIDES, speak: pricey.speak, signal: new AbortController().signal }, 'q', 'pack', { ...LIMITS, maxTokens: 100_000 })
  assert.equal(c.conclusion!.ended, 'budget')
  assert.deepEqual(pricey.calls.map((x) => x.who), ['guest', 'host', 'guest', 'host'], 'stops after the spend crosses the cap, still concludes')

  const usd = scripted({ guest: [{ text: 'A', costUsd: 0.3 }], host: [{ text: 'no\nSTANCE: disagree', costUsd: 0.3 }, CONCLUSION] })
  const d = await runConsult({ ...SIDES, speak: usd.speak, signal: new AbortController().signal }, 'q', 'pack', { ...LIMITS, maxUsd: 0.5 })
  assert.equal(d.conclusion!.ended, 'budget')

  const silent = scripted({ guest: [''], host: [] })
  const e = await runConsult({ ...SIDES, speak: silent.speak, signal: new AbortController().signal }, 'q', 'pack', LIMITS)
  assert.equal(e.conclusion, null)
  assert.match(e.error!, /GPT-6.1 Sol gave no answer/)
})

test('"ask gpt 6.1 sol ... report back" runs a converging consult end to end and posts a Conclusion card', async () => {
  const { chats, f } = await setup({
    files: { 'src/server/Shop.luau': 'return {}' },
    route: (req) => {
      if (req.url.endsWith('/responses')) return { sse: rsText('Use a per-player purchase lock and deduct before saving.') }
      const ask = lastUser(req)
      if (/Write the conclusion/.test(ask)) return { sse: ccText('## Answer\nAdd a per-player lock and deduct before the save.\n## Agreed\n- Lock per player\n- Deduct first\n## Disagreed\n- none\n## Confidence\nhigh: matches the code') }
      return { sse: ccText('Agreed with Sol, the save yields.\nSTANCE: agree') }
    }
  })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, 'ask gpt 6.1 sol how to fix the shop race, come up with a conclusion and report back')
  await idle(chats, chat.id)
  const msgs = chats.messages(chat.id)!
  const card = msgs.find((m) => m.card === 'conclusion')!
  assert.ok(card, 'conclusion card posted')
  assert.equal(card.speaker?.label, 'GPT-6 Astra')
  assert.equal(card.conclusion!.ended, 'agreed')
  assert.equal(card.conclusion!.confidence, 'high')
  assert.deepEqual(card.conclusion!.agreed.map((p) => p.text), ['Lock per player', 'Deduct first'])
  assert.deepEqual(card.conclusion!.participants.map((p) => p.label), ['GPT-6 Astra', 'GPT-6.1 Sol'])
  assert.match(card.conclusion!.question, /fix the shop race/)
  // Order: consult notice, Sol, Astra, card. The host's agent turn never ran with write tools.
  const said = msgs.filter((m) => m.role === 'assistant').map((m) => (m.card ? `card:${m.card}` : m.speaker?.label))
  assert.deepEqual(said, ['GPT-6.1 Sol', 'GPT-6 Astra', 'card:conclusion'])
  assert.ok(msgs.some((m) => m.role === 'system' && /^Consult: GPT-6 Astra ↔ GPT-6.1 Sol · up to 3 exchanges/.test(m.text)))
  for (const r of f.requests) {
    const tools = ((r.body.tools as any[]) ?? []).map((t) => t.function?.name ?? t.name)
    for (const n of tools) assert.ok(!isWriteTool(n), `no write tool offered in a consult: ${n}`)
  }
  // Board auto-filled; usage per model with a call count.
  const s = chats.list()[0]
  assert.deepEqual(
    s.board!.map((b) => b.kind),
    ['conclusion', 'decision', 'decision']
  )
  assert.deepEqual(s.usage!.map((u) => [u.label, u.calls]).sort(), [['GPT-6 Astra', 2], ['GPT-6.1 Sol', 1]])
})

// ---------------------------------------------------------------- read-only guard

test('read-only guard: guest tools never include a write tool, even when one is passed in', async () => {
  const writer = defineTool('write_script', 'w', { path: z.string() }, async () => ({ content: [{ type: 'text', text: 'wrote' }] }))
  const reader = defineTool('read_script', 'r', { path: z.string() }, async () => ({ content: [{ type: 'text', text: 'x' }] }))
  const sneaky = defineTool('add_wally_package', 'w', {}, async () => ({ content: [{ type: 'text', text: 'x' }] }))
  const kept = guardReadOnly([writer, reader, sneaky, reader], [...GUEST_TOOLS, 'write_script', 'add_wally_package'])
  assert.deepEqual(kept.map((t) => t.name), ['read_script'])
  // GroupChat's real guest list, with extra tools that try to sneak a writer in.
  const fake = fakeContext({ files: { 'src/shared/a.luau': 'return 1' } })
  const io: GroupIo = { git: async () => ({ code: 0, stdout: '', stderr: '' }) }
  const group = new GroupChat(fake.ctx, { credentials: new Credentials(fake.ctx, plainSafe, {}), toolFs: fake.fs, groupIo: io, extraReadTools: () => [writer as any] })
  const names = group.guestTools().map((t) => t.name)
  for (const w of [...WRITE_TOOLS, 'create_spec', 'run_in_terminal']) assert.ok(!names.includes(w), `no ${w}`)
  for (const n of names) assert.ok((GUEST_TOOLS as readonly string[]).includes(n), n)
  assert.ok(names.includes('git_diff') && names.includes('read_diagnostics') && names.includes('read_script'))
  assert.ok(isWriteTool('mcp__gentree__write_script') && !isWriteTool('read_script'))
})

test('a guest that calls write_script gets an error and the file is unchanged', async () => {
  const { chats, fake, f } = await setup({
    files: { 'src/shared/a.luau': 'return 1' },
    route: (req, n) => {
      if (req.url.endsWith('/responses')) return { sse: rsText('host') }
      return n === 0 ? { sse: ccCall('write_script', { path: 'src/shared/a.luau', contents: 'hacked' }) } : { sse: ccText('I could not write.') }
    }
  })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
  chats.addGuest(chat.id, { provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, '@astra rewrite a.luau')
  await idle(chats, chat.id)
  assert.equal(fake.files.get('src/shared/a.luau'), 'return 1')
  const offered = (f.requests[0].body.tools as any[]).map((t) => t.function.name)
  assert.ok(!offered.includes('write_script'))
  const toolResult = (f.requests[1].body.messages as any[]).find((m) => m.role === 'tool')
  assert.match(toolResult.content, /unknown tool write_script/)
})

test('git_diff and read_diagnostics: read-only, capped, no option injection', async () => {
  const fake = fakeContext()
  const seen: string[][] = []
  const io: GroupIo = {
    git: async (_root, args) => {
      seen.push(args)
      if (args[0] === 'ls-files') return { code: 0, stdout: 'src/new.luau\n', stderr: '' }
      return { code: 0, stdout: 'diff --git a/x b/x\n' + '+line\n'.repeat(5000), stderr: '' }
    },
    diagnostics: async (_root, paths) => ({ ran: true, problems: [{ path: paths?.[0] ?? 'src/a.luau', line: 3, severity: 'warning', message: 'unused variable', code: 'unused_variable' }] })
  }
  const [diff, diag] = groupReadTools(fake.ctx, io)
  const d = await diff.handler({}, {})
  assert.ok(d.content[0].text.length < 12_200)
  assert.match(d.content[0].text, /Untracked \(new\) files:\nsrc\/new\.luau/)
  assert.deepEqual(seen[0].slice(0, 3), ['diff', '--no-color', '--no-ext-diff'])
  const bad = await diff.handler({ path: '--output=/tmp/x' }, {})
  assert.equal(bad.isError, true)
  const g = await diag.handler({ paths: ['src/a.luau'] }, {})
  assert.match(g.content[0].text, /warning src\/a\.luau:3 unused variable \[unused_variable\]/)
})

// ---------------------------------------------------------------- patch proposals

const FILE = ['local Shop = {}', '', 'function Shop.buy(player, item)', '\tlocal price = item.price', '\tsave(player)', '\tcoins -= price', 'end', '', 'return Shop', ''].join('\n')
const DIFF = [
  '--- a/src/server/Shop.luau',
  '+++ b/src/server/Shop.luau',
  '@@ -3,5 +3,6 @@',
  ' function Shop.buy(player, item)',
  '-\tlocal price = item.price',
  '-\tsave(player)',
  '+\tlocal price = Prices[item.id]',
  '+\tcoins -= price',
  '+\tsave(player)',
  '-\tcoins -= price',
  ' end'
].join('\n')

test('patch proposal parsing and applying (located by context, whitespace-tolerant)', () => {
  const reply = `Here is the fix:\n\n\`\`\`diff\n${DIFF}\n\`\`\`\n\nSTANCE: agree`
  const p = parsePatchProposal(reply)!
  assert.deepEqual(p.files, [{ path: 'src/server/Shop.luau', added: 3, removed: 3 }])
  assert.equal(extractDiff('no diff here ```lua\nprint(1)\n```'), null)
  const [f] = parseDiff(p.diff)
  const out = applyFileDiff(FILE, f)!
  assert.equal(out, ['local Shop = {}', '', 'function Shop.buy(player, item)', '\tlocal price = Prices[item.id]', '\tcoins -= price', '\tsave(player)', 'end', '', 'return Shop', ''].join('\n'))
  // Wrong line numbers: still found by context.
  const shifted = parseDiff(p.diff.replace('@@ -3,5 +3,6 @@', '@@ -40,5 +40,6 @@'))[0]
  assert.equal(applyFileDiff(FILE, shifted), out)
  // Context that is not in the file: refused.
  const wrong = parseDiff(p.diff.replace(' function Shop.buy(player, item)', ' function Shop.sell(player, item)'))[0]
  assert.throws(() => applyFileDiff(FILE, wrong), /hunk 1/)
  // New file.
  const created = parseDiff('--- /dev/null\n+++ b/src/shared/New.luau\n@@ -0,0 +1,2 @@\n+local x = 1\n+return x\n')[0]
  assert.equal(applyFileDiff(null, created), 'local x = 1\nreturn x\n')
  assert.ok(safePatchPath('src/server/a.luau') && !safePatchPath('../x') && !safePatchPath('Packages/x.lua') && !safePatchPath('/etc/passwd'))
})

test('applyPatch is all-or-nothing', async () => {
  const files = new Map([['src/a.luau', 'a\nb\nc\n'], ['src/b.luau', 'x\ny\n']])
  const io = { read: async (p: string) => files.get(p) ?? null, write: async (p: string, c: string) => (files.set(p, c), null) }
  const good = '--- a/src/a.luau\n+++ b/src/a.luau\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n'
  const bad = '--- a/src/b.luau\n+++ b/src/b.luau\n@@ -1,2 +1,2 @@\n nope\n-y\n+Y\n'
  await assert.rejects(applyPatch(good + bad, io), /does not match src\/b\.luau/)
  assert.equal(files.get('src/a.luau'), 'a\nb\nc\n', 'nothing written when one file fails')
  assert.deepEqual(await applyPatch(good, io), { written: ['src/a.luau'] })
  assert.equal(files.get('src/a.luau'), 'a\nB\nc\n')
  await assert.rejects(applyPatch('--- a/src/a.luau\n+++ /dev/null\n@@ -1,3 +0,0 @@\n-a\n-B\n-c\n', io), /deletes src\/a\.luau; ask the host/)
  await assert.rejects(applyPatch('--- a/../x\n+++ b/../x\n@@ -1 +1 @@\n-a\n+b\n', io), /refusing/)
})

test("a guest's diff becomes a patch card; Apply writes through the host's write path", async () => {
  const reply = `Lock it:\n\`\`\`diff\n${DIFF}\n\`\`\``
  const { chats, fake } = await setup({
    files: { 'src/server/Shop.luau': FILE },
    route: (req) => (req.url.endsWith('/responses') ? { sse: rsText('host') } : { sse: ccText(reply) })
  })
  fake.dirs.add('src/server')
  const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
  chats.addGuest(chat.id, { provider: 'openai', model: 'gpt-6-astra' })
  await chats.send(chat.id, '@astra fix the shop race')
  await idle(chats, chat.id)
  const card = chats.messages(chat.id)!.find((m) => m.card === 'patch')!
  assert.equal(card.patch!.state, 'proposed')
  assert.equal(card.patch!.by.label, 'GPT-6 Astra')
  assert.equal(fake.files.get('src/server/Shop.luau'), FILE, 'the guest did not write')
  await chats.applyPatchProposal(chat.id, card.id)
  const after = chats.messages(chat.id)!.find((m) => m.id === card.id)!
  assert.equal(after.patch!.state, 'applied')
  assert.match(fake.files.get('src/server/Shop.luau')!, /Prices\[item\.id\]/)
  await assert.rejects(chats.applyPatchProposal(chat.id, card.id), /already applied/)
  chats.dismissPatchProposal(chat.id, card.id)
  assert.equal(chats.messages(chat.id)!.find((m) => m.id === card.id)!.patch!.state, 'dismissed')
})

// ---------------------------------------------------------------- cross-check

test('review parsing, reviewer choice and edited files', () => {
  const r = parseReview('BLOCKING: src/server/Shop.luau:12: lock is never released on error\nNOTE: src/client/ShopController.luau: debounce is 0.1s\nVERDICT: changes')
  assert.equal(r.verdict, 'changes')
  assert.deepEqual(r.findings[0], { severity: 'blocking', file: 'src/server/Shop.luau', line: 12, text: 'lock is never released on error' })
  assert.equal(r.findings[1].severity, 'note')
  assert.deepEqual(parseReview('VERDICT: approve'), { verdict: 'approve', findings: [] })
  assert.equal(parseReview('BLOCKING: x\nVERDICT: approve').verdict, 'changes', 'a blocking finding wins over approve')
  const host = { provider: 'anthropic' as const, model: 'claude-opus-5-5' }
  const ready = [host, { provider: 'openai' as const, model: 'gpt-6.1-sol' }, { provider: 'gemini' as const, model: 'gemini-3.1-pro-preview' }]
  assert.deepEqual(pickReviewer(host, '', [], ready), { provider: 'openai', model: 'gpt-6.1-sol' })
  assert.deepEqual(pickReviewer(host, 'gemini/gemini-3.1-pro-preview', [], ready), { provider: 'gemini', model: 'gemini-3.1-pro-preview' })
  assert.deepEqual(pickReviewer(host, 'anthropic/claude-sonnet-5-5', [{ ...ready[2], alias: 'gemini', label: 'G', role: 'guest' as const }], ready), { provider: 'gemini', model: 'gemini-3.1-pro-preview' }, 'same provider is never the reviewer')
  assert.equal(pickReviewer(host, '', [], [host]), null)
  assert.deepEqual(editedFiles([{ name: 'write_script', input: 'path=src/a.luau contents=x' }, { name: 'mcp__gentree__edit_script', input: 'path=src/b.luau old_string=…' }, { name: 'Edit', input: 'file_path=src/a.luau' }, { name: 'read_script', input: 'path=src/c.luau' }]), ['src/a.luau', 'src/b.luau'])
})

test('cross-check: a multi-file host edit is reviewed by another provider; blocking findings get a fix turn', async () => {
  const sdkPrompts: string[] = []
  const queryFn: QueryFn = ({ prompt }) => {
    sdkPrompts.push(String(prompt))
    return (async function* () {
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'BLOCKING: src/shared/b.luau:1: returns nil, callers expect a table\nNOTE: src/shared/a.luau: name is vague\nVERDICT: changes' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 900, output_tokens: 40 } } as any
    })()
  }
  const hostPrompts: string[] = []
  const io: GroupIo = { git: async (_r, args) => (args[0] === 'diff' ? { code: 0, stdout: 'diff --git a/src/shared/a.luau b/src/shared/a.luau\n+++ b/src/shared/a.luau\n+return 2\ndiff --git a/src/shared/b.luau b/src/shared/b.luau\n+++ b/src/shared/b.luau\n+return nil\n', stderr: '' } : { code: 0, stdout: '', stderr: '' }) }
  const { chats, fake } = await setup({
    files: { 'src/shared/a.luau': 'return 1', 'src/shared/b.luau': 'return {}' },
    queryFn,
    groupIo: io,
    route: (req, n) => {
      hostPrompts.push(lastUser(req))
      if (n === 0) return { sse: ccCall('write_script', { path: 'src/shared/a.luau', contents: 'return 2' }, 'w1') }
      if (n === 1) return { sse: ccCall('write_script', { path: 'src/shared/b.luau', contents: 'return nil' }, 'w2') }
      if (n === 2) return { sse: ccText('Edited both files.') }
      if (n === 3) return { sse: ccCall('write_script', { path: 'src/shared/b.luau', contents: 'return {}' }, 'w3') }
      return { sse: ccText('Fixed b.luau to return a table.') }
    }
  })
  chats.setGroupSettings({ crossCheck: true })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' })
  chats.setMode(chat.id, 'auto') // edits land without approval cards, as the cross-check expects
  await chats.send(chat.id, 'change a and b')
  await until(() => chats.messages(chat.id)!.some((m) => m.review?.state === 'addressed'), 4000)
  await idle(chats, chat.id)
  const msgs = chats.messages(chat.id)!
  const card = msgs.find((m) => m.card === 'review')!
  assert.equal(card.review!.reviewer.provider, 'anthropic')
  assert.deepEqual(card.review!.files, ['src/shared/a.luau', 'src/shared/b.luau'])
  assert.equal(card.review!.verdict, 'changes')
  assert.equal(card.review!.findings.filter((f) => f.severity === 'blocking').length, 1)
  assert.match(sdkPrompts[0], /```diff\n[\s\S]*src\/shared\/b\.luau/)
  assert.ok(msgs.some((m) => m.role === 'system' && /Cross-check: GPT-6 Astra is addressing 1 blocking finding from Claude Opus 5\.5/.test(m.text)))
  assert.ok(hostPrompts.some((p) => /\[Cross-check\] Claude Opus 5\.5 reviewed your edit[\s\S]*returns nil/.test(p)))
  assert.equal(fake.files.get('src/shared/b.luau'), 'return {}')
  assert.equal(sdkPrompts.length, 1, 'the fix turn is not reviewed again')
  // Off: no review.
  chats.setGroupSettings({ crossCheck: false })
  assert.equal(chats.getGroupSettings().crossCheck, false)
})

test('buildDiff falls back to file text without git, and shows new files in full', async () => {
  const read = async (p: string) => ({ 'src/a.luau': 'return 1', 'src/new.luau': 'local x = 1\nreturn x' })[p] ?? null
  const none = await buildDiff('/r', ['src/a.luau'], undefined, read)
  assert.match(none, /# src\/a\.luau \(current contents; no git diff available\)\nreturn 1/)
  const io: GroupIo = { git: async (_r, a) => (a[0] === 'ls-files' ? { code: 0, stdout: 'src/new.luau\n', stderr: '' } : { code: 0, stdout: 'diff --git a/src/a.luau b/src/a.luau\n+++ b/src/a.luau\n+x', stderr: '' }) }
  const withGit = await buildDiff('/r', ['src/a.luau', 'src/new.luau', '../etc'], io, read)
  assert.match(withGit, /\+\+\+ b\/src\/new\.luau\n@@ -0,0 \+1,2 @@\n\+local x = 1\n\+return x/)
  assert.doesNotMatch(withGit, /etc/)
})

// ---------------------------------------------------------------- board

test('board: auto-fill from conclusion and plan, user edits survive, pack for guests', () => {
  let b = boardFromConclusion([], 'c1', { question: 'How to fix the race?', answer: 'Lock per player.', agreed: [{ text: 'Deduct first' }], disagreed: [{ text: 'Retry count: Sol 3, Opus 5', by: ['Sol', 'Opus'] }] })
  assert.deepEqual(b.map((x) => x.kind), ['conclusion', 'decision', 'question'])
  // The user edits the decision; a refill of the same card keeps the edit and drops the rest.
  b = b.map((x) => (x.kind === 'decision' ? { ...x, text: 'Deduct coins first, refund on failure', edited: true } : x))
  b = boardFromConclusion(b, 'c1', { question: 'How to fix the race?', answer: 'Lock per player.', agreed: [{ text: 'Deduct first' }], disagreed: [] })
  assert.deepEqual(b.map((x) => x.text).sort(), ['Deduct coins first, refund on failure', 'Deduct first', 'How to fix the race? → Lock per player.'].sort())
  b = boardFromPlan(b, 'p1', '## Agreements\n- Server owns prices\n## Disagreements\n- Debounce length\n## Recommendation\n1. Add the lock\n2. Test it', 'Shop exploit')
  assert.ok(b.some((x) => x.kind === 'question' && x.text === 'Debounce length'))
  assert.ok(b.some((x) => x.kind === 'conclusion' && /Shop exploit → 2 step plan: Add the lock/.test(x.text)))
  const done = b.map((x) => (x.text === 'Debounce length' ? { ...x, done: true } : x))
  const pack = boardPack(done)
  assert.match(pack, /^## Board/)
  assert.match(pack, /Decisions:\n- Deduct coins first/)
  assert.doesNotMatch(pack, /Debounce length/, 'ticked-off questions are left out')
  assert.ok(boardPack(done, 120).length <= 120)
  assert.equal(boardPack([]), '')
  assert.deepEqual(normalizeBoard([{ kind: 'nope', text: 'x' }, { kind: 'decision', text: '  ' }, null, 5]), [])
})

test('board persists with the chat and replaces long history in the guest context pack', async () => {
  const { chats, fake, f, deps } = await setup({ route: (req) => (req.url.endsWith('/responses') ? { sse: rsText('host') } : { sse: ccText('Guest view.') }) })
  const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
  chats.addGuest(chat.id, { provider: 'openai', model: 'gpt-6-astra' })
  const saved = chats.saveBoard(chat.id, [
    { id: 'd1', kind: 'decision', text: 'ProfileStore for saves', at: 1, edited: true },
    { id: 'q1', kind: 'question', text: 'Session locking on teleport?', at: 2 },
    { kind: 'bogus', text: 'dropped' }
  ])
  assert.equal(saved.length, 2)
  chats.flush()
  const again = new ChatManager(fake.ctx, deps)
  assert.deepEqual(again.list().find((c) => c.id === chat.id)!.board!.map((b) => [b.id, b.kind, b.text]), [
    ['d1', 'decision', 'ProfileStore for saves'],
    ['q1', 'question', 'Session locking on teleport?']
  ])
  for (let i = 0; i < 6; i++) {
    await chats.send(chat.id, `@astra thought ${i}`)
    await idle(chats, chat.id)
  }
  const last = lastUser(f.requests.at(-1)!)
  assert.match(last, /## Board \(shared decisions[^\n]*\nDecisions:\n- ProfileStore for saves\nOpen questions:\n- Session locking on teleport\?/)
  const recent = last.split('## Recent group messages')[1] ?? ''
  assert.ok((recent.match(/^\[/gm) ?? []).length <= 3, 'at most 3 recent messages when the board is set')
})

// ---------------------------------------------------------------- settings

test('group settings: defaults, clamping, merge keeps older keys', () => {
  assert.deepEqual(normalizeGroupSettings(undefined), { consultTurns: 3, consultMaxTokens: 120_000, consultMaxUsd: 0.75, crossCheck: false, crossCheckModel: '', crossCheckMinFiles: 2 })
  assert.equal(normalizeGroupSettings({ consultTurns: 99 }).consultTurns, 6)
  assert.equal(normalizeGroupSettings({ consultMaxUsd: -1 }).consultMaxUsd, 0)
  const merged = mergeGroupSettings({ recentMessages: 5, consultTurns: 2 }, { crossCheck: true })
  assert.equal(merged.recentMessages, 5)
  assert.equal(merged.consultTurns, 2)
  assert.equal(merged.crossCheck, true)
})

void ({} as ChatMessage)
