// R15 <-> R6 for whole clips and poses.
//
// R6 -> R15 (lossless): each R6 Motor6D maps onto the R15 joint with the same job (RootJoint -> Root,
// Neck, shoulders, hips) with its Transform turned from the R6 joint's rotated frame into the plain
// frame (r6ToNeutral). Waist, elbows, wrists, knees and ankles stay at rest.
//
// R15 -> R6 (loses detail): the two torso parts become one Torso that follows UpperTorso, and each
// arm and leg (upper, lower, hand / foot) becomes one straight part that keeps the overall limb
// direction: the R6 arm points from the shoulder toward where the R15 wrist was, the leg from the hip
// toward the R15 ankle, keeping the upper segment's twist. Waist, elbow, wrist, knee and ankle bends
// are gone, and converting back gives straight limbs. R15 -> R6 -> R15 -> R6 is stable.
//
// The "R15 view" of a clip is what measuring, checks, style and patches read: the clip itself for R15,
// the lossless R6 -> R15 mapping for R6.

import type { AnimClip, AnimKey, PoseEasingDirection, PoseEasingStyle, R15Joint, RigType } from './model.ts'
import { eulerDegOf, qconj, qfromTo, qmul, qnorm, qrot, vnorm, vsub, xfToCf, type Quat, type V3, type Xf } from './math.ts'
import { KIT_POSES, resolveKitPose, type KitPose } from './kit.ts'
import { forwardKinematics, jointWorld, type Pose } from './r15.ts'
import { R15_OF_R6, R6_CAPABLE, R6_JOINT_DEFS, R6_OF_R15, r6FromNeutral, r6ToNeutral, type R6Joint } from './r6.ts'
import { clipRig, keyXf, normalizeKeys, sampleTrack } from './sample.ts'

export const RIG_CONVERT_WARNING = {
  R6: 'Converting to R6 merges UpperTorso and LowerTorso into one Torso and each arm and leg into one part: waist, elbow, wrist, knee and ankle bends are lost (each limb keeps its overall direction). Converting back to R15 gives straight limbs.',
  R15: 'Converting to R15 maps the six R6 joints onto Root, Neck, shoulders and hips; the new R15 joints (waist, elbows, wrists, knees, ankles) start at rest.'
} as const

// ------------------------------------------------------------------ poses

// Neutral R6 pose (keyed by the R15 names of the six R6 joints) for an R15 pose.
export function collapsePose(pose: Pose): Partial<Record<R15Joint, Xf>> {
  const parts = forwardKinematics(pose)
  const torso = parts.UpperTorso.q
  const torsoInv = qconj(torso)
  const hrpInv = qconj(parts.HumanoidRootPart.q)
  const out: Partial<Record<R15Joint, Xf>> = {}
  const p = (j: R15Joint) => pose[j]?.p ?? [0, 0, 0]
  out.Root = { p: [...p('Root')] as Xf['p'], q: qnorm(qmul(hrpInv, torso)) }
  out.Neck = { p: [...p('Neck')] as Xf['p'], q: qnorm(qmul(torsoInv, parts.Head.q)) }
  const limb = (j: R15Joint, upperPart: 'RightUpperArm' | 'LeftUpperArm' | 'RightUpperLeg' | 'LeftUpperLeg', end: R15Joint) => {
    const upper = parts[upperPart].q
    const down = qrot(upper, [0, -1, 0])
    const want = vnorm(vsub(jointWorld(parts, end), jointWorld(parts, j)), down)
    const world = qnorm(qmul(qfromTo(down, want), upper))
    out[j] = { p: [...p(j)] as Xf['p'], q: qnorm(qmul(torsoInv, world)) }
  }
  limb('RightShoulder', 'RightUpperArm', 'RightWrist')
  limb('LeftShoulder', 'LeftUpperArm', 'LeftWrist')
  limb('RightHip', 'RightUpperLeg', 'RightAnkle')
  limb('LeftHip', 'LeftUpperLeg', 'LeftAnkle')
  return out
}

// Which R15 joints each R6 joint depends on in collapsePose (their key times become R6 key times).
const DEPS: Record<R6Joint, R15Joint[]> = {
  RootJoint: ['Root', 'Waist'],
  Neck: ['Neck'],
  'Right Shoulder': ['RightShoulder', 'RightElbow'],
  'Left Shoulder': ['LeftShoulder', 'LeftElbow'],
  'Right Hip': ['RightHip', 'RightKnee', 'Waist'],
  'Left Hip': ['LeftHip', 'LeftKnee', 'Waist']
}

// ------------------------------------------------------------------ tracks

type Tracks = Partial<Record<string, AnimKey[]>>

// R6 tracks (native) -> R15 tracks (neutral, six joints). Lossless.
export function r6TracksToR15(tracks: Tracks): Partial<Record<R15Joint, AnimKey[]>> {
  const out: Partial<Record<R15Joint, AnimKey[]>> = {}
  for (const d of R6_JOINT_DEFS) {
    const keys = tracks[d.name]
    if (!keys?.length) continue
    out[d.r15] = keys.map((k) => ({ ...k, cf: xfToCf(r6ToNeutral(d.name, keyXf(k))) }))
  }
  return out
}

// R15 tracks (neutral) -> neutral R6 tracks on the R15 names of the six R6 joints (collapsing limbs).
export function r15TracksToR6Neutral(tracks: Tracks): Partial<Record<R15Joint, AnimKey[]>> {
  const r = (t: number) => Math.round(t * 10000) / 10000
  const sampleAll = (t: number): Pose => {
    const pose: Pose = {}
    for (const [j, keys] of Object.entries(tracks)) {
      const v = sampleTrack(keys, t)
      if (v) pose[j as R15Joint] = v
    }
    return pose
  }
  const cache = new Map<number, Partial<Record<R15Joint, Xf>>>()
  const collapsed = (t: number) => {
    let c = cache.get(t)
    if (!c) {
      c = collapsePose(sampleAll(t))
      cache.set(t, c)
    }
    return c
  }
  const out: Partial<Record<R15Joint, AnimKey[]>> = {}
  for (const d of R6_JOINT_DEFS) {
    const deps = DEPS[d.name]
    const times = new Set<number>()
    for (const j of deps) for (const k of tracks[j] ?? []) times.add(r(k.t))
    if (!times.size) continue
    const main = tracks[d.r15] ?? []
    const keys: AnimKey[] = []
    for (const t of [...times].sort((a, b) => a - b)) {
      // Easing: the main joint's key at that time, else any contributing joint's key there.
      const src = main.find((k) => Math.abs(k.t - t) < 1e-4) ?? deps.map((j) => tracks[j]?.find((k) => Math.abs(k.t - t) < 1e-4)).find(Boolean)
      const ease: PoseEasingStyle = src?.ease ?? 'Linear'
      const dir: PoseEasingDirection = src?.dir ?? 'In'
      keys.push({ t, cf: xfToCf(collapsed(t)[d.r15]!), ease, dir })
    }
    out[d.r15] = normalizeKeys(keys)
  }
  return out
}

// Neutral tracks on R15 names (only the six R6 joints are read) -> native R6 tracks.
export function neutralToR6Tracks(tracks: Tracks): Partial<Record<R6Joint, AnimKey[]>> {
  const out: Partial<Record<R6Joint, AnimKey[]>> = {}
  for (const d of R6_JOINT_DEFS) {
    const keys = tracks[d.r15]
    if (!keys?.length) continue
    out[d.name] = keys.map((k) => ({ ...k, cf: xfToCf(r6FromNeutral(d.name, keyXf(k))) }))
  }
  return out
}

// Neutral R15-named tracks that only use R6-capable joints (no collapsing needed).
export function onlyR6Capable(tracks: Tracks): boolean {
  return Object.entries(tracks).every(([j, keys]) => !keys?.length || (R6_CAPABLE as string[]).includes(j))
}

// ------------------------------------------------------------------ clips

const viewCache = new WeakMap<AnimClip, AnimClip>()

// The clip as R15 joints (R6 clips mapped losslessly); R15 clips come back unchanged.
export function r15View(clip: AnimClip): AnimClip {
  if (clipRig(clip) !== 'R6') return clip
  let v = viewCache.get(clip)
  if (!v) {
    v = { ...clip, rig: 'R15', tracks: r6TracksToR15(clip.tracks) }
    viewCache.set(clip, v)
  }
  return v
}

// R15-named neutral tracks (e.g. an R15 view after edits) -> an R6 clip's native tracks.
export function r6TracksFromView(tracks: Tracks): Partial<Record<R6Joint, AnimKey[]>> {
  return neutralToR6Tracks(onlyR6Capable(tracks) ? tracks : r15TracksToR6Neutral(tracks))
}

export function convertClip(clip: AnimClip, to: RigType): AnimClip {
  const from = clipRig(clip)
  if (from === to) return clip
  if (to === 'R6') {
    const tracks = neutralToR6Tracks(r15TracksToR6Neutral(clip.tracks))
    return { ...clip, rig: 'R6', tracks }
  }
  const { rig: _rig, ...rest } = clip
  return { ...rest, tracks: r6TracksToR15(clip.tracks) }
}

// R6 joint names accepted where R15 names are expected (scripts, critic changes): the Motor6D name,
// the Pose (part) name, or the R15 name.
export function jointAlias(name: string): R15Joint | null {
  const s = String(name ?? '').trim().toLowerCase().replace(/[\s_]+/g, '')
  for (const d of R6_JOINT_DEFS) {
    if (d.name.toLowerCase().replace(/\s+/g, '') === s || d.part1.toLowerCase().replace(/\s+/g, '') === s) return d.r15
  }
  if (s === 'root' || s === 'humanoidrootpart') return 'Root'
  return null
}

export { R15_OF_R6, R6_OF_R15 }
export type { Quat }

// ------------------------------------------------------------------ R6 kit

// The R6 version of a kit pose: the R15 pose collapsed onto the six R6 joints, as neutral Euler
// degrees (the same conventions as the R15 kit: Shoulder / Hip X+ raises the limb forward...) keyed
// by R6 Motor6D name. a:pose on an R6 clip plays exactly this.
export function r6KitPose(pose: KitPose): Partial<Record<R6Joint, V3>> {
  const r = resolveKitPose(pose, { rig: 'R6' })
  const c = collapsePose(r.joints as Pose)
  const out: Partial<Record<R6Joint, V3>> = {}
  for (const d of R6_JOINT_DEFS) {
    const x = c[d.r15]
    if (!x) continue
    const e = eulerDegOf(x.q).map((v) => Math.round(v)) as V3
    if (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) >= 1) out[d.name] = e
  }
  return out
}

export function r6KitReferenceText(): string {
  const fmt = (v: V3) => `(${v.join(', ')})`
  return [
    'R6 versions of the kit poses (what a:pose gives on R6: each limb aimed where the R15 pose puts its hand / foot, the torso following the chest; degrees on the R6 joints):',
    ...KIT_POSES.map((p) => {
      const j = r6KitPose(p)
      const parts = Object.entries(j).map(([k, v]) => `${k} ${fmt(v as V3)}`)
      return `- ${p.name}: ${parts.join(', ') || 'rest'}`
    })
  ].join('\n')
}
