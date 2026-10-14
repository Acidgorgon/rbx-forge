// Rojo serve resilience (no electron imports, unit tested in test/rojoRestart.test.ts):
//   - RestartPolicy: backoff for restarting a crashed rojo serve, reset after a stable run, and a
//     give-up after too many quick failures (the UI then shows a Restart button instead of looping).
//   - isRojoPanic: rojo's panic output ("panicked at", "Result::unwrap()" on an Err). rojo 7 panics in
//     its change processor when a watched folder vanishes mid-event (canonicalize NotFound) and can
//     stay up half-dead, so the supervisor kills and restarts it.
//   - gateAction: what the Forge Sync gate means for one rojo serve process.
//   - RojoPause: stops rojo around Forge's own user-initiated folder deletes / renames (Explorer,
//     feature rename; the trigger of that panic) and starts it again once the file system has
//     settled. Overlapping operations share one pause. Studio-driven deletes written by Forge Sync are
//     deliberately not paused (they are frequent and a stop disconnects Studio's Rojo plugin); a rare
//     crash there is covered by the auto-restart.
import { lstat } from 'node:fs/promises'

export const ROJO_BACKOFF_MS = [500, 1000, 2000, 5000]
// A run this long counts as stable: the next crash starts the backoff from the beginning.
export const ROJO_STABLE_MS = 30_000
// Crashes in a row (each before ROJO_STABLE_MS) before giving up.
export const ROJO_MAX_QUICK_FAILURES = 5

export type RestartDecision = { action: 'restart'; delayMs: number; attempt: number } | { action: 'give-up'; failures: number }

export interface RestartPolicyOptions {
  backoffMs?: number[]
  stableMs?: number
  maxQuickFailures?: number
}

export class RestartPolicy {
  private backoffMs: number[]
  private stableMs: number
  private maxQuick: number
  private startedAt = 0
  private count = 0

  constructor(options: RestartPolicyOptions = {}) {
    this.backoffMs = options.backoffMs?.length ? options.backoffMs : ROJO_BACKOFF_MS
    this.stableMs = options.stableMs ?? ROJO_STABLE_MS
    this.maxQuick = options.maxQuickFailures ?? ROJO_MAX_QUICK_FAILURES
  }

  get failures(): number {
    return this.count
  }

  // The process (re)started at `now`.
  started(now: number): void {
    this.startedAt = now
  }

  // The process ran this long without crashing: forget earlier failures (timer-driven callers).
  stable(): void {
    this.count = 0
  }

  // The process exited unexpectedly at `now`.
  failed(now: number): RestartDecision {
    if (this.startedAt && now - this.startedAt >= this.stableMs) this.count = 0
    this.count++
    if (this.count > this.maxQuick) return { action: 'give-up', failures: this.count - 1 }
    const delayMs = this.backoffMs[Math.min(this.count - 1, this.backoffMs.length - 1)]
    return { action: 'restart', delayMs, attempt: this.count }
  }

  reset(): void {
    this.count = 0
    this.startedAt = 0
  }
}

const PANIC = [/\bpanicked at\b/i, /thread '[^']*' panicked/i, /called `(Result|Option)::unwrap\(\)`/, /\bRojo crashed!?/i]

export function isRojoPanic(line: string): boolean {
  return PANIC.some((re) => re.test(line))
}

// "0.5s", "2s"
export function secondsText(ms: number): string {
  const s = ms / 1000
  return `${Number.isInteger(s) ? s : s.toFixed(1)}s`
}

// What the Forge Sync gate means for one rojo serve: stop a running one it now holds, note the reason
// on one that is already waiting, start one it no longer holds, or nothing.
export type GateAction = 'stop' | 'wait' | 'start' | 'none'

export function gateAction(p: { holds: boolean; running: boolean; held: boolean }): GateAction {
  if (p.holds) return p.running ? 'stop' : 'wait'
  return p.held ? 'start' : 'none'
}

export interface RojoPauseDeps {
  // Stops rojo serve if it runs; true when it did (so resume starts it again).
  pause: (reason: string) => Promise<boolean>
  resume: () => Promise<void>
  // Quiet time after the last operation before rojo starts again (default 400ms).
  settleMs?: number
  log?: (text: string) => void
}

export class RojoPause {
  private deps: RojoPauseDeps
  private active = 0
  private paused: Promise<boolean> | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: RojoPauseDeps) {
    this.deps = deps
  }

  // Runs fn with rojo stopped (when `needed`), restarting it after the last overlapping op settles.
  async run<T>(fn: () => Promise<T>, reason = 'folder change', needed = true): Promise<T> {
    if (!needed) return fn()
    this.active++
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.paused) this.paused = this.deps.pause(reason).catch(() => false)
    try {
      await this.paused
      return await fn()
    } finally {
      this.active--
      if (this.active === 0) this.scheduleResume()
    }
  }

  // Runs fn with rojo stopped only when `full` is a directory (a file change does not trip rojo).
  async aroundPath<T>(full: string, fn: () => Promise<T>, reason = 'folder change'): Promise<T> {
    const info = await lstat(full).catch(() => null)
    return this.run(fn, reason, !!info?.isDirectory())
  }

  private scheduleResume(): void {
    this.timer = setTimeout(() => {
      this.timer = null
      if (this.active) return
      const paused = this.paused
      this.paused = null
      void (async () => {
        if (!(await paused)) return
        await this.deps.resume().catch((error) => this.deps.log?.(`rojo resume: ${error}`))
      })()
    }, this.deps.settleMs ?? 400)
  }
}
