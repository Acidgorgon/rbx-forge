// createSync: Forge Sync wiring for main/index.ts. One SyncService per open project, the bridge
// SyncHandler (stable across projects), IPC handlers (SyncApi), the gate hookup to the supervisor and
// the git-pull guard. The engine and place mapping are passed in (engine worker's modules) so this
// file builds before they land. No electron imports.

import type { StudioConflict } from '../../../shared/types.ts'
import type { SyncStatus, GateState } from '../../../shared/sync/types.ts'
import { SYNC_ENGINE_SETTING, SYNC_GATE_SETTING } from '../../../shared/sync/types.ts'
import type { ForgeSyncSettings, SyncCommitResult } from '../../../shared/sync/api.ts'
import type { ServiceState } from '../../../shared/types.ts'
import { findTool, run, toolEnv } from '../tools.ts'
import { deleteInStudio, deleteUnavailable, type DeleteBridge } from '../studio/deleteInstance.ts'
import { engineSetting, SyncService, type LiveStudioNode, type SyncEngineLike, type SyncHandler, type SyncMapping } from './service.ts'

export interface SyncWireDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'sync:status' | 'sync:entry' | 'studio:conflicts', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  supervisor: {
    setGate(file: string, gate: GateState, detail?: string): void
    applyGates(): void
    setSyncSummary(state: ServiceState, detail: string): void
  }
  pluginsDir: () => string | null
  studio?: () => { placeId?: number; place?: string; pluginVersion?: number; connected: boolean } | null
  // Every Studio window polling the bridge right now.
  studios?: () => { placeId?: number; place?: string }[]
  plugin?: () => Promise<{ installed: boolean; version?: number } | null>
  // The engine worker's SyncEngine and mapping.ts (loadPlaces / placeFor). Absent: Forge Sync stays
  // off for the plugin and every place serves normally.
  engine?: (root: string) => SyncEngineLike
  mapping?: SyncMapping
  git?: (root: string, args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>
  // The open project's active place file (Game tab "Save to repo" acts on that place).
  activePlace?: () => string | null
  // The live Studio tree changed shape (throttled): the Game tab re-reads liveTree().
  onStudioTree?: () => void
  // The Forge Bridge (Game tab "Delete in Studio" queues a delete job for the plugin).
  bridge?: () => DeleteBridge | null
}

export interface GitLike {
  syncNow(): Promise<{ error?: string }>
  refresh(fetch?: boolean): Promise<unknown>
}

export interface SyncWiring {
  service(): SyncService | null
  // For bridge.setSyncHandler: answers for whichever project is open.
  handler: SyncHandler
  handlers: Record<string, (...args: any[]) => unknown>
  onProjectOpen(root: string): Promise<void>
  onProjectClose(): void
  onPlacesChanged(): void
  // Forge Sync conflicts as the Studio-conflict shape the editor tabs use; null when the setting
  // is not 'forge' (the project's studio-sync.py conflicts apply then).
  studioConflicts(): StudioConflict[] | null
  resolveStudioConflict(path: string, take: 'studio' | 'repo', placeKey?: string): Promise<void>
  // Wraps GitSync so every Forge-initiated pull / branch switch checks for uncommitted Studio edits.
  guardGit<G extends GitLike>(git: G, autoCommit: () => boolean): G
  // Game tab: the live Studio tree of a place file, or null (no Studio session / Forge Sync off).
  liveTree(projectFile: string): { nodes: LiveStudioNode[]; truncated: boolean } | null
}

function defaultGit(root: string, args: string[]) {
  const git = findTool('git') || 'git'
  return run(git, args, root, { ...toolEnv(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' })
}

export function syncSummary(status: SyncStatus): { state: ServiceState; detail: string } {
  if (status.engine !== 'forge') return { state: 'stopped', detail: status.engine === 'off' ? 'off' : 'project script' }
  const live = status.places.filter((p) => p.connected)
  const blocked = status.places.filter((p) => p.gate === 'blocked')
  const checking = status.places.filter((p) => p.gate === 'checking')
  if (checking.length) return { state: 'starting', detail: `Forge Sync: checking ${checking.map((p) => p.projectFile.replace(/\.project\.json$/, '')).join(', ')}` }
  if (blocked.length) {
    const n = blocked.reduce((sum, p) => sum + p.conflicts, 0)
    return { state: 'running', detail: `Forge Sync: ${n} conflict${n === 1 ? '' : 's'} held` }
  }
  // Studio edits are not reaching disk (no plugin, place refused, mapped folders missing ...): not green.
  if (status.notice?.level === 'warn') return { state: 'starting', detail: status.notice.text }
  return { state: 'running', detail: live.length ? `Forge Sync: ${live.length} Studio session${live.length === 1 ? '' : 's'}` : 'Forge Sync: waiting for Studio' }
}

// An instance path from the renderer: 1-64 non-empty names.
function cleanPath(v: unknown): string[] {
  if (!Array.isArray(v) || v.length < 1 || v.length > 64 || !v.every((n) => typeof n === 'string' && n.length > 0 && n.length <= 256)) throw new Error('Invalid instance path')
  return v as string[]
}

export function createSync(deps: SyncWireDeps): SyncWiring {
  let current: SyncService | null = null
  const git = deps.git ?? defaultGit
  const offAnswer = { ok: false as const, error: 'No project open in Forge' }

  const emit = (event: 'sync:status' | 'sync:entry', payload: unknown) => {
    deps.emit(event, payload)
    if (event !== 'sync:status') return
    const status = payload as SyncStatus
    const summary = syncSummary(status)
    deps.supervisor.setSyncSummary(summary.state, summary.detail)
    if (status.engine === 'forge') deps.emit('studio:conflicts', wiring.studioConflicts() ?? [])
  }

  const need = (): SyncService => {
    if (!current) throw new Error('No project open')
    return current
  }

  const settings = (): ForgeSyncSettings => engineSetting(deps.settings)

  const handler: SyncHandler = {
    config: async (q) => (current ? current.handler.config(q) : { enabled: false, sessionToken: '', roots: [], skip: [], reason: 'No project open in Forge' }),
    snapshot: async (body) => (current ? current.handler.snapshot(body) : offAnswer),
    changes: async (body) => (current ? current.handler.changes(body) : offAnswer),
    outline: async (body) => (current?.handler.outline ? current.handler.outline(body) : offAnswer)
  }

  const deleteDeps = () => {
    const bridge = deps.bridge?.()
    if (!bridge) throw new Error('The Forge Bridge is not running')
    return {
      bridge,
      refusal: (path: string[]) => (current ? current.deleteRefusal(deps.activePlace?.() ?? 'default.project.json', path) : 'No project open')
    }
  }

  const emptyStatus = (): SyncStatus => ({ engine: settings().engine, places: [], recent: [], pendingStudioEdits: [] })

  const handlers: Record<string, (...args: any[]) => unknown> = {
    syncStatus: async () => (current ? current.status() : emptyStatus()),
    syncResolve: (placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string) => need().resolve(String(placeKey), String(file), take, text),
    syncResolveAll: (placeKey: string, take: 'studio' | 'disk', reason?: string) =>
      need().resolveAll(String(placeKey), take, reason === 'first-run' || reason === 'both-changed' || reason === 'deleted-vs-edited' ? reason : undefined),
    syncServeAnyway: (placeKey: string) => need().serveAnyway(String(placeKey)),
    syncLinkPlace: (id: string, projectFile?: string) => need().linkPlace(String(id), typeof projectFile === 'string' && projectFile ? projectFile : undefined),
    syncCommitStudioEdits: (message?: string): Promise<SyncCommitResult> => need().commitStudioEdits(message),
    syncDisableLegacyPlugin: () => need().disableLegacyPlugin(),
    syncSaveTarget: async (instancePath: unknown) => (current ? current.saveTarget(deps.activePlace?.() ?? 'default.project.json', cleanPath(instancePath)) : { reason: 'No project open' }),
    syncSaveToRepo: (instancePath: unknown) => need().saveToRepo(deps.activePlace?.() ?? 'default.project.json', cleanPath(instancePath)),
    // Game tab "Delete in Studio" (plugin v7) for a Studio-only instance of the active place.
    syncDeleteCheck: async (instancePath: unknown): Promise<{ ok: true } | { reason: string }> => {
      const why = await deleteUnavailable(deleteDeps(), cleanPath(instancePath)).catch((e) => (e as Error).message)
      return why ? { reason: why } : { ok: true }
    },
    syncDeleteInStudio: async (instancePath: unknown, className?: unknown) => {
      const path = cleanPath(instancePath)
      await deleteInStudio(deleteDeps(), path, typeof className === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(className) ? className : undefined)
      deps.log?.(`sync: deleted ${path.join('.')} in Studio (Ctrl+Z in Studio restores it)`)
    },
    forgeSyncSettings: () => settings(),
    setForgeSyncSettings: async (patch: Partial<ForgeSyncSettings>) => {
      if (patch.engine === 'forge' || patch.engine === 'project' || patch.engine === 'off') deps.settings.set(SYNC_ENGINE_SETTING, patch.engine)
      if (typeof patch.gateRojo === 'boolean') deps.settings.set(SYNC_GATE_SETTING, patch.gateRojo)
      // Gate off / engine changed: release (or re-check) held rojo serves.
      deps.supervisor.applyGates()
      current?.refresh()
      return settings()
    }
  }

  const wiring: SyncWiring = {
    service: () => current,
    handler,
    handlers,
    async onProjectOpen(root) {
      current?.close()
      current = new SyncService({
        root,
        engine: deps.engine ? deps.engine(root) : null,
        mapping: deps.mapping ?? null,
        settings: deps.settings,
        git: (args) => git(root, args),
        pluginsDir: deps.pluginsDir,
        studio: deps.studio,
        studios: deps.studios,
        plugin: deps.plugin,
        onGate: (file, gate, detail) => deps.supervisor.setGate(file, gate, detail),
        emit,
        log: deps.log,
        onStudioTree: deps.onStudioTree
      })
      await current.start().catch((e) => deps.log?.(`sync: ${(e as Error).message}`, 'stderr'))
    },
    liveTree(projectFile) {
      return current ? current.liveTree(projectFile) : null
    },
    onProjectClose() {
      current?.close()
      current = null
    },
    onPlacesChanged() {
      void current?.reload()
    },
    studioConflicts() {
      if (settings().engine !== 'forge') return null
      return (current?.conflicts() ?? []).map((c) => ({
        path: c.file,
        repoSource: c.disk,
        studioSource: c.studio,
        base: c.base,
        placeKey: c.placeKey,
        instancePath: c.instancePath,
        reason: c.reason
      }))
    },
    async resolveStudioConflict(path, take, placeKey) {
      const service = need()
      const all = service.conflicts().filter((c) => c.file === path)
      const hit = all.find((c) => c.placeKey === placeKey) ?? all[0]
      if (!hit) throw new Error(`No held Studio version for ${path}`)
      await service.resolve(hit.placeKey, hit.file, take === 'repo' ? 'disk' : 'studio')
    },
    guardGit(g, autoCommit) {
      return new Proxy(g, {
        get(target, prop, receiver) {
          if (prop !== 'syncNow') return Reflect.get(target, prop, receiver)
          return async () => {
            if (current && settings().engine === 'forge') {
              const guard = await current.guardGitOp('pull', { autoCommit: autoCommit() }).catch(() => null)
              if (guard?.committed?.length) deps.log?.(`sync: committed ${guard.committed.length} Studio edit(s) before pulling`)
            }
            return target.syncNow()
          }
        }
      })
    }
  }
  return wiring
}
