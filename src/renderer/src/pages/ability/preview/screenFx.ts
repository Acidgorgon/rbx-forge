// Screen effects for the Ability Composer preview, approximated with CSS on top of the WebGL canvas
// (updated every frame without React): ColorCorrectionEffect (Brightness, Contrast, Saturation,
// TintColor) as CSS brightness / contrast / saturate plus a multiply tint layer, BlurEffect (Size) as
// a CSS blur, BloomEffect (Intensity, Size, Threshold) as a brightness lift plus a soft screen-blend
// glow, and the flash as a full-screen colour layer like the runner's ScreenGui Frame. Property names
// per the Roblox Creator Hub class pages; the look is an approximation, not Roblox's post-processing.

import type { ScreenState } from '@shared/ability/timing'

export interface ScreenEls {
  canvas: HTMLElement
  tint: HTMLElement
  bloom: HTMLElement
  flash: HTMLElement
}

const rgb = (c: number[], a = 1) => `rgba(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)}, ${a})`

export function screenFilter(s: ScreenState): string {
  const cc = s.colorCorrection
  const bloomLift = Math.min(0.6, s.bloom.intensity * 0.12)
  const parts: string[] = []
  const brightness = 1 + cc.brightness + bloomLift
  if (Math.abs(brightness - 1) > 1e-3) parts.push(`brightness(${brightness.toFixed(3)})`)
  if (Math.abs(cc.contrast) > 1e-3) parts.push(`contrast(${Math.max(0, 1 + cc.contrast).toFixed(3)})`)
  if (Math.abs(cc.saturation) > 1e-3) parts.push(`saturate(${Math.max(0, 1 + cc.saturation).toFixed(3)})`)
  // BlurEffect.Size is roughly a pixel radius at 1080p; scaled down for the smaller canvas.
  if (s.blur > 0.05) parts.push(`blur(${(s.blur * 0.35).toFixed(2)}px)`)
  return parts.join(' ') || 'none'
}

export function applyScreen(els: ScreenEls, s: ScreenState): void {
  els.canvas.style.filter = screenFilter(s)
  const tint = s.colorCorrection.tint
  const tinted = Math.abs(tint[0] - 1) + Math.abs(tint[1] - 1) + Math.abs(tint[2] - 1) > 0.01
  els.tint.style.opacity = tinted ? '1' : '0'
  if (tinted) els.tint.style.background = rgb(tint)
  const glow = Math.min(0.55, s.bloom.intensity * 0.22)
  els.bloom.style.opacity = glow > 0.005 ? glow.toFixed(3) : '0'
  els.flash.style.opacity = s.flash.opacity > 0.002 ? s.flash.opacity.toFixed(3) : '0'
  els.flash.style.background = rgb(s.flash.color)
}
