// Live preview of a move (preview/abilityScene.ts) with the screen-effect overlay, transport (play /
// pause, restart, loop, speed, camera, background) and the timeline. Playback runs in ability time:
// hit-stop windows slow it down exactly like the runner does in game (shared/ability/timing advance()).
// With reduced motion the preview does not autoplay, the camera does not shake and flashes are dimmed.
import { useEffect, useRef, useState } from 'react'
import { advance, resolveAbility, timeScaleAt, type ResolvedAbility } from '@shared/ability/timing'
import type { Ability, TimeRef } from '@shared/ability/types'
import type { VfxEffect } from '@shared/types'
import { Icon } from '../../components/Icons'
import { prefersReducedMotion } from '../vfx/motion'
import type { Background } from '../vfx/preview/scene'
import { AbilityScene, type AbilityView } from './preview/abilityScene'
import { applyScreen, type ScreenEls } from './preview/screenFx'
import { AbilityTimeline } from './AbilityTimeline'
import { webglMessage } from '../../lib/webgl'

const SPEEDS = [1, 0.5, 0.25, 0.1]

export function ScreenLayers({ refs }: { refs: React.MutableRefObject<Partial<ScreenEls>> }) {
  return (
    <>
      <div className="ab-fx-tint" ref={(el) => void (refs.current.tint = el ?? undefined)} aria-hidden />
      <div className="ab-fx-bloom" ref={(el) => void (refs.current.bloom = el ?? undefined)} aria-hidden />
      <div className="ab-fx-flash" ref={(el) => void (refs.current.flash = el ?? undefined)} aria-hidden />
    </>
  )
}

export function AbilityPreview({
  ability,
  effects,
  selected,
  onSelect,
  onRetime,
  onAnimationStart,
  onSnapshot
}: {
  ability: Ability
  effects: Record<string, VfxEffect>
  selected: string | null
  onSelect: (id: string | null) => void
  onRetime: (id: string, at: TimeRef) => void
  onAnimationStart: (start: number) => void
  onSnapshot?: (png: string) => void
}) {
  const reduced = prefersReducedMotion()
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<AbilityScene | null>(null)
  const fxRefs = useRef<Partial<ScreenEls>>({})
  const tRef = useRef(0)
  const [playing, setPlaying] = useState(!reduced)
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [bg, setBg] = useState<Background>('dark')
  const [view, setView] = useState<AbilityView>('front')
  const [t, setT] = useState(0)
  const [hud, setHud] = useState({ particles: 0, scale: 1, shake: 0 })
  const [error, setError] = useState<string | null>(null)
  const [notes, setNotes] = useState<string[]>([])
  const resolvedRef = useRef<ResolvedAbility>(resolveAbility(ability))
  const [resolved, setResolved] = useState<ResolvedAbility>(resolvedRef.current)
  const snapped = useRef(false)
  const playRef = useRef({ playing, loop, speed, duration: ability.duration })
  playRef.current = { playing, loop, speed, duration: ability.duration }

  useEffect(() => {
    const canvas = canvasRef.current!
    let scene: AbilityScene
    try {
      scene = new AbilityScene(canvas, { resolver: (ref) => window.harness.vfxResolveTexture(ref) })
    } catch (e) {
      setError(webglMessage(e))
      return
    }
    scene.shakeEnabled = !reduced
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
        let next = advance(resolvedRef.current, tRef.current, dt * p.speed)
        if (next >= p.duration) {
          if (p.loop) next = 0
          else {
            next = p.duration
            setPlaying(false)
          }
        }
        tRef.current = next
      }
      const f = scene.setTime(tRef.current)
      const els = fxRefs.current
      if (els.tint && els.bloom && els.flash) {
        const screen = reduced ? { ...f.screen, flash: { ...f.screen.flash, opacity: f.screen.flash.opacity * 0.4 } } : f.screen
        applyScreen({ canvas, tint: els.tint, bloom: els.bloom, flash: els.flash }, screen)
      }
      scene.render()
      if (++tick % 4 === 0) {
        setT(tRef.current)
        setHud({ particles: f.particles, scale: timeScaleAt(resolvedRef.current, tRef.current), shake: f.shake })
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
    void scene.load(ability, effects).then(async () => {
      if (!live) return
      resolvedRef.current = scene.timeline
      setResolved(scene.timeline)
      const n: string[] = []
      if (scene.poseMissing) n.push('animation clip unavailable: rest pose')
      const missing = ability.events.filter((e) => e.kind === 'vfx' && !effects[e.effect]).length
      if (missing) n.push(`${missing} VFX effect${missing === 1 ? '' : 's'} not in the library`)
      if (await scene.usesPlaceholders()) n.push('some textures are placeholders')
      setNotes(n)
      if (onSnapshot && !snapped.current) {
        snapped.current = true
        // The release (or the middle) makes the library thumbnail.
        const rel = scene.timeline.markers.find((m) => /release|impact|hit|fire/.test(m.name))
        scene.setTime(Math.min(ability.duration, (rel?.t ?? ability.duration / 2) + 0.12))
        onSnapshot(scene.snapshot())
        scene.setTime(tRef.current)
      }
    })
    return () => {
      live = false
    }
  }, [ability, effects])

  useEffect(() => sceneRef.current?.setBackground(bg), [bg])
  useEffect(() => sceneRef.current?.setView(view), [view])

  const scrub = (v: number) => {
    setPlaying(false)
    tRef.current = v
    setT(v)
  }
  const marker = [...resolved.markers].filter((m) => m.t <= t + 1e-6).pop()

  return (
    <div className="ab-preview">
      <div ref={wrapRef} className="vfx-canvas ab-canvas">
        <canvas ref={canvasRef} aria-label={`3D preview of ${ability.name}`} />
        <ScreenLayers refs={fxRefs} />
        {error && <div className="vfx-canvas-err note">{error}</div>}
        <div className="vfx-hud mono" aria-live="off">
          {t.toFixed(2)}s / {ability.duration.toFixed(2)}s{marker ? ` · ${marker.name}` : ''} · {hud.particles} particles
          {hud.scale < 1 ? ` · hit-stop ×${hud.scale}` : ''}
          {hud.shake > 0.01 ? ` · shake ${hud.shake.toFixed(2)}${reduced ? ' (off: reduced motion)' : ''}` : ''}
          {speed !== 1 ? ` · ${speed}×` : ''}
        </div>
      </div>
      <AbilityTimeline ability={ability} resolved={resolved} t={t} selected={selected} onSelect={onSelect} onScrub={scrub} onRetime={onRetime} onAnimationStart={onAnimationStart} />
      <div className="vfx-transport">
        <button className="btn small ghost" onClick={() => setPlaying((p) => !p)} aria-label={playing ? 'Pause' : 'Play'} title={playing ? 'Pause' : 'Play'}>
          <Icon name={playing ? 'stop' : 'play'} size={11} />
        </button>
        <button className="btn small ghost" onClick={() => ((tRef.current = 0), setT(0), setPlaying(true))} aria-label="Play from the start" title="Play from the start">
          <Icon name="restart" size={11} />
        </button>
        <span className="grow" />
        <button className={`btn small${loop ? ' primary' : ''}`} onClick={() => setLoop((l) => !l)} aria-pressed={loop} title="Loop">
          loop
        </button>
        <div className="seg" role="group" aria-label="Playback speed">
          {SPEEDS.map((s) => (
            <button key={s} className={speed === s ? 'on' : ''} onClick={() => setSpeed(s)} aria-pressed={speed === s}>
              {s}×
            </button>
          ))}
        </div>
        <div className="seg" role="group" aria-label="Camera">
          {(['front', 'side', 'back', 'wide'] as AbilityView[]).map((v) => (
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
        Approximation of Roblox: blocky R15 dummy, VFX spawned at the part when the event starts, CSS stand-ins for ColorCorrection / Bloom / Blur, hit-stop slows the whole preview like the runner{notes.length ? ` · ${notes.join(' · ')}` : ''}. Use Export and play it in Studio for the final check.
      </p>
    </div>
  )
}
