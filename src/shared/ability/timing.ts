// Timing of an ability: marker-relative start times resolved to ability time, event lengths, the
// hit-stop time warp, root movement, camera shake and screen-effect envelopes. Pure functions, so the
// preview can scrub, the critic can reason about beats, the exporter can write absolute times and
// tests can check all of it.

import { ease } from '../vfx/timeline.ts'
import type { Rgb, Vec3 } from '../vfx/types.ts'
import type { Ability, AbilityEvent, ScreenEvent, ShakeEvent, TimeRef } from './types.ts'

// Default length of a VFX bar when the effect is unknown, and of a sound without a known length.
export const DEFAULT_VFX_LENGTH = 1.5
export const DEFAULT_SOUND_LENGTH = 1

// Absolute ability time of an animation marker (start + clip time / speed), or null when unknown.
export function markerTime(ability: Pick<Ability, 'animation'>, name: string): number | null {
  const a = ability.animation
  if (!a) return null
  const m = a.markers.find((x) => x.name === name) ?? a.markers.find((x) => x.name.toLowerCase() === name.toLowerCase())
  if (!m) return null
  return a.start + m.t / Math.max(0.01, a.speed)
}

export function markerTimes(ability: Pick<Ability, 'animation'>): { name: string; t: number }[] {
  const a = ability.animation
  if (!a) return []
  return a.markers.map((m) => ({ name: m.name, t: a.start + m.t / Math.max(0.01, a.speed) })).sort((x, y) => x.t - y.t)
}

// Ability time of a TimeRef. An unknown marker falls back to the offset as an absolute time.
export function resolveRef(ability: Pick<Ability, 'animation'>, ref: TimeRef): number {
  const base = ref.marker ? markerTime(ability, ref.marker) : 0
  return Math.max(0, (base ?? 0) + (Number(ref.at) || 0))
}

// A TimeRef that lands on absolute time t, keeping the marker when there is one (drag to retime).
export function refAt(ability: Pick<Ability, 'animation'>, ref: TimeRef, t: number): TimeRef {
  const time = Math.max(0, round(t))
  if (ref.marker) {
    const m = markerTime(ability, ref.marker)
    if (m !== null) return { marker: ref.marker, at: round(time - m) }
  }
  return { at: time }
}

// Snap t to the nearest marker within `tolerance` seconds; returns a marker-relative ref on a hit.
export function snapToMarker(ability: Pick<Ability, 'animation'>, t: number, tolerance: number): { t: number; ref: TimeRef } | null {
  let best: { name: string; t: number } | null = null
  for (const m of markerTimes(ability)) if (Math.abs(m.t - t) <= tolerance && (!best || Math.abs(m.t - t) < Math.abs(best.t - t))) best = m
  return best ? { t: best.t, ref: { marker: best.name, at: 0 } } : null
}

export function round(x: number, digits = 3): number {
  const k = 10 ** digits
  return Math.round(x * k) / k
}

export interface EventLengths {
  // Seconds a VFX entry plays, by library entry id.
  vfx?: (effectId: string) => number | undefined
}

// Length of an event's bar on the timeline (hit-stop: ability-time span, i.e. duration x timeScale).
export function eventLength(ev: AbilityEvent, lengths: EventLengths = {}): number {
  switch (ev.kind) {
    case 'vfx':
      return lengths.vfx?.(ev.effect) ?? ev.duration ?? DEFAULT_VFX_LENGTH
    case 'sound':
      return ev.duration ?? DEFAULT_SOUND_LENGTH
    case 'screen':
      return ev.attack + ev.hold + ev.release
    case 'hitstop':
      return ev.duration * ev.timeScale
    default:
      return ev.duration
  }
}

export interface ResolvedEvent {
  id: string
  kind: AbilityEvent['kind']
  start: number
  end: number
  marker?: string
  event: AbilityEvent
}

export interface ResolvedAbility {
  events: ResolvedEvent[]
  markers: { name: string; t: number }[]
  animation: { start: number; end: number } | null
  // The end of the last thing that happens (animation, events).
  end: number
}

export function resolveAbility(ability: Ability, lengths: EventLengths = {}): ResolvedAbility {
  const events = ability.events
    .filter((e) => !e.muted)
    .map((event): ResolvedEvent => {
      const start = resolveRef(ability, event.at)
      return { id: event.id, kind: event.kind, start, end: start + Math.max(0, eventLength(event, lengths)), ...(event.at.marker ? { marker: event.at.marker } : {}), event }
    })
    .sort((a, b) => a.start - b.start || a.id.localeCompare(b.id))
  const a = ability.animation
  const animation = a ? { start: a.start, end: a.start + a.duration / Math.max(0.01, a.speed) } : null
  const end = Math.max(animation?.end ?? 0, ...events.map((e) => e.end), 0)
  return { events, markers: markerTimes(ability), animation, end }
}

// ------------------------------------------------------------------ hit-stop time warp

// Hit-stop windows in ability time: [start, start + duration * timeScale), running at timeScale.
export function hitStopWindows(resolved: ResolvedAbility): { start: number; end: number; scale: number }[] {
  return resolved.events
    .filter((e) => e.event.kind === 'hitstop')
    .map((e) => {
      const h = e.event as Extract<AbilityEvent, { kind: 'hitstop' }>
      const scale = Math.max(0.001, Math.min(1, h.timeScale))
      return { start: e.start, end: e.start + h.duration * scale, scale }
    })
}

// How fast ability time runs at ability time t (1 outside hit-stops; the slowest overlapping one inside).
export function timeScaleAt(resolved: ResolvedAbility, t: number): number {
  let s = 1
  for (const w of hitStopWindows(resolved)) if (t >= w.start && t < w.end) s = Math.min(s, w.scale)
  return s
}

// Advances ability time by dtReal seconds of wall clock, slowing inside hit-stop windows.
export function advance(resolved: ResolvedAbility, t: number, dtReal: number): number {
  const windows = hitStopWindows(resolved)
  let time = t
  let left = dtReal
  for (let guard = 0; left > 1e-9 && guard < 64; guard++) {
    const s = windows.filter((w) => time >= w.start && time < w.end).reduce((m, w) => Math.min(m, w.scale), 1)
    // Next boundary where the scale may change.
    const bounds = windows.flatMap((w) => [w.start, w.end]).filter((b) => b > time + 1e-9)
    const next = bounds.length ? Math.min(...bounds) : Infinity
    const reach = (next - time) / s
    if (reach >= left) return time + left * s
    time = next
    left -= reach
  }
  return time
}

// Wall-clock seconds one play takes (ability length stretched by the hit-stops).
export function realLength(resolved: ResolvedAbility, length: number): number {
  let extra = 0
  for (const w of hitStopWindows(resolved)) extra += Math.max(0, Math.min(w.end, length) - w.start) * (1 / w.scale - 1)
  return length + extra
}

// ------------------------------------------------------------------ root movement

// Displacement (studs, root space at the start of the move: -Z forward) at ability time t.
export function rootOffset(resolved: ResolvedAbility, t: number): Vec3 {
  const out: Vec3 = [0, 0, 0]
  for (const e of resolved.events) {
    if (e.event.kind !== 'move' || t <= e.start) continue
    const m = e.event
    const d = Math.max(1e-3, m.duration)
    const u = Math.min(d, t - e.start)
    // Constant: v * u. Decay (linear to 0 over d): v * (u - u^2 / 2d).
    const k = m.easing === 'decay' ? u - (u * u) / (2 * d) : u
    for (let i = 0; i < 3; i++) out[i] += m.velocity[i] * k
  }
  return out
}

// ------------------------------------------------------------------ camera shake

function falloff(kind: ShakeEvent['falloff'], u: number): number {
  if (kind === 'none') return 1
  if (kind === 'linear') return 1 - u
  return Math.exp(-4.5 * u) * (1 - u)
}

// Camera offset (studs) and roll (radians) from every shake active at t. Deterministic noise: sums of
// incommensurate sines, so scrubbing shows the same frame every time.
export function shakeAt(resolved: ResolvedAbility, t: number): { offset: Vec3; roll: number; strength: number } {
  const offset: Vec3 = [0, 0, 0]
  let roll = 0
  let strength = 0
  for (const e of resolved.events) {
    if (e.event.kind !== 'shake' || t < e.start || t >= e.end) continue
    const s = e.event
    const u = (t - e.start) / Math.max(1e-3, s.duration)
    const amp = s.amplitude * falloff(s.falloff, u)
    const w = 2 * Math.PI * s.frequency * (t - e.start)
    offset[0] += amp * (0.7 * Math.sin(w * 1.0 + 0.3) + 0.3 * Math.sin(w * 2.37 + 1.1))
    offset[1] += amp * (0.7 * Math.sin(w * 1.13 + 2.1) + 0.3 * Math.sin(w * 2.71 + 0.4))
    offset[2] += amp * 0.25 * Math.sin(w * 0.91 + 4.2)
    roll += amp * 0.02 * Math.sin(w * 0.77 + 0.9)
    strength = Math.max(strength, amp)
  }
  return { offset, roll, strength }
}

// ------------------------------------------------------------------ screen effects

// 0..1 envelope of a screen event at ability time t (attack ease in, hold, release ease out).
export function screenEnvelope(ev: ScreenEvent, start: number, t: number): number {
  const u = t - start
  if (u < 0) return 0
  if (u < ev.attack) return ease(ev.style, 'Out', u / Math.max(1e-4, ev.attack))
  if (u < ev.attack + ev.hold) return 1
  const r = u - ev.attack - ev.hold
  if (r < ev.release) return 1 - ease(ev.style, 'In', r / Math.max(1e-4, ev.release))
  return 0
}

export interface ScreenState {
  flash: { color: Rgb; opacity: number }
  // ColorCorrectionEffect: neutral is 0 / 0 / 0 / white.
  colorCorrection: { brightness: number; contrast: number; saturation: number; tint: Rgb }
  // BloomEffect added on top of the scene (intensity 0 = none).
  bloom: { intensity: number; size: number; threshold: number }
  // BlurEffect.Size (0 = none).
  blur: number
}

export function neutralScreen(): ScreenState {
  return { flash: { color: [1, 1, 1], opacity: 0 }, colorCorrection: { brightness: 0, contrast: 0, saturation: 0, tint: [1, 1, 1] }, bloom: { intensity: 0, size: 24, threshold: 0.8 }, blur: 0 }
}

const lerp = (a: number, b: number, k: number) => a + (b - a) * k
const lerpRgb = (a: Rgb, b: Rgb, k: number): Rgb => [lerp(a[0], b[0], k), lerp(a[1], b[1], k), lerp(a[2], b[2], k)]

// Every screen effect active at t, combined (numbers add, colours blend toward the strongest).
export function screenAt(resolved: ResolvedAbility, t: number): ScreenState {
  const s = neutralScreen()
  let flashW = 0
  for (const e of resolved.events) {
    if (e.event.kind !== 'screen' || t < e.start || t >= e.end) continue
    const ev = e.event
    const k = screenEnvelope(ev, e.start, t)
    if (k <= 0) continue
    const v = ev.values
    if (ev.effect === 'flash') {
      const o = (v.opacity ?? 0.8) * k
      if (o > flashW) {
        flashW = o
        s.flash = { color: v.color ?? [1, 1, 1], opacity: o }
      }
    } else if (ev.effect === 'colorCorrection') {
      s.colorCorrection.brightness += (v.brightness ?? 0) * k
      s.colorCorrection.contrast += (v.contrast ?? 0) * k
      s.colorCorrection.saturation += (v.saturation ?? 0) * k
      if (v.tint) s.colorCorrection.tint = lerpRgb(s.colorCorrection.tint, v.tint, k)
    } else if (ev.effect === 'bloom') {
      s.bloom.intensity += (v.intensity ?? 1) * k
      s.bloom.size = v.size ?? s.bloom.size
      s.bloom.threshold = v.threshold ?? s.bloom.threshold
    } else if (ev.effect === 'blur') {
      s.blur += (v.size ?? 12) * k
    }
  }
  return s
}

// ------------------------------------------------------------------ summary

// One line per event (for the assistant and the critic).
export function timelineText(ability: Ability, lengths: EventLengths = {}): string {
  const r = resolveAbility(ability, lengths)
  const f = (x: number) => x.toFixed(2).padStart(5)
  const lines: string[] = []
  const a = ability.animation
  if (a) lines.push(`${f(a.start)}s  animation ${a.name} (${a.clip}) speed ${a.speed} -> ${f(r.animation!.end).trim()}s; markers ${r.markers.map((m) => `${m.name}@${m.t.toFixed(2)}`).join(', ') || 'none'}`)
  for (const e of r.events) {
    const ev = e.event
    const rel = ev.at.marker ? ` [${ev.at.marker}${ev.at.at >= 0 ? '+' : ''}${ev.at.at}]` : ''
    let what = ''
    if (ev.kind === 'vfx') what = `vfx ${ev.effectName} (${ev.effect}) at ${ev.attachment ?? ev.part} offset (${ev.offset.join(', ')})`
    else if (ev.kind === 'sound') what = `sound ${ev.source.kind === 'asset' ? ev.source.id : ev.source.name} vol ${ev.volume} pitch ${ev.pitch}`
    else if (ev.kind === 'shake') what = `shake ${ev.duration}s amp ${ev.amplitude} freq ${ev.frequency} ${ev.falloff}`
    else if (ev.kind === 'screen') what = `screen ${ev.effect} ${ev.attack}/${ev.hold}/${ev.release}s ${JSON.stringify(ev.values)}`
    else if (ev.kind === 'hitstop') what = `hit-stop ${ev.duration}s at x${ev.timeScale}`
    else if (ev.kind === 'move') what = `move v=(${ev.velocity.join(', ')}) ${ev.duration}s ${ev.easing}`
    lines.push(`${f(e.start)}s  ${ev.id}${rel} ${what}`)
  }
  lines.push(`length ${ability.duration}s`)
  return lines.join('\n')
}
