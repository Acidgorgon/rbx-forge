// Minimal PNG decoder for the frame gate: 8-bit greyscale / RGB / grey+alpha / RGBA, not interlaced
// (what Electron's capturePage().toPNG() and the Studio check write). Anything else returns null and
// the gate treats the frame as changed. Spec: https://www.w3.org/TR/png-3/ (chunks, filters 0-4).

import { inflateSync } from 'node:zlib'
import type { RawImage } from '../../../shared/gating/frames.ts'

const SIG = [137, 80, 78, 71, 13, 10, 26, 10]
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 4: 2, 6: 4 }

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
}

export function decodePng(buf: Uint8Array): RawImage | null {
  try {
    if (buf.length < 33 || SIG.some((v, i) => buf[i] !== v)) return null
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
    let pos = 8
    let width = 0
    let height = 0
    let channels = 0
    const idat: Uint8Array[] = []
    while (pos + 8 <= buf.length) {
      const len = view.getUint32(pos)
      const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7])
      const body = buf.subarray(pos + 8, pos + 8 + len)
      if (type === 'IHDR') {
        width = view.getUint32(pos + 8)
        height = view.getUint32(pos + 12)
        const depth = body[8]
        const color = body[9]
        const interlace = body[12]
        if (depth !== 8 || interlace !== 0 || !CHANNELS[color]) return null
        channels = CHANNELS[color]
        if (!width || !height || width * height > 16_000_000) return null
      } else if (type === 'IDAT') idat.push(body)
      else if (type === 'IEND') break
      pos += 12 + len
    }
    if (!channels || !idat.length) return null
    const raw = inflateSync(Buffer.concat(idat.map((b) => Buffer.from(b.buffer, b.byteOffset, b.byteLength))))
    const stride = width * channels
    if (raw.length < (stride + 1) * height) return null
    const out = new Uint8Array(stride * height)
    for (let y = 0; y < height; y++) {
      const f = raw[y * (stride + 1)]
      const src = y * (stride + 1) + 1
      const row = y * stride
      for (let x = 0; x < stride; x++) {
        const v = raw[src + x]
        const a = x >= channels ? out[row + x - channels] : 0
        const b = y > 0 ? out[row - stride + x] : 0
        const c = x >= channels && y > 0 ? out[row - stride + x - channels] : 0
        out[row + x] = (f === 0 ? v : f === 1 ? v + a : f === 2 ? v + b : f === 3 ? v + ((a + b) >> 1) : f === 4 ? v + paeth(a, b, c) : v) & 255
      }
    }
    return { width, height, channels, data: out }
  } catch {
    return null
  }
}
