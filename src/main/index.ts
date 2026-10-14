import { app, BrowserWindow, dialog, ipcMain, safeStorage, session, shell, systemPreferences } from 'electron'
import { existsSync, statSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import {
  INVOKE_PREFIX,
  type BlinkModel,
  type GitStatus,
  type HarnessEvents,
  type LogLine,
  type PlaceInfo,
  type AppSettings,
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
import { artElectronDeps } from './services/art/electron.ts'
import { findTool, loadLoginShellPath, run } from './services/tools.ts'
import iconPath from '../../build/icon.png?asset'
import { PRODUCTION_CSP } from './csp.ts'
import { TerminalService } from './services/terminal/index.ts'
import { loadPtyBackend } from './services/terminal/backend.ts'
import { createSetup } from './setup.ts'
import { MemoryService } from './agent/memory/service.ts'
import { memoryHandlers } from './agent/memory/ipc.ts'
import { memoryTools, withMemoryTools } from './agent/serviceTools.ts'
import { wireBrainSync } from './agent/memory/sync/electron.ts'
import { wireUpdater } from './services/updater/electron.ts'
import { registerPackSection } from './agent/memory/sync/sections.ts'
import { createVfxWiring } from './services/vfx/wire.ts'
import { vfxElectronDeps } from './services/vfx/electron.ts'
import { uiPreviewCapture } from './services/uiPreview/electron.ts'
import { withVfxTools } from './services/vfx/tools.ts'
import { createAnimWiring } from './services/anim/wire.ts'
import { animElectronDeps } from './services/anim/electron.ts'
import { withAnimTools } from './services/anim/tools.ts'
import { createRefWiring } from './services/videoref/wire.ts'
import { refElectronDeps } from './services/videoref/electron.ts'
import { withRefTools } from './services/videoref/tools.ts'
import { createAbilityWiring } from './services/ability/wire.ts'
import { abilityElectronDeps } from './services/ability/electron.ts'
import { withAbilityTools } from './services/ability/tools.ts'
import { createUiMotionWiring } from './services/uimotion/wire.ts'
import { uiMotionElectronDeps } from './services/uimotion/electron.ts'
import { createPrincipleWiring } from './services/principles/wire.ts'
import { createGatingWiring } from './services/gating/wire.ts'
import type { LabTier } from '../shared/labModels.ts'
import { createStudioWiring } from './services/studio/wire.ts'
import { SyncEngine } from './services/sync/engine.ts'
import { loadPlaces, placeFor } from './services/sync/mapping.ts'
import { createSync } from './services/sync/wire.ts'
import { pluginsDir } from '../shared/studio/plugin.ts'
import { homedir } from 'node:os'
import { studioElectronDeps } from './services/studio/electron.ts'
import { withStudioTools } from './services/studio/tools.ts'
import { defaultChatImage } from './services/art/wire.ts'
import { createThumbsWiring } from './services/thumbs/wire.ts'
import { thumbsElectronDeps } from './services/thumbs/electron.ts'
import { createQol } from './services/qol/wire.ts'
import { createSpendWiring } from './services/spend/wire.ts'
import { createDoctorWiring } from './services/doctor/wire.ts'
import { doctorMarkdown } from '../shared/doctor/format.ts'
import { createAddToGameWiring } from './services/addToGame/wire.ts'

// Name and data folder. The data folder stays "rbx-forge" (what development builds have always
// used), so settings, the stored API key and the luau-lsp cache carry over to the installed app.
app.setName('RBX Forge')
app.setPath('userData', join(app.getPath('appData'), 'rbx-forge'))
// Windows shows toast notifications only for the AppUserModelID of a Start menu shortcut: the
// installer's shortcut carries appId (electron-builder.yml). Without this, "run finished"
// notifications silently never appear on Windows.
if (process.platform === 'win32') app.setAppUserModelId(app.isPackaged ? 'com.acidgorgon.rbxforge' : process.execPath)

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

// Quality of life (services/qol): sees every event for done notifications and the away digest.
let qolObserve: ((event: string, payload: unknown) => void) | null = null
function emit<K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]): void {
  qolObserve?.(event, payload)
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

// Integrated terminal (node-pty), bottom panel + the main chat's run_in_terminal.
const terminal = new TerminalService({
  backend: loadPtyBackend,
  root: () => project?.info.root ?? null,
  emit,
  getSetting: (key, fallback) => settings.get(key, fallback),
  setSetting: (key, value) => settings.set(key, value),
  log: (text) => logs.push({ service: 'harness', stream: 'info', text })
})

// First-run toolchain (bundled rokit + global tools), per-project rokit install, New project.
const setup = createSetup({
  settings,
  emit,
  log: (line) => logs.push(line),
  resourcesPath: app.isPackaged ? process.resourcesPath : null,
  devRoot: app.getAppPath(),
  homeDir: app.getPath('home'),
  chooseFolder: async (title, defaultPath) => {
    const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const options: Electron.OpenDialogOptions = { title, defaultPath, properties: ['openDirectory', 'createDirectory'] }
    const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
    return picked.canceled ? null : (picked.filePaths[0] ?? null)
  },
  // Freshly installed tools are found on the next lookup (tools.ts searches ~/.rokit/bin first);
  // services that gave up as "missing" start again.
  onToolsInstalled: () => {
    for (const s of supervisor.statuses()) if (s.state === 'missing') void supervisor.start(s.id).catch(() => undefined)
  }
})

// Adaptive memory + skills for the agents (user memory in userData/memory, project memory in
// .forge/memory), the Memory page and reflection proposals (agent/memory).
const memory = new MemoryService({
  userDir: join(app.getPath('userData'), 'memory'),
  projectRoot: () => project?.info.root ?? null,
  getSetting: (key, fallback) => settings.get(key, fallback),
  setSetting: (key, value) => settings.set(key, value),
  emit: (event, payload) => {
    emit(event, payload as never)
    if (event === 'memory:changed') brainSync.onMemoryChanged()
  },
  log: (text, stream = 'info') => logs.push({ service: 'agent', stream, text })
})
// .forgepack export/import and optional device sync of user memory + skills (agent/memory/sync).
const brainSync = wireBrainSync({
  memory,
  userData: app.getPath('userData'),
  version: app.getVersion(),
  settings,
  emitStatus: (status) => emit('brainsync:status', status),
  emitMemoryChanged: () => emit('memory:changed', { at: Date.now() }),
  log: (text, stream = 'info') => logs.push({ service: 'agent', stream, text })
})
const memoryToolSets = memoryTools(memory)

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

function appSettings(): AppSettings {
  return {
    serveAllPlaces: settings.get<boolean>('serveAllPlaces', false) === true,
    autoRoute: settings.get<boolean>('autoRoute', true) !== false
  }
}

function harnessLog(text: string, stream: LogLine['stream'] = 'info'): void {
  logs.push({ service: 'harness', stream, text })
}

function requireProject(): Project {
  if (!project) throw new Error('No project open')
  return project
}

async function closeProject(): Promise<void> {
  if (project) await qol.service.onProjectClose()
  terminal.onProjectClose()
  integrations.onProjectClose()
  project?.close()
  conflicts?.close()
  forgeSync.onProjectClose()
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
  // Game tab: Studio-only instances from Forge Sync's live tree (Forge Bridge), else tree.json.
  opened.setLiveStudio((file) => forgeSync.liveTree(file))
  settings.setLastProject(full)
  harnessLog(`opened ${full}`)
  // Before project:changed reaches the renderer: its "since you were away" request (3.5 s later)
  // must not run against the previous project's last-seen state while sync and services start.
  await qol.service.onProjectOpen(full).catch(() => undefined)

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
    if (change.places) {
      applyPlace(opened)
      forgeSync.onPlacesChanged()
    }
    void git?.refresh()
  })

  // Forge Sync guard: a pull / branch switch first commits (or warns about) uncommitted Studio edits.
  git = forgeSync.guardGit(
    new GitSync({
      root: full,
      settings: syncSettings,
      onStatus: (status) => emit('git:status', status),
      log: (text, stream = 'info') => logs.push({ service: 'git', stream, text })
    }),
    () => syncSettings().autoCommit
  )
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
  // The project's studio-sync.py conflicts; with Forge Sync on, Forge Sync reports conflicts instead.
  conflicts.watch((list) => {
    if (forgeSync.studioConflicts() === null) emit('studio:conflicts', list)
  })

  emit('project:changed', opened.info)
  emit('tree:changed', opened.tree)
  emit('scripts:changed', opened.scripts)
  // Live Studio instances -> luau-lsp ($/plugin/full), for DataModel autocomplete.
  lsp.setDataModel(opened.tree)

  await supervisor.setRoot(full)
  applyPlace(opened, false)
  await forgeSync.onProjectOpen(full)
  void lsp.setRoot(full).catch((error) => harnessLog(`luau-lsp: ${error}`, 'stderr'))
  void supervisor.startAll().catch((error) => harnessLog(`start services: ${error}`, 'stderr'))
  await integrations.onProjectOpen(full).catch((error) => harnessLog(`integrations: ${error}`, 'stderr'))
  setup.onProjectOpen(full)
  void memory.onProjectOpen()
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
  studioConflicts: async () => forgeSync.studioConflicts() ?? (conflicts ? conflicts.list() : []),
  resolveStudioConflict: async (path, take, placeKey?: string) => {
    if (forgeSync.studioConflicts() !== null) return forgeSync.resolveStudioConflict(path, take, placeKey)
    if (!conflicts) throw new Error('No project open')
    await conflicts.resolve(path, take)
    emit('studio:conflicts', await conflicts.list())
  },

  getSetting: (key, fallback) => settings.get(key, fallback),
  setSetting: (key, value) => settings.set(key, value),

  emit,
  log: (line) => logs.push(line),

  serviceTools: () => ({ ...withStudioTools(withAbilityTools(withRefTools(withAnimTools(withVfxTools(withMemoryTools(integrations.serviceTools(), memoryToolSets), vfx.tools()), anim.tools()), refs.tools()), ability.tools()), studio.tools()), chat: terminal.chatTools() }),
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
  studioConflicts: async () => forgeSync.studioConflicts() ?? (conflicts ? conflicts.list() : []),
  pauseProjectWatch: () => project?.pause(),
  resumeProjectWatch: () => project?.resume(),
  services: () => supervisor.statuses(),
  startService: (id) => supervisor.start(id),
  stopService: (id) => supervisor.stop(id),
  openExternal: (url) => void shell.openExternal(url),
  summarize: (prompt) => agentIpc.summarize(prompt),
  art: artElectronDeps(),
  // UI Preview: preview_ui screenshots through an offscreen renderer window.
  uiPreview: { capture: uiPreviewCapture(preloadPath()) },
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

// Self-update from GitHub Releases (services/updater): checks at startup and every 4 hours,
// downloads in the background and installs only when the user restarts or quits.
const updater = wireUpdater({
  isPackaged: app.isPackaged,
  version: app.getVersion(),
  platform: process.platform,
  resourcesPath: process.resourcesPath,
  execPath: process.execPath,
  settings,
  emit: (state) => emit('update:state', state),
  openExternal: (url) => void shell.openExternal(url),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text })
})

// Studio check (services/studio): the Forge Bridge plugin plays lab items in the user's Roblox Studio
// and Forge records the Studio window at the key beats. Created before the labs because their render
// step goes through it ("critique in Studio when connected"); it reaches the labs lazily.
const vfxElectron = vfxElectronDeps(preloadPath())
const animElectron = animElectronDeps(preloadPath())
const abilityElectron = abilityElectronDeps(preloadPath())
const studio = createStudioWiring({
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[studio] ${text}` }),
  labs: () => ({ vfx: vfx.service, anim: anim.service, ability: ability.service }),
  previews: { vfx: vfxElectron.capture, anim: animElectron.capture, ability: abilityElectron.capture },
  rojo: () => (supervisor.statuses().some((s) => s.id === 'rojo' && (s.state === 'running' || s.state === 'starting')) ? 'running' : 'stopped'),
  chatImage: defaultChatImage,
  ...studioElectronDeps(preloadPath())
})

// Forge Sync (services/sync): Studio -> disk through the Forge Bridge plugin, reconciled per place
// before rojo serve may run for it (supervisor gate). Studio conflicts, git-pull guard, legacy plugin.
const forgeSync = createSync({
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[sync] ${text}` }),
  supervisor,
  pluginsDir: () => pluginsDir({ platform: process.platform, env: process.env, home: homedir() }),
  studio: () => {
    const info = studio.bridge.studio()
    return info ? { placeId: info.placeId, connected: studio.bridge.connected() } : null
  },
  engine: (root) => new SyncEngine({ root }),
  mapping: { loadPlaces, placeFor },
  activePlace: () => project?.activePlace ?? null,
  onStudioTree: () => project?.studioChanged()
})
studio.bridge.setSyncHandler(forgeSync.handler)
// Lab gating (services/gating): code gates before big-model calls in the labs (skip the critic,
// early stop, retry routes), learned decision models, shadow mode, and cost per kept result.
const gating = createGatingWiring({
  userDataDir: app.getPath('userData'),
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[gating] ${text}` })
})
// The labs' model calls, with each call's tokens + cost charged to the current lab run.
const labModel = (tier: LabTier) => (system: string, prompt: string, images: Parameters<typeof agentIpc.vision>[2]) =>
  agentIpc.vision(system, prompt, images, { tier, onUsage: (u) => void gating.service.charge(tier, u) })

// Principle priorities (services/principles): per-principle weights learned from Labs ratings; the
// VFX Lab, Animation Lab and Ability Composer critics weigh their principle scores by them.
const principles = createPrincipleWiring({
  gate: gating.service,
  userDataDir: app.getPath('userData'),
  memory,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[principles] ${text}` })
})
registerPackSection({ id: 'principles', label: 'Principle priorities', dir: () => principles.service.dir })

// VFX Lab (services/vfx): reference library, recipes as memory skills, offscreen three.js renders and
// the render / critique / refine loop (critique on the default model through the agent layer).
const vfx = createVfxWiring({
  principles: principles.service,
  userDataDir: app.getPath('userData'),
  root: () => project?.info.root ?? null,
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[vfx] ${text}` }),
  memory,
  vision: (tier) => labModel(tier ?? 'default'),
  gate: gating.service,
  rojo: {
    running: () => supervisor.statuses().some((s) => s.id === 'rojo' && (s.state === 'running' || s.state === 'starting')),
    start: () => supervisor.start('rojo')
  },
  chatImage: defaultChatImage,
  images: integrations.images,
  openCloud: integrations.openCloud,
  ...vfxElectron,
  capture: studio.wrap.vfx(vfxElectron.capture)
})
// The user VFX library rides along in .forgepack export/import and device sync (one folder per entry).
registerPackSection({ id: 'vfx', label: 'VFX library', dir: () => vfx.service.userLibraryDir })
registerPackSection({ id: 'vfx-textures', label: 'VFX textures', dir: () => vfx.textures.userLibraryDir })

// Animation Lab (services/anim): clip library, style profiles as memory skills, timeline scripts and
// the render / critique / refine loop. Models per Labs tier (Settings > Labs) through the agent layer.
const anim = createAnimWiring({
  principles: principles.service,
  userDataDir: app.getPath('userData'),
  root: () => project?.info.root ?? null,
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[anim] ${text}` }),
  memory,
  model: (tier) => labModel(tier),
  gate: gating.service,
  openCloud: integrations.openCloud,
  ...animElectron,
  capture: studio.wrap.anim(animElectron.capture)
})
// The user animation library rides along in .forgepack export/import and device sync.
registerPackSection({ id: 'anim', label: 'Animation library', dir: () => anim.service.userLibraryDir })

// Video references (services/videoref): clips / GIFs decoded in the renderer, analysed in shared code
// and stored as 'media' entries in the VFX / Animation libraries (so they ride along in the packs
// above); the vision summary runs on the Labs critic tier.
const refs = createRefWiring({
  vfx: vfx.service,
  anim: anim.service,
  model: (tier) => (system, prompt, images) => agentIpc.vision(system, prompt, images, { tier }),
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[ref] ${text}` }),
  chatImage: defaultChatImage,
  ...refElectronDeps(preloadPath())
})

// Ability Composer (services/ability): moves that reference VFX Lab effects and Animation Lab clips by
// id; compose uses vfx_compose / anim_compose from the tool registry when they exist.
const ability = createAbilityWiring({
  principles: principles.service,
  userDataDir: app.getPath('userData'),
  root: () => project?.info.root ?? null,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[ability] ${text}` }),
  memory,
  model: (tier) => labModel(tier),
  gate: gating.service,
  vfx: { get: (id) => vfx.service.get(id), list: () => vfx.service.list(), search: (q, o) => vfx.service.search(q, o), addExample: (k) => vfx.service.addExample(k), writeProjectFiles: (e) => vfx.service.writeProjectFiles(e) },
  anim: () => anim.service.listAnimClips(),
  tools: () => {
    const sets = ctx.serviceTools?.()
    return sets ? [...sets.read, ...sets.write] : []
  },
  lune: async () => (await vfx.service.status()).lune.available,
  ...abilityElectron,
  capture: studio.wrap.ability(abilityElectron.capture)
})
registerPackSection({ id: 'abilities', label: 'Ability library', dir: () => ability.service.userLibraryDir })

// Thumbnail Lab (services/thumbs): reference thumbnails -> style profiles, base images from the game
// (files or a Studio capture through the Forge Bridge), OpenAI variations through the Art page's key
// and budget, the thumbnail critic, ratings / CTR that teach taste, and the Open Cloud upload.
const thumbs = createThumbsWiring({
  userDataDir: app.getPath('userData'),
  root: () => project?.info.root ?? null,
  gameName: () => project?.info.name,
  settings,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[thumbs] ${text}` }),
  memory,
  principles: principles.service,
  vision: (tier) => labModel(tier),
  images: integrations.images,
  openCloud: integrations.openCloud,
  studio: {
    snapshot: () => studio.service.snapshot(),
    status: async () => {
      const s = await studio.service.status()
      return { connected: s.studio.connected, message: s.message }
    }
  },
  // Image spend counts in the Labs cost-per-kept table (default tier: it is the "compose" step).
  chargeImage: (usd) => void gating.service.charge('default', { input: 0, output: 0, costUsd: usd }),
  ...thumbsElectronDeps()
})
registerPackSection({ id: 'thumbs', label: 'Thumbnail Lab library', dir: () => thumbs.service.userLibraryDir })
// Quality of life (services/qol): bug reports, done notifications, session restore, away digest.
const qol = createQol({
  userDataDir: app.getPath('userData'),
  getSetting: (key, fallback) => settings.get(key, fallback),
  setSetting: (key, value) => settings.set(key, value),
  logs: () => logs.get(),
  root: () => project?.info.root ?? null,
  projectName: () => project?.info.name,
  emit: (event, payload) => emit(event as keyof HarnessEvents, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text }),
  git: (args, cwd) => run(findTool('git') || 'git', args, cwd),
  syncStatus: async () => (await forgeSync.handlers.syncStatus()) as never,
  studioConflicts: () => ctx.studioConflicts(),
  gitStatus: async () => (git ? git.status() : null),
  testsLast: async () => (await integrations.handlers.testsLast()) as never
})
qolObserve = (event, payload) => qol.service.observe(event, payload)
// qol-c: spending cap (userData/spend.json; every AI call is charged and checked), Forge Doctor
// (Help menu, palette, Settings) and "Add to game" (VFX / Animation / Ability labs, adapters for more).
const spend = createSpendWiring({
  userDataDir: app.getPath('userData'),
  emit: (event, payload) => emit(event, payload as never),
  log: (text) => logs.push({ service: 'harness', stream: 'info', text: `[spend] ${text}` })
})
const doctor = createDoctorWiring({
  platform: process.platform,
  appVersion: app.getVersion(),
  isPackaged: app.isPackaged,
  userDataDir: app.getPath('userData'),
  homeDir: homedir(),
  env: process.env,
  projectRoot: () => project?.info.root ?? null,
  places: () => project?.listPlaces() ?? [],
  serveAllPlaces: () => appSettings().serveAllPlaces,
  activePlace: () => project?.getActivePlace()?.file ?? null,
  services: () => supervisor.statuses(),
  toolchainStatus: () => setup.handlers.toolchainStatus() as never,
  toolchainRepair: () => Promise.resolve(setup.handlers.toolchainSetup({ mode: 'repair' })),
  installProjectTools: (root) => setup.onProjectOpen(root),
  studioStatus: () => studio.service.status(),
  installPlugin: () => studio.service.installPlugin(),
  pluginsDir: () => pluginsDir({ platform: process.platform, env: process.env, home: homedir() }),
  syncStatus: () => forgeSync.handlers.syncStatus() as never,
  disableLegacyPlugins: () => Promise.resolve(forgeSync.handlers.syncDisableLegacyPlugin()),
  providers: () => agentIpc.providers(),
  defaultProvider: () => agentIpc.defaultProvider(),
  openCloudKey: () => integrations.openCloud.key(),
  openAiKey: () => integrations.images.openAiKey(),
  updateState: () => updater.handlers.updateGetState() as never,
  updateCheck: () => Promise.resolve(updater.handlers.updateCheck()),
  startRojo: () => supervisor.start('rojo'),
  screenRecording: () => (process.platform === 'darwin' ? (systemPreferences.getMediaAccessStatus('screen') as 'granted') : null),
  openExternal: (url) => void shell.openExternal(url),
  emit: (report) => emit('doctor:report', report)
})
const addToGame = createAddToGameWiring({
  root: () => project?.info.root ?? null,
  settings,
  log: (text) => logs.push({ service: 'harness', stream: 'info', text: `[add to game] ${text}` }),
  vfx: vfx.service,
  textures: vfx.textures,
  anim: anim.service,
  ability: ability.service
})
const qolcHandlers = { ...doctor.handlers, ...spend.handlers, ...addToGame.handlers }
// Bug reports carry a Forge Doctor section (home folder shown as ~).
qol.service.setBugReportExtra(async () => doctorMarkdown(await doctor.service.run(), { home: homedir() }))
// UI Motion Lab (services/uimotion): Figma imports (plugin JSON or a link; the token lives in the
// encrypted secret store) and effect stacks compiled to client Luau modules.
const uiMotion = createUiMotionWiring({
  principles: principles.service,
  userDataDir: app.getPath('userData'),
  root: () => project?.info.root ?? null,
  projectFile: () => project?.activePlace ?? null,
  emit: (event, payload) => emit(event, payload as never),
  log: (text, stream = 'info') => logs.push({ service: 'harness', stream, text: `[uimotion] ${text}` }),
  memory,
  model: (tier) => labModel(tier),
  gate: gating.service,
  secrets: integrations.secrets,
  lune: async () => (await vfx.service.status()).lune.available,
  ...uiMotionElectronDeps()
})
registerPackSection({ id: 'uimotion', label: 'UI motion library', dir: () => uiMotion.service.userLibraryDir })

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
  resolveStudioConflict: (path: string, take: 'studio' | 'repo', placeKey?: string) => ctx.resolveStudioConflict(path, take, placeKey),

  getBlink: () => blink?.model ?? EMPTY_BLINK,
  lspStart: () => lsp.start(),

  listPlaces: () => project?.listPlaces() ?? [],
  getActivePlace: () => project?.getActivePlace() ?? null,
  setActivePlace: (file: string) => setActivePlace(file),
  getAppSettings: () => appSettings(),
  setAppSettings: async (patch: Partial<AppSettings>) => {
    const before = appSettings()
    if (typeof patch.serveAllPlaces === 'boolean') settings.set('serveAllPlaces', patch.serveAllPlaces)
    if (typeof patch.autoRoute === 'boolean') settings.set('autoRoute', patch.autoRoute)
    const after = appSettings()
    // rojo's job list depends on serveAllPlaces; restart a running rojo so it serves the new set.
    const rojo = supervisor.statuses().find((s) => s.id === 'rojo')
    if (before.serveAllPlaces !== after.serveAllPlaces && rojo && (rojo.state === 'running' || rojo.state === 'starting')) {
      await supervisor.restart('rojo').catch((error) => harnessLog(`rojo restart: ${error}`, 'stderr'))
    }
    return after
  },

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
// Long lab / build calls notify when they finish (services/qol).
const timed = (name: string, handler: (...args: any[]) => unknown) => qol.service.timed(name, handler)
for (const [name, handler] of Object.entries({ ...integrations.handlers, ...terminal.handlers(), ...setup.handlers, ...memoryHandlers(memory), ...brainSync.handlers, ...updater.handlers, ...gating.wrap('vfx', vfx.handlers), ...gating.wrap('anim', anim.handlers), ...studio.handlers, ...refs.handlers, ...principles.handlers, ...gating.handlers, ...forgeSync.handlers, ...qol.handlers, ...qolcHandlers })) {
  if (name in handlers) throw new Error(`duplicate IPC handler ${name}`)
  const fn = timed(name, handler)
  ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => fn(...args))
}
for (const [name, handler] of Object.entries({ ...gating.wrap('ability', ability.handlers), ...gating.wrap('thumbs', thumbs.handlers), ...gating.wrap('uimotion', uiMotion.handlers) })) {
  if (name in handlers) throw new Error(`duplicate IPC handler ${name}`)
  const fn = timed(name, handler)
  ipcMain.handle(INVOKE_PREFIX + name, (_event, ...args) => fn(...args))
}
ipcMain.on(INVOKE_PREFIX + 'lspSend', (_event, message: unknown) => lsp.send(message))
// Caption-button overlay colours follow the renderer theme (Windows/Linux only).
ipcMain.on('forge:titlebarTheme', (event, theme: unknown) => {
  if (process.platform === 'darwin') return
  const win = BrowserWindow.fromWebContents(event.sender)
  const light = theme === 'light'
  try {
    win?.setTitleBarOverlay?.({ color: light ? '#e4e7eb' : '#0c0e11', symbolColor: light ? '#3c434d' : '#b0b7c2', height: 38 })
  } catch {
    // "Titlebar overlay is not enabled" (Linux without window-controls overlay, e.g. no compositor):
    // nothing to recolour, and an uncaught throw here would surface as a main-process error.
  }
  win?.setBackgroundColor(light ? '#e4e7eb' : '#0c0e11')
})
const agentIpc = registerAgentIpc(ctx, ipcMain, { memory, userDataDir: app.getPath('userData'), gating: async () => (await gating.service.view()).costs })

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
    minWidth: 1024,
    minHeight: 640,
    show: false,
    backgroundColor: '#0c0e11',
    title: 'RBX Forge',
    // Windows/Linux window and taskbar icon; macOS uses the app bundle's icon.
    ...(process.platform === 'darwin' ? {} : { icon: iconPath }),
    // The renderer draws its own 38px titlebar: macOS keeps the traffic lights inset, Windows/Linux
    // get the native caption buttons as an overlay (the titlebar leaves room via titlebar-area env()).
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    ...(process.platform === 'darwin' ? {} : { titleBarOverlay: { color: '#0c0e11', symbolColor: '#b0b7c2', height: 38 } }),
    webPreferences: {
      preload: preloadPath(),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })
  window.once('ready-to-show', () => window.show())
  // Links (PR URLs, docs) open in the browser, never in a new Electron window.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
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
  updater.start()
  brainSync.start()
  void studio.start()
  // Studio's Roblox folder (the plugins folder's parent) exists only where Studio is installed.
  void studio.service
    .ensurePlugin((dir) => existsSync(dirname(dir)))
    .then((done) => done && emit('studio:pluginAuto', { action: done }))
    .catch((error) => harnessLog(`studio: could not install the Forge Bridge plugin: ${error}`, 'stderr'))
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
  terminal.dispose()
  setup.dispose()
  memory.dispose()
  brainSync.dispose()
  updater.dispose()
  void spend.dispose()
  vfx.service.dispose()
  anim.service.dispose()
  void studio.dispose()
  lsp.dispose()
  closeProject()
    .catch(() => undefined)
    .finally(() => app.quit())
})

process.on('exit', () => {
  terminal.dispose()
  lsp.dispose()
  supervisor.killAllSync()
})
