// "Split into layers" (services/art/layers.ts, shared/artLayers.ts) with fake backends: the vision
// proposal, generation on the Images API and on Codex (the concept as the reference image), the
// budget, layers.json, Import all to Roblox, the theme snippet and the agent tools.
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'
import { ArtService } from '../src/main/services/art/service.ts'
import { artTools, ART_TOOL_NAMES } from '../src/main/services/art/tools.ts'
import { createArtWiring } from '../src/main/services/art/wire.ts'
import { MemorySecretStore, projectScope } from '../src/main/services/release/secrets.ts'
import { SERVICE_WRITE_TOOLS } from '../src/main/agent/serviceTools.ts'
import { decodePng, encodePng } from '../src/main/services/vfx/textures/png.ts'
import type { CodexImages } from '../src/main/services/art/imageBackend.ts'
import {
  conceptLayerName,
  defaultLayerSize,
  layerKind,
  layerPrompt,
  layerProposalPrompt,
  LAYER_SYSTEM,
  MAX_LAYERS,
  normalizeLayerSpecs,
  parseLayerProposal,
  themeSnippet
} from '../src/shared/artLayers.ts'

const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=='
const PNG = Buffer.from(PNG_B64, 'base64')
const DAY = '2026-10-13'
const CONCEPT = `art/concepts/${DAY}/football-main-menu-1.png`

interface Call {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}
type Reply = { status: number; body?: string }

function fakeFetch(reply: (call: Call, i: number) => Reply): { fetch: ArtFetch; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const fetch: ArtFetch = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body }
    calls.push(call)
    const r = reply(call, i++)
    return { status: r.status, ok: r.status >= 200 && r.status < 300, headers: { get: () => null }, text: async () => r.body ?? '' }
  }
  return { fetch, calls }
}

const imagesReply: Reply = { status: 200, body: JSON.stringify({ created: 1, output_format: 'png', size: '1024x1024', quality: 'high', data: [{ b64_json: PNG_B64 }] }) }

// OpenAI edits + Open Cloud upload (create, then a finished operation) on one fake.
function backend() {
  let asset = 900
  return fakeFetch((call) => {
    if (call.url.includes('api.openai.com')) return imagesReply
    if (call.url.endsWith('/assets/v1/assets')) return { status: 200, body: JSON.stringify({ path: `operations/op-${++asset}`, done: false }) }
    const id = /op-(\d+)/.exec(call.url)?.[1] ?? '1'
    return { status: 200, body: JSON.stringify({ done: true, response: { assetId: `77${id}`, moderationResult: { moderationState: 'MODERATION_STATE_APPROVED' } } }) }
  })
}

class MemSettings {
  data = new Map<string, unknown>()
  get<T>(k: string, f: T): T {
    return this.data.has(k) ? (this.data.get(k) as T) : f
  }
  set(k: string, v: unknown) {
    this.data.set(k, v)
  }
}

async function project() {
  const root = await mkdtemp(join(tmpdir(), 'forge-layers-'))
  const user = await mkdtemp(join(tmpdir(), 'forge-layers-user-'))
  const dir = join(root, 'art', 'concepts', DAY)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'football-main-menu-1.png'), PNG)
  await writeFile(
    join(dir, 'football-main-menu-1.json'),
    JSON.stringify({ path: CONCEPT, date: DAY, slug: 'football-main-menu', index: 1, prompt: 'Football game main menu, stadium tunnel, striker, headline, nav tabs, three cards', fullPrompt: '', style: 'none', model: 'gpt-image-2.5-flare', size: '1536x1024', quality: 'high', background: 'opaque', outputFormat: 'png', mode: 'generate', seed: null, costUsd: 0.04, createdAt: `${DAY}T09:00:00.000Z`, bytes: PNG.length, width: 1536, height: 1024, source: 'page' })
  )
  return { root, user, cleanup: async () => (await rm(root, { recursive: true, force: true }), await rm(user, { recursive: true, force: true })) }
}

function service(root: string, user: string, fetch: ArtFetch, extra: Partial<ConstructorParameters<typeof ArtService>[0]> = {}) {
  const progress: { stage: string; detail?: string }[] = []
  const svc = new ArtService({
    root: () => root,
    scope: projectScope,
    settings: new MemSettings(),
    openAiKey: async () => 'sk-test-openai',
    robloxKey: async () => ({ key: 'roblox-open-cloud-key-xxxxxxxx', source: 'art' }),
    fetch,
    sleep: async () => undefined,
    now: () => new Date(2026, 9, 13, 12, 0, 0).getTime(),
    trashDir: join(user, 'trash'),
    minIntervalMs: 0,
    onProgress: (p) => void progress.push(p),
    ...extra
  })
  return { svc, progress }
}

const VISION_ANSWER = '```json\n' + JSON.stringify({
  layers: [
    { name: 'quick join card', kind: 'panel texture', prompt: 'Green Quick Join card background with pitch lines, no text', transparent: true },
    { name: 'Background', kind: 'background plate', prompt: 'Stadium tunnel, floodlights, all UI and the striker removed', transparent: false },
    { name: 'GameLogo', kind: 'logo', prompt: 'Shield logo with a ball' },
    { name: 'Striker', kind: 'character', prompt: 'The striker in the red kit, full figure' }
  ]
}) + '\n```'

// ---------------------------------------------------------------- shared helpers

test('shared: proposal parsing, kinds, names, sizes and the per-layer prompt', () => {
  const raw = parseLayerProposal(`Here you go:\n${VISION_ANSWER}`)
  assert.ok(raw)
  const specs = normalizeLayerSpecs(raw, { width: 1536, height: 1024 })
  assert.deepEqual(specs.map((s) => [s.name, s.kind, s.transparent, s.size]), [
    ['QuickJoinCard', 'panel', true, '1024x1536'],
    ['Background', 'background', false, '1536x1024'],
    ['GameLogo', 'logo', true, '1024x1024'],
    ['Striker', 'character', true, '1024x1536']
  ])
  // A bare array, duplicate names, unknown kinds by name, and the cap.
  assert.deepEqual(normalizeLayerSpecs([{ name: 'Icon', prompt: 'a' }, { name: 'Icon', prompt: 'b', kind: 'icon' }]).map((s) => s.name), ['Icon', 'Icon2'])
  assert.equal(normalizeLayerSpecs(Array.from({ length: 30 }, (_, i) => ({ name: `L${i}`, kind: 'icon', prompt: 'x' }))).length, MAX_LAYERS)
  assert.equal(parseLayerProposal('no json here'), null)
  assert.equal(layerKind('panel'), 'panel')
  assert.equal(layerKind('card background'), 'panel')
  assert.equal(defaultLayerSize('background', { width: 1024, height: 1536 }), '1024x1536')
  assert.equal(conceptLayerName('football-main-menu', 1), 'FootballMainMenu')
  assert.equal(conceptLayerName('football-main-menu', 2), 'FootballMainMenu2')
  const p = layerPrompt(specs[1])
  assert.match(p, /remove ALL UI, text/)
  assert.match(p, /Match the reference image exactly/)
  assert.doesNotMatch(p, /Fully transparent/)
  assert.match(layerPrompt(specs[0]), /Fully transparent background/)
  assert.match(LAYER_SYSTEM, /NEVER image layers/)
  assert.match(layerProposalPrompt({ width: 1536, height: 1024 }), /1536x1024/)
})

test('shared: theme snippet lists imported layers only, in order', () => {
  assert.equal(themeSnippet(null), '{}')
  const layers = [
    { name: 'Background', uri: 'rbxassetid://1' },
    { name: 'RankedCard' },
    { name: 'QuickJoinCard', uri: 'rbxassetid://2' }
  ] as never
  assert.equal(themeSnippet({ layers }), '{\n\tBackground = "rbxassetid://1",\n\tQuickJoinCard = "rbxassetid://2",\n}')
})

// ---------------------------------------------------------------- propose

test('propose: the vision model sees the concept; background first; fallbacks without vision', async () => {
  const t = await project()
  try {
    const seen: { system: string; prompt: string; images: { mime: string; base64: string }[] }[] = []
    const { svc } = service(t.root, t.user, backend().fetch, { vision: async (system, prompt, images) => (seen.push({ system, prompt, images }), VISION_ANSWER) })
    const p = await svc.layers.propose(CONCEPT)
    assert.equal(p.source, 'vision')
    assert.equal(p.name, 'FootballMainMenu')
    assert.deepEqual(p.layers.map((l) => l.name), ['Background', 'QuickJoinCard', 'GameLogo', 'Striker'])
    assert.equal(seen.length, 1)
    assert.equal(seen[0].system, LAYER_SYSTEM)
    assert.match(seen[0].prompt, /stadium tunnel/)
    assert.deepEqual(seen[0].images, [{ mime: 'image/png', base64: PNG_B64 }])

    // No vision model: a starter list with a note. A failing model: the same, with its error.
    const none = service(t.root, t.user, backend().fetch).svc
    const d = await none.layers.propose(CONCEPT)
    assert.equal(d.source, 'default')
    assert.equal(d.layers[0].kind, 'background')
    assert.match(d.note ?? '', /No vision model/)
    const broken = service(t.root, t.user, backend().fetch, { vision: async () => Promise.reject(new Error('model down')) }).svc
    assert.match((await broken.layers.propose(CONCEPT)).note ?? '', /model down/)
    // An answer with no background gets one.
    const nobg = service(t.root, t.user, backend().fetch, { vision: async () => '{"layers":[{"name":"ShopIcon","kind":"icon","prompt":"bag icon"}]}' }).svc
    assert.deepEqual((await nobg.layers.propose(CONCEPT)).layers.map((l) => l.kind), ['background', 'icon'])
    await assert.rejects(svc.layers.propose('art/concepts/nope.png'), /does not exist/)
    await assert.rejects(svc.layers.propose('../outside.png'), /not an art file/)
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- generate

test('generate (API): one edit per layer with the concept as reference, files + layers.json, spend counted', async () => {
  const t = await project()
  try {
    const { fetch, calls } = backend()
    const { svc } = service(t.root, t.user, fetch)
    const layers = normalizeLayerSpecs(parseLayerProposal(VISION_ANSWER), { width: 1536, height: 1024 })
    const est = await svc.layers.estimate({ concept: CONCEPT, layers })
    assert.equal(est.layers.length, 4)
    assert.ok(est.totalUsd > 0)
    assert.equal(est.overCap, false)
    assert.equal(est.dailyCapUsd, 5)
    const before = await svc.spentToday()

    const m = await svc.layers.generate({ concept: CONCEPT, layers })
    assert.equal(m.name, 'FootballMainMenu')
    assert.equal(m.concept, CONCEPT)
    assert.equal(calls.length, 4)
    for (const c of calls) {
      assert.equal(c.url, 'https://api.openai.com/v1/images/edits')
      const body = JSON.parse(String(c.body))
      assert.deepEqual(body.images, [{ image_url: `data:image/png;base64,${PNG_B64}` }])
      assert.equal(body.n, 1)
    }
    const bodies = calls.map((c) => JSON.parse(String(c.body)))
    assert.equal(bodies[0].background, 'transparent')
    assert.equal('background' in bodies[1], false)
    assert.equal(bodies[1].size, '1536x1024')
    assert.match(bodies[1].prompt, /Asset layer "Background"/)

    const saved = JSON.parse(await readFile(join(t.root, 'art/ui/FootballMainMenu/layers/layers.json'), 'utf8'))
    assert.deepEqual(saved.layers.map((l: { name: string; kind: string; file: string; size: string }) => [l.name, l.kind, l.file, l.size]), [
      ['QuickJoinCard', 'panel', 'art/ui/FootballMainMenu/layers/QuickJoinCard.png', '1x1'],
      ['Background', 'background', 'art/ui/FootballMainMenu/layers/Background.png', '1x1'],
      ['GameLogo', 'logo', 'art/ui/FootballMainMenu/layers/GameLogo.png', '1x1'],
      ['Striker', 'character', 'art/ui/FootballMainMenu/layers/Striker.png', '1x1']
    ])
    assert.ok(saved.layers.every((l: { prompt: string }) => l.prompt.length > 5))
    assert.ok((await stat(join(t.root, 'art/ui/FootballMainMenu/layers/Background.png'))).isFile())
    assert.ok(Math.abs((await svc.spentToday()) - (before + est.totalUsd)) < 0.001)
    // Found by concept path or by name; the concept stays out of the gallery's layers.
    assert.equal((await svc.layers.get(CONCEPT))?.name, 'FootballMainMenu')
    assert.equal((await svc.layers.get('FootballMainMenu'))?.layers.length, 4)
    assert.equal((await svc.list()).length, 1)

    // Regenerating one layer replaces it and keeps the others; spend keeps adding up.
    await svc.layers.generate({ concept: CONCEPT, layers: [layers[2]] })
    assert.equal((await svc.layers.get(CONCEPT))?.layers.length, 4)
    assert.ok((await svc.spentToday()) > before + est.totalUsd)
    // The name of another concept's set is refused.
    await writeFile(join(t.root, `art/concepts/${DAY}/other-1.png`), PNG)
    await assert.rejects(svc.layers.generate({ concept: `art/concepts/${DAY}/other-1.png`, name: 'FootballMainMenu', layers }), /already holds the layers/)
    await assert.rejects(svc.layers.generate({ concept: CONCEPT, layers: [] }), /at least one layer/)
  } finally {
    await t.cleanup()
  }
})

test('generate: the daily budget is checked up front for the whole set', async () => {
  const t = await project()
  try {
    const { fetch, calls } = backend()
    const { svc } = service(t.root, t.user, fetch)
    await svc.setSettings({ dailyCapUsd: 0.05, quality: 'max' })
    const layers = normalizeLayerSpecs(parseLayerProposal(VISION_ANSWER))
    const est = await svc.layers.estimate({ concept: CONCEPT, layers })
    assert.equal(est.overCap, true)
    await assert.rejects(svc.layers.generate({ concept: CONCEPT, layers }), /pass today's art budget/)
    assert.equal(calls.length, 0)
  } finally {
    await t.cleanup()
  }
})

test('generate (Codex): references go to Codex, no cost, opaque transparent layers are keyed out', async () => {
  const t = await project()
  try {
    // A white field with a red block: what an image model returns when it ignores transparency.
    const w = 32
    const data = new Uint8ClampedArray(w * w * 4)
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data.set(x > 8 && x < 24 && y > 8 && y < 24 ? [220, 30, 30, 255] : [255, 255, 255, 255], (y * w + x) * 4)
    const opaque = encodePng({ width: w, height: w, data })
    const reqs: { prompt: string; n: number; transparent?: boolean; references?: unknown[] }[] = []
    const codex: CodexImages = {
      status: async () => ({ ready: true, detail: 'signed in' }),
      generate: async (req) => (reqs.push(req), { images: [opaque], notes: [] })
    }
    const { fetch, calls } = backend()
    const { svc } = service(t.root, t.user, fetch, { codex, openAiKey: async () => null })
    await svc.setSettings({ backend: 'codex' })
    const est = await svc.layers.estimate({ concept: CONCEPT, layers: [{ name: 'Logo', kind: 'logo', prompt: 'the logo', transparent: true }] })
    assert.equal(est.totalUsd, 0)
    assert.equal(est.dailyCapUsd, 0)
    const m = await svc.layers.generate({ concept: CONCEPT, layers: [{ name: 'Logo', kind: 'logo', prompt: 'the logo', transparent: true }, { name: 'Background', kind: 'background', prompt: 'the plate', transparent: false }] })
    assert.equal(calls.length, 0)
    assert.equal(reqs.length, 2)
    assert.deepEqual(reqs[0].references, [`data:image/png;base64,${PNG_B64}`])
    assert.equal(reqs[0].n, 1)
    assert.equal(m.layers[0].model, 'codex-gpt-image-2')
    assert.equal(m.layers[0].costUsd, 0)
    const logo = decodePng(await readFile(join(t.root, m.layers[0].file)))
    assert.equal(logo.data[3], 0, 'the logo corner should be keyed out')
    const plate = decodePng(await readFile(join(t.root, m.layers[1].file)))
    assert.equal(plate.data[3], 255, 'the opaque background plate is kept as is')
  } finally {
    await t.cleanup()
  }
})

test('generate: a failing layer keeps the ones already made and says which failed', async () => {
  const t = await project()
  try {
    let n = 0
    const { fetch } = fakeFetch(() => (++n === 2 ? { status: 400, body: '{"error":{"message":"bad prompt"}}' } : imagesReply))
    const { svc } = service(t.root, t.user, fetch)
    const layers = normalizeLayerSpecs(parseLayerProposal(VISION_ANSWER))
    await assert.rejects(svc.layers.generate({ concept: CONCEPT, layers }), /Layer Background failed: .*bad prompt.*1 of 4 layers saved: QuickJoinCard/)
    assert.deepEqual((await svc.layers.get(CONCEPT))?.layers.map((l) => l.name), ['QuickJoinCard'])
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- import

test('import all: uploads each layer once, records ids in layers.json, never sends the key elsewhere', async () => {
  const t = await project()
  try {
    const { fetch, calls } = backend()
    const { svc } = service(t.root, t.user, fetch)
    const layers = normalizeLayerSpecs(parseLayerProposal(VISION_ANSWER)).slice(0, 2)
    await svc.layers.generate({ concept: CONCEPT, layers })
    await assert.rejects(svc.layers.importAll('FootballMainMenu'), /creator/i)
    await svc.setSettings({ creatorUserId: 42 })
    calls.length = 0
    const r = await svc.layers.importAll('FootballMainMenu')
    assert.deepEqual(r.imported, ['QuickJoinCard', 'Background'])
    assert.deepEqual(r.failed, [])
    const uploads = calls.filter((c) => c.url.endsWith('/assets/v1/assets'))
    assert.equal(uploads.length, 2)
    assert.match(Buffer.from(uploads[0].body as Uint8Array).toString('latin1'), /"displayName":"FootballMainMenuQuickJoinCard"/)
    for (const c of calls) {
      if (c.url.includes('apis.roblox.com')) assert.equal(c.headers?.['x-api-key'], 'roblox-open-cloud-key-xxxxxxxx')
      else assert.ok(!JSON.stringify(c).includes('roblox-open-cloud-key'))
    }
    const saved = JSON.parse(await readFile(join(t.root, 'art/ui/FootballMainMenu/layers/layers.json'), 'utf8'))
    assert.ok(saved.layers.every((l: { assetId?: string; uri?: string }) => l.assetId && l.uri === `rbxassetid://${l.assetId}`))
    assert.ok(!JSON.stringify(saved).includes('roblox-open-cloud-key'))
    assert.match(themeSnippet(saved), /QuickJoinCard = "rbxassetid:\/\/77\d+"/)
    // Already imported: nothing to do unless forced.
    calls.length = 0
    assert.deepEqual((await svc.layers.importAll('FootballMainMenu')).imported, [])
    assert.equal(calls.length, 0)
    assert.equal((await svc.layers.importAll('FootballMainMenu', { force: true })).imported.length, 2)
    await assert.rejects(svc.layers.importAll('Nope'), /No layers for Nope/)
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- agent tools and wiring

test('tools: art_split_layers proposes, generates and imports; art_layers_get reads the ids', async () => {
  const t = await project()
  try {
    const { fetch } = backend()
    const { svc } = service(t.root, t.user, fetch, { vision: async () => VISION_ANSWER })
    await svc.setSettings({ creatorUserId: 42 })
    const tools = artTools({ service: svc })
    assert.deepEqual(tools.map((x) => x.name), [...ART_TOOL_NAMES])
    for (const name of ['art_split_layers', 'art_layers_get']) assert.ok((SERVICE_WRITE_TOOLS as readonly string[]).includes(name))
    const split = tools.find((x) => x.name === 'art_split_layers')!
    const get = tools.find((x) => x.name === 'art_layers_get')!
    const schema = z.object(split.inputSchema)
    assert.equal(schema.safeParse({ concept: CONCEPT, action: 'propose' }).success, true)
    assert.equal(schema.safeParse({ concept: CONCEPT, action: 'cut' }).success, false)
    assert.equal(schema.safeParse({ concept: CONCEPT, action: 'generate', layers: [{ name: 'X', kind: 'button', prompt: 'abc' }] }).success, false)

    const proposed = await split.handler({ concept: CONCEPT, action: 'propose' }, undefined)
    assert.equal(proposed.isError, undefined)
    assert.match(proposed.content[0].text, /^proposed 4 layers for .* as FootballMainMenu; cost about \$/)
    assert.match(proposed.content[0].text, /"name": "QuickJoinCard"/)
    assert.equal(await svc.layers.get(CONCEPT), null)

    const made = await split.handler({ concept: CONCEPT, action: 'generate', layers: [{ name: 'Background', kind: 'background', prompt: 'the plate' }, { name: 'RankedCard', kind: 'panel', prompt: 'gold card' }], import: true }, undefined)
    assert.equal(made.isError, undefined, made.content[0].text)
    assert.match(made.content[0].text, /imported 2/)
    assert.match(made.content[0].text, /RankedCard \[panel, transparent\] art\/ui\/FootballMainMenu\/layers\/RankedCard\.png/)

    const read = await get.handler({ concept: 'FootballMainMenu' }, undefined)
    assert.match(read.content[0].text, /Theme \(Luau\): \{\n\tBackground = "rbxassetid:\/\/\d+",\n\tRankedCard = "rbxassetid:\/\/\d+",\n\}/)
    assert.match((await get.handler({}, undefined)).content[0].text, /FootballMainMenu: 2 layers/)
    assert.equal((await get.handler({ concept: 'Nope' }, undefined)).isError, true)
  } finally {
    await t.cleanup()
  }
})

test('wiring: the vision model reaches the layer proposal; layer handlers exist and return no key', async () => {
  const t = await project()
  try {
    const secrets = new MemorySecretStore()
    await secrets.set('art.openCloudApiKey', 'roblox-open-cloud-key-xxxxxxxx')
    const w = createArtWiring({
      root: () => t.root,
      settings: new MemSettings(),
      secrets,
      userDataDir: t.user,
      openAiKey: async () => 'sk-test-openai',
      emit: () => undefined,
      fetch: backend().fetch,
      sleep: async () => undefined,
      vision: async () => VISION_ANSWER
    })
    for (const h of ['artLayersPropose', 'artLayersEstimate', 'artLayersGenerate', 'artLayersGet', 'artLayersImport']) assert.equal(typeof w.handlers[h], 'function', h)
    const p = (await w.handlers.artLayersPropose(CONCEPT)) as { source: string; layers: unknown[] }
    assert.equal(p.source, 'vision')
    const m = await w.handlers.artLayersGenerate({ concept: CONCEPT, layers: p.layers.slice(0, 1) })
    assert.ok(!JSON.stringify(m).includes('roblox-open-cloud-key'))
    assert.ok(!JSON.stringify(m).includes('sk-test-openai'))
    assert.equal(await w.handlers.artLayersGet('Missing'), null)
  } finally {
    await t.cleanup()
  }
})
