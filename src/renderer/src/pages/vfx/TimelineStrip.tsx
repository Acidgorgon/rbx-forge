// Timeline strip for scripted (multi-stage) effects: stage bands with labels, tween bars, emit /
// enable / disable ticks and a playhead. Click or drag to scrub; arrow keys step 1/20 s (shift: 1/4 s),
// Home / End jump, and the strip is a slider for screen readers.
import { useMemo, useRef } from 'react'
import type { VfxCue, VfxEffect, VfxNode } from '@shared/types'

const MAX_ROWS = 4

interface Bar {
  cue: VfxCue
  row: number
  label: string
}

function nameMap(effect: VfxEffect): Map<string, string> {
  const m = new Map<string, string>()
  const walk = (n: VfxNode) => {
    m.set(n.id, n.name)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return m
}

function goalsText(c: VfxCue): string {
  return Object.keys(c.props ?? {}).join(', ')
}

// Tween bars packed into rows (first row whose last bar ended before this one starts).
function packBars(cues: VfxCue[], names: Map<string, string>, D: number): Bar[] {
  const ends: number[] = []
  const out: Bar[] = []
  const gap = D * 0.004
  for (const c of cues) {
    if (c.action !== 'tween' || c.prelude) continue
    const end = c.at + (c.duration ?? 0)
    let row = ends.findIndex((e) => e + gap <= c.at)
    if (row < 0) row = ends.length < MAX_ROWS ? ends.length : ends.indexOf(Math.min(...ends))
    ends[row] = Math.max(ends[row] ?? 0, end)
    out.push({ cue: c, row, label: `${names.get(c.target) ?? '?'} ${goalsText(c)}` })
  }
  return out
}

export function hasTimeline(effect: VfxEffect): boolean {
  return !!effect.stages?.length || effect.cues.some((c) => c.action === 'tween' || c.action === 'set')
}

export function TimelineStrip({ effect, t, onScrub }: { effect: VfxEffect; t: number; onScrub: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const D = Math.max(0.01, effect.duration)
  const names = useMemo(() => nameMap(effect), [effect])
  const stages = useMemo(() => [...(effect.stages ?? [])].sort((a, b) => a.at - b.at), [effect])
  const bars = useMemo(() => packBars([...effect.cues].sort((a, b) => a.at - b.at), names, D), [effect, names, D])
  const rows = Math.max(1, ...bars.map((b) => b.row + 1))
  const ticks = useMemo(() => effect.cues.filter((c) => !c.prelude && (c.action === 'emit' || c.action === 'enable' || c.action === 'disable')), [effect])
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / D) * 100))}%`
  const stageNow = stages.filter((s) => s.at <= t + 1e-6).pop()

  const fromEvent = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    onScrub(Math.max(0, Math.min(D, ((clientX - r.left) / r.width) * D)))
  }
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    fromEvent(e.clientX)
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) fromEvent(e.clientX)
  }
  const onKey = (e: React.KeyboardEvent) => {
    const step = e.shiftKey ? 0.25 : 0.05
    let next: number | null = null
    if (e.key === 'ArrowRight') next = t + step
    else if (e.key === 'ArrowLeft') next = t - step
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = D
    else if (e.key === 'PageDown' || e.key === 'PageUp') {
      // Jump between stages.
      const starts = stages.map((s) => s.at)
      next = e.key === 'PageDown' ? starts.find((a) => a > t + 0.001) ?? D : [...starts].reverse().find((a) => a < t - 0.001) ?? 0
    }
    if (next === null) return
    e.preventDefault()
    onScrub(Math.max(0, Math.min(D, next)))
  }

  // Ruler: a label every 0.5 s (every 1 s past 6 s).
  const every = D > 6 ? 1 : 0.5
  const marks = Array.from({ length: Math.floor(D / every) + 1 }, (_, i) => i * every)

  return (
    <div
      ref={ref}
      className="vfx-tl"
      style={{ ['--tl-rows' as string]: rows }}
      role="slider"
      tabIndex={0}
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(D * 100) / 100}
      aria-valuenow={Math.round(t * 100) / 100}
      aria-valuetext={`${t.toFixed(2)} s${stageNow ? `, ${stageNow.label}` : ''}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onKeyDown={onKey}
    >
      <div className="vfx-tl-stages">
        {stages.map((s, i) => {
          const end = stages[i + 1]?.at ?? D
          return (
            <span key={`${s.label}-${i}`} className={`vfx-tl-stage${i % 2 ? ' alt' : ''}${stageNow === s ? ' now' : ''}`} style={{ left: pct(s.at), width: pct(end - s.at) }} title={`${s.label} · ${s.at.toFixed(2)}–${end.toFixed(2)} s`}>
              {s.label}
            </span>
          )
        })}
        {!stages.length && <span className="vfx-tl-none faint">no stages · add fx:stage("charge") to the script</span>}
      </div>
      <div className="vfx-tl-bars">
        {bars.map((b, i) => (
          <span key={i} className="vfx-tl-bar" style={{ left: pct(b.cue.at), width: `max(3px, ${pct(b.cue.duration ?? 0)})`, top: `calc(${b.row} * var(--tl-row))` }} title={`${b.cue.at.toFixed(2)} s · tween ${b.label} · ${b.cue.duration}s ${b.cue.style ?? 'Quad'} ${b.cue.direction ?? 'Out'}`} />
        ))}
      </div>
      <div className="vfx-tl-ticks">
        {ticks.map((c, i) => (
          <span key={i} className={`vfx-tl-tick ${c.action}`} style={{ left: pct(c.at) }} title={`${c.at.toFixed(2)} s · ${c.action}${c.action === 'emit' ? ` ${c.count ?? 16}` : ''} ${names.get(c.target) ?? ''}`} />
        ))}
      </div>
      <div className="vfx-tl-ruler mono" aria-hidden>
        {marks.map((m) => (
          <span key={m} style={{ left: pct(m) }}>
            {Number.isInteger(m) ? `${m}s` : ''}
          </span>
        ))}
      </div>
      <span className="vfx-tl-head" style={{ left: pct(t) }} aria-hidden />
    </div>
  )
}
