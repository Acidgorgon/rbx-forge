// IPC handlers (AddToGameApi) and the built-in adapters for "Add to game". Other labs (UI Motion,
// Thumbnails) call `addToGame.service.registerAdapter(...)` with their own adapter.

import type { AddToGameTarget } from '../../../shared/addToGame/types.ts'
import { loadPlaces } from '../sync/mapping.ts'
import { abilityAdapter, animAdapter, vfxAdapter, type AbilityLabPort, type AnimLabPort, type TexturePort, type VfxLabPort } from './adapters.ts'
import { AddToGameService } from './service.ts'

export function createAddToGameWiring(deps: {
  root(): string | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  log?: (text: string) => void
  vfx?: VfxLabPort
  textures?: TexturePort
  anim?: AnimLabPort
  ability?: AbilityLabPort
}): { service: AddToGameService; handlers: Record<string, (...args: any[]) => unknown> } {
  const service = new AddToGameService({
    root: deps.root,
    loadPlaces,
    getSetting: (k, f) => deps.settings.get(k, f),
    setSetting: (k, v) => deps.settings.set(k, v),
    log: deps.log
  })
  if (deps.vfx) service.registerAdapter(vfxAdapter(deps.vfx, deps.textures))
  if (deps.anim) service.registerAdapter(animAdapter(deps.anim))
  if (deps.ability) service.registerAdapter(abilityAdapter(deps.ability, deps.vfx ?? null))
  const target = (t: unknown): AddToGameTarget => {
    const o = (t && typeof t === 'object' ? t : {}) as Partial<AddToGameTarget>
    return { placeFile: String(o.placeFile ?? ''), instance: Array.isArray(o.instance) ? o.instance.map(String) : [] }
  }
  const handlers: Record<string, (...args: any[]) => unknown> = {
    addToGameOptions: (lab: unknown, id: unknown) => service.options(String(lab ?? ''), String(id ?? '')),
    addToGamePreview: (lab: unknown, id: unknown, t: unknown) => service.preview(String(lab ?? ''), String(id ?? ''), target(t)),
    addToGameApply: (lab: unknown, id: unknown, t: unknown, confirmed: unknown) =>
      service.apply(String(lab ?? ''), String(id ?? ''), target(t), Array.isArray(confirmed) ? confirmed.map(String) : [])
  }
  return { service, handlers }
}
