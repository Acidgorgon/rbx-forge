// A library shaped like a real imported one (the "I taught it a lot" case): 36 effects bought /
// ripped / hand-made for anime-style abilities, each an invisible Part with two or three
// Attachments holding 4-10 ParticleEmitters named "1", "2", "1SP"..., plus Beams and Trails on
// attachment pairs, flipbook sheets and the user's own uploaded textures, timed by the EmitCount /
// EmitDelay / EmitDuration attributes (staggered bursts). Unlike library.ts, the tags are NOT
// hand-set: every entry is tagged the way an import tags it (auto-tags from the effect and its
// name, service.ts addEffect), and most names say nothing about the kind ("Hollow Purple",
// "Cleave", "Black Flash").

import { describeEffect, effectFromNodes, effectStats } from '../../src/shared/vfx/analyze.ts'
import { SCHEMA } from '../../src/shared/vfx/schema.ts'
import { rng } from '../../src/shared/vfx/sequence.ts'
import { normalizeValue } from '../../src/shared/vfx/spec.ts'
import { autoTagGroups, flatTags } from '../../src/shared/vfx/tags.ts'
import type { PropValue, VfxEntry, VfxNode } from '../../src/shared/vfx/types.ts'

// The user's uploaded textures (ids in the 7-8 digit range, as uploads are).
export const RICH_TEX = {
  spark: 'rbxassetid://7216848832',
  spark2: 'rbxassetid://7216849325',
  star: 'rbxassetid://7216850012',
  glow: 'rbxassetid://7216851190',
  flare: 'rbxassetid://7216851777',
  smoke: 'rbxassetid://7216853001',
  fireSheet: 'rbxassetid://7216854455',
  energySheet: 'rbxassetid://7216855101',
  slash: 'rbxassetid://7216856020',
  slashSheet: 'rbxassetid://7216856666',
  ring: 'rbxassetid://7216857300',
  crack: 'rbxassetid://7216858010',
  rock: 'rbxassetid://7216858999',
  lightning: 'rbxassetid://7216859701',
  beam: 'rbxassetid://7216860404',
  trail: 'rbxassetid://7216861111'
}

type Pal = [string, string, string, string]
const PAL: Record<string, Pal> = {
  purple: ['#ffffff', '#c27bff', '#6a1bff', '#1a0b2e'],
  red: ['#ffffff', '#ff5a5a', '#b3000f', '#2a0606'],
  blue: ['#ffffff', '#6fc8ff', '#1f5bff', '#0b1430'],
  fire: ['#fff3c4', '#ff8a1f', '#d1260f', '#3a2a22'],
  black: ['#ff3b3b', '#2a0000', '#000000', '#140404'],
  ice: ['#ffffff', '#a8ecff', '#3f8cff', '#cfe6ff'],
  gold: ['#ffffff', '#ffe27a', '#ffae2b', '#fff4d6'],
  green: ['#f2ffb0', '#7dff3a', '#2c8a10', '#25331b'],
  white: ['#ffffff', '#e6f2ff', '#a6c8ff', '#dfe7ef'],
  cyan: ['#ffffff', '#7ffcff', '#14b8d6', '#0d2a30']
}

let ids = 0
const nid = (p: string) => `${p}${(++ids).toString(36)}`

function node(className: string, name: string, raw: Record<string, unknown>, attrs?: Record<string, number>, children: VfxNode[] = []): VfxNode {
  const props: Record<string, PropValue> = {}
  for (const [k, v] of Object.entries(raw)) {
    const spec = SCHEMA[className]?.[k]
    if (!spec) throw new Error(`rich fixture: ${className}.${k}`)
    props[k] = spec.kind === 'ref' ? (v as string) : normalizeValue(spec.kind, v, `${name}.${k}`)
  }
  return { id: nid('r'), className, name, props, children, ...(attrs ? { attrs } : {}) }
}

const r2 = (x: number) => Math.round(x * 100) / 100

// One emitter layer of the bank: what it is, how it bursts.
type L = { name: string; props: Record<string, unknown>; count: number; delay: number; duration?: number }
type Bank = (p: Pal, j: () => number, s: number) => L

const LAYERS: Record<string, Bank> = {
  core: (p, j, s) => ({ name: '1', props: { Lifetime: [r2(0.35 * j()), r2(0.6 * j())], Speed: [0, 1], Size: [[0, r2(2 * s)], [0.2, r2(6 * s * j())], [1, r2(7 * s)]], Transparency: [[0, 0], [0.6, 0.35], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 1, Rotation: [0, 360], RotSpeed: [-60, 60], Texture: RICH_TEX.energySheet, FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot', ZOffset: 1 }, count: Math.round(3 * j()), delay: 0 }),
  glow: (p, j, s) => ({ name: '2', props: { Lifetime: [0.5, r2(0.7 * j())], Speed: [0, 0], Size: [[0, r2(4 * s)], [0.3, r2(10 * s * j())], [1, r2(12 * s)]], Transparency: [[0, 0.5], [0.5, 0.7], [1, 1]], Color: [p[1], p[2]], LightEmission: 1, Texture: RICH_TEX.glow, ZOffset: -1 }, count: 1, delay: 0 }),
  flare: (p, j, s) => ({ name: 'Flare', props: { Lifetime: [0.12, r2(0.2 * j())], Speed: [0, 0], Size: [[0, r2(3 * s)], [0.2, r2(9 * s * j())], [1, r2(10 * s)]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Rotation: [0, 360], Texture: RICH_TEX.flare, ZOffset: 2 }, count: 2, delay: 0 }),
  sparks: (p, j, s) => ({ name: '1SP', props: { Lifetime: [r2(0.2 * j()), r2(0.5 * j())], Speed: [r2(40 * j()), r2(70 * j())], SpreadAngle: [180, 180], Drag: r2(5 * j()), Size: [[0, r2(0.4 * s)], [1, 0]], Squash: [[0, 2], [1, 0.5]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Orientation: 'VelocityParallel', Texture: RICH_TEX.spark }, count: Math.round(40 * j()), delay: 0.02 }),
  sparks2: (p, j, s) => ({ name: '2SP', props: { Lifetime: [0.4, r2(0.9 * j())], Speed: [r2(15 * j()), r2(30 * j())], SpreadAngle: [180, 180], Drag: r2(3 * j()), Acceleration: [0, -12, 0], Size: [[0, r2(0.25 * s)], [1, 0]], Transparency: [[0, 0], [0.8, 0.3], [1, 1]], Color: [p[1], p[2]], LightEmission: 1, Texture: RICH_TEX.spark2 }, count: Math.round(25 * j()), delay: 0.08 }),
  specks: (p, j, s) => ({ name: '3', props: { Lifetime: [0.8, r2(1.4 * j())], Speed: [2, r2(6 * j())], SpreadAngle: [180, 180], Acceleration: [0, 3, 0], Size: [[0, r2(0.18 * s)], [0.5, r2(0.3 * s)], [1, 0]], Transparency: [[0, 0], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Texture: RICH_TEX.star }, count: Math.round(18 * j()), delay: 0.15 }),
  smoke: (p, j, s) => ({ name: 'Smoke', props: { Lifetime: [r2(0.9 * j()), r2(1.6 * j())], Speed: [r2(5 * j()), r2(12 * j())], SpreadAngle: [180, 180], Drag: r2(3 * j()), Size: [[0, r2(2.5 * s)], [1, r2(6 * s * j())]], Transparency: [[0, 0.4], [0.6, 0.6], [1, 1]], Color: [p[3], p[3]], LightEmission: 0, Rotation: [0, 360], RotSpeed: [-30, 30], Texture: RICH_TEX.smoke, FlipbookLayout: 'Grid4x4', FlipbookMode: 'OneShot' }, count: Math.round(10 * j()), delay: 0.05 }),
  ring: (p, j, s) => ({ name: 'Wave', props: { Lifetime: [r2(0.3 * j()), r2(0.45 * j())], Speed: [0, 0], Size: [[0, 1], [1, r2(22 * s * j())]], Transparency: [[0, 0.1], [1, 1]], Color: [p[1], p[2]], LightEmission: 1, Orientation: 'VelocityPerpendicular', Texture: RICH_TEX.ring }, count: 1, delay: 0.03 }),
  ring2: (p, j, s) => ({ name: 'Wave2', props: { Lifetime: [r2(0.4 * j()), r2(0.6 * j())], Speed: [0, 0], Size: [[0, 2], [1, r2(30 * s * j())]], Transparency: [[0, 0.3], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Orientation: 'VelocityPerpendicular', Texture: RICH_TEX.ring }, count: 1, delay: 0.12 }),
  debris: (p, j, s) => ({ name: 'Rocks', props: { Lifetime: [0.9, r2(1.4 * j())], Speed: [r2(25 * j()), r2(40 * j())], SpreadAngle: [55, 55], Acceleration: [0, -45, 0], Size: [[0, r2(0.9 * s)], [1, r2(0.7 * s)]], Transparency: [[0, 0], [0.85, 0], [1, 1]], Color: [p[3], p[3]], LightEmission: 0, Rotation: [0, 360], RotSpeed: [-200, 200], Texture: RICH_TEX.rock }, count: Math.round(16 * j()), delay: 0 }),
  crack: (p, j, s) => ({ name: 'Crack', props: { Lifetime: [1.4, r2(1.8 * j())], Speed: [0, 0], Size: [[0, r2(10 * s)], [1, r2(10 * s)]], Transparency: [[0, 0.1], [0.8, 0.3], [1, 1]], Color: [p[2], p[3]], LightEmission: 0.3, Orientation: 'VelocityPerpendicular', Texture: RICH_TEX.crack }, count: 1, delay: 0 }),
  slash: (p, j, s) => ({ name: 'Slash', props: { Lifetime: [r2(0.2 * j()), r2(0.3 * j())], Speed: [0.5, 0.5], Size: [[0, r2(7 * s * j())], [0.3, r2(11 * s * j())], [1, r2(10 * s)]], Transparency: [[0, 0], [0.7, 0.3], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 1, Rotation: [-25, 25], Texture: RICH_TEX.slashSheet, FlipbookLayout: 'Grid2x2', FlipbookMode: 'OneShot' }, count: 1, delay: 0 }),
  slash2: (p, j, s) => ({ name: 'Slash2', props: { Lifetime: [r2(0.25 * j()), r2(0.35 * j())], Speed: [0.5, 0.5], Size: [[0, r2(9 * s * j())], [0.3, r2(14 * s * j())], [1, r2(12 * s)]], Transparency: [[0, 0.2], [0.7, 0.4], [1, 1]], Color: [p[1], p[2]], LightEmission: 1, Rotation: [155, 205], Texture: RICH_TEX.slash }, count: 1, delay: 0.06 }),
  bolts: (p, j, s) => ({ name: 'Lightning', props: { Lifetime: [0.08, 0.16], Speed: [0, 0], Size: [[0, r2(4 * s)], [1, r2(5 * s)]], Transparency: [[0, 0], [0.8, 0.2], [1, 1]], Color: [p[0], p[1]], LightEmission: 1, Rotation: [0, 360], Texture: RICH_TEX.lightning, FlipbookLayout: 'Grid2x2', FlipbookMode: 'Random' }, count: Math.round(6 * j()), delay: 0.01 }),
  inward: (p, j, s) => ({ name: 'Charge', props: { Lifetime: [0.35, 0.5], Speed: [r2(10 * s), r2(14 * s)], Shape: 'Sphere', ShapeStyle: 'Surface', ShapeInOut: 'Inward', Size: [[0, 0.15], [0.7, 0.3], [1, 0]], Squash: [[0, 2], [1, 1]], Transparency: [[0, 1], [0.25, 0], [1, 1]], Color: [p[1], p[0]], LightEmission: 1, Orientation: 'VelocityParallel', Texture: RICH_TEX.spark }, count: Math.round(50 * j()), delay: 0, duration: 0.6 }),
  aura: (p, j, s) => ({ name: 'Aura', props: { Lifetime: [0.7, r2(1.1 * j())], Speed: [2, r2(5 * j())], SpreadAngle: [20, 20], Acceleration: [0, 6, 0], Size: [[0, r2(0.6 * s)], [0.4, r2(2 * s * j())], [1, 0]], Transparency: [[0, 1], [0.2, 0.3], [1, 1]], Color: [p[0], p[1], p[2]], LightEmission: 1, Texture: RICH_TEX.fireSheet, FlipbookLayout: 'Grid4x4', FlipbookMode: 'Loop' }, count: Math.round(30 * j()), delay: 0, duration: 1.2 })
}

// Archetypes: the layer mix, beams / trails, and the emitters per attachment.
const ARCH: Record<string, { layers: string[]; beams: number; trail: boolean }> = {
  blast: { layers: ['core', 'glow', 'flare', 'sparks', 'sparks2', 'smoke', 'ring', 'ring2', 'specks'], beams: 0, trail: false },
  orb: { layers: ['core', 'glow', 'inward', 'sparks', 'specks', 'ring', 'flare'], beams: 2, trail: true },
  impact: { layers: ['flare', 'core', 'sparks', 'sparks2', 'ring', 'smoke', 'bolts'], beams: 0, trail: false },
  slash: { layers: ['slash', 'slash2', 'sparks', 'flare', 'specks', 'smoke'], beams: 0, trail: true },
  ground: { layers: ['flare', 'ring', 'ring2', 'debris', 'crack', 'smoke', 'sparks'], beams: 0, trail: false },
  beam: { layers: ['inward', 'core', 'glow', 'sparks', 'flare'], beams: 3, trail: false },
  aura: { layers: ['aura', 'specks', 'glow', 'sparks2'], beams: 0, trail: false }
}

// name, palette, archetype, extra layers (repeats of bank layers at another size)
export const RICH_PLAN: [string, string, string, number][] = [
  ['Hollow Purple', 'purple', 'orb', 2],
  ['Reversal Red', 'red', 'orb', 1],
  ['Lapse Blue', 'blue', 'orb', 1],
  ['Black Flash', 'black', 'impact', 2],
  ['Divergent Fist', 'blue', 'impact', 1],
  ['Cleave', 'red', 'slash', 1],
  ['Dismantle', 'white', 'slash', 2],
  ['World Cutter', 'white', 'slash', 0],
  ['Getsuga', 'black', 'slash', 1],
  ['Flame Arrow', 'fire', 'orb', 0],
  ['Fuga', 'fire', 'blast', 1],
  ['Maximum Output', 'purple', 'blast', 1],
  ['Nuke', 'fire', 'blast', 2],
  ['Crimson Burst', 'red', 'blast', 0],
  ['Void Rupture', 'purple', 'blast', 0],
  ['Thunder Clap', 'cyan', 'impact', 1],
  ['Kamutoke', 'blue', 'beam', 1],
  ['Cero', 'red', 'beam', 0],
  ['Final Flash', 'gold', 'beam', 1],
  ['Galick Gun', 'purple', 'beam', 0],
  ['Ground Pound', 'white', 'ground', 1],
  ['Meteor Drop', 'fire', 'ground', 1],
  ['Earth Breaker', 'white', 'ground', 0],
  ['Frost Spikes', 'ice', 'ground', 1],
  ['Glacier Burst', 'ice', 'blast', 0],
  ['Super Saiyan', 'gold', 'aura', 1],
  ['Dark Aura', 'purple', 'aura', 1],
  ['Toxic Field', 'green', 'aura', 0],
  ['Shadow Step', 'black', 'slash', 0],
  ['Blink Strike', 'cyan', 'slash', 1],
  ['Spirit Bomb', 'blue', 'orb', 2],
  ['Death Ball', 'red', 'orb', 1],
  ['Domain Expansion', 'purple', 'blast', 2],
  ['Red Lightning Punch', 'red', 'impact', 1],
  ['Water Dragon', 'blue', 'beam', 1],
  ['Heavenly Strike', 'gold', 'impact', 0]
]

function buildEffect(name: string, pal: Pal, arch: string, extra: number, rand: () => number): VfxNode {
  const j = () => 0.85 + rand() * 0.3
  const a = ARCH[arch]
  const s = 0.8 + rand() * 0.5
  const layers: L[] = a.layers.map((k) => LAYERS[k](pal, j, s))
  // Extra copies at another scale and delay (the "second wave" of a purchased pack).
  for (let i = 0; i < extra; i++) {
    const k = a.layers[(i * 3 + 1) % a.layers.length]
    const l = LAYERS[k](pal, j, s * 1.4)
    layers.push({ ...l, name: l.name, delay: l.delay + 0.2 + 0.1 * i })
  }
  // Two or three attachments, layers spread over them (names repeat: "1" in each).
  const nAtt = layers.length > 7 ? 3 : 2
  const atts = Array.from({ length: nAtt }, (_, i) => node('Attachment', i === 0 ? 'Attachment' : i === 1 ? 'Mid' : 'Attachment2', { CFrame: [0, i * 0.5, 0] }))
  layers.forEach((l, i) => {
    const attrs: Record<string, number> = { EmitCount: Math.max(1, l.count), EmitDelay: l.delay, ...(l.duration ? { EmitDuration: l.duration } : {}) }
    atts[i % nAtt].children.push(node('ParticleEmitter', l.name, { Rate: l.duration ? Math.round(l.count / l.duration) : 0, Enabled: false, ...l.props }, attrs))
  })
  const kids: VfxNode[] = [...atts]
  // Beams between attachment pairs (the user's beam texture), and a trail on a third pair.
  for (let b = 0; b < a.beams; b++) {
    const a0 = node('Attachment', `B${b}0`, { CFrame: [0, 0, 0] })
    const a1 = node('Attachment', `B${b}1`, { CFrame: [0, 0, -14 - 4 * b] })
    kids.push(a0, a1, node('Beam', b === 0 ? 'Beam' : `Beam${b + 1}`, { Attachment0: a0.id, Attachment1: a1.id, Width0: r2((3 - b) * s), Width1: r2((2.4 - b * 0.6) * s), Color: [pal[0], pal[1]], Transparency: [[0, 0.1], [1, 0.4]], LightEmission: 1, Texture: b === 1 ? RICH_TEX.lightning : RICH_TEX.beam, TextureMode: 'Wrap', TextureLength: 4, TextureSpeed: 2, Segments: 20 }, { EmitDelay: 0.05 * b, EmitDuration: 0.6 }))
  }
  if (a.trail) {
    const t0 = node('Attachment', 'T0', { CFrame: [0, 0.8, 0] })
    const t1 = node('Attachment', 'T1', { CFrame: [0, -0.8, 0] })
    kids.push(t0, t1, node('Trail', 'Trail', { Attachment0: t0.id, Attachment1: t1.id, Lifetime: r2(0.3 * j()), Color: [pal[0], pal[1], pal[2]], Transparency: [[0, 0.1], [0.6, 0.5], [1, 1]], WidthScale: [[0, 1], [1, 0.2]], LightEmission: 1, Texture: RICH_TEX.trail, TextureMode: 'Stretch' }))
  }
  if (arch === 'orb' || arch === 'blast') kids.push(node('PointLight', 'Light', { Color: pal[1], Brightness: 4, Range: 16 }))
  return node('Part', name.replace(/\s+/g, ''), { Transparency: 1, Size: [1, 1, 1] }, undefined, kids)
}

export function richLibrary(): VfxEntry[] {
  ids = 0
  const out: VfxEntry[] = []
  let t = 1_710_000_000_000
  for (const [name, pal, arch, extra] of RICH_PLAN) {
    const rand = rng(out.length * 104729 + 7)
    const root = buildEffect(name, PAL[pal], arch, extra, rand)
    const effect = effectFromNodes(name, [root])
    // Tagged the way an import tags it (service.ts addEffect -> tagFields: auto-tags from the effect
    // and its name; nothing hand-set).
    const { groups } = autoTagGroups(effect, `${name} ${name}.rbxm`)
    t += 60_000
    out.push({
      id: `rich-${name.toLowerCase().replace(/\s+/g, '-')}`,
      scope: 'user',
      kind: 'model',
      name,
      description: describeEffect(effect),
      tags: flatTags(groups),
      tagGroups: groups,
      createdAt: t,
      updatedAt: t,
      origin: `${name}.rbxm`,
      effect,
      stats: effectStats(effect),
      thumbs: [],
      quality: 'reference'
    })
  }
  return out
}
