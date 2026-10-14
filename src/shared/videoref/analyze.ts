// Pure analysis of a video reference: decoded RGBA frames (small, evenly sampled, see the renderer's
// pages/videoref/decode.ts) -> motion energy from frame differences, brightness spikes (flash /
// impact frames), beat peaks, the anticipation / release / impact / dissipate segmentation, a
// dominant palette per beat, a glow (bloom) estimate, the screen-space size and direction of the
// motion, holds versus fast motion (Animation Lab) and the key frames for the contact sheet and the
// vision model. No pose estimation here: the vision model describes poses from the key frames.
// Deterministic, no DOM, no electron (tested in test/videoref.test.ts).

import type { PaletteColor, RefBeatLabel, RefBeatPeak, RefCrop, RefDirection, RefFrameStat, RefGlow, RefKeyFrame, RefMotion, RefSegment, RefTimelineSpan, RgbaFrame, VideoRefAnalysis } from './types.ts'
import { REF_BEATS } from './types.ts'

// Frames are measured on a grid of at most this many pixels on the long side.
export const ANALYSIS_SIDE = 96
// |luma difference| below this is sensor / compression noise.
const NOISE = 0.06
const r3 = (x: number) => Math.round(x * 1000) / 1000
const r2 = (x: number) => Math.round(x * 100) / 100

export interface Grid {
  w: number
  h: number
  luma: Float32Array
  r: Float32Array
  g: Float32Array
  b: Float32Array
}

// Box-filtered downscale to at most `side` pixels on the long side; channels 0..1.
export function toGrid(frame: RgbaFrame, side = ANALYSIS_SIDE): Grid {
  const scale = Math.max(1, Math.max(frame.width, frame.height) / side)
  const w = Math.max(1, Math.round(frame.width / scale))
  const h = Math.max(1, Math.round(frame.height / scale))
  const n = w * h
  const r = new Float32Array(n)
  const g = new Float32Array(n)
  const b = new Float32Array(n)
  const count = new Float32Array(n)
  const d = frame.data
  for (let y = 0; y < frame.height; y++) {
    const ty = Math.min(h - 1, Math.floor((y * h) / frame.height))
    for (let x = 0; x < frame.width; x++) {
      const tx = Math.min(w - 1, Math.floor((x * w) / frame.width))
      const i = (y * frame.width + x) * 4
      const ti = ty * w + tx
      r[ti] += d[i]
      g[ti] += d[i + 1]
      b[ti] += d[i + 2]
      count[ti]++
    }
  }
  const luma = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const c = count[i] * 255 || 1
    r[i] /= c
    g[i] /= c
    b[i] /= c
    luma[i] = 0.2126 * r[i] + 0.7152 * g[i] + 0.0722 * b[i]
  }
  return { w, h, luma, r, g, b }
}

// ------------------------------------------------------------------ per frame

export interface FrameMeasure {
  stat: RefFrameStat
  // Centroid of the change (normalised, y down) and its bounding box; null when nothing moved.
  centroid: { x: number; y: number } | null
  bbox: RefCrop | null
}

export function measureFrames(frames: RgbaFrame[], grids: Grid[] = frames.map((f) => toGrid(f))): FrameMeasure[] {
  const out: FrameMeasure[] = []
  for (let f = 0; f < grids.length; f++) {
    const g = grids[f]
    const n = g.luma.length
    let sum = 0
    let bright = 0
    for (let i = 0; i < n; i++) {
      sum += g.luma[i]
      if (g.luma[i] > 0.8) bright++
    }
    let motion = 0
    let active = 0
    let cx = 0
    let cy = 0
    let wsum = 0
    let x0 = Infinity
    let y0 = Infinity
    let x1 = -Infinity
    let y1 = -Infinity
    const prev = f > 0 && grids[f - 1].luma.length === n ? grids[f - 1] : null
    if (prev) {
      for (let i = 0; i < n; i++) {
        const d = Math.abs(g.luma[i] - prev.luma[i])
        motion += d
        if (d > NOISE) {
          active++
          const x = i % g.w
          const y = (i - x) / g.w
          cx += x * d
          cy += y * d
          wsum += d
          if (x < x0) x0 = x
          if (y < y0) y0 = y
          if (x > x1) x1 = x
          if (y > y1) y1 = y
        }
      }
    }
    const has = wsum > 0 && active >= 2
    out.push({
      stat: { t: r3(frames[f]?.t ?? 0), motion: r3(motion / n), brightness: r3(sum / n), bright: r3(bright / n), active: r3(active / n) },
      centroid: has ? { x: (cx / wsum + 0.5) / g.w, y: (cy / wsum + 0.5) / g.h } : null,
      bbox: has ? { x: x0 / g.w, y: y0 / g.h, w: (x1 - x0 + 1) / g.w, h: (y1 - y0 + 1) / g.h } : null
    })
  }
  return out
}

// ------------------------------------------------------------------ series helpers

export function smooth3(v: number[]): number[] {
  return v.map((x, i) => {
    const a = v[i - 1] ?? x
    const c = v[i + 1] ?? x
    return (a + 2 * x + c) / 4
  })
}

export function percentile(values: number[], p: number): number {
  if (!values.length) return 0
  const s = [...values].sort((a, b) => a - b)
  const pos = Math.min(s.length - 1, Math.max(0, p * (s.length - 1)))
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

function median(values: number[]): number {
  return percentile(values, 0.5)
}

// The end of the analysed span: the last sample plus one sample interval.
export function spanEnd(times: number[], duration?: number): number {
  if (duration && duration > 0) return duration
  if (!times.length) return 0
  const dt = times.length > 1 ? (times[times.length - 1] - times[0]) / (times.length - 1) : 0.04
  return times[times.length - 1] + dt
}

// ------------------------------------------------------------------ beats

// Peaks of the (lightly smoothed) motion energy: local maxima above both the mean + half a standard
// deviation and a quarter of the strongest, at least minGap seconds apart (stronger ones win).
export function detectPeaks(times: number[], energy: number[], opts: { minGap?: number } = {}): RefBeatPeak[] {
  const s = smooth3(energy)
  const max = Math.max(0, ...s)
  if (max < 1e-4) return []
  const mean = s.reduce((a, b) => a + b, 0) / s.length
  const std = Math.sqrt(s.reduce((a, b) => a + (b - mean) ** 2, 0) / s.length)
  const thr = Math.max(mean + 0.5 * std, 0.25 * max)
  const cands: { i: number; v: number }[] = []
  for (let i = 0; i < s.length; i++) {
    const left = i === 0 ? -Infinity : s[i - 1]
    const right = i === s.length - 1 ? -Infinity : s[i + 1]
    if (s[i] >= left && s[i] > right && s[i] >= thr) cands.push({ i, v: s[i] })
  }
  const gap = opts.minGap ?? 0.12
  const kept: { i: number; v: number }[] = []
  for (const c of cands.sort((a, b) => b.v - a.v)) if (kept.every((k) => Math.abs(times[k.i] - times[c.i]) >= gap)) kept.push(c)
  return kept.sort((a, b) => a.i - b.i).map((k) => ({ t: r3(times[k.i]), strength: r2(k.v / max) }))
}

// Brightness spikes: a frame clearly brighter than the frames around it (flash / impact frames).
// Consecutive spike frames count once (the brightest).
export function detectFlashes(times: number[], brightness: number[]): number[] {
  const flagged: number[] = []
  for (let i = 0; i < brightness.length; i++) {
    const around: number[] = []
    for (let j = Math.max(0, i - 4); j <= Math.min(brightness.length - 1, i + 4); j++) if (Math.abs(j - i) > 1) around.push(brightness[j])
    if (!around.length) continue
    const base = median(around)
    const spike = brightness[i] - base
    if (spike > 0.08 && brightness[i] > base * 1.3) flagged.push(i)
  }
  const out: number[] = []
  for (let k = 0; k < flagged.length; k++) {
    let best = flagged[k]
    while (k + 1 < flagged.length && flagged[k + 1] === flagged[k] + 1) {
      k++
      if (brightness[flagged[k]] > brightness[best]) best = flagged[k]
    }
    out.push(r3(times[best]))
  }
  return out
}

// ------------------------------------------------------------------ segmentation

export interface RawSegment {
  label: RefBeatLabel
  from: number
  to: number
}

// Splits the clip around its strongest moment (the brightest flash when there is one, else the
// motion peak): anticipation = the build-up before the energy rises, release = the fast rise into
// the peak, impact = the peak while it stays above half its energy (or flashes), dissipate = the
// rest. Indices are frame ranges [from, to). Empty beats are dropped.
export function segmentIndices(energy: number[], brightness: number[], flashIdx: number[] = []): RawSegment[] {
  const n = energy.length
  if (!n) return []
  const s = smooth3(energy)
  const peakE = Math.max(...s)
  if (n < 3 || peakE < 1e-4) return [{ label: 'impact', from: 0, to: n }]
  const flashes = new Set(flashIdx)
  let impact = 0
  if (flashIdx.length) {
    impact = flashIdx.reduce((a, b) => (brightness[b] > brightness[a] ? b : a), flashIdx[0])
  } else {
    for (let i = 1; i < n; i++) if (s[i] > s[impact]) impact = i
  }
  const hi = Math.max(s[impact], 0.35 * peakE)
  let rel = impact
  while (rel > 0 && s[rel - 1] >= 0.35 * hi) rel--
  if (rel === impact && impact > 0) rel = impact - 1
  let end = impact + 1
  while (end < n && (s[end] >= 0.5 * hi || flashes.has(end))) end++
  const raw: RawSegment[] = [
    { label: 'anticipation', from: 0, to: rel },
    { label: 'release', from: rel, to: impact },
    { label: 'impact', from: impact, to: end },
    { label: 'dissipate', from: end, to: n }
  ]
  return raw.filter((r) => r.to > r.from)
}

// ------------------------------------------------------------------ palette

const hex2 = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0')
export const toHex = (r: number, g: number, b: number) => `#${hex2(r)}${hex2(g)}${hex2(b)}`
export function fromHex(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim())
  if (!m) return [0, 0, 0]
  const v = parseInt(m[1], 16)
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
}

// Dominant colours (weighted k-means, deterministic). Near-black background pixels are left out
// unless the whole clip is dark; saturated and bright pixels weigh more (they are the effect).
export function extractPalette(grids: Grid[], k = 5, maxSamples = 6000): PaletteColor[] {
  const total = grids.reduce((a, g) => a + g.luma.length, 0)
  if (!total) return []
  const stride = Math.max(1, Math.floor(total / maxSamples))
  const pts: { c: [number, number, number]; w: number; l: number }[] = []
  const dark: { c: [number, number, number]; w: number; l: number }[] = []
  let idx = 0
  for (const g of grids) {
    for (let i = 0; i < g.luma.length; i++, idx++) {
      if (idx % stride) continue
      const c: [number, number, number] = [g.r[i], g.g[i], g.b[i]]
      const sat = Math.max(...c) - Math.min(...c)
      const p = { c, w: 0.35 + sat + 0.5 * Math.max(0, g.luma[i] - 0.5), l: g.luma[i] }
      if (g.luma[i] < 0.07) dark.push(p)
      else pts.push(p)
    }
  }
  const use = pts.length >= 8 ? pts : [...pts, ...dark]
  if (!use.length) return []
  const sorted = [...use].sort((a, b) => a.l - b.l)
  const kk = Math.max(1, Math.min(k, use.length))
  let centers = Array.from({ length: kk }, (_, i) => [...sorted[Math.min(sorted.length - 1, Math.floor(((i + 0.5) / kk) * sorted.length))].c] as [number, number, number])
  const assign = new Int32Array(use.length)
  for (let it = 0; it < 10; it++) {
    const acc = centers.map(() => [0, 0, 0, 0])
    for (let p = 0; p < use.length; p++) {
      let best = 0
      let bd = Infinity
      for (let c = 0; c < centers.length; c++) {
        const d = (use[p].c[0] - centers[c][0]) ** 2 + (use[p].c[1] - centers[c][1]) ** 2 + (use[p].c[2] - centers[c][2]) ** 2
        if (d < bd) {
          bd = d
          best = c
        }
      }
      assign[p] = best
      const a = acc[best]
      a[0] += use[p].c[0] * use[p].w
      a[1] += use[p].c[1] * use[p].w
      a[2] += use[p].c[2] * use[p].w
      a[3] += use[p].w
    }
    centers = centers.map((c, i) => (acc[i][3] > 0 ? [acc[i][0] / acc[i][3], acc[i][1] / acc[i][3], acc[i][2] / acc[i][3]] : c))
  }
  const weight = centers.map(() => 0)
  let wsum = 0
  for (let p = 0; p < use.length; p++) {
    weight[assign[p]] += use[p].w
    wsum += use[p].w
  }
  // Merge centres that ended up nearly the same colour.
  const merged: { c: [number, number, number]; w: number }[] = []
  centers.forEach((c, i) => {
    if (!weight[i]) return
    const near = merged.find((m) => Math.hypot(m.c[0] - c[0], m.c[1] - c[1], m.c[2] - c[2]) < 0.06)
    if (near) near.w += weight[i]
    else merged.push({ c, w: weight[i] })
  })
  return merged
    .sort((a, b) => b.w - a.w)
    .map((m) => ({ hex: toHex(...m.c), share: r2(m.w / (wsum || 1)) }))
    .filter((m) => m.share >= 0.02)
}

// ------------------------------------------------------------------ glow

// Bloom around the brightest parts: of the pixels near a near-white core, the share that is lit
// (a soft halo) instead of dark (a hard edge). Returns null when the frame has no core.
export function frameBloom(g: Grid): { bloom: number; core: number } | null {
  const { w, h, luma } = g
  const n = w * h
  const core = new Uint8Array(n)
  let cores = 0
  for (let i = 0; i < n; i++) if (luma[i] > 0.82) (core[i] = 1), cores++
  if (!cores) return null
  const rad = Math.max(2, Math.round(Math.min(w, h) * 0.06))
  // Integral image of the core mask: "is there a core pixel within rad" in O(1).
  const I = new Int32Array((w + 1) * (h + 1))
  for (let y = 0; y < h; y++) {
    let row = 0
    for (let x = 0; x < w; x++) {
      row += core[y * w + x]
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1] + row
    }
  }
  let ring = 0
  let lit = 0
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      if (core[i]) continue
      const xa = Math.max(0, x - rad)
      const ya = Math.max(0, y - rad)
      const xb = Math.min(w, x + rad + 1)
      const yb = Math.min(h, y + rad + 1)
      const s = I[yb * (w + 1) + xb] - I[ya * (w + 1) + xb] - I[yb * (w + 1) + xa] + I[ya * (w + 1) + xa]
      if (!s) continue
      ring++
      if (luma[i] > 0.3) lit++
    }
  }
  return { bloom: ring ? lit / ring : 0, core: cores / n }
}

export function glowEstimate(grids: Grid[], stats: RefFrameStat[]): RefGlow {
  let wsum = 0
  let acc = 0
  for (const g of grids) {
    const b = frameBloom(g)
    if (!b) continue
    acc += b.bloom * b.core
    wsum += b.core
  }
  const peakBright = Math.max(0, ...stats.map((s) => s.bright))
  const bloom = wsum ? r2(acc / wsum) : 0
  const level: RefGlow['level'] = peakBright < 0.002 || bloom < 0.18 ? 'none' : bloom < 0.45 ? 'soft' : 'strong'
  return { bloom, peakBright: r3(peakBright), level }
}

// ------------------------------------------------------------------ motion

export function motionSummary(measures: FrameMeasure[], aspect = 16 / 9): RefMotion {
  const pts = measures.map((m, i) => ({ m, i })).filter((x) => x.m.centroid && x.m.stat.active > 0.002)
  if (!pts.length) return { direction: 'still', angle: null, peakCoverage: 0, meanCoverage: 0, bbox: null, travel: 0 }
  const area = (b: RefCrop | null) => (b ? b.w * b.h : 0)
  const third = Math.max(1, Math.floor(pts.length / 3))
  const avg = (xs: typeof pts) => {
    let x = 0
    let y = 0
    let w = 0
    let a = 0
    for (const p of xs) {
      const e = p.m.stat.motion || 1e-6
      x += p.m.centroid!.x * e
      y += p.m.centroid!.y * e
      a += area(p.m.bbox) * e
      w += e
    }
    return { x: x / w, y: y / w, a: a / w }
  }
  const early = avg(pts.slice(0, third))
  const late = avg(pts.slice(-third))
  const peak = pts.reduce((a, b) => (b.m.stat.motion > a.m.stat.motion ? b : a), pts[0])
  // Normalised coordinates -> screen proportions (x scaled by the aspect ratio).
  const dx = (late.x - early.x) * aspect
  const dy = early.y - late.y
  const travel = Math.hypot(dx, dy) / Math.hypot(aspect, 1)
  let direction: RefDirection = 'still'
  let angle: number | null = null
  if (travel > 0.06) {
    angle = Math.round((Math.atan2(dy, dx) * 180) / Math.PI)
    const a = ((angle % 360) + 360) % 360
    direction = a < 45 || a >= 315 ? 'right' : a < 135 ? 'up' : a < 225 ? 'left' : 'down'
  } else if (pts.length >= 3) {
    const grow = (late.a + 1e-4) / (early.a + 1e-4)
    direction = grow > 1.6 ? 'outward' : grow < 0.6 ? 'inward' : 'still'
  }
  return {
    direction,
    angle,
    peakCoverage: r2(area(peak.m.bbox)),
    meanCoverage: r2(pts.reduce((a, p) => a + area(p.m.bbox), 0) / pts.length),
    bbox: peak.m.bbox ? { x: r3(peak.m.bbox.x), y: r3(peak.m.bbox.y), w: r3(peak.m.bbox.w), h: r3(peak.m.bbox.h) } : null,
    travel: r2(travel)
  }
}

// ------------------------------------------------------------------ Animation Lab timeline

// Holds (the body barely moves) versus fast motion, from the raw energy relative to its 90th
// percentile. Holds shorter than minHold seconds are absorbed into their neighbours.
export function motionTimeline(times: number[], energy: number[], duration?: number, opts: { minHold?: number } = {}): RefTimelineSpan[] {
  const end = spanEnd(times, duration)
  if (!times.length) return []
  const ref = percentile(energy, 0.9)
  if (ref < 1e-4) return [{ kind: 'hold', start: 0, end: r3(end) }]
  const kind = (e: number): RefTimelineSpan['kind'] => (e < 0.2 * ref || e < 0.003 ? 'hold' : e > 0.6 * ref ? 'fast' : 'move')
  let spans: RefTimelineSpan[] = []
  for (let i = 0; i < times.length; i++) {
    // Frame i's energy is the change since frame i - 1: it describes (t[i-1], t[i]].
    const start = i === 0 ? 0 : times[i - 1]
    const stop = i === times.length - 1 ? end : times[i]
    if (stop <= start) continue
    const k = kind(i === 0 ? (energy[1] ?? energy[0]) : energy[i])
    const last = spans[spans.length - 1]
    if (last && last.kind === k) last.end = stop
    else spans.push({ kind: k, start, end: stop })
  }
  const minHold = opts.minHold ?? 0.06
  for (let pass = 0; pass < 2; pass++) {
    const out: RefTimelineSpan[] = []
    for (const s of spans) {
      const last = out[out.length - 1]
      if (last && (s.kind === last.kind || (s.kind === 'hold' && s.end - s.start < minHold && pass === 0))) last.end = s.end
      else out.push({ ...s })
    }
    spans = out
  }
  return spans.map((s) => ({ kind: s.kind, start: r3(s.start), end: r3(s.end) }))
}

// ------------------------------------------------------------------ key frames + contact sheet

// One key frame per beat: late in the anticipation (the wind-up is built), the peak of the release
// and of the impact, early in the dissipate. Plus flash frames when there is room (max `max`).
export function keyFrameIndices(segments: RawSegment[], energy: number[], flashIdx: number[] = [], max = 5): { index: number; label: string }[] {
  const out: { index: number; label: string }[] = []
  for (const s of segments) {
    let i: number
    if (s.label === 'anticipation') i = s.from + Math.floor((s.to - s.from) * 0.7)
    else if (s.label === 'dissipate') i = s.from + Math.floor((s.to - s.from) * 0.4)
    else {
      i = s.from
      for (let j = s.from; j < s.to; j++) if (energy[j] > energy[i]) i = j
    }
    i = Math.max(s.from, Math.min(s.to - 1, i))
    if (!out.some((o) => o.index === i)) out.push({ index: i, label: s.label })
  }
  for (const f of flashIdx) if (out.length < max && !out.some((o) => Math.abs(o.index - f) <= 1)) out.push({ index: f, label: 'flash' })
  return out.sort((a, b) => a.index - b.index).slice(0, max)
}

// Frame indices for the contact sheet: evenly spaced, with every key frame swapped in.
export function sheetIndices(n: number, keys: number[] = [], max = 12): number[] {
  if (n <= 0) return []
  const count = Math.min(n, max)
  const picked = Array.from({ length: count }, (_, i) => Math.round((i * (n - 1)) / Math.max(1, count - 1)))
  for (const k of keys) {
    if (k < 0 || k >= n || picked.includes(k)) continue
    let best = 0
    for (let i = 1; i < picked.length; i++) if (Math.abs(picked[i] - k) < Math.abs(picked[best] - k) && !keys.includes(picked[i])) best = i
    if (!keys.includes(picked[best])) picked[best] = k
  }
  return [...new Set(picked)].sort((a, b) => a - b)
}

export interface SheetLayout {
  cols: number
  rows: number
  cellW: number
  cellH: number
  labelH: number
  gap: number
  width: number
  height: number
}

export function sheetLayout(count: number, frameW: number, frameH: number, maxWidth = 1152): SheetLayout {
  const cols = Math.max(1, Math.min(4, count))
  const rows = Math.max(1, Math.ceil(count / cols))
  const gap = 4
  const cellW = Math.max(16, Math.min(frameW, Math.floor((maxWidth - gap * (cols + 1)) / cols)))
  const cellH = Math.max(9, Math.round((cellW * frameH) / Math.max(1, frameW)))
  const labelH = 16
  return { cols, rows, cellW, cellH, labelH, gap, width: cols * cellW + gap * (cols + 1), height: rows * (cellH + labelH) + gap * (rows + 1) }
}

// ------------------------------------------------------------------ whole clip

export interface AnalyzeOptions {
  duration?: number
  width?: number
  height?: number
}

export function analyzeFrames(frames: RgbaFrame[], opts: AnalyzeOptions = {}): VideoRefAnalysis {
  const grids = frames.map((f) => toGrid(f))
  const measures = measureFrames(frames, grids)
  const stats = measures.map((m) => m.stat)
  const times = stats.map((s) => s.t)
  const energy = stats.map((s) => s.motion)
  const brightness = stats.map((s) => s.brightness)
  const duration = r3(spanEnd(times, opts.duration))
  const flashes = detectFlashes(times, brightness)
  const flashIdx = flashes.map((t) => times.indexOf(t)).filter((i) => i >= 0)
  const raw = segmentIndices(energy, brightness, flashIdx)
  const peakE = Math.max(1e-6, ...smooth3(energy))
  const tAt = (i: number) => (i < times.length ? times[i] : duration)
  const segments: RefSegment[] = raw.map((s) => {
    let pk = s.from
    let sum = 0
    for (let j = s.from; j < s.to; j++) {
      if (energy[j] > energy[pk]) pk = j
      sum += energy[j]
    }
    return {
      label: s.label,
      start: r3(tAt(s.from)),
      end: r3(tAt(s.to)),
      peak: r3(times[pk] ?? 0),
      energy: r2(Math.min(1, sum / Math.max(1, s.to - s.from) / peakE)),
      palette: extractPalette(grids.slice(s.from, s.to), 4, 2500)
    }
  })
  const keys = keyFrameIndices(raw, energy, flashIdx)
  const keyFrames: RefKeyFrame[] = keys.map((k) => ({ t: r3(times[k.index] ?? 0), label: k.label, index: k.index }))
  const w = opts.width ?? frames[0]?.width ?? 0
  const h = opts.height ?? frames[0]?.height ?? 0
  const fps = times.length > 1 ? r2((times.length - 1) / Math.max(1e-6, times[times.length - 1] - times[0])) : 0
  return {
    version: 1,
    duration,
    fps,
    width: w,
    height: h,
    frames: stats,
    peaks: detectPeaks(times, energy),
    flashes,
    segments,
    palette: extractPalette(grids, 6),
    glow: glowEstimate(grids, stats),
    motion: motionSummary(measures, w && h ? w / h : 16 / 9),
    timeline: motionTimeline(times, energy, duration),
    keyFrames
  }
}

// ------------------------------------------------------------------ derived numbers

// Seconds per beat (0 for a beat the clip does not have).
export function beatSeconds(a: Pick<VideoRefAnalysis, 'segments'>): Record<RefBeatLabel, number> {
  const out = { anticipation: 0, release: 0, impact: 0, dissipate: 0 } as Record<RefBeatLabel, number>
  for (const s of a.segments) out[s.label] += Math.max(0, s.end - s.start)
  for (const k of REF_BEATS) out[k] = r3(out[k])
  return out
}

// Share of the clip per beat (sums to 1 when there are segments).
export function beatFractions(a: Pick<VideoRefAnalysis, 'segments'>): Record<RefBeatLabel, number> {
  const s = beatSeconds(a)
  const total = REF_BEATS.reduce((x, k) => x + s[k], 0) || 1
  return Object.fromEntries(REF_BEATS.map((k) => [k, r3(s[k] / total)])) as Record<RefBeatLabel, number>
}

// The Animation Lab reading: anticipation, action (release + impact), recovery (dissipate), holds.
export function animPhases(a: Pick<VideoRefAnalysis, 'segments' | 'timeline'>): { anticipation: number; action: number; recovery: number; holds: number } {
  const s = beatSeconds(a)
  const holds = a.timeline.filter((x) => x.kind === 'hold').reduce((acc, x) => acc + (x.end - x.start), 0)
  return { anticipation: s.anticipation, action: r3(s.release + s.impact), recovery: s.dissipate, holds: r3(holds) }
}

// A stage label of a scripted effect -> the reference beat it corresponds to.
export function stageBeat(label: string): RefBeatLabel | null {
  const l = label.toLowerCase()
  if (/antic|charge|wind|build|gather|channel|prep|ready/.test(l)) return 'anticipation'
  if (/release|fire|launch|travel|merge|throw|cast|swing|slash|dash|beam|shoot/.test(l)) return 'release'
  if (/impact|hit|explo|burst|slam|detonat|strike|crash|peak/.test(l)) return 'impact'
  if (/dissip|fade|linger|after|decay|smoke|settle|end|outro/.test(l)) return 'dissipate'
  return null
}

// Fractions per beat of a scripted effect, from its stages (unknown labels take the next beat in order).
export function stageFractions(stages: { at: number; label: string }[], duration: number): Record<RefBeatLabel, number> | null {
  const st = [...stages].sort((a, b) => a.at - b.at)
  if (!st.length || duration <= 0) return null
  const out = { anticipation: 0, release: 0, impact: 0, dissipate: 0 } as Record<RefBeatLabel, number>
  let order = 0
  st.forEach((s, i) => {
    const end = i + 1 < st.length ? st[i + 1].at : duration
    const b = stageBeat(s.label) ?? REF_BEATS[Math.min(3, order)]
    order = Math.max(order, REF_BEATS.indexOf(b) + 1)
    out[b] += Math.max(0, end - s.at)
  })
  const first = st[0].at
  if (first > 0) out.anticipation += first
  const total = REF_BEATS.reduce((x, k) => x + out[k], 0) || 1
  return Object.fromEntries(REF_BEATS.map((k) => [k, r3(out[k] / total)])) as Record<RefBeatLabel, number>
}

// 0..10: how close two beat-fraction vectors are (L1 distance 0 -> 10, 1.2 or more -> 0).
export function timingMatch(ref: Record<string, number>, res: Record<string, number>): number {
  const keys = new Set([...Object.keys(ref), ...Object.keys(res)])
  let d = 0
  for (const k of keys) d += Math.abs((ref[k] ?? 0) - (res[k] ?? 0))
  return r2(Math.max(0, Math.min(10, 10 * (1 - d / 1.2))))
}

// "Redmean" colour distance, normalised to 0..1.
export function colorDistance(a: string, b: string): number {
  const [r1, g1, b1] = fromHex(a).map((x) => x * 255)
  const [r2_, g2, b2] = fromHex(b).map((x) => x * 255)
  const rm = (r1 + r2_) / 2
  const d = Math.sqrt((2 + rm / 256) * (r1 - r2_) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2)
  return Math.min(1, d / 765)
}

// 0..10: how well the result's colours cover the reference palette (share-weighted nearest colour).
export function paletteMatch(ref: PaletteColor[], result: string[]): number {
  if (!ref.length || !result.length) return 5
  let acc = 0
  let w = 0
  for (const c of ref) {
    const d = Math.min(...result.map((x) => colorDistance(c.hex, x)))
    acc += d * c.share
    w += c.share
  }
  const avg = acc / (w || 1)
  return r2(Math.max(0, Math.min(10, 10 * (1 - avg / 0.45))))
}

// Text for one palette: "#ff8800 40%, #ffffff 25%".
export function paletteText(p: PaletteColor[]): string {
  return p.map((c) => `${c.hex} ${Math.round(c.share * 100)}%`).join(', ')
}
