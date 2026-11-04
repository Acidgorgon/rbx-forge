// "Play Studio selection" (VFX Lab header): Roblox Studio plays its current selection with ForgeVFX
// through one Forge Bridge job (shared/vfx/emitStudio.ts), once or looped with a gap until Stop.
// The job is preemptible: it replaces a running Live loop (which resumes after it), and any other
// Studio job (a capture, a mesh read) stops it. No electron imports (the bridge and timers are
// injected, so tests drive it with a fake bridge).

import { randomBytes } from 'node:crypto'
import { isScriptInjectionError, SCRIPT_INJECTION_CODE, SCRIPT_INJECTION_MESSAGE } from '../../../shared/studio/errors.ts'
import { normalizeGap, parsePlayError, parsePlayInfo, parsePlayPoll, playAnswer, playSelectionJob, type SelectionPlayStatus } from '../../../shared/vfx/emitStudio.ts'
import type { LiveBridge } from './live.ts'

export type { SelectionPlayStatus }

export interface SelectionPlayDeps {
  bridge?: () => LiveBridge | undefined
  emit?: (event: 'vfx:selection', payload: SelectionPlayStatus) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  setTimer?: (fn: () => void, ms: number) => unknown
}

export class SelectionPlayError extends Error {}

export class SelectionPlayer {
  private deps: SelectionPlayDeps
  private jobId: string | null = null
  private stopping: string | null = null
  private st: SelectionPlayStatus = { state: 'off', loop: false, gap: normalizeGap(undefined), plays: 0, names: [], count: 0 }

  constructor(deps: SelectionPlayDeps) {
    this.deps = deps
  }

  status(): SelectionPlayStatus {
    return { ...this.st, names: [...this.st.names] }
  }

  private set(patch: Partial<SelectionPlayStatus>): void {
    this.st = { ...this.st, ...patch }
    this.deps.emit?.('vfx:selection', this.status())
  }

  // Starts a play (a running one is replaced). Resolves once the job is queued; vfx:selection reports.
  play(opts: { loop?: boolean; gap?: number } = {}): SelectionPlayStatus {
    const b = this.deps.bridge?.()
    if (!b?.listening) throw new SelectionPlayError('The Forge Bridge is not running (Studio checks are off).')
    if (!b.connected()) throw new SelectionPlayError('Roblox Studio is not connected: open Studio with the Forge Bridge plugin on.')
    const other = b.current?.()
    if (other && other.id !== this.jobId && !other.id.startsWith('job-live-')) throw new SelectionPlayError('Studio is busy with another Forge job; try again when it is done.')
    const id = `job-vfxplay-${randomBytes(5).toString('hex')}`
    const loop = !!opts.loop
    const gap = normalizeGap(opts.gap ?? this.st.gap)
    const job = playSelectionJob({ id, port: b.port, loop, gap })
    this.jobId = id
    this.stopping = null
    this.st = { state: 'starting', loop, gap, plays: 0, names: [], count: 0 }
    this.set({ state: 'starting' })
    this.deps.log?.(`vfx: playing the Studio selection${loop ? ' (loop)' : ''}`)
    b.run(job, (ev) => this.onEvent(id, ev), { acceptTimeoutMs: 15_000, timeoutMs: job.timeout * 1000, preemptible: true }).then(
      () => this.ended(id, null),
      (e: Error) => this.ended(id, e)
    )
    return this.status()
  }

  // Loop gap (applies on the next poll).
  setGap(gap: number): SelectionPlayStatus {
    this.set({ gap: normalizeGap(gap) })
    return this.status()
  }

  // The module stops on its next poll; a job that does not end is cancelled.
  stop(): SelectionPlayStatus {
    const id = this.jobId
    if (!id) return this.status()
    this.stopping = id
    const cancel = () => {
      const b = this.deps.bridge?.()
      if (this.jobId === id && b?.current?.()?.id === id) b.cancel?.('selection play stopped')
    }
    // A one-shot play does not poll: cancel it now; a loop gets one poll to clean up first.
    if (!this.st.loop) cancel()
    else (this.deps.setTimer ?? ((f, ms) => setTimeout(f, ms)))(cancel, 1500)
    return this.status()
  }

  dispose(): void {
    const id = this.jobId
    if (!id) return
    this.stopping = id
    const b = this.deps.bridge?.()
    if (b?.current?.()?.id === id) b.cancel?.('Forge closed')
  }

  private onEvent(id: string, ev: { type: string; message?: string }): unknown {
    const mine = this.jobId === id
    if (ev.type === 'accepted' && mine) this.set({ state: 'playing' })
    if (ev.type !== 'log' || typeof ev.message !== 'string') return {}
    const poll = parsePlayPoll(ev.message)
    if (poll) {
      if (!mine || this.stopping === id) return playAnswer({ stop: true, gap: this.st.gap })
      if (poll.plays !== this.st.plays) this.set({ plays: poll.plays })
      return playAnswer({ gap: this.st.gap })
    }
    if (!mine) return {}
    const info = parsePlayInfo(ev.message)
    if (info) {
      this.set({ names: info.names, count: info.count, plays: Math.max(this.st.plays, 1) })
      return {}
    }
    const err = parsePlayError(ev.message)
    if (err) {
      this.deps.log?.(`vfx: Studio selection: ${err}`, 'stderr')
      this.set({ error: err })
    }
    return {}
  }

  private ended(id: string, e: Error | null): void {
    if (this.jobId !== id) return
    this.jobId = null
    const stopped = this.stopping === id
    this.stopping = null
    if (e && !stopped && !/another Studio job|selection play stopped|Forge closed/.test(e.message)) {
      const injection = (e as { code?: string }).code === SCRIPT_INJECTION_CODE || isScriptInjectionError(e.message)
      this.deps.log?.(`vfx: Studio selection: ${e.message}`, 'stderr')
      this.set({ state: 'off', error: injection ? SCRIPT_INJECTION_MESSAGE : e.message, ...(injection ? { errorCode: SCRIPT_INJECTION_CODE } : {}) })
      return
    }
    this.set({ state: 'off' })
  }
}
