// IPC handlers (VfxApi) and agent tools for the VFX Lab, built from app pieces passed in by
// main/index.ts. No electron imports: capture, dialogs and the vision model come in as functions.

import type { LabTier } from '../../../shared/labModels.ts'
import { join } from 'node:path'
import { findRuntimeDir, luneStatus } from '../tests/lune.ts'
import type { VfxEffect, VfxRefineOptions, VfxScope } from '../../../shared/vfx/types.ts'
import type { VfxSpec } from '../../../shared/vfx/spec.ts'
import { VfxService, type CaptureRequest, type MemoryLike, type VisionFn } from './service.ts'
import { vfxTools, type VfxTool } from './tools.ts'

export interface VfxWireDeps {
  userDataDir: string
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T }
  emit: (event: 'vfx:changed' | 'vfx:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: MemoryLike
  vision?: (tier?: LabTier) => VisionFn | null
  capture?: (req: CaptureRequest) => Promise<Buffer[]>
  chooseImport?: () => Promise<string[]>
  rojo?: { running(): boolean; start(): Promise<void> }
  chatImage?: (absPath: string, name: string) => Promise<string | null>
}

export interface VfxWiring {
  service: VfxService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: VfxTool[]; write: VfxTool[] }
}

export function createVfxWiring(deps: VfxWireDeps): VfxWiring {
  const lunePath = () => deps.settings.get<string | null>('tests.lunePath', null)
  const service = new VfxService({
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
    log: deps.log
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
    vfxAddExample: (key: string) => service.addExample(String(key ?? ''))
  }
  let tools: { read: VfxTool[]; write: VfxTool[] } | null = null
  return { service, handlers, tools: () => (tools ??= vfxTools(service, { chatImage: deps.chatImage })) }
}
