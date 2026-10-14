// VFX Lab custom textures: procedural generators (deterministic hashes and stats), the alpha
// post-processing pipeline, flipbook assembly, ParticleEmitter flipbook properties in the schema
// and the simulation (checked against the Creator Hub docs), forgetex:// refs and the swap to
// rbxassetid:// on export, the texture service (procedural, AI with a fake OpenAI, upload and
// moderation with a fake Open Cloud), the VFX service writing swapped project files, the critic's
// better-texture actions and the agent tools.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateSync } from 'node:zlib'
import { generateProcedural, PROCEDURAL_TYPES, renderProcedural, resolveParams, evolveFrames } from '../src/shared/vfx/tex/procedural.ts'
import { alphaCleanup, applyTint, assembleFlipbook, blank, centerOnContent, flipbookCell, imageStats, nearestPow2, premultipliedPreview, prepareSprite, radialFalloff, resample, toPow2Square, type Rgba } from '../src/shared/vfx/tex/image.ts'
import { applyFlipbookLayouts, exportEffect, genRef, kindFromText, parseTexRef, swapTextureRefs, texRef, texRefsIn, textureSuggestions, BUILTIN_SMOKE, BUILTIN_SPARKLES } from '../src/shared/vfx/tex/textures.ts'
import { ENUMS, SCHEMA } from '../src/shared/vfx/schema.ts'
import { flipbookFrames, flipbookGrid, prepareEffect, simulateEmitter, MAX_FLIPBOOK_FPS } from '../src/shared/vfx/simulate.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'
import { emitterRole } from '../src/shared/vfx/analyze.ts'
import { heuristicCritique } from '../src/shared/vfx/critique.ts'
import { readRbxmx, writeRbxmx } from '../src/shared/vfx/rbxmx.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'
import { decodePng, encodePng } from '../src/main/services/vfx/textures/png.ts'
import { TextureService, normalizeModeration } from '../src/main/services/vfx/textures/service.ts'
import { textureTools } from '../src/main/services/vfx/textures/tools.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-tex-${p}-`))

// ---------------------------------------------------------------- procedural

test('procedural generators are deterministic, centred and never touch the edge', () => {
  for (const type of PROCEDURAL_TYPES) {
    const a = generateProcedural({ type, size: 64 })
    const b = generateProcedural({ type, size: 64 })
    const s = imageStats(a.image)
    assert.equal(s.hash, imageStats(b.image).hash, `${type} is deterministic`)
    assert.equal(s.width, 64)
    assert.equal(s.edgeAlpha, 0, `${type} fades out before the edge`)
    assert.ok(s.coverage > 0.01 && s.coverage < 0.9, `${type} coverage ${s.coverage}`)
    // White on transparent (tintable by Color).
    for (let i = 0; i < a.image.data.length; i += 4) assert.equal(a.image.data[i], 255)
  }
  // Radially symmetric shapes sit exactly in the middle.
  for (const type of ['glow', 'ring', 'spark', 'star'] as const) {
    const c = imageStats(generateProcedural({ type, size: 64 }).image).centroid
    assert.ok(Math.abs(c[0] - 0.5) < 0.01 && Math.abs(c[1] - 0.5) < 0.01, `${type} centroid ${c}`)
  }
  // The seed changes noise-based shapes; params are clamped to their ranges.
  assert.notEqual(imageStats(generateProcedural({ type: 'smoke', size: 64, seed: 1 }).image).hash, imageStats(generateProcedural({ type: 'smoke', size: 64, seed: 2 }).image).hash)
  assert.equal(resolveParams('ring', { radius: 9, thickness: -1 }).radius, 0.85)
  assert.equal(resolveParams('ring', { thickness: -1 }).thickness, 0.02)
  assert.throws(() => generateProcedural({ type: 'blob' as never }), /unknown procedural type/)
})

test('procedural output hashes are pinned (catches accidental changes to the generators)', () => {
  // FNV-1a of the RGBA bytes at 32 px, seed 3. Update these only after an intentional change to a
  // generator (V8's Math functions are deterministic across platforms).
  const pins: Record<string, string> = { glow: 'eec236d5', ring: '479974d5', spark: 'a7ce6b65', smoke: '660236fd', crack: '20d54cca', star: '51fd8c75', slash: '123bbe09' }
  const got: Record<string, string> = {}
  for (const type of PROCEDURAL_TYPES) got[type] = imageStats(renderProcedural(type, {}, { size: 32, seed: 3 })).hash
  assert.deepEqual(got, pins)
  // Shape stats that define each generator.
  const ring = imageStats(renderProcedural('ring', { radius: 0.5, thickness: 0.05, softness: 0 }, { size: 128 }))
  const glow = imageStats(renderProcedural('glow', {}, { size: 128 }))
  assert.ok(ring.coverage < glow.coverage, 'a thin ring covers less than a glow')
  const ringImg = renderProcedural('ring', { radius: 0.5, thickness: 0.05, softness: 0 }, { size: 128 })
  assert.equal(ringImg.data[(64 * 128 + 64) * 4 + 3], 0, 'the ring centre is empty')
  assert.ok(ringImg.data[(64 * 128 + 96) * 4 + 3] > 200, 'the ring line at radius 0.5 is solid')
  const spark = renderProcedural('spark', {}, { size: 128 })
  assert.ok(spark.data[(20 * 128 + 64) * 4 + 3] > spark.data[(64 * 128 + 20) * 4 + 3], 'sparks are vertical streaks')
  // Grey tint keeps shading in rgb.
  const smoke = renderProcedural('smoke', {}, { size: 64, tint: 'grey' })
  const greys = new Set<number>()
  for (let i = 0; i < smoke.data.length; i += 4) if (smoke.data[i + 3] > 0) greys.add(smoke.data[i])
  assert.ok(greys.size > 10)
})

test('procedural flipbooks evolve over the frames on an exact grid', () => {
  const r = generateProcedural({ type: 'ring', frames: 16, size: 256 })
  assert.equal(r.layout, 'Grid4x4')
  assert.equal(r.frames, 16)
  assert.equal(r.image.width, 256)
  const first = imageStats(flipbookCell(r.image, 'Grid4x4', 0))
  const last = imageStats(flipbookCell(r.image, 'Grid4x4', 15))
  assert.notEqual(first.hash, last.hash)
  // The crack grows: more ink in the last frame.
  const c = generateProcedural({ type: 'crack', frames: 4, size: 256 })
  assert.equal(c.layout, 'Grid2x2')
  assert.ok(imageStats(flipbookCell(c.image, 'Grid2x2', 3)).coverage > imageStats(flipbookCell(c.image, 'Grid2x2', 0)).coverage)
  assert.equal(generateProcedural({ type: 'glow', frames: 64 }).image.width, 1024)
})

// ---------------------------------------------------------------- post-processing

function opaqueDot(size: number, bg: [number, number, number], fg: [number, number, number], at: [number, number], r: number): Rgba {
  const img = blank(size)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4
      const inside = Math.hypot(x + 0.5 - at[0], y + 0.5 - at[1]) < r
      const c = inside ? fg : bg
      img.data[i] = c[0]
      img.data[i + 1] = c[1]
      img.data[i + 2] = c[2]
      img.data[i + 3] = 255
    }
  }
  return img
}

test('alpha cleanup: opaque black backgrounds become alpha, haze is cut, no dark fringe', () => {
  const img = opaqueDot(32, [0, 0, 0], [200, 100, 50], [16, 16], 6)
  // A faint haze pixel.
  img.data[(2 * 32 + 2) * 4] = 5
  const out = alphaCleanup(img, { threshold: 10 })
  const at = (x: number, y: number) => out.data[(y * 32 + x) * 4 + 3]
  assert.ok(at(16, 16) > 190, 'the bright dot is (nearly) opaque: alpha from its brightness')
  assert.equal(at(0, 0), 0, 'the black background is transparent')
  assert.equal(at(2, 2), 0, 'haze under the threshold is cut')
  // Colour un-premultiplied (200/255 alpha -> full brightness).
  assert.equal(out.data[(16 * 32 + 16) * 4], 255)
  // Transparent pixels carry the visible average colour, not black.
  assert.ok(out.data[0] > 200 && out.data[1] > 100, 'no dark fringe colour under alpha 0')
  // A white background: distance from the border colour.
  const w = alphaCleanup(opaqueDot(32, [255, 255, 255], [20, 20, 20], [16, 16], 6))
  assert.equal(w.data[3], 0)
  assert.equal(w.data[(16 * 32 + 16) * 4 + 3], 255)
  // Already transparent input keeps its alpha (above the threshold).
  const t = blank(4)
  t.data.set([255, 255, 255, 128], 0)
  assert.ok(alphaCleanup(t).data[3] > 100)
})

test('centring, radial falloff, power-of-two resampling, tint modes and the premultiplied preview', () => {
  // A dot in the top-left corner ends up centred.
  const off = alphaCleanup(opaqueDot(100, [0, 0, 0], [255, 255, 255], [20, 25], 8))
  const centred = centerOnContent(off, 0.1)
  const c = imageStats(centred).centroid
  assert.ok(Math.abs(c[0] - 0.5) < 0.05 && Math.abs(c[1] - 0.5) < 0.05, `centroid ${c}`)
  // Radial falloff: corners and edges reach zero, the middle is untouched.
  const full = blank(64)
  full.data.fill(255)
  const f = radialFalloff(full, 0.7)
  assert.equal(imageStats(f).edgeAlpha, 0)
  assert.equal(f.data[(32 * 64 + 32) * 4 + 3], 255)
  // Power of two, square, max 1024.
  assert.equal(nearestPow2(700), 512)
  assert.equal(nearestPow2(800), 1024)
  assert.equal(nearestPow2(5000), 1024)
  assert.equal(nearestPow2(10), 32)
  const sq = toPow2Square(resample(f, 300, 300))
  assert.equal(sq.width, 256)
  assert.equal(sq.height, 256)
  // Resampling keeps mean coverage.
  close(imageStats(resample(f, 32)).meanAlpha, imageStats(f).meanAlpha, 0.02)
  // Tints: white moves brightness into alpha; grey keeps alpha and makes rgb grey.
  const coloured = blank(2, 1)
  coloured.data.set([255, 0, 0, 255, 0, 0, 255, 255])
  const white = applyTint(coloured, 'white')
  assert.deepEqual([...white.data.subarray(0, 3)], [255, 255, 255])
  assert.ok(white.data[3] > white.data[7], 'red is brighter than blue: more alpha')
  const grey = applyTint(coloured, 'grey')
  assert.equal(grey.data[0], grey.data[1])
  assert.equal(grey.data[3], 255)
  // Premultiplied on black, opaque.
  const half = blank(1)
  half.data.set([200, 100, 50, 128])
  assert.deepEqual([...premultipliedPreview(half).data], [100, 50, 25, 255])
  // The whole pipeline: a 1024 opaque generation -> a centred 512 sprite with clean edges.
  const sprite = prepareSprite(opaqueDot(1024, [0, 0, 0], [240, 240, 255], [400, 600], 200), { size: 512 })
  const s = imageStats(sprite)
  assert.equal(s.width, 512)
  assert.equal(s.edgeAlpha, 0)
  assert.ok(Math.abs(s.centroid[0] - 0.5) < 0.03 && Math.abs(s.centroid[1] - 0.5) < 0.03)
})

function close(a: number, b: number, eps: number) {
  assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)
}

test('flipbook assembly: frames on an exact grid with transparent gutters', () => {
  const frames = [0, 1, 2, 3].map((k) => {
    const f = blank(32)
    for (let i = 0; i < f.data.length; i += 4) f.data.set([255, 255, 255, 60 * (k + 1)], i)
    return f
  })
  const sheet = assembleFlipbook(frames, 'Grid2x2', 128, 0.1)
  assert.equal(sheet.width, 128)
  for (let k = 0; k < 4; k++) {
    const cell = flipbookCell(sheet, 'Grid2x2', k)
    assert.equal(cell.width, 64)
    assert.equal(imageStats(cell).edgeAlpha, 0, `cell ${k} has a gutter`)
    assert.equal(cell.data[(32 * 64 + 32) * 4 + 3], 60 * (k + 1), `cell ${k} holds frame ${k}`)
  }
  // Fewer frames than cells: the last one repeats (a Loop never shows an empty cell).
  const two = assembleFlipbook(frames.slice(0, 2), 'Grid2x2', 64)
  assert.equal(flipbookCell(two, 'Grid2x2', 3).data[(16 * 32 + 16) * 4 + 3], 120)
  // Roblox: the texture size must be an exact multiple of the layout; we also keep powers of two <= 1024.
  assert.throws(() => assembleFlipbook(frames, 'Grid8x8', 100), /power of two/)
  assert.throws(() => assembleFlipbook(frames, 'Grid4x4', 2048), /1024/)
  assert.throws(() => assembleFlipbook(new Array(5).fill(frames[0]), 'Grid2x2', 64), /holds 4/)
  // AI flipbooks evolve one image: frames dissolve over time.
  const evo = evolveFrames(generateProcedural({ type: 'glow', size: 64 }).image, 4)
  assert.equal(evo.length, 4)
  assert.ok(imageStats(evo[3]).meanAlpha < imageStats(evo[0]).meanAlpha)
})

// ---------------------------------------------------------------- schema + simulation

test('ParticleEmitter flipbook properties match the Creator Hub reference', () => {
  // reference/engine/enums/ParticleFlipbookLayout.yaml and ParticleFlipbookMode.yaml (read 2026-10-13).
  assert.deepEqual(ENUMS.ParticleFlipbookLayout, { None: 0, Grid2x2: 1, Grid4x4: 2, Grid8x8: 3, Custom: 4 })
  assert.deepEqual(ENUMS.ParticleFlipbookMode, { Loop: 0, OneShot: 1, PingPong: 2, Random: 3 })
  const pe = SCHEMA.ParticleEmitter
  assert.equal(pe.FlipbookLayout.kind, 'enum:ParticleFlipbookLayout')
  assert.equal(pe.FlipbookMode.kind, 'enum:ParticleFlipbookMode')
  // FlipbookFramerate is a NumberRange "with a maximum of 30 frames per second".
  assert.equal(pe.FlipbookFramerate.kind, 'range')
  assert.equal(pe.FlipbookFramerate.max, 30)
  assert.equal(MAX_FLIPBOOK_FPS, 30)
  for (const k of ['FlipbookStartRandom', 'FlipbookSizeX', 'FlipbookSizeY', 'FlipbookBlendFrames']) assert.ok(pe[k], k)
  const node = (props: VfxNode['props']): VfxNode => ({ id: 'n', className: 'ParticleEmitter', name: 'F', props, children: [] })
  assert.deepEqual(flipbookGrid(node({ FlipbookLayout: 'Grid8x8' })), [8, 8])
  assert.equal(flipbookFrames(node({ FlipbookLayout: 'Custom', FlipbookSizeX: 3, FlipbookSizeY: 2 })), 6)
  // Written to .rbxmx as enum tokens and read back.
  const back = readRbxmx(writeRbxmx([node({ FlipbookLayout: 'Grid4x4', FlipbookMode: 'PingPong', FlipbookFramerate: [12, 24] })]))
  const n = back.flatMap(function all(x): VfxNode[] {
    return [x, ...x.children.flatMap(all)]
  }).find((x) => x.className === 'ParticleEmitter')!
  assert.equal(n.props.FlipbookLayout, 'Grid4x4')
  assert.equal(n.props.FlipbookMode, 'PingPong')
  assert.deepEqual(n.props.FlipbookFramerate, [12, 24])
})

function flipEffect(props: Record<string, unknown>): VfxEffect {
  return effectFromSpec({ name: 'Flip', duration: 2, layers: [{ name: 'Puff', class: 'ParticleEmitter', props: { Lifetime: [1, 1], Speed: [0, 0], FlipbookLayout: 'Grid4x4', ...props }, emit: [{ at: 0, count: 1 }] }] } as never)
}

test('the simulation plays flipbooks like Roblox: OneShot over the lifetime, Loop at the framerate (max 30)', () => {
  const frameAt = (fx: VfxEffect, t: number) => simulateEmitter(prepareEffect(fx, 1).emitters[0], t, 1)[0]
  // OneShot: "the framerate is determined by the particle's Lifetime divided evenly by the number of
  // frames" (FlipbookFramerate does not apply).
  const one = flipEffect({ FlipbookMode: 'OneShot', FlipbookFramerate: [1, 1] })
  assert.equal(frameAt(one, 0.03).frame, 0)
  assert.equal(frameAt(one, 0.5).frame, 8)
  assert.equal(frameAt(one, 0.97).frame, 15)
  // Loop at 8 fps: frame = floor(age * 8) mod 16.
  const loop = flipEffect({ FlipbookMode: 'Loop', FlipbookFramerate: [8, 8] })
  assert.equal(frameAt(loop, 0.51).frame, 4)
  // Framerate above 30 is capped at 30.
  const fast = flipEffect({ FlipbookMode: 'Loop', FlipbookFramerate: [60, 60] })
  assert.equal(frameAt(fast, 0.21).frame, 6)
  // PingPong goes back down after the last frame (16 frames: 0..15..1).
  const pp = flipEffect({ FlipbookMode: 'PingPong', FlipbookFramerate: [30, 30] })
  assert.equal(frameAt(pp, 0.6).frame, 12)
  // Blend weight between frames for FlipbookBlendFrames.
  const b = frameAt(loop, 0.5625)
  assert.ok(b.blend > 0.4 && b.blend < 0.6)
})

// ---------------------------------------------------------------- refs and the export swap

const nodeWith = (name: string, className: string, props: VfxNode['props']): VfxNode => ({ id: name.toLowerCase(), className, name, props, children: [] })

function texEffect(): VfxEffect {
  return {
    name: 'Tex',
    duration: 1,
    cues: [],
    roots: [
      {
        id: 'root',
        className: 'Part',
        name: 'Root',
        props: {},
        children: [nodeWith('Glow', 'ParticleEmitter', { Texture: 'forgetex://glow-up-aaaaaa' }), nodeWith('Smoke', 'ParticleEmitter', { Texture: genRef('smoke', {}, { tint: 'grey' }) }), nodeWith('Ring', 'ParticleEmitter', { Texture: 'forgetex://ring-local-bbbbbb' }), nodeWith('Beam', 'Beam', { Texture: 'forgetex://ring-local-bbbbbb' }), nodeWith('Spark', 'ParticleEmitter', { Texture: 'rbxassetid://123' })]
      }
    ],
    patches: [{ node: 'Glow', prop: 'Texture', value: 'forgetex://glow-up-aaaaaa' }],
    script: 'return function(fx)\n  fx:spawn("glow", { texture = "forgetex://glow-up-aaaaaa" })\nend\n'
  }
}

test('forgetex refs: parse, canonical gen refs, swap in nodes, patches and the script', () => {
  assert.deepEqual(parseTexRef('forgetex://glow-up-aaaaaa'), { kind: 'id', id: 'glow-up-aaaaaa' })
  const g = parseTexRef('forgetex://gen/ring?thickness=0.05&seed=2&frames=16')
  assert.equal(g?.kind, 'gen')
  if (g?.kind === 'gen') {
    assert.equal(g.type, 'ring')
    assert.equal(g.params.thickness, 0.05)
    assert.equal(g.params.radius, 0.62)
    assert.equal(g.seed, 2)
    assert.equal(g.frames, 16)
  }
  assert.equal(parseTexRef('forgetex://gen/blob'), null)
  assert.equal(parseTexRef('rbxassetid://1'), null)
  assert.equal(parseTexRef('forgetex://../etc'), null)
  // Equal requests share one canonical ref.
  assert.equal(genRef('ring', { radius: 0.62 }), genRef('ring'))
  const fx = texEffect()
  assert.equal(texRefsIn(fx).length, 3)
  const swapped = swapTextureRefs(fx, { 'forgetex://glow-up-aaaaaa': 'rbxassetid://999' })
  assert.equal(swapped.roots[0].children[0].props.Texture, 'rbxassetid://999')
  assert.equal(swapped.patches![0].value, 'rbxassetid://999')
  assert.match(swapped.script!, /rbxassetid:\/\/999/)
  assert.equal(fx.roots[0].children[0].props.Texture, 'forgetex://glow-up-aaaaaa', 'the input is not mutated')
  assert.equal(kindFromText('purple energy wisps'), 'wisp')
  assert.equal(kindFromText('shockwave ring'), 'shockwave')
})

test('export: uploaded textures become rbxassetid, others fall back to a built-in', () => {
  const plan = exportEffect(texEffect(), (ref) =>
    ref === 'forgetex://glow-up-aaaaaa' ? { uri: 'rbxassetid://555', moderation: 'Approved', kind: 'glow' } : ref === 'forgetex://ring-local-bbbbbb' ? { kind: 'ring' } : null
  )
  const kids = plan.effect.roots[0].children
  assert.equal(kids[0].props.Texture, 'rbxassetid://555')
  assert.equal(kids[1].props.Texture, BUILTIN_SMOKE, 'an unmaterialised smoke request falls back to the smoke built-in')
  assert.equal(kids[2].props.Texture, BUILTIN_SPARKLES)
  assert.equal(kids[3].props.Texture, '', 'a Beam falls back to no texture')
  assert.equal(kids[4].props.Texture, 'rbxassetid://123')
  assert.equal(plan.fallbacks.length, 2)
  assert.ok(plan.fallbacks.some((f) => /not uploaded/.test(f.reason)))
  assert.doesNotMatch(JSON.stringify(plan.effect), /forgetex:/)
  // Rejected by moderation: fall back as well.
  const rej = exportEffect(texEffect(), () => ({ uri: 'rbxassetid://1', moderation: 'Rejected', kind: 'glow' }))
  assert.ok(rej.fallbacks.every((f) => /rejected/.test(f.reason)))
  // Flipbook textures set the layout on their emitters.
  const laid = applyFlipbookLayouts(texEffect(), (r) => (r === 'forgetex://ring-local-bbbbbb' ? { layout: 'Grid4x4', frames: 16 } : null))
  assert.equal(laid.roots[0].children[2].props.FlipbookLayout, 'Grid4x4')
  assert.equal(laid.roots[0].children[2].props.FlipbookMode, 'OneShot')
  assert.equal(laid.roots[0].children[3].props.FlipbookLayout, undefined, 'beams have no flipbooks')
})

test('the critic suggests better textures for layers whose built-in does not fit', () => {
  const fx = effectFromSpec({
    name: 'Bad',
    duration: 1,
    layers: [
      { name: 'Smoke', class: 'ParticleEmitter', props: { LightEmission: 0, Lifetime: [1.5, 2], Color: ['#888888', '#666666'], Texture: BUILTIN_SPARKLES } },
      { name: 'Sparks', class: 'ParticleEmitter', props: { Orientation: 'VelocityParallel', Speed: [20, 30] } },
      { name: 'ShockRing', class: 'ParticleEmitter', props: {} }
    ]
  } as never)
  const s = textureSuggestions(fx, (n) => emitterRole(n))
  assert.deepEqual(s.map((c) => c.node), ['Smoke', 'Sparks', 'ShockRing'])
  assert.match(String(s[0].value), /^forgetex:\/\/gen\/smoke\?.*tint=grey/)
  assert.match(String(s[1].value), /^forgetex:\/\/gen\/spark/)
  const crit = heuristicCritique(fx, null)
  assert.ok(crit.changes.some((c) => c.prop === 'Texture'))
})

// ---------------------------------------------------------------- PNG

test('PNG codec: RGBA round trip and decoding filtered rows', () => {
  const img = generateProcedural({ type: 'star', size: 48 }).image
  const back = decodePng(encodePng(img))
  assert.deepEqual([...back.data], [...img.data])
  // A 3x2 RGB image written with Sub, Up, Average and Paeth filters.
  const rows = [
    [1, 10, 20, 30, 5, 5, 5, 5, 5, 5],
    [4, 1, 2, 3, 1, 2, 3, 1, 2, 3]
  ]
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(3, 0)
  ihdr.writeUInt32BE(2, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4)
    len.writeUInt32BE(data.length)
    return Buffer.concat([len, Buffer.from(type), data, Buffer.alloc(4)])
  }
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.from(rows.flat()))), chunk('IEND', Buffer.alloc(0))])
  const d = decodePng(png)
  // Row 0 (Sub): 10,20,30 then +5 each.
  assert.deepEqual([...d.data.subarray(0, 12)], [10, 20, 30, 255, 15, 25, 35, 255, 20, 30, 40, 255])
  // Row 1 (Paeth): first pixel predicts from up (10,20,30).
  assert.deepEqual([...d.data.subarray(12, 15)], [11, 22, 33])
  assert.throws(() => decodePng(Buffer.from('nope')), /not a PNG/)
})

// ---------------------------------------------------------------- the service

function fakeMemory() {
  const saved: { name: string; body: string; kind?: string }[] = []
  return { saved, remember: async (input: { name: string; body: string; kind?: 'memory' | 'skill' }) => (saved.push(input), { entry: { name: input.name } }) }
}

type Call = { url: string; method: string; headers: Record<string, string>; body?: string | Uint8Array }

function fakeFetch(handler: (c: Call) => { status?: number; body: unknown }): { fetch: ArtFetch; calls: Call[] } {
  const calls: Call[] = []
  const fetch: ArtFetch = async (url, init) => {
    const c = { url, method: init?.method ?? 'GET', headers: init?.headers ?? {}, body: init?.body }
    calls.push(c)
    const r = handler(c)
    const status = r.status ?? 200
    return { status, ok: status >= 200 && status < 300, headers: { get: () => null }, text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)) }
  }
  return { fetch, calls }
}

test('texture service: procedural items, gen-ref materialisation (deduped), ratings into memory', async () => {
  const dir = await tmp('svc')
  const root = await tmp('proj')
  const memory = fakeMemory()
  const svc = new TextureService({ userDir: dir, projectRoot: () => root, memory, now: () => Date.UTC(2026, 9, 13) })
  const [ring] = await svc.generate({ procedural: { type: 'ring', params: { thickness: 0.05 } }, frames: 16 })
  assert.equal(ring.scope, 'project', 'project scope by default when a project is open')
  assert.equal(ring.flipbook?.layout, 'Grid4x4')
  assert.equal(ring.size, 1024)
  const png = decodePng(await readFile(join(root, '.forge/vfx/textures', ring.id, 'texture.png')))
  assert.equal(png.width, 1024)
  const preview = decodePng(await readFile(join(root, '.forge/vfx/textures', ring.id, 'preview.png')))
  assert.equal(preview.data[3], 255, 'the preview is opaque (premultiplied on black)')
  const [mine] = await svc.generate({ kind: 'smoke', scope: 'user' })
  assert.equal(mine.scope, 'user')
  assert.equal(mine.procedural?.type, 'smoke')
  assert.equal(mine.tint, 'grey', 'smoke defaults to greyscale')
  await assert.rejects(svc.generate({ kind: 'wisp' }), /No procedural generator/)
  // Preview data URLs: library files and gen refs.
  assert.match((await svc.resolve(texRef(ring.id)))!, /^data:image\/png;base64,/)
  assert.match((await svc.resolve(genRef('star')))!, /^data:image\/png;base64,/)
  assert.equal(await svc.resolve('forgetex://missing-000000'), null)
  // Materialisation: two layers asking for the same gen ref share one new item; a flipbook gets its layout.
  const fx: VfxEffect = { name: 'M', duration: 1, cues: [], roots: [nodeWith('A', 'ParticleEmitter', { Texture: genRef('crack') }), nodeWith('B', 'ParticleEmitter', { Texture: genRef('crack') }), nodeWith('C', 'ParticleEmitter', { Texture: texRef(ring.id) })] }
  const before = (await svc.list()).length
  const prepared = await svc.prepareEffect(fx)
  assert.equal((await svc.list()).length, before + 1)
  assert.equal(prepared.roots[0].props.Texture, prepared.roots[1].props.Texture)
  assert.match(String(prepared.roots[0].props.Texture), /^forgetex:\/\/[a-z]/)
  assert.equal(prepared.roots[2].props.FlipbookLayout, 'Grid4x4')
  await svc.prepareEffect(fx)
  assert.equal((await svc.list()).length, before + 1, 'the same request reuses the item')
  // Ratings feed memory (liked skill, avoid note).
  await svc.rate(ring.id, 'up')
  await svc.rate(mine.id, 'down')
  assert.ok(memory.saved.some((m) => m.name === 'vfx-textures-liked' && m.body.includes(texRef(ring.id))))
  assert.ok(memory.saved.some((m) => m.name === 'vfx-textures-avoid' && m.body.includes('smoke')))
  const lines = await svc.promptList()
  // Policy line first, then the library by kind (liked first); disliked only in the "never use" line.
  assert.match(lines[0], /LIBRARY FIRST/)
  assert.ok(lines.find((l) => /^\w+: forgetex:\/\//.test(l))!.includes(ring.id), 'liked first')
  assert.ok(!lines.some((l) => l.includes(mine.id) && !l.startsWith('Never use')), 'disliked never offered')
  assert.equal((await svc.update(ring.id, { tags: ['Shock', 'ring'] })).tags.join(','), 'shock,ring')
  assert.equal(await svc.remove(mine.id), true)
})

// A 64x64 opaque PNG on black with a bright blob off-centre, base64 (what a model that ignores
// "transparent background" returns).
function fakeGeneration(): string {
  const img = opaqueDot(64, [0, 0, 0], [180, 220, 255], [24, 40], 12)
  return encodePng(img).toString('base64')
}

test('AI textures: OpenAI request (transparent PNG), post-processing, flipbook from variants, budget', async () => {
  const dir = await tmp('ai')
  const { fetch, calls } = fakeFetch((c) => {
    const n = JSON.parse(String(c.body)).n as number
    return { body: { data: Array.from({ length: n }, () => ({ b64_json: fakeGeneration() })) } }
  })
  let spentArt = 0
  const svc = new TextureService({ userDir: dir, projectRoot: () => null, openAiKey: async () => 'sk-test', imageSettings: () => ({ model: 'gpt-image-2.5-flare', quality: 'high', dailyCapUsd: 1 }), artSpentToday: async () => spentArt, fetch, sleep: async () => undefined })
  const items = await svc.generate({ ai: true, kind: 'wisp', description: 'purple energy wisp', n: 2 })
  assert.equal(items.length, 2)
  const body = JSON.parse(String(calls[0].body))
  assert.equal(calls[0].url, 'https://api.openai.com/v1/images/generations')
  assert.equal(body.background, 'transparent')
  assert.equal(body.output_format, 'png')
  assert.equal(body.quality, 'medium', 'sprites use medium quality, not the Art page high')
  assert.equal(body.size, '1024x1024')
  assert.match(body.prompt, /purple energy wisp/)
  assert.match(body.prompt, /Transparent background/)
  assert.equal(calls[0].headers.authorization, 'Bearer sk-test')
  const t = items[0]
  assert.equal(t.source, 'ai')
  assert.ok(t.costUsd! > 0)
  const png = decodePng(await svc.user.readFile(t.id, 'texture.png'))
  const s = imageStats(png)
  assert.equal(png.width, 512)
  assert.equal(s.edgeAlpha, 0)
  assert.ok(Math.abs(s.centroid[0] - 0.5) < 0.05, 'the off-centre blob was centred')
  // Four variants on a 2x2 sheet.
  const [sheet] = await svc.generate({ ai: true, kind: 'smoke', description: 'puff', frames: 4 })
  assert.equal(sheet.flipbook?.layout, 'Grid2x2')
  assert.equal(JSON.parse(String(calls[1].body)).n, 4)
  // Budget: Art spend counts too.
  spentArt = 0.99
  await assert.rejects(svc.generate({ ai: true, kind: 'wisp', description: 'more' }), /daily|budget/i)
  const noKey = new TextureService({ userDir: dir, projectRoot: () => null })
  await assert.rejects(noKey.generate({ ai: true, kind: 'wisp', description: 'x' }), /OpenAI API key/)
})

test('upload: Open Cloud Image asset, operation polling, moderation state and re-check', async () => {
  const dir = await tmp('up')
  let polls = 0
  const { fetch, calls } = fakeFetch((c) => {
    if (c.method === 'POST' && c.url.endsWith('/assets/v1/assets')) return { body: { path: 'operations/op-1', done: false } }
    if (c.url.includes('/operations/op-1')) return polls++ ? { body: { path: 'operations/op-1', done: true, response: { assetId: '424242', moderationResult: { moderationState: 'MODERATION_STATE_REVIEWING' } } } } : { body: { path: 'operations/op-1', done: false } }
    if (c.url.includes('/assets/v1/assets/424242')) return { body: { assetId: '424242', moderationResult: { moderationState: 'Approved' } } }
    return { status: 404, body: {} }
  })
  const svc = new TextureService({ userDir: dir, projectRoot: () => null, robloxKey: async () => 'rbx-key', creator: () => ({ userId: 77 }), fetch, sleep: async () => undefined })
  const [t] = await svc.generate({ procedural: { type: 'glow' } })
  await assert.rejects(svc.checkModeration(t.id), /not uploaded/)
  const up = await svc.upload(t.id)
  assert.equal(up.roblox?.uri, 'rbxassetid://424242')
  assert.equal(up.roblox?.moderation, 'Reviewing')
  const create = calls[0]
  assert.equal(create.headers['x-api-key'], 'rbx-key')
  const text = Buffer.from(create.body as Uint8Array).toString('latin1')
  assert.match(text, /"assetType":"Image"/, 'particle textures upload as Image, never Decal')
  assert.match(text, /"userId":"77"/)
  assert.match(text, /Content-Type: image\/png/)
  const checked = await svc.checkModeration(t.id)
  assert.equal(checked.roblox?.moderation, 'Approved')
  assert.match(calls[calls.length - 1].url, /assets\/424242\?readMask=moderationResult$/)
  // Export now uses the asset id.
  const plan = await svc.exportEffect({ name: 'E', duration: 1, cues: [], roots: [nodeWith('A', 'ParticleEmitter', { Texture: texRef(t.id) })] })
  assert.equal(plan.effect.roots[0].props.Texture, 'rbxassetid://424242')
  const noKey = new TextureService({ userDir: dir, projectRoot: () => null })
  await assert.rejects(noKey.upload(t.id), /Open Cloud API key/)
  assert.equal(normalizeModeration('MODERATION_STATE_REJECTED'), 'Rejected')
  assert.equal(normalizeModeration(undefined), 'Unknown')
})

test('VFX service: previews forgetex refs, materialises on save, writes rbxassetid (or a fallback) to the project', async () => {
  const dir = await tmp('vfx')
  const root = await tmp('vfxproj')
  const { fetch } = fakeFetch((c) => (c.method === 'POST' ? { body: { path: 'operations/o', done: true, response: { assetId: '9001', moderationResult: { moderationState: 'Approved' } } } } : { status: 404, body: {} }))
  const textures = new TextureService({ userDir: dir, projectRoot: () => root, robloxKey: async () => 'k', creator: () => ({ groupId: 5 }), fetch, sleep: async () => undefined })
  const logs: string[] = []
  const vfx = new VfxService({ userDir: dir, projectRoot: () => root, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, textures, log: (t) => logs.push(t) })
  const [glow] = await textures.generate({ procedural: { type: 'glow' } })
  assert.match((await vfx.resolveTexture(texRef(glow.id)))!, /^data:image\/png/)
  const { entry } = await vfx.create({ name: 'TexTest', duration: 1, layers: [{ name: 'Core', class: 'ParticleEmitter', props: { Texture: texRef(glow.id) }, emit: [{ at: 0, count: 5 }] }, { name: 'Ring', class: 'ParticleEmitter', props: { Texture: genRef('ring') }, emit: [{ at: 0, count: 1 }] }] } as never)
  const ringRef = String(entry.effect!.roots.flatMap(function all(n): VfxNode[] {
    return [n, ...n.children.flatMap(all)]
  }).find((n) => n.name === 'Ring')!.props.Texture)
  assert.match(ringRef, /^forgetex:\/\/(?!gen\/)/, 'the gen request became a library item')
  const rbxmx = await readFile(join(root, entry.written!.model), 'utf8')
  assert.doesNotMatch(rbxmx, /forgetex:/, 'nothing Roblox cannot load reaches the project')
  assert.match(rbxmx, /sparkles_main\.dds/)
  assert.ok(logs.some((l) => /not uploaded/.test(l)))
  // Upload the glow, write again: the asset id lands in the project; the library keeps the local ref.
  await textures.upload(glow.id)
  const again = await vfx.writeProjectFiles(entry)
  const rbxmx2 = await readFile(join(root, again.written!.model), 'utf8')
  assert.match(rbxmx2, /rbxassetid:\/\/9001/)
  const lua = await readFile(join(root, again.written!.module), 'utf8')
  assert.doesNotMatch(lua, /forgetex:/)
  assert.ok(JSON.stringify((await vfx.get(entry.id)).effect).includes(texRef(glow.id)))
})

test('agent tools: vfx_texture_generate (procedural) and vfx_texture_list', async () => {
  const dir = await tmp('tools')
  const svc = new TextureService({ userDir: dir, projectRoot: () => null })
  const tools = textureTools(svc)
  const gen = tools.write.find((t) => t.name === 'vfx_texture_generate')!
  const r = await gen.handler({ type: 'shockwave', params: { thickness: 0.08 }, frames: 16 }, {})
  assert.ok(!r.isError, r.content[0].text)
  assert.match(r.content[0].text, /forgetex:\/\/[a-z0-9-]+ .*Grid4x4/)
  const bad = await gen.handler({ type: 'wisp', description: 'swirl' }, {})
  assert.ok(bad.isError, 'AI without a key is an error, not a crash')
  assert.match(bad.content[0].text, /OpenAI API key/)
  const list = await tools.read[0].handler({}, {})
  assert.match(list.content[0].text, /forgetex:\/\/gen\/<type>/)
  assert.match(list.content[0].text, /shockwave procedural/)
})
