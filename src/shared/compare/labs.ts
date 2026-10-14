// CompareItems for the VFX Lab, the Animation Lab and the Ability Composer: an entry's current
// version, each of its refine iterations, and the other library entries' current versions. The
// parameter maps are lab-shaped (nodes by name, joints by name, events by label) so a diff reads
// like the editor does. Pure code; other labs build their items with flattenParams the same way.

import type { AnimClip, AnimEntry } from '../anim/model.ts'
import type { Ability, AbilityEntry } from '../ability/types.ts'
import type { ColorKey, NumKey, PropValue, VfxEffect, VfxEntry, VfxNode } from '../vfx/types.ts'
import { flattenParams, hashString, roundTo } from './diff.ts'
import type { CompareItem, ParamMap } from './types.ts'

const r3 = (n: number) => roundTo(n, 3)

function isNumKeys(v: unknown[]): v is NumKey[] {
  return v.every((k) => k && typeof k === 'object' && 'v' in (k as object) && 't' in (k as object))
}
function isColorKeys(v: unknown[]): v is ColorKey[] {
  return v.every((k) => k && typeof k === 'object' && 'c' in (k as object) && 't' in (k as object))
}
function hex(c: number[]): string {
  return `#${c.map((x) => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('')}`
}

// One Roblox property value as one diffable string / number (sequences stay one line).
export function vfxPropValue(v: PropValue): string | number | boolean {
  if (typeof v !== 'object') return typeof v === 'number' ? r3(v) : v
  const arr = v as unknown[]
  if (!arr.length) return '[]'
  if (typeof arr[0] === 'number') {
    const nums = arr as number[]
    // color3 is 0..1 and 3 long; a CFrame shows its position.
    if (nums.length === 12) return `pos [${nums.slice(0, 3).map((n) => roundTo(n, 2)).join(', ')}] rot ${hashString(nums.slice(3).map((n) => roundTo(n, 3)).join(','))}`
    return `[${nums.map(r3).join(', ')}]`
  }
  if (isColorKeys(arr)) return arr.map((k) => `${r3(k.t)}:${hex(k.c)}`).join(' → ')
  if (isNumKeys(arr)) return arr.map((k) => `${r3(k.t)}:${r3(k.v)}${k.e ? `±${r3(k.e)}` : ''}`).join(' → ')
  return JSON.stringify(v)
}

export function vfxEffectParams(effect: VfxEffect): ParamMap {
  const out: ParamMap = {}
  const names = new Map<string, string>()
  const walk = (nodes: VfxNode[], prefix: string) => {
    const seen = new Map<string, number>()
    for (const n of nodes) {
      const count = seen.get(n.name) ?? 0
      seen.set(n.name, count + 1)
      const path = `${prefix}${n.name}${count ? `#${count + 1}` : ''}`
      names.set(n.id, path)
      out[`${path}.class`] = n.className
      for (const [k, v] of Object.entries(n.props)) out[`${path}.${k}`] = vfxPropValue(v)
      if (n.source) out[`${path}.source`] = `<${n.source.length} chars #${hashString(n.source)}>`
      walk(n.children, `${path}/`)
    }
  }
  walk(effect.roots, '')
  out['effect.duration'] = r3(effect.duration)
  if (effect.motion) out['effect.motion'] = effect.motion
  if (effect.anchor) out['effect.anchor'] = `[${effect.anchor.map(r3).join(', ')}]`
  for (const s of effect.stages ?? []) out[`stage.${s.label}`] = r3(s.at)
  effect.cues.forEach((c, i) => {
    const target = names.get(c.target) ?? c.target
    const base = `cue[${i}]`
    out[`${base}`] = `${c.action} ${target}`
    out[`${base}.at`] = r3(c.at)
    if (c.count != null) out[`${base}.count`] = c.count
    if (c.duration != null) out[`${base}.duration`] = r3(c.duration)
    if (c.style) out[`${base}.style`] = `${c.style}${c.direction ? ` ${c.direction}` : ''}`
    for (const [k, v] of Object.entries(c.props ?? {})) out[`${base}.${k}`] = vfxPropValue(v)
  })
  if (effect.script) out['script'] = `<${effect.script.split('\n').length} lines #${hashString(effect.script)}>`
  if (effect.patches?.length) out['patches'] = effect.patches.length
  return out
}

function when(at: number | undefined): string | undefined {
  if (!at) return undefined
  const d = new Date(at)
  return `${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })} ${d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })}`
}

export interface VfxPayload {
  effect: VfxEffect
}

export function vfxCompareItems(entry: VfxEntry, library: VfxEntry[] = []): CompareItem<VfxPayload>[] {
  const out: CompareItem<VfxPayload>[] = []
  const its = entry.iterations ?? []
  const best = its.filter((i) => i.critique).reduce<(typeof its)[number] | null>((x, y) => (!x || (y.critique!.overall > x.critique!.overall) ? y : x), null)
  const last = its[its.length - 1]
  if (entry.effect) {
    // The current version carries the latest critique when it is that iteration's effect.
    const crit = last && JSON.stringify(last.effect) === JSON.stringify(entry.effect) ? last.critique : undefined
    out.push({
      id: entry.id,
      entryId: entry.id,
      label: 'current',
      group: 'This effect',
      sub: when(entry.updatedAt),
      at: entry.updatedAt,
      duration: entry.effect.duration,
      overall: crit?.overall,
      scores: crit?.scores,
      principles: crit?.principles,
      principleScore: crit?.principleScore,
      params: vfxEffectParams(entry.effect),
      payload: { effect: entry.effect },
      current: true
    })
  }
  for (const it of its) {
    out.push({
      id: `${entry.id}#${it.n}`,
      entryId: entry.id,
      label: `#${it.n}`,
      group: 'This effect',
      sub: when(it.at),
      at: it.at,
      duration: it.effect.duration,
      overall: it.critique?.overall,
      scores: it.critique?.scores,
      principles: it.critique?.principles,
      principleScore: it.critique?.principleScore,
      params: vfxEffectParams(it.effect),
      payload: { effect: it.effect },
      best: it === best
    })
  }
  for (const e of library) {
    if (e.id === entry.id || !e.effect) continue
    const crit = e.iterations?.[e.iterations.length - 1]?.critique
    out.push({ id: e.id, entryId: e.id, label: e.name, group: 'Library', sub: e.scope, at: e.updatedAt, duration: e.effect.duration, overall: crit?.overall, scores: crit?.scores, principles: crit?.principles, principleScore: crit?.principleScore, params: vfxEffectParams(e.effect), payload: { effect: e.effect } })
  }
  return out
}

// Animation: clip facts, markers and beats by name, per-joint key counts / times / easing (the full
// CFrames would be thousands of numbers; a key's pose shows as a short hash so an edited pose is one change).
export function animClipParams(clip: AnimClip): ParamMap {
  const out: ParamMap = {
    'clip.duration': r3(clip.duration),
    'clip.looped': clip.looped,
    'clip.priority': clip.priority,
    'clip.rig': clip.rig ?? 'R15'
  }
  for (const m of clip.markers) out[`marker.${m.name}`] = r3(m.t)
  for (const b of clip.beats ?? []) out[`beat.${b.label}`] = r3(b.at)
  for (const [joint, keys] of Object.entries(clip.tracks)) {
    if (!keys?.length) continue
    out[`${joint}.keys`] = keys.length
    out[`${joint}.times`] = keys.map((k) => roundTo(k.t, 2)).join(' ')
    const eases = [...new Set(keys.map((k) => `${k.ease ?? 'Linear'}${k.dir && k.dir !== 'In' ? ` ${k.dir}` : ''}`))]
    out[`${joint}.easing`] = eases.join(', ')
    out[`${joint}.poses`] = hashString(keys.map((k) => k.cf.map((n) => roundTo(n, 3)).join(',')).join(';'))
  }
  if (clip.script) out['script'] = `<${clip.script.split('\n').length} lines #${hashString(clip.script)}>`
  if (clip.patches?.length) out['patches'] = clip.patches.length
  return out
}

export interface AnimPayload {
  clip: AnimClip
}

export function animCompareItems(entry: AnimEntry, library: AnimEntry[] = []): CompareItem<AnimPayload>[] {
  const its = entry.iterations ?? []
  const best = its.filter((i) => i.critique).reduce<(typeof its)[number] | null>((x, y) => (!x || y.critique!.overall > x.critique!.overall ? y : x), null)
  const last = its[its.length - 1]
  const crit = last && JSON.stringify(last.clip) === JSON.stringify(entry.clip) ? last.critique : undefined
  const out: CompareItem<AnimPayload>[] = [
    {
      id: entry.id,
      entryId: entry.id,
      label: 'current',
      group: 'This clip',
      sub: when(entry.updatedAt),
      at: entry.updatedAt,
      duration: entry.clip.duration,
      overall: crit?.overall,
      scores: crit?.scores,
      principles: crit?.principles,
      principleScore: crit?.principleScore,
      params: animClipParams(entry.clip),
      payload: { clip: entry.clip },
      current: true
    }
  ]
  for (const it of its) {
    out.push({
      id: `${entry.id}#${it.n}`,
      entryId: entry.id,
      label: `#${it.n}`,
      group: 'This clip',
      sub: when(it.at),
      at: it.at,
      duration: it.clip.duration,
      overall: it.critique?.overall,
      scores: it.critique?.scores,
      principles: it.critique?.principles,
      principleScore: it.critique?.principleScore,
      params: animClipParams(it.clip),
      payload: { clip: it.clip },
      best: it === best
    })
  }
  for (const e of library) {
    if (e.id === entry.id || e.kind === 'media') continue
    const c = e.iterations?.[e.iterations.length - 1]?.critique
    out.push({ id: e.id, entryId: e.id, label: e.name, group: 'Library', sub: `${e.scope} · ${e.clip.rig ?? 'R15'}`, at: e.updatedAt, duration: e.clip.duration, overall: c?.overall, scores: c?.scores, principles: c?.principles, principleScore: c?.principleScore, params: animClipParams(e.clip), payload: { clip: e.clip } })
  }
  return out
}

// Ability: the animation's facts and every event by kind + label (or id), with its own fields.
export function abilityParams(ability: Ability): ParamMap {
  const out: ParamMap = { 'move.duration': r3(ability.duration) }
  const a = ability.animation
  if (a) Object.assign(out, flattenParams({ clip: a.name, speed: a.speed, start: a.start, fadeIn: a.fadeIn, rig: a.rig ?? 'R15' }, {}, 'animation'))
  else out['animation'] = 'none'
  const seen = new Map<string, number>()
  for (const e of ability.events) {
    const base0 = `${e.kind}:${e.label || e.id}`
    const n = (seen.get(base0) ?? 0) + 1
    seen.set(base0, n)
    const base = n > 1 ? `${base0}#${n}` : base0
    const { id: _id, kind: _kind, label: _label, at, ...rest } = e as unknown as Record<string, unknown> & { at: { at: number; marker?: string } }
    out[`${base}.at`] = at.marker ? `${at.marker}${at.at >= 0 ? '+' : ''}${r3(at.at)}` : r3(at.at)
    Object.assign(out, flattenParams(rest, { skip: ['effect'] }, base))
  }
  return out
}

export interface AbilityPayload {
  ability: Ability
}

export function abilityCompareItems(entry: AbilityEntry, library: AbilityEntry[] = []): CompareItem<AbilityPayload>[] {
  const item = (e: AbilityEntry, group: string, label: string, current?: boolean): CompareItem<AbilityPayload> => {
    const c = e.critique
    return {
      id: e.id,
      entryId: e.id,
      label,
      group,
      sub: when(e.updatedAt),
      at: e.updatedAt,
      duration: e.ability.duration,
      overall: c?.overall,
      scores: c ? { timing: c.timingScore, ...(c.vision?.scores ?? {}) } : undefined,
      principles: c?.principles,
      principleScore: c?.principleScore,
      params: abilityParams(e.ability),
      payload: { ability: e.ability },
      current
    }
  }
  return [item(entry, 'This move', entry.name, true), ...library.filter((e) => e.id !== entry.id).map((e) => item(e, 'Library', e.name))]
}
