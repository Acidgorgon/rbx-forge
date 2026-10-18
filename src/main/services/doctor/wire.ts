// Real probes + fixes for Forge Doctor, built from the app's existing pieces (toolchain setup, Studio
// bridge, Forge Sync, supervisor, providers, updater). Electron-only bits (macOS permission status,
// opening System Settings) come in as plain functions, so this file has no electron import.

import { createServer } from 'node:net'
import { access, readdir, readFile, stat, statfs } from 'node:fs/promises'
import { join } from 'node:path'
import type { DoctorAction, DoctorInputs, DoctorReport } from '../../../shared/doctor/types.ts'
import type { ProviderInfo, ServiceStatus, PlaceInfo, RojoPlaceStatus } from '../../../shared/types.ts'
import type { StudioStatus } from '../../../shared/studio/types.ts'
import type { SyncStatus } from '../../../shared/sync/types.ts'
import type { UpdateState } from '../../../shared/updateTypes.ts'
import type { ToolchainStatus } from '../setup/toolchain.ts'
import { checkProjectTools, defaultToolchainEnv } from '../setup/toolchain.ts'
import { findTool, run } from '../tools.ts'
import { findLegacyPlugins } from '../sync/legacy.ts'
import { duplicateMappings, duplicateMappingText, loadPlaces } from '../sync/mapping.ts'
import { isRojoProcess, portOwners, stopProcess } from '../portOwner.ts'
import { DoctorService, scopeStrings, type DoctorProbes } from './service.ts'

export interface DoctorWiringDeps {
  platform: NodeJS.Platform
  appVersion: string
  isPackaged: boolean
  userDataDir: string
  homeDir: string
  env: NodeJS.ProcessEnv
  projectRoot(): string | null
  places(): PlaceInfo[]
  serveAllPlaces(): boolean
  activePlace(): string | null
  services(): ServiceStatus[]
  toolchainStatus(): Promise<ToolchainStatus>
  toolchainRepair(): Promise<unknown>
  installProjectTools(root: string): void
  studioStatus(): Promise<StudioStatus>
  installPlugin(): Promise<unknown>
  pluginsDir(): string | null
  syncStatus(): Promise<SyncStatus>
  disableLegacyPlugins(): Promise<unknown>
  providers(): Promise<ProviderInfo[]>
  defaultProvider(): string
  openCloudKey(): Promise<string | null>
  openAiKey(): Promise<string | null>
  updateState(): Promise<UpdateState>
  updateCheck(): Promise<unknown>
  startRojo(): Promise<unknown>
  // Each place's real rojo serve (supervisor.rojoPlaces), and whether a serve of Forge's is up on a port.
  rojoPlaces?(): RojoPlaceStatus[]
  servesPort?(port: number): boolean
  // macOS: systemPreferences.getMediaAccessStatus('screen'); null elsewhere.
  screenRecording(): DoctorInputs['screenRecording']
  openExternal(url: string): void
  emit(report: DoctorReport): void
  fetch?: typeof fetch
  log?(text: string): void
}

// Where Roblox Studio installs (Windows: per-user Versions folder; macOS: the app bundle).
export function studioCandidates(platform: string, env: NodeJS.ProcessEnv, home: string): { versionsDirs: string[]; apps: string[] } | null {
  if (platform === 'darwin') return { versionsDirs: [], apps: ['/Applications/RobloxStudio.app', `${home}/Applications/RobloxStudio.app`] }
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA ?? `${home}\\AppData\\Local`
    const pf = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    return { versionsDirs: [`${local}\\Roblox\\Versions`, `${pf}\\Roblox\\Versions`], apps: [] }
  }
  return null
}

async function exists(p: string): Promise<boolean> {
  try {
    await access(p)
    return true
  } catch {
    return false
  }
}

export function portBusy(port: number, host = '127.0.0.1'): Promise<boolean | null> {
  return new Promise((resolve) => {
    const srv = createServer()
    srv.once('error', (e: NodeJS.ErrnoException) => resolve(e.code === 'EADDRINUSE' || e.code === 'EACCES' ? true : null))
    srv.once('listening', () => srv.close(() => resolve(false)))
    srv.listen(port, host)
  })
}

// POST https://apis.roblox.com/api-keys/v1/introspect {"apiKey": ...} -> name, scopes[{name,
// operations}], enabled, expired (https://create.roblox.com/docs/cloud/auth/api-keys). The key is
// only sent to Roblox, never logged or returned.
export async function introspectOpenCloudKey(key: string, fetchFn: typeof fetch = fetch): Promise<{ enabled: boolean; expired: boolean; scopes: string[] }> {
  const res = await fetchFn('https://apis.roblox.com/api-keys/v1/introspect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ apiKey: key }) })
  if (!res.ok) throw new Error(`Roblox answered ${res.status}`)
  const j = (await res.json()) as { enabled?: unknown; expired?: unknown; scopes?: unknown }
  return { enabled: j.enabled !== false, expired: j.expired === true, scopes: scopeStrings(j.scopes) }
}

function rojoState(services: ServiceStatus[]): DoctorInputs['rojo'] {
  const r = services.find((s) => s.id === 'rojo')
  if (!r) return null
  return r.state === 'running' || r.state === 'starting' || r.state === 'crashed' || r.state === 'missing' ? r.state : 'stopped'
}

export function createDoctorWiring(deps: DoctorWiringDeps): { service: DoctorService; handlers: Record<string, (...args: any[]) => unknown> } {
  let introspectCache: { key: string; at: number; value: { enabled: boolean; expired: boolean; scopes: string[] } } | null = null
  const runCmd = async (cmd: string, args: string[], cwd?: string) => {
    const file = findTool(cmd)
    if (!file) return { code: null, output: '' }
    const r = await run(file, args, cwd ?? deps.homeDir)
    return { code: r.code, output: `${r.stdout}\n${r.stderr}` }
  }
  const probes: DoctorProbes = {
    platform: deps.platform,
    appVersion: deps.appVersion,
    isPackaged: deps.isPackaged,
    userDataDir: deps.userDataDir,
    projectRoot: deps.projectRoot,
    toolchain: async () => {
      const t = await deps.toolchainStatus()
      return { rokit: { installed: t.rokit.installed, version: t.rokit.version }, tools: t.tools.map((x) => ({ alias: x.alias, pinned: x.pinned, version: x.version, state: x.state })) }
    },
    git: async () => {
      const t = await deps.toolchainStatus()
      return { available: t.git.available, version: t.git.version, ...(t.git.hint ? { hint: t.git.hint } : {}), ...(t.git.downloadUrl ? { downloadUrl: t.git.downloadUrl } : {}) }
    },
    run: runCmd,
    studioInstall: async () => {
      const c = studioCandidates(deps.platform, deps.env, deps.homeDir)
      if (!c) return null
      for (const app of c.apps) if (await exists(app)) return { installed: true, path: app }
      for (const dir of c.versionsDirs) {
        for (const v of await readdir(dir).catch(() => [] as string[])) {
          const exe = join(dir, v, 'RobloxStudioBeta.exe')
          if (await exists(exe)) return { installed: true, path: join(dir, v) }
        }
      }
      return { installed: false }
    },
    bridge: async () => {
      const s = await deps.studioStatus()
      return { port: s.server.port, listening: s.server.listening, ...(s.server.error ? { error: s.server.error } : {}), plugin: { installed: s.plugin.installed, ...(s.plugin.version !== undefined ? { version: s.plugin.version } : {}), bundled: s.plugin.bundled, ...(s.plugin.outdated ? { outdated: true } : {}), dir: s.plugin.dir }, studio: s.studio }
    },
    legacyPlugins: () => findLegacyPlugins(deps.pluginsDir()),
    // Served from the supervisor's real per-place state (a held, crashed or given-up place is not
    // served), the settings only when that is not available.
    servePorts: () => {
      const places = deps.places()
      const active = deps.activePlace()
      const live = deps.rojoPlaces?.()
      if (live?.length) return places.map((p) => ({ port: p.servePort, label: `rojo serve (${p.name})`, served: live.some((x) => x.file === p.file && (x.state === 'serving' || x.state === 'starting')), live: true }))
      return places.map((p) => ({ port: p.servePort, label: `rojo serve (${p.name})`, served: deps.serveAllPlaces() || p.file === active || (places.length === 1 && !active) }))
    },
    portOwner: async (port) => {
      if (deps.servesPort?.(port)) return null
      const owner = (await portOwners(port, deps.platform))[0]
      return owner ? { pid: owner.pid, name: owner.name, rojo: isRojoProcess(owner.name) } : null
    },
    duplicateMappings: async (root) => (await Promise.all((await loadPlaces(root)).map((m) => duplicateMappings(m)))).flat().map(duplicateMappingText),
    rojo: () => rojoState(deps.services()),
    portBusy: (port) => portBusy(port),
    sync: async () => {
      const s = await deps.syncStatus()
      return { engine: s.engine, places: s.places.map((p) => ({ projectFile: p.projectFile, gate: p.gate, conflicts: p.conflicts, connected: p.connected, ...(p.studioOnly ? { studioOnly: p.studioOnly.count } : {}) })), pendingStudioEdits: s.pendingStudioEdits.length }
    },
    keys: async () => {
      const def = deps.defaultProvider()
      return (await deps.providers()).map((p) => ({ provider: p.id, label: p.label, set: !!p.keyHint || (p.needsKey && p.ready), isDefault: p.id === def, ...(p.needsKey ? {} : { local: true }) }))
    },
    openCloudKey: deps.openCloudKey,
    introspectKey: async (key) => {
      if (introspectCache && introspectCache.key === key && Date.now() - introspectCache.at < 10 * 60_000) return introspectCache.value
      const value = await introspectOpenCloudKey(key, deps.fetch)
      introspectCache = { key, at: Date.now(), value }
      return value
    },
    openAiKey: async () => !!(await deps.openAiKey()),
    freeBytes: async (path) => {
      const s = await statfs(path)
      return Number(s.bavail) * Number(s.bsize)
    },
    readText: (path) => readFile(path, 'utf8').catch(() => null),
    listDir: (path) => readdir(path),
    exists,
    mtimeMs: async (path) => (await stat(path).catch(() => null))?.mtimeMs ?? null,
    projectToolsMissing: (root) => {
      const env = defaultToolchainEnv(null)
      return checkProjectTools(env, root).missing.map((m) => `${m.alias} ${m.version}`)
    },
    updater: async () => {
      const u = await deps.updateState()
      return { state: u.phase, ...(u.offer?.version ? { version: u.offer.version } : {}), ...(u.error ? { error: u.error.message } : u.phase === 'disabled' && u.note ? { error: u.note } : {}) }
    },
    screenRecording: deps.screenRecording
  }

  const needRoot = (): string => {
    const r = deps.projectRoot()
    if (!r) throw new Error('Open a project first.')
    return r
  }
  const fixers: Partial<Record<DoctorAction, () => Promise<string>>> = {
    installTools: async () => {
      await deps.toolchainRepair()
      return 'Toolchain repaired.'
    },
    installProjectTools: async () => {
      deps.installProjectTools(needRoot())
      return 'Running rokit install in the project (see Output).'
    },
    installPlugin: async () => {
      await deps.installPlugin()
      return 'Forge Bridge installed. Restart Studio (or reload plugins).'
    },
    disableLegacyPlugins: async () => {
      await deps.disableLegacyPlugins()
      return 'Legacy plugin moved aside. Restart Studio.'
    },
    wallyInstall: async () => {
      const r = await runCmd('wally', ['install'], needRoot())
      if (r.code !== 0) throw new Error(r.output.trim().split('\n').slice(-3).join(' ') || 'wally install failed (is wally installed?)')
      return 'wally install finished.'
    },
    sourcemap: async () => {
      const root = needRoot()
      const r = await runCmd('rojo', ['sourcemap', 'default.project.json', '--output', 'sourcemap.json'], root)
      if (r.code !== 0) throw new Error(r.output.trim().split('\n').slice(-3).join(' ') || 'rojo sourcemap failed')
      return 'sourcemap.json written.'
    },
    startRojo: async () => {
      await deps.startRojo()
      return 'Rojo started.'
    },
    // Only a process named rojo, on a serve port of this project, and only while no serve of Forge's
    // own is up on that port.
    stopStrayRojo: async () => {
      const stopped: string[] = []
      for (const port of [...new Set(deps.places().map((p) => p.servePort))]) {
        if (deps.servesPort?.(port)) continue
        for (const owner of await portOwners(port, deps.platform)) {
          if (!isRojoProcess(owner.name)) continue
          deps.log?.(`doctor: stopping stray ${owner.name} (pid ${owner.pid}) on port ${port}`)
          await stopProcess(owner.pid, deps.platform)
          stopped.push(`:${port} (pid ${owner.pid})`)
        }
      }
      if (!stopped.length) throw new Error('No stray rojo found on the serve ports.')
      await deps.startRojo().catch(() => undefined)
      return `Stopped rojo on ${stopped.join(', ')}; Forge starts its own serve again.`
    },
    checkUpdates: async () => {
      await deps.updateCheck()
      return 'Checked for updates.'
    },
    openScreenRecording: async () => {
      deps.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture')
      return 'Opened System Settings > Privacy & Security > Screen Recording. Turn on RBX Forge, then restart it.'
    }
  }

  const service = new DoctorService({ probes, fixers, emit: deps.emit })
  const handlers: Record<string, (...args: any[]) => unknown> = {
    doctorRun: () => service.run(),
    doctorLast: async () => service.lastReport(),
    doctorFix: (action: unknown) => service.fix(String(action ?? '') as DoctorAction)
  }
  return { service, handlers }
}
