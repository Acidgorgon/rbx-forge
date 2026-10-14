// Plain-data types of the Ability Composer: one game "move" that combines an Animation Lab clip, VFX
// Lab effects and more client-side tracks on a single timeline. The composer only references the
// labs' items by id (a VFX library entry id, an anim clip id); both labs stay separate.
//
// Times are seconds of ability time from the moment the move starts. An event's start is a TimeRef:
// absolute (`{ at: 0.4 }`) or relative to an animation marker (`{ marker: 'release', at: -0.05 }`:
// 0.05 s before the clip's "release" marker, after the animation's start and speed are applied).
// No electron or React imports.

import type { AnimMarker } from '../anim/types.ts'
import type { EasingStyle, Rgb, Vec3 } from '../vfx/types.ts'
import type { PrincipleScore } from '../principles/types.ts'

export type { AnimMarker }

// R15 body parts (Humanoid rig); VFX and sounds attach to these or to an attachment inside them.
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

// R6 body parts. An event may name either rig's parts: when the move's clip is R6 an R15 part plays on
// the R6 part that holds it (RightHand -> "Right Arm", UpperTorso -> Torso...), and the other way round.
export const R6_PARTS = ['HumanoidRootPart', 'Torso', 'Head', 'Right Arm', 'Left Arm', 'Right Leg', 'Left Leg'] as const
export type R6Part = (typeof R6_PARTS)[number]
export type BodyPart = R15Part | R6Part
export type AbilityRig = 'R15' | 'R6'

export interface TimeRef {
  // Seconds: absolute, or an offset from the marker when `marker` is set.
  at: number
  marker?: string
}

// The move's animation (one clip from the Animation Lab, or a built-in placeholder pose track).
// Clip facts are cached here so timing resolves without the anim library (refreshed when it has them).
export interface AbilityAnimation {
  clip: string
  name: string
  duration: number
  looped: boolean
  markers: AnimMarker[]
  // Playback speed (AnimationTrack:Play speed); markers move with it.
  speed: number
  // Absolute start in ability time.
  start: number
  fadeIn: number
  // rbxassetid of the published animation, for the game export (empty until published).
  assetId?: string
  // The clip's rig (AnimClipRef.rig); absent = R15.
  rig?: AbilityRig
}

interface EventBase {
  id: string
  label?: string
  at: TimeRef
  muted?: boolean
}

export interface VfxEvent extends EventBase {
  kind: 'vfx'
  // VFX Lab library entry id, and its effect name (the module the game requires).
  effect: string
  effectName: string
  part: BodyPart
  attachment?: string
  // Studs and degrees relative to the part (or attachment); -Z is the part's forward.
  offset: Vec3
  rotation: Vec3
  // Seconds the effect plays (from the VFX entry; used for the timeline bar).
  duration?: number
}

export type SoundSource = { kind: 'asset'; id: string } | { kind: 'file'; path: string; name: string }

export interface SoundEvent extends EventBase {
  kind: 'sound'
  source: SoundSource
  volume: number
  // Sound.PlaybackSpeed.
  pitch: number
  // 3D sound from this part; absent = 2D (SoundService).
  part?: BodyPart
  duration?: number
}

export type ShakeFalloff = 'none' | 'linear' | 'exponential'

export interface ShakeEvent extends EventBase {
  kind: 'shake'
  duration: number
  // Studs of camera offset at the peak.
  amplitude: number
  // Oscillations per second.
  frequency: number
  // How the amplitude decays over the duration.
  falloff: ShakeFalloff
}

export type ScreenKind = 'flash' | 'colorCorrection' | 'bloom' | 'blur'

// Peak values; the effect tweens from neutral to these over `attack`, holds, then back over `release`.
//   flash            color, opacity (0..1)            a full-screen Frame
//   colorCorrection  brightness, contrast, saturation, tint   ColorCorrectionEffect
//   bloom            intensity, size, threshold       BloomEffect
//   blur             size                             BlurEffect
export interface ScreenValues {
  color?: Rgb
  opacity?: number
  brightness?: number
  contrast?: number
  saturation?: number
  tint?: Rgb
  intensity?: number
  size?: number
  threshold?: number
}

export interface ScreenEvent extends EventBase {
  kind: 'screen'
  effect: ScreenKind
  attack: number
  hold: number
  release: number
  style: EasingStyle
  values: ScreenValues
}

// Client time-scale dip ("hit-stop"): ability time runs at timeScale for `duration` real seconds.
export interface HitStopEvent extends EventBase {
  kind: 'hitstop'
  duration: number
  timeScale: number
}

// Root velocity for the caster: studs/s in the root's space (-Z forward), constant or decaying to 0.
export interface MoveEvent extends EventBase {
  kind: 'move'
  duration: number
  velocity: Vec3
  easing: 'constant' | 'decay'
}

export type AbilityEvent = VfxEvent | SoundEvent | ShakeEvent | ScreenEvent | HitStopEvent | MoveEvent
export type EventKind = AbilityEvent['kind']
export const EVENT_KINDS: EventKind[] = ['vfx', 'sound', 'shake', 'screen', 'hitstop', 'move']

export interface Ability {
  version: 1
  name: string
  description?: string
  tags?: string[]
  // Length of one play (the preview loops this).
  duration: number
  animation: AbilityAnimation | null
  events: AbilityEvent[]
}

export type AbilityScope = 'user' | 'project'

// One timing rule check (critique.ts).
export interface TimingCheck {
  rule: string
  ok: boolean
  level: 'info' | 'warn' | 'error'
  message: string
  // A concrete retime that fixes it (event id + new TimeRef).
  fix?: { event: string; at?: TimeRef; duration?: number }
}

export const ABILITY_RUBRIC = ['anticipation', 'impact', 'sync', 'readability', 'followThrough'] as const
export type AbilityRubricKey = (typeof ABILITY_RUBRIC)[number]

export interface AbilityChange {
  event: string
  field: string
  value: unknown
  why?: string
  // The principle the change raises (shared/principles), when the critic named one.
  principle?: string
}

export interface AbilityCritique {
  at: number
  // 0..10 from the timing rules alone.
  timingScore: number
  checks: TimingCheck[]
  // Vision critic on frames at the key beats (absent without a vision model or renderer).
  vision?: { scores: Record<AbilityRubricKey, number>; overall: number; summary: string; changes: AbilityChange[] }
  // Key beats the frames were taken at.
  beats: { label: string; t: number }[]
  // PNG file names inside the entry folder.
  frames: string[]
  overall: number
  summary: string
  // Per-principle scores (critic + code checks), their weighted mean (blended into overall) and the
  // principles to fix first (shared/principles).
  principles?: PrincipleScore[]
  principleScore?: number
  focus?: string[]
}

export interface AbilityEntry {
  id: string
  scope: AbilityScope
  name: string
  description: string
  tags: string[]
  createdAt: number
  updatedAt: number
  // The request (composed), "example:<key>" or "manual".
  origin: string
  ability: Ability
  rating?: 'up' | 'down'
  quality?: 'good' | 'avoid'
  critique?: AbilityCritique
  // Where the game export wrote it.
  written?: { module: string; runner: string }
  thumbs: string[]
}

export interface AbilityStatus {
  projectRoot: string | null
  vision: boolean
  render: boolean
  lune: boolean
  entries: { user: number; project: number }
  // Where the export writes (src/skills/Client/Abilities in FSF-style projects, else src/shared/Abilities).
  exportDir: string | null
  // Sound generation needs an audio-capable provider; the current setup has none (import only).
  soundGeneration: false
}

export interface AbilityExportResult {
  files: string[]
  // Project-relative paths of the move module and the runner.
  module: string
  runner: string
  // The move module's Luau source (shown in the Export tab).
  source: string
  requirePath: string | null
  command: string | null
  warnings: string[]
}

export interface AbilityComposeResult {
  entry: AbilityEntry
  // Where the pieces came from.
  vfx: { id: string; name: string; source: 'library' | 'vfx_compose' | 'example' } | null
  animation: { id: string; name: string; source: 'library' | 'anim_compose' | 'placeholder' } | null
  timing: 'model' | 'draft'
  notes: string[]
}
