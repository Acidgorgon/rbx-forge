// Command registry: the palette's ">" mode and the global keyboard shortcuts (SPEC §8.5, §8.7).
import type { ReactNode } from 'react'
import type { Actions, State } from '../store'
import { Icon } from '../components/Icons'
import { setMotionMode, setThemeMode } from '../theme'
import { instancePathOfFile, featuresOf, scriptsFlat, realmOfFile } from '../lib/roblox'
import { sparks } from '../lib/sparks'
import { newTerminal, requestFocus, runTask, startTerminals, termStore } from '../terminal/session'
import { requestPack } from '../pages/memory/MemoryPack'

export interface Command {
  id: string
  group: string
  label: string
  // Shortcut spec ("mod+shift+n"); also bound globally.
  keys?: string
  icon?: ReactNode
  detail?: string
  run: () => void
}

export function buildCommands(state: State, actions: Actions): Command[] {
  const h = window.harness
  const rojo = state.services.find((s) => s.id === 'rojo')
  const active = state.activeFile
  const cmds: Command[] = []
  const add = (group: string, id: string, label: string, run: () => void, extra: Partial<Command> = {}) => cmds.push({ id, group, label, run, ...extra })

  // Create
  add('Create', 'new.feature', 'New Feature…', () => actions.requestCreate('Feature'), { keys: 'mod+shift+n', icon: <Icon name="trio" />, detail: 'shared + Service + Controller' })
  add('Create', 'new.module', 'New ModuleScript…', () => actions.requestCreate('ModuleScript'), { keys: 'mod+n', icon: <Icon name="filePlus" /> })
  add('Create', 'new.script', 'New Script…', () => actions.requestCreate('Script'), { icon: <Icon name="filePlus" /> })
  add('Create', 'new.local', 'New LocalScript…', () => actions.requestCreate('LocalScript'), { icon: <Icon name="filePlus" /> })
  add('Create', 'new.folder', 'New Folder…', () => actions.requestCreate('Folder'), { icon: <Icon name="folderPlus" /> })
  add('Create', 'new.blink', 'New Blink event…', () => actions.requestCreate('Blink'), { icon: <Icon name="bolt" />, detail: 'appends to events.blink' })
  add('Create', 'feature.rename', 'Rename Feature…', () => actions.openDialog({ kind: 'renameFeature' }), { icon: <Icon name="pencil" />, detail: 'renames the shared, Service and Controller trio' })

  // Services
  add('Services', 'rojo.restart', rojo?.state === 'running' ? 'Restart Rojo' : 'Start Rojo', () => void (rojo?.state === 'running' ? h.restartService('rojo') : h.startService('rojo')), { keys: 'mod+shift+r', icon: <Icon name="play" /> })
  add('Services', 'rojo.stop', 'Stop Rojo', () => void h.stopService('rojo'), { icon: <Icon name="stop" /> })
  add('Services', 'dev.restart', 'Restart dev watcher', () => void actions.restartService('dev'), { icon: <Icon name="restart" /> })
  add('Services', 'lsp.restart', 'Restart Luau LSP', () => void actions.restartService('lsp'), { icon: <Icon name="restart" /> })
  add('Services', 'studio.restart', 'Reconnect Studio Sync', () => void actions.restartService('studioSync'), { icon: <Icon name="studio" /> })
  add('Services', 'lint.run', 'Run lint (selene + StyLua)', () => void actions.runLint(), { icon: <Icon name="check" /> })
  add('Services', 'output.show', 'Show Output', () => actions.showBottom('output', []), { icon: <Icon name="terminal" /> })
  add('Services', 'problems.show', 'Show Problems', () => actions.showBottom('problems'), { icon: <Icon name="warn" /> })

  // Terminal (terminal/session.ts)
  startTerminals()
  add('Terminal', 'terminal.toggle', 'Toggle terminal', () => {
    const open = state.layout.bottomOpen && state.layout.bottomTab === 'shell'
    actions.toggleBottom('shell')
    if (!open) requestFocus()
  }, { keys: 'ctrl+`', icon: <Icon name="terminal" /> })
  add('Terminal', 'terminal.new', 'New terminal', () => {
    actions.showBottom('shell')
    void newTerminal()
  }, { keys: 'ctrl+shift+`', icon: <Icon name="plus" />, detail: 'project root · Rokit tools on PATH' })
  add('Terminal', 'terminal.task', 'Run task…', () => actions.openPalette('>Run task: '), { icon: <Icon name="play" />, detail: './dev · ./check · rojo · wally · lune' })
  for (const t of termStore.get().tasks) {
    add('Terminal', `terminal.task.${t.id}`, `Run task: ${t.label}`, () => {
      actions.showBottom('shell')
      void runTask(t.id)
    }, { icon: <Icon name="play" />, detail: t.command === t.label ? t.detail : t.command })
  }

  // Places
  for (const p of state.places) {
    if (p.file === state.activePlace) continue
    add('Places', `place.${p.file}`, `Switch place: ${p.name}`, () => void actions.setActivePlace(p.file), { icon: <Icon name="flag" />, detail: `${p.file} · :${p.servePort}` })
  }
  if (state.places.length > 1 && state.appSettings) {
    const on = state.appSettings.serveAllPlaces
    add('Places', 'place.serveAll', on ? 'Serve only the active place' : 'Serve all places', () => void actions.setAppSettings({ serveAllPlaces: !on }), { icon: <Icon name="flag" /> })
  }

  // Sync
  add('Sync', 'sync.now', 'Sync with collaborators', () => {
    void h.syncNow().then((git) => actions.set({ git })).catch((e) => actions.toast({ text: 'Sync failed', detail: String(e?.message ?? e), kind: 'err' }))
  }, { keys: 'mod+shift+s', icon: <Icon name="sync" /> })
  if (state.studioConflicts.length) add('Sync', 'sync.conflict', 'Resolve next Studio conflict', () => actions.openConflict(state.studioConflicts[0].path), { icon: <Icon name="diff" />, detail: state.studioConflicts[0].path })
  add('Sync', 'branch.start', 'Start feature branch…', () => actions.openDialog({ kind: 'featureBranch' }), { icon: <Icon name="branch" /> })
  add('Sync', 'pr.open', 'Open pull request…', () => actions.openDialog({ kind: 'pullRequest' }), { icon: <Icon name="pr" /> })
  add('Sync', 'join', 'Join a project…', () => actions.openDialog({ kind: 'joinProject' }), { icon: <Icon name="team" />, detail: 'clone · rokit · wally' })
  add('Sync', 'project.new', 'New project…', () => actions.openDialog({ kind: 'newProject' }), { icon: <Icon name="folderPlus" />, detail: 'GenTree or empty Rojo · git · rokit' })
  add('Sync', 'project.open', 'Open folder…', () => void actions.openProject(), { keys: 'mod+o', icon: <Icon name="folder" /> })

  // Navigate
  add('Navigate', 'go.file', 'Go to file…', () => actions.openPalette(''), { keys: 'mod+p', icon: <Icon name="files" /> })
  add('Navigate', 'go.instance', 'Go to instance…', () => actions.openPalette('#'), { icon: <Icon name="tree" /> })
  add('Navigate', 'go.line', 'Go to line…', () => actions.openPalette(':'), { keys: 'ctrl+g', icon: <Icon name="arrowRight" /> })
  add('Navigate', 'forge', 'Open Forge tab', () => actions.openPage('forge'), { keys: 'mod+shift+h', icon: <Icon name="hammer" /> })
  add('Navigate', 'toolchain', 'Toolchain: install or repair tools', () => (actions.openPage('settings'), setTimeout(() => document.getElementById('set-toolchain')?.scrollIntoView({ block: 'start' }), 80)), { icon: <Icon name="tool" />, detail: 'rokit · rojo · wally · lune · luau-lsp…' })
  add('Navigate', 'settings', 'Open Settings', () => actions.openPage('settings'), { keys: 'mod+comma', icon: <Icon name="gear" /> })
  add('Navigate', 'packages', 'Open Packages (Wally, Rokit)', () => actions.openPage('packages'), { icon: <Icon name="package" /> })
  add('Navigate', 'release', 'Open Release', () => actions.openPage('release'), { icon: <Icon name="rocket" /> })
  add('Navigate', 'analytics', 'Open Analytics', () => actions.openPage('analytics'), { icon: <Icon name="chart" /> })
  add('Navigate', 'art', 'Open Art (image concepts)', () => actions.openPage('art'), { icon: <Icon name="image" /> })
  add('Navigate', 'anim', 'Open Animation Lab', () => actions.openPage('anim'), { icon: <Icon name="figure" />, detail: 'R15 animations · library · make & refine' })
  add('Navigate', 'vfx', 'Open VFX Lab', () => actions.openPage('vfx'), { icon: <Icon name="sparkle" />, detail: 'particle effects · library · make & refine' })
  add('Navigate', 'ability', 'Open Ability Composer', () => actions.openPage('ability'), { icon: <Icon name="bolt" />, detail: 'moves · animation + VFX + shake + hit-stop on one timeline' })
  add('Navigate', 'thumbs', 'Open Thumbnail Lab', () => actions.openPage('thumbs'), { icon: <Icon name="thumbnail" />, detail: 'experience thumbnails · style profiles · CTR' })
  add('Navigate', 'uipreview', 'Open UI Preview (UI Labs stories)', () => actions.openPage('uipreview'), { icon: <Icon name="monitor" /> })
  add('Navigate', 'memory', 'Open Memory & skills', () => actions.openPage('memory'), { icon: <Icon name="memory" /> })
  // Memory export/import and device sync (pages/memory/MemoryPack.tsx).
  add('Memory', 'memory.export', 'Export memory and skills…', () => (actions.openPage('memory'), requestPack('export')), { icon: <Icon name="download" />, detail: '.forgepack for another device' })
  add('Memory', 'memory.import', 'Import memory and skills…', () => (actions.openPage('memory'), requestPack('import')), { icon: <Icon name="upload" />, detail: 'from a .forgepack' })
  add('Memory', 'memory.sync', 'Sync memory across devices now', () => {
    void h.brainSyncNow().then((s) => {
      if (s.state === 'off') actions.toast({ text: 'Device sync is off', detail: 'Turn it on in Memory > Sync across devices.', kind: 'info' })
      else if (s.state === 'error') actions.toast({ text: s.authProblem ? 'Sync needs a git sign-in' : 'Sync failed', detail: s.lastError, kind: 'err' })
      else actions.toast({ text: 'Memory synced', detail: s.last ? `${s.last.pulled} pulled · ${s.last.pushed} pushed` : undefined, kind: 'ok', ms: 2400 })
    }).catch((e) => actions.toast({ text: 'Sync failed', detail: String(e?.message ?? e), kind: 'err' }))
  }, { icon: <Icon name="sync" /> })
  if (active) {
    add('Navigate', 'reveal', 'Reveal active file in tree', () => {
      const ip = instancePathOfFile(state.tree, active)
      if (ip) actions.revealInstance(ip)
    }, { keys: 'alt+mod+r', icon: <Icon name="reveal" /> })
    const feature = featuresOf(scriptsFlat(state.scripts)).find((f) => f.shared === active || f.service === active || f.controller === active)
    if (feature) {
      const order = [feature.service, feature.controller, feature.shared].filter((p): p is string => !!p)
      const i = order.indexOf(active)
      const next = order[(i + 1) % order.length]
      const prev = order[(i - 1 + order.length) % order.length]
      if (next && next !== active) add('Navigate', 'feature.next', `Go to ${feature.name} ${realmOfFile(next) === 'client' ? 'Controller' : realmOfFile(next) === 'server' ? 'Service' : 'shared module'}`, () => void actions.openFile(next), { keys: 'alt+mod+arrowdown', icon: <Icon name="trio" /> })
      if (prev && prev !== active && prev !== next) add('Navigate', 'feature.prev', `Go to ${feature.name} ${realmOfFile(prev) === 'client' ? 'Controller' : realmOfFile(prev) === 'server' ? 'Service' : 'shared module'}`, () => void actions.openFile(prev), { keys: 'alt+mod+arrowup', icon: <Icon name="trio" /> })
    }
  }

  // Assistant & agents
  add('Assistant', 'assistant.toggle', 'Toggle Assistant', () => actions.toggleRight(), { keys: 'mod+l', icon: <Icon name="hammer" /> })
  add('Assistant', 'assistant.new', 'New assistant thread', () => {
    actions.toggleRight(true)
    void actions.newChat()
  }, { keys: 'mod+shift+l', icon: <Icon name="plus" /> })
  if (active) add('Assistant', 'assistant.file', 'Ask Assistant about this file', () => actions.ask(`\`${active}\` `), { icon: <Icon name="at" /> })
  add('Assistant', 'tests.agents', 'Run test agents…', () => actions.showSide('tests'), { keys: 'mod+shift+a', icon: <Icon name="bot" /> })

  // Tests
  add('Tests', 'tests.all', 'Run all Lune tests', () => void actions.runTests({ scope: { kind: 'all' } }), { icon: <Icon name="flask" /> })
  if (active && /\.spec\.luau?$/.test(active)) add('Tests', 'tests.file', 'Run tests in this file', () => void actions.runTests({ scope: { kind: 'file', file: active } }), { icon: <Icon name="flask" /> })
  if (active && /\.luau?$/.test(active) && !/\.spec\.luau?$/.test(active) && !/\.(server|client)\.luau?$/.test(active)) add('Tests', 'tests.spec', 'Create spec for this module', () => void actions.createSpec(active), { icon: <Icon name="flask" /> })

  // View
  add('View', 'view.side', 'Toggle side panel', () => actions.toggleSide(), { keys: 'mod+b', icon: <Icon name="panelL" /> })
  add('View', 'view.bottom', 'Toggle bottom panel', () => actions.toggleBottom(), { keys: 'mod+j', icon: <Icon name="panelB" /> })
  add('View', 'view.explorer', 'Focus Explorer', () => actions.setLayout({ sideOpen: true, sideView: 'explorer' }), { keys: 'mod+shift+e', icon: <Icon name="tree" /> })
  add('View', 'view.scripts', 'Focus Scripts', () => actions.setLayout({ sideOpen: true, sideView: 'scripts' }), { keys: 'mod+shift+f', icon: <Icon name="script" /> })
  add('View', 'view.events', 'Focus Events (Blink)', () => actions.setLayout({ sideOpen: true, sideView: 'events' }), { keys: 'mod+shift+v', icon: <Icon name="bolt" /> })
  add('View', 'view.sync', 'Focus Source control & Sync', () => actions.setLayout({ sideOpen: true, sideView: 'sync' }), { keys: 'mod+shift+g', icon: <Icon name="branch" /> })
  add('View', 'view.tests', 'Focus Tests', () => actions.setLayout({ sideOpen: true, sideView: 'tests' }), { icon: <Icon name="flask" /> })
  add('View', 'view.team', 'Focus Team', () => actions.setLayout({ sideOpen: true, sideView: 'team' }), { icon: <Icon name="team" /> })
  add('View', 'theme.dark', 'Theme: Dark', () => setThemeMode('dark'), { icon: <Icon name="moon" /> })
  add('View', 'theme.light', 'Theme: Light', () => setThemeMode('light'), { icon: <Icon name="sun" /> })
  add('View', 'theme.system', 'Theme: System', () => setThemeMode('system'), { icon: <Icon name="monitor" /> })
  add('View', 'motion.full', 'Motion: Full', () => setMotionMode('full'), { icon: <Icon name="eye" /> })
  add('View', 'motion.reduced', 'Motion: Reduced', () => setMotionMode('reduced'), { icon: <Icon name="eye" /> })
  add('View', 'motion.off', 'Motion: Off', () => setMotionMode('off'), { icon: <Icon name="eye" /> })

  // File
  if (active) add('File', 'file.save', 'Save', () => void actions.saveFile(active), { keys: 'mod+s', icon: <Icon name="download" /> })
  add('File', 'tab.close', 'Close tab', () => actions.closeTab(state.activeTab), { keys: 'mod+w', icon: <Icon name="x" /> })
  return cmds
}

// "mod+shift+n" from a keyboard event (mod = ⌘ on macOS, Ctrl elsewhere).
export function keySpec(e: KeyboardEvent): string {
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  const parts: string[] = []
  if (e.ctrlKey && (!mac || !e.metaKey)) parts.push(mac ? 'ctrl' : 'mod')
  if (mac && e.metaKey) parts.push('mod')
  if (e.altKey) parts.push('alt')
  if (e.shiftKey) parts.push('shift')
  let key = e.key.toLowerCase()
  if (e.code.startsWith('Key')) key = e.code.slice(3).toLowerCase()
  else if (e.code.startsWith('Digit')) key = e.code.slice(5)
  else if (key === ',') key = 'comma'
  else if (key === '\\') key = 'backslash'
  else if (e.code === 'Backquote') key = '`'
  // Normalise ordering to match specs: mod, alt, shift (specs may be written alt+mod).
  return [...parts, key].join('+')
}

export function normalizeSpec(spec: string): string {
  const parts = spec.split('+')
  const key = parts.pop()!
  const order = ['ctrl', 'mod', 'alt', 'shift']
  const mac = /Mac|iPhone|iPad/.test(navigator.platform)
  // ctrl+g on Windows/Linux is mod+g.
  const mods = parts.map((p) => (p === 'ctrl' && !mac ? 'mod' : p)).sort((a, b) => order.indexOf(a) - order.indexOf(b))
  return [...mods, key].join('+')
}

export { sparks }
