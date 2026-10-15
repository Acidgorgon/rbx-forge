// Building on a scripted library effect (the user's HollowPurple: orbs that converge and merge, made
// by a timeline script): grounding finds it by name and builds on its script instead of a copy of its
// layers played as one burst; a request that is just its name is a faithful copy (the script
// re-recorded), a model edits the script itself, no model writes the request's colour into it; single
// Make hands a scripted match to the sequence path; non-scripted bases keep the copy-at-impact path.
// The "From scratch" toggle: never a copy, remix or script reuse, the library only a style guide.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allNodes, describeEffect, effectStats } from '../src/shared/vfx/analyze.ts'
import { compileTimeline, finishRun } from '../src/shared/vfx/compile.ts'
import { findExample, HOLLOW_PURPLE } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { composeBase, ground, scratchCandidate, scriptedBase, singleCandidates, tweakScript } from '../src/shared/vfx/ground.ts'
import { recolorScript, rescaleScript } from '../src/shared/vfx/remix.ts'
import { richness } from '../src/shared/vfx/richness.ts'
import { applyChanges } from '../src/shared/vfx/spec.ts'
import { autoTagGroups, flatTags } from '../src/shared/vfx/tags.ts'
import type { VfxEffect, VfxEntry } from '../src/shared/vfx/types.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { luneTimeline } from '../src/main/services/vfx/lune.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { richLibrary, RICH_TEX } from './vfxEval/richLibrary.ts'

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
const noLune = !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false
const BLANK = (name: string): VfxEffect => ({ name, roots: [], cues: [], duration: 2 })

// The user's own HollowPurple: the example's script with two real texture ids passed to kit spawns,
// plus a texture set later in the parameter editor (a patch).
const TEX_A = 'rbxassetid://11122233'
const TEX_B = 'rbxassetid://44455566'
const TEX_PATCH = 'rbxassetid://77788899'
const USER_SCRIPT = HOLLOW_PURPLE.replace('{ name = "MergeSparks", ', `{ name = "MergeSparks", texture = "${TEX_A}", `).replace('{ name = "PurpleGather", ', `{ name = "PurpleGather", texture = "${TEX_B}", `)

function entryOf(effect: VfxEffect, over: Partial<VfxEntry> = {}): VfxEntry {
  const { groups } = autoTagGroups(effect, over.origin ?? effect.name)
  return { id: 'user-hollow-purple', scope: 'user', kind: 'model', name: effect.name, description: describeEffect(effect), tags: [...flatTags(groups), 'sequence'], tagGroups: groups, createdAt: 1, updatedAt: 1, origin: 'HollowPurple.rbxm', effect, stats: effectStats(effect), thumbs: [], ...over } as VfxEntry
}

// The example's recorded ops (no Lune): structure for the pure grounding tests.
function exampleEntry(over: Partial<VfxEntry> = {}): VfxEntry {
  const ex = findExample('hollow-purple')!
  const { effect } = compileTimeline(BLANK('HollowPurple'), RECORDED[ex.key], ex.script)
  return entryOf(effect, { kind: 'generated', origin: 'example:hollow-purple', ...over })
}

// The library: rich imported effects (minus their non-scripted Hollow Purple) + the scripted one.
const others = () => richLibrary().filter((e) => e.name !== 'Hollow Purple')

async function userHollowPurple(): Promise<VfxEntry> {
  const rec = await luneTimeline(USER_SCRIPT, { lune: lune!, runtimeDir: runtime! })
  const run = finishRun(BLANK('HollowPurple'), USER_SCRIPT, rec)
  assert.ok(run.ok && run.effect, run.error?.message)
  const em = allNodes(run.effect!.roots).find((n) => n.className === 'ParticleEmitter' && n.name.startsWith('Blue'))!
  const effect = applyChanges(run.effect!, [{ node: em.name, prop: 'Texture', value: TEX_PATCH }])
  assert.equal(effect.patches?.length, 1)
  return entryOf(effect)
}

const texturesOf = (e: VfxEffect) => new Set(allNodes(e.roots).map((n) => n.props.Texture).filter((t): t is string => typeof t === 'string'))
const emitterNames = (e: VfxEffect) => allNodes(e.roots).filter((n) => ['ParticleEmitter', 'Beam', 'Trail'].includes(n.className)).map((n) => n.name).sort()

async function service(entries: VfxEntry[], extra: Partial<ConstructorParameters<typeof VfxService>[0]> = {}) {
  const userDir = await mkdtemp(join(tmpdir(), 'forge-vfxscript-user-'))
  const root = await mkdtemp(join(tmpdir(), 'forge-vfxscript-proj-'))
  const svc = new VfxService({ userDir, projectRoot: () => root, lune: async () => (lune ? { path: lune } : { error: 'no lune' }), runtimeDir: () => runtime, ...extra })
  for (const e of entries) await svc.user.save(e)
  return svc
}

test('grounding: "hollow purple" names a scripted effect, so it is built on its script (composeBase never sees it)', () => {
  const lib = [...others(), exampleEntry()]
  const g = ground('hollow purple', { entries: lib })
  assert.equal(g.matches[0].entry.name, 'HollowPurple')
  assert.ok(g.matches[0].nameMatch)
  // The bug: the scripted match is skipped by the copy path, so the sequence had nothing of it.
  assert.equal(composeBase('hollow purple', g), null)
  assert.notEqual(singleCandidates('hollow purple', g, 1)[0].how, 'remix')
  const sb = scriptedBase('hollow purple', g)!
  assert.ok(sb, 'the scripted match is the base')
  assert.equal(sb.match.entry.name, 'HollowPurple')
  assert.equal(sb.asIs, true)
  assert.equal(sb.effect.script, g.matches[0].entry.effect!.script)
  assert.deepEqual(sb.effect.stages, g.matches[0].entry.effect!.stages)
  for (const q of ['Make Hollow Purple', 'my hollow purple effect again']) assert.equal(scriptedBase(q, ground(q, { entries: lib }))?.asIs, true, q)
  // A change asked for: not as is; the colour turn is worked out.
  const red = scriptedBase('hollow purple but red', ground('hollow purple but red', { entries: lib }))!
  assert.deepEqual(red.extra, ['red'])
  assert.equal(red.asIs, false)
  assert.ok(red.hueDelta !== 0)
  const t = tweakScript(red)
  assert.notEqual(t.script, sb.effect.script)
  assert.doesNotMatch(t.script, /Color3\.fromRGB\(176, 92, 255\)/)
  assert.match(t.script, /fx:stage\("converge"\)/)
  assert.ok(t.notes.some((n) => /recoloured in its script/.test(n)))
  // Non-scripted libraries keep the copy-at-impact path.
  const plain = ground('hollow purple', { entries: richLibrary() })
  assert.equal(scriptedBase('hollow purple', plain), null)
  assert.ok(composeBase('hollow purple', plain))
  // An unrated earlier Lab result that is merely close (not named) is not built on.
  const old = exampleEntry({ id: 'old', name: 'Sequence7', origin: 'purple energy blast' })
  const og = ground('purple energy blast', { entries: [...richLibrary(), old] })
  assert.equal(og.matches[0].entry.id, 'old', 'it is the closest')
  assert.notEqual(scriptedBase('purple energy blast', og)?.match.entry.id, 'old')
})

test('script tweaks: colour literals turn, whites stay; sizes scale', () => {
  const s = 'local A = Color3.fromRGB(255, 55, 70)\nlocal W = Color3.new(1, 1, 1)\nlocal H = Color3.fromHex("#46a0ff")\nfx:spawn("orb", { size = 2, width = 1.5 })'
  const r = recolorScript(s, 120)
  assert.equal(r.changed, 2)
  assert.match(r.script, /Color3\.new\(1, 1, 1\)/)
  assert.doesNotMatch(r.script, /fromRGB\(255, 55, 70\)/)
  assert.doesNotMatch(r.script, /#46a0ff/)
  assert.equal(recolorScript(s, 0).script, s)
  const k = rescaleScript(s, 1.5)
  assert.equal(k.changed, 2)
  assert.match(k.script, /size = 3, width = 2\.25/)
})

test('compose "hollow purple" without a model: the user\'s script re-recorded as written, every layer and texture kept', { skip: noLune }, async () => {
  const hp = await userHollowPurple()
  const svc = await service([...others(), hp])
  const r = await svc.compose('hollow purple', { refine: false })
  assert.ok(r.ok, r.error?.message)
  const e = r.entry!
  assert.equal(r.source, 'library')
  assert.equal(e.name, 'HollowPurple')
  assert.equal(e.effect!.script, USER_SCRIPT, 'the same script')
  assert.deepEqual(e.effect!.stages, hp.effect!.stages, 'the same choreography')
  assert.deepEqual(emitterNames(e.effect!), emitterNames(hp.effect!), 'the same layers')
  assert.equal(richness(e.effect!).layers, richness(hp.effect!).layers)
  assert.equal(e.effect!.cues.length, hp.effect!.cues.length)
  for (const t of [TEX_A, TEX_B, TEX_PATCH]) assert.ok(texturesOf(e.effect!).has(t), `keeps ${t}`)
  assert.deepEqual(e.effect!.patches, hp.effect!.patches)
  assert.equal(e.basedOn?.[0], hp.id)
  assert.ok(e.makeNotes!.some((n) => /^built on your scripted "HollowPurple" \(its timeline script: blue > red > converge > merge/.test(n)), e.makeNotes!.join(' | '))
  assert.ok(e.makeNotes!.some((n) => /a faithful copy/.test(n)))
  assert.ok(!e.makeNotes!.some((n) => /composed from kit rigs/.test(n)))
  assert.match(e.description, /built on your "HollowPurple"/)
  assert.equal(e.modelNote, undefined)
  // A colour asked for, no model: written into the script, which still records the same beats.
  const red = await svc.compose('hollow purple but red', { refine: false })
  assert.ok(red.ok, red.error?.message)
  assert.notEqual(red.entry!.effect!.script, USER_SCRIPT)
  assert.doesNotMatch(red.entry!.effect!.script!, /Color3\.fromRGB\(176, 92, 255\)/)
  assert.deepEqual(red.entry!.effect!.stages!.map((s) => s.label), hp.effect!.stages!.map((s) => s.label))
  assert.deepEqual(emitterNames(red.entry!.effect!), emitterNames(hp.effect!))
  for (const t of [TEX_A, TEX_B, TEX_PATCH]) assert.ok(texturesOf(red.entry!.effect!).has(t))
  assert.ok(red.entry!.makeNotes!.some((n) => /recoloured in its script/.test(n)), red.entry!.makeNotes!.join(' | '))
})

test('compose with a model: it gets the user\'s script to edit, and the result is built on it', { skip: noLune }, async () => {
  const hp = await userHollowPurple()
  const prompts: string[] = []
  const edited = `-- Name: HollowPurpleRed\n${USER_SCRIPT.replace('fx:stage("dissipate")', 'fx:spawn("ring", { name = "ExtraRing", color = Color3.fromRGB(255, 60, 60), size = 9 })\n\tfx:stage("dissipate")')}`
  const vision = async (_s: string, prompt: string) => (prompts.push(prompt), '```lua\n' + edited + '```')
  const svc = await service([...others(), hp], { vision: () => vision })
  const r = await svc.compose('hollow purple with an extra red ring at the end', { refine: false, variations: 1 })
  assert.ok(r.ok, r.error?.message)
  assert.equal(r.source, 'model')
  assert.ok(prompts[0].includes(USER_SCRIPT.trim().split('\n').slice(4, 10).join('\n')), 'the prompt holds the original script')
  assert.match(prompts[0], /Apply only the changes the request asks for/)
  assert.ok(prompts[0].includes(TEX_A))
  assert.doesNotMatch(prompts[0], /The effect already holds a copy/)
  const e = r.entry!
  assert.equal(e.name, 'HollowPurpleRed')
  assert.match(e.effect!.script!, /ExtraRing/)
  assert.deepEqual(e.effect!.stages!.map((s) => s.label), hp.effect!.stages!.map((s) => s.label))
  for (const n of emitterNames(hp.effect!)) assert.ok(emitterNames(e.effect!).includes(n), `keeps ${n}`)
  for (const t of [TEX_A, TEX_B, TEX_PATCH]) assert.ok(texturesOf(e.effect!).has(t))
  assert.equal(e.basedOn?.[0], hp.id)
  assert.ok(e.makeNotes!.some((n) => /^built on your scripted "HollowPurple"/.test(n)))
  assert.ok(e.makeNotes!.some((n) => /the model edited its script/.test(n)))
  // "hollow purple" alone: no model call, the faithful copy.
  const before = prompts.length
  const same = await svc.compose('hollow purple', { refine: false })
  assert.equal(prompts.length, before)
  assert.equal(same.entry!.effect!.script, USER_SCRIPT)
  // A model that rewrites it into two layers: the script as written joins and wins the pick.
  const dome = '```lua\n-- Name: Purple\nreturn function(fx)\n\tfx:stage("charge")\n\tfx:wait(0.3)\n\tfx:stage("impact")\n\tfx:spawn("shockwave", { name = "Dome", size = 14 })\n\tfx:wait(0.5)\nend\n```'
  const small = await service([...others(), hp], { vision: () => async () => dome })
  const s = await small.compose('hollow purple but faster', { refine: false, variations: 1 })
  assert.ok(s.ok)
  assert.equal(s.entry!.effect!.script, USER_SCRIPT)
  assert.ok(richness(s.entry!.effect!).layers >= richness(hp.effect!).layers)
})

test('single Make on a scripted match builds on its script (the sequence path)', { skip: noLune }, async () => {
  const hp = await userHollowPurple()
  const svc = await service([...others(), hp])
  const { entry } = await svc.make('hollow purple')
  assert.equal(entry.effect!.script, USER_SCRIPT)
  assert.equal(entry.basedOn?.[0], hp.id)
  assert.ok(entry.makeNotes!.some((n) => /^Make \(single\): your "HollowPurple" is a scripted sequence/.test(n)))
  // Non-scripted close match: the remix as before.
  const plain = await service(richLibrary())
  const { entry: remix } = await plain.make('hollow purple but red')
  assert.equal(remix.effect!.script, undefined)
  assert.match(remix.description, /remixed from your "Hollow Purple"/)
})

test('compose on a non-scripted base keeps the copy-at-impact path', { skip: noLune }, async () => {
  const prompts: string[] = []
  const dome = '```lua\n-- Name: HP\nreturn function(fx)\n\tfx:stage("charge")\n\tfx:wait(0.3)\n\tfx:stage("impact")\n\tfx:spawn("shockwave", { name = "Dome", size = 14 })\n\tfx:wait(0.5)\n\tfx:stage("dissipate")\nend\n```'
  const svc = await service(richLibrary(), { vision: () => async (_s, p) => (prompts.push(p), dome) })
  const r = await svc.compose('hollow purple', { refine: false, variations: 1 })
  assert.ok(r.ok, r.error?.message)
  assert.match(prompts[0], /The effect already holds a copy of the user's "Hollow Purple"/)
  assert.ok(r.entry!.makeNotes!.some((n) => /started from your effect "Hollow Purple"/.test(n)))
})

// ------------------------------------------------------------------ From scratch

test('from scratch, single Make: no copied layers, library textures and ranges still used', async () => {
  const lib = richLibrary()
  const hp = lib.find((e) => e.name === 'Hollow Purple')!
  const g = ground('hollow purple but red', { entries: lib })
  assert.equal(scratchCandidate('hollow purple but red', g).basedOn.length, 0)
  const svc = await service(lib)
  const { entry } = await svc.make('hollow purple but red', { fromScratch: true })
  const ids = new Set(allNodes(hp.effect!.roots).map((n) => n.id))
  assert.ok(allNodes(entry.effect!.roots).every((n) => !ids.has(n.id)), 'no node of the library entry')
  assert.ok(!emitterNames(entry.effect!).includes('1SP') && !emitterNames(entry.effect!).includes('2SP'))
  assert.ok(!entry.basedOn?.length)
  assert.ok(entry.makeNotes!.some((n) => /^from scratch \(library used as a style guide: "Hollow Purple"/.test(n)), entry.makeNotes!.join(' | '))
  const lt = new Set<string>(Object.values(RICH_TEX))
  assert.ok([...texturesOf(entry.effect!)].some((t) => lt.has(t)), 'textures from the library')
  // Off: the remix as before.
  const { entry: off } = await svc.make('hollow purple but red')
  assert.equal(off.basedOn?.[0], hp.id)
})

test('from scratch, compose: no library copy, no script reuse; the model is told the library is a style guide', { skip: noLune }, async () => {
  const hp = await userHollowPurple()
  const rich = richLibrary()
  const prompts: string[] = []
  const own = '```lua\n-- Name: Hollow\nreturn function(fx)\n\tfx:stage("charge")\n\tfx:spawn("orb", { name = "Mass", color = Color3.fromRGB(150, 60, 255), size = 2 })\n\tfx:spawn("charge", { name = "Pull", color = Color3.fromRGB(150, 60, 255) })\n\tfx:wait(0.4)\n\tfx:stage("impact")\n\tfx:spawn("shockwave", { name = "Wave", size = 14 })\n\tfx:spawn("sparks", { name = "Bits", count = 30 })\n\tfx:wait(0.5)\n\tfx:stage("dissipate")\nend\n```'
  const svc = await service([...rich, hp], { vision: () => async (_s, p) => (prompts.push(p), own) })
  const r = await svc.compose('hollow purple', { refine: false, variations: 1, fromScratch: true })
  assert.ok(r.ok, r.error?.message)
  assert.ok(!prompts[0].includes('fx:stage("converge")'), 'not given the user\'s script')
  assert.doesNotMatch(prompts[0], /already holds a copy|Start from the user's own scripted effect/)
  assert.match(prompts[0], /From scratch: build every layer yourself/)
  const e = r.entry!
  const libIds = new Set([...rich, hp].flatMap((x) => allNodes(x.effect!.roots).map((n) => n.id)))
  assert.ok(allNodes(e.effect!.roots).every((n) => !libIds.has(n.id)))
  assert.notEqual(e.effect!.script, USER_SCRIPT)
  assert.ok(!e.basedOn?.length)
  assert.ok(e.makeNotes!.some((n) => /^from scratch \(library used as a style guide/.test(n)))
  // No model: the built-in draft script, never the library's; textures from the library.
  const plain = await service([...rich, hp])
  const d = await plain.compose('hollow purple', { refine: false, fromScratch: true })
  assert.ok(d.ok, d.error?.message)
  assert.ok(!d.entry!.effect!.script!.includes('fx:stage("converge")'))
  assert.doesNotMatch(d.entry!.effect!.script!, /built on your/)
  assert.ok(allNodes(d.entry!.effect!.roots).every((n) => !libIds.has(n.id)))
  const lt = new Set<string>(Object.values(RICH_TEX))
  assert.ok([...texturesOf(d.entry!.effect!)].some((t) => lt.has(t)), 'library textures on the kit layers')
  // Single Make from scratch does not hand the scripted match to the script path either.
  const { entry: m } = await plain.make('hollow purple', { fromScratch: true })
  assert.equal(m.effect!.script, undefined)
  assert.ok(!m.basedOn?.length)
})
