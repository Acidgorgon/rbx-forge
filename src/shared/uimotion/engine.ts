// The motion model in TypeScript: the same state machine and springs as the Luau runtime compile.ts
// writes (RUNTIME_LUAU), stepped by dt. Used for the lab's timeline (scripted hover / press / release
// / leave), the browser preview, the critique's code checks, and the parity test against the Luau
// runtime in Lune. Pure.

import { stepSpring, type SpringParams, type SpringState } from './spring.ts'
import type { AppearEffect, DisappearEffect, EffectKind, FloatEffect, GlowEffect, HoverEffect, MotionEffect, MotionSpec, PopEffect, PressEffect, RippleEffect, ShineEffect, SquashEffect, TiltEffect } from './spec.ts'

export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export interface Ripple {
  x: number
  y: number
  // Diameter in px and opacity now.
  d: number
  a: number
}

// What the runtime writes to the element each frame.
export interface MotionValues {
  scale: number
  sx: number
  sy: number
  dx: number
  dy: number
  rot: number
  // UIGradient.Offset.X of the shine band (null: no sweep running).
  shine: number | null
  // 0..1+ glow intensity.
  glow: number
  // Multiplies the opacity of the element and its descendants.
  alpha: number
  ripples: Ripple[]
}

export const REST_VALUES: MotionValues = { scale: 1, sx: 1, sy: 1, dx: 0, dy: 0, rot: 0, shine: null, glow: 0, alpha: 1, ripples: [] }

type Fx = Partial<{ hover: HoverEffect; press: PressEffect; pop: PopEffect; squash: SquashEffect; shine: ShineEffect; glow: GlowEffect; ripple: RippleEffect; tilt: TiltEffect; float: FloatEffect; appear: AppearEffect; disappear: DisappearEffect }>

const spring = (): SpringState => ({ x: 0, v: 0 })
const DEFAULT_SPRING: SpringParams = { frequency: 4, damping: 1 }
const easeInOutQuad = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2)
const easeOutQuad = (t: number) => 1 - (1 - t) * (1 - t)
const clamp = (x: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, x))

interface TargetState {
  path: string
  fx: Fx
  hovered: boolean
  pressed: boolean
  rect: Rect | null
  time: number
  // visible | entering | hidden
  mode: 'visible' | 'entering' | 'hidden'
  modeTime: number
  scale: SpringState
  pop: SpringState
  squash: SpringState
  lift: SpringState
  rot: SpringState
  tx: SpringState
  ty: SpringState
  glow: SpringState
  enterY: SpringState
  alpha: number
  alphaFrom: number
  alphaTo: number
  alphaT: number
  alphaDur: number
  alphaDelay: number
  shineActive: boolean
  shineT: number
  shineNext: number
  ripples: { x: number; y: number; t: number; max: number }[]
}

export interface EngineOptions {
  // GuiService.ReducedMotionEnabled (only applied when the spec respects it).
  reduced?: boolean
}

// The springs and effects as they apply with reduced motion on: no decorative movement (float,
// tilt, idle shine, ripple, pop, squash), no overshoot, appear becomes a fade.
export function reducedEffects(effects: MotionEffect[]): MotionEffect[] {
  const out: MotionEffect[] = []
  for (const e of effects) {
    if (e.kind === 'float' || e.kind === 'tilt' || e.kind === 'ripple' || e.kind === 'pop' || e.kind === 'squash') continue
    if (e.kind === 'shine' && e.trigger === 'idle') continue
    const c = { ...e } as MotionEffect & { damping?: number }
    if ('damping' in c && typeof c.damping === 'number') c.damping = Math.max(1, c.damping)
    if (c.kind === 'appear') Object.assign(c, { fromScale: 1, fromY: 0 })
    if (c.kind === 'disappear') Object.assign(c, { toScale: 1, toY: 0 })
    if (c.kind === 'glow') Object.assign(c, { period: 0 })
    out.push(c)
  }
  return out
}

export class MotionEngine {
  readonly targets: TargetState[] = []
  readonly reduced: boolean

  constructor(spec: MotionSpec, opts: EngineOptions = {}) {
    this.reduced = !!opts.reduced && spec.reducedMotion === 'respect'
    for (const t of spec.targets) {
      const fx: Fx = {}
      for (const e of this.reduced ? reducedEffects(t.effects) : t.effects) (fx as Record<string, MotionEffect>)[e.kind] = e
      const s: TargetState = {
        path: t.path,
        fx,
        hovered: false,
        pressed: false,
        rect: null,
        time: 0,
        mode: 'visible',
        modeTime: 0,
        scale: { x: 1, v: 0 },
        pop: spring(),
        squash: spring(),
        lift: spring(),
        rot: spring(),
        tx: spring(),
        ty: spring(),
        glow: { x: fx.glow?.trigger === 'idle' ? 1 : 0, v: 0 },
        enterY: spring(),
        alpha: 1,
        alphaFrom: 1,
        alphaTo: 1,
        alphaT: 0,
        alphaDur: 0,
        alphaDelay: 0,
        shineActive: false,
        shineT: 0,
        shineNext: 0.6,
        ripples: []
      }
      this.targets.push(s)
      if (fx.appear) this.startAppear(s)
    }
  }

  private find(path: string): TargetState | undefined {
    return this.targets.find((t) => t.path === path)
  }

  private startAppear(s: TargetState): void {
    const a = s.fx.appear!
    s.mode = 'entering'
    s.modeTime = 0
    s.scale = { x: a.fromScale, v: 0 }
    s.enterY = { x: a.fromY, v: 0 }
    s.alpha = 0
    s.alphaFrom = 0
    s.alphaTo = 1
    s.alphaT = 0
    s.alphaDur = a.duration
    s.alphaDelay = a.delay
  }

  setRect(path: string, rect: Rect): void {
    const s = this.find(path)
    if (s) s.rect = rect
  }

  hover(path: string, on: boolean): void {
    const s = this.find(path)
    if (!s || s.hovered === on) return
    s.hovered = on
    if (on && s.fx.shine?.trigger === 'hover' && !s.shineActive) {
      s.shineActive = true
      s.shineT = 0
    }
    if (!on) {
      s.pressed = false
    }
  }

  // Pointer position in the same space as the rects (tilt, ripple origin).
  private mouse = { x: 0, y: 0 }
  move(x: number, y: number): void {
    this.mouse = { x, y }
  }

  press(path: string, on: boolean): void {
    const s = this.find(path)
    if (!s) return
    if (on) {
      if (s.pressed) return
      s.pressed = true
      const r = s.fx.ripple
      if (r && s.rect) {
        const lx = this.mouse.x - s.rect.x
        const ly = this.mouse.y - s.rect.y
        const far = Math.max(Math.hypot(lx, ly), Math.hypot(s.rect.w - lx, ly), Math.hypot(lx, s.rect.h - ly), Math.hypot(s.rect.w - lx, s.rect.h - ly))
        s.ripples.push({ x: lx, y: ly, t: 0, max: far * 2 })
      }
      return
    }
    if (!s.pressed) return
    s.pressed = false
    // A release after a press on the element is a click.
    const p = s.fx.pop
    if (p) s.pop.v += p.amount * 2 * Math.PI * p.frequency * Math.E
    if (s.fx.shine?.trigger === 'click') {
      s.shineActive = true
      s.shineT = 0
    }
  }

  // Effects.show / Effects.hide (appear / disappear transitions).
  play(kind: 'appear' | 'disappear'): void {
    for (const s of this.targets) {
      if (kind === 'appear' && s.fx.appear) this.startAppear(s)
      if (kind === 'disappear' && s.fx.disappear) {
        const d = s.fx.disappear
        s.mode = 'hidden'
        s.modeTime = 0
        s.alphaFrom = s.alpha
        s.alphaTo = 0
        s.alphaT = 0
        s.alphaDur = d.duration
        s.alphaDelay = 0
      }
    }
  }

  step(dt: number): void {
    for (const s of this.targets) this.stepTarget(s, dt)
  }

  private stepTarget(s: TargetState, dt: number): void {
    const fx = s.fx
    s.time += dt
    s.modeTime += dt
    // Appear: hold the start pose through the delay.
    const holding = s.mode === 'entering' && fx.appear && s.modeTime < fx.appear.delay
    if (s.mode === 'entering' && fx.appear && s.modeTime > fx.appear.delay + 2) s.mode = 'visible'
    // Scale
    let goal = 1
    let params: SpringParams = fx.hover ?? DEFAULT_SPRING
    if (s.pressed && fx.press) {
      goal = fx.press.scale
      params = fx.press
    } else if (s.hovered && fx.hover) goal = fx.hover.scale
    let yGoal = 0
    let yParams: SpringParams = fx.appear ?? DEFAULT_SPRING
    if (s.mode === 'entering' && fx.appear && !s.hovered && !s.pressed) params = fx.appear
    if (s.mode === 'hidden' && fx.disappear) {
      goal = fx.disappear.toScale
      params = { frequency: 1.2 / Math.max(0.05, fx.disappear.duration), damping: 1 }
      yGoal = fx.disappear.toY
      yParams = params
    }
    if (!holding) {
      s.scale = stepSpring(s.scale, goal, params, dt)
      s.enterY = stepSpring(s.enterY, yGoal, yParams, dt)
    }
    if (fx.pop) s.pop = stepSpring(s.pop, 0, fx.pop, dt)
    if (fx.squash) s.squash = stepSpring(s.squash, s.pressed ? fx.squash.amount : 0, fx.squash, dt)
    if (fx.hover) s.lift = stepSpring(s.lift, s.hovered && !s.pressed ? fx.hover.lift : 0, fx.hover, dt)
    if (fx.tilt) {
      let nx = 0
      let ny = 0
      if (s.hovered && s.rect && s.rect.w > 0 && s.rect.h > 0) {
        nx = clamp((this.mouse.x - (s.rect.x + s.rect.w / 2)) / (s.rect.w / 2), -1, 1)
        ny = clamp((this.mouse.y - (s.rect.y + s.rect.h / 2)) / (s.rect.h / 2), -1, 1)
      }
      s.rot = stepSpring(s.rot, nx * fx.tilt.angle, fx.tilt, dt)
      s.tx = stepSpring(s.tx, nx * fx.tilt.shift, fx.tilt, dt)
      s.ty = stepSpring(s.ty, ny * fx.tilt.shift, fx.tilt, dt)
    }
    if (fx.glow) s.glow = stepSpring(s.glow, fx.glow.trigger === 'idle' || s.hovered ? 1 : 0, fx.glow, dt)
    // Alpha tween (appear / disappear), linear after the delay.
    if (s.alphaDur > 0 && s.alpha !== s.alphaTo) {
      s.alphaT += dt
      const k = clamp((s.alphaT - s.alphaDelay) / s.alphaDur, 0, 1)
      s.alpha = s.alphaFrom + (s.alphaTo - s.alphaFrom) * k
    }
    // Shine
    const sh = fx.shine
    if (sh) {
      if (sh.trigger === 'idle' && !s.shineActive && s.time >= s.shineNext) {
        s.shineActive = true
        s.shineT = 0
        s.shineNext = s.time + sh.interval + sh.duration
      }
      if (s.shineActive) {
        s.shineT += dt
        if (s.shineT >= sh.duration) s.shineActive = false
      }
    }
    // Ripples
    if (fx.ripple) {
      for (const r of s.ripples) r.t += dt
      s.ripples = s.ripples.filter((r) => r.t < fx.ripple!.duration)
    }
  }

  values(path: string): MotionValues {
    const s = this.find(path)
    if (!s) return { ...REST_VALUES, ripples: [] }
    const fx = s.fx
    const fl = fx.float
    const floatY = fl ? -Math.sin((2 * Math.PI * s.time) / fl.period) * fl.amplitude : 0
    const floatR = fl && fl.rotate ? Math.cos((2 * Math.PI * s.time) / fl.period) * fl.rotate : 0
    const g = fx.glow
    const pulse = g && g.period > 0 ? 0.7 + 0.3 * Math.cos((2 * Math.PI * s.time) / g.period) : 1
    const sh = fx.shine
    return {
      scale: s.scale.x + s.pop.x,
      sx: 1 + s.squash.x,
      sy: 1 - s.squash.x,
      dx: s.tx.x,
      dy: -s.lift.x + s.ty.x + s.enterY.x + floatY,
      rot: s.rot.x + floatR,
      shine: sh && s.shineActive ? -1 + 2 * easeInOutQuad(clamp(s.shineT / sh.duration, 0, 1)) : null,
      glow: g ? clamp(s.glow.x, 0, 1.25) * pulse : 0,
      alpha: s.alpha,
      ripples: fx.ripple ? s.ripples.map((r) => ({ x: r.x, y: r.y, d: r.max * easeOutQuad(r.t / fx.ripple!.duration), a: fx.ripple!.opacity * (1 - r.t / fx.ripple!.duration) })) : []
    }
  }
}

// ---- scripted timeline (the lab's "timeline of state transitions")

export type TimelineEvent = { at: number; kind: 'enter' | 'leave' | 'down' | 'up' | 'appear' | 'disappear'; label?: string }

export interface TimelineSample {
  t: number
  values: MotionValues
}

export interface Timeline {
  duration: number
  dt: number
  events: TimelineEvent[]
  // State bands: idle / hover / pressed / hidden.
  states: { from: number; to: number; state: 'idle' | 'hover' | 'pressed' | 'hidden' }[]
  samples: TimelineSample[]
}

// The default script: appear, idle, hover in, press, release (click), hover out, idle, hide.
export function defaultScript(kinds: Set<EffectKind>): TimelineEvent[] {
  const out: TimelineEvent[] = []
  let t = 0
  if (kinds.has('appear')) {
    out.push({ at: 0, kind: 'appear', label: 'appear' })
    t = 0.8
  } else t = 0.3
  out.push({ at: t, kind: 'enter', label: 'hover' })
  out.push({ at: t + 0.7, kind: 'down', label: 'press' })
  out.push({ at: t + 0.95, kind: 'up', label: 'release' })
  out.push({ at: t + 1.8, kind: 'leave', label: 'leave' })
  if (kinds.has('disappear')) out.push({ at: t + 2.6, kind: 'disappear', label: 'hide' })
  return out
}

// Runs one target of a spec through a script (pointer at the element's centre right of middle, so
// tilt shows) and samples every frame.
export function simulate(spec: MotionSpec, path: string, script: TimelineEvent[], opts: { duration?: number; dt?: number; reduced?: boolean; rect?: Rect } = {}): Timeline {
  const dt = opts.dt ?? 1 / 60
  const last = script.reduce((m, e) => Math.max(m, e.at), 0)
  const duration = opts.duration ?? last + 1.2
  const eng = new MotionEngine(spec, { reduced: opts.reduced })
  const rect = opts.rect ?? { x: 0, y: 0, w: 200, h: 60 }
  eng.setRect(path, rect)
  eng.move(rect.x + rect.w * 0.8, rect.y + rect.h * 0.35)
  const events = [...script].sort((a, b) => a.at - b.at)
  const samples: TimelineSample[] = []
  const states: Timeline['states'] = []
  let state: 'idle' | 'hover' | 'pressed' | 'hidden' = 'idle'
  let since = 0
  let i = 0
  const setState = (t: number, next: typeof state) => {
    if (next === state) return
    if (t > since) states.push({ from: since, to: t, state })
    state = next
    since = t
  }
  for (let k = 0; k * dt <= duration + 1e-9; k++) {
    const t = k * dt
    while (i < events.length && events[i].at <= t + 1e-9) {
      const e = events[i++]
      if (e.kind === 'enter') (eng.hover(path, true), setState(e.at, 'hover'))
      else if (e.kind === 'leave') (eng.hover(path, false), setState(e.at, 'idle'))
      else if (e.kind === 'down') (eng.press(path, true), setState(e.at, 'pressed'))
      else if (e.kind === 'up') (eng.press(path, false), setState(e.at, 'hover'))
      else if (e.kind === 'appear') (eng.play('appear'), setState(e.at, 'idle'))
      else if (e.kind === 'disappear') (eng.play('disappear'), setState(e.at, 'hidden'))
    }
    samples.push({ t, values: eng.values(path) })
    eng.step(dt)
  }
  if (duration > since) states.push({ from: since, to: duration, state })
  return { duration, dt, events, states, samples }
}

// Time from an event until the scale has moved `fraction` of the way to where it settles
// (responsiveness check); null when nothing moves.
export function responseTime(tl: Timeline, eventKind: TimelineEvent['kind'], fraction = 0.5): number | null {
  const e = tl.events.find((x) => x.kind === eventKind)
  if (!e) return null
  const from = tl.samples.find((s) => s.t >= e.at)
  const next = tl.events.find((x) => x.at > e.at)
  const end = [...tl.samples].reverse().find((s) => s.t < (next?.at ?? tl.duration) - 1e-9)
  if (!from || !end) return null
  const v0 = from.values.scale * from.values.sy
  const v1 = end.values.scale * end.values.sy
  if (Math.abs(v1 - v0) < 0.004) return null
  for (const s of tl.samples) {
    if (s.t < e.at) continue
    const v = s.values.scale * s.values.sy
    if ((v - v0) / (v1 - v0) >= fraction) return s.t - e.at
  }
  return null
}

// Largest overshoot of the scale past where it settles after an event, as a fraction of the move.
export function overshootAfter(tl: Timeline, eventKind: TimelineEvent['kind']): number {
  const e = tl.events.find((x) => x.kind === eventKind)
  if (!e) return 0
  const next = tl.events.find((x) => x.at > e.at)
  const span = tl.samples.filter((s) => s.t >= e.at && s.t < (next?.at ?? tl.duration))
  if (span.length < 2) return 0
  const v0 = span[0].values.scale
  const v1 = span[span.length - 1].values.scale
  const move = v1 - v0
  if (Math.abs(move) < 0.004) return 0
  let worst = 0
  for (const s of span) worst = Math.max(worst, (s.values.scale - v1) / move)
  return Math.max(0, worst)
}
