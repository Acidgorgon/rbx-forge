// Animation Lab: parsers (rbxmx, BVH, R6 retarget), IK, the timeline compiler and the built-in
// examples, style statistics (profiles, coverage, avoid exclusion), auto checks, the export round trip
// (.rbxmx write -> read, and the binary .rbxm through Lune), the Luau module, the Labs model tiers, the
// Open Cloud animation upload and AnimService import / rate / listAnimClips / getAnimPose.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClip, AnimEntry } from '../src/shared/anim/model.ts'
import { clipFromSequence, readKeyframeSequencesXml, writeKeyframeSequenceXml, type RawSequence } from '../src/shared/anim/rbxmx.ts'
import { bvhToClip, parseBvh, BvhError } from '../src/shared/anim/bvh.ts'
import { solveTwoBone } from '../src/shared/anim/ik.ts'
import { forwardKinematics, jointWorld, LIMBS } from '../src/shared/anim/r15.ts'
import { qeulerDeg, vdist, xfToCf, type V3 } from '../src/shared/anim/math.ts'
import { compileAnim, finishAnimRun, AnimCompileError } from '../src/shared/anim/compile.ts'
import { ANIM_EXAMPLES } from '../src/shared/anim/examples.ts'
import { ANIM_RECORDED } from '../src/shared/anim/examples.recorded.ts'
import { samplePose, poseCFrames, keyCount } from '../src/shared/anim/sample.ts'
import { autoTags, buildStyle, coverage, profileFor, pct } from '../src/shared/anim/style.ts'
import { runChecks } from '../src/shared/anim/checks.ts'
import { measureClip } from '../src/shared/anim/measure.ts'
import { reduceKeys } from '../src/shared/anim/reduce.ts'
import { applyAnimChanges } from '../src/shared/anim/patch.ts'
import { animLuauModule, animModuleName } from '../src/shared/anim/luau.ts'
import { heuristicAnimCritique, parseAnimCritique, beatFrameTimes } from '../src/shared/anim/critique.ts'
import { resolveLabModel, normalizeLabModels } from '../src/shared/labModels.ts'
import { uploadAnimationAsset, AssetUploadError } from '../src/main/services/art/robloxAssets.ts'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'
import { AnimService, extractAnimScript, cleanTags } from '../src/main/services/anim/service.ts'
import { animTools, ANIM_READ_TOOLS, ANIM_WRITE_TOOLS } from '../src/main/services/anim/tools.ts'
import { luneAnimExtract, luneAnimTimeline } from '../src/main/services/anim/lune.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'

const example = (key: string): AnimClip => {
  const ex = ANIM_EXAMPLES.find((e) => e.key === key)!
  return compileAnim(ANIM_RECORDED[key], ex.script).clip
}

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
const noLune = !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false

// ------------------------------------------------------------------ parsers

test('rbxmx: write -> read round trip keeps keys, easing, markers and loop', () => {
  const clip = example('sign-push')
  const xml = writeKeyframeSequenceXml(clip)
  assert.match(xml, /<Item class="KeyframeSequence"/)
  assert.match(xml, /<Item class="KeyframeMarker"/)
  const seqs = readKeyframeSequencesXml(xml)
  assert.equal(seqs.length, 1)
  const { clip: back, info } = clipFromSequence(seqs[0])
  assert.equal(info.rig, 'R15')
  assert.deepEqual(info.unmapped, [])
  assert.equal(back.name, clip.name)
  assert.ok(Math.abs(back.duration - clip.duration) < 1e-3)
  assert.deepEqual(back.markers.map((m) => m.name), ['charge', 'release'])
  for (const m of clip.markers) assert.ok(back.markers.some((b) => b.name === m.name && Math.abs(b.t - m.t) < 1e-3))
  // Pose at a few times matches within rounding.
  for (const t of [0, clip.duration * 0.3, clip.duration * 0.7]) {
    const a = poseCFrames(clip, t)
    const b = poseCFrames(back, t)
    for (const j of Object.keys(a)) for (let i = 0; i < 12; i++) assert.ok(Math.abs(a[j][i] - (b[j]?.[i] ?? NaN)) < 0.01, `${j}[${i}] at ${t}`)
  }
})

test('rbxmx: R6 sequences retarget onto R15 joints; unknown parts are reported', () => {
  const ident = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
  const rot = xfToCf({ p: [0, 0, 0], q: qeulerDeg([0, 0, 40]) })
  const seq: RawSequence = {
    name: 'R6Wave',
    loop: true,
    priority: 'Action',
    keyframes: [0, 0.5].map((time) => ({
      time,
      markers: time ? [{ name: 'wave' }] : [],
      poses: [
        { name: 'HumanoidRootPart', cf: ident, children: [{ name: 'Torso', cf: ident, children: [{ name: 'Right Arm', cf: time ? rot : ident, children: [] }, { name: 'Head', cf: ident, children: [] }, { name: 'Tail', cf: ident, children: [] }] }] }
      ]
    }))
  }
  const { clip, info } = clipFromSequence(seq)
  assert.equal(info.rig, 'R6')
  assert.deepEqual(info.unmapped, ['Tail'])
  assert.ok(clip.tracks.RightShoulder?.length === 2)
  assert.ok(clip.tracks.Neck)
  assert.equal(clip.looped, true)
  assert.deepEqual(clip.markers, [{ name: 'wave', t: 0.5 }])
  // The arm actually moves between the two keys.
  const a = forwardKinematics(samplePose(clip, 0))
  const b = forwardKinematics(samplePose(clip, 0.499)) // looped: 0.5 wraps to 0
  assert.ok(vdist(jointWorld(a, 'RightWrist'), jointWorld(b, 'RightWrist')) > 0.3)
})

test('rbxmx: rejects files without a KeyframeSequence', () => {
  assert.deepEqual(readKeyframeSequencesXml('<roblox version="4"><Item class="Part" referent="1"></Item></roblox>'), [])
})

const BVH = `HIERARCHY
ROOT Hips
{
  OFFSET 0 0 0
  CHANNELS 6 Xposition Yposition Zposition Zrotation Xrotation Yrotation
  JOINT Spine
  {
    OFFSET 0 10 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT Neck
    {
      OFFSET 0 15 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT Head
      {
        OFFSET 0 5 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0 8 0
        }
      }
    }
    JOINT LeftArm
    {
      OFFSET 8 13 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT LeftForeArm
      {
        OFFSET 12 0 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT LeftHand
        {
          OFFSET 11 0 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET 4 0 0
          }
        }
      }
    }
    JOINT RightArm
    {
      OFFSET -8 13 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT RightForeArm
      {
        OFFSET -12 0 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        JOINT RightHand
        {
          OFFSET -11 0 0
          CHANNELS 3 Zrotation Xrotation Yrotation
          End Site
          {
            OFFSET -4 0 0
          }
        }
      }
    }
  }
  JOINT LeftUpLeg
  {
    OFFSET 4 0 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT LeftLeg
    {
      OFFSET 0 -18 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT LeftFoot
      {
        OFFSET 0 -18 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0 -2 4
        }
      }
    }
  }
  JOINT RightUpLeg
  {
    OFFSET -4 0 0
    CHANNELS 3 Zrotation Xrotation Yrotation
    JOINT RightLeg
    {
      OFFSET 0 -18 0
      CHANNELS 3 Zrotation Xrotation Yrotation
      JOINT RightFoot
      {
        OFFSET 0 -18 0
        CHANNELS 3 Zrotation Xrotation Yrotation
        End Site
        {
          OFFSET 0 -2 4
        }
      }
    }
  }
}
MOTION
Frames: 3
Frame Time: 0.0333333
`

function bvhFrames(rows: number[][]): string {
  return BVH + rows.map((r) => r.join(' ')).join('\n') + '\n'
}

test('bvh: parses the hierarchy and retargets a moving forearm onto R15', () => {
  const channels = 6 + 3 * 15
  const row = (elbowZ: number) => {
    const r = new Array(channels).fill(0)
    r[1] = 38
    // Order: Hips(6) Spine Neck Head LeftArm LeftForeArm ... -> LeftForeArm starts at 6 + 4*3.
    r[6 + 4 * 3] = elbowZ
    return r
  }
  const bvh = parseBvh(bvhFrames([row(0), row(45), row(90)]))
  assert.equal(bvh.joints.length, 16)
  assert.equal(bvh.frames.length, 3)
  const { clip, mapped } = bvhToClip(bvh, { name: 'Wave', tolerance: 0 })
  assert.equal(clip.source, 'bvh')
  assert.ok(mapped.length >= 10, `mapped ${mapped.join(',')}`)
  assert.ok(Math.abs(clip.duration - 2 / 30) < 0.01)
  const a = forwardKinematics(samplePose(clip, 0))
  const b = forwardKinematics(samplePose(clip, clip.duration))
  assert.ok(vdist(jointWorld(a, 'LeftWrist'), jointWorld(b, 'LeftWrist')) > 0.4, 'the left hand moves')
  assert.ok(vdist(jointWorld(a, 'RightWrist'), jointWorld(b, 'RightWrist')) < 0.05, 'the right hand stays')
})

test('bvh: malformed input throws BvhError', () => {
  assert.throws(() => parseBvh('nope'), BvhError)
  assert.throws(() => parseBvh(BVH.replace('Frames: 3', 'Frames: x')), BvhError)
})

// ------------------------------------------------------------------ IK and compile

test('ik: two-bone solve reaches a target in range and reports out-of-range ones', () => {
  const rest = forwardKinematics({})
  for (const limb of Object.keys(LIMBS) as (keyof typeof LIMBS)[]) {
    const L = LIMBS[limb]
    const root = jointWorld(rest, L.upper)
    const target: V3 = limb.endsWith('Arm') ? [root[0] + (limb.startsWith('Left') ? -0.6 : 0.6), root[1] - 0.4, root[2] - 1.1] : [root[0], root[1] - 1.5, root[2] - 0.6]
    const r = solveTwoBone(rest, limb, target)
    assert.equal(r.reached, true, limb)
    const pose = { [L.upper]: { p: [0, 0, 0], q: r.upper }, [L.lower]: { p: [0, 0, 0], q: r.lower } } as Parameters<typeof forwardKinematics>[0]
    const parts = forwardKinematics(pose)
    assert.ok(vdist(jointWorld(parts, L.end), target) < 0.05, `${limb} end ${jointWorld(parts, L.end)} vs ${target}`)
    const far = solveTwoBone(rest, limb, [root[0], root[1], root[2] - 10])
    assert.equal(far.reached, false)
  }
})

test('compile: the recorded examples become clips with their markers and pass the checks', () => {
  const want: Record<string, string[]> = { 'sign-push': ['charge', 'release'], 'dash-punch': ['hit'], 'hit-reaction': ['impact'], 'sign-push-r6': ['charge', 'release'], 'dash-punch-r6': ['hit'], 'hit-reaction-r6': ['impact'] }
  for (const ex of ANIM_EXAMPLES) {
    const { clip, warnings } = compileAnim(ANIM_RECORDED[ex.key], ex.script)
    assert.equal(clip.name, ex.name)
    assert.deepEqual(clip.markers.map((m) => m.name), want[ex.key])
    assert.equal(clip.rig ?? 'R15', ex.rig ?? 'R15')
    assert.ok(keyCount(clip) > (ex.rig === 'R6' ? 12 : 20), `${ex.key} keys`)
    assert.ok(clip.beats && clip.beats.length >= 3)
    assert.ok(!warnings.some((w) => /error/i.test(w)), warnings.join('; '))
    const report = runChecks(clip)
    assert.ok(report.overall >= 7.5, `${ex.key} checks ${report.overall}: ${report.issues.map((i) => i.message).join('; ')}`)
    assert.ok(report.scores.limits >= 8, `${ex.key} limits ${report.scores.limits}`)
  }
})

test('compile: bad ops fail with the script line', () => {
  assert.throws(() => compileAnim([{ at: 0, line: 7, op: 'pose', name: 'no_such_pose' } as never], 'x'), (e: unknown) => e instanceof AnimCompileError && (e as AnimCompileError).line === 7 && /no pose "no_such_pose"/.test((e as Error).message))
  const failed = finishAnimRun({ ok: false, ops: [], prints: [], error: { message: 'boom', line: 3 } } as never, 'x')
  assert.equal(failed.ok, false)
  assert.equal(failed.error?.line, 3)
})

// ------------------------------------------------------------------ style statistics and checks

function entry(id: string, clip: AnimClip, extra: Partial<AnimEntry> = {}): AnimEntry {
  return { id, name: clip.name, scope: 'user', kind: 'imported', clip, tags: autoTags(clip, id), createdAt: 1, updatedAt: 1, description: '', notes: '', ...extra } as AnimEntry
}

test('style: auto tags, profiles per tag, liked weighting and avoid exclusion', () => {
  const sign = example('sign-push')
  const dash = example('dash-punch')
  const hit = example('hit-reaction')
  assert.ok(autoTags(dash, 'DashPunch.rbxmx').includes('dash'))
  assert.ok(autoTags(hit, 'HitReaction').includes('hit'))
  assert.ok(!autoTags(hit, 'HitReaction').includes('attack'))
  const floaty = { ...dash, name: 'Floaty', duration: dash.duration * 2.5 }
  const entries = [
    entry('a', sign, { tags: ['sign', 'cast', 'attack'], rating: 'up' }),
    entry('b', dash, { tags: ['dash', 'attack'] }),
    entry('c', hit, { tags: ['hit'] }),
    entry('d', floaty, { tags: ['attack'], quality: 'avoid', rating: 'down', notes: 'too floaty, no anticipation' })
  ]
  const style = buildStyle(entries, 5)
  const attack = profileFor(style, ['attack'])!
  assert.equal(attack.tag, 'attack')
  assert.equal(attack.samples, 2, 'avoid clips are not samples')
  assert.equal(attack.liked, 1)
  assert.ok(attack.avoid.some((n) => /floaty/.test(n)), attack.avoid.join(' | '))
  assert.ok(attack.timing.action.median > 0 && attack.timing.action.median < 0.5)
  assert.ok(attack.poses.length >= 1)
  const cov = coverage(entries)
  const row = cov.tags.find((t) => t.tag === 'attack')!
  assert.deepEqual([row.clips, row.liked, row.disliked], [2, 1, 1])
  assert.ok(cov.thin.includes('idle'))
  const p = pct([1, 2, 3, 4, 5])
  assert.equal(p.median, 3)
})

test('measure + checks: a foot slide, a joint past its limit and a dead pose are flagged', () => {
  const still: AnimClip = { name: 'Still', duration: 1, looped: false, priority: 'Action', tracks: { Root: [{ t: 0, cf: xfToCf({ p: [0, 0, 0], q: [0, 0, 0, 1] }) }, { t: 1, cf: xfToCf({ p: [0, 0, -2], q: [0, 0, 0, 1] }) }] }, markers: [] }
  const r = runChecks(still)
  assert.ok(r.slideStuds > 1, `slide ${r.slideStuds}`)
  assert.ok(r.issues.some((i) => i.check === 'sliding'))
  assert.ok(r.issues.some((i) => i.check === 'readability'))
  const bent: AnimClip = { ...still, tracks: { LeftKnee: [{ t: 0, cf: xfToCf({ p: [0, 0, 0], q: qeulerDeg([60, 0, 0]) }) }] } }
  const r2 = runChecks(bent)
  assert.ok(r2.worstLimitDeg > 20, `limit ${r2.worstLimitDeg}`)
  assert.ok(r2.issues.some((i) => i.check === 'limits' && i.joint === 'LeftKnee'))
  const stats = measureClip(example('dash-punch'))
  assert.ok(stats.spread > 1.3, `spread ${stats.spread}`)
})

test('reduce + patch: key reduction keeps the shape; changes apply and bad ones are rejected', () => {
  const keys = Array.from({ length: 31 }, (_, i) => ({ t: i / 30, cf: xfToCf({ p: [0, 0, 0], q: qeulerDeg([i * 2, 0, 0]) }) }))
  const reduced = reduceKeys(keys, 0.6)
  assert.ok(reduced.length <= 3, `kept ${reduced.length}`)
  const clip = example('sign-push')
  const { applied, rejected, clip: next } = applyAnimChanges(clip, [{ kind: 'retime', from: 0, to: clip.duration, scale: 0.8 }, { kind: 'nonsense' }])
  assert.equal(rejected.length, 1)
  assert.equal(applied.length, 1)
  assert.ok(next.duration < clip.duration)
})

test('critique: heuristic fallback, parsed model output and beat frame times', () => {
  const clip = example('dash-punch')
  const checks = runChecks(clip)
  const h = heuristicAnimCritique(clip, checks)
  assert.ok(h.overall > 0 && h.overall <= 10)
  const p = parseAnimCritique('```json\n{"scores":{"silhouette":8,"timing":7,"weight":6,"arcs":7,"appeal":8,"cleanliness":9},"summary":"ok","changes":[]}\n```', checks)
  assert.equal(p.scores.weight, 6)
  const times = beatFrameTimes(clip, 6)
  assert.ok(times.length >= 3 && times.length <= 6)
  assert.ok(times.every((t) => t >= 0 && t <= clip.duration))
})

// ------------------------------------------------------------------ export

test('luau module: markers, priority, the asset id and the Studio fallback', () => {
  const clip = example('sign-push')
  assert.equal(animModuleName('Sign_Push!'), 'Sign_Push')
  const src = animLuauModule(clip, { description: 'A sign "push"', assetId: '1234' })
  assert.match(src, /AnimationId = "rbxassetid:\/\/1234"/)
  assert.match(src, /Priority = Enum\.AnimationPriority\.Action/)
  assert.match(src, /GetMarkerReachedSignal/)
  assert.match(src, /"charge"/)
  assert.match(src, /"release"/)
  assert.match(src, /RegisterKeyframeSequence/)
  assert.match(src, /IsStudio/)
  const none = animLuauModule(clip)
  assert.match(none, /AnimationId = ""/)
})

test('lune: the example scripts record to the committed ops; binary .rbxm round trip', { skip: noLune }, async () => {
  for (const ex of ANIM_EXAMPLES) {
    const r = await luneAnimTimeline(ex.script, { lune: lune!, runtimeDir: runtime! })
    assert.equal(r.ok, true, r.error?.message)
    assert.deepEqual(r.ops, ANIM_RECORDED[ex.key], `${ex.key}: regenerate examples.recorded.ts (node --experimental-strip-types build/anim-examples.ts)`)
  }
  const bad = await luneAnimTimeline('return function(a)\n\ta:pose("idle")\n\terror("nope")\nend\n', { lune: lune!, runtimeDir: runtime! })
  assert.equal(bad.ok, false)
  assert.equal(bad.error?.line, 3)

  const dir = await mkdtemp(join(tmpdir(), 'anim-rbxm-'))
  try {
    const clip = example('dash-punch')
    await writeFile(join(dir, 'seq.rbxmx'), writeKeyframeSequenceXml(clip))
    const conv = `local fs = require("@lune/fs")\nlocal roblox = require("@lune/roblox")\nlocal m = roblox.deserializeModel(fs.readFile("seq.rbxmx"))\nfs.writeFile("seq.rbxm", roblox.serializeModel(m))\n`
    await writeFile(join(dir, 'conv.luau'), conv)
    await new Promise<void>((res, rej) => execFile(lune!, ['run', 'conv.luau'], { cwd: dir }, (err, _o, stderr) => (err ? rej(new Error(stderr || err.message)) : res())))
    const [out] = await luneAnimExtract([join(dir, 'seq.rbxm')], { lune: lune!, runtimeDir: runtime! })
    assert.ok(out.sequences?.length === 1, out.error)
    const back = clipFromSequence(out.sequences![0]).clip
    assert.deepEqual(back.markers.map((m) => m.name), ['hit'])
    assert.ok(Math.abs(back.duration - clip.duration) < 1e-3)
    const a = poseCFrames(clip, clip.duration * 0.5)
    const b = poseCFrames(back, clip.duration * 0.5)
    for (const j of Object.keys(a)) for (let i = 0; i < 12; i++) assert.ok(Math.abs(a[j][i] - (b[j]?.[i] ?? NaN)) < 0.01, `${j}[${i}]`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ model tiers and upload

test('labs: tier resolution (setting, then provider tier, then the chat model)', () => {
  const tiers = { cheap: 'claude-haiku', big: 'claude-opus' }
  assert.equal(resolveLabModel('cheap', {}, 'claude-sonnet', tiers), 'claude-haiku')
  assert.equal(resolveLabModel('default', {}, 'claude-sonnet', tiers), 'claude-sonnet')
  assert.equal(resolveLabModel('critic', {}, 'claude-sonnet', tiers), 'claude-opus')
  assert.equal(resolveLabModel('critic', { critic: ' gpt-x ' }, 'claude-sonnet', tiers), 'gpt-x')
  assert.equal(resolveLabModel('cheap', null, 'llama3', null), 'llama3')
  assert.deepEqual(normalizeLabModels({ cheap: '', default: 3, critic: 'm', other: 'x' }), { critic: 'm' })
})

function fakeFetch(replies: { status: number; body: string }[]): { fetch: ArtFetch; calls: { url: string; init: Record<string, unknown> }[] } {
  const calls: { url: string; init: Record<string, unknown> }[] = []
  let i = 0
  const fetch = (async (url: string, init: Record<string, unknown> = {}) => {
    calls.push({ url, init })
    const r = replies[Math.min(i++, replies.length - 1)]
    return { ok: r.status < 300, status: r.status, headers: { get: () => null }, text: async () => r.body, json: async () => JSON.parse(r.body) }
  }) as unknown as ArtFetch
  return { fetch, calls }
}

test('upload: KeyframeSequence goes to Open Cloud as an Animation asset (model/x-rbxm)', async () => {
  const xml = writeKeyframeSequenceXml(example('hit-reaction'))
  const { fetch, calls } = fakeFetch([
    { status: 200, body: JSON.stringify({ path: 'operations/op-1', done: false }) },
    { status: 200, body: JSON.stringify({ path: 'operations/op-1', done: true, response: { assetId: '777' } }) }
  ])
  const r = await uploadAnimationAsset({ apiKey: 'k'.repeat(30), bytes: Buffer.from(xml), fileName: 'HitReaction.rbxmx', displayName: 'HitReaction', creator: { userId: 5 }, fetch, sleep: async () => {} })
  assert.equal(r.assetId, '777')
  assert.equal(calls[0].url, 'https://apis.roblox.com/assets/v1/assets')
  const body = Buffer.from(calls[0].init.body as Uint8Array).toString('latin1')
  assert.match(body, /"assetType":"Animation"/)
  assert.match(body, /filename="HitReaction.rbxmx"\r\nContent-Type: model\/x-rbxm/)
  assert.throws(() => uploadAnimationAsset({ apiKey: 'k', bytes: Buffer.from('x'), fileName: 'a.fbx', displayName: 'a', creator: { userId: 1 } }), AssetUploadError)
})

// ------------------------------------------------------------------ service

test('service: import with tags, rate, avoid exclusion, listAnimClips / getAnimPose, export', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anim-svc-'))
  try {
    const project = join(root, 'proj')
    await mkdir(project, { recursive: true })
    const files = join(root, 'files')
    await mkdir(files)
    await writeFile(join(files, 'DashPunch.rbxmx'), writeKeyframeSequenceXml(example('dash-punch')))
    await writeFile(join(files, 'Floaty_Punch.rbxmx'), writeKeyframeSequenceXml({ ...example('dash-punch'), name: 'FloatyPunch' }))
    const remembered: string[] = []
    const svc = new AnimService({
      userDir: join(root, 'user'),
      projectRoot: () => project,
      lune: async () => ({ error: 'no lune' }),
      runtimeDir: () => null,
      memory: { remember: async (input) => (remembered.push(input.name), { entry: { name: input.name } }) },
      now: () => 1000
    })
    const preview = await svc.previewImport([join(files, 'DashPunch.rbxmx')])
    assert.equal(preview.length, 1)
    assert.ok(preview[0].suggestedTags?.includes('dash'), JSON.stringify(preview[0]))
    const good = await svc.import([join(files, 'DashPunch.rbxmx')], 'user', { tags: ['dash', 'attack', 'Attack'] })
    assert.equal(good.added.length, 1)
    assert.deepEqual(good.added[0].tags, ['dash', 'attack'])
    const bad = await svc.import([join(files, 'Floaty_Punch.rbxmx')], 'project', { tags: ['attack'], quality: 'avoid' })
    const badEntry = bad.added[0]
    assert.equal(badEntry.quality, 'avoid')
    assert.equal(badEntry.rating, 'down')

    const refs = await svc.listAnimClips()
    assert.deepEqual(refs.map((r) => r.name), ['DashPunch'], 'avoid clips are not offered')
    assert.deepEqual(Object.keys(refs[0]).sort(), ['duration', 'id', 'looped', 'markers', 'name', 'rig', 'scope'])
    assert.deepEqual(refs[0].markers.map((m) => m.name), ['hit'])
    const pose = await svc.getAnimPose(refs[0].id, refs[0].markers[0].t)
    assert.ok(pose && Array.isArray(pose.RightShoulder) && pose.RightShoulder.length === 12)
    assert.equal(await svc.getAnimPose('missing', 0), null)

    const found = await svc.search('punch', { tags: ['attack'] })
    assert.ok(found.every((e) => e.quality !== 'avoid'))
    const cov = await svc.coverage()
    const attack = cov.tags.find((t) => t.tag === 'attack')!
    assert.equal(attack.disliked, 1)

    const liked = await svc.rate(refs[0].id, 'up')
    assert.equal(liked.rating, 'up')
    const style = await svc.style()
    assert.ok(style?.profiles.some((p) => p.tag === 'attack' && p.liked === 1 && p.avoid.length >= 1))
    assert.ok(remembered.some((n) => n.startsWith('anim-style-')), remembered.join(','))

    const ex = await svc.addExample('sign-push')
    assert.equal(ex.name, 'SignPalmPush')
    assert.equal(ex.kind, 'generated')
    const exp = await svc.export(ex.id)
    const mod = await readFile(join(project, exp.module), 'utf8')
    assert.match(mod, /GetMarkerReachedSignal/)
    const seq = await readFile(join(project, exp.model), 'utf8')
    assert.equal(readKeyframeSequencesXml(seq).length, 1)
    await assert.rejects(svc.upload(ex.id), /key|Open Cloud/i)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('service helpers and tools: script extraction, tag cleaning, tool names', () => {
  assert.equal(extractAnimScript('Here:\n```lua\nreturn function(a)\nend\n```'), 'return function(a)\nend\n')
  assert.equal(extractAnimScript('no code'), null)
  assert.deepEqual(cleanTags(['Attack', 'attack', ' cast ', '', 5, 'x'.repeat(80)]).slice(0, 2), ['attack', 'cast'])
  const svc = new AnimService({ userDir: join(tmpdir(), 'anim-none'), projectRoot: () => null, lune: async () => ({ error: 'x' }), runtimeDir: () => null })
  const t = animTools(svc)
  assert.deepEqual(t.read.map((x) => x.name), [...ANIM_READ_TOOLS])
  assert.deepEqual(t.write.map((x) => x.name), [...ANIM_WRITE_TOOLS])
})
