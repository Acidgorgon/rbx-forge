// IPC handlers (GatingApi) for lab gating, and the wrappers main/index.ts puts around the labs'
// handlers: each compose / refine / critique runs as one cost-accounted lab run, and rating a result
// up, saving or exporting it marks the run kept. No electron imports.

import { join } from 'node:path'
import { GATING_SETTING, normalizeGatingSettings, type GatingSettings, type LabId } from '../../../shared/gating/types.ts'
import { GatingService } from './service.ts'
import { batchOf } from '../../../shared/thumbs/size.ts'

export interface GatingWireDeps {
  userDataDir: string
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'labs:gating', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
}

export interface GatingWiring {
  service: GatingService
  handlers: Record<string, (...args: any[]) => unknown>
  // Wraps a lab's IPC handlers in place (see LAB_HANDLERS).
  wrap(lab: LabId, handlers: Record<string, (...args: any[]) => unknown>): Record<string, (...args: any[]) => unknown>
}

type Handler = (...args: any[]) => unknown

// Per lab: handlers that start model work (run = the entry id argument index, or 'result' when the
// entry comes back from the call), and handlers that mean "kept".
export const LAB_HANDLERS: Record<LabId, { runs: Record<string, number | 'result'>; kept: Record<string, (args: unknown[]) => { id: string; kept: boolean } | null> }> = {
  vfx: {
    runs: { vfxCompose: 'result', vfxMake: 'result', vfxRefine: 0 },
    kept: {
      vfxRate: (a) => (a[1] === 'up' ? { id: String(a[0]), kept: true } : a[1] === 'down' ? { id: String(a[0]), kept: false } : null),
      vfxTestInStudio: (a) => ({ id: String(a[0]), kept: true })
    }
  },
  anim: {
    runs: { animCompose: 'result', animRemix: 'result', animRefine: 0 },
    kept: {
      animRate: (a) => (a[1] === 'up' ? { id: String(a[0]), kept: true } : a[1] === 'down' ? { id: String(a[0]), kept: false } : null),
      animExport: (a) => ({ id: String(a[0]), kept: true }),
      animUpload: (a) => ({ id: String(a[0]), kept: true })
    }
  },
  ability: {
    runs: { abilityCompose: 'result', abilityCritique: 0 },
    kept: {
      abilityRate: (a) => (a[1] === 'up' ? { id: String(a[0]), kept: true } : a[1] === 'down' ? { id: String(a[0]), kept: false } : null),
      abilityExport: (a) => ({ id: String(a[0]), kept: true })
    }
  },
  // Thumbnail Lab: one run per batch of variations (refine rounds charge the same batch).
  thumbs: {
    runs: { thumbGenerate: 'result', thumbRefine: 'result', thumbCritique: 'result', thumbUiGenerate: 'result', thumbUiCritique: 'result' },
    kept: {
      thumbRate: (a) => (a[1] === 'up' ? { id: batchOf(String(a[0])), kept: true } : a[1] === 'down' ? { id: batchOf(String(a[0])), kept: false } : null),
      thumbShip: (a) => (a[1] === true ? { id: batchOf(String(a[0])), kept: true } : null),
      thumbUpload: (a) => ({ id: batchOf(String(a[0])), kept: true }),
      // UI art: batches are "ua-..." and assets "<batch>-<k>" (same shape as thumbnails).
      thumbUiRate: (a) => (a[1] === 'up' ? { id: batchOf(String(a[0])), kept: true } : a[1] === 'down' ? { id: batchOf(String(a[0])), kept: false } : null),
      thumbUiKeep: (a) => (a[1] === true ? { id: batchOf(String(a[0])), kept: true } : null),
      thumbUiExport: (a) => ({ id: batchOf(String(a[0])), kept: true }),
      thumbUiUpload: (a) => ({ id: batchOf(String(a[0])), kept: true })
    }
  },
  uimotion: {
    runs: { uiMotionCompose: 'result', uiMotionCritique: 0 },
    kept: {
      uiMotionRate: (a) => (a[1] === 'up' ? { id: String(a[0]), kept: true } : a[1] === 'down' ? { id: String(a[0]), kept: false } : null),
      uiMotionExport: (a) => ({ id: String(a[0]), kept: true })
    }
  },
  // Model Lab: Generate (AI script + critic rounds) and one-round Critique; built in Studio = kept.
  model: {
    runs: { modelGenerate: 'result', modelCritique: 0 },
    kept: {
      modelBuildInStudio: (a) => ({ id: String(a[0]), kept: true })
    }
  }
}

// The entry id in a handler's result ({ entry: { id } } or { id }).
export function resultEntryId(r: unknown): string | null {
  const o = r as { entry?: { id?: unknown }; id?: unknown } | null
  const id = o?.entry?.id ?? o?.id
  return typeof id === 'string' && id ? id : null
}

export function createGatingWiring(deps: GatingWireDeps): GatingWiring {
  const settings = (): GatingSettings => normalizeGatingSettings(deps.settings.get(GATING_SETTING, {}))
  const service = new GatingService({ dir: join(deps.userDataDir, 'labs-gating'), settings, emit: deps.emit, log: deps.log })
  const handlers: Record<string, Handler> = {
    labGatingView: (filter?: { lab?: LabId; entryId?: string; limit?: number }) => service.view(filter ?? {}),
    labGatingSet: async (patch: Partial<GatingSettings>) => {
      const next = normalizeGatingSettings({ ...settings(), ...(patch ?? {}) })
      deps.settings.set(GATING_SETTING, next)
      deps.emit('labs:gating', { at: Date.now() })
      return next
    },
    labGatingRetrain: async () => {
      await service.retrain()
      return service.view()
    },
    labGatingReset: async () => {
      await service.reset()
      return service.view()
    }
  }
  const wrap = (lab: LabId, hs: Record<string, Handler>) => {
    const spec = LAB_HANDLERS[lab]
    for (const [name, at] of Object.entries(spec.runs)) {
      const orig = hs[name]
      if (!orig) continue
      hs[name] = (...args: unknown[]) =>
        service.withRun(lab, at === 'result' ? undefined : String(args[at] ?? ''), async () => {
          const r = await orig(...args)
          const id = at === 'result' ? resultEntryId(r) : null
          if (id) service.attach(id)
          return r
        })
    }
    for (const [name, pick] of Object.entries(spec.kept)) {
      const orig = hs[name]
      if (!orig) continue
      hs[name] = async (...args: unknown[]) => {
        const r = await orig(...args)
        const k = pick(args)
        if (k) await service.kept(lab, k.id, k.kept).catch(() => undefined)
        return r
      }
    }
    return hs
  }
  return { service, handlers, wrap }
}
