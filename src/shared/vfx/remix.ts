// Remix: start from the closest real effect in the user's library instead of drafting from scratch.
// The copy keeps the effect's structure, textures, flipbooks and timing (what makes it look like the
// user's work); only what the request asks for changes: the hue (a fire slash asked for in blue
// rotates every saturated colour, whites and smoke stay), the size ("huge" / "small"), the name.
// The model then edits it with a few parameter changes (service.ts), or the remix is used as is.
// Pure code (test/vfxQuality.test.ts).

import { allNodes, hueName } from './analyze.ts'
import { SCHEMA } from './schema.ts'
import { fromHex } from './sequence.ts'
import type { VfxRequest } from './retrieve.ts'
import type { ColorKey, NumKey, Rgb, VfxEffect, VfxEntry } from './types.ts'
import { tagGroupsOf } from './tags.ts'

// Hue (degrees) per colour name and per element (the element's main colour).
const HUE_DEG: Record<string, number> = { red: 2, orange: 28, yellow: 52, green: 120, cyan: 185, blue: 222, purple: 275, pink: 322 }
const ELEMENT_HUE: Record<string, number> = { fire: 26, ice: 200, electric: 195, water: 210, dark: 278, light: 48, energy: 270, wind: 170, earth: 32 }

function rgbToHsv([r, g, b]: Rgb): [number, number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  const d = mx - mn
  let h = 0
  if (d > 1e-6) {
    if (mx === r) h = ((g - b) / d) % 6
    else if (mx === g) h = (b - r) / d + 2
    else h = (r - g) / d + 4
    h = (h * 60 + 360) % 360
  }
  return [h, mx <= 0 ? 0 : d / mx, mx]
}

function hsvToRgb([h, s, v]: [number, number, number]): Rgb {
  const c = v * s
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1))
  const m = v - c
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m].map((k) => Math.round(Math.max(0, Math.min(1, k)) * 1000) / 1000) as Rgb
}

const SATURATED = 0.22

// The effect's main hue: circular mean over saturated, visible colour keys (emitters, beams, trails,
// lights, parts). null when it is all white / grey.
export function mainHue(effect: VfxEffect): number | null {
  let x = 0
  let y = 0
  let n = 0
  for (const node of allNodes(effect.roots)) {
    for (const [k, v] of Object.entries(node.props)) {
      const kind = SCHEMA[node.className]?.[k]?.kind
      const cols: Rgb[] = kind === 'cseq' ? (v as ColorKey[]).map((c) => c.c) : kind === 'color3' && Array.isArray(v) ? [v as unknown as Rgb] : []
      for (const c of cols) {
        const [h, s, val] = rgbToHsv(c)
        if (s < SATURATED || val < 0.15) continue
        const w = s * val
        x += Math.cos((h * Math.PI) / 180) * w
        y += Math.sin((h * Math.PI) / 180) * w
        n += w
      }
    }
  }
  if (n <= 0) return null
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360
}

// The hue the request asks for: a colour word wins, else an element the base does not have.
export function targetHue(req: VfxRequest, base?: VfxEntry): number | null {
  const hue = req.hues.find((h) => HUE_DEG[h] !== undefined)
  if (hue) return HUE_DEG[hue]
  const have = base ? tagGroupsOf(base).element : []
  const el = req.groups.element.find((e) => ELEMENT_HUE[e] !== undefined)
  if (el && !have.includes(el)) return ELEMENT_HUE[el]
  return null
}

// Rotates every saturated colour so the effect's main hue lands on `hue` (whites, greys, blacks
// and smoke keep their colour; value and saturation stay). Returns the same effect when it is
// already within 18 degrees.
export function recolor(effect: VfxEffect, hue: number): { effect: VfxEffect; delta: number } {
  const from = mainHue(effect)
  if (from === null) return { effect, delta: 0 }
  let delta = (((hue - from) % 360) + 540) % 360 - 180
  if (Math.abs(delta) < 18) return { effect, delta: 0 }
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  const turn = (c: Rgb): Rgb => {
    const [h, s, v] = rgbToHsv(c)
    if (s < SATURATED * 0.6) return c
    return hsvToRgb([(h + delta + 360) % 360, s, v])
  }
  for (const node of allNodes(next.roots)) {
    for (const [k, v] of Object.entries(node.props)) {
      const kind = SCHEMA[node.className]?.[k]?.kind
      if (kind === 'cseq') node.props[k] = (v as ColorKey[]).map((c) => ({ t: c.t, c: turn(c.c) }))
      else if (kind === 'color3' && Array.isArray(v) && v.length === 3) node.props[k] = turn(v as unknown as Rgb) as unknown as number[]
    }
  }
  // Tween goals in the cues (Color on lights / parts).
  for (const c of next.cues) {
    for (const [k, v] of Object.entries(c.props ?? {})) if (k === 'Color' && Array.isArray(v) && v.length === 3 && typeof v[0] === 'number') c.props![k] = turn(v as unknown as Rgb) as unknown as number[]
  }
  delta = Math.round(delta)
  return { effect: next, delta }
}

// Scales particle sizes, beam widths and light ranges (not speeds or timing).
export function rescale(effect: VfxEffect, k: number): VfxEffect {
  if (Math.abs(k - 1) < 1e-3) return effect
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  const r = (x: number) => Math.round(x * k * 1000) / 1000
  for (const n of allNodes(next.roots)) {
    if (n.className === 'ParticleEmitter' && Array.isArray(n.props.Size)) n.props.Size = (n.props.Size as NumKey[]).map((key) => ({ ...key, v: r(key.v), ...(key.e ? { e: r(key.e) } : {}) }))
    if (n.className === 'Beam') for (const p of ['Width0', 'Width1']) if (typeof n.props[p] === 'number') n.props[p] = r(n.props[p] as number)
    if (/Light$/.test(n.className) && typeof n.props.Range === 'number') n.props.Range = Math.min(60, r(n.props.Range as number))
  }
  return next
}

export interface Remix {
  effect: VfxEffect
  base: VfxEntry
  notes: string[]
}

// A copy of `base` fitted to the request (name, hue, size). Never edits the library entry.
export function remixEffect(base: VfxEntry, req: VfxRequest, name: string): Remix {
  let effect: VfxEffect = JSON.parse(JSON.stringify(base.effect))
  effect.name = name
  delete effect.patches
  const notes: string[] = [`started from your effect "${base.name}"`]
  const hue = targetHue(req, base)
  if (hue !== null) {
    const r = recolor(effect, hue)
    if (r.delta) {
      effect = r.effect
      notes.push(`recoloured toward ${hueName(hsvToRgb([hue, 1, 1])) ?? 'the request'} (hue ${r.delta > 0 ? '+' : ''}${r.delta} deg)`)
    }
  }
  if (req.scale !== 1) {
    effect = rescale(effect, req.scale)
    notes.push(`${req.scale > 1 ? 'scaled up' : 'scaled down'} x${req.scale}`)
  }
  return { effect, base, notes }
}

export function hexHue(h: string): number {
  return rgbToHsv(fromHex(h))[0]
}
