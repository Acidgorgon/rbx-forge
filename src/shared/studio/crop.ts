// Finding Studio's 3D viewport inside a capture of the whole Studio window. Before a job the plugin
// fills the viewport with a full-screen key-colour frame (a ScreenGui under CoreGui; UI is not lit,
// so the colour arrives exact); the rectangle of key-coloured pixels is the viewport, and every beat
// frame is cropped to it. Pure, on raw RGBA / BGRA pixels.

export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export const KEY_COLOR: [number, number, number] = [255, 0, 255]

export interface KeyRectOptions {
  key?: [number, number, number]
  // Byte order of the pixels: 'rgba' (canvas ImageData) or 'bgra' (Electron nativeImage.toBitmap).
  order?: 'rgba' | 'bgra'
  // Per-channel tolerance.
  tolerance?: number
  // Smallest share of the window the viewport may cover (else no viewport was found).
  minShare?: number
}

export function findKeyRect(px: Uint8Array, width: number, height: number, opts: KeyRectOptions = {}): Rect | null {
  const [kr, kg, kb] = opts.key ?? KEY_COLOR
  const tol = opts.tolerance ?? 24
  const bgra = opts.order === 'bgra'
  if (px.length < width * height * 4 || width < 4 || height < 4) return null
  const rows = new Uint32Array(height)
  const cols = new Uint32Array(width)
  for (let y = 0; y < height; y++) {
    let o = y * width * 4
    for (let x = 0; x < width; x++, o += 4) {
      const r = bgra ? px[o + 2] : px[o]
      const g = px[o + 1]
      const b = bgra ? px[o] : px[o + 2]
      if (Math.abs(r - kr) <= tol && Math.abs(g - kg) <= tol && Math.abs(b - kb) <= tol) {
        rows[y]++
        cols[x]++
      }
    }
  }
  const ys = longestRun(rows, 0.5)
  const xs = longestRun(cols, 0.5)
  if (!ys || !xs) return null
  const rect = { x: xs[0], y: ys[0], width: xs[1] - xs[0] + 1, height: ys[1] - ys[0] + 1 }
  if (rect.width * rect.height < (opts.minShare ?? 0.08) * width * height) return null
  return rect
}

// The longest run of indices whose count is at least `share` of the largest count.
function longestRun(counts: Uint32Array, share: number): [number, number] | null {
  let max = 0
  for (const c of counts) max = Math.max(max, c)
  if (max === 0) return null
  const min = max * share
  let best: [number, number] | null = null
  let start = -1
  for (let i = 0; i <= counts.length; i++) {
    const on = i < counts.length && counts[i] >= min
    if (on && start < 0) start = i
    if (!on && start >= 0) {
      if (!best || i - 1 - start > best[1] - best[0]) best = [start, i - 1]
      start = -1
    }
  }
  return best
}

// Scales a rect found on a downscaled image back to the full-size capture.
export function scaleRect(r: Rect, sx: number, sy: number, bounds: { width: number; height: number }): Rect {
  const x = Math.max(0, Math.floor(r.x * sx))
  const y = Math.max(0, Math.floor(r.y * sy))
  return { x, y, width: Math.min(bounds.width - x, Math.ceil(r.width * sx)), height: Math.min(bounds.height - y, Math.ceil(r.height * sy)) }
}

// Shrinks a rect by a margin (the key colour bleeds a pixel into the viewport border).
export function insetRect(r: Rect, m: number): Rect {
  if (r.width <= 2 * m || r.height <= 2 * m) return r
  return { x: r.x + m, y: r.y + m, width: r.width - 2 * m, height: r.height - 2 * m }
}
