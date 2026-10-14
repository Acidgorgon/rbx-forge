// IPC types for the Animation Lab (main/services/anim). HarnessApi / HarnessEvents extend these.

import type { AnimClipRef } from './anim/types.ts'
import type { AnimCheckReport, AnimClip, AnimEntry, AnimExportResult, AnimImportResult, AnimLabStatus, AnimRefineOptions, AnimRefineProgress, AnimScope, AnimScriptResult, AnimStyle, AnimUploadResult, RigType } from './anim/model.ts'
import type { LabModels } from './labModels.ts'
import type { Restatement } from './restate/types.ts'
import type { CustomMoveTag, ResolvedMoveSet } from './anim/movesets.ts'
import type { RemixCandidate, RemixOp } from './anim/remix.ts'

export type { RemixCandidate, RemixOp, RemixOrigin, RemixPart } from './anim/remix.ts'

// Animate row mode: from scratch (the model writes keys) or remix the closest library clip (edit ops
// on real motion). auto: remix when the library has a usable clip of the request's move type.
export type AnimRemixMode = 'auto' | 'remix' | 'scratch'

export interface AnimRemixOptions extends AnimRefineOptions {
  // Library id of the clip to start from (default: the closest one for the request).
  base?: string
  // Ops to apply instead of planning them.
  ops?: RemixOp[]
  refine?: boolean
  scope?: AnimScope
  rig?: RigType
  restatement?: Restatement
}

export type * from './anim/model.ts'
export type { LabModels, LabTier } from './labModels.ts'

export interface AnimCoverage {
  tags: { tag: string; clips: number; liked: number; disliked: number }[]
  thin: string[]
}

// Move sets (anim/movesets.ts): the active one (with the project's custom move types) and the built-ins.
export interface AnimMoveSets {
  active: ResolvedMoveSet
  sets: { id: string; name: string; description: string }[]
}

export interface AnimRetagResult {
  set: string
  // model: the cheap Labs tier read the clips; heuristic: keywords in names, files and notes.
  source: 'model' | 'heuristic'
  total: number
  changed: number
  changes: { id: string; before: string[]; after: string[] }[]
}

export interface AnimImportOptions {
  // Bad examples: never used as references, they feed "avoid" notes to the drafter and the critic.
  quality?: 'reference' | 'good' | 'avoid'
  tags?: string[]
  // Tag suggestions only (nothing is saved): the import dialog shows them as editable pills.
  dryRun?: boolean
  // Convert every imported clip to this rig. Absent: each clip keeps its own rig (R6 stays R6).
  convert?: RigType
}

export interface AnimImportPreview {
  file: string
  name: string
  duration: number
  looped: boolean
  markers: number
  suggestedTags: string[]
  rig?: RigType
  error?: string
}

export interface AnimApi {
  animStatus(): Promise<AnimLabStatus>
  animList(): Promise<AnimEntry[]>
  animGet(id: string): Promise<AnimEntry>
  // .rbxm / .rbxmx KeyframeSequences and .bvh motion capture, retargeted to R15.
  animImport(paths: string[], scope: AnimScope, opts?: AnimImportOptions): Promise<AnimImportResult>
  animPreviewImport(paths: string[]): Promise<AnimImportPreview[]>
  animChooseImport(): Promise<string[]>
  animUpdate(id: string, patch: { name?: string; description?: string; tags?: string[]; notes?: string; quality?: AnimEntry['quality'] | null; reference?: string | null; clip?: AnimClip }): Promise<AnimEntry>
  animDelete(id: string): Promise<boolean>
  // Thumbs up / down: re-learns the style profile and, on up, saves the clip as an example.
  animRate(id: string, rating: 'up' | 'down' | null): Promise<AnimEntry>
  animLearn(): Promise<{ style: AnimStyle; saved: string[]; errors: string[] }>
  animStyle(): Promise<AnimStyle | null>
  animCoverage(): Promise<AnimCoverage>
  // Move sets (Combat / Football / Movement & emotes), per project in .forge/anim/settings.json.
  animMoveSets(): Promise<AnimMoveSets>
  animSetMoveSet(id: string): Promise<ResolvedMoveSet>
  animAddMoveTag(tag: CustomMoveTag): Promise<ResolvedMoveSet>
  animRemoveMoveTag(tag: string): Promise<ResolvedMoveSet>
  // Re-tags the library with the active set (cheap model, else keywords); keeps unmatched clips' tags.
  animRetag(): Promise<AnimRetagResult>
  // rig: R15 or R6 (default: the project's rig).
  // reference: a video reference id ("make it like this"; see RefApi).
  animCompose(request: string, opts?: AnimRefineOptions & { refine?: boolean; scope?: AnimScope; rig?: RigType; reference?: string; restatement?: Restatement }): Promise<AnimScriptResult>
  // Remix closest: library clips to start from for a request (best first) and the request's move types.
  animRemixCandidates(prompt: string): Promise<{ candidates: RemixCandidate[]; tags: string[] }>
  // Edits the closest (or the given) library clip with planned ops; saved as a generated clip.
  animRemix(request: string, opts?: AnimRemixOptions): Promise<AnimScriptResult>
  // Re-applies (edited) ops to a remixed clip's base, or to another base clip.
  animRemixApply(id: string, ops: RemixOp[], opts?: { base?: string }): Promise<AnimEntry>
  // From scratch / Remix closest, per project in .forge/anim/settings.json.
  animRemixMode(): Promise<AnimRemixMode>
  animSetRemixMode(mode: AnimRemixMode): Promise<AnimRemixMode>
  animRunScript(script: string, opts?: { id?: string; save?: boolean; prompt?: string; rig?: RigType }): Promise<AnimScriptResult>
  // The rig new clips use (project setting, .forge/anim/settings.json; app default without a project).
  animGetRig(): Promise<RigType>
  animSetRig(rig: RigType): Promise<RigType>
  // Converts a clip to the other rig (in place, or as a copy). R15 -> R6 loses elbow / knee / waist bends.
  animConvert(id: string, to: RigType, opts?: { copy?: boolean }): Promise<{ entry: AnimEntry; warning: string }>
  animRefine(id: string, opts?: AnimRefineOptions): Promise<void>
  animCancel(id: string): Promise<void>
  animChecks(id: string): Promise<AnimCheckReport>
  animExamples(): Promise<{ key: string; name: string; description: string; tags: string[]; rig: RigType }[]>
  animAddExample(key: string): Promise<AnimEntry>
  animFile(id: string, file: string): Promise<string | null>
  animSaveThumb(id: string, pngDataUrl: string): Promise<AnimEntry>
  // Writes src/shared/Animations/<Name>/init.luau + Sequence.rbxmx into the project.
  animExport(id: string): Promise<AnimExportResult>
  // Uploads the KeyframeSequence as an Animation asset (Open Cloud) and writes the id into the module.
  animUpload(id: string): Promise<AnimUploadResult>
  // CONTRACT (shared with the Ability Composer).
  listAnimClips(): Promise<AnimClipRef[]>
  // Motor6D.Transform per joint name as 12 numbers; null for an unknown id. R15 clips: Root, Waist,
  // Neck, ...; R6 clips (AnimClipRef.rig = "R6"): RootJoint, Neck, "Right Shoulder", ... in the R6
  // Motor6Ds' own frames.
  getAnimPose(id: string, t: number): Promise<Record<string, number[]> | null>
  // Labs model tiers (Settings > Labs), shared with the VFX Lab and the Ability Composer.
  getLabModels(): Promise<LabModels>
  setLabModels(models: LabModels): Promise<LabModels>
}

export interface AnimEvents {
  'anim:changed': { at: number }
  'anim:progress': AnimRefineProgress
}
