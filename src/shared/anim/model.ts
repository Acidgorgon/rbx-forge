// Plain-data types of the Animation Lab (clips, library entries, style profiles, critique loop).
// Shared by the main process (services/anim), the renderer (pages/anim) and tests. No electron or
// React imports. The cross-feature contract (AnimMarker, AnimClipRef) lives in ./types.ts.

import type { AnimMarker } from './types.ts'
import type { R6Joint } from './r6.ts'
import type { VideoRef } from '../videoref/types.ts'
import type { PrincipleScore } from '../principles/types.ts'
import type { Restatement } from '../restate/types.ts'
import type { PartMotion } from './bodyparts.ts'
import type { RemixOp, RemixOrigin } from './remix.ts'

export type { R6Joint }

export type { AnimMarker, AnimClipRef } from './types.ts'

// R15 Motor6D names (the joints a KeyframeSequence animates; a Pose is named after the joint's Part1).
export const R15_JOINTS = [
  'Root',
  'Waist',
  'Neck',
  'LeftShoulder',
  'LeftElbow',
  'LeftWrist',
  'RightShoulder',
  'RightElbow',
  'RightWrist',
  'LeftHip',
  'LeftKnee',
  'LeftAnkle',
  'RightHip',
  'RightKnee',
  'RightAnkle'
] as const
export type R15Joint = (typeof R15_JOINTS)[number]

// The character rig a clip animates. R15 (15 Motor6Ds) or R6 (6 Motor6Ds: RootJoint, Neck, Left /
// Right Shoulder, Left / Right Hip). Clips without a rig are R15 (everything made before R6 support).
export const RIG_TYPES = ['R15', 'R6'] as const
export type RigType = (typeof RIG_TYPES)[number]
// A track key: an R15 joint on R15 clips, an R6 Motor6D name on R6 clips.
export type AnimJoint = R15Joint | R6Joint

// Enum.PoseEasingStyle / Enum.PoseEasingDirection item names. A Pose's easing shapes the move from
// that keyframe to the next one (PoseBase.EasingStyle: "the easing style to use to reach the next
// Pose's value"). Cubic is the legacy style with reversed directions; CubicV2 is the fixed one.
export const POSE_EASING_STYLES = ['Linear', 'Constant', 'Elastic', 'Cubic', 'Bounce', 'CubicV2'] as const
export type PoseEasingStyle = (typeof POSE_EASING_STYLES)[number]
export const POSE_EASING_DIRECTIONS = ['In', 'Out', 'InOut'] as const
export type PoseEasingDirection = (typeof POSE_EASING_DIRECTIONS)[number]

export const ANIM_PRIORITIES = ['Idle', 'Movement', 'Action', 'Action2', 'Action3', 'Action4', 'Core'] as const
export type AnimPriority = (typeof ANIM_PRIORITIES)[number]

// One key of a joint track: the Motor6D.Transform (Pose.CFrame) at time t, and how it eases to the
// next key.
export interface AnimKey {
  t: number
  cf: number[]
  ease?: PoseEasingStyle
  dir?: PoseEasingDirection
}

// A labelled phase for the timeline and the critic (anticipation, action, recovery...). Not exported
// to Roblox (markers are).
export interface AnimBeat {
  at: number
  label: string
}

export interface AnimClip {
  name: string
  duration: number
  looped: boolean
  priority: AnimPriority
  // R15 when absent. R6 clips key their tracks by R6 Motor6D name with the native R6 Transforms.
  rig?: RigType
  tracks: Partial<Record<AnimJoint, AnimKey[]>>
  markers: AnimMarker[]
  beats?: AnimBeat[]
  // Timeline script (Luau, the anim API) that produced the clip.
  script?: string
  // Edits applied on top of the script's result (the critic's offsets, fixes, retimes).
  patches?: AnimChange[]
  // Where the keys came from.
  source?: 'rbxmx' | 'rbxm' | 'bvh' | 'script'
  // Source frame rate of dense (motion capture) clips.
  fps?: number
}

export type AnimScope = 'user' | 'project'
// media: a video reference (no keys; its clip is an empty placeholder with the measured beats).
export type AnimEntryKind = 'imported' | 'generated' | 'media'

export interface AnimEntry {
  id: string
  scope: AnimScope
  kind: AnimEntryKind
  name: string
  description: string
  tags: string[]
  notes: string
  createdAt: number
  updatedAt: number
  // Original file name (import) or the request (generated).
  origin: string
  clip: AnimClip
  thumbs: string[]
  rating?: 'up' | 'down'
  quality?: 'reference' | 'good' | 'avoid'
  // Measured timing / spread numbers (style.ts).
  stats?: AnimClipStats
  // Generated clips: where they were written in the project.
  written?: { module: string; model: string }
  // Open Cloud upload (Animation asset).
  roblox?: { assetId: string; uploadedAt: number }
  iterations?: AnimIteration[]
  // Reference clip the preview ghosts against.
  reference?: string
  // Video references (kind 'media'): the analysed clip (shared/videoref).
  video?: VideoRef
  // Generated clips: the video reference pinned with "make it like this" (critic compares to it).
  refId?: string
  // "Restate first": the reading of the brief the user confirmed (compose prompt + critic judge against it).
  restatement?: Restatement
  // Remixed clips ("Remix closest"): the library clip it started from and the edit ops (remix.ts),
  // so the clip is reproducible and its ops editable.
  remix?: RemixOrigin
}

// Timing and shape numbers of one clip (style.ts measureClip).
export interface AnimClipStats {
  duration: number
  keys: number
  keyRate: number
  anticipation: number
  action: number
  recovery: number
  holds: number
  overshoot: number
  peakTime: number
  spread: number
  easing: Record<string, number>
}

export interface Pct {
  p10: number
  median: number
  p90: number
}

// A learned pose (k-means centroid of key poses for one tag): joint -> Euler degrees (CFrame.Angles).
export interface LearnedPose {
  id: string
  tag: string
  count: number
  // Where the pose tends to sit in a move (0 = start, 1 = end).
  phase: number
  joints: Partial<Record<R15Joint, [number, number, number]>>
  root?: [number, number, number]
}

// Style profile for one move type (attack, cast, dash, idle, hit, sign...), learned from the library.
export interface AnimStyleProfile {
  tag: string
  // Which rig's clips it was learned from (R15 when absent).
  rig?: RigType
  samples: number
  liked: number
  timing: { duration: Pct; anticipation: Pct; action: Pct; recovery: Pct; holds: Pct }
  overshoot: Pct
  keyRate: Pct
  spread: Pct
  easing: { style: string; share: number }[]
  poses: LearnedPose[]
  notes: string[]
  avoid: string[]
  // Timing (median seconds per beat) from video references with this tag; never poses.
  video?: { samples: number; beats: Record<string, number> }
}

export interface AnimStyle {
  updatedAt: number
  profiles: AnimStyleProfile[]
  // Profile over every clip (fallback when a tag has no examples).
  overall: AnimStyleProfile | null
  // Profiles learned from the R6 clips (profiles / overall above are the R15 ones).
  r6?: { profiles: AnimStyleProfile[]; overall: AnimStyleProfile | null }
}

// ------------------------------------------------------------------ automatic checks

export interface AnimCheckIssue {
  // motion: a body part the request names barely moves (anim/bodyparts.ts).
  check: 'sliding' | 'limits' | 'penetration' | 'readability' | 'timing' | 'motion'
  severity: 'info' | 'warn' | 'error'
  message: string
  joint?: string
  at?: number
}

export interface AnimCheckReport {
  // 0..10 each.
  scores: { sliding: number; limits: number; penetration: number; readability: number; timing: number }
  overall: number
  issues: AnimCheckIssue[]
  // Raw measures.
  slideStuds: number
  worstLimitDeg: number
  penetrationStuds: number
  spread: number
  // The body parts the request (and its move-type tags) name, and how far each moves.
  motion?: PartMotion[]
}

// ------------------------------------------------------------------ critique and refine

export const ANIM_RUBRIC_KEYS = ['silhouette', 'timing', 'weight', 'arcs', 'appeal', 'cleanliness'] as const
export type AnimRubricKey = (typeof ANIM_RUBRIC_KEYS)[number]

// A change the critic (or an automatic check) proposes, applied on top of the script's clip.
// principle: the principle the change raises (shared/principles), when the critic named one.
export type AnimChange =
  | { kind: 'offset'; joint: R15Joint; at: number; rot: [number, number, number]; why?: string; principle?: string }
  | { kind: 'retime'; from: number; to: number; scale: number; why?: string; principle?: string }
  | { kind: 'ease'; at: number; joint?: R15Joint; style: PoseEasingStyle; dir?: PoseEasingDirection; why?: string; principle?: string }
  | { kind: 'fix'; check: 'limits' | 'sliding' | 'penetration'; why?: string; principle?: string }

export interface AnimCritique {
  scores: Record<AnimRubricKey, number>
  overall: number
  summary: string
  changes: AnimChange[]
  checks?: AnimCheckReport
  references: string[]
  // With a pinned video reference: 0..10 match (blended into overall) and the biggest difference.
  match?: number
  matchNotes?: string
  // Per-principle scores (critic + code checks), their weighted mean (blended into overall) and the
  // principles the next round targets first (shared/principles).
  principles?: PrincipleScore[]
  principleScore?: number
  focus?: string[]
  // Requirements the clip fails outright (a named body part that barely moves); the score is capped
  // while any is open.
  mustFix?: string[]
}

export interface AnimIteration {
  n: number
  at: number
  clip: AnimClip
  frames: string[]
  times: number[]
  critique?: AnimCritique
  // Remixed clips: the ops that produced this iteration's clip.
  ops?: RemixOp[]
}

export interface AnimRefineOptions {
  maxIterations?: number
  threshold?: number
  frames?: number
}

export interface AnimRefineProgress {
  entryId: string
  iteration: number
  phase: 'render' | 'critique' | 'adjust' | 'done' | 'error'
  score?: number
  message?: string
}

export interface AnimScriptResult {
  ok: boolean
  error?: { message: string; line?: number }
  prints: string[]
  warnings: string[]
  summary: string
  clip?: AnimClip
  checks?: AnimCheckReport
  entry?: AnimEntry
  source?: 'model' | 'draft' | 'example' | 'remix'
  // compose with source 'draft': "Drafted without a model because: <error>".
  modelError?: string
}

export interface AnimImportResult {
  added: AnimEntry[]
  skipped: { file: string; reason: string }[]
}

export interface AnimLabStatus {
  projectRoot: string | null
  lune: { available: boolean; version?: string; hint?: string }
  vision: boolean
  upload: boolean
  entries: { user: number; project: number }
  profiles: number
  // The rig new clips use (project setting, or the app default without a project).
  rig: RigType
}

export interface AnimExportResult {
  module: string
  model: string
  instancePath: string
  command: string
}

export interface AnimUploadResult {
  assetId: string
  uri: string
  module?: string
}
