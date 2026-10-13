// VFX sequences: easing, tween tracks (later tweens take over, set, tint, rig SizeScale / Fade), the
// kit + timeline compiler on the recorded built-in examples, simulation of moving rigs and tweened
// rates, the Luau export (ForgeFX runtime + Timeline module), stage frame times for the critic, the
// service (examples, scripts, compose with a fake model) and, when Lune is installed, the sandboxed
// recorder itself (examples record to exactly the checked-in ops; errors carry the script line).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { VfxCue, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'
import { ease, EASING_STYLES, EASING_DIRECTIONS, trackValue, tintValue, applyTint, Timeline, normalizeGoal, TimelineError, timelineSummary, type TweenSegment } from '../src/shared/vfx/timeline.ts'
import { compileTimeline, finishRun, parseLuauError, scriptBase, SCRIPT_TEMPLATE, type RecordedOp } from '../src/shared/vfx/compile.ts'
import { KIT, KIT_OPTION_KEYS, kitKind } from '../src/shared/vfx/kit.ts'
import { VFX_EXAMPLES, findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { archetype, draftScript, kitReference } from '../src/shared/vfx/choreo.ts'
import { prepareEffect, simulate } from '../src/shared/vfx/simulate.ts'
import { allNodes, effectStats, isSequence } from '../src/shared/vfx/analyze.ts'
import { luauModule, needsRuntime, timelineModule } from '../src/shared/vfx/luau.ts'
import { FORGEFX_SOURCE, isOwnRuntime } from '../src/shared/vfx/runtime.ts'
import { stageFrameTimes, stageAt, critiquePrompt } from '../src/shared/vfx/critique.ts'
import { applyChanges, editProp, compactEffect } from '../src/shared/vfx/spec.ts'
import { writeRbxmx, readRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { luneTimeline } from '../src/main/services/vfx/lune.ts'
import { VfxService, extractScript, scriptName } from '../src/main/services/vfx/service.ts'
import { scriptReport } from '../src/main/services/vfx/tools.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} ≉ ${b}`)
const blank = (name = 'Seq'): VfxEffect => ({ name, roots: [], cues: [], duration: 2 })
const compiled = (key: string) => {
  const ex = findExample(key)!
  return compileTimeline(blank(ex.name), RECORDED[ex.key], ex.script)
}
const byName = (e: VfxEffect, name: string): VfxNode => {
  const n = allNodes(e.roots).find((x) => x.name === name)
  assert.ok(n, `no node ${name}`)
  return n
}

// ------------------------------------------------------------------ easing + tracks

test('every easing style and direction maps 0 -> 0 and 1 -> 1', () => {
  for (const s of EASING_STYLES) for (const d of EASING_DIRECTIONS) {
    close(ease(s, d, 0), 0, 1e-9)
    close(ease(s, d, 1), 1, 1e-9)
  }
  close(ease('Linear', 'In', 0.3), 0.3)
  close(ease('Quad', 'In', 0.5), 0.25)
  close(ease('Quad', 'Out', 0.5), 0.75)
  close(ease('Sine', 'InOut', 0.5), 0.5, 1e-9)
  // Back overshoots, Quad never does.
  assert.ok(Math.max(...Array.from({ length: 50 }, (_, i) => ease('Back', 'Out', i / 49))) > 1.05)
  for (let i = 1; i < 50; i++) assert.ok(ease('Quad', 'Out', i / 49) >= ease('Quad', 'Out', (i - 1) / 49))
})

test('a later tween takes over from the current value (TweenService semantics)', () => {
  const segs: TweenSegment[] = [
    { at: 0, duration: 1, to: 10, style: 'Linear', direction: 'In' },
    { at: 0.5, duration: 1, to: 0, style: 'Linear', direction: 'In' }
  ]
  close(trackValue('number', 0, segs, 0.25) as number, 2.5)
  close(trackValue('number', 0, segs, 0.5) as number, 5)
  close(trackValue('number', 0, segs, 1) as number, 2.5) // halfway from 5 back to 0
  close(trackValue('number', 0, segs, 2) as number, 0)
  // set = an instant segment
  close(trackValue('number', 1, [{ at: 0.2, duration: 0, to: 4, style: 'Quad', direction: 'Out' }], 0.1) as number, 1)
  close(trackValue('number', 1, [{ at: 0.2, duration: 0, to: 4, style: 'Quad', direction: 'Out' }], 0.3) as number, 4)
})

test('colour tints accumulate and apply to sequences', () => {
  const red: [number, number, number] = [1, 0, 0]
  const tint = tintValue([{ at: 0, duration: 1, to: red, style: 'Linear', direction: 'In' }], 0.5)
  close(tint.alpha, 0.5)
  const c = applyTint([0, 0, 1], tint)
  close(c[0], 0.5)
  close(c[2], 0.5)
  close(applyTint([0, 0, 1], tintValue([{ at: 0, duration: 1, to: red, style: 'Linear', direction: 'In' }], 2))[0], 1)
})

test('rig SizeScale and Fade multiply down the hierarchy', () => {
  const kid: VfxNode = { id: 'k', className: 'ParticleEmitter', name: 'K', props: {}, children: [] }
  const rig: VfxNode = { id: 'r', className: 'Part', name: 'R', props: {}, children: [{ id: 'a', className: 'Attachment', name: 'A', props: {}, children: [kid] }] }
  const cues: VfxCue[] = [
    { at: 0, target: 'r', action: 'tween', duration: 1, props: { SizeScale: 3, Fade: 1 }, style: 'Linear', direction: 'In' },
    { at: 0, target: 'a', action: 'set', props: { SizeScale: 0.5 } }
  ]
  const tl = new Timeline({ roots: [rig], cues })
  close(tl.sizeScale('k', 0.5), 2 * 0.5)
  close(tl.fade('k', 0.5), 0.5)
  close(tl.fade('k', 1), 1)
  assert.equal(tl.animated('k'), true)
})

test('goals are validated against what TweenService can animate', () => {
  assert.deepEqual(normalizeGoal('PointLight', 'Brightness', 4), 4)
  assert.deepEqual(normalizeGoal('Part', 'Position', { __t: 'v3', x: 1, y: 2, z: 3 }), [1, 2, 3])
  assert.throws(() => normalizeGoal('ParticleEmitter', 'Texture', 'x'), TimelineError)
})

// ------------------------------------------------------------------ kit + compiler

test('every kit preset builds a named rig with its documented layers', () => {
  let n = 0
  const id = (p: string) => `${p}-${n++}`
  for (const [kind, def] of Object.entries(KIT)) {
    const b = def.build('X', kind === 'trail' ? { parent: 'P' } : {}, id)
    assert.ok(b.node, kind)
    const names = new Set(allNodes([b.node, ...(b.extras ?? []).map((e) => e.node)]).map((x) => x.name))
    for (const layer of def.layers) assert.ok(names.has(`X${layer}`) || names.has('X'), `${kind}: X${layer}`)
    for (const c of [...b.prelude, ...b.activate]) assert.ok(names.has(c.target), `${kind}: cue target ${c.target}`)
  }
  assert.equal(kitKind('ring'), 'shockwave')
  assert.equal(kitKind('nope'), null)
  assert.ok(KIT_OPTION_KEYS.includes('facing'))
  assert.match(kitReference(), /fx:spawn/)
})

test('the built-in examples compile into staged, local-space sequences', () => {
  const stagesOf: Record<string, string[]> = {
    'hollow-purple': ['blue', 'red', 'converge', 'merge', 'charge', 'fire', 'dissipate'],
    'charge-slash': ['anticipation', 'slash', 'impact', 'dissipate'],
    'ground-slam': ['wind-up', 'drop', 'impact', 'aftershock', 'dissipate']
  }
  for (const ex of VFX_EXAMPLES) {
    const { effect, warnings } = compiled(ex.key)
    assert.deepEqual(effect.stages!.map((s) => s.label), stagesOf[ex.key], ex.key)
    assert.equal(effect.space, 'local')
    assert.equal(effect.script, ex.script)
    assert.deepEqual(warnings, [], ex.key)
    assert.ok(effect.duration > 2 && effect.duration < 6, `${ex.key} ${effect.duration}`)
    assert.ok(isSequence(effect))
    // Model > Root part as the pivot.
    assert.equal(effect.roots[0].className, 'Model')
    assert.ok(effect.roots[0].children.some((c) => c.name === 'Root' && c.className === 'Part'))
    const stats = effectStats(effect)
    assert.ok(stats.particles > 20 && stats.particles < 800, `${ex.key} particles ${stats.particles}`)
    // Round-trips through .rbxmx (kit rigs are ordinary instances).
    const back = readRbxmx(writeRbxmx(effect.roots))
    assert.equal(allNodes(back).length, allNodes(effect.roots).length)
  }
})

test('compile errors carry the script line, with a suggestion for typos', () => {
  const base = blank()
  const run = (ops: RecordedOp[]) => finishRun(base, 'return function(fx) end', { ok: true, ops, prints: [] })
  const bad = run([{ op: 'spawn', at: 0, kind: 'orbb', name: 'O', opts: {}, line: 3 }])
  assert.equal(bad.ok, false)
  assert.equal(bad.error!.line, 3)
  assert.match(bad.error!.message, /orb/)
  const opt = run([{ op: 'spawn', at: 0, kind: 'orb', name: 'O', opts: { colour: 1 }, line: 4 }])
  assert.equal(opt.error!.line, 4)
  assert.match(opt.error!.message, /unknown option "colour"/)
  const target = run([
    { op: 'spawn', at: 0, kind: 'orb', name: 'Blue', opts: {}, line: 2 },
    { op: 'tween', at: 0, target: 'Bleu', duration: 1, props: { Fade: 1 }, line: 5 }
  ])
  assert.equal(target.error!.line, 5)
  assert.match(target.error!.message, /Blue/)
  const prop = run([
    { op: 'spawn', at: 0, kind: 'orb', name: 'Blue', opts: {}, line: 2 },
    { op: 'tween', at: 0, target: 'BlueLight', duration: 1, props: { Texture: 'x' }, line: 6 }
  ])
  assert.equal(prop.error!.line, 6)
  const facing = run([{ op: 'spawn', at: 0, kind: 'sparks', name: 'S', opts: { facing: 'Sideways' }, line: 7 }])
  assert.equal(facing.error!.line, 7)
  assert.equal(run([{ op: 'spawn', at: 0, kind: 'sparks', name: 'S', opts: { facing: 'Front' }, line: 7 }]).ok, true)
  // A recorder (Luau) error passes through.
  const lua = finishRun(base, '', { ok: false, ops: [], prints: [], error: { message: 'boom', line: 9 } })
  assert.deepEqual(lua.error, { message: 'boom', line: 9 })
})

test('parseLuauError finds the line in Lune output', () => {
  assert.deepEqual(parseLuauError('[string "timeline"]:12: attempt to call a nil value'), { line: 12, message: 'attempt to call a nil value' })
  assert.deepEqual(parseLuauError('timeline.luau:3: syntax error: Expected end'), { line: 3, message: 'Expected end' })
  assert.equal(parseLuauError('weird').line, undefined)
})

test('re-running a script keeps parameter edits made on kit layers', () => {
  const { effect } = compiled('ground-slam')
  const fist = byName(effect, 'FistGlow')
  const edited = editProp(effect, fist.id, 'LightEmission', 0.4)
  assert.equal(edited.patches!.length, 1)
  const critic = applyChanges(edited, [{ node: 'FlashLight', prop: 'Range', value: 30 }])
  assert.equal(critic.patches!.length, 2)
  const again = compileTimeline(critic, RECORDED['ground-slam'], critic.script!).effect
  assert.equal(byName(again, 'FistGlow').props.LightEmission, 0.4)
  assert.equal(byName(again, 'FlashLight').props.Range, 30)
  // scriptBase strips the old rigs and script cues.
  const base = scriptBase(again)
  assert.ok(!allNodes(base.roots).some((n) => n.kit))
  assert.equal(base.cues.length, 0)
})

// ------------------------------------------------------------------ simulation

test('Hollow Purple: rigs converge, merge, and the purple mass flies forward', () => {
  const { effect } = compiled('hollow-purple')
  const p = prepareEffect(effect)
  const mesh = (name: string) => p.meshes.find((m) => m.name === name)!
  const at = (name: string, t: number) => mesh(name).at(t)
  const stage = (label: string) => effect.stages!.find((s) => s.label === label)!.at
  // Blue starts left, red right, both meet in the middle by the merge.
  assert.ok(at('Blue', stage('converge'))[0] < -2)
  assert.ok(at('Red', stage('converge'))[0] > 2)
  close(at('Blue', stage('merge'))[0], at('Red', stage('merge'))[0], 0.05)
  // Faded out after the merge.
  assert.ok(mesh('Blue').look(stage('merge') + 0.2).transparency > 0.95)
  // The purple mass travels -Z during fire.
  const z0 = at('Purple', stage('fire'))[2]
  const z1 = at('Purple', stage('dissipate'))[2]
  assert.ok(z0 - z1 > 25, `moved ${z0 - z1}`)
  // Charge streaks run during the blue stage and are off once converging.
  const gather = (t: number) => simulate(p, t).emitters.filter((e) => e.name.startsWith('BlueGather')).reduce((a, e) => a + e.particles.length, 0)
  assert.ok(gather(stage('red')) > 5)
  assert.equal(gather(stage('merge') + 0.6), 0)
  // Particles exist at every stage midpoint.
  for (const t of stageFrameTimes(effect, 8)) assert.ok(simulate(p, t).emitters.some((e) => e.particles.length > 0), `empty frame at ${t}`)
})

test('tweened Rate changes how many particles spawn', () => {
  const { effect } = compiled('charge-slash')
  const p = prepareEffect(effect)
  const count = (t: number) => simulate(p, t).emitters.filter((e) => e.name === 'BladeGlow').reduce((a, e) => a + e.particles.length, 0)
  assert.ok(count(0.6) > count(0.15), `${count(0.15)} -> ${count(0.6)}`)
})

// ------------------------------------------------------------------ export

test('scripted effects export with the ForgeFX runtime and a Timeline module', () => {
  const { effect } = compiled('hollow-purple')
  assert.equal(needsRuntime(effect), true)
  const src = luauModule(effect)
  for (const s of ['ForgeFX', 'Timeline', 'SPAWNS', 'CUES', 'Effect.Stages', 'function Effect.play', 'PivotTo']) assert.ok(src.includes(s), s)
  assert.ok(isOwnRuntime(FORGEFX_SOURCE))
  assert.equal(isOwnRuntime('-- my own runtime\nreturn {}'), false)
  for (const s of ['TweenService', 'TweenInfo.new', 'TweenService:GetValue', 'task.wait', ':Emit(', 'GetValue']) assert.ok(FORGEFX_SOURCE.includes(s), s)
  // Scripts without the module wrapper are wrapped.
  assert.match(timelineModule('fx:wait(1)'), /return function\(fx\)/)
  assert.equal(timelineModule(SCRIPT_TEMPLATE).trim(), SCRIPT_TEMPLATE.trim())
  // Plain effects stay plain.
  assert.equal(needsRuntime(blank()), false)
})

// ------------------------------------------------------------------ critic

test('critique frames land inside each stage and the prompt names the beats', () => {
  const { effect } = compiled('ground-slam')
  const times = stageFrameTimes(effect, 6)
  assert.equal(times.length, 5)
  assert.deepEqual(times.map((t) => stageAt(effect, t)), ['wind-up', 'drop', 'impact', 'aftershock', 'dissipate'])
  const prompt = critiquePrompt({ prompt: 'ground slam', effect, frameTimes: times, references: [], iteration: 1 })
  assert.match(prompt, /\(wind-up\)/)
  assert.match(prompt, /Stages: wind-up @ 0\.00 s/)
  assert.ok(compactEffect(effect).scripted)
  assert.match(timelineSummary(effect), /impact/)
})

// ------------------------------------------------------------------ service

async function service(extra: Partial<ConstructorParameters<typeof VfxService>[0]> = {}) {
  const userDir = await mkdtemp(join(tmpdir(), 'forge-seq-user-'))
  const root = await mkdtemp(join(tmpdir(), 'forge-seq-proj-'))
  const memory: { name: string; body: string; kind?: string }[] = []
  const svc = new VfxService({
    userDir,
    projectRoot: () => root,
    lune: async () => (lune ? { path: lune } : { error: 'no lune' }),
    runtimeDir: () => runtime,
    memory: { remember: async (m) => (memory.push(m), { entry: { name: m.name } }) },
    ...extra
  })
  return { svc, root, memory }
}

test('examples go into the library and the project with Timeline.luau and the runtime', async () => {
  const { svc, root } = await service()
  assert.equal(svc.examples().length, 3)
  const e = await svc.addExample('hollow-purple')
  assert.equal(e.name, 'HollowPurple')
  assert.ok(e.tags.includes('sequence'))
  assert.equal((await svc.addExample('Hollow Purple')).id, e.id) // reused
  const dir = join(root, 'src', 'shared', 'VFX', 'HollowPurple')
  assert.ok(existsSync(join(dir, 'init.luau')))
  assert.match(await readFile(join(dir, 'Timeline.luau'), 'utf8'), /fx:stage\("converge"\)/)
  assert.ok(isOwnRuntime(await readFile(join(root, 'src', 'shared', 'VFX', 'ForgeFX.luau'), 'utf8')))
  await assert.rejects(svc.addExample('nope'), /no built-in example/)
  // Liking a scripted effect saves its script as a memory skill.
  const { svc: s2, memory } = await service()
  const ex = await s2.addExample('ground-slam')
  await s2.rate(ex.id, 'up')
  const skill = memory.find((m) => m.name === 'vfx-sequence-GroundSlam')
  assert.ok(skill, memory.map((m) => m.name).join(','))
  assert.match(skill!.body, /fx:stage\("impact"\)/)
})

test('extractScript and scriptName read model answers', () => {
  assert.equal(extractScript('Here:\n```lua\n-- Name: Ice Nova\nreturn function(fx)\nend\n```'), '-- Name: Ice Nova\nreturn function(fx)\nend\n')
  assert.equal(extractScript('no code'), null)
  assert.equal(scriptName('-- Name: Ice Nova\nreturn function(fx) end', 'x'), 'IceNova')
  assert.equal(scriptName('return function(fx) end', 'make a blue fireball effect'), 'BlueFireball')
  assert.match(scriptReport({ ok: false, error: { message: 'oops', line: 2 }, prints: [], warnings: [], summary: '' }, 'a\nfx:boom()\n'), /line 2: oops\n {2}2 \| fx:boom\(\)/)
})

test('draft scripts exist for every archetype', () => {
  for (const p of ['fireball', 'sword slash', 'ground slam', 'fire breath', 'rasengan', 'explosion', 'teleport', 'heal']) {
    const s = draftScript(p)
    assert.match(s, /^return function\(fx\)|\nreturn function\(fx\)/, p)
    assert.match(s, /fx:stage\(/, p)
  }
  assert.equal(archetype('a laser beam'), 'projectile')
  assert.equal(archetype('katana slash'), 'slash')
})

// ------------------------------------------------------------------ Lune (recorder)

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
const noLune = !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false

test('the recorder reproduces the checked-in example ops', { skip: noLune }, async () => {
  for (const ex of VFX_EXAMPLES) {
    const r = await luneTimeline(ex.script, { lune: lune!, runtimeDir: runtime! })
    assert.equal(r.ok, true, `${ex.key}: ${r.error?.message}`)
    assert.deepEqual(r.ops, RECORDED[ex.key], `${ex.key}: regenerate with node --experimental-strip-types build/vfx-examples.ts`)
  }
})

test('recorder errors point at the script line; the sandbox blocks the outside world', { skip: noLune }, async () => {
  const run = (s: string) => luneTimeline(s, { lune: lune!, runtimeDir: runtime! })
  const syntax = await run('return function(fx)\n\tfx:wait(1\nend\n')
  assert.equal(syntax.ok, false)
  assert.ok(syntax.error!.line && syntax.error!.line >= 2 && syntax.error!.line <= 3, JSON.stringify(syntax.error))
  const call = await run('return function(fx)\n\tfx:wait(0.1)\n\tfx:tweem("A", 1, {})\nend\n')
  assert.equal(call.error!.line, 3)
  const bad = await run('return function(fx)\n\tfx:wait(-1)\nend\n')
  assert.equal(bad.error!.line, 2)
  const fs = await run('return function(fx)\n\tlocal f = require("@lune/fs")\nend\n')
  assert.equal(fs.ok, false)
  const game = await run('return function(fx)\n\tprint(game)\nend\n')
  assert.equal(game.ok, false)
  assert.match(game.error!.message, /not available/)
  const loop = await luneTimeline('return function(fx)\n\twhile true do end\nend\n', { lune: lune!, runtimeDir: runtime!, timeoutMs: 1500 })
  assert.equal(loop.ok, false)
  assert.match(loop.error!.message, /time|long/i)
  const printed = await run('return function(fx)\n\tprint("hi", 2)\n\tfx:stage("a")\nend\n')
  assert.deepEqual(printed.prints, ['hi\t2'])
})

test('draft scripts record and compile for every archetype', { skip: noLune }, async () => {
  for (const p of ['blue fireball', 'sword slash', 'ground slam', 'fire breath', 'rasengan', 'explosion', 'teleport', 'heal']) {
    const s = draftScript(p)
    const run = finishRun(blank(), s, await luneTimeline(s, { lune: lune!, runtimeDir: runtime! }))
    assert.equal(run.ok, true, `${p}: ${run.error?.message} (line ${run.error?.line})`)
    assert.ok(run.effect!.stages!.length >= 3, p)
    assert.ok(effectStats(run.effect!).particles > 0, p)
  }
})

test('the ForgeFX runtime and the exported modules are valid Luau', { skip: noLune }, async () => {
  const { effect } = compiled('charge-slash')
  const dir = await mkdtemp(join(tmpdir(), 'forge-seq-luau-'))
  const { writeFile } = await import('node:fs/promises')
  const { execFile } = await import('node:child_process')
  const files: Record<string, string> = { 'ForgeFX.luau': FORGEFX_SOURCE, 'Effect.luau': luauModule(effect), 'Timeline.luau': timelineModule(effect.script!) }
  const check = `local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { ${Object.keys(files).map((f) => `"${f}"`).join(', ')} } do\n\tluau.compile(fs.readFile(f))\nend\nprint("ok")\n`
  for (const [f, src] of Object.entries(files)) await writeFile(join(dir, f), src)
  await writeFile(join(dir, 'check.luau'), check)
  const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})

test('service: run, save and compose scripts (fake model with one repair round)', { skip: noLune }, async () => {
  const answers = [
    '```lua\n-- Name: Ice Nova\nreturn function(fx)\n\tfx:stage("charge")\n\tfx:spawn("orb", { name = "Core", colour = Color3.new(0, 1, 1) })\nend\n```',
    '```lua\n-- Name: Ice Nova\nreturn function(fx)\n\tfx:stage("charge")\n\tlocal c = fx:spawn("orb", { name = "Core", color = Color3.new(0, 1, 1) })\n\tfx:wait(0.4)\n\tfx:stage("release")\n\tfx:spawn("shockwave", { name = "Nova", color = Color3.new(0.6, 1, 1), size = 14 })\n\tfx:tween(c, 0.3, { Fade = 1 })\n\tfx:wait(0.5)\n\tfx:stage("dissipate")\nend\n```'
  ]
  const prompts: string[] = []
  const { svc, root, memory } = await service({ vision: () => async (_sys, prompt) => (prompts.push(prompt), answers.shift() ?? '') })
  const r = await svc.compose('an ice nova', { refine: false })
  assert.equal(r.ok, true, r.error?.message)
  assert.equal(r.source, 'model')
  assert.equal(r.entry!.name, 'IceNova')
  assert.match(prompts[1], /unknown option "colour"/)
  assert.deepEqual(r.effect!.stages!.map((s) => s.label), ['charge', 'release', 'dissipate'])
  assert.ok(memory.some((m) => m.name === 'vfx-choreography'))
  assert.ok(existsSync(join(root, 'src', 'shared', 'VFX', 'IceNova', 'Timeline.luau')))
  // Dry run: errors with a line, nothing saved.
  const dry = await svc.runScript('return function(fx)\n\tfx:spawn("orb")\n\tfx:boom()\nend\n', { id: r.entry!.id })
  assert.equal(dry.ok, false)
  assert.equal(dry.error!.line, 3)
  // Save a new script on the entry.
  const saved = await svc.runScript(SCRIPT_TEMPLATE, { id: r.entry!.id, save: true })
  assert.equal(saved.ok, true, saved.error?.message)
  assert.equal((await svc.get(r.entry!.id)).effect!.script, SCRIPT_TEMPLATE)
  // No model: the built-in draft for the archetype.
  const { svc: plain } = await service()
  const d = await plain.compose('a sword slash with sparks', { refine: false })
  assert.equal(d.source, 'draft')
  assert.ok(d.effect!.stages!.length >= 3)
})
