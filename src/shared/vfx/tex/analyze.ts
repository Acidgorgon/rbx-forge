// Image analysis for imported VFX textures (pure code: main, renderer, tests). From the pixels alone:
// what kind of texture it is (glow, ring, spark, smoke, noise, beam strip ...), its dominant colour,
// soft or hard edges and how much of the image is visible, so an imported pack gets useful kinds and
// tags without anyone typing them. Works on a small copy (64 px), so a folder of 1024 px sheets is
// quick. Opaque images (JPGs on black) are read by brightness, like alphaCleanup does.

import { alphaCleanup, isOpaque, resample, type Rgba } from './image.ts'
import type { TextureAnalysisSummary, TextureKind } from './textures.ts'

export interface TextureAnalysis extends TextureAnalysisSummary {
  // Saturation of the mean colour (0 grey .. 1 vivid).
  saturation: number
  // Visible pixels that are partly transparent (0 = hard cut-out .. 1 = all soft).
  softness: number
  // Share of the 1-pixel border with visible alpha (tiling textures touch all edges).
  edgeCoverage: number
  // Principal-axis ratio of the visible mass (1 = round, >3 = a streak).
  elongation: number
  // Radial profile around the centre (10 annuli, mean alpha 0..1) and its shape.
  radial: number[]
  ring: boolean
  ringWidth: number
  // Angular variation at mid radius (coefficient of variation) and the number of bright lobes.
  angularCv: number
  lobes: number
  // Mean absolute neighbour difference of the alpha (0..1): high for noise and lumpy smoke.
  roughness: number
  // Horizontal strip that reaches the left and right edges (a Beam / Trail texture).
  strip: 'beam' | 'trail' | null
  // The visible mass sits off the middle of its bounding box (crescents).
  offCentre: number
  kind: TextureKind
}

const WORK = 64

function hex(r: number, g: number, b: number): string {
  return `#${[r, g, b].map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`
}

// A name for a colour: white / grey / black for unsaturated ones, else the hue bucket.
export function colorName(r: number, g: number, b: number): string {
  const max = Math.max(r, g, b)
  const min = Math.min(r, g, b)
  const sat = max > 0 ? (max - min) / max : 0
  if (sat < 0.2 || max < 40) return max > 200 ? 'white' : max > 70 ? 'grey' : 'black'
  let h: number
  if (max === r) h = ((g - b) / (max - min)) * 60
  else if (max === g) h = (2 + (b - r) / (max - min)) * 60
  else h = (4 + (r - g) / (max - min)) * 60
  if (h < 0) h += 360
  if (h < 15 || h >= 340) return 'red'
  if (h < 40) return 'orange'
  if (h < 68) return 'yellow'
  if (h < 160) return 'green'
  if (h < 200) return 'cyan'
  if (h < 255) return 'blue'
  if (h < 295) return 'purple'
  return 'pink'
}

// The image as the analysis sees it: at most WORK px on its long side, alpha from brightness when
// the image is opaque.
export function workingCopy(img: Rgba, max = WORK): Rgba {
  const k = Math.min(1, max / Math.max(img.width, img.height))
  const small = k < 1 ? resample(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))) : img
  return isOpaque(small) ? alphaCleanup(small, { threshold: 6 }) : small
}

export function analyzeTexture(src: Rgba): TextureAnalysis {
  const img = workingCopy(src)
  const { width: w, height: h, data: d } = img
  const A = (x: number, y: number) => d[(y * w + x) * 4 + 3] / 255
  let vis = 0
  let soft = 0
  let sr = 0
  let sg = 0
  let sb = 0
  let sa = 0
  let mx = 0
  let my = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const a = d[i + 3]
      if (a > 16) {
        vis++
        if (a < 200) soft++
      }
      sr += d[i] * a
      sg += d[i + 1] * a
      sb += d[i + 2] * a
      sa += a
      mx += a * (x + 0.5)
      my += a * (y + 0.5)
    }
  }
  const n = w * h
  const coverage = vis / n
  const [cr, cg, cb] = sa > 0 ? [sr / sa, sg / sa, sb / sa] : [255, 255, 255]
  const cmax = Math.max(cr, cg, cb)
  const saturation = cmax > 0 ? (cmax - Math.min(cr, cg, cb)) / cmax : 0
  const softness = vis ? soft / vis : 0
  // Centroid and second moments (principal axes).
  const cx = sa ? mx / sa : w / 2
  const cy = sa ? my / sa : h / 2
  let sxx = 0
  let syy = 0
  let sxy = 0
  let bx0 = w
  let by0 = h
  let bx1 = -1
  let by1 = -1
  let rough = 0
  let roughN = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const a = A(x, y)
      const dx = x + 0.5 - cx
      const dy = y + 0.5 - cy
      sxx += a * dx * dx
      syy += a * dy * dy
      sxy += a * dx * dy
      if (a > 16 / 255) {
        if (x < bx0) bx0 = x
        if (x > bx1) bx1 = x
        if (y < by0) by0 = y
        if (y > by1) by1 = y
      }
      if (x + 1 < w) {
        rough += Math.abs(a - A(x + 1, y))
        roughN++
      }
      if (y + 1 < h) {
        rough += Math.abs(a - A(x, y + 1))
        roughN++
      }
    }
  }
  const tr = sxx + syy
  const det = sxx * syy - sxy * sxy
  const disc = Math.sqrt(Math.max(0, (tr * tr) / 4 - det))
  const l1 = tr / 2 + disc
  const l2 = Math.max(1e-9, tr / 2 - disc)
  const elongation = sa ? Math.sqrt(l1 / l2) : 1
  const roughness = roughN ? rough / roughN : 0
  // Edges.
  let edgeVis = 0
  let edgeN = 0
  const sideCov = (pts: [number, number][]) => pts.filter(([x, y]) => A(x, y) > 16 / 255).length / Math.max(1, pts.length)
  const left: [number, number][] = []
  const right: [number, number][] = []
  const top: [number, number][] = []
  const bottom: [number, number][] = []
  for (let y = 0; y < h; y++) (left.push([0, y]), right.push([w - 1, y]))
  for (let x = 0; x < w; x++) (top.push([x, 0]), bottom.push([x, h - 1]))
  for (const p of [...left, ...right, ...top, ...bottom]) {
    edgeN++
    if (A(p[0], p[1]) > 16 / 255) edgeVis++
  }
  const edgeCoverage = edgeVis / Math.max(1, edgeN)
  // Radial profile around the image centre.
  const R = Math.min(w, h) / 2
  const ann = new Array(10).fill(0)
  const annN = new Array(10).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const r = Math.hypot(x + 0.5 - w / 2, y + 0.5 - h / 2) / R
      if (r >= 1) continue
      const k = Math.min(9, Math.floor(r * 10))
      ann[k] += A(x, y)
      annN[k]++
    }
  }
  const radial = ann.map((v, i) => (annN[i] ? Math.round((v / annN[i]) * 1000) / 1000 : 0))
  const peak = radial.indexOf(Math.max(...radial))
  const peakV = radial[peak]
  const inner = (radial[0] + radial[1]) / 2
  const ring = peakV > 0.12 && peak >= 3 && inner < peakV * 0.35
  const ringWidth = ring ? radial.filter((v) => v >= peakV * 0.5).length : 0
  // Angular profile at mid radius (0.2 .. 0.6 of R).
  const BINS = 72
  const ang = new Array(BINS).fill(0)
  const angN = new Array(BINS).fill(0)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const dx = x + 0.5 - w / 2
      const dy = y + 0.5 - h / 2
      const r = Math.hypot(dx, dy) / R
      if (r < 0.2 || r > 0.6) continue
      const k = Math.min(BINS - 1, Math.floor(((Math.atan2(dy, dx) + Math.PI) / (2 * Math.PI)) * BINS))
      ang[k] += A(x, y)
      angN[k]++
    }
  }
  const angM = ang.map((v, i) => (angN[i] ? v / angN[i] : 0))
  const mean = angM.reduce((s, v) => s + v, 0) / BINS
  const sd = Math.sqrt(angM.reduce((s, v) => s + (v - mean) ** 2, 0) / BINS)
  const angularCv = mean > 1e-3 ? sd / mean : 0
  let lobes = 0
  if (angularCv > 0.3) {
    const hi = mean + sd * 0.5
    for (let i = 0; i < BINS; i++) if (angM[i] > hi && angM[(i + BINS - 1) % BINS] <= hi) lobes++
  }
  // Strips (Beam / Trail textures run along U, left to right).
  let strip: TextureAnalysis['strip'] = null
  if ((sideCov(left) > 0.12 || sideCov(right) > 0.12) && bx1 - bx0 + 1 >= w * 0.85 && w >= h * 0.9) {
    const third = (x0: number, x1: number) => {
      let s = 0
      for (let y = 0; y < h; y++) for (let x = x0; x < x1; x++) s += A(x, y)
      return s
    }
    const l = third(0, Math.floor(w / 3))
    const r = third(Math.ceil((2 * w) / 3), w)
    const across = sideCov(top) < 0.3 && sideCov(bottom) < 0.3
    if (across || coverage < 0.75) strip = Math.max(l, r) > Math.min(l, r) * 2.2 + 1e-6 ? 'trail' : 'beam'
  }
  const offCentre = bx1 >= 0 ? Math.hypot(cx - (bx0 + bx1 + 1) / 2, cy - (by0 + by1 + 1) / 2) / Math.max(1, Math.max(bx1 - bx0 + 1, by1 - by0 + 1)) : 0
  const base = { coverage: Math.round(coverage * 1000) / 1000, saturation: Math.round(saturation * 1000) / 1000, softness: Math.round(softness * 1000) / 1000, edgeCoverage: Math.round(edgeCoverage * 1000) / 1000, elongation: Math.round(elongation * 100) / 100, radial, ring, ringWidth, angularCv: Math.round(angularCv * 1000) / 1000, lobes, roughness: Math.round(roughness * 1000) / 1000, strip, offCentre: Math.round(offCentre * 1000) / 1000 }
  const a: TextureAnalysis = {
    ...base,
    color: hex(cr, cg, cb),
    colorName: colorName(cr, cg, cb),
    edge: softness > 0.45 ? 'soft' : 'hard',
    kind: 'other'
  }
  a.kind = kindFromAnalysis(a)
  return a
}

// The kind from the numbers (first rule that matches).
export function kindFromAnalysis(a: Omit<TextureAnalysis, 'kind'>): TextureKind {
  if (a.coverage < 0.002) return 'other'
  if (a.coverage > 0.6 && a.edgeCoverage > 0.6 && !a.strip) return 'noise'
  if (a.strip) return a.strip
  if (a.ring) return a.ringWidth >= 3 || a.angularCv > 0.35 ? 'shockwave' : 'ring'
  if (a.elongation > 3.2) return 'spark'
  if (a.elongation > 1.5 && a.offCentre > 0.12) return 'slash'
  if (a.angularCv > 0.55 && a.radial[0] > 0.3) return a.lobes > 0 && a.lobes <= 6 ? 'star' : 'flare'
  const monotonic = a.radial.every((v, i) => i === 0 || v <= a.radial[i - 1] + 0.04)
  if (a.edge === 'soft' && monotonic && a.angularCv < 0.2) return 'glow'
  if (a.edge === 'soft' && a.coverage > 0.08) return 'smoke'
  if (a.coverage < 0.05) return 'spark'
  return a.edge === 'soft' ? 'glow' : 'other'
}

// Tags for the library (kind, colour, edge, coverage, flipbook).
export function autoTags(a: TextureAnalysisSummary & { kind?: TextureKind }, opts: { flipbook?: boolean; extra?: string[] } = {}): string[] {
  const cov = a.coverage < 0.12 ? 'sparse' : a.coverage > 0.5 ? 'dense' : null
  return [...new Set([a.kind, a.colorName, a.edge, cov, opts.flipbook ? 'flipbook' : null, ...(opts.extra ?? [])].filter((t): t is string => !!t && t !== 'other').map((t) => t.toLowerCase()))].slice(0, 12)
}

export function summary(a: TextureAnalysis): TextureAnalysisSummary {
  return { color: a.color, colorName: a.colorName, edge: a.edge, coverage: a.coverage }
}
