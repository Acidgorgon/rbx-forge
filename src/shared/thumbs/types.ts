// Thumbnail Lab: reference thumbnails analysed into style cards, named style profiles, base images
// from the real game (project screenshots or a Studio capture), generated 1920x1080 variations with a
// critic, ratings / "would ship" and manual CTR that teach taste, and the Open Cloud upload.
// Plain data shared by main, preload, renderer and tests. No node or electron imports.

import type { PrincipleScore } from '../principles/types.ts'
import type { Restatement } from '../restate/types.ts'

export type ThumbScope = 'user' | 'project'

// Code-side image statistics (stats.ts). All ratios 0..1 unless noted.
export interface ThumbImageStats {
  width: number
  height: number
  // Dominant colours, most common first (hex + share of pixels).
  palette: { hex: string; share: number }[]
  // Mean HSV saturation and the share of strongly saturated pixels (s > 0.6, v > 0.25).
  saturation: number
  vivid: number
  // Mean luma and RMS contrast (luma standard deviation, 0..~0.5).
  luma: number
  contrast: number
  // Hasler-Süsstrunk colourfulness, scaled to 0..1 (raw / 150).
  colorfulness: number
  // Share of pixels on a strong edge (Sobel magnitude over a threshold) at 256x144.
  edgeDensity: number
  // Edge / saliency energy in the centre third vs the whole frame (>1: subject in the middle).
  centerFocus: number
}

// Small-size readability (stats.ts smallSizeReport): what survives on the discovery page.
export interface SmallSizeReport {
  // 0..10 proxies.
  legibility256: number
  legibility160: number
  focal256: number
  focal160: number
  // Strong-edge detail kept at 160x90 relative to 256x144 (0..1).
  detailKept: number
  // Visual weight in the bottom 15% (Creator Hub: keep essential content off the bottom edge).
  bottomLoad: number
  // How far the image's colours stand out from Roblox's page backgrounds (0..1).
  popDark: number
  popLight: number
}

export type Framing = 'close-up' | 'medium' | 'scene'
export type SaturationLevel = 'muted' | 'balanced' | 'vivid' | 'neon'
export type TextSize = 'none' | 'small' | 'medium' | 'large' | 'huge'

// The vision analysis of one reference (style only: never characters, logos or the text itself).
export interface StyleCard {
  composition: string
  framing: Framing
  palette: string[]
  saturation: SaturationLevel
  outline: boolean
  rimLight: boolean
  glow: boolean
  text: { present: boolean; words: number; size: TextSize; placement: string; font: string }
  emotion: string
  // 0..10
  focalContrast: number
  clutter: number
  notes: string
}

export interface ThumbRef {
  id: string
  scope: ThumbScope
  name: string
  // The game it came from (kept out of prompts: references teach style only).
  game?: string
  source: 'file' | 'url' | 'paste'
  url?: string
  file: string
  width: number
  height: number
  stats: ThumbImageStats
  card?: StyleCard
  analyzedAt?: number
  analyzeError?: string
  tags: string[]
  createdAt: number
  updatedAt: number
}

// Aggregate of several style cards + stats (style.ts aggregateProfile).
export interface ProfileCard {
  framing: { mode: Framing; share: number }
  palette: string[]
  saturation: SaturationLevel
  outline: number
  rimLight: number
  glow: number
  text: { share: number; words: number; size: TextSize; placement: string; font: string }
  emotions: string[]
  focalContrast: number
  clutter: number
  compositions: string[]
}

export interface ThumbStyleProfile {
  id: string
  scope: ThumbScope
  name: string
  refIds: string[]
  card: ProfileCard
  stats: Pick<ThumbImageStats, 'saturation' | 'vivid' | 'luma' | 'contrast' | 'colorfulness' | 'edgeDensity' | 'centerFocus'>
  // The style text that goes into the generation prompt (no names, no logos, no copied text).
  summary: string
  notes?: string
  createdAt: number
  updatedAt: number
}

export interface ThumbBase {
  id: string
  scope: ThumbScope
  name: string
  source: 'file' | 'studio'
  file: string
  width: number
  height: number
  createdAt: number
}

export interface CtrRecord {
  at: number
  // Optional period label ("2026-10-01..10-07").
  period?: string
  impressions: number
  clicks: number
  note?: string
}

export interface ThumbCritique {
  at: number
  // 0..10 (principles blended with the critic's overall).
  overall: number
  summary: string
  principles: PrincipleScore[]
  focus: string[]
  // Changes for the next refine (most important first).
  changes: string[]
  // No-copy guard: things that look taken from the references or other games.
  copyFlags: string[]
  by: 'critic' | 'code'
}

export interface Thumb {
  id: string
  batchId: string
  scope: ThumbScope
  name: string
  brief: string
  restatement?: Restatement
  profileId?: string
  baseIds: string[]
  // Refine: the variation it came from and the round.
  parentId?: string
  round: number
  prompt: string
  // The builder sections the prompt was made from (refine reuses them).
  sections?: PromptSection[]
  model: string
  // What OpenAI was asked for (the image is then cropped / resized to 1920x1080).
  genSize: string
  quality: string
  costUsd: number
  file: string
  small: { s256: string; s160: string }
  stats: ThumbImageStats
  report: SmallSizeReport
  critique?: ThumbCritique
  rating?: 'up' | 'down'
  ship?: boolean
  notes?: string
  roblox?: { assetId: string; uri: string; uploadedAt: number; moderation?: string }
  experience?: { universeId: number; mediaAssetId: string; at: number; languageCode: string }
  ctr: CtrRecord[]
  createdAt: number
  updatedAt: number
}

export interface ThumbBatch {
  id: string
  brief: string
  at: number
  thumbs: Thumb[]
  bestId?: string
}

export interface ThumbSettings {
  // Image model (default gpt-image-2.5-sunburst; gpt-image-1-mini is the cheap option).
  model: string
  quality: string
  // Variations per Make (1..10, default 4).
  n: number
  // Attach up to two of the profile's reference images to the edit call as style references
  // (the prompt says style only; the critic's copy guard checks the result).
  sendRefs: boolean
  // Experience thumbnail upload (experimental Open Cloud API): the experience's universe id per
  // project and the source language code.
  languageCode: string
}

export const THUMB_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.5-flare', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini'] as const
export const DEFAULT_THUMB_SETTINGS: ThumbSettings = { model: 'gpt-image-2.5-sunburst', quality: 'high', n: 4, sendRefs: true, languageCode: 'en' }

export interface ThumbStatus {
  project: boolean
  openaiKey: boolean
  robloxKey: boolean
  creator: boolean
  vision: boolean
  studio: { connected: boolean; message: string }
  model: string
  quality: string
  genSize: string
  perImageUsd: number
  spentTodayUsd: number
  dailyCapUsd: number
  counts: { refs: number; profiles: number; bases: number; thumbs: number; ui?: number }
  settings: ThumbSettings
  models: string[]
  universeId?: number
  // Set when the Art page's image backend is Codex (ChatGPT plan): no key, cost or cap applies.
  codex?: { ready: boolean; detail: string }
}

export interface ThumbGenerateInput {
  brief: string
  // Prompt builder sections the user reviewed / edited (builder.ts). Without them the rule-based
  // builder fills them from the brief, the style profile and the learned taste.
  sections?: PromptSection[]
  profileId?: string
  baseIds?: string[]
  n?: number
  quality?: string
  scope?: ThumbScope
  restatement?: Restatement
  // Run the critic on every variation and pick the best (default true).
  critique?: boolean
  source?: 'page' | 'agent'
}

export interface ThumbEstimate {
  n: number
  model: string
  quality: string
  genSize: string
  perImageUsd: number
  totalUsd: number
  spentTodayUsd: number
  dailyCapUsd: number
  overCap: boolean
}

export interface TasteView {
  samples: number
  ctrSamples: number
  weights: Record<string, number>
  lines: string[]
}

export interface ThumbsEvents {
  'thumbs:changed': { at: number }
  'thumbs:progress': { batchId: string; stage: string; detail?: string; done?: boolean; error?: boolean }
}

export interface ThumbsApi {
  thumbStatus(): Promise<ThumbStatus>
  thumbSetSettings(patch: Partial<ThumbSettings> & { universeId?: number | null }): Promise<ThumbStatus>
  thumbRefs(): Promise<ThumbRef[]>
  // Files (absolute paths), http(s) URLs (downloaded locally) or pasted data: URLs.
  thumbAddRefs(input: { paths?: string[]; urls?: string[]; dataUrls?: string[]; game?: string }, scope?: ThumbScope): Promise<{ added: ThumbRef[]; skipped: { item: string; reason: string }[] }>
  thumbChooseImages(): Promise<string[]>
  thumbAnalyzeRef(id: string): Promise<ThumbRef>
  thumbUpdateRef(id: string, patch: { name?: string; game?: string; tags?: string[] }): Promise<ThumbRef>
  thumbDeleteRef(id: string): Promise<boolean>
  thumbProfiles(): Promise<ThumbStyleProfile[]>
  thumbSaveProfile(input: { id?: string; name: string; refIds: string[]; scope?: ThumbScope; notes?: string }): Promise<ThumbStyleProfile>
  thumbDeleteProfile(id: string): Promise<boolean>
  thumbBases(): Promise<ThumbBase[]>
  thumbAddBases(paths: string[], scope?: ThumbScope): Promise<ThumbBase[]>
  thumbCaptureStudio(name?: string): Promise<ThumbBase>
  thumbDeleteBase(id: string): Promise<boolean>
  thumbEstimate(input: ThumbGenerateInput): Promise<ThumbEstimate>
  thumbGenerate(input: ThumbGenerateInput): Promise<{ id: string; thumbs: Thumb[]; bestId?: string }>
  thumbCritique(id: string): Promise<{ id: string; thumb: Thumb }>
  thumbRefine(id: string, opts?: { note?: string; rounds?: number; threshold?: number }): Promise<{ id: string; thumbs: Thumb[] }>
  thumbList(): Promise<Thumb[]>
  thumbRate(id: string, rating: 'up' | 'down' | null): Promise<Thumb>
  thumbShip(id: string, ship: boolean): Promise<Thumb>
  thumbNotes(id: string, notes: string): Promise<Thumb>
  thumbDelete(id: string): Promise<boolean>
  thumbAddCtr(id: string, rec: { impressions: number; clicks: number; period?: string; note?: string }): Promise<Thumb>
  thumbRemoveCtr(id: string, index: number): Promise<Thumb>
  thumbUpload(id: string): Promise<Thumb>
  // Experimental Open Cloud (legacy-game-internationalization): adds it to the experience's
  // thumbnails. Only after the user confirmed in the UI.
  thumbSetExperience(id: string, opts: { universeId: number; languageCode?: string }): Promise<Thumb>
  thumbTaste(): Promise<TasteView>
  thumbFile(kind: 'ref' | 'base' | 'thumb' | 'ui', id: string, which?: 'image' | 's256' | 's160'): Promise<string | null>
  // A variation the user likes becomes a style reference (own game: no copy concern).
  thumbUseAsRef(id: string): Promise<ThumbRef>
  // Prompt builder: a short ask -> editable sections (rules; "model" expands them with the Labs model).
  thumbBuildPrompt(input: BuildPromptInput): Promise<BuiltPrompt>
  // UI art: buttons, panels, icons, icon sets, HUD mockups (transparent where it makes sense).
  thumbUiEstimate(input: UiGenerateInput): Promise<ThumbEstimate>
  thumbUiGenerate(input: UiGenerateInput): Promise<UiBatchResult>
  thumbUiList(): Promise<UiAsset[]>
  thumbUiRate(id: string, rating: 'up' | 'down' | null): Promise<UiAsset>
  thumbUiKeep(id: string, keep: boolean): Promise<UiAsset>
  thumbUiPin(id: string, pinned: boolean): Promise<UiAsset>
  thumbUiCritique(id: string): Promise<{ id: string; asset: UiAsset }>
  thumbUiDelete(id: string): Promise<boolean>
  thumbUiKit(): Promise<UiKit>
  thumbUiExport(id: string): Promise<{ path: string; luau: string }>
  thumbUiUpload(id: string): Promise<UiAsset>
}

// ------------------------------------------------------------------ prompt builder

export type UiAssetKind = 'button' | 'panel' | 'icon' | 'icon-set' | 'hud'
export type PromptMode = 'thumbnail' | UiAssetKind
export type SectionKey = 'subject' | 'composition' | 'camera' | 'lighting' | 'palette' | 'style' | 'text' | 'roblox' | 'output' | 'avoid'

export interface PromptSection {
  key: SectionKey
  label: string
  text: string
  // Where it came from: the rules, the model, the style kit / profile, or the user's edit.
  source?: 'rules' | 'model' | 'kit' | 'user'
}

export interface BuildPromptInput {
  ask: string
  mode: PromptMode
  profileId?: string
  baseIds?: string[]
  // Icon set: the icons to draw (else read from the ask).
  names?: string[]
  // Ask the Labs model to expand the rule draft (falls back to the rules when there is none).
  model?: boolean
}

export interface BuiltPrompt {
  mode: PromptMode
  sections: PromptSection[]
  // The final prompt as it would be sent (sections + the fixed honesty / copy lines).
  prompt: string
  notes: string[]
  warnings: string[]
  by: 'rules' | 'model'
  // Icon set names read from the ask.
  names?: string[]
}

// ------------------------------------------------------------------ UI art

export interface UiLook {
  stroke: string
  corners: string
  shading: string
  typography: string
}

export interface UiAssetStats {
  width: number
  height: number
  // Share of visible (alpha > 128) pixels.
  coverage: number
  // Colours of the visible pixels only.
  palette: { hex: string; share: number }[]
  // Measured look: outline darker / lighter than the fill, corner radius (fraction of the short
  // side), flat fill (0..1), lit from the top.
  outline: 'dark' | 'light' | 'none'
  corner: number
  flatness: number
  topLit: boolean
}

export interface UiSlice {
  // Roblox ImageLabel.SliceCenter in pixels of the exported image (ScaleType = Slice).
  x0: number
  y0: number
  x1: number
  y1: number
}

export interface UiCritique {
  at: number
  overall: number
  summary: string
  scores: { brief: number; readability: number; consistency: number; clean: number }
  changes: string[]
  by: 'critic' | 'code'
}

export interface UiCheck {
  id: string
  label: string
  score: number
  note: string
  fix?: string
}

export interface UiAsset {
  id: string
  batchId: string
  scope: ThumbScope
  kind: UiAssetKind
  name: string
  ask: string
  // Icon sets: the set's name and this icon's place in it (0 = the anchor the rest follow).
  setName?: string
  setIndex?: number
  prompt: string
  sections?: PromptSection[]
  model: string
  genSize: string
  quality: string
  costUsd: number
  transparent: boolean
  // The model returned an opaque background and it was keyed out in code.
  keyed?: boolean
  file: string
  width: number
  height: number
  stats: UiAssetStats
  slice?: UiSlice
  checks: UiCheck[]
  critique?: UiCritique
  look?: UiLook
  rating?: 'up' | 'down'
  keep?: boolean
  // "Use as reference": attached to later UI prompts as an edit reference.
  pinned?: boolean
  // Assets that went in as references.
  refIds: string[]
  roblox?: { assetId: string; uri: string; uploadedAt: number; moderation?: string }
  exportedTo?: string
  createdAt: number
  updatedAt: number
}

export interface UiGenerateInput {
  ask: string
  kind: UiAssetKind
  // Candidates per asset (icon set: candidates for the first icon; the rest follow the best one).
  n?: number
  quality?: string
  names?: string[]
  // Panel shape.
  shape?: 'square' | 'wide' | 'tall'
  sections?: PromptSection[]
  // Attach the learned kit (palette, look, pinned references). Default true.
  useKit?: boolean
  scope?: ThumbScope
  source?: 'page' | 'agent'
}

export interface UiBatchResult {
  id: string
  assets: UiAsset[]
  bestId?: string
  // Icon set: the chosen anchor then one asset per remaining name, in order.
  set?: string[]
  notes: string[]
}

export interface UiKit {
  // Kept / +1 assets it was learned from.
  samples: number
  palette: string[]
  look: UiLook
  // Pinned assets first, then the most recent kept ones (edit references).
  refIds: string[]
  // The lines that go into prompts.
  lines: string[]
  avoid: string[]
}
