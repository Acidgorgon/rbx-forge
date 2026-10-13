// Wires the toolchain setup (bundled rokit + global tools), the per-project `rokit install` and the
// New project flow into IPC. main/index.ts builds this once with the Electron pieces; nothing here
// imports electron, so it runs under node --test with fakes.

import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join, posix, win32 } from 'node:path'
import type { LogLine } from '@shared/types'
import { defaultContext, rokitBin, setLoginShellPath, loadLoginShellPath } from './services/tools.ts'
import {
  checkProjectTools,
  defaultToolchainEnv,
  installProjectTools,
  runSetup,
  toolchainStatus,
  type SetupMode,
  type SetupProgress,
  type SetupRecord,
  type SetupResult,
  type ToolchainEnv,
  type ToolchainStatus
} from './services/setup/toolchain.ts'
import { createProject, type NewProjectDeps, type NewProjectInput, type NewProjectProgress, type NewProjectResult } from './services/setup/newProject.ts'

export interface ProjectToolsEvent {
  root: string
  state: 'running' | 'done' | 'failed' | 'needsTrust' | 'noRokit'
  tools: string[]
  message?: string
}

export interface SetupEmit {
  (event: 'toolchain:progress', payload: SetupProgress): void
  (event: 'toolchain:projectTools', payload: ProjectToolsEvent): void
  (event: 'newProject:progress', payload: NewProjectProgress): void
}

export interface SetupDeps {
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: SetupEmit
  log: (line: Omit<LogLine, 'at'>) => void
  // Folder holding the packaged extraResources (process.resourcesPath), and the repo root in
  // development (resources/rokit/<os>-<arch>).
  resourcesPath: string | null
  devRoot: string
  platform?: NodeJS.Platform
  arch?: string
  chooseFolder: (title: string, defaultPath?: string) => Promise<string | null>
  homeDir: string
  // After tools were installed: services that reported "missing" retry.
  onToolsInstalled: () => void
  // Test seams.
  env?: ToolchainEnv
  newProjectDeps?: Partial<NewProjectDeps>
}

export interface SetupWiring {
  handlers: Record<string, (...args: any[]) => unknown>
  onProjectOpen(root: string): void
  dispose(): void
  bundledRokit: string | null
}

const OS_KEY: Record<string, string> = { darwin: 'mac', win32: 'win', linux: 'linux' }

// The app's own rokit: <resources>/rokit/rokit[.exe] when packaged (electron-builder.yml
// extraResources), resources/rokit/<os>-<arch>/ in a development checkout after
// `npm run rokit-binaries`.
export function findBundledRokit(resourcesPath: string | null, devRoot: string, platform: NodeJS.Platform = process.platform, arch: string = process.arch, exists: (file: string) => boolean = existsSync): string | null {
  const file = platform === 'win32' ? 'rokit.exe' : 'rokit'
  const p = platform === 'win32' ? win32 : posix
  const candidates = [
    ...(resourcesPath ? [p.join(resourcesPath, 'rokit', file)] : []),
    p.join(devRoot, 'resources', 'rokit', `${OS_KEY[platform] ?? platform}-${arch}`, file)
  ]
  return candidates.find((candidate) => exists(candidate)) ?? null
}

// PATH for this process after rokit landed in ~/.rokit/bin: Forge's own lookups (tools.ts) always
// search there, but anything that reads process.env.PATH (the agent's shell, child processes
// started without toolEnv) should see it too, without restarting Forge.
export function refreshProcessPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  bin: string = rokitBin({ ...defaultContext(), env, platform })
): boolean {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const delimiter = platform === 'win32' ? ';' : ':'
  const parts = (env[key] ?? '').split(delimiter).filter(Boolean)
  const norm = (d: string) => (platform === 'win32' ? d.toLowerCase() : d).replace(/[\\/]+$/, '')
  if (parts.some((d) => norm(d) === norm(bin))) return false
  env[key] = [bin, ...parts].join(delimiter)
  return true
}

export function createSetup(deps: SetupDeps): SetupWiring {
  const bundledRokit = findBundledRokit(deps.resourcesPath, deps.devRoot, deps.platform, deps.arch)
  const env = () => deps.env ?? defaultToolchainEnv(bundledRokit)
  const record = (): SetupRecord => {
    const value = deps.settings.get<string>('toolchainSetup', 'never')
    return value === 'done' || value === 'skipped' ? value : 'never'
  }
  let running: AbortController | null = null
  let projectRun: AbortController | null = null

  const afterInstall = async () => {
    refreshProcessPath()
    // macOS: the login shell now sources ~/.rokit/env too; re-read it so later lookups match.
    if (process.platform === 'darwin') await loadLoginShellPath().catch(() => setLoginShellPath(null))
    deps.onToolsInstalled()
  }

  const setup = async (options: { mode?: SetupMode; tools?: string[] } = {}): Promise<SetupResult> => {
    if (running) throw new Error('The toolchain setup is already running.')
    const controller = new AbortController()
    running = controller
    const mode = options.mode ?? 'install'
    deps.log({ service: 'harness', stream: 'info', text: `toolchain: ${mode}${options.tools ? ` ${options.tools.join(', ')}` : ''}` })
    try {
      const result = await runSetup(env(), {
        mode,
        tools: options.tools,
        signal: controller.signal,
        onProgress: (p) => {
          deps.emit('toolchain:progress', p)
          if (p.state !== 'running') deps.log({ service: 'harness', stream: p.state === 'failed' ? 'stderr' : 'info', text: `toolchain: ${p.step} ${p.state}${p.message ? ` · ${p.message}` : ''}` })
        }
      })
      if (result.ok && !options.tools) deps.settings.set('toolchainSetup', 'done')
      if (result.steps.some((s) => s.state === 'done')) await afterInstall()
      return result
    } finally {
      running = null
    }
  }

  const handlers: Record<string, (...args: any[]) => unknown> = {
    toolchainStatus: (): Promise<ToolchainStatus> => toolchainStatus(env(), record()),
    toolchainSetup: (options?: { mode?: SetupMode; tools?: string[] }) => setup(options ?? {}),
    toolchainCancel: async () => {
      running?.abort()
    },
    toolchainSkip: async () => {
      running?.abort()
      deps.settings.set('toolchainSetup', 'skipped')
    },
    newProjectDefaults: async () => ({
      parentDir: deps.settings.get<string>('newProjectParent', join(deps.homeDir, 'Roblox')),
      gitAvailable: (await toolchainStatus(env(), record())).git.available
    }),
    chooseFolder: (title?: string, defaultPath?: string) => deps.chooseFolder(title || 'Choose a folder', defaultPath),
    createProject: async (input: NewProjectInput): Promise<NewProjectResult> => {
      const result = await createProject(input, {
        defaultScope: safeUserName(),
        ...deps.newProjectDeps,
        onProgress: (p) => deps.emit('newProject:progress', p)
      })
      deps.settings.set('newProjectParent', input.parentDir)
      deps.log({ service: 'harness', stream: 'info', text: `new project: ${result.root} (${result.via})` })
      return result
    }
  }

  const onProjectOpen = (root: string) => {
    projectRun?.abort()
    const controller = new AbortController()
    projectRun = controller
    const e = env()
    const check = checkProjectTools(e, root)
    if (!check.missing.length) return
    if (!check.untrusted.length) {
      deps.emit('toolchain:projectTools', { root, state: 'running', tools: check.missing.map((m) => `${m.alias} ${m.version}`) })
    }
    void (async () => {
      const result = await installProjectTools(
        e,
        root,
        (line) => deps.log({ service: 'harness', stream: 'stdout', text: `rokit install: ${line}` }),
        controller.signal
      ).catch((error) => ({ state: 'failed' as const, tools: [], message: String(error?.message ?? error) }))
      if (controller.signal.aborted || result.state === 'none') return
      deps.emit('toolchain:projectTools', { root, state: result.state, tools: result.tools, message: result.message })
      deps.log({ service: 'harness', stream: result.state === 'done' ? 'info' : 'stderr', text: `rokit install (${result.tools.join(', ')}): ${result.state}${result.message ? ` · ${result.message}` : ''}` })
      if (result.state === 'done') await afterInstall()
    })()
  }

  return {
    handlers,
    onProjectOpen,
    dispose: () => {
      running?.abort()
      projectRun?.abort()
    },
    bundledRokit
  }
}

function safeUserName(): string | undefined {
  try {
    return userInfo().username || undefined
  } catch {
    return undefined
  }
}
