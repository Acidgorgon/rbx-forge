// Drives "Live in Studio" (the VFX Lab header toggle: Studio loops whatever is current) and "Loop"
// on Test in Studio (one entry until Stop or another entry is picked) through the preemptible live
// job (shared/vfx/live.ts). One job at a time; it steps aside for any other Studio job (Studio
// check captures, mesh reads, imports: the bridge preempts it) and starts again once the bridge is
// idle, with the camera where the user left it. A Loop started while Live is on goes back to
// following the selection when it stops. Turning it off, disposing (Forge quitting) or Studio
// disconnecting ends the job; the module then removes Workspace.ForgeLivePreview. A job that keeps
// failing to start is retried with a back-off, then given up (status error); a start Studio refuses
// outright (its Script Injection permission is off: errorCode 'script-injection') is not retried.
// Changing the Studio target restarts the job in the new place. No electron imports (timers and the
// bridge are injected for tests).

import { randomBytes } from 'node:crypto'
import { baseKey, LiveSchedule, liveJob, parseLiveError, parseLivePoll, LIVE_DEBOUNCE_MS, type LiveCurrent, type LiveSettings, type LiveStatus } from '../../../shared/vfx/live.ts'
import type { BridgeJob } from '../../../shared/studio/protocol.ts'
import { isScriptInjectionError, SCRIPT_INJECTION_CODE, SCRIPT_INJECTION_MESSAGE } from '../../../shared/studio/errors.ts'
import type { VfxEffect } from '../../../shared/vfx/types.ts'

export type { LiveStatus }

export interface LiveBridge {
  port: number
  listening: boolean
  connected(): boolean
  // Any job (a preemptible one included).
  current?(): BridgeJob | null
  run(job: BridgeJob, handler: (ev: { type: string; message?: string }, at: number) => unknown, opts?: { acceptTimeoutMs?: number; timeoutMs?: number; preemptible?: boolean }): Promise<void>
  cancel?(reason?: string): void
}

export interface LiveDeps {
  bridge?: () => LiveBridge | undefined
  emit?: (event: 'vfx:live', payload: LiveStatus) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (t: unknown) => void
  // How often the controller checks whether it should (re)start the job.
  tickMs?: number
  // While an entry is being refined its iterations loop; the lab's copy of the entry does not
  // replace them.
  isRefining?: (entryId: string) => boolean
}

export class LiveStudio {
  readonly schedule = new LiveSchedule()
  private deps: LiveDeps
  private now: () => number
  private jobId: string | null = null
  private framed = false
  private starting = false
  private paused = false
  private ticker: unknown = null
  private debounce: unknown = null
  private error: string | undefined
  private errorCode: LiveStatus['errorCode']
  private message: string | undefined
  private last = ''
  // The header toggle (follow the current effect) is on; a pinned Loop returns to it.
  private following = false
  // Consecutive job starts that failed (reset by the first poll of a job) and the next retry.
  private failures = 0
  private retryAt = 0
  private polled = false
  // A job told to stop so that one with new settings starts.
  private restarting: string | null = null

  constructor(deps: LiveDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  private setTimer(fn: () => void, ms: number): unknown {
    return (this.deps.setTimer ?? ((f, m) => setTimeout(f, m)))(fn, ms)
  }

  private clearTimer(t: unknown): void {
    if (t) (this.deps.clearTimer ?? ((x) => clearTimeout(x as ReturnType<typeof setTimeout>)))(t)
  }

  status(): LiveStatus {
    const s = this.schedule
    const state: LiveStatus['state'] = !s.enabled ? 'off' : this.jobId && !this.starting ? 'looping' : this.starting ? 'starting' : this.paused ? 'paused' : 'waiting'
    return {
      state,
      pinned: s.pin,
      following: this.following,
      name: s.current?.effect.name ?? null,
      label: s.current?.label ?? '',
      plays: s.plays,
      settings: s.settings,
      ...(this.error || s.lastError ? { error: this.error ?? s.lastError ?? undefined } : {}),
      ...(this.errorCode && this.error ? { errorCode: this.errorCode } : {}),
      ...(this.message ? { message: this.message } : {})
    }
  }

  private changed(): void {
    const st = this.status()
    const key = JSON.stringify(st)
    if (key === this.last) return
    this.last = key
    this.deps.emit?.('vfx:live', st)
  }

  // Live toggle on (no pin: follow the current effect) or Loop on one entry (pin). Turning Live on
  // while a Loop runs keeps the Loop; Live takes over when it stops.
  start(opts: { pin?: string | null; settings?: Partial<LiveSettings>; current?: LiveCurrent } = {}): LiveStatus {
    const wasOn = this.schedule.enabled
    const pin = opts.pin ?? null
    if (!pin) this.following = true
    if (!pin && wasOn && this.schedule.pin) {
      if (opts.settings) this.schedule.setSettings(opts.settings)
      this.changed()
      return this.status()
    }
    const pinChanged = this.schedule.pin !== pin
    this.schedule.start({ pin, settings: opts.settings })
    if (!wasOn) {
      this.framed = false
      this.failures = 0
      this.retryAt = 0
    }
    if (opts.current) {
      this.schedule.set(opts.current, this.now())
      this.schedule.flush(this.now(), true)
    }
    this.error = undefined
    this.errorCode = undefined
    this.schedule.lastError = null
    if (!wasOn || pinChanged) this.deps.log?.(`live: ${pin ? `looping ${pin}` : 'live preview on'}`)
    this.tick()
    this.changed()
    return this.status()
  }

  // Everything off (the live line's Stop, Forge closing).
  stop(reason = 'stopped'): LiveStatus {
    this.following = false
    if (this.schedule.enabled) this.deps.log?.(`live: ${reason}`)
    this.schedule.stop()
    this.clearTimer(this.debounce)
    this.debounce = null
    this.paused = false
    // The module stops on its next poll (answer: stop); cancel the job too if it does not end.
    const id = this.jobId
    if (id) {
      this.setTimer(() => {
        const b = this.deps.bridge?.()
        if (this.jobId === id && b?.current?.()?.id === id) b.cancel?.('live preview stopped')
      }, 1500)
    }
    this.changed()
    return this.status()
  }

  // Stop on a Loop: back to following when Live is on, else off.
  stopLoop(): LiveStatus {
    if (!this.schedule.enabled || !this.schedule.pin) return this.status()
    if (!this.following) return this.stop('loop stopped')
    this.schedule.pin = null
    this.deps.log?.('live: loop stopped; following the lab again')
    this.changed()
    return this.status()
  }

  // The header toggle off: a running Loop keeps going (it ends with its own Stop).
  unfollow(): LiveStatus {
    this.following = false
    if (this.schedule.enabled && !this.schedule.pin) return this.stop('live preview off')
    this.changed()
    return this.status()
  }

  // The gap applies on the next poll; another place (dummy / origin) restarts the job (the module
  // stops on its next poll, the next one frames the new place).
  setSettings(s: Partial<LiveSettings>): LiveStatus {
    const mode = this.schedule.settings.mode
    this.schedule.setSettings(s)
    if (this.schedule.settings.mode !== mode && this.jobId) {
      this.restarting = this.jobId
      this.framed = false
    }
    this.changed()
    return this.status()
  }

  // The lab's current effect (selection, parameter edits): debounced, applied on the next loop.
  setCurrent(value: LiveCurrent): LiveStatus {
    if (!value.key.startsWith('draft:') && this.schedule.current?.key === `draft:${value.key}` && this.deps.isRefining?.(value.key)) return this.status()
    // Another entry while a Loop runs: Live (when on) follows it, else the Loop stops.
    if (this.schedule.enabled && this.schedule.pin && baseKey(value.key) !== this.schedule.pin && this.following) {
      this.schedule.pin = null
      this.deps.log?.('live: another entry was picked; following the lab again')
    }
    const r = this.schedule.set(value, this.now())
    if (r === 'stopped') {
      this.deps.log?.('live: the looping entry is no longer selected; loop stopped')
      return this.stop('loop stopped (another entry was picked)')
    }
    if (r === 'queued') {
      this.clearTimer(this.debounce)
      this.debounce = this.setTimer(() => {
        this.debounce = null
        this.schedule.flush(this.now(), true)
        this.tick()
        this.changed()
      }, LIVE_DEBOUNCE_MS)
    }
    return this.status()
  }

  // A refine / make iteration: replaces what loops at once (no debounce: iterations are seconds
  // apart); the score arrives later as a label.
  draft(entryId: string, iteration: number, effect: VfxEffect, score?: number): void {
    if (!this.schedule.enabled) return
    if (this.schedule.pin && this.schedule.pin !== entryId) return
    const label = `${effect.name} · iteration ${iteration}${score != null ? ` · ${score.toFixed(1)}/10` : ''}`
    const key = `draft:${entryId}`
    if (this.schedule.current?.key === key && score != null && this.schedule.relabel(key, label)) return this.changed()
    this.schedule.set({ key, effect, label }, this.now())
    this.schedule.flush(this.now(), true)
    this.tick()
    this.changed()
  }

  // (Re)starts the job when it should run and the bridge is free. Called on changes and by a timer
  // while live is on (resume after a capture, Studio reconnecting).
  tick(): void {
    this.clearTimer(this.ticker)
    this.ticker = null
    if (!this.schedule.enabled) return
    this.ticker = this.setTimer(() => this.tick(), this.deps.tickMs ?? 1000)
    if (this.jobId || this.starting || !this.schedule.current || this.retryAt > this.now()) return
    const b = this.deps.bridge?.()
    if (!b?.listening || !b.connected()) {
      this.message = 'Waiting for Roblox Studio (Forge Bridge plugin).'
      return this.changed()
    }
    if (b.current?.()) {
      this.paused = true
      this.message = 'Paused while Studio runs another job.'
      return this.changed()
    }
    this.launch(b)
  }

  private launch(b: LiveBridge): void {
    const id = `job-live-${randomBytes(5).toString('hex')}`
    this.jobId = id
    this.starting = true
    this.polled = false
    this.message = undefined
    const frame = !this.framed
    const job = liveJob({ id, port: b.port, mode: this.schedule.settings.mode, frame, camera: frame ? null : this.schedule.camera })
    this.framed = true
    this.changed()
    b.run(
      job,
      (ev) => {
        if (this.jobId !== id || this.restarting === id) return { live: { stop: true } }
        if (ev.type !== 'log' || typeof ev.message !== 'string') return {}
        const poll = parseLivePoll(ev.message)
        if (poll) {
          if (!this.polled) {
            // The module runs: the start worked.
            this.polled = true
            this.starting = false
            this.paused = false
            this.failures = 0
            this.retryAt = 0
            this.error = undefined
            this.errorCode = undefined
            this.changed()
          }
          const plays = this.schedule.plays
          const answer = this.schedule.answer(poll, this.now())
          if (plays !== this.schedule.plays) this.changed()
          return { live: answer }
        }
        const err = parseLiveError(ev.message)
        if (err) {
          this.schedule.lastError = err.error
          this.deps.log?.(`live: Studio could not play version ${err.version}: ${err.error}`, 'stderr')
          this.changed()
        }
        return {}
      },
      { acceptTimeoutMs: 15_000, timeoutMs: job.timeout * 1000, preemptible: true }
    ).then(
      () => this.ended(id, null),
      (e: Error) => this.ended(id, e)
    )
  }

  private ended(id: string, e: Error | null): void {
    if (this.jobId !== id) return
    this.jobId = null
    this.starting = false
    if (this.restarting === id) {
      this.restarting = null
      this.changed()
      if (this.schedule.enabled) this.tick()
      return
    }
    if (this.schedule.enabled) {
      const retargeted = !!e && /Studio target changed/.test(e.message)
      const preempted = !!e && (retargeted || /another Studio job/.test(e.message))
      this.paused = preempted && !retargeted
      this.message = preempted && !retargeted ? 'Paused while Studio runs another job.' : undefined
      // Another place: frame the effect there.
      if (retargeted) this.framed = false
      if (e) this.deps.log?.(`live: ${e.message}`, preempted ? 'info' : 'stderr')
      // Studio refuses to create the module (Script Injection off): retrying cannot help.
      if (e && ((e as { code?: string }).code === SCRIPT_INJECTION_CODE || isScriptInjectionError(e.message))) {
        this.error = SCRIPT_INJECTION_MESSAGE
        this.errorCode = SCRIPT_INJECTION_CODE
        this.stop('stopped: Studio blocks script injection for the Forge Bridge plugin')
        return
      }
      // A job that failed, or ended before its first poll, is a failed start: retry with a
      // back-off, give up after three in a row.
      if (!preempted && (e || !this.polled)) {
        this.failures++
        this.error = e?.message ?? 'the live preview ended in Studio before it started'
        if (this.failures >= 3) {
          this.deps.log?.(`live: gave up after ${this.failures} failed starts`, 'stderr')
          this.stop('stopped after repeated failures')
          return
        }
        this.retryAt = this.now() + 2000 * this.failures
      }
    }
    this.changed()
    if (this.schedule.enabled) this.tick()
  }

  dispose(): void {
    this.stop('Forge closed')
    this.clearTimer(this.ticker)
    this.ticker = null
    const b = this.deps.bridge?.()
    if (this.jobId && b?.current?.()?.id === this.jobId) b.cancel?.('Forge closed')
  }
}
