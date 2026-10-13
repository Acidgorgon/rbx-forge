// Plain-data types of the Animation Lab (clips, library entries, style profiles, critique loop).
// Shared by the main process (services/anim), the renderer (pages/anim) and tests. No electron or
// React imports. The cross-feature contract (AnimMarker, AnimClipRef) lives in ./types.ts.

import type { AnimMarker } from './types.ts'

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
  tracks: Partial<Record<R15Joint, AnimKey[]>>
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
export type AnimEntryKind = 'imported' | 'generated'

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
}

export interface AnimStyle {
  updatedAt: number
  profiles: AnimStyleProfile[]
  // Profile over every clip (fallback when a tag has no examples).
  overall: AnimStyleProfile | null
}

// ------------------------------------------------------------------ automatic checks

export interface AnimCheckIssue {
  check: 'sliding' | 'limits' | 'penetration' | 'readability' | 'timing'
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
}

// ------------------------------------------------------------------ critique and refine

export const ANIM_RUBRIC_KEYS = ['silhouette', 'timing', 'weight', 'arcs', 'appeal', 'cleanliness'] as const
export type AnimRubricKey = (typeof ANIM_RUBRIC_KEYS)[number]

// A change the critic (or an automatic check) proposes, applied on top of the script's clip.
export type AnimChange =
  | { kind: 'offset'; joint: R15Joint; at: number; rot: [number, number, number]; why?: string }
  | { kind: 'retime'; from: number; to: number; scale: number; why?: string }
  | { kind: 'ease'; at: number; joint?: R15Joint; style: PoseEasingStyle; dir?: PoseEasingDirection; why?: string }
  | { kind: 'fix'; check: 'limits' | 'sliding' | 'penetration'; why?: string }

export interface AnimCritique {
  scores: Record<AnimRubricKey, number>
  overall: number
  summary: string
  changes: AnimChange[]
  checks?: AnimCheckReport
  references: string[]
}

export interface AnimIteration {
  n: number
  at: number
  clip: AnimClip
  frames: string[]
  times: number[]
  critique?: AnimCritique
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
  source?: 'model' | 'draft' | 'example'
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
