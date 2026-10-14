// VFX texture import and reuse first: flipbook detection (names and gutters) and the repack into
// Roblox grids, asset-id parsing, de-duplication, image analysis on small synthetic images, the
// Studio harvest job and its messages, the reuse-first selection policy and its setting, and the
// importer end to end (PNG files and folders, asset ids with a fake thumbnails API).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { blank, flipbookCell, imageStats, type Rgba } from '../src/shared/vfx/tex/image.ts'
import { analyzeTexture, autoTags, colorName } from '../src/shared/vfx/tex/analyze.ts'
import { detectGrid, flipbookFromName, importName, kindFromPath, markDuplicates, parseAssetIds, parseVisionTags, planFlipbook, prepareImport } from '../src/shared/vfx/tex/import.ts'
import { applyTexturePolicy, generationAllowed, libraryPromptLines, nodeWant, normalizePolicy, pickLibraryTexture, roleTextures, scoreTexture, DEFAULT_TEXTURE_POLICY, TEXTURE_POLICY_SETTING } from '../src/shared/vfx/tex/reuse.ts'
import { collectHarvest, harvestCandidates, harvestFromTree, harvestJob, harvestModuleSource, HARVEST_TAG } from '../src/shared/vfx/tex/harvest.ts'
import { BUILTIN_SMOKE, BUILTIN_SPARKLES, genRef, texRef, type VfxTexture } from '../src/shared/vfx/tex/textures.ts'
import { generateProcedural } from '../src/shared/vfx/tex/procedural.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'
import { encodePng } from '../src/main/services/vfx/textures/png.ts'
import { TextureService } from '../src/main/services/vfx/textures/service.ts'
import { textureTools } from '../src/main/services/vfx/textures/tools.ts'
import { createVfxWiring } from '../src/main/services/vfx/wire.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-teximp-${p}-`))

// ---------------------------------------------------------------- synthetic images

function draw(w: number, h: number, fn: (u: number, v: number, x: number, y: number) => [number, number, number, number] | number): Rgba {
  const img = blank(w, h)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = fn((x + 0.5) / w, (y + 0.5) / h, x, y)
      const [cr, cg, cb, a] = typeof r === 'number' ? [255, 255, 255, r] : r
      const i = (y * w + x) * 4
      img.data[i] = cr
      img.data[i + 1] = cg
      img.data[i + 2] = cb
      img.data[i + 3] = Math.max(0, Math.min(255, Math.round(a)))
    }
  }
  return img
}

const glowImg = (s = 64) => draw(s, s, (u, v) => 255 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.02))
const ringImg = (s = 64) => draw(s, s, (u, v) => (Math.abs(Math.hypot(u - 0.5, v - 0.5) - 0.32) < 0.035 ? 255 : 0))
const sparkImg = (s = 64) => draw(s, s, (u, v) => (Math.abs(u - 0.5) < 0.03 && Math.abs(v - 0.5) < 0.4 ? 255 : 0))
const beamImg = (s = 64) => draw(s, s, (_u, v) => 255 * Math.max(0, 1 - Math.abs(v - 0.5) / 0.2))
const trailImg = (s = 64) => draw(s, s, (u, v) => 255 * (1 - u) * Math.max(0, 1 - Math.abs(v - 0.5) / 0.2))
function noiseImg(s = 64): Rgba {
  let seed = 7
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff)
  return draw(s, s, () => 60 + rnd() * 195)
}
const starImg = (s = 64) =>
  draw(s, s, (u, v) => {
    const dx = u - 0.5
    const dy = v - 0.5
    const r = Math.hypot(dx, dy)
    const core = r < 0.08 ? 255 : 0
    const ray = (Math.abs(dx) < 0.025 || Math.abs(dy) < 0.025) && r < 0.45 ? 230 : 0
    return Math.max(core, ray)
  })
const redGlow = () => draw(64, 64, (u, v) => [255, 40, 30, 255 * Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.02)])

// A cols x rows sheet of glows with transparent gutters.
function sheet(cols: number, rows: number, cell = 32, frames = cols * rows): Rgba {
  return draw(cols * cell, rows * cell, (_u, _v, x, y) => {
    const k = Math.floor(y / cell) * cols + Math.floor(x / cell)
    if (k >= frames) return 0
    const cx = (x % cell) + 0.5 - cell / 2
    const cy = (y % cell) + 0.5 - cell / 2
    const r = Math.hypot(cx, cy) / (cell / 2)
    return r < 0.75 ? 255 * (1 - r / 0.75) * (0.4 + (0.6 * (k + 1)) / frames) : 0
  })
}

// ---------------------------------------------------------------- flipbooks

test('flipbook hints from file names', () => {
  assert.deepEqual(flipbookFromName('smoke_4x4.png'), { cols: 4, rows: 4, frames: 16 })
  assert.deepEqual(flipbookFromName('Explosion Grid8x8.png'), { cols: 8, rows: 8, frames: 64 })
  assert.deepEqual(flipbookFromName('fire 5×5'), { cols: 5, rows: 5, frames: 25 })
  assert.deepEqual(flipbookFromName('spark_8f.png'), { frames: 8 })
  assert.deepEqual(flipbookFromName('dust-16frames.png'), { frames: 16 })
  assert.deepEqual(flipbookFromName('flash_32fr.jpg'), { frames: 32 })
  // Resolutions, versions and single sprites are not grids.
  assert.equal(flipbookFromName('glow_512x512.png'), null)
  assert.equal(flipbookFromName('ring_v2.png'), null)
  assert.equal(flipbookFromName('star.png'), null)
  assert.equal(flipbookFromName('wisp_1x1.png'), null)
})

test('grid detection finds gutters, not single sprites', () => {
  assert.deepEqual(detectGrid(sheet(4, 4)), { cols: 4, rows: 4, frames: 16 })
  assert.deepEqual(detectGrid(sheet(2, 2, 48)), { cols: 2, rows: 2, frames: 4 })
  assert.deepEqual(detectGrid(sheet(3, 3)), { cols: 3, rows: 3, frames: 9 })
  // A partly filled sheet: frames up to the last non-empty cell.
  assert.deepEqual(detectGrid(sheet(4, 4, 32, 13)), { cols: 4, rows: 4, frames: 13 })
  // A 4x2 strip.
  assert.deepEqual(detectGrid(sheet(4, 2)), { cols: 4, rows: 2, frames: 8 })
  for (const img of [glowImg(), ringImg(), sparkImg(), starImg(), noiseImg(), beamImg()]) assert.equal(detectGrid(img), null)
})

test('flipbook plans: native grids stay, others are repacked into a Roblox layout', () => {
  const native = planFlipbook(sheet(4, 4), 'whatever.png')!
  assert.equal(native.layout, 'Grid4x4')
  assert.equal(native.native, true)
  assert.equal(native.source, 'grid')
  const out = prepareImport(sheet(4, 4), native)
  assert.equal(out.image.width, 128)
  assert.deepEqual(out.flipbook, { layout: 'Grid4x4', frames: 16 })
  // Name and grid agree.
  assert.equal(planFlipbook(sheet(4, 4), 'smoke_4x4.png')!.source, 'name+grid')
  // 3x3 -> Grid4x4 with every cell filled (time-resampled), size a multiple of 4.
  const p3 = planFlipbook(sheet(3, 3), 'a.png')!
  assert.equal(p3.native, false)
  assert.equal(p3.layout, 'Grid4x4')
  const r3 = prepareImport(sheet(3, 3), p3)
  assert.equal(r3.image.width % 4, 0)
  assert.equal(r3.image.width, r3.image.height)
  for (let k = 0; k < 16; k++) assert.ok(imageStats(flipbookCell(r3.image, 'Grid4x4', k)).coverage > 0.05, `cell ${k} filled`)
  assert.match(r3.notes.join(' '), /repacked as Grid4x4/)
  // Frames from the name only, no gutters: grid from the aspect (8 frames on 2:1 = 4x2).
  const noGutter = draw(256, 128, (u) => 255 * u)
  const p8 = planFlipbook(noGutter, 'swoosh_8f.png', null)!
  assert.deepEqual([p8.cols, p8.rows, p8.frames, p8.layout], [4, 2, 8, 'Grid4x4'])
  // Single sprites: padded square, power of two.
  assert.equal(planFlipbook(glowImg(), 'glow.png'), null)
  const single = prepareImport(draw(100, 60, (u, v) => (Math.hypot(u - 0.5, v - 0.5) < 0.3 ? 255 : 0)), null)
  assert.equal(single.image.width, single.image.height)
  assert.equal(single.image.width, 128)
  // Opaque art on black gets alpha from brightness.
  const opaque = draw(32, 32, (u, v) => [Math.hypot(u - 0.5, v - 0.5) < 0.25 ? 255 : 0, Math.hypot(u - 0.5, v - 0.5) < 0.25 ? 200 : 0, 0, 255])
  const o = prepareImport(opaque, null)
  assert.equal(o.image.data[3], 0, 'corner transparent')
  assert.ok(o.image.data[(16 * 32 + 16) * 4 + 3] > 200, 'centre visible')
  assert.match(o.notes.join(' '), /alpha made from brightness/)
})

// ---------------------------------------------------------------- names, ids, dedupe

test('import names and kinds from paths', () => {
  assert.equal(importName('pack/T_Smoke_Puff_04.png'), 'Smoke Puff 04')
  assert.equal(importName('C:\\fx\\explosionGrid_8x8.png'), 'Explosion')
  assert.equal(importName('spark_8f.png'), 'Spark')
  assert.equal(kindFromPath('pack/Smoke/puff_01.png'), 'smoke')
  assert.equal(kindFromPath('pack/rings/a.png'), 'ring')
  assert.equal(kindFromPath('pack/misc/a.png'), null)
})

test('asset ids from pasted text', () => {
  const text = `rbxassetid://1234567
  https://create.roblox.com/store/asset/987654321/Fire-Sparks
  https://www.roblox.com/library/55555555/Smoke
  http://www.roblox.com/asset/?id=24242424
  https://www.roblox.com/catalog/77777777/x
  99999999, 1234567 (dupe)  4x4 1080 v2`
  assert.deepEqual(
    parseAssetIds(text).map((p) => p.id),
    ['1234567', '987654321', '55555555', '24242424', '77777777', '99999999']
  )
  assert.deepEqual(parseAssetIds('nothing here 123 abc'), [])
  assert.deepEqual(parseAssetIds('rbxassetid://0012345').map((p) => p.id), ['12345'])
})

test('duplicates by content hash: library first, then earlier in the batch', () => {
  const rows = markDuplicates(
    [
      { key: 'a', hash: 'h1' },
      { key: 'b', hash: 'h2' },
      { key: 'c', hash: 'h1' },
      { key: 'd', hash: 'h3' },
      { key: 'e' }
    ] as { key: string; hash?: string; duplicateOf?: string }[],
    new Map([['h3', 'lib-tex']])
  )
  assert.deepEqual(
    rows.map((r) => r.duplicateOf),
    [undefined, undefined, 'batch:a', 'lib-tex', undefined]
  )
})

test('vision answers are parsed defensively', () => {
  const r = parseVisionTags('```json\n[{"name":"Blue Spark","kind":"spark","description":"A thin streak.","tags":["Blue","streak","!!bad"]},null,{"kind":"banana"}]\n```', 3)
  assert.deepEqual(r[0], { name: 'Blue Spark', kind: 'spark', description: 'A thin streak.', tags: ['blue', 'streak'] })
  assert.equal(r[1], null)
  assert.equal(r[2], null)
  assert.deepEqual(parseVisionTags('no json', 2), [null, null])
})

// ---------------------------------------------------------------- analysis

test('image analysis: kinds, colour, edge and coverage on synthetic images', () => {
  const kinds: [string, Rgba][] = [
    ['glow', glowImg()],
    ['ring', ringImg()],
    ['spark', sparkImg()],
    ['noise', noiseImg()],
    ['beam', beamImg()],
    ['trail', trailImg()],
    ['star', starImg()]
  ]
  for (const [k, img] of kinds) assert.equal(analyzeTexture(img).kind, k, `${k}: ${JSON.stringify(analyzeTexture(img))}`)
  const smoke = generateProcedural({ type: 'smoke', size: 64, tint: 'grey' }).image
  assert.equal(analyzeTexture(smoke).kind, 'smoke')
  const g = analyzeTexture(glowImg())
  assert.equal(g.edge, 'soft')
  assert.equal(g.colorName, 'white')
  assert.equal(analyzeTexture(ringImg()).edge, 'hard')
  assert.ok(analyzeTexture(sparkImg()).coverage < 0.1)
  assert.ok(analyzeTexture(noiseImg()).coverage > 0.9)
  const red = analyzeTexture(redGlow())
  assert.equal(red.colorName, 'red')
  assert.equal(red.color.slice(0, 3), '#ff')
  assert.deepEqual(autoTags(red, { flipbook: true, extra: ['imported'] }), ['glow', 'red', 'soft', 'flipbook', 'imported'])
  assert.equal(colorName(255, 140, 0), 'orange')
  assert.equal(colorName(40, 90, 255), 'blue')
  assert.equal(colorName(128, 128, 128), 'grey')
  // JPG-style art on black reads by brightness.
  const onBlack = draw(64, 64, (u, v) => {
    const a = Math.exp(-((u - 0.5) ** 2 + (v - 0.5) ** 2) / 0.02)
    return [255 * a, 255 * a, 255 * a, 255]
  })
  assert.equal(analyzeTexture(onBlack).kind, 'glow')
})

// ---------------------------------------------------------------- reuse first

let clock = 1000
function tex(id: string, kind: VfxTexture['kind'], extra: Partial<VfxTexture> = {}): VfxTexture {
  return { id, scope: 'user', name: id, kind, description: '', tags: [kind], source: 'procedural', tint: 'white', size: 64, createdAt: clock, updatedAt: clock++, file: 'texture.png', preview: 'preview.png', ...extra }
}
const node = (name: string, className: string, props: Record<string, unknown> = {}): VfxNode => ({ id: name, className, name, props: props as VfxNode['props'], children: [] })
function fx(nodes: VfxNode[]): VfxEffect {
  return { name: 'Fx', roots: [{ id: 'root', className: 'Model', name: 'Fx', props: {}, children: nodes }], cues: [], duration: 1 }
}
const texOf = (e: VfxEffect, name: string) => e.roots[0].children.find((n) => n.name === name)!.props.Texture

test('policy setting: values, default and key', () => {
  assert.equal(DEFAULT_TEXTURE_POLICY, 'library-first')
  assert.equal(TEXTURE_POLICY_SETTING, 'vfx.texturePolicy')
  assert.equal(normalizePolicy('library-only'), 'library-only')
  assert.equal(normalizePolicy('generate'), 'generate')
  assert.equal(normalizePolicy('nonsense'), 'library-first')
  assert.equal(normalizePolicy(undefined), 'library-first')
})

test('scoring prefers exact, imported and liked textures and never disliked ones', () => {
  const imported = tex('smoke-imp', 'smoke', { source: 'imported' })
  const liked = tex('smoke-liked', 'smoke', { rating: 'up' })
  const plain = tex('smoke-plain', 'smoke')
  const bad = tex('smoke-bad', 'smoke', { rating: 'down', source: 'imported' })
  const wisp = tex('wisp', 'wisp')
  const beam = tex('beam', 'beam', { source: 'imported' })
  assert.equal(scoreTexture(bad, { kind: 'smoke' }), 0)
  assert.ok(scoreTexture(liked, { kind: 'smoke' }) > scoreTexture(imported, { kind: 'smoke' }))
  assert.ok(scoreTexture(imported, { kind: 'smoke' }) > scoreTexture(plain, { kind: 'smoke' }))
  assert.ok(scoreTexture(plain, { kind: 'smoke' }) > scoreTexture(wisp, { kind: 'smoke' }))
  assert.ok(scoreTexture(wisp, { kind: 'smoke' }) > 0, 'related kind')
  assert.equal(scoreTexture(tex('ring', 'ring'), { kind: 'smoke' }), 0)
  assert.equal(scoreTexture(beam, { kind: 'beam', className: 'ParticleEmitter' }), 0, 'strips never on emitters')
  assert.equal(pickLibraryTexture([plain, imported, liked, bad], { kind: 'smoke' })!.id, 'smoke-liked')
  // strict: only imported / liked exact matches.
  assert.equal(pickLibraryTexture([plain, wisp], { kind: 'smoke' }, { strict: true }), null)
  assert.equal(pickLibraryTexture([plain, imported], { kind: 'smoke' }, { strict: true })!.id, 'smoke-imp')
})

test('node wants come from gen refs, names and roles', () => {
  assert.equal(nodeWant(node('X', 'ParticleEmitter', { Texture: genRef('ring') }))!.kind, 'ring')
  assert.equal(nodeWant(node('HitSmoke', 'ParticleEmitter', {}))!.kind, 'smoke')
  assert.equal(nodeWant(node('Sparks', 'ParticleEmitter', {}))!.kind, 'spark')
  assert.equal(nodeWant(node('Wake', 'Beam', {}))!.kind, 'beam')
  assert.equal(nodeWant(node('CoreTrail', 'Trail', {}))!.kind, 'trail')
  assert.equal(nodeWant(node('Light', 'PointLight', {})), null)
})

test('reuse-first selection: library textures replace gen requests, disliked and built-in defaults', () => {
  const lib = [tex('ring-imp', 'ring', { source: 'imported' }), tex('smoke-liked', 'smoke', { rating: 'up' }), tex('spark-bad', 'spark', { rating: 'down' }), tex('spark-ok', 'spark'), tex('beam-imp', 'beam', { source: 'asset', roblox: { assetId: '1', uri: 'rbxassetid://1', uploadedAt: 1, moderation: 'Approved' } })]
  const effect = fx([
    node('Wave', 'ParticleEmitter', { Texture: genRef('ring') }),
    node('Crack', 'ParticleEmitter', { Texture: genRef('crack') }),
    node('Smoke', 'ParticleEmitter', { Texture: BUILTIN_SMOKE }),
    node('Sparks', 'ParticleEmitter', { Texture: texRef('spark-bad') }),
    node('Glow', 'ParticleEmitter', { Texture: BUILTIN_SPARKLES }),
    node('Wake', 'Beam', {}),
    node('Fixed', 'ParticleEmitter', { Texture: 'rbxassetid://42' })
  ])
  // library first (default)
  const first = applyTexturePolicy(effect, lib, 'library-first', { replaceBuiltins: true })
  assert.equal(texOf(first.effect, 'Wave'), texRef('ring-imp'))
  assert.equal(texOf(first.effect, 'Crack'), genRef('crack'), 'nothing fits: the procedural request stays (made for free)')
  assert.equal(texOf(first.effect, 'Smoke'), texRef('smoke-liked'))
  assert.equal(texOf(first.effect, 'Sparks'), texRef('spark-ok'), 'disliked swapped for an alternative')
  assert.equal(texOf(first.effect, 'Glow'), BUILTIN_SPARKLES, 'no imported / liked glow: the built-in stays')
  assert.equal(texOf(first.effect, 'Wake'), texRef('beam-imp'))
  assert.equal(texOf(first.effect, 'Fixed'), 'rbxassetid://42', 'explicit ids are left alone')
  assert.ok(first.picks.every((p) => p.why))
  // library only: no generation at all.
  const only = applyTexturePolicy(effect, lib, 'library-only', { replaceBuiltins: true })
  assert.equal(texOf(only.effect, 'Crack'), BUILTIN_SPARKLES)
  assert.equal(texOf(only.effect, 'Wave'), texRef('ring-imp'))
  // generate freely: gen requests stay, built-ins stay; disliked are still swapped.
  const gen = applyTexturePolicy(effect, lib, 'generate', { replaceBuiltins: true })
  assert.equal(texOf(gen.effect, 'Wave'), genRef('ring'))
  assert.equal(texOf(gen.effect, 'Smoke'), BUILTIN_SMOKE)
  assert.equal(texOf(gen.effect, 'Sparks'), texRef('spark-ok'))
  // Manual saves (no replaceBuiltins) keep built-ins.
  assert.equal(texOf(applyTexturePolicy(effect, lib, 'library-first').effect, 'Smoke'), BUILTIN_SMOKE)
  // Scripted effects keep the swaps as patches (re-applied when the script runs again).
  const scripted = applyTexturePolicy({ ...effect, script: 'return function(fx) end' }, lib, 'library-first', { replaceBuiltins: true })
  assert.ok(scripted.effect.patches!.some((p) => p.node === 'Smoke' && p.value === texRef('smoke-liked')))
})

test('prompt lines, draft roles and the generate gate follow the policy', () => {
  const lib = [tex('smoke-imp', 'smoke', { source: 'imported', analysis: { color: '#888888', colorName: 'grey', edge: 'soft', coverage: 0.4 } }), tex('glow-liked', 'glow', { rating: 'up' }), tex('bad', 'ring', { rating: 'down' })]
  const first = libraryPromptLines(lib, 'library-first').join('\n')
  assert.match(first, /LIBRARY FIRST/)
  assert.match(first, /smoke: forgetex:\/\/smoke-imp "smoke-imp" \(grey, soft\)/)
  assert.match(first, /Never use these disliked textures: forgetex:\/\/bad/)
  assert.doesNotMatch(first.split('Never')[0], /forgetex:\/\/bad/)
  assert.match(libraryPromptLines(lib, 'library-only').join('\n'), /Never use forgetex:\/\/gen/)
  assert.match(libraryPromptLines([], 'generate').join('\n'), /generate freely[\s\S]*empty/)
  assert.deepEqual(roleTextures(lib, 'library-first'), { core: texRef('glow-liked'), glow: texRef('glow-liked'), smoke: texRef('smoke-imp') })
  assert.deepEqual(roleTextures(lib, 'generate'), {})
  assert.equal(generationAllowed(lib, 'library-first', 'smoke', false).ok, false)
  assert.equal(generationAllowed(lib, 'library-first', 'crack', false).ok, true)
  assert.equal(generationAllowed(lib, 'library-only', 'crack', false).ok, false)
  assert.equal(generationAllowed(lib, 'library-only', 'crack', true).ok, true)
  assert.equal(generationAllowed(lib, 'generate', 'smoke', false).ok, true)
})

// ---------------------------------------------------------------- Studio harvest

test('studio harvest: the job, its messages and the live tree', () => {
  const job = harvestJob({ id: 'job-tex-abc', port: 51234 })
  assert.equal(job.kind, 'vfx')
  assert.equal(job.entry, 'ForgeTextureHarvest')
  assert.equal(job.calibrate, false)
  const src = job.modules[0].source!
  assert.match(src, /http:\/\/127\.0\.0\.1:51234\/forge-bridge\/event\/job-tex-abc/)
  assert.match(src, /function M\.play/)
  assert.doesNotMatch(src, /:Destroy\(|\.Parent\s*=|:SetAttribute|Instance\.new/, 'read-only')
  assert.throws(() => harvestModuleSource({ port: 1, jobId: 'bad id"' }))
  const body = JSON.stringify([
    { t: 'rbxassetid://111', c: ['ParticleEmitter'], p: ['Workspace.Sword.Sparks'], n: 3 },
    { t: 'rbxasset://textures/particles/sparkles_main.dds', c: ['ParticleEmitter'], p: ['Workspace.A'], n: 1 },
    { t: 'http://www.roblox.com/asset/?id=222', c: ['Beam'], p: ['ReplicatedStorage.VFX.Laser.Beam'], n: 1 }
  ])
  const half = Math.ceil(body.length / 2)
  const msgs = [`${HARVEST_TAG} 2/2 ${body.slice(half)}`, 'unrelated log', `${HARVEST_TAG} 1/2 ${body.slice(0, half)}`]
  const uses = collectHarvest(msgs)!
  assert.equal(uses.length, 3)
  assert.equal(collectHarvest(msgs.slice(0, 2)), null, 'incomplete')
  assert.deepEqual(collectHarvest([`${HARVEST_TAG} 1/1 []`]), [])
  const tree = harvestFromTree([
    { path: ['ReplicatedStorage', 'VFX', 'Fire', 'Embers'], className: 'ParticleEmitter', props: { Texture: 'rbxassetid://333' } },
    { path: ['ReplicatedStorage', 'VFX', 'Fire', 'Part'], className: 'Part', props: {} },
    { path: ['ReplicatedStorage', 'VFX', 'Laser', 'Beam'], className: 'Beam', props: { Texture: 'rbxassetid://222' } }
  ])
  const c = harvestCandidates(uses, tree)
  assert.deepEqual(
    c.map((x) => x.id),
    ['111', '222', '333']
  )
  assert.deepEqual(c[0].names, ['Sparks'])
  assert.deepEqual(c[1].classes, ['Beam'])
})

// ---------------------------------------------------------------- importer end to end

const png = (img: Rgba) => encodePng(img)

function fakeFetch(online: boolean) {
  const calls: string[] = []
  const f = async (url: string) => {
    calls.push(url)
    if (!online) throw new Error('offline')
    if (url.startsWith('https://thumbnails.roblox.com/v1/assets')) {
      const ids = /assetIds=([\d,]+)/.exec(url)![1].split(',')
      return { ok: true, status: 200, json: async () => ({ data: ids.map((id) => ({ targetId: Number(id), state: id === '66666' ? 'Blocked' : 'Completed', imageUrl: `https://tr.rbxcdn.com/${id}/420/420/Image/Png` })) }), text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
    }
    if (url.startsWith('https://tr.rbxcdn.com/')) {
      const b = png(url.includes('/222/') ? ringImg(64) : glowImg(64))
      return { ok: true, status: 200, json: async () => null, text: async () => '', arrayBuffer: async () => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer }
    }
    return { ok: false, status: 404, json: async () => null, text: async () => '', arrayBuffer: async () => new ArrayBuffer(0) }
  }
  return { f, calls }
}

test('importer: folders recursively, flipbooks, duplicates, review edits and commit', async () => {
  const dir = await tmp('files')
  const pack = join(dir, 'pack')
  await mkdir(join(pack, 'Smoke'), { recursive: true })
  await mkdir(join(pack, '.hidden'), { recursive: true })
  await writeFile(join(pack, 'glow.png'), png(glowImg()))
  await writeFile(join(pack, 'zz_glow_copy.png'), png(glowImg()))
  await writeFile(join(pack, 'Smoke', 'puff_4x4.png'), png(sheet(4, 4)))
  await writeFile(join(pack, 'notes.txt'), 'x')
  await writeFile(join(pack, '.hidden', 'x.png'), png(glowImg()))
  await writeFile(join(pack, 'broken.png'), Buffer.from('nope'))
  const vision = async (_s: string, prompt: string, images: unknown[]) => {
    assert.ok(images.length >= 1)
    return JSON.stringify(prompt.split('\n').map((line) => (/glow\.png/.test(line) ? { name: 'Hot Core', description: 'A soft hot glow.', tags: ['core'] } : null)))
  }
  const svc = new TextureService({ userDir: join(dir, 'user'), projectRoot: () => null, vision: () => vision })
  const scan = await svc.importFiles([pack], { vision: true })
  const byLabel = new Map(scan.rows.map((r) => [r.label.replace(/\\/g, '/'), r]))
  assert.deepEqual([...byLabel.keys()].sort(), ['pack/Smoke/puff_4x4.png', 'pack/broken.png', 'pack/glow.png', 'pack/zz_glow_copy.png'])
  assert.ok(byLabel.get('pack/broken.png')!.error)
  const fb = byLabel.get('pack/Smoke/puff_4x4.png')!
  assert.equal(fb.kind, 'smoke', 'folder name wins')
  assert.deepEqual(fb.flipbook && [fb.flipbook.layout, fb.flipbook.frames, fb.flipbook.source], ['Grid4x4', 16, 'name+grid'])
  assert.ok(fb.tags.includes('flipbook') && fb.tags.includes('imported'))
  const g = byLabel.get('pack/glow.png')!
  assert.equal(g.kind, 'glow')
  assert.equal(g.name, 'Hot Core', 'vision name')
  assert.ok(g.vision)
  assert.match(byLabel.get('pack/zz_glow_copy.png')!.duplicateOf!, /glow\.png/)
  // Commit: edited name / tags, flipbook kept.
  const made = await svc.importCommit({ scanId: scan.scanId, scope: 'user', rows: [{ key: g.key, name: 'My Glow', tags: ['core', 'hot'] }, { key: fb.key }] })
  assert.equal(made.length, 2)
  const mg = made.find((t) => t.name === 'My Glow')!
  assert.equal(mg.source, 'imported')
  assert.equal(mg.tint, 'color')
  assert.deepEqual(mg.tags, ['glow', 'core', 'hot'])
  assert.ok(mg.origin?.hash && mg.analysis?.edge === 'soft')
  const ms = made.find((t) => t.kind === 'smoke')!
  assert.deepEqual(ms.flipbook, { layout: 'Grid4x4', frames: 16 })
  assert.equal(ms.size, 128)
  // A second scan sees the library duplicate.
  const again = await svc.importFiles([join(pack, 'glow.png')])
  assert.equal(again.rows[0].duplicateOf, mg.id)
  await assert.rejects(svc.importCommit({ scanId: 'nope', rows: [] }), /expired/)
})

test('importer: asset ids with previews, offline fallback, and the export swap', async () => {
  const dir = await tmp('ids')
  const on = fakeFetch(true)
  const svc = new TextureService({ userDir: join(dir, 'user'), projectRoot: () => null, bytesFetch: on.f as never })
  const scan = await svc.importIds('rbxassetid://111\nhttps://create.roblox.com/store/asset/222/Ring 66666')
  assert.equal(scan.rows.length, 3)
  assert.equal(on.calls.filter((u) => u.includes('thumbnails.roblox.com')).length, 1, 'one batched thumbnails call')
  assert.match(on.calls[0], /assetIds=111,222,66666&returnPolicy=PlaceHolder&size=420x420&format=Png/)
  assert.equal(scan.rows[0].kind, 'glow')
  assert.equal(scan.rows[1].kind, 'ring')
  assert.match(scan.rows[2].notes.join(' '), /blocks/)
  const made = await svc.importCommit({ scanId: scan.scanId, rows: scan.rows.map((r) => ({ key: r.key })) })
  assert.equal(made[0].source, 'asset')
  assert.equal(made[0].roblox!.uri, 'rbxassetid://111')
  assert.equal(made[0].roblox!.moderation, 'Approved')
  assert.equal(made[2].roblox!.moderation, 'Rejected')
  // Exported effects use the existing id: no upload needed.
  const plan = await svc.exportEffect(fx([node('Core', 'ParticleEmitter', { Texture: texRef(made[0].id) })]))
  assert.equal(texOf(plan.effect, 'Core'), 'rbxassetid://111')
  assert.deepEqual(plan.fallbacks, [])
  // Pasting the same id again is a duplicate.
  assert.equal((await svc.importIds('rbxassetid://111')).rows[0].duplicateOf, made[0].id)
  // Offline: rows without previews still import and work.
  const off = new TextureService({ userDir: join(dir, 'user2'), projectRoot: () => null, bytesFetch: fakeFetch(false).f as never })
  const s2 = await off.importIds('33333')
  assert.match(s2.notes.join(' '), /could not be reached/)
  assert.equal(s2.rows[0].preview, undefined)
  const [t] = await off.importCommit({ scanId: s2.scanId, rows: [{ key: s2.rows[0].key, kind: 'spark' }] })
  assert.equal(t.kind, 'spark')
  assert.equal(t.origin?.noPreview, true)
  assert.equal(t.roblox!.uri, 'rbxassetid://33333')
  assert.ok(await off.file(t.id, 'texture'), 'placeholder image')
  await assert.rejects(svc.importIds('hello'), /No asset ids/)
})

test('importer: From Studio merges the bridge job and the live tree', async () => {
  const dir = await tmp('studio')
  const body = JSON.stringify([{ t: 'rbxassetid://111', c: ['ParticleEmitter'], p: ['Workspace.Sword.HitSparks'], n: 2 }])
  let ran = 0
  const bridge = {
    port: 40000,
    listening: true,
    connected: () => true,
    run: async (job: { modules: { source?: string }[] }, handler: (ev: { type: string; message?: string }, at: number) => unknown) => {
      ran++
      assert.match(job.modules[0].source!, /127\.0\.0\.1:40000/)
      await handler({ type: 'accepted' }, 0)
      await handler({ type: 'log', message: `${HARVEST_TAG} 1/1 ${body}` }, 0)
      await handler({ type: 'done' }, 0)
    }
  }
  const liveTree = () => ({ nodes: [{ path: ['ReplicatedStorage', 'VFX', 'Laser', 'LaserBeam'], className: 'Beam', props: { Texture: 'rbxassetid://222' } }] })
  const svc = new TextureService({ userDir: join(dir, 'user'), projectRoot: () => null, bytesFetch: fakeFetch(true).f as never, studio: { bridge, liveTree } })
  const scan = await svc.importStudio()
  assert.equal(ran, 1)
  assert.deepEqual(
    scan.rows.map((r) => [r.assetId, r.from, r.name]),
    [
      ['111', 'studio', 'HitSparks'],
      ['222', 'studio', 'LaserBeam']
    ]
  )
  assert.equal(scan.rows[0].kind, 'spark', 'kind from the emitter name')
  assert.equal(scan.rows[1].kind, 'beam')
  assert.deepEqual(scan.rows[0].paths, ['Workspace.Sword.HitSparks'])
  // Not connected and no live tree: a clear error.
  const none = new TextureService({ userDir: join(dir, 'u2'), projectRoot: () => null, studio: { bridge: { ...bridge, connected: () => false } } })
  await assert.rejects(none.importStudio(), /Nothing to read from Studio/)
})

test('policy setting through the wiring, the composer hooks and the generate tool', async () => {
  const dir = await tmp('policy')
  const store: Record<string, unknown> = {}
  const w = createVfxWiring({ userDataDir: dir, root: () => null, settings: { get: <T>(k: string, f: T) => (k in store ? (store[k] as T) : f), set: (k, v) => void (store[k] = v) }, emit: () => undefined })
  assert.equal(((await w.handlers.vfxTexStatus()) as { policy: string }).policy, 'library-first')
  assert.equal(await w.handlers.vfxTexSetPolicy('library-only'), 'library-only')
  assert.equal(store['vfx.texturePolicy'], 'library-only')
  assert.equal(await w.handlers.vfxTexSetPolicy('bogus'), 'library-first')
  const svc = w.textures
  svc.setPolicy('library-first')
  // Seed the library with an imported smoke texture.
  const d2 = await mkdtemp(join(tmpdir(), 'forge-teximp-src-'))
  await writeFile(join(d2, 'puff.png'), png(generateProcedural({ type: 'smoke', size: 64, tint: 'grey' }).image))
  const s = await svc.importFiles([join(d2, 'puff.png')])
  const [smoke] = await svc.importCommit({ scanId: s.scanId, scope: 'user', rows: [{ key: s.rows[0].key, kind: 'smoke' }] })
  // Composer output: a gen smoke request and a kit layer on the built-in smoke.
  const effect = fx([node('Haze', 'ParticleEmitter', { Texture: genRef('smoke') }), node('Dust', 'ParticleEmitter', { Texture: BUILTIN_SMOKE })])
  const prepared = await svc.prepareEffect(effect, 'user', { reuse: true })
  assert.equal(texOf(prepared, 'Haze'), texRef(smoke.id))
  assert.equal(texOf(prepared, 'Dust'), texRef(smoke.id))
  assert.equal((await svc.list()).length, 1, 'nothing generated')
  // Manual edits keep the requested procedural texture.
  const manual = await svc.prepareEffect(effect, 'user')
  assert.notEqual(texOf(manual, 'Haze'), texRef(smoke.id))
  assert.equal((await svc.list()).length, 2)
  // Prompt lines and draft roles.
  assert.match((await svc.promptList()).join('\n'), new RegExp(`LIBRARY FIRST[\\s\\S]*smoke: forgetex://${smoke.id}`))
  assert.deepEqual(await svc.roleTextures(), { smoke: texRef(smoke.id) })
  // The agent's generate tool answers with the library texture instead.
  const gen = textureTools(svc).write[0]
  const r = await gen.handler({ type: 'smoke' }, {})
  assert.match(r.content[0].text, /library first/)
  assert.match(r.content[0].text, new RegExp(smoke.id))
  const n = (await svc.list()).length
  await gen.handler({ type: 'smoke', user_asked: true }, {})
  assert.equal((await svc.list()).length, n + 1, 'user asked: generated')
})
