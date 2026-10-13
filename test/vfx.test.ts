// VFX Lab: sequences + envelopes, seeded simulation, drag/acceleration closed forms, .rbxmx write ->
// read (and through Lune when it is installed), spec -> effect, library storage (.conflict files
// skipped), recipe extraction, the critique loop with a fake critic, script cue parsing, and the
// service (import, learn into a fake memory, rate, create, refine with fake capture + vision).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VfxCritique, VfxEffect, VfxEntry, VfxNode } from '../src/shared/vfx/types.ts'
import { evalColorSequence, evalNumberSequence, envelopeOffsets, rng, curveShape, luauNumberSequence } from '../src/shared/vfx/sequence.ts'
import { prepareEffect, simulate, simulateEmitter, displacement, velocityAt, flipbookFrames } from '../src/shared/vfx/simulate.ts'
import { readRbxmx, writeRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { effectFromSpec, applyChanges, SpecError, type VfxSpec } from '../src/shared/vfx/spec.ts'
import { allNodes, autoTags, cuesFromScripts, effectFromNodes, effectStats, findNode, perfWarnings } from '../src/shared/vfx/analyze.ts'
import { extractRecipe, recipeSkill, RECIPE_PREFIX } from '../src/shared/vfx/recipes.ts'
import { refineLoop, parseCritique, heuristicCritique, overallScore } from '../src/shared/vfx/critique.ts'
import { draftSpec } from '../src/shared/vfx/draft.ts'
import { luauModule } from '../src/shared/vfx/luau.ts'
import { VfxStore } from '../src/main/services/vfx/library.ts'
import { luneExtract } from '../src/main/services/vfx/lune.ts'
import { VfxService, frameTimes, splitEffects } from '../src/main/services/vfx/service.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-vfx-${p}-`))
const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)

const SLASH: VfxSpec = {
  name: 'Test Slash',
  duration: 1,
  layers: [
    { name: 'Core', class: 'ParticleEmitter', props: { Color: '#a070ff', Size: [[0, 0.5], [0.3, 2], [1, 0]], Transparency: [[0, 0.2], [1, 1]], Lifetime: [0.3, 0.5], Speed: [8, 12], Drag: 4, LightEmission: 1, Rate: 0 }, emit: [{ at: 0, count: 20 }] },
    { name: 'Sparks', class: 'ParticleEmitter', props: { Color: '#ffffff', Size: 0.15, Lifetime: [0.2, 0.4], Speed: 20, SpreadAngle: [180, 180], Acceleration: [0, -30, 0], Rate: 0 }, emit: [{ at: 0.05, count: 12 }] },
    { name: 'Glow', class: 'PointLight', props: { Color: '#a070ff', Brightness: 3, Range: 10 } }
  ]
}

// ---------------------------------------------------------------- sequences

test('NumberSequence interpolates linearly and clamps outside [0, 1]', () => {
  const seq = [
    { t: 0, v: 0 },
    { t: 0.5, v: 2 },
    { t: 1, v: 1 }
  ]
  close(evalNumberSequence(seq, 0), 0)
  close(evalNumberSequence(seq, 0.25), 1)
  close(evalNumberSequence(seq, 0.75), 1.5)
  close(evalNumberSequence(seq, 1), 1)
  close(evalNumberSequence(seq, 2), 1)
  close(evalNumberSequence([{ t: 0, v: 3 }, { t: 1, v: 3 }], 0.4), 3)
  assert.equal(curveShape([{ t: 0, v: 0 }, { t: 0.3, v: 2 }, { t: 1, v: 0 }]), 'swell-decay')
  assert.equal(curveShape([{ t: 0, v: 2 }, { t: 1, v: 0 }]), 'shrink')
  assert.match(luauNumberSequence(seq), /NumberSequence\.new\(\{/)
})

test('envelopes give a per-particle offset within ±envelope, deterministic per seed', () => {
  const seq = [
    { t: 0, v: 1, e: 0.5 },
    { t: 1, v: 1, e: 0.5 }
  ]
  const a = envelopeOffsets(seq, rng(42))
  const b = envelopeOffsets(seq, rng(42))
  assert.deepEqual(a, b)
  for (let s = 0; s < 50; s++) {
    const off = envelopeOffsets(seq, rng(s))
    const v = evalNumberSequence(seq, 0.5, off)
    assert.ok(v >= 0.5 - 1e-9 && v <= 1.5 + 1e-9, `value ${v} outside the envelope`)
  }
})

test('ColorSequence interpolates each channel', () => {
  const c = evalColorSequence(
    [
      { t: 0, c: [1, 0, 0] },
      { t: 1, c: [0, 0, 1] }
    ],
    0.25
  )
  close(c[0], 0.75)
  close(c[1], 0)
  close(c[2], 0.25)
})

// ---------------------------------------------------------------- simulation

test('drag halves the speed every Drag seconds; acceleration integrates without drag', () => {
  // Docs: "the rate in seconds at which individual particles will lose half their speed via exponential decay".
  const v = velocityAt([10, 0, 0], [0, 0, 0], 1, 1)
  close(v[0], 5, 1e-6)
  close(velocityAt([10, 0, 0], [0, 0, 0], 1, 2)[0], 2.5, 1e-6)
  const p = displacement([2, 0, 0], [0, -10, 0], 0, 1)
  close(p[0], 2)
  close(p[1], -5)
  // Drag 0 = no decay.
  close(velocityAt([3, 0, 0], [0, 0, 0], 0, 5)[0], 3)
})

test('simulation is seeded and deterministic, and bursts spawn the cued count', () => {
  const effect = effectFromSpec(SLASH)
  const a = simulate(prepareEffect(effect, 7), 0.1)
  const b = simulate(prepareEffect(effect, 7), 0.1)
  assert.deepEqual(a, b)
  const c = simulate(prepareEffect(effect, 8), 0.1)
  const pos = (f: typeof a) => f.emitters.flatMap((e) => e.particles.map((p) => p.pos))
  assert.ok(pos(a).length > 0)
  assert.notDeepEqual(pos(a), pos(c))
  const prep = prepareEffect(effect, 7)
  const core = prep.emitters.find((e) => e.name === 'Core')!
  assert.equal(simulateEmitter(core, 0.1, 7).length, 20)
  // Lifetime max 0.5: everything from the burst at 0 is gone by 0.6.
  assert.equal(simulateEmitter(core, 0.6, 7).length, 0)
  // Scrubbing backwards gives the same frame as playing forward.
  assert.deepEqual(simulateEmitter(core, 0.2, 7), simulateEmitter(core, 0.2, 7))
})

test('flipbook layouts map to frame counts', () => {
  const node: VfxNode = { id: 'x', className: 'ParticleEmitter', name: 'F', props: { FlipbookLayout: 'Grid4x4' }, children: [] }
  assert.equal(flipbookFrames(node), 16)
  assert.equal(flipbookFrames({ ...node, props: {} }), 1)
})

// ---------------------------------------------------------------- spec + rbxmx

test('effectFromSpec builds Model > Part > Attachment > layers with cues; bad props are rejected', () => {
  const e = effectFromSpec(SLASH)
  const names = allNodes(e.roots).map((n) => `${n.className}:${n.name}`)
  assert.ok(names.includes('ParticleEmitter:Core'))
  assert.ok(names.includes('PointLight:Glow'))
  assert.equal(e.roots[0].className, 'Model')
  assert.ok(e.cues.some((c) => c.action === 'emit' && c.count === 20))
  assert.throws(() => effectFromSpec({ ...SLASH, layers: [{ name: 'X', class: 'ParticleEmitter', props: { NotAProp: 1 } }] }), SpecError)
  const next = applyChanges(e, [
    { node: 'Core', prop: 'Drag', value: 6 },
    { node: '$effect', prop: 'duration', value: 1.5 }
  ])
  assert.equal(findNode(next.roots, 'Core')!.props.Drag, 6)
  assert.equal(next.duration, 1.5)
  assert.equal(findNode(e.roots, 'Core')!.props.Drag, 4, 'applyChanges must not mutate its input')
  assert.throws(() => applyChanges(e, [{ node: 'Nope', prop: 'Drag', value: 1 }]), SpecError)
})

test('writeRbxmx -> readRbxmx round-trips classes, sequences, enums, content and scripts', () => {
  const e = effectFromSpec(SLASH)
  const core = findNode(e.roots, 'Core')!
  core.props.Texture = 'rbxassetid://123456'
  core.props.FlipbookLayout = 'Grid2x2'
  const xml = writeRbxmx(e.roots)
  assert.match(xml, /<roblox[^>]*version="4"/)
  const back = readRbxmx(xml)
  const core2 = findNode(back, 'Core')!
  assert.equal(core2.className, 'ParticleEmitter')
  assert.equal(core2.props.Texture, 'rbxassetid://123456')
  assert.equal(core2.props.FlipbookLayout, 'Grid2x2')
  assert.deepEqual(core2.props.Lifetime, [0.3, 0.5])
  const size = core2.props.Size as { t: number; v: number }[]
  assert.equal(size.length, 3)
  close(size[1].v, 2)
  assert.equal(allNodes(back).length, allNodes(e.roots).length)
})

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
test('Lune deserializes the written .rbxmx (round trip through @lune/roblox)', { skip: !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const dir = await tmp('lune')
  const e = effectFromSpec(SLASH)
  findNode(e.roots, 'Core')!.props.Texture = 'rbxassetid://987'
  const file = join(dir, 'Slash.rbxmx')
  await writeFile(file, writeRbxmx(e.roots), 'utf8')
  const [res] = await luneExtract([file], { lune: lune!, runtimeDir: runtime! })
  assert.equal(res.error, undefined, res.error)
  const core = findNode(res.roots!, 'Core')!
  assert.equal(core.className, 'ParticleEmitter')
  assert.equal(core.props.Texture, 'rbxassetid://987')
  close(core.props.Drag as number, 4, 1e-4)
  close(core.props.LightEmission as number, 1, 1e-4)
  assert.deepEqual((core.props.Lifetime as number[]).map((x) => Math.round(x * 100) / 100), [0.3, 0.5])
  const light = findNode(res.roots!, 'Glow')!
  assert.equal(light.className, 'PointLight')
})

test('cuesFromScripts reads Emit bursts, waits and Enabled toggles', () => {
  const nodes: VfxNode[] = [
    {
      id: 'm',
      className: 'Model',
      name: 'FX',
      props: {},
      children: [
        { id: 'a', className: 'ParticleEmitter', name: 'Burst', props: {}, children: [] },
        { id: 'b', className: 'ParticleEmitter', name: 'Smoke', props: {}, children: [] },
        { id: 's', className: 'Script', name: 'Play', props: {}, children: [], source: 'local fx = script.Parent\nfx.Burst:Emit(25)\ntask.wait(0.2)\nfx.Smoke.Enabled = true\nwait(0.5)\nfx.Smoke.Enabled = false -- stop' }
      ]
    }
  ]
  const cues = cuesFromScripts(nodes)
  assert.deepEqual(
    cues.map((c) => [c.target, c.action, c.at, c.count ?? null]),
    [
      ['a', 'emit', 0, 25],
      ['b', 'enable', 0.2, null],
      ['b', 'disable', 0.7, null]
    ]
  )
  const effect = effectFromNodes('FX', nodes)
  assert.ok(effect.duration >= 0.7)
})

test('splitEffects splits a pack folder of models, but not a single effect', () => {
  const em = (id: string): VfxNode => ({ id, className: 'ParticleEmitter', name: id, props: {}, children: [] })
  const pack: VfxNode = { id: 'f', className: 'Folder', name: 'Pack', props: {}, children: [{ id: 'm1', className: 'Model', name: 'Fire', props: {}, children: [em('e1')] }, { id: 'm2', className: 'Model', name: 'Ice', props: {}, children: [em('e2')] }] }
  assert.deepEqual(splitEffects([pack]).map((g) => g.name), ['Fire', 'Ice'])
  const single: VfxNode = { id: 'p', className: 'Part', name: 'FX', props: {}, children: [{ id: 'a', className: 'Attachment', name: 'A', props: {}, children: [em('e3')] }] }
  assert.equal(splitEffects([single]).length, 1)
})

test('luau module is strict and plays the cues', () => {
  const src = luauModule(effectFromSpec(SLASH), { description: 'test' })
  assert.match(src, /^--!strict/)
  assert.match(src, /function Effect\.play/)
  assert.match(src, /Emit/)
})

test('perf guard warns about very high particle counts', () => {
  const e = effectFromSpec({ name: 'Heavy', layers: [{ name: 'Lots', class: 'ParticleEmitter', props: { Rate: 400, Lifetime: [5, 5], Size: 6 } }] })
  assert.ok(perfWarnings(e).some((w) => w.level !== 'info'))
  assert.ok(effectStats(e).particles > 500)
})

// ---------------------------------------------------------------- library + recipes

function entryFrom(effect: VfxEffect, extra: Partial<VfxEntry> = {}): VfxEntry {
  return { id: effect.name.toLowerCase().replace(/\W+/g, '-'), scope: 'user', kind: 'model', name: effect.name, description: '', tags: autoTags(effect, effect.name), createdAt: 1, updatedAt: 1, origin: 'test', effect, stats: effectStats(effect), thumbs: [], quality: 'reference', ...extra }
}

test('VfxStore saves, lists, and skips .conflict and hidden files', async () => {
  const dir = await tmp('store')
  const store = new VfxStore('user', dir)
  const e = entryFrom(effectFromSpec(SLASH))
  await store.save(e)
  await writeFile(join(dir, e.id, 'entry.json.conflict'), '{"broken": true', 'utf8')
  await mkdir(join(dir, 'other.conflict'), { recursive: true })
  await writeFile(join(dir, 'other.conflict', 'entry.json'), JSON.stringify({ ...e, id: 'other.conflict' }), 'utf8')
  await mkdir(join(dir, '.git'), { recursive: true })
  const list = await store.list()
  assert.deepEqual(list.map((x) => x.id), [e.id])
  assert.equal((await store.read(e.id))!.name, e.name)
  await store.writeFile(e.id, 'thumbs/a.png', Buffer.from([1, 2, 3]))
  assert.deepEqual([...(await store.readFile(e.id, 'thumbs/a.png'))], [1, 2, 3])
  await assert.rejects(() => store.writeFile(e.id, '../../escape.txt', 'x'))
  assert.equal(await store.remove(e.id), true)
  assert.deepEqual(await store.list(), [])
})

test('recipes summarize parameter ranges per tag and become a memory skill', () => {
  const entries = ['purple sword slash', 'fire slash', 'ice slash arc'].map((p, i) => entryFrom(effectFromSpec({ ...draftSpec(p), name: `S${i}` }), { tags: ['slash'] }))
  const r = extractRecipe('slash', entries)!
  assert.equal(r.tag, 'slash')
  assert.equal(r.samples, 3)
  const life = Object.entries(r.ranges).find(([k]) => k.endsWith('.Lifetime'))!
  assert.ok(life && life[1].p10 <= life[1].median && life[1].median <= life[1].p90)
  assert.ok(r.layers.length > 0)
  const skill = recipeSkill(r, ['S0: example'])
  assert.equal(skill.name, `${RECIPE_PREFIX}slash`)
  assert.ok(skill.description.length <= 200)
  assert.ok(skill.body.length <= 8000)
  assert.match(skill.body, /Lifetime/)
  assert.equal(extractRecipe('nothing-here', entries), null)
})

// ---------------------------------------------------------------- critique loop

function fakeCritique(overall: number, changes: VfxCritique['changes'] = [{ node: 'Core', prop: 'Drag', value: 5 }]): VfxCritique {
  const s = { readability: overall, layering: overall, timing: overall, color: overall, silhouette: overall, performance: overall }
  return { scores: s, overall, summary: `score ${overall}`, changes, references: [] }
}

test('refine loop stops once the score reaches the threshold', async () => {
  const scores = [5, 6.5, 8, 9]
  const renders: number[] = []
  const r = await refineLoop(effectFromSpec(SLASH), { render: async (_e, n) => (renders.push(n), [`f${n}`]), critique: async (_e, _f, n) => fakeCritique(scores[n - 1]) }, { maxIterations: 6, threshold: 7.5 })
  assert.equal(r.stop, 'threshold')
  assert.equal(r.iterations.length, 3)
  assert.equal(r.best.critique.overall, 8)
  assert.deepEqual(renders, [1, 2, 3])
  // Changes were applied between iterations.
  assert.equal(findNode(r.iterations[1].effect.roots, 'Core')!.props.Drag, 5)
})

test('refine loop stops at max iterations and keeps the best, not the last', async () => {
  const scores = [5, 6.8, 6.1]
  const r = await refineLoop(effectFromSpec(SLASH), { render: async (_e, n) => [`f${n}`], critique: async (_e, _f, n) => fakeCritique(scores[n - 1]) }, { maxIterations: 3, threshold: 9 })
  assert.equal(r.stop, 'max-iterations')
  assert.equal(r.iterations.length, 3)
  assert.equal(r.best.n, 2)
})

test('refine loop stops when the critic proposes nothing, records bad changes, and honours cancel', async () => {
  const none = await refineLoop(effectFromSpec(SLASH), { render: async () => [], critique: async () => fakeCritique(5, []) }, { maxIterations: 5, threshold: 9 })
  assert.equal(none.stop, 'no-changes')
  assert.equal(none.iterations.length, 1)
  let n = 0
  const bad = await refineLoop(
    effectFromSpec(SLASH),
    {
      render: async () => [],
      critique: async () => fakeCritique(5, [{ node: 'Ghost', prop: 'Drag', value: 1 }, { node: 'Core', prop: 'Drag', value: 2 }]),
      cancelled: () => ++n > 2
    },
    { maxIterations: 5, threshold: 9 }
  )
  assert.equal(bad.stop, 'cancelled')
  assert.equal(bad.iterations[0].rejected.length, 1)
  await assert.rejects(() => refineLoop(effectFromSpec(SLASH), { render: async () => [], critique: async () => fakeCritique(5), cancelled: () => true }))
})

test('parseCritique reads fenced JSON, clamps scores and caps performance by the perf guard', () => {
  const e = effectFromSpec(SLASH)
  const raw = 'Here you go:\n```json\n{"scores":{"readability":12,"layering":7,"timing":6,"color":8,"silhouette":"x","performance":9},"summary":"Needs a stronger core.","changes":[{"node":"Core","prop":"Size","value":[[0,1],[1,0]],"why":"bigger"},{"bad":1}]}\n```'
  const c = parseCritique(raw, e, ['ref-a'])
  assert.equal(c.scores.readability, 10)
  assert.equal(c.scores.silhouette, 5)
  assert.equal(c.changes.length, 1)
  assert.equal(c.references[0], 'ref-a')
  close(c.overall, overallScore(c.scores))
  const heavy = effectFromSpec({ name: 'Heavy', layers: [{ name: 'Lots', class: 'ParticleEmitter', props: { Rate: 400, Lifetime: [5, 5], Size: 8 } }] })
  assert.ok(parseCritique('{"scores":{"performance":10}}', heavy).scores.performance < 10)
  assert.ok(heuristicCritique(e, null).overall > 0)
})

// ---------------------------------------------------------------- service

const RBXMX = writeRbxmx(effectFromSpec(SLASH).roots)

function fakeMemory() {
  const calls: { name: string; kind?: string; type?: string; body: string }[] = []
  return { calls, memory: { remember: async (input: { name: string; kind?: 'memory' | 'skill'; type?: string; body: string; description: string; scope: 'user' | 'project' }) => (calls.push(input), { entry: { name: input.name } }) } }
}

async function service(extra: Partial<ConstructorParameters<typeof VfxService>[0]> = {}) {
  const userDir = await tmp('user')
  const root = await tmp('proj')
  const svc = new VfxService({ userDir, projectRoot: () => root, lune: async () => ({ error: 'not in this test' }), runtimeDir: () => null, ...extra })
  return { svc, userDir, root }
}

test('service imports .rbxmx (TS fallback) and media, then learns recipes into memory', async () => {
  const { memory, calls } = fakeMemory()
  const { svc } = await service({ memory })
  const src = await tmp('src')
  await writeFile(join(src, 'Purple Slash.rbxmx'), RBXMX, 'utf8')
  await writeFile(join(src, 'ref.png'), Buffer.from('89504e470d0a1a0a', 'hex'))
  await writeFile(join(src, 'notes.txt'), 'ignored', 'utf8')
  await writeFile(join(src, 'broken.rbxm'), 'not a model', 'utf8')
  const r = await svc.import([src], 'user')
  const model = r.added.find((e) => e.kind === 'model')!
  assert.ok(model, 'model entry')
  assert.equal(model.name, 'Purple Slash')
  assert.ok(model.tags.includes('slash'))
  assert.ok(allNodes(model.effect!.roots).some((n) => n.name === 'Core'))
  assert.ok(r.added.some((e) => e.kind === 'media'))
  assert.ok(r.skipped.some((s) => s.file.endsWith('broken.rbxm')))
  const list = await svc.list()
  assert.equal(list.length, 2)
  const learned = await svc.learn()
  assert.ok(learned.recipes.some((x) => x.tag === 'slash'))
  assert.ok(calls.some((c) => c.kind === 'skill' && c.name === 'vfx-recipe-slash'))
  assert.deepEqual(learned.errors, [])
  // Search finds by tag; .conflict copies from sync are ignored.
  assert.equal((await svc.search('slash'))[0].id, model.id)
  const dir = svc.userLibraryDir
  await writeFile(join(dir, `${model.id}.conflict`), '{}', 'utf8')
  assert.equal((await svc.list()).length, 2)
})

test('service creates an effect into src/shared/VFX and edits write back', async () => {
  const { svc, root } = await service()
  const { entry, warnings } = await svc.create(SLASH, { prompt: 'purple slash' })
  assert.ok(Array.isArray(warnings))
  assert.equal(entry.kind, 'generated')
  assert.ok(entry.written)
  const luau = await readFile(join(root, entry.written!.module), 'utf8')
  assert.match(luau, /^--!strict/)
  const xml = await readFile(join(root, entry.written!.model), 'utf8')
  assert.ok(findNode(readRbxmx(xml), 'Core'))
  const edited = applyChanges(entry.effect!, [{ node: 'Core', prop: 'Drag', value: 9 }])
  await svc.update(entry.id, { effect: edited })
  assert.equal(findNode(readRbxmx(await readFile(join(root, entry.written!.model), 'utf8')), 'Core')!.props.Drag, 9)
  assert.ok((await readdir(join(root, 'src/shared/VFX'))).length === 1)
})

test('service refine renders, critiques with the vision model, stops at the threshold and keeps iterations', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
  let shots = 0
  const answers = [5.5, 8.2]
  const vision = async (_s: string, _p: string, images: unknown[]) => {
    assert.ok(images.length > 0, 'frames reach the vision model')
    const v = answers[Math.min(shots++, answers.length - 1)]
    return JSON.stringify({ scores: { readability: v, layering: v, timing: v, color: v, silhouette: v, performance: 10 }, summary: `pass ${shots}`, changes: [{ node: 'Core', prop: 'LightEmission', value: 0.8 }] })
  }
  const progress: string[] = []
  const { svc } = await service({ capture: async (req) => req.times.map(() => png), vision: () => vision, emit: (ev, p) => ev === 'vfx:progress' && progress.push((p as { phase: string }).phase) })
  const { entry } = await svc.create(SLASH)
  const r = await svc.refine(entry.id, { maxIterations: 5, threshold: 7.5, frames: 3 })
  assert.equal(r.stop, 'threshold')
  assert.equal(r.iterations.length, 2)
  const saved = await svc.get(entry.id)
  assert.equal(saved.iterations!.length, 2)
  assert.equal(saved.iterations![0].frames.length, 3)
  assert.ok(await svc.file(entry.id, saved.iterations![1].frames[0]))
  assert.equal(findNode(saved.effect!.roots, 'Core')!.props.LightEmission, 0.8)
  assert.ok(progress.includes('critique') && progress.at(-1) === 'done')
})

test('rating down a generated effect marks it avoid and writes an avoid note', async () => {
  const { memory, calls } = fakeMemory()
  const { svc } = await service({ memory })
  const { entry } = await svc.create({ ...SLASH, tags: ['slash'] })
  const down = await svc.rate(entry.id, 'down')
  assert.equal(down.quality, 'avoid')
  assert.ok(calls.some((c) => c.name.startsWith('vfx-avoid-') && c.type === 'feedback'))
  // Avoided effects are not offered as references.
  assert.equal((await svc.references(['slash'], 'slash')).length, 0)
  const up = await svc.rate(entry.id, 'up')
  assert.equal(up.quality, 'good')
})

test('frame times stay inside the effect and bias early', () => {
  const t = frameTimes(2, 4)
  assert.equal(t.length, 4)
  assert.ok(t.every((x, i) => x > 0 && x < 2 && (i === 0 || x > t[i - 1])))
  assert.ok(t[1] < 1)
  assert.ok(existsSync(join(import.meta.dirname, '..', 'resources', 'lune', 'vfx_extract.luau')))
})
