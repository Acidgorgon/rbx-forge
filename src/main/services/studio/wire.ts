// IPC handlers (StudioApi) and agent tools for the Studio Bridge (plugin installation, Studio
// targets, Build in Studio, Inbox inserts, Delete in Studio, and Forge Sync). No electron imports.

import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { existsSync } from 'node:fs'
import { BRIDGE_PORT, type StudioCheckKind, type StudioCheckOptions } from '../../../shared/studio/types.ts'
import { BUNDLED_TEMPLATE_DIR, PLUGIN_TEMPLATE_FILE, PLUGIN_VERSION, pluginTemplateVersion } from '../../../shared/studio/plugin.ts'
import { cleanTarget, resolveTarget, STUDIO_TARGETS_SETTING, targetKey, type StudioPlace, type StudioPlaces, type StudioTarget } from '../../../shared/studio/target.ts'
import { StudioBridge, type StudioInfo } from './bridge.ts'
import { StudioService, type ImageOps, type PluginInstaller, type StudioCapturer } from './service.ts'
import { studioTools, type StudioTool } from './tools.ts'

export interface StudioWireDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'studio:bridge' | 'studio:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  capturer?: StudioCapturer
  image?: ImageOps
  plugin: Pick<PluginInstaller, 'dir' | 'open'> & { write?: PluginInstaller['write'] }
  rojo?: () => 'running' | 'stopped'
  port?: number
  // The open project (the Studio target is kept per project root) and the PlaceIds linked to its
  // active place (servePlaceIds): with several places open, jobs default to the linked one.
  projectRoot?: () => string | null
  linkedPlaceIds?: () => number[]
}

export interface StudioWiring {
  bridge: StudioBridge
  service: StudioService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => { read: StudioTool[]; write: StudioTool[] }
  start(): Promise<void>
  dispose(): Promise<void>
}

export function pluginTemplateCandidates(here: string = import.meta.dirname ?? process.cwd(), resourcesPath: string | undefined = (process as { resourcesPath?: string }).resourcesPath): string[] {
  const out: string[] = [join(here, BUNDLED_TEMPLATE_DIR)]
  if (resourcesPath) out.push(join(resourcesPath, 'studio'))
  out.push(resolve(here, '..', '..', '..', '..', 'resources', 'studio'))
  out.push(resolve(here, '..', '..', 'resources', 'studio'))
  out.push(resolve(process.cwd(), 'resources', 'studio'))
  return out
}

export async function readPluginTemplate(candidates = pluginTemplateCandidates()): Promise<string | null> {
  let best: { text: string; version: number } | null = null
  for (const dir of candidates) {
    const f = join(dir, PLUGIN_TEMPLATE_FILE)
    if (!existsSync(f)) continue
    const text = await readFile(f, 'utf8').catch(() => null)
    if (text === null) continue
    const version = pluginTemplateVersion(text)
    if (version >= PLUGIN_VERSION) return text
    if (!best || version > best.version) best = { text, version }
  }
  return best?.text ?? null
}

function studioPlace(info: StudioInfo, linkedIds: number[]): StudioPlace {
  return {
    key: targetKey(info),
    ...(info.placeId ? { placeId: info.placeId } : {}),
    ...(info.place ? { place: info.place } : {}),
    ...(info.pluginVersion ? { pluginVersion: info.pluginVersion } : {}),
    lastSeen: info.lastSeen,
    since: info.since,
    ...(info.placeId && linkedIds.includes(info.placeId) ? { linked: true } : {})
  }
}

export function studioTargets(deps: Pick<StudioWireDeps, 'settings' | 'projectRoot' | 'linkedPlaceIds'>, studios: () => StudioInfo[]) {
  const all = () => deps.settings.get<Record<string, unknown>>(STUDIO_TARGETS_SETTING, {}) ?? {}
  const root = () => deps.projectRoot?.() ?? ''
  const chosen = (): StudioTarget | null => cleanTarget(all()[root()])
  const view = (): StudioPlaces => {
    const linked = deps.linkedPlaceIds?.() ?? []
    const places = studios()
      .map((s) => studioPlace(s, linked))
      .sort((a, b) => a.since - b.since || a.key.localeCompare(b.key))
    const c = chosen()
    const r = resolveTarget(places, c, linked)
    return { places, chosen: c, target: r.target?.key ?? null, why: r.why }
  }
  return {
    chosen,
    view,
    target: (): StudioTarget | null => {
      const v = view()
      const hit = v.places.find((p) => p.key === v.target)
      return hit ? { ...(hit.placeId ? { placeId: hit.placeId } : {}), ...(hit.place ? { place: hit.place } : {}) } : null
    },
    set: (t: unknown): void => {
      const next = { ...all() }
      const clean = cleanTarget(t)
      if (clean) next[root()] = clean
      else delete next[root()]
      deps.settings.set(STUDIO_TARGETS_SETTING, next)
    }
  }
}

export function createStudioWiring(deps: StudioWireDeps): StudioWiring {
  let service: StudioService | null = null
  const bridge = new StudioBridge({ port: deps.port ?? BRIDGE_PORT, log: deps.log, onChange: () => service?.bridgeChanged() })
  const targets = studioTargets(deps, () => bridge.studios())
  bridge.setDefaultTarget(targets.target)
  service = new StudioService({
    bridge,
    capturer: deps.capturer,
    image: deps.image,
    labs: {},
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
    studioFile: (k: unknown, id: unknown, file: unknown) => svc.file(kind(k), String(id ?? ''), String(file ?? '')),
    studioPlaces: () => targets.view(),
    studioSetTarget: (t: unknown) => {
      targets.set(t)
      bridge.retarget()
      svc.bridgeChanged()
      return targets.view()
    }
  }
  let tools: { read: StudioTool[]; write: StudioTool[] } | null = null
  return {
    bridge,
    service: svc,
    handlers,
    tools: () => (tools ??= studioTools(svc)),
    start: () => bridge.start(),
    dispose: () => bridge.stop()
  }
}
