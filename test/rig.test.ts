// R15 / R6 rig switching: the R6 rig maths (default Motor6D C0 / C1, rest pose, the neutral <-> native
// joint frames), R15 <-> R6 conversion (limb direction kept, round trips stable), the R6
// KeyframeSequence export round trip (HumanoidRootPart > Torso > limbs), the R6 compile path (kit,
// IK, checks, the recorded R6 examples), style per rig, the service rig setting / convert / compose
// and the Ability Composer on R6 clips (part mapping, R6 solve, the AbilityRunner export).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClip } from '../src/shared/anim/model.ts'
import { cfToXf, qangle, qeulerDeg, qrot, vdist, vnorm, vsub, vdot, type V3, type Xf } from '../src/shared/anim/math.ts'
import { forwardKinematics, jointWorld } from '../src/shared/anim/r15.ts'
import { R6_JOINT, R6_JOINT_DEFS, R6_PART_FOR_R15_PART, r6ForwardKinematics, r6ForwardKinematicsNeutral, r6FromNeutral, r6JointWorld, r6LimbEnd, r6ToNeutral } from '../src/shared/anim/r6.ts'
import { collapsePose, convertClip, jointAlias, r15View, r6KitPose } from '../src/shared/anim/convert.ts'
import { compileAnim } from '../src/shared/anim/compile.ts'
import { ANIM_EXAMPLES } from '../src/shared/anim/examples.ts'
import { ANIM_RECORDED } from '../src/shared/anim/examples.recorded.ts'
import { clipRig, poseCFrames, samplePose, sampleR6 } from '../src/shared/anim/sample.ts'
import { clipFromSequence, readKeyframeSequencesXml, writeKeyframeSequenceXml, type RawPose } from '../src/shared/anim/rbxmx.ts'
import { runChecks } from '../src/shared/anim/checks.ts'
import { buildStyle, profileFor } from '../src/shared/anim/style.ts'
import { KIT_POSES } from '../src/shared/anim/kit.ts'
import { animCriticSystem } from '../src/shared/anim/critique.ts'
import { draftAnimScript, kitReferenceText } from '../src/shared/anim/draft.ts'
import { posedParts } from '../src/shared/anim/posed.ts'
import { AnimService, animComposeSystem } from '../src/main/services/anim/service.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { anglesXYZ, attachWorldFor, partForRig, solveRigFor, solveRigR6 } from '../src/shared/ability/rig.ts'
import { abilityModule, runnerModule } from '../src/shared/ability/luau.ts'
import { normalizeAbility } from '../src/shared/ability/model.ts'

const example = (key: string): AnimClip => {
  const ex = ANIM_EXAMPLES.find((e) => e.key === key)!
  return compileAnim(ANIM_RECORDED[key], ex.script, { rig: ex.rig }).clip
}
const near = (a: number[], b: number[], eps = 1e-4) => a.every((v, i) => Math.abs(v - b[i]) < eps)
const R6_NAMES = new Set(R6_JOINT_DEFS.map((d) => d.name))

// ------------------------------------------------------------------ rig maths

test('r6: default C0 / C1 are CFrame.Angles(-pi/2, 0, pi) for RootJoint / Neck and +-90 deg Y for the limbs', () => {
  const spine = anglesXYZ(-Math.PI / 2, 0, Math.PI)
  const right = anglesXYZ(0, Math.PI / 2, 0)
  const left = anglesXYZ(0, -Math.PI / 2, 0)
  for (const d of R6_JOINT_DEFS) {
    const rot = d.name === 'RootJoint' || d.name === 'Neck' ? spine : d.name.startsWith('Right') ? right : left
    assert.ok(near(d.c0.slice(3), rot.slice(3)), `${d.name} C0 rotation`)
    assert.ok(near(d.c1.slice(3), rot.slice(3)), `${d.name} C1 rotation`)
  }
  assert.deepEqual(R6_JOINT.Neck.c0.slice(0, 3), [0, 1, 0])
  assert.deepEqual(R6_JOINT.Neck.c1.slice(0, 3), [0, -0.5, 0])
  assert.deepEqual(R6_JOINT['Right Shoulder'].c0.slice(0, 3), [1, 0.5, 0])
  assert.deepEqual(R6_JOINT['Right Shoulder'].c1.slice(0, 3), [-0.5, 0.5, 0])
  assert.deepEqual(R6_JOINT['Left Hip'].c0.slice(0, 3), [-1, -1, 0])
  assert.deepEqual(R6_JOINT['Left Hip'].c1.slice(0, 3), [-0.5, 1, 0])
})

test('r6: rest pose puts the stock R6 parts where Studio does (Torso 3 studs up, 5 studs tall)', () => {
  const p = r6ForwardKinematics({})
  const at = (n: keyof typeof p) => p[n].p.map((v) => Math.round(v * 1000) / 1000)
  assert.deepEqual(at('Torso'), [0, 3, 0])
  assert.deepEqual(at('Head'), [0, 4.5, 0])
  assert.deepEqual(at('Right Arm'), [1.5, 3, 0])
  assert.deepEqual(at('Left Arm'), [-1.5, 3, 0])
  assert.deepEqual(at('Right Leg'), [0.5, 1, 0])
  assert.deepEqual(at('Left Leg'), [-0.5, 1, 0])
  for (const n of ['Torso', 'Head', 'Right Arm', 'Left Leg'] as const) assert.ok(qangle(p[n].q, [0, 0, 0, 1]) < 1e-6, `${n} upright`)
  assert.ok(near(r6JointWorld(p, 'Right Shoulder'), [1, 3.5, 0]))
  assert.ok(near(r6LimbEnd(p, 'Right Leg'), [0.5, 0, 0]), 'the feet touch the floor')
})

test('r6: neutral <-> native joint frames round trip, and Shoulder X+ raises the arm forward like R15', () => {
  const x: Xf = { p: [0.1, -0.2, 0.3], q: qeulerDeg([20, -35, 50]) }
  for (const d of R6_JOINT_DEFS) {
    const back = r6FromNeutral(d.name, r6ToNeutral(d.name, x))
    assert.ok(vdist(back.p, x.p) < 1e-6 && qangle(back.q, x.q) < 1e-6, d.name)
  }
  const raised = r6ForwardKinematicsNeutral({ RightShoulder: { p: [0, 0, 0], q: qeulerDeg([90, 0, 0]) } })
  const end = r6LimbEnd(raised, 'Right Arm')
  assert.ok(end[2] < -1.2 && Math.abs(end[1] - 3.5) < 0.6, `arm forward (-Z): ${end}`)
  const r15 = forwardKinematics({ RightShoulder: { p: [0, 0, 0], q: qeulerDeg([90, 0, 0]) } })
  assert.ok(jointWorld(r15, 'RightWrist')[2] < -1, 'the same Euler raises the R15 arm forward too')
})

// ------------------------------------------------------------------ conversion

test('convert: R15 -> R6 aims each limb at the R15 wrist / ankle (bends lost, direction kept)', () => {
  const pose = { RightShoulder: { p: [0, 0, 0] as V3, q: qeulerDeg([40, 0, 10]) }, RightElbow: { p: [0, 0, 0] as V3, q: qeulerDeg([80, 0, 0]) }, LeftHip: { p: [0, 0, 0] as V3, q: qeulerDeg([60, 0, 0]) }, LeftKnee: { p: [0, 0, 0] as V3, q: qeulerDeg([-90, 0, 0]) } }
  const r15 = forwardKinematics(pose)
  const r6 = r6ForwardKinematicsNeutral(collapsePose(pose))
  // The R6 limb's long axis (part -Y) points the way the R15 shoulder -> wrist (hip -> ankle) does.
  const dir = (a: V3, b: V3) => vnorm(vsub(b, a))
  const axis = (x: Xf) => qrot(x.q, [0, -1, 0])
  const want = dir(jointWorld(r15, 'RightShoulder'), jointWorld(r15, 'RightWrist'))
  const got = axis(r6['Right Arm'])
  assert.ok(Math.acos(Math.min(1, vdot(want, got))) < 0.02, `arm direction ${want} vs ${got}`)
  const wantLeg = dir(jointWorld(r15, 'LeftHip'), jointWorld(r15, 'LeftAnkle'))
  const gotLeg = axis(r6['Left Leg'])
  assert.ok(Math.acos(Math.min(1, vdot(wantLeg, gotLeg))) < 0.02, `leg direction ${wantLeg} vs ${gotLeg}`)
})

test('convert: R15 -> R6 -> R15 -> R6 is stable; R6 -> R15 -> R6 is lossless', () => {
  const r15 = example('sign-push')
  const a = convertClip(r15, 'R6')
  assert.equal(a.rig, 'R6')
  assert.ok(Object.keys(a.tracks).every((j) => R6_NAMES.has(j as never)), Object.keys(a.tracks).join(','))
  const b = convertClip(convertClip(a, 'R15'), 'R6')
  for (const t of [0, 0.3, 0.7, 1.1, 1.18, 1.5]) {
    const pa = sampleR6(a, t)
    const pb = sampleR6(b, t)
    for (const j of Object.keys(pa) as (keyof typeof pa)[]) assert.ok(vdist(pa[j]!.p, pb[j]!.p) < 1e-3 && qangle(pa[j]!.q, pb[j]!.q) < 1e-3, `${j} @${t}`)
  }
  const r6 = example('sign-push-r6')
  const back = convertClip(convertClip(r6, 'R15'), 'R6')
  for (const [j, keys] of Object.entries(r6.tracks)) {
    const other = (back.tracks as Record<string, typeof keys>)[j]!
    assert.equal(other.length, keys!.length, j)
    keys!.forEach((k, i) => assert.ok(near(k.cf, other[i].cf, 1e-4), `${j} key ${i}`))
  }
  assert.equal(convertClip(r15, 'R15'), r15, 'same rig: unchanged')
  assert.equal(r15View(r15), r15)
  assert.equal(r15View(r6).rig, 'R15')
})

test('convert: joint aliases and the R6 kit', () => {
  assert.equal(jointAlias('Right Shoulder'), 'RightShoulder')
  assert.equal(jointAlias('right_arm'), 'RightShoulder')
  assert.equal(jointAlias('Torso'), 'Root')
  assert.equal(jointAlias('RootJoint'), 'Root')
  assert.equal(jointAlias('Elbow'), null)
  const punch = r6KitPose(KIT_POSES.find((p) => p.name === 'punch_extend')!)
  assert.ok(punch['Right Shoulder'] && Math.abs(punch['Right Shoulder'][0]) > 45, JSON.stringify(punch))
  assert.match(kitReferenceText('R6'), /R6 versions of the kit poses/)
})

// ------------------------------------------------------------------ export

test('export: R6 clips write HumanoidRootPart > Torso > limbs and read back as R6 (keepR6)', () => {
  const clip = example('sign-push-r6')
  const xml = writeKeyframeSequenceXml(clip)
  const [seq] = readKeyframeSequencesXml(xml)
  const kf = seq.keyframes.find((k) => k.poses.length)!
  const hrp = kf.poses[0]
  assert.equal(hrp.name, 'HumanoidRootPart')
  assert.deepEqual(hrp.children.map((c) => c.name), ['Torso'])
  const names = (p: RawPose): string[] => [p.name, ...p.children.flatMap(names)]
  assert.deepEqual(new Set(names(hrp.children[0])), new Set(['Torso', 'Head', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg']))
  assert.ok(!/UpperTorso|RightHand|LowerTorso/.test(xml), 'no R15 parts in an R6 sequence')

  const { clip: back, info } = clipFromSequence(seq, { keepR6: true })
  assert.equal(info.rig, 'R6')
  assert.equal(back.rig, 'R6')
  assert.deepEqual(back.markers.map((m) => m.name), clip.markers.map((m) => m.name))
  // Same keys per R6 joint (Keyframe times are written to the millisecond).
  for (const [j, keys] of Object.entries(clip.tracks)) {
    const other = (back.tracks as Record<string, typeof keys>)[j]!
    assert.equal(other.length, keys!.length, j)
    keys!.forEach((k, i) => {
      assert.ok(Math.abs(k.t - other[i].t) < 1e-3, `${j} key ${i} time`)
      assert.ok(near(k.cf, other[i].cf, 1e-5), `${j} key ${i} cf`)
      assert.equal(other[i].ease ?? 'Linear', k.ease ?? 'Linear')
    })
  }
  // Without keepR6 the import still retargets onto R15 (and the motion matches the R15 view).
  const { clip: retargeted } = clipFromSequence(seq)
  assert.equal(clipRig(retargeted), 'R15')
  const v = samplePose(r15View(clip), 1.18)
  const r = samplePose(retargeted, 1.18)
  assert.ok(qangle(v.RightShoulder!.q, r.RightShoulder!.q) < 0.01, "same motion up to the millisecond key times")

  const pose = poseCFrames(clip, 1.18)
  assert.ok(Object.keys(pose).every((k) => R6_NAMES.has(k as never)), Object.keys(pose).join(','))
  assert.ok(Array.isArray(pose['Right Shoulder']) && pose['Right Shoulder'].length === 12)
})

// ------------------------------------------------------------------ compile, checks, style

test('compile: the R6 examples are R6 clips with markers that pass the checks', () => {
  for (const key of ['sign-push-r6', 'dash-punch-r6', 'hit-reaction-r6']) {
    const clip = example(key)
    assert.equal(clip.rig, 'R6', key)
    assert.ok(Object.keys(clip.tracks).every((j) => R6_NAMES.has(j as never)), `${key}: ${Object.keys(clip.tracks)}`)
    assert.ok(clip.markers.length >= 1, key)
    const report = runChecks(clip)
    assert.ok(report.overall >= 6.5, `${key}: ${report.overall} ${JSON.stringify(report.issues.slice(0, 3))}`)
    assert.ok(!report.issues.some((i) => /UpperTorso|RightUpperArm|LeftLowerLeg/.test(i.message)), 'issues use R6 names')
  }
  const parts = posedParts(example('sign-push-r6'), 1.18)
  assert.deepEqual(parts.map((p) => p.name).sort(), ['Head', 'Left Arm', 'Left Leg', 'Right Arm', 'Right Leg', 'Torso'])
})

test('compile: a:rig("R6") wins over the caller, R6 IK aims the whole arm, R15-only joints warn', () => {
  const reach = vdist([1, 3.5, 0], [1.5, 2, 0])
  const target: V3 = [1, 3.5, -reach]
  const ops = [
    { op: 'rig' as const, at: 0, value: 'R6', line: 1 },
    { op: 'pose' as const, at: 0, name: 'idle', line: 2 },
    { op: 'ik' as const, at: 0.4, limb: 'RightArm', target: { __t: 'v3', x: target[0], y: target[1], z: target[2] }, line: 3 },
    { op: 'joint' as const, at: 0.4, joint: 'LeftElbow', rot: { __t: 'v3', x: 30, y: 0, z: 0 }, line: 4 }
  ]
  const { clip, warnings } = compileAnim(ops, '', { rig: 'R15' })
  assert.equal(clip.rig, 'R6')
  const parts = r6ForwardKinematics(sampleR6(clip, 0.4))
  assert.ok(vdist(r6LimbEnd(parts, 'Right Arm'), target) < 0.3, `hand ${r6LimbEnd(parts, 'Right Arm')} vs ${target}`)
  assert.ok(warnings.some((w) => /LeftElbow|elbow/i.test(w)), warnings.join(' | '))
  const plain = compileAnim(ops.slice(1), '', { rig: 'R6' })
  assert.equal(plain.clip.rig, 'R6', 'the caller rig applies without a:rig')
  assert.equal(compileAnim(ops.slice(1, 3), '').clip.rig ?? 'R15', 'R15', 'default R15')
})

test('style: profiles are kept per rig; R6 falls back to R15; prompts mention the rig', () => {
  const entry = (id: string, clip: AnimClip, tags: string[]) => ({ id, name: clip.name, scope: 'user' as const, kind: 'generated' as const, origin: 'test', description: '', notes: '', tags, quality: null, rating: null, clip, createdAt: 1, updatedAt: 1 })
  const r15Only = buildStyle([entry('a', example('dash-punch'), ['attack'])] as never, 1)
  assert.equal(r15Only.r6, undefined)
  assert.equal(profileFor(r15Only, ['attack'], 'R6')?.tag, 'attack', 'R6 falls back to the R15 profile')
  const both = buildStyle([entry('a', example('dash-punch'), ['attack']), entry('b', example('dash-punch-r6'), ['attack'])] as never, 1)
  assert.ok(both.r6?.profiles.some((p) => p.tag === 'attack' && p.rig === 'R6'))
  assert.equal(profileFor(both, ['attack'], 'R6')?.rig, 'R6')
  assert.notEqual(profileFor(both, ['attack'], 'R15')?.rig, 'R6')
  assert.match(animCriticSystem('R6'), /R6/)
  assert.doesNotMatch(animCriticSystem('R6'), /an R15 Roblox/)
  assert.match(animComposeSystem('R6'), /R6 Roblox animations/)
  assert.match(draftAnimScript('quick jab', null, 'R6'), /a:rig\("R6"\)/)
  assert.doesNotMatch(draftAnimScript('quick jab', null, 'R15'), /a:rig/)
})

// ------------------------------------------------------------------ service

const lunePath = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()

test('service: project rig setting, R6 examples, convert in place / as a copy, getAnimPose names', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anim-rig-'))
  try {
    const project = join(root, 'proj')
    await mkdir(project, { recursive: true })
    let appRig: 'R15' | 'R6' = 'R15'
    const svc = new AnimService({ userDir: join(root, 'user'), projectRoot: () => project, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, defaultRig: { get: () => appRig, set: (r) => (appRig = r) }, now: () => 1000 })
    assert.equal(await svc.rig(), 'R15')
    assert.equal(await svc.setRig('R6'), 'R6')
    assert.equal(await svc.rig(), 'R6')
    assert.equal(JSON.parse(await readFile(join(project, '.forge', 'anim', 'settings.json'), 'utf8')).rig, 'R6')
    assert.equal((await svc.status()).rig, 'R6')

    const ex = await svc.addExample('sign-push-r6')
    assert.equal(ex.clip.rig, 'R6')
    const refs = await svc.listAnimClips()
    assert.equal(refs.find((r) => r.id === ex.id)?.rig, 'R6')
    const pose = await svc.getAnimPose(ex.id, 1.18)
    assert.ok(pose && Array.isArray(pose['Right Shoulder']) && !('RightShoulder' in pose))

    const copy = await svc.convert(ex.id, 'R15', { copy: true })
    assert.notEqual(copy.entry.id, ex.id)
    assert.equal(clipRig(copy.entry.clip), 'R15')
    assert.match(copy.warning, /R15/)
    const r15 = await svc.addExample('sign-push')
    const inPlace = await svc.convert(r15.id, 'R6')
    assert.equal(inPlace.entry.id, r15.id)
    assert.equal(inPlace.entry.clip.rig, 'R6')
    assert.match(inPlace.warning, /elbow/)
    assert.equal((await svc.list()).length, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('service: compose on R6 records an R6 clip (draft path through Lune)', { skip: lunePath && runtime ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'anim-rig-compose-'))
  try {
    const svc = new AnimService({ userDir: join(root, 'user'), projectRoot: () => null, lune: async () => ({ path: lunePath! }), runtimeDir: () => runtime, now: () => 1000 })
    const r = await svc.compose('a quick jab', { rig: 'R6', refine: false })
    assert.ok(r.ok, JSON.stringify(r.error))
    assert.equal(r.entry?.clip.rig, 'R6')
    assert.ok(Object.keys(r.entry!.clip.tracks).every((j) => R6_NAMES.has(j as never)))
    const scripted = await svc.runScript('return function(a)\n\ta:pose("idle")\n\ta:wait(0.3)\n\ta:pose("punch_extend")\n\ta:joint("RightElbow", Vector3.new(40, 0, 0))\nend\n', { rig: 'R6' })
    assert.ok(scripted.ok && scripted.clip?.rig === 'R6', JSON.stringify(scripted.error))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ Ability Composer

test('ability: R6 parts, the R6 solve and attachments follow the clip rig', () => {
  assert.equal(partForRig('RightHand', 'R6'), 'Right Arm')
  assert.equal(partForRig('UpperTorso', 'R6'), 'Torso')
  assert.equal(partForRig('Right Arm', 'R15'), 'RightHand')
  assert.equal(partForRig('HumanoidRootPart', 'R6'), 'HumanoidRootPart')
  assert.equal(partForRig('LeftFoot', 'R15'), 'LeftFoot')
  for (const [r15, r6] of Object.entries(R6_PART_FOR_R15_PART)) assert.equal(partForRig(r15, 'R6'), r6)

  const root = [0, 3, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  const rest = solveRigR6(root)
  const fk = r6ForwardKinematics({})
  for (const n of ['Torso', 'Head', 'Right Arm', 'Left Leg'] as const) assert.ok(near(rest[n].slice(0, 3), fk[n].p, 1e-6), n)
  // A posed R6 clip: the ability solve (Roblox CFrame arrays) matches the Lab's FK.
  const clip = example('sign-push-r6')
  const pose = poseCFrames(clip, 1.18)
  const parts = solveRigFor('R6', root, pose)
  const lab = r6ForwardKinematics(sampleR6(clip, 1.18), cfToXf(root as never))
  assert.ok(vdist(parts['Right Arm'].slice(0, 3) as V3, lab['Right Arm'].p) < 1e-3)
  const grip = attachWorldFor('R6', rest, 'RightHand', 'RightGripAttachment', [0, 0, 0], [0, 0, 0])
  assert.ok(near(grip.slice(0, 3), [1.5, 2, 0]), `grip at the bottom of the R6 arm: ${grip.slice(0, 3)}`)
  const hand = attachWorldFor('R6', rest, 'RightHand', undefined, [0, 0, 0], [0, 0, 0])
  assert.ok(near(hand.slice(0, 3), [1.5, 3, 0]), 'RightHand plays on "Right Arm"')
})

test('ability: R6 events normalise and export R6 part names; the runner maps parts between rigs', () => {
  const a = normalizeAbility({
    name: 'R6Blast',
    duration: 1.5,
    animation: { clip: 'x', name: 'SignPalmPushR6', duration: 1.74, markers: [{ name: 'release', t: 1.18 }], rig: 'R6' },
    events: [
      { id: 'hand', kind: 'vfx', effect: 'fx', effectName: 'Blast', part: 'RightHand', at: { marker: 'release', at: 0 } },
      { id: 'arm', kind: 'vfx', effect: 'fx', effectName: 'Blast', part: 'Right Arm', attachment: 'RightGripAttachment', at: 0.2 },
      { id: 'loose', kind: 'vfx', effect: 'fx', effectName: 'Blast', part: 'left_leg', at: 0.1 },
      { id: 'boom', kind: 'sound', source: 'rbxassetid://123456', part: 'UpperTorso', at: 0.3 }
    ]
  })
  assert.equal(a.animation?.rig, 'R6')
  const ev = Object.fromEntries(a.events.map((e) => [e.id, e])) as Record<string, { part?: string; attachment?: string }>
  assert.equal(ev.arm.part, 'Right Arm')
  assert.equal(ev.arm.attachment, 'RightGripAttachment')
  assert.equal(ev.loose.part, 'Left Leg')
  const mod = abilityModule(a).source
  assert.match(mod, /Part = "Right Arm"/)
  assert.match(mod, /Part = "Torso"/)
  assert.doesNotMatch(mod, /Part = "RightHand"|Part = "UpperTorso"/)
  assert.match(mod, /Rig = "R6"/)
  const r15 = abilityModule({ ...a, animation: { ...a.animation!, rig: undefined } }).source
  assert.match(r15, /Part = "RightHand"/)
  assert.match(r15, /Part = "UpperTorso"/)
  const runner = runnerModule()
  assert.match(runner, /\["Right Arm"\] = \{ "RightHand"/)
  assert.match(runner, /RightHand = \{ "Right Arm" \}/)
  assert.match(runner, /findPart\(self\.character, partName\)/)
})

test('ability: Lune compiles an R6 module with the runner', { skip: lunePath ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const { execFile } = await import('node:child_process')
  const dir = await mkdtemp(join(tmpdir(), 'ability-r6-'))
  try {
    const a = normalizeAbility({ name: 'R6Blast', duration: 1, animation: { clip: 'x', name: 'X', duration: 1, rig: 'R6' }, events: [{ id: 'v', kind: 'vfx', effect: 'fx', effectName: 'Blast', part: 'RightHand', at: 0.2 }] })
    await writeFile(join(dir, 'AbilityRunner.luau'), runnerModule())
    await writeFile(join(dir, 'R6Blast.luau'), abilityModule(a).source)
    await writeFile(join(dir, 'check.luau'), 'local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { "AbilityRunner.luau", "R6Blast.luau" } do\n\tluau.compile(fs.readFile(f))\nend\nprint("ok")\n')
    const out = await new Promise<string>((res, rej) => execFile(lunePath!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
    assert.match(out, /ok/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
