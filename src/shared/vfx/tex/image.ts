// Pixel operations for VFX textures (pure code, no DOM / node imports): alpha cleanup of generated
// images, centring, a radial falloff, square power-of-two resampling, tint modes (white / greyscale
// so ParticleEmitter.Color can tint the texture), the premultiplied preview on black, flipbook grid
// assembly and stats / hashes for tests.
//
// Roblox facts used here (creator-docs, read 2026-10-13):
//  - "Roblox supports up to 1024×1024 pixel spaces for texture maps"
//    (content/en-us/art/modeling/texture-specifications.md, "Maximum Texture Resolution").
//  - ParticleEmitter.FlipbookIncompatible: "The flipbook texture size must be an exact multiple of the
//    flipbook layout size." (reference/engine/classes/ParticleEmitter.yaml)
//  - Particle emitters guide (effects/particle-emitters.md, Flipbooks): "include spacing between each
//    of the particle frames. In some cases, mip filtering might require even more spacing."
//  - Texture: "Textures with transparent backgrounds work best for particles"; a texture is influenced
//    by Color (it multiplies the image), so a white / greyscale image takes any colour.

export interface Rgba {
  width: number
  height: number
  // RGBA8, row-major, straight (not premultiplied) alpha.
  data: Uint8ClampedArray
}

export type TintMode = 'white' | 'grey' | 'color'

export const MAX_TEXTURE_SIZE = 1024
export const MIN_TEXTURE_SIZE = 32

export function blank(width: number, height = width): Rgba {
  return { width, height, data: new Uint8ClampedArray(width * height * 4) }
}

export function clone(img: Rgba): Rgba {
  return { width: img.width, height: img.height, data: new Uint8ClampedArray(img.data) }
}

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b > a ? b - a : 1e-9)))
  return t * t * (3 - 2 * t)
}

export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0
}

// The power of two nearest to n (ties go up), clamped to 32..1024.
export function nearestPow2(n: number): number {
  let p = MIN_TEXTURE_SIZE
  while (p < MAX_TEXTURE_SIZE && p * 1.5 <= n) p *= 2
  return p
}

// ------------------------------------------------------------------ alpha

// True when the image has no real transparency (alpha above 250 almost everywhere).
export function isOpaque(img: Rgba): boolean {
  const d = img.data
  let opaque = 0
  const n = img.width * img.height
  for (let i = 3; i < d.length; i += 4) if (d[i] > 250) opaque++
  return opaque / n > 0.98
}

// Average colour of the 1-pixel border (the background of an opaque image).
export function borderColor(img: Rgba): [number, number, number] {
  const { width: w, height: h, data: d } = img
  const s = [0, 0, 0]
  let n = 0
  const add = (x: number, y: number) => {
    const i = (y * w + x) * 4
    s[0] += d[i]
    s[1] += d[i + 1]
    s[2] += d[i + 2]
    n++
  }
  for (let x = 0; x < w; x++) (add(x, 0), add(x, h - 1))
  for (let y = 1; y < h - 1; y++) (add(0, y), add(w - 1, y))
  return [s[0] / n, s[1] / n, s[2] / n]
}

export interface CleanupOptions {
  // Alpha at or below this (0..255) becomes fully transparent (kills haze and stray noise).
  threshold?: number
}

// Makes a generated image a clean particle sprite:
//  1. an opaque image (the model ignored "transparent background") gets alpha from its distance to
//     the border colour; on a dark background that is the brightness, and colour is un-premultiplied;
//  2. faint alpha (<= threshold) is cut to 0 and the rest re-stretched so the edge stays soft;
//  3. fully transparent pixels take the average visible colour, so bilinear filtering and mipmaps do
//     not pull a dark (or white) fringe into the edges.
export function alphaCleanup(src: Rgba, opts: CleanupOptions = {}): Rgba {
  const img = clone(src)
  const d = img.data
  const threshold = Math.max(0, Math.min(250, opts.threshold ?? 10))
  if (isOpaque(img)) {
    const bg = borderColor(img)
    const dark = (bg[0] + bg[1] + bg[2]) / 3 < 128
    for (let i = 0; i < d.length; i += 4) {
      let a: number
      if (dark) {
        // Additive-looking art on black: alpha = brightness above the background.
        a = Math.max(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2], 0) / Math.max(1, 255 - Math.min(bg[0], bg[1], bg[2]))
        if (a > 0) for (let c = 0; c < 3; c++) d[i + c] = Math.min(255, Math.max(0, (d[i + c] - bg[c] * (1 - a)) / a))
      } else {
        const dist = Math.hypot(d[i] - bg[0], d[i + 1] - bg[1], d[i + 2] - bg[2]) / 441.7
        a = Math.min(1, dist * 2.2)
      }
      d[i + 3] = Math.round(a * 255)
    }
  }
  let sr = 0
  let sg = 0
  let sb = 0
  let sw = 0
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3]
    const na = a <= threshold ? 0 : Math.round(((a - threshold) / (255 - threshold)) * 255)
    d[i + 3] = na
    if (na > 0) {
      sr += d[i] * na
      sg += d[i + 1] * na
      sb += d[i + 2] * na
      sw += na
    }
  }
  const avg = sw ? [sr / sw, sg / sw, sb / sw] : [255, 255, 255]
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] === 0) {
      d[i] = avg[0]
      d[i + 1] = avg[1]
      d[i + 2] = avg[2]
    }
  }
  return img
}

// Bounding box of the visible pixels (alpha > threshold), or null when empty.
export function contentBox(img: Rgba, threshold = 8): { x0: number; y0: number; x1: number; y1: number } | null {
  const { width: w, height: h, data: d } = img
  let x0 = w
  let y0 = h
  let x1 = -1
  let y1 = -1
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (d[(y * w + x) * 4 + 3] > threshold) {
        if (x < x0) x0 = x
        if (x > x1) x1 = x
        if (y < y0) y0 = y
        if (y > y1) y1 = y
      }
    }
  }
  return x1 < 0 ? null : { x0, y0, x1, y1 }
}

// Crops a square around the visible content, centred, with `pad` (fraction of the side) of empty
// border, so the sprite sits in the middle of the particle quad.
export function centerOnContent(img: Rgba, pad = 0.08): Rgba {
  const box = contentBox(img)
  if (!box) return clone(img)
  const cw = box.x1 - box.x0 + 1
  const ch = box.y1 - box.y0 + 1
  const side = Math.max(2, Math.ceil(Math.max(cw, ch) / (1 - 2 * pad)))
  const cx = (box.x0 + box.x1 + 1) / 2
  const cy = (box.y0 + box.y1 + 1) / 2
  const out = blank(side)
  const ox = Math.round(cx - side / 2)
  const oy = Math.round(cy - side / 2)
  for (let y = 0; y < side; y++) {
    const sy = oy + y
    if (sy < 0 || sy >= img.height) continue
    for (let x = 0; x < side; x++) {
      const sx = ox + x
      if (sx < 0 || sx >= img.width) continue
      const si = (sy * img.width + sx) * 4
      const di = (y * side + x) * 4
      for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c]
    }
  }
  // Transparent padding takes the content's average colour (no dark fringe).
  return alphaCleanup(out, { threshold: 0 })
}

// Fades alpha to 0 towards the edge of the inscribed circle: 1 inside `inner` (fraction of the
// half-side), 0 at the edge, smooth in between. No hard square edge can show on a particle.
export function radialFalloff(img: Rgba, inner = 0.72): Rgba {
  const out = clone(img)
  const { width: w, height: h } = out
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const u = ((x + 0.5) / w) * 2 - 1
      const v = ((y + 0.5) / h) * 2 - 1
      // Reaches zero a pixel inside the edge, so even the border pixels are empty.
      const k = 1 - smooth(inner, 1 - 2 / Math.min(w, h), Math.hypot(u, v))
      const i = (y * w + x) * 4 + 3
      out.data[i] = Math.round(out.data[i] * k)
    }
  }
  return out
}

// ------------------------------------------------------------------ resampling

// Area-weighted resample (box filter over each target pixel's footprint, bilinear-like when
// upscaling), in premultiplied space so transparent pixels do not darken the edges.
export function resample(img: Rgba, width: number, height = width): Rgba {
  if (img.width === width && img.height === height) return clone(img)
  const out = blank(width, height)
  const sx = img.width / width
  const sy = img.height / height
  const sd = img.data
  for (let y = 0; y < height; y++) {
    const fy0 = y * sy
    const fy1 = fy0 + Math.max(sy, 1)
    for (let x = 0; x < width; x++) {
      const fx0 = x * sx
      const fx1 = fx0 + Math.max(sx, 1)
      let r = 0
      let g = 0
      let b = 0
      let a = 0
      let wsum = 0
      // Upscaling: sample a 1-source-pixel footprint centred on the target pixel.
      const ax0 = sx < 1 ? fx0 + sx / 2 - 0.5 : fx0
      const ay0 = sy < 1 ? fy0 + sy / 2 - 0.5 : fy0
      const ax1 = sx < 1 ? ax0 + 1 : fx1
      const ay1 = sy < 1 ? ay0 + 1 : fy1
      for (let py = Math.floor(ay0); py < Math.ceil(ay1); py++) {
        const wy = Math.min(ay1, py + 1) - Math.max(ay0, py)
        if (wy <= 0) continue
        const cy = Math.min(img.height - 1, Math.max(0, py))
        for (let px = Math.floor(ax0); px < Math.ceil(ax1); px++) {
          const wx = Math.min(ax1, px + 1) - Math.max(ax0, px)
          if (wx <= 0) continue
          const cx = Math.min(img.width - 1, Math.max(0, px))
          const i = (cy * img.width + cx) * 4
          const wgt = wx * wy
          const al = sd[i + 3] / 255
          r += sd[i] * al * wgt
          g += sd[i + 1] * al * wgt
          b += sd[i + 2] * al * wgt
          a += al * wgt
          wsum += wgt
        }
      }
      const o = (y * width + x) * 4
      if (a > 1e-6) {
        out.data[o] = r / a
        out.data[o + 1] = g / a
        out.data[o + 2] = b / a
      } else {
        out.data[o] = 255
        out.data[o + 1] = 255
        out.data[o + 2] = 255
      }
      out.data[o + 3] = Math.round((a / (wsum || 1)) * 255)
    }
  }
  return out
}

// Square, power of two, at most 1024 (Roblox's texture maximum).
export function toPow2Square(img: Rgba, size?: number): Rgba {
  const target = size && isPow2(size) ? Math.min(MAX_TEXTURE_SIZE, Math.max(MIN_TEXTURE_SIZE, size)) : nearestPow2(Math.max(img.width, img.height))
  return resample(img, target, target)
}

// ------------------------------------------------------------------ tint modes

const lum = (r: number, g: number, b: number) => 0.2126 * r + 0.7152 * g + 0.0722 * b

// white: every pixel white, brightness moves into alpha (ParticleEmitter.Color gives the whole
//   colour, like Roblox's own sparkles texture);
// grey: greyscale with the original alpha (Color tints it, darker areas stay darker: depth for smoke);
// color: unchanged (Color multiplies it, keep Color white to see the original).
export function applyTint(img: Rgba, mode: TintMode): Rgba {
  if (mode === 'color') return clone(img)
  const out = clone(img)
  const d = out.data
  let max = 1
  for (let i = 0; i < d.length; i += 4) if (d[i + 3] > 0) max = Math.max(max, lum(d[i], d[i + 1], d[i + 2]))
  for (let i = 0; i < d.length; i += 4) {
    const l = lum(d[i], d[i + 1], d[i + 2]) / max
    if (mode === 'white') {
      d[i + 3] = Math.round(d[i + 3] * Math.min(1, l))
      d[i] = d[i + 1] = d[i + 2] = 255
    } else {
      d[i] = d[i + 1] = d[i + 2] = Math.round(Math.min(1, l) * 255)
    }
  }
  return out
}

// What the sprite looks like drawn additively on black (rgb x alpha, opaque): the library thumbnail.
export function premultipliedPreview(img: Rgba, tint?: [number, number, number]): Rgba {
  const out = blank(img.width, img.height)
  const t = tint ?? [1, 1, 1]
  for (let i = 0; i < img.data.length; i += 4) {
    const a = img.data[i + 3] / 255
    out.data[i] = img.data[i] * a * t[0]
    out.data[i + 1] = img.data[i + 1] * a * t[1]
    out.data[i + 2] = img.data[i + 2] * a * t[2]
    out.data[i + 3] = 255
  }
  return out
}

// ------------------------------------------------------------------ flipbooks

export type FlipbookLayout = 'Grid2x2' | 'Grid4x4' | 'Grid8x8'
export const FLIPBOOK_GRID: Record<FlipbookLayout, number> = { Grid2x2: 2, Grid4x4: 4, Grid8x8: 8 }

export function layoutForFrames(frames: number): FlipbookLayout {
  return frames <= 4 ? 'Grid2x2' : frames <= 16 ? 'Grid4x4' : 'Grid8x8'
}

// Places frames row by row into a cols x cols grid of `size` px (an exact multiple of the layout,
// as Roblox requires). Each frame is shrunk to leave `pad` (fraction of a cell) of transparent space
// on every side, so neighbouring frames never bleed in under mip filtering. Missing frames repeat
// the last one so a Loop never shows an empty cell.
export function assembleFlipbook(frames: Rgba[], layout: FlipbookLayout, size = 1024, pad = 0.06): Rgba {
  if (!frames.length) throw new Error('a flipbook needs at least one frame')
  const cols = FLIPBOOK_GRID[layout]
  if (!isPow2(size) || size > MAX_TEXTURE_SIZE || size % cols) throw new Error(`flipbook size must be a power of two up to ${MAX_TEXTURE_SIZE} and a multiple of ${cols}`)
  if (frames.length > cols * cols) throw new Error(`${layout} holds ${cols * cols} frames, got ${frames.length}`)
  const cell = size / cols
  const inner = Math.max(1, Math.round(cell * (1 - 2 * pad)))
  const off = Math.floor((cell - inner) / 2)
  const sheet = blank(size)
  for (let k = 0; k < cols * cols; k++) {
    const f = resample(frames[Math.min(k, frames.length - 1)], inner, inner)
    const cx = (k % cols) * cell + off
    const cy = Math.floor(k / cols) * cell + off
    for (let y = 0; y < inner; y++) {
      for (let x = 0; x < inner; x++) {
        const si = (y * inner + x) * 4
        const di = ((cy + y) * size + cx + x) * 4
        for (let c = 0; c < 4; c++) sheet.data[di + c] = f.data[si + c]
      }
    }
  }
  // Gutters take the visible average colour, like alphaCleanup.
  return alphaCleanup(sheet, { threshold: 0 })
}

// One cell back out of a sheet (tests, previews).
export function flipbookCell(sheet: Rgba, layout: FlipbookLayout, index: number): Rgba {
  const cols = FLIPBOOK_GRID[layout]
  const cell = Math.floor(sheet.width / cols)
  const out = blank(cell)
  const cx = (index % cols) * cell
  const cy = Math.floor(index / cols) * cell
  for (let y = 0; y < cell; y++) for (let x = 0; x < cell; x++) for (let c = 0; c < 4; c++) out.data[(y * cell + x) * 4 + c] = sheet.data[((cy + y) * sheet.width + cx + x) * 4 + c]
  return out
}

// ------------------------------------------------------------------ stats

export interface ImageStats {
  width: number
  height: number
  // Mean alpha 0..1, share of pixels with alpha > 8, alpha-weighted centroid (0..1), and the largest
  // alpha on the 1-pixel border (0 = nothing touches the edge).
  meanAlpha: number
  coverage: number
  centroid: [number, number]
  edgeAlpha: number
  hash: string
}

export function fnv1a(bytes: ArrayLike<number>): string {
  let h = 0x811c9dc5
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i] & 0xff
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function imageStats(img: Rgba): ImageStats {
  const { width: w, height: h, data: d } = img
  let sum = 0
  let cov = 0
  let cx = 0
  let cy = 0
  let edge = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = d[(y * w + x) * 4 + 3]
      sum += a
      if (a > 8) cov++
      cx += a * (x + 0.5)
      cy += a * (y + 0.5)
      if ((x === 0 || y === 0 || x === w - 1 || y === h - 1) && a > edge) edge = a
    }
  }
  const n = w * h
  return {
    width: w,
    height: h,
    meanAlpha: Math.round((sum / n / 255) * 10000) / 10000,
    coverage: Math.round((cov / n) * 10000) / 10000,
    centroid: sum ? [Math.round((cx / sum / w) * 1000) / 1000, Math.round((cy / sum / h) * 1000) / 1000] : [0.5, 0.5],
    edgeAlpha: edge,
    hash: fnv1a(d)
  }
}

// ------------------------------------------------------------------ the whole pipeline

export interface SpriteOptions {
  tint?: TintMode
  // Output side (power of two, <= 1024); default: nearest power of two of the content, max 512.
  size?: number
  threshold?: number
  // Radial falloff start (fraction of the half-side); 1 disables it.
  falloff?: number
  pad?: number
}

// A generated image -> a particle texture: alpha cleanup, centred on its content, a radial falloff
// so no hard edge shows, square power of two, then the tint mode.
export function prepareSprite(src: Rgba, opts: SpriteOptions = {}): Rgba {
  let img = alphaCleanup(src, { threshold: opts.threshold })
  img = centerOnContent(img, opts.pad ?? 0.06)
  if ((opts.falloff ?? 0.78) < 1) img = radialFalloff(img, opts.falloff ?? 0.78)
  img = toPow2Square(img, opts.size ?? Math.min(512, nearestPow2(img.width)))
  return applyTint(img, opts.tint ?? 'white')
}
