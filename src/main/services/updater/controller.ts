// Self-update state machine over electron-updater's AppUpdater. No electron imports: electron.ts
// passes the real autoUpdater, test/updater.test.ts a fake.
//
//   idle -> checking -> none | available -> downloading -> ready
//                    \-> error (kept with the offer when a download fails)
//
// Checks run at startup and every 4 hours while auto-check is on, plus on "Check now". In install
// mode the update downloads in the background and waits: it is installed only when the user picks
// Restart (the renderer asks first if an agent is running or an editor is dirty) or quits Forge
// (autoInstallOnAppQuit). Nothing here quits the app on its own.
import type { UpdateChannel, UpdateMode, UpdateSettings, UpdateState } from '../../../shared/updateTypes.ts'
import { classifyUpdateError, clipNotes, notesToText, releasePageUrl, type FeedConfig } from './util.ts'

// The part of electron-updater's AppUpdater this uses.
export interface UpdaterLike {
  autoDownload: boolean
  autoInstallOnAppQuit: boolean
  allowPrerelease: boolean
  allowDowngrade: boolean
  on(event: string, listener: (...args: any[]) => void): unknown
  checkForUpdates(): Promise<unknown>
  downloadUpdate(): Promise<unknown>
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void
}

export interface UpdateInfoLike {
  version: string
  releaseName?: string | null
  releaseNotes?: unknown
  releaseDate?: string
}

export const CHECK_EVERY_MS = 4 * 60 * 60 * 1000
export const FIRST_CHECK_DELAY_MS = 15 * 1000
const SETTINGS_KEY = 'updates'

export interface UpdateControllerDeps {
  updater: UpdaterLike
  currentVersion: string
  feed: FeedConfig | null
  mode: UpdateMode
  // Set when this build cannot update at all (development build, Linux).
  disabledReason?: string
  // Why mode is manual, shown in Settings.
  modeNote?: string
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (state: UpdateState) => void
  openExternal: (url: string) => void
  log: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  setRepeat?: (fn: () => void, ms: number) => unknown
  clearRepeat?: (handle: unknown) => void
}

export class UpdateController {
  private state: UpdateState
  private readonly deps: UpdateControllerDeps
  private first: unknown = null
  private repeat: unknown = null
  private checking: Promise<void> | null = null
  private disposed = false
  private lastError: object | null = null

  constructor(deps: UpdateControllerDeps) {
    this.deps = deps
    const saved = this.readSettings()
    this.state = {
      phase: deps.disabledReason ? 'disabled' : 'idle',
      mode: deps.mode,
      currentVersion: deps.currentVersion,
      channel: saved.channel,
      autoCheck: saved.autoCheck,
      feed: deps.feed ? `${deps.feed.owner}/${deps.feed.repo}` : null,
      note: deps.disabledReason ?? deps.modeNote
    }
    const u = deps.updater
    // Background download only where the app can install it; a manual (macOS unsigned) build just
    // reports the version and links to the release.
    u.autoDownload = deps.mode === 'install'
    u.autoInstallOnAppQuit = deps.mode === 'install'
    u.allowDowngrade = false
    u.allowPrerelease = saved.channel === 'beta'
    u.on('checking-for-update', () => this.patch({ phase: 'checking', error: undefined }))
    u.on('update-available', (info: UpdateInfoLike) => {
      this.patch({ phase: this.state.mode === 'install' ? 'downloading' : 'available', offer: this.offer(info), percent: 0, error: undefined })
      this.deps.log(`update ${info.version} available${this.state.mode === 'install' ? ', downloading' : ''}`)
    })
    u.on('update-not-available', () => this.patch({ phase: 'none', offer: undefined, percent: undefined, error: undefined }))
    u.on('download-progress', (p: { percent?: number }) => {
      if (this.state.phase !== 'downloading' && this.state.phase !== 'available') return
      const percent = Math.max(0, Math.min(100, Math.round(Number(p?.percent) || 0)))
      this.patch({ phase: 'downloading', percent })
    })
    u.on('update-downloaded', (info: UpdateInfoLike) => {
      this.patch({ phase: 'ready', offer: this.offer(info), percent: 100, error: undefined })
      this.deps.log(`update ${info.version} downloaded; installs on restart`)
    })
    u.on('update-cancelled', () => this.patch({ phase: this.state.offer ? 'available' : 'idle', percent: undefined }))
    u.on('error', (error: unknown) => this.fail(error))
  }

  get current(): UpdateState {
    return { ...this.state }
  }

  // Startup: first check shortly after launch, then every 4 hours.
  start(): void {
    if (this.state.phase === 'disabled') return
    this.schedule()
  }

  // manual: "Check now". The timer leaves a downloaded update alone until the user restarts.
  async check(manual = true): Promise<UpdateState> {
    if (this.state.phase === 'disabled' || this.disposed) return this.current
    // Never restart a running download, and don't re-check over a finished one from the timer.
    if (this.state.phase === 'downloading' || (!manual && this.state.phase === 'ready')) return this.current
    if (!this.checking) {
      this.patch({ phase: 'checking', error: undefined })
      this.checking = this.deps.updater
        .checkForUpdates()
        .then((result) => {
          // electron-updater resolves null when it skips (e.g. not packaged) without events.
          if (result == null && this.state.phase === 'checking') this.patch({ phase: 'none' })
        })
        .catch((error) => this.fail(error))
        .finally(() => {
          this.checking = null
          this.patch({ lastCheck: (this.deps.now ?? Date.now)() })
        })
    }
    await this.checking
    return this.current
  }

  setSettings(patch: Partial<UpdateSettings>): UpdateState {
    const next: UpdateSettings = { ...this.readSettings() }
    if (typeof patch.autoCheck === 'boolean') next.autoCheck = patch.autoCheck
    if (patch.channel === 'stable' || patch.channel === 'beta') next.channel = patch.channel
    if (typeof patch.quick === 'boolean') next.quick = patch.quick
    const channelChanged = next.channel !== this.state.channel
    this.deps.settings.set(SETTINGS_KEY, next)
    this.deps.updater.allowPrerelease = next.channel === 'beta'
    this.patch({ autoCheck: next.autoCheck, channel: next.channel })
    if (this.state.phase !== 'disabled') {
      this.schedule()
      // A different channel can offer a different version: look again (unless a download runs).
      if (channelChanged && this.state.phase !== 'downloading' && this.state.phase !== 'ready') void this.check()
    }
    return this.current
  }

  // Restart into the downloaded update. Only valid when ready in install mode.
  install(): void {
    if (this.state.mode !== 'install' || this.state.phase !== 'ready') {
      throw new Error(this.state.mode === 'manual' ? 'This build installs updates from the release page.' : 'No update is ready to install.')
    }
    this.deps.log(`restarting into ${this.state.offer?.version ?? 'the update'}`)
    // Silent NSIS install into the same folder, then relaunch.
    this.deps.updater.quitAndInstall(true, true)
  }

  openRelease(): void {
    if (!this.deps.feed) return
    this.deps.openExternal(this.state.offer?.url ?? releasePageUrl(this.deps.feed))
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  private readSettings(): UpdateSettings {
    const raw = this.deps.settings.get<Partial<UpdateSettings>>(SETTINGS_KEY, {}) ?? {}
    const channel: UpdateChannel = raw.channel === 'beta' ? 'beta' : 'stable'
    return { autoCheck: raw.autoCheck !== false, channel, quick: raw.quick !== false }
  }

  private schedule(): void {
    this.clearTimers()
    if (!this.state.autoCheck || this.disposed) return
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const setRepeat = this.deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms))
    // The first check waits a moment so it never competes with project startup; a later schedule
    // (toggle on) checks only when the last check is older than the interval.
    const last = this.state.lastCheck
    const now = (this.deps.now ?? Date.now)()
    if (last === undefined || now - last >= CHECK_EVERY_MS) this.first = setTimer(() => void this.check(false), FIRST_CHECK_DELAY_MS)
    this.repeat = setRepeat(() => void this.check(false), CHECK_EVERY_MS)
  }

  private clearTimers(): void {
    if (this.first != null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.first)
    if (this.repeat != null) (this.deps.clearRepeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.repeat)
    this.first = null
    this.repeat = null
  }

  private offer(info: UpdateInfoLike): UpdateState['offer'] {
    const notes = clipNotes(notesToText(info.releaseNotes))
    return {
      version: info.version,
      releaseName: info.releaseName ?? undefined,
      notes: notes || undefined,
      releaseDate: info.releaseDate,
      url: this.deps.feed ? releasePageUrl(this.deps.feed, info.version) : ''
    }
  }

  private fail(error: unknown): void {
    // electron-updater both emits 'error' and rejects checkForUpdates with the same error.
    if (error !== null && typeof error === 'object') {
      if (this.lastError === error) return
      this.lastError = error
    }
    const classified = classifyUpdateError(error, this.deps.feed)
    this.deps.log(`update: ${classified.detail ?? classified.message}`, 'stderr')
    // A failed download keeps the offer so Settings can still link to it.
    this.patch({ phase: 'error', error: classified, percent: undefined })
  }

  private patch(next: Partial<UpdateState>): void {
    this.state = { ...this.state, ...next }
    for (const key of Object.keys(next) as (keyof UpdateState)[]) if (next[key] === undefined) delete this.state[key]
    if (!this.disposed) this.deps.emit(this.current)
  }
}
