import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import { editImages, editPayload, generateImages, ImageApiError, pngSize, validSize, type ArtFetch } from '../src/main/services/art/openaiImages.ts'
import { estimateImageUsd, estimateUsd } from '../src/main/services/art/pricing.ts'
import { forbidsComments, parseRegistry, registryName, renderRegistry, upsertRegistry } from '../src/main/services/art/registry.ts'
import { assetRequestJson, AssetUploadError, multipartBody, uploadImageAsset } from '../src/main/services/art/robloxAssets.ts'
import { ArtService, AGENT_MAX_VARIANTS } from '../src/main/services/art/service.ts'
import { mergeGitignore, gitignoreBlock } from '../src/main/services/art/store.ts'
import { fullPrompt, slugify } from '../src/main/services/art/styles.ts'
import { artTools, ART_TOOL_NAMES } from '../src/main/services/art/tools.ts'
import { createArtWiring } from '../src/main/services/art/wire.ts'
import { MemorySecretStore, projectScope } from '../src/main/services/release/secrets.ts'
import { SERVICE_WRITE_TOOLS } from '../src/main/agent/serviceTools.ts'
import type { ArtStatus } from '../src/shared/artTypes.ts'

// 1x1 RGBA PNG.
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')

interface Call {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}
type Reply = { status: number; body?: string; headers?: Record<string, string> }

function fakeFetch(replies: Reply[] | ((call: Call, i: number) => Reply)): { fetch: ArtFetch; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const fetch: ArtFetch = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body }
    calls.push(call)
    const n = i++
    const reply = typeof replies === 'function' ? replies(call, n) : replies[Math.min(n, replies.length - 1)]
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => reply.body ?? '' }
  }
  return { fetch, calls }
}

const imagesReply = (n: number): Reply => ({ status: 200, body: JSON.stringify({ created: 1, output_format: 'png', size: '1024x1024', quality: 'high', background: 'transparent', data: Array.from({ length: n }, () => ({ b64_json: PNG_B64 })) }) })

class MemSettings {
  data = new Map<string, unknown>()
  get<T>(k: string, f: T): T {
    return this.data.has(k) ? (this.data.get(k) as T) : f
  }
  set(k: string, v: unknown) {
    this.data.set(k, v)
  }
}

async function tempProject() {
  const root = await mkdtemp(join(tmpdir(), 'forge-art-'))
  const user = await mkdtemp(join(tmpdir(), 'forge-art-user-'))
  return { root, user, cleanup: async () => (await rm(root, { recursive: true, force: true }), await rm(user, { recursive: true, force: true })) }
}

function service(root: string, user: string, fetch: ArtFetch, extra: Partial<ConstructorParameters<typeof ArtService>[0]> = {}) {
  const sleeps: number[] = []
  const svc = new ArtService({
    root: () => root,
    scope: projectScope,
    settings: new MemSettings(),
    openAiKey: async () => 'sk-test-openai',
    robloxKey: async () => ({ key: 'roblox-open-cloud-key-xxxxxxxx', source: 'art' }),
    fetch,
    sleep: async (ms) => void sleeps.push(ms),
    now: () => new Date(2026, 9, 13, 12, 0, 0).getTime(),
    trashDir: join(user, 'trash'),
    minIntervalMs: 0,
    ...extra
  })
  return { svc, sleeps }
}

// ---------------------------------------------------------------- OpenAI Images API

test('generations: payload, auth header and base64 images', async () => {
  const { fetch, calls } = fakeFetch([imagesReply(2)])
  const res = await generateImages({ model: 'gpt-image-2.5-flare', prompt: 'coin', n: 2, size: '1024x1024', quality: 'high', background: 'transparent', outputFormat: 'png' }, { apiKey: 'sk-x', fetch })
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations')
  assert.equal(calls[0].headers?.authorization, 'Bearer sk-x')
  const body = JSON.parse(String(calls[0].body))
  assert.deepEqual(body, { model: 'gpt-image-2.5-flare', prompt: 'coin', n: 2, size: '1024x1024', quality: 'high', output_format: 'png', background: 'transparent' })
  assert.equal(res.images.length, 2)
  assert.deepEqual(pngSize(res.images[0]), { width: 1, height: 1 })
})

test('generations: background auto is omitted', async () => {
  const { fetch, calls } = fakeFetch([imagesReply(1)])
  await generateImages({ model: 'gpt-image-2.5-flare', prompt: 'x', n: 1, size: 'auto', quality: 'low', background: 'auto', outputFormat: 'png' }, { apiKey: 'k', fetch })
  assert.equal('background' in JSON.parse(String(calls[0].body)), false)
})

test('edits: JSON body with data-URL images and mask; input_fidelity only for gpt-image-1.x', async () => {
  const { fetch, calls } = fakeFetch([imagesReply(1)])
  const ref = `data:image/png;base64,${PNG_B64}`
  await editImages({ model: 'gpt-image-2.5-sunburst', prompt: 'make it red', n: 1, size: '1024x1024', quality: 'high', background: 'auto', outputFormat: 'png', images: [ref], mask: ref }, { apiKey: 'k', fetch })
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/edits')
  const body = JSON.parse(String(calls[0].body))
  assert.deepEqual(body.images, [{ image_url: ref }])
  assert.deepEqual(body.mask, { image_url: ref })
  assert.equal('input_fidelity' in body, false)
  assert.equal(editPayload({ model: 'gpt-image-1.5', prompt: 'p', n: 1, size: 'auto', quality: 'auto', background: 'auto', outputFormat: 'png', images: [ref] }).input_fidelity, 'high')
})

test('429 backs off with Retry-After, then succeeds; quota errors do not retry', async () => {
  const sleeps: number[] = []
  const { fetch, calls } = fakeFetch([{ status: 429, headers: { 'retry-after': '3' }, body: '{"error":{"message":"slow down"}}' }, { status: 500 }, imagesReply(1)])
  const res = await generateImages({ model: 'gpt-image-2.5-flare', prompt: 'x', n: 1, size: '1024x1024', quality: 'low', background: 'auto', outputFormat: 'png' }, { apiKey: 'k', fetch, sleep: async (ms) => void sleeps.push(ms) })
  assert.equal(res.images.length, 1)
  assert.equal(calls.length, 3)
  assert.deepEqual(sleeps, [3000, 4000])

  const q = fakeFetch([{ status: 429, body: '{"error":{"code":"insufficient_quota","message":"You exceeded your current quota"}}' }])
  await assert.rejects(
    generateImages({ model: 'm', prompt: 'x', n: 1, size: 'auto', quality: 'low', background: 'auto', outputFormat: 'png' }, { apiKey: 'k', fetch: q.fetch, sleep: async () => {} }),
    (e: ImageApiError) => e.status === 429 && /quota/.test(e.message)
  )
  assert.equal(q.calls.length, 1)
})

test('401 maps to a helpful message and never echoes the key', async () => {
  const { fetch } = fakeFetch([{ status: 401, body: '{"error":{"message":"Incorrect API key provided"}}' }])
  await assert.rejects(generateImages({ model: 'm', prompt: 'x', n: 1, size: 'auto', quality: 'low', background: 'auto', outputFormat: 'png' }, { apiKey: 'sk-secret', fetch }), (e: Error) => /Settings/.test(e.message) && !e.message.includes('sk-secret'))
})

test('validSize and pricing', () => {
  assert.equal(validSize('gpt-image-2.5-flare', '1920x1088'), null)
  assert.match(validSize('gpt-image-1.5', '1920x1088')!, /only supports/)
  assert.match(validSize('gpt-image-2', '1000x1000')!, /multiples of 16/)
  assert.match(validSize('gpt-image-2', '3200x1008')!, /aspect/)
  assert.equal(estimateImageUsd('gpt-image-2.5-flare', 'high', '1024x1024'), 0.0527)
  assert.equal(estimateImageUsd('gpt-image-2.5-flare', 'low', '1536x1024'), 0.0047)
  assert.equal(estimateUsd('gpt-image-2', 'medium', '1024x1024', 2, 1), 0.114)
})

// ---------------------------------------------------------------- Roblox Open Cloud Assets

test('asset upload: multipart request, operation polling, rbxassetid', async () => {
  const sleeps: number[] = []
  const { fetch, calls } = fakeFetch((call, i) => {
    if (i === 0) return { status: 200, body: JSON.stringify({ path: 'operations/op-123', done: false }) }
    if (i === 1) return { status: 429, headers: { 'retry-after': '1' } }
    if (i === 2) return { status: 200, body: JSON.stringify({ path: 'operations/op-123', done: false }) }
    return { status: 200, body: JSON.stringify({ path: 'operations/op-123', done: true, response: { path: 'assets/2205400862', assetId: '2205400862', moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } }) }
  })
  const r = await uploadImageAsset({ apiKey: 'k'.repeat(30), bytes: PNG, fileName: 'coin-1.png', displayName: 'GoldCoin', description: 'coin', assetType: 'Image', creator: { userId: 42 }, fetch, sleep: async (ms) => void sleeps.push(ms) })
  assert.equal(r.uri, 'rbxassetid://2205400862')
  assert.equal(r.moderation, 'MODERATION_STATE_APPROVED')
  assert.equal(calls[0].url, 'https://apis.roblox.com/assets/v1/assets')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers?.['x-api-key'], 'k'.repeat(30))
  assert.match(calls[0].headers?.['content-type'] ?? '', /^multipart\/form-data; boundary=/)
  const text = Buffer.from(calls[0].body as Uint8Array).toString('latin1')
  assert.match(text, /name="request"\r\n\r\n\{"assetType":"Image","displayName":"GoldCoin","description":"coin","creationContext":\{"creator":\{"userId":"42"\}\}\}/)
  assert.match(text, /name="fileContent"; filename="coin-1.png"\r\nContent-Type: image\/png/)
  assert.equal(calls[1].url, 'https://apis.roblox.com/assets/v1/operations/op-123')
  assert.equal(calls.length, 4)
  assert.ok(sleeps.includes(1000))
})

test('asset upload: group creator, operation error, missing creator and bad format', async () => {
  assert.equal(JSON.parse(assetRequestJson({ assetType: 'Decal', displayName: 'X', creator: { groupId: 7 } })).creationContext.creator.groupId, '7')
  const { fetch } = fakeFetch([{ status: 200, body: JSON.stringify({ path: 'operations/o', done: true, error: { code: 400, message: 'Asset name is moderated' } }) }])
  await assert.rejects(uploadImageAsset({ apiKey: 'k'.repeat(30), bytes: PNG, fileName: 'a.png', displayName: 'A', assetType: 'Image', creator: { userId: 1 }, fetch }), /moderated/)
  await assert.rejects(uploadImageAsset({ apiKey: 'k'.repeat(30), bytes: PNG, fileName: 'a.png', displayName: 'A', assetType: 'Image', creator: {}, fetch }), AssetUploadError)
  await assert.rejects(uploadImageAsset({ apiKey: 'k'.repeat(30), bytes: Buffer.from('RIFF0000WEBPVP8 '), fileName: 'a.webp', displayName: 'A', assetType: 'Image', creator: { userId: 1 }, fetch }), /PNG/)
  const forbidden = fakeFetch([{ status: 403, body: '{"message":"Insufficient scope"}' }])
  await assert.rejects(uploadImageAsset({ apiKey: 'k'.repeat(30), bytes: PNG, fileName: 'a.png', displayName: 'A', assetType: 'Image', creator: { userId: 1 }, fetch: forbidden.fetch }), /asset:read \+ asset:write/)
})

test('multipartBody is well formed', () => {
  const { body, contentType } = multipartBody([{ name: 'a', value: 'b' }], 'BOUND')
  assert.equal(contentType, 'multipart/form-data; boundary=BOUND')
  assert.equal(Buffer.from(body).toString(), '--BOUND\r\nContent-Disposition: form-data; name="a"\r\n\r\nb\r\n--BOUND--\r\n')
})

// ---------------------------------------------------------------- Images.luau registry

test('registry: created, sorted, idempotent, keeps hand-written entries', () => {
  const a = upsertRegistry(null, { name: 'ShopButton', uri: 'rbxassetid://2' })
  assert.equal(a.changed, true)
  const b = upsertRegistry(a.text, { name: 'Coin', uri: 'rbxassetid://1' })
  assert.equal(
    b.text,
    '--!strict\n\nexport type Images = {\n\tCoin: string,\n\tShopButton: string,\n}\n\nlocal Images: Images = {\n\tCoin = "rbxassetid://1",\n\tShopButton = "rbxassetid://2",\n}\n\nreturn table.freeze(Images)\n'
  )
  const again = upsertRegistry(b.text, { name: 'Coin', uri: 'rbxassetid://1' })
  assert.equal(again.changed, false)
  assert.equal(again.text, b.text)
  const replaced = upsertRegistry(b.text, { name: 'Coin', uri: 'rbxassetid://9' })
  assert.deepEqual(parseRegistry(replaced.text), [{ name: 'Coin', uri: 'rbxassetid://9' }, { name: 'ShopButton', uri: 'rbxassetid://2' }])
  const hand = 'return {\n    Zed = "rbxassetid://5",\n    Alpha = "rbxassetid://4",\n}\n'
  const merged = upsertRegistry(hand, { name: 'Mid', uri: 'rbxassetid://6' })
  assert.deepEqual(parseRegistry(merged.text).map((e) => e.name), ['Alpha', 'Mid', 'Zed'])
  assert.match(merged.text, /^ {4}Alpha = /m)
  assert.match(renderRegistry([], { comments: true }), /-- Uploaded image ids/)
  assert.doesNotMatch(renderRegistry([{ name: 'A', uri: 'rbxassetid://1' }]), /^-- /m)
})

test('registry names and AGENTS.md comment rule', () => {
  assert.equal(registryName('gold coin-icon 2'), 'GoldCoinIcon2')
  assert.equal(registryName('shopButton'), 'ShopButton')
  assert.equal(registryName('2d logo'), 'Image2dLogo')
  assert.equal(forbidsComments('- No comments in game scripts.'), true)
  assert.equal(forbidsComments('Do not add comments to Luau files'), true)
  assert.equal(forbidsComments('Write clear comments.'), false)
  assert.equal(forbidsComments(null), false)
})

test('slugify, style prompt and gitignore block', () => {
  assert.equal(slugify('A Shop Button for the HUD!'), 'shop-button-hud')
  assert.match(fullPrompt('coin', 'roblox-ui-flat', true), /Style: Flat game UI[\s\S]*Transparent background/)
  assert.deepEqual(gitignoreBlock('ignore', []), ['*', '!.gitignore'])
  assert.deepEqual(gitignoreBlock('track-small', ['concepts/2026-10-13/big-1.png']), ['/concepts/2026-10-13/big-1.png'])
  const g = mergeGitignore('mine.psd\n', ['/x.png'])
  assert.equal(mergeGitignore(g, ['/x.png']), g)
  assert.match(g, /mine\.psd\n# forge:begin\n\/x\.png\n# forge:end\n$/)
})

// ---------------------------------------------------------------- service

test('service.generate saves PNGs and sidecars under art/concepts/<date>, numbered', async () => {
  const t = await tempProject()
  try {
    const { fetch, calls } = fakeFetch([imagesReply(2), imagesReply(1)])
    const { svc } = service(t.root, t.user, fetch)
    const items = await svc.generate({ prompt: 'Gold coin icon', style: 'stylized-icon', n: 2 })
    assert.deepEqual(items.map((i) => i.path), ['art/concepts/2026-10-13/gold-coin-icon-1.png', 'art/concepts/2026-10-13/gold-coin-icon-2.png'])
    const side = JSON.parse(await readFile(join(t.root, 'art/concepts/2026-10-13/gold-coin-icon-1.json'), 'utf8'))
    assert.equal(side.prompt, 'Gold coin icon')
    assert.equal(side.model, 'gpt-image-2.5-flare')
    assert.equal(side.size, '1024x1024')
    assert.equal(side.seed, null)
    assert.equal(side.background, 'transparent')
    assert.ok(side.costUsd > 0)
    assert.equal('absPath' in side, false)
    assert.equal(JSON.parse(String(calls[0].body)).background, 'transparent')
    const more = await svc.generate({ prompt: 'Gold coin icon' })
    assert.equal(more[0].index, 3)
    const list = await svc.list()
    assert.equal(list.length, 3)
    assert.match(await readFile(join(t.root, 'art/.gitignore'), 'utf8'), /# forge:begin\n# forge:end/)
  } finally {
    await t.cleanup()
  }
})

test('service: references make an edit; daily cap refuses; agent variants capped', async () => {
  const t = await tempProject()
  try {
    await writeFile(join(t.root, 'shot.png'), PNG)
    const { fetch, calls } = fakeFetch(() => imagesReply(1))
    const { svc } = service(t.root, t.user, fetch)
    const [item] = await svc.generate({ prompt: 'Restyle this HUD', referencePaths: ['shot.png'] })
    assert.equal(item.mode, 'edit')
    assert.deepEqual(item.referencePaths, ['shot.png'])
    assert.match(calls[0].url, /\/images\/edits$/)
    assert.equal((await svc.estimate({ prompt: 'x', n: 10, source: 'agent' })).n, AGENT_MAX_VARIANTS)
    await assert.rejects(svc.generate({ prompt: 'x', referencePaths: ['missing.png'] }), /not found/)
    await svc.setSettings({ dailyCapUsd: 0.05 })
    await assert.rejects(svc.generate({ prompt: 'x', n: 2, quality: 'high' }), /budget/)
  } finally {
    await t.cleanup()
  }
})

test('service: delete with undo, save to project, import writes the registry', async () => {
  const t = await tempProject()
  try {
    let polls = 0
    const { fetch } = fakeFetch((call) => {
      if (call.url.endsWith('/images/generations')) return imagesReply(1)
      if (call.url.endsWith('/assets')) return { status: 200, body: '{"path":"operations/abc","done":false}' }
      polls++
      return { status: 200, body: JSON.stringify(polls < 2 ? { path: 'operations/abc', done: false } : { done: true, response: { assetId: '555' } }) }
    })
    const { svc } = service(t.root, t.user, fetch)
    await svc.setSettings({ creatorUserId: 42 })
    const [item] = await svc.generate({ prompt: 'Shop button' })
    const { undoId } = await svc.remove(item.path)
    assert.equal((await svc.list()).length, 0)
    const back = await svc.undoRemove(undoId)
    assert.equal(back?.path, item.path)
    assert.equal((await svc.list()).length, 1)

    const saved = await svc.saveToProject(item.path, 'shop button')
    assert.equal(saved.savedAs, 'art/ui/ShopButton.png')
    assert.ok((await stat(join(t.root, 'art/ui/ShopButton.png'))).isFile())

    await mkdir(join(t.root, 'src/shared'), { recursive: true })
    await writeFile(join(t.root, 'AGENTS.md'), 'Rules: no comments in game scripts.\n')
    const r = await svc.importToRoblox({ path: item.path, name: 'ShopButton' })
    assert.equal(r.uri, 'rbxassetid://555')
    assert.deepEqual(r.registry, { path: 'src/shared/Assets/Images.luau', name: 'ShopButton', changed: true })
    const reg = await readFile(join(t.root, 'src/shared/Assets/Images.luau'), 'utf8')
    assert.match(reg, /\tShopButton = "rbxassetid:\/\/555",/)
    assert.doesNotMatch(reg, /^-- /m)
    assert.equal((await svc.list())[0].roblox?.uri, 'rbxassetid://555')
    assert.deepEqual(await svc.registry(), [{ name: 'ShopButton', uri: 'rbxassetid://555' }])
  } finally {
    await t.cleanup()
  }
})

test('service: missing OpenAI key and missing creator explain what to do', async () => {
  const t = await tempProject()
  try {
    const { fetch } = fakeFetch([imagesReply(1)])
    const { svc } = service(t.root, t.user, fetch, { openAiKey: async () => null })
    await assert.rejects(svc.generate({ prompt: 'x' }), /OpenAI API key/)
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- tools and wiring

test('tool schemas: names, required fields, limits; registered as service write tools', async () => {
  const t = await tempProject()
  try {
    const { fetch } = fakeFetch(() => imagesReply(2))
    const { svc } = service(t.root, t.user, fetch)
    const tools = artTools({ service: svc, chatImage: async (_abs, name) => `![${name}](forge-image://img-1)` })
    assert.deepEqual(tools.map((x) => x.name), [...ART_TOOL_NAMES])
    for (const name of ART_TOOL_NAMES) assert.ok((SERVICE_WRITE_TOOLS as readonly string[]).includes(name))
    const gen = z.object(tools[0].inputSchema)
    assert.equal(gen.safeParse({ prompt: 'a shop button' }).success, true)
    assert.equal(gen.safeParse({ prompt: 'a shop button', n: AGENT_MAX_VARIANTS + 1 }).success, false)
    assert.equal(gen.safeParse({ prompt: 'x', size: 'big' }).success, false)
    assert.equal(gen.safeParse({ prompt: 'icon', size: '1024x1024', transparent: true, n: 2, reference_paths: ['art/concepts/a.png'] }).success, true)
    const imp = z.object(tools[1].inputSchema)
    assert.equal(imp.safeParse({ path: 'art/x.png' }).success, false)
    assert.equal(imp.safeParse({ path: 'art/x.png', name: 'ShopButton' }).success, true)
    assert.equal(z.object(tools[2].inputSchema).safeParse({}).success, true)

    const res = await tools[0].handler({ prompt: 'shop button', n: 2 }, undefined)
    assert.equal(res.isError, undefined)
    const text = res.content[0].text
    assert.match(text, /^generated 2 images with gpt-image-2\.5-flare/)
    assert.match(text, /!\[shop-button-1\.png\]\(forge-image:\/\/img-1\)/)
    const listed = await tools[2].handler({}, undefined)
    assert.match(listed.content[0].text, /art\/concepts\/2026-10-13\/shop-button-2\.png/)
    const bad = await tools[1].handler({ path: '../etc/passwd', name: 'X' }, undefined)
    assert.equal(bad.isError, true)
  } finally {
    await t.cleanup()
  }
})

test('wiring: Roblox key falls back to the Release key; no handler returns a key', async () => {
  const t = await tempProject()
  try {
    const secrets = new MemorySecretStore()
    const settings = new MemSettings()
    const events: string[] = []
    const w = createArtWiring({ root: () => t.root, settings, secrets, userDataDir: t.user, openAiKey: async () => 'sk-hidden-openai', emit: (e) => void events.push(e) })
    let s = (await w.handlers.artStatus()) as ArtStatus
    assert.equal(s.robloxKey, false)
    await secrets.set(`release.openCloudApiKey.${projectScope(t.root)}`, 'release-key-123456789012345')
    s = (await w.handlers.artStatus()) as ArtStatus
    assert.equal(s.robloxKeySource, 'release')
    s = (await w.handlers.artSetRobloxKey('art-key-1234567890123456789', 'project')) as ArtStatus
    assert.equal(s.robloxKeySource, 'art')
    assert.ok(!JSON.stringify(s).includes('art-key-123') && !JSON.stringify(s).includes('sk-hidden'))
    await assert.rejects(Promise.resolve().then(() => w.handlers.artSetRobloxKey('short', 'project')), /Open Cloud/)
    s = (await w.handlers.artSetSettings({ gitPolicy: 'ignore' })) as ArtStatus
    assert.equal(s.settings.gitPolicy, 'ignore')
    assert.match(await readFile(join(t.root, 'art/.gitignore'), 'utf8'), /^\*$/m)
  } finally {
    await t.cleanup()
  }
})

test('wiring: generated images become chat image markers; forge-image refs resolve to the store', async () => {
  const { ChatImageStore, setChatImageStore, extractImageMarkers } = await import('../src/main/agent/chatImages.ts')
  const { defaultChatImage, defaultResolveReference } = await import('../src/main/services/art/wire.ts')
  const t = await tempProject()
  try {
    setChatImageStore(new ChatImageStore(join(t.user, 'chat-images')))
    await writeFile(join(t.root, 'a.png'), PNG)
    const marker = await defaultChatImage(join(t.root, 'a.png'), 'a.png')
    const { ids } = extractImageMarkers(marker ?? '')
    assert.equal(ids.length, 1)
    const path = await defaultResolveReference(`forge-image://${ids[0].id}`)
    assert.ok(path && path.endsWith(`${ids[0].id}.png`))
    assert.equal(await defaultResolveReference('forge-image://not-an-id'), null)
  } finally {
    await t.cleanup()
  }
})
