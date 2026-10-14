// Code-side image statistics for the Thumbnail Lab (pure: no DOM, node or electron): the 16:9 cover
// crop + resize to 1920x1080 (on top of the VFX texture resampler), palette, saturation, contrast,
// colourfulness, edge density, centre focus, and the small-size report (how the thumbnail reads at
// 256x144 and 160x90 on the discovery page). Tested in test/thumbs.test.ts.
//
// The small-size numbers are proxies, not OCR or face detection: legibility is how crisp the
// strongest edges stay after the downscale (text with an outline keeps hard, high-contrast edges;
// thin or low-contrast lettering blurs into the background), focal contrast is how much one region's
// saliency (luma / colour difference from the frame + edges) stands out over the rest.

import { resample, type Rgba } from '../vfx/tex/image.ts'
import type { SmallSizeReport, ThumbImageStats } from './types.ts'

export const THUMB_W = 1920
export const THUMB_H = 1080
export const SMALL_SIZES = [
  { w: 256, h: 144 },
  { w: 160, h: 90 }
] as const

// Roblox page backgrounds the tile sits on. Approximations of the dark and light site themes (a
// neutral near-black and near-white grey); the measure is a relative "stands out" score, not a
// colour match.
export const PAGE_DARK: [number, number, number] = [25, 27, 31]
export const PAGE_LIGHT: [number, number, number] = [242, 244, 245]

const r2 = (x: number) => Math.round(x * 100) / 100
const r3 = (x: number) => Math.round(x * 1000) / 1000
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const clamp10 = (x: number) => Math.max(0, Math.min(10, x))

// ------------------------------------------------------------------ crop / resize

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

// The largest centred rectangle with the given aspect (w / h) inside srcW x srcH.
export function coverCrop(srcW: number, srcH: number, aspect = THUMB_W / THUMB_H): Rect {
  if (srcW <= 0 || srcH <= 0) return { x: 0, y: 0, width: 0, height: 0 }
  if (srcW / srcH > aspect) {
    const width = Math.max(1, Math.round(srcH * aspect))
    return { x: Math.floor((srcW - width) / 2), y: 0, width, height: srcH }
  }
  const height = Math.max(1, Math.round(srcW / aspect))
  return { x: 0, y: Math.floor((srcH - height) / 2), width: srcW, height }
}

export function cropRgba(img: Rgba, r: Rect): Rgba {
  const x0 = Math.max(0, Math.min(img.width - 1, Math.floor(r.x)))
  const y0 = Math.max(0, Math.min(img.height - 1, Math.floor(r.y)))
  const w = Math.max(1, Math.min(img.width - x0, Math.floor(r.width)))
  const h = Math.max(1, Math.min(img.height - y0, Math.floor(r.height)))
  const out = new Uint8ClampedArray(w * h * 4)
  for (let y = 0; y < h; y++) out.set(img.data.subarray(((y0 + y) * img.width + x0) * 4, ((y0 + y) * img.width + x0 + w) * 4), y * w * 4)
  return { width: w, height: h, data: out }
}

// Opaque copy (thumbnails have no transparency: alpha is flattened onto black).
export function flatten(img: Rgba): Rgba {
  const d = new Uint8ClampedArray(img.data)
  for (let i = 0; i < d.length; i += 4) {
    const a = d[i + 3] / 255
    if (a < 1) {
      d[i] = d[i] * a
      d[i + 1] = d[i + 1] * a
      d[i + 2] = d[i + 2] * a
    }
    d[i + 3] = 255
  }
  return { width: img.width, height: img.height, data: d }
}

// Cover-crop to 16:9 and resize to width x height (default 1920x1080).
export function toThumbnail(img: Rgba, width = THUMB_W, height = THUMB_H): Rgba {
  const r = coverCrop(img.width, img.height, width / height)
  const cropped = r.x === 0 && r.y === 0 && r.width === img.width && r.height === img.height ? img : cropRgba(img, r)
  return flatten(resample(cropped, width, height))
}

// Fit inside maxW x maxH keeping the aspect (references and bases are stored at most 1920 wide).
export function fitWithin(img: Rgba, maxW: number, maxH: number): Rgba {
  const s = Math.min(1, maxW / img.width, maxH / img.height)
  if (s >= 1) return flatten(img)
  return flatten(resample(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s))))
}

// ------------------------------------------------------------------ per-pixel helpers

const luma = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255

function hsv(r: number, g: number, b: number): [number, number] {
  const mx = Math.max(r, g, b)
  const mn = Math.min(r, g, b)
  return [mx ? (mx - mn) / mx : 0, mx / 255]
}

export function toHex(c: [number, number, number]): string {
  return '#' + c.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')
}

export function fromHex(hex: string): [number, number, number] | null {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

const dist = (a: [number, number, number], b: [number, number, number]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function lumaPlane(img: Rgba): Float32Array {
  const out = new Float32Array(img.width * img.height)
  const d = img.data
  for (let i = 0, p = 0; p < out.length; i += 4, p++) out[p] = luma(d[i], d[i + 1], d[i + 2])
  return out
}

// Sobel gradient magnitude, normalised to 0..1 (4 is the largest possible value for 0..1 input).
export function sobel(gray: Float32Array, w: number, h: number): Float32Array {
  const out = new Float32Array(w * h)
  const at = (x: number, y: number) => gray[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))]
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const gx = at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x - 1, y) - at(x - 1, y + 1)
      const gy = at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1) - at(x - 1, y - 1) - 2 * at(x, y - 1) - at(x + 1, y - 1)
      out[y * w + x] = Math.min(1, Math.hypot(gx, gy) / 4)
    }
  }
  return out
}

export const EDGE_STRONG = 0.25

function percentile(values: Float32Array, p: number): number {
  if (!values.length) return 0
  const sorted = Float32Array.from(values).sort()
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))))]
}

// Saliency per pixel: distance from the frame's mean colour, plus edges.
function saliency(img: Rgba, edges: Float32Array): Float32Array {
  const d = img.data
  const n = img.width * img.height
  let mr = 0
  let mg = 0
  let mb = 0
  for (let i = 0; i < d.length; i += 4) {
    mr += d[i]
    mg += d[i + 1]
    mb += d[i + 2]
  }
  const mean: [number, number, number] = [mr / n, mg / n, mb / n]
  const out = new Float32Array(n)
  for (let p = 0, i = 0; p < n; p++, i += 4) out[p] = dist([d[i], d[i + 1], d[i + 2]], mean) / 441.7 + 0.6 * edges[p]
  return out
}

// ------------------------------------------------------------------ palette

// Dominant colours: a 4x4x4 histogram of a small copy, bin means, most common first, skipping
// colours too close to one already picked.
export function palette(img: Rgba, k = 5): { hex: string; share: number }[] {
  const small = img.width * img.height > 96 * 54 ? resample(img, 96, Math.max(1, Math.round((96 * img.height) / img.width))) : img
  const d = small.data
  const bins = new Map<number, { n: number; r: number; g: number; b: number }>()
  let total = 0
  for (let i = 0; i < d.length; i += 4) {
    if (d[i + 3] < 128) continue
    const key = ((d[i] >> 6) << 4) | ((d[i + 1] >> 6) << 2) | (d[i + 2] >> 6)
    const b = bins.get(key) ?? { n: 0, r: 0, g: 0, b: 0 }
    b.n++
    b.r += d[i]
    b.g += d[i + 1]
    b.b += d[i + 2]
    bins.set(key, b)
    total++
  }
  const ranked = [...bins.entries()].map(([key, b]) => ({ key, n: b.n, c: [b.r / b.n, b.g / b.n, b.b / b.n] as [number, number, number] })).sort((a, b) => b.n - a.n || a.key - b.key)
  const out: { c: [number, number, number]; n: number }[] = []
  for (const x of ranked) {
    const near = out.find((o) => dist(o.c, x.c) < 48)
    if (near) {
      near.n += x.n
      continue
    }
    if (out.length < k) out.push({ c: x.c, n: x.n })
  }
  // Edge blends from the downscale are not palette colours: drop anything under 2%.
  return out
    .filter((o) => o.n / (total || 1) >= 0.02)
    .sort((a, b) => b.n - a.n)
    .map((o) => ({ hex: toHex(o.c), share: r3(o.n / (total || 1)) }))
}

// ------------------------------------------------------------------ stats

export function imageStats(img: Rgba): ThumbImageStats {
  const d = img.data
  const n = img.width * img.height
  let sat = 0
  let vivid = 0
  let lsum = 0
  let l2 = 0
  let rgS = 0
  let rgS2 = 0
  let ybS = 0
  let ybS2 = 0
  for (let i = 0; i < d.length; i += 4) {
    const [s, v] = hsv(d[i], d[i + 1], d[i + 2])
    sat += s
    if (s > 0.6 && v > 0.25) vivid++
    const l = luma(d[i], d[i + 1], d[i + 2])
    lsum += l
    l2 += l * l
    const rg = d[i] - d[i + 1]
    const yb = 0.5 * (d[i] + d[i + 1]) - d[i + 2]
    rgS += rg
    rgS2 += rg * rg
    ybS += yb
    ybS2 += yb * yb
  }
  const lm = lsum / n
  const contrast = Math.sqrt(Math.max(0, l2 / n - lm * lm))
  const mrg = rgS / n
  const myb = ybS / n
  const sdrg = Math.sqrt(Math.max(0, rgS2 / n - mrg * mrg))
  const sdyb = Math.sqrt(Math.max(0, ybS2 / n - myb * myb))
  const colorful = Math.hypot(sdrg, sdyb) + 0.3 * Math.hypot(mrg, myb)
  // Edges and focus at a fixed working size so they compare across image sizes.
  const work = img.width === 256 && img.height === 144 ? img : resample(img, 256, 144)
  const edges = sobel(lumaPlane(work), work.width, work.height)
  let strong = 0
  for (const e of edges) if (e > EDGE_STRONG) strong++
  const sal = saliency(work, edges)
  return {
    width: img.width,
    height: img.height,
    palette: palette(img),
    saturation: r3(sat / n),
    vivid: r3(vivid / n),
    luma: r3(lm),
    contrast: r3(contrast),
    colorfulness: r3(clamp01(colorful / 150)),
    edgeDensity: r3(strong / edges.length),
    centerFocus: r2(regionMean(sal, work.width, work.height, 1 / 3, 1 / 3, 2 / 3, 2 / 3) / (mean(sal) || 1))
  }
}

function mean(a: Float32Array): number {
  let s = 0
  for (const v of a) s += v
  return a.length ? s / a.length : 0
}

function regionMean(a: Float32Array, w: number, h: number, fx0: number, fy0: number, fx1: number, fy1: number): number {
  const x0 = Math.floor(w * fx0)
  const x1 = Math.max(x0 + 1, Math.ceil(w * fx1))
  const y0 = Math.floor(h * fy0)
  const y1 = Math.max(y0 + 1, Math.ceil(h * fy1))
  let s = 0
  let c = 0
  for (let y = y0; y < y1 && y < h; y++) for (let x = x0; x < x1 && x < w; x++) (s += a[y * w + x]), c++
  return c ? s / c : 0
}

// ------------------------------------------------------------------ small sizes

// Legibility proxy 0..10: the 95th percentile edge magnitude (the crispest edges: outlined text,
// silhouettes) after the downscale. ~0.1 is mush, ~0.55 is a hard black outline on a bright fill.
export function legibility(img: Rgba): number {
  const edges = sobel(lumaPlane(img), img.width, img.height)
  return r2(clamp10(((percentile(edges, 0.95) - 0.08) / 0.45) * 10))
}

// Focal contrast 0..10 on a 6x4 grid of saliency: how far the strongest cell stands above the median
// cell, damped when another, non-adjacent cell competes with it (two focal points).
export function focalContrast(img: Rgba): { score: number; peak: [number, number]; competing: boolean } {
  const edges = sobel(lumaPlane(img), img.width, img.height)
  const sal = saliency(img, edges)
  const gx = 6
  const gy = 4
  const cells: { x: number; y: number; v: number }[] = []
  for (let y = 0; y < gy; y++) for (let x = 0; x < gx; x++) cells.push({ x, y, v: regionMean(sal, img.width, img.height, x / gx, y / gy, (x + 1) / gx, (y + 1) / gy) })
  const sorted = [...cells].sort((a, b) => b.v - a.v)
  const peak = sorted[0]
  const median = [...cells].sort((a, b) => a.v - b.v)[Math.floor(cells.length / 2)].v
  const rival = sorted.find((c) => Math.abs(c.x - peak.x) > 1 || Math.abs(c.y - peak.y) > 1)
  const dominance = peak.v > 0 ? (peak.v - median) / peak.v : 0
  const competing = !!rival && peak.v > 0 && rival.v / peak.v > 0.9
  return { score: r2(clamp10(dominance * 14 * (competing ? 0.75 : 1))), peak: [peak.x, peak.y], competing }
}

function strongShare(img: Rgba): number {
  const edges = sobel(lumaPlane(img), img.width, img.height)
  let s = 0
  for (const e of edges) if (e > EDGE_STRONG) s++
  return s / (edges.length || 1)
}

// How much the image stands apart from a page background colour (0..1): mean colour distance of the
// frame, its border ring (where the tile meets the page) and its colourfulness.
export function popAgainst(img: Rgba, bg: [number, number, number], colorfulness: number): number {
  const d = img.data
  const w = img.width
  const h = img.height
  let all = 0
  let ring = 0
  let rc = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const k = dist([d[i], d[i + 1], d[i + 2]], bg) / 441.7
      all += k
      if (x < 2 || y < 2 || x >= w - 2 || y >= h - 2) (ring += k), rc++
    }
  }
  return r3(clamp01(0.45 * (all / (w * h)) + 0.25 * (ring / (rc || 1)) + 0.5 * colorfulness))
}

export interface SmallRenders {
  s256: Rgba
  s160: Rgba
  report: SmallSizeReport
}

// Downscales (256x144, 160x90) and the report on them. `stats` saves recomputing colourfulness.
export function smallSizeReport(img: Rgba, stats?: Pick<ThumbImageStats, 'colorfulness'>): SmallRenders {
  const s256 = resample(img, 256, 144)
  const s160 = resample(img, 160, 90)
  const f256 = focalContrast(s256)
  const f160 = focalContrast(s160)
  const e256 = strongShare(s256)
  const e160 = strongShare(s160)
  const edges = sobel(lumaPlane(s256), 256, 144)
  const sal = saliency(s256, edges)
  const bottom = regionMean(sal, 256, 144, 0, 0.85, 1, 1) / (mean(sal) || 1)
  const colorful = stats?.colorfulness ?? imageStats(s256).colorfulness
  return {
    s256,
    s160,
    report: {
      legibility256: legibility(s256),
      legibility160: legibility(s160),
      focal256: f256.score,
      focal160: f160.score,
      detailKept: r3(e256 > 0 ? clamp01(e160 / e256) : 1),
      bottomLoad: r3(clamp01(bottom / 2)),
      popDark: popAgainst(s160, PAGE_DARK, colorful),
      popLight: popAgainst(s160, PAGE_LIGHT, colorful)
    }
  }
}
