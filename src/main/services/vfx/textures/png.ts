// Minimal PNG codec for VFX textures (node:zlib, no native deps): decodes 8-bit greyscale, grey +
// alpha, RGB, RGBA and palette images (non-interlaced, all five filter types: what the OpenAI Images
// API and image editors write) and encodes RGBA8. PNG spec: https://www.w3.org/TR/png-3/
import { deflateSync, inflateSync } from 'node:zlib'
import type { Rgba } from '../../../../shared/vfx/tex/image.ts'

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

export class PngError extends Error {}

export function encodePng(img: Rgba): Buffer {
  const { width: w, height: h } = img
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 6
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  // Filter 0 (None) on every row: deterministic output for the tests' hashes.
  const raw = Buffer.alloc((w * 4 + 1) * h)
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0
    Buffer.from(img.data.buffer, img.data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1)
  }
  return Buffer.concat([SIG, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))])
}

export function decodePng(buf: Uint8Array): Rgba {
  const b = Buffer.from(buf.buffer, buf.byteOffset, buf.byteLength)
  if (b.length < 8 || !b.subarray(0, 8).equals(SIG)) throw new PngError('not a PNG')
  let pos = 8
  let w = 0
  let h = 0
  let depth = 0
  let type = 0
  let interlace = 0
  let palette: Buffer | null = null
  let trns: Buffer | null = null
  const idat: Buffer[] = []
  while (pos + 8 <= b.length) {
    const len = b.readUInt32BE(pos)
    const t = b.toString('ascii', pos + 4, pos + 8)
    const data = b.subarray(pos + 8, pos + 8 + len)
    pos += 12 + len
    if (t === 'IHDR') {
      w = data.readUInt32BE(0)
      h = data.readUInt32BE(4)
      depth = data[8]
      type = data[9]
      interlace = data[12]
    } else if (t === 'PLTE') palette = data
    else if (t === 'tRNS') trns = data
    else if (t === 'IDAT') idat.push(data)
    else if (t === 'IEND') break
  }
  if (!w || !h) throw new PngError('PNG has no IHDR')
  if (w * h > 8192 * 8192) throw new PngError('PNG too large')
  if (depth !== 8) throw new PngError(`only 8-bit PNGs are supported (this one is ${depth}-bit)`)
  if (interlace) throw new PngError('interlaced PNGs are not supported')
  const channels = ({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 } as Record<number, number>)[type]
  if (!channels) throw new PngError(`unsupported PNG colour type ${type}`)
  const raw = inflateSync(Buffer.concat(idat))
  const stride = w * channels
  if (raw.length < (stride + 1) * h) throw new PngError('PNG data is truncated')
  const px = Buffer.alloc(stride * h)
  const bpp = channels
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    for (let x = 0; x < stride; x++) {
      const v = raw[src + x]
      const a = x >= bpp ? px[dst + x - bpp] : 0
      const up = y > 0 ? px[dst - stride + x] : 0
      const c = y > 0 && x >= bpp ? px[dst - stride + x - bpp] : 0
      let out: number
      switch (f) {
        case 0:
          out = v
          break
        case 1:
          out = v + a
          break
        case 2:
          out = v + up
          break
        case 3:
          out = v + ((a + up) >> 1)
          break
        case 4: {
          const p = a + up - c
          const pa = Math.abs(p - a)
          const pb = Math.abs(p - up)
          const pc = Math.abs(p - c)
          out = v + (pa <= pb && pa <= pc ? a : pb <= pc ? up : c)
          break
        }
        default:
          throw new PngError(`bad PNG filter ${f}`)
      }
      px[dst + x] = out & 0xff
    }
  }
  const data = new Uint8ClampedArray(w * h * 4)
  for (let i = 0; i < w * h; i++) {
    const o = i * 4
    switch (type) {
      case 0:
        data[o] = data[o + 1] = data[o + 2] = px[i]
        data[o + 3] = trns && trns.length >= 2 && trns.readUInt16BE(0) === px[i] ? 0 : 255
        break
      case 4:
        data[o] = data[o + 1] = data[o + 2] = px[i * 2]
        data[o + 3] = px[i * 2 + 1]
        break
      case 2:
        data[o] = px[i * 3]
        data[o + 1] = px[i * 3 + 1]
        data[o + 2] = px[i * 3 + 2]
        data[o + 3] = trns && trns.length >= 6 && trns.readUInt16BE(0) === px[i * 3] && trns.readUInt16BE(2) === px[i * 3 + 1] && trns.readUInt16BE(4) === px[i * 3 + 2] ? 0 : 255
        break
      case 3: {
        const k = px[i]
        if (!palette || k * 3 + 2 >= palette.length) throw new PngError('PNG palette index out of range')
        data[o] = palette[k * 3]
        data[o + 1] = palette[k * 3 + 1]
        data[o + 2] = palette[k * 3 + 2]
        data[o + 3] = trns && k < trns.length ? trns[k] : 255
        break
      }
      default:
        data[o] = px[i * 4]
        data[o + 1] = px[i * 4 + 1]
        data[o + 2] = px[i * 4 + 2]
        data[o + 3] = px[i * 4 + 3]
    }
  }
  return { width: w, height: h, data }
}
