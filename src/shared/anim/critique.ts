// The animation critic and the refine loop: frames of the clip on the R15 dummy at its key beats go
// to a vision model with a fixed rubric, together with the automatic checks and the learned style
// profile; its proposed changes (joint offsets, retimes, easing, fixes) are applied and the loop
// repeats until the score passes the threshold. Model and renderer are injected (tests use fakes).
// Without a vision model, a numbers-only critique from the checks and the profile drives the loop.

import type { AnimChange, AnimCheckReport, AnimClip, AnimCritique, AnimRubricKey, AnimStyleProfile } from './model.ts'
import { ANIM_RUBRIC_KEYS } from './model.ts'
import { runChecks } from './checks.ts'
import { clipSummary } from './compile.ts'
import { measureClip, phases } from './measure.ts'
import { applyAnimChanges } from './patch.ts'
import { profileText } from './style.ts'

export const ANIM_RUBRIC_WEIGHTS: Record<AnimRubricKey, number> = { silhouette: 0.2, timing: 0.2, weight: 0.16, arcs: 0.12, appeal: 0.14, cleanliness: 0.18 }
export const ANIM_DEFAULT_THRESHOLD = 7.5
export const ANIM_DEFAULT_MAX_ITERATIONS = 4

export const ANIM_RUBRIC_TEXT = `Rubric (score each 0-10; 7 = shippable in a good Roblox combat game, 9 = front-page quality):
- silhouette: every key pose reads instantly as a shape (clear line of action, limbs off the body, no tangents).
- timing: anticipation, a fast action, a readable hold or impact, then recovery; spacing has fast and slow parts, nothing floaty or robotic.
- weight: the body commits (hips lead, weight shifts over the feet, knees absorb), nothing feels weightless.
- arcs: hands, head and feet travel on arcs; parts overlap and follow through instead of stopping together.
- appeal: the style matches the request and the user's references; the move looks intentional and cool.
- cleanliness: no foot sliding, no joints bending the wrong way, no limbs through the body (see the automatic checks).`

export const ANIM_CRITIC_SYSTEM = `You are a senior animator reviewing an R15 Roblox character animation (a KeyframeSequence).
You get frames of a blocky R15 dummy (dark background, 1-stud grid, the character faces the camera's left-front) at the clip's key beats, the clip's keys summarised, automatic checks (foot sliding, joint limits, interpenetration, silhouette spread, timing against the learned style), and the user's learned style profile.
${ANIM_RUBRIC_TEXT}
Then propose at most 6 concrete changes that raise the lowest scores. Change kinds:
{"kind":"offset","joint":"RightShoulder","at":0.42,"rot":[dx,dy,dz],"why":"..."}  degrees added to that joint's key nearest the time (CFrame.Angles order, joint-local; Shoulder/Hip X+ raises forward, Elbow X+ bends, Knee X- bends, Waist X- leans forward, Waist Y+ turns left)
{"kind":"retime","from":0.0,"to":0.3,"scale":1.4,"why":"..."}  stretch (scale > 1) or squash a span of time
{"kind":"ease","at":0.3,"joint":"RightShoulder"?,"style":"CubicV2|Linear|Constant|Elastic|Bounce","dir":"In|Out|InOut","why":"..."}  easing of the keys at that time (toward the next key)
{"kind":"fix","check":"limits|sliding|penetration","why":"..."}  automatic fix
Joints: Root Waist Neck LeftShoulder LeftElbow LeftWrist RightShoulder RightElbow RightWrist LeftHip LeftKnee LeftAnkle RightHip RightKnee RightAnkle.
Answer with JSON only:
{"scores":{"silhouette":n,"timing":n,"weight":n,"arcs":n,"appeal":n,"cleanliness":n},"summary":"two sentences","changes":[...]}`

// The critic's system prompt for a rig. On R6 the frames show the R6 dummy and the joints are the
// six R6 Motor6Ds (changes may name them as R6 Motor6Ds or as their R15 equivalents).
export function animCriticSystem(rig: 'R15' | 'R6' = 'R15'): string {
  if (rig !== 'R6') return ANIM_CRITIC_SYSTEM
  return ANIM_CRITIC_SYSTEM.replace('reviewing an R15 Roblox character animation', 'reviewing an R6 Roblox character animation')
    .replace('frames of a blocky R15 dummy', 'frames of a blocky R6 dummy (Head, Torso, one straight part per arm and leg)')
    .replace(
      'Joints: Root Waist Neck LeftShoulder LeftElbow LeftWrist RightShoulder RightElbow RightWrist LeftHip LeftKnee LeftAnkle RightHip RightKnee RightAnkle.',
      'Joints (R6 has no waist, elbows, wrists, knees or ankles; judge it as R6, where straight limbs and a leaning root are the style): RootJoint Neck "Right Shoulder" "Left Shoulder" "Right Hip" "Left Hip" (Shoulder / Hip X+ raises the limb forward, the same conventions as R15).'
    )
}

export function animOverall(scores: Record<AnimRubricKey, number>): number {
  let s = 0
  for (const k of ANIM_RUBRIC_KEYS) s += (scores[k] ?? 0) * ANIM_RUBRIC_WEIGHTS[k]
  return Math.round(s * 10) / 10
}

// Frame times for the critic: one inside each beat (40% in), plus the peak of the motion, capped.
export function beatFrameTimes(clip: AnimClip, max = 6): number[] {
  const out = new Set<number>()
  const beats = [...(clip.beats ?? [])].sort((a, b) => a.at - b.at)
  beats.forEach((b, i) => {
    const end = beats[i + 1]?.at ?? clip.duration
    if (end - b.at > 0.02) out.add(Math.round((b.at + (end - b.at) * 0.4) * 100) / 100)
  })
  const ph = phases(clip)
  out.add(Math.round(ph.peakTime * 100) / 100)
  if (out.size < 3) {
    out.add(Math.round(Math.max(0, ph.actionStart - Math.max(0.05, ph.anticipation / 2)) * 100) / 100)
    out.add(Math.round(Math.min(clip.duration, ph.actionEnd + 0.05) * 100) / 100)
    out.add(Math.round(clip.duration * 0.95 * 100) / 100)
  }
  for (const m of clip.markers) if (out.size < max) out.add(Math.round(m.t * 100) / 100)
  return [...out].filter((t) => t >= 0 && t <= clip.duration).sort((a, b) => a - b).slice(0, max)
}

export interface AnimCritiqueInput {
  request: string
  clip: AnimClip
  frameTimes: number[]
  checks: AnimCheckReport
  profile?: AnimStyleProfile | null
  references: { name: string; description: string }[]
  iteration: number
  previous?: AnimCritique | null
}

export function animCritiquePrompt(input: AnimCritiqueInput): string {
  const s = measureClip(input.clip)
  const parts = [
    `Request: ${input.request}`,
    `Iteration ${input.iteration}. Frames attached in order at t = ${input.frameTimes.map((t) => t.toFixed(2)).join(', ')} s (clip ${input.clip.duration.toFixed(2)} s${input.clip.looped ? ', looped' : ''}).`,
    '',
    clipSummary(input.clip, 30),
    `Measured: anticipation ${s.anticipation.toFixed(2)} s, action ${s.action.toFixed(2)} s, recovery ${s.recovery.toFixed(2)} s, holds ${s.holds.toFixed(2)} s, overshoot ${Math.round(s.overshoot * 100)}%, peak spread ${s.spread.toFixed(2)}x standing.`,
    '',
    `Automatic checks (${input.checks.overall}/10): ${Object.entries(input.checks.scores).map(([k, v]) => `${k} ${v}`).join(', ')}`,
    ...input.checks.issues.slice(0, 10).map((i) => `- ${i.severity}: ${i.message}`)
  ]
  if (input.profile) parts.push('', profileText(input.profile))
  if (input.references.length) parts.push('', 'Closest library references:', ...input.references.slice(0, 3).map((r) => `- ${r.name}: ${r.description.slice(0, 200)}`))
  if (input.previous) parts.push('', `Previous critique (${input.previous.overall}/10): ${input.previous.summary}`)
  return parts.join('\n')
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the critic did not answer with JSON')
  return JSON.parse(text.slice(start, end + 1))
}

const cleanScore = (c: AnimCheckReport) => Math.round(((c.scores.sliding + c.scores.limits + c.scores.penetration) / 3) * 10) / 10

// The critic's JSON -> AnimCritique. Cleanliness is never above what the checks measured.
export function parseAnimCritique(raw: string, checks: AnimCheckReport, references: string[] = []): AnimCritique {
  const data = extractJson(raw) as { scores?: Record<string, unknown>; summary?: unknown; changes?: unknown }
  const scores = {} as Record<AnimRubricKey, number>
  for (const k of ANIM_RUBRIC_KEYS) {
    const v = Number(data.scores?.[k])
    scores[k] = Number.isFinite(v) ? Math.max(0, Math.min(10, v)) : 5
  }
  scores.cleanliness = Math.min(scores.cleanliness, cleanScore(checks) + 0.5)
  const changes = Array.isArray(data.changes) ? (data.changes as AnimChange[]).filter((c) => c && typeof c === 'object' && typeof (c as { kind?: unknown }).kind === 'string').slice(0, 8) : []
  return { scores, overall: animOverall(scores), summary: String(data.summary ?? '').slice(0, 600), changes, checks, references }
}

// No vision model: scores and changes from the checks and the learned profile.
export function heuristicAnimCritique(clip: AnimClip, checks: AnimCheckReport, profile?: AnimStyleProfile | null, references: string[] = []): AnimCritique {
  const s = measureClip(clip)
  const changes: AnimChange[] = []
  const notes: string[] = []
  if (checks.scores.limits < 8) changes.push({ kind: 'fix', check: 'limits', why: 'joints past natural limits' })
  if (checks.scores.sliding < 8) changes.push({ kind: 'fix', check: 'sliding', why: 'feet slide while planted' })
  if (checks.scores.penetration < 8) changes.push({ kind: 'fix', check: 'penetration', why: 'arms cut into the body' })
  const ph = phases(clip)
  if (profile && profile.samples > 0) {
    const want = profile.timing.anticipation.median
    if (want > 0.04 && s.anticipation > 0.02 && (s.anticipation < want * 0.75 || s.anticipation > want * 1.4)) {
      const scale = Math.max(0.5, Math.min(2.2, want / s.anticipation))
      changes.push({ kind: 'retime', from: ph.motionStart, to: ph.actionStart, scale: Math.round(scale * 100) / 100, why: `anticipation toward the ${profile.tag} references (${want.toFixed(2)} s)` })
      notes.push(`anticipation ${s.anticipation.toFixed(2)} s vs ${want.toFixed(2)} s in the references`)
    }
    const wantRec = profile.timing.recovery.median
    if (wantRec > 0.05 && s.recovery > 0.02 && (s.recovery < wantRec * 0.7 || s.recovery > wantRec * 1.5)) {
      const scale = Math.max(0.5, Math.min(2.2, wantRec / s.recovery))
      changes.push({ kind: 'retime', from: ph.actionEnd, to: ph.motionEnd, scale: Math.round(scale * 100) / 100, why: `recovery toward the references (${wantRec.toFixed(2)} s)` })
    }
  }
  const timing = checks.scores.timing
  const weight = Math.max(3, Math.min(9, 5 + (s.anticipation > 0.05 ? 1.5 : 0) + (s.overshoot > 0.04 ? 1 : 0) + (s.holds > 0.03 ? 0.5 : 0)))
  const arcs = Math.max(3, Math.min(8.5, 5 + s.overshoot * 10 + (clip.patches?.length ? 0.3 : 0)))
  const scores: Record<AnimRubricKey, number> = {
    silhouette: checks.scores.readability,
    timing,
    weight: Math.round(weight * 10) / 10,
    arcs: Math.round(arcs * 10) / 10,
    appeal: Math.round(Math.min(8, (checks.scores.readability + timing) / 2) * 10) / 10,
    cleanliness: cleanScore(checks)
  }
  return {
    scores,
    overall: animOverall(scores),
    summary: `Numbers-only check (no vision model): checks ${checks.overall}/10${profile ? ` against the "${profile.tag}" profile` : ''}. ${notes.join('; ') || checks.issues.slice(0, 2).map((i) => i.message).join('; ') || 'No issues found.'}`.trim(),
    changes: changes.slice(0, 6),
    checks,
    references
  }
}

// ------------------------------------------------------------------ loop

export interface AnimRefineIteration {
  n: number
  clip: AnimClip
  frames: string[]
  times: number[]
  critique: AnimCritique
  rejected: { change: unknown; reason: string }[]
}

export interface AnimRefineDeps {
  render(clip: AnimClip, iteration: number): Promise<{ frames: string[]; times: number[] }>
  critique(clip: AnimClip, frames: string[], times: number[], iteration: number, previous: AnimCritique | null): Promise<AnimCritique>
  onIteration?(it: AnimRefineIteration): void | Promise<void>
  cancelled?(): boolean
}

export type AnimStopReason = 'threshold' | 'max-iterations' | 'no-changes' | 'cancelled'

export async function animRefineLoop(initial: AnimClip, deps: AnimRefineDeps, opts: { maxIterations?: number; threshold?: number } = {}): Promise<{ best: AnimRefineIteration; iterations: AnimRefineIteration[]; stop: AnimStopReason }> {
  const max = Math.max(1, Math.min(10, Math.floor(opts.maxIterations ?? ANIM_DEFAULT_MAX_ITERATIONS)))
  const threshold = opts.threshold ?? ANIM_DEFAULT_THRESHOLD
  const iterations: AnimRefineIteration[] = []
  let clip = initial
  let previous: AnimCritique | null = null
  let stop: AnimStopReason = 'max-iterations'
  for (let n = 1; n <= max; n++) {
    if (deps.cancelled?.()) {
      stop = 'cancelled'
      break
    }
    const { frames, times } = await deps.render(clip, n)
    const critique = await deps.critique(clip, frames, times, n, previous)
    const it: AnimRefineIteration = { n, clip, frames, times, critique, rejected: [] }
    iterations.push(it)
    previous = critique
    if (critique.overall >= threshold || n === max) {
      await deps.onIteration?.(it)
      stop = critique.overall >= threshold ? 'threshold' : 'max-iterations'
      break
    }
    const r = applyAnimChanges(clip, critique.changes)
    it.rejected = r.rejected
    await deps.onIteration?.(it)
    if (!r.applied.length) {
      stop = 'no-changes'
      break
    }
    clip = { ...r.clip, patches: [...(clip.patches ?? []), ...r.applied] }
  }
  if (!iterations.length) throw new Error('refinement was cancelled before the first render')
  const best = iterations.reduce((a, b) => (b.critique.overall > a.critique.overall ? b : a), iterations[0])
  return { best, iterations, stop }
}

export { runChecks }
