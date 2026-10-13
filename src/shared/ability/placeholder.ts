// Built-in placeholder pose tracks: a few keyframed R15 poses with markers, so a move can be composed
// and previewed before the Animation Lab has a clip for it (and as compose fallbacks). They produce
// the same data as the Animation Lab's getAnimPose: Motor6D.Transform per joint name.
//
// Angles are degrees about X, Y, Z (CFrame.Angles order). With the arm hanging along -Y, +X raises it
// forward (-Z) and +Z swings the right arm out to the side (-Z for the left arm).

import type { AnimClipRef } from '../anim/types.ts'
import { anglesXYZ, type Pose } from './rig.ts'

type Rot = [number, number, number]
interface Key {
  t: number
  joints: Record<string, Rot>
  // Root translation (studs) of LowerTorso relative to the root part (crouch, lunge).
  root?: [number, number, number]
}

interface Placeholder {
  ref: AnimClipRef
  keys: Key[]
}

export const PLACEHOLDER_PREFIX = 'placeholder:'

const HOLLOW_PURPLE: Placeholder = {
  ref: {
    id: 'placeholder:hollow-purple',
    name: 'Hollow Purple cast (placeholder)',
    duration: 3.6,
    looped: false,
    scope: 'user',
    markers: [
      { name: 'blue', t: 0 },
      { name: 'red', t: 0.55 },
      { name: 'converge', t: 1.1 },
      { name: 'anticipation', t: 1.95 },
      { name: 'release', t: 2.45 },
      { name: 'recover', t: 2.95 }
    ]
  },
  keys: [
    { t: 0, joints: {} },
    { t: 0.35, joints: { LeftShoulder: [20, 0, -80], LeftElbow: [10, 0, 0], Waist: [0, -12, 0], Neck: [0, -20, 0] } },
    { t: 0.9, joints: { LeftShoulder: [20, 0, -80], RightShoulder: [20, 0, 80], RightElbow: [10, 0, 0], Waist: [0, 0, 0], Neck: [0, 0, 0] } },
    { t: 1.6, joints: { LeftShoulder: [85, 0, -12], RightShoulder: [85, 0, 12], LeftElbow: [25, 0, 0], RightElbow: [25, 0, 0] } },
    { t: 2.25, joints: { Waist: [0, 28, 0], RightShoulder: [45, 0, 25], RightElbow: [80, 0, 0], LeftShoulder: [70, 0, -20], LeftElbow: [30, 0, 0], LeftHip: [25, 0, 0], RightHip: [10, 0, 0], LeftKnee: [-40, 0, 0], RightKnee: [-25, 0, 0], Neck: [0, -15, 0] }, root: [0, -0.35, 0.1] },
    { t: 2.45, joints: { Root: [-8, 0, 0], Waist: [-6, -18, 0], RightShoulder: [96, 0, 4], RightElbow: [0, 0, 0], RightWrist: [-15, 0, 0], LeftShoulder: [35, 0, -35], LeftElbow: [40, 0, 0], LeftHip: [35, 0, 0], RightHip: [-15, 0, 0], LeftKnee: [-30, 0, 0], RightKnee: [-10, 0, 0] }, root: [0, -0.2, -0.3] },
    { t: 2.85, joints: { Root: [-6, 0, 0], Waist: [-4, -14, 0], RightShoulder: [92, 0, 6], RightWrist: [-10, 0, 0], LeftShoulder: [30, 0, -35], LeftElbow: [40, 0, 0], LeftHip: [30, 0, 0], RightHip: [-12, 0, 0], LeftKnee: [-25, 0, 0], RightKnee: [-8, 0, 0] }, root: [0, -0.2, -0.3] },
    { t: 3.6, joints: {} }
  ]
}

const STRIKE: Placeholder = {
  ref: {
    id: 'placeholder:strike',
    name: 'Forward strike (placeholder)',
    duration: 0.95,
    looped: false,
    scope: 'user',
    markers: [
      { name: 'anticipation', t: 0.05 },
      { name: 'release', t: 0.32 },
      { name: 'recover', t: 0.55 }
    ]
  },
  keys: [
    { t: 0, joints: {} },
    { t: 0.24, joints: { Waist: [0, 35, 0], RightShoulder: [30, 0, 40], RightElbow: [90, 0, 0], LeftShoulder: [40, 0, -10], LeftHip: [20, 0, 0], LeftKnee: [-30, 0, 0] }, root: [0, -0.25, 0.15] },
    { t: 0.32, joints: { Waist: [-5, -25, 0], RightShoulder: [95, 0, 0], RightElbow: [0, 0, 0], LeftShoulder: [20, 0, -20], LeftElbow: [50, 0, 0], LeftHip: [35, 0, 0], RightHip: [-15, 0, 0], LeftKnee: [-25, 0, 0] }, root: [0, -0.2, -0.4] },
    { t: 0.55, joints: { Waist: [-4, -20, 0], RightShoulder: [88, 0, 0], LeftShoulder: [20, 0, -20], LeftElbow: [50, 0, 0], LeftHip: [30, 0, 0], RightHip: [-12, 0, 0], LeftKnee: [-20, 0, 0] }, root: [0, -0.2, -0.4] },
    { t: 0.95, joints: {} }
  ]
}

const SLAM: Placeholder = {
  ref: {
    id: 'placeholder:slam',
    name: 'Overhead slam (placeholder)',
    duration: 1.4,
    looped: false,
    scope: 'user',
    markers: [
      { name: 'anticipation', t: 0 },
      { name: 'release', t: 0.66 },
      { name: 'recover', t: 0.95 }
    ]
  },
  keys: [
    { t: 0, joints: {} },
    { t: 0.5, joints: { LeftShoulder: [170, 0, -10], RightShoulder: [170, 0, 10], Waist: [12, 0, 0], Neck: [15, 0, 0] }, root: [0, 0.15, 0.1] },
    { t: 0.66, joints: { LeftShoulder: [60, 0, -10], RightShoulder: [60, 0, 10], Waist: [-30, 0, 0], LeftHip: [60, 0, 0], RightHip: [60, 0, 0], LeftKnee: [-80, 0, 0], RightKnee: [-80, 0, 0], LeftAnkle: [20, 0, 0], RightAnkle: [20, 0, 0] }, root: [0, -0.9, -0.2] },
    { t: 0.95, joints: { LeftShoulder: [55, 0, -10], RightShoulder: [55, 0, 10], Waist: [-25, 0, 0], LeftHip: [55, 0, 0], RightHip: [55, 0, 0], LeftKnee: [-75, 0, 0], RightKnee: [-75, 0, 0], LeftAnkle: [20, 0, 0], RightAnkle: [20, 0, 0] }, root: [0, -0.85, -0.2] },
    { t: 1.4, joints: {} }
  ]
}

const ALL: Placeholder[] = [HOLLOW_PURPLE, STRIKE, SLAM]

export function placeholderClips(): AnimClipRef[] {
  return ALL.map((p) => ({ ...p.ref, markers: p.ref.markers.map((m) => ({ ...m })) }))
}

export function isPlaceholder(id: string): boolean {
  return String(id).startsWith(PLACEHOLDER_PREFIX)
}

const smooth = (x: number) => x * x * (3 - 2 * x)

// Pose at clip time t (clamped to the clip), interpolated between keyframes with smoothstep.
export function placeholderPose(id: string, t: number): Pose | null {
  const p = ALL.find((x) => x.ref.id === id)
  if (!p) return null
  const time = Math.max(0, Math.min(p.ref.duration, t))
  let i = 0
  while (i < p.keys.length - 2 && p.keys[i + 1].t <= time) i++
  const a = p.keys[i]
  const b = p.keys[i + 1] ?? a
  const u = b.t > a.t ? smooth(Math.max(0, Math.min(1, (time - a.t) / (b.t - a.t)))) : 0
  const names = new Set([...Object.keys(a.joints), ...Object.keys(b.joints), 'Root'])
  const d = Math.PI / 180
  const pose: Pose = {}
  for (const n of names) {
    const ra = a.joints[n] ?? [0, 0, 0]
    const rb = b.joints[n] ?? [0, 0, 0]
    const r = [0, 1, 2].map((k) => (ra[k] + (rb[k] - ra[k]) * u) * d)
    const ta = n === 'Root' ? (a.root ?? [0, 0, 0]) : [0, 0, 0]
    const tb = n === 'Root' ? (b.root ?? [0, 0, 0]) : [0, 0, 0]
    const at = [0, 1, 2].map((k) => ta[k] + (tb[k] - ta[k]) * u) as [number, number, number]
    if (r.every((x) => Math.abs(x) < 1e-9) && at.every((x) => Math.abs(x) < 1e-9)) continue
    pose[n] = anglesXYZ(r[0], r[1], r[2], at)
  }
  return pose
}
