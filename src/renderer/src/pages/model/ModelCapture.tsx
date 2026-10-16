// Offscreen capture mode (?model-capture=1): only the block-model preview, driven by the main process
// through services/capture/offscreen.ts for the Model Lab critic:
//   window.__modelCapture.load(parts)  -> draws the build (front view), resolves after paint
//   window.__modelCapture.view(name)   -> moves the camera to a view, resolves after paint
import { useEffect, useRef } from 'react'
import type { ModelPart } from '@shared/types'
import type { ModelView } from '@shared/model/frame'
import { ModelScene } from './preview/modelScene'

declare global {
  interface Window {
    __modelCapture?: { load(parts: ModelPart[]): Promise<number>; view(view: ModelView): Promise<boolean> }
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function ModelCapture() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const scene = new ModelScene(canvas, { interactive: false, background: 'studio' })
    const fit = () => scene.resize(window.innerWidth, window.innerHeight)
    fit()
    window.addEventListener('resize', fit)
    window.__modelCapture = {
      async load(parts) {
        fit()
        scene.load(parts)
        scene.render()
        await nextFrame()
        return scene.partCount
      },
      async view(view) {
        scene.setView(view)
        scene.render()
        await nextFrame()
        return true
      }
    }
    return () => {
      window.removeEventListener('resize', fit)
      delete window.__modelCapture
      scene.dispose()
    }
  }, [])
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', display: 'block' }} />
}
