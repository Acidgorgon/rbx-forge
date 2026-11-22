// Minimal XML DOM and Roblox AttributesSerialize binary decoder used by Studio insert jobs
// (shared/studio/insert.ts) to unpack .rbxmx models into BridgeJob nodes without pulling VFX schemas.

export interface NumKey {
  t: number
  v: number
  e?: number
}

export type RbxmxAttrValue = number | boolean | string | number[] | NumKey[]

export interface XmlEl {
  name: string
  attrs: Record<string, string>
  children: XmlEl[]
  text: string
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function decode(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (m, e: string) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10))
    return ENTITIES[e] ?? m
  })
}

export function parseXml(src: string): XmlEl {
  const root: XmlEl = { name: '#root', attrs: {}, children: [], text: '' }
  const stack: XmlEl[] = [root]
  let i = 0
  const n = src.length
  while (i < n) {
    const lt = src.indexOf('<', i)
    if (lt < 0) {
      stack[stack.length - 1].text += decode(src.slice(i))
      break
    }
    if (lt > i) stack[stack.length - 1].text += decode(src.slice(i, lt))
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt)
      if (end < 0) throw new Error('unterminated CDATA')
      stack[stack.length - 1].text += src.slice(lt + 9, end)
      i = end + 3
      continue
    }
    if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt)
      i = end < 0 ? n : end + 3
      continue
    }
    if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt)
      i = end < 0 ? n : end + 1
      continue
    }
    const gt = src.indexOf('>', lt)
    if (gt < 0) throw new Error('unterminated tag')
    const raw = src.slice(lt + 1, gt)
    i = gt + 1
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim()
      while (stack.length > 1) {
        const top = stack.pop()!
        if (top.name === name) break
      }
      continue
    }
    const selfClose = raw.endsWith('/')
    const body = selfClose ? raw.slice(0, -1) : raw
    const m = /^([^\s/]+)/.exec(body)
    if (!m) continue
    const el: XmlEl = { name: m[1], attrs: {}, children: [], text: '' }
    const attrRe = /([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g
    let a: RegExpExecArray | null
    while ((a = attrRe.exec(body.slice(m[1].length)))) el.attrs[a[1]] = decode(a[3] ?? a[4] ?? '')
    stack[stack.length - 1].children.push(el)
    if (!selfClose) stack.push(el)
  }
  return root
}

function b64bytes(text: string): Uint8Array {
  const clean = text.replace(/[^A-Za-z0-9+/]/g, '')
  const map = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4))
  let o = 0
  for (let i = 0; i + 1 < clean.length; i += 4) {
    const a = map.indexOf(clean[i])
    const b = map.indexOf(clean[i + 1])
    const c = i + 2 < clean.length ? map.indexOf(clean[i + 2]) : -1
    const d = i + 3 < clean.length ? map.indexOf(clean[i + 3]) : -1
    out[o++] = (a << 2) | (b >> 4)
    if (c >= 0 && o < out.length) out[o++] = ((b & 15) << 4) | (c >> 2)
    if (d >= 0 && o < out.length) out[o++] = ((c & 3) << 6) | d
  }
  return out.subarray(0, o)
}

const ATTR_SIZES: Record<number, number> = { 0x04: 4, 0x09: 8, 0x0a: 16, 0x0e: 4, 0x1c: 16 }
const ATTR_FLOATS: Record<number, number> = { 0x0f: 3, 0x10: 2, 0x11: 3, 0x1b: 2 }
const f6 = (x: number) => Math.round(x * 1e6) / 1e6

// Instance attributes as Roblox serialises them (AttributesSerialize, a BinaryString in .rbxmx).
export function decodeAttributes(input: string | Uint8Array): Record<string, RbxmxAttrValue> {
  const bytes = typeof input === 'string' ? b64bytes(input) : input
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Record<string, RbxmxAttrValue> = {}
  let at = 0
  const u32 = () => {
    const v = view.getUint32(at, true)
    at += 4
    return v
  }
  const f32 = () => {
    const v = view.getFloat32(at, true)
    at += 4
    return f6(v)
  }
  const str = () => {
    const n = u32()
    if (at + n > bytes.length) throw new Error('truncated')
    const v = new TextDecoder().decode(bytes.subarray(at, at + n))
    at += n
    return v
  }
  try {
    if (bytes.length < 4) return out
    const count = u32()
    for (let i = 0; i < count && at < bytes.length; i++) {
      const name = str()
      const type = bytes[at++]
      if (type === 0x02) out[name] = str()
      else if (type === 0x03) out[name] = bytes[at++] !== 0
      else if (type === 0x05) out[name] = f32()
      else if (type === 0x06) {
        out[name] = view.getFloat64(at, true)
        at += 8
      } else if (ATTR_FLOATS[type]) out[name] = Array.from({ length: ATTR_FLOATS[type] }, f32)
      else if (type === 0x17) {
        const n = u32()
        const keys: NumKey[] = []
        for (let k = 0; k < n; k++) {
          const e = f32()
          const t = f32()
          const v = f32()
          keys.push(e ? { t, v, e } : { t, v })
        }
        out[name] = keys
      } else if (type === 0x19) {
        const n = u32()
        at += n * 20
      } else if (ATTR_SIZES[type]) at += ATTR_SIZES[type]
      else break
    }
  } catch {
    // keep what was read
  }
  return out
}
