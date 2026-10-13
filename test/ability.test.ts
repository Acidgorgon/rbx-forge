// Ability Composer: the model and validation, marker-relative timing resolution (start, speed,
// snapping, retiming), the hit-stop time warp, root movement, shake and screen envelopes, the R15 rig,
// the timing critique rules and their fixes, the draft and the Hollow Purple example, and the Luau
// export (compiled with Lune when it is installed; skipped otherwise).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClipRef } from '../src/shared/anim/types.ts'
import type { Ability } from '../src/shared/ability/types.ts'
import { AbilityError, abilityName, applyPatch, blankAbility, defaultEvent, normalizeAbility, normalizeEvent, timeRef, upsertEvent, validateAbility } from '../src/shared/ability/model.ts'
import { advance, markerTime, realLength, refAt, resolveAbility, resolveRef, rootOffset, screenAt, screenEnvelope, shakeAt, snapToMarker, timeScaleAt, timelineText } from '../src/shared/ability/timing.ts'
import { anglesXYZ, attachWorld, inverse, RIG_JOINTS, solveRig } from '../src/shared/ability/rig.ts'
import { mul } from '../src/shared/vfx/cframe.ts'
import { isPlaceholder, placeholderClips, placeholderPose } from '../src/shared/ability/placeholder.ts'
import { applyChanges, applyTimingFixes, keyBeats, parseVisionCritique, releaseMarker, timingChecks, timingScore, vfxReleaseStage, type CritiqueContext } from '../src/shared/ability/critique.ts'
import { draftAbility, offsetFromAnchor } from '../src/shared/ability/draft.ts'
import { ABILITY_EXAMPLES, findAbilityExample } from '../src/shared/ability/examples.ts'
import { abilityModule, isOwnRunner, runnerModule } from '../src/shared/ability/luau.ts'
import { compileTimeline } from '../src/shared/vfx/compile.ts'
import { findExample } from '../src/shared/vfx/examples.ts'
import { RECORDED } from '../src/shared/vfx/examples.recorded.ts'
import { findLune } from '../src/main/services/tests/lune.ts'

const close = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) <= eps, `${a} != ${b}`)

const clip: AnimClipRef = { id: 'clip-1', name: 'Punch', duration: 1, looped: false, scope: 'user', markers: [{ name: 'anticipation', t: 0.1 }, { name: 'release', t: 0.4 }, { name: 'recover', t: 0.7 }] }

function punch(extra: Partial<Ability> = {}): Ability {
  return normalizeAbility({
    name: 'punch',
    duration: 1.2,
    animation: { clip: clip.id, name: clip.name, duration: clip.duration, markers: clip.markers, speed: 1, start: 0 },
    events: [
      { id: 'flash', kind: 'screen', effect: 'flash', at: { marker: 'release', at: 0 }, attack: 0.02, hold: 0.03, release: 0.2 },
      { id: 'shake', kind: 'shake', at: { marker: 'release', at: 0 }, duration: 0.3, amplitude: 0.5, frequency: 20 },
      { id: 'stop', kind: 'hitstop', at: { marker: 'release', at: 0 }, duration: 0.08, timeScale: 0.05 }
    ],
    ...extra
  })
}

const purpleEffect = () => {
  const ex = findExample('hollow-purple')!
  return compileTimeline({ name: ex.name, roots: [], cues: [], duration: 2 }, RECORDED[ex.key], ex.script).effect
}

// ------------------------------------------------------------------ model

test('normalizeAbility: names, defaults, clamping and errors', () => {
  const a = normalizeAbility({ name: 'hollow purple!', events: [{ kind: 'shake', at: 0.5 }, { kind: 'hitstop', at: { marker: 'release' }, timeScale: 9 }, { kind: 'screen', effect: 'BLOOM', values: { intensity: 99 } }] })
  assert.equal(a.name, 'HollowPurple')
  assert.equal(abilityName('3 hit combo'), 'Ability3HitCombo')
  assert.equal(a.events.length, 3)
  assert.deepEqual(a.events[0].at, { at: 0.5 })
  assert.equal(a.events[0].kind === 'shake' && a.events[0].falloff, 'exponential')
  const stop = a.events[1]
  assert.equal(stop.kind === 'hitstop' && stop.timeScale, 1)
  assert.deepEqual(stop.at, { marker: 'release', at: 0 })
  const bloom = a.events[2]
  assert.equal(bloom.kind === 'screen' && bloom.effect, 'bloom')
  assert.equal(bloom.kind === 'screen' && bloom.values.intensity, 5)
  assert.ok(a.duration >= 0.5)
  assert.throws(() => normalizeAbility({ events: [{ kind: 'laser' }, { kind: 'vfx' }] }), (e: Error) => e instanceof AbilityError && /kind must be/.test(e.message) && /effect \(a VFX Lab entry id\)/.test(e.message))
  assert.throws(() => normalizeAbility(null), AbilityError)
})

test('normalizeEvent: vfx attachments pick their part; sound asset ids; colours', () => {
  const v = normalizeEvent({ kind: 'vfx', effect: 'fx-1', effectName: 'my fx', attachment: 'RightGripAttachment', part: 'Head', offset: { x: 1, y: 2, z: 3 } }, 'v')
  assert.equal(v.kind === 'vfx' && v.part, 'RightHand')
  assert.equal(v.kind === 'vfx' && v.effectName, 'MyFx')
  assert.deepEqual(v.kind === 'vfx' && v.offset, [1, 2, 3])
  const s = normalizeEvent({ kind: 'sound', source: 'rbxassetid://12345678' }, 's')
  assert.deepEqual(s.kind === 'sound' && s.source, { kind: 'asset', id: 'rbxassetid://12345678' })
  const f = normalizeEvent({ kind: 'screen', effect: 'flash', values: { color: '#ff0000' } }, 'f')
  assert.deepEqual(f.kind === 'screen' && f.values.color, [1, 0, 0])
  assert.deepEqual(timeRef(-3), { at: 0 })
  assert.deepEqual(timeRef({ marker: 'release', at: -0.2 }), { marker: 'release', at: -0.2 })
})

test('validateAbility: unknown markers, duplicate ids, local sound files, events past the end', () => {
  const a = punch()
  assert.deepEqual(validateAbility(a).filter((i) => i.level === 'error'), [])
  const bad: Ability = { ...a, events: [...a.events, { ...a.events[0] }, { id: 'late', kind: 'shake', at: { at: 9 }, duration: 0.2, amplitude: 1, frequency: 10, falloff: 'none' }, { id: 'odd', kind: 'shake', at: { marker: 'nope', at: 0 }, duration: 0.2, amplitude: 1, frequency: 10, falloff: 'none' }, { id: 'snd', kind: 'sound', at: { at: 0.5 }, source: { kind: 'file', path: '/x/boom.ogg', name: 'boom.ogg' }, volume: 1, pitch: 1 }] }
  const issues = validateAbility(bad)
  assert.ok(issues.some((i) => i.level === 'error' && /duplicate event id "flash"/.test(i.message)))
  assert.ok(issues.some((i) => i.level === 'error' && /marker "nope"/.test(i.message)))
  assert.ok(issues.some((i) => i.event === 'late' && /after the end/.test(i.message)))
  assert.ok(issues.some((i) => i.event === 'snd' && /upload it to Roblox/.test(i.message)))
})

test('applyPatch: top-level fields, event upserts merge, removes', () => {
  const a = punch()
  const b = applyPatch(a, { ability: { duration: 2, animation: { speed: 2 } }, events: [{ id: 'shake', amplitude: 1.5 }, { kind: 'move', id: 'dash', at: 0.1, velocity: [0, 0, -30] }], remove: ['stop'] })
  assert.equal(b.duration, 2)
  assert.equal(b.animation!.speed, 2)
  assert.equal(b.animation!.clip, 'clip-1')
  const shake = b.events.find((e) => e.id === 'shake')!
  assert.equal(shake.kind === 'shake' && shake.amplitude, 1.5)
  assert.equal(shake.kind === 'shake' && shake.frequency, 20)
  assert.ok(b.events.some((e) => e.id === 'dash'))
  assert.ok(!b.events.some((e) => e.id === 'stop'))
  const c = upsertEvent(blankAbility('x'), defaultEvent(blankAbility('x'), 'shake', { at: 0.2 }))
  assert.equal(c.events[0].id, 'shake')
})

// ------------------------------------------------------------------ timing

test('marker-relative timing follows the animation start and speed', () => {
  const a = punch()
  close(markerTime(a, 'release')!, 0.4)
  close(markerTime(a, 'RELEASE')!, 0.4)
  assert.equal(markerTime(a, 'missing'), null)
  const fast: Ability = { ...a, animation: { ...a.animation!, speed: 2, start: 0.5 } }
  close(markerTime(fast, 'release')!, 0.7)
  close(resolveRef(fast, { marker: 'release', at: -0.1 }), 0.6)
  close(resolveRef(fast, { marker: 'missing', at: 0.3 }), 0.3)
  close(resolveRef(fast, { at: -1 }), 0)
  const r = resolveAbility(fast)
  for (const e of r.events) close(e.start, 0.7)
  close(r.animation!.end, 1)
  assert.deepEqual(r.markers.map((m) => m.name), ['anticipation', 'release', 'recover'])
})

test('retime keeps the marker; snapping finds the nearest marker in tolerance', () => {
  const a = punch()
  assert.deepEqual(refAt(a, { marker: 'release', at: 0 }, 0.55), { marker: 'release', at: 0.15 })
  assert.deepEqual(refAt(a, { at: 0 }, 0.55), { at: 0.55 })
  assert.deepEqual(snapToMarker(a, 0.43, 0.05), { t: 0.4, ref: { marker: 'release', at: 0 } })
  assert.equal(snapToMarker(a, 0.55, 0.05), null)
  close(snapToMarker(a, 0.12, 0.05)!.t, 0.1)
})

test('hit-stop slows ability time inside its window and stretches the real length', () => {
  const a = punch()
  const r = resolveAbility(a)
  assert.equal(timeScaleAt(r, 0.2), 1)
  assert.equal(timeScaleAt(r, 0.401), 0.05)
  // Window in ability time: 0.4 .. 0.4 + 0.08 * 0.05 = 0.404.
  assert.equal(timeScaleAt(r, 0.405), 1)
  close(advance(r, 0, 0.3), 0.3)
  // 0.1 s reaches the window, then 0.08 s of real time covers it, then 0.02 s at full speed.
  close(advance(r, 0.3, 0.2), 0.424, 1e-9)
  close(advance(r, 0.39, 0.05), 0.4 + 0.04 * 0.05, 1e-9)
  close(realLength(r, 1.2), 1.2 + 0.004 * (1 / 0.05 - 1), 1e-9)
})

test('root movement integrates constant and decaying velocities', () => {
  const a = normalizeAbility({ events: [{ id: 'dash', kind: 'move', at: 0.2, duration: 0.4, velocity: [0, 0, -10], easing: 'constant' }, { id: 'back', kind: 'move', at: 1, duration: 0.5, velocity: [0, 0, 8], easing: 'decay' }] })
  const r = resolveAbility(a)
  assert.deepEqual(rootOffset(r, 0.1), [0, 0, 0])
  close(rootOffset(r, 0.4)[2], -2)
  close(rootOffset(r, 0.9)[2], -4)
  // Decay: v * (d - d/2) = 8 * 0.25 = 2 once finished.
  close(rootOffset(r, 2)[2], -4 + 2)
})

test('shake and screen envelopes', () => {
  const a = punch()
  const r = resolveAbility(a)
  assert.equal(shakeAt(r, 0.3).strength, 0)
  const s = shakeAt(r, 0.45)
  assert.ok(s.strength > 0 && s.strength <= 0.5)
  assert.ok(Math.hypot(...s.offset) > 0)
  assert.deepEqual(shakeAt(r, 0.45), shakeAt(r, 0.45))
  const flash = a.events[0]
  assert.ok(flash.kind === 'screen')
  if (flash.kind === 'screen') {
    assert.equal(screenEnvelope(flash, 0.4, 0.39), 0)
    close(screenEnvelope(flash, 0.4, 0.42), 1)
    close(screenEnvelope(flash, 0.4, 0.44), 1)
    assert.ok(screenEnvelope(flash, 0.4, 0.55) < 1 && screenEnvelope(flash, 0.4, 0.55) > 0)
    assert.equal(screenEnvelope(flash, 0.4, 0.7), 0)
  }
  close(screenAt(r, 0.44).flash.opacity, 0.8)
  assert.equal(screenAt(r, 0.1).flash.opacity, 0)
  assert.match(timelineText(a), /release@0\.40/)
})

// ------------------------------------------------------------------ rig

test('R15 rig: rest pose proportions, Motor6D posing and attachments', () => {
  const root = [0, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  const rest = solveRig(root)
  close(rest.Head[1], 4.6)
  close(rest.RightHand[0], 1.5)
  close(rest.RightHand[1], 1.6)
  close(rest.LeftFoot[1], 0.15)
  // Raising the right shoulder 90 degrees about X points the arm forward (-Z).
  const raised = solveRig(root, { RightShoulder: anglesXYZ(Math.PI / 2, 0, 0) })
  close(raised.RightHand[1], 3.8, 1e-6)
  close(raised.RightHand[2], -2.2, 1e-6)
  const grip = attachWorld(raised, 'RightHand', 'RightGripAttachment', [0, 0, 0], [0, 0, 0])
  close(grip[2], -2.4, 1e-6)
  const m = anglesXYZ(0.3, -0.7, 1.1, [1, 2, 3])
  const id = mul(m, inverse(m))
  for (const [i, v] of [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1].entries()) close(id[i], v, 1e-9)
  assert.equal(RIG_JOINTS.length, 15)
})

test('placeholder pose tracks: markers, clamped time, joint transforms', () => {
  const clips = placeholderClips()
  assert.ok(clips.some((c) => c.id === 'placeholder:hollow-purple' && c.markers.some((m) => m.name === 'release')))
  assert.ok(isPlaceholder('placeholder:strike'))
  assert.equal(placeholderPose('placeholder:nope', 0), null)
  const atRelease = placeholderPose('placeholder:hollow-purple', 2.45)!
  assert.ok(atRelease.RightShoulder && atRelease.RightShoulder.length === 12)
  assert.deepEqual(placeholderPose('placeholder:hollow-purple', 99), placeholderPose('placeholder:hollow-purple', 3.6))
  const parts = solveRig([0, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1], atRelease)
  assert.ok(parts.RightHand[2] < -1.5, 'the right hand thrusts forward on the release')
})

// ------------------------------------------------------------------ critique

const ctxFor = (stages: { label: string; at: number }[]): CritiqueContext => ({ stages: () => stages, vfx: () => 1.2 })

test('timing rules pass when the impact lands on the release marker', () => {
  const a = punch()
  const checks = timingChecks(a)
  assert.deepEqual(checks.filter((c) => !c.ok), [])
  assert.equal(timingScore(checks), 10)
  assert.equal(releaseMarker(a)!.name, 'release')
})

test('timing rules flag a late flash, early shake, misplaced hit-stop, short anticipation, and fix them', () => {
  const a = applyPatch(punch(), { events: [{ id: 'flash', at: { marker: 'release', at: 0.12 } }, { id: 'shake', at: { at: 0.1 } }, { id: 'stop', at: { marker: 'release', at: 0.2 }, duration: 0.4 }] })
  const checks = timingChecks(a)
  const failed = (rule: string) => checks.find((c) => c.rule === rule && !c.ok)
  assert.ok(failed('flash-on-release'))
  assert.ok(failed('shake-on-release'))
  assert.ok(failed('hitstop-on-release'))
  assert.ok(failed('hitstop-length'))
  assert.ok(timingScore(checks) < 5)
  const fixed = applyTimingFixes(a, checks)
  const after = timingChecks(fixed)
  assert.deepEqual(after.filter((c) => !c.ok).map((c) => c.rule), [])
  const stop = fixed.events.find((e) => e.id === 'stop')!
  assert.equal(stop.kind === 'hitstop' && stop.duration, 0.15)

  const rushed = normalizeAbility({ ...punch(), animation: { ...punch().animation!, markers: [{ name: 'anticipation', t: 0.35 }, { name: 'release', t: 0.4 }] } })
  const ant = timingChecks(rushed).find((c) => c.rule === 'anticipation')!
  assert.equal(ant.ok, false)
  assert.equal(ant.level, 'error')
  const none = timingChecks(normalizeAbility({ events: [] }))
  assert.equal(none.find((c) => c.rule === 'release-marker')!.ok, false)
})

test('timing rules: the effect release stage must land on the release marker', () => {
  const base = applyPatch(punch(), { events: [{ id: 'fx', kind: 'vfx', effect: 'e1', effectName: 'Slash', at: { at: 0 } }] })
  const ctx = ctxFor([{ label: 'anticipation', at: 0 }, { label: 'slash', at: 0.25 }])
  assert.equal(vfxReleaseStage([{ label: 'charge', at: 0 }, { label: 'fire', at: 1 }])!.label, 'fire')
  const sync = timingChecks(base, ctx).find((c) => c.rule === 'vfx-release-sync')!
  assert.equal(sync.ok, false)
  assert.deepEqual(sync.fix, { event: 'fx', at: { marker: 'release', at: -0.25 } })
  const fixed = applyTimingFixes(base, timingChecks(base, ctx))
  assert.equal(timingChecks(fixed, ctx).find((c) => c.rule === 'vfx-release-sync')!.ok, true)
  assert.equal(keyBeats(fixed).find((b) => b.label === 'release')!.t, 0.4)
})

test('vision critique parsing and field edits', () => {
  const v = parseVisionCritique('```json\n{"scores":{"anticipation":6,"impact":9,"sync":8,"readability":7,"followThrough":5},"summary":"Good.","changes":[{"event":"shake","field":"amplitude","value":0.9},{"event":"flash","field":"values.opacity","value":1},{"event":"ghost","field":"at","value":1},{"event":"shake","field":"kind","value":"vfx"}]}\n```')
  close(v.overall, 7)
  assert.equal(v.changes.length, 4)
  const { ability, skipped } = applyChanges(punch(), v.changes)
  const shake = ability.events.find((e) => e.id === 'shake')!
  assert.equal(shake.kind === 'shake' && shake.amplitude, 0.9)
  const flash = ability.events.find((e) => e.id === 'flash')!
  assert.equal(flash.kind === 'screen' && flash.values.opacity, 1)
  assert.equal(skipped.length, 2)
  assert.throws(() => parseVisionCritique('no json'))
})

// ------------------------------------------------------------------ draft + example

test('draft: the effect release stage goes on the clip release marker; impact beats on the marker', () => {
  const fx = purpleEffect()
  const a = draftAbility({ request: 'hollow purple ultimate beam', clip: placeholderClips()[0], vfx: { id: 'hp', name: 'HollowPurple', duration: fx.duration, stages: fx.stages, anchor: fx.anchor } })
  assert.deepEqual(offsetFromAnchor([0, 3.2, -3]), [0, 0.2, -3])
  const ctx = ctxFor(fx.stages!)
  const bad = timingChecks(a, ctx).filter((c) => !c.ok)
  assert.deepEqual(bad.map((c) => c.message), [])
  assert.ok(a.events.some((e) => e.kind === 'move' && e.id === 'recoil'))
  const plain = draftAbility({ request: 'quick jab', clip })
  assert.ok(plain.events.every((e) => e.kind !== 'vfx'))
  assert.deepEqual(timingChecks(plain).filter((c) => !c.ok).map((c) => c.rule), [])
})

test('Hollow Purple example: VFX fire stage, flash, shake and hit-stop on the release marker', () => {
  const ex = findAbilityExample('hollow-purple')!
  assert.equal(ABILITY_EXAMPLES.length >= 1, true)
  const fx = purpleEffect()
  const a = ex.build({ 'purple-vfx': { id: 'hollow-purple-entry', duration: fx.duration } })
  const checks = timingChecks(a, { stages: () => fx.stages, vfx: () => fx.duration })
  assert.deepEqual(checks.filter((c) => !c.ok).map((c) => c.message), [])
  assert.ok(checks.some((c) => c.rule === 'vfx-release-sync' && c.ok))
  const r = resolveAbility(a, { vfx: () => fx.duration })
  for (const kind of ['shake', 'hitstop'] as const) assert.ok(r.events.some((e) => e.kind === kind && Math.abs(e.start - 2.45) < 1e-9), kind)
  assert.ok(r.events.some((e) => e.kind === 'screen' && e.event.kind === 'screen' && e.event.effect === 'flash' && Math.abs(e.start - 2.45) < 1e-9))
  assert.ok(!a.events.some((e) => (e.kind as string) === 'hitbox'))
})

// ------------------------------------------------------------------ Luau export

test('Luau export: absolute times, markers, skipped sounds, no comments', () => {
  const fx = purpleEffect()
  const a = findAbilityExample('hollow-purple')!.build({ 'purple-vfx': { id: 'x', duration: fx.duration } })
  const withSound = applyPatch(a, { events: [{ id: 'boom', kind: 'sound', at: { marker: 'release', at: 0 }, source: { kind: 'file', path: '/tmp/boom.ogg', name: 'boom.ogg' } }, { id: 'whoosh', kind: 'sound', at: 1, source: 'rbxassetid://1234567', part: 'RightHand' }] })
  const { source, skipped } = abilityModule(withSound, { vfx: () => fx.duration })
  assert.match(source, /local HollowPurple = \{/)
  assert.match(source, /Kind = "HitStop", At = 2\.45, Marker = "release", MarkerOffset = 0, Duration = 0\.09, TimeScale = 0\.05/)
  assert.match(source, /Kind = "Vfx", At = 0, Marker = "release", MarkerOffset = -2\.45, Effect = "HollowPurple", Part = "HumanoidRootPart", Offset = CFrame\.new\(0, 0\.2, -3\)/)
  assert.match(source, /SoundId = "rbxassetid:\/\/1234567"/)
  assert.match(source, /\{ Name = "release", At = 2\.45 \}/)
  assert.deepEqual(skipped, ['boom: sound without a Roblox asset id'])
  const runner = runnerModule(['ReplicatedStorage', 'Shared', 'VFX'])
  assert.ok(isOwnRunner(runner))
  for (const src of [source, runner]) assert.ok(!src.split('\n').some((l) => /^\s*--/.test(l) || /\s--\s/.test(l)), 'no comments in game scripts')
  assert.match(runner, /BindToRenderStep/)
  assert.match(runner, /AdjustSpeed/)
  assert.ok(!/RemoteEvent|OnServerEvent|TakeDamage/.test(runner), 'client only')
})

const lune = process.env.LUNE_PATH || findLune()
test('Luau export compiles with Lune', { skip: lune ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const fx = purpleEffect()
  const a = findAbilityExample('hollow-purple')!.build({ 'purple-vfx': { id: 'x', duration: fx.duration } })
  const dir = await mkdtemp(join(tmpdir(), 'forge-ability-luau-'))
  const files: Record<string, string> = { 'AbilityRunner.luau': runnerModule(), 'HollowPurple.luau': abilityModule(a).source }
  for (const [f, src] of Object.entries(files)) await writeFile(join(dir, f), src)
  const check = `local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { ${Object.keys(files).map((f) => `"${f}"`).join(', ')} } do\n\tluau.compile(fs.readFile(f))\nend\nprint("ok")\n`
  await writeFile(join(dir, 'check.luau'), check)
  const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})
