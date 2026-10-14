// Quick update checks and downloads (no electron imports; electron.ts wires it, the tests drive it
// with a fake feed).
//
// A check reads the signed manifest(s) for the channel (Stable: quick-stable.json; Beta: also
// quick-beta.json), keeps a bundle only when its signature verifies with the key built into the
// installed app, it is newer than the code that runs now (and than one already downloaded), it is
// not marked bad, and it fits the installed app (same Electron and package versions; otherwise
// "needs a full update"). The zip is then downloaded, checked against the signed sha256 and
// unpacked into userData/code/<version>; it runs from the next launch on (src/main/bootstrap.ts).
import { join } from 'node:path'
import type { QuickUpdateState, RunningCode, UpdateChannel } from '../../../shared/updateTypes.ts'
import { MAX_MANIFEST_BYTES, parseAndVerify, QuickError, type QuickManifest } from './manifest.ts'
import { checkCompat, type ShellInfo } from './shellInfo.ts'
import { isBad, readCodeState, setDisabled, updateCodeState } from './codeState.ts'
import { STATE_FILE } from './boot.ts'
import { installBundle, type InstallOptions } from './install.ts'
import type { QuickFeed } from './feed.ts'
import { compareVersions } from './version.ts'

export const QUICK_CHECK_EVERY_MS = 4 * 60 * 60 * 1000
export const QUICK_FIRST_CHECK_DELAY_MS = 20 * 1000
const SETTINGS_KEY = 'updates'

export interface FetchResult {
  status: number
  body: Buffer
}

export interface QuickUpdaterDeps {
  running: RunningCode
  // Set when this build cannot use quick updates (development build, no key, no feed).
  unavailable?: string
  shell: ShellInfo | null
  publicKey: string
  codeRoot: string
  feed: QuickFeed | null
  // GET with redirects restricted to the allowed hosts and a size cap (electron.ts).
  get: (url: string, maxBytes: number) => Promise<FetchResult>
  install?: (opts: InstallOptions) => Promise<string>
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (state: QuickUpdateState) => void
  log: (text: string, stream?: 'info' | 'stderr') => void
  relaunch: () => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
  setRepeat?: (fn: () => void, ms: number) => unknown
  clearRepeat?: (handle: unknown) => void
}

interface Prefs {
  enabled: boolean
  channel: UpdateChannel
  autoCheck: boolean
}

export class QuickUpdater {
  private state: QuickUpdateState
  private readonly deps: QuickUpdaterDeps
  private checking: Promise<void> | null = null
  private ready: QuickManifest | null = null
  private first: unknown = null
  private repeat: unknown = null
  private disposed = false
  private channel: UpdateChannel

  constructor(deps: QuickUpdaterDeps) {
    this.deps = deps
    const prefs = this.prefs()
    this.channel = prefs.channel
    this.state = {
      phase: deps.unavailable ? 'unavailable' : prefs.enabled ? 'idle' : 'off',
      enabled: prefs.enabled,
      running: deps.running,
      note: deps.unavailable
    }
  }

  get current(): QuickUpdateState {
    return { ...this.state }
  }

  start(): void {
    if (this.state.phase === 'unavailable') return
    this.syncDisabledFlag(this.state.enabled)
    this.schedule()
  }

  dispose(): void {
    this.disposed = true
    this.clearTimers()
  }

  // Called after Settings > Updates changed (quick switch, channel or auto-check).
  settingsChanged(): void {
    if (this.state.phase === 'unavailable') return
    const prefs = this.prefs()
    const wasEnabled = this.state.enabled
    const channelChanged = prefs.channel !== this.channel
    this.channel = prefs.channel
    this.syncDisabledFlag(prefs.enabled)
    if (!prefs.enabled) {
      this.ready = null
      this.patch({ enabled: false, phase: 'off', version: undefined, commit: undefined, createdAt: undefined, message: undefined })
    } else if (!wasEnabled) {
      this.patch({ enabled: true, phase: 'idle' })
    }
    this.schedule()
    if (prefs.enabled && (!wasEnabled || channelChanged) && this.state.phase !== 'downloading') void this.check(true)
  }

  async check(manual = true): Promise<QuickUpdateState> {
    if (this.disposed || this.state.phase === 'unavailable' || !this.state.enabled) return this.current
    if (!manual && this.state.phase === 'ready') return this.current
    this.checking ??= this.run().finally(() => {
      this.checking = null
    })
    await this.checking
    return this.current
  }

  // Restart into the downloaded quick update.
  restart(): void {
    if (this.state.phase !== 'ready' || !this.ready) throw new Error('No quick update is ready.')
    this.deps.log(`restarting into quick update ${this.ready.version}`)
    this.deps.relaunch()
  }

  private async run(): Promise<void> {
    const { deps } = this
    const now = deps.now ?? Date.now
    if (!deps.feed || !deps.shell) return
    this.patch({ phase: 'checking', message: undefined })
    try {
      const channels: ('stable' | 'beta')[] = this.prefs().channel === 'beta' ? ['stable', 'beta'] : ['stable']
      let best: { manifest: QuickManifest; text: string } | null = null
      for (const channel of channels) {
        const found = await this.readManifest(channel)
        if (found && (!best || compareVersions(found.manifest.version, best.manifest.version) > 0)) best = found
      }
      const base = this.ready && compareVersions(this.ready.version, deps.running.version) > 0 ? this.ready.version : deps.running.version
      if (!best || compareVersions(best.manifest.version, base) <= 0) {
        this.patch(this.ready ? this.readyPatch(this.ready) : { phase: 'none', version: undefined, commit: undefined, createdAt: undefined })
        return
      }
      const m = best.manifest
      if (compareVersions(m.version, deps.running.appVersion) <= 0) {
        this.patch({ phase: 'none' })
        return
      }
      if (isBad(readCodeState(join(deps.codeRoot, STATE_FILE)), m.version)) {
        deps.log(`quick update ${m.version} failed to start before; skipping it`)
        this.patch(this.ready ? this.readyPatch(this.ready) : { phase: 'none' })
        return
      }
      const compat = checkCompat(m, deps.shell)
      if (!compat.ok) {
        deps.log(`quick update ${m.version} needs a full update: ${compat.reasons.join('; ')}`)
        this.patch({
          phase: 'needsFull',
          version: m.version,
          commit: m.commit,
          createdAt: m.createdAt,
          message: `Quick update ${m.version} needs a newer installed app (${compat.reasons.join('; ')}). Install the next full update.`
        })
        return
      }
      this.patch({ phase: 'downloading', version: m.version, commit: m.commit, createdAt: m.createdAt })
      deps.log(`quick update ${m.version} available, downloading`)
      const zip = await deps.get(deps.feed.zipUrl(m.zip.name), m.zip.size)
      if (zip.status !== 200) throw new Error(`Downloading ${m.zip.name} failed (HTTP ${zip.status})`)
      await (deps.install ?? installBundle)({ codeRoot: deps.codeRoot, manifest: m, envelopeText: best.text, zip: zip.body, publicKey: deps.publicKey })
      this.ready = m
      deps.log(`quick update ${m.version} verified and unpacked; applies on restart`)
      this.patch(this.readyPatch(m))
    } catch (e) {
      const message = e instanceof QuickError && e.kind === 'signature' ? `Rejected a quick update: ${e.message}.` : `Quick update check failed: ${(e as Error).message ?? e}`
      deps.log(message, 'stderr')
      this.patch(this.ready ? { ...this.readyPatch(this.ready), message } : { phase: 'error', message })
    } finally {
      this.patch({ lastCheck: now() })
    }
  }

  private async readManifest(channel: 'stable' | 'beta'): Promise<{ manifest: QuickManifest; text: string } | null> {
    const res = await this.deps.get(this.deps.feed!.manifestUrl(channel), MAX_MANIFEST_BYTES)
    if (res.status === 404) return null // nothing published on this channel yet
    if (res.status !== 200) throw new Error(`Reading quick-${channel}.json failed (HTTP ${res.status})`)
    const text = res.body.toString('utf8')
    const manifest = parseAndVerify(text, this.deps.publicKey)
    if (manifest.channel !== channel) throw new QuickError('manifest', `quick-${channel}.json holds a ${manifest.channel} build`)
    return { manifest, text }
  }

  private readyPatch(m: QuickManifest): Partial<QuickUpdateState> {
    return { phase: 'ready', version: m.version, commit: m.commit, createdAt: m.createdAt, message: undefined }
  }

  private prefs(): Prefs {
    const raw = this.deps.settings.get<{ quick?: boolean; channel?: string; autoCheck?: boolean }>(SETTINGS_KEY, {}) ?? {}
    return { enabled: raw.quick !== false, channel: raw.channel === 'beta' ? 'beta' : 'stable', autoCheck: raw.autoCheck !== false }
  }

  // The bootstrap reads the switch from userData/code/state.json (it starts before settings load).
  private syncDisabledFlag(enabled: boolean): void {
    const file = join(this.deps.codeRoot, STATE_FILE)
    const disabled = readCodeState(file).disabled === true
    if (disabled === !enabled) return
    try {
      updateCodeState(file, (s) => setDisabled(s, !enabled))
    } catch (e) {
      this.deps.log(`quick update: could not save the setting: ${(e as Error).message}`, 'stderr')
    }
  }

  private schedule(): void {
    this.clearTimers()
    if (this.disposed || !this.state.enabled || !this.prefs().autoCheck) return
    const setTimer = this.deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms))
    const setRepeat = this.deps.setRepeat ?? ((fn, ms) => setInterval(fn, ms))
    if (this.state.lastCheck === undefined) this.first = setTimer(() => void this.check(false), QUICK_FIRST_CHECK_DELAY_MS)
    this.repeat = setRepeat(() => void this.check(false), QUICK_CHECK_EVERY_MS)
  }

  private clearTimers(): void {
    if (this.first != null) (this.deps.clearTimer ?? ((h) => clearTimeout(h as ReturnType<typeof setTimeout>)))(this.first)
    if (this.repeat != null) (this.deps.clearRepeat ?? ((h) => clearInterval(h as ReturnType<typeof setInterval>)))(this.repeat)
    this.first = null
    this.repeat = null
  }

  private patch(next: Partial<QuickUpdateState>): void {
    this.state = { ...this.state, ...next }
    for (const key of Object.keys(next) as (keyof QuickUpdateState)[]) if (next[key] === undefined) delete this.state[key]
    if (!this.disposed) this.deps.emit(this.current)
  }
}
