// IPC types for VFX Lab custom textures (main/services/vfx/textures). HarnessApi / HarnessEvents
// extend these.

import type { TintMode } from './vfx/tex/image.ts'
import type { ProceduralParams, ProceduralType } from './vfx/tex/procedural.ts'
import type { TextureKind, TextureScope, VfxTexture } from './vfx/tex/textures.ts'
import type { TexturePolicy } from './vfx/tex/reuse.ts'
import type { FlipbookLayout } from './vfx/tex/image.ts'

export type { TintMode, ProceduralParams, ProceduralType, TextureKind, TextureScope, VfxTexture, TexturePolicy }

// One texture offered for import (files, pasted asset ids, or ids harvested from Studio), with what
// the analysis suggests; the review edits name / kind / tags / flipbook before committing.
export interface TextureImportRow {
  key: string
  from: 'file' | 'asset' | 'studio'
  // File path relative to what was picked / dropped (files), or the asset id.
  label: string
  name: string
  kind: TextureKind
  tags: string[]
  description: string
  // Detected or hinted flipbook (null = a single texture). The review can switch it off.
  flipbook: { layout: FlipbookLayout; frames: number; cols: number; rows: number; source: string } | null
  // Small preview (PNG data URL on black), when there is one.
  preview?: string
  color?: string
  edge?: 'soft' | 'hard'
  notes: string[]
  // A texture already in the library (or earlier in this batch) with the same pixels / asset id.
  duplicateOf?: string
  assetId?: string
  // Studio: where the id is used.
  paths?: string[]
  error?: string
  // Names / description came from the vision model.
  vision?: boolean
}

export interface TextureImportScan {
  scanId: string
  rows: TextureImportRow[]
  // Why some sources were skipped (Studio not connected, offline thumbnails, too many files ...).
  notes: string[]
}

export interface TextureImportCommit {
  scanId: string
  scope?: TextureScope
  rows: { key: string; name?: string; kind?: TextureKind; tags?: string[]; description?: string; flipbook?: boolean }[]
}

export interface TextureGenerateInput {
  kind?: TextureKind
  description?: string
  // Procedural (free): type + params + seed; omitted = the kind's procedural type when ai is false.
  procedural?: { type: ProceduralType; params?: ProceduralParams; seed?: number }
  // true: generate with OpenAI (costs money, uses the Art page's model and daily budget).
  ai?: boolean
  tint?: TintMode
  // 64..1024, power of two (single textures default 256 procedural / 512 AI; flipbooks 1024).
  size?: number
  // 1, or 4 / 16 / 64 frames (Grid2x2 / Grid4x4 / Grid8x8).
  frames?: number
  // AI: variants (separate textures; with frames 4 the four variants become one 2x2 sheet).
  n?: number
  scope?: TextureScope
  name?: string
  tags?: string[]
  source?: 'page' | 'agent'
}

export interface TextureStatus {
  project: boolean
  openaiKey: boolean
  robloxKey: boolean
  creator: boolean
  model: string
  // AI estimate per image, today's spend (Art + textures) and the Art page's daily cap.
  perImageUsd: number
  spentTodayUsd: number
  dailyCapUsd: number
  counts: { user: number; project: number }
  // Set when the Art page's image backend is Codex (ChatGPT plan): no key, cost or cap applies.
  codex?: { ready: boolean; detail: string }
  // VFX Lab setting: how effects pick textures (library only / library first / generate freely).
  policy?: TexturePolicy
  // A vision model is configured (import names textures with the cheap tier).
  vision?: boolean
  // Studio sources for "From Studio".
  studio?: { connected: boolean; liveTree: boolean }
}

export interface VfxTextureApi {
  vfxTexStatus(): Promise<TextureStatus>
  vfxTexList(): Promise<VfxTexture[]>
  vfxTexGenerate(input: TextureGenerateInput): Promise<VfxTexture[]>
  // Live procedural preview while dragging sliders (PNG data URL, not saved).
  vfxTexPreview(input: { type: ProceduralType; params?: ProceduralParams; seed?: number; tint?: TintMode; frames?: number }): Promise<string>
  vfxTexUpdate(id: string, patch: { name?: string; description?: string; tags?: string[] }): Promise<VfxTexture>
  vfxTexRate(id: string, rating: 'up' | 'down' | null): Promise<VfxTexture>
  vfxTexDelete(id: string): Promise<boolean>
  // Open Cloud upload as an Image asset; the effect's forgetex:// reference becomes rbxassetid://
  // when it is written to the project.
  vfxTexUpload(id: string): Promise<VfxTexture>
  // Re-reads the moderation state of an uploaded texture.
  vfxTexCheck(id: string): Promise<VfxTexture>
  // texture.png or preview.png as a data URL.
  vfxTexFile(id: string, which: 'texture' | 'preview'): Promise<string | null>
  // Import: scan files / folders (recursive), pasted asset ids, or the ids used in the open Studio
  // place; then commit the reviewed rows.
  vfxTexImportPick(what: 'files' | 'folder'): Promise<string[]>
  vfxTexImportScan(paths: string[], opts?: { vision?: boolean }): Promise<TextureImportScan>
  vfxTexImportIds(text: string, opts?: { vision?: boolean }): Promise<TextureImportScan>
  vfxTexImportStudio(opts?: { vision?: boolean }): Promise<TextureImportScan>
  vfxTexImportCommit(input: TextureImportCommit): Promise<VfxTexture[]>
  vfxTexSetPolicy(policy: TexturePolicy): Promise<TexturePolicy>
}

export interface VfxTextureEvents {
  'vfx:textures': { at: number }
}
