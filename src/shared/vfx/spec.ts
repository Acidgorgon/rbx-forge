// The compact effect spec agents write (vfx_create) and read (vfx_search_library), and the value
// normaliser shared by the spec, the critic's changes and the parameter editor.
//
// Spec shape (JSON):
//   { name, description?, tags?, duration?, motion?: static|swing|orbit|dash|rise, anchor?: [x,y,z],
//     layers: [ { name, class: ParticleEmitter|Beam|Trail|PointLight|SpotLight|Highlight,
//                 props: { Rate: 20, Lifetime: [0.3, 0.6], Size: [[0,0],[0.15,3],[1,0]],
//                          Color: ["#fff2b0", "#ff5a1f"], Transparency: [[0,0],[0.7,0.3],[1,1]], ... },
//                 emit?: [{ at: 0, count: 30 }], enable?: [[0, 0.4]],
//                 shape?: { size: [4,1,4] }       // emit from a part of this size (Shape needs one)
//                 width?: 3                       // Trail: attachment spacing (studs)
//                 from?: [x,y,z], to?: [x,y,z]    // Beam: attachment offsets from the root
//               } ] }
// Sequence shorthands: a number (constant), [[t, v], [t, v, envelope]], or [{t, v, e}].
// Colour shorthands: "#rrggbb", ["#a", "#b", ...] (evenly spaced), [[t, "#hex"]], [{t, c:[r,g,b]}].

import { cf } from './cframe.ts'
import { normalizeSequence, fromHex, hex } from './sequence.ts'
import { ENUMS, SCHEMA, type PropKind } from './schema.ts'
import { allNodes, findNode } from './analyze.ts'
import type { ColorKey, NumKey, PropValue, Rgb, VfxChange, VfxCue, VfxEffect, VfxMotion, VfxNode } from './types.ts'

export interface VfxLayerSpec {
  name: string
  class: string
  props?: Record<string, unknown>
  emit?: { at: number; count: number }[]
  enable?: [number, number][]
  shape?: { size: [number, number, number] }
  width?: number
  from?: [number, number, number]
  to?: [number, number, number]
}

export interface VfxSpec {
  name: string
  description?: string
  tags?: string[]
  duration?: number
  motion?: VfxMotion
  anchor?: [number, number, number]
  layers: VfxLayerSpec[]
}

export class SpecError extends Error {}

const MOTIONS: VfxMotion[] = ['static', 'swing', 'orbit', 'dash', 'rise']
const LAYER_CLASSES = new Set(['ParticleEmitter', 'Beam', 'Trail', 'PointLight', 'SpotLight', 'Highlight'])

function finite(x: unknown, what: string): number {
  const v = Number(x)
  if (!Number.isFinite(v)) throw new SpecError(`${what}: expected a number, got ${JSON.stringify(x)}`)
  return v
}

function color(x: unknown, what: string): Rgb {
  if (typeof x === 'string') {
    if (!/^#?[0-9a-f]{6}$/i.test(x.trim())) throw new SpecError(`${what}: colour "${x}" is not #rrggbb`)
    return fromHex(x)
  }
  if (Array.isArray(x) && x.length === 3) {
    const v = x.map((c, i) => finite(c, `${what}[${i}]`))
    // 0..255 given: scale.
    return (v.some((c) => c > 1) ? v.map((c) => c / 255) : v) as Rgb
  }
  throw new SpecError(`${what}: expected "#rrggbb" or [r,g,b]`)
}

// Raw value (spec shorthand, editor input, critic change) -> normalised PropValue for `kind`.
export function normalizeValue(kind: PropKind, raw: unknown, what = 'value'): PropValue {
  switch (kind) {
    case 'number':
      return finite(raw, what)
    case 'int':
      return Math.round(finite(raw, what))
    case 'bool':
      if (typeof raw === 'boolean') return raw
      if (raw === 'true' || raw === 'false') return raw === 'true'
      throw new SpecError(`${what}: expected true or false`)
    case 'string':
    case 'content':
      if (typeof raw === 'number') return `rbxassetid://${raw}`
      if (typeof raw !== 'string') throw new SpecError(`${what}: expected a string`)
      return /^\d+$/.test(raw.trim()) ? `rbxassetid://${raw.trim()}` : raw.trim()
    case 'vec2':
    case 'vec3': {
      const len = kind === 'vec2' ? 2 : 3
      if (typeof raw === 'number') return new Array(len).fill(raw)
      if (!Array.isArray(raw) || raw.length < len) throw new SpecError(`${what}: expected [${len === 2 ? 'x, y' : 'x, y, z'}]`)
      return raw.slice(0, len).map((v, i) => finite(v, `${what}[${i}]`))
    }
    case 'color3':
      return color(raw, what)
    case 'range': {
      if (typeof raw === 'number') return [raw, raw]
      if (Array.isArray(raw) && raw.length >= 1) {
        const a = finite(raw[0], `${what}[0]`)
        const b = raw.length > 1 ? finite(raw[1], `${what}[1]`) : a
        return [Math.min(a, b), Math.max(a, b)]
      }
      if (raw && typeof raw === 'object' && 'min' in raw) {
        const o = raw as { min: unknown; max?: unknown }
        return normalizeValue('range', [o.min, o.max ?? o.min], what)
      }
      throw new SpecError(`${what}: expected a number or [min, max]`)
    }
    case 'nseq': {
      if (typeof raw === 'number') return [{ t: 0, v: raw }, { t: 1, v: raw }]
      if (!Array.isArray(raw) || !raw.length) throw new SpecError(`${what}: expected a number or [[t, v], ...]`)
      const keys: NumKey[] = raw.map((k, i) => {
        if (Array.isArray(k)) {
          const key: NumKey = { t: finite(k[0], `${what}[${i}].t`), v: finite(k[1], `${what}[${i}].v`) }
          if (k.length > 2 && Number(k[2])) key.e = Math.abs(finite(k[2], `${what}[${i}].e`))
          return key
        }
        if (k && typeof k === 'object') {
          const o = k as { t: unknown; v: unknown; e?: unknown }
          const key: NumKey = { t: finite(o.t, `${what}[${i}].t`), v: finite(o.v, `${what}[${i}].v`) }
          if (o.e !== undefined && Number(o.e)) key.e = Math.abs(finite(o.e, `${what}[${i}].e`))
          return key
        }
        if (typeof k === 'number') return { t: raw.length === 1 ? 0 : i / (raw.length - 1), v: k }
        throw new SpecError(`${what}[${i}]: expected [t, v] or {t, v}`)
      })
      return normalizeSequence(keys)
    }
    case 'cseq': {
      if (typeof raw === 'string' || (Array.isArray(raw) && raw.length === 3 && raw.every((x) => typeof x === 'number'))) {
        const c = color(raw, what)
        return [{ t: 0, c }, { t: 1, c }]
      }
      if (!Array.isArray(raw) || !raw.length) throw new SpecError(`${what}: expected "#hex" or a list of colours`)
      const keys: ColorKey[] = raw.map((k, i) => {
        if (typeof k === 'string') return { t: raw.length === 1 ? 0 : i / (raw.length - 1), c: color(k, `${what}[${i}]`) }
        if (Array.isArray(k) && k.length === 2) return { t: finite(k[0], `${what}[${i}].t`), c: color(k[1], `${what}[${i}].c`) }
        if (k && typeof k === 'object') {
          const o = k as { t: unknown; c?: unknown; color?: unknown }
          return { t: finite(o.t, `${what}[${i}].t`), c: color(o.c ?? o.color, `${what}[${i}].c`) }
        }
        throw new SpecError(`${what}[${i}]: expected "#hex" or [t, "#hex"]`)
      })
      return normalizeSequence(keys)
    }
    case 'cframe':
      if (Array.isArray(raw) && raw.length === 3) return cf(finite(raw[0], what), finite(raw[1], what), finite(raw[2], what))
      if (Array.isArray(raw) && raw.length === 12) return raw.map((v, i) => finite(v, `${what}[${i}]`))
      throw new SpecError(`${what}: expected [x, y, z] or 12 CFrame components`)
    case 'ref':
      if (typeof raw !== 'string') throw new SpecError(`${what}: expected a node name`)
      return raw
    default:
      if (kind.startsWith('enum:')) {
        const t = kind.slice(5)
        const items = Object.keys(ENUMS[t] ?? {})
        const s = String(raw).replace(/^Enum\.\w+\./, '')
        const hit = items.find((k) => k.toLowerCase() === s.toLowerCase())
        if (!hit) throw new SpecError(`${what}: "${raw}" is not one of ${items.join(', ')}`)
        return hit
      }
      throw new SpecError(`${what}: unsupported kind ${kind}`)
  }
}

function setProps(node: VfxNode, raw: Record<string, unknown> | undefined, where: string): void {
  for (const [key, value] of Object.entries(raw ?? {})) {
    const spec = SCHEMA[node.className]?.[key]
    if (!spec) throw new SpecError(`${where}: ${node.className} has no property "${key}" the Lab supports (${Object.keys(SCHEMA[node.className] ?? {}).join(', ')})`)
    if (spec.kind === 'ref') continue
    node.props[key] = normalizeValue(spec.kind, value, `${where}.${key}`)
  }
}

let idCounter = 0
function newId(prefix: string): string {
  idCounter = (idCounter + 1) % 1e9
  return `${prefix}-${idCounter.toString(36)}`
}

export function safeName(name: string): string {
  const s = name.replace(/[^A-Za-z0-9]+(.)?/g, (_, c: string | undefined) => (c ? c.toUpperCase() : '')).replace(/^[^A-Za-z]+/, '')
  return (s.charAt(0).toUpperCase() + s.slice(1)).slice(0, 40) || 'Effect'
}

// Spec -> effect: Model > Root part (invisible, anchored) > Origin attachment > emitters, plus
// attachment pairs for trails and beams and shape parts for emitters with a shape.
export function effectFromSpec(spec: VfxSpec): VfxEffect {
  if (!spec || typeof spec !== 'object') throw new SpecError('spec must be an object')
  if (!Array.isArray(spec.layers) || !spec.layers.length) throw new SpecError('spec.layers must list at least one layer')
  if (spec.layers.length > 16) throw new SpecError('at most 16 layers')
  const name = safeName(String(spec.name ?? 'Effect'))
  const root: VfxNode = { id: newId('root'), className: 'Part', name: 'Root', props: { Size: [1, 1, 1], Transparency: 1, Anchored: true, CanCollide: false }, children: [] }
  const origin: VfxNode = { id: newId('att'), className: 'Attachment', name: 'Origin', props: {}, children: [] }
  root.children.push(origin)
  const cues: VfxCue[] = []
  const names = new Set<string>()
  spec.layers.forEach((layer, i) => {
    const where = `layers[${i}]`
    const cls = String(layer.class ?? 'ParticleEmitter')
    if (!LAYER_CLASSES.has(cls)) throw new SpecError(`${where}.class must be one of ${[...LAYER_CLASSES].join(', ')}`)
    let lname = safeName(String(layer.name ?? `${cls}${i + 1}`))
    while (names.has(lname)) lname += '2'
    names.add(lname)
    const node: VfxNode = { id: newId('n'), className: cls, name: lname, props: {}, children: [] }
    setProps(node, layer.props, where)
    if (cls === 'ParticleEmitter') {
      if (layer.shape?.size) {
        const part: VfxNode = { id: newId('part'), className: 'Part', name: `${lname}Shape`, props: { Size: normalizeValue('vec3', layer.shape.size, `${where}.shape.size`), Transparency: 1, Anchored: true, CanCollide: false, CFrame: cf(0, 0, 0) }, children: [node] }
        // A shape part lives beside the root (same place; parts are positioned in model space).
        root.children.push(part)
      } else origin.children.push(node)
    } else if (cls === 'Trail') {
      const w = layer.width === undefined ? 2 : finite(layer.width, `${where}.width`)
      const a0: VfxNode = { id: newId('att'), className: 'Attachment', name: `${lname}A0`, props: { CFrame: cf(0, w / 2, 0) }, children: [] }
      const a1: VfxNode = { id: newId('att'), className: 'Attachment', name: `${lname}A1`, props: { CFrame: cf(0, -w / 2, 0) }, children: [] }
      node.props.Attachment0 = a0.id
      node.props.Attachment1 = a1.id
      root.children.push(a0, a1, node)
    } else if (cls === 'Beam') {
      const from = normalizeValue('vec3', layer.from ?? [0, 0, 0], `${where}.from`) as number[]
      const to = normalizeValue('vec3', layer.to ?? [0, 0, -8], `${where}.to`) as number[]
      const a0: VfxNode = { id: newId('att'), className: 'Attachment', name: `${lname}A0`, props: { CFrame: cf(from[0], from[1], from[2]) }, children: [] }
      const a1: VfxNode = { id: newId('att'), className: 'Attachment', name: `${lname}A1`, props: { CFrame: cf(to[0], to[1], to[2]) }, children: [] }
      node.props.Attachment0 = a0.id
      node.props.Attachment1 = a1.id
      root.children.push(a0, a1, node)
    } else if (cls === 'Highlight') {
      root.children.push(node)
    } else {
      origin.children.push(node)
    }
    for (const [j, e] of (layer.emit ?? []).entries()) {
      if (cls !== 'ParticleEmitter') throw new SpecError(`${where}.emit only applies to ParticleEmitter`)
      cues.push({ at: Math.max(0, finite(e.at, `${where}.emit[${j}].at`)), target: node.id, action: 'emit', count: Math.max(1, Math.min(1000, Math.round(finite(e.count, `${where}.emit[${j}].count`)))) })
    }
    if (layer.enable?.length) {
      node.props.Enabled = false
      for (const [j, w] of layer.enable.entries()) {
        const a = finite(w[0], `${where}.enable[${j}][0]`)
        const b = finite(w[1], `${where}.enable[${j}][1]`)
        cues.push({ at: Math.max(0, a), target: node.id, action: 'enable' }, { at: Math.max(a, b), target: node.id, action: 'disable' })
      }
    } else if (layer.emit?.length && node.props.Enabled === undefined) node.props.Enabled = false
  })
  const model: VfxNode = { id: newId('model'), className: 'Model', name, props: {}, children: [root] }
  const motion = spec.motion && MOTIONS.includes(spec.motion) ? spec.motion : spec.layers.some((l) => l.class === 'Trail') ? 'swing' : 'static'
  const duration = spec.duration === undefined ? 2 : Math.max(0.2, Math.min(10, finite(spec.duration, 'duration')))
  const effect: VfxEffect = { name, roots: [model], cues: cues.sort((a, b) => a.at - b.at), duration, motion }
  if (spec.anchor) effect.anchor = normalizeValue('vec3', spec.anchor, 'anchor') as [number, number, number]
  return effect
}

// Changes from the critic or the editor: node (name or id) + property + raw value. Returns a new
// effect; unknown nodes / properties throw so the loop can report them.
// Scripted effects also keep each change in effect.patches (re-applied when the script runs again),
// unless record is false (that re-application itself).
export function applyChanges(effect: VfxEffect, changes: VfxChange[], opts: { record?: boolean } = {}): VfxEffect {
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  const record = (ch: VfxChange) => {
    if (!next.script || opts.record === false || ch.node === '$effect') return
    const key = (c: VfxChange) => `${c.node.toLowerCase()}|${c.prop.toLowerCase()}`
    next.patches = [...(next.patches ?? []).filter((p) => key(p) !== key(ch)), { node: ch.node, prop: ch.prop, value: ch.value }].slice(-60)
  }
  for (const ch of changes) {
    if (ch.node === '$effect') {
      if (ch.prop === 'duration') next.duration = Math.max(0.2, Math.min(10, finite(ch.value, 'duration')))
      else if (ch.prop === 'motion' && MOTIONS.includes(ch.value as VfxMotion)) next.motion = ch.value as VfxMotion
      continue
    }
    const node = findNode(next.roots, ch.node)
    if (!node) throw new SpecError(`no node named "${ch.node}"`)
    if (ch.prop === 'Emit' || ch.prop === 'emit') {
      const arr = Array.isArray(ch.value) ? ch.value : [ch.value]
      next.cues = next.cues.filter((c) => !(c.target === node.id && c.action === 'emit'))
      for (const raw of arr as unknown[]) {
        const e = (typeof raw === 'number' ? { at: 0, count: raw } : raw) as { at: unknown; count: unknown }
        next.cues.push({ at: Math.max(0, finite(e.at, 'emit.at')), target: node.id, action: 'emit', count: Math.max(1, Math.round(finite(e.count, 'emit.count'))) })
      }
      next.cues.sort((a, b) => a.at - b.at)
      record(ch)
      continue
    }
    const spec = SCHEMA[node.className]?.[ch.prop]
    if (!spec) throw new SpecError(`${node.className} "${node.name}" has no property "${ch.prop}"`)
    node.props[ch.prop] = normalizeValue(spec.kind, ch.value, `${node.name}.${ch.prop}`)
    record(ch)
  }
  return next
}

// A direct property edit (parameter editor): the new effect, recorded as a patch when scripted.
export function editProp(effect: VfxEffect, nodeId: string, propName: string, value: PropValue): VfxEffect {
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  const node = allNodes(next.roots).find((n) => n.id === nodeId)
  if (!node) return next
  node.props[propName] = value
  if (next.script) {
    const key = `${node.name.toLowerCase()}|${propName.toLowerCase()}`
    const raw = compactValue(SCHEMA[node.className]?.[propName]?.kind ?? 'number', value)
    next.patches = [...(next.patches ?? []).filter((p) => `${p.node.toLowerCase()}|${p.prop.toLowerCase()}` !== key), { node: node.name, prop: propName, value: raw }].slice(-60)
  }
  return next
}

// Effect -> compact JSON-able description (non-default props only), for prompts and the agent.
export function compactEffect(effect: VfxEffect): Record<string, unknown> {
  const layers: Record<string, unknown>[] = []
  for (const n of allNodes(effect.roots)) {
    // Scripted effects: visible kit parts (orb spheres, shockwave shells) are layers too.
    if (!LAYER_CLASSES.has(n.className) && !(n.kit === 'rig' && n.className === 'Part' && Number(n.props.Transparency ?? 0) < 1)) continue
    const props: Record<string, unknown> = {}
    const schema = SCHEMA[n.className] ?? {}
    for (const [k, v] of Object.entries(n.props)) {
      const spec = schema[k]
      if (!spec || spec.kind === 'ref' || k === 'Enabled') continue
      if (spec.default !== undefined && JSON.stringify(spec.default) === JSON.stringify(v)) continue
      props[k] = compactValue(spec.kind, v)
    }
    const layer: Record<string, unknown> = { name: n.name, class: n.className, props }
    const emits = effect.cues.filter((c) => c.target === n.id && c.action === 'emit').map((c) => ({ at: c.at, count: c.count }))
    if (emits.length) layer.emit = emits
    const en = effect.cues.filter((c) => c.target === n.id && (c.action === 'enable' || c.action === 'disable'))
    if (en.length) layer.toggles = en.map((c) => `${c.action}@${c.at}`)
    const tw = effect.cues.filter((c) => c.target === n.id && (c.action === 'tween' || c.action === 'set'))
    if (tw.length) layer.tweens = tw.map((c) => `${c.action}@${c.at}${c.duration ? `+${c.duration}` : ''} ${Object.keys(c.props ?? {}).join(',')}`)
    if (n.props.Enabled === false && !emits.length && !en.length) layer.enabled = false
    layers.push(layer)
  }
  const out: Record<string, unknown> = { name: effect.name, duration: effect.duration, motion: effect.motion ?? 'static', layers }
  if (effect.stages?.length) out.stages = effect.stages.map((s) => `${s.label}@${s.at}`)
  if (effect.script) out.scripted = true
  return out
}

function compactValue(kind: PropKind, v: PropValue): unknown {
  const r = (x: number) => Math.round(x * 1000) / 1000
  if (kind === 'nseq') return (v as NumKey[]).map((k) => (k.e ? [r(k.t), r(k.v), r(k.e)] : [r(k.t), r(k.v)]))
  if (kind === 'cseq') return (v as ColorKey[]).map((k) => [r(k.t), hex(k.c)])
  if (kind === 'color3') return hex(v as Rgb)
  if (Array.isArray(v)) return (v as number[]).map((x) => (typeof x === 'number' ? r(x) : x))
  if (typeof v === 'number') return r(v)
  return v
}
