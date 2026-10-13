// Tweens on the effect timeline: Roblox easing, which properties a tween can drive, and the value
// of a tweened property at any time (pure functions, so the preview can scrub and tests can check).
//
// Semantics follow TweenService (Creator Hub, TweenService and EasingStyle, read 2026-10-13):
//   - tweenable types are number, bool, CFrame, Color3, Vector2/3 and EnumItem; NumberSequence,
//     ColorSequence and NumberRange are not, so the Lab adds virtual properties that the runtime
//     module (runtime.ts, ForgeFX) drives with a NumberValue tween:
//       SizeScale  multiplies Size (ParticleEmitter), Width0/1 (Beam), WidthScale (Trail), Size (Part),
//                  Range (lights); on a Part or Attachment rig it scales everything under it.
//       Fade       0 = as authored, 1 = invisible: Transparency -> 1 - (1 - t) * (1 - Fade), lights'
//                  Brightness * (1 - Fade); on a rig it fades everything under it.
//       Color      a Color3 goal on a ParticleEmitter / Beam / Trail lerps every ColorSequence key
//                  toward that colour.
//   - "If two tweens attempt to modify the same property, the initial tween will be cancelled and
//     overwritten by the most recent tween": a later tween starts from the value at its start time.
//   - EasingDirection In / Out / InOut as in Robert Penner's equations (the curves on the
//     EasingStyle page); Back overshoot 1.70158, Elastic period 0.3.

import { fromHex } from './sequence.ts'
import type { CFrameArr, EasingDirection, EasingStyle, PropValue, Rgb, VfxCue, VfxEffect, VfxNode } from './types.ts'

export const EASING_STYLES: EasingStyle[] = ['Linear', 'Sine', 'Back', 'Quad', 'Quart', 'Quint', 'Bounce', 'Elastic', 'Exponential', 'Circular', 'Cubic']
export const EASING_DIRECTIONS: EasingDirection[] = ['In', 'Out', 'InOut']

function bounceOut(x: number): number {
  const n = 7.5625
  const d = 2.75
  if (x < 1 / d) return n * x * x
  if (x < 2 / d) return n * (x -= 1.5 / d) * x + 0.75
  if (x < 2.5 / d) return n * (x -= 2.25 / d) * x + 0.9375
  return n * (x -= 2.625 / d) * x + 0.984375
}

// The "In" curve of each style (0 -> 0, 1 -> 1).
function easeIn(style: EasingStyle, x: number): number {
  switch (style) {
    case 'Linear':
      return x
    case 'Sine':
      return 1 - Math.cos((x * Math.PI) / 2)
    case 'Back': {
      const s = 1.70158
      return x * x * ((s + 1) * x - s)
    }
    case 'Quad':
      return x * x
    case 'Cubic':
      return x * x * x
    case 'Quart':
      return x * x * x * x
    case 'Quint':
      return x * x * x * x * x
    case 'Bounce':
      return 1 - bounceOut(1 - x)
    case 'Elastic': {
      if (x <= 0 || x >= 1) return x <= 0 ? 0 : 1
      const p = 0.3
      return -Math.pow(2, 10 * (x - 1)) * Math.sin(((x - 1 - p / 4) * (2 * Math.PI)) / p)
    }
    case 'Exponential':
      return (Math.pow(2, 10 * x) - 1) / 1023
    case 'Circular':
      return 1 - Math.sqrt(Math.max(0, 1 - x * x))
    default:
      return x
  }
}

export function ease(style: EasingStyle = 'Quad', direction: EasingDirection = 'Out', x: number): number {
  const t = x <= 0 ? 0 : x >= 1 ? 1 : x
  if (direction === 'In') return easeIn(style, t)
  if (direction === 'Out') return 1 - easeIn(style, 1 - t)
  return t < 0.5 ? easeIn(style, t * 2) / 2 : 1 - easeIn(style, (1 - t) * 2) / 2
}

export function easingStyle(v: unknown): EasingStyle {
  const s = String(v ?? '').replace(/^Enum\.EasingStyle\./, '')
  return EASING_STYLES.find((k) => k.toLowerCase() === s.toLowerCase()) ?? 'Quad'
}

export function easingDirection(v: unknown): EasingDirection {
  const s = String(v ?? '').replace(/^Enum\.EasingDirection\./, '')
  return EASING_DIRECTIONS.find((k) => k.toLowerCase() === s.toLowerCase()) ?? 'Out'
}

// ------------------------------------------------------------------ tweenable properties

export type TweenKind = 'number' | 'vec3' | 'color3' | 'cframe' | 'tint'

const LIGHT = { Brightness: 'number', Range: 'number', Color: 'color3', Angle: 'number' } as const
const RIG = { SizeScale: 'number', Fade: 'number' } as const

export const TWEENABLE: Record<string, Record<string, TweenKind>> = {
  Attachment: { Position: 'vec3', CFrame: 'cframe', ...RIG },
  Part: { Position: 'vec3', CFrame: 'cframe', Size: 'vec3', Transparency: 'number', Color: 'color3', ...RIG },
  MeshPart: { Position: 'vec3', CFrame: 'cframe', Size: 'vec3', Transparency: 'number', Color: 'color3', ...RIG },
  ParticleEmitter: { Rate: 'number', LightEmission: 'number', LightInfluence: 'number', Brightness: 'number', Drag: 'number', TimeScale: 'number', ZOffset: 'number', Acceleration: 'vec3', Color: 'tint', ...RIG },
  Beam: { Width0: 'number', Width1: 'number', CurveSize0: 'number', CurveSize1: 'number', LightEmission: 'number', Brightness: 'number', TextureSpeed: 'number', TextureLength: 'number', Color: 'tint', ...RIG },
  Trail: { LightEmission: 'number', Brightness: 'number', MaxLength: 'number', MinLength: 'number', Color: 'tint', ...RIG },
  PointLight: { ...LIGHT, ...RIG },
  SpotLight: { ...LIGHT, ...RIG },
  SurfaceLight: { ...LIGHT, ...RIG },
  Highlight: { FillTransparency: 'number', OutlineTransparency: 'number', FillColor: 'color3', OutlineColor: 'color3', Fade: 'number' }
}

// Virtual properties (driven by ForgeFX at runtime, not real Roblox properties).
export const VIRTUAL_PROPS = new Set(['SizeScale', 'Fade'])

export function tweenKind(className: string, prop: string): TweenKind | null {
  return TWEENABLE[className]?.[prop] ?? null
}

export class TimelineError extends Error {}

function num(x: unknown, what: string): number {
  const v = Number(x)
  if (!Number.isFinite(v)) throw new TimelineError(`${what}: expected a number, got ${JSON.stringify(x)}`)
  return v
}

// Raw goal (recorder JSON {__t:"v3"...}, plain arrays, "#hex") -> normalised PropValue.
export function normalizeGoal(className: string, prop: string, raw: unknown): PropValue {
  const kind = tweenKind(className, prop)
  const what = `${className}.${prop}`
  if (!kind) {
    const ok = Object.keys(TWEENABLE[className] ?? {})
    throw new TimelineError(`${what} cannot be tweened${ok.length ? ` (tweenable: ${ok.join(', ')})` : ''}`)
  }
  const o = raw as Record<string, unknown> | null
  const tag = o && typeof o === 'object' && !Array.isArray(o) ? o.__t : undefined
  switch (kind) {
    case 'number':
      if (typeof raw === 'boolean') return raw ? 1 : 0
      return num(raw, what)
    case 'vec3': {
      if (tag === 'v3') return [num(o!.x, what), num(o!.y, what), num(o!.z, what)]
      if (Array.isArray(raw) && raw.length >= 3) return raw.slice(0, 3).map((v) => num(v, what))
      if (tag === 'cf' && Array.isArray(o!.c)) return (o!.c as number[]).slice(0, 3).map((v) => num(v, what))
      throw new TimelineError(`${what}: expected a Vector3`)
    }
    case 'color3':
    case 'tint': {
      if (tag === 'c3') return [num(o!.r, what), num(o!.g, what), num(o!.b, what)]
      if (typeof raw === 'string' && /^#?[0-9a-f]{6}$/i.test(raw.trim())) return fromHex(raw)
      if (Array.isArray(raw) && raw.length === 3) {
        const v = raw.map((c) => num(c, what))
        return v.some((c) => c > 1) ? v.map((c) => c / 255) : v
      }
      throw new TimelineError(`${what}: expected a Color3 or "#rrggbb"`)
    }
    case 'cframe': {
      if (tag === 'cf' && Array.isArray(o!.c) && (o!.c as unknown[]).length === 12) return (o!.c as unknown[]).map((v) => num(v, what))
      if (tag === 'v3') return [num(o!.x, what), num(o!.y, what), num(o!.z, what), 1, 0, 0, 0, 1, 0, 0, 0, 1]
      if (Array.isArray(raw) && raw.length === 12) return raw.map((v) => num(v, what))
      if (Array.isArray(raw) && raw.length === 3) return [...raw.map((v) => num(v, what)), 1, 0, 0, 0, 1, 0, 0, 0, 1]
      throw new TimelineError(`${what}: expected a CFrame`)
    }
  }
}

// ------------------------------------------------------------------ interpolation

type Quat = [number, number, number, number]

function quatFromMatrix(c: CFrameArr): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = c.slice(3)
  const tr = m00 + m11 + m22
  let x: number, y: number, z: number, w: number
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    w = 0.25 * s
    x = (m21 - m12) / s
    y = (m02 - m20) / s
    z = (m10 - m01) / s
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    w = (m21 - m12) / s
    x = 0.25 * s
    y = (m01 + m10) / s
    z = (m02 + m20) / s
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    w = (m02 - m20) / s
    x = (m01 + m10) / s
    y = 0.25 * s
    z = (m12 + m21) / s
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    w = (m10 - m01) / s
    x = (m02 + m20) / s
    y = (m12 + m21) / s
    z = 0.25 * s
  }
  return [x, y, z, w]
}

function matrixFromQuat([x, y, z, w]: Quat): number[] {
  return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w), 2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w), 2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]
}

function slerp(a: Quat, b: Quat, t: number): Quat {
  let d = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
  let bb = b
  if (d < 0) {
    d = -d
    bb = [-b[0], -b[1], -b[2], -b[3]]
  }
  if (d > 0.9995) {
    const q: Quat = [a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t]
    const l = Math.hypot(...q) || 1
    return [q[0] / l, q[1] / l, q[2] / l, q[3] / l]
  }
  const th = Math.acos(d)
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb]
}

// CFrame:Lerp: position linearly, rotation along the shortest arc.
export function lerpCFrame(a: CFrameArr, b: CFrameArr, t: number): CFrameArr {
  const p = [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t)
  return [...p, ...matrixFromQuat(slerp(quatFromMatrix(a), quatFromMatrix(b), t))]
}

export function lerpValue(kind: TweenKind, a: PropValue, b: PropValue, t: number): PropValue {
  if (kind === 'number') return (a as number) + ((b as number) - (a as number)) * t
  if (kind === 'cframe') return lerpCFrame(a as CFrameArr, b as CFrameArr, t)
  const x = a as number[]
  const y = b as number[]
  return x.map((v, i) => v + ((y[i] ?? v) - v) * t)
}

// ------------------------------------------------------------------ tracks

export interface TweenSegment {
  at: number
  duration: number
  to: PropValue
  style: EasingStyle
  direction: EasingDirection
}

// Tint state of a ColorSequence: final colour = lerp(sequence colour, color, alpha).
export interface Tint {
  color: Rgb
  alpha: number
}

function sortedSegments(cues: VfxCue[], target: string, prop: string): TweenSegment[] {
  const out: TweenSegment[] = []
  cues.forEach((c, i) => {
    if (c.target !== target || (c.action !== 'tween' && c.action !== 'set') || !c.props || !(prop in c.props)) return
    out.push({ at: c.at, duration: c.action === 'set' ? 0 : Math.max(0, c.duration ?? 0), to: c.props[prop], style: c.style ?? 'Quad', direction: c.direction ?? 'Out', order: i } as TweenSegment & { order: number })
  })
  return out.sort((a, b) => a.at - b.at || (a as any).order - (b as any).order)
}

// Value of a property under a list of tween segments (later tweens take over from the current value).
export function trackValue(kind: TweenKind, base: PropValue, segs: TweenSegment[], t: number): PropValue {
  let from = base
  let cur: TweenSegment | null = null
  const at = (s: TweenSegment | null, f: PropValue, time: number): PropValue => {
    if (!s) return f
    if (s.duration <= 0 || time >= s.at + s.duration) return s.to
    return lerpValue(kind, f, s.to, ease(s.style, s.direction, (time - s.at) / s.duration))
  }
  for (const s of segs) {
    if (s.at > t) break
    from = at(cur, from, s.at)
    cur = s
  }
  return at(cur, from, t)
}

export function tintValue(segs: TweenSegment[], t: number): Tint {
  let state: Tint = { color: [1, 1, 1], alpha: 0 }
  let cur: TweenSegment | null = null
  const at = (s: TweenSegment | null, st: Tint, time: number): Tint => {
    if (!s) return st
    const e = s.duration <= 0 || time >= s.at + s.duration ? 1 : ease(s.style, s.direction, (time - s.at) / s.duration)
    const c = s.to as Rgb
    // lerp(lerp(S, tc, ta), c, e) == lerp(S, X, A) with A = 1 - (1 - ta)(1 - e).
    const A = 1 - (1 - st.alpha) * (1 - e)
    if (A <= 1e-6) return { color: c, alpha: 0 }
    const X = [0, 1, 2].map((i) => (st.color[i] * st.alpha * (1 - e) + c[i] * e) / A) as Rgb
    return { color: X, alpha: A }
  }
  for (const s of segs) {
    if (s.at > t) break
    state = at(cur, state, s.at)
    cur = s
  }
  return at(cur, state, t)
}

export function applyTint(c: Rgb, tint: Tint | null): Rgb {
  if (!tint || tint.alpha <= 0) return c
  return [c[0] + (tint.color[0] - c[0]) * tint.alpha, c[1] + (tint.color[1] - c[1]) * tint.alpha, c[2] + (tint.color[2] - c[2]) * tint.alpha]
}

// Every tween track of an effect, plus the parent links for rig-wide SizeScale / Fade.
export class Timeline {
  readonly tracks = new Map<string, Map<string, TweenSegment[]>>()
  private parent = new Map<string, string | null>()
  private nodes = new Map<string, VfxNode>()

  constructor(effect: Pick<VfxEffect, 'roots' | 'cues'>) {
    const walk = (n: VfxNode, p: string | null) => {
      this.parent.set(n.id, p)
      this.nodes.set(n.id, n)
      n.children.forEach((c) => walk(c, n.id))
    }
    effect.roots.forEach((r) => walk(r, null))
    for (const c of effect.cues) {
      if ((c.action !== 'tween' && c.action !== 'set') || !c.props) continue
      const m = this.tracks.get(c.target) ?? new Map<string, TweenSegment[]>()
      for (const prop of Object.keys(c.props)) if (!m.has(prop)) m.set(prop, sortedSegments(effect.cues, c.target, prop))
      this.tracks.set(c.target, m)
    }
  }

  has(id: string, prop: string): boolean {
    return !!this.tracks.get(id)?.get(prop)?.length
  }

  // Any tween on this node or its ancestors (rig SizeScale / Fade).
  animated(id: string): boolean {
    for (let cur: string | null | undefined = id; cur; cur = this.parent.get(cur)) if (this.tracks.has(cur)) return true
    return false
  }

  // A real or virtual property at time t; `base` is the authored value (virtuals: SizeScale 1, Fade 0).
  value<T extends PropValue>(id: string, prop: string, base: T, t: number): T {
    const segs = this.tracks.get(id)?.get(prop)
    if (!segs?.length) return base
    const node = this.nodes.get(id)
    const kind = (node && tweenKind(node.className, prop)) || 'number'
    if (kind === 'tint') return base
    return trackValue(kind, base, segs, t) as T
  }

  tint(id: string, t: number): Tint | null {
    const segs = this.tracks.get(id)?.get('Color')
    const node = this.nodes.get(id)
    if (!segs?.length || !node || tweenKind(node.className, 'Color') !== 'tint') return null
    return tintValue(segs, t)
  }

  // Product of SizeScale on the node and its ancestors.
  sizeScale(id: string, t: number): number {
    let s = 1
    for (let cur: string | null | undefined = id; cur; cur = this.parent.get(cur)) if (this.tracks.has(cur)) s *= this.value(cur, 'SizeScale', 1, t)
    return Math.max(0, s)
  }

  // Combined Fade: 1 - prod(1 - fade) over the node and its ancestors.
  fade(id: string, t: number): number {
    let keep = 1
    for (let cur: string | null | undefined = id; cur; cur = this.parent.get(cur)) if (this.tracks.has(cur)) keep *= 1 - Math.max(0, Math.min(1, this.value(cur, 'Fade', 0, t)))
    return 1 - keep
  }
}

// ------------------------------------------------------------------ summary

// One line per stage and cue, for the agent (vfx_run_script) and the UI.
export function timelineSummary(effect: VfxEffect, maxLines = 60): string {
  const names = new Map<string, string>()
  const walk = (n: VfxNode) => {
    names.set(n.id, n.name)
    n.children.forEach(walk)
  }
  effect.roots.forEach(walk)
  const fmt = (x: number) => (Math.round(x * 100) / 100).toString()
  const short = (v: PropValue): string => {
    if (typeof v === 'number') return fmt(v)
    if (Array.isArray(v)) return `(${(v as number[]).slice(0, 3).map((x) => fmt(Number(x))).join(',')})`
    return String(v)
  }
  const rows: { at: number; text: string }[] = []
  for (const s of effect.stages ?? []) rows.push({ at: s.at, text: `== ${s.label} ==` })
  for (const c of effect.cues) {
    const n = names.get(c.target) ?? c.target
    if (c.action === 'emit') rows.push({ at: c.at, text: `emit ${n} ${c.count ?? 16}` })
    else if (c.action === 'enable' || c.action === 'disable') rows.push({ at: c.at, text: `${c.action} ${n}` })
    else {
      const goals = Object.entries(c.props ?? {}).map(([k, v]) => `${k}=${short(v)}`).join(' ')
      rows.push({ at: c.at, text: c.action === 'set' ? `set ${n} ${goals}` : `tween ${n} ${fmt(c.duration ?? 0)}s ${c.style ?? 'Quad'}/${c.direction ?? 'Out'} ${goals}` })
    }
  }
  rows.sort((a, b) => a.at - b.at || (a.text.startsWith('==') ? -1 : 0))
  const lines = rows.map((r) => `${fmt(r.at).padStart(5)}s  ${r.text}`)
  if (lines.length > maxLines) return [...lines.slice(0, maxLines), `... ${lines.length - maxLines} more`].join('\n')
  return lines.join('\n')
}
