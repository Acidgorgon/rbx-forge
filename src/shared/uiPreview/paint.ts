// Paint for the UI preview, shared by the DOM renderer, the SVG export and the Figma JSON: colours,
// UIGradient (Color x Transparency sequences, Rotation, Offset), UIStroke and UICorner. Pure.

import { bool, color, enumName, isTagged, num, vec2, type PreviewTree, type UiNode } from './protocol.ts'
import { modifier, TEXT_CLASSES } from './layout.ts'

export type RGB = [number, number, number]

export const clamp01 = (n: number) => Math.max(0, Math.min(1, n))

export function rgba(c: RGB, alpha = 1): string {
  const [r, g, b] = c.map((x) => Math.round(clamp01(x) * 255))
  const a = Math.round(clamp01(alpha) * 1000) / 1000
  return a >= 1 ? `rgb(${r}, ${g}, ${b})` : `rgba(${r}, ${g}, ${b}, ${a})`
}

export function hex(c: RGB): string {
  return '#' + c.map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('').toUpperCase()
}

export interface GradientStop {
  t: number
  color: RGB
  transparency: number
}

export interface Gradient {
  // Roblox UIGradient.Rotation in degrees (0 = left to right, clockwise).
  rotation: number
  offset: [number, number]
  stops: GradientStop[]
}

function sampleColor(seq: [number, number, number, number][], t: number): RGB {
  if (!seq.length) return [1, 1, 1]
  if (t <= seq[0][0]) return [seq[0][1], seq[0][2], seq[0][3]]
  for (let i = 1; i < seq.length; i++) {
    const [t1, r1, g1, b1] = seq[i]
    if (t <= t1) {
      const [t0, r0, g0, b0] = seq[i - 1]
      const a = t1 === t0 ? 1 : (t - t0) / (t1 - t0)
      return [r0 + (r1 - r0) * a, g0 + (g1 - g0) * a, b0 + (b1 - b0) * a]
    }
  }
  const last = seq[seq.length - 1]
  return [last[1], last[2], last[3]]
}

function sampleNumber(seq: [number, number][], t: number): number {
  if (!seq.length) return 0
  if (t <= seq[0][0]) return seq[0][1]
  for (let i = 1; i < seq.length; i++) {
    const [t1, v1] = seq[i]
    if (t <= t1) {
      const [t0, v0] = seq[i - 1]
      const a = t1 === t0 ? 1 : (t - t0) / (t1 - t0)
      return v0 + (v1 - v0) * a
    }
  }
  return seq[seq.length - 1][1]
}

// The UIGradient child of `node` (Enabled), merged into one stop list. Keypoints at the same time
// (hard stops) are kept in order.
export function gradientOf(tree: PreviewTree, node: UiNode): Gradient | null {
  const g = modifier(tree, node, 'UIGradient')
  if (!g) return null
  return gradientFromProps(g.props)
}

export function gradientFromProps(props: UiNode['props']): Gradient {
  const colors = isTagged(props.Color, 'ColorSequence') ? props.Color.v : [[0, 1, 1, 1], [1, 1, 1, 1]] as [number, number, number, number][]
  const alphas = isTagged(props.Transparency, 'NumberSequence') ? props.Transparency.v : [[0, 0], [1, 0]] as [number, number][]
  const stops: GradientStop[] = []
  const times: { t: number; from: 'c' | 'a'; i: number }[] = [
    ...colors.map((k, i) => ({ t: k[0], from: 'c' as const, i })),
    ...alphas.map((k, i) => ({ t: k[0], from: 'a' as const, i }))
  ]
  times.sort((a, b) => a.t - b.t || (a.from === b.from ? a.i - b.i : 0))
  for (const k of times) {
    // A hard stop is two keypoints at the same time: use each side's own value.
    const c: RGB = k.from === 'c' ? [colors[k.i][1], colors[k.i][2], colors[k.i][3]] : sampleColor(colors, k.t)
    const a = k.from === 'a' ? alphas[k.i][1] : sampleNumber(alphas, k.t)
    const prev = stops[stops.length - 1]
    if (prev && prev.t === k.t && prev.transparency === a && prev.color.every((x, i) => Math.abs(x - c[i]) < 1e-4)) continue
    stops.push({ t: k.t, color: c, transparency: a })
  }
  return { rotation: num(props.Rotation), offset: vec2(props.Offset), stops }
}

// Stops multiplied by a base colour and alpha (the GuiObject's own colour/transparency), with the
// Offset applied along the gradient axis.
export function shadeStops(g: Gradient, base: RGB, baseAlpha: number): { t: number; css: string; color: RGB; alpha: number }[] {
  const rad = (g.rotation * Math.PI) / 180
  const shift = g.offset[0] * Math.cos(rad) + g.offset[1] * Math.sin(rad)
  return g.stops.map((s) => {
    const c: RGB = [s.color[0] * base[0], s.color[1] * base[1], s.color[2] * base[2]]
    const alpha = baseAlpha * (1 - s.transparency)
    return { t: s.t + shift, css: rgba(c, alpha), color: c, alpha }
  })
}

// CSS linear-gradient for a gradient painted over `base`. CSS 90deg runs left to right, and both
// rotate clockwise on screen, so the CSS angle is 90 + Rotation.
export function cssGradient(g: Gradient, base: RGB, baseAlpha: number): string {
  const stops = shadeStops(g, base, baseAlpha)
  return `linear-gradient(${90 + g.rotation}deg, ${stops.map((s) => `${s.css} ${(s.t * 100).toFixed(2)}%`).join(', ')})`
}

export interface Stroke {
  thickness: number
  color: RGB
  transparency: number
  // Border: around the box. Text: around the glyphs (Contextual on a text object).
  target: 'border' | 'text'
  join: 'Round' | 'Bevel' | 'Miter'
  gradient: Gradient | null
}

export function strokeOf(tree: PreviewTree, node: UiNode, k = 1): Stroke | null {
  const s = modifier(tree, node, 'UIStroke')
  if (s) {
    const mode = enumName(s.props.ApplyStrokeMode, 'Contextual')
    const thickness = num(s.props.Thickness, 1) * k
    if (thickness <= 0) return null
    return {
      thickness,
      color: color(s.props.Color, [0, 0, 0]),
      transparency: num(s.props.Transparency),
      target: mode === 'Contextual' && TEXT_CLASSES.has(node.cls) ? 'text' : 'border',
      join: enumName(s.props.LineJoinMode, 'Round') as Stroke['join'],
      gradient: gradientOf(tree, s)
    }
  }
  // Legacy text stroke.
  if (TEXT_CLASSES.has(node.cls) && num(node.props.TextStrokeTransparency, 1) < 1) {
    return { thickness: k, color: color(node.props.TextStrokeColor3, [0, 0, 0]), transparency: num(node.props.TextStrokeTransparency, 1), target: 'text', join: 'Round', gradient: null }
  }
  return null
}

export function hasCorner(tree: PreviewTree, node: UiNode): UiNode | undefined {
  return modifier(tree, node, 'UICorner')
}

// Background fill alpha (0 = invisible).
export function backgroundAlpha(node: UiNode): number {
  return 1 - num(node.props.BackgroundTransparency, 0)
}

export function textAlpha(node: UiNode): number {
  return 1 - num(node.props.TextTransparency, 0)
}

export function isVisible(node: UiNode): boolean {
  return bool(node.props.Visible, true)
}
