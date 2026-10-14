// IPC handlers (UiMotionApi) for the UI Motion Lab, built from app pieces passed in by
// main/index.ts. No electron imports: the window snapshot and the secret store come in as functions.

import { join } from 'node:path'
import type { LabGate } from '../../../shared/gating/hooks.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import type { PrincipleHooks } from '../../../shared/principles/types.ts'
import type { Restatement } from '../../../shared/restate/types.ts'
import type { LabSubject } from '../../../shared/uimotion/compile.ts'
import type { FetchLike } from '../../../shared/uimotion/figma/rest.ts'
import type { MotionSpec } from '../../../shared/uimotion/spec.ts'
import type { UiMotionScope } from '../../../shared/uiMotionTypes.ts'
import { UiMotionService, type MemoryLike, type ModelFn, type SecretsLike } from './service.ts'

export interface UiMotionWireDeps {
  userDataDir: string
  root: () => string | null
  projectFile?: () => string | null
  emit: (event: 'uimotion:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: MemoryLike
  model?: (tier: LabTier) => ModelFn | null
  principles?: PrincipleHooks
  gate?: LabGate
  secrets?: SecretsLike
  canStoreSecrets?: () => boolean
  fetch?: FetchLike
  lune?: () => Promise<boolean>
  // A PNG data URL of a rectangle of the Forge window (electron.ts).
  snap?: (rect: { x: number; y: number; width: number; height: number }) => Promise<string | null>
}

export interface UiMotionWiring {
  service: UiMotionService
  handlers: Record<string, (...args: any[]) => unknown>
}

const scope = (s: unknown): UiMotionScope | undefined => (s === 'project' || s === 'user' ? s : undefined)
const str = (v: unknown) => String(v ?? '')

export function createUiMotionWiring(deps: UiMotionWireDeps): UiMotionWiring {
  const service = new UiMotionService({
    userDir: join(deps.userDataDir, 'uimotion'),
    projectRoot: deps.root,
    projectFile: deps.projectFile,
    model: deps.model,
    memory: deps.memory,
    principles: deps.principles,
    gate: deps.gate,
    secrets: deps.secrets,
    canStoreSecrets: deps.canStoreSecrets,
    fetch: deps.fetch,
    lune: deps.lune,
    emit: deps.emit,
    log: deps.log
  })
  const handlers: Record<string, (...args: any[]) => unknown> = {
    uiMotionStatus: () => service.status(),
    uiMotionList: () => service.list(),
    uiMotionGet: (id: string) => service.get(str(id)),
    uiMotionSave: (spec: MotionSpec, o?: { id?: string; origin?: string; scope?: UiMotionScope; component?: string; name?: string }) =>
      service.save(spec, { id: o?.id ? str(o.id) : undefined, origin: o?.origin ? str(o.origin) : undefined, scope: scope(o?.scope), component: o?.component ? str(o.component) : undefined, name: o?.name ? str(o.name) : undefined }),
    uiMotionDelete: (id: string) => service.remove(str(id)),
    uiMotionRate: (id: string, r: unknown) => service.rate(str(id), r === 'up' || r === 'down' ? r : null),
    uiMotionComponents: () => service.components(),
    uiMotionImportFigmaDoc: (json: string, o?: { name?: string }) => service.importFigmaDoc(str(json), { name: o?.name ? str(o.name) : undefined }),
    uiMotionImportFigmaUrl: (url: string, o?: { name?: string }) => service.importFigmaUrl(str(url), { name: o?.name ? str(o.name) : undefined }),
    uiMotionFigmaToken: () => service.tokenStatus(),
    uiMotionSetFigmaToken: (token: string) => service.setToken(str(token)),
    uiMotionClearFigmaToken: () => service.clearToken(),
    uiMotionTestFigmaToken: () => service.testToken(),
    uiMotionLabStory: (subject: LabSubject) => service.labStory(subject),
    uiMotionCompose: (brief: string, o?: { restatement?: Restatement; component?: string; current?: MotionSpec }) => service.compose(str(brief), { restatement: o?.restatement, component: o?.component ? str(o.component) : undefined, current: o?.current }),
    uiMotionCritique: (id: string, o?: { frames?: string[]; labels?: string[]; apply?: boolean }) =>
      service.critique(str(id), { frames: Array.isArray(o?.frames) ? o!.frames.map(str) : [], labels: Array.isArray(o?.labels) ? o!.labels.map(str) : [], apply: !!o?.apply }),
    uiMotionExport: (id: string, o?: { component?: string }) => service.export(str(id), { component: o?.component ? str(o.component) : undefined }),
    uiMotionSnap: async (rect: { x: number; y: number; width: number; height: number }) => {
      const r = { x: Math.round(Number(rect?.x) || 0), y: Math.round(Number(rect?.y) || 0), width: Math.round(Number(rect?.width) || 0), height: Math.round(Number(rect?.height) || 0) }
      if (r.width < 4 || r.height < 4 || r.width > 4000 || r.height > 4000) return null
      return deps.snap ? deps.snap(r) : null
    },
    uiMotionFile: (id: string, file: string) => service.file(str(id), str(file))
  }
  return { service, handlers }
}
