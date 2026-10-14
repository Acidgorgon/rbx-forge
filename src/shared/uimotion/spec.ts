// UI Motion Lab effect specs: the data a motion stack is (JSON in the library, on the page and in the
// AI's answers), the effect library with each parameter's range (the page's sliders and the
// normaliser use the same table), built-in presets, and normalisation of anything that claims to be
// a spec (model output, imports, old entries). Pure.
//
// A spec is a list of targets (elements under the component root, by relative instance path, "" =
// the root) each with a stack of effects. compile.ts turns it into a client Luau module; engine.ts
// runs the same model in TypeScript (timeline, browser preview, critique checks).

export const MOTION_SPEC_VERSION = 1

export type EffectKind = 'hover' | 'press' | 'pop' | 'squash' | 'shine' | 'glow' | 'ripple' | 'tilt' | 'float' | 'appear' | 'disappear'
export const EFFECT_KINDS: readonly EffectKind[] = ['hover', 'press', 'pop', 'squash', 'shine', 'glow', 'ripple', 'tilt', 'float', 'appear', 'disappear']

export type Rgb = [number, number, number]

export interface HoverEffect {
  kind: 'hover'
  scale: number
  // Pixels the element rises while hovered (not pressed).
  lift: number
  frequency: number
  damping: number
}
export interface PressEffect {
  kind: 'press'
  scale: number
  frequency: number
  damping: number
}
export interface PopEffect {
  kind: 'pop'
  // Peak extra scale after a click (about this much with damping near 1).
  amount: number
  frequency: number
  damping: number
}
export interface SquashEffect {
  kind: 'squash'
  // Width grows and height shrinks by this fraction while pressed; release springs back (and stretches past when bouncy).
  amount: number
  frequency: number
  damping: number
}
export interface ShineEffect {
  kind: 'shine'
  trigger: 'hover' | 'idle' | 'click'
  duration: number
  // Seconds between sweeps (idle).
  interval: number
  // Band angle in degrees (UIGradient.Rotation).
  angle: number
  // Band width as a fraction of the element.
  width: number
  // 0..1 peak opacity of the band.
  intensity: number
  color: Rgb
}
export interface GlowEffect {
  kind: 'glow'
  trigger: 'hover' | 'idle'
  color: Rgb
  // Extra UIStroke thickness at full glow (px).
  thickness: number
  // 0..1 peak opacity of the glow stroke.
  opacity: number
  // Pulse period in seconds (0 = steady).
  period: number
  frequency: number
  damping: number
}
export interface RippleEffect {
  kind: 'ripple'
  color: Rgb
  duration: number
  opacity: number
}
export interface TiltEffect {
  kind: 'tilt'
  // Degrees of Rotation at the element's edge (2D: Roblox UI has no perspective).
  angle: number
  // Pixels the element leans toward the cursor.
  shift: number
  frequency: number
  damping: number
}
export interface FloatEffect {
  kind: 'float'
  // Pixels up and down.
  amplitude: number
  period: number
  // Degrees of sway (0 = none).
  rotate: number
}
export interface AppearEffect {
  kind: 'appear'
  // Starting scale and vertical offset (px, positive = from below).
  fromScale: number
  fromY: number
  duration: number
  delay: number
  frequency: number
  damping: number
}
export interface DisappearEffect {
  kind: 'disappear'
  toScale: number
  toY: number
  duration: number
}

export type MotionEffect = HoverEffect | PressEffect | PopEffect | SquashEffect | ShineEffect | GlowEffect | RippleEffect | TiltEffect | FloatEffect | AppearEffect | DisappearEffect

export interface MotionTarget {
  // Relative instance path under the component root ("" = the root, "Icon", "Content.Label").
  path: string
  effects: MotionEffect[]
}

export interface MotionSpec {
  version: number
  name: string
  // respect: GuiService.ReducedMotionEnabled drops decorative motion (float, tilt, idle shine, ripple,
  // overshoot); ignore: always full motion (not recommended).
  reducedMotion: 'respect' | 'ignore'
  targets: MotionTarget[]
}

// ---- parameter table (sliders + normalisation)

export interface NumParam {
  key: string
  label: string
  min: number
  max: number
  step: number
  unit?: string
}
export interface ChoiceParam {
  key: string
  label: string
  options: string[]
}
export interface ColorParam {
  key: string
  label: string
  color: true
}
export type EffectParam = NumParam | ChoiceParam | ColorParam

const F = (label = 'frequency'): NumParam => ({ key: 'frequency', label, min: 0.5, max: 12, step: 0.1, unit: 'Hz' })
const Z: NumParam = { key: 'damping', label: 'damping', min: 0.1, max: 2, step: 0.01 }

export interface EffectInfo {
  kind: EffectKind
  label: string
  // What it does, one line (library list, AI prompt).
  does: string
  // What Roblox objects it drives (compile notes, AI prompt).
  drives: string
  group: 'feedback' | 'accent' | 'ambient' | 'transition'
  params: EffectParam[]
  defaults: MotionEffect
}

export const EFFECT_LIBRARY: Record<EffectKind, EffectInfo> = {
  hover: {
    kind: 'hover',
    label: 'hover spring',
    does: 'grows (and lifts) while the cursor is over it, on a spring',
    drives: 'UIScale.Scale, Position offset',
    group: 'feedback',
    params: [{ key: 'scale', label: 'scale', min: 0.8, max: 1.3, step: 0.01 }, { key: 'lift', label: 'lift', min: 0, max: 12, step: 0.5, unit: 'px' }, F(), Z],
    defaults: { kind: 'hover', scale: 1.05, lift: 2, frequency: 4, damping: 0.7 }
  },
  press: {
    kind: 'press',
    label: 'press spring',
    does: 'shrinks while held down, springs back on release',
    drives: 'UIScale.Scale',
    group: 'feedback',
    params: [{ key: 'scale', label: 'scale', min: 0.7, max: 1.1, step: 0.01 }, F(), Z],
    defaults: { kind: 'press', scale: 0.94, frequency: 6, damping: 0.75 }
  },
  pop: {
    kind: 'pop',
    label: 'scale pop',
    does: 'a springy kick in scale on click',
    drives: 'UIScale.Scale',
    group: 'accent',
    params: [{ key: 'amount', label: 'amount', min: 0, max: 0.4, step: 0.01 }, F(), Z],
    defaults: { kind: 'pop', amount: 0.1, frequency: 5, damping: 0.45 }
  },
  squash: {
    kind: 'squash',
    label: 'click squash',
    does: 'squashes wide and short while pressed, stretches back on release',
    drives: 'Size (scale and offset multiplied)',
    group: 'accent',
    params: [{ key: 'amount', label: 'amount', min: 0, max: 0.3, step: 0.01 }, F(), Z],
    defaults: { kind: 'squash', amount: 0.08, frequency: 5, damping: 0.4 }
  },
  shine: {
    kind: 'shine',
    label: 'shine sweep',
    does: 'a light band sweeps across the face',
    drives: 'overlay Frame + UIGradient.Offset (Transparency band)',
    group: 'accent',
    params: [
      { key: 'trigger', label: 'trigger', options: ['hover', 'idle', 'click'] },
      { key: 'duration', label: 'duration', min: 0.15, max: 2, step: 0.05, unit: 's' },
      { key: 'interval', label: 'interval', min: 0.5, max: 10, step: 0.1, unit: 's' },
      { key: 'angle', label: 'angle', min: -80, max: 80, step: 1, unit: '°' },
      { key: 'width', label: 'width', min: 0.05, max: 0.5, step: 0.01 },
      { key: 'intensity', label: 'intensity', min: 0, max: 1, step: 0.01 },
      { key: 'color', label: 'color', color: true }
    ],
    defaults: { kind: 'shine', trigger: 'hover', duration: 0.55, interval: 3, angle: 20, width: 0.16, intensity: 0.45, color: [1, 1, 1] }
  },
  glow: {
    kind: 'glow',
    label: 'glow pulse',
    does: 'an outline glows in (and pulses) on hover or while idle',
    drives: 'UIStroke Thickness / Color / Transparency',
    group: 'accent',
    params: [
      { key: 'trigger', label: 'trigger', options: ['hover', 'idle'] },
      { key: 'color', label: 'color', color: true },
      { key: 'thickness', label: 'thickness', min: 0, max: 10, step: 0.5, unit: 'px' },
      { key: 'opacity', label: 'opacity', min: 0, max: 1, step: 0.01 },
      { key: 'period', label: 'pulse', min: 0, max: 4, step: 0.05, unit: 's' },
      F('fade freq'),
      Z
    ],
    defaults: { kind: 'glow', trigger: 'hover', color: [1, 0.85, 0.35], thickness: 3, opacity: 0.8, period: 1.2, frequency: 3, damping: 1 }
  },
  ripple: {
    kind: 'ripple',
    label: 'click ripple',
    does: 'a circle grows from the click point and fades',
    drives: 'child Frames with UICorner (ClipsDescendants while rippling)',
    group: 'accent',
    params: [{ key: 'color', label: 'color', color: true }, { key: 'duration', label: 'duration', min: 0.15, max: 1.5, step: 0.05, unit: 's' }, { key: 'opacity', label: 'opacity', min: 0, max: 1, step: 0.01 }],
    defaults: { kind: 'ripple', color: [1, 1, 1], duration: 0.45, opacity: 0.35 }
  },
  tilt: {
    kind: 'tilt',
    label: 'tilt to cursor',
    does: 'leans and turns slightly toward the cursor (2D: Roblox UI has no perspective)',
    drives: 'Rotation, Position offset',
    group: 'ambient',
    params: [{ key: 'angle', label: 'angle', min: 0, max: 15, step: 0.5, unit: '°' }, { key: 'shift', label: 'shift', min: 0, max: 12, step: 0.5, unit: 'px' }, F(), Z],
    defaults: { kind: 'tilt', angle: 3, shift: 3, frequency: 3, damping: 0.8 }
  },
  float: {
    kind: 'float',
    label: 'idle float',
    does: 'bobs gently up and down while idle',
    drives: 'Position offset, Rotation',
    group: 'ambient',
    params: [{ key: 'amplitude', label: 'amplitude', min: 0, max: 12, step: 0.5, unit: 'px' }, { key: 'period', label: 'period', min: 0.5, max: 8, step: 0.1, unit: 's' }, { key: 'rotate', label: 'sway', min: 0, max: 8, step: 0.5, unit: '°' }],
    defaults: { kind: 'float', amplitude: 3, period: 2.6, rotate: 0 }
  },
  appear: {
    kind: 'appear',
    label: 'appear',
    does: 'fades and springs in when shown',
    drives: 'UIScale, Position offset, descendants’ transparency',
    group: 'transition',
    params: [
      { key: 'fromScale', label: 'from scale', min: 0, max: 1.5, step: 0.01 },
      { key: 'fromY', label: 'from y', min: -60, max: 60, step: 1, unit: 'px' },
      { key: 'duration', label: 'fade', min: 0.05, max: 1.5, step: 0.05, unit: 's' },
      { key: 'delay', label: 'delay', min: 0, max: 1.5, step: 0.05, unit: 's' },
      F(),
      Z
    ],
    defaults: { kind: 'appear', fromScale: 0.85, fromY: 12, duration: 0.25, delay: 0, frequency: 3.5, damping: 0.7 }
  },
  disappear: {
    kind: 'disappear',
    label: 'disappear',
    does: 'fades and shrinks out when hidden (Effects.hide)',
    drives: 'UIScale, Position offset, descendants’ transparency',
    group: 'transition',
    params: [{ key: 'toScale', label: 'to scale', min: 0, max: 1.5, step: 0.01 }, { key: 'toY', label: 'to y', min: -60, max: 60, step: 1, unit: 'px' }, { key: 'duration', label: 'duration', min: 0.05, max: 1.5, step: 0.05, unit: 's' }],
    defaults: { kind: 'disappear', toScale: 0.9, toY: 8, duration: 0.18 }
  }
}

export function defaultEffect(kind: EffectKind): MotionEffect {
  return structuredClone(EFFECT_LIBRARY[kind].defaults)
}

// ---- normalisation

const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

function normColor(v: unknown, fallback: Rgb): Rgb {
  if (Array.isArray(v) && v.length >= 3 && v.every((x) => Number.isFinite(Number(x)))) {
    const c = v.slice(0, 3).map(Number)
    // Accept 0..255 too (models love it).
    const k = c.some((x) => x > 1) ? 255 : 1
    return c.map((x) => clamp(x / k, 0, 1)) as Rgb
  }
  if (typeof v === 'string') {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(v.trim())
    if (m) return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255]
  }
  return [...fallback] as Rgb
}

// One effect from untrusted input (null when the kind is unknown). Numbers are clamped to the slider
// ranges; missing fields take the defaults.
export function normalizeEffect(raw: unknown): MotionEffect | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  const kind = String(r.kind ?? r.type ?? '').toLowerCase() as EffectKind
  const info = EFFECT_LIBRARY[kind]
  if (!info) return null
  const out: Record<string, unknown> = { ...structuredClone(info.defaults) }
  for (const p of info.params) {
    const v = r[p.key]
    if (v === undefined) continue
    if ('color' in p) out[p.key] = normColor(v, (info.defaults as unknown as Record<string, Rgb>)[p.key])
    else if ('options' in p) out[p.key] = p.options.includes(String(v)) ? String(v) : out[p.key]
    else if (Number.isFinite(Number(v))) out[p.key] = Math.round(clamp(Number(v), p.min, p.max) / p.step) * p.step
  }
  // Float rounding noise from the step snap.
  for (const p of info.params) if (!('color' in p) && !('options' in p)) out[p.key] = Math.round((out[p.key] as number) * 1e4) / 1e4
  return out as unknown as MotionEffect
}

const PATH_RE = /^[^.\n]{1,80}(\.[^.\n]{1,80}){0,12}$/

export function normalizeSpec(raw: unknown, name = 'Motion'): MotionSpec {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const targets: MotionTarget[] = []
  const list = Array.isArray(r.targets) ? r.targets : Array.isArray(r.effects) ? [{ path: '', effects: r.effects }] : []
  for (const t of list.slice(0, 16)) {
    if (!t || typeof t !== 'object') continue
    const tt = t as Record<string, unknown>
    const path = typeof tt.path === 'string' ? tt.path.trim() : ''
    if (path && !PATH_RE.test(path)) continue
    const effects: MotionEffect[] = []
    for (const e of Array.isArray(tt.effects) ? tt.effects : []) {
      const n = normalizeEffect(e)
      // One of each kind per target (the last wins).
      if (!n) continue
      const i = effects.findIndex((x) => x.kind === n.kind)
      if (i >= 0) effects[i] = n
      else effects.push(n)
    }
    const prev = targets.find((x) => x.path === path)
    if (prev) for (const e of effects) prev.effects = [...prev.effects.filter((x) => x.kind !== e.kind), e]
    else targets.push({ path, effects })
  }
  const nm = typeof r.name === 'string' && r.name.trim() ? r.name.trim() : name
  return {
    version: MOTION_SPEC_VERSION,
    name: luauName(nm),
    reducedMotion: r.reducedMotion === 'ignore' ? 'ignore' : 'respect',
    targets
  }
}

// A Luau-friendly identifier from any name ("play button!" -> "PlayButton").
export function luauName(name: string, fallback = 'Motion'): string {
  const words = String(name ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let out = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  if (!out) out = fallback
  if (/^\d/.test(out)) out = `M${out}`
  return out.slice(0, 48)
}

export function effectsOf(spec: MotionSpec, path: string): MotionEffect[] {
  return spec.targets.find((t) => t.path === path)?.effects ?? []
}

// Every effect kind the spec uses (compile.ts emits only those parts of the runtime).
export function usedKinds(spec: MotionSpec): Set<EffectKind> {
  return new Set(spec.targets.flatMap((t) => t.effects.map((e) => e.kind)))
}

// Short text of a stack for prompts and memory ("hover 1.05 f4 z0.7 · press 0.94 ...").
export function describeSpec(spec: MotionSpec): string {
  return spec.targets
    .map((t) => `${t.path || '(root)'}: ${t.effects.map(describeEffect).join(' · ') || 'none'}`)
    .join('\n')
}

export function describeEffect(e: MotionEffect): string {
  const fz = 'frequency' in e ? ` f${e.frequency} z${e.damping}` : ''
  switch (e.kind) {
    case 'hover':
      return `hover x${e.scale} lift ${e.lift}px${fz}`
    case 'press':
      return `press x${e.scale}${fz}`
    case 'pop':
      return `pop +${e.amount}${fz}`
    case 'squash':
      return `squash ${e.amount}${fz}`
    case 'shine':
      return `shine on ${e.trigger} ${e.duration}s${e.trigger === 'idle' ? ` every ${e.interval}s` : ''} @${e.angle}°`
    case 'glow':
      return `glow on ${e.trigger} +${e.thickness}px${e.period ? ` pulse ${e.period}s` : ''}${fz}`
    case 'ripple':
      return `ripple ${e.duration}s`
    case 'tilt':
      return `tilt ${e.angle}° shift ${e.shift}px${fz}`
    case 'float':
      return `float ${e.amplitude}px / ${e.period}s${e.rotate ? ` sway ${e.rotate}°` : ''}`
    case 'appear':
      return `appear from x${e.fromScale} y${e.fromY} fade ${e.duration}s${fz}`
    case 'disappear':
      return `disappear to x${e.toScale} y${e.toY} ${e.duration}s`
  }
}

// ---- presets (compare view, AI starting points)

export interface MotionPreset {
  key: string
  label: string
  feel: string
  effects: MotionEffect[]
}

const fx = <K extends EffectKind>(kind: K, patch: Partial<Extract<MotionEffect, { kind: K }>> = {}): MotionEffect => ({ ...defaultEffect(kind), ...patch }) as MotionEffect

export const MOTION_PRESETS: MotionPreset[] = [
  { key: 'snappy', label: 'Snappy', feel: 'tight and quick: instant feedback, almost no overshoot', effects: [fx('hover', { scale: 1.04, lift: 1, frequency: 6, damping: 0.9 }), fx('press', { scale: 0.95, frequency: 9, damping: 0.95 })] },
  { key: 'bouncy', label: 'Bouncy', feel: 'playful: overshoots and settles, pops on click', effects: [fx('hover', { scale: 1.07, lift: 3, frequency: 3.5, damping: 0.45 }), fx('press', { scale: 0.9, frequency: 5, damping: 0.5 }), fx('pop', { amount: 0.12, frequency: 4.5, damping: 0.35 })] },
  { key: 'soft', label: 'Soft', feel: 'calm and smooth: slow, no overshoot', effects: [fx('hover', { scale: 1.03, lift: 2, frequency: 2.2, damping: 1 }), fx('press', { scale: 0.97, frequency: 4, damping: 1 }), fx('glow', { thickness: 2, opacity: 0.5, period: 0, frequency: 2 })] },
  { key: 'juicy', label: 'Juicy', feel: 'loud: shine, glow, ripple, squash, bounce (shop / reward buttons)', effects: [fx('hover', { scale: 1.06, lift: 2, frequency: 4, damping: 0.55 }), fx('press', { scale: 0.92, frequency: 7, damping: 0.6 }), fx('squash', { amount: 0.08 }), fx('shine', { trigger: 'idle', interval: 2.5 }), fx('glow', { period: 1.1 }), fx('ripple')] },
  { key: 'floaty', label: 'Floaty', feel: 'idle life: float and tilt toward the cursor (menus, cards)', effects: [fx('float'), fx('tilt'), fx('hover', { scale: 1.03, lift: 0, frequency: 3, damping: 0.8 })] }
]

export function presetSpec(key: string, path = '', name?: string): MotionSpec {
  const p = MOTION_PRESETS.find((x) => x.key === key) ?? MOTION_PRESETS[0]
  return normalizeSpec({ name: name ?? p.label, targets: [{ path, effects: structuredClone(p.effects) }] })
}
