// IPC types for the VFX Lab (main/services/vfx). HarnessApi / HarnessEvents extend these.

import type { PerfWarning } from './vfx/analyze.ts'
import type { VfxEffect, VfxEntry, VfxImportResult, VfxLabStatus, VfxRecipe, VfxRefineOptions, VfxRefineProgress, VfxScope, VfxScriptResult } from './vfx/types.ts'
import type { VfxSpec } from './vfx/spec.ts'

export type * from './vfx/types.ts'
export type { PerfWarning, VfxSpec }

export interface VfxApi {
  vfxStatus(): Promise<VfxLabStatus>
  // User + project library, project first.
  vfxList(): Promise<VfxEntry[]>
  vfxGet(id: string): Promise<VfxEntry>
  vfxSearch(query: string): Promise<VfxEntry[]>
  // Files and folders: .rbxm / .rbxmx (effects), .png / .jpg / .webp / .gif / .mp4 / .webm (visual references).
  vfxImport(paths: string[], scope: VfxScope): Promise<VfxImportResult>
  // Native picker (files and folders); [] when cancelled.
  vfxChooseImport(): Promise<string[]>
  // Parameter edits write back to the effect's Luau module and .rbxmx when it was written.
  vfxUpdate(id: string, patch: { name?: string; description?: string; tags?: string[]; notes?: string; effect?: VfxEffect }): Promise<VfxEntry>
  vfxDelete(id: string): Promise<boolean>
  vfxRate(id: string, rating: 'up' | 'down' | null): Promise<VfxEntry>
  // Library -> recipes -> memory skills (vfx-recipe-<tag>).
  vfxLearn(): Promise<{ recipes: VfxRecipe[]; saved: string[]; errors: string[] }>
  vfxRecipes(): Promise<VfxRecipe[]>
  // "Make a ___ effect": draft + create; the refine loop continues in the background (vfx:progress).
  vfxMake(prompt: string, opts?: VfxRefineOptions): Promise<VfxEntry>
  vfxRefine(id: string, opts?: VfxRefineOptions): Promise<void>
  vfxCancel(id: string): Promise<void>
  vfxCreate(spec: VfxSpec, id?: string): Promise<{ entry: VfxEntry; warnings: PerfWarning[] }>
  // An entry's file (thumbs/..., frames/..., media/...) as a data URL.
  vfxFile(id: string, file: string): Promise<string | null>
  vfxSaveThumb(id: string, pngDataUrl: string): Promise<VfxEntry>
  // rbxassetid / local image -> data URL; null = placeholder.
  vfxResolveTexture(ref: string): Promise<string | null>
  // Timeline scripts (Luau, recorded by Lune): run one (save: store it on the entry, or as a new
  // entry without id), compose a scripted multi-stage effect from a request, built-in examples.
  vfxRunScript(script: string, opts?: { id?: string; save?: boolean; prompt?: string }): Promise<VfxScriptResult>
  // reference: a video reference id ("make it like this"; see RefApi).
  vfxCompose(request: string, opts?: VfxRefineOptions & { refine?: boolean; reference?: string }): Promise<VfxScriptResult>
  vfxExamples(): Promise<{ key: string; name: string; description: string; tags: string[] }[]>
  vfxAddExample(key: string): Promise<VfxEntry>
  vfxTestInStudio(id: string): Promise<{ module: string; rojo: 'running' | 'started' | 'unavailable'; command: string; instancePath: string }>
}

export interface VfxEvents {
  'vfx:changed': { at: number }
  'vfx:progress': VfxRefineProgress
}
