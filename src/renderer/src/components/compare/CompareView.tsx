// Compare any two versions (shared/compare): pick A and B from a lab's items, play them side by side
// on one clock (synced scrubber, speed, loop; same seconds or stretched to the same length) or flip
// A/B in one frame, and read the score, rubric, principle and parameter deltas underneath.
//
// Generic over the lab: a lab passes its CompareItems and a renderPane(item, ctx) that draws one
// version. Canvas labs wrap their scene class in <ScenePane> (./ScenePane.tsx); anything else can
// call useCompareTime(ctx, draw) to be driven by the clock. Adopting it in a new lab:
//
//   const items = myItems(entry, library)              // CompareItem<MyPayload>[], params via flattenParams
//   <CompareDialog title="Compare" items={items} focus={entry.id}
//     renderPane={(item, ctx) => <ScenePane ctx={ctx} create={(c) => new MyScene(c)} load={(s) => s.load(item.payload)} loadKey={item.id} />}
//     onClose={...} />
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { clockLength, compareItems, defaultPair, filterChanges, formatValue, paneTime, stepClock } from '@shared/compare/diff'
import type { CompareItem, ParamChangeKind, ScoreDelta, SyncMode } from '@shared/compare/types'
import { principleLabel } from '@shared/principles/catalog'
import { Icon } from '../Icons'
import { prefersReducedMotion } from '../../pages/vfx/motion'
import './compare.css'

export type CompareSide = 'a' | 'b'

// What a pane gets: which side it is and the shared clock to attach its draw to.
export interface PaneContext {
  side: CompareSide
  attach: (draw: (t: number) => void) => () => void
}

// Drive any renderer from the compare clock: draw(t) runs every frame with this pane's own time.
export function useCompareTime(ctx: PaneContext, draw: (t: number) => void): void {
  const ref = useRef(draw)
  ref.current = draw
  useEffect(() => ctx.attach((t) => ref.current(t)), [ctx])
}

const SPEEDS = [1, 0.5, 0.25]
const FRAME = 1 / 30

function fmt(n: number | undefined, d = 1): string {
  return n == null ? '—' : n.toFixed(d)
}

// Score deltas are tinted (up is better); parameter deltas are neutral (bigger is not better).
function Delta({ d, digits = 1, neutral }: { d: number | undefined; digits?: number; neutral?: boolean }) {
  if (d == null) return <span className="cmp-d faint">—</span>
  const cls = neutral ? 'flat' : d > 0.0001 ? 'up' : d < -0.0001 ? 'down' : 'flat'
  return <span className={`cmp-d ${cls}`}>{d > 0 ? '+' : d < 0 ? '−' : '±'}{Math.abs(d).toFixed(digits)}</span>
}

function ScoreRow({ s, label }: { s: ScoreDelta; label?: string }) {
  return (
    <div className="cmp-score" role="row">
      <span className="cmp-score-k" role="cell">{label ?? s.key}</span>
      <span className="cmp-bars" role="cell" aria-label={`A ${fmt(s.a)}, B ${fmt(s.b)}`}>
        <i className="a" style={{ width: `${(s.a ?? 0) * 10}%` }} />
        <i className="b" style={{ width: `${(s.b ?? 0) * 10}%` }} />
      </span>
      <span className="mono cmp-ab" role="cell">{fmt(s.a)} → {fmt(s.b)}</span>
      <span role="cell"><Delta d={s.delta} /></span>
    </div>
  )
}

function Picker<P>({ side, items, value, onChange }: { side: CompareSide; items: CompareItem<P>[]; value: string; onChange: (id: string) => void }) {
  const groups = useMemo(() => {
    const m = new Map<string, CompareItem<P>[]>()
    for (const i of items) m.set(i.group, [...(m.get(i.group) ?? []), i])
    return [...m]
  }, [items])
  return (
    <label className={`cmp-pick ${side}`}>
      <span className="cmp-side mono">{side.toUpperCase()}</span>
      <select className="input" value={value} onChange={(e) => onChange(e.target.value)} aria-label={`Version ${side.toUpperCase()}`}>
        {groups.map(([g, list]) => (
          <optgroup key={g} label={g}>
            {list.map((i) => (
              <option key={i.id} value={i.id}>
                {i.label}
                {i.overall != null ? ` · ${i.overall.toFixed(1)}` : ''}
                {i.best ? ' · best' : ''}
                {i.current && i.label !== 'current' ? ' · current' : ''}
                {i.sub ? ` · ${i.sub}` : ''}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  )
}

export interface CompareViewProps<P> {
  items: CompareItem<P>[]
  // Initial pair; default: defaultPair(items, focus).
  a?: string
  b?: string
  focus?: string
  renderPane: (item: CompareItem<P>, ctx: PaneContext) => ReactNode
  // "Use this version" (restore an iteration); absent hides the buttons.
  onUse?: (item: CompareItem<P>) => void
  useLabel?: (item: CompareItem<P>) => string | null
}

export function CompareView<P>({ items, a: a0, b: b0, focus, renderPane, onUse, useLabel }: CompareViewProps<P>) {
  const initial = useMemo(() => (a0 && b0 ? ([a0, b0] as [string, string]) : defaultPair(items, focus)), [])
  const [aId, setA] = useState(initial?.[0] ?? items[0]?.id ?? '')
  const [bId, setB] = useState(initial?.[1] ?? items[1]?.id ?? items[0]?.id ?? '')
  const A = items.find((i) => i.id === aId) ?? items[0]
  const B = items.find((i) => i.id === bId) ?? items[1] ?? items[0]
  const [layout, setLayout] = useState<'side' | 'flip'>('side')
  const [shown, setShown] = useState<CompareSide>('a')
  const [mode, setMode] = useState<SyncMode>('seconds')
  const [playing, setPlaying] = useState(!prefersReducedMotion())
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [clock, setClock] = useState(0)
  const [query, setQuery] = useState('')
  const [allParams, setAllParams] = useState(false)
  const [kind, setKind] = useState<ParamChangeKind | null>(null)

  // One clock for both panes: the frame loop advances it and calls each attached draw with the
  // pane's own time, so A and B are always on the same frame.
  const clockRef = useRef(0)
  const draws = useRef<Record<CompareSide, Set<(t: number) => void>>>({ a: new Set(), b: new Set() })
  const live = useRef({ playing, loop, speed, mode, durA: A?.duration ?? 0, durB: B?.duration ?? 0 })
  live.current = { playing, loop, speed, mode, durA: A?.duration ?? 0, durB: B?.duration ?? 0 }
  const ctxA = useMemo<PaneContext>(() => ({ side: 'a', attach: (d) => (draws.current.a.add(d), () => void draws.current.a.delete(d)) }), [])
  const ctxB = useMemo<PaneContext>(() => ({ side: 'b', attach: (d) => (draws.current.b.add(d), () => void draws.current.b.delete(d)) }), [])

  useEffect(() => {
    let raf = 0
    let last = performance.now()
    let tick = 0
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const p = live.current
      if (p.playing) {
        const s = stepClock(p.mode, clockRef.current, dt, p.speed, p.durA, p.durB, p.loop)
        clockRef.current = s.clock
        if (s.ended) setPlaying(false)
      }
      const ta = paneTime(p.mode, clockRef.current, p.durA)
      const tb = paneTime(p.mode, clockRef.current, p.durB)
      draws.current.a.forEach((d) => d(ta))
      draws.current.b.forEach((d) => d(tb))
      if (++tick % 4 === 0) setClock(clockRef.current)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [])

  const len = clockLength(mode, A?.duration ?? 0, B?.duration ?? 0)
  const seek = (v: number) => {
    clockRef.current = Math.max(0, Math.min(len, v))
    setClock(clockRef.current)
  }
  const switchMode = (m: SyncMode) => {
    // Keep the same moment of A when switching between seconds and stretch.
    const tA = paneTime(mode, clockRef.current, A?.duration ?? 0)
    const dA = A?.duration || 1
    clockRef.current = m === 'stretch' ? tA / dA : tA
    setMode(m)
  }

  // Keys while the compare has focus: space play / pause, f (or tab in flip) flips, , and . step a frame.
  const rootRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const el = rootRef.current
    if (!el) return
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement
      if (t.closest('input:not([type=range]), select, textarea')) return
      const step = mode === 'stretch' ? FRAME / Math.max(A?.duration ?? 1, B?.duration ?? 1, 1e-6) : FRAME
      if (e.key === ' ') setPlaying((p) => !p)
      else if (e.key === 'f' || e.key === 'F') (setLayout('flip'), setShown((s) => (s === 'a' ? 'b' : 'a')))
      else if (e.key === ',') (setPlaying(false), seek(clockRef.current - step))
      else if (e.key === '.') (setPlaying(false), seek(clockRef.current + step))
      else return
      e.preventDefault()
      e.stopPropagation()
    }
    el.addEventListener('keydown', onKey)
    return () => el.removeEventListener('keydown', onKey)
  })

  const summary = useMemo(() => (A && B ? compareItems(A, B) : null), [A, B])
  const changes = useMemo(() => (summary ? filterChanges(summary.params, query).filter((c) => !kind || c.kind === kind) : []), [summary, query, kind])
  if (!A || !B || !summary) return <div className="empty">Nothing to compare yet: this needs at least two versions.</div>
  const tA = paneTime(mode, clock, A.duration)
  const tB = paneTime(mode, clock, B.duration)
  const shownChanges = allParams ? changes : changes.slice(0, 60)
  const counts = { changed: summary.params.filter((c) => c.kind === 'changed').length, added: summary.params.filter((c) => c.kind === 'added').length, removed: summary.params.filter((c) => c.kind === 'removed').length }

  const pane = (item: CompareItem<P>, ctx: PaneContext, t: number) => (
    <div className={`cmp-pane ${ctx.side}${layout === 'flip' && shown !== ctx.side ? ' hidden' : ''}`} aria-hidden={layout === 'flip' && shown !== ctx.side}>
      {renderPane(item, ctx)}
      <div className="cmp-tag mono" aria-hidden>
        <b>{ctx.side.toUpperCase()}</b> {item.label}
        {item.overall != null ? ` · ${item.overall.toFixed(1)}` : ''} · {t.toFixed(2)}s
      </div>
    </div>
  )

  return (
    <div className="cmp" ref={rootRef} tabIndex={-1}>
      <div className="cmp-bar">
        <Picker side="a" items={items} value={A.id} onChange={setA} />
        <button className="btn small ghost" onClick={() => (setA(B.id), setB(A.id))} title="Swap A and B" aria-label="Swap A and B">
          <Icon name="split" size={12} />
        </button>
        <Picker side="b" items={items} value={B.id} onChange={setB} />
        <span className="grow" />
        <div className="seg" role="radiogroup" aria-label="Layout">
          <button role="radio" aria-checked={layout === 'side'} className={layout === 'side' ? 'on' : ''} onClick={() => setLayout('side')}>side by side</button>
          <button role="radio" aria-checked={layout === 'flip'} className={layout === 'flip' ? 'on' : ''} onClick={() => setLayout('flip')} title="One frame, flip between A and B (F)">A/B flip</button>
        </div>
      </div>

      <div className={`cmp-stage lay-${layout}`}>
        {pane(A, ctxA, tA)}
        {pane(B, ctxB, tB)}
        {layout === 'flip' && (
          <div className="cmp-flip seg" role="radiogroup" aria-label="Showing">
            {(['a', 'b'] as const).map((s) => (
              <button key={s} role="radio" aria-checked={shown === s} className={shown === s ? 'on' : ''} onClick={() => setShown(s)}>
                {s.toUpperCase()}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="cmp-transport">
        <button className="btn small ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause (space)' : 'Play (space)'}>
          <Icon name={playing ? 'stop' : 'play'} size={11} />
        </button>
        <button className="btn small ghost" onClick={() => (seek(0), setPlaying(true))} aria-label="Play from the start" title="Play from the start">
          <Icon name="restart" size={11} />
        </button>
        <input className="cmp-scrub grow" type="range" min={0} max={len || 1} step={mode === 'stretch' ? 0.001 : 0.01} value={Math.min(clock, len)} onChange={(e) => (setPlaying(false), seek(Number(e.target.value)))} aria-label="Scrub both versions" />
        <span className="mono cmp-time">{mode === 'stretch' ? `${Math.round(clock * 100)}%` : `${clock.toFixed(2)}s / ${len.toFixed(2)}s`}</span>
        <button className={`btn small${loop ? ' primary' : ''}`} onClick={() => setLoop((l) => !l)} aria-pressed={loop}>loop</button>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>{s}×</button>
          ))}
        </div>
        <div className="seg" role="radiogroup" aria-label="Sync">
          <button role="radio" aria-checked={mode === 'seconds'} className={mode === 'seconds' ? 'on' : ''} onClick={() => switchMode('seconds')} title="Same seconds: the shorter version holds its last frame">same time</button>
          <button role="radio" aria-checked={mode === 'stretch'} className={mode === 'stretch' ? 'on' : ''} onClick={() => switchMode('stretch')} title="Stretch both to the same length (compare phases)">stretch</button>
        </div>
      </div>

      <div className="cmp-data">
        <section className="cmp-card" aria-label="Scores">
          <h3>Scores</h3>
          <div className="cmp-overall">
            <div><span className="faint">A</span> <b className="mono">{fmt(summary.overall.a)}</b></div>
            <Icon name="arrowRight" size={11} />
            <div><span className="faint">B</span> <b className="mono">{fmt(summary.overall.b)}</b></div>
            <Delta d={summary.overall.delta} />
            {summary.principleScore.a != null || summary.principleScore.b != null ? (
              <span className="cmp-psc faint mono">principles {fmt(summary.principleScore.a)} → {fmt(summary.principleScore.b)} <Delta d={summary.principleScore.delta} /></span>
            ) : null}
          </div>
          {summary.scores.length ? (
            <div role="table" aria-label="Rubric">{summary.scores.map((s) => <ScoreRow key={s.key} s={s} />)}</div>
          ) : (
            <p className="note">No critique on {summary.overall.a == null && summary.overall.b == null ? 'either version' : summary.overall.a == null ? 'A' : 'B'} yet. Refine or Critique to score it.</p>
          )}
          {summary.principles.length > 0 && (
            <>
              <h4>Principles</h4>
              <div role="table" aria-label="Principles">{summary.principles.map((s) => <ScoreRow key={s.key} s={s} label={principleLabel(s.key)} />)}</div>
            </>
          )}
          {onUse && (
            <div className="cmp-use">
              {[A, B].map((it, i) => {
                const label = useLabel ? useLabel(it) : `Use ${it.label}`
                return label ? (
                  <button key={it.id} className="btn small" onClick={() => onUse(it)}>
                    <Icon name="undo" size={11} /> {label} ({i ? 'B' : 'A'})
                  </button>
                ) : null
              })}
            </div>
          )}
        </section>

        <section className="cmp-card cmp-params" aria-label="Parameter changes">
          <h3>
            Params
            <span className="cmp-counts" role="group" aria-label="Show only">
              {(['changed', 'added', 'removed'] as const).map((k) => (
                <button key={k} className={`chip mono${kind === k ? ' on' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)} disabled={!counts[k]}>
                  {counts[k]} {k}
                </button>
              ))}
              <span className="faint mono">{summary.unchanged} same</span>
            </span>
          </h3>
          <input className="input cmp-filter" placeholder="Filter (rate, Core, removed...)" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Filter parameter changes" />
          {summary.params.length === 0 ? (
            <p className="note">Identical parameters{A.id === B.id ? ' (A and B are the same version)' : ''}.</p>
          ) : (
            <div className="cmp-diff" role="table" aria-label="Parameter diff">
              {shownChanges.map((c) => (
                <div key={c.path} className={`cmp-drow ${c.kind}`} role="row">
                  <span className="mono cmp-path" role="cell" title={c.path}>{c.path}</span>
                  <span className="mono cmp-va" role="cell" title={formatValue(c.a)}>{formatValue(c.a)}</span>
                  <Icon name="arrowRight" size={10} />
                  <span className="mono cmp-vb" role="cell" title={formatValue(c.b)}>{formatValue(c.b)}</span>
                  <span role="cell" className="cmp-dcell">{c.delta != null ? <Delta d={c.delta} digits={Math.abs(c.delta) < 1 ? 3 : 2} neutral /> : <span className={`tag cmp-kind ${c.kind}`}>{c.kind}</span>}</span>
                </div>
              ))}
              {changes.length > shownChanges.length && (
                <button className="btn small ghost" onClick={() => setAllParams(true)}>Show all {changes.length}</button>
              )}
              {!changes.length && <p className="note">No change matches{query ? ` “${query}”` : ''}{kind ? ` (${kind} only)` : ''}.</p>}
            </div>
          )}
        </section>
      </div>
    </div>
  )
}

// The compare as a large overlay (scrim, Escape closes).
export function CompareDialog<P>({ title, onClose, ...rest }: CompareViewProps<P> & { title: string; onClose: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey, true)
    ref.current?.querySelector<HTMLElement>('.cmp')?.focus({ preventScroll: true })
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])
  return (
    <>
      <div className="scrim" onClick={onClose} />
      <div className="cmp-modal" role="dialog" aria-modal="true" aria-label={title} ref={ref}>
        <div className="cmp-head">
          <Icon name="diff" size={13} />
          <b>{title}</b>
          <span className="faint cmp-keys">space play · F flip · , . step a frame · esc close</span>
          <span className="grow" />
          <button className="btn small ghost" onClick={onClose} aria-label="Close compare">
            <Icon name="x" size={12} />
          </button>
        </div>
        <CompareView {...rest} />
      </div>
    </>
  )
}
