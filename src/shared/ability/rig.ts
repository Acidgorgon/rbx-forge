// A minimal blocky R15 rig for the Ability Composer preview and for placing attachments: part sizes,
// the 15 Motor6Ds (Root, Waist, Neck, shoulders, elbows, wrists, hips, knees, ankles) with C0 / C1,
// and the standard R15 attachment names. Proportions follow the default block R15 (HipHeight 2, root
// 2x2x1 centred 3 studs above the floor, about 5.2 studs tall, facing -Z); the exact Roblox C0 / C1
// values differ slightly, which is fine for a preview.
//
// Posing matches Motor6D: Part1.CFrame = Part0.CFrame * C0 * Transform * C1:Inverse(), where the
// Transform per joint comes from getAnimPose (Animation Lab) or a placeholder pose track.

import { mul } from '../vfx/cframe.ts'
import type { CFrameArr, Vec3 } from '../vfx/types.ts'
import type { R15Part } from './types.ts'

export const JOINT_NAMES = ['Root', 'Waist', 'Neck', 'LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightShoulder', 'RightElbow', 'RightWrist', 'LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle'] as const
export type JointName = (typeof JOINT_NAMES)[number]

// Joint name -> Motor6D.Transform (12 numbers, Roblox CFrame component order). Missing = identity.
export type Pose = Partial<Record<string, number[]>>

export interface RigJoint {
  name: JointName
  part0: R15Part
  part1: R15Part
  c0: Vec3
  c1: Vec3
}

export const PART_SIZE: Record<R15Part, Vec3> = {
  HumanoidRootPart: [2, 2, 1],
  LowerTorso: [2, 0.4, 1],
  UpperTorso: [2, 1.6, 1],
  Head: [1.2, 1.2, 1.2],
  LeftUpperArm: [1, 1, 1],
  LeftLowerArm: [1, 1, 1],
  LeftHand: [1, 0.4, 1],
  RightUpperArm: [1, 1, 1],
  RightLowerArm: [1, 1, 1],
  RightHand: [1, 0.4, 1],
  LeftUpperLeg: [1, 0.85, 1],
  LeftLowerLeg: [1, 0.85, 1],
  LeftFoot: [1, 0.3, 1],
  RightUpperLeg: [1, 0.85, 1],
  RightLowerLeg: [1, 0.85, 1],
  RightFoot: [1, 0.3, 1]
}

// Parents before children (FK order).
export const RIG_JOINTS: RigJoint[] = [
  { name: 'Root', part0: 'HumanoidRootPart', part1: 'LowerTorso', c0: [0, -0.8, 0], c1: [0, 0, 0] },
  { name: 'Waist', part0: 'LowerTorso', part1: 'UpperTorso', c0: [0, 0.2, 0], c1: [0, -0.8, 0] },
  { name: 'Neck', part0: 'UpperTorso', part1: 'Head', c0: [0, 0.8, 0], c1: [0, -0.6, 0] },
  { name: 'LeftShoulder', part0: 'UpperTorso', part1: 'LeftUpperArm', c0: [-1.5, 0.6, 0], c1: [0, 0.5, 0] },
  { name: 'LeftElbow', part0: 'LeftUpperArm', part1: 'LeftLowerArm', c0: [0, -0.5, 0], c1: [0, 0.5, 0] },
  { name: 'LeftWrist', part0: 'LeftLowerArm', part1: 'LeftHand', c0: [0, -0.5, 0], c1: [0, 0.2, 0] },
  { name: 'RightShoulder', part0: 'UpperTorso', part1: 'RightUpperArm', c0: [1.5, 0.6, 0], c1: [0, 0.5, 0] },
  { name: 'RightElbow', part0: 'RightUpperArm', part1: 'RightLowerArm', c0: [0, -0.5, 0], c1: [0, 0.5, 0] },
  { name: 'RightWrist', part0: 'RightLowerArm', part1: 'RightHand', c0: [0, -0.5, 0], c1: [0, 0.2, 0] },
  { name: 'LeftHip', part0: 'LowerTorso', part1: 'LeftUpperLeg', c0: [-0.5, -0.2, 0], c1: [0, 0.425, 0] },
  { name: 'LeftKnee', part0: 'LeftUpperLeg', part1: 'LeftLowerLeg', c0: [0, -0.425, 0], c1: [0, 0.425, 0] },
  { name: 'LeftAnkle', part0: 'LeftLowerLeg', part1: 'LeftFoot', c0: [0, -0.425, 0], c1: [0, 0.15, 0] },
  { name: 'RightHip', part0: 'LowerTorso', part1: 'RightUpperLeg', c0: [0.5, -0.2, 0], c1: [0, 0.425, 0] },
  { name: 'RightKnee', part0: 'RightUpperLeg', part1: 'RightLowerLeg', c0: [0, -0.425, 0], c1: [0, 0.425, 0] },
  { name: 'RightAnkle', part0: 'RightLowerLeg', part1: 'RightFoot', c0: [0, -0.425, 0], c1: [0, 0.15, 0] }
]

// Standard R15 attachments (names as in a Roblox R15 character) and where they sit in their part.
export const RIG_ATTACHMENTS: Record<string, { part: R15Part; at: Vec3 }> = {
  RootAttachment: { part: 'HumanoidRootPart', at: [0, 0, 0] },
  WaistCenterAttachment: { part: 'LowerTorso', at: [0, 0, 0] },
  BodyFrontAttachment: { part: 'UpperTorso', at: [0, 0, -0.5] },
  BodyBackAttachment: { part: 'UpperTorso', at: [0, 0, 0.5] },
  NeckAttachment: { part: 'UpperTorso', at: [0, 0.8, 0] },
  HatAttachment: { part: 'Head', at: [0, 0.6, 0] },
  FaceFrontAttachment: { part: 'Head', at: [0, 0, -0.6] },
  RightGripAttachment: { part: 'RightHand', at: [0, -0.2, 0] },
  LeftGripAttachment: { part: 'LeftHand', at: [0, -0.2, 0] },
  RightFootAttachment: { part: 'RightFoot', at: [0, -0.15, 0] },
  LeftFootAttachment: { part: 'LeftFoot', at: [0, -0.15, 0] }
}

export const ROOT_HEIGHT = 3

const T = (v: Vec3): CFrameArr => [v[0], v[1], v[2], 1, 0, 0, 0, 1, 0, 0, 0, 1]

// Inverse of a rigid CFrame.
export function inverse(c: CFrameArr): CFrameArr {
  const r = [c[3], c[6], c[9], c[4], c[7], c[10], c[5], c[8], c[11]]
  const p = [-(r[0] * c[0] + r[1] * c[1] + r[2] * c[2]), -(r[3] * c[0] + r[4] * c[1] + r[5] * c[2]), -(r[6] * c[0] + r[7] * c[1] + r[8] * c[2])]
  return [...p, ...r]
}

// CFrame.Angles(rx, ry, rz) (radians): Rx * Ry * Rz, like CFrame.fromEulerAnglesXYZ.
export function anglesXYZ(rx: number, ry: number, rz: number, at: Vec3 = [0, 0, 0]): CFrameArr {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
  const X: CFrameArr = [0, 0, 0, 1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const Y: CFrameArr = [0, 0, 0, cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const Z: CFrameArr = [0, 0, 0, cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  const m = mul(mul(X, Y), Z)
  m[0] = at[0]
  m[1] = at[1]
  m[2] = at[2]
  return m
}

function valid(v: unknown): v is number[] {
  return Array.isArray(v) && v.length === 12 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

// World CFrame of every part for a root CFrame and a pose.
export function solveRig(root: CFrameArr, pose: Pose = {}): Record<R15Part, CFrameArr> {
  const out = { HumanoidRootPart: root } as Record<R15Part, CFrameArr>
  for (const j of RIG_JOINTS) {
    const tr = pose[j.name]
    const transform = valid(tr) ? (tr as CFrameArr) : null
    let m = mul(out[j.part0], T(j.c0))
    if (transform) m = mul(m, transform)
    out[j.part1] = mul(m, inverse(T(j.c1)))
  }
  return out
}

// World CFrame of a part or one of its attachments, then a local offset (studs) and rotation (degrees).
export function attachWorld(parts: Record<R15Part, CFrameArr>, part: R15Part, attachment: string | undefined, offset: Vec3, rotationDeg: Vec3): CFrameArr {
  const a = attachment ? RIG_ATTACHMENTS[attachment] : undefined
  const base = a ? mul(parts[a.part], T(a.at)) : parts[part]
  const d = Math.PI / 180
  return mul(base, anglesXYZ(rotationDeg[0] * d, rotationDeg[1] * d, rotationDeg[2] * d, offset))
}
