// A first draft for "Make a ___ effect" when no model writes the spec (or as the model's starting
// point): the closest library reference when there is one, else a layered archetype whose numbers
// are pulled into the learned recipe's ranges. Deterministic, so it is testable.

import { allNodes, emitterRole, KNOWN_TAGS } from './analyze.ts'
import { safeName, type VfxLayerSpec, type VfxSpec } from './spec.ts'
import type { VfxEntry, VfxRecipe } from './types.ts'

type Palette = { hot: string; mid: string; cool: string; smoke: string }

const PALETTES: Record<string, Palette> = {
  fire: { hot: '#fff3c4', mid: '#ff8a1f', cool: '#d1260f', smoke: '#3a2f2a' },
  ice: { hot: '#ffffff', mid: '#9be7ff', cool: '#2f7bff', smoke: '#cfe9ff' },
  lightning: { hot: '#ffffff', mid: '#b9a8ff', cool: '#5b3bff', smoke: '#2a2440' },
  electric: { hot: '#ffffff', mid: '#8ff5ff', cool: '#1f8bff', smoke: '#1d2a3a' },
  poison: { hot: '#f2ffb0', mid: '#7dff3a', cool: '#2c8a10', smoke: '#25331b' },
  dark: { hot: '#d9a8ff', mid: '#7a2cff', cool: '#24093f', smoke: '#120818' },
  holy: { hot: '#ffffff', mid: '#ffe58a', cool: '#ffb341', smoke: '#fff4d6' },
  heal: { hot: '#f4fff0', mid: '#7dffa0', cool: '#21b35a', smoke: '#d8ffe3' },
  water: { hot: '#ffffff', mid: '#6fd3ff', cool: '#1767d1', smoke: '#cdeeff' },
  blood: { hot: '#ff6b6b', mid: '#c4161c', cool: '#5c0508', smoke: '#2b0a0a' },
  magic: { hot: '#ffffff', mid: '#c77dff', cool: '#5a2dff', smoke: '#2a1745' }
}

function paletteFor(words: string): Palette {
  for (const [k, p] of Object.entries(PALETTES)) if (words.includes(k)) return p
  if (/red|flame|burn|lava/.test(words)) return PALETTES.fire
  if (/blue|frost|cold/.test(words)) return PALETTES.ice
  if (/green|toxic|acid/.test(words)) return PALETTES.poison
  if (/purple|void|shadow/.test(words)) return PALETTES.dark
  if (/yellow|gold|light/.test(words)) return PALETTES.holy
  return PALETTES.magic
}

export function promptTags(prompt: string): string[] {
  const words = prompt.toLowerCase()
  return KNOWN_TAGS.filter((t) => new RegExp(`\\b${t.replace('-', '.?')}`).test(words))
}

// Most common texture per layer role across the library's good entries.
export function libraryTextures(entries: VfxEntry[]): Record<string, string> {
  const counts = new Map<string, Map<string, number>>()
  for (const e of entries) {
    if (!e.effect || e.quality === 'avoid') continue
    for (const n of allNodes(e.effect.roots)) {
      if (n.className !== 'ParticleEmitter') continue
      const tex = n.props.Texture
      if (typeof tex !== 'string' || !/^rbxassetid:\/\/\d+$/.test(tex)) continue
      const role = emitterRole(n)
      const m = counts.get(role) ?? new Map<string, number>()
      m.set(tex, (m.get(tex) ?? 0) + 1)
      counts.set(role, m)
    }
  }
  const out: Record<string, string> = {}
  for (const [role, m] of counts) out[role] = [...m.entries()].sort((a, b) => b[1] - a[1])[0][0]
  return out
}

function within(recipe: VfxRecipe | null | undefined, key: string, value: number): number {
  const r = recipe?.ranges[key]
  if (!r) return value
  return Math.min(Math.max(value, r.p10), r.p90)
}

export function draftSpec(prompt: string, opts: { recipe?: VfxRecipe | null; textures?: Record<string, string> } = {}): VfxSpec {
  const words = prompt.toLowerCase()
  const tags = promptTags(prompt)
  const p = paletteFor(words)
  const rc = opts.recipe
  const tex = (role: string) => (opts.textures?.[role] ? { Texture: opts.textures[role] } : {})
  const name = safeName(prompt.replace(/\b(make|a|an|the|effect|vfx|please)\b/gi, ' ')) || 'Effect'
  const sparks = (count: number, speed: number): VfxLayerSpec => ({
    name: 'Sparks',
    class: 'ParticleEmitter',
    props: {
      Lifetime: [0.25, within(rc, 'sparks.Lifetime', 0.5)],
      Speed: [speed * 0.6, within(rc, 'sparks.Speed', speed)],
      SpreadAngle: [180, 180],
      Drag: within(rc, 'sparks.Drag', 4),
      Acceleration: [0, -20, 0],
      Size: [[0, 0.25], [1, 0]],
      Transparency: [[0, 0], [0.7, 0.2], [1, 1]],
      Color: [p.hot, p.mid],
      LightEmission: 1,
      Orientation: 'VelocityParallel',
      Squash: [[0, 1.2], [1, 0.4]],
      ...tex('sparks')
    },
    emit: [{ at: 0, count: Math.round(within(rc, 'sparks.Burst', count)) }]
  })
  const core = (size: number, life: number): VfxLayerSpec => ({
    name: 'Core',
    class: 'ParticleEmitter',
    props: {
      Lifetime: [life * 0.7, within(rc, 'core.Lifetime', life)],
      Speed: [0, 1],
      SpreadAngle: [360, 360],
      Size: [[0, size * 0.3], [0.15, within(rc, 'core.SizePeak', size)], [1, 0]],
      Transparency: [[0, 0.1], [0.6, 0.3], [1, 1]],
      Color: [p.hot, p.mid, p.cool],
      LightEmission: within(rc, 'core.LightEmission', 1),
      Rotation: [0, 360],
      RotSpeed: [-90, 90],
      ...tex('core')
    },
    emit: [{ at: 0, count: 6 }]
  })
  const glow = (size: number): VfxLayerSpec => ({
    name: 'Glow',
    class: 'ParticleEmitter',
    props: { Lifetime: [0.3, 0.4], Speed: 0, Size: [[0, size * 0.5], [0.2, size], [1, size * 1.2]], Transparency: [[0, 0.5], [1, 1]], Color: p.mid, LightEmission: 1, ZOffset: -0.5, ...tex('glow') },
    emit: [{ at: 0, count: 1 }]
  })
  const smoke = (rateOrBurst: number, burst: boolean): VfxLayerSpec => ({
    name: 'Smoke',
    class: 'ParticleEmitter',
    props: {
      Lifetime: [0.8, within(rc, 'smoke.Lifetime', 1.4)],
      Speed: [1, within(rc, 'smoke.Speed', 4)],
      SpreadAngle: [180, 180],
      Drag: 2,
      Acceleration: [0, 2, 0],
      Size: [[0, 1], [1, 4]],
      Transparency: [[0, 0.6], [0.3, 0.5], [1, 1]],
      Color: p.smoke,
      LightEmission: within(rc, 'smoke.LightEmission', 0),
      Rotation: [0, 360],
      RotSpeed: [-30, 30],
      ZOffset: -1,
      ...(burst ? {} : { Rate: rateOrBurst }),
      ...tex('smoke')
    },
    ...(burst ? { emit: [{ at: 0.05, count: Math.round(rateOrBurst) }] } : {})
  })
  const light: VfxLayerSpec = { name: 'Flash', class: 'PointLight', props: { Color: p.mid, Brightness: 4, Range: 12 }, enable: [[0, 0.25]] }

  let spec: VfxSpec
  if (tags.includes('slash')) {
    spec = {
      name,
      tags,
      duration: 1,
      motion: 'swing',
      layers: [
        { name: 'Slash', class: 'Trail', width: 3, props: { Lifetime: 0.25, Color: [p.hot, p.mid, p.cool], Transparency: [[0, 0], [0.5, 0.4], [1, 1]], WidthScale: [[0, 1], [1, 0.2]], LightEmission: 1, FaceCamera: false }, enable: [[0, 0.45]] },
        { ...sparks(14, 18), emit: [{ at: 0.15, count: 14 }] },
        { ...glow(5), emit: [{ at: 0.1, count: 1 }] }
      ]
    }
  } else if (tags.includes('aura') || tags.includes('buff') || tags.includes('charge') || tags.includes('heal')) {
    spec = {
      name,
      tags,
      duration: 2.5,
      motion: 'static',
      anchor: [0, 2.6, 0],
      layers: [
        {
          name: 'Aura',
          class: 'ParticleEmitter',
          shape: { size: [3, 0.2, 3] },
          props: { Shape: 'Disc', ShapeStyle: 'Surface', Rate: 24, Lifetime: [0.8, 1.2], Speed: [3, 5], EmissionDirection: 'Top', Size: [[0, 0.2], [0.3, 1.2], [1, 0]], Transparency: [[0, 0.3], [1, 1]], Color: [p.hot, p.mid], LightEmission: 1, Drag: 1, ...tex('core') }
        },
        { name: 'Motes', class: 'ParticleEmitter', props: { Rate: 12, Lifetime: [1, 1.6], Speed: [1, 2], SpreadAngle: [360, 360], Size: [[0, 0], [0.2, 0.25], [1, 0]], Color: p.hot, LightEmission: 1, Acceleration: [0, 3, 0], ...tex('sparks') } },
        { name: 'Glow', class: 'ParticleEmitter', props: { Rate: 3, Lifetime: [0.8, 1], Speed: 0, Size: [[0, 4], [1, 5]], Transparency: [[0, 1], [0.5, 0.7], [1, 1]], Color: p.mid, LightEmission: 1, ZOffset: -1, ...tex('glow') } },
        { name: 'Light', class: 'PointLight', props: { Color: p.mid, Brightness: 2, Range: 10 } }
      ]
    }
  } else if (tags.includes('beam') || tags.includes('lightning') || tags.includes('projectile')) {
    spec = {
      name,
      tags,
      duration: 1.2,
      motion: 'static',
      anchor: [0, 3, -2],
      layers: [
        { name: 'Beam', class: 'Beam', from: [0, 0, 0], to: [0, 0, -14], props: { Width0: 1.2, Width1: 0.6, Color: [p.hot, p.mid], Transparency: [[0, 0], [0.8, 0.2], [1, 1]], LightEmission: 1, FaceCamera: true, Segments: 20, TextureSpeed: 3 }, enable: [[0, 0.6]] },
        { ...core(3, 0.35), name: 'MuzzleCore' },
        sparks(16, 14),
        light
      ]
    }
  } else {
    // impact / explosion / fire / generic burst
    const big = tags.includes('explosion') ? 1.6 : 1
    spec = {
      name,
      tags: tags.length ? tags : ['impact'],
      duration: 1.6,
      motion: 'static',
      anchor: [0, 3, -3],
      layers: [core(4 * big, 0.45), glow(7 * big), sparks(Math.round(24 * big), 26), smoke(8, true), { name: 'Ring', class: 'ParticleEmitter', props: { Lifetime: [0.3, 0.35], Speed: 0, Size: [[0, 1], [1, 9 * big]], Transparency: [[0, 0.2], [1, 1]], Color: p.mid, LightEmission: 1, Orientation: 'VelocityPerpendicular', EmissionDirection: 'Top', ...tex('ring') }, emit: [{ at: 0, count: 1 }] }, light]
    }
    if (tags.includes('fire') && !tags.includes('impact') && !tags.includes('explosion')) {
      spec.duration = 2.5
      spec.anchor = [0, 0.5, -3]
      spec.layers = [
        { name: 'Flames', class: 'ParticleEmitter', shape: { size: [2, 0.5, 2] }, props: { Rate: 30, Lifetime: [0.6, 0.9], Speed: [3, 5], EmissionDirection: 'Top', Size: [[0, 0.5], [0.2, 2.2], [1, 0]], Transparency: [[0, 0.3], [0.5, 0.2], [1, 1]], Color: [p.hot, p.mid, p.cool], LightEmission: 0.8, Rotation: [0, 360], RotSpeed: [-60, 60], Acceleration: [0, 4, 0], ...tex('core') } },
        { name: 'Embers', class: 'ParticleEmitter', props: { Rate: 10, Lifetime: [1, 1.6], Speed: [3, 6], SpreadAngle: [25, 25], Size: [[0, 0.15], [1, 0]], Color: p.hot, LightEmission: 1, Acceleration: [1, 3, 0], ...tex('sparks') } },
        { name: 'Smoke', class: 'ParticleEmitter', props: { Rate: 6, Lifetime: [1.5, 2.2], Speed: [3, 4], EmissionDirection: 'Top', Size: [[0, 1.5], [1, 4]], Transparency: [[0, 1], [0.3, 0.7], [1, 1]], Color: p.smoke, LightEmission: 0, Rotation: [0, 360], RotSpeed: [-20, 20], ZOffset: -1, ...tex('smoke') } },
        { name: 'Light', class: 'PointLight', props: { Color: p.mid, Brightness: 3, Range: 14 } }
      ]
    }
  }
  spec.description = `Draft for "${prompt.trim()}"${rc ? ` using the learned ${rc.tag} recipe (${rc.samples} refs)` : ''}.`
  return spec
}
