// Procedural VFX textures in pure code (no AI, no cost): soft glow, ring, spark streak, noise smoke,
// crack, star and slash arc. Each is a function of its parameters, a seed and an evolution time
// t (0..1) for flipbooks, so the same parameters always give the same pixels (tests check hashes),
// and the AI or the user can ask for exactly the texture they want.
//
// Output is white (or greyscale shading) on transparent with straight alpha, centred, fading to zero
// before the edge, so ParticleEmitter.Color / Beam.Color tint it like Roblox's own particle textures.

import { hashSeed, rng } from '../sequence.ts'
import { applyTint, assembleFlipbook, blank, layoutForFrames, type FlipbookLayout, type Rgba, type TintMode } from './image.ts'

export const PROCEDURAL_TYPES = ['glow', 'ring', 'spark', 'smoke', 'crack', 'star', 'slash'] as const
export type ProceduralType = (typeof PROCEDURAL_TYPES)[number]

export interface ParamSpec {
  min: number
  max: number
  step: number
  default: number
  label: string
}

// Parameters per type (all numbers; the editor draws a slider for each).
export const PROCEDURAL_PARAMS: Record<ProceduralType, Record<string, ParamSpec>> = {
  glow: {
    falloff: { min: 0.5, max: 6, step: 0.1, default: 2.2, label: 'falloff' },
    core: { min: 0, max: 0.6, step: 0.01, default: 0.12, label: 'hot core' },
    radius: { min: 0.3, max: 1, step: 0.01, default: 0.95, label: 'radius' }
  },
  ring: {
    radius: { min: 0.2, max: 0.85, step: 0.01, default: 0.62, label: 'radius' },
    thickness: { min: 0.02, max: 0.4, step: 0.01, default: 0.1, label: 'thickness' },
    softness: { min: 0, max: 1, step: 0.05, default: 0.5, label: 'softness' },
    breakup: { min: 0, max: 1, step: 0.05, default: 0, label: 'noise breakup' }
  },
  spark: {
    length: { min: 0.3, max: 1, step: 0.01, default: 0.92, label: 'length' },
    width: { min: 0.02, max: 0.3, step: 0.01, default: 0.07, label: 'width' },
    taper: { min: 0, max: 1, step: 0.05, default: 0.6, label: 'taper' },
    head: { min: 0, max: 1, step: 0.05, default: 0.4, label: 'bright head' }
  },
  smoke: {
    scale: { min: 1, max: 8, step: 0.1, default: 3.2, label: 'noise scale' },
    octaves: { min: 1, max: 6, step: 1, default: 4, label: 'octaves' },
    density: { min: 0.1, max: 1, step: 0.05, default: 0.65, label: 'density' },
    softness: { min: 0, max: 1, step: 0.05, default: 0.6, label: 'edge softness' }
  },
  crack: {
    branches: { min: 2, max: 12, step: 1, default: 6, label: 'branches' },
    jitter: { min: 0, max: 1, step: 0.05, default: 0.55, label: 'jitter' },
    width: { min: 0.005, max: 0.08, step: 0.005, default: 0.02, label: 'line width' },
    glow: { min: 0, max: 1, step: 0.05, default: 0.35, label: 'glow' }
  },
  star: {
    points: { min: 3, max: 12, step: 1, default: 4, label: 'points' },
    sharpness: { min: 1, max: 40, step: 1, default: 14, label: 'sharpness' },
    core: { min: 0, max: 0.5, step: 0.01, default: 0.16, label: 'core' },
    rotation: { min: 0, max: 90, step: 1, default: 0, label: 'rotation°' }
  },
  slash: {
    arc: { min: 40, max: 300, step: 5, default: 160, label: 'arc°' },
    radius: { min: 0.3, max: 0.85, step: 0.01, default: 0.66, label: 'radius' },
    thickness: { min: 0.03, max: 0.4, step: 0.01, default: 0.16, label: 'thickness' },
    taper: { min: 0, max: 1, step: 0.05, default: 0.8, label: 'end taper' }
  }
}

// What each type is for (picker, AI tool descriptions) and the built-in it replaces.
export const PROCEDURAL_INFO: Record<ProceduralType, { label: string; use: string }> = {
  glow: { label: 'Soft glow', use: 'cores, auras, flashes, light blooms' },
  ring: { label: 'Ring', use: 'shockwaves, impact rings, portals (Orientation VelocityPerpendicular or a flat Beam)' },
  spark: { label: 'Spark streak', use: 'sparks and embers with Orientation VelocityParallel' },
  smoke: { label: 'Noise smoke', use: 'smoke puffs, dust, fog (grey tint keeps depth)' },
  crack: { label: 'Crack', use: 'ground cracks, lightning branches, shatter' },
  star: { label: 'Star', use: 'twinkles, glints, hit flashes' },
  slash: { label: 'Slash arc', use: 'sword slashes and swipes (a crescent; rotate with Rotation)' }
}

export type ProceduralParams = Record<string, number>

export interface ProceduralRequest {
  type: ProceduralType
  params?: ProceduralParams
  seed?: number
  // Pixels (power of two, 32..1024). Default 256 (single) or 1024 (flipbook sheet).
  size?: number
  tint?: TintMode
  // Flipbook: frames of the evolution (4 / 16 / 64 → Grid2x2 / Grid4x4 / Grid8x8).
  frames?: number
}

export function resolveParams(type: ProceduralType, params: ProceduralParams = {}): ProceduralParams {
  const spec = PROCEDURAL_PARAMS[type]
  const out: ProceduralParams = {}
  for (const [k, s] of Object.entries(spec)) {
    const v = Number(params[k])
    out[k] = Number.isFinite(v) ? Math.min(s.max, Math.max(s.min, v)) : s.default
  }
  return out
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)
const smooth = (a: number, b: number, x: number) => {
  const t = clamp01((x - a) / (b - a || 1e-9))
  return t * t * (3 - 2 * t)
}

// ------------------------------------------------------------------ noise

// Seeded value noise on a lattice (smooth-step interpolation), and fBm over octaves.
export function valueNoise(seed: number): (x: number, y: number) => number {
  const h = (ix: number, iy: number) => {
    let n = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + Math.imul(seed, 2147483647)
    n = Math.imul(n ^ (n >>> 13), 1274126177)
    return ((n ^ (n >>> 16)) >>> 0) / 4294967296
  }
  return (x, y) => {
    const ix = Math.floor(x)
    const iy = Math.floor(y)
    const fx = x - ix
    const fy = y - iy
    const sx = fx * fx * (3 - 2 * fx)
    const sy = fy * fy * (3 - 2 * fy)
    const a = h(ix, iy)
    const b = h(ix + 1, iy)
    const c = h(ix, iy + 1)
    const d = h(ix + 1, iy + 1)
    return a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy
  }
}

export function fbm(noise: (x: number, y: number) => number, x: number, y: number, octaves: number): number {
  let sum = 0
  let amp = 0.5
  let norm = 0
  let f = 1
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise(x * f + o * 17.3, y * f - o * 9.1)
    norm += amp
    amp *= 0.5
    f *= 2
  }
  return sum / norm
}

// ------------------------------------------------------------------ fields

// A field gives (alpha, shade) for u, v in [-1, 1] (y down) at evolution time t.
type Field = (u: number, v: number) => [number, number]

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax
  const dy = by - ay
  const l2 = dx * dx + dy * dy
  const t = l2 ? clamp01(((px - ax) * dx + (py - ay) * dy) / l2) : 0
  return Math.hypot(px - ax - t * dx, py - ay - t * dy)
}

// Crack segments: random walks from the centre that branch, each with its distance from the start
// (so t reveals them in growth order).
export function crackSegments(p: ProceduralParams, seed: number): { a: [number, number]; b: [number, number]; d0: number; d1: number; w: number }[] {
  const r = rng(hashSeed('crack', seed))
  const segs: { a: [number, number]; b: [number, number]; d0: number; d1: number; w: number }[] = []
  const walk = (x: number, y: number, ang: number, len: number, dist: number, width: number, depth: number) => {
    const steps = Math.max(3, Math.round(len / 0.07))
    for (let i = 0; i < steps && segs.length < 400; i++) {
      ang += (r() - 0.5) * 1.4 * p.jitter
      const step = len / steps
      const nx = x + Math.cos(ang) * step
      const ny = y + Math.sin(ang) * step
      if (Math.hypot(nx, ny) > 0.86) return
      segs.push({ a: [x, y], b: [nx, ny], d0: dist, d1: dist + step, w: width })
      dist += step
      x = nx
      y = ny
      width *= 0.93
      if (depth < 2 && r() < 0.18) walk(x, y, ang + (r() < 0.5 ? -1 : 1) * (0.5 + r() * 0.6), len * (0.35 + r() * 0.3), dist, width * 0.7, depth + 1)
    }
  }
  const n = Math.round(p.branches)
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + (r() - 0.5) * (Math.PI / n)
    walk(0, 0, ang, 0.55 + r() * 0.3, 0, p.width, 0)
  }
  return segs
}

function field(type: ProceduralType, p: ProceduralParams, seed: number, t: number): Field {
  switch (type) {
    case 'glow': {
      // Flipbook: a pulse (grows then settles).
      const s = 0.75 + 0.25 * Math.sin(Math.PI * t)
      const R = p.radius * s
      return (u, v) => {
        const r = Math.hypot(u, v) / R
        const body = Math.pow(clamp01(1 - r), p.falloff)
        const core = p.core > 0 ? Math.exp(-((r / Math.max(0.02, p.core)) ** 2)) : 0
        const a = clamp01(body + core * 0.6)
        return [a, clamp01(0.55 + core * 0.45 + body * 0.2)]
      }
    }
    case 'ring': {
      // Flipbook: the ring expands and thins out.
      const radius = p.radius * (t > 0 ? 0.25 + 0.75 * t : 1)
      const thick = p.thickness * (t > 0 ? 1.4 - 0.8 * t : 1)
      const noise = valueNoise(seed)
      return (u, v) => {
        const r = Math.hypot(u, v)
        const d = Math.abs(r - radius) / Math.max(0.005, thick)
        const hard = 1 - smooth(0.7, 1, d)
        const soft = Math.exp(-d * d * 2)
        let a = hard * (1 - p.softness) + soft * p.softness
        if (p.breakup > 0) {
          const ang = Math.atan2(v, u)
          const n = fbm(noise, Math.cos(ang) * 3 + 10, Math.sin(ang) * 3 + r * 4, 3)
          a *= clamp01(1 - p.breakup + (n - 0.35) * 2 * p.breakup)
        }
        return [a, clamp01(0.6 + 0.4 * (1 - d))]
      }
    }
    case 'spark': {
      const len = p.length * (t > 0 ? 1 - 0.6 * t : 1)
      return (u, v) => {
        const along = Math.abs(v) / Math.max(0.05, len)
        if (along >= 1) return [0, 0]
        const w = p.width * (1 - p.taper * along)
        const across = Math.abs(u) / Math.max(0.004, w)
        const a = Math.exp(-across * across * 2.5) * (1 - smooth(0.55, 1, along))
        const head = p.head * Math.exp(-((Math.hypot(u, v) / Math.max(0.02, p.width * 1.6)) ** 2))
        return [clamp01(a + head), clamp01(0.7 + 0.3 * (1 - along))]
      }
    }
    case 'smoke': {
      const noise = valueNoise(seed)
      const shade = valueNoise(seed + 101)
      // Flipbook: the puff expands, drifts and thins (dissolves from the inside out).
      const grow = t > 0 ? 0.55 + 0.45 * t : 1
      const drift = t * 1.5
      const thin = t > 0 ? t * 0.55 : 0
      return (u, v) => {
        const r = Math.hypot(u, v) / grow
        const n = fbm(noise, u * p.scale + 7 + drift, v * p.scale - 3 - drift * 0.5, Math.round(p.octaves))
        const edge = 1 - smooth(0.35 + 0.3 * (1 - p.softness), 1, r + (n - 0.5) * 0.55)
        const body = clamp01((n - (1 - p.density) * 0.55 - thin) * 2.2) * edge
        const s = fbm(shade, u * p.scale * 0.7 + 3, v * p.scale * 0.7 + 5, 3)
        // Lit from the top: brighter where v < 0.
        return [body, clamp01(0.45 + 0.4 * s + 0.25 * -v)]
      }
    }
    case 'crack':
      // Rasterised per segment in renderProcedural (a per-pixel field over hundreds of segments is slow).
      return () => [0, 0]
    case 'star': {
      const rot = (p.rotation * Math.PI) / 180 + t * (Math.PI / Math.max(3, p.points))
      const twinkle = t > 0 ? 0.6 + 0.4 * Math.sin(Math.PI * t) : 1
      return (u, v) => {
        const r = Math.hypot(u, v) / twinkle
        const ang = Math.atan2(v, u) - rot
        const ray = Math.pow(Math.abs(Math.cos((p.points / 2) * ang)), p.sharpness)
        const rays = ray * Math.pow(clamp01(1 - r), 1.6)
        const core = p.core > 0 ? Math.exp(-((r / p.core) ** 2)) : 0
        return [clamp01(rays + core), clamp01(0.7 + core * 0.3)]
      }
    }
    case 'slash': {
      const span = (p.arc * Math.PI) / 180
      // Flipbook: the arc sweeps in, then fades from its tail.
      const head = t > 0 ? Math.min(1, t * 1.6) : 1
      const tail = t > 0 ? Math.max(0, (t - 0.5) * 2) : 0
      return (u, v) => {
        // Arc centred on "up" (-v), sweeping clockwise.
        let ang = Math.atan2(u, -v) + span / 2
        if (ang < 0) ang += Math.PI * 2
        const f = ang / span
        if (f < tail || f > head) return [0, 0]
        const r = Math.hypot(u, v)
        const local = (f - tail) / Math.max(1e-3, head - tail)
        const ends = Math.pow(Math.sin(Math.PI * clamp01(local)), p.taper)
        const thick = p.thickness * (0.35 + 0.65 * local) * ends
        const d = (r - p.radius) / Math.max(0.004, thick)
        // Sharp outer edge, softer inner edge (a blade's leading edge).
        const a = d > 0 ? 1 - smooth(0.6, 1, d) : Math.exp(-d * d * 1.2)
        return [clamp01(a * (0.4 + 0.6 * local)), clamp01(0.6 + 0.4 * Math.max(0, d + 0.5))]
      }
    }
  }
}

// Crack: each segment stamps its line (and glow) into the pixels of its bounding box only.
function renderCrack(p: ProceduralParams, seed: number, size: number, t: number): { a: Float32Array; s: Float32Array } {
  const segs = crackSegments(p, seed)
  const maxD = Math.max(1e-6, ...segs.map((x) => x.d1))
  // Flipbook: the crack grows outwards.
  const reveal = t > 0 ? t * maxD : maxD
  const line = new Float32Array(size * size)
  const glow = new Float32Array(size * size)
  const px = 2 / size
  for (const sg of segs) {
    if (sg.d0 > reveal) continue
    // Partly revealed segment: cut at the reveal distance.
    const k = sg.d1 > reveal ? (reveal - sg.d0) / (sg.d1 - sg.d0) : 1
    const bx = sg.a[0] + (sg.b[0] - sg.a[0]) * k
    const by = sg.a[1] + (sg.b[1] - sg.a[1]) * k
    const w = Math.max(sg.w, px * 1.2)
    const reach = p.glow > 0 ? w * 4 + 0.02 : w
    const x0 = Math.max(0, Math.floor(((Math.min(sg.a[0], bx) - reach + 1) / 2) * size))
    const x1 = Math.min(size - 1, Math.ceil(((Math.max(sg.a[0], bx) + reach + 1) / 2) * size))
    const y0 = Math.max(0, Math.floor(((Math.min(sg.a[1], by) - reach + 1) / 2) * size))
    const y1 = Math.min(size - 1, Math.ceil(((Math.max(sg.a[1], by) + reach + 1) / 2) * size))
    for (let y = y0; y <= y1; y++) {
      const v = ((y + 0.5) / size) * 2 - 1
      for (let x = x0; x <= x1; x++) {
        const u = ((x + 0.5) / size) * 2 - 1
        const d = segDist(u, v, sg.a[0], sg.a[1], bx, by)
        const i = y * size + x
        const l = 1 - smooth(w * 0.5 - px * 0.5, w + px * 0.5, d)
        if (l > line[i]) line[i] = l
        if (p.glow > 0) {
          const g = Math.exp(-((d / (w * 4 + 0.01)) ** 2)) * p.glow * 0.6
          if (g > glow[i]) glow[i] = g
        }
      }
    }
  }
  const a = new Float32Array(size * size)
  const s = new Float32Array(size * size)
  for (let i = 0; i < a.length; i++) {
    a[i] = clamp01(line[i] + glow[i])
    s[i] = clamp01(line[i] * 0.9 + 0.1)
  }
  return { a, s }
}

// One frame (straight alpha; rgb = shade for 'grey', white otherwise).
export function renderProcedural(type: ProceduralType, params: ProceduralParams = {}, opts: { seed?: number; size?: number; t?: number; tint?: TintMode } = {}): Rgba {
  const p = resolveParams(type, params)
  const size = opts.size ?? 256
  const seed = opts.seed ?? 1
  const img = blank(size)
  const tint = opts.tint ?? 'white'
  if (type === 'crack') {
    const { a, s } = renderCrack(p, seed, size, opts.t ?? 0)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const k = 1 - smooth(0.88, 1 - 2 / size, Math.hypot(((x + 0.5) / size) * 2 - 1, ((y + 0.5) / size) * 2 - 1))
        const i = (y * size + x) * 4
        const shade = tint === 'grey' ? Math.round(s[y * size + x] * 255) : 255
        img.data[i] = img.data[i + 1] = img.data[i + 2] = shade
        img.data[i + 3] = Math.round(a[y * size + x] * k * 255)
      }
    }
    return img
  }
  const f = field(type, p, seed, opts.t ?? 0)
  // 2x2 supersampling keeps thin lines (cracks, sparks) from aliasing.
  const o = [0.25, 0.75]
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let a = 0
      let s = 0
      for (const oy of o) {
        for (const ox of o) {
          const u = ((x + ox) / size) * 2 - 1
          const v = ((y + oy) / size) * 2 - 1
          const [fa, fs] = f(u, v)
          // Safety falloff: nothing reaches the quad's edge.
          const k = 1 - smooth(0.88, 1 - 2 / size, Math.hypot(u, v))
          a += fa * k
          s += fs
        }
      }
      a /= 4
      s /= 4
      const i = (y * size + x) * 4
      const shade = tint === 'grey' ? Math.round(clamp01(s) * 255) : 255
      img.data[i] = shade
      img.data[i + 1] = shade
      img.data[i + 2] = shade
      img.data[i + 3] = Math.round(clamp01(a) * 255)
    }
  }
  return img
}

export interface ProceduralResult {
  image: Rgba
  // Frames in the sheet (1 = single texture), its layout, and the params actually used.
  frames: number
  layout?: FlipbookLayout
  params: ProceduralParams
  seed: number
}

// A texture or a flipbook sheet of its evolution (t = 0..1 over the frames).
export function generateProcedural(req: ProceduralRequest): ProceduralResult {
  if (!PROCEDURAL_TYPES.includes(req.type)) throw new Error(`unknown procedural type "${req.type}" (${PROCEDURAL_TYPES.join(', ')})`)
  const params = resolveParams(req.type, req.params)
  const seed = Math.max(0, Math.floor(req.seed ?? 1))
  const tint = req.tint ?? 'white'
  const frames = req.frames && req.frames > 1 ? Math.min(64, Math.floor(req.frames)) : 1
  if (frames <= 1) {
    const image = renderProcedural(req.type, params, { seed, size: req.size ?? 256, tint })
    return { image: tint === 'color' ? applyTint(image, 'color') : image, frames: 1, params, seed }
  }
  const layout = layoutForFrames(frames)
  const n = layout === 'Grid2x2' ? 4 : layout === 'Grid4x4' ? 16 : 64
  const size = req.size ?? (n === 4 ? 512 : 1024)
  const cols = Math.sqrt(n)
  const cell = Math.max(16, Math.floor(size / cols))
  const list: Rgba[] = []
  for (let i = 0; i < n; i++) list.push(renderProcedural(req.type, params, { seed, size: cell, t: (i + 1) / n, tint }))
  return { image: assembleFlipbook(list, layout, size, 0.04), frames: n, layout, params, seed }
}

// Procedural evolution of any sprite (an AI texture) into flipbook frames: it grows a little, turns
// slowly and dissolves through noise from the thin parts inwards, like a puff burning out. Frame k of
// n is t = k / (n - 1).
export function evolveFrames(base: Rgba, n: number, seed = 1): Rgba[] {
  const size = base.width
  const noise = valueNoise(seed + 7)
  const out: Rgba[] = []
  for (let k = 0; k < n; k++) {
    const t = n > 1 ? k / (n - 1) : 0
    const scale = 0.82 + 0.3 * t
    const rot = t * 0.35
    const cos = Math.cos(rot)
    const sin = Math.sin(rot)
    const img = blank(size)
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const u = ((x + 0.5) / size) * 2 - 1
        const v = ((y + 0.5) / size) * 2 - 1
        // Inverse transform into the base image.
        const bu = (u * cos + v * sin) / scale
        const bv = (-u * sin + v * cos) / scale
        const bx = Math.floor(((bu + 1) / 2) * size)
        const by = Math.floor(((bv + 1) / 2) * size)
        if (bx < 0 || by < 0 || bx >= size || by >= size) continue
        const si = (by * size + bx) * 4
        const n0 = fbm(noise, u * 3 + 11, v * 3 - 5, 3)
        const a = base.data[si + 3] / 255
        // Dissolve: pixels whose noise (biased by thin alpha) falls under the rising threshold go.
        const keep = smooth(t * 1.05 - 0.12, t * 1.05, n0 * 0.6 + a * 0.4)
        const o = (y * size + x) * 4
        img.data[o] = base.data[si]
        img.data[o + 1] = base.data[si + 1]
        img.data[o + 2] = base.data[si + 2]
        img.data[o + 3] = Math.round(base.data[si + 3] * (t === 0 ? 1 : keep) * (1 - 0.35 * t))
      }
    }
    out.push(img)
  }
  return out
}
