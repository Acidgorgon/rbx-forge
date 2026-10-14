// IPC handlers (VfxApi) and agent tools for the VFX Lab, built from app pieces passed in by
// main/index.ts. No electron imports: capture, dialogs and the vision model come in as functions.

import type { LabGate } from '../../../shared/gating/hooks.ts'
import type { PrincipleHooks } from '../../../shared/principles/types.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import { join } from 'node:path'
import { findRuntimeDir, luneStatus } from '../tests/lune.ts'
import type { VfxEffect, VfxRefineOptions, VfxScope } from '../../../shared/vfx/types.ts'
import type { VfxSpec } from '../../../shared/vfx/spec.ts'
import { VfxService, type CaptureRequest, type MemoryLike, type VisionFn } from './service.ts'
import { vfxTools, type VfxTool } from './tools.ts'
import { TextureService } from './textures/service.ts'
import { textureTools } from './textures/tools.ts'
import type { TextureGenerateInput } from '../../../shared/vfxTextureTypes.ts'
import type { ArtFetch } from '../art/openaiImages.ts'
import type { CodexImages } from '../art/imageBackend.ts'
import type { ImageBackend } from '../../../shared/artTypes.ts'
import type { Rgba } from '../../../shared/vfx/tex/image.ts'
import { normalizePolicy, TEXTURE_POLICY_SETTING, DEFAULT_TEXTURE_POLICY } from '../../../shared/vfx/tex/reuse.ts'
import type { StudioHarvestDeps } from './textures/importer.ts'

export interface VfxWireDeps {
  // Principle priorities (services/principles): weights for the critics, ratings feed them.
  principles?: PrincipleHooks
  // Lab gating (services/gating).
  gate?: LabGate
  userDataDir: string
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T; set?(key: string, value: unknown): void }
  emit: (event: 'vfx:changed' | 'vfx:progress' | 'vfx:textures', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: MemoryLike
  vision?: (tier?: LabTier) => VisionFn | null
  capture?: (req: CaptureRequest) => Promise<Buffer[]>
  chooseImport?: () => Promise<string[]>
  // Texture import: file / folder picker and JPEG decoding (electron), Studio sources.
  chooseTextures?: (what: 'files' | 'folder') => Promise<string[]>
  decodeImage?: (bytes: Buffer, ext: string) => Rgba | null
  studioTextures?: StudioHarvestDeps
  rojo?: { running(): boolean; start(): Promise<void> }
  chatImage?: (absPath: string, name: string) => Promise<string | null>
  // Custom textures: OpenAI images (Art page key, model, budget) and the Open Cloud upload.
  images?: { openAiKey(): Promise<string | null>; settings(): { model: string; quality: string; dailyCapUsd: number; backend?: ImageBackend }; spentToday(): Promise<number>; codex?: CodexImages }
  openCloud?: { key(): Promise<string | null>; creator(): { userId?: number; groupId?: number } }
  fetch?: ArtFetch
}

export interface VfxWiring {
  service: VfxService
  textures: TextureService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: VfxTool[]; write: VfxTool[] }
}

export function createVfxWiring(deps: VfxWireDeps): VfxWiring {
  const lunePath = () => deps.settings.get<string | null>('tests.lunePath', null)
  const textures = new TextureService({
    userDir: join(deps.userDataDir, 'vfx'),
    projectRoot: deps.root,
    openAiKey: deps.images?.openAiKey,
    imageSettings: deps.images?.settings,
    codexImages: deps.images?.codex,
    artSpentToday: deps.images?.spentToday,
    robloxKey: deps.openCloud?.key,
    creator: deps.openCloud?.creator,
    fetch: deps.fetch,
    memory: deps.memory,
    emit: deps.emit,
    log: deps.log,
    policy: {
      get: () => normalizePolicy(deps.settings.get<string>(TEXTURE_POLICY_SETTING, DEFAULT_TEXTURE_POLICY)),
      set: (p) => deps.settings.set?.(TEXTURE_POLICY_SETTING, p)
    },
    decodeImage: deps.decodeImage,
    vision: deps.vision ? () => deps.vision!('cheap') : undefined,
    studio: deps.studioTextures
  })
  const service = new VfxService({
    principles: deps.principles,
    gate: deps.gate,
    userDir: join(deps.userDataDir, 'vfx'),
    projectRoot: deps.root,
    lune: async () => {
      const s = await luneStatus(lunePath(), deps.root() ?? process.cwd())
      if (s.available) return { path: s.path, version: s.version }
      return { error: s.hint }
    },
    runtimeDir: () => findRuntimeDir(),
    capture: deps.capture,
    vision: deps.vision,
    memory: deps.memory,
    rojo: deps.rojo,
    emit: deps.emit,
    log: deps.log,
    textures
  })
  const scope = (s: unknown): VfxScope => (s === 'project' ? 'project' : 'user')
  const handlers: Record<string, (...args: any[]) => unknown> = {
    vfxStatus: () => service.status(),
    vfxList: () => service.list(),
    vfxGet: (id: string) => service.get(String(id ?? '')),
    vfxSearch: (q: string) => service.search(String(q ?? ''), { includeAvoid: true }),
    vfxImport: (paths: unknown, s: unknown) => service.import(Array.isArray(paths) ? paths.map(String) : [], scope(s)),
    vfxChooseImport: async () => (deps.chooseImport ? deps.chooseImport() : []),
    vfxUpdate: (id: string, patch: { name?: string; description?: string; tags?: string[]; notes?: string; effect?: VfxEffect }) => service.update(String(id ?? ''), patch ?? {}),
    vfxDelete: (id: string) => service.remove(String(id ?? '')),
    vfxRate: (id: string, r: unknown) => service.rate(String(id ?? ''), r === 'up' || r === 'down' ? r : null),
    vfxLearn: () => service.learn(),
    vfxRecipes: () => service.recipes(),
    vfxMake: async (prompt: string, opts?: VfxRefineOptions) => (await service.make(String(prompt ?? ''), opts ?? {})).entry,
    vfxRefine: async (id: string, opts?: VfxRefineOptions) => {
      void service.refine(String(id ?? ''), opts ?? {}).catch((e) => deps.log?.(`vfx: refine: ${(e as Error).message}`, 'stderr'))
    },
    vfxCancel: async (id: string) => service.cancel(String(id ?? '')),
    vfxCreate: (spec: VfxSpec, id?: string) => service.create(spec, id ? { id: String(id) } : {}),
    vfxFile: (id: string, file: string) => service.file(String(id ?? ''), String(file ?? '')),
    vfxSaveThumb: (id: string, url: string) => service.saveThumb(String(id ?? ''), String(url ?? '')),
    vfxResolveTexture: (ref: string) => service.resolveTexture(String(ref ?? '')),
    vfxTestInStudio: (id: string) => service.testInStudio(String(id ?? '')),
    vfxRunScript: (script: string, opts?: { id?: string; save?: boolean; prompt?: string }) =>
      service.runScript(String(script ?? ''), { id: opts?.id ? String(opts.id) : undefined, save: !!opts?.save, prompt: opts?.prompt ? String(opts.prompt) : undefined }),
    // The background refinement promise stays in main (not serialisable).
    vfxCompose: async (request: string, opts?: VfxRefineOptions & { refine?: boolean; reference?: string }) => {
      const { refined: _refined, ...r } = await service.compose(String(request ?? ''), { ...(opts ?? {}), wait: false })
      return r
    },
    vfxExamples: async () => service.examples(),
    vfxAddExample: (key: string) => service.addExample(String(key ?? '')),
    // Custom textures (textures/service.ts)
    vfxTexStatus: () => textures.status(),
    vfxTexList: () => textures.list(),
    vfxTexGenerate: (input: TextureGenerateInput) => textures.generate({ ...(input ?? {}), source: 'page' }),
    vfxTexPreview: async (input: Parameters<TextureService['previewProcedural']>[0]) => textures.previewProcedural(input),
    vfxTexUpdate: (id: string, patch: { name?: string; description?: string; tags?: string[] }) => textures.update(String(id ?? ''), patch ?? {}),
    vfxTexRate: (id: string, r: unknown) => textures.rate(String(id ?? ''), r === 'up' || r === 'down' ? r : null),
    vfxTexDelete: (id: string) => textures.remove(String(id ?? '')),
    vfxTexUpload: (id: string) => textures.upload(String(id ?? '')),
    vfxTexCheck: (id: string) => textures.checkModeration(String(id ?? '')),
    vfxTexFile: (id: string, which: unknown) => textures.file(String(id ?? ''), which === 'preview' ? 'preview' : 'texture'),
    vfxTexImportPick: async (what: unknown) => (deps.chooseTextures ? deps.chooseTextures(what === 'folder' ? 'folder' : 'files') : []),
    vfxTexImportScan: (paths: unknown, opts?: { vision?: boolean }) => textures.importFiles(Array.isArray(paths) ? paths.map(String).slice(0, 500) : [], { vision: !!opts?.vision }),
    vfxTexImportIds: (text: unknown, opts?: { vision?: boolean }) => textures.importIds(String(text ?? '').slice(0, 200_000), { vision: !!opts?.vision }),
    vfxTexImportStudio: (opts?: { vision?: boolean }) => textures.importStudio({ vision: !!opts?.vision }),
    vfxTexImportCommit: (input: Parameters<TextureService['importCommit']>[0]) => textures.importCommit(input),
    vfxTexSetPolicy: async (p: unknown) => textures.setPolicy(p)
  }
  let tools: { read: VfxTool[]; write: VfxTool[] } | null = null
  const withTextures = () => {
    const v = vfxTools(service, { chatImage: deps.chatImage })
    const t = textureTools(textures, { chatImage: deps.chatImage })
    return { read: [...v.read, ...t.read], write: [...v.write, ...t.write] }
  }
  return { service, textures, handlers, tools: () => (tools ??= withTextures()) }
}
