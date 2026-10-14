// Plain-data types of the VFX Lab (library, effects, recipes, critique loop). Shared by the main
// process (services/vfx), the renderer (pages/vfx) and tests. No imports from electron or React.
//
// Values of Roblox properties are normalised to JSON (see schema.ts for which kind each property is):
//   number, boolean, string, content (string), enum (item name, e.g. "Front"),
//   vec2 [x, y], vec3 [x, y, z], color3 [r, g, b] (0..1), range [min, max],
//   nseq NumKey[] (NumberSequence), cseq ColorKey[] (ColorSequence), ref (node id), cframe number[12]

import type { VideoRef } from '../videoref/types.ts'
import type { PrincipleScore } from '../principles/types.ts'
import type { Restatement } from '../restate/types.ts'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Rgb = [number, number, number]
export type NumberRange = [number, number]

// One NumberSequenceKeypoint: time 0..1, value, envelope (random +-e per particle).
export interface NumKey {
  t: number
  v: number
  e?: number
}
export type NumberSequence = NumKey[]

export interface ColorKey {
  t: number
  c: Rgb
}
export type ColorSequence = ColorKey[]

// [px, py, pz, r00, r01, r02, r10, r11, r12, r20, r21, r22] (Roblox CFrame component order).
export type CFrameArr = number[]

export type PropValue = number | boolean | string | number[] | NumKey[] | ColorKey[]

// One instance of an effect (a tree mirroring the Roblox hierarchy).
export interface VfxNode {
  // Stable within the effect (rbxmx referent or a generated id); refs point at it.
  id: string
  className: string
  name: string
  props: Record<string, PropValue>
  children: VfxNode[]
  // Script / LocalScript / ModuleScript source (kept for reference; not executed).
  source?: string
  // Made by a timeline script's fx:spawn (kit preset name); rebuilt each time the script runs.
  kit?: string
  // Instance attributes (numbers, booleans, strings) from the imported model, e.g. the community
  // EmitCount / EmitDelay / EmitDuration convention (analyze.ts cuesFromAttributes).
  attrs?: Record<string, number | boolean | string>
}

// Roblox Enum.EasingStyle / Enum.EasingDirection item names (TweenInfo).
export type EasingStyle = 'Linear' | 'Sine' | 'Back' | 'Quad' | 'Quart' | 'Quint' | 'Bounce' | 'Elastic' | 'Exponential' | 'Circular' | 'Cubic'
export type EasingDirection = 'In' | 'Out' | 'InOut'

// When things happen while an effect plays (from scripts or from a generated spec).
export interface VfxCue {
  // Seconds from the start of the effect.
  at: number
  // Node id of a ParticleEmitter / Beam / Trail / light / Part / Attachment.
  target: string
  // emit: ParticleEmitter:Emit(count); enable / disable: toggles Enabled;
  // tween: TweenService over [at, at + duration] to `props`; set: `props` instantly.
  action: 'emit' | 'enable' | 'disable' | 'tween' | 'set'
  count?: number
  // tween / set: goal values (normalised like node props; see timeline.ts for tweenable props,
  // including the virtual SizeScale and Fade).
  props?: Record<string, PropValue>
  duration?: number
  style?: EasingStyle
  direction?: EasingDirection
  // Made by the timeline script (replaced when it runs again).
  script?: boolean
  // Kit cues: the state before a rig appears (prelude, applied before the model is parented), or
  // what fx:spawn(name) does at spawnAt (the runtime replays these when the script spawns it).
  prelude?: boolean
  spawn?: string
  spawnAt?: number
}

// A labelled moment on the timeline (fx:stage), e.g. charge / merge / release / dissipate.
export interface VfxStage {
  at: number
  label: string
}

// How the preview moves the effect's root (trails need motion to draw anything).
export type VfxMotion = 'static' | 'swing' | 'orbit' | 'dash' | 'rise'

export interface VfxEffect {
  name: string
  roots: VfxNode[]
  cues: VfxCue[]
  // Length of one play in seconds (the preview loops this).
  duration: number
  motion?: VfxMotion
  // Studs: where the root sits relative to the dummy's feet (default: chest height in front).
  anchor?: Vec3
  // Timeline script (Luau, the ForgeFX API): run with Lune to produce kit nodes, cues and stages.
  script?: string
  stages?: VfxStage[]
  // 'local': part CFrames are relative to the root (scripted effects); default re-centres imports.
  space?: 'local'
  // Parameter edits on scripted effects, re-applied after the script rebuilds its nodes.
  patches?: VfxChange[]
}

export type VfxScope = 'user' | 'project'
export type VfxEntryKind = 'model' | 'media' | 'generated'

export interface VfxStats {
  emitters: number
  beams: number
  trails: number
  lights: number
  meshes: number
  scripts: number
  // Steady-state live particles (sum of Rate x mean Lifetime) plus the largest burst.
  particles: number
  // Rough overdraw: sum over emitters of live particles x mean area (studs^2) x opacity.
  overdraw: number
  textures: string[]
  flipbooks: number
}

export interface VfxEntry {
  id: string
  scope: VfxScope
  kind: VfxEntryKind
  name: string
  description: string
  tags: string[]
  createdAt: number
  updatedAt: number
  // Original file name (import) or the prompt (generated).
  origin: string
  effect?: VfxEffect
  stats?: VfxStats
  // Media references (image / gif / video) for visual critique, file names inside the entry folder.
  media?: { file: string; mime: string }[]
  // Preview thumbnails (PNG file names inside the entry folder).
  thumbs: string[]
  rating?: 'up' | 'down'
  // Learned: a liked result (good) or a disliked one kept as an "avoid" example.
  quality?: 'reference' | 'good' | 'avoid'
  // Generated effects: where they were written in the project.
  written?: { module: string; model: string }
  iterations?: VfxIteration[]
  // Video references (kind 'media'): the analysed clip (shared/videoref).
  video?: VideoRef
  notes?: string
  // Generated effects the model did not draft: "Drafted without a model because: <error>".
  modelNote?: string
  // Imported models: what the preview could not reproduce (scripts with logic it could not read,
  // meshes drawn as proxies, ...).
  importNotes?: string[]
  // Imported models: the importer version that built `effect` (IMPORT_VERSION in services/vfx);
  // older entries can be rebuilt from their stored model file (vfxReimport).
  importVersion?: number
  // Generated effects: the video reference pinned with "make it like this" (critic compares to it).
  refId?: string
  // "Restate first": the reading of the brief the user confirmed (compose prompt + critic judge against it).
  restatement?: Restatement
}

// Result of running a timeline script (vfx_run_script, the Script tab, vfx_compose).
export interface VfxScriptResult {
  ok: boolean
  // Luau or timeline error; line is the script line when known.
  error?: { message: string; line?: number }
  prints: string[]
  warnings: string[]
  // Stages and cues, one per line (what the assistant reads back).
  summary: string
  effect?: VfxEffect
  // Saved entry (when the run was saved / composed).
  entry?: VfxEntry
  // vfx_compose: who wrote the script.
  source?: 'model' | 'draft' | 'example'
  // vfx_compose with source 'draft': why the model's script was not used (the actual error).
  modelError?: string
}

// One round of the render, critique and refine loop.
export interface VfxIteration {
  n: number
  at: number
  effect: VfxEffect
  // PNG file names (inside the entry folder) of the rendered frames.
  frames: string[]
  critique?: VfxCritique
}

export const RUBRIC_KEYS = ['readability', 'layering', 'timing', 'color', 'silhouette', 'performance'] as const
export type RubricKey = (typeof RUBRIC_KEYS)[number]

export interface VfxCritique {
  // 0..10 per criterion and overall (weighted mean, see critique.ts).
  scores: Record<RubricKey, number>
  overall: number
  summary: string
  // Concrete parameter changes the critic proposes (applied by the loop).
  changes: VfxChange[]
  references: string[]
  // With a pinned video reference: 0..10 match (blended into overall) and the biggest difference.
  match?: number
  matchNotes?: string
  // Per-principle scores (critic + code checks), their weighted mean (blended into overall) and the
  // principles the next round targets first (shared/principles).
  principles?: PrincipleScore[]
  principleScore?: number
  focus?: string[]
}

// One parameter change: node by name (or id), property, new value.
export interface VfxChange {
  node: string
  prop: string
  // Raw JSON in the spec shorthands (normalised when applied, see spec.ts normalizeValue).
  value: unknown
  why?: string
  // The principle this change raises (shared/principles), when the critic named one.
  principle?: string
}

// Parameter ranges and patterns learned from the library for one effect type (tag).
export interface VfxRecipe {
  tag: string
  samples: number
  // Median emitter count and the layer roles seen (core, glow, sparks, smoke, ring, trail, beam...).
  emitters: number
  layers: { role: string; share: number }[]
  ranges: Record<string, { p10: number; median: number; p90: number }>
  sizeCurves: Record<string, number>
  flipbookShare: number
  burstShare: number
  colors: string[]
  avoid: string[]
  notes: string[]
  // Timing (median seconds per beat) and palette from video references with this tag.
  video?: { samples: number; beats: Record<string, number>; palette: string[] }
}

export interface VfxImportResult {
  added: VfxEntry[]
  skipped: { file: string; reason: string }[]
  // Per imported file: what is not reproduced faithfully.
  notes?: { file: string; notes: string[] }[]
}

export interface VfxLabStatus {
  projectRoot: string | null
  lune: { available: boolean; version?: string; hint?: string }
  vision: boolean
  rojo: boolean
  entries: { user: number; project: number }
  recipes: number
}

export interface VfxRefineOptions {
  maxIterations?: number
  threshold?: number
  frames?: number
}

export interface VfxRefineProgress {
  entryId: string
  iteration: number
  phase: 'create' | 'render' | 'critique' | 'adjust' | 'done' | 'error'
  score?: number
  message?: string
}
