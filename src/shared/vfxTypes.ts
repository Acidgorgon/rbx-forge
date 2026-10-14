// IPC types for the VFX Lab (main/services/vfx). HarnessApi / HarnessEvents extend these.

import type { PerfWarning } from './vfx/analyze.ts'
import type { VfxEffect, VfxEntry, VfxImportCommit, VfxImportProgress, VfxImportResult, VfxImportScan, VfxLabStatus, VfxRecipe, VfxRefineOptions, VfxRefineProgress, VfxScope, VfxScriptResult, VfxStudioPack } from './vfx/types.ts'
import type { VfxSpec } from './vfx/spec.ts'
import type { Restatement } from './restate/types.ts'
import type { VfxMeshApi } from './vfxMeshTypes.ts'
import type { LiveSettings, LiveStatus } from './vfx/live.ts'

export type * from './vfx/types.ts'
export type { PerfWarning, VfxSpec, LiveSettings, LiveStatus }

export interface VfxApi extends VfxMeshApi {
  vfxStatus(): Promise<VfxLabStatus>
  // User + project library, project first.
  vfxList(): Promise<VfxEntry[]>
  vfxGet(id: string): Promise<VfxEntry>
  vfxSearch(query: string): Promise<VfxEntry[]>
  // Files and folders: .rbxm / .rbxmx (effects), .png / .jpg / .webp / .gif / .mp4 / .webm (visual references).
  // Effects already in the library (same content hash) are skipped (result.duplicates) unless force.
  vfxImport(paths: string[], scope: VfxScope, opts?: { force?: boolean }): Promise<VfxImportResult>
  // Bulk import with a review: scan files, or the Studio selection (nothing selected: scan.packs
  // lists VFX folders; scan again with their paths), then commit the chosen rows. vfx:import events
  // report progress.
  vfxImportScan(paths: string[]): Promise<VfxImportScan>
  vfxStudioScan(opts?: { packs?: VfxStudioPack['path'][] }): Promise<VfxImportScan>
  vfxImportCommit(input: VfxImportCommit): Promise<VfxImportResult>
  // Library management: deletes go to a trash until the next start (vfxRestore undoes a batch).
  vfxTrash(ids: string[]): Promise<{ batch: string; removed: string[] }>
  vfxRestore(batch: string): Promise<{ restored: string[] }>
  vfxClear(scope: VfxScope): Promise<{ batch: string; removed: string[] }>
  // Entries with the same effect (content hash), keep-first order.
  vfxDuplicates(): Promise<{ hash: string; scope: VfxScope; entries: VfxEntry[] }[]>
  // Recompute auto-tags (kind / element / timing); groups the user edited stay.
  vfxRetag(): Promise<{ changed: number; total: number }>
  // Live in Studio: Studio loops the current effect (pin: Loop on one entry until Stop or another
  // entry is current). vfxLiveSet pushes the lab's current effect (debounced); vfx:live reports.
  vfxLiveStart(opts?: { pin?: string | null; settings?: Partial<LiveSettings>; current?: { key: string; effect: VfxEffect; label?: string } }): Promise<LiveStatus>
  // loop: stop a Loop (Live, when on, follows the lab again); follow: the header toggle off (a Loop
  // keeps going); neither: everything off.
  vfxLiveStop(opts?: { loop?: boolean; follow?: boolean }): Promise<LiveStatus>
  vfxLiveSet(current: { key: string; effect: VfxEffect; label?: string }): Promise<LiveStatus>
  vfxLiveSettings(settings: Partial<LiveSettings>): Promise<LiveStatus>
  vfxLiveStatus(): Promise<LiveStatus>
  // Native picker (files and folders); [] when cancelled.
  vfxChooseImport(): Promise<string[]>
  // Parameter edits write back to the effect's Luau module and .rbxmx when it was written.
  vfxUpdate(id: string, patch: { name?: string; description?: string; tags?: string[]; tagGroups?: Partial<Record<'kind' | 'element' | 'timing' | 'custom', string[]>>; notes?: string; effect?: VfxEffect }): Promise<VfxEntry>
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
  vfxCompose(request: string, opts?: VfxRefineOptions & { refine?: boolean; reference?: string; restatement?: Restatement }): Promise<VfxScriptResult>
  vfxExamples(): Promise<{ key: string; name: string; description: string; tags: string[] }[]>
  vfxAddExample(key: string): Promise<VfxEntry>
  // Rebuilds an imported model entry from its stored model file (newer importer: parts, meshes,
  // script tweens).
  vfxReimport(id: string): Promise<VfxEntry>
  vfxTestInStudio(id: string): Promise<{ module: string; rojo: 'running' | 'started' | 'unavailable'; command: string; instancePath: string }>
}

export interface VfxEvents {
  'vfx:changed': { at: number }
  'vfx:progress': VfxRefineProgress
  // Mesh geometry arrived in the cache (previews reload those meshes).
  'vfx:meshes': { at: number; ids: string[] }
  // Bulk import progress (scan / Studio read / commit / meshes).
  'vfx:import': VfxImportProgress
  'vfx:live': LiveStatus
}
