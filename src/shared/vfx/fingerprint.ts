// A stable content hash of an effect, for "already in the library" on import and Find duplicates.
//
// Covers what the effect looks like and does: class names, normalised property values (numbers
// rounded to 4 decimals), attributes, script sources (whitespace collapsed), cues, duration and the
// timeline script. Ignores names (the same effect imported as "Slash" and "Slash (2)" matches),
// node ids, the order of siblings, and where the effect sat in the world (part CFrame positions are
// taken relative to their centroid). Instance references (ref props, cue targets) are reduced to the
// target's class so ids do not matter. Pure code (FNV-1a over a canonical string).

import { SCHEMA } from './schema.ts'
import type { VfxCue, VfxEffect, VfxNode } from './types.ts'

const r4 = (x: number) => {
  const v = Math.round(x * 1e4) / 1e4
  return Object.is(v, -0) ? 0 : v
}

function canon(v: unknown): string {
  if (typeof v === 'number') return Number.isFinite(v) ? String(r4(v)) : '0'
  if (typeof v === 'string') return JSON.stringify(v)
  if (typeof v === 'boolean') return v ? 'T' : 'F'
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .filter((k) => o[k] !== undefined)
      .sort()
      .map((k) => `${k}:${canon(o[k])}`)
      .join(',')}}`
  }
  return 'null'
}

function index(nodes: VfxNode[]): Map<string, VfxNode> {
  const m = new Map<string, VfxNode>()
  const walk = (n: VfxNode) => {
    m.set(n.id, n)
    n.children.forEach(walk)
  }
  nodes.forEach(walk)
  return m
}

// Canonical text of an effect's node tree (+ cues and timing when given an effect).
export function effectCanon(input: VfxEffect | VfxNode[]): string {
  const roots = Array.isArray(input) ? input : input.roots
  const byId = index(roots)
  // Centroid of every CFrame position in the tree (world placement drops out).
  let cx = 0
  let cy = 0
  let cz = 0
  let count = 0
  for (const n of byId.values()) {
    const cf = n.props.CFrame
    if (Array.isArray(cf) && cf.length >= 3 && typeof cf[0] === 'number') {
      cx += cf[0] as number
      cy += cf[1] as number
      cz += cf[2] as number
      count++
    }
  }
  if (count) (cx /= count), (cy /= count), (cz /= count)
  const node = (n: VfxNode): string => {
    const schema = SCHEMA[n.className] ?? {}
    const props = Object.keys(n.props)
      .sort()
      .map((k) => {
        let v = n.props[k] as unknown
        if (schema[k]?.kind === 'ref' && typeof v === 'string') v = `ref:${byId.get(v)?.className ?? '?'}`
        else if (k === 'CFrame' && Array.isArray(v) && v.length >= 3 && typeof v[0] === 'number') v = [(v[0] as number) - cx, (v[1] as number) - cy, (v[2] as number) - cz, ...v.slice(3)]
        return `${k}=${canon(v)}`
      })
      .join(';')
    const attrs = n.attrs ? canon(n.attrs) : ''
    const src = n.source !== undefined ? `#${n.source.replace(/\s+/g, ' ').trim()}` : ''
    const kids = n.children.map(node).sort().join('|')
    return `${n.className}(${props})${attrs}${src}[${kids}]`
  }
  const tree = roots.map(node).sort().join('|')
  if (Array.isArray(input)) return tree
  const cue = (c: VfxCue) => {
    const { target, ...rest } = c
    return canon({ ...rest, target: byId.get(target)?.className ?? '?' })
  }
  return `${tree}\ncues:${input.cues.map(cue).sort().join('|')}\nd:${r4(input.duration)}\ns:${(input.script ?? '').replace(/\s+/g, ' ').trim()}`
}

// 64-bit FNV-1a (two 32-bit halves) as 16 hex digits.
export function fnv64(text: string): string {
  let h1 = 0x811c9dc5
  let h2 = 0xcbf29ce4
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c ^ (i & 0xff), 0x01000193) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

export function effectHash(input: VfxEffect | VfxNode[]): string {
  return fnv64(effectCanon(input))
}
