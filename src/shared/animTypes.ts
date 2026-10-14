// IPC types for the Animation Lab (main/services/anim). HarnessApi / HarnessEvents extend these.

import type { AnimClipRef } from './anim/types.ts'
import type { AnimCheckReport, AnimClip, AnimEntry, AnimExportResult, AnimImportResult, AnimLabStatus, AnimRefineOptions, AnimRefineProgress, AnimScope, AnimScriptResult, AnimStyle, AnimUploadResult, RigType } from './anim/model.ts'
import type { LabModels } from './labModels.ts'
import type { Restatement } from './restate/types.ts'

export type * from './anim/model.ts'
export type { LabModels, LabTier } from './labModels.ts'

export interface AnimCoverage {
  tags: { tag: string; clips: number; liked: number; disliked: number }[]
  thin: string[]
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
  // rig: R15 or R6 (default: the project's rig).
  // reference: a video reference id ("make it like this"; see RefApi).
  animCompose(request: string, opts?: AnimRefineOptions & { refine?: boolean; scope?: AnimScope; rig?: RigType; reference?: string; restatement?: Restatement }): Promise<AnimScriptResult>
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
