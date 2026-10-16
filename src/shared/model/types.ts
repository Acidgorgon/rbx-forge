// Model Lab (main/services/model): blocky, plated, voxel-style creature / guard / egg models built
// from Roblox Parts by a Luau build script on the BlockyKit library (resources/lune/BlockyKit.luau).
// The script runs headlessly in Lune for the preview (resources/lune/model_build.luau records every
// part) and in Studio through the Forge Bridge ("Build in Studio"). Plain data shared by main,
// preload and renderer. No electron imports.

export type ModelTemplateId = 'creature' | 'guard' | 'egg'
export const MODEL_TEMPLATE_IDS: readonly ModelTemplateId[] = ['creature', 'guard', 'egg']

// One recorded part. k: P Part, W WedgePart, C CornerWedgePart, M MeshPart, T TrussPart.
// cf: the CFrame's 12 components (x, y, z, R00..R22), in model-local studs (ctx.origin = identity).
// c: Color3 0..1 (sRGB). t: Transparency (omitted when 0). m: Material name (omitted for Plastic).
// sh: Part.Shape when not Block (Ball, Cylinder, Wedge, CornerWedge). a: Anchored.
export interface ModelPart {
  n: string
  k: 'P' | 'W' | 'C' | 'M' | 'T'
  s: [number, number, number]
  cf: number[]
  c: [number, number, number]
  t?: number
  m?: string
  sh?: string
  a?: boolean
}

export interface ModelStats {
  motors: number
  welds: number
  weldConstraints: number
  attachments: number
  animators: number
  animationControllers: number
  humanoids: number
  anchored: number
  instances: number
  // Parts joined by welds / motors, and the unanchored parts outside the main one (they would fall
  // apart in a running game).
  assemblies: number
  loose: number
  primaryPart?: string
  truncated?: boolean
}

export interface ModelScriptError {
  line?: number
  message: string
}

export interface ModelBuild {
  ok: boolean
  name?: string
  parts: ModelPart[]
  stats?: ModelStats
  prints: string[]
  error?: ModelScriptError
  // Build checks (part budget, loose parts, missing rig...), for the UI and the critic.
  warnings: string[]
  ms?: number
}

export interface ModelCriticRound {
  round: number
  at: number
  // What the critic said it changed (or why it kept the model).
  summary: string
  changed: boolean
  // Entry files of the frames it saw (frames/r<round>-<view>.png).
  frames: string[]
  parts?: number
  error?: string
}

export interface ModelGuardLink {
  // Dotted path of an existing guard Model in the place, e.g. Workspace.Guards.SharkGuard.
  path: string
  areaId: string
}

export interface ModelEntry {
  id: string
  name: string
  prompt: string
  template: ModelTemplateId
  script: string
  // Part count of the last successful build.
  parts: number
  stats?: ModelStats
  // Reference images (entry files refs/ref-N.png).
  refs: string[]
  // Preview snapshot (entry file thumb.png).
  thumb?: string
  // The updatedAt the thumbnail was taken at (a newer edit means it should be retaken).
  thumbStamp?: number
  critic?: ModelCriticRound[]
  guard?: ModelGuardLink
  origin: 'ai' | 'template' | 'edit'
  // The last build failed with this (the script is kept so it can be fixed).
  error?: string
  // The model call failed and the template was used instead.
  modelError?: string
  createdAt: number
  updatedAt: number
}

export interface ModelSettings {
  // Snapshot the preview and let the AI compare with the request / references and revise.
  critic: boolean
  rounds: number
}

export const MODEL_SETTINGS_DEFAULTS: ModelSettings = { critic: true, rounds: 2 }
export const MODEL_MAX_ROUNDS = 5

export interface ModelStatus {
  projectRoot: string | null
  // The library folder (<root>/.forge/models, or userData/models without a project).
  libraryDir: string
  lune: { available: boolean; version?: string; hint?: string }
  vision: boolean
  render: boolean
  studio: { connected: boolean; place?: string; pluginVersion?: number; canBuild: boolean; message: string }
  settings: ModelSettings
  entries: number
}

export type ModelPhase = 'writing' | 'building' | 'repairing' | 'capturing' | 'critic' | 'revising' | 'saving' | 'studio' | 'done' | 'error'

export interface ModelProgress {
  id?: string
  // The generate call this belongs to (the renderer passes one to follow its own run).
  run?: string
  phase: ModelPhase
  round?: number
  message: string
  at: number
}

export interface ModelGenerateOptions {
  template?: ModelTemplateId
  // Reference images as data URLs (png / jpg / webp), kept with the entry.
  refs?: string[]
  // Revise this entry (its script is the starting point) instead of making a new one.
  id?: string
  name?: string
  critic?: boolean
  rounds?: number
  run?: string
}

export interface ModelGenerateResult {
  entry: ModelEntry
  build: ModelBuild
  source: 'model' | 'template'
  notes: string[]
}

export interface ModelStudioResult {
  name: string
  parts: number
  path: string
  place?: string
}

export interface ModelApi {
  modelStatus(): Promise<ModelStatus>
  modelList(): Promise<ModelEntry[]>
  // The entry and its last build (rebuilt with Lune when the cached one is missing or stale).
  modelLoad(id: string): Promise<{ entry: ModelEntry; build: ModelBuild }>
  // Runs a script in the preview sandbox (nothing is saved).
  modelRun(script: string, opts?: { name?: string }): Promise<ModelBuild>
  // prompt + references -> AI build script -> preview -> critic rounds; saved as an entry.
  modelGenerate(prompt: string, opts?: ModelGenerateOptions): Promise<ModelGenerateResult>
  // A new entry from a built-in template script (no AI).
  modelFromTemplate(template: ModelTemplateId, opts?: { name?: string; prompt?: string }): Promise<{ entry: ModelEntry; build: ModelBuild }>
  // Saves an edited script (runs it first; a failing script is saved with its error).
  modelSave(id: string, patch: { script?: string; name?: string; prompt?: string; template?: ModelTemplateId; guard?: ModelGuardLink | null }): Promise<{ entry: ModelEntry; build: ModelBuild }>
  modelRename(id: string, name: string): Promise<ModelEntry>
  modelDelete(id: string): Promise<boolean>
  // One critic round on a saved entry (snapshots + references -> revised script).
  modelCritique(id: string, opts?: { run?: string }): Promise<ModelGenerateResult>
  modelSetSettings(patch: Partial<ModelSettings>): Promise<ModelSettings>
  // An entry file (refs/..., frames/..., thumb.png) as a data URL.
  modelFile(id: string, file: string): Promise<string | null>
  modelSaveThumb(id: string, pngDataUrl: string): Promise<ModelEntry>
  // Builds the model in the connected Studio place (Workspace, selected; Ctrl+Z removes it).
  modelBuildInStudio(id: string, opts?: { guard?: ModelGuardLink | null }): Promise<ModelStudioResult>
}

export interface ModelEvents {
  'model:changed': { at: number; id?: string }
  'model:progress': ModelProgress
}
