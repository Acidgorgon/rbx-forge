import type { LogLine } from '@shared/types'

// Ring buffer of recent log lines from every service.
export class LogBuffer {
  private lines: LogLine[] = []
  private cap: number
  private onLine: (line: LogLine) => void

  constructor(onLine: (line: LogLine) => void, cap = 5000) {
    this.onLine = onLine
    this.cap = cap
  }

  push(line: Omit<LogLine, 'at'>): void {
    const full: LogLine = { ...line, at: Date.now() }
    this.lines.push(full)
    if (this.lines.length > this.cap) this.lines.splice(0, this.lines.length - this.cap)
    this.onLine(full)
  }

  get(service?: LogLine['service'], limit?: number): LogLine[] {
    const matching = service ? this.lines.filter((line) => line.service === service) : this.lines.slice()
    return limit && limit > 0 ? matching.slice(-limit) : matching
  }
}
