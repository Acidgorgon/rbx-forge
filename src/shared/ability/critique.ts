// Ability critique: timing rules that need no model (the impact flash, camera shake, hit-stop and the
// effect's release stage land on the animation's release marker; enough anticipation; room for the
// follow-through), plus the prompt and parser for a vision critic that looks at frames taken at the key
// beats. The rules come with concrete retimes (fixes) the composer or the assistant can apply.

import { applyPatch, validateAbility } from './model.ts'
import { markerTime, resolveAbility, round, type EventLengths, type ResolvedAbility } from './timing.ts'
import { ABILITY_RUBRIC, type Ability, type AbilityChange, type AbilityCritique, type AbilityRubricKey, type TimingCheck } from './types.ts'

// One frame at 60 Hz; "aligned" means within two frames.
export const FRAME = 1 / 60
export const ALIGN = 2 * FRAME + 1e-6
export const RELEASE_MARKERS = ['release', 'impact', 'hit', 'strike', 'fire', 'launch']
export const ANTICIPATION_MARKERS = ['anticipation', 'windup', 'wind-up', 'charge', 'startup']
export const RELEASE_STAGES = ['fire', 'release', 'impact', 'slash', 'strike', 'launch', 'hit', 'drop']
export const HITSTOP_RANGE = { min: 0.03, max: 0.15, maxScale: 0.25 }
export const ANTICIPATION_RANGE = { min: 0.12, hardMin: 0.08, max: 1.2, maxCharged: 3.5 }
export const MIN_FOLLOW_THROUGH = 0.25

export interface CritiqueContext extends EventLengths {
  // Stages of a VFX entry (label + seconds into the effect), when known.
  stages?: (effectId: string) => { label: string; at: number }[] | undefined
}

export function releaseMarker(ability: Ability): { name: string; t: number } | null {
  const a = ability.animation
  if (!a) return null
  for (const want of RELEASE_MARKERS) {
    const m = a.markers.find((x) => x.name.toLowerCase() === want)
    if (m) return { name: m.name, t: markerTime(ability, m.name)! }
  }
  return null
}

function anticipationStart(ability: Ability): { label: string; t: number } {
  const a = ability.animation
  if (a) {
    for (const want of ANTICIPATION_MARKERS) {
      const m = a.markers.find((x) => x.name.toLowerCase() === want)
      if (m) return { label: `"${m.name}" marker`, t: markerTime(ability, m.name)! }
    }
    return { label: 'animation start', t: a.start }
  }
  return { label: 'start', t: 0 }
}

function charged(ability: Ability, ctx: CritiqueContext): boolean {
  const tags = (ability.tags ?? []).map((t) => t.toLowerCase())
  if (tags.some((t) => ['charge', 'charged', 'ultimate', 'cast', 'channel'].includes(t))) return true
  return ability.events.some((e) => e.kind === 'vfx' && (ctx.stages?.(e.effect) ?? []).some((s) => /charge|gather|channel/i.test(s.label)))
}

// The release-like stage of a VFX entry (fire, impact, slash...), seconds into the effect.
export function vfxReleaseStage(stages: { label: string; at: number }[] | undefined): { label: string; at: number } | null {
  if (!stages?.length) return null
  for (const want of RELEASE_STAGES) {
    const s = stages.find((x) => x.label.toLowerCase() === want)
    if (s) return s
  }
  return null
}

const near = (a: number, b: number, before: number, after: number) => a >= b - before && a <= b + after

export function timingChecks(ability: Ability, ctx: CritiqueContext = {}): TimingCheck[] {
  const out: TimingCheck[] = []
  const r = resolveAbility(ability, ctx)
  for (const issue of validateAbility(ability, ctx)) if (issue.level === 'error') out.push({ rule: 'valid', ok: false, level: 'error', message: issue.message })
  const rel = releaseMarker(ability)
  if (!rel) {
    out.push({ rule: 'release-marker', ok: false, level: 'warn', message: `no release marker on the animation (${RELEASE_MARKERS.join(' / ')}): add one in the Animation Lab so the impact can sync to it` })
    return out
  }
  out.push({ rule: 'release-marker', ok: true, level: 'info', message: `release at ${rel.t.toFixed(2)} s ("${rel.name}" marker)` })
  const R = rel.t
  const toRelease = { marker: rel.name, at: 0 }

  const pick = (pred: (e: ResolvedAbility['events'][number]) => boolean, prefer: (e: ResolvedAbility['events'][number]) => number = () => 0) =>
    r.events.filter(pred).sort((a, b) => Math.abs(a.start - R) - Math.abs(b.start - R) || prefer(a) - prefer(b))[0]

  const flash = pick((e) => e.event.kind === 'screen' && (e.event.effect === 'flash' || e.event.effect === 'bloom'), (e) => (e.event.kind === 'screen' && e.event.effect === 'flash' ? 0 : 1))
  if (!flash) out.push({ rule: 'flash-on-release', ok: false, level: 'warn', message: 'no impact flash: add a screen flash (or bloom pop) on the release marker' })
  else if (near(flash.start, R, ALIGN, ALIGN)) out.push({ rule: 'flash-on-release', ok: true, level: 'info', message: `flash "${flash.id}" lands on the release (${(flash.start - R >= 0 ? '+' : '') + ((flash.start - R) * 1000).toFixed(0)} ms)` })
  else out.push({ rule: 'flash-on-release', ok: false, level: 'warn', message: `flash "${flash.id}" starts ${((flash.start - R) * 1000).toFixed(0)} ms from the release; the impact frame should flash`, fix: { event: flash.id, at: toRelease } })

  const shake = pick((e) => e.event.kind === 'shake')
  if (!shake) out.push({ rule: 'shake-on-release', ok: false, level: 'warn', message: 'no camera shake on the impact' })
  else if (near(shake.start, R, ALIGN, 0.05)) out.push({ rule: 'shake-on-release', ok: true, level: 'info', message: `shake "${shake.id}" starts with the release` })
  else out.push({ rule: 'shake-on-release', ok: false, level: 'warn', message: `shake "${shake.id}" starts ${((shake.start - R) * 1000).toFixed(0)} ms from the release`, fix: { event: shake.id, at: toRelease } })

  const stop = pick((e) => e.event.kind === 'hitstop')
  if (!stop) out.push({ rule: 'hitstop-on-release', ok: false, level: 'warn', message: `no hit-stop: a ${HITSTOP_RANGE.min * 1000}-${HITSTOP_RANGE.max * 1000} ms time-scale dip on contact sells the impact` })
  else {
    const h = stop.event as Extract<Ability['events'][number], { kind: 'hitstop' }>
    if (!near(stop.start, R, 0.02, 0.05)) out.push({ rule: 'hitstop-on-release', ok: false, level: 'warn', message: `hit-stop "${stop.id}" is ${((stop.start - R) * 1000).toFixed(0)} ms from the release; it should start on contact`, fix: { event: stop.id, at: toRelease } })
    else out.push({ rule: 'hitstop-on-release', ok: true, level: 'info', message: `hit-stop "${stop.id}" on contact` })
    if (h.duration < HITSTOP_RANGE.min || h.duration > HITSTOP_RANGE.max) {
      const d = round(Math.min(HITSTOP_RANGE.max, Math.max(HITSTOP_RANGE.min, h.duration)))
      out.push({ rule: 'hitstop-length', ok: false, level: 'warn', message: `hit-stop lasts ${(h.duration * 1000).toFixed(0)} ms (${HITSTOP_RANGE.min * 1000}-${HITSTOP_RANGE.max * 1000} ms reads as a hit without feeling like lag)`, fix: { event: stop.id, duration: d } })
    }
    if (h.timeScale > HITSTOP_RANGE.maxScale) out.push({ rule: 'hitstop-depth', ok: false, level: 'warn', message: `hit-stop only slows time to x${h.timeScale}; use ${HITSTOP_RANGE.maxScale} or less` })
  }

  const ant = anticipationStart(ability)
  const A = R - ant.t
  const max = charged(ability, ctx) ? ANTICIPATION_RANGE.maxCharged : ANTICIPATION_RANGE.max
  if (A < ANTICIPATION_RANGE.hardMin) out.push({ rule: 'anticipation', ok: false, level: 'error', message: `anticipation is ${(A * 1000).toFixed(0)} ms (${ant.label} to release): the move pops without a readable wind-up (aim for ${ANTICIPATION_RANGE.min * 1000} ms or more)` })
  else if (A < ANTICIPATION_RANGE.min) out.push({ rule: 'anticipation', ok: false, level: 'warn', message: `anticipation is short (${(A * 1000).toFixed(0)} ms from the ${ant.label}); ${ANTICIPATION_RANGE.min * 1000} ms or more reads better` })
  else if (A > max) out.push({ rule: 'anticipation', ok: false, level: 'warn', message: `anticipation is long (${A.toFixed(2)} s from the ${ant.label}); players feel input lag past ${max} s` })
  else out.push({ rule: 'anticipation', ok: true, level: 'info', message: `anticipation ${A.toFixed(2)} s (${ant.label} to release)` })

  for (const e of r.events) {
    if (e.event.kind !== 'vfx') continue
    const stage = vfxReleaseStage(ctx.stages?.(e.event.effect))
    if (!stage) continue
    const at = e.start + stage.at
    if (near(at, R, ALIGN, ALIGN)) out.push({ rule: 'vfx-release-sync', ok: true, level: 'info', message: `${e.event.effectName}'s "${stage.label}" stage lands on the release` })
    else out.push({ rule: 'vfx-release-sync', ok: false, level: 'warn', message: `${e.event.effectName}'s "${stage.label}" stage is ${((at - R) * 1000).toFixed(0)} ms from the release marker`, fix: { event: e.id, at: { marker: rel.name, at: round(-stage.at) } } })
  }

  const follow = ability.duration - R
  if (follow < MIN_FOLLOW_THROUGH) out.push({ rule: 'follow-through', ok: false, level: 'warn', message: `only ${(follow * 1000).toFixed(0)} ms after the release: leave ${MIN_FOLLOW_THROUGH * 1000} ms or more for the follow-through and recovery` })
  else out.push({ rule: 'follow-through', ok: true, level: 'info', message: `${follow.toFixed(2)} s of follow-through after the release` })
  return out
}

export function timingScore(checks: TimingCheck[]): number {
  let s = 10
  for (const c of checks) if (!c.ok) s -= c.level === 'error' ? 3 : 1.5
  return Math.max(0, Math.round(s * 10) / 10)
}

// Applies every check's fix (retime to the release marker, hit-stop length).
export function applyTimingFixes(ability: Ability, checks: TimingCheck[]): Ability {
  const byId = new Map<string, Record<string, unknown>>()
  for (const c of checks) {
    if (c.ok || !c.fix) continue
    const p = byId.get(c.fix.event) ?? { id: c.fix.event }
    if (c.fix.at) p.at = c.fix.at
    if (c.fix.duration !== undefined) p.duration = c.fix.duration
    byId.set(c.fix.event, p)
  }
  return byId.size ? applyPatch(ability, { events: [...byId.values()] }) : ability
}

// Moments the vision critic sees: wind-up, mid anticipation, release, impact, follow-through.
export function keyBeats(ability: Ability): { label: string; t: number }[] {
  const rel = releaseMarker(ability)
  const D = ability.duration
  if (!rel) return [0.15, 0.4, 0.6, 0.85].map((k) => ({ label: `t${Math.round(k * 100)}%`, t: round(D * k) }))
  const ant = anticipationStart(ability)
  const clamp = (t: number) => round(Math.max(0, Math.min(D - 0.01, t)))
  return [
    { label: 'wind-up', t: clamp(ant.t + 0.05) },
    { label: 'anticipation', t: clamp((ant.t + rel.t) / 2) },
    { label: 'release', t: clamp(rel.t) },
    { label: 'impact', t: clamp(rel.t + 0.08) },
    { label: 'follow-through', t: clamp(rel.t + Math.min(0.4, (D - rel.t) * 0.6)) }
  ]
}

export const ABILITY_CRITIC_SYSTEM = `You are a senior combat designer and animator reviewing a Roblox ability ("move"): an R15 or R6 character animation with VFX, camera shake, screen effects (flash, bloom, colour correction, blur) and hit-stop on one timeline.
You get frames from an approximate WebGL preview (grey R15 or R6 dummy, as the clip's rig, facing away from the camera toward -Z, dark floor grid, screen effects as overlays), the timeline as text and the results of automatic timing checks.
Score each 0-10 (7 = shippable in a good Roblox game, 9 = front-page quality):
- anticipation: a readable wind-up that telegraphs the move without feeling laggy.
- impact: the release frame hits hard: the flash, shake, hit-stop and the effect's peak land together.
- sync: VFX attach to the right body parts and follow the pose; nothing fires early or late.
- readability: the silhouette and effect read at gameplay distance; screen effects do not hide the action.
- followThrough: the move settles: recovery pose, effect dissipates, effects fade out cleanly.
Then propose at most 6 concrete changes as event field edits. Fields: at ({"marker":"release","at":-0.05} or {"at":seconds}), duration, amplitude, frequency, timeScale, attack, hold, release, values.opacity, values.intensity, offset [x,y,z], part (a body part of the clip's rig: R15 names, or R6 Torso / "Right Arm"... when the clip is R6), volume. Use event ids from the timeline.
Answer with JSON only:
{"scores":{"anticipation":n,"impact":n,"sync":n,"readability":n,"followThrough":n},"summary":"two sentences","changes":[{"event":"id","field":"at","value":...,"why":"short"}]}`

export function critiquePrompt(input: { request: string; timeline: string; checks: TimingCheck[]; beats: { label: string; t: number }[] }): string {
  return [
    `Move: ${input.request}`,
    `Frames attached in order at: ${input.beats.map((b) => `${b.label} ${b.t.toFixed(2)} s`).join(', ')}.`,
    '',
    'Timeline:',
    input.timeline,
    '',
    'Timing checks:',
    ...input.checks.map((c) => `- ${c.ok ? 'ok' : c.level}: ${c.message}`)
  ].join('\n')
}

export function parseVisionCritique(raw: string): NonNullable<AbilityCritique['vision']> {
  const m = /\{[\s\S]*\}/.exec(String(raw ?? '').replace(/```(?:json)?/g, ''))
  if (!m) throw new Error('no JSON in the critique')
  const j = JSON.parse(m[0]) as Record<string, any>
  const scores = {} as Record<AbilityRubricKey, number>
  for (const k of ABILITY_RUBRIC) scores[k] = Math.max(0, Math.min(10, Number(j.scores?.[k]) || 0))
  const overall = Math.round((ABILITY_RUBRIC.reduce((s, k) => s + scores[k], 0) / ABILITY_RUBRIC.length) * 10) / 10
  const changes: AbilityChange[] = (Array.isArray(j.changes) ? j.changes : [])
    .filter((c: any) => c && typeof c.event === 'string' && typeof c.field === 'string')
    .slice(0, 6)
    .map((c: any) => ({ event: c.event, field: c.field, value: c.value, ...(c.why ? { why: String(c.why).slice(0, 200) } : {}) }))
  return { scores, overall, summary: String(j.summary ?? '').slice(0, 600), changes }
}

const EDITABLE = new Set(['at', 'duration', 'amplitude', 'frequency', 'timeScale', 'attack', 'hold', 'release', 'offset', 'rotation', 'part', 'attachment', 'volume', 'pitch', 'velocity', 'falloff', 'style'])

// Applies the critic's field edits (unknown events / fields are skipped and reported).
export function applyChanges(ability: Ability, changes: AbilityChange[]): { ability: Ability; skipped: string[] } {
  const skipped: string[] = []
  const events: Record<string, unknown>[] = []
  for (const c of changes) {
    const ev = ability.events.find((e) => e.id === c.event)
    if (!ev) {
      skipped.push(`${c.event}: no such event`)
      continue
    }
    const patch = events.find((e) => e.id === ev.id) ?? (events.push({ id: ev.id }), events[events.length - 1])
    if (c.field.startsWith('values.') && ev.kind === 'screen') patch.values = { ...ev.values, ...((patch.values as object) ?? {}), [c.field.slice(7)]: c.value }
    else if (EDITABLE.has(c.field)) patch[c.field] = c.value
    else skipped.push(`${c.event}.${c.field}: not editable`)
  }
  try {
    return { ability: events.length ? applyPatch(ability, { events }) : ability, skipped }
  } catch (e) {
    return { ability, skipped: [...skipped, (e as Error).message] }
  }
}

export function summarize(checks: TimingCheck[], vision?: AbilityCritique['vision']): string {
  const bad = checks.filter((c) => !c.ok)
  const head = bad.length ? `${bad.length} timing issue${bad.length === 1 ? '' : 's'}: ${bad.slice(0, 3).map((c) => c.message).join('; ')}` : 'Timing rules pass: the impact lands on the release marker.'
  return vision?.summary ? `${head} ${vision.summary}` : head
}
