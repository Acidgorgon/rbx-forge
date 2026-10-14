// Live preview of a clip on a blocky R15 or R6 dummy (the clip's rig) (three.js, preview/rig.ts) with transport controls:
// play / pause, scrub on the timeline (beats, markers, keys), loop, slow motion, onion skins, root
// motion on / in place, front / side / wide camera, and the ghost of a library reference clip.
import { useEffect, useRef, useState } from 'react'
import type { AnimClip, AnimEntry } from '@shared/types'
import { Icon } from '../../components/Icons'
import { prefersReducedMotion } from '../vfx/motion'
import { AnimScene, type AnimView } from './preview/rig'
import { AnimTimeline } from './AnimTimeline'
import { webglMessage } from '../../lib/webgl'

const SPEEDS = [1, 0.5, 0.25]

export function AnimPreview({
  clip,
  reference,
  references,
  onReference,
  onSnapshot
}: {
  clip: AnimClip
  reference?: AnimClip | null
  references?: AnimEntry[]
  onReference?: (id: string | null) => void
  onSnapshot?: (png: string) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<AnimScene | null>(null)
  const tRef = useRef(0)
  const [playing, setPlaying] = useState(!prefersReducedMotion())
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [view, setView] = useState<AnimView>('front')
  const [onion, setOnion] = useState(0)
  const [travel, setTravel] = useState(true)
  const [t, setT] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const playRef = useRef({ playing, loop, speed })
  playRef.current = { playing, loop, speed }
  const snapped = useRef(false)

  useEffect(() => {
    let scene: AnimScene
    try {
      scene = new AnimScene(canvasRef.current!)
    } catch (e) {
      setError(webglMessage(e))
      return
    }
    sceneRef.current = scene
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect()
      scene.resize(r.width, r.height)
      scene.render()
    })
    ro.observe(wrapRef.current!)
    let raf = 0
    let last = performance.now()
    let tick = 0
    const step = (now: number) => {
      raf = requestAnimationFrame(step)
      const dt = Math.min(0.1, (now - last) / 1000)
      last = now
      const p = playRef.current
      if (p.playing) {
        let next = tRef.current + dt * p.speed
        const D = scene.duration
        if (next >= D) {
          if (p.loop) next = next % D
          else {
            next = D
            setPlaying(false)
          }
        }
        tRef.current = next
      }
      scene.setTime(tRef.current)
      scene.render()
      if (++tick % 3 === 0) setT(tRef.current)
    }
    raf = requestAnimationFrame(step)
    return () => {
      cancelAnimationFrame(raf)
      ro.disconnect()
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setClip(clip)
    if (tRef.current > clip.duration) tRef.current = 0
    if (onSnapshot && !snapped.current) {
      snapped.current = true
      const peak = clip.beats?.find((b) => /release|strike|action|hit|impact|sign/i.test(b.label))?.at ?? clip.duration * 0.45
      scene.setTime(peak)
      onSnapshot(scene.snapshot())
      scene.setTime(tRef.current)
    }
  }, [clip])
  useEffect(() => sceneRef.current?.setReference(reference ?? null), [reference])
  useEffect(() => sceneRef.current?.setView(view), [view])
  useEffect(() => sceneRef.current?.setOnion(onion), [onion])
  useEffect(() => {
    if (sceneRef.current) sceneRef.current.travel = travel
  }, [travel])

  const scrub = (v: number) => {
    setPlaying(false)
    tRef.current = v
    setT(v)
  }
  const beat = [...(clip.beats ?? [])].filter((b) => b.at <= t + 1e-6).pop()?.label
  const marker = clip.markers.find((m) => Math.abs(m.t - t) < 0.05)

  return (
    <div className="anim-preview">
      <div ref={wrapRef} className="anim-canvas">
        <canvas ref={canvasRef} aria-label={`3D preview of ${clip.name}`} />
        {error && <div className="vfx-canvas-err note">{error}</div>}
        <div className="anim-hud mono" aria-live="off">
          {t.toFixed(2)}s / {clip.duration.toFixed(2)}s · f{Math.round(t * 30)}
          {beat ? ` · ${beat}` : ''}
          {speed !== 1 ? ` · ${speed}×` : ''}
          {clip.looped ? ' · loop' : ''}
        </div>
        {marker && <div className="anim-flash mono">◆ {marker.name}</div>}
        {reference && <div className="anim-ghost-lab mono">ghost: {reference.name}</div>}
      </div>
      <AnimTimeline clip={clip} t={Math.min(t, clip.duration)} onScrub={scrub} />
      <div className="vfx-transport">
        <button className="btn small ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'stop' : 'play'} size={11} />
        </button>
        <button className="btn small ghost" onClick={() => scrub(0)} aria-label="Back to start" title="Back to start">
          <Icon name="restart" size={11} />
        </button>
        <button className={`btn small${loop ? ' primary' : ''}`} onClick={() => setLoop((l) => !l)} aria-pressed={loop} title="Loop playback">
          loop
        </button>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Onion skins">
          {[0, 1, 2].map((n) => (
            <button key={n} className={onion === n ? 'on' : ''} onClick={() => setOnion(n)} aria-pressed={onion === n} title={n ? `${n} ghost pose${n > 1 ? 's' : ''} before (blue) and after (orange)` : 'No onion skins'}>
              {n ? `onion ${n}` : 'onion off'}
            </button>
          ))}
        </div>
        <button className={`btn small${travel ? '' : ' primary'}`} onClick={() => setTravel((v) => !v)} aria-pressed={!travel} title="Pin the character in place (ignore root motion)">
          in place
        </button>
        <span className="grow" />
        {references && onReference && (
          <select className="input anim-ref-sel" value={reference ? references.find((r) => r.clip === reference)?.id ?? '' : ''} onChange={(e) => onReference(e.target.value || null)} aria-label="Ghost a library reference">
            <option value="">no ghost</option>
            {references.map((r) => (
              <option key={r.id} value={r.id}>
                ghost: {r.name}
              </option>
            ))}
          </select>
        )}
        <div className="seg" role="group" aria-label="Camera">
          {(['front', 'side', 'wide'] as AnimView[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} aria-pressed={view === v}>
              {v}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
