// Fullscreen image viewer: covers the whole window, fits the image (or shows it at 100%), zooms with
// the wheel and +/-, pans by dragging, double-click toggles fit / 100%, ←/→ step through a list, and
// the backdrop cycles checkerboard / dark / light so transparent UI art reads. Rendered in a portal on
// <body> and marked no-drag, so the Windows title bar drag region never takes its clicks (as Menu.tsx).
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons'
import './lightbox.css'

export interface LightboxItem {
  key: string
  name: string
  // Shown after the image's pixel size ("1.2 MB").
  detail?: string
  // Tooltip on the name (the full path).
  title?: string
  // A URL already at hand; otherwise `load` fetches it.
  src?: string
  // Transparent art opens on the checkerboard.
  transparent?: boolean
}

export interface LightboxProps {
  items: LightboxItem[]
  index: number
  onIndex: (index: number) => void
  onClose: () => void
  load?: (item: LightboxItem) => Promise<string>
  // Extra header actions for the shown item (Open file, Show in folder).
  actions?: (item: LightboxItem) => ReactNode
}

type Backdrop = 'checker' | 'dark' | 'light'
const BACKDROPS: Backdrop[] = ['checker', 'dark', 'light']
const MIN_ZOOM = 0.05
const MAX_ZOOM = 16
const STEP = 1.25
// Room left around a fitted image.
const PAD = 24
// The backdrop picked last, for the next open (this session only).
let picked: Backdrop | null = null

interface View {
  // null = fit to the window.
  zoom: number | null
  // Pan offset from the centre, in screen px.
  x: number
  y: number
}

const clampZoom = (z: number) => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))

export function Lightbox({ items, index, onIndex, onClose, load, actions }: LightboxProps) {
  const at = Math.max(0, Math.min(index, items.length - 1))
  const item = items[at] as LightboxItem | undefined
  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const urls = useRef(new Map<string, string | null>())
  const [, bump] = useState(0)
  const [loaded, setLoaded] = useState<{ key: string; w: number; h: number } | null>(null)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  const [view, setView] = useState<View>({ zoom: null, x: 0, y: 0 })
  const [smooth, setSmooth] = useState(false)
  const [drag, setDrag] = useState<{ id: number; sx: number; sy: number; x: number; y: number; moved: boolean } | null>(null)
  const defaultBg = (it?: LightboxItem): Backdrop => picked ?? (it?.transparent ? 'checker' : 'dark')
  const [bg, setBg] = useState<Backdrop>(() => defaultBg(item))
  // A new image starts fitted (state adjusted while rendering, so no frame shows the old zoom).
  const [shown, setShown] = useState(item?.key)
  if (item && item.key !== shown) {
    setShown(item.key)
    setView({ zoom: null, x: 0, y: 0 })
    setBg(defaultBg(item))
  }
  const natural = loaded && loaded.key === item?.key ? loaded : null

  // The shown image and its neighbours (so stepping is instant).
  useEffect(() => {
    let live = true
    for (const it of [items[at], items[at - 1], items[at + 1]]) {
      if (!it || it.src || urls.current.has(it.key) || !load) continue
      urls.current.set(it.key, '')
      load(it)
        .then((u) => urls.current.set(it.key, u))
        .catch(() => urls.current.set(it.key, null))
        .finally(() => live && bump((n) => n + 1))
    }
    return () => {
      live = false
    }
  }, [items, at, load])
  const got = item ? urls.current.get(item.key) : undefined
  const url = item?.src ?? got ?? ''

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const measure = () => setStage({ w: el.clientWidth, h: el.clientHeight })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Focus moves into the viewer and back to where it was on close.
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    rootRef.current?.focus()
    return () => before?.focus?.()
  }, [])

  const fit = natural && stage.w && stage.h ? Math.min((stage.w - PAD * 2) / natural.w, (stage.h - PAD * 2) / natural.h) : 1
  const scale = view.zoom ?? fit
  const clampView = useCallback(
    (v: View): View => {
      if (!natural) return v
      const s = v.zoom ?? fit
      // Panning only reaches the edges of an image larger than the window (plus the padding).
      const mx = natural.w * s > stage.w ? (natural.w * s - stage.w) / 2 + PAD : 0
      const my = natural.h * s > stage.h ? (natural.h * s - stage.h) / 2 + PAD : 0
      return { zoom: v.zoom, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) }
    },
    [natural, fit, stage.w, stage.h]
  )
  const pannable = !!natural && (natural.w * scale > stage.w || natural.h * scale > stage.h)

  // Zooms to z (or z(current scale), so fast wheel events add up) keeping the point p (px from the
  // stage centre) where it is.
  const zoomTo = useCallback(
    (z: number | ((s: number) => number), p = { x: 0, y: 0 }, ease = true) => {
      setSmooth(ease)
      setView((v) => {
        const s = v.zoom ?? fit
        const n = clampZoom(typeof z === 'function' ? z(s) : z)
        return clampView({ zoom: n, x: p.x - (p.x - v.x) * (n / s), y: p.y - (p.y - v.y) * (n / s) })
      })
    },
    [fit, clampView]
  )
  const toFit = useCallback(() => (setSmooth(true), setView({ zoom: null, x: 0, y: 0 })), [])
  const fromCentre = (e: { clientX: number; clientY: number }) => {
    const r = stageRef.current!.getBoundingClientRect()
    return { x: e.clientX - r.left - r.width / 2, y: e.clientY - r.top - r.height / 2 }
  }
  const step = useCallback((d: number) => {
    const n = at + d
    if (n >= 0 && n < items.length) onIndex(n)
  }, [at, items.length, onIndex])
  const cycleBg = useCallback(() => {
    setBg((b) => (picked = BACKDROPS[(BACKDROPS.indexOf(b) + 1) % BACKDROPS.length]))
  }, [])

  // The wheel needs a non-passive listener to keep the page from scrolling.
  useEffect(() => {
    const el = stageRef.current
    if (!el) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const f = Math.exp(-e.deltaY * (e.deltaMode === 1 ? 0.05 : 0.0015))
      zoomTo((s) => s * f, fromCentre(e), false)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [zoomTo])

  // Keys win over the page underneath (capture phase); Tab stays inside the viewer.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      if (e.repeat && (k === 'f' || k === 'F')) return
      if (k === 'Escape' || k === 'f' || k === 'F') onClose()
      else if (k === 'ArrowLeft') step(-1)
      else if (k === 'ArrowRight') step(1)
      else if (k === '+' || k === '=') zoomTo((s) => s * STEP)
      else if (k === '-' || k === '_') zoomTo((s) => s / STEP)
      else if (k === '0') toFit()
      else if (k === '1') zoomTo(1)
      else if (k === 'b' || k === 'B') cycleBg()
      else if (k === 'Tab') {
        const list = [...(rootRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])]
        if (!list.length) return
        const i = list.indexOf(document.activeElement as HTMLElement)
        list[(i + (e.shiftKey ? -1 : 1) + list.length) % list.length].focus()
      } else return
      e.preventDefault()
      e.stopPropagation()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, step, zoomTo, toFit, cycleBg])

  // Nothing left to show (the list emptied while open).
  useEffect(() => {
    if (!items.length) onClose()
  }, [items.length, onClose])
  if (!item) return null

  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.currentTarget.setPointerCapture(e.pointerId)
    setDrag({ id: e.pointerId, sx: e.clientX, sy: e.clientY, x: view.x, y: view.y, moved: false })
  }
  const onPointerMove = (e: React.PointerEvent) => {
    if (!drag || drag.id !== e.pointerId) return
    const dx = e.clientX - drag.sx
    const dy = e.clientY - drag.sy
    if (!drag.moved && Math.hypot(dx, dy) < 3) return
    if (!drag.moved) setDrag({ ...drag, moved: true })
    if (!pannable) return
    setSmooth(false)
    setView((v) => clampView({ zoom: v.zoom, x: drag.x + dx, y: drag.y + dy }))
  }
  const onPointerUp = (e: React.PointerEvent) => {
    if (drag?.id === e.pointerId) setDrag(null)
  }
  const atActual = Math.abs(scale - 1) < 0.001
  const fitted = view.zoom === null
  const w = natural ? natural.w * scale : 0
  const h = natural ? natural.h * scale : 0
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return createPortal(
    <div ref={rootRef} className="lb" role="dialog" aria-modal="true" aria-label={`${item.name}, fullscreen`} tabIndex={-1} data-testid="lightbox">
      <div className="lb-head">
        <span className="lb-name mono ellipsis" title={item.title ?? item.name}>
          {item.name}
        </span>
        {(natural || item.detail) && <span className="lb-detail faint mono">{[natural ? `${natural.w}×${natural.h}` : '', item.detail].filter(Boolean).join(' · ')}</span>}
        {items.length > 1 && (
          <span className="lb-count faint mono">
            {at + 1} / {items.length}
          </span>
        )}
        <span className="grow" />
        {actions?.(item)}
        <span className="lb-zoom" role="group" aria-label="Zoom">
          <button className="btn small ghost" onClick={() => zoomTo((s) => s / STEP)} aria-label="Zoom out" title="Zoom out (−)" disabled={!natural || scale <= MIN_ZOOM}>
            <Icon name="minus" size={12} />
          </button>
          <span className="lb-pct mono">
            {Math.round(scale * 100)}%
          </span>
          <button className="btn small ghost" onClick={() => zoomTo((s) => s * STEP)} aria-label="Zoom in" title="Zoom in (+)" disabled={!natural || scale >= MAX_ZOOM}>
            <Icon name="plus" size={12} />
          </button>
        </span>
        <span className="seg lb-seg" role="group" aria-label="Size">
          <button className={fitted ? 'on' : ''} aria-pressed={fitted} onClick={toFit} title="Fit to the window (0)">
            Fit
          </button>
          <button className={atActual && !fitted ? 'on' : ''} aria-pressed={atActual && !fitted} onClick={() => zoomTo(1)} title="Actual pixels (1)">
            100%
          </button>
        </span>
        <button className="badge-o lb-bg" onClick={cycleBg} title="Background: checkerboard, dark, light (B)" aria-label={`Background: ${bg}`}>
          <span className={`lb-swatch lb-${bg}`} aria-hidden /> {bg}
        </button>
        <button className="btn small ghost lb-close" onClick={onClose} aria-label="Close fullscreen" title="Close (Esc)">
          <Icon name="x" size={14} />
        </button>
      </div>
      <div
        ref={stageRef}
        className={`lb-stage lb-${bg}${pannable ? ' pan' : ''}${drag?.moved && pannable ? ' dragging' : ''}`}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={() => setDrag(null)}
        onDoubleClick={(e) => (atActual && !fitted ? toFit() : zoomTo(1, fromCentre(e)))}
      >
        {url ? (
          <img
            key={item.key}
            src={url}
            alt={item.name}
            draggable={false}
            className={`${smooth ? 'smooth' : ''}${scale >= 2 ? ' px' : ''}`}
            style={natural ? { width: w, height: h, transform: `translate(calc(-50% + ${view.x}px), calc(-50% + ${view.y}px))` } : { visibility: 'hidden' }}
            onLoad={(e) => setLoaded({ key: item.key, w: e.currentTarget.naturalWidth || 1, h: e.currentTarget.naturalHeight || 1 })}
            onTransitionEnd={() => setSmooth(false)}
          />
        ) : null}
        {!natural && (got === null && !item.src ? <span className="lb-missing">image unavailable</span> : <span className="spinner lb-spin" aria-label="Loading" />)}
        {at > 0 && (
          <button className="lb-nav prev" onClick={() => step(-1)} onPointerDown={stop} onDoubleClick={stop} aria-label="Previous image" title="Previous (←)">
            <Icon name="chevLeft" size={18} />
          </button>
        )}
        {at < items.length - 1 && (
          <button className="lb-nav next" onClick={() => step(1)} onPointerDown={stop} onDoubleClick={stop} aria-label="Next image" title="Next (→)">
            <Icon name="chev" size={18} />
          </button>
        )}
      </div>
      <div className="lb-foot faint">scroll or +/− zoom · drag to pan · double-click fit / 100% · ←/→ step · B background · Esc close</div>
    </div>,
    document.body
  )
}
