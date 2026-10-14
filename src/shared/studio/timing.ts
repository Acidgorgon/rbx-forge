// Timing sync between the Studio plugin's clock and Forge's, and the choice of captured frames.
//
// The plugin cannot screenshot (plugins have no capture API), so Forge records the Studio window and
// picks frames by wall-clock time. The plugin reports, right after it starts the play, how long ago
// it started (`elapsed`, its os.clock) and the round trip of a ping it just made (`rtt`). Forge maps
// that to its own clock:
//
//   start = receivedAt - rtt / 2 - elapsed
//
// and a beat at t seconds shows on screen around start + t + lag (Studio renders the frame after the
// change, and the window capture adds a frame or two). Pure functions, tested in test/studio.test.ts;
// the capture page (renderer) uses NearestFramePicker on its live frames.

export const DEFAULT_LAG_MS = 50
// A target is settled once a frame this much later than it has arrived (nothing closer can come).
export const SETTLE_MS = 120

export function startEpoch(ev: { receivedAt: number; elapsed: number; rtt: number }): number {
  return ev.receivedAt - Math.max(0, ev.rtt) / 2 - Math.max(0, ev.elapsed) * 1000
}

// Wall-clock targets (ms) for beat times (s).
export function beatTargets(start: number, beats: number[], lagMs = DEFAULT_LAG_MS): number[] {
  return beats.map((t) => Math.round(start + t * 1000 + lagMs))
}

export interface PickedFrame<T> {
  ts: number
  frame: T
  offsetMs: number
}

// Keeps, for each target time, the offered frame closest to it. Frames come in time order; a frame
// that was offered before the targets were known is offered again from the recent buffer.
export class NearestFramePicker<T> {
  readonly targets: number[]
  private best: (PickedFrame<T> | null)[]
  private latest = -Infinity

  constructor(targets: number[]) {
    this.targets = [...targets]
    this.best = targets.map(() => null)
  }

  // Returns the indices this frame became the best for.
  offer(ts: number, frame: T): number[] {
    const won: number[] = []
    this.latest = Math.max(this.latest, ts)
    for (const [i, target] of this.targets.entries()) {
      const d = Math.abs(ts - target)
      const cur = this.best[i]
      if (!cur || d < Math.abs(cur.offsetMs)) {
        this.best[i] = { ts, frame, offsetMs: ts - target }
        won.push(i)
      }
    }
    return won
  }

  settled(settleMs = SETTLE_MS): boolean {
    return this.targets.every((t, i) => this.best[i] !== null && this.latest >= t + settleMs)
  }

  picks(): (PickedFrame<T> | null)[] {
    return [...this.best]
  }
}

// A ring of recent frames (the capture page keeps ~1.5 s so the first beat can be resolved even when
// the plugin's "start" event arrives after it).
export class FrameRing<T> {
  private items: { ts: number; frame: T }[] = []
  private keepMs: number
  private onDrop?: (frame: T) => void

  constructor(keepMs: number, onDrop?: (frame: T) => void) {
    this.keepMs = keepMs
    this.onDrop = onDrop
  }

  push(ts: number, frame: T): void {
    this.items.push({ ts, frame })
    while (this.items.length && this.items[0].ts < ts - this.keepMs) {
      const old = this.items.shift()!
      this.onDrop?.(old.frame)
    }
  }

  all(): { ts: number; frame: T }[] {
    return [...this.items]
  }

  // Removes and returns everything (the caller owns the frames).
  drain(): { ts: number; frame: T }[] {
    const out = this.items
    this.items = []
    return out
  }

  get size(): number {
    return this.items.length
  }
}

// The first frame at or after a time (stepped capture: the pose is applied, give Studio a frame).
export function firstAtOrAfter<T>(frames: { ts: number; frame: T }[], at: number): { ts: number; frame: T } | null {
  for (const f of frames) if (f.ts >= at) return f
  return null
}

// Stage times the plugin reported against the planned ones (same label, in order).
export function stageDrift(planned: { label: string; at: number }[], marks: { label: string; t: number }[]): { label: string; planned: number; actual: number }[] {
  const out: { label: string; planned: number; actual: number }[] = []
  const used = new Set<number>()
  for (const p of planned) {
    const i = marks.findIndex((m, k) => !used.has(k) && m.label === p.label)
    if (i < 0) continue
    used.add(i)
    out.push({ label: p.label, planned: round3(p.at), actual: round3(marks[i].t) })
  }
  return out
}

function round3(x: number): number {
  return Math.round(x * 1000) / 1000
}
