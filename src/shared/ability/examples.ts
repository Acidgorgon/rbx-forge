// Built-in example moves. Hollow Purple uses the VFX Lab's Hollow Purple example (its "fire" stage
// lands on the cast's "release" marker) and the placeholder pose track until the Animation Lab has a
// real clip for it, with the impact flash, bloom, shake, hit-stop and a recoil on the release.

import { normalizeAbility } from './model.ts'
import { placeholderClips } from './placeholder.ts'
import type { Ability } from './types.ts'

export interface AbilityExample {
  key: string
  name: string
  description: string
  tags: string[]
  // VFX Lab built-in example keys the move needs (vfxAddExample), by event id.
  vfx: Record<string, string>
  build: (effects: Record<string, { id: string; duration?: number }>) => Ability
}

const PURPLE = [0.69, 0.36, 1]

function hollowPurple(effects: Record<string, { id: string; duration?: number }>): Ability {
  const clip = placeholderClips().find((c) => c.id === 'placeholder:hollow-purple')!
  return normalizeAbility({
    name: 'HollowPurple',
    description: 'Gojo-style Hollow Purple: blue then red gather at the hands, converge and merge, the mass charges with a colour grade, then fires on the release marker with a flash, bloom, heavy shake, hit-stop and a recoil step.',
    tags: ['charge', 'heavy', 'projectile', 'example'],
    duration: 3.6,
    animation: { clip: clip.id, name: clip.name, duration: clip.duration, looped: false, markers: clip.markers, speed: 1, start: 0, fadeIn: 0.1 },
    events: [
      { id: 'purple-vfx', kind: 'vfx', label: 'Hollow Purple', effect: effects['purple-vfx'].id, effectName: 'HollowPurple', part: 'HumanoidRootPart', offset: [0, 0.2, -3], rotation: [0, 0, 0], at: { marker: 'release', at: -2.45 }, duration: effects['purple-vfx'].duration ?? 3.35 },
      { id: 'merge-flash', kind: 'screen', label: 'merge pop', effect: 'flash', at: { marker: 'converge', at: 0.6 }, attack: 0.02, hold: 0.03, release: 0.2, style: 'Quad', values: { color: PURPLE, opacity: 0.35 } },
      { id: 'merge-shake', kind: 'shake', at: { marker: 'converge', at: 0.6 }, duration: 0.3, amplitude: 0.25, frequency: 22, falloff: 'exponential' },
      { id: 'charge-grade', kind: 'screen', label: 'charge grade', effect: 'colorCorrection', at: { marker: 'anticipation', at: 0 }, attack: 0.4, hold: 0.1, release: 0.4, style: 'Sine', values: { saturation: -0.35, contrast: 0.2, brightness: -0.05, tint: [0.88, 0.8, 1] } },
      { id: 'release-flash', kind: 'screen', label: 'impact flash', effect: 'flash', at: { marker: 'release', at: 0 }, attack: 0.02, hold: 0.05, release: 0.35, style: 'Quad', values: { color: [0.92, 0.85, 1], opacity: 0.85 } },
      { id: 'release-bloom', kind: 'screen', effect: 'bloom', at: { marker: 'release', at: 0 }, attack: 0.03, hold: 0.15, release: 0.5, style: 'Quad', values: { intensity: 1.6, size: 40, threshold: 0.6 } },
      { id: 'release-blur', kind: 'screen', effect: 'blur', at: { marker: 'release', at: 0.02 }, attack: 0.02, hold: 0, release: 0.25, style: 'Quad', values: { size: 8 } },
      { id: 'release-shake', kind: 'shake', at: { marker: 'release', at: 0 }, duration: 0.55, amplitude: 0.8, frequency: 18, falloff: 'exponential' },
      { id: 'hitstop', kind: 'hitstop', at: { marker: 'release', at: 0 }, duration: 0.09, timeScale: 0.05 },
      { id: 'recoil', kind: 'move', at: { marker: 'release', at: 0 }, duration: 0.25, velocity: [0, 0, 9], easing: 'decay' }
    ]
  })
}

export const ABILITY_EXAMPLES: AbilityExample[] = [
  {
    key: 'hollow-purple',
    name: 'HollowPurple',
    description: 'Hollow Purple cast: VFX Lab Hollow Purple + placeholder pose track, flash, bloom, shake, hit-stop and recoil on the release marker.',
    tags: ['charge', 'heavy', 'projectile', 'example'],
    vfx: { 'purple-vfx': 'hollow-purple' },
    build: hollowPurple
  }
]

export function findAbilityExample(key: string): AbilityExample | null {
  const k = String(key ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-')
  return ABILITY_EXAMPLES.find((e) => e.key === k || e.name.toLowerCase() === k.replace(/-/g, '')) ?? null
}
