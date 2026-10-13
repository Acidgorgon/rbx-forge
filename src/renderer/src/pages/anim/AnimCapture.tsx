// Offscreen capture mode (?anim-capture=1): only the R15 preview canvas, driven by the main process
// through services/capture/offscreen.ts for the critic and anim_critique:
//   window.__animCapture.load(clip, { reference }) -> resolves once the first frame is drawn
//   window.__animCapture.at(t)                      -> draws the pose at t, resolves after paint
import { useEffect, useRef } from 'react'
import type { AnimClip } from '@shared/types'
import { AnimScene } from './preview/rig'

declare global {
  interface Window {
    __animCapture?: { load(clip: AnimClip, opts?: { reference?: AnimClip | null }): Promise<boolean>; at(t: number): Promise<number> }
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function AnimCapture() {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const scene = new AnimScene(ref.current!, { interactive: false })
    const fit = () => scene.resize(window.innerWidth, window.innerHeight)
    fit()
    window.addEventListener('resize', fit)
    window.__animCapture = {
      async load(clip, opts) {
        fit()
        scene.setClip(clip)
        scene.setReference(opts?.reference ?? null)
        scene.setTime(0)
        scene.render()
        await nextFrame()
        return true
      },
      async at(t) {
        scene.setTime(t)
        scene.render()
        await nextFrame()
        return t
      }
    }
    return () => {
      window.removeEventListener('resize', fit)
      delete window.__animCapture
      scene.dispose()
    }
  }, [])
  return <canvas ref={ref} style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', display: 'block' }} />
}
