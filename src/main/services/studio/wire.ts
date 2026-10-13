// IPC handlers (StudioApi), agent tools and lab adapters for the Studio check, built from app pieces
// passed in by main/index.ts. The labs are reached lazily (the Studio wiring is created before them,
// because their render step is wrapped by wrap.*). No electron imports.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import type { AbilityCaptureRequest, AbilityService } from '../ability/service.ts'
import type { AnimCaptureRequest, AnimService } from '../anim/service.ts'
import type { CaptureRequest, VfxService } from '../vfx/service.ts'
import { keyBeats } from '../../../shared/ability/critique.ts'
import { isPlaceholder } from '../../../shared/ability/placeholder.ts'
import { beatFrameTimes } from '../../../shared/anim/critique.ts'
import type { AnimClip } from '../../../shared/anim/model.ts'
import { markStudioFrames } from '../../../shared/studio/frames.ts'
import { abilityJob, animJob, vfxJob } from '../../../shared/studio/payload.ts'
import { BRIDGE_PORT, type StudioCheckKind, type StudioCheckOptions } from '../../../shared/studio/types.ts'
import { StudioBridge } from './bridge.ts'
import { StudioService, type ImageOps, type PluginInstaller, type StudioCapturer, type StudioLab } from './service.ts'
import { studioTools, type StudioTool } from './tools.ts'

export interface StudioLabs {
  vfx?: VfxService
  anim?: AnimService
  ability?: AbilityService
}

export interface StudioWireDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'studio:bridge' | 'studio:progress' | 'vfx:changed' | 'anim:changed' | 'ability:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  labs: () => StudioLabs
  // The labs' own preview renderers (offscreen WebGL), for the side-by-side frames.
  previews: {
    vfx?: (req: CaptureRequest) => Promise<Buffer[]>
    anim?: (req: AnimCaptureRequest) => Promise<Buffer[]>
    ability?: (req: AbilityCaptureRequest) => Promise<Buffer[]>
  }
  capturer?: StudioCapturer
  image?: ImageOps
  plugin: Pick<PluginInstaller, 'dir' | 'open'> & { write?: PluginInstaller['write'] }
  rojo?: () => 'running' | 'stopped'
  chatImage?: (absPath: string, name: string) => Promise<string | null>
  port?: number
}

export interface StudioWiring {
  bridge: StudioBridge
  service: StudioService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: StudioTool[]; write: StudioTool[] }
  // The labs' capture functions, Studio-first when "critique in Studio" is on.
  wrap: {
    vfx: (fn?: (req: CaptureRequest) => Promise<Buffer[]>) => ((req: CaptureRequest) => Promise<Buffer[]>) | undefined
    anim: (fn?: (req: AnimCaptureRequest) => Promise<Buffer[]>) => ((req: AnimCaptureRequest) => Promise<Buffer[]>) | undefined
    ability: (fn?: (req: AbilityCaptureRequest) => Promise<Buffer[]>) => ((req: AbilityCaptureRequest) => Promise<Buffer[]>) | undefined
  }
  start(): Promise<void>
  dispose(): Promise<void>
}

// resources/studio (packaged: process.resourcesPath/studio via electron-builder extraResources).
export function pluginTemplateCandidates(): string[] {
  const out: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) out.push(join(resourcesPath, 'studio'))
  const here = import.meta.dirname ?? process.cwd()
  out.push(resolve(here, '..', '..', '..', '..', 'resources', 'studio'))
  out.push(resolve(here, '..', '..', 'resources', 'studio'))
  out.push(resolve(process.cwd(), 'resources', 'studio'))
  return out
}

export async function readPluginTemplate(candidates = pluginTemplateCandidates()): Promise<string | null> {
  for (const dir of candidates) {
    const f = join(dir, 'ForgeBridge.luau')
    if (existsSync(f)) return readFile(f, 'utf8')
  }
  return null
}

type Fx = Parameters<VfxService['exportTextures']>[0]
// Studio cannot load forgetex:// textures: swap them the way a project export does (uploaded
// rbxassetid://, else a built-in fallback).
async function studioFx(deps: StudioWireDeps, fx: Fx): Promise<Fx> {
  const v = deps.labs().vfx
  return v ? v.exportTextures(fx).catch(() => fx) : fx
}
async function studioFxAll(deps: StudioWireDeps, effects: Record<string, Fx>): Promise<Record<string, Fx>> {
  return Object.fromEntries(await Promise.all(Object.entries(effects).map(async ([k, fx]) => [k, await studioFx(deps, fx)] as const)))
}

const changed = (deps: StudioWireDeps, event: 'vfx:changed' | 'anim:changed' | 'ability:changed') => deps.emit(event, { at: Date.now() })

function prepend<T extends { thumbs: string[] }>(entry: T, file: string): T {
  return { ...entry, thumbs: [file, ...entry.thumbs.filter((t) => t !== file && !t.startsWith('studio/'))].slice(0, 6) }
}

function vfxLab(deps: StudioWireDeps): StudioLab {
  const lab = () => {
    const s = deps.labs().vfx
    if (!s) throw new Error('the VFX Lab is not available')
    return s
  }
  const hit = async (id: string) => {
    const h = await lab().find(id)
    if (!h) throw new Error(`no VFX entry "${id}"`)
    return h
  }
  return {
    prepare: async (id, jobId) => {
      const e = await lab().get(id)
      if (!e.effect) throw new Error(`"${e.name}" is a media reference; there is nothing to play in Studio`)
      return { name: e.name, job: vfxJob(await studioFx(deps, e.effect), { id: jobId }), stages: e.effect.stages }
    },
    writeFile: async (id, file, bytes) => (await hit(id)).store.writeFile(id, file, bytes),
    readFile: async (id, file) => (await hit(id)).store.readFile(id, file).catch(() => null),
    preview: deps.previews.vfx
      ? async (id, times, size) => {
          const e = await lab().get(id)
          return deps.previews.vfx!({ effect: e.effect!, times, ...size, background: 'dark' })
        }
      : undefined,
    critique: async (id, studio, times, preview) => {
      const e = await lab().get(id)
      const frames = markStudioFrames([...studio, ...preview], { studio: studio.length, preview: preview.length })
      const c = await lab().critique(e, e.effect!, frames, times, (e.iterations?.length ?? 0) + 1, null)
      return { overall: c.overall, summary: c.summary }
    },
    setThumb: async (id, file) => {
      const h = await hit(id)
      await h.store.save(prepend(h.entry, file))
      changed(deps, 'vfx:changed')
    }
  }
}

function animLab(deps: StudioWireDeps): StudioLab {
  const lab = () => {
    const s = deps.labs().anim
    if (!s) throw new Error('the Animation Lab is not available')
    return s
  }
  const hit = async (id: string) => {
    const h = await lab().find(id)
    if (!h) throw new Error(`no animation "${id}"`)
    return h
  }
  return {
    prepare: async (id, jobId) => {
      const e = await lab().get(id)
      return { name: e.name, job: animJob(e.clip, { id: jobId, times: beatFrameTimes(e.clip, 6) }) }
    },
    writeFile: async (id, file, bytes) => (await hit(id)).store.writeFile(id, file, bytes),
    readFile: async (id, file) => (await hit(id)).store.readFile(id, file).catch(() => null),
    preview: deps.previews.anim
      ? async (id, times, size) => {
          const e = await lab().get(id)
          return deps.previews.anim!({ clip: e.clip, times, ...size })
        }
      : undefined,
    critique: async (id, studio, times, preview) => {
      const e = await lab().get(id)
      const frames = markStudioFrames([...studio, ...preview], { studio: studio.length, preview: preview.length })
      const c = await lab().critique(e, e.clip, frames, times, (e.iterations?.length ?? 0) + 1, null)
      return { overall: c.overall, summary: c.summary }
    },
    setThumb: async (id, file) => {
      const h = await hit(id)
      await h.store.save(prepend(h.entry, file))
      changed(deps, 'anim:changed')
    }
  }
}

async function abilityClip(deps: StudioWireDeps, clipId: string | undefined): Promise<AnimClip | null> {
  if (!clipId || isPlaceholder(clipId)) return null
  const hit = await deps.labs().anim?.find(clipId).catch(() => null)
  return hit?.entry.clip ?? null
}

function abilityLab(deps: StudioWireDeps): StudioLab {
  const lab = () => {
    const s = deps.labs().ability
    if (!s) throw new Error('the Ability Composer is not available')
    return s
  }
  const hit = async (id: string) => {
    const h = await lab().find(id)
    if (!h) throw new Error(`no ability "${id}"`)
    return h
  }
  return {
    prepare: async (id, jobId) => {
      const e = await lab().get(id)
      const { effects } = await lab().context(e.ability)
      const clip = await abilityClip(deps, e.ability.animation?.clip)
      return { name: e.name, job: abilityJob(e.ability, await studioFxAll(deps, effects), clip, { id: jobId, times: keyBeats(e.ability) }) }
    },
    writeFile: async (id, file, bytes) => (await hit(id)).store.writeFile(id, file, bytes),
    readFile: async (id, file) => (await hit(id)).store.readFile(id, file).catch(() => null),
    preview: deps.previews.ability
      ? async (id, times, size) => {
          const e = await lab().get(id)
          const { effects } = await lab().context(e.ability)
          return deps.previews.ability!({ ability: e.ability, effects, times, ...size })
        }
      : undefined,
    critique: async (id, studio, _times, preview) => {
      const frames = markStudioFrames([...studio, ...preview], { studio: studio.length, preview: preview.length })
      const r = await lab().critique(id, { vision: true, frames })
      return { overall: r.critique.overall, summary: r.critique.summary }
    },
    setThumb: async (id, file) => {
      const h = await hit(id)
      await h.store.save(prepend(h.entry, file))
      changed(deps, 'ability:changed')
    }
  }
}

export function createStudioWiring(deps: StudioWireDeps): StudioWiring {
  let service: StudioService | null = null
  const bridge = new StudioBridge({ port: deps.port ?? BRIDGE_PORT, log: deps.log, onChange: () => service?.bridgeChanged() })
  service = new StudioService({
    bridge,
    capturer: deps.capturer,
    image: deps.image,
    labs: { vfx: vfxLab(deps), anim: animLab(deps), ability: abilityLab(deps) },
    settings: deps.settings,
    plugin: {
      dir: deps.plugin.dir,
      open: deps.plugin.open,
      template: () => readPluginTemplate(),
      read: (p) => readFile(p, 'utf8').catch(() => null),
      write: deps.plugin.write ?? (async (p, text) => {
        const { mkdir, writeFile } = await import('node:fs/promises')
        await mkdir(resolve(p, '..'), { recursive: true })
        await writeFile(p, text, 'utf8')
      })
    },
    rojo: deps.rojo,
    emit: (event, payload) => deps.emit(event, payload),
    log: deps.log
  })
  const svc = service
  const kind = (k: unknown): StudioCheckKind => (k === 'anim' || k === 'ability' ? k : 'vfx')
  const handlers: Record<string, (...args: any[]) => unknown> = {
    studioStatus: () => svc.status(),
    studioInstallPlugin: () => svc.installPlugin(),
    studioOpenPluginsFolder: () => svc.openPluginsFolder(),
    studioSetPrefer: (on: unknown) => svc.setPrefer(on === true),
    studioCheck: (k: unknown, id: unknown, opts?: StudioCheckOptions) => svc.check(kind(k), String(id ?? ''), { critique: !!opts?.critique, preview: opts?.preview !== false }),
    studioLastCheck: (k: unknown, id: unknown) => svc.lastCheck(kind(k), String(id ?? '')),
    studioFile: (k: unknown, id: unknown, file: unknown) => svc.file(kind(k), String(id ?? ''), String(file ?? ''))
  }
  const labelFor = (beats: { t: number; label: string }[], t: number, i: number) => beats.find((b) => Math.abs(b.t - t) < 1e-3)?.label ?? `t${i + 1}`
  let tools: { read: StudioTool[]; write: StudioTool[] } | null = null
  return {
    bridge,
    service: svc,
    handlers,
    tools: () => (tools ??= studioTools(svc, { chatImage: deps.chatImage })),
    wrap: {
      vfx: (fn) => svc.wrapCapture('vfx', fn, async (req, id) => vfxJob(await studioFx(deps, req.effect), { id, times: req.times })),
      anim: (fn) => svc.wrapCapture('anim', fn, (req, id) => animJob(req.clip, { id, times: req.times })),
      ability: (fn) =>
        svc.wrapCapture('ability', fn, async (req, id) => {
          const beats = keyBeats(req.ability)
          const clip = await abilityClip(deps, req.ability.animation?.clip)
          return abilityJob(req.ability, await studioFxAll(deps, req.effects), clip, { id, times: req.times.map((t, i) => ({ t, label: labelFor(beats, t, i) })) })
        })
    },
    start: () => bridge.start(),
    dispose: () => bridge.stop()
  }
}
