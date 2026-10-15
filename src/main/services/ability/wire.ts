// IPC handlers (AbilityApi) and agent tools for the Ability Composer, built from app pieces passed in
// by main/index.ts. No electron imports: capture, dialogs and the model come in as functions.

import type { LabGate } from '../../../shared/gating/hooks.ts'
import type { PrincipleHooks } from '../../../shared/principles/types.ts'
import { join } from 'node:path'
import type { Ability, AbilityScope } from '../../../shared/ability/types.ts'
import type { AnimClipRef } from '../../../shared/anim/types.ts'
import { AbilityService, type AbilityCaptureRequest, type LabTier, type MemoryLike, type ModelFn, type RegistryTool, type VfxLabLike } from './service.ts'
import { abilityTools, type AbilityTool } from './tools.ts'
import type { Restatement } from '../../../shared/restate/types.ts'

export interface AbilityWireDeps {
  // Principle priorities (services/principles): weights for the critics, ratings feed them.
  principles?: PrincipleHooks
  // Lab gating (services/gating).
  gate?: LabGate
  userDataDir: string
  root: () => string | null
  emit: (event: 'ability:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: MemoryLike
  model?: (tier: LabTier) => ModelFn | null
  vfx?: VfxLabLike
  anim?: () => Promise<AnimClipRef[]>
  tools?: () => RegistryTool[]
  lune?: () => Promise<boolean>
  capture?: (req: AbilityCaptureRequest) => Promise<Buffer[]>
  chooseSounds?: () => Promise<string[]>
}

export interface AbilityWiring {
  service: AbilityService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: AbilityTool[]; write: AbilityTool[] }
}

export function createAbilityWiring(deps: AbilityWireDeps): AbilityWiring {
  const service = new AbilityService({
    principles: deps.principles,
    gate: deps.gate,
    userDir: join(deps.userDataDir, 'abilities'),
    projectRoot: deps.root,
    vfx: deps.vfx,
    anim: deps.anim,
    tools: deps.tools,
    model: deps.model,
    capture: deps.capture,
    memory: deps.memory,
    lune: deps.lune,
    emit: deps.emit,
    log: deps.log
  })
  const scope = (s: unknown): AbilityScope | undefined => (s === 'project' || s === 'user' ? s : undefined)
  const handlers: Record<string, (...args: any[]) => unknown> = {
    abilityStatus: () => service.status(),
    abilityList: () => service.list(),
    abilitySave: (ability: Ability, opts?: { id?: string; origin?: string; scope?: AbilityScope }) => service.save(ability, { id: opts?.id ? String(opts.id) : undefined, origin: opts?.origin ? String(opts.origin) : undefined, scope: scope(opts?.scope) }),
    abilityDelete: (id: string) => service.remove(String(id ?? '')),
    abilityRate: (id: string, r: unknown) => service.rate(String(id ?? ''), r === 'up' || r === 'down' ? r : null),
    // restatement is normalised by the service (Restate first).
    abilityCompose: (request: string, opts?: { restatement?: Restatement }) => service.compose(String(request ?? ''), { restatement: opts?.restatement }),
    abilityCritique: (id: string, opts?: { vision?: boolean; apply?: boolean }) => service.critique(String(id ?? ''), { vision: opts?.vision, apply: !!opts?.apply }),
    abilityExport: (id: string) => service.export(String(id ?? '')),
    abilityAddExample: (key: string) => service.addExample(String(key ?? '')),
    abilityFile: (id: string, file: string) => service.file(String(id ?? ''), String(file ?? '')),
    abilitySaveThumb: (id: string, url: string) => service.saveThumb(String(id ?? ''), String(url ?? '')),
    abilityChooseSounds: async () => (deps.chooseSounds ? deps.chooseSounds() : [])
  }
  let tools: { read: AbilityTool[]; write: AbilityTool[] } | null = null
  return { service, handlers, tools: () => (tools ??= abilityTools(service)) }
}
