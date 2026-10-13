// Offscreen capture mode (?ability-capture=1): only the ability preview (canvas + screen-effect
// layers), driven by the main process through services/capture/offscreen.ts for the vision critic:
//   window.__abilityCapture.load(ability, effects) -> resolves when textures are ready
//   window.__abilityCapture.at(t)                  -> draws ability time t, resolves after paint
import { useEffect, useRef } from 'react'
import type { Ability } from '@shared/ability/types'
import type { VfxEffect } from '@shared/types'
import { AbilityScene } from './preview/abilityScene'
import { applyScreen, type ScreenEls } from './preview/screenFx'
import { ScreenLayers } from './AbilityPreview'
import './ability.css'

declare global {
  interface Window {
    __abilityCapture?: { load(ability: Ability, effects: Record<string, VfxEffect>): Promise<boolean>; at(t: number): Promise<number> }
  }
}

const nextFrame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())))

export function AbilityCapture() {
  const ref = useRef<HTMLCanvasElement>(null)
  const fx = useRef<Partial<ScreenEls>>({})
  useEffect(() => {
    const canvas = ref.current!
    const scene = new AbilityScene(canvas, { interactive: false, resolver: (r) => window.harness.vfxResolveTexture(r) })
    const fit = () => scene.resize(window.innerWidth, window.innerHeight)
    fit()
    window.addEventListener('resize', fit)
    const draw = (t: number) => {
      const f = scene.setTime(t)
      const els = fx.current
      if (els.tint && els.bloom && els.flash) applyScreen({ canvas, tint: els.tint, bloom: els.bloom, flash: els.flash }, f.screen)
      scene.render()
      return f
    }
    window.__abilityCapture = {
      async load(ability, effects) {
        fit()
        await scene.load(ability, effects)
        draw(0)
        await nextFrame()
        return true
      },
      async at(t) {
        const f = draw(t)
        await nextFrame()
        return f.particles
      }
    }
    return () => {
      window.removeEventListener('resize', fit)
      delete window.__abilityCapture
      scene.dispose()
    }
  }, [])
  return (
    <div className="ab-capture">
      <canvas ref={ref} />
      <ScreenLayers refs={fx} />
    </div>
  )
}
