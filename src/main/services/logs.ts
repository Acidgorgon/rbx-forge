import type { LogLine } from '@shared/types'

export interface LogBufferOptions {
  // Lines kept (oldest dropped first).
  cap?: number
  // Lines pushed within this window reach onLines together (ms). 0 delivers each push at once.
  batchMs?: number
}

// Ring buffer of recent log lines from every service. Listeners get lines in batches (one call per
// batchMs) so a chatty service costs one IPC message per window instead of one per line.
export class LogBuffer {
  private ring: (LogLine | undefined)[]
  // Next write position and how many lines are held.
  private head = 0
  private size = 0
  private cap: number
  private batchMs: number
  private onLines: (lines: LogLine[]) => void
  private batch: LogLine[] = []
  private timer: ReturnType<typeof setTimeout> | null = null

  constructor(onLines: (lines: LogLine[]) => void, options: LogBufferOptions = {}) {
    this.onLines = onLines
    this.cap = Math.max(1, options.cap ?? 5000)
    this.batchMs = options.batchMs ?? 100
    this.ring = new Array(this.cap)
  }

  push(line: Omit<LogLine, 'at'>): void {
    const full: LogLine = { ...line, at: Date.now() }
    this.ring[this.head] = full
    this.head = (this.head + 1) % this.cap
    if (this.size < this.cap) this.size++
    if (this.batchMs <= 0) {
      this.onLines([full])
      return
    }
    this.batch.push(full)
    // A batch never outgrows the buffer: older lines in it would be gone from get() anyway.
    if (this.batch.length > this.cap) this.batch.splice(0, this.batch.length - this.cap)
    if (!this.timer) {
      this.timer = setTimeout(() => this.flush(), this.batchMs)
      ;(this.timer as { unref?: () => void }).unref?.()
    }
  }

  // Delivers the pending batch now.
  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (!this.batch.length) return
    const lines = this.batch
    this.batch = []
    this.onLines(lines)
  }

  get(service?: LogLine['service'], limit?: number): LogLine[] {
    const all = this.ordered()
    const matching = service ? all.filter((line) => line.service === service) : all
    return limit && limit > 0 ? matching.slice(-limit) : matching
  }

  // Held lines, oldest first.
  private ordered(): LogLine[] {
    const out: LogLine[] = new Array(this.size)
    const start = (this.head - this.size + this.cap) % this.cap
    for (let i = 0; i < this.size; i++) out[i] = this.ring[(start + i) % this.cap] as LogLine
    return out
  }
}
