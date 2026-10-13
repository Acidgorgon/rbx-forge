import { app, BrowserWindow, dialog, ipcMain } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  INVOKE_PREFIX,
  type GitStatus,
  type HarnessEvents,
  type LogLine,
  type ProjectInfo,
  type ServiceId,
  type SyncSettings
} from '../shared/types.ts'
import type { HarnessContext } from './context.ts'
import { registerAgentIpc } from './agent/index.ts'
import { DEFAULT_SYNC, emptyStatus, GitSync } from './services/gitSync.ts'
import { LogBuffer } from './services/logs.ts'
import { LspBridge } from './services/lspBridge.ts'
import { Project } from './services/project.ts'
import { Settings } from './services/settings.ts'
import { StudioConflicts } from './services/studioConflicts.ts'
import { Supervisor } from './services/supervisor.ts'
import { findTool, run } from './services/tools.ts'

function emit<K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(event, payload)
  }
}

const settings = new Settings(app.getPath('userData'))
const logs = new LogBuffer((line) => emit('log:line', line))
const supervisor = new Supervisor({
  log: (line) => logs.push(line),
  onStatus: (statuses) => emit('services:status', statuses),
  getSetting: (key, fallback) => settings.get(key, fallback)
})

// Editor language server: luau-lsp over stdio, relayed to the renderer's Monaco client.
const lsp = new LspBridge({
  spawn: (args) => supervisor.spawnLsp(args),
  send: (message) => emit('lsp:message', message),
  log: (line) => logs.push(line),
  cacheDir: join(app.getPath('userData'), 'luau-lsp'),
  version: async () => {
    const bin = findTool('luau-lsp')
    if (!bin) return null
    const result = await run(bin, ['--version'], process.cwd())
    return result.code === 0 ? result.stdout.trim() : null
  }
})

let project: Project | null = null
let git: GitSync | null = null
let conflicts: StudioConflicts | null = null
let remoteTimer: ReturnType<typeof setInterval> | null = null

function syncSettings(): SyncSettings {
  return { ...DEFAULT_SYNC, ...settings.get<Partial<SyncSettings>>('sync', {}) }
}

function harnessLog(text: string, stream: LogLine['stream'] = 'info'): void {
  logs.push({ service: 'harness', stream, text })
}

function requireProject(): Project {
  if (!project) throw new Error('No project open')
  return project
}

async function closeProject(): Promise<void> {
  project?.close()
  conflicts?.close()
  git?.dispose()
  if (remoteTimer) clearInterval(remoteTimer)
  remoteTimer = null
  project = null
  git = null
  conflicts = null
  await supervisor.setRoot(null)
  await lsp.setRoot(null)
}

function isProjectDir(root: string): boolean {
  try {
    return statSync(root).isDirectory() && existsSync(join(root, 'default.project.json'))
  } catch {
    return false
  }
}

async function openProject(root?: string): Promise<ProjectInfo | null> {
  if (root === undefined) {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = { title: 'Open a GenTree project', properties: ['openDirectory'] }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    if (picked.canceled || picked.filePaths.length === 0) return project?.info ?? null
    root = picked.filePaths[0]
  }
  const full = resolve(root)
  if (!isProjectDir(full)) throw new Error(`${full} has no default.project.json; pick the project folder.`)

  await closeProject()
  const opened = await Project.open(full)
  project = opened
  settings.setLastProject(full)
  harnessLog(`opened ${full}`)

  opened.watch((change) => {
    if (change.info) emit('project:changed', opened.info)
    if (change.tree) emit('tree:changed', opened.tree)
    if (change.scripts) emit('scripts:changed', opened.scripts)
    void git?.refresh()
  })

  git = new GitSync({
    root: full,
    settings: syncSettings,
    onStatus: (status) => emit('git:status', status),
    log: (text, stream = 'info') => logs.push({ service: 'git', stream, text })
  })
  git.schedule()
  void git.refresh(true)
  remoteTimer = setInterval(() => void git?.refresh(true), 2 * 60 * 1000)

  conflicts = new StudioConflicts(full)
  conflicts.watch((list) => emit('studio:conflicts', list))

  emit('project:changed', opened.info)
  emit('tree:changed', opened.tree)
  emit('scripts:changed', opened.scripts)

  await supervisor.setRoot(full)
  void lsp.setRoot(full).catch((error) => harnessLog(`luau-lsp: ${error}`, 'stderr'))
  void supervisor.startAll().catch((error) => harnessLog(`start services: ${error}`, 'stderr'))
  return opened.info
}

const ctx: HarnessContext = {
  project: () => project?.info ?? null,
  tree: () => project?.tree ?? [],
  scripts: () => project?.scripts ?? [],
  readFile: (path) => requireProject().readFile(path),
  writeFile: (path, contents) => requireProject().writeFile(path, contents),
  listFiles: (dir) => requireProject().listFiles(dir),

  services: () => supervisor.statuses(),
  restartService: (id) => supervisor.restart(id),
  logs: (service, limit) => logs.get(service, limit),

  gitStatus: async () => (git ? git.status() : emptyStatus('No project open')),
  syncNow: async () => (git ? git.syncNow() : emptyStatus('No project open')),
  studioConflicts: async () => (conflicts ? conflicts.list() : []),
  resolveStudioConflict: async (path, take) => {
    if (!conflicts) throw new Error('No project open')
    await conflicts.resolve(path, take)
    emit('studio:conflicts', await conflicts.list())
  },

  getSetting: (key, fallback) => settings.get(key, fallback),
  setSetting: (key, value) => settings.set(key, value),

  emit,
  log: (line) => logs.push(line)
}

const handlers: Record<string, (...args: any[]) => unknown> = {
  openProject: (root?: string) => openProject(root),
  getProject: () => ctx.project(),
  getTree: () => ctx.tree(),
  getScripts: () => ctx.scripts(),
  readFile: (path: string) => ctx.readFile(path),
  writeFile: (path: string, contents: string) => ctx.writeFile(path, contents),

  getServices: () => supervisor.statuses(),
  startService: (id: ServiceId) => supervisor.start(id),
  stopService: (id: ServiceId) => supervisor.stop(id),
  restartService: (id: ServiceId) => supervisor.restart(id),
  getLogs: (service?: LogLine['service']) => logs.get(service),

  getGitStatus: () => ctx.gitStatus(),
  syncNow: () => ctx.syncNow(),
  initGit: async (remoteUrl?: string): Promise<GitStatus> =>
    git ? git.initGit(remoteUrl || undefined) : emptyStatus('No project open'),
  getSyncSettings: () => syncSettings(),
  setSyncSettings: (next: SyncSettings) => {
    const minutes = Math.max(0, Math.floor(Number(next.autoSyncMinutes) || 0))
    settings.set('sync', { autoSyncMinutes: minutes, autoCommit: Boolean(next.autoCommit) })
    git?.schedule()
  },
  getStudioConflicts: () => ctx.studioConflicts(),
  resolveStudioConflict: (path: string, take: 'studio' | 'repo') => ctx.resolveStudioConflict(path, take),

  lspStart: () => lsp.start()
}

for (const [name, handler] of Object.entries(handlers)) {
  ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => handler(...args))
}
ipcMain.on(INVOKE_PREFIX + 'lspSend', (_event, message: unknown) => lsp.send(message))
const agentIpc = registerAgentIpc(ctx, ipcMain)

function preloadPath(): string {
  const dir = join(__dirname, '../preload')
  for (const name of ['index.mjs', 'index.js', 'index.cjs']) {
    if (existsSync(join(dir, name))) return join(dir, name)
  }
  return join(dir, 'index.js')
}

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    show: false,
    backgroundColor: '#0f0f10',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.once('ready-to-show', () => window.show())
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'))
  }
  return window
}

app.whenReady().then(async () => {
  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
  const last = settings.lastProject()
  if (last && isProjectDir(last)) {
    await openProject(last).catch((error) => harnessLog(`reopen ${last}: ${error}`, 'stderr'))
  }
})

app.on('window-all-closed', () => {
  app.quit()
})

let quitting = false
app.on('before-quit', (event) => {
  if (quitting) return
  quitting = true
  event.preventDefault()
  agentIpc.dispose()
  lsp.dispose()
  closeProject()
    .catch(() => undefined)
    .finally(() => app.quit())
})

process.on('exit', () => {
  lsp.dispose()
  supervisor.killAllSync()
})
