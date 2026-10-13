// Chat additions: reasoning effort per provider (request bodies on every path), image parts per
// provider, the chat image store and markers, the downscale helper, and vision gating.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options } from '@anthropic-ai/claude-agent-sdk'
import { fakeContext } from './agentFake.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { extraBody, Providers, sdkEffortOptions } from '../src/main/agent/providers.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { GroupChat, type Room } from '../src/main/agent/groupChat.ts'
import { makeParticipant } from '../src/shared/modelResolve.ts'
import { runOpenAiLoop } from '../src/main/agent/openaiLoop.ts'
import { runResponsesLoop, toResponsesInput } from '../src/main/agent/responsesLoop.ts'
import { ChatImageStore, extractImageMarkers, imageMarker, imageSize, setChatImageStore, sniffMime } from '../src/main/agent/chatImages.ts'
import { anthropicContent, chatCompletionsContent, resolveHistoryImages, responsesContent, userContentWithRefs } from '../src/main/agent/imageParts.ts'
import { toChatMessages, type QueryFn } from '../src/main/agent/sdk.ts'
import { autoEffort, clampEffort, effortSupport, routeSummary, supportsVision } from '../src/shared/modelCaps.ts'
import { acceptedImageType, encodeType, fitWithin } from '../src/renderer/src/assistant/imageScale.ts'

// ---------------------------------------------------------------- fakes

// 1x1 PNG.
const PNG_1x1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

function pngHeader(w: number, h: number): Buffer {
  const b = Buffer.alloc(33)
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0)
  b.writeUInt32BE(13, 8)
  b.write('IHDR', 12, 'ascii')
  b.writeUInt32BE(w, 16)
  b.writeUInt32BE(h, 20)
  return b
}

interface Req {
  url: string
  body: any
}

function fakeFetch(): { fetch: typeof fetch; requests: Req[]; ollamaVision: Record<string, boolean> } {
  const requests: Req[] = []
  const ollamaVision: Record<string, boolean> = {}
  const fn = (async (url: string, init: RequestInit = {}) => {
    const u = String(url)
    const body = init.body ? JSON.parse(String(init.body)) : null
    if (u.endsWith('/api/show')) {
      const vision = ollamaVision[body.model]
      return new Response(JSON.stringify({ capabilities: vision ? ['completion', 'vision'] : ['completion'] }), { status: 200, headers: { 'content-type': 'application/json' } })
    }
    requests.push({ url: u, body })
    if (u.endsWith('/responses')) {
      const sse = `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'ok' })}\n\ndata: ${JSON.stringify({ type: 'response.completed', response: { output: [{ type: 'message', content: [{ type: 'output_text', text: 'ok' }] }], usage: { input_tokens: 1, output_tokens: 1 } } })}\n\n`
      return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    }
    const sse = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'ok' } }] })}\n\ndata: [DONE]\n\n`
    return new Response(sse, { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }) as unknown as typeof fetch
  return { fetch: fn, requests, ollamaVision }
}

async function setup(env: Record<string, string> = {}) {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, async () => null, { ANTHROPIC_API_KEY: 'sk-ant', OPENAI_API_KEY: 'sk-oai', GEMINI_API_KEY: 'g', OPENROUTER_API_KEY: 'or', ...env })
  const f = fakeFetch()
  const providers = new Providers(fake.ctx, creds, f.fetch)
  const sdkCalls: { prompt: unknown; options: Options }[] = []
  const queryFn: QueryFn = ({ prompt, options }) => {
    sdkCalls.push({ prompt, options })
    return (async function* () {
      yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } } as any
    })()
  }
  const chats = new ChatManager(fake.ctx, { credentials: creds, providers, fetchFn: f.fetch, toolFs: fake.fs, queryFn, makeServer: () => ({ type: 'sdk', name: 'gentree', instance: {} }) as any })
  const dir = await mkdtemp(join(tmpdir(), 'forge-img-'))
  const store = new ChatImageStore(dir)
  setChatImageStore(store)
  return { fake, chats, f, sdkCalls, store, providers }
}

async function turn(chats: ChatManager, id: string, text: string, images: string[] = []) {
  await chats.send(id, text, images)
  while (chats.busy(id)) await new Promise((r) => setTimeout(r, 5))
}

// ---------------------------------------------------------------- effort: capability tables

test('effort levels per model follow the providers docs', () => {
  assert.deepEqual(effortSupport('anthropic', 'claude-opus-5-5'), { levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' })
  assert.equal(effortSupport('anthropic', 'claude-sonnet-5-5').default, 'high')
  assert.deepEqual(effortSupport('anthropic', 'claude-sonnet-4-6').levels, ['low', 'medium', 'high', 'max'])
  assert.deepEqual(effortSupport('anthropic', 'claude-opus-4-5').levels, ['low', 'medium', 'high'])
  assert.deepEqual(effortSupport('anthropic', 'claude-3-haiku').levels, [])
  assert.deepEqual(effortSupport('openai', 'gpt-6.1-sol').levels, ['low', 'medium', 'high', 'xhigh', 'max'])
  // Luna only takes reasoning_effort "none" with tools on Chat Completions: no picker.
  assert.deepEqual(effortSupport('openai', 'gpt-6-luna').levels, [])
  assert.deepEqual(effortSupport('gemini', 'gemini-3.8-flash').levels, ['low', 'medium', 'high'])
  assert.deepEqual(effortSupport('ollama', 'qwen3.8').levels, [])
  assert.deepEqual(effortSupport('custom', 'anything').levels, [])
  // OpenRouter: runtime metadata wins; null = every level; absent = none.
  assert.deepEqual(effortSupport('openrouter', 'x/y', { efforts: ['high', 'low'] }).levels, ['low', 'high'])
  assert.equal(effortSupport('openrouter', 'x/y', { efforts: null }).levels.length, 5)
  assert.deepEqual(effortSupport('openrouter', 'x/y', { efforts: undefined }).levels, [])
  assert.deepEqual(effortSupport('openrouter', 'anthropic/claude-haiku-5.5').levels.length, 5)
})

test('clampEffort falls back to the nearest lower level, autoEffort follows the tier', () => {
  assert.equal(clampEffort('max', ['low', 'medium', 'high']), 'high')
  assert.equal(clampEffort('xhigh', ['low', 'medium', 'high', 'max']), 'high')
  assert.equal(clampEffort('low', ['medium', 'high']), 'medium')
  assert.equal(clampEffort('high', []), undefined)
  const s = effortSupport('anthropic', 'claude-haiku-5-5')
  assert.equal(autoEffort('cheap', s), 'low')
  assert.equal(autoEffort('big', s), 'high')
  assert.equal(autoEffort('chosen', s), undefined)
  assert.equal(routeSummary({ model: 'claude-sonnet-5-5', tier: 'chosen', effort: 'medium' }, 'auto'), 'auto → sonnet · med')
  assert.equal(routeSummary({ model: 'claude-opus-5-5', tier: 'chosen', effort: 'high' }, 'high'), 'opus · high')
  assert.equal(routeSummary({ model: 'gpt-6.1-sol', tier: 'chosen' }, 'auto', 'medium'), 'auto → sol · med')
})

test('extraBody maps an effort per provider dialect', () => {
  assert.deepEqual(extraBody('openai', 'gpt-6-astra', 'high'), { stream_options: { include_usage: true }, reasoning_effort: 'high' })
  assert.deepEqual(extraBody('openai', 'gpt-6-luna', 'high'), { reasoning_effort: 'none', stream_options: { include_usage: true } })
  assert.deepEqual(extraBody('gemini', 'gemini-3.1-pro-preview', 'max'), { reasoning_effort: 'high' })
  assert.deepEqual(extraBody('openrouter', 'openai/gpt-6.1-sol', 'xhigh'), { reasoning: { effort: 'xhigh' } })
  assert.deepEqual(extraBody('ollama', 'qwen3.8', 'high'), {})
  assert.deepEqual(extraBody('openai', 'gpt-6-astra'), { stream_options: { include_usage: true } })
  assert.deepEqual(sdkEffortOptions('claude-sonnet-4-6', 'xhigh'), { effort: 'high' })
  assert.deepEqual(sdkEffortOptions('claude-3-haiku', 'high'), {})
})

// ---------------------------------------------------------------- effort: request bodies per path

test('anthropic (Agent SDK): explicit effort is sent as Options.effort and pins the model', async () => {
  const { chats, sdkCalls } = await setup()
  const chat = chats.create(undefined, { effort: 'max' })
  assert.equal(chat.effort, 'max')
  await turn(chats, chat.id, 'what is a ModuleScript?')
  // A short question would route to Haiku; an explicit effort keeps the chosen model.
  assert.equal(sdkCalls[0].options.model, 'claude-opus-5-5')
  assert.equal(sdkCalls[0].options.effort, 'max')
  assert.equal(chats.list()[0].route?.effort, 'max')
  // Back to auto: the router picks the cheap tier and a low effort.
  chats.setEffort(chat.id, 'auto')
  const fresh = chats.create()
  await turn(chats, fresh.id, 'what is a ModuleScript?')
  assert.equal(sdkCalls[1].options.model, 'claude-haiku-5-5')
  assert.equal(sdkCalls[1].options.effort, 'low')
  // Default model on a "default" turn: no effort sent (the model's default applies).
  const third = chats.create()
  await turn(chats, third.id, 'Add a coins counter to the HUD and wire it up to the player data module please')
  assert.equal(sdkCalls[2].options.effort, undefined)
})

test('openai Chat Completions: reasoning_effort in the body; luna keeps "none"', async () => {
  const { chats, f } = await setup()
  const chat = chats.create({ provider: 'openai', model: 'gpt-6-astra' }, { effort: 'high' })
  await turn(chats, chat.id, 'hi')
  assert.match(f.requests[0].url, /\/chat\/completions$/)
  assert.equal(f.requests[0].body.reasoning_effort, 'high')
  const luna = chats.create({ provider: 'openai', model: 'gpt-6-luna' }, { effort: 'high' })
  await turn(chats, luna.id, 'hi')
  assert.equal(f.requests[1].body.reasoning_effort, 'none')
})

test('openai Responses (gpt-6.1-sol): reasoning.effort in the body, xhigh/max allowed', async () => {
  const { chats, f } = await setup()
  const chat = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' }, { effort: 'max' })
  await turn(chats, chat.id, 'hi')
  assert.match(f.requests[0].url, /\/responses$/)
  assert.deepEqual(f.requests[0].body.reasoning, { effort: 'max' })
  assert.equal(f.requests[0].body.reasoning_effort, undefined)
})

test('gemini and openrouter: their reasoning params; ollama sends none', async () => {
  const { chats, f } = await setup()
  const g = chats.create({ provider: 'gemini', model: 'gemini-3.8-flash' }, { effort: 'max' })
  await turn(chats, g.id, 'hi')
  assert.equal(f.requests[0].body.reasoning_effort, 'high')
  const o = chats.create({ provider: 'openrouter', model: 'anthropic/claude-sonnet-5.5' }, { effort: 'xhigh' })
  await turn(chats, o.id, 'hi')
  assert.deepEqual(f.requests[1].body.reasoning, { effort: 'xhigh' })
  const l = chats.create({ provider: 'ollama', model: 'qwen3.8' }, { effort: 'high' })
  await turn(chats, l.id, 'hi')
  assert.equal(f.requests[2].body.reasoning_effort, undefined)
  assert.equal(f.requests[2].body.reasoning, undefined)
})

test('default effort comes from settings and applies to new chats', async () => {
  const { chats } = await setup()
  assert.equal(chats.defaultEffort(), 'auto')
  chats.setDefaultEffort('low')
  assert.equal(chats.create().effort, 'low')
  assert.throws(() => chats.setDefaultEffort('huge' as any))
})

// ---------------------------------------------------------------- images: pure mapping

test('image parts per provider API', () => {
  const img = { mime: 'image/png', base64: 'AAAA' }
  assert.deepEqual(chatCompletionsContent('look', [img]), [
    { type: 'text', text: 'look' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }
  ])
  assert.equal(chatCompletionsContent('plain', []), 'plain')
  assert.deepEqual(responsesContent(chatCompletionsContent('look', [img]) as any), [
    { type: 'input_text', text: 'look' },
    { type: 'input_image', image_url: 'data:image/png;base64,AAAA', detail: 'auto' }
  ])
  assert.deepEqual(anthropicContent('look', [img]), [
    { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } },
    { type: 'text', text: 'look' }
  ])
  // An image on its own: no empty text block (the Messages API rejects them).
  assert.deepEqual(anthropicContent('', [img]).map((b) => b.type), ['image'])
  assert.deepEqual(userContentWithRefs('x', ['11111111-1111-4111-8111-111111111111']), [
    { type: 'text', text: 'x' },
    { type: 'image_url', image_url: { url: 'forge-image://11111111-1111-4111-8111-111111111111' } }
  ])
})

test('stored history keeps references; requests get data URLs', async () => {
  const id = '22222222-2222-4222-8222-222222222222'
  const history = [{ role: 'user', content: userContentWithRefs('see', [id]) }] as any[]
  const out = await resolveHistoryImages(history, async () => ({ mime: 'image/jpeg', base64: 'QUJD' }))
  assert.equal(out[0].content[1].image_url.url, 'data:image/jpeg;base64,QUJD')
  assert.equal(history[0].content[1].image_url.url, `forge-image://${id}`)
  const gone = await resolveHistoryImages(history, async () => null)
  assert.deepEqual(gone[0].content[1], { type: 'text', text: '[image no longer available]' })
  assert.deepEqual(toResponsesInput(out)[0].content[1], { type: 'input_image', image_url: 'data:image/jpeg;base64,QUJD', detail: 'auto' })
})

test('image store: sniffs type and size, refuses non-images, round-trips data URLs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-store-'))
  const store = new ChatImageStore(dir)
  assert.equal(sniffMime(PNG_1x1), 'image/png')
  assert.deepEqual(imageSize(pngHeader(3000, 1500)), { width: 3000, height: 1500 })
  const ref = await store.add({ dataUrl: `data:image/png;base64,${PNG_1x1.toString('base64')}`, name: 'dot' })
  assert.equal(ref.mime, 'image/png')
  assert.equal(ref.width, 1)
  assert.equal(await store.dataUrl(ref.id), `data:image/png;base64,${PNG_1x1.toString('base64')}`)
  const file = join(dir, 'art.png')
  await writeFile(file, PNG_1x1)
  const fromPath = await store.importFile(file)
  assert.equal(fromPath.name, 'art')
  await assert.rejects(store.add({ dataUrl: 'data:text/plain;base64,aGVsbG8=' }), /PNG, JPEG, WebP and GIF/)
  assert.equal(await store.read('../../etc/passwd'), null)
})

test('markers: tools put images in text, messages get them as images', () => {
  const id = '33333333-3333-4333-8333-333333333333'
  const m = imageMarker({ id, name: 'sword icon' })
  assert.equal(m, `![sword icon](forge-image://${id})`)
  const x = extractImageMarkers(`Generated:\n${m}\nDone.`)
  assert.deepEqual(x.ids, [{ id, name: 'sword icon' }])
  assert.equal(x.text, 'Generated:\n\nDone.')
  // SDK path: an image in a tool result surfaces as a message.
  const out = toChatMessages({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: [{ type: 'text', text: `ok ${m}` }] }] } } as any, 'main')
  assert.equal(out.length, 1)
  assert.match(out[0].text, /forge-image:\/\//)
})

// ---------------------------------------------------------------- images: per provider, end to end

test('anthropic: images go through the SDK streaming input as image blocks', async () => {
  const { chats, sdkCalls, store } = await setup()
  const ref = await store.add({ dataUrl: `data:image/png;base64,${PNG_1x1.toString('base64')}` })
  const chat = chats.create()
  await turn(chats, chat.id, 'what is in this?', [ref.id])
  const prompt = sdkCalls[0].prompt as AsyncIterable<any>
  assert.equal(typeof prompt, 'object')
  const msgs: any[] = []
  for await (const m of prompt) msgs.push(m)
  assert.equal(msgs.length, 1)
  assert.equal(msgs[0].type, 'user')
  assert.deepEqual(msgs[0].message.content.map((b: any) => b.type), ['image', 'text'])
  assert.equal(msgs[0].message.content[0].source.data, PNG_1x1.toString('base64'))
  // The saved message holds a reference, not the bytes.
  const user = chats.messages(chat.id)!.find((m) => m.role === 'user')!
  assert.deepEqual(user.images?.map((i) => i.id), [ref.id])
  assert.ok(!JSON.stringify(user).includes(PNG_1x1.toString('base64')))
})

test('openai / gemini / openrouter: image_url parts; responses: input_image; history stays small', async () => {
  const { chats, f, store } = await setup()
  const ref = await store.add({ dataUrl: `data:image/png;base64,${PNG_1x1.toString('base64')}` })
  const data = `data:image/png;base64,${PNG_1x1.toString('base64')}`
  for (const [provider, model] of [['openai', 'gpt-6-astra'], ['gemini', 'gemini-3.8-flash'], ['openrouter', 'google/gemini-3.8-flash']] as const) {
    const chat = chats.create({ provider, model })
    await turn(chats, chat.id, 'look', [ref.id])
    const user = f.requests.at(-1)!.body.messages.at(-1)
    assert.deepEqual(user.content[1], { type: 'image_url', image_url: { url: data } }, provider)
  }
  const sol = chats.create({ provider: 'openai', model: 'gpt-6.1-sol' })
  await turn(chats, sol.id, 'look', [ref.id])
  const input = f.requests.at(-1)!.body.input
  assert.deepEqual(input.at(-1).content[1], { type: 'input_image', image_url: data, detail: 'auto' })
  chats.flush()
})

test('vision gating: ollama only with vision (from /api/show); others get a note and text only', async () => {
  const { chats, f, store, fake } = await setup()
  const ref = await store.add({ dataUrl: `data:image/png;base64,${PNG_1x1.toString('base64')}` })
  f.ollamaVision['llava:13b'] = true
  const v = chats.create({ provider: 'ollama', model: 'llava:13b' })
  await turn(chats, v.id, 'look', [ref.id])
  assert.equal(f.requests.at(-1)!.body.messages.at(-1).content[1].type, 'image_url')
  const t = chats.create({ provider: 'ollama', model: 'qwen3.8' })
  await turn(chats, t.id, 'look', [ref.id])
  assert.equal(f.requests.at(-1)!.body.messages.at(-1).content, 'look')
  assert.match(chats.messages(t.id)!.find((m) => m.role === 'system')!.text, /cannot read images/)
  // Static table.
  assert.equal(supportsVision('anthropic', 'claude-haiku-5-5'), true)
  assert.equal(supportsVision('openai', 'gpt-6-luna'), true)
  assert.equal(supportsVision('ollama', 'llama3.1'), false)
  assert.equal(supportsVision('ollama', 'llama3.2-vision'), true)
  assert.equal(supportsVision('openrouter', 'x/y', { vision: true }), true)
  assert.equal(supportsVision('custom', 'my-model'), false)
  void fake
})

test('group chat: guests that read images get them; others do not', async () => {
  const { store, f, fake } = await setup()
  const creds = new Credentials(fake.ctx, async () => null, { OPENAI_API_KEY: 'k' })
  const providers = new Providers(fake.ctx, creds, f.fetch)
  const group = new GroupChat(fake.ctx, { credentials: creds, providers, fetchFn: f.fetch, toolFs: fake.fs })
  const ref = await store.add({ dataUrl: `data:image/png;base64,${PNG_1x1.toString('base64')}` })
  const host = makeParticipant({ provider: 'anthropic', model: 'claude-opus-5-5' }, 'host')
  const astra = makeParticipant({ provider: 'openai', model: 'gpt-6-astra' }, 'guest', ['opus'])
  const room: Room = {
    id: 'r',
    host,
    guests: [astra],
    guestTools: false,
    messages: [],
    signal: new AbortController().signal,
    push: () => {},
    addGuest: () => {},
    recordUsage: () => {},
    note: () => {},
    images: [ref]
  }
  await group.ask(room, astra, 'what do you see?', 'direct', 'User')
  const user = f.requests.at(-1)!.body.messages.at(-1)
  assert.equal(user.content[1].type, 'image_url')
  const payloads = await group.imagesFor(makeParticipant({ provider: 'ollama', model: 'llama3.1' }, 'guest'), [ref])
  assert.equal(payloads.length, 0)
})

// ---------------------------------------------------------------- downscale helper

test('fitWithin keeps the long edge at most 1568 and never upscales', () => {
  assert.deepEqual(fitWithin(3136, 1000), { width: 1568, height: 500, scaled: true })
  assert.deepEqual(fitWithin(1000, 4000), { width: 392, height: 1568, scaled: true })
  assert.deepEqual(fitWithin(800, 600), { width: 800, height: 600, scaled: false })
  assert.deepEqual(fitWithin(1568, 1568), { width: 1568, height: 1568, scaled: false })
  assert.deepEqual(fitWithin(10000, 1, 1568), { width: 1568, height: 1, scaled: true })
  assert.deepEqual(fitWithin(0, 0), { width: 0, height: 0, scaled: false })
  assert.equal(acceptedImageType('image/PNG'), true)
  assert.equal(acceptedImageType('image/svg+xml'), false)
  assert.equal(encodeType('image/gif'), 'image/png')
  assert.equal(encodeType('image/jpeg'), 'image/jpeg')
})

test('loops pass extraBody effort through unchanged (runOpenAiLoop / runResponsesLoop)', async () => {
  const f = fakeFetch()
  const base = { baseUrl: 'https://x/v1', model: 'm', system: 's', history: [{ role: 'user' as const, content: 'hi' }], tools: [], maxTurns: 1, signal: new AbortController().signal, agentId: 'a', emit: () => {}, fetchFn: f.fetch }
  await runOpenAiLoop({ ...base, extraBody: extraBody('openai', 'gpt-5.6-terra', 'low') })
  assert.equal(f.requests[0].body.reasoning_effort, 'low')
  await runResponsesLoop({ ...base, extraBody: extraBody('openai', 'gpt-6.1-sol', 'xhigh') })
  assert.deepEqual(f.requests[1].body.reasoning, { effort: 'xhigh' })
})
