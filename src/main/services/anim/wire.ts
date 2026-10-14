// IPC handlers (AnimApi) and agent tools for the Animation Lab, built from app pieces passed in by
// main/index.ts. No electron imports: capture, dialogs and the models come in as functions.

import type { LabGate } from '../../../shared/gating/hooks.ts'
import type { PrincipleHooks } from '../../../shared/principles/types.ts'
import { join } from 'node:path'
import { findRuntimeDir, luneStatus } from '../tests/lune.ts'
import type { AnimClip, AnimEntry, AnimRefineOptions, AnimScope, RigType } from '../../../shared/anim/model.ts'
import type { AnimImportOptions } from '../../../shared/animTypes.ts'
import { LAB_MODELS_SETTING, normalizeLabModels, type LabModels, type LabTier } from '../../../shared/labModels.ts'
import { AnimService, type AnimCaptureRequest, type MemoryLike, type ModelFn } from './service.ts'
import { animTools, type AnimTool } from './tools.ts'

export interface AnimWireDeps {
  // Principle priorities (services/principles): weights for the critics, ratings feed them.
  principles?: PrincipleHooks
  // Lab gating (services/gating).
  gate?: LabGate
  userDataDir: string
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'anim:changed' | 'anim:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: MemoryLike
  // A one-shot model call on a Labs tier (agentIpc.vision with { tier }).
  model?: (tier: LabTier) => ModelFn | null
  openCloud?: { key(): Promise<string | null>; creator(): { userId?: number; groupId?: number } }
  capture?: (req: AnimCaptureRequest) => Promise<Buffer[]>
  chooseImport?: () => Promise<string[]>
}

export interface AnimWiring {
  service: AnimService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: AnimTool[]; write: AnimTool[] }
}

export const ANIM_RIG_SETTING = 'anim.rig'

export function createAnimWiring(deps: AnimWireDeps): AnimWiring {
  const lunePath = () => deps.settings.get<string | null>('tests.lunePath', null)
  const service = new AnimService({
    principles: deps.principles,
    gate: deps.gate,
    userDir: join(deps.userDataDir, 'anim'),
    projectRoot: deps.root,
    lune: async () => {
      const s = await luneStatus(lunePath(), deps.root() ?? process.cwd())
      if (s.available) return { path: s.path, version: s.version }
      return { error: s.hint }
    },
    runtimeDir: () => findRuntimeDir(),
    capture: deps.capture,
    model: deps.model,
    memory: deps.memory,
    openCloud: deps.openCloud,
    emit: deps.emit,
    log: deps.log,
    defaultRig: {
      get: () => (deps.settings.get<string>(ANIM_RIG_SETTING, 'R15') === 'R6' ? 'R6' : 'R15'),
      set: (rig) => deps.settings.set(ANIM_RIG_SETTING, rig)
    }
  })
  const rigOf = (r: unknown): RigType | undefined => (r === 'R6' || r === 'R15' ? r : undefined)
  const scope = (s: unknown): AnimScope => (s === 'project' ? 'project' : 'user')
  const id = (x: unknown) => String(x ?? '')
  const handlers: Record<string, (...args: any[]) => unknown> = {
    animStatus: () => service.status(),
    animList: () => service.list(),
    animGet: (x: string) => service.get(id(x)),
    animImport: (paths: unknown, s: unknown, opts?: AnimImportOptions) => service.import(Array.isArray(paths) ? paths.map(String) : [], scope(s), opts ?? {}),
    animPreviewImport: (paths: unknown) => service.previewImport(Array.isArray(paths) ? paths.map(String) : []),
    animChooseImport: async () => (deps.chooseImport ? deps.chooseImport() : []),
    animUpdate: (x: string, patch: { name?: string; description?: string; tags?: string[]; notes?: string; quality?: AnimEntry['quality'] | null; reference?: string | null; clip?: AnimClip }) => service.update(id(x), patch ?? {}),
    animDelete: (x: string) => service.remove(id(x)),
    animRate: (x: string, r: unknown) => service.rate(id(x), r === 'up' || r === 'down' ? r : null),
    animLearn: () => service.learn(),
    animStyle: () => service.style(),
    animCoverage: () => service.coverage(),
    animMoveSets: () => service.moveSets(),
    animSetMoveSet: (x: unknown) => service.setMoveSet(String(x ?? '')),
    animAddMoveTag: (tag: unknown) => service.addMoveTag(tag as never),
    animRemoveMoveTag: (tag: unknown) => service.removeMoveTag(String(tag ?? '')),
    animRetag: () => service.retag(),
    // The background refinement promise stays in main (not serialisable).
    animCompose: async (request: string, opts?: AnimRefineOptions & { refine?: boolean; scope?: AnimScope; rig?: RigType; reference?: string }) => {
      const { refined: _refined, ...r } = await service.compose(String(request ?? ''), { ...(opts ?? {}), rig: rigOf(opts?.rig), wait: false })
      return r
    },
    animRunScript: (script: string, opts?: { id?: string; save?: boolean; prompt?: string; rig?: RigType }) =>
      service.runScript(String(script ?? ''), { id: opts?.id ? String(opts.id) : undefined, save: !!opts?.save, prompt: opts?.prompt ? String(opts.prompt) : undefined, rig: rigOf(opts?.rig) }),
    animGetRig: () => service.rig(),
    animSetRig: (rig: unknown) => service.setRig(rigOf(rig) ?? 'R15'),
    animConvert: (x: string, to: unknown, opts?: { copy?: boolean }) => service.convert(id(x), rigOf(to) ?? 'R15', { copy: !!opts?.copy }),
    animRefine: async (x: string, opts?: AnimRefineOptions) => {
      void service.refine(id(x), opts ?? {}).catch((e) => deps.log?.(`anim: refine: ${(e as Error).message}`, 'stderr'))
    },
    animCancel: async (x: string) => service.cancel(id(x)),
    animChecks: (x: string) => service.checks(id(x)),
    animExamples: async () => service.examples(),
    animAddExample: (key: string) => service.addExample(String(key ?? '')),
    animFile: (x: string, file: string) => service.file(id(x), String(file ?? '')),
    animSaveThumb: (x: string, url: string) => service.saveThumb(id(x), String(url ?? '')),
    animExport: (x: string) => service.export(id(x)),
    animUpload: (x: string) => service.upload(id(x)),
    listAnimClips: () => service.listAnimClips(),
    getAnimPose: (x: string, t: number) => service.getAnimPose(id(x), Number(t) || 0),
    getLabModels: async (): Promise<LabModels> => normalizeLabModels(deps.settings.get(LAB_MODELS_SETTING, {})),
    setLabModels: async (models: LabModels): Promise<LabModels> => {
      const next = normalizeLabModels(models)
      deps.settings.set(LAB_MODELS_SETTING, next)
      return next
    }
  }
  let tools: { read: AnimTool[]; write: AnimTool[] } | null = null
  return { service, handlers, tools: () => (tools ??= animTools(service)) }
}
