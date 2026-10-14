// IPC handlers (RefApi) and agent tools for video references, built from the VFX and Animation Lab
// services and app pieces passed in by main/index.ts. No electron imports.

import type { LabTier } from '../../../shared/labModels.ts'
import type { RefDecodeOptions, RefEntry, RefLab, RefSaveInput } from '../../../shared/videoref/types.ts'
import type { AnimService } from '../anim/service.ts'
import type { VfxService } from '../vfx/service.ts'
import { RefService, type DecodedRef, type ModelFn } from './service.ts'
import { refTools, type RefTool } from './tools.ts'

export interface RefWireDeps {
  vfx: VfxService
  anim: AnimService
  model?: (tier: LabTier) => ModelFn | null
  decode?: (token: string, opts: RefDecodeOptions) => Promise<DecodedRef>
  emit: (event: 'ref:progress' | 'vfx:changed' | 'anim:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  chatImage?: (absPath: string, name: string) => Promise<string | null>
}

export interface RefWiring {
  service: RefService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: RefTool[]; write: RefTool[] }
}

export function createRefWiring(deps: RefWireDeps): RefWiring {
  const service = new RefService({ vfx: deps.vfx, anim: deps.anim, model: deps.model, decode: deps.decode, emit: deps.emit, log: deps.log })
  const id = (x: unknown) => String(x ?? '')
  const handlers: Record<string, (...args: any[]) => unknown> = {
    refSave: (input: RefSaveInput) => service.save(input),
    refList: (lab?: unknown) => service.list(lab === 'vfx' || lab === 'anim' ? (lab as RefLab) : undefined),
    refGet: (x: string) => service.get(id(x)),
    refDescribe: (x: string) => service.describe(id(x)),
    refFile: (x: string, file: string) => service.file(id(x), String(file ?? '')),
    refDecodeSource: (token: string) => service.sourceForToken(String(token ?? ''))
  }
  // The contact sheet's path on disk, for showing it inline in the chat.
  const sheetPath = async (r: RefEntry) => {
    const h = await service.find(r.id)
    return h ? h.store.filePath(h.entry.id, r.video.sheet) : null
  }
  let tools: { read: RefTool[]; write: RefTool[] } | null = null
  return { service, handlers, tools: () => (tools ??= refTools(service, { chatImage: deps.chatImage, sheetPath })) }
}
