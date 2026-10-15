// A stand-in for a real VFX library (the offline benchmark and test/vfxQuality.test.ts): 28 effects
// built the way purchased / hand-made Roblox packs are: an invisible Part with Attachments holding
// ParticleEmitters (layers often named "1SP", "2"), Beams and Trails, timed by the EmitCount /
// EmitDelay / EmitDuration attributes, with uploaded textures (rbxassetid, some flipbooks), and
// imported through the same code path as a dropped .rbxm (effectFromNodes). Numbers vary per effect
// (seeded), so the learned ranges are ranges. Tags are what the user would have after Learn.

import { effectFromNodes, effectStats, describeEffect } from '../../src/shared/vfx/analyze.ts'
import { SCHEMA } from '../../src/shared/vfx/schema.ts'
import { rng } from '../../src/shared/vfx/sequence.ts'
import { normalizeValue } from '../../src/shared/vfx/spec.ts'
import { flatTags } from '../../src/shared/vfx/tags.ts'
import type { PropValue, VfxEntry, VfxNode } from '../../src/shared/vfx/types.ts'

// Texture ids by job (the "uploaded textures" of the pack).
export const TEX = {
  spark: 'rbxassetid://1001',
  star: 'rbxassetid://1002',
  bolt: 'rbxassetid://1101',
  puff: 'rbxassetid://2001',
  smokeSheet: 'rbxassetid://2002',
  crescent: 'rbxassetid://3001',
  slashSheet: 'rbxassetid://3002',
  ring: 'rbxassetid://4001',
  glow: 'rbxassetid://5001',
  flash: 'rbxassetid://5002',
  fireSheet: 'rbxassetid://6001',
  trail: 'rbxassetid://7001',
  crack: 'rbxassetid://8001',
  rock: 'rbxassetid://9001'
}

type Pal = [string, string, string, string]
const PALETTE: Record<string, Pal> = {
  fire: ['#fff1b0', '#ff8c1a', '#c2200b', '#3a2a22'],
  electric: ['#ffffff', '#7fe6ff', '#2f6bff', '#1b2233'],
  ice: ['#ffffff', '#a8ecff', '#3f8cff', '#cfe6ff'],
  dark: ['#e2b8ff', '#7d2cff', '#1a0630', '#140a1c'],
  water: ['#ffffff', '#5fd0ff', '#1764d1', '#cdeeff'],
  light: ['#ffffff', '#ffe68a', '#ffb23f', '#fff4d6'],
  earth: ['#e8d2a8', '#9b7a52', '#4a3726', '#6b5a48'],
  wind: ['#ffffff', '#d8fff6', '#8fe3d0', '#e8fffa'],
  energy: ['#ffffff', '#c48cff', '#5a2dff', '#23143d']
}

let ids = 0
const nid = (p: string) => `${p}${(++ids).toString(36)}`

function node(className: string, name: string, raw: Record<string, unknown>, attrs?: Record<string, number>, children: VfxNode[] = []): VfxNode {
  const props: Record<string, PropValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    const spec = SCHEMA[className]?.[k]
    if (!spec) throw new Error(`fixture: ${className}.${k}`)
    props[k] = spec.kind === 'ref' ? (v as string) : normalizeValue(spec.kind, v, `${name}.${k}`)
  }
  return { id: nid('n'), className, name, props, children, ...(attrs ? { attrs } : {}) }
}

type Layer = { cls?: string; name: string; props: Record<string, unknown>; count?: number; delay?: number; duration?: number }

// One effect: Part (invisible) > Attachment > layers; trails get two attachments.
function build(name: string, layers: Layer[]): VfxNode {
  const att = node('Attachment', 'Attachment', {})
  const a0 = node('Attachment', 'A0', { CFrame: [0, 0.6, 0] })
  const a1 = node('Attachment', 'A1', { CFrame: [0, -0.6, 0] })
  let usesTrail = false
  for (const l of layers) {
    const cls = l.cls ?? 'ParticleEmitter'
    const attrs = l.count !== undefined || l.delay !== undefined || l.duration !== undefined ? { ...(l.count !== undefined ? { EmitCount: l.count } : {}), ...(l.delay !== undefined ? { EmitDelay: l.delay } : {}), ...(l.duration !== undefined ? { EmitDuration: l.duration } : {}) } : undefined
    if (cls === 'Trail' || cls === 'Beam') {
      usesTrail = true
      att.children.push(node(cls, l.name, { ...l.props, Attachment0: a0.id, Attachment1: a1.id }, attrs))
    } else {
      att.children.push(node(cls, l.name, cls === 'ParticleEmitter' && l.count !== undefined ? { Rate: 0, ...l.props } : l.props, attrs))
    }
  }
  return node('Part', name, { Transparency: 1, Size: [1, 1, 1] }, undefined, usesTrail ? [att, a0, a1] : [att])
}

type Kit = (p: Pal, j: () => number, el: string) => Layer[]

const r2 = (x: number) => Math.round(x * 100) / 100

const sparks = (p: Pal, j: () => number, o: { name?: string; count?: number; speed?: number; delay?: number; tex?: string } = {}): Layer => ({
  name: o.name ?? '1SP',
  props: { Lifetime: [r2(0.2 * j()), r2(0.45 * j())], Speed: [r2((o.speed ?? 35) * 0.7 * j()), r2((o.speed ?? 35) * j())], SpreadAngle: [70, 70], Drag: r2(6 * j()), Size: [[0, r2(0.35 * j())], [1, 0]], Squash: [[0, 1.5], [1, 0.5]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Orientation: 'VelocityParallel', Texture: o.tex ?? TEX.spark },
  count: Math.round((o.count ?? 18) * j()),
  delay: o.delay ?? 0.05
})
const flash = (p: Pal, j: () => number, size = 5): Layer => ({ name: '2', props: { Lifetime: [0.12, r2(0.18 * j())], Speed: [0, 0], Size: [[0, r2(size * 0.7 * j())], [0.2, r2(size * j())], [1, r2(size * 0.9)]], Transparency: [[0, 0.3], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Texture: TEX.flash, ZOffset: 1 }, count: 1, delay: 0 })
const smoke = (p: Pal, j: () => number, o: { count?: number; size?: number; delay?: number } = {}): Layer => ({
  name: 'Smoke',
  props: { Lifetime: [r2(0.9 * j()), r2(1.5 * j())], Speed: [r2(6 * j()), r2(11 * j())], SpreadAngle: [180, 180], Drag: r2(3 * j()), Size: [[0, r2((o.size ?? 2.5) * j())], [1, r2((o.size ?? 2.5) * 2.2 * j())]], Transparency: [[0, 0.45], [0.6, 0.6], [1, 1]], Color: [p[3], p[3]], LightEmission: 0, Rotation: [0, 360], RotSpeed: [-30, 30], Texture: TEX.smokeSheet, FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot' },
  count: Math.round((o.count ?? 8) * j()),
  delay: o.delay ?? 0.05
})
const ring = (p: Pal, j: () => number, size = 12, delay = 0): Layer => ({ name: 'Ring', props: { Lifetime: [r2(0.3 * j()), r2(0.38 * j())], Speed: [0, 0], Size: [[0, 1], [1, r2(size * j())]], Transparency: [[0, 0.2], [1, 1]], Color: [p[1], p[2]], LightEmission: 1, Orientation: 'VelocityPerpendicular', Texture: TEX.ring }, count: 1, delay })

const KINDS: Record<string, Kit> = {
  slash: (p, j, el) => [
    { name: 'Slash', props: { Lifetime: [r2(0.22 * j()), r2(0.3 * j())], Speed: [0.5, 0.5], Size: [[0, r2(7 * j())], [0.3, r2(10 * j())], [1, r2(9 * j())]], Transparency: [[0, 0.1], [0.7, 0.3], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 1, Rotation: [-20, 20], Texture: TEX.slashSheet, FlipbookLayout: 'Grid2x2', FlipbookMode: 'OneShot' }, count: 1, delay: 0 },
    sparks(p, j),
    flash(p, j, 5),
    ...(el === 'fire' ? [{ name: 'Embers', props: { Lifetime: [0.6, r2(1.2 * j())], Speed: [4, r2(8 * j())], SpreadAngle: [40, 40], Acceleration: [0, 6, 0], Size: [[0, 0.22], [1, 0]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Texture: TEX.star }, count: Math.round(10 * j()), delay: 0.1 } as Layer] : []),
    ...(el === 'electric' ? [{ name: 'Bolts', props: { Lifetime: [0.1, 0.2], Speed: [0, 0], Size: [[0, 3], [1, 3.5]], Transparency: [[0, 0], [0.8, 0.2], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Rotation: [0, 360], Texture: TEX.bolt, FlipbookLayout: 'Grid2x2', FlipbookMode: 'Random' }, count: 4, delay: 0.02 } as Layer] : []),
    ...(el === 'dark' || el === 'wind' ? [smoke(p, j, { count: 6, size: 2 })] : [])
  ],
  impact: (p, j, el) => [
    { ...flash(p, j, 7), name: 'Flash' },
    sparks(p, j, { name: 'Sparks', count: 30, speed: 50, delay: 0, tex: el === 'water' ? TEX.star : TEX.spark }),
    ring(p, j, 12),
    smoke(p, j, { count: 8 }),
    ...(el === 'earth' ? [{ name: 'Debris', props: { Lifetime: [0.8, r2(1.2 * j())], Speed: [20, r2(35 * j())], SpreadAngle: [50, 50], Acceleration: [0, -40, 0], Size: [[0, 0.8], [1, 0.6]], Transparency: [[0, 0], [0.8, 0], [1, 1]], Color: [p[1], p[2]], LightEmission: 0, Rotation: [0, 360], RotSpeed: [-200, 200], Texture: TEX.rock }, count: 14, delay: 0 } as Layer, { name: 'Crack', props: { Lifetime: [1.4, 1.6], Speed: [0, 0], Size: [[0, 9], [1, 9]], Transparency: [[0, 0.1], [0.8, 0.3], [1, 1]], Color: [p[3], p[3]], LightEmission: 0, Orientation: 'VelocityPerpendicular', Texture: TEX.crack }, count: 1, delay: 0 } as Layer] : []),
    ...(el === 'electric' ? [{ name: 'Bolts', props: { Lifetime: [0.1, 0.2], Speed: [0, 0], Size: [[0, 4], [1, 5]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Rotation: [0, 360], Texture: TEX.bolt, FlipbookLayout: 'Grid2x2', FlipbookMode: 'Random' }, count: 5, delay: 0 } as Layer] : [])
  ],
  explosion: (p, j) => [
    { name: 'Core', props: { Lifetime: [r2(0.6 * j()), r2(0.9 * j())], Speed: [4, r2(10 * j())], SpreadAngle: [180, 180], Size: [[0, 4], [0.25, r2(11 * j())], [1, r2(13 * j())]], Transparency: [[0, 0], [0.6, 0.3], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 0.8, Rotation: [0, 360], Texture: TEX.fireSheet, FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot' }, count: Math.round(12 * j()), delay: 0 },
    sparks(p, j, { name: 'Sparks', count: 50, speed: 70, delay: 0 }),
    smoke(p, j, { count: 14, size: 6, delay: 0.1 }),
    ring(p, j, 20),
    { ...flash(p, j, 14), name: 'Flash' }
  ],
  aura: (p, j) => [
    { name: 'Aura', props: { Rate: Math.round(25 * j()), Lifetime: [0.8, r2(1.2 * j())], Speed: [2, r2(4 * j())], SpreadAngle: [20, 20], Acceleration: [0, 4, 0], Size: [[0, 0.5], [0.4, r2(1.6 * j())], [1, 0]], Transparency: [[0, 1], [0.2, 0.4], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 1, Texture: TEX.glow } },
    { name: 'Specks', props: { Rate: Math.round(10 * j()), Lifetime: [1, r2(1.6 * j())], Speed: [1, 3], SpreadAngle: [30, 30], Acceleration: [0, 5, 0], Size: [[0, 0.2], [1, 0]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Texture: TEX.star } },
    { name: 'Glow', props: { Rate: 3, Lifetime: [0.9, 1.1], Speed: [0, 0], Size: [[0, r2(5 * j())], [1, r2(6 * j())]], Transparency: [[0, 1], [0.5, 0.75], [1, 1]], Color: [p[1], p[1]], LightEmission: 1, Texture: TEX.glow, ZOffset: -1 } }
  ],
  projectile: (p, j, el) => [
    { name: 'Core', props: { Rate: 30, Lifetime: [0.15, r2(0.25 * j())], Speed: [0, 0], Size: [[0, r2(1.8 * j())], [1, 1]], Transparency: [[0, 0.1], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, LockedToPart: true, Texture: TEX.glow } },
    { cls: 'Trail', name: 'Trail', props: { Lifetime: r2(0.3 * j()), Color: [p[0], p[1], p[2]], Transparency: [[0, 0.1], [0.6, 0.5], [1, 1]], WidthScale: [[0, 1], [1, 0.2]], LightEmission: 1, Texture: TEX.trail, TextureMode: 'Stretch' } },
    { name: 'Sparks', props: { Rate: 20, Lifetime: [0.2, r2(0.4 * j())], Speed: [4, r2(8 * j())], SpreadAngle: [180, 180], Size: [[0, 0.25], [1, 0]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Texture: TEX.spark } },
    ...(el === 'fire' ? [{ name: 'Flames', props: { Rate: 20, Lifetime: [0.3, r2(0.5 * j())], Speed: [1, 2], Size: [[0, 1.5], [0.3, r2(2.5 * j())], [1, 0.5]], Transparency: [[0, 0.2], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 0.8, Rotation: [0, 360], Texture: TEX.fireSheet, FlipbookLayout: 'Grid4x4', FlipbookMode: 'Loop' } } as Layer] : []),
    { cls: 'PointLight', name: 'Light', props: { Color: p[1], Brightness: 2, Range: 10 } }
  ],
  shockwave: (p, j) => [ring(p, j, 24), ring(p, j, 16, 0.1), { ...smoke(p, j, { count: 30, size: 2 }), name: 'Dust' }, { ...flash(p, j, 8), name: 'Flash' }],
  charge: (p, j) => [
    { name: 'Charge', props: { Lifetime: [0.4, 0.5], Speed: [8, r2(12 * j())], Shape: 'Sphere', ShapeStyle: 'Surface', ShapeInOut: 'Inward', Size: [[0, 0.15], [0.7, 0.25], [1, 0]], Squash: [[0, 2], [1, 1]], Transparency: [[0, 1], [0.25, 0], [1, 1]], Color: [p[1], p[0]], LightEmission: 1, Orientation: 'VelocityParallel', Texture: TEX.spark }, count: Math.round(40 * j()), delay: 0, duration: 0.8 },
    { name: 'Glow', props: { Lifetime: [0.8, 0.9], Speed: [0, 0], Size: [[0, 1], [1, r2(5 * j())]], Transparency: [[0, 0.8], [0.6, 0.4], [1, 1]], Color: [p[1], p[1]], LightEmission: 1, Texture: TEX.glow }, count: 1, delay: 0 },
    sparks(p, j, { count: 20, delay: 0.8 })
  ],
  dash: (p, j, el) => [
    { name: 'Streaks', props: { Lifetime: [0.2, r2(0.3 * j())], Speed: [30, r2(50 * j())], SpreadAngle: [10, 10], Size: [[0, 0.4], [1, 0]], Squash: [[0, 2.5], [1, 1]], Transparency: [[0, 0.2], [1, 1]], Color: [p[0], p[1]], LightEmission: el === 'dark' ? 0.4 : 1, Orientation: 'VelocityParallel', Texture: TEX.spark }, count: Math.round(20 * j()), delay: 0 },
    smoke(p, j, { count: 10, size: 2 }),
    { cls: 'Trail', name: 'Trail', props: { Lifetime: r2(0.25 * j()), Color: [p[0], p[1]], Transparency: [[0, 0.2], [1, 1]], WidthScale: [[0, 1], [1, 0]], LightEmission: el === 'dark' ? 0.3 : 1, Texture: TEX.trail, TextureMode: 'Stretch' } }
  ]
}

// kind, element, how many, liked
const PLAN: [string, string, number, boolean?][] = [
  ['slash', 'fire', 2, true],
  ['slash', 'electric', 1],
  ['slash', 'dark', 2],
  ['slash', 'wind', 1],
  ['impact', 'fire', 1],
  ['impact', 'electric', 2, true],
  ['impact', 'earth', 2],
  ['impact', 'water', 1],
  ['impact', 'ice', 1],
  ['explosion', 'fire', 2],
  ['explosion', 'dark', 1],
  ['aura', 'light', 1],
  ['aura', 'dark', 1],
  ['aura', 'energy', 1],
  ['projectile', 'fire', 2],
  ['projectile', 'ice', 1],
  ['shockwave', 'earth', 1],
  ['shockwave', 'energy', 1],
  ['charge', 'energy', 1],
  ['charge', 'electric', 1],
  ['dash', 'wind', 1],
  ['dash', 'dark', 1]
]

const cap = (s: string) => s[0].toUpperCase() + s.slice(1)

export function fixtureLibrary(): VfxEntry[] {
  ids = 0
  const out: VfxEntry[] = []
  let t = 1_700_000_000_000
  for (const [kind, el, n, liked] of PLAN) {
    for (let i = 0; i < n; i++) {
      const rand = rng(out.length * 7919 + 13)
      const j = () => 0.85 + rand() * 0.3
      const name = `${cap(el)}${cap(kind)}${n > 1 ? i + 1 : ''}`
      const root = build(name, KINDS[kind](PALETTE[el], j, el))
      const effect = effectFromNodes(name, [root])
      const tagGroups = { kind: [kind], element: [el], timing: [kind === 'aura' ? 'loop' : 'burst'], custom: [] as string[] }
      t += 60_000
      out.push({
        id: `fx-${name.toLowerCase()}`,
        scope: 'user',
        kind: 'model',
        name,
        description: describeEffect(effect),
        tags: flatTags(tagGroups),
        tagGroups,
        createdAt: t,
        updatedAt: t,
        origin: `${name}.rbxm`,
        effect,
        stats: effectStats(effect),
        thumbs: [],
        quality: 'reference',
        ...(liked && i === 0 ? { rating: 'up' as const } : {})
      })
    }
  }
  return out
}
