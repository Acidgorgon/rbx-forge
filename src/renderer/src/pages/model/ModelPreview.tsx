// Live 3D preview of a Model Lab build (three.js, preview/modelScene.ts): orbit, front / side / back /
// top views, Studio / dark / grey stage, the part count, and the build checks. Takes the library
// thumbnail once per edit (onSnapshot).
import { useEffect, useRef, useState } from 'react'
import type { ModelBuild } from '@shared/types'
import { MODEL_VIEWS, visibleParts, type ModelView } from '@shared/model/frame'
import { PART_BUDGET } from '@shared/model/prompt'
import { Icon } from '../../components/Icons'
import { webglMessage } from '../../lib/webgl'
import { BACKGROUNDS, type Background } from '../vfx/preview/stage'
import { ModelScene } from './preview/modelScene'

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function ModelPreview({ build, name, onSnapshot }: { build: ModelBuild; name: string; onSnapshot?: (png: string) => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<ModelScene | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<ModelView>('front')
  const [bg, setBg] = useState<Background>('studio')
  const snapRef = useRef(onSnapshot)
  snapRef.current = onSnapshot

  useEffect(() => {
    const canvas = canvasRef.current!
    let scene: ModelScene
    try {
      scene = new ModelScene(canvas, { background: 'studio' })
    } catch (e) {
      setError(webglMessage(e))
      return
    }
    sceneRef.current = scene
    const wrap = wrapRef.current!
    const ro = new ResizeObserver(() => {
      if (!wrap.isConnected) return
      const r = wrap.getBoundingClientRect()
      scene.resize(r.width, r.height)
      scene.render()
    })
    ro.observe(wrap)
    let raf = 0
    const step = () => {
      raf = requestAnimationFrame(step)
      scene.render()
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
    scene.load(build.parts)
    if (!snapRef.current || !build.ok || !build.parts.length) return
    let live = true
    void nextFrame().then(() => {
      if (live && sceneRef.current === scene) snapRef.current?.(scene.snapshot('front'))
    })
    return () => {
      live = false
    }
  }, [build])

  useEffect(() => sceneRef.current?.setBackground(bg), [bg])
  useEffect(() => sceneRef.current?.setView(view), [view])

  const shown = visibleParts(build.parts).length
  const over = build.parts.length > PART_BUDGET
  return (
    <div className="vfx-preview model-preview">
      <div ref={wrapRef} className="vfx-canvas model-canvas">
        <canvas ref={canvasRef} aria-label={`3D preview of ${name}`} />
        {error && <div className="vfx-canvas-err note">{error}</div>}
        {!error && !build.ok && <div className="vfx-canvas-err note">{build.error ? `The build failed${build.error.line ? ` at line ${build.error.line}` : ''}: ${build.error.message}` : 'Nothing to show yet'}</div>}
        <div className="vfx-hud mono" aria-live="off">
          <span data-testid="model-part-count" className={over ? 'model-over' : undefined}>
            {build.parts.length.toLocaleString('en-US')} parts
          </span>
          {build.parts.length !== shown ? ` · ${shown.toLocaleString('en-US')} visible` : ''}
          {build.stats ? ` · ${build.stats.motors} motors` : ''}
          {build.ms !== undefined ? ` · ${build.ms} ms` : ''}
        </div>
      </div>
      <div className="vfx-transport">
        <div className="seg" role="group" aria-label="Camera">
          {MODEL_VIEWS.map((v) => (
            <button key={v} className={view === v ? 'on' : ''} onClick={() => (setView(v), sceneRef.current?.setView(v))} aria-pressed={view === v}>
              {v}
            </button>
          ))}
        </div>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Background">
          {BACKGROUNDS.map((b) => (
            <button key={b} className={bg === b ? 'on' : ''} onClick={() => setBg(b)} aria-pressed={bg === b}>
              {b}
            </button>
          ))}
        </div>
      </div>
      {build.warnings.length > 0 && (
        <ul className="vfx-warn" data-testid="model-warnings">
          {build.warnings.map((w) => (
            <li key={w} className="warn">
              <Icon name="warn" size={11} /> {w}
            </li>
          ))}
        </ul>
      )}
      <p className="note vfx-honest">Drawn from the Lune preview build: every Part with its shape, size, colour and material look (no textures or engine lighting). Build in Studio for the real thing.</p>
    </div>
  )
}
