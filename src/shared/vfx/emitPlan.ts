// The ForgeVFX play plan (docs/vfx-emit.md): from a node tree and its attributes, everything one
// `ForgeVFX.emit(template)` does over time. The VFX Lab preview (simulate.ts), the importer
// (analyze.ts cuesFromAttributes) and the tests read it; the Luau runtime mirrors the same rules.
// Pure code.
//
// Rules (where the spec left a choice, the choice is written here; the runtime follows them):
//   Inheritance  EmitDelay is the SUM of EmitDelay on the node and all its ancestors (clamped 0..30);
//                every other attribute is the node's own value, else its nearest ancestor's.
//                Numeric strings count as numbers.
//   Layers       ParticleEmitter / Beam / Trail / PointLight / SpotLight / SurfaceLight / Highlight
//                are attribute-driven when EmitDelay, EmitCount or EmitDuration applies to them
//                (FadeOut too, for the non-emitters). Emitters: exactly the old cuesFromAttributes
//                rules (Rate is the emitter's Rate property). Others: off until the delay, on for
//                EmitDuration, else until Duration (open window, at least OPEN_MIN s).
//   FadeOut      linear over the last FadeOut seconds of the window: Beam / Trail transparency
//                T' = 1 - (1 - T)(1 - k), light Brightness x (1 - k).
//   Mesh effect  a Model / Folder with direct BasePart children named Start and End. Lifetime, Ease*,
//                SpreadAngle, Min/MaxInitRot, Spin, SyncPosition are read from the container itself;
//                EmitDelay (summed), EmitCount (default 1), EmitDuration, Rate are inherited.
//                Spawns: EmitDuration > 0 and Rate > 0: EmitCount copies at delay + k/Rate while
//                k/Rate < EmitDuration; EmitDuration > 0 and no Rate: EmitCount copies spread, copy i
//                at delay + i * EmitDuration / EmitCount; else EmitCount copies at the delay.
//                At most MAX_COPIES copies.
//                Per copy random draws, in order: lifetime, spread X, spread Y, rot X, rot Y, rot Z.
//                Pivot P = CFrame.new(Start.Position). Copy CFrame (template space) at age a:
//                  P * Angles(spread) * Angles(initRot) * P^-1 * Start:Lerp(End, easeCFrame(a/life))
//                    * Angles(Spin * a)          (spin is linear in seconds, about the copy's centre)
//                Size and SpecialMesh Scale use EaseSize, SpecialMesh Offset EaseCFrame, Transparency
//                (part, same-named Decal / Texture) EaseTransparency, Color / Color3 / VertexColor
//                EaseColor. Overshoot extrapolates; drawing clamps Transparency to 0..1.
//   Riding       children of Start ride each copy: inheritance restarts at Start, times are
//                relative to the copy's spawn, "until the end" is the copy's death (spawn + life),
//                where the copy hides and its layers switch off (events after it are dropped).
//   Duration     the latest of: window starts, explicit window ends, emitter bursts, open windows'
//                start + OPEN_MIN, copy deaths. At Duration every attribute-driven layer still on
//                switches off. Duration 0 with an Enabled untimed layer: OPEN_MIN. Linger: how long particles (Lifetime.Max after their last emission)
//                and trail segments (Trail.Lifetime after the window ends) outlive Duration.

import { anglesXYZ, cf, inverse, lerpCFrame, mul } from './cframe.ts'
import { PART_CLASSES, prop } from './schema.ts'
import { evalNumberSequence, hashSeed, rng } from './sequence.ts'
import type { CFrameArr, EasingDirection, EasingStyle, NumberRange, NumKey, Rgb, Vec2, Vec3, VfxAttrValue, VfxCue, VfxNode } from './types.ts'

export const EMIT_ATTRS = ['EmitCount', 'EmitDelay', 'EmitDuration'] as const
export const LAYER_ATTRS = ['EmitDelay', 'EmitDuration', 'EmitCount', 'Rate', 'FadeOut'] as const
export const EASE_PROPS = ['EaseCFrame', 'EaseSize', 'EaseTransparency', 'EaseColor'] as const
export const MESH_ATTRS = ['Lifetime', 'Ease', ...EASE_PROPS, 'SpreadAngle', 'MinInitRot', 'MaxInitRot', 'Spin', 'SyncPosition'] as const
// Roblox types of the array-valued attributes (how .rbxmx writes them; Studio shows them so).
export const ATTR_TYPES: Record<string, 'NumberRange' | 'Vector2' | 'Vector3' | 'Color3'> = { Lifetime: 'NumberRange', SpreadAngle: 'Vector2', MinInitRot: 'Vector3', MaxInitRot: 'Vector3', Spin: 'Vector3' }
export const MAX_DELAY = 30
export const MAX_COPIES = 200
export const OPEN_MIN = 1
export const DEFAULT_LIFETIME = 0.5
export const DEFAULT_EASE = 'Quad.Out'

export const EASING_STYLES: EasingStyle[] = ['Linear', 'Sine', 'Back', 'Quad', 'Quart', 'Quint', 'Bounce', 'Elastic', 'Exponential', 'Circular', 'Cubic']
export const EASING_DIRECTIONS: EasingDirection[] = ['In', 'Out', 'InOut']

const LIGHTS = new Set(['PointLight', 'SpotLight', 'SurfaceLight', 'Highlight'])
export type LayerKind = 'emitter' | 'beam' | 'trail' | 'light'

export function layerKind(className: string): LayerKind | null {
  if (className === 'ParticleEmitter') return 'emitter'
  if (className === 'Beam') return 'beam'
  if (className === 'Trail') return 'trail'
  return LIGHTS.has(className) ? 'light' : null
}

// ------------------------------------------------------------------ attribute values

export function attrNumber(v: VfxAttrValue | undefined): number | undefined {
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v)
  return undefined
}

function numbersOf(v: VfxAttrValue | undefined): number[] | undefined {
  if (Array.isArray(v) && v.every((x) => typeof x === 'number')) return (v as number[]).map((x) => (Number.isFinite(x) ? x : 0))
  if (typeof v === 'string' && v.trim()) {
    const parts = v.split(/[\s,]+/).filter(Boolean).map(Number)
    if (parts.length && parts.every(Number.isFinite)) return parts
  }
  if (typeof v === 'number' && Number.isFinite(v)) return [v]
  return undefined
}

// NumberRange: [min, max], a number (both), or "min max".
export function attrRange(v: VfxAttrValue | undefined): NumberRange | undefined {
  const n = numbersOf(v)
  if (!n?.length) return undefined
  const a = n[0]
  const b = n.length > 1 ? n[1] : n[0]
  return [Math.min(a, b), Math.max(a, b)]
}

// Vector2 / Vector3: [x, y(, z)], or "x y z" (missing components are 0).
export function attrVec(v: VfxAttrValue | undefined, size: 2 | 3): number[] | undefined {
  const n = numbersOf(v)
  if (!n?.length || (typeof v === 'number')) return undefined
  return Array.from({ length: size }, (_, i) => n[i] ?? 0)
}

export function attrBool(v: VfxAttrValue | undefined): boolean | undefined {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'string') return /^(true|yes|1)$/i.test(v.trim()) ? true : /^(false|no|0)$/i.test(v.trim()) ? false : undefined
  return undefined
}

export function attrSequence(v: VfxAttrValue | undefined): NumKey[] | undefined {
  if (!Array.isArray(v) || v.length < 2 || !v.every((k) => typeof k === 'object' && k !== null && typeof (k as NumKey).t === 'number' && typeof (k as NumKey).v === 'number')) return undefined
  return [...(v as NumKey[])].sort((a, b) => a.t - b.t)
}

// The Roblox type an array attribute is written as (Effect.rbxmx and the module's NODES rebuild
// agree on it): the name's type in ATTR_TYPES, else a 2-array is a Vector2 and a 3-array a
// Vector3; NumKey[] is a NumberSequence. null: not an array attribute Roblox can hold.
export type ArrayAttrType = (typeof ATTR_TYPES)[string] | 'NumberSequence'
export function arrayAttrType(name: string, v: VfxAttrValue): ArrayAttrType | null {
  if (!Array.isArray(v) || v.length < 2) return null
  if (v.every((x) => typeof x === 'number')) {
    if (v.length > 3) return null
    return ATTR_TYPES[name] ?? (v.length === 2 ? 'Vector2' : 'Vector3')
  }
  return attrSequence(v) ? 'NumberSequence' : null
}

// ------------------------------------------------------------------ easing (TweenService:GetValue)

// The "In" curve of each style (Out and InOut are built from it, as Roblox / Penner do; Back and
// Elastic InOut use Penner's own constants).
const BACK = 1.70158
function easeIn(style: EasingStyle, t: number): number {
  switch (style) {
    case 'Linear':
      return t
    case 'Sine':
      return 1 - Math.cos((t * Math.PI) / 2)
    case 'Quad':
      return t * t
    case 'Cubic':
      return t * t * t
    case 'Quart':
      return t ** 4
    case 'Quint':
      return t ** 5
    case 'Exponential':
      return t <= 0 ? 0 : Math.pow(2, 10 * t - 10)
    case 'Circular':
      return 1 - Math.sqrt(Math.max(0, 1 - t * t))
    case 'Back':
      return (BACK + 1) * t * t * t - BACK * t * t
    case 'Elastic':
      return t <= 0 ? 0 : t >= 1 ? 1 : -Math.pow(2, 10 * t - 10) * Math.sin((t * 10 - 10.75) * ((2 * Math.PI) / 3))
    case 'Bounce':
      return 1 - bounceOut(1 - t)
  }
}

function bounceOut(t: number): number {
  const n = 7.5625
  const d = 2.75
  if (t < 1 / d) return n * t * t
  if (t < 2 / d) return n * (t -= 1.5 / d) * t + 0.75
  if (t < 2.5 / d) return n * (t -= 2.25 / d) * t + 0.9375
  return n * (t -= 2.625 / d) * t + 0.984375
}

// TweenService:GetValue(alpha, style, direction).
export function easeValue(style: EasingStyle, direction: EasingDirection, alpha: number): number {
  const t = Math.max(0, Math.min(1, alpha))
  if (direction === 'In') return easeIn(style, t)
  if (direction === 'Out') return 1 - easeIn(style, 1 - t)
  if (style === 'Back') {
    const c2 = BACK * 1.525
    return t < 0.5 ? (Math.pow(2 * t, 2) * ((c2 + 1) * 2 * t - c2)) / 2 : (Math.pow(2 * t - 2, 2) * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2
  }
  if (style === 'Elastic') {
    if (t <= 0) return 0
    if (t >= 1) return 1
    const c5 = (2 * Math.PI) / 4.5
    return t < 0.5 ? -(Math.pow(2, 20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2 : (Math.pow(2, -20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1
  }
  return t < 0.5 ? easeIn(style, 2 * t) / 2 : 1 - easeIn(style, 2 - 2 * t) / 2
}

export type Ease = { style: EasingStyle; direction: EasingDirection } | { curve: NumKey[] }

// "Style.Direction" (or "Style", direction Out; any case; an "Enum.EasingStyle." prefix is
// ignored) or a NumberSequence curve; anything else -> the fallback (Quad.Out).
export function parseEase(v: VfxAttrValue | undefined, fallback: Ease = { style: 'Quad', direction: 'Out' }): Ease {
  const curve = attrSequence(v)
  if (curve) return { curve }
  if (typeof v !== 'string' || !v.trim()) return fallback
  const parts = v
    .trim()
    .replace(/^Enum\.EasingStyle\./i, '')
    .split(/[.\s_/-]+|(?<=[a-z])(?=(?:In|Out|InOut)$)/)
    .filter(Boolean)
  const style = EASING_STYLES.find((s) => s.toLowerCase() === (parts[0] ?? '').toLowerCase())
  if (!style) return fallback
  const dirRaw = parts.slice(1).join('').replace(/^Enum\.EasingDirection\.?/i, '').toLowerCase()
  const direction = dirRaw ? EASING_DIRECTIONS.find((d) => d.toLowerCase() === dirRaw) : 'Out'
  return direction ? { style, direction } : fallback
}

export function easeText(e: Ease): string {
  return 'curve' in e ? 'curve' : `${e.style}.${e.direction}`
}

// Eased progress for linear progress alpha (0..1). Curves may leave 0..1 (overshoot).
export function applyEase(e: Ease, alpha: number): number {
  const t = Math.max(0, Math.min(1, alpha))
  return 'curve' in e ? evalNumberSequence(e.curve, t) : easeValue(e.style, e.direction, t)
}

// ------------------------------------------------------------------ inheritance

export interface EmitAttrs {
  count?: number
  delay: number
  duration?: number
}

interface Inherited {
  delay: number
  // Own value else the nearest ancestor's.
  vals: Partial<Record<'EmitCount' | 'EmitDuration' | 'Rate' | 'FadeOut', number>>
  // Some timing attribute (EmitDelay / EmitCount / EmitDuration) applies.
  timed: boolean
}

const ROOT: Inherited = { delay: 0, vals: {}, timed: false }

function inherit(n: VfxNode, up: Inherited): Inherited {
  const a = n.attrs ?? {}
  const here: Inherited = { delay: up.delay, vals: { ...up.vals }, timed: up.timed }
  const d = attrNumber(a.EmitDelay)
  if (d !== undefined) {
    here.delay += d
    here.timed = true
  }
  for (const k of ['EmitCount', 'EmitDuration', 'Rate', 'FadeOut'] as const) {
    const v = attrNumber(a[k])
    if (v !== undefined) {
      here.vals[k] = v
      if (k === 'EmitCount' || k === 'EmitDuration') here.timed = true
    }
  }
  return here
}

function emitAttrsOf(h: Inherited): EmitAttrs {
  const count = h.vals.EmitCount
  const duration = h.vals.EmitDuration
  return {
    delay: Math.max(0, Math.min(MAX_DELAY, h.delay)),
    ...(count !== undefined ? { count: Math.max(0, Math.min(10000, Math.round(count))) } : {}),
    ...(duration !== undefined && duration > 0 ? { duration: Math.min(MAX_DELAY, duration) } : {})
  }
}

// A Model / Folder holding BaseParts named Start and End (direct children).
export function meshEffectParts(n: VfxNode): { start: VfxNode; end: VfxNode } | null {
  if (n.className !== 'Model' && n.className !== 'Folder') return null
  const start = n.children.find((c) => c.name === 'Start' && PART_CLASSES.has(c.className))
  const end = n.children.find((c) => c.name === 'End' && PART_CLASSES.has(c.className))
  return start && end ? { start, end } : null
}

// Ids of the Start / End template subtrees (never drawn themselves).
export function templateIds(roots: VfxNode[]): Set<string> {
  const out = new Set<string>()
  const all = (n: VfxNode) => {
    out.add(n.id)
    n.children.forEach(all)
  }
  const walk = (n: VfxNode) => {
    const me = meshEffectParts(n)
    if (me) {
      all(me.start)
      all(me.end)
    }
    for (const c of n.children) if (!me || (c !== me.start && c !== me.end)) walk(c)
  }
  roots.forEach(walk)
  return out
}

// ------------------------------------------------------------------ plan types

export interface PlanLayer {
  id: string
  name: string
  className: string
  kind: LayerKind
  node: VfxNode
  // Attribute-driven (its cues come from the attributes); riding layers without attributes keep
  // their authored Enabled state for the copy's life.
  driven: boolean
  attrs: EmitAttrs
  fadeOut?: number
  // emit / enable / disable cues, absolute seconds (the emitter starts disabled: a disable at its
  // start when it was Enabled).
  cues: VfxCue[]
  windows: [number, number][]
  bursts: { at: number; count: number }[]
  // FadeOut ramp [from, to] (visibility goes 1 -> 0 linearly).
  fade?: [number, number]
}

export interface MeshCopy {
  index: number
  spawn: number
  life: number
  death: number
  // Degrees: path tilt (X, Y) and extra rotation (X, Y, Z) at the pivot.
  spread: Vec2
  rot: Vec3
  riding: PlanLayer[]
}

export interface MeshEffectPlan {
  id: string
  name: string
  node: VfxNode
  start: VfxNode
  end: VfxNode
  pivot: CFrameArr
  attrs: EmitAttrs & { rate: number }
  lifetime: NumberRange
  ease: { cframe: Ease; size: Ease; transparency: Ease; color: Ease }
  spreadAngle: Vec2
  minRot: Vec3
  maxRot: Vec3
  spin: Vec3
  sync: boolean
  copies: MeshCopy[]
}

export interface EmitPlan {
  // Attribute-driven layers outside mesh-effect templates.
  layers: PlanLayer[]
  meshEffects: MeshEffectPlan[]
  duration: number
  linger: number
  // Anything here for the plan to drive (attribute-driven layers or a mesh effect).
  driven: boolean
}

function round(x: number): number {
  return Math.round(x * 1000) / 1000
}

// The attribute cues of one layer (the old cuesFromAttributes body), shifted by `offset`.
function attrCues(n: VfxNode, a: EmitAttrs, offset = 0): VfxCue[] {
  const cues: VfxCue[] = []
  const at = (x: number) => round(offset + x)
  const startsOn = prop<boolean>(n, 'Enabled') !== false
  if (n.className !== 'ParticleEmitter') {
    if (startsOn && (a.delay > 0 || a.duration)) cues.push({ at: at(0), target: n.id, action: 'disable' })
    cues.push({ at: at(a.delay), target: n.id, action: 'enable' })
    if (a.duration) cues.push({ at: at(a.delay + a.duration), target: n.id, action: 'disable' })
    return cues
  }
  if (startsOn) cues.push({ at: at(0), target: n.id, action: 'disable' })
  const rate = prop<number>(n, 'Rate') || 0
  if (a.duration && rate <= 0 && a.count) {
    const steps = Math.max(1, Math.min(60, a.count, Math.round(a.duration * 30)))
    let sent = 0
    for (let i = 0; i < steps; i++) {
      const want = Math.round(((i + 1) * a.count) / steps)
      if (want > sent) cues.push({ at: at(a.delay + (i * a.duration) / steps), target: n.id, action: 'emit', count: want - sent })
      sent = want
    }
    return cues
  }
  if (a.count) cues.push({ at: at(a.delay), target: n.id, action: 'emit', count: a.count })
  if (a.duration) {
    cues.push({ at: at(a.delay), target: n.id, action: 'enable' })
    cues.push({ at: at(a.delay + a.duration), target: n.id, action: 'disable' })
  } else if (a.count === undefined) {
    cues.push({ at: at(a.delay), target: n.id, action: 'emit', count: Math.max(8, Math.round(rate * 0.25)) })
  }
  return cues
}

// On windows over [from, end] from the authored Enabled state and the cues.
function windowsOf(n: VfxNode, cues: VfxCue[], from: number, end: number): [number, number][] {
  let on = prop<boolean>(n, 'Enabled') !== false
  let since = from
  const out: [number, number][] = []
  for (const c of [...cues].sort((a, b) => a.at - b.at)) {
    if (c.at > end) break
    if (c.action === 'enable' && !on) (on = true), (since = c.at)
    else if (c.action === 'disable' && on) {
      on = false
      if (c.at > since) out.push([since, c.at])
    }
  }
  if (on && end > since) out.push([since, end])
  return out
}

function finishLayer(l: PlanLayer, from: number, end: number): PlanLayer {
  l.cues = l.cues.filter((c) => c.at <= end)
  l.windows = windowsOf(l.node, l.cues, from, end)
  l.bursts = l.cues.filter((c) => c.action === 'emit').map((c) => ({ at: c.at, count: c.count ?? 16 }))
  if (l.fadeOut && l.fadeOut > 0 && l.kind !== 'emitter' && l.windows.length) {
    const [s, e] = l.windows[l.windows.length - 1]
    l.fade = [round(Math.max(s, e - l.fadeOut)), e]
  }
  return l
}

function makeLayer(n: VfxNode, h: Inherited, offset: number, riding: boolean): PlanLayer | null {
  const kind = layerKind(n.className)
  if (!kind) return null
  const fadeOut = kind !== 'emitter' ? h.vals.FadeOut : undefined
  const driven = h.timed || (fadeOut !== undefined && fadeOut > 0)
  if (!driven && !riding) return null
  const attrs = emitAttrsOf(h)
  return {
    id: n.id,
    name: n.name,
    className: n.className,
    kind,
    node: n,
    driven,
    attrs,
    ...(fadeOut && fadeOut > 0 ? { fadeOut } : {}),
    cues: driven ? attrCues(n, attrs, offset) : [],
    windows: [],
    bursts: []
  }
}

// When an open window closes: explicit EmitDuration windows close themselves.
function openStart(l: PlanLayer): number | null {
  if (l.kind === 'emitter') return null
  const enables = l.cues.filter((c) => c.action === 'enable')
  if (!enables.length) return null
  return l.attrs.duration ? null : Math.max(...enables.map((c) => c.at))
}

function vec3(v: VfxAttrValue | undefined): Vec3 {
  const a = attrVec(v, 3)
  return a ? (a as Vec3) : [0, 0, 0]
}

function lastEmission(l: PlanLayer): number | null {
  let last: number | null = null
  for (const b of l.bursts) if (b.count > 0) last = Math.max(last ?? -Infinity, b.at)
  if (l.kind === 'emitter' && (prop<number>(l.node, 'Rate') || 0) > 0) for (const w of l.windows) last = Math.max(last ?? -Infinity, w[1])
  return last
}

// How long after `end` the layer's particles / trail segments stay visible.
function layerTail(l: PlanLayer): number {
  if (l.kind === 'emitter') {
    const last = lastEmission(l)
    const life = prop<NumberRange>(l.node, 'Lifetime') ?? [1, 1]
    return last === null ? -Infinity : last + Math.max(0, Number(life[1]) || 0)
  }
  if (l.kind === 'trail' && l.windows.length) return l.windows[l.windows.length - 1][1] + Math.max(0, prop<number>(l.node, 'Lifetime') || 0)
  return -Infinity
}

// ------------------------------------------------------------------ the plan

export function emitPlan(roots: VfxNode[], opts: { seed?: number } = {}): EmitPlan {
  const seed = opts.seed ?? 1
  const layers: PlanLayer[] = []
  const meshes: MeshEffectPlan[] = []
  let untimedOn = false

  const walk = (n: VfxNode, up: Inherited) => {
    const h = inherit(n, up)
    const l = makeLayer(n, h, 0, false)
    if (l) layers.push(l)
    else if (layerKind(n.className) && prop<boolean>(n, 'Enabled') !== false) untimedOn = true
    const me = meshEffectParts(n)
    if (me) meshes.push(meshPlan(n, me.start, me.end, h, seed))
    for (const c of n.children) if (!me || (c !== me.start && c !== me.end)) walk(c, h)
  }
  roots.forEach((r) => walk(r, ROOT))

  // Duration: every scheduled point (riding events end at their copy's death).
  let duration = 0
  for (const l of layers) {
    for (const c of l.cues) duration = Math.max(duration, c.at)
    const open = openStart(l)
    if (open !== null) duration = Math.max(duration, open + OPEN_MIN)
  }
  for (const m of meshes) for (const c of m.copies) duration = Math.max(duration, c.death)
  duration = round(duration)
  // Nothing timed but something plays on its own: one second.
  if (duration <= 0 && untimedOn) duration = OPEN_MIN

  for (const l of layers) {
    // Open windows close at Duration.
    if (openStart(l) !== null) l.cues.push({ at: duration, target: l.id, action: 'disable' })
    finishLayer(l, 0, duration)
  }
  let tail = duration
  for (const l of layers) tail = Math.max(tail, layerTail(l))
  for (const m of meshes) for (const c of m.copies) for (const l of c.riding) tail = Math.max(tail, layerTail(l))
  const driven = layers.length > 0 || meshes.length > 0
  return { layers, meshEffects: meshes, duration, linger: round(Math.max(0, tail - duration)), driven }
}

function meshPlan(n: VfxNode, start: VfxNode, end: VfxNode, h: Inherited, seed: number): MeshEffectPlan {
  const a = n.attrs ?? {}
  const base = emitAttrsOf(h)
  const count = h.vals.EmitCount !== undefined ? Math.max(0, Math.min(MAX_COPIES, Math.round(h.vals.EmitCount))) : 1
  const rate = Math.max(0, h.vals.Rate ?? 0)
  const life = attrRange(a.Lifetime) ?? [DEFAULT_LIFETIME, DEFAULT_LIFETIME]
  const ease = parseEase(a.Ease)
  const sp = attrVec(a.SpreadAngle, 2) ?? [0, 0]
  const plan: MeshEffectPlan = {
    id: n.id,
    name: n.name,
    node: n,
    start,
    end,
    pivot: cf(...((prop<number[]>(start, 'CFrame') ?? [0, 0, 0]).slice(0, 3) as Vec3)),
    attrs: { ...base, count, rate },
    lifetime: [Math.max(0, life[0]), Math.max(0, life[1])],
    ease: { cframe: parseEase(a.EaseCFrame, ease), size: parseEase(a.EaseSize, ease), transparency: parseEase(a.EaseTransparency, ease), color: parseEase(a.EaseColor, ease) },
    spreadAngle: [Math.abs(sp[0]), Math.abs(sp[1])],
    minRot: vec3(a.MinInitRot),
    maxRot: vec3(a.MaxInitRot),
    spin: vec3(a.Spin),
    sync: attrBool(a.SyncPosition) ?? false,
    copies: []
  }
  const times: number[] = []
  const D = base.duration ?? 0
  if (D > 0 && rate > 0) {
    for (let k = 0; k / rate < D - 1e-9 && times.length < MAX_COPIES; k++) for (let j = 0; j < count && times.length < MAX_COPIES; j++) times.push(base.delay + k / rate)
  } else if (D > 0) {
    for (let i = 0; i < count; i++) times.push(base.delay + (i * D) / count)
  } else for (let i = 0; i < count; i++) times.push(base.delay)

  times.forEach((spawn, index) => {
    const r = rng(hashSeed(seed, n.id, 'copy', index))
    const lifeK = plan.lifetime[0] + (plan.lifetime[1] - plan.lifetime[0]) * r()
    const spread: Vec2 = [(r() * 2 - 1) * plan.spreadAngle[0], (r() * 2 - 1) * plan.spreadAngle[1]]
    const rot: Vec3 = [0, 1, 2].map((i) => plan.minRot[i] + (plan.maxRot[i] - plan.minRot[i]) * r()) as Vec3
    const death = spawn + lifeK
    plan.copies.push({ index, spawn, life: lifeK, death, spread, rot, riding: ridingLayers(start, spawn, death) })
  })
  return plan
}

// The layers riding one copy (inheritance restarts at Start; times from the spawn; the copy's death
// closes everything).
function ridingLayers(start: VfxNode, spawn: number, death: number): PlanLayer[] {
  const out: PlanLayer[] = []
  const walk = (n: VfxNode, up: Inherited) => {
    const h = inherit(n, up)
    const l = makeLayer(n, h, spawn, true)
    if (l) {
      if (!l.driven && l.kind === 'emitter' && prop<boolean>(n, 'Enabled') === false) {
        // Never switched on: nothing to draw.
      } else {
        const ends = l.cues.length ? windowsOf(n, l.cues, spawn, death) : []
        const on = l.driven ? ends.length > 0 || l.cues.some((c) => c.action === 'emit') : prop<boolean>(n, 'Enabled') !== false
        if (on) out.push(finishLayer(l, spawn, death))
      }
    }
    for (const c of n.children) walk(c, h)
  }
  for (const c of start.children) walk(c, inherit(start, ROOT))
  return out
}

// Cues for the attribute-driven layers (what the importer stores on the effect).
export function cuesFromPlan(plan: EmitPlan): VfxCue[] {
  return plan.layers.flatMap((l) => l.cues)
}

// Length of one play for the preview loop: Duration + linger.
export function planLength(plan: EmitPlan): number {
  return round(plan.duration + plan.linger)
}

// ------------------------------------------------------------------ mesh copies over time

export interface MeshCopyState {
  alive: boolean
  age: number
  // Template space (the effect's own space; the placement maps it to the world).
  cframe: CFrameArr
  size: Vec3
  transparency: number
  color: Rgb
  // SpecialMesh under Start (and End): Scale, Offset, VertexColor.
  meshScale?: Vec3
  meshOffset?: Vec3
  meshVertexColor?: Vec3
  // Decal / Texture children by name.
  decals: Record<string, { transparency: number; color: Rgb }>
}

const lerpN = (a: number, b: number, t: number) => a + (b - a) * t
const lerpV = <T extends number[]>(a: T, b: T, t: number): T => a.map((x, i) => lerpN(x, b[i] ?? x, t)) as T
const D2R = Math.PI / 180

function specialOf(n: VfxNode): VfxNode | undefined {
  return n.children.find((c) => c.className === 'SpecialMesh')
}

// A copy's state at effect time t (alive within [spawn, death)).
export function meshCopyAt(m: MeshEffectPlan, copy: MeshCopy, t: number): MeshCopyState {
  const age = Math.max(0, Math.min(copy.life, t - copy.spawn))
  const alive = t >= copy.spawn && t < copy.death
  const alpha = copy.life > 0 ? age / copy.life : 1
  const eCf = applyEase(m.ease.cframe, alpha)
  const eSize = applyEase(m.ease.size, alpha)
  const eTr = applyEase(m.ease.transparency, alpha)
  const eCol = applyEase(m.ease.color, alpha)
  const S = m.start
  const E = m.end
  const sCf = prop<number[]>(S, 'CFrame') as CFrameArr
  const eCfr = prop<number[]>(E, 'CFrame') as CFrameArr
  const path = lerpCFrame(sCf, eCfr, eCf)
  const tilt = mul(anglesXYZ(copy.spread[0] * D2R, copy.spread[1] * D2R, 0), anglesXYZ(copy.rot[0] * D2R, copy.rot[1] * D2R, copy.rot[2] * D2R))
  const spin = anglesXYZ(m.spin[0] * D2R * age, m.spin[1] * D2R * age, m.spin[2] * D2R * age)
  const cframe = mul(mul(mul(mul(m.pivot, tilt), inverse(m.pivot)), path), spin)
  const st: MeshCopyState = {
    alive,
    age,
    cframe,
    size: lerpV(prop<number[]>(S, 'Size') as Vec3, prop<number[]>(E, 'Size') as Vec3, eSize).map((x) => Math.max(0.001, x)) as Vec3,
    transparency: lerpN(prop<number>(S, 'Transparency'), prop<number>(E, 'Transparency'), eTr),
    color: lerpV(prop<Rgb>(S, 'Color'), prop<Rgb>(E, 'Color'), eCol),
    decals: {}
  }
  const sm = specialOf(S)
  if (sm) {
    const em = specialOf(E) ?? sm
    st.meshScale = lerpV(prop<number[]>(sm, 'Scale') as Vec3, prop<number[]>(em, 'Scale') as Vec3, eSize)
    st.meshOffset = lerpV(prop<number[]>(sm, 'Offset') as Vec3, prop<number[]>(em, 'Offset') as Vec3, eCf)
    st.meshVertexColor = lerpV(prop<number[]>(sm, 'VertexColor') as Vec3, prop<number[]>(em, 'VertexColor') as Vec3, eCol)
  }
  for (const d of S.children) {
    if (d.className !== 'Decal' && d.className !== 'Texture') continue
    const other = E.children.find((c) => c.name === d.name && (c.className === 'Decal' || c.className === 'Texture')) ?? d
    st.decals[d.name] = { transparency: lerpN(prop<number>(d, 'Transparency'), prop<number>(other, 'Transparency'), eTr), color: lerpV(prop<Rgb>(d, 'Color3'), prop<Rgb>(other, 'Color3'), eCol) }
  }
  return st
}

// FadeOut visibility (1 = fully visible) of a layer at time t.
export function fadeAt(fade: [number, number] | undefined, t: number): number {
  if (!fade) return 1
  const [a, b] = fade
  if (t <= a) return 1
  if (t >= b || b <= a) return 0
  return 1 - (t - a) / (b - a)
}

// ------------------------------------------------------------------ authoring

// A new mesh effect: a shockwave ring that grows and fades (Start: a flat cylinder ring with a
// SpecialMesh; End: the same, 6x wider, fully transparent).
export function makeMeshEffect(id: (prefix: string) => string, opts: { name?: string; at?: Vec3; color?: Rgb } = {}): VfxNode {
  const at = opts.at ?? [0, 0, 0]
  const color = opts.color ?? [0.55, 0.85, 1]
  // Cylinders run along X: tilt it so the ring lies flat (axis up).
  const flat = (p: Vec3): CFrameArr => {
    const r = anglesXYZ(0, 0, Math.PI / 2)
    return [p[0], p[1], p[2], ...r.slice(3)]
  }
  const part = (name: string, size: Vec3, scale: Vec3, transparency: number): VfxNode => ({
    id: id(name),
    className: 'Part',
    name,
    props: { CFrame: flat(at), Size: size, Color: color, Transparency: transparency, Material: 'Neon', Shape: 'Cylinder', Anchored: true, CanCollide: false },
    children: [{ id: id(`${name}Mesh`), className: 'SpecialMesh', name: 'Mesh', props: { MeshType: 'Cylinder', Scale: scale }, children: [] }]
  })
  return {
    id: id('MeshFx'),
    className: 'Model',
    name: opts.name ?? 'Shockwave',
    props: {},
    attrs: { EmitCount: 1, Lifetime: [0.45, 0.55], Ease: 'Quad.Out', EaseTransparency: 'Sine.In' },
    children: [part('Start', [0.2, 1, 1], [1, 1, 1], 0.1), part('End', [0.2, 8, 8], [1, 1, 1], 1)]
  }
}
