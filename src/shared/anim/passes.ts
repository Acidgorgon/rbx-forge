// Track editing passes shared by the script compiler and the critic's patches: a mutable set of
// joint tracks, planting feet on the floor (root height + leg IK), foot plants over a time window,
// and spring overlap (follow-through) on joint chains.

import { R15_JOINTS, type AnimKey, type PoseEasingDirection, type PoseEasingStyle, type R15Joint } from './model.ts'
import { qfromAxes, qrot, qslerp, vcross, vnorm, xfToCf, type Quat, type V3, type Xf } from './math.ts'
import { forwardKinematics, jointWorld, LIMBS, type LimbName, type Pose } from './r15.ts'
import { solveTwoBone, springFollow } from './ik.ts'
import { normalizeKeys, sampleTrack } from './sample.ts'
import { clampToLimits } from './checks.ts'
import { eulerDegOf, qeulerDeg } from './math.ts'
import { reduceKeys } from './reduce.ts'

export class Tracks {
  map = new Map<R15Joint, AnimKey[]>()

  set(j: R15Joint, t: number, x: Xf, ease: PoseEasingStyle, dir: PoseEasingDirection): void {
    const keys = this.map.get(j) ?? []
    const tt = Math.round(t * 10000) / 10000
    const k: AnimKey = { t: tt, cf: xfToCf(x), ease, dir }
    const i = keys.findIndex((x) => Math.abs(x.t - tt) < 1e-4)
    if (i >= 0) keys[i] = k
    else keys.push(k)
    keys.sort((a, b) => a.t - b.t)
    this.map.set(j, keys)
  }

  sample(j: R15Joint, t: number): Xf {
    return sampleTrack(this.map.get(j), t) ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }
  }

  pose(t: number): Pose {
    const out: Pose = {}
    for (const j of R15_JOINTS) out[j] = this.sample(j, t)
    return out
  }

  maxTime(): number {
    let m = 0
    for (const keys of this.map.values()) for (const k of keys) m = Math.max(m, k.t)
    return m
  }
}

// Yaw-only version of a world rotation (feet flat on the floor).
export function flatten(q: Quat): Quat {
  const f = qrot(q, [0, 0, -1])
  const fwd = vnorm([f[0], 0, f[2]], [0, 0, -1])
  const back: V3 = [-fwd[0], 0, -fwd[2]]
  const x = vcross([0, 1, 0], back)
  return qfromAxes(vnorm(x, [1, 0, 0]), [0, 1, 0], back)
}

const ANKLE_REST_Y = 0.3

// Plants the given feet flat on the floor at time t: lowers (or raises) the root so the higher
// planted ankle sits at rest height, then solves leg IK for the others.
export function settleFeet(tracks: Tracks, t: number, feet: 'both' | 'left' | 'right' | 'none', ease: PoseEasingStyle, dir: PoseEasingDirection): void {
  if (feet === 'none') return
  const legs: LimbName[] = feet === 'both' ? ['LeftLeg', 'RightLeg'] : feet === 'left' ? ['LeftLeg'] : ['RightLeg']
  let parts = forwardKinematics(tracks.pose(t))
  const ys = legs.map((l) => jointWorld(parts, LIMBS[l].end)[1])
  const dy = Math.max(-1.4, Math.min(0.6, ANKLE_REST_Y - Math.max(...ys)))
  const root = tracks.sample('Root', t)
  tracks.set('Root', t, { p: [root.p[0], root.p[1] + dy, root.p[2]], q: root.q }, ease, dir)
  parts = forwardKinematics(tracks.pose(t))
  for (const l of legs) {
    const L = LIMBS[l]
    const a = jointWorld(parts, L.end)
    const footPart = l === 'LeftLeg' ? 'LeftFoot' : 'RightFoot'
    const r = solveTwoBone(parts, l, [a[0], ANKLE_REST_Y, a[2]], { endWorld: flatten(parts[footPart].q) })
    tracks.set(L.upper, t, { p: [0, 0, 0], q: r.upper }, ease, dir)
    tracks.set(L.lower, t, { p: [0, 0, 0], q: r.lower }, ease, dir)
    if (r.end) tracks.set(L.end, t, { p: [0, 0, 0], q: r.end }, ease, dir)
    parts = forwardKinematics(tracks.pose(t))
  }
}

const FRAME = 1 / 30

export function plantPass(tracks: Tracks, foot: 'Left' | 'Right', from: number, to: number): void {
  const limb: LimbName = foot === 'Left' ? 'LeftLeg' : 'RightLeg'
  const L = LIMBS[limb]
  const p0 = forwardKinematics(tracks.pose(from))
  const anchor = jointWorld(p0, L.end)
  const footQ = flatten(p0[foot === 'Left' ? 'LeftFoot' : 'RightFoot'].q)
  const frames: { t: number; up: Quat; low: Quat; end?: Quat }[] = []
  const n = Math.max(1, Math.round((to - from) / FRAME))
  for (let i = 0; i <= n; i++) {
    const t = from + ((to - from) * i) / n
    const parts = forwardKinematics(tracks.pose(t))
    const r = solveTwoBone(parts, limb, anchor, { endWorld: footQ })
    frames.push({ t, up: r.upper, low: r.lower, end: r.end })
  }
  for (const j of [L.upper, L.lower, L.end]) tracks.map.set(j, (tracks.map.get(j) ?? []).filter((k) => k.t < from - 1e-4 || k.t > to + 1e-4))
  for (const f of frames) {
    tracks.set(L.upper, f.t, { p: [0, 0, 0], q: f.up }, 'Linear', 'In')
    tracks.set(L.lower, f.t, { p: [0, 0, 0], q: f.low }, 'Linear', 'In')
    if (f.end) tracks.set(L.end, f.t, { p: [0, 0, 0], q: f.end }, 'Linear', 'In')
  }
  for (const j of [L.upper, L.lower, L.end]) tracks.map.set(j, reduceKeys(tracks.map.get(j)!, 0.4))
}

// Chain depth for overlap delays (the further down the chain, the later it follows).
const DEPTH: Partial<Record<R15Joint, number>> = { Waist: 1, Neck: 2, LeftShoulder: 1, RightShoulder: 1, LeftElbow: 2, RightElbow: 2, LeftWrist: 3, RightWrist: 3, LeftHip: 1, RightHip: 1, LeftKnee: 2, RightKnee: 2, LeftAnkle: 3, RightAnkle: 3, Root: 0 }

export function overlapPass(tracks: Tracks, joints: R15Joint[], duration: number, o: { delay: number; freq: number; damping: number; amount: number }): void {
  const dt = 1 / 60
  const n = Math.max(2, Math.ceil(duration / dt) + 1)
  for (const j of joints) {
    const keys = tracks.map.get(j)
    if (!keys || keys.length < 2) continue
    const lag = o.delay * (DEPTH[j] ?? 1)
    const targets: Quat[] = []
    for (let i = 0; i < n; i++) targets.push(tracks.sample(j, Math.max(0, i * dt - lag)).q)
    const sprung = springFollow(targets, dt, o.freq, o.damping)
    const out: AnimKey[] = []
    for (let i = 0; i < n; i += 2) {
      const t = Math.min(duration, i * dt)
      const orig = tracks.sample(j, t)
      const q = qslerp(orig.q, sprung[i], o.amount)
      out.push({ t: Math.round(t * 10000) / 10000, cf: xfToCf({ p: orig.p, q }), ease: 'Linear', dir: 'In' })
    }
    tracks.map.set(j, reduceKeys(normalizeKeys(out), 0.5))
  }
}


// Tracks from a clip's track map (keys copied).
export function tracksOf(src: Partial<Record<R15Joint, AnimKey[]>>): Tracks {
  const t = new Tracks()
  for (const [j, keys] of Object.entries(src) as [R15Joint, AnimKey[]][]) t.map.set(j, keys.map((k) => ({ ...k })))
  return t
}

export function trackRecord(t: Tracks): Partial<Record<R15Joint, AnimKey[]>> {
  const out: Partial<Record<R15Joint, AnimKey[]>> = {}
  for (const [j, keys] of t.map) out[j] = normalizeKeys(keys)
  return out
}

// Automatic foot contacts. Between the clip's key times a grounded foot drifts because the root and
// the leg joints interpolate separately; this pins it. For each foot, the ankle positions at the key
// times decide: a small move between two grounded keys keeps the foot locked where it was (the next
// key's leg is re-solved to the locked spot), a large move becomes a step (the foot travels on a
// low arc to the new spot). Airborne spans are left alone.
const GROUND_Y = ANKLE_REST_Y + 0.14
const STEP_MIN = 0.35

export function footLockPass(tracks: Tracks, duration: number, keyTimesIn: number[]): void {
  const times = [...new Set([0, ...keyTimesIn.filter((t) => t > 0 && t < duration), duration].map((t) => Math.round(t * 10000) / 10000))].sort((a, b) => a - b)
  if (times.length < 2) return
  for (const foot of ['Left', 'Right'] as const) {
    const limb: LimbName = foot === 'Left' ? 'LeftLeg' : 'RightLeg'
    const L = LIMBS[limb]
    const footPart = foot === 'Left' ? 'LeftFoot' : 'RightFoot'
    const at = times.map((t) => {
      const parts = forwardKinematics(tracks.pose(t))
      return { t, p: jointWorld(parts, L.end), q: flatten(parts[footPart].q) }
    })
    type Seg = { from: number; to: number; a: V3; b: V3; qa: Quat; qb: Quat }
    const segs: Seg[] = []
    let anchor: { p: V3; q: Quat } | null = at[0].p[1] < GROUND_Y ? { p: [at[0].p[0], ANKLE_REST_Y, at[0].p[2]], q: at[0].q } : null
    for (let i = 0; i + 1 < at.length; i++) {
      const next = at[i + 1]
      const nextGrounded = next.p[1] < GROUND_Y
      if (!anchor || !nextGrounded) {
        anchor = nextGrounded ? { p: [next.p[0], ANKLE_REST_Y, next.p[2]], q: next.q } : null
        continue
      }
      const d = Math.hypot(next.p[0] - anchor.p[0], next.p[2] - anchor.p[2])
      if (d < STEP_MIN) segs.push({ from: at[i].t, to: next.t, a: anchor.p, b: anchor.p, qa: anchor.q, qb: anchor.q })
      else {
        const b: V3 = [next.p[0], ANKLE_REST_Y, next.p[2]]
        segs.push({ from: at[i].t, to: next.t, a: anchor.p, b, qa: anchor.q, qb: next.q })
        anchor = { p: b, q: next.q }
      }
    }
    if (!segs.length) continue
    const frames: { t: number; up: Quat; low: Quat; end?: Quat }[] = []
    for (const s of segs) {
      const n = Math.max(1, Math.round((s.to - s.from) / FRAME))
      const moving = s.a !== s.b
      const d = Math.hypot(s.b[0] - s.a[0], s.b[2] - s.a[2])
      for (let i = 0; i <= n; i++) {
        const t = s.from + ((s.to - s.from) * i) / n
        const u = i / n
        // The foot peels up first and travels while it is off the floor, then sets down.
        const w = Math.max(0, Math.min(1, (u - 0.2) / 0.6))
        const e = w * w * (3 - 2 * w)
        const lift = Math.sin(Math.PI * u) ** 0.6 * Math.max(0.22, Math.min(0.5, d * 0.4))
        const target: V3 = moving ? [s.a[0] + (s.b[0] - s.a[0]) * e, ANKLE_REST_Y + lift, s.a[2] + (s.b[2] - s.a[2]) * e] : s.a
        const parts = forwardKinematics(tracks.pose(t))
        const r = solveTwoBone(parts, limb, target, { endWorld: moving ? qslerp(s.qa, s.qb, e) : s.qa })
        // Past the ankle's range the heel lifts instead (the toes stay down).
        const end = r.end ? qeulerDeg(clampToLimits(L.end, eulerDegOf(r.end))) : undefined
        frames.push({ t, up: r.upper, low: r.lower, end })
      }
    }
    for (const j of [L.upper, L.lower, L.end]) {
      const keep = (tracks.map.get(j) ?? []).filter((k) => !segs.some((s) => k.t >= s.from - 1e-4 && k.t <= s.to + 1e-4))
      tracks.map.set(j, keep)
    }
    for (const f of frames) {
      tracks.set(L.upper, f.t, { p: [0, 0, 0], q: f.up }, 'Linear', 'In')
      tracks.set(L.lower, f.t, { p: [0, 0, 0], q: f.low }, 'Linear', 'In')
      if (f.end) tracks.set(L.end, f.t, { p: [0, 0, 0], q: f.end }, 'Linear', 'In')
    }
    for (const j of [L.upper, L.lower, L.end]) tracks.map.set(j, reduceKeys(tracks.map.get(j)!, 0.4))
  }
}
