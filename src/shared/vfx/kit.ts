// The building-block kit for scripted effects: fx:spawn(kind, opts) in a timeline script makes one
// of these parametric presets (orb, glow, sparks, smoke, shockwave, flash, beam, trail, debris,
// aura, charge, impact, slash, dust, light). Each preset is a small, layered Roblox rig with
// predictable instance names (<Name><Layer>, e.g. BlueGlow, BlueLight) so the script can tween and
// emit its layers, plus a "prelude" (state before it appears) and the cues that bring it in.
//
// Rigs only use built-in Roblox content (Neon / ForceField parts, rbxasset:// particle textures), so
// they look right in game without uploading assets; pass `texture` to use the library's own ids.
//
// Conventions: positions are studs relative to the effect's root (its pivot); -Z is forward (the
// root's LookVector), +Y is up. Sizes are studs.

import { cf, fromEuler, mul } from './cframe.ts'
import { normalizeSequence } from './sequence.ts'
import type { CFrameArr, ColorKey, EasingDirection, EasingStyle, NumKey, PropValue, Rgb, Vec3, VfxCue, VfxNode } from './types.ts'

export const SPARKLES = 'rbxasset://textures/particles/sparkles_main.dds'
export const SMOKE = 'rbxasset://textures/particles/smoke_main.dds'

export interface KitOpts {
  name?: string
  at?: Vec3
  parent?: string
  color?: Rgb
  color2?: Rgb
  size?: number
  count?: number
  rate?: number
  speed?: number
  duration?: number
  lifetime?: number
  width?: number
  // Beam end: an offset from the rig, or the name of another spawned rig (the beam follows it).
  to?: Vec3 | string
  arc?: number
  radius?: number
  tilt?: number
  spread?: number
  // Emission direction (NormalId) for sparks / smoke / glow: Top (default), Front (-Z, forward), Back, Left, Right, Bottom.
  facing?: 'Top' | 'Bottom' | 'Front' | 'Back' | 'Left' | 'Right'
  brightness?: number
  texture?: string
}

export const KIT_OPTION_KEYS = ['name', 'at', 'parent', 'color', 'color2', 'size', 'count', 'rate', 'speed', 'duration', 'lifetime', 'width', 'to', 'arc', 'radius', 'tilt', 'spread', 'facing', 'brightness', 'texture'] as const

// A cue relative to the spawn time; target is a node name inside the rig.
export interface KitCue {
  dt: number
  target: string
  action: VfxCue['action']
  count?: number
  props?: Record<string, PropValue>
  duration?: number
  style?: EasingStyle
  direction?: EasingDirection
}

export interface KitBuild {
  // 'part': a top-level Part rig (placed at `at`, or where `parent` is at spawn time);
  // 'attach': layers in an Attachment (follows `parent`, or sits in its own invisible rig part).
  mode: 'part' | 'attach'
  node: VfxNode
  // Nodes to add under other rigs (by rig name): beam ends, trail attachments.
  extras?: { parent: string; node: VfxNode }[]
  prelude: KitCue[]
  activate: KitCue[]
}

export interface KitDef {
  summary: string
  layers: string[]
  options: string
  build(name: string, o: KitOpts, id: (prefix: string) => string): KitBuild
}

// ------------------------------------------------------------------ helpers

const clamp01 = (x: number) => Math.max(0, Math.min(1, x))
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
const WHITE: Rgb = [1, 1, 1]
const r3 = (x: number) => Math.round(x * 1000) / 1000

function hot(c: Rgb): Rgb {
  return mix(c, WHITE, 0.55).map(r3) as Rgb
}

function deep(c: Rgb): Rgb {
  // Darker, a little more saturated: the falloff colour.
  const m = Math.max(...c)
  return c.map((v) => r3(clamp01((v - (m - v) * 0.4) * 0.6))) as Rgb
}

function nseq(...keys: [number, number, number?][]): NumKey[] {
  return normalizeSequence(keys.map(([t, v, e]) => (e ? { t, v: r3(v), e: r3(e) } : { t, v: r3(v) })))
}

function cseq(...colors: Rgb[]): ColorKey[] {
  return colors.map((c, i) => ({ t: colors.length === 1 ? 0 : i / (colors.length - 1), c: c.map(r3) as Rgb })).concat(colors.length === 1 ? [{ t: 1, c: colors[0].map(r3) as Rgb }] : [])
}

function emitter(id: string, name: string, props: Record<string, PropValue>): VfxNode {
  return { id, className: 'ParticleEmitter', name, props: { Enabled: false, ...props }, children: [], kit: 'layer' }
}

function attachment(id: string, name: string, at: Vec3 = [0, 0, 0], children: VfxNode[] = []): VfxNode {
  return { id, className: 'Attachment', name, props: { CFrame: cf(at[0], at[1], at[2]) }, children, kit: 'layer' }
}

function rigPart(id: string, name: string, at: Vec3, props: Record<string, PropValue> = {}, children: VfxNode[] = []): VfxNode {
  return {
    id,
    className: 'Part',
    name,
    props: { Size: [1, 1, 1], Transparency: 1, Anchored: true, CanCollide: false, CastShadow: false, CFrame: cf(at[0], at[1], at[2]), ...props },
    children,
    kit: 'rig'
  }
}

function light(id: string, name: string, color: Rgb, brightness: number, range: number): VfxNode {
  return { id, className: 'PointLight', name, props: { Enabled: false, Color: color.map(r3), Brightness: brightness, Range: Math.min(60, range), Shadows: false }, children: [], kit: 'layer' }
}

function tex(o: KitOpts, fallback: string): string {
  return o.texture ?? fallback
}

const on = (target: string, dt = 0): KitCue => ({ dt, target, action: 'enable' })
const off = (target: string, dt: number): KitCue => ({ dt, target, action: 'disable' })
const emit = (target: string, count: number, dt = 0): KitCue => ({ dt, target, action: 'emit', count: Math.max(1, Math.round(count)) })
const tween = (target: string, dt: number, duration: number, props: Record<string, PropValue>, style: EasingStyle = 'Quad', direction: EasingDirection = 'Out'): KitCue => ({ dt, target, action: 'tween', duration, props, style, direction })
const set = (target: string, props: Record<string, PropValue>, dt = 0): KitCue => ({ dt, target, action: 'set', props })

// ------------------------------------------------------------------ presets

function sparksLayer(id: string, name: string, c: Rgb, o: KitOpts, scale = 1): VfxNode {
  const s = o.speed ?? 18
  const k = (o.size ?? 1) * scale
  return emitter(id, name, {
    Rate: o.count ? 0 : o.rate ?? 40,
    Lifetime: [0.25, 0.55],
    Speed: [s * 0.55, s],
    SpreadAngle: [o.spread ?? 360, o.spread ?? 360],
    Drag: 3,
    Acceleration: [0, -12, 0],
    Size: nseq([0, 0.28 * k], [1, 0]),
    Squash: nseq([0, 1.3], [1, 0.4]),
    Transparency: nseq([0, 0], [0.7, 0.2], [1, 1]),
    Color: cseq(WHITE, hot(c), c),
    LightEmission: 1,
    Orientation: 'VelocityParallel',
    ...(o.facing ? { EmissionDirection: o.facing } : {}),
    Texture: tex(o, SPARKLES)
  })
}

function smokeLayer(id: string, name: string, o: KitOpts, burst: boolean): VfxNode {
  const s = o.size ?? 2
  const c = o.color2 ?? o.color ?? [0.23, 0.22, 0.26]
  return emitter(id, name, {
    Rate: burst ? 0 : o.rate ?? 12,
    Lifetime: [o.lifetime ?? 1.1, (o.lifetime ?? 1.1) * 1.5],
    Speed: [(o.speed ?? 3) * 0.4, o.speed ?? 3],
    SpreadAngle: [o.spread ?? 360, o.spread ?? 360],
    Drag: 2,
    Acceleration: [0, 1.5, 0],
    Size: nseq([0, 0.8 * s, 0.2 * s], [1, 2.6 * s, 0.4 * s]),
    Transparency: nseq([0, 1], [0.15, 0.5], [1, 1]),
    Color: cseq(c.map((v) => clamp01(v * 1.25)) as Rgb, c),
    LightEmission: 0,
    Rotation: [0, 360],
    RotSpeed: [-30, 30],
    ...(o.facing ? { EmissionDirection: o.facing } : {}),
    Texture: tex(o, SMOKE)
  })
}

function flashLayers(name: string, c: Rgb, o: KitOpts, id: (p: string) => string, d = o.size ?? 8): { nodes: VfxNode[]; cues: KitCue[] } {
  const dur = o.duration ?? 0.35
  const flash = emitter(id('n'), `${name}Flash`, {
    Rate: 0,
    Lifetime: [0.14, 0.2],
    Speed: [0, 0],
    Size: nseq([0, 0.35 * d], [0.25, d], [1, 1.15 * d]),
    Transparency: nseq([0, 0], [0.5, 0.35], [1, 1]),
    Color: cseq(WHITE, hot(c)),
    LightEmission: 1,
    ZOffset: 1.5,
    LockedToPart: true,
    Texture: tex(o, SPARKLES)
  })
  const lit = light(id('n'), `${name}Light`, c, o.brightness ?? 14, Math.max(8, d * 2.2))
  return {
    nodes: [flash, lit],
    cues: [emit(`${name}Flash`, o.count ?? 2), on(`${name}Light`), tween(`${name}Light`, 0, dur, { Brightness: 0 }, 'Quad', 'Out'), off(`${name}Light`, dur + 0.02)]
  }
}

export const KIT: Record<string, KitDef> = {
  orb: {
    summary: 'glowing energy ball (Neon sphere + core, glow, sparks emitters + PointLight); forms with a Back-out pop, follows when you tween it',
    layers: ['Core', 'Glow', 'Sparks', 'Light', 'Att'],
    options: 'color, color2, size (diameter, 1.6), at, rate (sparks), duration (form time, 0.35)',
    build(name, o, id) {
      const d = o.size ?? 1.6
      const c = o.color ?? [0.48, 0.36, 1]
      const c2 = o.color2 ?? deep(c)
      const att = attachment(id('att'), `${name}Att`, [0, 0, 0], [
        emitter(id('n'), `${name}Core`, { Rate: 30, Lifetime: [0.14, 0.24], Speed: [0, 0], Size: nseq([0, 0.85 * d], [1, 0.45 * d]), Transparency: nseq([0, 0.4], [1, 1]), Color: cseq(hot(c), c), LightEmission: 1, LockedToPart: true, ZOffset: 0.3, Rotation: [0, 360], Texture: tex(o, SPARKLES) }),
        emitter(id('n'), `${name}Glow`, { Rate: 18, Lifetime: [0.3, 0.45], Speed: [0, 0], Size: nseq([0, 1.5 * d], [0.5, 2.3 * d], [1, 1.6 * d]), Transparency: nseq([0, 0.72], [0.5, 0.6], [1, 1]), Color: cseq(c, c, c2), LightEmission: 1, LockedToPart: true, Rotation: [0, 360], RotSpeed: [-60, 60], Texture: tex(o, SPARKLES) }),
        emitter(id('n'), `${name}Sparks`, { Rate: o.rate ?? 26, Lifetime: [0.25, 0.45], Speed: [2.5, 5], SpreadAngle: [360, 360], Drag: 5, Size: nseq([0, 0.16 * d], [1, 0]), Squash: nseq([0, 1.2], [1, 0.5]), Transparency: nseq([0, 0], [1, 1]), Color: cseq(WHITE, c), LightEmission: 1, Orientation: 'VelocityParallel', Texture: tex(o, SPARKLES) }),
        light(id('n'), `${name}Light`, c, 3, 4 * d + 4)
      ])
      const part = rigPart(id('part'), name, o.at ?? [0, 0, 0], { Shape: 'Ball', Material: 'Neon', Size: [d, d, d].map(r3), Transparency: 0.05, Color: mix(c, WHITE, 0.2).map(r3) as Rgb }, [att])
      const form = o.duration ?? 0.35
      return {
        mode: 'part',
        node: part,
        prelude: [set(name, { Fade: 1, SizeScale: 0.15 })],
        activate: [on(`${name}Core`), on(`${name}Glow`), on(`${name}Sparks`), on(`${name}Light`), tween(name, 0, form, { Fade: 0, SizeScale: 1 }, 'Back', 'Out')]
      }
    }
  },
  glow: {
    summary: 'big soft additive glow that breathes in place (one emitter)',
    layers: ['Glow'],
    options: 'color, size (4), rate, at, parent',
    build(name, o, id) {
      const d = o.size ?? 4
      const c = o.color ?? [1, 0.8, 0.5]
      const g = emitter(id('n'), `${name}Glow`, { Rate: o.rate ?? 10, Lifetime: [0.4, 0.7], Speed: [0, 0], Size: nseq([0, 0.2 * d], [0.3, d], [1, 1.2 * d]), Transparency: nseq([0, 0.75], [0.4, 0.6], [1, 1]), Color: cseq(c, deep(c)), LightEmission: 1, LockedToPart: true, Rotation: [0, 360], Texture: tex(o, SPARKLES) })
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [g]), prelude: [], activate: [on(`${name}Glow`)] }
    }
  },
  sparks: {
    summary: 'fast streaking sparks (VelocityParallel + Squash); count = one burst, otherwise continuous',
    layers: ['Sparks'],
    options: 'color, count (burst), rate, speed (18), spread (360), facing, size, at, parent',
    build(name, o, id) {
      const c = o.color ?? [1, 0.75, 0.35]
      const s = sparksLayer(id('n'), `${name}Sparks`, c, o)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [s]), prelude: [], activate: [o.count ? emit(`${name}Sparks`, o.count) : on(`${name}Sparks`)] }
    }
  },
  smoke: {
    summary: 'soft dark smoke puffs (LightEmission 0); count = one burst, otherwise continuous',
    layers: ['Smoke'],
    options: 'color (or color2), count, rate (12), size (2), speed (3), lifetime, spread, facing, at, parent',
    build(name, o, id) {
      const s = smokeLayer(id('n'), `${name}Smoke`, o, !!o.count)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [s]), prelude: [], activate: [o.count ? emit(`${name}Smoke`, o.count) : on(`${name}Smoke`)] }
    }
  },
  shockwave: {
    summary: 'expanding ForceField shell that fades out (the merge / impact ring)',
    layers: [],
    options: 'color, size (final diameter, 14), duration (0.45), at, parent (spawns where the parent is)',
    build(name, o, id) {
      const d = o.size ?? 14
      const c = o.color ?? [0.7, 0.85, 1]
      const dur = o.duration ?? 0.45
      const part = rigPart(id('part'), name, o.at ?? [0, 0, 0], { Shape: 'Ball', Material: 'ForceField', Size: [0.6, 0.6, 0.6], Transparency: 0, Color: c.map(r3) })
      return {
        mode: 'part',
        node: part,
        prelude: [set(name, { Fade: 1 })],
        activate: [set(name, { Fade: 0 }), tween(name, 0, dur, { Size: [d, d, d] }, 'Quart', 'Out'), tween(name, dur * 0.25, dur * 0.75, { Fade: 1 }, 'Quad', 'In')]
      }
    }
  },
  flash: {
    summary: 'one-frame white-hot flash particle + PointLight spike that decays',
    layers: ['Flash', 'Light'],
    options: 'color, size (8), brightness (14), duration (light decay, 0.35), count (2), at, parent',
    build(name, o, id) {
      const c = o.color ?? [1, 0.9, 0.7]
      const f = flashLayers(name, c, o, id)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, f.nodes), prelude: [], activate: f.cues }
    }
  },
  beam: {
    summary: 'two-layer energy beam (wide glow + thin white core) from the rig to `to` (an offset, or another rig it follows)',
    layers: ['Beam', 'Core', 'A0', 'A1'],
    options: 'color, width (2), to (Vector3 offset or a handle), at, brightness, texture',
    build(name, o, id) {
      const w = o.width ?? 2
      const c = o.color ?? [0.6, 0.8, 1]
      const a0 = attachment(id('att'), `${name}A0`)
      const extras: KitBuild['extras'] = []
      let a1: VfxNode
      if (typeof o.to === 'string') {
        a1 = attachment(id('att'), `${name}A1`)
        extras.push({ parent: o.to, node: a1 })
      } else a1 = attachment(id('att'), `${name}A1`, o.to ?? [0, 0, -12])
      const beamProps = (width: number, colors: ColorKey[], transp: NumKey[]): Record<string, PropValue> => ({ Enabled: false, Attachment0: a0.id, Attachment1: a1.id, Width0: r3(width), Width1: r3(width * 0.7), Color: colors, Transparency: transp, LightEmission: 1, Brightness: o.brightness ?? 1.2, FaceCamera: true, Segments: 24, TextureSpeed: 2, TextureLength: 4, TextureMode: 'Wrap', ...(o.texture ? { Texture: o.texture } : {}) })
      const glow: VfxNode = { id: id('n'), className: 'Beam', name: `${name}Beam`, props: beamProps(w, cseq(c, deep(c)), nseq([0, 0.35], [0.85, 0.5], [1, 1])), children: [], kit: 'layer' }
      const core: VfxNode = { id: id('n'), className: 'Beam', name: `${name}Core`, props: beamProps(w * 0.32, cseq(WHITE, hot(c)), nseq([0, 0], [0.9, 0.1], [1, 1])), children: [], kit: 'layer' }
      const kids = typeof o.to === 'string' ? [a0, glow, core] : [a0, a1, glow, core]
      const part = rigPart(id('part'), name, o.at ?? [0, 0, 0], {}, kids)
      return { mode: 'part', node: part, extras, prelude: [set(name, { Fade: 1 })], activate: [on(`${name}Beam`), on(`${name}Core`), tween(name, 0, 0.08, { Fade: 0 }, 'Linear', 'Out')] }
    }
  },
  trail: {
    summary: 'Trail riding on a moving rig (parent required): a streak behind whatever you tween',
    layers: ['A0', 'A1'],
    options: 'parent (required), color, width (1.4), lifetime (0.35), texture',
    build(name, o, id) {
      if (!o.parent) throw new Error('trail needs parent = the rig it follows (e.g. an orb handle)')
      const w = o.width ?? 1.4
      const c = o.color ?? [0.8, 0.85, 1]
      const a0 = attachment(id('att'), `${name}A0`, [0, w / 2, 0])
      const a1 = attachment(id('att'), `${name}A1`, [0, -w / 2, 0])
      const trail: VfxNode = {
        id: id('n'),
        className: 'Trail',
        name,
        props: { Enabled: false, Attachment0: a0.id, Attachment1: a1.id, Lifetime: o.lifetime ?? 0.35, Color: cseq(hot(c), c, deep(c)), Transparency: nseq([0, 0.15], [0.6, 0.5], [1, 1]), WidthScale: nseq([0, 1], [1, 0.1]), LightEmission: 1, FaceCamera: true, MinLength: 0.05, ...(o.texture ? { Texture: o.texture } : {}) },
        children: [],
        kit: 'layer'
      }
      return { mode: 'attach', node: trail, extras: [{ parent: o.parent, node: a0 }, { parent: o.parent, node: a1 }, { parent: o.parent, node: trail }], prelude: [], activate: [on(name)] }
    }
  },
  debris: {
    summary: 'rock chunks thrown up and falling with gravity (+ a dust puff); one burst',
    layers: ['Debris', 'Dust'],
    options: 'color2 (rock colour), count (24), speed (22), size (1), spread (55), at, parent',
    build(name, o, id) {
      const s = o.speed ?? 22
      const k = o.size ?? 1
      const rock = o.color2 ?? o.color ?? [0.25, 0.22, 0.2]
      const debris = emitter(id('n'), `${name}Debris`, {
        Rate: 0,
        Lifetime: [0.9, 1.4],
        Speed: [s * 0.5, s],
        SpreadAngle: [o.spread ?? 55, o.spread ?? 55],
        Acceleration: [0, -70, 0],
        Drag: 0.4,
        Size: nseq([0, 0.45 * k, 0.15 * k], [0.85, 0.4 * k, 0.12 * k], [1, 0]),
        Transparency: nseq([0, 0], [0.85, 0], [1, 1]),
        Color: cseq(rock.map((v) => clamp01(v * 1.3)) as Rgb, rock),
        LightEmission: 0,
        LightInfluence: 1,
        Rotation: [0, 360],
        RotSpeed: [-320, 320],
        Texture: tex(o, SPARKLES)
      })
      const dust = smokeLayer(id('n'), `${name}Dust`, { ...o, color2: [0.42, 0.38, 0.34], size: 1.4 * k, speed: 6, lifetime: 0.8, spread: 70 }, true)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [debris, dust]), prelude: [], activate: [emit(`${name}Debris`, o.count ?? 24), emit(`${name}Dust`, Math.max(4, Math.round((o.count ?? 24) / 3)))] }
    }
  },
  aura: {
    summary: 'rising flame-like aura around a body-sized volume, plus floating specks; continuous',
    layers: ['Aura', 'Specks'],
    options: 'color, color2, size (1), rate (24), at',
    build(name, o, id) {
      const c = o.color ?? [0.5, 0.75, 1]
      const s = o.size ?? 1
      const aura = emitter(id('n'), `${name}Aura`, { Rate: o.rate ?? 24, Lifetime: [0.6, 1], Speed: [2, 4], SpreadAngle: [20, 20], Acceleration: [0, 4, 0], Size: nseq([0, 0.5 * s], [0.4, 1.3 * s], [1, 0]), Squash: nseq([0, 0.6], [1, 1.2]), Transparency: nseq([0, 1], [0.2, 0.45], [1, 1]), Color: cseq(hot(c), c, o.color2 ?? deep(c)), LightEmission: 1, Texture: tex(o, SPARKLES) })
      const specks = emitter(id('n'), `${name}Specks`, { Rate: Math.round((o.rate ?? 24) * 0.8), Lifetime: [0.8, 1.3], Speed: [1, 3], SpreadAngle: [30, 30], Acceleration: [0, 5, 0], Size: nseq([0, 0.16 * s], [1, 0]), Transparency: nseq([0, 0], [1, 1]), Color: cseq(WHITE, c), LightEmission: 1, Texture: tex(o, SPARKLES) })
      const part = rigPart(id('part'), name, o.at ?? [0, -0.5, 0], { Size: [2.6 * s, 4.5 * s, 1.6 * s].map(r3) }, [aura, specks])
      return { mode: 'part', node: part, prelude: [], activate: [on(`${name}Aura`), on(`${name}Specks`)] }
    }
  },
  charge: {
    summary: 'energy streaks converging inward onto a point (anticipation / gathering); continuous',
    layers: ['Charge'],
    options: 'color, size (radius, 4), rate (60), at, parent (spawns where the parent is)',
    build(name, o, id) {
      const r = o.size ?? 4
      const c = o.color ?? [0.7, 0.85, 1]
      const ch = emitter(id('n'), `${name}Charge`, { Rate: o.rate ?? 60, Lifetime: [0.4, 0.5], Speed: [r * 1.7, r * 2.2], Shape: 'Sphere', ShapeStyle: 'Surface', ShapeInOut: 'Inward', Size: nseq([0, 0.14], [0.7, 0.24], [1, 0]), Squash: nseq([0, 2], [1, 1]), Transparency: nseq([0, 1], [0.25, 0], [1, 0.2]), Color: cseq(c, hot(c), WHITE), LightEmission: 1, Orientation: 'VelocityParallel', Texture: tex(o, SPARKLES) })
      const part = rigPart(id('part'), name, o.at ?? [0, 0, 0], { Shape: 'Ball', Size: [2 * r, 2 * r, 2 * r].map(r3) }, [ch])
      return { mode: 'part', node: part, prelude: [], activate: [on(`${name}Charge`)] }
    }
  },
  impact: {
    summary: 'hit burst: flash + light spike, spark spray and a smoke puff, all at once',
    layers: ['Flash', 'Light', 'Sparks', 'Smoke'],
    options: 'color, size (6), count (sparks, 30), speed, at, parent',
    build(name, o, id) {
      const c = o.color ?? [1, 0.8, 0.45]
      const f = flashLayers(name, c, { ...o, count: 2 }, id, o.size ?? 6)
      const sp = sparksLayer(id('n'), `${name}Sparks`, c, { ...o, count: o.count ?? 30, speed: o.speed ?? 26 })
      const sm = smokeLayer(id('n'), `${name}Smoke`, { ...o, color: undefined, color2: o.color2 ?? [0.25, 0.24, 0.27], size: (o.size ?? 6) / 4, speed: 5, lifetime: 0.9 }, true)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [...f.nodes, sp, sm]), prelude: [], activate: [...f.cues, emit(`${name}Sparks`, o.count ?? 30), emit(`${name}Smoke`, 8)] }
    }
  },
  slash: {
    summary: 'crescent sword slash: a Trail swept through an arc (rig CFrame tween) with sparks off the tip',
    layers: ['Trail', 'Sparks', 'A0', 'A1', 'Tip'],
    options: 'color, radius (4), width (1.6), arc (degrees, max 170, 150), tilt (degrees around forward, 0), duration (0.18), at, parent',
    build(name, o, id) {
      const r = o.radius ?? 4
      const w = Math.min(r, o.width ?? 1.6)
      const arc = (Math.min(170, Math.max(10, o.arc ?? 150)) * Math.PI) / 180
      const tilt = ((o.tilt ?? 0) * Math.PI) / 180
      const c = o.color ?? [0.65, 0.85, 1]
      const at = o.at ?? [0, 0, 0]
      const base = fromEuler(0, 0, tilt, at)
      const start: CFrameArr = mul(base, fromEuler(0, arc / 2, 0))
      const end: CFrameArr = mul(base, fromEuler(0, -arc / 2, 0))
      const a0 = attachment(id('att'), `${name}A0`, [0, 0, -(r - w)])
      const a1 = attachment(id('att'), `${name}A1`, [0, 0, -r])
      const trail: VfxNode = { id: id('n'), className: 'Trail', name: `${name}Trail`, props: { Enabled: false, Attachment0: a0.id, Attachment1: a1.id, Lifetime: 0.22, Color: cseq(hot(c), c, deep(c)), Transparency: nseq([0, 0.05], [0.45, 0.3], [1, 1]), WidthScale: nseq([0, 1], [1, 0.3]), LightEmission: 1, MinLength: 0.02, ...(o.texture ? { Texture: o.texture } : {}) }, children: [], kit: 'layer' }
      const tip = attachment(id('att'), `${name}Tip`, [0, 0, -r], [sparksLayer(id('n'), `${name}Sparks`, c, { rate: 90, speed: 6, size: 0.8 })])
      const part = rigPart(id('part'), name, at, { CFrame: start.map(r3) }, [a0, a1, tip, trail])
      const dur = o.duration ?? 0.18
      return { mode: 'part', node: part, prelude: [], activate: [on(`${name}Trail`), on(`${name}Sparks`), tween(name, 0, dur, { CFrame: end.map(r3) }, 'Quart', 'Out'), off(`${name}Sparks`, dur), off(`${name}Trail`, dur + 0.03)] }
    }
  },
  dust: {
    summary: 'ground dust ring blowing outward along the floor (landing / slam); one burst',
    layers: ['Dust'],
    options: 'color2, size (radius, 2), count (40), speed (14), at (y = -3 is the floor under the default root)',
    build(name, o, id) {
      const r = o.size ?? 2
      const s = o.speed ?? 14
      const c = o.color2 ?? o.color ?? [0.48, 0.44, 0.39]
      const dust = emitter(id('n'), `${name}Dust`, { Rate: 0, Lifetime: [0.6, 1.1], Speed: [s * 0.6, s], Drag: 4, Shape: 'Cylinder', ShapeStyle: 'Surface', EmissionDirection: 'Top', Size: nseq([0, 1.1, 0.3], [1, 3.2, 0.6]), Transparency: nseq([0, 0.45], [1, 1]), Color: cseq(c.map((v) => clamp01(v * 1.2)) as Rgb, c), LightEmission: 0, Rotation: [0, 360], RotSpeed: [-40, 40], Acceleration: [0, 2, 0], Texture: tex(o, SMOKE) })
      const part = rigPart(id('part'), name, o.at ?? [0, -2.9, 0], { Size: [2 * r, 0.2, 2 * r].map(r3) }, [dust])
      return { mode: 'part', node: part, prelude: [], activate: [emit(`${name}Dust`, o.count ?? 40)] }
    }
  },
  light: {
    summary: 'a PointLight (colour the floor and the character)',
    layers: ['Light'],
    options: 'color, brightness (4), size (range, 12), at, parent',
    build(name, o, id) {
      const l = light(id('n'), `${name}Light`, o.color ?? [1, 0.85, 0.6], o.brightness ?? 4, o.size ?? 12)
      return { mode: 'attach', node: attachment(id('att'), name, o.at, [l]), prelude: [], activate: [on(`${name}Light`)] }
    }
  }
}

export const KIT_ALIASES: Record<string, string> = { ring: 'shockwave', wave: 'shockwave', ball: 'orb', sphere: 'orb', spark: 'sparks', rocks: 'debris', burst: 'impact', hit: 'impact', gather: 'charge', laser: 'beam', streak: 'trail' }

export function kitKind(kind: string): string | null {
  const k = String(kind ?? '').toLowerCase()
  if (KIT[k]) return k
  return KIT_ALIASES[k] ?? null
}

// The kit as text, for prompts and the vfx_kit tool.
export function kitDoc(): string {
  return Object.entries(KIT)
    .map(([k, d]) => `- ${k}: ${d.summary}. Layers: ${d.layers.length ? d.layers.map((l) => `<Name>${l}`).join(', ') : '(the rig itself)'}. Options: ${d.options}.`)
    .join('\n')
}
