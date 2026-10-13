// The posed body of a clip at a time, for drawing: one box per part (HumanoidRootPart left out) with
// its world transform, size and a role for colouring. R15 clips give the 15 R15 parts, R6 clips the
// six R6 parts (Head, Torso, Left / Right Arm, Left / Right Leg) posed by the R6 Motor6Ds.

import type { AnimClip, RigType } from './model.ts'
import type { V3, Xf } from './math.ts'
import { forwardKinematics, PARTS, R15_PARTS } from './r15.ts'
import { R6_HEAD_DRAW, R6_PART_SIZE, r6ForwardKinematics, r6FromNeutral, r6ToNeutral, type R6Part } from './r6.ts'
import { clipRig, samplePose, sampleR6 } from './sample.ts'

export type PartRole = 'head' | 'torso' | 'lowerTorso' | 'upperArm' | 'lowerArm' | 'hand' | 'upperLeg' | 'lowerLeg' | 'foot' | 'arm' | 'leg'

export interface PosedPart {
  name: string
  // Box to draw (the R6 head is drawn as its rounded mesh, about 1.25 studs, not its 2x1x1 part).
  size: V3
  x: Xf
  role: PartRole
  side?: 'Left' | 'Right'
}

const R15_ROLE: Record<string, PartRole> = {
  Head: 'head',
  UpperTorso: 'torso',
  LowerTorso: 'lowerTorso',
  UpperArm: 'upperArm',
  LowerArm: 'lowerArm',
  Hand: 'hand',
  UpperLeg: 'upperLeg',
  LowerLeg: 'lowerLeg',
  Foot: 'foot'
}

export const R6_DRAW_PARTS: R6Part[] = ['Torso', 'Head', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg']

function sideOf(name: string): 'Left' | 'Right' | undefined {
  return name.startsWith('Left') ? 'Left' : name.startsWith('Right') ? 'Right' : undefined
}

// Part names a rig draws (stable order, for building meshes once per rig).
export function drawPartNames(rig: RigType): string[] {
  return rig === 'R6' ? [...R6_DRAW_PARTS] : R15_PARTS.filter((p) => p !== 'HumanoidRootPart')
}

export function drawSize(rig: RigType, name: string): V3 {
  if (rig === 'R6') return name === 'Head' ? R6_HEAD_DRAW : R6_PART_SIZE[name as R6Part]
  return PARTS[name as keyof typeof PARTS].size
}

export function partRole(rig: RigType, name: string): PartRole {
  if (rig === 'R6') return name === 'Head' ? 'head' : name === 'Torso' ? 'torso' : name.endsWith('Arm') ? 'arm' : 'leg'
  return R15_ROLE[name.replace(/^(Left|Right)/, '')] ?? 'torso'
}

// travel = false pins the character to the origin (the root's x / z offset is dropped).
export function posedParts(clip: AnimClip | null, t: number, travel = true, rigIn?: RigType): PosedPart[] {
  const rig = rigIn ?? clipRig(clip)
  if (rig === 'R6') {
    const pose = clip && clipRig(clip) === 'R6' ? sampleR6(clip, t) : {}
    if (!travel && pose.RootJoint) {
      const n = r6ToNeutral('RootJoint', pose.RootJoint)
      pose.RootJoint = r6FromNeutral('RootJoint', { p: [0, n.p[1], 0], q: n.q })
    }
    const parts = r6ForwardKinematics(pose)
    return R6_DRAW_PARTS.map((name) => ({ name, size: drawSize('R6', name), x: parts[name], role: partRole('R6', name), side: sideOf(name) }))
  }
  const pose = clip ? samplePose(clip, t) : {}
  if (!travel && pose.Root) pose.Root = { p: [0, pose.Root.p[1], 0], q: pose.Root.q }
  const parts = forwardKinematics(pose)
  return drawPartNames('R15').map((name) => ({ name, size: drawSize('R15', name), x: parts[name as keyof typeof parts], role: partRole('R15', name), side: sideOf(name) }))
}

