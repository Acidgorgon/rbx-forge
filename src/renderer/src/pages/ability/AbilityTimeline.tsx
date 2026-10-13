// The move's timeline: a ruler, the animation clip (drag to move its start) with its markers drawn
// through every row, and one row per event (drag to retime; snaps to markers within 8 px, Alt drags
// freely; a marker-relative event stays relative to its marker). Click or drag the ruler to scrub.
// A focused bar nudges with the arrow keys (one frame; Shift: 0.05 s). Changes commit on release.
import { useMemo, useRef, useState } from 'react'
import { refAt, round, snapToMarker, type ResolvedAbility } from '@shared/ability/timing'
import type { Ability, AbilityEvent, TimeRef } from '@shared/ability/types'

export const KIND_LABEL: Record<AbilityEvent['kind'], string> = { vfx: 'vfx', sound: 'sfx', shake: 'shake', screen: 'screen', hitstop: 'hit-stop', move: 'move' }

const FRAME = 1 / 60
const SNAP_PX = 8

export function eventTitle(e: AbilityEvent): string {
  if (e.label) return e.label
  if (e.kind === 'vfx') return e.effectName
  if (e.kind === 'screen') return e.effect
  if (e.kind === 'sound') return e.source.kind === 'asset' ? e.source.id.replace('rbxassetid://', '#') : e.source.name
  return e.id
}

function refText(r: TimeRef): string {
  if (!r.marker) return `${r.at.toFixed(2)} s`
  return `${r.marker}${r.at >= 0 ? '+' : ''}${r.at.toFixed(2)}`
}

interface Drag {
  id: string
  pointer: number
  x0: number
  start0: number
  start: number
  snapped: string | null
  moved: boolean
}

export function AbilityTimeline({
  ability,
  resolved,
  t,
  selected,
  onSelect,
  onScrub,
  onRetime,
  onAnimationStart
}: {
  ability: Ability
  resolved: ResolvedAbility
  t: number
  selected: string | null
  onSelect: (id: string | null) => void
  onScrub: (t: number) => void
  onRetime: (id: string, at: TimeRef) => void
  onAnimationStart: (start: number) => void
}) {
  const lanesRef = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<Drag | null>(null)
  const D = Math.max(0.1, ability.duration, resolved.end)
  const pct = (x: number) => `${Math.max(0, Math.min(100, (x / D) * 100))}%`
  const width = () => lanesRef.current?.getBoundingClientRect().width || 1
  const byId = useMemo(() => new Map(resolved.events.map((r) => [r.id, r])), [resolved])
  // Every event in authoring order (muted ones too, drawn dim).
  const rows = ability.events
  const anim = ability.animation
  const animEnd = resolved.animation?.end ?? 0

  const timeAt = (clientX: number) => {
    const r = lanesRef.current!.getBoundingClientRect()
    return Math.max(0, Math.min(D, ((clientX - r.left) / r.width) * D))
  }
  const scrubDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    onScrub(timeAt(e.clientX))
  }
  const scrubMove = (e: React.PointerEvent) => {
    if (e.currentTarget.hasPointerCapture(e.pointerId)) onScrub(timeAt(e.clientX))
  }

  const barDown = (e: React.PointerEvent, id: string, start: number) => {
    if (e.button !== 0) return
    e.stopPropagation()
    e.currentTarget.setPointerCapture(e.pointerId)
    onSelect(id === '@anim' ? null : id)
    setDrag({ id, pointer: e.pointerId, x0: e.clientX, start0: start, start, snapped: null, moved: false })
  }
  const barMove = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return
    const dx = e.clientX - drag.x0
    if (!drag.moved && Math.abs(dx) < 3) return
    let start = Math.max(drag.id === '@anim' ? 0 : -5, drag.start0 + (dx / width()) * D)
    let snapped: string | null = null
    if (!e.altKey) {
      const tol = (SNAP_PX / width()) * D
      if (drag.id === '@anim') {
        if (Math.abs(start) < tol) start = 0
      } else {
        const s = snapToMarker(ability, start, tol)
        if (s) {
          start = s.t
          snapped = s.ref.marker ?? null
        }
      }
    }
    setDrag({ ...drag, start: Math.max(0, start), snapped, moved: true })
  }
  const barUp = (e: React.PointerEvent) => {
    if (!drag || e.pointerId !== drag.pointer) return
    const d = drag
    setDrag(null)
    if (!d.moved) return
    if (d.id === '@anim') return onAnimationStart(round(d.start))
    const ev = ability.events.find((x) => x.id === d.id)
    if (!ev) return
    const s = d.snapped ? snapToMarker(ability, d.start, 1e-3) : null
    onRetime(d.id, s ? s.ref : refAt(ability, ev.at, round(d.start)))
  }
  const barKey = (e: React.KeyboardEvent, ev: AbilityEvent) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return
    e.preventDefault()
    const step = (e.shiftKey ? 0.05 : FRAME) * (e.key === 'ArrowLeft' ? -1 : 1)
    onRetime(ev.id, { ...ev.at, at: round(ev.at.at + step) })
  }

  const every = D > 6 ? 1 : D > 2.5 ? 0.5 : 0.25
  const ticks = Array.from({ length: Math.floor(D / every + 1e-6) + 1 }, (_, i) => round(i * every))
  const dragged = (id: string, start: number) => (drag?.id === id && drag.moved ? drag.start : start)

  return (
    <div className="ab-tl" role="group" aria-label="Ability timeline">
      <div className="ab-tl-row ab-tl-rulerrow">
        <span className="ab-tl-label mono faint">{t.toFixed(2)}s</span>
        <div
          ref={lanesRef}
          className="ab-tl-lane ab-tl-ruler mono"
          role="slider"
          tabIndex={0}
          aria-label="Scrub"
          aria-valuemin={0}
          aria-valuemax={round(D, 2)}
          aria-valuenow={round(t, 2)}
          aria-valuetext={`${t.toFixed(2)} s`}
          onPointerDown={scrubDown}
          onPointerMove={scrubMove}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.25 : 0.05
            const next = e.key === 'ArrowRight' ? t + step : e.key === 'ArrowLeft' ? t - step : e.key === 'Home' ? 0 : e.key === 'End' ? D : null
            if (next === null) return
            e.preventDefault()
            onScrub(Math.max(0, Math.min(D, next)))
          }}
        >
          {ticks.map((m) => (
            <span key={m} className="ab-tl-tick" style={{ left: pct(m) }}>
              {Number.isInteger(m) ? `${m}s` : ''}
            </span>
          ))}
          {resolved.markers.map((m) => (
            <span key={m.name} className="ab-tl-mlabel" style={{ left: pct(m.t) }} title={`marker ${m.name} · ${m.t.toFixed(3)} s`}>
              {m.name}
            </span>
          ))}
        </div>
      </div>

      <div className="ab-tl-row">
        <span className="ab-tl-label mono" title={anim ? `${anim.name} (${anim.clip})` : 'no animation'}>
          <i className="ab-k anim">anim</i> {anim ? anim.name : '—'}
        </span>
        <div className="ab-tl-lane" onPointerDown={scrubDown} onPointerMove={scrubMove}>
          {anim && (
            <span
              className={`ab-tl-bar anim${drag?.id === '@anim' ? ' drag' : ''}`}
              style={{ left: pct(dragged('@anim', anim.start)), width: pct(animEnd - anim.start) }}
              onPointerDown={(e) => barDown(e, '@anim', anim.start)}
              onPointerMove={barMove}
              onPointerUp={barUp}
              onPointerCancel={() => setDrag(null)}
              title={`${anim.name} · starts ${anim.start.toFixed(2)} s · speed ${anim.speed}× · drag to move`}
            />
          )}
        </div>
      </div>

      {rows.map((ev) => {
        const r = byId.get(ev.id)
        const start = r?.start ?? 0
        const len = r ? r.end - r.start : 0
        const s = dragged(ev.id, start)
        return (
          <div key={ev.id} className={`ab-tl-row${selected === ev.id ? ' on' : ''}${ev.muted ? ' muted' : ''}`}>
            <button className="ab-tl-label mono" onClick={() => onSelect(selected === ev.id ? null : ev.id)} aria-pressed={selected === ev.id} title={`${ev.id} · ${refText(ev.at)}`}>
              <i className={`ab-k ${ev.kind}`}>{KIND_LABEL[ev.kind]}</i> {eventTitle(ev)}
            </button>
            <div className="ab-tl-lane" onPointerDown={scrubDown} onPointerMove={scrubMove}>
              <button
                className={`ab-tl-bar ${ev.kind}${selected === ev.id ? ' on' : ''}${drag?.id === ev.id ? ' drag' : ''}`}
                style={{ left: pct(s), width: `max(4px, ${pct(len)})` }}
                onPointerDown={(e) => barDown(e, ev.id, start)}
                onPointerMove={barMove}
                onPointerUp={barUp}
                onPointerCancel={() => setDrag(null)}
                onKeyDown={(e) => barKey(e, ev)}
                aria-label={`${KIND_LABEL[ev.kind]} ${eventTitle(ev)} at ${refText(ev.at)}; arrow keys nudge`}
                title={`${ev.id} · ${refText(ev.at)} · ${start.toFixed(3)}–${(start + len).toFixed(3)} s${ev.muted ? ' · muted' : ''}`}
              />
              {drag?.id === ev.id && drag.moved && (
                <span className="ab-tl-drag mono" style={{ left: pct(drag.start) }}>
                  {drag.snapped ? `⟶ ${drag.snapped}` : `${drag.start.toFixed(2)}s`}
                </span>
              )}
            </div>
          </div>
        )
      })}
      {!rows.length && (
        <div className="ab-tl-row">
          <span className="ab-tl-label" />
          <span className="ab-tl-empty faint">no events yet · add one below</span>
        </div>
      )}

      <div className="ab-tl-over" aria-hidden>
        {resolved.markers.map((m) => (
          <span key={m.name} className={`ab-tl-marker${drag?.snapped === m.name ? ' hot' : ''}`} style={{ left: pct(m.t) }} />
        ))}
        <span className="ab-tl-head" style={{ left: pct(t) }} />
        <span className="ab-tl-end" style={{ left: pct(ability.duration) }} />
      </div>
    </div>
  )
}
