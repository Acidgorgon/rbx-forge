// IPC handlers (AbilityApi) and agent tools for the Ability Composer, built from app pieces passed in
// by main/index.ts. No electron imports: capture, dialogs and the model come in as functions.

import { join } from 'node:path'
import type { Ability, AbilityScope } from '../../../shared/ability/types.ts'
import type { AnimClipRef } from '../../../shared/anim/types.ts'
import { AbilityService, type AbilityCaptureRequest, type LabTier, type MemoryLike, type ModelFn, type RegistryTool, type VfxLabLike } from './service.ts'
import { abilityTools, type AbilityTool } from './tools.ts'

export interface AbilityWireDeps {
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
    abilityGet: (id: string) => service.get(String(id ?? '')),
    abilitySave: (ability: Ability, opts?: { id?: string; origin?: string; scope?: AbilityScope }) => service.save(ability, { id: opts?.id ? String(opts.id) : undefined, origin: opts?.origin ? String(opts.origin) : undefined, scope: scope(opts?.scope) }),
    abilityDelete: (id: string) => service.remove(String(id ?? '')),
    abilityRate: (id: string, r: unknown) => service.rate(String(id ?? ''), r === 'up' || r === 'down' ? r : null),
    abilityCompose: (request: string) => service.compose(String(request ?? '')),
    abilityCritique: (id: string, opts?: { vision?: boolean; apply?: boolean }) => service.critique(String(id ?? ''), { vision: opts?.vision, apply: !!opts?.apply }),
    abilityExport: (id: string) => service.export(String(id ?? '')),
    abilityExamples: async () => service.examples(),
    abilityAddExample: (key: string) => service.addExample(String(key ?? '')),
    abilityFile: (id: string, file: string) => service.file(String(id ?? ''), String(file ?? '')),
    abilitySaveThumb: (id: string, url: string) => service.saveThumb(String(id ?? ''), String(url ?? '')),
    abilityChooseSounds: async () => (deps.chooseSounds ? deps.chooseSounds() : []),
    abilitySoundUrl: (path: string) => service.soundUrl(String(path ?? ''))
  }
  let tools: { read: AbilityTool[]; write: AbilityTool[] } | null = null
  return { service, handlers, tools: () => (tools ??= abilityTools(service)) }
}
