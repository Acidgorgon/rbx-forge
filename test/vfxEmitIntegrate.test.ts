// ForgeVFX in the per-effect modules (docs/vfx-emit.md, "Effect modules"): an effect with a Start/End
// mesh effect or a FadeOut gets a module that plays its template with ForgeVFX.emit, and "Add to
// game", Studio checks and Live ship ForgeVFX with it; the NODES rebuild keeps typed attributes
// (NumberRange / Vector2 / Vector3 / Color3 / NumberSequence); plain and scripted effects keep their
// modules. Every generated module is checked structurally (test/luauCheck.ts).
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { retimeFromAttributes } from '../src/shared/vfx/analyze.ts'
import { ATTR_TYPES, arrayAttrType, emitPlan, makeMeshEffect, planLength } from '../src/shared/vfx/emitPlan.ts'
import { EMIT_RUNTIME_MODULE, FORGEVFX_SOURCE } from '../src/shared/vfx/emitRuntime.ts'
import { liveJob, liveModuleSource, livePayload, playTiming } from '../src/shared/vfx/live.ts'
import { attrLiteral, effectModules, forgeVfxTiming, luauModule, moduleDuration, needsRuntime, playsWithForgeVFX } from '../src/shared/vfx/luau.ts'
import { decodeAttributes, encodeAttributes } from '../src/shared/vfx/rbxmx.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'
import { vfxJob } from '../src/shared/studio/payload.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { luauCheck } from './luauCheck.ts'

const checked = (src: string, what: string): string => {
  assert.deepEqual(luauCheck(src), [], what)
  assert.doesNotMatch(src, /\$\{|undefined|\[object |NaN/, what)
  return src
}

// A Lab effect (one burst emitter on the timeline) plus "+ Mesh effect" (ParamEditor: makeMeshEffect,
// then retimeFromAttributes), with typed attributes edited in.
function labMeshEffect(extra: VfxNode['attrs'] = {}): VfxEffect {
  const base = effectFromSpec({ name: 'Blast', duration: 1, layers: [{ name: 'Sparks', class: 'ParticleEmitter', props: { Rate: 0, Lifetime: [0.5, 1.2] }, emit: [{ at: 0.1, count: 20 }] }] })
  let k = 0
  const mesh = makeMeshEffect((p) => `${p}-${k++}`)
  mesh.attrs = { ...mesh.attrs, ...extra }
  return retimeFromAttributes({ ...base, roots: [...base.roots, mesh] })
}

const plain = (): VfxEffect => effectFromSpec({ name: 'Burst', duration: 1, layers: [{ name: 'Sparks', class: 'ParticleEmitter', props: { Rate: 10, Color: ['#ff8000'] }, emit: [{ at: 0, count: 10 }] }] })

// ------------------------------------------------------------------ which module

test('playsWithForgeVFX: mesh effects and FadeOut; not plain, emit-attribute-only or scripted effects', () => {
  const mesh = labMeshEffect()
  assert.equal(playsWithForgeVFX(mesh), true)
  assert.equal(playsWithForgeVFX(plain()), false)
  // Emit attributes alone are compiled cues (the plain module plays them).
  const timedBeam: VfxEffect = {
    name: 'Ray',
    duration: 2,
    cues: [],
    roots: [{ id: 'M', className: 'Model', name: 'Ray', props: {}, children: [
      { id: 'A0', className: 'Attachment', name: 'A0', props: {}, children: [] },
      { id: 'A1', className: 'Attachment', name: 'A1', props: {}, children: [] },
      { id: 'B', className: 'Beam', name: 'Beam', props: { Attachment0: 'A0', Attachment1: 'A1' }, attrs: { EmitDelay: 0.5, EmitDuration: 1 }, children: [] }
    ] }]
  }
  assert.equal(playsWithForgeVFX(retimeFromAttributes(timedBeam)), false)
  const faded = retimeFromAttributes({ ...timedBeam, roots: [{ ...timedBeam.roots[0], children: timedBeam.roots[0].children.map((c) => (c.id === 'B' ? { ...c, attrs: { ...c.attrs, FadeOut: 0.3 } } : c)) }] })
  assert.equal(playsWithForgeVFX(faded), true)
  // A scripted effect keeps the ForgeFX module, mesh effect or not.
  const scripted = { ...mesh, script: 'return function(fx)\n\tfx:wait(0.2)\nend\n' }
  assert.equal(needsRuntime(scripted), true)
  assert.equal(playsWithForgeVFX(scripted), false)
  assert.match(luauModule(scripted), /require\(script\.Parent:WaitForChild\("ForgeFX"\)\)/)
  assert.doesNotMatch(luauModule(scripted), /ForgeVFX/)
})

// ------------------------------------------------------------------ the ForgeVFX module

test('Lab mesh effect: the module builds the template once and plays it with ForgeVFX.emit', () => {
  const fx = labMeshEffect({ SpreadAngle: [10, 20], Spin: [0, 90, 0] })
  const src = checked(luauModule(fx), 'mesh module')
  assert.match(src, /^--!strict\n/)
  assert.match(src, /\nlocal ForgeVFX = require\(script\.Parent:WaitForChild\("ForgeVFX"\)\)\n/)
  // The template: built once, its anchor at the origin, never parented (emit clones it).
  const tpl = src.slice(src.indexOf('local function getTemplate(): Model'), src.indexOf('\nend\n', src.indexOf('local function getTemplate(): Model')))
  assert.match(tpl, /if cached then\n\t\treturn cached\n\tend\n\tlocal model = build\(\)\n\tif not model\.PrimaryPart then\n\t\tmodel\.WorldPivot = CFrame\.new\(\)\n\tend\n\tcached = model/)
  assert.doesNotMatch(tpl, /Parent/)
  assert.doesNotMatch(src, /Debris|model\.Parent = |:PivotTo\(/, 'ForgeVFX places, parents and cleans up')
  // play(target, parent, options) -> (clone, emission).
  assert.match(src, /function Effect\.play\(target: any, parent: Instance\?, options: \{ \[string\]: any \}\?\): \(Model, any\)\n\tlocal emission = ForgeVFX\.emit\(getTemplate\(\), target, \{ parent = parent, keepFor = [\d.]+ \}\)\n\tlocal model = emission\.Instance :: Model\n/)
  assert.match(src, /\treturn model, emission\nend\n\nreturn Effect\n$/)
  // The emitter on the Lab timeline (no attributes) still bursts, on the clone; the mesh template
  // has no cues (ForgeVFX spawns the copies).
  assert.match(src, /local CUES = \{\n\t\{ 0\.1, 1, "Sparks", "emit", 20 \},\n\}/)
  assert.match(src, /local ids = byId\(model\)\n\tfor _, cue in CUES do/)
  assert.doesNotMatch(src, /"Start", "(emit|enable)"|"End", "(emit|enable)"/)
  // Start / End (and the mesh effect's typed attributes) are in the rows for the rebuild.
  assert.match(src, /\{"Part","Start",\d+,/)
  assert.match(src, /\{"Part","End",\d+,/)
})

test('Lab mesh effect: Duration / Linger come from the emit plan (copies at their longest Lifetime)', () => {
  const fx = labMeshEffect()
  const plan = emitPlan(fx.roots)
  assert.equal(plan.meshEffects.length, 1)
  const lifeMax = plan.meshEffects[0].lifetime[1]
  assert.equal(lifeMax, 0.55)
  const t = forgeVfxTiming(fx)
  // One copy at 0: ForgeVFX's emission.Duration is that copy's Lifetime (0.45..0.55), never more.
  assert.equal(t.duration, 0.55)
  assert.ok(t.duration >= plan.duration)
  // The burst emitter's particles (Lifetime max 1.2, emitted at 0.1) outlive it: the Lab loop length.
  assert.equal(t.linger, 0.75)
  assert.equal(Math.round((t.duration + t.linger) * 1000) / 1000, fx.duration)
  const src = luauModule(fx)
  assert.match(src, /\nEffect\.Duration = 0\.55\nEffect\.Linger = 0\.75\n/)
  // The clone stays until the cued particles are gone (they are not ForgeVFX's own).
  assert.match(src, /keepFor = 1\.3 \}/)
  assert.doesNotMatch(src, /duration = Effect\.Duration/, 'the cues end inside the plan: open windows end where the preview ends them')

  // A mesh effect alone: no cue code, no keepFor; Rate copies over EmitDuration.
  let k = 0
  const ring = makeMeshEffect((p) => `${p}-${k++}`)
  ring.attrs = { ...ring.attrs, EmitDuration: 1, Rate: 4, EmitCount: 2 }
  const only = retimeFromAttributes({ name: 'Rings', duration: 1, roots: [ring], cues: [] })
  const p2 = emitPlan(only.roots)
  assert.equal(p2.meshEffects[0].copies.length, 8)
  const t2 = forgeVfxTiming(only)
  assert.equal(t2.duration, 0.75 + 0.55)
  assert.equal(t2.linger, 0)
  const src2 = checked(luauModule(only), 'mesh-only module')
  assert.match(src2, /ForgeVFX\.emit\(getTemplate\(\), target, \{ parent = parent \}\)/)
  assert.doesNotMatch(src2, /CUES|byId|TOGGLES/)
  assert.match(src2, /\nEffect\.Duration = 1\.3\n/)
  // The Lab's loop is at least as long as the module's play.
  assert.ok(planLength(p2) <= t2.duration + t2.linger)

  // Timeline cues past the plan: ForgeVFX runs that long (duration option).
  const late = { ...fx, cues: [...fx.cues, { at: 2, target: fx.cues.find((c) => c.action === 'emit')!.target, action: 'emit' as const, count: 5 }] }
  const t3 = forgeVfxTiming(late)
  assert.equal(t3.duration, 2)
  assert.equal(t3.linger, 1.2)
  assert.match(checked(luauModule(late), 'late cues'), /\{ parent = parent, duration = Effect\.Duration, keepFor = 3\.2 \}/)
})

test('stages fire options.onStage; a big ForgeVFX effect splits its data like the others', () => {
  const fx = { ...labMeshEffect(), stages: [{ at: 0, label: 'ring' }, { at: 0.3, label: 'fade' }] }
  const src = checked(luauModule(fx), 'staged')
  assert.match(src, /\nEffect\.Stages = \{ \{ at = 0, label = "ring" \}, \{ at = 0\.3, label = "fade" \} \}\n/)
  assert.match(src, /local onStage = options and options\.onStage\n\tif onStage then\n\t\tfor _, stage in Effect\.Stages do\n\t\t\ttask\.delay\(stage\.at, onStage, stage\.label, stage\.at\)/)
  assert.doesNotMatch(luauModule(labMeshEffect()), /onStage = options/, 'no stages, no stage code')
  const split = effectModules(fx, { cap: 7000 })
  assert.ok(split.data.length >= 1)
  checked(split.source, 'split module')
  for (const d of split.data) checked(d.source, d.name)
  assert.match(split.source, /local NODES: \{ any \} = DATA\.nodes/)
  assert.match(split.source, /local CUES = DATA\.cues/)
  assert.match(split.source, /ForgeVFX\.emit\(getTemplate\(\)/)
})

// ------------------------------------------------------------------ typed attributes in NODES

test('NODES rows keep typed attributes; the rebuild makes them Roblox values before SetAttribute', () => {
  const curve = [{ t: 0, v: 0 }, { t: 0.5, v: 1.2, e: 0.1 }, { t: 1, v: 1 }]
  const fx = labMeshEffect({ SpreadAngle: [10, 20], MinInitRot: [0, -45, 0], MaxInitRot: [0, 45], Spin: [0, 90, 0], EaseSize: curve, SyncPosition: true, Lifetime: [0.6, 0.4] })
  const src = checked(luauModule(fx), 'typed')
  const row = src.split('\n').find((l) => l.includes('{"Model","Shockwave",'))!
  assert.ok(row, 'the mesh effect row')
  assert.match(row, /"Lifetime",\{"NumberRange",0\.4,0\.6\}/, 'NumberRange, min <= max')
  assert.match(row, /"SpreadAngle",\{"Vector2",10,20\}/)
  assert.match(row, /"MinInitRot",\{"Vector3",0,-45,0\}/)
  assert.match(row, /"MaxInitRot",\{"Vector3",0,45,0\}/, 'a short vector is padded with 0')
  assert.match(row, /"Spin",\{"Vector3",0,90,0\}/)
  assert.match(row, /"EaseSize",\{"NumberSequence",0,0,0,0\.5,1\.2,0\.1,1,1,0\}/, 'time, value, envelope per keypoint')
  assert.match(row, /"Ease","Quad\.Out"/)
  assert.match(row, /"EmitCount",1/)
  assert.match(row, /"SyncPosition",true/)
  // The decoder and the SetAttribute loop.
  for (const s of [
    'local function attrValue(v: any): any',
    'if type(v) ~= "table" then\n\t\treturn v\n\tend',
    'if kind == "NumberRange" then\n\t\treturn NumberRange.new(v[2], v[3])',
    'elseif kind == "Vector2" then\n\t\treturn Vector2.new(v[2], v[3])',
    'elseif kind == "Vector3" then\n\t\treturn Vector3.new(v[2], v[3], v[4])',
    'elseif kind == "Color3" then\n\t\treturn Color3.new(v[2], v[3], v[4])',
    'for i = 2, #v, 3 do\n\t\t\ttable.insert(points, NumberSequenceKeypoint.new(v[i], v[i + 1], v[i + 2]))\n\t\tend\n\t\treturn NumberSequence.new(points)',
    'local ok, v = pcall(attrValue, attrs[a + 1])\n\t\t\t\tif ok then\n\t\t\t\t\tpcall(inst.SetAttribute, inst, attrs[a], v)\n\t\t\t\tend'
  ])
    assert.ok(src.includes(s), s)
  // attrValue is defined before build uses it.
  assert.ok(src.indexOf('local function attrValue') < src.indexOf('local function build(): Model'))
})

test('attrLiteral: the type Effect.rbxmx writes (ATTR_TYPES, else Vector2 / Vector3 / NumberSequence), valid sequences', () => {
  assert.equal(attrLiteral('EmitDelay', 0.25), '0.25')
  assert.equal(attrLiteral('EmitDelay', Number.NaN), null)
  assert.equal(attrLiteral('SyncPosition', false), 'false')
  assert.equal(attrLiteral('Ease', 'Back.In'), '"Back.In"')
  assert.equal(attrLiteral('Lifetime', [0.3, 0.7]), '{"NumberRange",0.3,0.7}')
  assert.equal(attrLiteral('Offset', [1, 2]), '{"Vector2",1,2}', 'unknown 2-array: Vector2')
  assert.equal(attrLiteral('Tint', [0.5, 0.25, 1]), '{"Vector3",0.5,0.25,1}', 'unknown 3-array: Vector3')
  assert.equal(attrLiteral('Odd', [1, 2, 3, 4]), null)
  assert.equal(attrLiteral('Odd', [1]), null)
  // A Color3 name (ATTR_TYPES decides: the template and the rebuild agree).
  ;(ATTR_TYPES as Record<string, string>).TintColor = 'Color3'
  try {
    assert.equal(arrayAttrType('TintColor', [1, 0.5, 0]), 'Color3')
    assert.equal(attrLiteral('TintColor', [1, 0.5, 0]), '{"Color3",1,0.5,0}')
  } finally {
    delete (ATTR_TYPES as Record<string, string>).TintColor
  }
  // NumberSequence: sorted, inside 0..1, keypoints at 0 and 1 added, envelopes not negative, <= 20.
  assert.equal(attrLiteral('EaseColor', [{ t: 0.8, v: 1 }, { t: 0.2, v: 0.5, e: -1 }]), '{"NumberSequence",0,0.5,0,0.2,0.5,0,0.8,1,0,1,1,0}')
  const many = Array.from({ length: 30 }, (_, i) => ({ t: i / 29, v: i }))
  const keys = attrLiteral('EaseSize', many)!.slice('{"NumberSequence",'.length, -1).split(',').map(Number)
  assert.equal(keys.length, 60)
  assert.equal(keys[0], 0)
  assert.equal(keys[57], 1)
  assert.equal(attrLiteral('EaseSize', [{ t: 0, v: 0 }] as never), null, 'one keypoint is not a sequence')
  // Effect.rbxmx keeps exactly the attributes the rows keep, with the same shapes.
  const attrs = { Lifetime: [0.3, 0.7], SpreadAngle: [5, 6], Spin: [1, 2, 3], EaseSize: [{ t: 0, v: 0 }, { t: 1, v: 1 }], Odd: [1, 2, 3, 4], Ease: 'Quad.In', EmitCount: 3, SyncPosition: true }
  const back = decodeAttributes(encodeAttributes(attrs))
  assert.deepEqual(Object.keys(back).sort(), Object.keys(attrs).filter((k) => attrLiteral(k, attrs[k as keyof typeof attrs]) !== null).sort())
  assert.deepEqual(back.Lifetime, [0.3, 0.7])
  assert.deepEqual(back.SpreadAngle, [5, 6])
  assert.deepEqual(back.Spin, [1, 2, 3])
})

// ------------------------------------------------------------------ Studio check, Live, project files

test('Studio check and Live ship ForgeVFX with a mesh effect; times come from the plan', () => {
  const fx = labMeshEffect()
  const t = forgeVfxTiming(fx)
  const job = vfxJob(fx, { id: 'job-mesh' })
  assert.deepEqual(job.modules.map((m) => m.name), [EMIT_RUNTIME_MODULE, 'Effect'])
  assert.equal(job.modules[0].source, FORGEVFX_SOURCE)
  assert.equal(job.modules[1].source, effectModules(fx).source)
  checked(job.modules[1].source!, 'job module')
  // The recording covers the module's play and every beat (beats lie inside the Lab's loop).
  assert.ok(job.duration >= t.duration)
  for (const b of job.beats) assert.ok(b.t <= job.duration, `beat ${b.t}`)
  assert.equal(job.linger, t.linger)
  assert.equal(job.timeout, Math.ceil(job.duration + 40))
  const timed = vfxJob(fx, { id: 'job-mesh-2', times: [0.05, 1.25] })
  assert.equal(timed.duration, 1.25)

  const live = livePayload(fx)
  assert.equal(live.source, effectModules(fx).source)
  assert.equal(live.duration, Math.round((t.duration + t.linger) * 1000) / 1000, 'the loop waits for the particles')
  assert.equal(live.linger, t.linger)
  assert.deepEqual(playTiming(fx), { duration: t.duration, linger: t.linger, forge: true })
  const lj = liveJob({ id: 'job-live-mesh', port: 34877, mode: 'origin', frame: true })
  const runtime = lj.modules.find((m) => m.name === EMIT_RUNTIME_MODULE)
  assert.equal(runtime?.source, FORGEVFX_SOURCE, 'the live module is a sibling of ForgeVFX')
  // Replays stop the last emission at once (ForgeVFX: Stop(true); ForgeFX: stop()).
  const loop = checked(liveModuleSource({ port: 34877, jobId: 'job-live-mesh', mode: 'origin', frame: true }), 'live loop')
  assert.match(loop, /if lastFx\.Stop then\n\t+lastFx:Stop\(true\)\n\t+else\n\t+lastFx:stop\(\)/)
})

test('plain effects keep the cue module, its times and its job', () => {
  const fx = plain()
  const src = checked(luauModule(fx), 'plain')
  assert.doesNotMatch(src, /ForgeVFX|attrValue|getTemplate/)
  assert.match(src, /function Effect\.play\(target: any, parent: Instance\?\): Model\n\tlocal model = build\(\)\n\tplace\(model, target or CFrame\.new\(\)\)/)
  assert.match(src, /\t\t\t\tpcall\(inst\.SetAttribute, inst, attrs\[a\], attrs\[a \+ 1\]\)\n/)
  const job = vfxJob(fx, { id: 'job-plain' })
  assert.deepEqual(job.modules.map((m) => m.name), ['Effect'])
  assert.equal(job.duration, moduleDuration(fx))
  assert.deepEqual(playTiming(fx), { duration: moduleDuration(fx), linger: job.linger, forge: false })
  assert.equal(livePayload(fx).duration, 1)
})

test('exportFiles: ForgeVFX.luau ships next to every effect whose module requires it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-integrate-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const entry = (e: VfxEffect) => ({ id: 'x', scope: 'user', kind: 'model', name: e.name, description: '', tags: [], createdAt: 0, updatedAt: 0, origin: 'lab', effect: e, thumbs: [] }) as never
  const files = await svc.exportFiles(entry(labMeshEffect()), 'src/shared/VFX/Blast')
  const mod = files.find((f) => f.path === 'src/shared/VFX/Blast/init.luau')!
  checked(mod.content, 'exported module')
  assert.match(mod.content, /ForgeVFX\.emit\(getTemplate\(\), target/)
  assert.equal(files.find((f) => f.path === 'src/shared/VFX/ForgeVFX.luau')?.content, FORGEVFX_SOURCE)
  assert.ok(files.some((f) => f.path === 'src/shared/VFX/Blast/Effect.rbxmx'), 'the template the module clones')
  assert.equal(files.some((f) => f.path.endsWith('/ForgeFX.luau')), false)
  const plainFiles = await svc.exportFiles(entry(plain()), 'src/shared/VFX/Burst')
  assert.equal(plainFiles.some((f) => f.path.endsWith('ForgeVFX.luau')), false)
})
