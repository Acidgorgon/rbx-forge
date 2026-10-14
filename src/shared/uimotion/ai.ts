// The UI Motion Lab's model prompts: "describe the feel" -> an effect stack (compose, default tier)
// and the critique of captured preview frames + the simulated timeline (critic tier), parsing both
// answers and applying the critic's parameter changes. Shared by main and the tests. No node or
// electron imports.

import { overshootAfter, responseTime, simulate, defaultScript } from './engine.ts'
import { EFFECT_KINDS, EFFECT_LIBRARY, MOTION_PRESETS, describeSpec, normalizeEffect, normalizeSpec, usedKinds, type EffectKind, type MotionEffect, type MotionSpec } from './spec.ts'

export interface UiMotionChange {
  // Target path ("" = root).
  path: string
  kind: EffectKind
  // A parameter key, or "add" / "remove" for the whole effect.
  field: string
  value?: unknown
  principle?: string
  why?: string
}

export interface UiMotionVision {
  overall: number
  summary: string
  scores: { feedback: number; feel: number; restraint: number; polish: number }
  changes: UiMotionChange[]
}

const EFFECT_LINES = EFFECT_KINDS.map((k) => {
  const i = EFFECT_LIBRARY[k]
  const params = i.params.map((p) => ('options' in p ? `${p.key}: ${p.options.join('|')}` : 'color' in p ? `${p.key}: [r,g,b] 0..1` : `${p.key} ${p.min}..${p.max}${p.unit ? ` ${p.unit}` : ''}`)).join(', ')
  return `- ${k}: ${i.does} (${i.drives}). ${params}`
}).join('\n')

export const UI_MOTION_GUIDE = `Spring model: x'' = -w^2 (x - goal) - 2 z w x', w = 2 pi frequency, z = damping (1 = critical, no overshoot; 0.5 overshoots ~16%; under 0.4 rings). Frequency sets speed: 4 Hz reaches half way in ~60 ms with z 0.7. Same model as Quenty's Spring (Speed = w, Damper = z).
UI feel rules: feedback within 100 ms of hover / press; press-in before the release pop; keep overshoot modest and settle in about 0.4 s; one spring family across hover / press / pop; scale within 0.85..1.15, tilt under 8 degrees so labels stay readable; reducedMotion "respect" (GuiService.ReducedMotionEnabled drops float, tilt, idle shine, ripples, pops).
Effects (at most one of each kind per target):
${EFFECT_LINES}
Presets: ${MOTION_PRESETS.map((p) => `${p.key} (${p.feel})`).join('; ')}.`

export const UI_COMPOSE_SYSTEM = `You design the feel of Roblox UI elements (buttons, cards, panels) in the RBX Forge UI Motion Lab. Effects are data: a JSON stack that compiles to a client Luau module (TweenService + RenderStepped springs).
Answer with JSON only: {"name":"PascalCaseName","reducedMotion":"respect","targets":[{"path":"","effects":[{"kind":"hover",...}]}],"notes":"one line on the feel"}. path "" is the element root; only use paths from the element list. Only include the effects the brief needs; leave out fields to keep defaults.

${UI_MOTION_GUIDE}`

export const UI_CRITIC_SYSTEM = `You critique the motion of a Roblox UI element in the RBX Forge UI Motion Lab from captured preview frames (rest, hover, pressed, released, settling) and the simulated timeline numbers. Judge feedback speed, feel versus the brief, restraint (overshoot, readability) and polish.
Answer with JSON only: {"overall":0-10,"summary":"two sentences","scores":{"feedback":0-10,"feel":0-10,"restraint":0-10,"polish":0-10},"changes":[{"path":"","kind":"hover","field":"damping","value":0.8,"principle":"ui-overshoot","why":"..."}]}. field may be a parameter key, "add" (value = the whole effect object) or "remove". At most 6 changes, most important first.

${UI_MOTION_GUIDE}`

// Element list for the prompts: relative paths with class names ("Label (TextLabel)").
export function elementsBlock(elements: { path: string; className: string }[]): string {
  if (!elements.length) return 'Elements: (root only)'
  return `Elements (path: class):\n${elements.slice(0, 40).map((e) => `- "${e.path}": ${e.className}`).join('\n')}`
}

export function composePrompt(i: { brief: string; elements: { path: string; className: string }[]; current?: MotionSpec | null; liked?: { name: string; spec: MotionSpec }[]; plan?: string; restatement?: string }): string {
  return [
    `Brief: ${i.brief}`,
    i.restatement ?? '',
    elementsBlock(i.elements),
    i.current && i.current.targets.some((t) => t.effects.length) ? `Current stack:\n${describeSpec(i.current)}` : '',
    ...(i.liked ?? []).slice(0, 2).map((l) => `A stack the user liked (${l.name}):\n${describeSpec(l.spec)}`),
    i.plan ?? ''
  ]
    .filter(Boolean)
    .join('\n\n')
}

function jsonObject(raw: string): Record<string, unknown> | null {
  const m = /\{[\s\S]*\}/.exec(String(raw ?? '').replace(/```(?:json)?/g, ''))
  if (!m) return null
  try {
    const v = JSON.parse(m[0])
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : null
  } catch {
    return null
  }
}

export type ComposeParse = { ok: true; spec: MotionSpec; notes: string; plan: unknown } | { ok: false; kind: 'no-script' | 'parse' | 'script-error'; message: string }

// The compose answer as a spec, checked against the element paths (unknown paths are dropped).
export function parseComposeAnswer(raw: string, paths: string[], fallbackName: string): ComposeParse {
  const m = /\{[\s\S]*\}/.exec(String(raw ?? '').replace(/```(?:json)?/g, ''))
  if (!m) return { ok: false, kind: 'no-script', message: 'no JSON in the answer' }
  let j: Record<string, unknown>
  try {
    j = JSON.parse(m[0])
  } catch (e) {
    return { ok: false, kind: 'parse', message: `JSON parse: ${(e as Error).message}` }
  }
  const spec = normalizeSpec(j, fallbackName)
  const known = new Set(['', ...paths])
  const dropped = spec.targets.filter((t) => !known.has(t.path)).map((t) => t.path)
  spec.targets = spec.targets.filter((t) => known.has(t.path) && t.effects.length)
  if (!spec.targets.length) return { ok: false, kind: 'script-error', message: dropped.length ? `unknown element paths: ${dropped.join(', ')}` : 'no effects in the stack' }
  return { ok: true, spec, notes: typeof j.notes === 'string' ? j.notes.slice(0, 300) : '', plan: j.plan }
}

// Numbers for the critic (and the scorecard): response and overshoot from the simulated timeline.
export function timelineFacts(spec: MotionSpec, path = spec.targets[0]?.path ?? ''): string {
  const tl = simulate(spec, path, defaultScript(usedKinds(spec)), { dt: 1 / 120 })
  const f = (x: number | null) => (x == null ? 'n/a' : `${Math.round(x * 1000)} ms`)
  return [
    `Timeline (simulated, same springs as the Luau): ${tl.events.map((e) => `${e.label ?? e.kind} @${e.at.toFixed(2)}s`).join(', ')}`,
    `hover half-response ${f(responseTime(tl, 'enter'))}, overshoot ${Math.round(overshootAfter(tl, 'enter') * 100)}%`,
    `press half-response ${f(responseTime(tl, 'down'))}; release overshoot ${Math.round(overshootAfter(tl, 'up') * 100)}%`
  ].join('\n')
}

export function critiquePrompt(i: { brief: string; spec: MotionSpec; frames: string[]; principles: string }): string {
  return [`Brief: ${i.brief || '(none: judge it as a general game button)'}`, `Stack:\n${describeSpec(i.spec)}`, timelineFacts(i.spec), `Frames, in order: ${i.frames.join(', ')}`, i.principles].filter(Boolean).join('\n\n')
}

const n10 = (v: unknown, d = 5) => (Number.isFinite(Number(v)) ? Math.max(0, Math.min(10, Number(v))) : d)

export function parseCritique(raw: string): UiMotionVision {
  const j = jsonObject(raw)
  if (!j) throw new Error('no JSON in the critique')
  const s = (j.scores ?? {}) as Record<string, unknown>
  const changes: UiMotionChange[] = []
  for (const c of Array.isArray(j.changes) ? j.changes.slice(0, 8) : []) {
    if (!c || typeof c !== 'object') continue
    const r = c as Record<string, unknown>
    const kind = String(r.kind ?? '') as EffectKind
    if (!EFFECT_LIBRARY[kind]) continue
    const field = String(r.field ?? '')
    if (!field) continue
    changes.push({ path: typeof r.path === 'string' ? r.path : '', kind, field, ...(r.value !== undefined ? { value: r.value } : {}), ...(typeof r.principle === 'string' ? { principle: r.principle } : {}), ...(typeof r.why === 'string' ? { why: r.why.slice(0, 200) } : {}) })
  }
  return {
    overall: n10(j.overall),
    summary: String(j.summary ?? '').slice(0, 600),
    scores: { feedback: n10(s.feedback), feel: n10(s.feel), restraint: n10(s.restraint), polish: n10(s.polish) },
    changes
  }
}

// Applies critic changes to a spec (bounded by the parameter ranges). Returns the new spec and the
// changes that did not apply.
export function applyChanges(spec: MotionSpec, changes: UiMotionChange[]): { spec: MotionSpec; applied: string[]; skipped: string[] } {
  const next = structuredClone(spec)
  const applied: string[] = []
  const skipped: string[] = []
  for (const c of changes) {
    const label = `${c.path || 'root'}.${c.kind}.${c.field}`
    let t = next.targets.find((x) => x.path === c.path)
    if (c.field === 'remove') {
      if (t && t.effects.some((e) => e.kind === c.kind)) {
        t.effects = t.effects.filter((e) => e.kind !== c.kind)
        applied.push(label)
      } else skipped.push(`${label}: not in the stack`)
      continue
    }
    if (!t) {
      if (c.field !== 'add') {
        skipped.push(`${label}: no such target`)
        continue
      }
      t = { path: c.path, effects: [] }
      next.targets.push(t)
    }
    const cur = t.effects.find((e) => e.kind === c.kind)
    let merged: MotionEffect | null
    if (c.field === 'add') merged = normalizeEffect({ ...(cur ?? {}), ...(c.value && typeof c.value === 'object' ? c.value : {}), kind: c.kind })
    else {
      const info = EFFECT_LIBRARY[c.kind]
      if (!info.params.some((p) => p.key === c.field)) {
        skipped.push(`${label}: unknown parameter`)
        continue
      }
      merged = normalizeEffect({ ...(cur ?? info.defaults), [c.field]: c.value })
    }
    if (!merged) {
      skipped.push(`${label}: invalid`)
      continue
    }
    t.effects = cur ? t.effects.map((e) => (e.kind === c.kind ? merged! : e)) : [...t.effects, merged]
    applied.push(label)
  }
  next.targets = next.targets.filter((t) => t.effects.length || t.path === '')
  return { spec: normalizeSpec(next, spec.name), applied, skipped }
}

// No model: pick the preset closest to the brief's words, so compose always gives a starting point.
export function heuristicStack(brief: string, path = ''): { spec: MotionSpec; preset: string } {
  const b = brief.toLowerCase()
  const score = (key: string): number => {
    const words: Record<string, RegExp> = {
      snappy: /snap|tight|quick|fast|crisp|responsive|clean|minimal|subtle/g,
      bouncy: /bounc|playful|spring|jelly|cartoon|fun|wobbl|elastic/g,
      soft: /soft|calm|smooth|gentle|elegant|premium|slow|relax/g,
      juicy: /juic|shop|buy|reward|shine|glow|flashy|loud|claim|sparkl|ripple|exciting/g,
      floaty: /float|idle|hover(ing)? card|menu|tilt|dreamy|alive|breath/g
    }
    return (b.match(words[key]) ?? []).length
  }
  const ranked = MOTION_PRESETS.map((p) => ({ p, s: score(p.key) })).sort((a, b) => b.s - a.s)
  const pick = ranked[0].s > 0 ? ranked[0].p : MOTION_PRESETS[0]
  const spec = normalizeSpec({ name: pick.label, targets: [{ path, effects: structuredClone(pick.effects) }] })
  if (/shine|sheen|glint/.test(b) && !spec.targets[0].effects.some((e) => e.kind === 'shine')) spec.targets[0].effects.push(normalizeEffect({ kind: 'shine', trigger: 'hover' })!)
  if (/glow/.test(b) && !spec.targets[0].effects.some((e) => e.kind === 'glow')) spec.targets[0].effects.push(normalizeEffect({ kind: 'glow' })!)
  if (/ripple|material/.test(b) && !spec.targets[0].effects.some((e) => e.kind === 'ripple')) spec.targets[0].effects.push(normalizeEffect({ kind: 'ripple' })!)
  if (/appear|enter|intro|slide in|pop in/.test(b) && !spec.targets[0].effects.some((e) => e.kind === 'appear')) spec.targets[0].effects.push(normalizeEffect({ kind: 'appear' })!)
  return { spec, preset: pick.key }
}
