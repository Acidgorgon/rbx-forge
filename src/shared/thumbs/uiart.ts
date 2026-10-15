// UI art in the Thumbnail Lab (pure): turning a generated image into a usable Roblox UI asset and
// judging it. Background key-out when the model ignored "transparent", trimming / squaring icons to
// the same padding, the 9-slice SliceCenter of buttons and panels, measured look (outline, corners,
// shading), code checks, the cheap one-call ranking critic for pick-from-N, and the UI style kit
// learned from kept / +1 assets (palette, look, references) that later prompts carry.

import { blank, centerOnContent, contentBox, isOpaque, resample, type Rgba } from '../vfx/tex/image.ts'
import { flatten, fromHex, legibility, palette } from './stats.ts'
import { mergePalettes } from './style.ts'
import { UI_KINDS } from './builder.ts'
import type { UiAsset, UiAssetKind, UiAssetStats, UiCheck, UiCritique, UiKit, UiLook, UiSlice } from './types.ts'

const r2 = (x: number) => Math.round(x * 100) / 100
const r1 = (x: number) => Math.round(x * 10) / 10
const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const clamp10 = (x: number) => Math.max(0, Math.min(10, x))
const luma = (d: Uint8ClampedArray, i: number) => (0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2]) / 255

// UI ids: "ua-<base36 time><4 hex>" batches, "<batch>-<k>" assets.
export const UI_BATCH_RE = /^ua-[a-z0-9]{4,24}$/
export const UI_ID_RE = /^ua-[a-z0-9]{4,24}-\d{1,3}$/

// ------------------------------------------------------------------ background

// Keys out a flat (or drawn checkerboard) background that touches the border: flood fill from the
// edge through pixels close to the background colours, with a soft one-step edge. Returns keyed false
// when the border is not a clean background (a scene: left alone).
export function keyOutBackground(src: Rgba, tol = 40): { img: Rgba; keyed: boolean } {
  if (!isOpaque(src)) return { img: src, keyed: false }
  const { width: w, height: h, data: d } = src
  // Border colours, clustered (a drawn checkerboard has two greys).
  const clusters: { c: [number, number, number]; n: number }[] = []
  let total = 0
  const visit = (x: number, y: number) => {
    const i = (y * w + x) * 4
    const c: [number, number, number] = [d[i], d[i + 1], d[i + 2]]
    total++
    const hit = clusters.find((k) => Math.hypot(k.c[0] - c[0], k.c[1] - c[1], k.c[2] - c[2]) < 30)
    if (hit) {
      hit.c = hit.c.map((v, j) => (v * hit.n + c[j]) / (hit.n + 1)) as [number, number, number]
      hit.n++
    } else clusters.push({ c, n: 1 })
  }
  for (let x = 0; x < w; x += 2) (visit(x, 0), visit(x, h - 1))
  for (let y = 0; y < h; y += 2) (visit(0, y), visit(w - 1, y))
  clusters.sort((a, b) => b.n - a.n)
  const top = clusters[0]
  if (!top) return { img: src, keyed: false }
  const bg = [top]
  const grey = (c: [number, number, number]) => Math.max(...c) - Math.min(...c) < 24
  if (top.n / total < 0.85 && clusters[1] && grey(top.c) && grey(clusters[1].c) && (top.n + clusters[1].n) / total >= 0.9) bg.push(clusters[1])
  if (bg.reduce((s, k) => s + k.n, 0) / total < 0.85) return { img: src, keyed: false }
  const near = (i: number) => Math.min(...bg.map((k) => Math.hypot(d[i] - k.c[0], d[i + 1] - k.c[1], d[i + 2] - k.c[2])))
  const out = new Uint8ClampedArray(d)
  const seen = new Uint8Array(w * h)
  const stack = new Int32Array(w * h)
  let sp = 0
  const push = (p: number) => {
    if (seen[p]) return
    seen[p] = 1
    if (near(p * 4) <= tol) stack[sp++] = p
  }
  for (let x = 0; x < w; x++) (push(x), push((h - 1) * w + x))
  for (let y = 0; y < h; y++) (push(y * w), push(y * w + w - 1))
  let removed = 0
  while (sp > 0) {
    const p = stack[--sp]
    out[p * 4 + 3] = 0
    removed++
    const x = p % w
    const y = (p - x) / w
    if (x > 0) push(p - 1)
    if (x < w - 1) push(p + 1)
    if (y > 0) push(p - w)
    if (y < h - 1) push(p + w)
  }
  // Nothing left, or nothing removed: not a background.
  if (removed === 0 || removed >= w * h * 0.995) return { img: src, keyed: false }
  // Soft edge: visible pixels next to the keyed area that are still close-ish to the background.
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (out[p * 4 + 3] === 0) continue
      const edge = (x > 0 && out[(p - 1) * 4 + 3] === 0) || (x < w - 1 && out[(p + 1) * 4 + 3] === 0) || (y > 0 && out[(p - w) * 4 + 3] === 0) || (y < h - 1 && out[(p + w) * 4 + 3] === 0)
      if (!edge) continue
      const k = clamp01((near(p * 4) - tol) / (tol * 1.5))
      out[p * 4 + 3] = Math.round(255 * Math.max(0.25, k))
    }
  }
  return { img: { width: w, height: h, data: out }, keyed: true }
}

// Crop to the visible content plus `pad` (fraction of the longer side) of transparent margin.
export function trimToContent(img: Rgba, pad = 0.02): Rgba {
  const box = contentBox(img, 8)
  if (!box) return img
  const m = Math.round(Math.max(box.x1 - box.x0 + 1, box.y1 - box.y0 + 1) * pad)
  const x0 = box.x0 - m
  const y0 = box.y0 - m
  const w = box.x1 - box.x0 + 1 + 2 * m
  const h = box.y1 - box.y0 + 1 + 2 * m
  const out = blank(w, h)
  for (let y = 0; y < h; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= img.height) continue
    for (let x = 0; x < w; x++) {
      const sx = x0 + x
      if (sx < 0 || sx >= img.width) continue
      const si = (sy * img.width + sx) * 4
      out.data.set(img.data.subarray(si, si + 4), (y * w + x) * 4)
    }
  }
  return out
}

// How much of the canvas the content spans (longest side of its box over the canvas side).
export function contentFill(img: Rgba): number {
  const box = contentBox(img, 8)
  if (!box) return 0
  return r2(Math.max((box.x1 - box.x0 + 1) / img.width, (box.y1 - box.y0 + 1) / img.height))
}

export function fitAlpha(img: Rgba, max: number): Rgba {
  const s = Math.min(1, max / img.width, max / img.height)
  return s >= 1 ? img : resample(img, Math.max(1, Math.round(img.width * s)), Math.max(1, Math.round(img.height * s)))
}

// Icons: square, centred on the content with the same padding, at `size` (default 512).
export function squareIcon(img: Rgba, size = 512, pad = 0.06): Rgba {
  return resample(centerOnContent(img, pad), size)
}

// ------------------------------------------------------------------ 9-slice

// Corner radius from the alpha mask: how far along the diagonal from a corner of the content box the
// first visible pixel is (a rounded rectangle of radius r starts at r (1 - 1/sqrt2)).
function cornerRadius(img: Rgba, box: { x0: number; y0: number; x1: number; y1: number }, sx: 1 | -1, sy: 1 | -1): number {
  const ox = sx > 0 ? box.x0 : box.x1
  const oy = sy > 0 ? box.y0 : box.y1
  const lim = Math.min(box.x1 - box.x0, box.y1 - box.y0) / 2
  for (let k = 0; k < lim; k++) {
    const x = ox + sx * k
    const y = oy + sy * k
    if (img.data[(y * img.width + x) * 4 + 3] > 128) return k / (1 - Math.SQRT1_2)
  }
  return lim
}

// From the centre outward along a line: where the smooth fill ends (a sharp step in colour or
// alpha). Returns the distance from that edge of the image.
function fillInset(img: Rgba, cx: number, cy: number, dx: number, dy: number): number {
  const { width: w, height: h, data: d } = img
  let x = cx
  let y = cy
  const at = (xx: number, yy: number) => (yy * w + xx) * 4
  let avg = [d[at(x, y)], d[at(x, y) + 1], d[at(x, y) + 2]]
  for (;;) {
    const nx = x + dx
    const ny = y + dy
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) break
    const i = at(nx, ny)
    if (d[i + 3] < 200) break
    const step = Math.abs(d[i] - avg[0]) + Math.abs(d[i + 1] - avg[1]) + Math.abs(d[i + 2] - avg[2])
    if (step > 48) break
    avg = avg.map((v, j) => v * 0.6 + d[i + j] * 0.4)
    x = nx
    y = ny
  }
  return dx > 0 ? w - 1 - x : dx < 0 ? x : dy > 0 ? h - 1 - y : y
}

// Roblox SliceCenter for a trimmed button / panel: the stretchable centre is inside the border, the
// bevel and the corner radius on every side. Null when there is no plain centre to stretch.
export function sliceCenter(img: Rgba): UiSlice | null {
  const { width: w, height: h } = img
  if (w < 16 || h < 16) return null
  const box = contentBox(img, 128)
  if (!box) return null
  const cx = Math.round((box.x0 + box.x1) / 2)
  const cy = Math.round((box.y0 + box.y1) / 2)
  if (img.data[(cy * w + cx) * 4 + 3] < 200) return null
  // A few lines either side of the centre, the largest inset wins (a highlight streak or a header
  // strip on one line must not make the centre too big).
  const offs = [-0.15, 0, 0.15]
  const left = Math.max(...offs.map((o) => fillInset(img, cx, Math.round(cy + o * (box.y1 - box.y0)), -1, 0)))
  const right = Math.max(...offs.map((o) => fillInset(img, cx, Math.round(cy + o * (box.y1 - box.y0)), 1, 0)))
  const top = Math.max(...offs.map((o) => fillInset(img, Math.round(cx + o * (box.x1 - box.x0)), cy, 0, -1)))
  const bottom = Math.max(...offs.map((o) => fillInset(img, Math.round(cx + o * (box.x1 - box.x0)), cy, 0, 1)))
  const rTL = cornerRadius(img, box, 1, 1)
  const rTR = cornerRadius(img, box, -1, 1)
  const rBL = cornerRadius(img, box, 1, -1)
  const rBR = cornerRadius(img, box, -1, -1)
  const x0 = Math.ceil(Math.max(left, box.x0 + Math.max(rTL, rBL))) + 2
  const x1 = Math.floor(Math.min(w - right, box.x1 + 1 - Math.max(rTR, rBR))) - 2
  const y0 = Math.ceil(Math.max(top, box.y0 + Math.max(rTL, rTR))) + 2
  const y1 = Math.floor(Math.min(h - bottom, box.y1 + 1 - Math.max(rBL, rBR))) - 2
  if (x1 - x0 < Math.max(4, w * 0.08) || y1 - y0 < Math.max(4, h * 0.08)) return null
  return { x0, y0, x1, y1 }
}

export function scaleSlice(s: UiSlice, from: { width: number; height: number }, to: { width: number; height: number }): UiSlice {
  const kx = to.width / from.width
  const ky = to.height / from.height
  return { x0: Math.round(s.x0 * kx), y0: Math.round(s.y0 * ky), x1: Math.round(s.x1 * kx), y1: Math.round(s.y1 * ky) }
}

// ------------------------------------------------------------------ measured look

// Distance (in px, capped) from each visible pixel to the nearest transparent one, by two passes.
function insideDistance(img: Rgba, cap = 12): Uint8Array {
  const { width: w, height: h, data: d } = img
  const out = new Uint8Array(w * h)
  for (let p = 0; p < w * h; p++) out[p] = d[p * 4 + 3] > 128 ? cap : 0
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = y * w + x
      if (!out[p]) continue
      const a = x > 0 ? out[p - 1] : 0
      const b = y > 0 ? out[p - w] : 0
      out[p] = Math.min(out[p], a + 1, b + 1)
    }
  for (let y = h - 1; y >= 0; y--)
    for (let x = w - 1; x >= 0; x--) {
      const p = y * w + x
      if (!out[p]) continue
      const a = x < w - 1 ? out[p + 1] : 0
      const b = y < h - 1 ? out[p + w] : 0
      out[p] = Math.min(out[p], a + 1, b + 1)
    }
  return out
}

export function uiAssetStats(img: Rgba): UiAssetStats {
  const small = img.width > 256 || img.height > 256 ? resample(img, Math.max(1, Math.round(img.width * Math.min(1, 256 / img.width, 256 / img.height))), Math.max(1, Math.round(img.height * Math.min(1, 256 / img.width, 256 / img.height)))) : img
  const { width: w, height: h, data: d } = small
  const dist = insideDistance(small)
  let visible = 0
  let rim = 0
  let rimN = 0
  const interior: { y: number; l: number }[] = []
  for (let p = 0; p < w * h; p++) {
    if (d[p * 4 + 3] <= 128) continue
    visible++
    const l = luma(d, p * 4)
    if (dist[p] <= 2) (rim += l), rimN++
    else if (dist[p] >= 5) interior.push({ y: Math.floor(p / w), l })
  }
  const inMean = interior.length ? interior.reduce((s, x) => s + x.l, 0) / interior.length : 0
  const rimMean = rimN ? rim / rimN : inMean
  const sd = interior.length ? Math.sqrt(interior.reduce((s, x) => s + (x.l - inMean) ** 2, 0) / interior.length) : 0
  const box = contentBox(small, 128)
  let topLit = false
  if (box && interior.length > 20) {
    const third = (box.y1 - box.y0) / 3
    const top = interior.filter((x) => x.y < box.y0 + third)
    const bot = interior.filter((x) => x.y > box.y1 - third)
    const m = (xs: { l: number }[]) => (xs.length ? xs.reduce((s, x) => s + x.l, 0) / xs.length : 0)
    topLit = top.length > 5 && bot.length > 5 && m(top) > m(bot) + 0.04
  }
  const opaque = visible / (w * h) > 0.98
  const corner = box && !opaque ? Math.min(0.5, cornerRadius(small, box, 1, 1) / Math.max(1, Math.min(box.x1 - box.x0, box.y1 - box.y0))) : 0
  return {
    width: img.width,
    height: img.height,
    coverage: r2(visible / (w * h)),
    palette: palette(small, 5),
    outline: opaque || !interior.length ? 'none' : rimMean < inMean - 0.12 ? 'dark' : rimMean > inMean + 0.12 ? 'light' : 'none',
    corner: r2(corner),
    flatness: r2(clamp01(1 - sd / 0.22)),
    topLit
  }
}

export function measuredLook(s: UiAssetStats): UiLook {
  return {
    stroke: s.outline === 'dark' ? 'thick dark outline' : s.outline === 'light' ? 'light rim or bevel edge' : 'no outline, clean edges',
    corners: s.corner >= 0.3 ? 'pill-shaped, very rounded corners' : s.corner >= 0.1 ? 'rounded corners' : 'sharp or slightly rounded corners',
    shading: s.topLit ? 'top-lit gradient with a glossy highlight' : s.flatness > 0.8 ? 'flat fills' : 'soft gradient shading',
    typography: ''
  }
}

// ------------------------------------------------------------------ code checks

// Real on-screen size per kind (for the small-size legibility check).
const SMALL: Record<UiAssetKind, [number, number]> = { button: [150, 56], panel: [200, 150], icon: [48, 48], 'icon-set': [48, 48], hud: [640, 360] }

export function paletteDistance(a: { hex: string; share: number }[], kit: string[]): number | null {
  const ks = kit.map(fromHex).filter((c): c is [number, number, number] => !!c)
  const as = a.map((p) => ({ c: fromHex(p.hex), w: p.share })).filter((p): p is { c: [number, number, number]; w: number } => !!p.c)
  if (!ks.length || !as.length) return null
  const tw = as.reduce((s, p) => s + p.w, 0) || 1
  return as.reduce((s, p) => s + p.w * Math.min(...ks.map((k) => Math.hypot(k[0] - p.c[0], k[1] - p.c[1], k[2] - p.c[2]))), 0) / tw
}

export interface UiCheckInput {
  kind: UiAssetKind
  img: Rgba
  stats: UiAssetStats
  // The image came back with real transparency / was keyed in code / stayed opaque.
  background: 'transparent' | 'keyed' | 'opaque'
  // Content span of the raw canvas (icons).
  fill: number
  slice?: UiSlice | null
  kitPalette?: string[]
}

export function uiChecks(i: UiCheckInput): UiCheck[] {
  const out: UiCheck[] = []
  if (UI_KINDS[i.kind].transparent) {
    const s = i.background === 'transparent' ? 10 : i.background === 'keyed' ? 8 : 2
    out.push({
      id: 'ui-bg',
      label: 'transparent',
      score: s,
      note: i.background === 'transparent' ? 'came back with a transparent background' : i.background === 'keyed' ? 'the flat background was keyed out in code' : 'opaque background that could not be removed',
      ...(s < 6 ? { fix: 'Ask for a transparent background with nothing behind the asset' } : {})
    })
  }
  const [sw, sh] = SMALL[i.kind]
  const k = Math.min(sw / i.img.width, sh / i.img.height)
  const small = resample(i.img, Math.max(8, Math.round(i.img.width * k)), Math.max(8, Math.round(i.img.height * k)))
  // On a mid-grey: the asset sits on unknown game backgrounds.
  const grey = blank(small.width, small.height)
  for (let p = 0; p < small.width * small.height; p++) {
    const a = small.data[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) grey.data[p * 4 + c] = small.data[p * 4 + c] * a + 110 * (1 - a)
    grey.data[p * 4 + 3] = 255
  }
  const leg = r1(clamp10(legibility(flatten(grey)) * 1.1))
  out.push({ id: 'ui-small', label: 'reads small', score: leg, note: `legibility ${leg.toFixed(1)} at ${sw}x${sh}`, ...(leg < 6 ? { fix: 'Thicker outline, fewer details, stronger contrast between fill and outline' } : {}) })
  if (i.kind === 'icon' || i.kind === 'icon-set') {
    const f = i.fill
    const s = f >= 0.55 && f <= 0.97 ? 10 : f < 0.55 ? r1(clamp10(f / 0.055)) : 7
    out.push({ id: 'ui-fill', label: 'fills the tile', score: s, note: `content spans ${Math.round(f * 100)}% of the canvas`, ...(s < 7 ? { fix: 'Make the object bigger: about 80% of the canvas' } : {}) })
  }
  if (i.kind === 'button' || i.kind === 'panel') {
    const sl = i.slice
    const cw = sl ? (sl.x1 - sl.x0) / i.img.width : 0
    const ch = sl ? (sl.y1 - sl.y0) / i.img.height : 0
    const s = !sl ? 3 : cw >= 0.2 && ch >= 0.2 ? 10 : 7
    out.push({
      id: 'ui-slice',
      label: '9-slice',
      score: s,
      note: sl ? `SliceCenter ${sl.x0},${sl.y0} → ${sl.x1},${sl.y1} (centre ${Math.round(cw * 100)}% × ${Math.round(ch * 100)}%)` : 'no plain centre found to stretch',
      ...(s < 7 ? { fix: 'Uniform border, ornaments only in the corners and a plain centre so it can 9-slice' } : {})
    })
  }
  if (i.kitPalette && i.kitPalette.length >= 2) {
    const dist = paletteDistance(i.stats.palette, i.kitPalette)
    if (dist != null) {
      const s = r1(clamp10(10 - ((dist - 40) / 140) * 10))
      out.push({ id: 'ui-kit', label: 'matches kit', score: s, note: `colour distance to the kit palette ${Math.round(dist)}`, ...(s < 6 ? { fix: `Use the kit colours: ${i.kitPalette.slice(0, 5).join(' ')}` } : {}) })
    }
  }
  return out
}

export function checksOverall(checks: UiCheck[]): number {
  return checks.length ? r1(checks.reduce((s, c) => s + c.score, 0) / checks.length) : 5
}

export function codeCritique(checks: UiCheck[], at: number): UiCritique {
  const overall = checksOverall(checks)
  const low = checks.filter((c) => c.score < 7)
  const sc = (id: string) => checks.find((c) => c.id === id)?.score
  return {
    at,
    overall,
    summary: low.length ? `Measured: ${low.map((c) => `${c.label} ${c.score.toFixed(0)}`).join(', ')}.` : 'Measured: transparent, reads small, stretches cleanly.',
    scores: { brief: 5, readability: sc('ui-small') ?? 5, consistency: sc('ui-kit') ?? sc('ui-fill') ?? 5, clean: sc('ui-bg') ?? sc('ui-slice') ?? 5 },
    changes: low.map((c) => c.fix).filter((x): x is string => !!x),
    by: 'code'
  }
}

// ------------------------------------------------------------------ ranking critic

export const UI_RANK_SYSTEM = [
  'You are a Roblox game UI art director picking the best of several generated UI assets for a brief.',
  'Each candidate is shown on a mid-grey background (its real background is transparent unless it is a HUD mockup).',
  'Judge: fits the brief, reads at real phone size, consistent with the style kit and the other icons in its set, clean edges and a shape that stretches (9-slice) for buttons and panels.',
  'Answer with JSON only.'
].join('\n')

export function uiRankPrompt(i: { brief: string; kind: UiAssetKind; count: number; kit?: string[]; measured: string[] }): string {
  return [
    `Brief: ${i.brief}`,
    `Asset: ${UI_KINDS[i.kind].label} (${UI_KINDS[i.kind].does}).`,
    i.kit?.length ? `Style kit: ${i.kit.join('; ')}` : '',
    `Measured in code, per candidate: ${i.measured.map((m, k) => `#${k + 1} ${m}`).join(' | ')}`,
    `${i.count} candidate${i.count === 1 ? '' : 's'} follow, in order.`,
    `JSON: {"candidates": [{"index": 1, "overall": 0-10, "brief": 0-10, "readability": 0-10, "consistency": 0-10, "clean": 0-10, "summary": "<one line>", "changes": ["<most important first>", ...up to 3], "look": {"stroke": "<e.g. thick dark outline>", "corners": "<e.g. very rounded>", "shading": "<e.g. top-lit glossy gradient>", "typography": "<lettering feel, or empty>"}}, ...]}`
  ]
    .filter(Boolean)
    .join('\n\n')
}

export interface UiRankEntry {
  overall: number
  scores: UiCritique['scores']
  summary: string
  changes: string[]
  look?: UiLook
}

const n10 = (v: unknown, d = 5) => (Number.isFinite(Number(v)) ? r1(clamp10(Number(v))) : d)
const str = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '')

// Per candidate (index 0-based), or null for a candidate the critic skipped; null overall when the
// answer has no JSON.
export function parseUiRanking(raw: string, count: number): (UiRankEntry | null)[] | null {
  const t = String(raw ?? '').replace(/```(?:json)?/g, '')
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  let j: { candidates?: unknown }
  try {
    j = JSON.parse(t.slice(s, e + 1)) as { candidates?: unknown }
  } catch {
    return null
  }
  const list = Array.isArray(j.candidates) ? j.candidates : count === 1 ? [j] : []
  const out: (UiRankEntry | null)[] = Array.from({ length: count }, () => null)
  list.forEach((c, k) => {
    if (!c || typeof c !== 'object') return
    const r = c as Record<string, unknown>
    const idx = Number.isInteger(Number(r.index)) ? Number(r.index) - 1 : k
    if (idx < 0 || idx >= count) return
    const look = r.look && typeof r.look === 'object' ? (r.look as Record<string, unknown>) : null
    out[idx] = {
      overall: n10(r.overall),
      scores: { brief: n10(r.brief), readability: n10(r.readability), consistency: n10(r.consistency), clean: n10(r.clean) },
      summary: str(r.summary, 300),
      changes: (Array.isArray(r.changes) ? r.changes : []).map((x) => str(x, 200)).filter(Boolean).slice(0, 3),
      ...(look ? { look: { stroke: str(look.stroke, 60), corners: str(look.corners, 60), shading: str(look.shading, 60), typography: str(look.typography, 60) } } : {})
    }
  })
  return out
}

// Critic + code: the critic's overall weighs 60%, the measured checks 40%.
export function blendCritique(rank: UiRankEntry, checks: UiCheck[], at: number): UiCritique {
  const code = checksOverall(checks)
  const fixes = checks.filter((c) => c.fix && c.score < 6).map((c) => c.fix!)
  return { at, overall: r1(rank.overall * 0.6 + code * 0.4), summary: rank.summary || codeCritique(checks, at).summary, scores: rank.scores, changes: [...rank.changes, ...fixes].slice(0, 5), by: 'critic' }
}

export function uiScore(a: Pick<UiAsset, 'critique' | 'checks'>): number {
  return a.critique?.overall ?? checksOverall(a.checks)
}

export function pickBestUi<T extends Pick<UiAsset, 'id' | 'critique' | 'checks'>>(assets: T[]): string | undefined {
  let best: T | undefined
  for (const a of assets) if (!best || uiScore(a) > uiScore(best)) best = a
  return best?.id
}

// ------------------------------------------------------------------ the learned kit

function mode(xs: string[]): string {
  const m = new Map<string, number>()
  for (const x of xs.filter(Boolean)) m.set(x, (m.get(x) ?? 0) + 1)
  let best = ''
  let n = 0
  for (const [k, v] of m) if (v > n) (best = k), (n = v)
  return best
}

export const EMPTY_KIT: UiKit = { samples: 0, palette: [], look: { stroke: '', corners: '', shading: '', typography: '' }, refIds: [], lines: [], avoid: [] }

// The kit from the user's kept (weight 1.5) and +1 assets: palette, look (the critic's words when it
// ran, else the measured look), references (pinned first, then the latest kept, same kind first
// when `kind` is given), and what the -1 assets did that the liked ones do not.
export function learnUiKit(assets: UiAsset[], o: { kind?: UiAssetKind; maxRefs?: number } = {}): UiKit {
  const liked = assets.filter((a) => a.keep || a.rating === 'up')
  const disliked = assets.filter((a) => a.rating === 'down' && !a.keep)
  const pinned = assets.filter((a) => a.pinned).sort((a, b) => b.updatedAt - a.updatedAt)
  if (!liked.length && !pinned.length) return { ...EMPTY_KIT, look: { ...EMPTY_KIT.look } }
  const pool = liked.length ? liked : pinned
  const weighted = pool.flatMap((a) => (a.keep ? [a, a] : [a]))
  const uiOnly = weighted.filter((a) => a.kind !== 'hud')
  const pal = mergePalettes(weighted.map((a) => a.stats.palette), 6)
  const looks = uiOnly.map((a) => ({ critic: a.look, measured: measuredLook(a.stats) }))
  const pick = (k: keyof UiLook) => mode(looks.map((l) => l.critic?.[k] ?? '')) || mode(looks.map((l) => l.measured[k]))
  const look: UiLook = { stroke: pick('stroke'), corners: pick('corners'), shading: pick('shading'), typography: mode(looks.map((l) => l.critic?.typography ?? '')) }
  const max = o.maxRefs ?? 4
  const sameKind = (a: UiAsset) => (o.kind && (a.kind === o.kind || (a.kind.startsWith('icon') && o.kind.startsWith('icon'))) ? 0 : 1)
  const kept = [...liked].filter((a) => !a.pinned && a.kind !== 'hud').sort((a, b) => sameKind(a) - sameKind(b) || Number(!!b.keep) - Number(!!a.keep) || b.updatedAt - a.updatedAt)
  const refIds = [...pinned.sort((a, b) => sameKind(a) - sameKind(b)), ...kept].map((a) => a.id).slice(0, max)
  const avoid: string[] = []
  if (disliked.length) {
    const share = (xs: UiAsset[], f: (a: UiAsset) => boolean) => (xs.length ? xs.filter(f).length / xs.length : 0)
    if (share(disliked, (a) => a.stats.outline !== 'dark') > 0.6 && share(liked, (a) => a.stats.outline === 'dark') > 0.5) avoid.push('avoid thin or missing outlines')
    if (share(disliked, (a) => a.stats.flatness > 0.8) > 0.6 && share(liked, (a) => a.stats.flatness <= 0.8) > 0.5) avoid.push('avoid flat, unshaded fills')
    if (share(disliked, (a) => a.stats.flatness < 0.45) > 0.6 && share(liked, (a) => a.stats.flatness >= 0.45) > 0.5) avoid.push('avoid noisy, over-detailed surfaces')
    if (share(disliked, (a) => a.stats.corner < 0.1) > 0.6 && share(liked, (a) => a.stats.corner >= 0.1) > 0.5) avoid.push('avoid sharp corners')
  }
  const lines = [pal.length ? `palette ${pal.join(' ')}` : '', look.stroke, look.corners, look.shading, look.typography ? `lettering: ${look.typography}` : ''].filter(Boolean)
  return { samples: liked.length, palette: pal, look, refIds, lines, avoid }
}

// The image the ranking critic sees: flattened on mid-grey, at most `max` px.
export function onGrey(img: Rgba, max = 384): Rgba {
  const s = fitAlpha(img, max)
  const out = blank(s.width, s.height)
  for (let p = 0; p < s.width * s.height; p++) {
    const a = s.data[p * 4 + 3] / 255
    for (let c = 0; c < 3; c++) out.data[p * 4 + c] = s.data[p * 4 + c] * a + 128 * (1 - a)
    out.data[p * 4 + 3] = 255
  }
  return out
}

// Luau to use an exported asset (SliceCenter for buttons and panels).
export function uiLuau(a: Pick<UiAsset, 'kind' | 'roblox' | 'slice' | 'name'>, size?: { width: number; height: number }): string {
  const lines = [`-- ${a.name}`, a.roblox ? `image.Image = "${a.roblox.uri}"` : 'image.Image = "rbxassetid://0" -- Upload to Roblox first, then paste the id', 'image.BackgroundTransparency = 1']
  if ((a.kind === 'button' || a.kind === 'panel') && a.slice) {
    lines.push('image.ScaleType = Enum.ScaleType.Slice', `image.SliceCenter = Rect.new(${a.slice.x0}, ${a.slice.y0}, ${a.slice.x1}, ${a.slice.y1})${size ? ` -- of ${size.width}x${size.height}` : ''}`)
  } else if (a.kind !== 'hud') lines.push('image.ScaleType = Enum.ScaleType.Fit')
  return lines.join('\n')
}
