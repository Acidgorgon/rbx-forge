// Deterministic first draft of a move from a request, an optional VFX Lab effect and an optional
// animation clip: the effect's release stage is put on the clip's release marker, the impact gets a
// flash, a shake and a hit-stop on the marker, charged moves get a colour-correction build-up, and
// dashes / recoils get a root movement. The assistant (ability_compose) refines the timings from here.

import type { AnimClipRef } from '../anim/types.ts'
import type { Rgb, Vec3 } from '../vfx/types.ts'
import { RELEASE_MARKERS, ANTICIPATION_MARKERS, vfxReleaseStage } from './critique.ts'
import { abilityName, normalizeAbility } from './model.ts'
import { ROOT_HEIGHT } from './rig.ts'
import type { Ability } from './types.ts'

export interface DraftVfx {
  id: string
  name: string
  duration: number
  stages?: { label: string; at: number }[]
  // Where the effect was authored relative to the dummy's feet (VfxEffect.anchor).
  anchor?: Vec3
  colors?: Rgb[]
}

export interface DraftInput {
  request: string
  vfx?: DraftVfx | null
  clip?: AnimClipRef | null
}

const has = (text: string, re: RegExp) => re.test(text.toLowerCase())

// Offset from HumanoidRootPart that puts the effect where the VFX Lab authored it.
export function offsetFromAnchor(anchor: Vec3 | undefined): Vec3 {
  const a = anchor ?? [0, 3.2, -3]
  return [round(a[0]), round(a[1] - ROOT_HEIGHT), round(a[2])]
}

const round = (x: number) => Math.round(x * 1000) / 1000

export function draftAbility(input: DraftInput): Ability {
  const req = String(input.request ?? '').trim()
  const clip = input.clip ?? null
  const vfx = input.vfx ?? null
  const rel = clip?.markers.find((m) => RELEASE_MARKERS.includes(m.name.toLowerCase())) ?? null
  const ant = clip?.markers.find((m) => ANTICIPATION_MARKERS.includes(m.name.toLowerCase())) ?? null
  const stage = vfxReleaseStage(vfx?.stages)
  const big = has(req, /ultimate|huge|massive|slam|nuke|domain|purple|explo|meteor|finisher/)
  const charged = has(req, /charge|cast|channel|beam|kamehameha|purple|ultimate|spirit/) || !!vfx?.stages?.some((s) => /charge|gather/i.test(s.label))
  const hand = has(req, /punch|palm|hand|fist|slash|sword|blade|claw|grab/)
  const flashColor: Rgb = vfx?.colors?.[0] ?? [1, 1, 1]
  const events: Record<string, unknown>[] = []
  const atRelease = rel ? { marker: rel.name, at: 0 } : { at: stage ? stage.at : 0.3 }
  if (vfx) {
    const at = rel && stage ? { marker: rel.name, at: round(-stage.at) } : rel ? { marker: rel.name, at: hand ? -0.05 : 0 } : { at: 0 }
    events.push(hand && !stage ? { id: 'vfx', kind: 'vfx', effect: vfx.id, effectName: vfx.name, attachment: 'RightGripAttachment', offset: [0, 0, 0], at, duration: vfx.duration } : { id: 'vfx', kind: 'vfx', effect: vfx.id, effectName: vfx.name, part: 'HumanoidRootPart', offset: offsetFromAnchor(vfx.anchor), at, duration: vfx.duration })
  }
  if (charged && ant) events.push({ id: 'charge-grade', kind: 'screen', effect: 'colorCorrection', at: { marker: ant.name, at: 0 }, attack: 0.35, hold: 0.1, release: 0.3, style: 'Sine', values: { saturation: -0.25, contrast: 0.15, tint: [0.85 + 0.15 * flashColor[0], 0.85 + 0.15 * flashColor[1], 0.85 + 0.15 * flashColor[2]] } })
  events.push({ id: 'impact-flash', kind: 'screen', effect: 'flash', at: atRelease, attack: 0.02, hold: 0.04, release: big ? 0.35 : 0.2, style: 'Quad', values: { color: flashColor, opacity: big ? 0.85 : 0.55 } })
  if (big) events.push({ id: 'impact-bloom', kind: 'screen', effect: 'bloom', at: atRelease, attack: 0.03, hold: 0.12, release: 0.45, style: 'Quad', values: { intensity: 1.5, size: 40, threshold: 0.6 } })
  events.push({ id: 'impact-shake', kind: 'shake', at: atRelease, duration: big ? 0.5 : 0.25, amplitude: big ? 0.8 : 0.35, frequency: big ? 18 : 24, falloff: 'exponential' })
  events.push({ id: 'hitstop', kind: 'hitstop', at: atRelease, duration: big ? 0.09 : 0.06, timeScale: 0.05 })
  if (has(req, /dash|lunge|rush|leap/)) events.push({ id: 'lunge', kind: 'move', at: ant ? { marker: ant.name, at: 0.05 } : { at: 0 }, duration: 0.25, velocity: [0, 0, -40], easing: 'decay' })
  else if (has(req, /beam|blast|recoil|cannon|purple|kamehameha/)) events.push({ id: 'recoil', kind: 'move', at: atRelease, duration: 0.25, velocity: [0, 0, 8], easing: 'decay' })
  const name = abilityName(req.replace(/\b(make|a|an|the|move|ability|skill|please|with|and|of|that)\b/gi, ' ')) || 'Ability'
  const draft = normalizeAbility({
    name,
    description: req.slice(0, 300),
    tags: [...new Set([...(charged ? ['charge'] : []), ...(big ? ['heavy'] : []), ...(hand ? ['melee'] : [])])],
    // When the effect's build-up is longer than the clip's lead-in, the clip starts later so the
    // release stage can still land on the release marker (the effect starts at 0).
    animation: clip ? { clip: clip.id, name: clip.name, duration: clip.duration, looped: clip.looped, markers: clip.markers, speed: 1, start: rel && stage && stage.at > rel.t ? round(stage.at - rel.t) : 0, fadeIn: 0.1 } : null,
    events
  })
  return draft
}
