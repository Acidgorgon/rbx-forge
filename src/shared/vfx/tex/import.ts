// Bringing existing textures into the VFX texture library (pure code: main, renderer, tests):
//  - flipbook sheets: a grid from the file name ("smoke_4x4.png", "fire_8f.png", "Grid8x8") or from
//    the pixels (transparent gutters between cells), and the repack of sheets Roblox cannot play
//    (3x3, 5x5, 4x2 strips ...) into Grid2x2 / Grid4x4 / Grid8x8;
//  - the image as stored: square, power of two, at most 1024 px (an opaque JPG on black gets alpha
//    from its brightness), colours kept;
//  - asset ids pasted as rbxassetid://123, plain numbers or Creator Store / catalog / library URLs;
//  - de-duplication by content hash, and the vision model's names / descriptions for a batch.
//
// Roblox facts (creator-docs, read 2026-10-13): FlipbookLayout is None, Grid2x2, Grid4x4 or Grid8x8;
// "The flipbook texture size must be an exact multiple of the flipbook layout size"
// (ParticleEmitter.FlipbookIncompatible); textures up to 1024x1024.

import { alphaCleanup, assembleFlipbook, blank, clone, FLIPBOOK_GRID, isOpaque, isPow2, layoutForFrames, MAX_TEXTURE_SIZE, nearestPow2, resample, type FlipbookLayout, type Rgba } from './image.ts'
import { kindFromText, TEXTURE_KINDS, type TextureKind } from './textures.ts'

export const IMPORT_IMAGE_EXT = ['.png', '.jpg', '.jpeg'] as const
export const MAX_IMPORT_FILES = 500

// ------------------------------------------------------------------ flipbooks

export interface GridHint {
  cols: number
  rows: number
  // Frames actually used (row by row); <= cols * rows.
  frames: number
}

export interface FlipbookPlan extends GridHint {
  layout: FlipbookLayout
  // Where the grid came from.
  source: 'name' | 'grid' | 'name+grid'
  // True when the sheet already is a Roblox grid (no repack needed).
  native: boolean
}

// "smoke_4x4", "Grid8x8", "fire 5×5", "explosion_16f", "spark-8frames", "dust_32fr".
export function flipbookFromName(name: string): { cols?: number; rows?: number; frames?: number } | null {
  const base = name.replace(/\.[a-z0-9]+$/i, '')
  const g = /(?<!\d)(\d{1,2})\s*[x×]\s*(\d{1,2})(?!\d)/i.exec(base)
  if (g) {
    const cols = Number(g[1])
    const rows = Number(g[2])
    if (cols >= 1 && rows >= 1 && cols <= 16 && rows <= 16 && cols * rows >= 4) return { cols, rows, frames: cols * rows }
  }
  const f = /(?<![a-z0-9])(\d{1,2})\s*(?:f|fr|frames?)(?![a-z])/i.exec(base)
  if (f) {
    const frames = Number(f[1])
    if (frames >= 2 && frames <= 64) return { frames }
  }
  return null
}

// The alpha (or brightness for opaque images) mask at up to `max` px.
function mask(img: Rgba, max = 512): { w: number; h: number; a: Uint8ClampedArray } {
  const k = Math.min(1, max / Math.max(img.width, img.height))
  let m = k < 1 ? resample(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))) : img
  if (isOpaque(m)) m = alphaCleanup(m, { threshold: 12 })
  const a = new Uint8ClampedArray(m.width * m.height)
  for (let i = 0; i < a.length; i++) a[i] = m.data[i * 4 + 3]
  return { w: m.width, h: m.height, a }
}

const CANDIDATES = [8, 6, 5, 4, 3, 2]

// A grid of cells separated by empty gutters (every boundary line between cells is transparent and
// most cells have something in them). null for a single sprite or gutterless sheets (those need a
// name hint).
export function detectGrid(img: Rgba): GridHint | null {
  const { w, h, a } = mask(img)
  const vis = (x: number, y: number) => a[y * w + x] > 24
  const lineClear = (vertical: boolean, at: number) => {
    const len = vertical ? h : w
    let hits = 0
    for (const p of [at - 1, at]) {
      if (p < 0 || p >= (vertical ? w : h)) continue
      for (let i = 0; i < len; i++) if (vertical ? vis(p, i) : vis(i, p)) hits++
    }
    return hits / (2 * len) < 0.01
  }
  const pick = (vertical: boolean) => {
    const size = vertical ? w : h
    for (const n of CANDIDATES) {
      if (size / n < 4) continue
      let ok = true
      for (let k = 1; k < n && ok; k++) ok = lineClear(vertical, Math.round((k * size) / n))
      if (ok) return n
    }
    return 1
  }
  const cols = pick(true)
  const rows = pick(false)
  if (cols * rows < 4) return null
  // Cells with content, row by row; the frame count is up to the last non-empty one.
  const cw = w / cols
  const ch = h / rows
  let used = 0
  let last = -1
  for (let k = 0; k < cols * rows; k++) {
    const x0 = Math.floor((k % cols) * cw)
    const y0 = Math.floor(Math.floor(k / cols) * ch)
    let c = 0
    for (let y = y0; y < Math.floor(y0 + ch); y++) for (let x = x0; x < Math.floor(x0 + cw); x++) if (vis(x, y)) c++
    if (c / (cw * ch) > 0.004) {
      used++
      last = k
    }
  }
  if (used < Math.max(2, (cols * rows) / 2)) return null
  return { cols, rows, frames: last + 1 }
}

// Combines the name hint and the detected grid into a plan (null = a single texture).
export function planFlipbook(img: Rgba, name: string, grid: GridHint | null = detectGrid(img)): FlipbookPlan | null {
  const hint = flipbookFromName(name)
  let g: GridHint | null = null
  let source: FlipbookPlan['source'] = 'grid'
  if (hint?.cols && hint.rows) {
    g = { cols: hint.cols, rows: hint.rows, frames: hint.frames ?? hint.cols * hint.rows }
    source = grid && grid.cols === g.cols && grid.rows === g.rows ? 'name+grid' : 'name'
    if (source === 'name+grid') g.frames = grid!.frames
  } else if (hint?.frames) {
    if (grid && grid.cols * grid.rows >= hint.frames) {
      g = { ...grid, frames: hint.frames }
      source = 'name+grid'
    } else {
      // From the aspect: 8 frames on a 2:1 sheet = 4x2, on a strip = 8x1.
      const aspect = img.width / img.height
      const cols = Math.max(1, Math.min(hint.frames, Math.round(Math.sqrt(hint.frames * aspect))))
      g = { cols, rows: Math.ceil(hint.frames / cols), frames: hint.frames }
      source = 'name'
    }
  } else if (grid) g = grid
  if (!g || g.frames < 2) return null
  const square = g.cols === g.rows && [2, 4, 8].includes(g.cols)
  const native = square && g.frames === g.cols * g.rows
  const frames = Math.min(64, g.frames)
  return { ...g, frames, layout: native ? (`Grid${g.cols}x${g.cols}` as FlipbookLayout) : layoutForFrames(frames), source, native }
}

function crop(img: Rgba, x0: number, y0: number, w: number, h: number): Rgba {
  const out = blank(w, h)
  for (let y = 0; y < h; y++) {
    const sy = y0 + y
    if (sy < 0 || sy >= img.height) continue
    for (let x = 0; x < w; x++) {
      const sx = x0 + x
      if (sx < 0 || sx >= img.width) continue
      const si = (sy * img.width + sx) * 4
      const di = (y * w + x) * 4
      for (let c = 0; c < 4; c++) out.data[di + c] = img.data[si + c]
    }
  }
  return out
}

// Centred on a transparent square (no cropping, no stretching).
export function padSquare(img: Rgba): Rgba {
  if (img.width === img.height) return clone(img)
  const side = Math.max(img.width, img.height)
  return crop(img, Math.floor((img.width - side) / 2), Math.floor((img.height - side) / 2), side, side)
}

const pow2Side = (n: number, min = 32) => Math.max(min, Math.min(MAX_TEXTURE_SIZE, nearestPow2(n)))

// The frames of a sheet, row by row.
export function sheetFrames(img: Rgba, g: GridHint): Rgba[] {
  const cw = Math.floor(img.width / g.cols)
  const ch = Math.floor(img.height / g.rows)
  return Array.from({ length: Math.min(g.frames, g.cols * g.rows) }, (_, k) => crop(img, (k % g.cols) * cw, Math.floor(k / g.cols) * ch, cw, ch))
}

export interface PreparedImport {
  image: Rgba
  flipbook?: { layout: FlipbookLayout; frames: number }
  // What changed on the way in (for the review).
  notes: string[]
}

// The image as stored in the library. Colours are kept (tint 'color'); a power-of-two square that
// is not too big is stored pixel for pixel.
export function prepareImport(src: Rgba, plan: FlipbookPlan | null): PreparedImport {
  const notes: string[] = []
  let img = src
  if (isOpaque(img)) {
    img = alphaCleanup(img, { threshold: 6 })
    notes.push('no transparency: alpha made from brightness')
  }
  if (!plan) {
    if (img.width !== img.height) notes.push('padded to a square')
    img = padSquare(img)
    if (!isPow2(img.width) || img.width > MAX_TEXTURE_SIZE) {
      const side = pow2Side(img.width)
      notes.push(`resized to ${side} px`)
      img = resample(img, side, side)
    }
    return { image: img, notes }
  }
  if (plan.native) {
    if (img.width !== img.height || !isPow2(img.width) || img.width > MAX_TEXTURE_SIZE) {
      const side = pow2Side(Math.max(img.width, img.height), plan.cols * 8)
      notes.push(`resized to ${side} px`)
      img = resample(img, side, side)
    }
    return { image: img, flipbook: { layout: plan.layout, frames: plan.frames }, notes }
  }
  // Repack: frames padded square, spread over the Roblox grid (time-resampled, so the whole grid
  // plays the animation once and no cell is empty).
  const frames = sheetFrames(img, plan).map(padSquare)
  const cols = FLIPBOOK_GRID[plan.layout]
  const n = cols * cols
  const order = Array.from({ length: n }, (_, k) => frames[Math.min(frames.length - 1, Math.floor((k * frames.length) / n))])
  const side = pow2Side(frames[0].width * cols, cols * 8)
  notes.push(`${plan.cols}x${plan.rows} sheet (${plan.frames} frames) repacked as ${plan.layout}`)
  return { image: assembleFlipbook(order, plan.layout, side, 0), flipbook: { layout: plan.layout, frames: plan.frames }, notes }
}

// ------------------------------------------------------------------ names

// "T_Smoke_Puff_04.png" -> "Smoke Puff 04"; flipbook hints and engine prefixes dropped.
export function importName(file: string): string {
  const base = file.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, '')
  const words = base
    .replace(/^(t|tex|vfx|fx)[_-]/i, '')
    .replace(/(?<!\d)\d{1,2}\s*[x×]\s*\d{1,2}(?!\d)/gi, ' ')
    .replace(/(?<![a-z0-9])\d{1,2}\s*(?:f|fr|frames?)(?![a-z])/gi, ' ')
    .replace(/grid/gi, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[\s_\-.]+/)
    .filter(Boolean)
  const name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join(' ').trim()
  return (name || 'Texture').slice(0, 60)
}

// Kind from the file name and folder names (closest first), else null.
export function kindFromPath(path: string): TextureKind | null {
  const parts = path.split(/[\\/]/).reverse()
  for (const p of parts.slice(0, 3)) {
    const k = kindFromText(p.replace(/[_\-.]+/g, ' '))
    if (k !== 'other') return k
  }
  return null
}

// ------------------------------------------------------------------ asset ids

export interface ParsedAssetId {
  id: string
  // The text it came from.
  from: string
}

const ID_PATTERNS: RegExp[] = [
  /rbxassetid:\/\/(\d{1,20})/gi,
  /roblox\.com\/asset\/?\?id=(\d{1,20})/gi,
  /assetdelivery\.roblox\.com\/v1\/asset\/?\?id=(\d{1,20})/gi,
  /create\.roblox\.com\/(?:store|marketplace)\/asset\/(\d{1,20})/gi,
  /roblox\.com\/(?:library|catalog|item-item|asset-item)\/(\d{1,20})/gi
]

// Asset ids from pasted text: rbxassetid://123, roblox.com/asset/?id=123, Creator Store / catalog /
// library URLs, and bare numbers of 5+ digits. Unique, in order.
export function parseAssetIds(text: string): ParsedAssetId[] {
  const hits: { at: number; id: string; from: string }[] = []
  const taken: [number, number][] = []
  for (const re of ID_PATTERNS) {
    for (const m of String(text ?? '').matchAll(re)) {
      hits.push({ at: m.index!, id: m[1], from: m[0] })
      taken.push([m.index!, m.index! + m[0].length])
    }
  }
  // Bare numbers outside the URLs above (and not inside other words or URLs).
  for (const m of String(text ?? '').matchAll(/(?<![\w/=.:-])(\d{5,20})(?![\w/.-])/g)) {
    if (taken.some(([a, b]) => m.index! >= a && m.index! < b)) continue
    hits.push({ at: m.index!, id: m[1], from: m[0] })
  }
  hits.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: ParsedAssetId[] = []
  for (const h of hits) {
    const id = h.id.replace(/^0+(?=\d)/, '')
    if (id === '0' || seen.has(id)) continue
    seen.add(id)
    out.push({ id, from: h.from })
  }
  return out
}

// ------------------------------------------------------------------ dedupe

// Marks rows whose hash is already in the library (duplicateOf = that texture id) or earlier in the
// same batch (duplicateOf = "batch:<key>"). Rows without a hash are never duplicates.
export function markDuplicates<T extends { key: string; hash?: string; duplicateOf?: string }>(rows: T[], existing: Map<string, string>): T[] {
  const batch = new Map<string, string>()
  return rows.map((r) => {
    if (!r.hash) return r
    const lib = existing.get(r.hash)
    if (lib) return { ...r, duplicateOf: lib }
    const prev = batch.get(r.hash)
    if (prev) return { ...r, duplicateOf: `batch:${prev}` }
    batch.set(r.hash, r.key)
    return r
  })
}

// ------------------------------------------------------------------ vision naming

export const VISION_TAG_SYSTEM = `You name VFX particle textures for a Roblox game's texture library. For each numbered image answer with JSON only: an array with one object per image, in order: {"name": 2-4 words, "kind": one of ${TEXTURE_KINDS.join(', ')}, "description": one short sentence on what it looks like and what effect layer it suits, "tags": up to 5 lowercase words}. The images are shown on black (they are drawn additively).`

export interface VisionTags {
  name?: string
  kind?: TextureKind
  description?: string
  tags?: string[]
}

// The model's answer -> one entry per image (null where it gave nothing usable).
export function parseVisionTags(raw: string, n: number): (VisionTags | null)[] {
  const out: (VisionTags | null)[] = Array.from({ length: n }, () => null)
  const m = /\[[\s\S]*\]/.exec(String(raw ?? '').replace(/```(?:json)?/g, ''))
  if (!m) return out
  let arr: unknown
  try {
    arr = JSON.parse(m[0])
  } catch {
    return out
  }
  if (!Array.isArray(arr)) return out
  for (let i = 0; i < n && i < arr.length; i++) {
    const o = arr[i] as Record<string, unknown> | null
    if (!o || typeof o !== 'object') continue
    const v: VisionTags = {}
    if (typeof o.name === 'string' && o.name.trim()) v.name = o.name.trim().slice(0, 60)
    if (typeof o.kind === 'string' && (TEXTURE_KINDS as readonly string[]).includes(o.kind.toLowerCase())) v.kind = o.kind.toLowerCase() as TextureKind
    if (typeof o.description === 'string' && o.description.trim()) v.description = o.description.trim().slice(0, 300)
    if (Array.isArray(o.tags)) v.tags = o.tags.filter((t): t is string => typeof t === 'string').map((t) => t.toLowerCase().trim()).filter((t) => /^[a-z0-9 -]{1,24}$/.test(t)).slice(0, 5)
    out[i] = Object.keys(v).length ? v : null
  }
  return out
}
