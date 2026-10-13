// The R15 rig the Animation Lab poses: a blocky R15 (about 5.2 studs tall, feet on y = 0, facing -Z,
// the character's right is +X). Each Motor6D has Part0, Part1 and its joint position; C0 / C1 are
// pure offsets from each part's centre to the joint, so Part1 = Part0 * C0 * Transform * C1:Inverse()
// with Transform = Pose.CFrame (what a KeyframeSequence stores). Proportions follow Roblox's default
// blocky R15 closely enough for previews, IK and checks; the exported transforms are joint-relative
// and play on any R15 character.

import type { R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { qconj, qmul, qrot, vadd, vsub, xmul, xpoint, type Quat, type V3, type Xf } from './math.ts'

export const R15_PARTS = [
  'HumanoidRootPart',
  'LowerTorso',
  'UpperTorso',
  'Head',
  'LeftUpperArm',
  'LeftLowerArm',
  'LeftHand',
  'RightUpperArm',
  'RightLowerArm',
  'RightHand',
  'LeftUpperLeg',
  'LeftLowerLeg',
  'LeftFoot',
  'RightUpperLeg',
  'RightLowerLeg',
  'RightFoot'
] as const
export type R15Part = (typeof R15_PARTS)[number]

export interface PartDef {
  name: R15Part
  size: V3
  // Centre in the rest pose (world, character space).
  center: V3
}

export interface JointDef {
  name: R15Joint
  part0: R15Part
  part1: R15Part
  // Joint position in the rest pose (world).
  at: V3
}

const PART_LIST: PartDef[] = [
  { name: 'HumanoidRootPart', size: [2, 2, 1], center: [0, 3, 0] },
  { name: 'LowerTorso', size: [2, 0.4, 1], center: [0, 2.2, 0] },
  { name: 'UpperTorso', size: [2, 1.6, 1], center: [0, 3.2, 0] },
  { name: 'Head', size: [1.25, 1.25, 1.25], center: [0, 4.62, 0] },
  { name: 'LeftUpperArm', size: [1, 1.25, 1], center: [-1.5, 3.37, 0] },
  { name: 'LeftLowerArm', size: [1, 0.9, 1], center: [-1.5, 2.45, 0] },
  { name: 'LeftHand', size: [1, 0.4, 1], center: [-1.5, 1.85, 0] },
  { name: 'RightUpperArm', size: [1, 1.25, 1], center: [1.5, 3.37, 0] },
  { name: 'RightLowerArm', size: [1, 0.9, 1], center: [1.5, 2.45, 0] },
  { name: 'RightHand', size: [1, 0.4, 1], center: [1.5, 1.85, 0] },
  { name: 'LeftUpperLeg', size: [1, 1, 1], center: [-0.5, 1.55, 0] },
  { name: 'LeftLowerLeg', size: [1, 0.8, 1], center: [-0.5, 0.7, 0] },
  { name: 'LeftFoot', size: [1, 0.3, 1.2], center: [-0.5, 0.15, -0.1] },
  { name: 'RightUpperLeg', size: [1, 1, 1], center: [0.5, 1.55, 0] },
  { name: 'RightLowerLeg', size: [1, 0.8, 1], center: [0.5, 0.7, 0] },
  { name: 'RightFoot', size: [1, 0.3, 1.2], center: [0.5, 0.15, -0.1] }
]

export const PARTS: Record<R15Part, PartDef> = Object.fromEntries(PART_LIST.map((p) => [p.name, p])) as Record<R15Part, PartDef>

const JOINT_LIST: JointDef[] = [
  { name: 'Root', part0: 'HumanoidRootPart', part1: 'LowerTorso', at: [0, 2.2, 0] },
  { name: 'Waist', part0: 'LowerTorso', part1: 'UpperTorso', at: [0, 2.4, 0] },
  { name: 'Neck', part0: 'UpperTorso', part1: 'Head', at: [0, 4.0, 0] },
  { name: 'LeftShoulder', part0: 'UpperTorso', part1: 'LeftUpperArm', at: [-1.5, 3.75, 0] },
  { name: 'LeftElbow', part0: 'LeftUpperArm', part1: 'LeftLowerArm', at: [-1.5, 2.85, 0] },
  { name: 'LeftWrist', part0: 'LeftLowerArm', part1: 'LeftHand', at: [-1.5, 2.05, 0] },
  { name: 'RightShoulder', part0: 'UpperTorso', part1: 'RightUpperArm', at: [1.5, 3.75, 0] },
  { name: 'RightElbow', part0: 'RightUpperArm', part1: 'RightLowerArm', at: [1.5, 2.85, 0] },
  { name: 'RightWrist', part0: 'RightLowerArm', part1: 'RightHand', at: [1.5, 2.05, 0] },
  { name: 'LeftHip', part0: 'LowerTorso', part1: 'LeftUpperLeg', at: [-0.5, 2.0, 0] },
  { name: 'LeftKnee', part0: 'LeftUpperLeg', part1: 'LeftLowerLeg', at: [-0.5, 1.1, 0] },
  { name: 'LeftAnkle', part0: 'LeftLowerLeg', part1: 'LeftFoot', at: [-0.5, 0.3, 0] },
  { name: 'RightHip', part0: 'LowerTorso', part1: 'RightUpperLeg', at: [0.5, 2.0, 0] },
  { name: 'RightKnee', part0: 'RightUpperLeg', part1: 'RightLowerLeg', at: [0.5, 1.1, 0] },
  { name: 'RightAnkle', part0: 'RightLowerLeg', part1: 'RightFoot', at: [0.5, 0.3, 0] }
]

export const JOINTS: Record<R15Joint, JointDef> = Object.fromEntries(JOINT_LIST.map((j) => [j.name, j])) as Record<R15Joint, JointDef>

// Joints in parent-first order (FK order).
export const JOINT_ORDER: R15Joint[] = [...R15_JOINTS]

// Pose name (Part1) -> joint, and back.
export const JOINT_OF_PART: Partial<Record<string, R15Joint>> = Object.fromEntries(JOINT_LIST.map((j) => [j.part1, j.name]))
export const PART_OF_JOINT: Record<R15Joint, R15Part> = Object.fromEntries(JOINT_LIST.map((j) => [j.name, j.part1])) as Record<R15Joint, R15Part>
export const PARENT_PART: Partial<Record<R15Part, R15Part>> = Object.fromEntries(JOINT_LIST.map((j) => [j.part1, j.part0]))

export function isJoint(name: string): name is R15Joint {
  return (R15_JOINTS as readonly string[]).includes(name)
}

// C0 / C1 offsets of each joint (no rotation in this rig).
export function c0(j: R15Joint): V3 {
  const d = JOINTS[j]
  return vsub(d.at, PARTS[d.part0].center)
}
export function c1(j: R15Joint): V3 {
  const d = JOINTS[j]
  return vsub(d.at, PARTS[d.part1].center)
}

// Lengths used by IK (studs).
export const LIMB = {
  upperArm: 0.9,
  lowerArm: 0.8,
  upperLeg: 0.9,
  lowerLeg: 0.8,
  ankleHeight: 0.3
}

export const LIMBS = {
  LeftArm: { upper: 'LeftShoulder', lower: 'LeftElbow', end: 'LeftWrist' },
  RightArm: { upper: 'RightShoulder', lower: 'RightElbow', end: 'RightWrist' },
  LeftLeg: { upper: 'LeftHip', lower: 'LeftKnee', end: 'LeftAnkle' },
  RightLeg: { upper: 'RightHip', lower: 'RightKnee', end: 'RightAnkle' }
} as const satisfies Record<string, { upper: R15Joint; lower: R15Joint; end: R15Joint }>
export type LimbName = keyof typeof LIMBS

// Left <-> right joint names.
export function mirrorJoint(j: R15Joint): R15Joint {
  if (j.startsWith('Left')) return ('Right' + j.slice(4)) as R15Joint
  if (j.startsWith('Right')) return ('Left' + j.slice(5)) as R15Joint
  return j
}

// Mirror a joint-local transform across the character's sagittal plane (x -> -x).
export function mirrorXf(a: Xf): Xf {
  return { p: [-a.p[0], a.p[1], a.p[2]], q: [a.q[0], -a.q[1], -a.q[2], a.q[3]] as Quat }
}

export type Pose = Partial<Record<R15Joint, Xf>>

// World (character space) transforms of every part for a pose. HumanoidRootPart sits at its rest
// position (root motion lives in the Root joint's transform, as in Roblox).
export function forwardKinematics(pose: Pose, rootCf?: Xf): Record<R15Part, Xf> {
  const out = {} as Record<R15Part, Xf>
  out.HumanoidRootPart = rootCf ?? { p: [...PARTS.HumanoidRootPart.center] as V3, q: [0, 0, 0, 1] }
  for (const j of JOINT_ORDER) {
    const d = JOINTS[j]
    const parent = out[d.part0]
    const t = pose[j] ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }
    // Part1 = Part0 * C0 * T * C1^-1
    const atJoint = xmul(xmul(parent, { p: c0(j), q: [0, 0, 0, 1] }), t)
    out[d.part1] = xmul(atJoint, { p: vsub([0, 0, 0], c1(j)), q: [0, 0, 0, 1] })
  }
  return out
}

// World position of a joint (where Part1 hinges) for a set of part transforms.
export function jointWorld(parts: Record<R15Part, Xf>, j: R15Joint): V3 {
  const d = JOINTS[j]
  return xpoint(parts[d.part1], c1(j))
}

// A point on a part, given in the part's local space (e.g. the bottom of a foot).
export function partPoint(parts: Record<R15Part, Xf>, part: R15Part, local: V3): V3 {
  return xpoint(parts[part], local)
}

// The rotation of a joint's Part0 in world space (used to turn world rotations into local ones).
export function parentRotation(parts: Record<R15Part, Xf>, j: R15Joint): Quat {
  return parts[JOINTS[j].part0].q
}

// Local Transform rotation that gives Part1 the world rotation `world`.
export function localRotation(parts: Record<R15Part, Xf>, j: R15Joint, world: Quat): Quat {
  return qmul(qconj(parentRotation(parts, j)), world)
}

// Lowest point of both feet (studs above the floor) and the foot sole centres.
export function soles(parts: Record<R15Part, Xf>): { left: V3; right: V3; lowest: number } {
  const corners = (part: R15Part): V3[] => {
    const s = PARTS[part].size
    const out: V3[] = []
    for (const x of [-s[0] / 2, s[0] / 2]) for (const z of [-s[2] / 2, s[2] / 2]) out.push(xpoint(parts[part], [x, -s[1] / 2, z]))
    return out
  }
  const lowest = Math.min(...[...corners('LeftFoot'), ...corners('RightFoot')].map((p) => p[1]))
  return { left: partPoint(parts, 'LeftFoot', [0, -0.15, 0]), right: partPoint(parts, 'RightFoot', [0, -0.15, 0]), lowest }
}

export function partCorners(parts: Record<R15Part, Xf>, part: R15Part): V3[] {
  const s = PARTS[part].size
  const out: V3[] = []
  for (const x of [-s[0] / 2, s[0] / 2]) for (const y of [-s[1] / 2, s[1] / 2]) for (const z of [-s[2] / 2, s[2] / 2]) out.push(xpoint(parts[part], [x, y, z]))
  return out
}

export { qrot, vadd }
