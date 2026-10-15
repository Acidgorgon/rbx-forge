// Live 3D preview of an effect (three.js, preview/scene.ts) with transport controls: play / pause,
// scrub (a timeline strip with stages and cues for scripted effects), loop, slow motion, "Emit burst",
// front / side / wide camera, Studio / dark / grey stage. An approximation of Roblox.
import { useEffect, useRef, useState } from 'react'
import type { VfxCue, VfxEffect } from '@shared/types'
import { Icon } from '../../components/Icons'
import { BACKGROUNDS, VfxScene, type Background, type View } from './preview/scene'
import { hasTimeline, TimelineStrip } from './TimelineStrip'
import { prefersReducedMotion } from './motion'
import { webglMessage } from '../../lib/webgl'
import { sharedMeshes } from './preview/meshes'
import type { MeshInfo } from './preview/fxLayer'
import type { MeshLoadReport } from '@shared/vfxMeshTypes'

// Mesh ids this window already tried to load automatically (once per session).
const autoTried = new Set<string>()

const SPEEDS = [1, 0.5, 0.25, 0.1]

// background: the initial stage ('studio' for effects imported from Studio, so they look the way
// they did there).
export function VfxPreview({ effect, onSnapshot, autoSnapshot, background = 'dark' }: { effect: VfxEffect; onSnapshot?: (png: string) => void; autoSnapshot?: boolean; background?: Background }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<VfxScene | null>(null)
  const tRef = useRef(0)
  const extra = useRef<VfxCue[]>([])
  const [playing, setPlaying] = useState(!prefersReducedMotion())
  const [loop, setLoop] = useState(true)
  const [speed, setSpeed] = useState(1)
  const [bg, setBg] = useState<Background>(background)
  const [view, setView] = useState<View>('front')
  const [t, setT] = useState(0)
  const [stats, setStats] = useState({ particles: 0 })
  const [error, setError] = useState<string | null>(null)
  const [placeholders, setPlaceholders] = useState(false)
  const [texStats, setTexStats] = useState<{ total: number; missing: string[] }>({ total: 0, missing: [] })
  const [meshInfo, setMeshInfo] = useState<MeshInfo | null>(null)
  const [meshReport, setMeshReport] = useState<MeshLoadReport | null>(null)
  const [meshBusy, setMeshBusy] = useState(false)
  const [reloadKey, setReloadKey] = useState(0)
  const snapped = useRef(false)
  const playRef = useRef({ playing, loop, speed })
  playRef.current = { playing, loop, speed }

  useEffect(() => {
    const canvas = canvasRef.current!
    let scene: VfxScene
    try {
      scene = new VfxScene(canvas, { resolver: (ref) => window.harness.vfxResolveTexture(ref), background })
    } catch (e) {
      setError(webglMessage(e))
      return
    }
    sceneRef.current = scene
    // Use the element captured here, not wrapRef: on unmount React clears the ref before this
    // effect's cleanup disconnects the observer, and the observer can still report the removal.
    const wrap = wrapRef.current!
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) return
      const r = wrap.getBoundingClientRect()
      scene.resize(r.width, r.height)
      scene.render()
    })
    ro.observe(wrap)
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
      setTexStats(await scene.textureStats())
      const info = scene.meshInfo
      setMeshInfo({ ...info })
      // Auto-load: missing meshes are read from Studio when it is connected (once per session).
      const missing = info.files.filter((f) => !info.loaded.includes(f) && !autoTried.has(f))
      if (missing.length && reloadKey === 0) {
        missing.forEach((f) => autoTried.add(f))
        const st = await window.harness.vfxMeshStatus().catch(() => null)
        if (live && st?.studio) void loadMeshes(missing, false)
      }
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
  }, [effect, reloadKey])

  // New meshes in the cache: draw them.
  useEffect(
    () =>
      window.harness.on('vfx:meshes', (p) => {
        const files = sceneRef.current?.meshInfo.files ?? []
        sharedMeshes.forget(p.ids)
        if (files.some((f) => p.ids.some((id) => f.endsWith(id)))) setReloadKey((k) => k + 1)
      }),
    []
  )

  const loadMeshes = async (refs: string[], retry: boolean) => {
    setMeshBusy(true)
    try {
      const r = await window.harness.vfxMeshLoad(refs, { retry })
      setMeshReport(r)
      sharedMeshes.forget()
      setReloadKey((k) => k + 1)
    } catch (e) {
      setMeshReport({ results: [], notes: [(e as Error).message], studio: false, at: Date.now() })
    } finally {
      setMeshBusy(false)
    }
  }

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
          {BACKGROUNDS.map((b) => (
            <button key={b} className={bg === b ? 'on' : ''} onClick={() => setBg(b)} aria-pressed={bg === b}>
              {b}
            </button>
          ))}
        </div>
      </div>
      {meshInfo && meshInfo.files.length > 0 && (
        <MeshNotice info={meshInfo} report={meshReport} busy={meshBusy} onLoad={() => void loadMeshes(meshInfo.files, true)} />
      )}
      {texStats.missing.length > 0 && (
        <p className="note vfx-mesh-note" title={texStats.missing.join('\n')}>
          {texStats.missing.length} of {texStats.total} uploaded texture{texStats.total === 1 ? '' : 's'} not loaded (shown as placeholders): Roblox did not return a preview for {texStats.missing.length === 1 ? 'it' : 'them'} (offline, private or moderated).
        </p>
      )}
      <p className="note vfx-honest">
        Approximation of Roblox's renderer (blending, sequences, flipbooks, drag and shapes follow the ParticleEmitter docs; no bloom or engine lighting){placeholders ? ' · some textures are placeholders' : ''}. Use Test in Studio for the final check.
      </p>
    </div>
  )
}

// Real meshes vs proxies, with "Load meshes from Studio" and the per-mesh reasons.
function MeshNotice({ info, report, busy, onLoad }: { info: MeshInfo; report: MeshLoadReport | null; busy: boolean; onLoad: () => void }) {
  const n = info.files.length
  const k = info.loaded.length
  const failed = (report?.results ?? []).filter((r) => r.state === 'failed' && !info.loaded.some((f) => f.endsWith(r.id)))
  const reasons = new Map<string, number>()
  for (const r of failed) reasons.set(r.reason ?? 'unknown', (reasons.get(r.reason ?? 'unknown') ?? 0) + 1)
  return (
    <div className={`vfx-mesh-notice${k < n ? ' warn' : ''}`} role="status" data-testid="vfx-mesh-notice">
      <span>
        <Icon name="studio" size={11} /> {n} mesh{n === 1 ? '' : 'es'}, {k} loaded{k < n ? ` · ${n - k} drawn as proxy shapes` : ''}
      </span>
      {k < n && (
        <button className="btn small" onClick={onLoad} disabled={busy} title="Read the mesh files from Roblox Studio (Forge Bridge plugin), else download them with your Open Cloud key">
          {busy ? 'Loading…' : 'Load meshes from Studio'}
        </button>
      )}
      {failed.length > 0 && (
        <ul className="vfx-mesh-reasons">
          {[...reasons].slice(0, 4).map(([why, count]) => (
            <li key={why}>
              {count}× {why}
            </li>
          ))}
        </ul>
      )}
      {report?.notes.map((t) => (
        <p key={t} className="note">
          {t}
        </p>
      ))}
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
