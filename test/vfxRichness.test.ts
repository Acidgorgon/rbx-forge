// VFX richness: a library of rich, multi-layer effects (test/vfxEval/richLibrary.ts, auto-tagged
// like an import) must not turn into two-layer results. Richness measured against the closest
// effects, the guard on model / critic edits that hide layers, name matches in retrieval, compose
// built on a library copy (base names give way to spawns, the copy lands on the impact beat, the
// exported module plays its cues), sparse model specs enriched, the pick and the small-model hint;
// the service end to end with a fake small model; the richness benchmark held to a floor.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allNodes } from '../src/shared/vfx/analyze.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { alignBaseToStage, baseLayerLines, composeBase, enrichSpec, ground, pickByCode, singleCandidates, type Candidate } from '../src/shared/vfx/ground.ts'
import { luauModule } from '../src/shared/vfx/luau.ts'
import { extractRecipes } from '../src/shared/vfx/recipes.ts'
import { remixable } from '../src/shared/vfx/retrieve.ts'
import { asksSimpler, guardLayerEdits, hidesLayer, richness, richnessScore, richTarget, tooSimple } from '../src/shared/vfx/richness.ts'
import { applyChanges } from '../src/shared/vfx/spec.ts'
import { isSmallModel, smallModelHint } from '../src/shared/labModels.ts'
import type { VfxEntry } from '../src/shared/vfx/types.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { richLibrary } from './vfxEval/richLibrary.ts'
import { DOME_FLARE_OPS, formatRichReport, runRichEval, smallModelRemixChanges, smallModelSpec } from './vfxEval/rich.ts'

const lib = richLibrary()
const recipes = extractRecipes(lib)
const byName = (n: string) => lib.find((e) => e.name === n)!
const EMPTY = { name: 'Seq', roots: [], cues: [], duration: 2 }
const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()

test('richness: layers that show, roles, beams / trails and burst beats; hidden layers count as dead', () => {
  const hp = richness(byName('Hollow Purple').effect!)
  assert.ok(hp.layers >= 10 && hp.beams === 2 && hp.trails === 1, JSON.stringify(hp))
  assert.ok(hp.beats >= 3, 'staggered EmitDelay bursts are several beats')
  assert.ok(hp.roles.includes('beam') && hp.roles.includes('sparks'))
  // The dome + flare a small model composes: two layers, one of them a part.
  const dome = compileTimeline(EMPTY, DOME_FLARE_OPS, '-- x').effect
  const d = richness(dome)
  assert.equal(d.layers, 2)
  assert.equal(d.parts, 1)
  // Hiding layers: they stop counting.
  const e = byName('Nuke').effect!
  const gutted = applyChanges(e, smallModelRemixChanges(e))
  const r = richness(gutted)
  assert.equal(r.layers, 2)
  assert.ok(r.dead >= 8)
})

test('richness against the closest effects: the dome + flare is too simple, the library copy is not; "simple" requests are exempt', () => {
  const g = ground('purple energy blast', { entries: lib, recipes })
  assert.ok(g.target && g.target.layers >= 8, JSON.stringify(g.target))
  const dome = compileTimeline(EMPTY, DOME_FLARE_OPS, '-- x').effect
  assert.ok(richnessScore(dome, g.target) < 0.4)
  assert.ok(tooSimple(dome, g.target))
  assert.ok(!tooSimple(dome, g.target, 'a simple purple energy blast'))
  const copy = singleCandidates('purple energy blast', g, 1)[0]
  assert.equal(copy.how, 'remix')
  assert.equal(richnessScore(copy.effect, g.target), 1)
  assert.ok(!tooSimple(copy.effect, g.target))
  // The target is read from same-kind matches when there are any.
  const t = richTarget(g.matches)!
  assert.ok(t.from.length >= 1)
  assert.ok(asksSimpler('minimal mobile hit') && !asksSimpler('small fire slash') && !asksSimpler('holy light aura'))
})

test('model / critic edits that hide layers are dropped unless the request asks for less', () => {
  const e = byName('Hollow Purple').effect!
  const changes = smallModelRemixChanges(e)
  assert.ok(changes.filter((c) => hidesLayer(e, c)).length >= 10)
  const g = guardLayerEdits(e, changes, 'hollow purple but red')
  assert.equal(g.kept.length, 1, 'only the colour edit stays')
  assert.ok(g.dropped.length >= 10)
  assert.equal(guardLayerEdits(e, changes, 'a simpler hollow purple').dropped.length, 0)
  // Ordinary edits pass: fades that end at 1, fewer particles, a Rate 0 on a burst emitter.
  const n = allNodes(e.roots).find((x) => x.className === 'ParticleEmitter')!
  for (const c of [
    { node: n.id, prop: 'Transparency', value: [[0, 0], [1, 1]] },
    { node: n.id, prop: 'emit', value: [{ at: 0, count: 4 }] },
    { node: n.id, prop: 'Rate', value: 0 },
    { node: n.id, prop: 'Size', value: [[0, 1], [1, 0]] }
  ])
    assert.ok(!hidesLayer(e, c), JSON.stringify(c))
  for (const c of [
    { node: n.id, prop: 'Transparency', value: 1 },
    { node: n.id, prop: 'Enabled', value: false },
    { node: n.id, prop: 'emit', value: [] },
    { node: n.id, prop: 'Size', value: 0 }
  ])
    assert.ok(hidesLayer(e, c), JSON.stringify(c))
})

test('retrieval on an auto-tagged library: typical requests start from a copy; an effect named by name is the base', () => {
  for (const p of ['dark purple explosion', 'red lightning punch', 'fire slash', 'ice ground spikes', 'electric beam attack', 'water dragon']) {
    const g = ground(p, { entries: lib, recipes })
    assert.equal(singleCandidates(p, g, 1)[0].how, 'remix', p)
  }
  const named = ground('hollow purple but red', { entries: lib, recipes })
  assert.equal(named.matches[0].entry.name, 'Hollow Purple')
  assert.ok(named.matches[0].nameMatch && remixable(named.matches[0], named.req))
  const c = singleCandidates('hollow purple but red', named, 1)[0]
  assert.equal(c.how, 'remix')
  assert.ok(c.notes.some((n) => /recoloured/.test(n)))
  // The kind word does not hide the named effect (Black Flash is tagged a shockwave).
  const bf = ground('black flash impact', { entries: lib, recipes })
  assert.equal(bf.matches[0].entry.name, 'Black Flash')
})

test('compose on a library copy: unique names, spawns win name clashes, the copy lands on the impact beat', () => {
  const g = ground('purple energy blast', { entries: lib, recipes })
  const base = composeBase('purple energy blast', g)!
  assert.ok(base)
  const names = allNodes(base.effect.roots).map((n) => n.name.toLowerCase())
  assert.equal(new Set(names).size, names.length, 'every node name unique')
  assert.ok(baseLayerLines(base.effect).length >= 8)
  // The fake script spawns "Flare"; the copy has a layer called Flare.
  assert.ok(allNodes(base.effect.roots).some((n) => n.name === 'Flare'))
  const { effect, warnings } = compileTimeline({ ...base.effect, name: 'Seq' }, DOME_FLARE_OPS, '-- x')
  assert.ok(warnings.some((w) => /"Flare" is now "FlareLib"/.test(w)), warnings.join('; '))
  assert.ok(allNodes(effect.roots).some((n) => n.name === 'FlareLib'))
  const baseCues = effect.cues.filter((c) => !c.script && !c.spawn && !c.prelude)
  assert.ok(baseCues.length >= 8)
  assert.equal(Math.min(...baseCues.map((c) => c.at)), 0)
  const aligned = alignBaseToStage(effect)
  assert.equal(aligned.at, 0.3)
  const moved = aligned.effect.cues.filter((c) => !c.script && !c.spawn && !c.prelude)
  assert.ok(Math.abs(Math.min(...moved.map((c) => c.at)) - 0.3) < 1e-6)
  assert.ok(aligned.effect.duration >= Math.max(...moved.map((c) => c.at)))
  assert.ok(richness(aligned.effect).layers >= 11)
  // The exported module plays the copy's cues next to the Timeline module.
  const lua = luauModule(aligned.effect)
  assert.match(lua, /local BASE_CUES = \{/)
  assert.match(lua, /fx:runCues\(BASE_CUES\)\n\t\tfx:run\(require\(timeline\)/)
  // A script on an empty base exports as before.
  assert.doesNotMatch(luauModule(compileTimeline(EMPTY, DOME_FLARE_OPS, '-- x').effect), /BASE_CUES/)
  // A script that names one of its own rigs twice still fails.
  assert.throws(() => compileTimeline(EMPTY, [...DOME_FLARE_OPS, { op: 'spawn', at: 0.4, kind: 'flash', opts: { name: 'Flare' } }], '-- x'), /already used/)
})

test('a sparse model spec gets the starting draft layers back; the code pick prefers the richer variation', () => {
  const g = ground('healing rain', { entries: lib, recipes })
  const start = singleCandidates('healing rain', g, 1)[0]
  assert.equal(start.how, 'draft')
  const small = smallModelSpec('healing rain')
  const { spec, added } = enrichSpec(small, start.spec, g, 'healing rain')
  assert.ok(added.length >= 2, added.join(', '))
  assert.ok(spec.layers.length >= start.spec!.layers.length)
  assert.equal(enrichSpec(small, start.spec, g, 'a simple healing rain').added.length, 0)
  // Pick: the plain copy vs a gutted copy (the gutted one's few numbers all sit in range).
  const g2 = ground('fire slash', { entries: lib, recipes })
  const copy = singleCandidates('fire slash', g2, 1)[0]
  const gutted: Candidate = { ...copy, effect: applyChanges(copy.effect, smallModelRemixChanges(copy.effect)) }
  const pick = pickByCode([gutted, copy], g2)
  assert.equal(pick.index, 1)
  assert.ok(pick.scores[0].richness < 0.6 && pick.scores[1].richness >= 0.9)
})

test('small-model hint: Haiku / mini-class ids for drafting and critique, never for the cheap tier', () => {
  for (const m of ['claude-haiku-5-5', 'claude-3-5-haiku-latest', 'gpt-5-mini', 'gpt-4.1-nano', 'gemini-2.5-flash-lite', 'llama3.1:8b', 'gemma3']) assert.ok(isSmallModel(m), m)
  for (const m of ['claude-opus-5-5', 'claude-sonnet-5', 'gpt-5', 'gemini-2.5-pro', '', null]) assert.ok(!isSmallModel(m), String(m))
  assert.match(smallModelHint('default', 'claude-haiku-5-5')!, /Drafting on a small model \(claude-haiku-5-5\).*larger model/)
  assert.match(smallModelHint('critic', 'gpt-5-mini')!, /Critiquing on a small model/)
  assert.equal(smallModelHint('cheap', 'claude-haiku-5-5'), null)
  assert.equal(smallModelHint('default', 'claude-opus-5-5'), null)
})

// ---------------------------------------------------------------- service, fake small model

async function service(extra: Partial<ConstructorParameters<typeof VfxService>[0]> = {}, entries: VfxEntry[] = lib) {
  const userDir = await mkdtemp(join(tmpdir(), 'forge-vfxrich-user-'))
  const root = await mkdtemp(join(tmpdir(), 'forge-vfxrich-proj-'))
  const svc = new VfxService({ userDir, projectRoot: () => root, lune: async () => ({ error: 'not in this test' }), runtimeDir: () => null, ...extra })
  for (const e of entries) await svc.user.save(e)
  return svc
}

test('Make with a small model that guts the copy: every layer stays, the entry says what it kept and how rich it is', async () => {
  const prompts: string[] = []
  const vision = async (system: string, prompt: string) => {
    prompts.push(`${system}\n${prompt}`)
    const keys = [...prompt.matchAll(/"name":"([^"]+)","(?:label|class)"/g)].map((m) => m[1])
    return JSON.stringify({ name: 'RedHollow', changes: keys.slice(2).flatMap((k) => [{ node: k, prop: 'emit', value: [] }, { node: k, prop: 'Enabled', value: false }]) })
  }
  const svc = await service({ vision: () => vision })
  const { entry } = await svc.make('hollow purple but red')
  assert.match(prompts[0], /Keep every layer/)
  assert.doesNotMatch(prompts[0], /set its "emit" to \[\] and "Enabled" to false/)
  assert.match(prompts[0], /How rich the user's closest effects are/)
  assert.deepEqual(entry.basedOn?.[0], byName('Hollow Purple').id)
  assert.ok(richness(entry.effect!).layers >= 11, `${richness(entry.effect!).layers} layers`)
  assert.ok(entry.makeNotes!.some((n) => /kept the \d+ layers it tried to hide/.test(n)), entry.makeNotes!.join(' | '))
  assert.ok(entry.makeNotes!.some((n) => /^richness: \d+ layers/.test(n)))
  // Asking for less lets the model simplify.
  const { entry: simple } = await svc.make('a simpler hollow purple')
  assert.ok(richness(simple.effect!).layers < richness(entry.effect!).layers)
})

test('Make: no close effect -> the entry says why it drafted; a sparse spec is enriched', async () => {
  const vision = async () => JSON.stringify(smallModelSpec('healing rain'))
  const svc = await service({ vision: () => vision })
  const { entry } = await svc.make('healing rain')
  assert.ok(entry.makeNotes!.some((n) => /^drafted from the built-in archetype: your closest ".+" is not close enough/.test(n)), entry.makeNotes!.join(' | '))
  assert.ok(entry.makeNotes!.some((n) => /the model's draft had 2 layers; added/.test(n)))
  assert.ok(allNodes(entry.effect!.roots).filter((n) => n.className === 'ParticleEmitter').length >= 5)
})

test('compose (the default sequence mode) with a small model: built on the library copy, never just a dome and a flare', { skip: !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const prompts: string[] = []
  const dome = '```lua\n-- Name: PurpleBlast\nreturn function(fx)\n\tfx:stage("charge")\n\tfx:wait(0.3)\n\tfx:stage("impact")\n\tfx:spawn("shockwave", { name = "Dome", color = Color3.fromRGB(160, 80, 255), size = 14 })\n\tfx:spawn("flash", { name = "Flare" })\n\tfx:wait(0.5)\n\tfx:stage("dissipate")\nend\n```'
  const vision = async (_s: string, prompt: string) => (prompts.push(prompt), dome)
  const svc = await service({ vision: () => vision, lune: async () => ({ path: lune! }), runtimeDir: () => runtime })
  const r = await svc.compose('purple energy blast', { variations: 1, refine: false })
  assert.ok(r.ok, r.error?.message)
  assert.match(prompts[0], /The effect already holds a copy of the user's "/)
  assert.match(prompts[0], /fx:stage\("impact"\)/)
  const e = r.entry!
  const rich = richness(e.effect!)
  assert.ok(rich.layers >= 11, JSON.stringify(rich))
  assert.ok(e.effect!.script?.includes('shockwave'))
  assert.ok(e.basedOn?.length && lib.some((x) => x.id === e.basedOn![0]))
  assert.ok(e.makeNotes!.some((n) => /started from your effect/.test(n)))
  assert.ok(e.makeNotes!.some((n) => /^richness: /.test(n)) && !e.makeNotes!.some((n) => /sparser than your/.test(n)))
  // The copy plays on the impact beat.
  const baseCues = e.effect!.cues.filter((c) => !c.script && !c.spawn && !c.prelude)
  assert.ok(Math.abs(Math.min(...baseCues.map((c) => c.at)) - 0.3) < 0.01)
  // No model: the Lab's own choreography around the copy.
  const svc2 = await service({ lune: async () => ({ path: lune! }), runtimeDir: () => runtime })
  const r2 = await svc2.compose('purple energy blast', { refine: false })
  assert.ok(r2.ok, r2.error?.message)
  assert.match(r2.entry!.effect!.script!, /built on your "/)
  assert.ok(richness(r2.entry!.effect!).layers >= 11)
  // Nothing close in the library and a sparse script: the built-in draft sequence wins the pick.
  const svc3 = await service({ vision: () => vision, lune: async () => ({ path: lune! }), runtimeDir: () => runtime })
  const r3 = await svc3.compose('healing rain', { variations: 1, refine: false })
  assert.ok(r3.ok)
  assert.ok(richness(r3.entry!.effect!).layers > 2, 'not the dome + flare')
  assert.ok(r3.entry!.makeNotes!.some((n) => /^composed from kit rigs: /.test(n)))
})

test('richness benchmark (small-model fake) holds its floor', async () => {
  const r = await runRichEval({ lune: lune && runtime ? { lune, runtimeDir: runtime } : null })
  const text = formatRichReport(r)
  assert.ok(r.mean.make.after >= 0.9 && r.mean.make.after >= r.mean.make.before + 0.3, text)
  assert.ok(r.mean.pick.after >= 0.9 && r.mean.pick.after > r.mean.pick.before, text)
  assert.ok(r.mean.compose.after >= 0.9 && r.mean.compose.after >= r.mean.compose.before + 0.5, text)
  assert.ok(r.tooSimple.after <= 4 && r.tooSimple.before >= 20, text)
  assert.equal(r.remixed.after, r.remixed.of, text)
  // Every prompt with a library base: the composed result is never the bare dome + flare.
  for (const row of r.rows) if (row.base !== 'draft') assert.ok(row.compose.after.layers >= row.target, `${row.prompt}: ${row.compose.after.layers} layers`)
})
