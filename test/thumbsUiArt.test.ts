// Thumbnail Lab prompt builder + UI art through ThumbService with fake image backends: no backend
// (clear message, the builder still works), the OpenAI Images API (transparent PNG requests at the
// kind's size, key-out of opaque answers, 9-slice, the one-call ranking critic, cost in today's
// spend), the learned kit attached to the next prompt as palette / look / edit references, icon sets
// on the Codex backend anchored on the best first icon, export into the project with Luau, Open Cloud
// upload, the builder's model expansion, thumbnails made from (edited) sections and "use as
// reference".
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, type Rgba } from '../src/shared/vfx/tex/image.ts'
import { decodePng, encodePng } from '../src/main/services/vfx/textures/png.ts'
import { ThumbService, type VisionFn } from '../src/main/services/thumbs/service.ts'
import { NO_BACKEND } from '../src/main/services/thumbs/uiart.ts'
import { LAB_HANDLERS } from '../src/main/services/gating/wire.ts'
import { batchOf } from '../src/shared/thumbs/size.ts'
import { sectionText } from '../src/shared/thumbs/builder.ts'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'
import type { CodexImages } from '../src/main/services/art/imageBackend.ts'
import { button } from './uiArtFixture.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-uiart-${p}-`))

function settingsStore(init: Record<string, unknown> = {}) {
  const m = new Map(Object.entries(init))
  return { get: <T>(k: string, f: T) => (m.has(k) ? (m.get(k) as T) : f), set: (k: string, v: unknown) => void m.set(k, v), m }
}

// A coin icon on a transparent canvas (what a model that honours transparency returns).
function coin(size = 256, rgb: [number, number, number] = [240, 190, 30]): Rgba {
  const img = blank(size)
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const d = Math.hypot(x - size / 2, y - size / 2)
      if (d < size * 0.36) img.data.set(d > size * 0.31 ? [40, 30, 10, 255] : [...rgb, 255], (y * size + x) * 4)
    }
  return img
}

interface Call {
  url: string
  body: any
  headers: Record<string, string>
}

function fakeOpenAi(images: () => Rgba[]) {
  const calls: Call[] = []
  const json = (status: number, body: unknown) => ({ status, ok: status < 300, headers: { get: () => null }, text: async () => JSON.stringify(body) })
  const fetch: ArtFetch = async (url, init) => {
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body
    calls.push({ url, body, headers: init?.headers ?? {} })
    if (url.endsWith('/images/generations') || url.endsWith('/images/edits')) {
      const list = images()
      return json(200, { data: Array.from({ length: body.n }, (_, i) => ({ b64_json: encodePng(list[i % list.length]).toString('base64') })) })
    }
    if (url === 'https://apis.roblox.com/assets/v1/assets') return json(200, { path: 'operations/op-1', operationId: 'op-1', done: true, response: { assetId: '4321', moderationResult: { moderationState: 'Approved' } } })
    if (url.includes('/assets/v1/operations/')) return json(200, { done: true, response: { assetId: '4321' } })
    return json(404, { error: 'unknown' })
  }
  return { fetch, calls }
}

function fakeCodex(images: () => Rgba[]) {
  const calls: { prompt: string; n: number; size?: string; transparent?: boolean; refs: number }[] = []
  const codex: CodexImages = {
    status: async () => ({ ready: true, detail: 'signed in' }) as never,
    generate: async (req) => {
      calls.push({ prompt: req.prompt, n: req.n, size: req.size, transparent: req.transparent, refs: req.references?.length ?? 0 })
      const list = images()
      return { images: Array.from({ length: Math.min(4, req.n) }, (_, i) => encodePng(list[i % list.length])), notes: ['Codex picks the image size itself (auto); the result is fitted afterwards.'] }
    }
  }
  return { codex, calls }
}

interface Opts {
  key?: string | null
  codex?: CodexImages
  vision?: 'rank' | 'broken' | 'none' | 'expand-fails'
  images?: () => Rgba[]
  cap?: number
}

function makeService(dir: string, root: string | null, o: Opts = {}) {
  const http = fakeOpenAi(o.images ?? (() => [button(600, 240, 480, 160, 40, [255, 255, 255]), button(600, 240, 300, 120, 30, [255, 255, 255], [220, 40, 40]), button(600, 240, 520, 200, 20, [255, 255, 255], [40, 80, 220])]))
  const visionCalls: { tier: string; system: string; prompt: string; images: number }[] = []
  const memory: { name: string; body: string }[] = []
  const events: { event: string; payload: any }[] = []
  let charged = 0
  const vision = (tier: string): VisionFn | null => {
    if (o.vision === 'none') return null
    return async (system, prompt, images) => {
      visionCalls.push({ tier, system, prompt, images: images.length })
      if (system.includes('writing prompts')) {
        if (o.vision === 'expand-fails') throw new Error('no provider signed in')
        return JSON.stringify({ subject: 'A chunky emerald-green pill button with a raised bevel', lighting: 'Soft top light with a bright specular streak', text: 'BUY in huge letters' })
      }
      if (system.includes('UI art director')) {
        if (o.vision === 'broken') return 'I cannot rank these.'
        // Prefers the second candidate; describes the look.
        const n = Number(/(\d+) candidates? follow/.exec(prompt)?.[1] ?? images.length)
        return JSON.stringify({ candidates: Array.from({ length: n }, (_, i) => ({ index: i + 1, overall: i === 1 ? 9.5 : 6, brief: 8, readability: 8, consistency: 7, clean: 8, summary: `candidate ${i + 1}`, changes: ['thicker outline'], look: { stroke: 'chunky dark outline', corners: 'pill corners', shading: 'glossy top light', typography: 'bubble letters' } })) })
      }
      if (system.includes('STYLE')) return JSON.stringify({ composition: 'centred', framing: 'close-up', palette: ['#ff8800'], saturation: 'vivid', outline: true, rimLight: true, glow: false, text: { present: false }, emotion: 'joy', focalContrast: 8, clutter: 2, notes: '' })
      return JSON.stringify({ overall: 7, summary: 'thumb critic', textWords: 0, changes: ['Bigger subject'], copyFlags: [], principles: [] })
    }
  }
  const settings = settingsStore()
  const svc = new ThumbService({
    userDir: join(dir, 'user'),
    projectRoot: () => root,
    gameName: () => 'Pet Paradise',
    settings,
    openAiKey: async () => (o.key === undefined ? 'sk-test' : o.key),
    imageSettings: () => ({ model: 'x', quality: 'high', dailyCapUsd: o.cap ?? 50, ...(o.codex ? { backend: 'codex' as const } : {}) }),
    codexImages: o.codex,
    artSpentToday: async () => 0,
    robloxKey: async () => 'rbx-key',
    creator: () => ({ userId: 7 }),
    vision,
    chargeImage: (usd) => (charged += usd),
    memory: { remember: async (m) => void memory.push({ name: m.name, body: m.body }) },
    fetch: http.fetch,
    sleep: async () => undefined,
    emit: (event, payload) => events.push({ event, payload })
  })
  return { svc, http, visionCalls, memory, events, charged: () => charged }
}

const pngOf = (dataUrl: string | null) => decodePng(Buffer.from(dataUrl!.split(',')[1], 'base64'))

test('no image backend: the builder still works, generation says how to set one up', async () => {
  const dir = await tmp('none')
  const { svc, http } = makeService(dir, await tmp('proj'), { key: null, vision: 'none' })
  const built = await svc.buildPrompt({ ask: 'a green BUY button', mode: 'button' })
  assert.equal(built.by, 'rules')
  assert.match(built.prompt, /Roblox game UI asset \(button\) for the game "Pet Paradise"/)
  assert.match(built.prompt, /transparent background/)
  assert.deepEqual(built.warnings, [])
  assert.ok(built.notes.some((n) => /quote it: "BUY"/.test(n)), 'the caps label hint')
  const est = await svc.ui.estimate({ ask: 'x', kind: 'button' })
  assert.equal(est.n, 4)
  assert.equal(est.genSize, '1536x576')
  await assert.rejects(svc.ui.generate({ ask: 'a green BUY button', kind: 'button' }), (e: Error) => e.message === NO_BACKEND)
  await assert.rejects(svc.ui.generate({ ask: '', kind: 'button' }), /Describe the UI asset/)
  await assert.rejects(svc.ui.generate({ ask: 'a trophy', kind: 'icon-set' }), /at least two icons/)
  await assert.rejects(svc.generate({ brief: 'boss fight' }), /No OpenAI API key/)
  // The model toggle with no model: the rules, and a note saying so.
  const m = await svc.buildPrompt({ ask: 'a coin', mode: 'icon', model: true })
  assert.equal(m.by, 'rules')
  assert.ok(m.notes.some((n) => /No Labs model/.test(n)))
  assert.equal(http.calls.length, 0)
})

test('API backend: transparent request at the kind size, key-out, 9-slice, one ranking call, best = critic pick, spend', async () => {
  const dir = await tmp('api')
  const root = await tmp('proj')
  const { svc, http, visionCalls, events, charged } = makeService(dir, root, { vision: 'rank' })
  const est = await svc.ui.estimate({ ask: 'x', kind: 'button', n: 3 })
  const out = await svc.ui.generate({ ask: 'a green BUY button, glossy', kind: 'button', n: 3 })
  const call = http.calls.find((c) => c.url.endsWith('/images/generations'))!
  assert.ok(call, 'no kit yet: a plain generation')
  assert.equal(call.body.size, '1536x576')
  assert.equal(call.body.background, 'transparent')
  assert.equal(call.body.output_format, 'png')
  assert.equal(call.body.n, 3)
  assert.match(call.body.prompt, /9-slice friendly/)
  assert.match(call.body.prompt, /No text, letters or numbers/)
  assert.equal(out.assets.length, 3)
  assert.match(out.id, /^ua-[a-z0-9]+$/)
  for (const a of out.assets) {
    assert.equal(batchOf(a.id), out.id)
    assert.equal(a.keyed, true, 'the white background was keyed out')
    assert.equal(a.scope, 'project')
    const img = pngOf(await svc.file('ui', a.id))
    assert.equal(img.data[3], 0, 'transparent corner')
    assert.deepEqual([img.width, img.height], [a.width, a.height])
    assert.ok(a.checks.some((c) => c.id === 'ui-slice'))
    assert.equal(a.critique?.by, 'critic')
    assert.equal(a.look?.stroke, 'chunky dark outline')
    assert.equal(a.sections?.length, 10)
  }
  assert.ok(out.assets[0].slice, 'the wide button has a SliceCenter')
  assert.equal(out.bestId, out.assets[1].id, "the critic's pick wins")
  const rank = visionCalls.filter((c) => c.system.includes('UI art director'))
  assert.equal(rank.length, 1, 'one call ranks every candidate')
  assert.equal(rank[0].tier, 'cheap')
  assert.equal(rank[0].images, 3)
  assert.match(rank[0].prompt, /Measured in code, per candidate: #1 transparent 8/)
  assert.ok(Math.abs(charged() - est.totalUsd) < 1e-9, `${charged()} vs ${est.totalUsd}`)
  const st = await svc.status()
  assert.equal(st.counts.ui, 3)
  assert.ok(st.spentTodayUsd >= est.totalUsd - 1e-9, 'UI spend counts toward today')
  assert.ok(events.some((e) => e.event === 'thumbs:progress' && e.payload.done && e.payload.batchId === out.id))
  // The critic tier re-critiques one asset.
  const re = await svc.ui.critique(out.assets[0].id)
  assert.equal(re.id, out.id)
  assert.equal(visionCalls.at(-1)!.tier, 'critic')
})

test('ranking falls back to the code checks when the critic answers nonsense; opaque scenes stay opaque', async () => {
  const dir = await tmp('broken')
  const noisy = blank(300, 200)
  for (let i = 0; i < 300 * 200; i++) noisy.data.set([(i * 37) % 256, (i * 91) % 256, (i * 13) % 256, 255], i * 4)
  const { svc } = makeService(dir, await tmp('proj'), { vision: 'broken', images: () => [noisy] })
  const out = await svc.ui.generate({ ask: 'a panel', kind: 'panel', n: 2 })
  assert.ok(out.notes.some((n) => /code checks only/.test(n)))
  assert.ok(out.assets.every((a) => a.critique?.by === 'code'))
  const bg = out.assets[0].checks.find((c) => c.id === 'ui-bg')!
  assert.equal(bg.score, 2)
  assert.ok(bg.fix)
})

test('keep / +1 teach the kit: the next prompt carries its palette, look and reference images; memory', async () => {
  const dir = await tmp('kit')
  const root = await tmp('proj')
  const { svc, http, memory } = makeService(dir, root, { vision: 'rank' })
  const first = await svc.ui.generate({ ask: 'a green BUY button', kind: 'button', n: 2 })
  assert.equal((await svc.ui.kit()).samples, 0)
  await svc.ui.keep(first.assets[0].id, true)
  await svc.ui.rate(first.assets[1].id, 'up')
  await svc.ui.pin(first.assets[1].id, true)
  const kit = await svc.ui.kit('button')
  assert.equal(kit.samples, 2)
  assert.equal(kit.refIds[0], first.assets[1].id, 'pinned first')
  assert.equal(kit.look.stroke, 'chunky dark outline')
  assert.ok(memory.some((m) => m.name === 'ui-style-kit' && /chunky dark outline/.test(m.body)))
  const built = await svc.buildPrompt({ ask: 'a red CLOSE button', mode: 'button' })
  assert.match(sectionText(built.sections, 'palette'), new RegExp(kit.palette[0]))
  assert.match(sectionText(built.sections, 'style'), /chunky dark outline/)
  assert.equal(built.sections.find((s) => s.key === 'style')!.source, 'kit')
  assert.ok(built.notes.some((n) => /Your UI kit \(2 kept\)/.test(n)))
  assert.match(built.prompt, /The attached 2 images are UI from this game's kit/)
  http.calls.length = 0
  await svc.ui.generate({ ask: 'a red CLOSE button', kind: 'button', n: 1 })
  const edit = http.calls.find((c) => c.url.endsWith('/images/edits'))!
  assert.ok(edit, 'kit references make it an edit')
  assert.equal(edit.body.images.length, 2)
  assert.match(edit.body.images[0].image_url, /^data:image\/png;base64,/)
  assert.equal(edit.body.background, 'transparent')
  // Turning the kit off: a plain generation again.
  http.calls.length = 0
  await svc.ui.generate({ ask: 'a red CLOSE button', kind: 'button', n: 1, useKit: false })
  assert.ok(http.calls.some((c) => c.url.endsWith('/images/generations')))
  assert.equal(await svc.ui.remove(first.assets[0].id), true)
  assert.equal(await svc.ui.remove(first.assets[0].id), false)
})

test('icon set on the Codex backend: best first icon anchors every other icon; square 512 icons; no cost', async () => {
  const dir = await tmp('codex')
  const fc = fakeCodex(() => [coin(256), coin(200, [40, 200, 90])])
  const { svc, charged, visionCalls } = makeService(dir, await tmp('proj'), { codex: fc.codex, key: null, vision: 'rank' })
  const est = await svc.ui.estimate({ ask: 'coin, gem, heart', kind: 'icon-set', n: 6 })
  assert.equal(est.totalUsd, 0)
  assert.equal(est.model, 'codex-gpt-image-2')
  const out = await svc.ui.generate({ ask: 'coin, gem and heart icons in a glossy style', kind: 'icon-set', n: 6 })
  assert.equal(fc.calls.length, 3, 'candidates for the first icon, then one call per other icon')
  assert.equal(fc.calls[0].n, 4, 'Codex makes at most 4 per run')
  assert.equal(fc.calls[0].transparent, true)
  assert.equal(fc.calls[0].refs, 0)
  assert.match(fc.calls[0].prompt, /This icon: coin\./)
  assert.match(fc.calls[1].prompt, /This icon: gem\./)
  assert.match(fc.calls[1].prompt, /The first attached image is the first icon of this set/)
  assert.equal(fc.calls[1].refs, 1, 'the anchor goes in as the reference')
  assert.match(fc.calls[2].prompt, /This icon: heart\./)
  assert.equal(out.set?.length, 3)
  assert.equal(out.set![0], out.bestId)
  const byId = new Map(out.assets.map((a) => [a.id, a]))
  assert.deepEqual(out.set!.map((id) => byId.get(id)!.name), ['coin 2', 'gem', 'heart'])
  assert.deepEqual(out.set!.map((id) => byId.get(id)!.setIndex), [0, 1, 2])
  assert.deepEqual(byId.get(out.set![1])!.refIds, [out.bestId])
  for (const a of out.assets) {
    assert.deepEqual([a.width, a.height], [512, 512])
    assert.equal(a.model, 'codex-gpt-image-2')
    assert.equal(a.costUsd, 0)
    assert.equal(a.keyed, undefined, 'came back transparent')
  }
  assert.equal(charged(), 0)
  assert.ok(out.notes.some((n) => /Codex picks the image size/.test(n)))
  // Two ranking calls: the first-icon candidates, then the whole set for consistency.
  const ranks = visionCalls.filter((c) => c.system.includes('UI art director'))
  assert.equal(ranks.length, 2)
  assert.match(ranks[1].prompt, /matching icon set/)
  assert.equal(ranks[1].images, 3)
})

test('export into the project (SliceCenter Luau), upload through Open Cloud; no project = clear error', async () => {
  const dir = await tmp('export')
  const root = await tmp('proj')
  const { svc, http } = makeService(dir, root, { vision: 'none' })
  const out = await svc.ui.generate({ ask: 'a green BUY button', kind: 'button', n: 1 })
  const a = out.assets[0]
  const ex = await svc.ui.export(a.id)
  assert.match(ex.path, /^art\/ui\/buttons\/a-green-buy-button-1?\.png$|^art\/ui\/buttons\/green-buy-button\.png$/)
  assert.ok(existsSync(join(root, ex.path)))
  const png = decodePng(await readFile(join(root, ex.path)))
  assert.ok(png.width <= 1024 && png.height <= 1024)
  assert.match(ex.luau, /SliceCenter = Rect\.new\(\d+, \d+, \d+, \d+\)/)
  assert.match(ex.luau, /Upload to Roblox first/)
  const again = await svc.ui.export(a.id)
  assert.notEqual(again.path, ex.path, 'a second export does not overwrite the first')
  const up = await svc.ui.upload(a.id)
  assert.equal(up.roblox?.uri, 'rbxassetid://4321')
  assert.equal(http.calls.find((c) => c.url === 'https://apis.roblox.com/assets/v1/assets')!.headers['x-api-key'], 'rbx-key')
  assert.match((await svc.ui.export(a.id)).luau, /image\.Image = "rbxassetid:\/\/4321"/)
  const noProj = makeService(await tmp('np'), null, { vision: 'none' })
  const o2 = await noProj.svc.ui.generate({ ask: 'a coin', kind: 'icon', n: 1 })
  assert.equal(o2.assets[0].scope, 'user', 'without a project UI art goes to the user library')
  await assert.rejects(noProj.svc.ui.export(o2.assets[0].id), /Open the game project/)
})

test('builder: model expansion (cheap tier), failure falls back to rules, reference names scrubbed', async () => {
  const dir = await tmp('builder')
  const { svc, visionCalls } = makeService(dir, await tmp('proj'), { vision: 'rank' })
  const m = await svc.buildPrompt({ ask: 'a green BUY button', mode: 'button', model: true })
  assert.equal(m.by, 'model')
  assert.match(sectionText(m.sections, 'subject'), /emerald-green pill/)
  assert.equal(m.sections.find((s) => s.key === 'subject')!.source, 'model')
  assert.match(sectionText(m.sections, 'text'), /^No text/, 'the model may not add text the ask did not quote')
  assert.match(sectionText(m.sections, 'roblox'), /9-slice/)
  const exp = visionCalls.find((c) => c.system.includes('writing prompts'))!
  assert.equal(exp.tier, 'cheap')
  assert.equal(exp.images, 0)
  const failing = makeService(await tmp('builder2'), await tmp('proj'), { vision: 'expand-fails' })
  const f = await failing.svc.buildPrompt({ ask: 'a coin', mode: 'icon', model: true })
  assert.equal(f.by, 'rules')
  assert.ok(f.notes.some((n) => /could not expand it \(no provider signed in\)/.test(n)))
  // Reference game names never reach the builder's prompt.
  await svc.addRefs({ dataUrls: [`data:image/png;base64,${encodePng(coin(64)).toString('base64')}`], game: 'Blox Legends' })
  const s = await svc.buildPrompt({ ask: 'a hero like Blox Legends fighting a boss', mode: 'thumbnail' })
  assert.doesNotMatch(s.prompt, /legends/i)
  assert.ok(s.notes.some((n) => /Kept reference names out/.test(n)))
  const set = await svc.buildPrompt({ ask: 'coin, gem, key', mode: 'icon-set' })
  assert.deepEqual(set.names, ['coin', 'gem', 'key'])
  assert.match(set.prompt, /This icon: coin\./)
})

test('thumbnails: generated from builder sections (edited ones win), stored for refine; use as reference', async () => {
  const dir = await tmp('thumbs')
  const root = await tmp('proj')
  const big = blank(384, 256)
  for (let i = 0; i < 384 * 256; i++) big.data.set([i % 384 < 192 ? 250 : 20, 120, 40, 255], i * 4)
  const { svc, http } = makeService(dir, root, { vision: 'rank', images: () => [big] })
  const auto = await svc.generate({ brief: 'a noob escaping a giant shark, shocked', n: 1 })
  const req = http.calls.find((c) => c.url.endsWith('/images/generations'))!.body
  assert.match(req.prompt, /Subject: a noob escaping a giant shark, shocked\. Roblox avatars look shocked/)
  assert.match(req.prompt, /Roblox rules: One focal point/)
  assert.equal(auto.thumbs[0].sections?.length, 10)
  const built = await svc.buildPrompt({ ask: 'a noob escaping a giant shark', mode: 'thumbnail' })
  const edited = built.sections.map((s) => (s.key === 'lighting' ? { ...s, text: 'Sunset backlight with god rays', source: 'user' as const } : s))
  http.calls.length = 0
  const out = await svc.generate({ brief: 'a noob escaping a giant shark', sections: edited, n: 1 })
  const p = http.calls.find((c) => c.url.endsWith('/images/generations'))!.body.prompt
  assert.match(p, /Lighting: Sunset backlight with god rays/)
  assert.equal(out.thumbs[0].sections!.find((s) => s.key === 'lighting')!.source, 'user')
  http.calls.length = 0
  await svc.refine(out.thumbs[0].id, { rounds: 1 })
  assert.match(http.calls.find((c) => c.url.endsWith('/images/edits'))!.body.prompt, /Lighting: Sunset backlight with god rays/)
  const ref = await svc.useAsRef(out.thumbs[0].id)
  assert.equal(ref.scope, 'user')
  assert.deepEqual(ref.tags, ['own'])
  assert.equal(ref.game, undefined)
  assert.ok((await svc.refs()).some((r) => r.id === ref.id))
  assert.ok(pngOf(await svc.file('ref', ref.id)).width === 1920)
})

test('gating: UI generation is a lab run; keep / +1 / export / upload mark it kept', () => {
  const t = LAB_HANDLERS.thumbs
  assert.equal(t.runs.thumbUiGenerate, 'result')
  assert.deepEqual(t.kept.thumbUiRate(['ua-abcd12-3', 'up']), { id: 'ua-abcd12', kept: true })
  assert.deepEqual(t.kept.thumbUiRate(['ua-abcd12-3', 'down']), { id: 'ua-abcd12', kept: false })
  assert.equal(t.kept.thumbUiKeep(['ua-abcd12-3', false]), null)
  assert.deepEqual(t.kept.thumbUiExport(['ua-abcd12-3']), { id: 'ua-abcd12', kept: true })
  assert.deepEqual(t.kept.thumbUiUpload(['ua-abcd12-3']), { id: 'ua-abcd12', kept: true })
})

test('budget: an over-cap UI batch is refused before any call', async () => {
  const dir = await tmp('cap')
  const { svc, http } = makeService(dir, await tmp('proj'), { cap: 0.01, vision: 'none' })
  await assert.rejects(svc.ui.generate({ ask: 'a coin', kind: 'icon', n: 4 }), /today's image budget/)
  assert.equal(http.calls.length, 0)
})
