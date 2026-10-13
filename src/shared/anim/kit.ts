// The pose kit: building-block R15 poses the animation script (and anim_compose) starts from.
// Angles are degrees in CFrame.Angles order (X, then Y, then Z, joint-local). Conventions on this rig
// (facing -Z, right = +X):
//   Shoulder / Hip X+  raises the limb forward        Elbow X+  bends the forearm forward
//   Knee X-            bends the shin back            Ankle X+  lifts the toes
//   Right shoulder Z+  raises the right arm sideways  Left shoulder Z-  raises the left arm sideways
//   Waist / Root Y+    turns the body to its left     Waist X-  leans forward, Neck X- looks down
// Poses are written right-handed; side = "left" mirrors them. Grounded poses keep both feet on the
// floor (the compiler lowers the root and solves leg IK), unless `feet` says a foot is in the air.

import type { R15Joint } from './model.ts'
import { qeulerDeg, qslerp, type Quat, type V3 } from './math.ts'
import { mirrorJoint, mirrorXf } from './r15.ts'

export interface KitPose {
  name: string
  description: string
  // Move types it suits (anim profile tags).
  tags: string[]
  joints: Partial<Record<R15Joint, V3>>
  // Root (LowerTorso) offset in studs and rotation in degrees.
  rootPos?: V3
  rootRot?: V3
  // Which feet stay planted on the floor (default both).
  feet?: 'both' | 'left' | 'right' | 'none'
}

const P = (name: string, description: string, tags: string[], joints: KitPose['joints'], extra: Partial<KitPose> = {}): KitPose => ({ name, description, tags, joints, ...extra })

export const KIT_POSES: KitPose[] = [
  P('rest', 'Neutral standing, arms down.', ['idle'], {}),
  P('idle', 'Relaxed idle: arms slightly out, soft knees.', ['idle'], {
    Waist: [-2, 0, 0],
    Neck: [-3, 0, 0],
    RightShoulder: [3, 0, 6],
    LeftShoulder: [3, 0, -6],
    RightElbow: [14, 0, 0],
    LeftElbow: [14, 0, 0],
    RightHip: [4, 0, 2],
    LeftHip: [4, 0, -2],
    RightKnee: [-8, 0, 0],
    LeftKnee: [-8, 0, 0]
  }),
  P('guard', 'Fighting stance: turned right, left foot forward, fists up by the chin.', ['attack', 'idle', 'combat'], {
    Waist: [-6, 10, 0],
    Neck: [-6, 12, 0],
    RightShoulder: [62, 0, -14],
    RightElbow: [118, 0, 0],
    RightWrist: [-10, 0, 0],
    LeftShoulder: [80, 0, 12],
    LeftElbow: [95, 0, 0],
    LeftHip: [28, 0, -6],
    LeftKnee: [-40, 0, 0],
    RightHip: [-10, 0, 8],
    RightKnee: [-32, 0, 0]
  }, { rootRot: [0, -22, 0] }),
  P('windup', 'Right punch cocked: torso coiled back, weight on the back leg, lead arm reaching.', ['attack', 'combat'], {
    Waist: [-10, -16, 0],
    Neck: [-6, 46, 0],
    RightShoulder: [-28, 0, 22],
    RightElbow: [128, 0, 0],
    LeftShoulder: [84, 0, 16],
    LeftElbow: [58, 0, 0],
    LeftHip: [32, 0, -5],
    LeftKnee: [-42, 0, 0],
    RightHip: [-4, 0, 8],
    RightKnee: [-52, 0, 0]
  }, { rootRot: [0, -34, 0] }),
  P('punch_extend', 'Right cross at full extension: hips and shoulders turned through, lunge, rear heel up.', ['attack', 'combat'], {
    Waist: [-14, 30, 0],
    Neck: [-4, -40, 0],
    RightShoulder: [88, 0, 26],
    RightElbow: [4, 0, 0],
    LeftShoulder: [68, 0, 22],
    LeftElbow: [126, 0, 0],
    LeftHip: [46, 0, -5],
    LeftKnee: [-58, 0, 0],
    RightHip: [-22, 0, 5],
    RightKnee: [-22, 0, 0]
  }, { rootRot: [0, 14, 0] }),
  P('palm_push', 'One-handed palm strike: arm straight, hand bent up so the palm faces forward, other hand at the hip.', ['cast', 'attack', 'sign'], {
    Waist: [-10, 20, 0],
    Neck: [-4, -18, 0],
    RightShoulder: [90, 0, 16],
    RightElbow: [6, 0, 0],
    RightWrist: [78, 0, 0],
    LeftShoulder: [-16, 0, -10],
    LeftElbow: [92, 0, 0],
    LeftHip: [36, 0, -5],
    LeftKnee: [-46, 0, 0],
    RightHip: [-16, 0, 6],
    RightKnee: [-26, 0, 0]
  }),
  P('two_finger_sign', 'Hand sign: right hand raised in front of the face (index and middle finger up), head tipped toward it, left arm loose.', ['sign', 'cast'], {
    Waist: [-4, 10, 0],
    Neck: [-10, -6, 0],
    RightShoulder: [58, 0, -38],
    RightElbow: [124, 0, 0],
    RightWrist: [-8, 0, 0],
    LeftShoulder: [6, 0, -8],
    LeftElbow: [24, 0, 0],
    LeftHip: [6, 0, -4],
    LeftKnee: [-10, 0, 0],
    RightHip: [2, 0, 4],
    RightKnee: [-8, 0, 0]
  }),
  P('cast_raise', 'Both arms raised overhead, chest open, chin up.', ['cast'], {
    Waist: [10, 0, 0],
    Neck: [18, 0, 0],
    RightShoulder: [165, 0, 12],
    LeftShoulder: [165, 0, -12],
    RightElbow: [12, 0, 0],
    LeftElbow: [12, 0, 0],
    RightKnee: [-6, 0, 0],
    LeftKnee: [-6, 0, 0]
  }),
  P('crouch', 'Deep crouch, arms forward for balance, eyes forward.', ['dash', 'land', 'cast'], {
    Waist: [-24, 0, 0],
    Neck: [16, 0, 0],
    RightShoulder: [44, 0, 10],
    LeftShoulder: [44, 0, -10],
    RightElbow: [40, 0, 0],
    LeftElbow: [40, 0, 0],
    RightHip: [74, 0, 6],
    LeftHip: [74, 0, -6],
    RightKnee: [-108, 0, 0],
    LeftKnee: [-108, 0, 0]
  }),
  P('land', 'Landing absorb: knees deep, arms flung out to the sides.', ['land', 'dash'], {
    Waist: [-30, 0, 0],
    Neck: [20, 0, 0],
    RightShoulder: [24, 0, 56],
    LeftShoulder: [24, 0, -56],
    RightElbow: [24, 0, 0],
    LeftElbow: [24, 0, 0],
    RightHip: [70, 0, 10],
    LeftHip: [70, 0, -10],
    RightKnee: [-100, 0, 0],
    LeftKnee: [-100, 0, 0]
  }),
  P('recoil', 'Hit reaction peak: chest and head snapped back, arms flung up, weight thrown back.', ['hit'], {
    Waist: [22, -10, 4],
    Neck: [26, 8, 8],
    RightShoulder: [42, 0, 32],
    RightElbow: [36, 0, 0],
    LeftShoulder: [56, 0, -24],
    LeftElbow: [46, 0, 0],
    LeftHip: [18, 0, -4],
    LeftKnee: [-30, 0, 0],
    RightHip: [-14, 0, 6],
    RightKnee: [-26, 0, 0]
  }, { rootRot: [10, 8, 0], rootPos: [0, 0, 0.35] }),
  P('flinch', 'Covering flinch: hunched, arms up to protect the head.', ['hit', 'block'], {
    Waist: [-20, 0, 0],
    Neck: [-18, 0, 0],
    RightShoulder: [74, 0, -30],
    LeftShoulder: [74, 0, 30],
    RightElbow: [122, 0, 0],
    LeftElbow: [122, 0, 0],
    RightHip: [20, 0, 4],
    LeftHip: [20, 0, -4],
    RightKnee: [-34, 0, 0],
    LeftKnee: [-34, 0, 0]
  }),
  P('block_cross', 'Guard block: forearms crossed in front of the face.', ['block', 'combat'], {
    Waist: [-10, 0, 0],
    Neck: [-12, 0, 0],
    RightShoulder: [82, 0, -32],
    LeftShoulder: [82, 0, 32],
    RightElbow: [108, 0, 0],
    LeftElbow: [108, 0, 0],
    RightKnee: [-22, 0, 0],
    LeftKnee: [-22, 0, 0],
    RightHip: [14, 0, 4],
    LeftHip: [14, 0, -4]
  }),
  P('dash_lean', 'Dash: whole body leaning forward, arms swept back, lead knee driving up (left foot in the air).', ['dash'], {
    Waist: [-14, 0, 0],
    Neck: [26, 0, 0],
    RightShoulder: [-56, 0, 12],
    LeftShoulder: [-56, 0, -12],
    RightElbow: [26, 0, 0],
    LeftElbow: [26, 0, 0],
    LeftHip: [62, 0, -4],
    LeftKnee: [-86, 0, 0],
    RightHip: [-24, 0, 4],
    RightKnee: [-34, 0, 0]
  }, { rootRot: [-22, 0, 0], feet: 'right' }),
  P('kick_chamber', 'Right knee chambered high, lean back slightly, arms in guard.', ['attack', 'kick'], {
    Waist: [12, 0, 0],
    Neck: [-12, 0, 0],
    RightShoulder: [62, 0, -10],
    RightElbow: [112, 0, 0],
    LeftShoulder: [70, 0, 12],
    LeftElbow: [100, 0, 0],
    RightHip: [96, 0, 0],
    RightKnee: [-112, 0, 0],
    RightAnkle: [-22, 0, 0],
    LeftKnee: [-16, 0, 0]
  }, { feet: 'left' }),
  P('kick_extend', 'Right front kick at full extension, torso leaning back for balance.', ['attack', 'kick'], {
    Waist: [24, 0, 0],
    Neck: [-22, 0, 0],
    RightShoulder: [40, 0, 26],
    RightElbow: [70, 0, 0],
    LeftShoulder: [56, 0, -20],
    LeftElbow: [80, 0, 0],
    RightHip: [98, 0, 0],
    RightKnee: [-6, 0, 0],
    RightAnkle: [-32, 0, 0],
    LeftKnee: [-14, 0, 0]
  }, { feet: 'left' }),
  P('point', 'Pointing forward with the right arm.', ['emote'], {
    Neck: [-2, -6, 0],
    RightShoulder: [90, 0, 4],
    RightElbow: [2, 0, 0],
    LeftShoulder: [2, 0, -5],
    LeftElbow: [12, 0, 0]
  }),
  P('jump_tuck', 'Airborne tuck: knees up, arms forward (no foot on the floor; lift the root yourself).', ['jump', 'dash'], {
    Waist: [-16, 0, 0],
    Neck: [12, 0, 0],
    RightShoulder: [60, 0, 20],
    LeftShoulder: [60, 0, -20],
    RightElbow: [60, 0, 0],
    LeftElbow: [60, 0, 0],
    RightHip: [84, 0, 4],
    LeftHip: [84, 0, -4],
    RightKnee: [-120, 0, 0],
    LeftKnee: [-120, 0, 0]
  }, { rootPos: [0, 1.4, 0], feet: 'none' })
]

export const KIT_GROUPS: Record<string, R15Joint[]> = {
  all: ['Root', 'Waist', 'Neck', 'LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightShoulder', 'RightElbow', 'RightWrist', 'LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle'],
  upper: ['Waist', 'Neck', 'LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightShoulder', 'RightElbow', 'RightWrist'],
  lower: ['Root', 'LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle'],
  arms: ['LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightShoulder', 'RightElbow', 'RightWrist'],
  legs: ['LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle'],
  leftArm: ['LeftShoulder', 'LeftElbow', 'LeftWrist'],
  rightArm: ['RightShoulder', 'RightElbow', 'RightWrist'],
  leftLeg: ['LeftHip', 'LeftKnee', 'LeftAnkle'],
  rightLeg: ['RightHip', 'RightKnee', 'RightAnkle'],
  spine: ['Root', 'Waist', 'Neck'],
  head: ['Neck']
}

export function findKitPose(name: string, extra: KitPose[] = []): KitPose | null {
  const key = String(name ?? '').toLowerCase().replace(/[\s-]+/g, '_')
  return [...KIT_POSES, ...extra].find((p) => p.name.toLowerCase() === key) ?? null
}

export interface ResolvedPose {
  joints: Partial<Record<R15Joint, { p: V3; q: Quat }>>
  feet: 'both' | 'left' | 'right' | 'none'
}

// A kit pose as joint transforms: mirrored for side = left, blended from rest by amount (0..1.5),
// limited to `only` joints when given.
export function resolveKitPose(pose: KitPose, opts: { side?: 'left' | 'right'; amount?: number; only?: R15Joint[] } = {}): ResolvedPose {
  const amount = Math.max(0, Math.min(1.5, opts.amount ?? 1))
  const out: ResolvedPose['joints'] = {}
  const all = KIT_GROUPS.all
  for (const j of all) {
    let q: Quat
    let p: V3 = [0, 0, 0]
    if (j === 'Root') {
      q = qeulerDeg(pose.rootRot ?? [0, 0, 0])
      p = [...(pose.rootPos ?? [0, 0, 0])] as V3
    } else q = qeulerDeg(pose.joints[j] ?? [0, 0, 0])
    if (amount !== 1) {
      q = qslerp([0, 0, 0, 1], q, amount)
      p = [p[0] * amount, p[1] * amount, p[2] * amount]
    }
    let target = j
    let x = { p, q }
    if (opts.side === 'left') {
      target = mirrorJoint(j)
      x = mirrorXf(x)
    }
    out[target] = x
  }
  if (opts.only?.length) for (const j of Object.keys(out) as R15Joint[]) if (!opts.only.includes(j)) delete out[j]
  let feet = pose.feet ?? 'both'
  if (opts.side === 'left' && (feet === 'left' || feet === 'right')) feet = feet === 'left' ? 'right' : 'left'
  return { joints: out, feet }
}

export function kitPoseNames(extra: KitPose[] = []): string[] {
  return [...KIT_POSES, ...extra].map((p) => p.name)
}
