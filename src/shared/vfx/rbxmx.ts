// Roblox XML models (.rbxmx): a small reader and writer for the VFX classes in schema.ts.
//
// Format (Roblox's XML place/model format, as written by Studio and by Lune 0.11's
// roblox.serializeModel(..., true)): <roblox version="4"> holds <Item class referent> elements, each
// with <Properties> and child Items. Property elements are named by type: float, double, int, bool,
// string, token (enum value number), Vector2/Vector3 (<X><Y><Z>), Color3 (<R><G><B>), Color3uint8
// (packed 0xRRGGBB), NumberRange ("min max"), NumberSequence ("t v e ..."), ColorSequence
// ("t r g b 0 ..."), CoordinateFrame (<X>..<R22>), Ref (referent), Content (<url>/<uri>/<null/>),
// ContentId and ProtectedString (script Source, usually CDATA).
//
// The binary format (.rbxm) is read through Lune (services/vfx/lune.ts); this reader also gives
// Forge a no-Lune path for .rbxmx and is used to check what we write.

import { ENUMS, SCHEMA, enumName } from './schema.ts'
import type { ColorKey, NumKey, PropValue, VfxNode } from './types.ts'

// ------------------------------------------------------------------ tiny XML DOM

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

const child = (el: XmlEl, name: string) => el.children.find((c) => c.name === name)
const num = (s: string | undefined) => {
  const v = Number(String(s ?? '').trim())
  return Number.isFinite(v) ? v : 0
}
const nums = (s: string) =>
  s
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map(Number)
    .map((x) => (Number.isFinite(x) ? x : 0))

// ------------------------------------------------------------------ read

// Property names Studio / Lune write in a different case or form than the API name.
const ALIASES: Record<string, string> = { size: 'Size', Color3uint8: 'Color', TextureContent: 'Texture', MeshContent: 'MeshId', TextureId: 'TextureId', shape: 'Shape', formFactorRaw: '' }

function readValue(el: XmlEl, className: string, propName: string): PropValue | undefined {
  const comp = (k: string) => num(child(el, k)?.text)
  switch (el.name) {
    case 'float':
    case 'double':
    case 'int':
    case 'int64':
      return num(el.text)
    case 'bool':
      return el.text.trim() === 'true'
    case 'string':
    case 'BinaryString':
    case 'ProtectedString':
      return el.text
    case 'Content':
    case 'ContentId': {
      const inner = child(el, 'url') ?? child(el, 'uri')
      if (child(el, 'null')) return ''
      return (inner ? inner.text : el.text).trim()
    }
    case 'token': {
      const spec = SCHEMA[className]?.[propName]
      const enumType = spec?.kind.startsWith('enum:') ? spec.kind.slice(5) : null
      const v = num(el.text)
      return enumType ? enumName(enumType, v) ?? String(v) : v
    }
    case 'Vector2':
      return [comp('X'), comp('Y')]
    case 'Vector3':
      return [comp('X'), comp('Y'), comp('Z')]
    case 'Color3':
      return [comp('R'), comp('G'), comp('B')]
    case 'Color3uint8': {
      const v = num(el.text) >>> 0
      return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255]
    }
    case 'NumberRange': {
      const v = nums(el.text)
      return [v[0] ?? 0, v[1] ?? v[0] ?? 0]
    }
    case 'NumberSequence': {
      const v = nums(el.text)
      const out: NumKey[] = []
      for (let i = 0; i + 2 < v.length + 1 && i + 1 < v.length; i += 3) out.push(v[i + 2] ? { t: v[i], v: v[i + 1], e: v[i + 2] } : { t: v[i], v: v[i + 1] })
      return out
    }
    case 'ColorSequence': {
      const v = nums(el.text)
      const out: ColorKey[] = []
      for (let i = 0; i + 3 < v.length; i += 5) out.push({ t: v[i], c: [v[i + 1], v[i + 2], v[i + 3]] })
      return out
    }
    case 'CoordinateFrame':
    case 'CFrame':
      return ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map(comp)
    case 'Ref': {
      const r = el.text.trim()
      return r && r !== 'null' ? `ref:${r}` : undefined
    }
    default:
      return undefined
  }
}

// ------------------------------------------------------------------ attributes

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

// Instance attributes as Roblox serialises them (AttributesSerialize, a BinaryString in .rbxmx):
// u32 count, then per attribute a u32-length name, a type byte and the value. Numbers set from Luau
// are Float64 (0x06); strings 0x02, booleans 0x03, Float32 0x05. Other types are skipped by size;
// an unknown type ends the read (the attributes before it are kept). Little-endian throughout.
// Format: rbx-dom docs/attributes.md.
const ATTR_SIZES: Record<number, number> = { 0x04: 4, 0x09: 8, 0x0a: 16, 0x0e: 4, 0x0f: 12, 0x10: 8, 0x11: 12, 0x1b: 8, 0x1c: 16 }
export function decodeAttributes(input: string | Uint8Array): Record<string, number | boolean | string> {
  const bytes = typeof input === 'string' ? b64bytes(input) : input
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const out: Record<string, number | boolean | string> = {}
  let at = 0
  const u32 = () => {
    const v = view.getUint32(at, true)
    at += 4
    return v
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
      else if (type === 0x05) {
        out[name] = Math.round(view.getFloat32(at, true) * 1e6) / 1e6
        at += 4
      } else if (type === 0x06) {
        out[name] = view.getFloat64(at, true)
        at += 8
      } else if (ATTR_SIZES[type]) at += ATTR_SIZES[type]
      else break
    }
  } catch {
    // keep what was read
  }
  return out
}

export function encodeAttributes(attrs: Record<string, number | boolean | string>): string {
  const parts: number[] = []
  const u32 = (v: number) => parts.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255)
  const str = (s: string) => {
    const b = new TextEncoder().encode(s)
    u32(b.length)
    parts.push(...b)
  }
  const entries = Object.entries(attrs)
  u32(entries.length)
  for (const [k, v] of entries) {
    str(k)
    if (typeof v === 'string') (parts.push(0x02), str(v))
    else if (typeof v === 'boolean') parts.push(0x03, v ? 1 : 0)
    else {
      parts.push(0x06)
      const f = new DataView(new ArrayBuffer(8))
      f.setFloat64(0, v, true)
      for (let i = 0; i < 8; i++) parts.push(f.getUint8(i))
    }
  }
  let bin = ''
  for (const b of parts) bin += String.fromCharCode(b)
  return btoa(bin)
}

// Every Item of an .rbxmx as VfxNodes (all classes, all readable properties). Refs are node ids.
export function readRbxmx(xml: string): VfxNode[] {
  const doc = parseXml(xml)
  const top = doc.children.find((c) => c.name === 'roblox') ?? doc
  const convert = (item: XmlEl): VfxNode => {
    const className = item.attrs.class ?? 'Folder'
    const id = item.attrs.referent ?? ''
    const props: Record<string, PropValue> = {}
    let name = className
    let source: string | undefined
    let attrs: Record<string, number | boolean | string> | undefined
    const propsEl = child(item, 'Properties')
    for (const p of propsEl?.children ?? []) {
      let key = p.attrs.name ?? ''
      if (!key) continue
      if (key in ALIASES) key = ALIASES[key] || ''
      if (!key) continue
      if (key === 'Name') {
        name = p.text
        continue
      }
      if (key === 'Source') {
        source = p.text
        continue
      }
      if (key === 'AttributesSerialize') {
        const a = decodeAttributes(p.text)
        if (Object.keys(a).length) attrs = a
        continue
      }
      const v = readValue(p, className, key)
      if (v === undefined) continue
      // Prefer Color3 over a packed Color3uint8 written alongside it; keep the first Texture.
      if (key === 'Texture' && typeof props.Texture === 'string' && props.Texture) continue
      props[key] = typeof v === 'string' && v.startsWith('ref:') ? v.slice(4) : v
    }
    // TextureContent (newer files) maps to the class's own texture property.
    if (typeof props.Texture === 'string' && (className === 'MeshPart' || className === 'SpecialMesh')) {
      const k = className === 'MeshPart' ? 'TextureID' : 'TextureId'
      if (!props[k]) props[k] = props.Texture
      delete props.Texture
    }
    const node: VfxNode = { id, className, name, props, children: item.children.filter((c) => c.name === 'Item').map(convert) }
    if (source !== undefined) node.source = source
    if (attrs) node.attrs = attrs
    return node
  }
  return top.children.filter((c) => c.name === 'Item').map(convert)
}

// ------------------------------------------------------------------ write

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function n(x: unknown): string {
  const v = Number(x)
  if (!Number.isFinite(v)) return '0'
  return String(Math.round(v * 1e6) / 1e6)
}

function writeProp(name: string, kind: string, v: PropValue, refs: Map<string, string>, pad: string): string | null {
  const arr = Array.isArray(v) ? (v as unknown[]) : []
  switch (kind) {
    case 'number':
      return `${pad}<float name="${name}">${n(v)}</float>`
    case 'int':
      return `${pad}<int name="${name}">${Math.round(Number(v) || 0)}</int>`
    case 'bool':
      return `${pad}<bool name="${name}">${v ? 'true' : 'false'}</bool>`
    case 'string':
      return `${pad}<string name="${name}">${esc(String(v))}</string>`
    case 'content':
      return String(v) ? `${pad}<Content name="${name}"><url>${esc(String(v))}</url></Content>` : `${pad}<Content name="${name}"><null></null></Content>`
    case 'vec2':
      return `${pad}<Vector2 name="${name}"><X>${n(arr[0])}</X><Y>${n(arr[1])}</Y></Vector2>`
    case 'vec3':
      return `${pad}<Vector3 name="${name}"><X>${n(arr[0])}</X><Y>${n(arr[1])}</Y><Z>${n(arr[2])}</Z></Vector3>`
    case 'color3':
      return `${pad}<Color3 name="${name}"><R>${n(arr[0])}</R><G>${n(arr[1])}</G><B>${n(arr[2])}</B></Color3>`
    case 'range':
      return `${pad}<NumberRange name="${name}">${n(arr[0])} ${n(arr[1] ?? arr[0])} </NumberRange>`
    case 'nseq':
      return `${pad}<NumberSequence name="${name}">${(v as NumKey[]).map((k) => `${n(k.t)} ${n(k.v)} ${n(k.e ?? 0)} `).join('')}</NumberSequence>`
    case 'cseq':
      return `${pad}<ColorSequence name="${name}">${(v as ColorKey[]).map((k) => `${n(k.t)} ${n(k.c[0])} ${n(k.c[1])} ${n(k.c[2])} 0 `).join('')}</ColorSequence>`
    case 'cframe': {
      const tags = ['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22']
      return `${pad}<CoordinateFrame name="${name}">${tags.map((t, i) => `<${t}>${n(arr[i])}</${t}>`).join('')}</CoordinateFrame>`
    }
    case 'ref': {
      const r = refs.get(String(v))
      return r ? `${pad}<Ref name="${name}">${r}</Ref>` : null
    }
    default:
      if (kind.startsWith('enum:')) {
        const t = ENUMS[kind.slice(5)]
        const value = typeof v === 'number' ? v : t?.[String(v)]
        return value === undefined ? null : `${pad}<token name="${name}">${value}</token>`
      }
      return null
  }
}

// Writes nodes as an .rbxmx model. Only schema properties are written (unknown ones are dropped).
export function writeRbxmx(roots: VfxNode[]): string {
  const refs = new Map<string, string>()
  let counter = 0
  const assign = (nd: VfxNode) => {
    refs.set(nd.id, `RBX${(counter++).toString(16).toUpperCase().padStart(8, '0')}`)
    nd.children.forEach(assign)
  }
  roots.forEach(assign)
  const lines: string[] = ['<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:noNamespaceSchemaLocation="http://www.roblox.com/roblox.xsd" version="4">', '\t<External>null</External>', '\t<External>nil</External>']
  const item = (nd: VfxNode, depth: number) => {
    const pad = '\t'.repeat(depth)
    lines.push(`${pad}<Item class="${esc(nd.className)}" referent="${refs.get(nd.id)}">`)
    lines.push(`${pad}\t<Properties>`)
    lines.push(`${pad}\t\t<string name="Name">${esc(nd.name)}</string>`)
    const schema = SCHEMA[nd.className] ?? {}
    for (const [key, value] of Object.entries(nd.props)) {
      const spec = schema[key]
      if (!spec || value === undefined || value === null) continue
      // Part colour is written as Color3uint8 (what BasePart serialises).
      if ((nd.className === 'Part' || nd.className === 'MeshPart') && key === 'Color' && Array.isArray(value)) {
        const c = (value as number[]).map((x) => Math.max(0, Math.min(255, Math.round(x * 255))))
        lines.push(`${pad}\t\t<Color3uint8 name="Color3uint8">${(((c[0] << 16) | (c[1] << 8) | c[2]) >>> 0).toString()}</Color3uint8>`)
        continue
      }
      if ((nd.className === 'Part' || nd.className === 'MeshPart') && key === 'Size') {
        const a = value as number[]
        lines.push(`${pad}\t\t<Vector3 name="size"><X>${n(a[0])}</X><Y>${n(a[1])}</Y><Z>${n(a[2])}</Z></Vector3>`)
        continue
      }
      // Part.Shape serialises as "shape".
      const l = writeProp(nd.className === 'Part' && key === 'Shape' ? 'shape' : key, spec.kind, value, refs, `${pad}\t\t`)
      if (l) lines.push(l)
    }
    if (nd.source !== undefined) lines.push(`${pad}\t\t<ProtectedString name="Source"><![CDATA[${nd.source.replace(/\]\]>/g, ']]]]><![CDATA[>')}]]></ProtectedString>`)
    lines.push(`${pad}\t</Properties>`)
    for (const c of nd.children) item(c, depth + 1)
    lines.push(`${pad}</Item>`)
  }
  for (const r of roots) item(r, 1)
  lines.push('</roblox>')
  return lines.join('\n') + '\n'
}
