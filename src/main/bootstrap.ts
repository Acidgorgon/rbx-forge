// Main-process entry (package.json "main" -> out/main/index.js). It stays in the installed app and is
// never replaced by a quick update: it picks which app code to run, then loads it.
//
// - The installed app's own code: out/main/app.js next to this file (src/main/index.ts).
// - A quick update: userData/code/<version>/main/app.js, when services/quick/boot.ts finds a version
//   that is newer than the installed app, not marked bad, fits its Electron and packages, and still
//   verifies (signature with the key built into this file's app, sha256 of every file).
//
// Before loading a quick version it sets a "booting" marker that the app clears once its window has
// loaded (services/quick/electron.ts watchBoot). If that never happens the next launch marks the
// version bad and runs the installed code. A quick version that throws while loading is marked bad
// at once and Forge relaunches. Nothing here writes to the install folder or the app bundle.
import { app } from 'electron'
import Module, { createRequire } from 'node:module'
import { delimiter, join } from 'node:path'
import { ENTRY, planBoot, removeDirs, STATE_FILE, type BootPlan } from './services/quick/boot.ts'
import { finishBoot, markBad, updateCodeState } from './services/quick/codeState.ts'
import { QUICK_UPDATE_PUBLIC_KEY } from './services/quick/publicKey.ts'
import { setBootInfo, type ForgeBoot } from './services/quick/runtime.ts'

const log = (line: string): void => console.log(`[forge boot] ${line}`)
// A quick version must have shown its window by then, or it counts as broken.
const BOOT_WATCHDOG_MS = 120_000

// Same name and data folder as src/main/index.ts (the single-instance lock is keyed on userData).
app.setName('RBX Forge')
app.setPath('userData', join(app.getPath('appData'), 'rbx-forge'))
// Only the first instance touches userData/code; a second launch just focuses the first window
// (index.ts handles 'second-instance').
if (!app.requestSingleInstanceLock()) {
  app.quit()
  process.exit(0)
}

const appVersion = app.getVersion()
const codeRoot = join(app.getPath('userData'), 'code')
const stateFile = join(codeRoot, STATE_FILE)
// Test hook for test/e2e-app/quick.ts (FORGE_QUICK_DEV, FORGE_QUICK_FEED, FORGE_QUICK_TEST_KEY): only
// an unpackaged build (running from a source checkout) honours it.
const devTest = !app.isPackaged && process.env.FORGE_QUICK_DEV === '1'
const initPaths = (Module as unknown as { _initPaths?: () => void })._initPaths
// The test also brings its own key; a packaged app only ever trusts the key built into it.
const publicKey = devTest && process.env.FORGE_QUICK_TEST_KEY ? process.env.FORGE_QUICK_TEST_KEY : QUICK_UPDATE_PUBLIC_KEY

let unavailable: string | undefined
if (!app.isPackaged && !devTest) unavailable = 'Development build. Quick updates run in the installed app.'
else if (process.env.ELECTRON_RENDERER_URL) unavailable = 'Development server. Quick updates run in the installed app.'
else if (!publicKey) unavailable = 'This build has no quick update key yet. Quick updates start with the next full update.'
else if (typeof initPaths !== 'function') unavailable = 'This Electron cannot load code from outside the app.'

let plan: BootPlan | null = null
if (!unavailable && !process.argv.includes('--forge-bundled-code')) {
  try {
    plan = planBoot({ codeRoot, shellVersion: appVersion, shell: __FORGE_SHELL__, publicKey, log })
  } catch (e) {
    log(`could not check quick updates: ${(e as Error).message}`)
  }
}
const choice = plan?.choice ?? null

let booted = false
const info: ForgeBoot = {
  source: choice ? 'quick' : 'bundled',
  version: choice?.version ?? appVersion,
  appVersion,
  codeRoot,
  shell: __FORGE_SHELL__,
  publicKey,
  unavailable,
  devFeed: devTest ? process.env.FORGE_QUICK_FEED : undefined,
  markBooted() {
    if (!choice || booted) return
    booted = true
    try {
      updateCodeState(stateFile, (s) => finishBoot(s, choice.version))
      log(`quick update ${choice.version} started`)
    } catch (e) {
      log(`could not clear the boot marker: ${(e as Error).message}`)
    }
  },
  markBad(reason: string) {
    if (!choice) return
    booted = true
    try {
      updateCodeState(stateFile, (s) => markBad(s, choice.version, reason, Date.now()))
      log(`quick update ${choice.version} marked bad: ${reason}`)
    } catch (e) {
      log(`could not mark ${choice.version} bad: ${(e as Error).message}`)
    }
  }
}
setBootInfo(info)

if (plan?.remove.length) {
  const dirs = plan.remove
  void app.whenReady().then(() => setTimeout(() => void removeDirs(dirs, log), 15_000))
}

function relaunchIntoInstalledCode(reason: string): void {
  info.markBad(reason)
  app.relaunch()
  app.exit(0)
}

const load = createRequire(__filename)
if (choice) {
  log(`running quick update ${choice.version} (installed app ${appVersion})`)
  // The quick code lives outside the app, so its require('zod') etc. must still find the installed
  // app's node_modules. NODE_PATH is only set while Node reads it, so child processes (terminals,
  // the agent CLI) never inherit it.
  const previous = process.env.NODE_PATH
  process.env.NODE_PATH = [join(app.getAppPath(), 'node_modules'), previous].filter(Boolean).join(delimiter)
  initPaths!()
  if (previous === undefined) delete process.env.NODE_PATH
  else process.env.NODE_PATH = previous
  void app.whenReady().then(() =>
    setTimeout(() => {
      if (!booted) relaunchIntoInstalledCode(`no window after ${BOOT_WATCHDOG_MS / 1000} s`)
    }, BOOT_WATCHDOG_MS)
  )
  try {
    load(join(choice.dir, ...ENTRY.split('/')))
  } catch (e) {
    log(`quick update ${choice.version} failed to load: ${(e as Error)?.stack ?? e}`)
    relaunchIntoInstalledCode(`failed to load: ${(e as Error)?.message ?? e}`)
  }
} else {
  load(join(__dirname, 'app.js'))
}
