// Art / UI concept workflow: OpenAI image generation saved into <project>/art/concepts, import to
// Roblox through Open Cloud Assets, and the src/shared/Assets/Images.luau registry.
// Keys (OpenAI, Open Cloud) never cross IPC; the renderer only learns whether they are set.

export type ArtModel =
  | 'gpt-image-2.5-flare'
  | 'gpt-image-2.5-sunburst'
  | 'gpt-image-2'
  | 'gpt-image-1.5'
  | 'gpt-image-1-mini'

export type ArtQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto'

export type ArtStyleId = 'none' | 'roblox-ui-flat' | 'stylized-icon' | 'cartoon-key-art' | 'thumbnail-16x9' | 'game-icon-512'

export interface ArtStylePreset {
  id: ArtStyleId
  label: string
  // Appended to the prompt as art direction.
  direction: string
  size?: string
  transparent?: boolean
}

export interface ArtGenerateInput {
  prompt: string
  style?: ArtStyleId
  // "1024x1024", "1536x1024", "1024x1536", "auto", or WIDTHxHEIGHT (multiples of 16) on gpt-image-2+.
  size?: string
  quality?: ArtQuality
  transparent?: boolean
  // Variants, 1-10 (agents are capped lower).
  n?: number
  // Reference images (absolute paths, or project-relative like art/concepts/...): makes it an edit.
  referencePaths?: string[]
  // Optional PNG mask for the first reference (transparent = area to change).
  maskPath?: string
  model?: ArtModel
  // File name base; derived from the prompt when absent.
  slug?: string
  // Who asked: the Art page or an agent tool.
  source?: 'page' | 'agent'
}

export interface ArtRobloxInfo {
  assetId: string
  uri: string
  assetType: 'Image' | 'Decal'
  name?: string
  uploadedAt: string
  moderation?: string
}

// One generated image plus its sidecar JSON.
export interface ArtItem {
  // Project-relative path, forward slashes: art/concepts/2026-10-13/coin-icon-1.png
  path: string
  absPath: string
  date: string
  slug: string
  index: number
  prompt: string
  // Prompt sent to OpenAI (with style direction).
  fullPrompt: string
  style: ArtStyleId
  model: string
  size: string
  quality: string
  background: 'transparent' | 'opaque' | 'auto'
  outputFormat: 'png' | 'webp' | 'jpeg'
  mode: 'generate' | 'edit'
  referencePaths?: string[]
  // OpenAI image models take no seed; kept for the sidecar shape.
  seed: null
  costUsd: number
  createdAt: string
  bytes: number
  width?: number
  height?: number
  source: 'page' | 'agent'
  roblox?: ArtRobloxInfo
  // Copied into art/ui/<Name>.png by "Save to project".
  savedAs?: string
}

export interface ArtCostEstimate {
  model: string
  quality: string
  size: string
  n: number
  perImageUsd: number
  totalUsd: number
  // Today's spend so far and the daily cap (0 = no cap).
  spentTodayUsd: number
  dailyCapUsd: number
  note: string
}

// 'track-small' (default): art/ is tracked but files over 5 MB are listed in art/.gitignore.
export type ArtGitPolicy = 'track-small' | 'track' | 'ignore'

export interface ArtSettings {
  model: ArtModel
  quality: ArtQuality
  gitPolicy: ArtGitPolicy
  dailyCapUsd: number
  // Roblox creator for uploads (one of them).
  creatorUserId?: number
  creatorGroupId?: number
  assetType: 'Image' | 'Decal'
  // Who makes the images (Art, Thumbnail Lab, VFX textures): 'api' = the OpenAI Images API with
  // the OpenAI key (billed, daily budget applies); 'codex' = the ChatGPT plan through the Codex
  // CLI's built-in image tool (plan limits, no spend cap). Unset = 'api'.
  backend?: ImageBackend
}

export type ImageBackend = 'api' | 'codex'

// The Codex backend's state, on every image status when it is the chosen backend.
export interface CodexImageInfo {
  ready: boolean
  detail: string
}

// Recorded as the model of images made through Codex (it runs gpt-image-2 on the plan).
export const CODEX_IMAGE_MODEL = 'codex-gpt-image-2'
// Shown wherever a cost would be: there is none to show.
export const CODEX_IMAGE_NOTE = 'ChatGPT plan (Codex): counts toward your plan limits, no spend cap. Codex picks the size; up to 4 images per run.'

export interface ArtStatus {
  project: boolean
  openaiKey: boolean
  robloxKey: boolean
  // Where the Open Cloud key comes from: the Art key, or the Release key as a fallback.
  robloxKeySource?: 'art' | 'release'
  settings: ArtSettings
  styles: ArtStylePreset[]
  models: ArtModel[]
  // Set when settings.backend is 'codex'.
  codex?: CodexImageInfo
}

export interface ArtImportInput {
  path: string
  // Registry key (PascalCase identifier); derived from the slug when absent.
  name?: string
  assetType?: 'Image' | 'Decal'
  // Write the id into src/shared/Assets/Images.luau (default true).
  registry?: boolean
}

export interface ArtImportResult {
  item: ArtItem
  assetId: string
  uri: string
  registry?: { path: string; name: string; changed: boolean }
}

export interface ArtRegistryEntry {
  name: string
  uri: string
}

export interface ArtEvents {
  // Concepts were added, changed or removed.
  'art:changed': { root: string }
  // Generation/upload progress for the page.
  'art:progress': { id: string; stage: string; detail?: string }
  // The FBX upload inbox finished a request (a Forge toast).
  'fbxInbox:upload': ModelInboxEntry
}

// FBX upload inbox (main/services/art/modelInbox.ts): <id>.request.json files dropped in a folder
// become Model assets; Forge writes <id>.result.json back.
export interface ModelInboxEntry {
  id: string
  name?: string
  status: 'done' | 'error'
  assetId?: number | string
  error?: string
  at: string
}

export interface ModelInboxStatus {
  enabled: boolean
  // The folder in use, the default one (<Documents>/ForgeModels/_upload_inbox) and its parent root.
  dir: string
  defaultDir: string
  modelsDir: string
  robloxKey: boolean
  creator: boolean
  watching: boolean
  recent: ModelInboxEntry[]
}

export interface ArtApi {
  artStatus(): Promise<ArtStatus>
  artSetSettings(patch: Partial<ArtSettings>): Promise<ArtStatus>
  artSetRobloxKey(key: string, scope: 'project' | 'global'): Promise<ArtStatus>
  artClearRobloxKey(scope: 'project' | 'global'): Promise<ArtStatus>
  artList(): Promise<ArtItem[]>
  artEstimate(input: ArtGenerateInput): Promise<ArtCostEstimate>
  artGenerate(input: ArtGenerateInput): Promise<ArtItem[]>
  // Small preview as a data: URL (cached; full image when no thumbnailer is available).
  artThumbnail(path: string, full?: boolean): Promise<string>
  artDelete(path: string): Promise<{ undoId: string }>
  artUndoDelete(undoId: string): Promise<ArtItem | null>
  artImportToRoblox(input: ArtImportInput): Promise<ArtImportResult>
  // Copy to art/ui/<Name>.png without uploading.
  artSaveToProject(path: string, name?: string): Promise<ArtItem>
  artRegistry(): Promise<ArtRegistryEntry[]>
  artChooseReferences(): Promise<string[]>
  // Opens a concept in the OS image viewer ('open') or shows it in its folder ('folder').
  artReveal(path: string, how: 'open' | 'folder'): Promise<void>
  // FBX upload inbox. Enabling needs an Open Cloud key; dir null goes back to the default folder.
  fbxInboxStatus(): Promise<ModelInboxStatus>
  fbxInboxSetSettings(patch: { enabled?: boolean; dir?: string | null }): Promise<ModelInboxStatus>
  // Folder picker; saves the choice. Unchanged status when cancelled.
  fbxInboxChooseFolder(): Promise<ModelInboxStatus>
}
