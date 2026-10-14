// Electron side of self-update: picks the mode for this build, reads the feed from app-update.yml
// and hands electron-updater's autoUpdater to UpdateController (controller.ts).
//
// electron-updater 6 (GitHub provider): https://www.electron.build/v26/docs/features/auto-update
// - Windows NSIS: the downloaded installer is checked against `publisherName` from app-update.yml
//   only when electron-builder wrote one, which it does only for a signed build (NsisUpdater
//   verifySignature returns early without it). Unsigned builds update.
// - macOS: Squirrel.Mac validates the update against the running app's designated requirement;
//   ad-hoc signatures cannot satisfy it across builds, so only a Developer ID signed app installs
//   updates. Other Macs get manual mode (open the release page).
// - Linux: no Linux build is published, so updates are off there.
import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { autoUpdater } from 'electron-updater'
import type { QuickUpdateState, UpdateMode, UpdateSettings, UpdateState } from '../../../shared/updateTypes.ts'
import { UpdateController } from './controller.ts'
import { createQuickUpdater } from '../quick/electron.ts'
import type { QuickUpdater } from '../quick/updater.ts'
import { macSignatureKind, parseFeedConfig, type FeedConfig } from './util.ts'

export interface UpdaterWiringDeps {
  isPackaged: boolean
  version: string
  platform: NodeJS.Platform
  resourcesPath: string
  execPath: string
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (state: UpdateState) => void
  openExternal: (url: string) => void
  log: (text: string, stream?: 'info' | 'stderr') => void
}

function readFeed(resourcesPath: string): FeedConfig | null {
  try {
    return parseFeedConfig(readFileSync(join(resourcesPath, 'app-update.yml'), 'utf8'))
  } catch {
    return null
  }
}

function codesignOutput(appBundle: string): Promise<string> {
  return new Promise((done) => {
    execFile('/usr/bin/codesign', ['-dv', '--verbose=2', appBundle], { timeout: 5000 }, (_error, stdout, stderr) => done(`${stdout}\n${stderr}`))
  })
}

export interface UpdaterWiring {
  handlers: Record<string, (...args: any[]) => unknown>
  // First check shortly after launch, then every 4 hours (when auto-check is on).
  start(): void
  dispose(): void
}

async function createController(deps: UpdaterWiringDeps, feed: FeedConfig | null): Promise<UpdateController> {
  let mode: UpdateMode = 'install'
  let modeNote: string | undefined
  let disabledReason: string | undefined

  if (!deps.isPackaged) disabledReason = 'Development build. Updates are checked in the installed app.'
  else if (deps.platform === 'linux') disabledReason = 'No Linux build is published. Pull and rebuild from source to update.'
  else if (!feed) disabledReason = 'This build has no update feed (app-update.yml is missing).'
  else if (deps.platform === 'darwin') {
    // .../RBX Forge.app/Contents/MacOS/RBX Forge -> .../RBX Forge.app
    const kind = macSignatureKind(await codesignOutput(resolve(deps.execPath, '..', '..', '..')))
    if (kind !== 'developerId') {
      mode = 'manual'
      modeNote = 'macOS only installs updates into apps signed with an Apple Developer ID, and this build is ad-hoc signed. Forge tells you about new versions and opens the download page.'
    }
  }

  autoUpdater.logger = {
    info: (m: unknown) => deps.log(`updater: ${String(m)}`),
    warn: (m: unknown) => deps.log(`updater: ${String(m)}`, 'stderr'),
    error: (m: unknown) => deps.log(`updater: ${String(m)}`, 'stderr'),
    debug: () => undefined
  }

  return new UpdateController({
    updater: autoUpdater,
    currentVersion: deps.version,
    feed,
    mode,
    modeNote,
    disabledReason,
    settings: deps.settings,
    emit: deps.emit,
    openExternal: deps.openExternal,
    log: deps.log
  })
}

// Full updates (UpdateController over electron-updater) and quick updates (services/quick) share
// Settings > Updates: one state object, where `quick` is the quick updater's part.
export function wireUpdater(deps: UpdaterWiringDeps): UpdaterWiring {
  const feed = deps.isPackaged ? readFeed(deps.resourcesPath) : null
  let latest: UpdateState | null = null
  let quickState: QuickUpdateState | null = null
  const send = (): void => {
    if (latest) deps.emit({ ...latest, ...(quickState ? { quick: quickState } : {}) })
  }
  const withQuick = (state: UpdateState): UpdateState => ({ ...state, ...(quickState ? { quick: quickState } : {}) })
  const controllerDeps: UpdaterWiringDeps = {
    ...deps,
    emit: (state) => {
      latest = state
      send()
    }
  }
  // Created on first use (after app ready): electron-updater's autoUpdater reads the app on access.
  let created: Promise<UpdateController> | null = null
  const controller = (): Promise<UpdateController> =>
    (created ??= createController(controllerDeps, feed).then((c) => {
      latest = c.current
      return c
    }))
  let quickCreated: QuickUpdater | null = null
  const quick = (): QuickUpdater => {
    if (!quickCreated) {
      quickCreated = createQuickUpdater({
        isPackaged: deps.isPackaged,
        feed,
        settings: deps.settings,
        emit: (state) => {
          quickState = state
          send()
        },
        log: deps.log
      })
      quickState = quickCreated.current
    }
    return quickCreated
  }
  let disposed = false
  return {
    handlers: {
      updateGetState: async () => {
        quick()
        return withQuick((await controller()).current)
      },
      updateCheck: async () => {
        const c = await controller()
        await Promise.all([c.check(true), quick().check(true)])
        return withQuick(c.current)
      },
      updateSetSettings: async (patch: Partial<UpdateSettings>) => {
        const state = (await controller()).setSettings(patch ?? {})
        quick().settingsChanged()
        return withQuick(state)
      },
      updateInstall: async () => (await controller()).install(),
      updateOpenRelease: async () => (await controller()).openRelease(),
      updateQuickRestart: async () => quick().restart()
    },
    start() {
      void controller().then((c) => !disposed && c.start()).catch((error) => deps.log(`updater: ${error}`, 'stderr'))
      try {
        quick().start()
      } catch (error) {
        deps.log(`quick update: ${error}`, 'stderr')
      }
    },
    dispose() {
      disposed = true
      void created?.then((c) => c.dispose()).catch(() => undefined)
      quickCreated?.dispose()
    }
  }
}
