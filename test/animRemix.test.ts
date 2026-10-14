// Animation Lab remix ("Remix closest"): the deterministic edit ops on small synthetic R15 and R6
// clips, op-plan validation and clamping, the keyword heuristic, critic -> op params, retrieval of the
// base clip for a football request, and AnimService remix / re-apply / refine (no Lune, no model).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClip, AnimEntry, AnimKey, R15Joint } from '../src/shared/anim/model.ts'
import { qangle, qeulerDeg, xfToCf, type V3, type Xf } from '../src/shared/anim/math.ts'
import { keyXf, samplePose, sampleTrack } from '../src/shared/anim/sample.ts'
import { forwardKinematics, jointWorld } from '../src/shared/anim/r15.ts'
import { moveSetDef } from '../src/shared/anim/movesets.ts'
import { adjustRemixOps, applyRemix, clipBeatSpans, clipKeysValid, describeRemixOp, dominantSide, heuristicRemixPlan, mirrorXf, normalizeRemixOp, normalizeRemixPlan, parseRemixPlan, qscale, remixCandidates, RemixPlanError, type RemixOp } from '../src/shared/anim/remix.ts'
import { AnimService } from '../src/main/services/anim/service.ts'

const cf = (rot: V3, p: V3 = [0, 0, 0]) => xfToCf({ p, q: qeulerDeg(rot) })
const keys = (list: [number, V3, V3?][], ease: AnimKey['ease'] = 'CubicV2'): AnimKey[] => list.map(([t, r, p]) => ({ t, cf: cf(r, p), ease, dir: 'InOut' }))

// A right-footed "shot": big right leg swing, a small left leg, arms out, a waist twist and root bob.
function r15Shot(name = 'KaiserImpact'): AnimClip {
  return {
    name,
    duration: 1.2,
    looped: false,
    priority: 'Action',
    tracks: {
      Root: keys([[0, [0, 0, 0], [0, 0, 0]], [0.4, [-8, 10, 0], [0.1, -0.2, 0]], [0.55, [5, -15, 0], [-0.05, 0, 0.1]], [1.2, [0, 0, 0], [0, 0, 0]]]),
      Waist: keys([[0, [0, 0, 0]], [0.4, [-5, 20, 0]], [0.55, [8, -25, 0]], [1.2, [0, 0, 0]]]),
      RightHip: keys([[0, [0, 0, 0]], [0.4, [-55, 0, 5]], [0.5, [70, 5, -5]], [0.65, [60, 0, 0]], [1.2, [0, 0, 0]]]),
      RightKnee: keys([[0, [0, 0, 0]], [0.4, [-80, 0, 0]], [0.5, [-10, 0, 0]], [1.2, [0, 0, 0]]]),
      LeftHip: keys([[0, [0, 0, 0]], [0.45, [-10, 0, 0]], [1.2, [0, 0, 0]]]),
      LeftShoulder: keys([[0, [0, 0, 0]], [0.45, [20, 0, -40]], [1.2, [0, 0, 0]]]),
      RightShoulder: keys([[0, [0, 0, 0]], [0.45, [-20, 0, 30]], [1.2, [0, 0, 0]]]),
      Neck: keys([[0, [0, 0, 0]], [0.5, [-15, 0, 0]], [1.2, [0, 0, 0]]])
    },
    markers: [{ name: 'contact', t: 0.5 }],
    beats: [{ at: 0, label: 'anticipation' }, { at: 0.4, label: 'right foot strike' }, { at: 0.65, label: 'recovery' }]
  }
}

// The same idea on R6 (native Motor6D Transforms: these are rotations in each joint's own frame).
function r6Shot(name = 'R6Shot'): AnimClip {
  return {
    name,
    duration: 1,
    looped: false,
    priority: 'Action',
    rig: 'R6',
    tracks: {
      RootJoint: keys([[0, [0, 0, 0]], [0.35, [10, 0, 15]], [0.6, [-5, 0, -10]], [1, [0, 0, 0]]]),
      'Right Hip': keys([[0, [0, 0, 0]], [0.35, [0, 0, 50]], [0.5, [0, 0, -65]], [1, [0, 0, 0]]]),
      'Left Hip': keys([[0, [0, 0, 0]], [0.4, [0, 0, 10]], [1, [0, 0, 0]]]),
      'Right Shoulder': keys([[0, [0, 0, 0]], [0.4, [30, 0, 0]], [1, [0, 0, 0]]]),
      Neck: keys([[0, [0, 0, 0]], [0.5, [12, 5, 0]], [1, [0, 0, 0]]])
    },
    markers: []
  }
}

const close = (a: number[], b: number[], eps = 2e-4) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps)
const xfClose = (a: Xf, b: Xf, eps = 2e-3) => Math.hypot(a.p[0] - b.p[0], a.p[1] - b.p[1], a.p[2] - b.p[2]) < eps && qangle(a.q, b.q) < eps

function assertSameClip(a: AnimClip, b: AnimClip, eps = 2e-4) {
  assert.ok(Math.abs(a.duration - b.duration) < 1e-6, 'duration')
  assert.deepEqual(Object.keys(a.tracks).sort(), Object.keys(b.tracks).sort())
  for (const [j, ka] of Object.entries(a.tracks)) {
    const kb = b.tracks[j as R15Joint]!
    assert.equal(ka!.length, kb.length, `${j} key count`)
    ka!.forEach((k, i) => {
      assert.ok(Math.abs(k.t - kb[i].t) < 1e-6, `${j} t`)
      assert.ok(close(k.cf, kb[i].cf, eps), `${j}[${i}] ${k.cf} vs ${kb[i].cf}`)
      assert.equal(k.ease, kb[i].ease)
    })
  }
}

const run = (clip: AnimClip, ops: RemixOp[], lookup?: (id: string) => AnimClip | null) => {
  const r = applyRemix(clip, ops, lookup)
  assert.deepEqual(r.skipped, [])
  assert.equal(clipKeysValid(r.clip), null, `invalid keys after ${ops.map((o) => o.op).join(', ')}`)
  return r.clip
}

// ------------------------------------------------------------------ mirror

test('remix mirror: twice is the identity on R15 and R6; once swaps sides in the world', () => {
  for (const clip of [r15Shot(), r6Shot()]) {
    const once = run(clip, [{ op: 'mirror' }])
    const twice = run(clip, [{ op: 'mirror' }, { op: 'mirror' }])
    assertSameClip(twice, clip)
    assert.equal(once.rig, clip.rig)
    // The left leg now does what the right leg did, reflected (neutral frame, both rigs).
    for (const t of [0.2, 0.45, 0.5, 0.8]) {
      const a = samplePose(clip, t)
      const b = samplePose(once, t)
      assert.ok(xfClose(b.LeftHip!, mirrorXf(a.RightHip!)), `LeftHip at ${t}`)
      assert.ok(xfClose(b.RightHip!, mirrorXf(a.LeftHip!)), `RightHip at ${t}`)
      assert.ok(xfClose(b.Root!, mirrorXf(a.Root!)), `Root at ${t}`)
    }
  }
  // World check (R15): the mirrored left ankle sits where the right ankle was, reflected in x.
  const clip = r15Shot()
  const once = run(clip, [{ op: 'mirror' }])
  for (const t of [0.4, 0.5]) {
    const a = jointWorld(forwardKinematics(samplePose(clip, t)), 'RightAnkle')
    const b = jointWorld(forwardKinematics(samplePose(once, t)), 'LeftAnkle')
    assert.ok(Math.abs(a[0] + b[0]) < 1e-3 && Math.abs(a[1] - b[1]) < 1e-3 && Math.abs(a[2] - b[2]) < 1e-3, `ankle at ${t}: ${a} vs ${b}`)
  }
  assert.equal(dominantSide(clip), 'right')
  assert.equal(dominantSide(once), 'left')
  assert.equal(once.beats?.find((b) => b.at === 0.4)?.label, 'left foot strike')
})

// ------------------------------------------------------------------ retime

test('remix retime: speed and per-beat stretch keep key count and order', () => {
  for (const clip of [r15Shot(), r6Shot()]) {
    const fast = run(clip, [{ op: 'speed', factor: 2 }])
    assert.ok(Math.abs(fast.duration - clip.duration / 2) < 1e-6)
    for (const [j, ks] of Object.entries(clip.tracks)) {
      const out = fast.tracks[j as R15Joint]!
      assert.equal(out.length, ks!.length, j)
      ks!.forEach((k, i) => assert.ok(Math.abs(out[i].t - k.t / 2) < 1e-4))
    }
    // The pose at t in the fast clip is the pose at 2t in the original.
    const a = samplePose(clip, 0.5)
    const b = samplePose(fast, 0.25)
    for (const j of Object.keys(a) as R15Joint[]) assert.ok(xfClose(a[j]!, b[j]!), j)

    const { a0, a1 } = clipBeatSpans(clip)
    assert.ok(a0 > 0 && a1 > a0 && a1 < clip.duration, `beats ${a0}..${a1}`)
    const st = run(clip, [{ op: 'stretch', anticipation: 1.5, action: 0.5, recovery: 1 }])
    assert.ok(Math.abs(st.duration - (a0 * 1.5 + (a1 - a0) * 0.5 + (clip.duration - a1))) < 1e-3, `stretched duration ${st.duration}`)
    for (const [j, ks] of Object.entries(clip.tracks)) {
      const out = st.tracks[j as R15Joint]!
      assert.equal(out.length, ks!.length, j)
      for (let i = 1; i < out.length; i++) assert.ok(out[i].t > out[i - 1].t)
    }
    if (clip.markers.length) assert.ok(st.markers[0].t !== clip.markers[0].t)
  }
})

// ------------------------------------------------------------------ amplitude

test('remix amplitude: 1.0 is the identity; a part scale touches only that part', () => {
  for (const clip of [r15Shot(), r6Shot()]) {
    assertSameClip(run(clip, [{ op: 'amplitude', part: 'all', scale: 1 }]), clip)
    const big = run(clip, [{ op: 'amplitude', part: 'legs', scale: 1.5 }])
    const before = samplePose(clip, 0.5)
    const after = samplePose(big, 0.5)
    for (const j of Object.keys(before) as R15Joint[]) {
      const legs = /Hip|Knee|Ankle/.test(j)
      const a = qangle(before[j]!.q, [0, 0, 0, 1])
      const b = qangle(after[j]!.q, [0, 0, 0, 1])
      if (legs) assert.ok(a < 1e-3 || Math.abs(b - a * 1.5) < 0.02, `${j}: ${a} -> ${b}`)
      else assert.ok(xfClose(before[j]!, after[j]!), `${j} changed`)
    }
  }
  assert.ok(qangle(qscale(qeulerDeg([40, 0, 0]), 0.5), qeulerDeg([20, 0, 0])) < 1e-6)
})

// ------------------------------------------------------------------ trim / hold / loop

test('remix trim, hold and loop keep keys valid and do what they say', () => {
  for (const clip of [r15Shot(), r6Shot()]) {
    const tr = run(clip, [{ op: 'trim', from: 0.25, to: 0.75 }])
    assert.ok(Math.abs(tr.duration - clip.duration * 0.5) < 1e-3)
    assert.equal(tr.looped, false)
    const a = samplePose(clip, clip.duration * 0.25)
    const b = samplePose(tr, 0)
    for (const j of Object.keys(a) as R15Joint[]) assert.ok(xfClose(a[j]!, b[j]!), `trim start ${j}`)
    const a2 = samplePose(clip, clip.duration * 0.75)
    const b2 = samplePose(tr, tr.duration)
    for (const j of Object.keys(a2) as R15Joint[]) assert.ok(xfClose(a2[j]!, b2[j]!), `trim end ${j}`)

    const held = run(clip, [{ op: 'hold', at: 0.5, duration: 0.2 }])
    assert.ok(Math.abs(held.duration - (clip.duration + 0.2)) < 1e-3)
    const T = clip.duration * 0.5
    const h0 = samplePose(held, T)
    const h1 = samplePose(held, T + 0.1)
    const h2 = samplePose(held, T + 0.2)
    const orig = samplePose(clip, T)
    for (const j of Object.keys(h0) as R15Joint[]) assert.ok(xfClose(h0[j]!, h1[j]!) && xfClose(h1[j]!, h2[j]!) && xfClose(h0[j]!, orig[j]!), `hold ${j}`)
    // After the hold the clip carries on as before, shifted.
    const late = samplePose(clip, clip.duration * 0.9)
    const lateH = samplePose(held, clip.duration * 0.9 + 0.2)
    for (const j of Object.keys(late) as R15Joint[]) assert.ok(xfClose(late[j]!, lateH[j]!, 0.03), `after hold ${j}`)

    const looped = run(clip, [{ op: 'loop', window: 0.3 }])
    assert.equal(looped.looped, true)
    const s = samplePose(looped, 0)
    const e = samplePose(looped, looped.duration)
    for (const j of Object.keys(s) as R15Joint[]) assert.ok(xfClose(s[j]!, e[j]!), `loop seam ${j}`)
    // Before the window nothing changes.
    const m0 = samplePose(clip, 0.3)
    const m1 = samplePose(looped, 0.3)
    for (const j of Object.keys(m0) as R15Joint[]) assert.ok(xfClose(m0[j]!, m1[j]!), `loop body ${j}`)
  }
})

// ------------------------------------------------------------------ blend / transplant

test('remix blend: continuous at the crossfade window edges; exact outside it', () => {
  for (const [A, B] of [[r15Shot('A'), run(r15Shot('B'), [{ op: 'mirror' }, { op: 'amplitude', part: 'all', scale: 0.6 }])], [r6Shot('A6'), run(r6Shot('B6'), [{ op: 'mirror' }])]] as const) {
    const lookup = (id: string) => (id === 'b' ? B : null)
    const at = 0.5
    const window = 0.3
    const out = run(A, [{ op: 'blend', clip: 'b', at, window, from: 0.4 }], lookup)
    const tA = A.duration * at
    const tB = B.duration * 0.4
    assert.ok(Math.abs(out.duration - (tA + B.duration - tB)) < 1e-3, `blend duration ${out.duration}`)
    const ws = tA - window / 2
    const we = tA + window / 2
    const eps = 1e-5
    const I: Xf = { p: [0, 0, 0], q: [0, 0, 0, 1] }
    const p = (c: AnimClip, t: number) => new Proxy(samplePose(c, t), { get: (o, k) => (o as Record<string, Xf>)[k as string] ?? I }) as Record<R15Joint, Xf>
    for (const j of Object.keys(p(A, 0)) as R15Joint[]) {
      // Window edges equal the outgoing / incoming clip exactly...
      assert.ok(xfClose(p(out, ws)[j]!, p(A, ws)[j]!), `${j} at window start`)
      assert.ok(xfClose(p(out, we)[j]!, p(B, we - tA + tB)[j]!), `${j} at window end`)
      // ...and the result is continuous across them.
      assert.ok(xfClose(p(out, ws - eps)[j]!, p(out, ws + eps)[j]!, 3e-3), `${j} jump at window start`)
      assert.ok(xfClose(p(out, we - eps)[j]!, p(out, we + eps)[j]!, 3e-3), `${j} jump at window end`)
      // Outside the window: A before (at A's key times), B after.
      assert.ok(xfClose(p(out, 0)[j]!, p(A, 0)[j]!), `${j} start`)
      assert.ok(xfClose(p(out, out.duration)[j]!, p(B, B.duration)[j]!), `${j} end`)
    }
  }
  const missing = applyRemix(r15Shot(), [{ op: 'blend', clip: 'gone', at: 0.5, window: 0.2 }])
  assert.equal(missing.skipped.length, 1)
  assert.match(missing.skipped[0].reason, /not in the library/)
})

test('remix transplant: only the part joints change (legs from B, everything else from A)', () => {
  const A = r15Shot('A')
  const B = { ...run(r15Shot('B'), [{ op: 'mirror' }, { op: 'speed', factor: 0.5 }]), name: 'B' }
  const out = run(A, [{ op: 'transplant', clip: 'b', part: 'legs' }], (id) => (id === 'b' ? B : null))
  const legs = ['LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle']
  for (const [j, ka] of Object.entries(A.tracks)) {
    if (legs.includes(j)) continue
    const ko = out.tracks[j as R15Joint]!
    assert.equal(ko.length, ka!.length, j)
    ka!.forEach((k, i) => assert.ok(close(k.cf, ko[i].cf, 1e-5) && Math.abs(k.t - ko[i].t) < 1e-6, `${j} touched`))
  }
  assert.ok(Math.abs(out.duration - A.duration) < 1e-6)
  // The legs follow B, stretched onto A's length.
  const s = B.duration / A.duration
  for (const t of [0.2, 0.5, 0.9]) for (const j of legs) {
    const want = sampleTrack(B.tracks[j as R15Joint], t * s)
    const got = sampleTrack(out.tracks[j as R15Joint], t)
    if (want) assert.ok(got && xfClose(got, want), `${j} at ${t}`)
  }
  // R6 base, R15 donor: the donor converts to R6 first; arms and head stay.
  const r6 = r6Shot()
  const out6 = run(r6, [{ op: 'transplant', clip: 'b', part: 'legs' }], (id) => (id === 'b' ? A : null))
  assert.equal(out6.rig, 'R6')
  for (const j of ['RootJoint', 'Right Shoulder', 'Neck']) r6.tracks[j as 'Neck']!.forEach((k, i) => assert.ok(close(k.cf, out6.tracks[j as 'Neck']![i].cf, 1e-5), `${j} touched`))
  assert.notDeepEqual(out6.tracks['Right Hip'], r6.tracks['Right Hip'])
})

test('remix: a chain of ops on both rigs keeps every key valid (sorted, unit rotations)', () => {
  const ops: RemixOp[] = [
    { op: 'mirror' },
    { op: 'stretch', anticipation: 1.3, action: 0.8, recovery: 1.1 },
    { op: 'amplitude', part: 'rightLeg', scale: 1.4 },
    { op: 'hold', at: 0.45, duration: 0.1 },
    { op: 'trim', from: 0.05, to: 0.95 },
    { op: 'speed', factor: 1.2 },
    { op: 'loop', window: 0.2 }
  ]
  for (const clip of [r15Shot(), r6Shot()]) {
    const out = run(clip, ops)
    for (const ks of Object.values(out.tracks)) for (const k of ks!) {
      const q = keyXf(k).q
      assert.ok(Math.abs(Math.hypot(...q) - 1) < 1e-6)
    }
    assert.equal(out.script, undefined)
  }
})

// ------------------------------------------------------------------ plan validation

test('remix plan: validation clamps params, rejects bad ops and unknown clips', () => {
  assert.deepEqual(normalizeRemixOp({ op: 'speed', factor: 10 }), { op: 'speed', factor: 4 })
  assert.deepEqual(normalizeRemixOp({ op: 'speed', factor: 0.01 }), { op: 'speed', factor: 0.25 })
  assert.deepEqual(normalizeRemixOp({ op: 'amplitude', part: 'leg', scale: 9 }), { op: 'amplitude', part: 'legs', scale: 2.5 })
  assert.deepEqual(normalizeRemixOp({ op: 'amplitude', part: 'right leg', scale: 1.33 }), { op: 'amplitude', part: 'rightLeg', scale: 1.35 })
  const tr = normalizeRemixOp({ op: 'trim', from: 0.8, to: 0.2 }) as Extract<RemixOp, { op: 'trim' }>
  assert.ok(tr.to - tr.from >= 0.05 - 1e-9 && tr.to <= 1)
  assert.deepEqual(normalizeRemixOp({ op: 'hold', at: 2, duration: 9 }), { op: 'hold', at: 1, duration: 1.5 })
  const bl = normalizeRemixOp({ op: 'blend', clip: 'b', at: 0.5, window: 5 }, { clips: ['b'] }) as Extract<RemixOp, { op: 'blend' }>
  assert.equal(bl.window, 1)
  assert.equal(bl.from, 0.5)
  assert.throws(() => normalizeRemixOp({ op: 'blend', clip: 'nope', at: 0.5 }, { clips: ['b'] }), RemixPlanError)
  assert.throws(() => normalizeRemixOp({ op: 'speed', factor: 'fast' }), /must be a number/)
  assert.throws(() => normalizeRemixOp({ op: 'amplitude', part: 'tail', scale: 1 }), /part must be/)
  assert.throws(() => normalizeRemixOp({ op: 'keys', tracks: {} }), /unknown op/)
  const plan = normalizeRemixPlan({ ops: [{ op: 'mirror' }, { op: 'warp' }, ...Array.from({ length: 10 }, () => ({ op: 'speed', factor: 1.1 }))] })
  assert.equal(plan.ops.length, 8)
  assert.equal(plan.rejected.length, 4)
  assert.throws(() => normalizeRemixPlan({ nope: 1 }), RemixPlanError)
  const parsed = parseRemixPlan('Here you go:\n```json\n{"ops":[{"op":"speed","factor":1.3,"why":"snappier"},{"op":"transplant","clip":"x","part":"upper"}],"why":"faster"}\n```', { clips: ['x'] })
  assert.deepEqual(parsed.ops, [{ op: 'speed', factor: 1.3, why: 'snappier' }, { op: 'transplant', clip: 'x', part: 'upper' }])
  assert.throws(() => parseRemixPlan('no json here'), RemixPlanError)
  assert.equal(describeRemixOp({ op: 'blend', clip: 'x', at: 0.5, window: 0.2 }, { x: 'Kaiser Impact' }), 'blend into "Kaiser Impact" at 50% (from its 50%, 0.2 s crossfade)')
})

// ------------------------------------------------------------------ heuristic

test('remix heuristic: prompt words map to ops (faster, slower, left foot, bigger, shorter, loop)', () => {
  const right = r15Shot()
  const left = run(right, [{ op: 'mirror' }])
  const kinds = (ops: RemixOp[]) => ops.map((o) => o.op)
  assert.deepEqual(heuristicRemixPlan('faster', right), [{ op: 'speed', factor: 1.3, why: 'faster' }])
  assert.deepEqual(heuristicRemixPlan('much slower', right), [{ op: 'speed', factor: 0.6, why: 'slower' }])
  assert.deepEqual(kinds(heuristicRemixPlan('power shot with the left foot', right)), ['mirror'])
  assert.deepEqual(kinds(heuristicRemixPlan('power shot with the left foot', left)), [])
  assert.deepEqual(kinds(heuristicRemixPlan('mirror it', right)), ['mirror'])
  const big = heuristicRemixPlan('bigger leg swing', right)
  assert.deepEqual(big.map((o) => (o.op === 'amplitude' ? [o.part, o.scale] : o.op)), [['legs', 1.3]])
  const subtle = heuristicRemixPlan('subtler arms', right)
  assert.deepEqual(subtle.map((o) => (o.op === 'amplitude' ? [o.part, o.scale] : o.op)), [['arms', 0.75]])
  assert.ok(['trim', 'speed'].includes(heuristicRemixPlan('make it shorter', right)[0].op))
  assert.deepEqual(kinds(heuristicRemixPlan('loop it', right)), ['loop'])
  assert.deepEqual(kinds(heuristicRemixPlan('longer windup', right)), ['stretch'])
  assert.deepEqual(kinds(heuristicRemixPlan('a shot', right)), [])
  // Combined: mirror first, then speed and amplitude; all valid ops.
  const combo = heuristicRemixPlan('faster shot with the left foot and a bigger leg swing', right)
  assert.deepEqual(kinds(combo), ['mirror', 'speed', 'amplitude'])
  assert.deepEqual(normalizeRemixPlan(combo).rejected, [])
})

test('remix critic adjust: a still named part gets more amplitude; a retime scales its beat', () => {
  const clip = r15Shot()
  const { a0 } = clipBeatSpans(clip)
  const ops: RemixOp[] = [{ op: 'speed', factor: 1.2 }]
  const next = adjustRemixOps(ops, { changes: [{ kind: 'retime', from: 0, to: a0 * 0.8, scale: 1.4, why: 'longer windup' }], checks: { motion: [{ part: 'RightLeg', source: 'right foot', label: 'right leg', rangeDeg: 5, minDeg: 14, warnDeg: 24, ok: false }] } as never }, clip)!
  assert.ok(next)
  assert.deepEqual(next[0], { op: 'speed', factor: 1.2 })
  const amp = next.find((o) => o.op === 'amplitude') as Extract<RemixOp, { op: 'amplitude' }>
  assert.equal(amp.part, 'rightLeg')
  assert.equal(amp.scale, 1.35)
  const st = next.find((o) => o.op === 'stretch') as Extract<RemixOp, { op: 'stretch' }>
  assert.equal(st.anticipation, 1.4)
  assert.equal(st.action, 1)
  // Nothing to map: no change (the loop stops).
  assert.equal(adjustRemixOps(ops, { changes: [{ kind: 'fix', check: 'limits' }], checks: undefined }, clip), null)
})

// ------------------------------------------------------------------ retrieval

const entry = (id: string, name: string, tags: string[], o: Partial<AnimEntry> = {}): AnimEntry => ({
  id,
  scope: 'user',
  kind: 'imported',
  name,
  description: `${name} clip`,
  tags,
  notes: '',
  createdAt: 0,
  updatedAt: 0,
  origin: `${name}.rbxmx`,
  clip: r15Shot(name.replace(/\s+/g, '')),
  thumbs: [],
  ...o
})

test('remix retrieval: the closest usable clip of the move type for a football prompt', () => {
  const football = moveSetDef('football')
  const lib = [
    entry('kaiser', 'Kaiser Impact', ['shot']),
    entry('chip', 'Chip Finish', ['shot'], { kind: 'generated' }),
    entry('bad-shot', 'Power Shot Backswing Big', ['shot'], { rating: 'down', quality: 'avoid' }),
    entry('vid', 'Power Shot Video', ['shot', 'video'], { kind: 'media' }),
    entry('keeper', 'Keeper Dive Power', ['save']),
    entry('pass', 'Long Pass', ['pass'], { rating: 'up' }),
    entry('slide', 'Knee Slide', ['celebration'])
  ]
  const c = remixCandidates(lib, 'a power shot with a big backswing', football)
  assert.equal(c[0].id, 'kaiser')
  assert.deepEqual(c.map((x) => x.id).sort(), ['chip', 'kaiser'])
  assert.deepEqual(c[0].matched, ['shot'])
  // Words still rank within the move type; a liked clip of another type never wins a shot request.
  assert.equal(remixCandidates(lib, 'chip finish over the keeper', football)[0].id, 'chip')
  assert.equal(remixCandidates(lib, 'long pass to the wing', football)[0].id, 'pass')
  assert.equal(remixCandidates(lib, 'diving save', football)[0].id, 'keeper')
  assert.deepEqual(remixCandidates(lib, 'bicycle kick', football, { exclude: 'kaiser' }).map((x) => x.id), ['chip'])
  assert.deepEqual(remixCandidates(lib, 'throw in', football), [])
})

// ------------------------------------------------------------------ service

test('service remix: heuristic plan from the closest clip, origin recorded, re-apply, refine tunes ops', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anim-remix-'))
  try {
    const svc = new AnimService({ userDir: dir, projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, now: () => 1_000 })
    await svc.setMoveSet('football')
    assert.equal(await svc.remixMode(), 'auto')
    assert.equal(await svc.setRemixMode('scratch'), 'scratch')
    assert.equal(await svc.remixMode(), 'scratch')
    const kaiser = await svc.saveClip(r15Shot('KaiserImpact'), { prompt: 'Kaiser Impact power shot', tags: ['shot'] })
    const header = await svc.saveClip(r15Shot('DivingHeader'), { prompt: 'diving header', tags: ['header'] })
    const { candidates, tags } = await svc.remixCandidates('faster power shot with the left foot')
    assert.deepEqual(tags, ['shot'])
    assert.equal(candidates[0].id, kaiser.id)

    const r = await svc.remix('faster power shot with the left foot', { refine: false })
    assert.equal(r.ok, true)
    assert.equal(r.source, 'remix')
    const e = r.entry!
    assert.equal(e.kind, 'generated')
    assert.equal(e.remix?.base, kaiser.id)
    assert.equal(e.remix?.source, 'heuristic')
    assert.deepEqual(e.remix?.ops.map((o) => o.op), ['mirror', 'speed'])
    assert.ok(e.tags.includes('shot'))
    assert.match(e.description, /Remix of "KaiserImpact"/)
    assert.ok(Math.abs(e.clip.duration - kaiser.clip.duration / 1.3) < 1e-3)
    assert.equal(clipKeysValid(e.clip), null)
    assert.ok(r.checks?.motion?.length, 'the body-part check runs on remixes')

    // Edited ops re-apply to the base; a different base works too.
    const edited = await svc.remixApply(e.id, [{ op: 'speed', factor: 2 }])
    assert.ok(Math.abs(edited.clip.duration - kaiser.clip.duration / 2) < 1e-3)
    assert.equal(edited.remix?.source, 'user')
    const rebased = await svc.remixApply(e.id, [{ op: 'transplant', clip: header.id, part: 'upper' }], { base: kaiser.id })
    assert.equal(rebased.remix?.clips?.[header.id], header.name)
    await assert.rejects(() => svc.remixApply(e.id, [{ op: 'warp' } as never]), /invalid op/)
    await assert.rejects(() => svc.remixApply(kaiser.id, []), /not a remix/)
    await assert.rejects(() => svc.remix('a throw in'), /No usable library clip/)

    // Refine without a renderer or model: the numbers-only critic, then op params (not keys) change.
    await svc.remixApply(e.id, [{ op: 'amplitude', part: 'legs', scale: 0.1 }])
    const done = await svc.refine(e.id, { maxIterations: 3, threshold: 9.9 })
    const its = done.entry.iterations ?? []
    assert.ok(its.length >= 1)
    assert.ok(its.every((it) => Array.isArray(it.ops)), 'iterations record their ops')
    assert.ok(its.length > 1, "the critic loop re-planned at least once")
    assert.notDeepEqual(its[1].ops, its[0].ops)
    assert.ok(its[1].ops!.some((o) => o.op === "amplitude" && o.part === "leftLeg"), JSON.stringify(its[1].ops))
    assert.equal(clipKeysValid(done.entry.clip), null)
    assert.ok(done.entry.remix)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
