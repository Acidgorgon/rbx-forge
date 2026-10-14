// Colour math for the preview's linear-light output (renderer/.../preview/stage.ts LinearOutput):
// Roblox colours are sRGB; the preview adds sprites in linear light and rolls highlights off with a
// soft shoulder instead of clipping, so stacked additive layers keep their hue the way Studio does.

import type { Rgb } from './types.ts'

// sRGB colour (possibly pre-multiplied by Brightness `bright`) -> linear, keeping the multiplier
// linear (Brightness scales light, not the encoded value).
export function linearColor(c: Rgb, bright = 1): Rgb {
  const b = bright > 0 ? bright : 1
  const f = (x: number) => {
    const v = Math.max(0, x / b)
    return (v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * b
  }
  return [f(c[0]), f(c[1]), f(c[2])]
}

// Linear -> displayed sRGB: identity below SHOULDER, exponential roll-off above (never clips).
export const SHOULDER = 0.75
export function outputCurve(linear: number): number {
  const k = SHOULDER
  const c = Math.max(0, linear)
  const v = Math.min(c, k) + (1 - k) * (1 - Math.exp(-Math.max(0, c - k) / (1 - k)))
  const x = Math.min(1, Math.max(0, v))
  return x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
}
