// Live 3D preview of an effect (three.js, preview/scene.ts) with transport controls: play / pause,
// scrub (a timeline strip with stages and cues for scripted effects), loop, slow motion, "Emit burst",
// front / side / wide camera, dark / grey background. An approximation of Roblox.
import { useEffect, useRef, useState } from 'react'
import type { VfxCue, VfxEffect } from '@shared/types'
import { Icon } from '../../components/Icons'
import { VfxScene, type Background, type View } from './preview/scene'
import { hasTimeline, TimelineStrip } from './TimelineStrip'
import { prefersReducedMotion } from './motion'

const SPEEDS = [1, 0.5, 0.25, 0.1]

export function VfxPreview({ effect, onSnapshot, autoSnapshot }: { effect: VfxEffect; onSnapshot?: (png: string) => void; autoSnapshot?: boolean }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<VfxScene | null>(null)
  const tRef = useRef(0)
  const extra = useRef<VfxCue[]>([])
  const [playing, setPlaying] = useState(!prefersReducedMotion())
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [bg, setBg] = useState<Background>('dark')
  const [view, setView] = useState<View>('front')
  const [t, setT] = useState(0)
  const [stats, setStats] = useState({ particles: 0 })
  const [error, setError] = useState<string | null>(null)
  const [placeholders, setPlaceholders] = useState(false)
  const snapped = useRef(false)
  const playRef = useRef({ playing, loop, speed })
  playRef.current = { playing, loop, speed }

  useEffect(() => {
    const canvas = canvasRef.current!
    let scene: VfxScene
    try {
      scene = new VfxScene(canvas, { resolver: (ref) => window.harness.vfxResolveTexture(ref) })
    } catch (e) {
      setError(`WebGL is not available: ${(e as Error).message}`)
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
          if (p.loop) {
            next = next % D
            extra.current = []
          } else {
            next = D
            setPlaying(false)
          }
        }
        tRef.current = next
      }
      const s = scene.setTime(tRef.current, extra.current)
      scene.render()
      if (++tick % 6 === 0) {
        setT(tRef.current)
        setStats({ particles: s.particles })
      }
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
    let live = true
    void scene.load(effect).then(async () => {
      if (!live) return
      setPlaceholders(await scene.usesPlaceholders())
      if (autoSnapshot && onSnapshot && !snapped.current) {
        snapped.current = true
        // A frame near the peak (a third of the way in) makes the library thumbnail.
        scene.setTime(Math.min(scene.duration, Math.max(0.15, scene.duration * 0.3)))
        onSnapshot(scene.snapshot())
        scene.setTime(tRef.current)
      }
    })
    return () => {
      live = false
    }
  }, [effect])

  useEffect(() => sceneRef.current?.setBackground(bg), [bg])
  useEffect(() => sceneRef.current?.setView(view), [view])
  const timeline = hasTimeline(effect)
  const stage = timeline ? [...(effect.stages ?? [])].filter((s) => s.at <= t + 1e-6).pop()?.label : undefined

  const burst = () => {
    const now = tRef.current
    const emitters = effect.roots.length ? collectEmitters(effect) : []
    extra.current = [
      ...extra.current,
      ...emitters.map((id) => {
        const existing = effect.cues.filter((c) => c.target === id && c.action === 'emit').map((c) => c.count ?? 16)
        return { at: now, target: id, action: 'emit' as const, count: existing.length ? Math.max(...existing) : 12 }
      })
    ]
    if (!playing) setPlaying(true)
  }

  const scrub = (v: number) => {
    tRef.current = v
    setT(v)
  }

  return (
    <div className="vfx-preview">
      <div ref={wrapRef} className="vfx-canvas">
        <canvas ref={canvasRef} aria-label={`3D preview of ${effect.name}`} />
        {error && <div className="vfx-canvas-err note">{error}</div>}
        <div className="vfx-hud mono" aria-live="off">
          {t.toFixed(2)}s / {effect.duration.toFixed(2)}s{stage ? ` · ${stage}` : ''} · {stats.particles} particles{speed !== 1 ? ` · ${speed}×` : ''}
        </div>
      </div>
      {timeline && <TimelineStrip effect={effect} t={Math.min(t, effect.duration)} onScrub={(v) => (setPlaying(false), scrub(v))} />}
      <div className="vfx-transport">
        <button className="btn small ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'stop' : 'play'} size={11} />
        </button>
        <button className="btn small ghost" onClick={() => scrub(0)} aria-label="Restart" title="Restart">
          <Icon name="restart" size={11} />
        </button>
        {!timeline && <input className="vfx-scrub grow" type="range" min={0} max={effect.duration} step={0.01} value={Math.min(t, effect.duration)} onChange={(e) => (setPlaying(false), scrub(Number(e.target.value)))} aria-label="Scrub" />}
        {timeline && <span className="grow" />}
        <button className={`btn small${loop ? ' primary' : ''}`} onClick={() => setLoop((l) => !l)} aria-pressed={loop} title="Loop">
          loop
        </button>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>
              {s === 1 ? '1×' : `${s}×`}
            </button>
          ))}
        </div>
        <button className="btn small" onClick={burst} title="Emit a burst from every emitter now">
          <Icon name="bolt" size={11} /> Emit burst
        </button>
        <div className="seg" role="group" aria-label="Camera">
          {(['front', 'side', 'wide'] as View[]).map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => setView(v)} aria-pressed={view === v}>
              {v}
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Background">
          {(['dark', 'grey'] as Background[]).map((b) => (
            <button key={b} className={bg === b ? 'on' : ''} onClick={() => setBg(b)} aria-pressed={bg === b}>
              {b}
            </button>
          ))}
        </div>
      </div>
      <p className="note vfx-honest">
        Approximation of Roblox's renderer (blending, sequences, flipbooks, drag and shapes follow the ParticleEmitter docs; no bloom or engine lighting){placeholders ? ' · some textures are placeholders' : ''}. Use Test in Studio for the final check.
      </p>
    </div>
  )
}

function collectEmitters(effect: VfxEffect): string[] {
  const out: string[] = []
  const walk = (n: VfxEffect['roots'][number]) => {
    if (n.className === 'ParticleEmitter') out.push(n.id)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  return out
}
