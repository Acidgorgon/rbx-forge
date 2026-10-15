// The "refine until high quality" loop: render -> a vision model critiques the frames against the
// closest library references with a fixed rubric -> apply the proposed parameter changes -> repeat
// until the score crosses the threshold or the iteration cap is hit. Model and renderer are injected,
// so the loop control is tested with fakes (test/vfx.test.ts).

import { allNodes, emitterRole, perfScore, perfWarnings } from './analyze.ts'
import { prop } from './schema.ts'
import { curveShape, evalNumberSequence } from './sequence.ts'
import { applyChanges, compactEffect, SpecError } from './spec.ts'
import { textureSuggestions } from './tex/textures.ts'
import { priorFit } from './priors.ts'
import { changePrinciple } from '../principles/score.ts'
import { RUBRIC_KEYS, type NumberRange, type NumberSequence, type RubricKey, type VfxChange, type VfxCritique, type VfxEffect, type VfxRecipe } from './types.ts'

export const RUBRIC_WEIGHTS: Record<RubricKey, number> = { readability: 0.22, layering: 0.18, timing: 0.16, color: 0.16, silhouette: 0.14, performance: 0.14 }
export const DEFAULT_THRESHOLD = 7.5
export const DEFAULT_MAX_ITERATIONS = 4

export const RUBRIC_TEXT = `Rubric (score each 0-10; 7 = shippable in a good Roblox game, 9 = front-page quality):
- readability: the effect reads instantly at gameplay distance; clear focal point and direction; not mush or noise.
- layering: distinct layers with jobs (bright core, soft glow, fast sparks, smoke or debris, ring/shockwave) that support each other.
- timing: anticipation, a punchy peak, then a clean decay; sizes swell fast and fade out; nothing pops in or out.
- color: a coherent palette with a hot core and cooler or darker falloff; value contrast; additive layers not blown out to white.
- silhouette: a strong, intentional overall shape (arc, burst, column, ring) at the key frames; not a uniform blob.
- performance: particle count, overdraw (large opaque quads), emitter count; cheap enough to play several at once on mobile.`

export const CRITIC_SYSTEM = `You are a senior Roblox VFX artist reviewing an effect made of ParticleEmitters, Beams, Trails and lights.
You get frames from an approximate WebGL preview (dark background, a grey R15 dummy for scale, a 1-stud floor grid), the effect's parameters as JSON, numbers from the closest reference effects in the user's library, and sometimes reference images.
${RUBRIC_TEXT}
Then propose at most 6 concrete parameter changes that would raise the lowest scores. Use only layer names and Roblox property names that exist in the parameters (Rate, Lifetime, Speed, SpreadAngle, Acceleration, Drag, Size, Transparency, Squash, Color, LightEmission, Brightness, Rotation, RotSpeed, ZOffset, Orientation, FlipbookLayout, FlipbookMode, Texture, Width0, Width1, WidthScale, CurveSize0, ...). Values use the same JSON shapes as the parameters: sequences [[t, v], ...] or [[t, v, envelope], ...], colour sequences [[t, "#hex"], ...], ranges [min, max]. To change bursts use prop "emit" with [{"at": seconds, "count": n}].
Better texture: when a layer's texture does not fit its job (sparkle dots on smoke, a round dot on a stretched spark, a ring layer without a ring), change its Texture to a free procedural one, "forgetex://gen/<glow|ring|spark|smoke|crack|star|slash>" (smoke can add "?tint=grey"), or to a forgetex://<id> the user liked if the parameters list one.
For a multi-stage sequence (it has stages: anticipation, charge, release, impact, dissipate...), frames come from inside each stage: judge timing as the beats (readable anticipation, a fast release, the biggest silhouette on impact, a clean dissipate) and name rigs and their layers as they appear in the parameters (e.g. "BlueGlow"); a change to a layer's props is kept when the timeline script is re-run.
Answer with JSON only:
{"scores":{"readability":n,"layering":n,"timing":n,"color":n,"silhouette":n,"performance":n},"summary":"two sentences","changes":[{"node":"LayerName","prop":"Property","value":...,"why":"short"}]}`

export interface CritiqueInput {
  prompt: string
  effect: VfxEffect
  frameTimes: number[]
  references: { name: string; description: string; effect?: VfxEffect }[]
  recipe?: VfxRecipe | null
  iteration: number
  previous?: VfxCritique | null
}

export function critiquePrompt(input: CritiqueInput): string {
  const warnings = perfWarnings(input.effect)
  const parts = [
    `Request: ${input.prompt}`,
    `Iteration ${input.iteration}. Frames attached in order at t = ${input.frameTimes.map((t) => `${t.toFixed(2)}${stageAt(input.effect, t) ? ` (${stageAt(input.effect, t)})` : ''}`).join(', ')} s (one play lasts ${input.effect.duration} s).`,
    ...(input.effect.stages?.length ? [`Stages: ${input.effect.stages.map((s) => `${s.label} @ ${s.at.toFixed(2)} s`).join(', ')}. Choreographed by a timeline script; check each beat reads on its own frame.`] : []),
    '',
    'Effect parameters:',
    JSON.stringify(compactEffect(input.effect)),
    '',
    `Performance guard: ${warnings.length ? warnings.map((w) => `${w.level}: ${w.node ? `${w.node}: ` : ''}${w.message}`).join(' | ') : 'no warnings'} (computed performance score ${perfScore(input.effect)}/10).`
  ]
  if (input.recipe) {
    const r = input.recipe
    parts.push('', `Learned recipe for "${r.tag}" (${r.samples} references): layers ${r.layers.map((l) => `${l.role} ${Math.round(l.share * 100)}%`).join(', ')}; ${r.notes.join(' ')}`)
    const keys = Object.keys(r.ranges).slice(0, 24)
    if (keys.length) parts.push('Ranges (p10-p90): ' + keys.map((k) => `${k} ${r.ranges[k].p10}-${r.ranges[k].p90}`).join('; '))
    if (r.avoid.length) parts.push('The user disliked: ' + r.avoid.join(' | '))
  }
  if (input.references.length) {
    parts.push('', 'Closest references from the library:')
    for (const ref of input.references.slice(0, 3)) parts.push(`- ${ref.name}: ${ref.description}${ref.effect ? `\n  ${JSON.stringify(compactEffect(ref.effect)).slice(0, 1500)}` : ''}`)
  }
  if (input.previous) parts.push('', `Previous critique (${input.previous.overall}/10): ${input.previous.summary}`)
  return parts.join('\n')
}

// The stage a time falls in (the last stage that started at or before t).
export function stageAt(effect: Pick<VfxEffect, 'stages'>, t: number): string | null {
  let label: string | null = null
  for (const s of effect.stages ?? []) if (s.at <= t + 1e-6) label = s.label
  return label
}

// Frame times for a sequence: one inside each stage (40% of the way in, past the transition), so
// the critic sees every beat; capped at `max` (longest stages win), sorted by time.
export function stageFrameTimes(effect: Pick<VfxEffect, 'stages' | 'duration'>, max = 6): number[] {
  const stages = [...(effect.stages ?? [])].sort((a, b) => a.at - b.at)
  if (!stages.length) return []
  const spans = stages.map((s, i) => ({ start: s.at, end: i + 1 < stages.length ? stages[i + 1].at : effect.duration }))
    .filter((s) => s.end - s.start > 0.02)
  const pick = [...spans].sort((a, b) => b.end - b.start - (a.end - a.start)).slice(0, max)
  return pick.map((s) => Math.round((s.start + (s.end - s.start) * 0.4) * 100) / 100).sort((a, b) => a - b)
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the critic did not answer with JSON')
  return JSON.parse(text.slice(start, end + 1))
}

export function overallScore(scores: Record<RubricKey, number>): number {
  let s = 0
  for (const k of RUBRIC_KEYS) s += (scores[k] ?? 0) * RUBRIC_WEIGHTS[k]
  return Math.round(s * 10) / 10
}

// The critic's JSON -> VfxCritique. Performance is the lower of the critic's and the computed score.
export function parseCritique(raw: string, effect: VfxEffect, references: string[] = []): VfxCritique {
  const data = extractJson(raw) as { scores?: Record<string, unknown>; summary?: unknown; changes?: unknown }
  const scores = {} as Record<RubricKey, number>
  for (const k of RUBRIC_KEYS) {
    const v = Number(data.scores?.[k])
    scores[k] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 5
  }
  scores.performance = Math.min(scores.performance, perfScore(effect))
  const changes: VfxChange[] = Array.isArray(data.changes)
    ? (data.changes as Record<string, unknown>[])
        .filter((c) => c && typeof c.node === 'string' && typeof c.prop === 'string' && c.value !== undefined)
        .slice(0, 8)
        .map((c) => ({ node: String(c.node), prop: String(c.prop), value: c.value as VfxChange['value'], ...(c.why ? { why: String(c.why).slice(0, 200) } : {}), ...(changePrinciple(c) ? { principle: changePrinciple(c) } : {}) }))
    : []
  return { scores, overall: overallScore(scores), summary: String(data.summary ?? '').slice(0, 600), changes, references }
}

export interface RefineIteration {
  n: number
  effect: VfxEffect
  frames: string[]
  critique: VfxCritique
  // Changes that could not be applied (unknown node / property / bad value).
  rejected: { change: VfxChange; reason: string }[]
}

export interface RefineDeps {
  // Renders the effect and returns frame references (file names or data URLs).
  render(effect: VfxEffect, iteration: number): Promise<string[]>
  critique(effect: VfxEffect, frames: string[], iteration: number, previous: VfxCritique | null): Promise<VfxCritique>
  onIteration?(it: RefineIteration): void | Promise<void>
  onPhase?(phase: 'render' | 'critique' | 'adjust', iteration: number): void
  // Stops early (user cancelled).
  cancelled?(): boolean
  // Lab gating (services/gating): after a critique below the threshold with rounds left, true ends
  // the loop now (score plateau). Not called on the last round or at the threshold.
  shouldStop?(critique: VfxCritique, iteration: number, remaining: number): Promise<boolean>
}

export type StopReason = 'threshold' | 'max-iterations' | 'no-changes' | 'cancelled' | 'plateau'

export interface RefineResult {
  best: RefineIteration
  iterations: RefineIteration[]
  stop: StopReason
}

export async function refineLoop(initial: VfxEffect, deps: RefineDeps, opts: { maxIterations?: number; threshold?: number } = {}): Promise<RefineResult> {
  const max = Math.max(1, Math.min(10, Math.floor(opts.maxIterations ?? DEFAULT_MAX_ITERATIONS)))
  const threshold = opts.threshold ?? DEFAULT_THRESHOLD
  const iterations: RefineIteration[] = []
  let effect = initial
  let previous: VfxCritique | null = null
  let stop: StopReason = 'max-iterations'
  for (let n = 1; n <= max; n++) {
    if (deps.cancelled?.()) {
      stop = 'cancelled'
      break
    }
    deps.onPhase?.('render', n)
    const frames = await deps.render(effect, n)
    deps.onPhase?.('critique', n)
    const critique = await deps.critique(effect, frames, n, previous)
    const it: RefineIteration = { n, effect, frames, critique, rejected: [] }
    iterations.push(it)
    previous = critique
    if (critique.overall >= threshold) {
      await deps.onIteration?.(it)
      stop = 'threshold'
      break
    }
    if (n === max) {
      await deps.onIteration?.(it)
      stop = 'max-iterations'
      break
    }
    if (await deps.shouldStop?.(critique, n, max - n)) {
      await deps.onIteration?.(it)
      stop = 'plateau'
      break
    }
    deps.onPhase?.('adjust', n)
    let next = effect
    for (const change of critique.changes) {
      try {
        next = applyChanges(next, [change])
      } catch (e) {
        it.rejected.push({ change, reason: e instanceof SpecError ? e.message : String((e as Error).message ?? e) })
      }
    }
    await deps.onIteration?.(it)
    if (next === effect) {
      stop = 'no-changes'
      break
    }
    effect = next
  }
  if (!iterations.length) throw new Error('refinement was cancelled before the first render')
  const best = iterations.reduce((a, b) => (b.critique.overall > a.critique.overall ? b : a), iterations[0])
  return { best, iterations, stop }
}

// No vision model: a numbers-only critique against the learned recipe and the performance guard.
// It cannot judge the look; it nudges parameters into the ranges the references use.
export function heuristicCritique(effect: VfxEffect, recipe: VfxRecipe | null, references: string[] = []): VfxCritique {
  const changes: VfxChange[] = []
  const notes: string[] = []
  let misses = 0
  let checks = 0
  const nodes = allNodes(effect.roots).filter((n) => n.className === 'ParticleEmitter')
  const roles = new Set(nodes.map((n) => emitterRole(n)))
  // The learned ranges of the user's effects (priors.ts): lifetime, speed, size peak, blending,
  // drag, burst counts and fade-outs per layer role; the farthest misses first.
  const prior = priorFit(effect, recipe, { minSamples: 1 })
  checks += prior.checks
  misses += prior.issues.length
  for (const i of [...prior.issues].sort((a, b) => Number(b.far) - Number(a.far))) changes.push(i.fix)
  if (prior.issues.length) notes.push(prior.issues.slice(0, 2).map((i) => i.message).join('; ') + '.')
  for (const n of nodes) {
    const role = emitterRole(n)
    const size = prop<NumberSequence>(n, 'Size')
    if (curveShape(size) === 'constant' && role !== 'glow') {
      checks++
      misses++
      const v = size[0]?.v ?? 1
      changes.push({ node: n.name, prop: 'Size', value: [[0, v * 0.4], [0.15, v], [1, 0]], why: 'quick swell then decay instead of a constant size', principle: 'fx-timing' })
    }
    const tr = prop<NumberSequence>(n, 'Transparency')
    if (evalNumberSequence(tr, 1) < 0.9 && !changes.some((c) => c.prop === 'Transparency' && (c.node === n.name || c.node === n.id))) {
      checks++
      misses++
      changes.push({ node: n.name, prop: 'Transparency', value: [...tr.filter((k) => k.t < 0.7).map((k) => [k.t, k.v]), [1, 1]], why: 'fade out instead of popping at the end of life', principle: 'fx-dissipation' })
    }
  }
  // Better-texture actions (built-in textures used for a job they do not fit).
  // First, so the cap of six keeps them.
  for (const c of textureSuggestions(effect, (n) => emitterRole(n)).reverse()) {
    checks++
    misses++
    changes.unshift({ ...c, principle: c.principle ?? 'fx-shape' })
  }
  const missingRoles = recipe ? recipe.layers.filter((l) => l.share >= 0.2 && !roles.has(l.role as never) && ['core', 'glow', 'sparks', 'smoke'].includes(l.role)).map((l) => l.role) : []
  if (missingRoles.length) notes.push(`The references usually also have ${missingRoles.join(', ')} layers.`)
  const fit = checks ? 1 - misses / checks : 0.6
  const perf = perfScore(effect)
  const layering = Math.min(10, 4 + roles.size * 1.5 - missingRoles.length)
  const base = Math.round((4 + fit * 5) * 10) / 10
  const scores: Record<RubricKey, number> = { readability: base, layering: Math.max(0, layering), timing: base, color: Math.min(9, base + 0.5), silhouette: base, performance: perf }
  return {
    scores,
    overall: overallScore(scores),
    summary: (checks
      ? `Numbers-only check (no vision model): ${misses} of ${checks} parameters outside the learned ranges${recipe ? ` for "${recipe.tag}"` : ''}. ${notes.join(' ')}`
      : `Numbers-only check (no vision model, no learned recipe for this type yet): only layering, timing and the performance guard were checked. ${notes.join(' ')}`
    ).trim(),
    changes: changes.slice(0, 6),
    references
  }
}
