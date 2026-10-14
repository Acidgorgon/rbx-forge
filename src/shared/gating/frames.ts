// Frame signatures for the "skip the critic" gate: each captured frame is reduced to a small
// greyscale thumbnail (box average) and a 64-bit difference hash (dHash: 9x8 luminance, one bit per
// horizontal neighbour pair). Two rounds of frames are compared by the mean absolute pixel difference
// of the thumbnails (0..1) and the Hamming distance of the hashes (0..64). Pure; decoding the PNGs
// happens in main (services/gating/png.ts).

export interface RawImage {
  width: number
  height: number
  // Channels per pixel in `data` (1 grey, 2 grey+alpha, 3 RGB, 4 RGBA).
  channels: number
  data: Uint8Array
}

export const THUMB_W = 32
export const THUMB_H = 24

export interface FrameSig {
  // THUMB_W x THUMB_H luminance, 0..255.
  thumb: number[]
  // 16 hex chars (64 bits).
  hash: string
}

function luma(img: RawImage, x: number, y: number): number {
  const i = (y * img.width + x) * img.channels
  const d = img.data
  if (img.channels <= 2) return d[i]
  return 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]
}

// Box-averaged greyscale at w x h.
export function downscale(img: RawImage, w: number, h: number): number[] {
  const out: number[] = new Array(w * h).fill(0)
  for (let ty = 0; ty < h; ty++) {
    const y0 = Math.floor((ty * img.height) / h)
    const y1 = Math.max(y0 + 1, Math.floor(((ty + 1) * img.height) / h))
    for (let tx = 0; tx < w; tx++) {
      const x0 = Math.floor((tx * img.width) / w)
      const x1 = Math.max(x0 + 1, Math.floor(((tx + 1) * img.width) / w))
      // Sample at most 8x8 points per cell so a large frame stays cheap.
      const sy = Math.max(1, Math.floor((y1 - y0) / 8))
      const sx = Math.max(1, Math.floor((x1 - x0) / 8))
      let sum = 0
      let n = 0
      for (let y = y0; y < y1; y += sy)
        for (let x = x0; x < x1; x += sx) {
          sum += luma(img, x, y)
          n++
        }
      out[ty * w + tx] = n ? sum / n : 0
    }
  }
  return out
}

export function dHash(img: RawImage): string {
  const g = downscale(img, 9, 8)
  let hex = ''
  for (let y = 0; y < 8; y++) {
    let byte = 0
    for (let x = 0; x < 8; x++) byte = (byte << 1) | (g[y * 9 + x] > g[y * 9 + x + 1] ? 1 : 0)
    hex += byte.toString(16).padStart(2, '0')
  }
  return hex
}

export function frameSig(img: RawImage): FrameSig {
  return { thumb: downscale(img, THUMB_W, THUMB_H).map((v) => Math.round(v)), hash: dHash(img) }
}

export function hamming(a: string, b: string): number {
  if (a.length !== b.length) return 64
  let d = 0
  for (let i = 0; i < a.length; i += 2) {
    let x = parseInt(a.slice(i, i + 2), 16) ^ parseInt(b.slice(i, i + 2), 16)
    while (x) {
      d += x & 1
      x >>= 1
    }
  }
  return d
}

// Mean absolute difference of two thumbnails, 0 (identical) .. 1 (black vs white).
export function thumbDiff(a: number[], b: number[]): number {
  if (a.length !== b.length || !a.length) return 1
  let s = 0
  for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i])
  return s / a.length / 255
}

export interface FramesDiff {
  // false when the rounds cannot be compared (different frame counts, undecodable frames).
  comparable: boolean
  // Largest per-frame thumbnail difference (one changed beat is enough to want a critique).
  diff: number
  // Largest per-frame hash distance.
  hash: number
}

// Compares two rounds frame by frame (same beat times). null entries are undecodable frames.
export function framesDiff(prev: (FrameSig | null)[] | null | undefined, cur: (FrameSig | null)[]): FramesDiff {
  if (!prev || !prev.length || prev.length !== cur.length) return { comparable: false, diff: 1, hash: 64 }
  let diff = 0
  let hash = 0
  for (let i = 0; i < cur.length; i++) {
    const a = prev[i]
    const b = cur[i]
    if (!a || !b) return { comparable: false, diff: 1, hash: 64 }
    diff = Math.max(diff, thumbDiff(a.thumb, b.thumb))
    hash = Math.max(hash, hamming(a.hash, b.hash))
  }
  return { comparable: true, diff, hash }
}
