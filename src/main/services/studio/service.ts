// Studio check: runs a lab item in the user's Roblox Studio through the Forge Bridge plugin, records
// the Studio window, keeps the frames at the key beats (cropped to the viewport), stores them with
// the library entry next to preview frames at the same times, and optionally runs the lab's critic on
// them. The labs' render step can also go through here (captureJob) when "critique in Studio" is on.
//
// No electron imports: the window capture, image ops and the labs come in as functions, so the job
// flow, timing sync and capture scheduling are tested with fakes (test/studio.test.ts).

import { insetRect, type Rect } from '../../../shared/studio/crop.ts'
import { newJobId, type BridgeJob } from '../../../shared/studio/protocol.ts'
import { snapshotJob } from '../../../shared/studio/payload.ts'
import { PLUGIN_FILE, PLUGIN_VERSION, pluginRbxmx, pluginSource, pluginTemplateVersion, pluginVersionOf } from '../../../shared/studio/plugin.ts'
import { beatTargets, DEFAULT_LAG_MS, stageDrift, startEpoch } from '../../../shared/studio/timing.ts'
import { STUDIO_PREFER_SETTING, type StudioCheckKind, type StudioCheckOptions, type StudioCheckRecord, type StudioFrame, type StudioMark, type StudioPhase, type StudioStatus } from '../../../shared/studio/types.ts'
import { markStudioFrames } from '../../../shared/studio/frames.ts'
import { BridgeError, type StudioBridge } from './bridge.ts'

// First Forge Bridge plugin version that runs 'snapshot' jobs (Thumbnail Lab).
export const SNAPSHOT_PLUGIN_VERSION = 4

export interface CapturedFrame {
  ts: number
  png: Buffer
}

export interface StudioCaptureSession {
  window: string
  // The first frame captured at or after `at` (ms since epoch).
  grabAfter(at: number, timeoutMs?: number): Promise<CapturedFrame>
  // The frames nearest each target time (ms since epoch); null where none arrived in time.
  pick(targets: number[], timeoutMs: number): Promise<((CapturedFrame & { offsetMs: number }) | null)[]>
  close(): Promise<void>
}

export interface StudioCapturer {
  // The Studio window Forge would record (for the status line), or why there is none.
  find(hint: { place?: string }): Promise<{ window: string } | { error: string }>
  open(hint: { place?: string }): Promise<StudioCaptureSession>
}

export interface ImageOps {
  // The key-coloured rectangle (the viewport during calibration).
  keyRect(png: Buffer, key: [number, number, number]): Rect | null
  // Crops (and scales down to maxWidth) a PNG.
  crop(png: Buffer, rect: Rect | null, maxWidth: number): Buffer
}

export interface StudioLab {
  prepare(id: string, jobId: string): Promise<{ name: string; job: BridgeJob; stages?: { label: string; at: number }[] }>
  // Returns the absolute path when the store has one.
  writeFile(id: string, file: string, bytes: Buffer): Promise<string | void>
  readFile(id: string, file: string): Promise<Buffer | null>
  // Preview frames at the same times (side by side in the UI, and for the critic's comparison).
  preview?(id: string, times: number[], size: { width: number; height: number }): Promise<Buffer[]>
  critique?(id: string, studio: Buffer[], times: number[], preview: Buffer[]): Promise<{ overall: number; summary: string }>
  // A Studio frame becomes the entry's thumbnail (and so a reference image for later critiques).
  setThumb?(id: string, file: string): Promise<void>
}

export interface PluginInstaller {
  dir(): string | null
  template(): Promise<string | null>
  read(path: string): Promise<string | null>
  write(path: string, text: string): Promise<void>
  open?(dir: string): Promise<void>
}

export interface StudioServiceDeps {
  bridge: Pick<StudioBridge, 'port' | 'listening' | 'lastError' | 'studio' | 'connected' | 'busy' | 'run' | 'cancel'>
  capturer?: StudioCapturer
  image?: ImageOps
  labs: Partial<Record<StudioCheckKind, StudioLab>>
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  plugin: PluginInstaller
  rojo?: () => 'running' | 'stopped'
  emit?: (event: 'studio:bridge' | 'studio:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  // Display + capture latency added to beat targets (ms).
  lagMs?: number
  // Delay after a stepped pose before the frame counts (Studio has to render it).
  settleMs?: number
  // Width of the stored frames.
  frameWidth?: number
}

export class StudioCheckError extends Error {
  readonly state: StudioStatus['state'] | 'job'
  constructor(state: StudioCheckError['state'], message: string) {
    super(message)
    this.state = state
  }
}

export interface JobCapture {
  frames: Buffer[]
  times: number[]
  offsets: (number | undefined)[]
  marks: StudioMark[]
  window: string
  crop: Rect | null
  place?: string
}

export const CHECK_FILE = 'studio/check.json'
const FRAME_WIDTH = 640

export class StudioService {
  private deps: StudioServiceDeps
  private now: () => number
  private queue: Promise<unknown> = Promise.resolve()
  private busy: StudioStatus['busy'] | undefined
  private captureCache: { at: number; value: { window: string } | { error: string } } | null = null

  constructor(deps: StudioServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  prefer(): boolean {
    return this.deps.settings.get<boolean>(STUDIO_PREFER_SETTING, false) === true
  }

  // Whether the labs' render step should use Studio right now.
  useStudio(): boolean {
    return this.prefer() && !!this.deps.capturer && this.deps.bridge.listening && this.deps.bridge.connected()
  }

  // ------------------------------------------------------------ status + plugin

  private pluginPath(): { dir: string | null; file: string | null } {
    const dir = this.deps.plugin.dir()
    return { dir, file: dir ? `${dir}${dir.includes('\\') ? '\\' : '/'}${PLUGIN_FILE}` : null }
  }

  private async findWindow(): Promise<{ window: string } | { error: string }> {
    if (!this.deps.capturer) return { error: 'Screen capture needs the desktop app.' }
    if (this.captureCache && this.now() - this.captureCache.at < 4000) return this.captureCache.value
    const value = await this.deps.capturer.find({ place: this.deps.bridge.studio()?.place }).catch((e) => ({ error: (e as Error).message }))
    this.captureCache = { at: this.now(), value }
    return value
  }

  async status(): Promise<StudioStatus> {
    const bridge = this.deps.bridge
    const { dir, file } = this.pluginPath()
    const text = file ? await this.deps.plugin.read(file).catch(() => null) : null
    const fileVersion = text ? pluginVersionOf(text) : null
    const portOk = !text || text.includes(`127.0.0.1:${bridge.port}/`)
    const info = bridge.studio()
    const connected = bridge.connected()
    const outdated = (text !== null && ((fileVersion ?? 0) < PLUGIN_VERSION || !portOk)) || (connected && (info?.pluginVersion ?? 0) < PLUGIN_VERSION)
    const capture = connected ? await this.findWindow() : null
    const s: StudioStatus = {
      state: 'ready',
      message: '',
      server: { port: bridge.port, listening: bridge.listening, ...(bridge.lastError ? { error: bridge.lastError } : {}) },
      plugin: { installed: text !== null, dir, ...(file ? { file } : {}), ...(fileVersion !== null ? { version: fileVersion } : {}), bundled: PLUGIN_VERSION, ...(outdated ? { outdated: true } : {}) },
      studio: { connected, ...(info ? { lastSeen: info.lastSeen, ...(info.place ? { place: info.place } : {}), ...(info.placeId ? { placeId: info.placeId } : {}), ...(info.pluginVersion ? { pluginVersion: info.pluginVersion } : {}) } : {}) },
      capture: capture ? ('window' in capture ? { available: true, window: capture.window } : { available: false, hint: capture.error }) : { available: false },
      ...(this.deps.rojo ? { rojo: this.deps.rojo() } : {}),
      prefer: this.prefer(),
      ...(this.busy ? { busy: this.busy } : {})
    }
    if (!dir && !connected) [s.state, s.message] = ['unsupported', 'Roblox Studio runs on Windows and macOS; the Studio check is not available here.']
    else if (!bridge.listening) [s.state, s.message] = ['server-error', `Forge could not listen on 127.0.0.1:${bridge.port}${bridge.lastError ? `: ${bridge.lastError}` : ''}.`]
    else if (text === null && !connected) [s.state, s.message] = ['no-plugin', 'Install the Forge Bridge plugin, then restart Studio (or reload plugins).']
    else if (outdated) [s.state, s.message] = ['plugin-outdated', 'The Forge Bridge plugin is older than this Forge; reinstall it and restart Studio.']
    else if (!connected) [s.state, s.message] = ['studio-offline', 'Open your place in Roblox Studio; the Forge Bridge plugin connects on its own (allow HTTP requests to 127.0.0.1 when Studio asks).']
    else if (capture && 'error' in capture) [s.state, s.message] = ['no-capture', capture.error]
    else if (this.busy) [s.state, s.message] = ['busy', `Checking ${this.busy.kind} ${this.busy.id} (${this.busy.phase}).`]
    else s.message = `Connected to ${info?.place ?? 'Studio'}${capture && 'window' in capture ? ` · recording "${capture.window}"` : ''}.`
    return s
  }

  private async changed(): Promise<void> {
    if (!this.deps.emit) return
    this.deps.emit('studio:bridge', await this.status().catch(() => null))
  }

  bridgeChanged(): void {
    this.captureCache = null
    void this.changed()
  }

  async installPlugin(): Promise<StudioStatus> {
    const { dir, file } = this.pluginPath()
    if (!dir || !file) throw new StudioCheckError('unsupported', 'Roblox Studio runs on Windows and macOS; there is no plugins folder on this system.')
    const template = await this.deps.plugin.template()
    if (!template) throw new StudioCheckError('no-plugin', 'The Forge Bridge plugin is missing from this install (resources/studio/ForgeBridge.luau).')
    // Stamped with the template's own version: an older template (a broken quick update without its
    // bundled copy) must not claim to be the plugin this code expects.
    await this.deps.plugin.write(file, pluginRbxmx(pluginSource(template, { port: this.deps.bridge.port, version: Math.min(PLUGIN_VERSION, pluginTemplateVersion(template)) })))
    this.deps.log?.(`studio: installed the Forge Bridge plugin at ${file}`)
    const s = await this.status()
    this.deps.emit?.('studio:bridge', s)
    return s
  }

  // At startup: put the bundled plugin in Studio's plugins folder when it is missing or older than
  // this Forge, so Forge Sync and the Studio check work without a manual install. `studioPresent`
  // tells whether Studio looks installed (its Roblox folder exists); nothing is written otherwise.
  async ensurePlugin(studioPresent: (pluginsDir: string) => boolean): Promise<'installed' | 'updated' | null> {
    const s = await this.status()
    if (!s.plugin.dir || !studioPresent(s.plugin.dir)) return null
    const stale = !s.plugin.installed || (s.plugin.version ?? 0) < PLUGIN_VERSION || !!s.plugin.outdated
    if (!stale) return null
    const was = s.plugin.installed
    await this.installPlugin()
    this.deps.log?.(`studio: ${was ? 'updated' : 'installed'} the Forge Bridge plugin (v${PLUGIN_VERSION}); restart Studio to load it`)
    return was ? 'updated' : 'installed'
  }

  async openPluginsFolder(): Promise<void> {
    const { dir } = this.pluginPath()
    if (dir && this.deps.plugin.open) await this.deps.plugin.open(dir)
  }

  async setPrefer(on: boolean): Promise<StudioStatus> {
    this.deps.settings.set(STUDIO_PREFER_SETTING, !!on)
    const s = await this.status()
    this.deps.emit?.('studio:bridge', s)
    return s
  }

  // ------------------------------------------------------------ capture

  private progress(kind: StudioCheckKind, id: string, phase: StudioPhase, message?: string): void {
    this.busy = phase === 'done' || phase === 'error' ? undefined : { kind, id, phase }
    this.deps.emit?.('studio:progress', { kind, id, phase, ...(message ? { message } : {}) })
  }

  // One job at a time (Studio has one viewport).
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn, fn)
    this.queue = next.catch(() => undefined)
    return next
  }

  private ready(): void {
    const b = this.deps.bridge
    if (!this.deps.capturer || !this.deps.image) throw new StudioCheckError('no-capture', 'The Studio check needs the desktop app (window capture).')
    if (!b.listening) throw new StudioCheckError('server-error', `Forge is not listening on 127.0.0.1:${b.port}${b.lastError ? ` (${b.lastError})` : ''}.`)
    if (!b.connected()) throw new StudioCheckError('studio-offline', 'Studio is not connected: open your place in Roblox Studio with the Forge Bridge plugin installed and on.')
  }

  // Plays a job in Studio and returns the frames at its beats.
  captureJob(job: BridgeJob, onPhase?: (phase: StudioPhase, message?: string) => void): Promise<JobCapture> {
    return this.serial(() => this.runJob(job, onPhase))
  }

  private async runJob(job: BridgeJob, onPhase?: (phase: StudioPhase, message?: string) => void): Promise<JobCapture> {
    this.ready()
    const place = this.deps.bridge.studio()?.place
    const session = await this.deps.capturer!.open({ place }).catch((e) => {
      throw new StudioCheckError('no-capture', `Could not record the Studio window: ${(e as Error).message}`)
    })
    const image = this.deps.image!
    const lag = this.deps.lagMs ?? DEFAULT_LAG_MS
    const settle = this.deps.settleMs ?? 80
    const width = this.deps.frameWidth ?? FRAME_WIDTH
    let crop: Rect | null = null
    const stepped: (CapturedFrame | null)[] = job.beats.map(() => null)
    let picking: Promise<((CapturedFrame & { offsetMs: number }) | null)[]> | null = null
    let marks: StudioMark[] = []
    onPhase?.('waiting', 'waiting for Studio to pick up the job')
    try {
      await this.deps.bridge.run(job, async (ev, at) => {
        switch (ev.type) {
          case 'accepted':
            onPhase?.('staging', 'building the stage in Studio')
            return {}
          case 'calibrate': {
            const f = await session.grabAfter(at + settle)
            const r = image.keyRect(f.png, job.key)
            crop = r ? insetRect(r, 2) : null
            if (!r) this.deps.log?.('studio: viewport not found in the window capture; keeping the whole window', 'stderr')
            return { crop: !!r }
          }
          case 'ready':
            onPhase?.('capturing', job.mode === 'stepped' ? 'posing each beat' : 'playing')
            return { go: true }
          case 'start': {
            const start = startEpoch({ receivedAt: at, elapsed: ev.elapsed, rtt: ev.rtt })
            const targets = beatTargets(start, job.beats.map((b) => b.t), lag)
            picking = session.pick(targets, Math.max(5000, job.duration * 1000 + 4000))
            return {}
          }
          case 'beat': {
            if (ev.index < stepped.length) stepped[ev.index] = await session.grabAfter(at + settle)
            return {}
          }
          case 'mark':
            marks.push({ label: ev.label, t: ev.t })
            return {}
          case 'done':
            marks = [...marks, ...ev.marks]
            return {}
          default:
            return {}
        }
      })
      const raw: ((CapturedFrame & { offsetMs?: number }) | null)[] = job.mode === 'stepped' ? stepped : picking ? await picking : []
      const missing = raw.map((f, i) => (f ? null : job.beats[i]?.label)).filter(Boolean)
      if (!raw.length || missing.length === raw.length) throw new StudioCheckError('no-capture', 'No frames were captured from the Studio window (is it visible and not minimised?).')
      if (missing.length) this.deps.log?.(`studio: no frame for ${missing.join(', ')}`, 'stderr')
      const keep = raw.map((f, i) => ({ f, i })).filter((x) => x.f)
      return {
        frames: keep.map((x) => image.crop(x.f!.png, crop, width)),
        times: keep.map((x) => job.beats[x.i].t),
        offsets: keep.map((x) => x.f!.offsetMs),
        marks: marks.sort((a, b) => a.t - b.t),
        window: session.window,
        crop,
        ...(place ? { place } : {})
      }
    } catch (e) {
      if (e instanceof BridgeError) throw new StudioCheckError(e.code === 'not-accepted' ? 'studio-offline' : 'job', e.message)
      throw e
    } finally {
      await session.close().catch(() => undefined)
    }
  }

  // Thumbnail Lab: the user's current Studio view as a PNG (at most maxWidth wide). Through the Forge
  // Bridge when Studio is connected (a snapshot job: the plugin finds the viewport with the key colour,
  // clears the selection, builds no stage and leaves the camera alone); otherwise, or when the plugin
  // is too old for snapshot jobs, a plain grab of the whole Studio window.
  snapshot(maxWidth = 1920): Promise<{ png: Buffer; via: 'bridge' | 'window'; window: string }> {
    return this.serial(async () => {
      if (!this.deps.capturer || !this.deps.image) throw new StudioCheckError('no-capture', 'Capturing Studio needs the desktop app (window capture).')
      const image = this.deps.image
      const b = this.deps.bridge
      const place = b.studio()?.place
      const settle = this.deps.settleMs ?? 80
      // Plugins before version 4 do not know snapshot jobs: they would build a stage and move the
      // camera, so the grab would show the stage instead of the user's view.
      const snapshots = (b.studio()?.pluginVersion ?? 0) >= SNAPSHOT_PLUGIN_VERSION
      if (b.listening && b.connected() && !snapshots) this.deps.log?.('studio: the Forge Bridge plugin is too old for viewport snapshots; grabbing the window (reinstall the plugin and restart Studio)', 'stderr')
      if (b.listening && b.connected() && snapshots) {
        const session = await this.deps.capturer.open({ place }).catch((e) => {
          throw new StudioCheckError('no-capture', `Could not record the Studio window: ${(e as Error).message}`)
        })
        try {
          const job = snapshotJob({ id: newJobId() })
          let crop: Rect | null = null
          let frame: CapturedFrame | null = null
          await b.run(job, async (ev, at) => {
            if (ev.type === 'calibrate') {
              const f = await session.grabAfter(at + settle)
              const r = image.keyRect(f.png, job.key)
              crop = r ? insetRect(r, 2) : null
              return { crop: !!r }
            }
            if (ev.type === 'beat') frame = await session.grabAfter(at + settle)
            return {}
          })
          if (frame) return { png: image.crop((frame as CapturedFrame).png, crop, maxWidth), via: 'bridge' as const, window: session.window }
        } catch (e) {
          this.deps.log?.(`studio: snapshot through the bridge failed (${(e as Error).message}); grabbing the window`, 'stderr')
        } finally {
          await session.close().catch(() => undefined)
        }
      }
      const session = await this.deps.capturer.open({ place }).catch((e) => {
        throw new StudioCheckError('no-capture', `Could not record the Studio window: ${(e as Error).message}`)
      })
      try {
        const f = await session.grabAfter(this.now() + 150)
        return { png: image.crop(f.png, null, maxWidth), via: 'window' as const, window: session.window }
      } finally {
        await session.close().catch(() => undefined)
      }
    })
  }

  // Wraps a lab's preview capture: Studio frames when "critique in Studio" is on and Studio is
  // connected (marked for the critic), the preview otherwise or when Studio fails.
  wrapCapture<R>(kind: StudioCheckKind, preview: ((req: R) => Promise<Buffer[]>) | undefined, toJob: (req: R, jobId: string) => BridgeJob | Promise<BridgeJob>): ((req: R) => Promise<Buffer[]>) | undefined {
    if (!preview) return preview
    return async (req: R) => {
      if (!this.useStudio()) return preview(req)
      try {
        const job = await toJob(req, newJobId())
        const r = await this.captureJob(job)
        // The loop expects one frame per requested time; fill gaps from the preview.
        if (r.frames.length === job.beats.length) return markStudioFrames(r.frames, { studio: r.frames.length })
        this.deps.log?.(`studio: ${job.beats.length - r.frames.length} beat(s) missing in Studio; using the preview for this render`, 'stderr')
      } catch (e) {
        this.deps.log?.(`studio: ${kind} capture in Studio failed (${(e as Error).message}); using the preview`, 'stderr')
      }
      return preview(req)
    }
  }

  // ------------------------------------------------------------ check

  private lab(kind: StudioCheckKind): StudioLab {
    const lab = this.deps.labs[kind]
    if (!lab) throw new StudioCheckError('job', `the ${kind} lab is not available`)
    return lab
  }

  async check(kind: StudioCheckKind, id: string, opts: StudioCheckOptions = {}): Promise<StudioCheckRecord> {
    const lab = this.lab(kind)
    const started = this.now()
    this.progress(kind, id, 'queued')
    let name = id
    try {
      const prep = await lab.prepare(id, newJobId())
      name = prep.name
      const cap = await this.captureJob(prep.job, (phase, message) => this.progress(kind, id, phase, message))
      const frames: StudioFrame[] = []
      const abs: string[] = []
      for (const [i, png] of cap.frames.entries()) {
        const file = `studio/beat-${i + 1}.png`
        const p = await lab.writeFile(id, file, png)
        if (p) abs.push(p)
        const beat = prep.job.beats.find((b) => b.t === cap.times[i])
        frames.push({ beat: i, label: beat?.label ?? `t${i + 1}`, t: cap.times[i], file, ...(cap.offsets[i] !== undefined ? { offsetMs: Math.round(cap.offsets[i]!) } : {}) })
      }
      let previews: Buffer[] = []
      if (opts.preview !== false && lab.preview) {
        this.progress(kind, id, 'preview', 'rendering the preview at the same beats')
        const size = cap.crop ? { width: 512, height: Math.max(200, Math.min(640, Math.round((512 * cap.crop.height) / cap.crop.width))) } : { width: 512, height: 384 }
        previews = await lab.preview(id, cap.times, size).catch((e) => {
          this.deps.log?.(`studio: preview frames: ${(e as Error).message}`, 'stderr')
          return [] as Buffer[]
        })
        for (const [i, png] of previews.entries()) {
          if (!frames[i]) break
          const file = `studio/preview-${i + 1}.png`
          await lab.writeFile(id, file, png)
          frames[i].preview = file
        }
      }
      let critique: StudioCheckRecord['critique']
      if (opts.critique && lab.critique) {
        this.progress(kind, id, 'critique', 'the critic is looking at the Studio frames')
        critique = await lab.critique(id, cap.frames, cap.times, previews).catch((e) => {
          this.deps.log?.(`studio: critique: ${(e as Error).message}`, 'stderr')
          return undefined
        })
      }
      if (lab.setThumb && frames.length) await lab.setThumb(id, frames[Math.min(frames.length - 1, Math.floor(frames.length / 2))].file).catch(() => undefined)
      const drift = prep.stages?.length ? stageDrift(prep.stages, cap.marks) : []
      const record: StudioCheckRecord = {
        kind,
        id,
        name,
        at: this.now(),
        ok: true,
        mode: prep.job.mode,
        frames,
        marks: cap.marks,
        ...(drift.length ? { drift } : {}),
        window: cap.window,
        ...(cap.place ? { place: cap.place } : {}),
        crop: cap.crop,
        ...(critique ? { critique } : {}),
        ms: this.now() - started
      }
      await lab.writeFile(id, CHECK_FILE, Buffer.from(JSON.stringify(record, null, 1), 'utf8'))
      this.progress(kind, id, 'done', `${frames.length} Studio frame(s)`)
      void this.changed()
      return abs.length === frames.length ? { ...record, abs } : record
    } catch (e) {
      const message = (e as Error).message
      this.progress(kind, id, 'error', message)
      void this.changed()
      throw e instanceof StudioCheckError ? e : new StudioCheckError('job', message)
    }
  }

  async lastCheck(kind: StudioCheckKind, id: string): Promise<StudioCheckRecord | null> {
    const lab = this.deps.labs[kind]
    if (!lab) return null
    const bytes = await lab.readFile(id, CHECK_FILE).catch(() => null)
    if (!bytes) return null
    try {
      return JSON.parse(bytes.toString('utf8')) as StudioCheckRecord
    } catch {
      return null
    }
  }

  async file(kind: StudioCheckKind, id: string, file: string): Promise<string | null> {
    if (!/^studio\/[\w.-]+\.png$/.test(file)) return null
    const bytes = await this.deps.labs[kind]?.readFile(id, file).catch(() => null)
    return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null
  }

  cancel(): void {
    this.deps.bridge.cancel('cancelled in Forge')
  }
}
