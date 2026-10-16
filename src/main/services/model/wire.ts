// IPC handlers (ModelApi) for the Model Lab, built from app pieces passed in by main/index.ts. No
// electron imports: the offscreen capture, the AI model and the Forge Bridge come in as functions.

import { join } from 'node:path'
import type { LabTier } from '../../../shared/labModels.ts'
import { MODEL_TEMPLATE_IDS, type ModelGenerateOptions, type ModelGuardLink, type ModelSettings, type ModelTemplateId } from '../../../shared/model/types.ts'
import { luneStatus } from '../tests/lune.ts'
import { ModelService, type ModelBridge, type ModelCaptureRequest, type ModelFn } from './service.ts'

export interface ModelWireDeps {
  userDataDir: string
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'model:changed' | 'model:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  model?: (tier: LabTier) => ModelFn | null
  modelReady?: () => Promise<boolean>
  capture?: (req: ModelCaptureRequest) => Promise<Buffer[]>
  bridge?: () => ModelBridge | null | undefined
}

export interface ModelWiring {
  service: ModelService
  handlers: Record<string, (...args: any[]) => unknown>
}

const str = (v: unknown, max = 200_000) => String(v ?? '').slice(0, max)
const template = (v: unknown): ModelTemplateId => (MODEL_TEMPLATE_IDS.includes(v as ModelTemplateId) ? (v as ModelTemplateId) : 'creature')

function guard(v: unknown): ModelGuardLink | null | undefined {
  if (v === null) return null
  if (!v || typeof v !== 'object') return undefined
  const g = v as Partial<ModelGuardLink>
  const path = str(g.path, 300).trim()
  return path ? { path, areaId: str(g.areaId, 80).trim() } : null
}

export function createModelWiring(deps: ModelWireDeps): ModelWiring {
  const lunePath = () => deps.settings.get<string | null>('tests.lunePath', null)
  const service = new ModelService({
    userDir: join(deps.userDataDir, 'models'),
    projectRoot: deps.root,
    lune: async () => {
      const s = await luneStatus(lunePath(), deps.root() ?? process.cwd())
      if (s.available) return { path: s.path, version: s.version }
      return { error: s.hint }
    },
    model: deps.model,
    modelReady: deps.modelReady,
    capture: deps.capture,
    bridge: deps.bridge ? () => deps.bridge!() ?? null : undefined,
    settings: deps.settings,
    emit: deps.emit,
    log: deps.log
  })
  const handlers: Record<string, (...args: any[]) => unknown> = {
    modelStatus: () => service.status(),
    modelList: () => service.list(),
    modelLoad: (id: unknown) => service.load(str(id, 200)),
    modelRun: (script: unknown, opts?: { name?: unknown }) => service.run(str(script), { name: opts?.name ? str(opts.name, 80) : undefined }),
    modelGenerate: (prompt: unknown, opts?: Partial<ModelGenerateOptions>) =>
      service.generate(str(prompt, 2000), {
        ...(opts?.template ? { template: template(opts.template) } : {}),
        ...(Array.isArray(opts?.refs) ? { refs: opts!.refs.slice(0, 4).map((r) => str(r, 12_000_000)) } : {}),
        ...(opts?.id ? { id: str(opts.id, 200) } : {}),
        ...(opts?.name ? { name: str(opts.name, 80) } : {}),
        ...(typeof opts?.critic === 'boolean' ? { critic: opts.critic } : {}),
        ...(opts?.rounds !== undefined && Number.isFinite(Number(opts.rounds)) ? { rounds: Number(opts.rounds) } : {}),
        ...(opts?.run ? { run: str(opts.run, 80) } : {})
      }),
    modelFromTemplate: (t: unknown, opts?: { name?: unknown; prompt?: unknown }) => service.fromTemplate(template(t), { name: opts?.name ? str(opts.name, 80) : undefined, prompt: opts?.prompt ? str(opts.prompt, 2000) : undefined }),
    modelSave: (id: unknown, patch?: { script?: unknown; name?: unknown; prompt?: unknown; template?: unknown; guard?: unknown }) =>
      service.save(str(id, 200), {
        ...(typeof patch?.script === 'string' ? { script: str(patch.script) } : {}),
        ...(typeof patch?.name === 'string' ? { name: str(patch.name, 80) } : {}),
        ...(typeof patch?.prompt === 'string' ? { prompt: str(patch.prompt, 2000) } : {}),
        ...(patch?.template ? { template: template(patch.template) } : {}),
        ...(patch && 'guard' in patch ? { guard: guard(patch.guard) } : {})
      }),
    modelRename: (id: unknown, name: unknown) => service.rename(str(id, 200), str(name, 80)),
    modelDelete: (id: unknown) => service.remove(str(id, 200)),
    modelCritique: (id: unknown, opts?: { run?: unknown }) => service.critique(str(id, 200), { run: opts?.run ? str(opts.run, 80) : undefined }),
    modelSetSettings: (patch?: Partial<ModelSettings>) => service.setSettings(patch && typeof patch === 'object' ? patch : {}),
    modelFile: (id: unknown, file: unknown) => service.file(str(id, 200), str(file, 300)),
    modelSaveThumb: (id: unknown, url: unknown) => service.saveThumb(str(id, 200), str(url, 12_000_000)),
    modelBuildInStudio: (id: unknown, opts?: { guard?: unknown }) => service.buildInStudio(str(id, 200), opts && 'guard' in opts ? { guard: guard(opts.guard) } : {})
  }
  return { service, handlers }
}
