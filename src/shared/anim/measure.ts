// Measuring a clip: world part transforms over time, a weighted motion-speed curve, the phases it
// implies (anticipation -> action -> recovery, holds), overshoot, silhouette spread and easing usage.
// Pure code (no model): the style profile and the automatic checks are built from these numbers.

import type { AnimClip, AnimClipStats, R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { qangle, vdist, vsub, xpoint, type V3, type Xf } from './math.ts'
import { forwardKinematics, jointWorld, type R15Part } from './r15.ts'
import { keyCount, keyTimes, samplePose, sampleTrack } from './sample.ts'

export const MEASURE_FPS = 30

export interface Frame {
  t: number
  parts: Record<R15Part, Xf>
}

export function sampleFrames(clip: AnimClip, fps = MEASURE_FPS): Frame[] {
  const n = Math.max(1, Math.round(clip.duration * fps))
  const out: Frame[] = []
  for (let i = 0; i <= n; i++) {
    const t = Math.min(clip.duration, i / fps)
    out.push({ t, parts: forwardKinematics(samplePose({ ...clip, looped: false }, t)) })
  }
  return out
}

const WEIGHT: Record<R15Joint, number> = {
  Root: 1.5,
  Waist: 1.2,
  Neck: 0.5,
  LeftShoulder: 1,
  RightShoulder: 1,
  LeftElbow: 0.8,
  RightElbow: 0.8,
  LeftWrist: 0.3,
  RightWrist: 0.3,
  LeftHip: 1,
  RightHip: 1,
  LeftKnee: 0.8,
  RightKnee: 0.8,
  LeftAnkle: 0.3,
  RightAnkle: 0.3
}

// Weighted angular speed (degrees per second, summed over joints) plus root travel, per frame.
export function speedCurve(clip: AnimClip, fps = MEASURE_FPS): { t: number[]; v: number[] } {
  const n = Math.max(1, Math.round(clip.duration * fps))
  const ts: number[] = []
  const vs: number[] = []
  const dt = 1 / fps
  for (let i = 0; i <= n; i++) {
    const t = Math.min(clip.duration, i * dt)
    const t2 = Math.min(clip.duration, t + dt)
    let v = 0
    if (t2 > t) {
      for (const j of R15_JOINTS) {
        const a = sampleTrack(clip.tracks[j], t)
        const b = sampleTrack(clip.tracks[j], t2)
        if (!a || !b) continue
        v += (WEIGHT[j] * (qangle(a.q, b.q) * 180)) / Math.PI / (t2 - t)
        if (j === 'Root') v += (vdist(a.p, b.p) / (t2 - t)) * 30
      }
    }
    ts.push(t)
    vs.push(v)
  }
  return { t: ts, v: vs }
}

export interface Phases {
  peakTime: number
  motionStart: number
  motionEnd: number
  actionStart: number
  actionEnd: number
  anticipation: number
  action: number
  recovery: number
  holds: number
}

export function phases(clip: AnimClip, curve = speedCurve(clip)): Phases {
  const { t, v } = curve
  const peak = Math.max(...v, 0)
  if (peak < 1) return { peakTime: 0, motionStart: 0, motionEnd: 0, actionStart: 0, actionEnd: 0, anticipation: 0, action: 0, recovery: 0, holds: clip.duration }
  const ip = v.indexOf(peak)
  let a0 = ip
  while (a0 > 0 && v[a0 - 1] >= peak * 0.4) a0--
  let a1 = ip
  while (a1 < v.length - 1 && v[a1 + 1] >= peak * 0.4) a1++
  let m0 = 0
  while (m0 < v.length - 1 && v[m0] < peak * 0.08) m0++
  let m1 = v.length - 1
  while (m1 > 0 && v[m1] < peak * 0.08) m1--
  m0 = Math.min(m0, a0)
  m1 = Math.max(m1, a1)
  // Holds: quiet stretches (2+ frames) between the first and last motion.
  let holds = 0
  let run = 0
  const dt = t.length > 1 ? t[1] - t[0] : 1 / MEASURE_FPS
  for (let i = m0; i <= m1; i++) {
    if (v[i] < peak * 0.08) run++
    else {
      if (run >= 2) holds += run * dt
      run = 0
    }
  }
  if (run >= 2) holds += run * dt
  const r = (x: number) => Math.round(x * 1000) / 1000
  return {
    peakTime: r(t[ip]),
    motionStart: r(t[m0]),
    motionEnd: r(t[m1]),
    actionStart: r(t[a0]),
    actionEnd: r(t[a1]),
    anticipation: r(t[a0] - t[m0]),
    action: r(t[a1] - t[a0] + dt),
    recovery: r(t[m1] - t[a1]),
    holds: r(holds)
  }
}

// How far the most active joints swing past where they settle after the action (0..1 of travel).
export function overshoot(clip: AnimClip, ph = phases(clip)): number {
  if (ph.action <= 0) return 0
  const travel = R15_JOINTS.map((j) => {
    const keys = clip.tracks[j]
    if (!keys || keys.length < 2) return { j, d: 0 }
    const a = sampleTrack(keys, ph.actionStart)!
    const b = sampleTrack(keys, ph.actionEnd)!
    return { j, d: qangle(a.q, b.q) }
  })
    .filter((x) => x.d > 0.05)
    .sort((a, b) => b.d - a.d)
    .slice(0, 3)
  if (!travel.length) return 0
  const settleAt = Math.min(clip.duration, ph.actionEnd + 0.12)
  let sum = 0
  for (const { j } of travel) {
    const keys = clip.tracks[j]!
    const start = sampleTrack(keys, ph.actionStart)!
    let max = 0
    for (let t = ph.actionStart; t <= settleAt + 1e-6; t += 1 / 60) max = Math.max(max, qangle(start.q, sampleTrack(keys, t)!.q))
    const settled = qangle(start.q, sampleTrack(keys, settleAt)!.q)
    sum += max > 1e-3 ? Math.max(0, (max - settled) / max) : 0
  }
  return Math.round((sum / travel.length) * 1000) / 1000
}

const EXTREMITIES: [R15Part, V3][] = [
  ['LeftHand', [0, -0.2, 0]],
  ['RightHand', [0, -0.2, 0]],
  ['LeftLowerArm', [0, 0.4, 0]],
  ['RightLowerArm', [0, 0.4, 0]],
  ['LeftFoot', [0, 0, -0.5]],
  ['RightFoot', [0, 0, -0.5]],
  ['LeftLowerLeg', [0, 0.4, 0]],
  ['RightLowerLeg', [0, 0.4, 0]],
  ['Head', [0, 0.4, 0]],
  ['UpperTorso', [0, 0.5, 0]],
  ['LowerTorso', [0, -0.2, 0]]
]

function hullArea(pts: [number, number][]): number {
  const p = [...pts].sort((a, b) => a[0] - b[0] || a[1] - b[1])
  if (p.length < 3) return 0
  const cross = (o: [number, number], a: [number, number], b: [number, number]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  const lower: [number, number][] = []
  for (const q of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop()
    lower.push(q)
  }
  const upper: [number, number][] = []
  for (const q of [...p].reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop()
    upper.push(q)
  }
  const hull = [...lower.slice(0, -1), ...upper.slice(0, -1)]
  let a = 0
  for (let i = 0; i < hull.length; i++) {
    const [x1, y1] = hull[i]
    const [x2, y2] = hull[(i + 1) % hull.length]
    a += x1 * y2 - x2 * y1
  }
  return Math.abs(a) / 2
}

// Silhouette spread: how much area the body's outline covers (convex hull of head, hands, elbows,
// feet, knees and torso) in the 3/4 preview view and from the side, each relative to standing, so a
// pose that opens toward the camera (a punch) counts as much as one that opens sideways. The square
// root keeps it a length ratio: 1 = as compact as standing still.
const projected = (parts: Record<R15Part, Xf>) => {
  const pts = EXTREMITIES.map(([part, local]) => xpoint(parts[part], local))
  return { three: hullArea(pts.map((p) => [p[0] * 0.857 + p[2] * 0.514, p[1]])), side: hullArea(pts.map((p) => [p[2], p[1]])) }
}
let restAreas: { three: number; side: number } | null = null
export function spreadOf(parts: Record<R15Part, Xf>): number {
  restAreas ??= projected(forwardKinematics({}))
  const a = projected(parts)
  const three = a.three / restAreas.three
  const side = a.side / restAreas.side
  return Math.sqrt(Math.max(three, 0.5 * three + 0.5 * side))
}

let restSpread: number | null = null
export function restSpreadValue(): number {
  restSpread ??= spreadOf(forwardKinematics({}))
  return restSpread
}

export function easingUsage(clip: AnimClip): Record<string, number> {
  const out: Record<string, number> = {}
  if (clip.source === 'bvh') return out
  for (const keys of Object.values(clip.tracks)) {
    for (const k of keys ?? []) {
      const key = k.ease === 'Linear' || k.ease === 'Constant' || !k.ease ? k.ease ?? 'Linear' : `${k.ease}.${k.dir ?? 'In'}`
      out[key] = (out[key] ?? 0) + 1
    }
  }
  return out
}

export function measureClip(clip: AnimClip): AnimClipStats {
  const curve = speedCurve(clip)
  const ph = phases(clip, curve)
  const frames = sampleFrames(clip, 15)
  const rest = restSpreadValue()
  const spread = Math.max(...frames.map((f) => spreadOf(f.parts) / rest), 1)
  const times = keyTimes(clip)
  return {
    duration: clip.duration,
    keys: keyCount(clip),
    keyRate: Math.round((times.length / Math.max(0.1, clip.duration)) * 100) / 100,
    anticipation: ph.anticipation,
    action: ph.action,
    recovery: ph.recovery,
    holds: ph.holds,
    overshoot: overshoot(clip, ph),
    peakTime: ph.peakTime,
    spread: Math.round(spread * 1000) / 1000,
    easing: easingUsage(clip)
  }
}

export { jointWorld }
