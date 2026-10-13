// Offscreen capture mode (?vfx-capture=1): only the preview canvas, driven by the main process
// through services/capture/offscreen.ts for the vfx_render tool and the refine loop:
//   window.__vfxCapture.load(effect, { background, view }) -> resolves when textures are ready
//   window.__vfxCapture.at(t)                        -> draws the frame at t, resolves after paint
import { useEffect, useRef } from 'react'
import type { VfxEffect } from '@shared/types'
import { VfxScene, type Background, type View } from './preview/scene'

declare global {
  interface Window {
    __vfxCapture?: { load(effect: VfxEffect, opts?: { background?: Background; view?: View }): Promise<boolean>; at(t: number): Promise<number> }
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function VfxCapture() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current!
    const scene = new VfxScene(canvas, { interactive: false, resolver: (r) => window.harness.vfxResolveTexture(r) })
    const fit = () => scene.resize(window.innerWidth, window.innerHeight)
    fit()
    window.addEventListener('resize', fit)
    window.__vfxCapture = {
      async load(effect, opts) {
        fit()
        scene.setBackground(opts?.background ?? 'dark')
        scene.setView(opts?.view ?? 'front')
        await scene.load(effect)
        scene.setTime(0)
        scene.render()
        await nextFrame()
        return true
      },
      async at(t) {
        const s = scene.setTime(t)
        scene.render()
        await nextFrame()
        return s.particles
      }
    }
    return () => {
      window.removeEventListener('resize', fit)
      delete window.__vfxCapture
      scene.dispose()
    }
  }, [])
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', display: 'block' }} />
}
