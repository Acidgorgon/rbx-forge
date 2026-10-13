import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import {
  INVOKE_PREFIX,
  type BlinkModel,
  type GitStatus,
  type HarnessEvents,
  type LogLine,
  type PlaceInfo,
  type ProjectInfo,
  type ServiceId,
  type SyncSettings,
  type WallyAddSpec,
  type WallyRealm
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
import { Packages } from './services/packages.ts'
import { BLINK_ENTRY, BlinkWatcher } from './services/blink.ts'
import { createIntegrations } from './integrations.ts'
import { findTool, loadLoginShellPath, run } from './services/tools.ts'
import iconPath from '../../build/icon.png?asset'
import { PRODUCTION_CSP } from './csp.ts'

// Name and data folder. The data folder stays "rbx-forge" (what development builds have always
// used), so settings, the stored API key and the luau-lsp cache carry over to the installed app.
app.setName('RBX Forge')
app.setPath('userData', join(app.getPath('appData'), 'rbx-forge'))

// One window per user: a second launch (double-clicking the app again) focuses the first.
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}
app.on('second-instance', () => {
  const window = BrowserWindow.getAllWindows()[0]
  if (!window) return
  if (window.isMinimized()) window.restore()
  window.show()
  window.focus()
})

// Content Security Policy for the packaged renderer (see csp.ts). Development (the Vite dev server
// with HMR) is left alone.
function installCsp(): void {
  if (!app.isPackaged && process.env.ELECTRON_RENDERER_URL) return
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: { ...details.responseHeaders, 'Content-Security-Policy': [PRODUCTION_CSP] }
    })
  })
}

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

// Wally deps and Rokit tools of the open project (Packages drawer).
const packages = new Packages({
  root: () => project?.info.root ?? null,
  devRunning: () => supervisor.statuses().some((s) => s.id === 'dev' && s.state === 'running'),
  log: (line) => logs.push(line),
  emit: (payload) => emit('packages:changed', payload)
})
let git: GitSync | null = null
let conflicts: StudioConflicts | null = null
let remoteTimer: ReturnType<typeof setInterval> | null = null
let blink: BlinkWatcher | null = null
const EMPTY_BLINK: BlinkModel = { file: null, events: [], types: [], options: {}, diagnostics: [] }

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
  integrations.onProjectClose()
  project?.close()
  conflicts?.close()
  blink?.close()
  blink = null
  git?.dispose()
  if (remoteTimer) clearInterval(remoteTimer)
  remoteTimer = null
  project = null
  git = null
  conflicts = null
  await supervisor.setRoot(null)
  lsp.setDataModel(null)
  await lsp.setRoot(null)
}

function isProjectDir(root: string): boolean {
  try {
    return statSync(root).isDirectory() && existsSync(join(root, 'default.project.json'))
  } catch {
    return false
  }
}

// Active place per project root (settings key "activePlaces").
function activePlaces(): Record<string, string> {
  return settings.get<Record<string, string>>('activePlaces', {})
}

// Points rojo serve, the luau-lsp sourcemap and the renderer at the project's active place.
function applyPlace(opened: Project, announce = true): void {
  const place = opened.getActivePlace()
  lsp.setPlace(place?.file ?? null, place?.sourcemap)
  void supervisor.setPlaces(opened.listPlaces(), place?.file ?? null).catch((error) => harnessLog(`places: ${error}`, 'stderr'))
  if (announce) emit('places:changed', { places: opened.listPlaces(), active: opened.activePlace })
}

async function setActivePlace(file: string): Promise<PlaceInfo> {
  const opened = requireProject()
  const change = await opened.setActivePlace(file)
  settings.set('activePlaces', { ...activePlaces(), [opened.root]: opened.activePlace })
  if (change.info) emit('project:changed', opened.info)
  if (change.tree) {
    emit('tree:changed', opened.tree)
    lsp.setDataModel(opened.tree)
  }
  if (change.scripts) emit('scripts:changed', opened.scripts)
  applyPlace(opened)
  integrations.onActivePlaceChanged()
  return opened.getActivePlace() as PlaceInfo
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
  const opened = await Project.open(full, { activePlace: activePlaces()[full] })
  project = opened
  settings.setLastProject(full)
  harnessLog(`opened ${full}`)

  opened.watch((change) => {
    if (change.info) emit('project:changed', opened.info)
    if (change.tree) {
      emit('tree:changed', opened.tree)
      lsp.setDataModel(opened.tree)
    }
    if (change.scripts) {
      emit('scripts:changed', opened.scripts)
      integrations.onScriptsChanged()
    }
    if (change.places) applyPlace(opened)
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

  // events.blink: parse on change, compile a temp copy, report errors (Events tab + dev log).
  // Root *.blink files other than events.blink are not generated by the dev loop: Forge compiles
  // them to their configured outputs after a passing check (events.blink too while ./dev is off).
  blink = new BlinkWatcher({
    root: full,
    log: (line) => logs.push(line),
    onChange: (model) => emit('blink:changed', model),
    generate: (entry) => entry !== BLINK_ENTRY || !supervisor.statuses().some((s) => s.id === 'dev' && (s.state === 'running' || s.state === 'starting'))
  })
  void blink.start().catch((error) => harnessLog(`blink: ${error}`, 'stderr'))

  conflicts = new StudioConflicts(full)
  conflicts.watch((list) => emit('studio:conflicts', list))

  emit('project:changed', opened.info)
  emit('tree:changed', opened.tree)
  emit('scripts:changed', opened.scripts)
  // Live Studio instances -> luau-lsp ($/plugin/full), for DataModel autocomplete.
  lsp.setDataModel(opened.tree)

  await supervisor.setRoot(full)
  applyPlace(opened, false)
  void lsp.setRoot(full).catch((error) => harnessLog(`luau-lsp: ${error}`, 'stderr'))
  void supervisor.startAll().catch((error) => harnessLog(`start services: ${error}`, 'stderr'))
  await integrations.onProjectOpen(full).catch((error) => harnessLog(`integrations: ${error}`, 'stderr'))
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
  log: (line) => logs.push(line),

  serviceTools: () => integrations.serviceTools(),
  notifyTestFailure: (event) => integrations.notifyTestFailure(event)
}

// Collab, release, Lune tests, analytics, feature rename + their agent tools (integrations.ts).
const integrations = createIntegrations({
  ctx,
  settings,
  safeStorage,
  userDataDir: app.getPath('userData'),
  emit,
  log: (line) => logs.push(line),
  root: () => project?.info.root ?? null,
  projectFile: () => project?.activePlace ?? null,
  projectName: () => project?.info.name,
  packages,
  git: () => git,
  studioConflicts: async () => (conflicts ? conflicts.list() : []),
  pauseProjectWatch: () => project?.pause(),
  resumeProjectWatch: () => project?.resume(),
  services: () => supervisor.statuses(),
  startService: (id) => supervisor.start(id),
  stopService: (id) => supervisor.stop(id),
  openExternal: (url) => void shell.openExternal(url),
  summarize: (prompt) => agentIpc.summarize(prompt),
  choosePlaceFile: async () => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = {
      title: 'Choose the exported place file',
      properties: ['openFile'],
      filters: [{ name: 'Roblox place', extensions: ['rbxl', 'rbxlx'] }]
    }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  }
})

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

  getBlink: () => blink?.model ?? EMPTY_BLINK,
  lspStart: () => lsp.start(),

  listPlaces: () => project?.listPlaces() ?? [],
  getActivePlace: () => project?.getActivePlace() ?? null,
  setActivePlace: (file: string) => setActivePlace(file),

  searchWally: (query: string) => packages.search(query),
  wallyPackage: (id: string) => packages.metadata(id),
  listWallyDeps: () => packages.listDeps(),
  addWallyDep: (spec: WallyAddSpec) => packages.addDep(spec),
  removeWallyDep: (alias: string, realm: WallyRealm) => packages.removeDep(alias, realm),
  updateWallyDep: (alias: string, realm: WallyRealm, version?: string) => packages.updateDep(alias, realm, version),
  listRokitTools: () => packages.listTools(),
  addRokitTool: (repo: string, version?: string) => packages.addTool(repo, version),
  updateRokitTool: (name: string) => packages.updateTool(name),
  curatedTools: () => packages.curated()
}

for (const [name, handler] of Object.entries(handlers)) {
  ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => handler(...args))
}
for (const [name, handler] of Object.entries(integrations.handlers)) {
  if (name in handlers) throw new Error(`duplicate IPC handler ${name}`)
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
    title: 'RBX Forge',
    // Windows/Linux window and taskbar icon; macOS uses the app bundle's icon.
    ...(process.platform === 'darwin' ? {} : { icon: iconPath }),
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
  installCsp()
  if (process.platform === 'darwin' && !app.isPackaged) app.dock?.setIcon(iconPath)
  createWindow()
  // Finder-launched apps miss the login shell's PATH (Homebrew, nvm, ~/.rokit/bin from .zprofile).
  // Read it before starting any tools; bounded by a 3 s timeout.
  if (process.platform === 'darwin') await loadLoginShellPath().catch(() => null)
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
  integrations.dispose()
  lsp.dispose()
  closeProject()
    .catch(() => undefined)
    .finally(() => app.quit())
})

process.on('exit', () => {
  lsp.dispose()
  supervisor.killAllSync()
})
