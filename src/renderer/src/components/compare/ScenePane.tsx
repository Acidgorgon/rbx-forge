// One compare pane around a lab's canvas scene class (VfxScene, AnimScene, AbilityScene, or any
// object with setTime / render / resize / dispose): creates it once, (re)loads the version when
// loadKey changes, and draws it at the compare clock's time for this side.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useCompareTime, type PaneContext } from './CompareView'

export interface PaneScene {
  setTime(t: number): unknown
  render(): void
  resize(width: number, height: number): void
  dispose(): void
}

export function ScenePane<S extends PaneScene>({
  ctx,
  create,
  load,
  loadKey,
  label,
  children
}: {
  ctx: PaneContext
  create: (canvas: HTMLCanvasElement) => S
  // Load the version into the scene (may be async); runs on mount and when loadKey changes.
  load: (scene: S) => unknown
  loadKey: string
  label: string
  // Overlays inside the canvas frame (screen effects...).
  children?: ReactNode
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const sceneRef = useRef<S | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [ready, setReady] = useState(0)

  useEffect(() => {
    let scene: S
    try {
      scene = create(canvasRef.current!)
    } catch (e) {
      setError(`WebGL is not available: ${(e as Error).message}`)
      return
    }
    sceneRef.current = scene
    const ro = new ResizeObserver(() => {
      const r = wrapRef.current!.getBoundingClientRect()
      if (r.width && r.height) scene.resize(r.width, r.height)
    })
    ro.observe(wrapRef.current!)
    setReady((n) => n + 1)
    return () => {
      ro.disconnect()
      scene.dispose()
      sceneRef.current = null
    }
  }, [])

  useEffect(() => {
    const scene = sceneRef.current
    if (!scene) return
    Promise.resolve(load(scene)).catch((e) => setError(String((e as Error)?.message ?? e)))
  }, [loadKey, ready])

  useCompareTime(ctx, (t) => {
    const scene = sceneRef.current
    if (!scene) return
    scene.setTime(t)
    scene.render()
  })

  return (
    <div ref={wrapRef} className="cmp-canvas">
      <canvas ref={canvasRef} aria-label={label} />
      {children}
      {error && <div className="cmp-canvas-err note">{error}</div>}
    </div>
  )
}
