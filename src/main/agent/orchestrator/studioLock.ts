// Fair FIFO mutex for live Roblox Studio access (Bridge / MCP / Playtest / Insert / Delete).
// Prevents overlapping agents or labs from corrupting Studio state and recovers from hung workers
// via automatic lease expiry. No electron imports.

import type { StudioLockHolder, StudioLockStatus, StudioLockWaiter } from '../../../shared/studioLockTypes.ts'

export const DEFAULT_STUDIO_LOCK_LEASE_MS = 60_000

export interface AcquireOptions {
  leaseMs?: number
  signal?: AbortSignal
}

export interface StudioTurnLockOptions {
  defaultLeaseMs?: number
  now?: () => number
  onChange?: (status: StudioLockStatus) => void
  onTimeout?: (expired: StudioLockHolder) => void
}

interface InternalHolder {
  token: symbol
  info: StudioLockHolder
  timer: ReturnType<typeof setTimeout> | null
}

interface InternalWaiter {
  info: StudioLockWaiter
  leaseMs: number
  resolve: (release: () => void) => void
  reject: (err: Error) => void
  abortCleanup?: () => void
}

function makeAbortError(message = 'Studio turn lock acquire aborted'): Error {
  const err = new Error(message)
  err.name = 'AbortError'
  return err
}

export class StudioTurnLock {
  private defaultLeaseMs: number
  private now: () => number
  private listeners = new Set<(status: StudioLockStatus) => void>()
  private onTimeout?: (expired: StudioLockHolder) => void
  private holder: InternalHolder | null = null
  private waiters: InternalWaiter[] = []
  private disposed = false

  constructor(opts: StudioTurnLockOptions = {}) {
    this.defaultLeaseMs = Math.max(50, opts.defaultLeaseMs ?? DEFAULT_STUDIO_LOCK_LEASE_MS)
    this.now = opts.now ?? Date.now
    if (opts.onChange) this.listeners.add(opts.onChange)
    this.onTimeout = opts.onTimeout
  }

  onChange(fn: (status: StudioLockStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  status(): StudioLockStatus {
    return {
      holder: this.holder ? { ...this.holder.info } : null,
      queue: this.waiters.map((w) => ({ ...w.info }))
    }
  }

  private notify(): void {
    const st = this.status()
    for (const fn of this.listeners) {
      try {
        fn(st)
      } catch {
        // listener errors must not break lock handoff
      }
    }
  }

  private syncTimerRef(): void {
    const t = this.holder?.timer as { ref?: () => void; unref?: () => void } | null | undefined
    if (!t) return
    if (this.waiters.length > 0) t.ref?.()
    else t.unref?.()
  }

  private grantTo(owner: string, reason: string, leaseMs: number): () => void {
    const token = Symbol(owner)
    const acquiredAt = this.now()
    const effectiveLease = Math.max(10, leaseMs)
    const info: StudioLockHolder = {
      owner,
      reason,
      acquiredAt,
      expiresAt: acquiredAt + effectiveLease
    }
    const timer = setTimeout(() => {
      if (this.holder?.token !== token) return
      const expired = { ...this.holder.info }
      this.releaseToken(token)
      this.onTimeout?.(expired)
    }, effectiveLease)

    this.holder = { token, info, timer }
    this.syncTimerRef()
    this.notify()

    let released = false
    return () => {
      if (released) return
      released = true
      this.releaseToken(token)
    }
  }

  private releaseToken(token: symbol): void {
    if (this.holder?.token !== token) return
    if (this.holder.timer) clearTimeout(this.holder.timer)
    this.holder = null

    // Hand off strictly in FIFO order to the next non-disposed waiter.
    while (!this.disposed && this.waiters.length > 0) {
      const next = this.waiters.shift()!
      next.abortCleanup?.()
      const release = this.grantTo(next.info.owner, next.info.reason, next.leaseMs)
      next.resolve(release)
      return
    }
    this.notify()
  }

  acquire(owner: string, reason: string, opts: AcquireOptions = {}): Promise<() => void> {
    if (this.disposed) return Promise.reject(new Error('StudioTurnLock disposed'))
    if (opts.signal?.aborted) return Promise.reject(makeAbortError())

    const leaseMs = opts.leaseMs ?? this.defaultLeaseMs
    if (!this.holder && this.waiters.length === 0) {
      return Promise.resolve(this.grantTo(owner, reason, leaseMs))
    }

    return new Promise<() => void>((resolve, reject) => {
      const waiter: InternalWaiter = {
        info: { owner, reason, queuedAt: this.now() },
        leaseMs,
        resolve,
        reject
      }
      if (opts.signal) {
        const onAbort = () => {
          const idx = this.waiters.indexOf(waiter)
          if (idx >= 0) {
            this.waiters.splice(idx, 1)
            this.syncTimerRef()
            this.notify()
            reject(makeAbortError())
          }
        }
        opts.signal.addEventListener('abort', onAbort, { once: true })
        waiter.abortCleanup = () => opts.signal?.removeEventListener('abort', onAbort)
      }
      this.waiters.push(waiter)
      this.syncTimerRef()
      this.notify()
    })
  }

  async withLock<T>(owner: string, reason: string, fn: () => Promise<T>, opts: AcquireOptions = {}): Promise<T> {
    const release = await this.acquire(owner, reason, opts)
    try {
      return await fn()
    } finally {
      release()
    }
  }

  forceRelease(_reason?: string): boolean {
    if (!this.holder) return false
    this.releaseToken(this.holder.token)
    return true
  }

  dispose(): void {
    this.disposed = true
    if (this.holder?.timer) clearTimeout(this.holder.timer)
    this.holder = null
    const pending = this.waiters.splice(0, this.waiters.length)
    for (const w of pending) {
      w.abortCleanup?.()
      w.reject(new Error('StudioTurnLock disposed'))
    }
    this.notify()
  }
}
