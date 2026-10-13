// The R6 rig: seven parts (HumanoidRootPart, Torso, Head and one part per arm and leg) joined by six
// Motor6Ds. Part1 = Part0 * C0 * Transform * C1:Inverse(), where Transform is what a KeyframeSequence
// Pose stores (the Pose is named after Part1: Torso, Head, "Right Arm"...).
//
// Default C0 / C1 of Roblox's stock R6 character. Roblox's creator docs do not list these (the
// Motor6D reference, https://create.roblox.com/docs/reference/engine/classes/Motor6D, documents only
// C0 / C1 / Transform), so they come from the default R6 rig as Studio builds it (Avatar > Rig
// Builder > Block Rig, R6), and match what community tools print from that rig, e.g. the Neck
// CFrame.new(0, 1, 0, -1, 0, 0, 0, 0, 1, 0, 1, 0) / CFrame.new(0, -0.5, 0, ...) in
// https://devforum.roblox.com/t/adjusting-a-neck-cframe-to-the-direction-another-part-is-facing/404507
// and the joint offsets in https://devforum.roblox.com/t/active-ragdoll-for-r6-easy-setup/4054228.
// They are also the rotations this Lab's R6 -> R15 import retarget always used (rbxmx.ts):
//   RootJoint       HumanoidRootPart -> Torso       C0 = C1 = CFrame.new(0, 0, 0,   -1,0,0, 0,0,1, 0,1,0)
//   Neck            Torso -> Head                   C0 = (0, 1, 0)    C1 = (0, -0.5, 0)   same rotation
//   Right Shoulder  Torso -> Right Arm              C0 = (1, 0.5, 0)  C1 = (-0.5, 0.5, 0) rotation 0,0,1, 0,1,0, -1,0,0
//   Left Shoulder   Torso -> Left Arm               C0 = (-1, 0.5, 0) C1 = (0.5, 0.5, 0)  rotation 0,0,-1, 0,1,0, 1,0,0
//   Right Hip       Torso -> Right Leg              C0 = (1, -1, 0)   C1 = (0.5, 1, 0)    rotation 0,0,1, 0,1,0, -1,0,0
//   Left Hip        Torso -> Left Leg               C0 = (-1, -1, 0)  C1 = (-0.5, 1, 0)   rotation 0,0,-1, 0,1,0, 1,0,0
// The rotations are CFrame.Angles(-pi/2, 0, pi) for RootJoint / Neck and CFrame.Angles(0, +-pi/2, 0)
// for the limbs, and each joint's C0 and C1 share the rotation R. So a Transform T in that rotated
// joint frame equals R * T * R^-1 in the plain (unrotated) frame the R15 rig uses: the Lab's kit,
// IK, checks and the critic work in that plain "neutral" frame, and the clip stores the native T.
//
// Part sizes: Head 2x1x1, Torso 2x2x1, arms and legs 1x2x1, HumanoidRootPart 2x2x1 (HipHeight 0,
// so the Torso centre is 3 studs above the floor and the character is 5 studs tall).

import type { R15Joint } from './model.ts'
import { cfToXf, qconj, qeuler, qmul, qrot, xmul, xpoint, type Quat, type V3, type Xf } from './math.ts'

export const R6_JOINTS = ['RootJoint', 'Neck', 'Right Shoulder', 'Left Shoulder', 'Right Hip', 'Left Hip'] as const
export type R6Joint = (typeof R6_JOINTS)[number]

export const R6_PARTS = ['HumanoidRootPart', 'Torso', 'Head', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg'] as const
export type R6Part = (typeof R6_PARTS)[number]

export interface R6JointDef {
  name: R6Joint
  part0: R6Part
  part1: R6Part
  // Default C0 / C1 (Roblox component order).
  c0: number[]
  c1: number[]
  // The R15 joint with the same job (the neutral-frame name used by the kit, IK and checks).
  r15: R15Joint
}

const ROT_SPINE = [-1, 0, 0, 0, 0, 1, 0, 1, 0]
const ROT_RIGHT = [0, 0, 1, 0, 1, 0, -1, 0, 0]
const ROT_LEFT = [0, 0, -1, 0, 1, 0, 1, 0, 0]

// Parent-first order.
export const R6_JOINT_DEFS: R6JointDef[] = [
  { name: 'RootJoint', part0: 'HumanoidRootPart', part1: 'Torso', c0: [0, 0, 0, ...ROT_SPINE], c1: [0, 0, 0, ...ROT_SPINE], r15: 'Root' },
  { name: 'Neck', part0: 'Torso', part1: 'Head', c0: [0, 1, 0, ...ROT_SPINE], c1: [0, -0.5, 0, ...ROT_SPINE], r15: 'Neck' },
  { name: 'Right Shoulder', part0: 'Torso', part1: 'Right Arm', c0: [1, 0.5, 0, ...ROT_RIGHT], c1: [-0.5, 0.5, 0, ...ROT_RIGHT], r15: 'RightShoulder' },
  { name: 'Left Shoulder', part0: 'Torso', part1: 'Left Arm', c0: [-1, 0.5, 0, ...ROT_LEFT], c1: [0.5, 0.5, 0, ...ROT_LEFT], r15: 'LeftShoulder' },
  { name: 'Right Hip', part0: 'Torso', part1: 'Right Leg', c0: [1, -1, 0, ...ROT_RIGHT], c1: [0.5, 1, 0, ...ROT_RIGHT], r15: 'RightHip' },
  { name: 'Left Hip', part0: 'Torso', part1: 'Left Leg', c0: [-1, -1, 0, ...ROT_LEFT], c1: [-0.5, 1, 0, ...ROT_LEFT], r15: 'LeftHip' }
]

export const R6_JOINT: Record<R6Joint, R6JointDef> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.name, j])) as Record<R6Joint, R6JointDef>

export const R6_PART_SIZE: Record<R6Part, V3> = {
  HumanoidRootPart: [2, 2, 1],
  Torso: [2, 2, 1],
  Head: [2, 1, 1],
  'Right Arm': [1, 2, 1],
  'Left Arm': [1, 2, 1],
  'Right Leg': [1, 2, 1],
  'Left Leg': [1, 2, 1]
}

// The rendered head of the stock R6 character is a rounded mesh about 1.2 studs across (the part is
// 2x1x1); previews draw that.
export const R6_HEAD_DRAW: V3 = [1.25, 1.25, 1.25]

export const R6_ROOT_HEIGHT = 3

// R15 joint <-> R6 joint, and the R6 Pose (Part1) name for each joint.
export const R6_OF_R15: Partial<Record<R15Joint, R6Joint>> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.r15, j.name]))
export const R15_OF_R6: Record<R6Joint, R15Joint> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.name, j.r15])) as Record<R6Joint, R15Joint>
export const R6_JOINT_OF_PART: Partial<Record<string, R6Joint>> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.part1, j.name]))
// The R15 joints an R6 rig has an equivalent for (the rest, Waist / elbows / wrists / knees / ankles, do not exist on R6).
export const R6_CAPABLE: R15Joint[] = R6_JOINT_DEFS.map((j) => j.r15)

export function isR6Joint(name: string): name is R6Joint {
  return (R6_JOINTS as readonly string[]).includes(name)
}

// ------------------------------------------------------------------ frames

const rotOf = (c: number[]): Quat => cfToXf(c).q
const ROT: Record<R6Joint, Quat> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.name, rotOf(j.c0)])) as Record<R6Joint, Quat>

// The joint frame rotation R of a Motor6D (C0 and C1 share it).
export function r6JointRotation(j: R6Joint): Quat {
  return ROT[j]
}

// Native R6 Transform (rotated joint frame) -> neutral (plain) transform: R * T * R^-1.
export function r6ToNeutral(j: R6Joint, t: Xf): Xf {
  const r = ROT[j]
  return { p: qrot(r, t.p), q: qmul(qmul(r, t.q), qconj(r)) }
}

// Neutral -> native: R^-1 * N * R.
export function r6FromNeutral(j: R6Joint, n: Xf): Xf {
  const r = ROT[j]
  const ri = qconj(r)
  return { p: qrot(ri, n.p), q: qmul(qmul(ri, n.q), r) }
}

// Same as the old retarget table (CFrame.Angles of each joint's rotation), kept for callers that want
// Euler angles.
export const R6_JOINT_EULER: Record<R6Joint, [number, number, number]> = {
  RootJoint: [-Math.PI / 2, 0, Math.PI],
  Neck: [-Math.PI / 2, 0, Math.PI],
  'Right Shoulder': [0, Math.PI / 2, 0],
  'Left Shoulder': [0, -Math.PI / 2, 0],
  'Right Hip': [0, Math.PI / 2, 0],
  'Left Hip': [0, -Math.PI / 2, 0]
}
// Sanity: the Euler table and the C0 matrices describe the same rotations.
for (const j of R6_JOINTS) {
  const e = R6_JOINT_EULER[j]
  const a = qeuler(e[0], e[1], e[2])
  const b = ROT[j]
  if (Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]) < 0.9999) throw new Error(`R6 rotation table mismatch for ${j}`)
}

// ------------------------------------------------------------------ forward kinematics

const xfOf = (c: number[]): Xf => cfToXf(c)
const C0: Record<R6Joint, Xf> = Object.fromEntries(R6_JOINT_DEFS.map((j) => [j.name, xfOf(j.c0)])) as Record<R6Joint, Xf>
const C1INV: Record<R6Joint, Xf> = Object.fromEntries(
  R6_JOINT_DEFS.map((j) => {
    const x = xfOf(j.c1)
    const qi = qconj(x.q)
    return [j.name, { p: qrot(qi, [-x.p[0], -x.p[1], -x.p[2]]), q: qi }]
  })
) as Record<R6Joint, Xf>

export type R6Pose = Partial<Record<R6Joint, Xf>>

// World transforms of every R6 part for native Transforms (what the KeyframeSequence stores).
export function r6ForwardKinematics(pose: R6Pose, rootCf?: Xf): Record<R6Part, Xf> {
  const out = {} as Record<R6Part, Xf>
  out.HumanoidRootPart = rootCf ?? { p: [0, R6_ROOT_HEIGHT, 0], q: [0, 0, 0, 1] }
  for (const d of R6_JOINT_DEFS) {
    const t = pose[d.name] ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }
    out[d.part1] = xmul(xmul(xmul(out[d.part0], C0[d.name]), t), C1INV[d.name])
  }
  return out
}

// Same, from neutral transforms keyed by R15 joint names (Root, Neck, RightShoulder...).
export function r6ForwardKinematicsNeutral(pose: Partial<Record<R15Joint, Xf>>, rootCf?: Xf): Record<R6Part, Xf> {
  const native: R6Pose = {}
  for (const d of R6_JOINT_DEFS) {
    const n = pose[d.r15]
    if (n) native[d.name] = r6FromNeutral(d.name, n)
  }
  return r6ForwardKinematics(native, rootCf)
}

// World position of a joint (its pivot) for posed parts.
export function r6JointWorld(parts: Record<R6Part, Xf>, j: R6Joint): V3 {
  const d = R6_JOINT[j]
  return xpoint(parts[d.part1], cfToXf(d.c1).p)
}

// The grip point of an arm / the sole centre of a leg (part-local (0, -1, 0)).
export function r6LimbEnd(parts: Record<R6Part, Xf>, part: 'Right Arm' | 'Left Arm' | 'Right Leg' | 'Left Leg'): V3 {
  return xpoint(parts[part], [0, -1, 0])
}

export const R6_LIMB_PART = { RightArm: 'Right Arm', LeftArm: 'Left Arm', RightLeg: 'Right Leg', LeftLeg: 'Left Leg' } as const
export const R6_LIMB_JOINT = { RightArm: 'Right Shoulder', LeftArm: 'Left Shoulder', RightLeg: 'Right Hip', LeftLeg: 'Left Hip' } as const

export function r6PartCorners(parts: Record<R6Part, Xf>, part: R6Part): V3[] {
  const s = R6_PART_SIZE[part]
  const out: V3[] = []
  for (const x of [-s[0] / 2, s[0] / 2]) for (const y of [-s[1] / 2, s[1] / 2]) for (const z of [-s[2] / 2, s[2] / 2]) out.push(xpoint(parts[part], [x, y, z]))
  return out
}

// Lowest point of the given legs (studs above the floor).
export function r6LowestFoot(parts: Record<R6Part, Xf>, legs: ('Right Leg' | 'Left Leg')[] = ['Right Leg', 'Left Leg']): number {
  let y = Infinity
  for (const l of legs) {
    const s = R6_PART_SIZE[l]
    for (const x of [-s[0] / 2, s[0] / 2]) for (const z of [-s[2] / 2, s[2] / 2]) y = Math.min(y, xpoint(parts[l], [x, -s[1] / 2, z])[1])
  }
  return y
}

// ------------------------------------------------------------------ names (R15 -> R6 wording)

// R15 parts / joints -> the R6 part / joint that stands in for them (messages, attachments).
export const R6_PART_FOR_R15_PART: Record<string, R6Part> = {
  HumanoidRootPart: 'HumanoidRootPart',
  LowerTorso: 'Torso',
  UpperTorso: 'Torso',
  Head: 'Head',
  LeftUpperArm: 'Left Arm',
  LeftLowerArm: 'Left Arm',
  LeftHand: 'Left Arm',
  RightUpperArm: 'Right Arm',
  RightLowerArm: 'Right Arm',
  RightHand: 'Right Arm',
  LeftUpperLeg: 'Left Leg',
  LeftLowerLeg: 'Left Leg',
  LeftFoot: 'Left Leg',
  RightUpperLeg: 'Right Leg',
  RightLowerLeg: 'Right Leg',
  RightFoot: 'Right Leg'
}

// The R15 part that best stands in for an R6 part (the end of the limb: hands and feet carry VFX).
export const R15_PART_FOR_R6_PART: Record<R6Part, string> = {
  HumanoidRootPart: 'HumanoidRootPart',
  Torso: 'UpperTorso',
  Head: 'Head',
  'Right Arm': 'RightHand',
  'Left Arm': 'LeftHand',
  'Right Leg': 'RightFoot',
  'Left Leg': 'LeftFoot'
}

// Rewrites R15 joint / part names in a message to the R6 ones (checks and critic text on R6 clips).
export function r6Wording(text: string): string {
  return text
    .replace(/\b(Left|Right)(Shoulder|Hip)\b/g, (_m, s: string, j: string) => `${s} ${j}`)
    .replace(/\b(Left|Right)(UpperArm|LowerArm|Hand)\b/g, (_m, s: string) => `${s} Arm`)
    .replace(/\b(Left|Right)(UpperLeg|LowerLeg|Foot)\b/g, (_m, s: string) => `${s} Leg`)
    .replace(/\b(Upper|Lower)Torso\b/g, 'Torso')
    .replace(/\bRoot\b(?!Joint|Part)/g, 'RootJoint')
}

