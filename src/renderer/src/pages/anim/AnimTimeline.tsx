// Timeline for a clip: beat bands (anticipation / action / recovery labels from a:beat), marker
// diamonds (the names game code listens for), key ticks per body group, a ruler and the playhead.
// Click or drag to scrub; arrow keys step one frame at 30 fps (shift: 1/4 s), PageUp / PageDown jump
// between keys, Home / End jump to the ends. The strip is a slider for screen readers.
import { useMemo, useRef } from 'react'
import type { AnimClip } from '@shared/types'

// R15 joint names plus the R6 Motor6D names, so both rigs fill the same three rows.
const GROUPS: { label: string; joints: string[] }[] = [
  { label: 'body', joints: ['Root', 'Waist', 'Neck', 'RootJoint'] },
  { label: 'arms', joints: ['LeftShoulder', 'LeftElbow', 'LeftWrist', 'RightShoulder', 'RightElbow', 'RightWrist', 'Left Shoulder', 'Right Shoulder'] },
  { label: 'legs', joints: ['LeftHip', 'LeftKnee', 'LeftAnkle', 'RightHip', 'RightKnee', 'RightAnkle', 'Left Hip', 'Right Hip'] }
]

function keyTimesOf(clip: AnimClip, joints: string[]): number[] {
  const set = new Set<number>()
  const tracks = clip.tracks as Record<string, { t: number }[] | undefined>
  for (const j of joints) for (const k of tracks[j] ?? []) set.add(Math.round(k.t * 100) / 100)
  return [...set].sort((a, b) => a - b)
}

export function AnimTimeline({ clip, t, onScrub }: { clip: AnimClip; t: number; onScrub: (t: number) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const D = Math.max(0.01, clip.duration)
  const beats = useMemo(() => [...(clip.beats ?? [])].sort((a, b) => a.at - b.at), [clip])
  const rows = useMemo(() => GROUPS.map((g) => ({ label: g.label, times: keyTimesOf(clip, g.joints) })), [clip])
  const allKeys = useMemo(() => [...new Set(rows.flatMap((r) => r.times))].sort((a, b) => a - b), [rows])
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / D) * 100))}%`
  const beatNow = beats.filter((b) => b.at <= t + 1e-6).pop()

  const fromEvent = (clientX: number) => {
    const r = ref.current!.getBoundingClientRect()
    onScrub(Math.max(0, Math.min(D, ((clientX - r.left) / r.width) * D)))
  }
  const onKey = (e: React.KeyboardEvent) => {
    let next: number | null = null
    if (e.key === 'ArrowRight') next = t + (e.shiftKey ? 0.25 : 1 / 30)
    else if (e.key === 'ArrowLeft') next = t - (e.shiftKey ? 0.25 : 1 / 30)
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = D
    else if (e.key === 'PageDown') next = allKeys.find((k) => k > t + 0.005) ?? D
    else if (e.key === 'PageUp') next = [...allKeys].reverse().find((k) => k < t - 0.005) ?? 0
    if (next === null) return
    e.preventDefault()
    onScrub(Math.max(0, Math.min(D, next)))
  }
  const every = D > 6 ? 1 : D > 2 ? 0.5 : 0.25
  const marks = Array.from({ length: Math.floor(D / every + 1e-6) + 1 }, (_, i) => Math.round(i * every * 100) / 100)

  return (
    <div
      ref={ref}
      className="anim-tl"
      role="slider"
      tabIndex={0}
      aria-label="Timeline"
      aria-valuemin={0}
      aria-valuemax={Math.round(D * 100) / 100}
      aria-valuenow={Math.round(t * 100) / 100}
      aria-valuetext={`${t.toFixed(2)} s, frame ${Math.round(t * 30)}${beatNow ? `, ${beatNow.label}` : ''}`}
      onPointerDown={(e) => {
        if (e.button !== 0) return
        e.currentTarget.setPointerCapture(e.pointerId)
        fromEvent(e.clientX)
      }}
      onPointerMove={(e) => e.currentTarget.hasPointerCapture(e.pointerId) && fromEvent(e.clientX)}
      onKeyDown={onKey}
    >
      <div className="anim-tl-beats">
        {beats.map((b, i) => {
          const end = beats[i + 1]?.at ?? D
          return (
            <span key={`${b.label}-${i}`} className={`anim-tl-beat${i % 2 ? ' alt' : ''}${beatNow === b ? ' now' : ''}`} style={{ left: pct(b.at), width: pct(end - b.at) }} title={`${b.label} · ${b.at.toFixed(2)}–${end.toFixed(2)} s`}>
              {b.label}
            </span>
          )
        })}
        {!beats.length && <span className="anim-tl-none faint">no beats · a:beat("anticipation") labels them</span>}
      </div>
      <div className="anim-tl-markers">
        {clip.markers.map((m, i) => (
          <span key={`${m.name}-${i}`} className={`anim-tl-marker${Math.abs(m.t - t) < 0.04 ? ' hit' : ''}`} style={{ left: pct(m.t) }} title={`marker "${m.name}" · ${m.t.toFixed(2)} s (GetMarkerReachedSignal)`}>
            <i aria-hidden />
            <b>{m.name}</b>
          </span>
        ))}
      </div>
      {rows.map((r) => (
        <div key={r.label} className="anim-tl-row">
          <span className="anim-tl-lab mono">{r.label}</span>
          {r.times.slice(0, 400).map((k) => (
            <span key={k} className="anim-tl-key" style={{ left: pct(k) }} />
          ))}
        </div>
      ))}
      <div className="anim-tl-ruler mono" aria-hidden>
        {marks.map((m) => (
          <span key={m} style={{ left: pct(m) }}>
            {Number.isInteger(m) || every < 1 ? `${m}s` : ''}
          </span>
        ))}
      </div>
      <span className="anim-tl-head" style={{ left: pct(t) }} aria-hidden />
    </div>
  )
}
