// Sampling a clip: Roblox pose easing between keys, per-joint tracks, the pose at a time, and the
// getAnimPose payload (Motor6D name -> Transform CFrame) other features use for previews.

import type { AnimClip, AnimKey, PoseEasingDirection, PoseEasingStyle, R15Joint, RigType } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { cfToXf, xfToCf, xlerp, type CF, type Xf } from './math.ts'
import type { Pose } from './r15.ts'
import { R6_JOINT_DEFS, r6ToNeutral, type R6Pose } from './r6.ts'

export function clipRig(clip: Pick<AnimClip, 'rig'> | null | undefined): RigType {
  return clip?.rig === 'R6' ? 'R6' : 'R15'
}

function bounceOut(x: number): number {
  const n1 = 7.5625
  const d1 = 2.75
  if (x < 1 / d1) return n1 * x * x
  if (x < 2 / d1) return n1 * (x -= 1.5 / d1) * x + 0.75
  if (x < 2.5 / d1) return n1 * (x -= 2.25 / d1) * x + 0.9375
  return n1 * (x -= 2.625 / d1) * x + 0.984375
}

function elasticOut(x: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  return Math.pow(2, -10 * x) * Math.sin((x * 10 - 0.75) * ((2 * Math.PI) / 3)) + 1
}

const cubicIn = (x: number) => x * x * x

// Shape of the move from one key to the next (x in 0..1). In = slow start, Out = slow end.
export function poseEase(style: PoseEasingStyle = 'Linear', dir: PoseEasingDirection = 'In', x: number): number {
  const t = Math.max(0, Math.min(1, x))
  // Legacy Cubic plays with In and Out swapped at runtime (Enum.PoseEasingStyle docs); preview what
  // the game shows.
  let d = dir
  if (style === 'Cubic') d = dir === 'In' ? 'Out' : dir === 'Out' ? 'In' : 'InOut'
  const inFn = (v: number): number => {
    switch (style) {
      case 'Linear':
        return v
      case 'Constant':
        return 0
      case 'Elastic':
        return 1 - elasticOut(1 - v)
      case 'Bounce':
        return 1 - bounceOut(1 - v)
      default:
        return cubicIn(v)
    }
  }
  if (style === 'Linear') return t
  if (style === 'Constant') return t >= 1 ? 1 : 0
  if (d === 'In') return inFn(t)
  if (d === 'Out') return 1 - inFn(1 - t)
  return t < 0.5 ? inFn(t * 2) / 2 : 1 - inFn((1 - t) * 2) / 2
}

// Keys sorted by time, duplicates (same t) collapsed to the last one.
export function normalizeKeys(keys: AnimKey[]): AnimKey[] {
  const sorted = [...keys].filter((k) => Number.isFinite(k.t)).sort((a, b) => a.t - b.t)
  const out: AnimKey[] = []
  for (const k of sorted) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.t - k.t) < 1e-5) out[out.length - 1] = k
    else out.push(k)
  }
  return out
}

const xfCache = new WeakMap<AnimKey, Xf>()
export function keyXf(k: AnimKey): Xf {
  let v = xfCache.get(k)
  if (!v) {
    v = cfToXf(k.cf)
    xfCache.set(k, v)
  }
  return v
}

export function sampleTrack(keys: AnimKey[] | undefined, t: number): Xf | null {
  if (!keys?.length) return null
  if (t <= keys[0].t) return keyXf(keys[0])
  const last = keys[keys.length - 1]
  if (t >= last.t) return keyXf(last)
  let lo = 0
  let hi = keys.length - 1
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (keys[mid].t <= t) lo = mid
    else hi = mid
  }
  const a = keys[lo]
  const b = keys[hi]
  const span = b.t - a.t
  const x = span > 1e-6 ? (t - a.t) / span : 1
  return xlerp(keyXf(a), keyXf(b), poseEase(a.ease ?? 'Linear', a.dir ?? 'In', x))
}

export function clipTime(clip: Pick<AnimClip, 'duration' | 'looped'>, t: number): number {
  const D = Math.max(1e-3, clip.duration)
  if (clip.looped) return ((t % D) + D) % D
  return Math.max(0, Math.min(D, t))
}

// The pose at t as neutral transforms on R15 joint names. On an R6 clip the six R6 Motor6Ds come back
// as their R15 equivalents (Root, Neck, shoulders, hips) in the plain joint frame, so measuring,
// checks and the R15 tools read R6 clips too (the rest of the joints stay at rest).
export function samplePose(clip: AnimClip, t: number): Pose {
  const tt = clipTime(clip, t)
  const pose: Pose = {}
  if (clipRig(clip) === 'R6') {
    for (const d of R6_JOINT_DEFS) {
      const v = sampleTrack(clip.tracks[d.name], tt)
      if (v) pose[d.r15] = r6ToNeutral(d.name, v)
    }
    return pose
  }
  for (const j of R15_JOINTS) {
    const v = sampleTrack(clip.tracks[j], tt)
    if (v) pose[j] = v
  }
  return pose
}

// Native R6 Transforms at t (R6 clips only; empty for R15 clips).
export function sampleR6(clip: AnimClip, t: number): R6Pose {
  const out: R6Pose = {}
  if (clipRig(clip) !== 'R6') return out
  const tt = clipTime(clip, t)
  for (const d of R6_JOINT_DEFS) {
    const v = sampleTrack(clip.tracks[d.name], tt)
    if (v) out[d.name] = v
  }
  return out
}

// getAnimPose payload: Motor6D name -> Transform CFrame (12 numbers, Roblox component order). R15
// clips use the R15 Motor6D names (Root, Waist, ...), R6 clips the R6 ones (RootJoint, Neck,
// "Right Shoulder", ...) with the Transform in that Motor6D's own (rotated) frame, as Roblox plays it.
export function poseCFrames(clip: AnimClip, t: number): Record<string, CF> {
  const out: Record<string, CF> = {}
  if (clipRig(clip) === 'R6') {
    for (const [j, v] of Object.entries(sampleR6(clip, t))) out[j] = xfToCf(v as Xf, 5)
    return out
  }
  const pose = samplePose(clip, t)
  for (const [j, v] of Object.entries(pose) as [R15Joint, Xf][]) out[j] = xfToCf(v, 5)
  return out
}

// All key times of a clip (sorted, unique).
export function keyTimes(clip: AnimClip): number[] {
  const s = new Set<number>()
  for (const keys of Object.values(clip.tracks)) for (const k of keys ?? []) s.add(Math.round(k.t * 1000) / 1000)
  return [...s].sort((a, b) => a - b)
}

export function keyCount(clip: AnimClip): number {
  let n = 0
  for (const keys of Object.values(clip.tracks)) n += keys?.length ?? 0
  return n
}
