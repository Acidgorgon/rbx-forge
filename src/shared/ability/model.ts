// Building, validating and editing abilities. normalizeAbility turns loose JSON (from the assistant,
// an old file or the UI) into a well-formed Ability or throws AbilityError with every problem it found;
// validateAbility reports problems without throwing (unknown markers, events past the end...).

import { EASING_STYLES } from '../vfx/timeline.ts'
import type { EasingStyle, Rgb, Vec3 } from '../vfx/types.ts'
import { RIG_ATTACHMENTS } from './rig.ts'
import { markerTime, resolveAbility, type EventLengths } from './timing.ts'
import { EVENT_KINDS, R15_PARTS, type Ability, type AbilityAnimation, type AbilityEvent, type EventKind, type R15Part, type ScreenKind, type ScreenValues, type ShakeFalloff, type SoundSource, type TimeRef } from './types.ts'

export class AbilityError extends Error {}

export const MAX_EVENTS = 64
export const MAX_DURATION = 30

const num = (v: unknown, d: number, min = -Infinity, max = Infinity): number => {
  const x = Number(v)
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : d
}
const r3 = (x: number) => Math.round(x * 1000) / 1000
const vec3 = (v: unknown, d: Vec3): Vec3 => (Array.isArray(v) && v.length >= 3 ? [0, 1, 2].map((i) => r3(num(v[i], d[i]))) as Vec3 : v && typeof v === 'object' && 'x' in (v as object) ? [r3(num((v as any).x, d[0])), r3(num((v as any).y, d[1])), r3(num((v as any).z, d[2]))] : [...d])

function rgb(v: unknown, d: Rgb): Rgb {
  if (typeof v === 'string' && /^#?[0-9a-f]{6}$/i.test(v.trim())) {
    const h = v.trim().replace('#', '')
    return [0, 2, 4].map((i) => r3(parseInt(h.slice(i, i + 2), 16) / 255)) as Rgb
  }
  if (Array.isArray(v) && v.length >= 3) {
    const c = v.slice(0, 3).map((x) => num(x, 1))
    return (c.some((x) => x > 1) ? c.map((x) => r3(Math.min(255, Math.max(0, x)) / 255)) : c.map((x) => r3(Math.min(1, Math.max(0, x))))) as Rgb
  }
  return [...d]
}

export function slug(s: string): string {
  return (
    String(s ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'event'
  )
}

// PascalCase Luau-safe name: "hollow purple!" -> HollowPurple.
export function abilityName(raw: string): string {
  const words = String(raw ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let n = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  if (!n) n = 'Ability'
  if (/^\d/.test(n)) n = `Ability${n}`
  return n.slice(0, 40)
}

export function timeRef(v: unknown): TimeRef {
  if (typeof v === 'number') return { at: r3(Math.max(0, v)) }
  const o = (v ?? {}) as Record<string, unknown>
  const marker = typeof o.marker === 'string' && o.marker.trim() ? o.marker.trim().slice(0, 40) : undefined
  const at = r3(num(o.at ?? o.offset ?? o.t, 0, -MAX_DURATION, MAX_DURATION))
  return marker ? { marker, at } : { at: Math.max(0, at) }
}

const part = (v: unknown, d: R15Part): R15Part => (R15_PARTS.includes(v as R15Part) ? (v as R15Part) : d)
const style = (v: unknown): EasingStyle => EASING_STYLES.find((s) => s.toLowerCase() === String(v ?? '').toLowerCase()) ?? 'Quad'

// A fresh event id that is not taken.
export function newEventId(ability: Pick<Ability, 'events'>, base: string): string {
  const b = slug(base)
  const taken = new Set(ability.events.map((e) => e.id))
  if (!taken.has(b)) return b
  for (let i = 2; ; i++) if (!taken.has(`${b}-${i}`)) return `${b}-${i}`
}

function normalizeSource(v: unknown): SoundSource {
  const o = (v ?? {}) as Record<string, unknown>
  if (o.kind === 'file' && typeof o.path === 'string') return { kind: 'file', path: o.path.slice(0, 1000), name: String(o.name ?? o.path.split(/[\\/]/).pop() ?? 'sound').slice(0, 80) }
  const raw = String(o.id ?? (typeof v === 'string' ? v : '') ?? '')
  const id = /(\d{3,})/.exec(raw)?.[1]
  return { kind: 'asset', id: id ? `rbxassetid://${id}` : '' }
}

function screenValues(kind: ScreenKind, v: unknown): ScreenValues {
  const o = (v ?? {}) as Record<string, unknown>
  switch (kind) {
    case 'flash':
      return { color: rgb(o.color, [1, 1, 1]), opacity: r3(num(o.opacity, 0.8, 0, 1)) }
    case 'colorCorrection':
      return { brightness: r3(num(o.brightness, 0, -1, 1)), contrast: r3(num(o.contrast, 0, -1, 1)), saturation: r3(num(o.saturation, 0, -1, 1)), tint: rgb(o.tint, [1, 1, 1]) }
    case 'bloom':
      return { intensity: r3(num(o.intensity, 1, 0, 5)), size: r3(num(o.size, 24, 0, 56)), threshold: r3(num(o.threshold, 0.8, 0, 4)) }
    case 'blur':
      return { size: r3(num(o.size, 12, 0, 56)) }
  }
}

export function normalizeEvent(raw: unknown, fallbackId: string): AbilityEvent {
  const o = (raw ?? {}) as Record<string, unknown>
  const kind = String(o.kind ?? '') as EventKind
  if (!EVENT_KINDS.includes(kind)) throw new AbilityError(`event "${String(o.id ?? fallbackId)}": kind must be one of ${EVENT_KINDS.join(', ')}`)
  const base = {
    id: typeof o.id === 'string' && o.id.trim() ? slug(o.id) : fallbackId,
    at: timeRef(o.at ?? o.time ?? 0),
    ...(typeof o.label === 'string' && o.label.trim() ? { label: o.label.trim().slice(0, 60) } : {}),
    ...(o.muted === true ? { muted: true } : {})
  }
  switch (kind) {
    case 'vfx': {
      const effect = String(o.effect ?? '').trim()
      if (!effect) throw new AbilityError(`vfx event "${base.id}": effect (a VFX Lab entry id) is required`)
      const attachment = typeof o.attachment === 'string' && RIG_ATTACHMENTS[o.attachment] ? o.attachment : undefined
      return {
        ...base,
        kind,
        effect: effect.slice(0, 100),
        effectName: abilityName(String(o.effectName ?? effect)),
        part: attachment ? RIG_ATTACHMENTS[attachment].part : part(o.part, 'HumanoidRootPart'),
        ...(attachment ? { attachment } : {}),
        offset: vec3(o.offset, [0, 0, 0]),
        rotation: vec3(o.rotation, [0, 0, 0]),
        ...(o.duration !== undefined ? { duration: r3(num(o.duration, 1.5, 0.01, MAX_DURATION)) } : {})
      }
    }
    case 'sound':
      return {
        ...base,
        kind,
        source: normalizeSource(o.source ?? o.soundId ?? o.asset),
        volume: r3(num(o.volume, 0.6, 0, 10)),
        pitch: r3(num(o.pitch, 1, 0.05, 4)),
        ...(o.part ? { part: part(o.part, 'HumanoidRootPart') } : {}),
        ...(o.duration !== undefined ? { duration: r3(num(o.duration, 1, 0.01, MAX_DURATION)) } : {})
      }
    case 'shake':
      return {
        ...base,
        kind,
        duration: r3(num(o.duration, 0.35, 0.01, 10)),
        amplitude: r3(num(o.amplitude, 0.5, 0, 10)),
        frequency: r3(num(o.frequency, 16, 0.1, 60)),
        falloff: (['none', 'linear', 'exponential'] as ShakeFalloff[]).includes(o.falloff as ShakeFalloff) ? (o.falloff as ShakeFalloff) : 'exponential'
      }
    case 'screen': {
      const effect = (['flash', 'colorCorrection', 'bloom', 'blur'] as ScreenKind[]).find((k) => k.toLowerCase() === String(o.effect ?? '').toLowerCase()) ?? 'flash'
      return {
        ...base,
        kind,
        effect,
        attack: r3(num(o.attack, 0.03, 0, 5)),
        hold: r3(num(o.hold, 0.04, 0, 5)),
        release: r3(num(o.release, 0.25, 0, 5)),
        style: style(o.style),
        values: screenValues(effect, o.values ?? o)
      }
    }
    case 'hitstop':
      return { ...base, kind, duration: r3(num(o.duration, 0.08, 0.005, 2)), timeScale: r3(num(o.timeScale ?? o.scale, 0.05, 0.001, 1)) }
    case 'move':
      return { ...base, kind, duration: r3(num(o.duration, 0.2, 0.01, 10)), velocity: vec3(o.velocity, [0, 0, -20]), easing: o.easing === 'constant' ? 'constant' : 'decay' }
  }
}

export function normalizeAnimation(raw: unknown): AbilityAnimation | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const clip = String(o.clip ?? o.id ?? '').trim()
  if (!clip) return null
  const markers = Array.isArray(o.markers)
    ? (o.markers as unknown[])
        .map((m) => m as Record<string, unknown>)
        .filter((m) => m && typeof m.name === 'string' && m.name.trim())
        .map((m) => ({ name: String(m.name).trim().slice(0, 40), t: r3(num(m.t, 0, 0, MAX_DURATION)) }))
    : []
  const assetId = /(\d{3,})/.exec(String(o.assetId ?? ''))?.[1]
  return {
    clip: clip.slice(0, 100),
    name: String(o.name ?? clip).slice(0, 80),
    duration: r3(num(o.duration, 1, 0.01, MAX_DURATION)),
    looped: o.looped === true,
    markers,
    speed: r3(num(o.speed, 1, 0.05, 10)),
    start: r3(num(o.start, 0, 0, MAX_DURATION)),
    fadeIn: r3(num(o.fadeIn, 0.1, 0, 2)),
    ...(assetId ? { assetId: `rbxassetid://${assetId}` } : {})
  }
}

// Loose JSON -> Ability. Throws AbilityError listing what is wrong.
export function normalizeAbility(raw: unknown): Ability {
  if (!raw || typeof raw !== 'object') throw new AbilityError('expected an ability object')
  const o = raw as Record<string, unknown>
  const problems: string[] = []
  const rawEvents = Array.isArray(o.events) ? o.events : []
  if (rawEvents.length > MAX_EVENTS) problems.push(`too many events (${rawEvents.length}; max ${MAX_EVENTS})`)
  const events: AbilityEvent[] = []
  const seen = new Set<string>()
  for (const [i, e] of rawEvents.slice(0, MAX_EVENTS).entries()) {
    try {
      const ev = normalizeEvent(e, `${String((e as any)?.kind ?? 'event')}-${i + 1}`)
      if (seen.has(ev.id)) ev.id = newEventId({ events }, ev.id)
      seen.add(ev.id)
      events.push(ev)
    } catch (err) {
      problems.push((err as Error).message)
    }
  }
  if (problems.length) throw new AbilityError(problems.join('; '))
  const animation = normalizeAnimation(o.animation)
  const ability: Ability = {
    version: 1,
    name: abilityName(String(o.name ?? 'Ability')),
    ...(typeof o.description === 'string' ? { description: o.description.slice(0, 1000) } : {}),
    ...(Array.isArray(o.tags) ? { tags: [...new Set((o.tags as unknown[]).map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 12) } : {}),
    duration: r3(num(o.duration, 0, 0, MAX_DURATION)),
    animation,
    events
  }
  if (!ability.duration) ability.duration = r3(Math.min(MAX_DURATION, Math.max(0.5, resolveAbility(ability).end + 0.2)))
  return ability
}

export interface ValidationIssue {
  level: 'error' | 'warn'
  event?: string
  message: string
}

export function validateAbility(ability: Ability, lengths: EventLengths = {}): ValidationIssue[] {
  const out: ValidationIssue[] = []
  const ids = new Set<string>()
  for (const e of ability.events) {
    if (ids.has(e.id)) out.push({ level: 'error', event: e.id, message: `duplicate event id "${e.id}"` })
    ids.add(e.id)
    if (e.at.marker && markerTime(ability, e.at.marker) === null) out.push({ level: 'error', event: e.id, message: `marker "${e.at.marker}" is not in the animation${ability.animation ? ` (markers: ${ability.animation.markers.map((m) => m.name).join(', ') || 'none'})` : ' (no animation)'}` })
    if (e.kind === 'sound' && e.source.kind === 'asset' && !e.source.id) out.push({ level: 'warn', event: e.id, message: 'sound has no asset id (import or upload one)' })
    if (e.kind === 'sound' && e.source.kind === 'file') out.push({ level: 'warn', event: e.id, message: `sound "${e.source.name}" is a local file: upload it to Roblox and set the asset id before export` })
  }
  const r = resolveAbility(ability, lengths)
  for (const e of r.events) if (e.start > ability.duration + 1e-6) out.push({ level: 'warn', event: e.id, message: `starts at ${e.start.toFixed(2)} s, after the end of the move (${ability.duration} s)` })
  if (ability.animation && ability.animation.markers.length === 0) out.push({ level: 'warn', message: 'the animation has no markers: events can only use absolute times' })
  if (!ability.animation) out.push({ level: 'warn', message: 'no animation: add a clip from the Animation Lab (or a placeholder pose track)' })
  return out
}

// ------------------------------------------------------------------ edits

export function blankAbility(name = 'NewAbility'): Ability {
  return { version: 1, name: abilityName(name), duration: 1.5, animation: null, events: [] }
}

export function defaultEvent(ability: Ability, kind: EventKind, at: TimeRef, extra: Record<string, unknown> = {}): AbilityEvent {
  return normalizeEvent({ kind, at, ...extra, id: newEventId(ability, String(extra.id ?? kind)) }, newEventId(ability, kind))
}

export function upsertEvent(ability: Ability, ev: AbilityEvent): Ability {
  const i = ability.events.findIndex((e) => e.id === ev.id)
  const events = i >= 0 ? ability.events.map((e, k) => (k === i ? ev : e)) : [...ability.events, ev]
  return { ...ability, events }
}

export function removeEvent(ability: Ability, id: string): Ability {
  return { ...ability, events: ability.events.filter((e) => e.id !== id) }
}

// ability_set: top-level fields replace, `events` upserts by id (partial fields merge onto the
// existing event), `remove` deletes ids. Returns the normalised result.
export function applyPatch(ability: Ability, patch: { ability?: Record<string, unknown>; events?: Record<string, unknown>[]; remove?: string[] }): Ability {
  let next: Record<string, unknown> = { ...ability }
  if (patch.ability) {
    const { events: _ignored, ...top } = patch.ability
    next = { ...next, ...top }
    if (top.animation && typeof top.animation === 'object' && ability.animation) next.animation = { ...ability.animation, ...(top.animation as object) }
    if (Array.isArray(patch.ability.events)) next.events = patch.ability.events
  }
  let events = [...((next.events as unknown[]) ?? [])] as Record<string, unknown>[]
  for (const e of patch.events ?? []) {
    const id = typeof e.id === 'string' ? slug(e.id) : null
    const i = id ? events.findIndex((x) => x.id === id) : -1
    if (i >= 0) events[i] = { ...events[i], ...e, id }
    else events.push(e)
  }
  if (patch.remove?.length) events = events.filter((e) => !patch.remove!.includes(String(e.id)))
  return normalizeAbility({ ...next, events })
}
