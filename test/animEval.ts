// Offline eval of the Animation Lab refinement (npm run eval:anim; test/animEval.test.ts runs it too).
//
// A fixed set of prompts (football skills, a header, combat moves), each with a small library of
// synthetic "real" reference clips and a first draft that uses the right limb but a bit timidly. Two
// fake critics drive the refine loop (no model, no renderer, no Lune):
//   biased   the failure mode seen in the app: scores every round higher than the last and proposes a
//            mix of real fixes and "tidy" edits that pull the lead leg / arm back toward rest
//   helpful  an honest critic: scores track the code metrics and its edits are the priors' own fixes
// Each prompt runs through the pipeline before this change (the frozen loop below: last-best by the
// critic's score, every edit applied as given, checks without intent or priors) and the current one
// (keep-best ranking, guarded edits, intent from the references, learned priors). Both final clips
// are judged by the same code metrics:
//   lead       the limb that should lead does (moves at least half the references' swing, not out-moved)
//   swing      lead swing / the references' median swing
//   priors     share of the learned priors the clip satisfies (0..10)
//   smooth     smoothness score (0..10)
//   slide      support foot sliding (studs)
//   objective  the combined code score (0..10)
//   kept       the final clip is not worse than round 1 (objective)
// plus whether the lead limb is inferred correctly from the prompt and the library.

import { pathToFileURL } from 'node:url'
import type { AnimChange, AnimClip, AnimCritique, AnimEntry, AnimRubricKey, AnimStyleProfile, R15Joint } from '../src/shared/anim/model.ts'
import { qeulerDeg, eulerDegOf, xfToCf, type V3 } from '../src/shared/anim/math.ts'
import { sampleTrack } from '../src/shared/anim/sample.ts'
import { runChecks } from '../src/shared/anim/checks.ts'
import { animOverall, animRefineLoop, betterIteration, withMustFix } from '../src/shared/anim/critique.ts'
import { applyAnimChanges } from '../src/shared/anim/patch.ts'
import { buildProfile } from '../src/shared/anim/style.ts'
import { phases } from '../src/shared/anim/measure.ts'
import { requestedParts, measureParts } from '../src/shared/anim/bodyparts.ts'
import { motionIntent, type Limb, type MotionIntent } from '../src/shared/anim/intent.ts'
import { guardedApply, iterationScore, objectiveScore, type QualityContext } from '../src/shared/anim/quality.ts'
import { peakOf, priorChecks, priorScore, smoothScore } from '../src/shared/anim/priors.ts'
import { moveSetDef, setPromptTags } from '../src/shared/anim/movesets.ts'

// ------------------------------------------------------------------ clips

type Keys = Partial<Record<R15Joint, [number, V3, V3?][]>>

function clipOf(name: string, duration: number, keys: Keys): AnimClip {
  const tracks: AnimClip['tracks'] = {}
  for (const [j, ks] of Object.entries(keys) as [R15Joint, [number, V3, V3?][]][]) tracks[j] = ks.map(([t, e, p]) => ({ t: Math.round(t * 1000) / 1000, cf: xfToCf({ p: p ?? [0, 0, 0], q: qeulerDeg(e) }), ease: 'CubicV2', dir: 'InOut' }))
  return { name, duration, looped: false, priority: 'Action', tracks, markers: [], source: 'rbxm' }
}

// Scales times by ts and the listed joints' angles by amp (variation between references, timid drafts).
function vary(keys: Keys, ts: number, amp: number, joints: R15Joint[] = []): Keys {
  const out: Keys = {}
  for (const [j, ks] of Object.entries(keys) as [R15Joint, [number, V3, V3?][]][]) {
    const a = joints.includes(j) ? amp : 1
    out[j] = ks.map(([t, e, p]) => [t * ts, e.map((x) => x * a) as V3, p])
  }
  return out
}

const ELASTICO: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.25, [-4, 8, 0], [0, -0.15, 0]], [0.45, [-4, -8, 0], [0, -0.15, 0]], [1, [0, 0, 0], [0, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.25, [-8, 15, 5]], [0.45, [-5, -14, -4]], [1, [0, 0, 0]]],
  RightHip: [[0, [0, 0, 0]], [0.25, [25, 0, 32]], [0.42, [22, 0, -22]], [0.6, [6, 0, 0]], [1, [0, 0, 0]]],
  RightKnee: [[0, [0, 0, 0]], [0.22, [-42, 0, 0]], [0.42, [-32, 0, 0]], [0.6, [-10, 0, 0]], [1, [0, 0, 0]]],
  RightAnkle: [[0, [0, 0, 0]], [0.25, [10, 0, 8]], [0.42, [5, 0, -8]], [1, [0, 0, 0]]],
  LeftHip: [[0, [0, 0, 0]], [0.3, [-6, 0, 0]], [1, [0, 0, 0]]],
  LeftKnee: [[0, [0, 0, 0]], [0.3, [-18, 0, 0]], [1, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.3, [10, 0, -35]], [1, [0, 0, 0]]],
  RightShoulder: [[0, [0, 0, 0]], [0.3, [-10, 0, 22]], [1, [0, 0, 0]]]
}

const SHOT: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.4, [-6, 12, 0], [0.05, -0.2, 0]], [0.55, [6, -14, 0], [0, -0.05, -0.1]], [1.2, [0, 0, 0], [0, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.4, [-6, 18, 0]], [0.55, [10, -22, 0]], [1.2, [0, 0, 0]]],
  RightHip: [[0, [0, 0, 0]], [0.4, [-50, 0, 6]], [0.52, [72, 4, -6]], [0.7, [58, 0, 0]], [1.2, [0, 0, 0]]],
  RightKnee: [[0, [0, 0, 0]], [0.4, [-88, 0, 0]], [0.52, [-12, 0, 0]], [1.2, [0, 0, 0]]],
  LeftHip: [[0, [0, 0, 0]], [0.45, [-12, 0, 0]], [1.2, [0, 0, 0]]],
  LeftKnee: [[0, [0, 0, 0]], [0.45, [-26, 0, 0]], [1.2, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.45, [25, 0, -42]], [1.2, [0, 0, 0]]],
  RightShoulder: [[0, [0, 0, 0]], [0.45, [-25, 0, 32]], [1.2, [0, 0, 0]]],
  Neck: [[0, [0, 0, 0]], [0.5, [-14, 0, 0]], [1.2, [0, 0, 0]]]
}

const STEPOVER: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.3, [-3, -10, 0], [0, -0.12, 0]], [0.6, [-3, 12, 0], [0.1, -0.1, 0]], [0.9, [0, 0, 0], [0, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.25, [-6, -16, 0]], [0.5, [-4, 14, 0]], [0.9, [0, 0, 0]]],
  RightHip: [[0, [0, 0, 0]], [0.18, [32, 0, 18]], [0.34, [26, 0, -28]], [0.5, [4, 0, -6]], [0.9, [0, 0, 0]]],
  RightKnee: [[0, [0, 0, 0]], [0.18, [-48, 0, 0]], [0.34, [-36, 0, 0]], [0.5, [-8, 0, 0]], [0.9, [0, 0, 0]]],
  LeftKnee: [[0, [0, 0, 0]], [0.3, [-20, 0, 0]], [0.9, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.3, [5, 0, -28]], [0.9, [0, 0, 0]]],
  RightShoulder: [[0, [0, 0, 0]], [0.3, [-5, 0, 24]], [0.9, [0, 0, 0]]]
}

const HEADER: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.3, [12, 0, 0], [0, -0.3, 0.1]], [0.55, [-55, 0, 0], [0, -0.9, -1.2]], [1, [-70, 0, 0], [0, -1.6, -2]]],
  Neck: [[0, [0, 0, 0]], [0.3, [18, 0, 0]], [0.5, [-26, 0, 0]], [1, [-5, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.3, [10, 0, 0]], [0.5, [-14, 0, 0]], [1, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.5, [60, 0, -20]], [1, [90, 0, -10]]],
  RightShoulder: [[0, [0, 0, 0]], [0.5, [60, 0, 20]], [1, [90, 0, 10]]],
  RightHip: [[0, [0, 0, 0]], [0.55, [-20, 0, 0]], [1, [-10, 0, 0]]],
  LeftHip: [[0, [0, 0, 0]], [0.55, [-25, 0, 0]], [1, [-10, 0, 0]]]
}

const OVERHEAD: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.4, [6, 10, 0], [0, -0.1, 0.1]], [0.55, [-10, -12, 0], [0, -0.3, -0.2]], [1.1, [0, 0, 0], [0, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.4, [12, 12, 0]], [0.55, [-22, -10, 0]], [1.1, [0, 0, 0]]],
  RightShoulder: [[0, [0, 0, 0]], [0.4, [150, 0, 12]], [0.55, [55, 0, 0]], [0.75, [40, 0, 0]], [1.1, [0, 0, 0]]],
  RightElbow: [[0, [0, 0, 0]], [0.4, [100, 0, 0]], [0.55, [12, 0, 0]], [1.1, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.45, [30, 0, -15]], [1.1, [0, 0, 0]]],
  LeftElbow: [[0, [0, 0, 0]], [0.45, [60, 0, 0]], [1.1, [0, 0, 0]]],
  RightKnee: [[0, [0, 0, 0]], [0.55, [-20, 0, 0]], [1.1, [0, 0, 0]]],
  LeftKnee: [[0, [0, 0, 0]], [0.55, [-25, 0, 0]], [1.1, [0, 0, 0]]]
}

const ROUNDHOUSE: Keys = {
  Root: [[0, [0, 0, 0], [0, 0, 0]], [0.3, [0, 20, 0], [0, -0.1, 0]], [0.5, [0, -55, -12], [0, 0, 0]], [1, [0, 0, 0], [0, 0, 0]]],
  Waist: [[0, [0, 0, 0]], [0.3, [-4, 10, 0]], [0.5, [-6, -20, 8]], [1, [0, 0, 0]]],
  RightHip: [[0, [0, 0, 0]], [0.32, [55, 0, 25]], [0.5, [70, 0, 60]], [0.65, [40, 0, 30]], [1, [0, 0, 0]]],
  RightKnee: [[0, [0, 0, 0]], [0.32, [-100, 0, 0]], [0.5, [-12, 0, 0]], [0.65, [-60, 0, 0]], [1, [0, 0, 0]]],
  LeftKnee: [[0, [0, 0, 0]], [0.45, [-15, 0, 0]], [1, [0, 0, 0]]],
  LeftShoulder: [[0, [0, 0, 0]], [0.45, [40, 0, -20]], [1, [0, 0, 0]]],
  RightShoulder: [[0, [0, 0, 0]], [0.45, [-20, 0, 40]], [1, [0, 0, 0]]]
}

// Left-led version of a right-led move (for the left-foot prompt the library still holds right-footed refs).
export interface EvalCase {
  id: string
  prompt: string
  set: 'football' | 'combat'
  base: Keys
  duration: number
  // The limb that should lead ('head' for a header).
  lead: Limb | 'head'
  leadJoints: R15Joint[]
}

const LEG: R15Joint[] = ['RightHip', 'RightKnee', 'RightAnkle']
const ARM: R15Joint[] = ['RightShoulder', 'RightElbow', 'RightWrist']

export const EVAL_CASES: EvalCase[] = [
  { id: 'elastico-sided', prompt: 'elastico: right foot pushes the ball out, then snaps back inside', set: 'football', base: ELASTICO, duration: 1, lead: 'RightLeg', leadJoints: LEG },
  { id: 'elastico', prompt: 'elastico', set: 'football', base: ELASTICO, duration: 1, lead: 'RightLeg', leadJoints: LEG },
  { id: 'power-shot', prompt: 'power shot with a big backswing', set: 'football', base: SHOT, duration: 1.2, lead: 'RightLeg', leadJoints: LEG },
  { id: 'step-over', prompt: 'step-over then burst away', set: 'football', base: STEPOVER, duration: 0.9, lead: 'RightLeg', leadJoints: LEG },
  { id: 'diving-header', prompt: 'diving header', set: 'football', base: HEADER, duration: 1, lead: 'head', leadJoints: ['Neck'] },
  { id: 'overhead-punch', prompt: 'heavy overhead punch with a long windup', set: 'combat', base: OVERHEAD, duration: 1.1, lead: 'RightArm', leadJoints: ARM },
  { id: 'roundhouse', prompt: 'roundhouse kick', set: 'combat', base: ROUNDHOUSE, duration: 1, lead: 'RightLeg', leadJoints: LEG }
]

// Three references per case (timing and size vary a little) and a timid first draft (lead at 72% of
// the swing, anticipation 20% shorter, the root drifting so the support foot slides).
export function caseLibrary(c: EvalCase): { refs: AnimEntry[]; draft: AnimClip; tags: string[] } {
  const set = moveSetDef(c.set)
  const tags = setPromptTags(c.prompt, set)
  const lead = c.leadJoints
  const refs = [
    [1, 1],
    [0.92, 1.08],
    [1.1, 0.94]
  ].map(([ts, amp], i) => {
    const clip = clipOf(`${c.id}-ref${i + 1}`, c.duration * ts, vary(c.base, ts, amp, lead))
    return { id: `${c.id}-ref${i + 1}`, scope: 'user', kind: 'imported', name: clip.name, description: c.prompt, tags, notes: '', createdAt: 1, updatedAt: 1, origin: `${clip.name}.rbxm`, clip, thumbs: [] } as AnimEntry
  })
  const keys = vary(c.base, 1, 0.72, lead)
  // Earlier action (shorter anticipation) and a root drift (support-foot slide).
  const draftKeys: Keys = {}
  for (const [j, ks] of Object.entries(keys) as [R15Joint, [number, V3, V3?][]][]) draftKeys[j] = ks.map(([t, e, p]) => [t <= 0.45 * c.duration ? t * 0.8 : t, e, j === 'Root' ? ([(p?.[0] ?? 0) + t * 0.35, p?.[1] ?? 0, p?.[2] ?? 0] as V3) : p])
  const draft = { ...clipOf(`${c.id}-draft`, c.duration, draftKeys), source: 'script' as const }
  return { refs, draft, tags }
}

// ------------------------------------------------------------------ fake critics

const RUBRIC: AnimRubricKey[] = ['silhouette', 'timing', 'weight', 'arcs', 'appeal', 'cleanliness']
const scoresAt = (v: number) => Object.fromEntries(RUBRIC.map((k) => [k, Math.round(v * 10) / 10])) as Record<AnimRubricKey, number>

function widestLeadJoint(clip: AnimClip, c: EvalCase): R15Joint {
  let best = c.leadJoints[0]
  let bv = -1
  for (const j of c.leadJoints) {
    const keys = clip.tracks[j]
    if (!keys?.length) continue
    const v = Math.max(...keys.map((k) => Math.abs(eulerDegOf(sampleTrack(keys, k.t)!.q)[0]) + Math.abs(eulerDegOf(sampleTrack(keys, k.t)!.q)[2])))
    if (v > bv) {
      bv = v
      best = j
    }
  }
  return best
}

type Critic = (clip: AnimClip, n: number, checks: ReturnType<typeof runChecks>, c: EvalCase, truth: QualityContext) => AnimCritique

// Rounds always "improve" by 0.6; proposes a real fix (sliding, a lean, more anticipation) plus an edit
// that tucks the lead limb in toward rest at its peak (what made later rounds drop the leg).
export const biasedCritic: Critic = (clip, n, checks, c) => {
  const changes: AnimChange[] = []
  const j = widestLeadJoint(clip, c)
  const at = peakOf(clip, j)
  const x = sampleTrack(clip.tracks[j], at)
  if (x) {
    const e = eulerDegOf(x.q)
    changes.push({ kind: 'offset', joint: j, at, rot: e.map((v) => Math.max(-40, Math.min(40, -0.45 * v))) as [number, number, number], why: 'the limb overextends; tuck it in for a cleaner silhouette' })
  }
  if (checks.scores.sliding < 8) changes.push({ kind: 'fix', check: 'sliding', why: 'feet slide' })
  changes.push({ kind: 'offset', joint: 'Waist', at: Math.round(phases(clip).peakTime * 100) / 100, rot: [-6, 0, 0], why: 'lean into the move' })
  const ph = phases(clip)
  if (ph.actionStart > ph.motionStart + 0.05) changes.push({ kind: 'retime', from: ph.motionStart, to: ph.actionStart, scale: 1.12, why: 'a touch more anticipation' })
  const overall = Math.min(9.4, 5.6 + 0.6 * (n - 1) + 0.3 * ((checks.scores.readability - 5) / 5))
  return withMustFix({ scores: scoresAt(overall), overall: animOverall(scoresAt(overall)), summary: `round ${n}: reads better than before`, changes, checks, references: [] })
}

// Scores follow the code metrics; proposes the priors' fixes and a must-fix swing when needed (tagged).
export const helpfulCritic: Critic = (clip, _n, checks, _c, truth) => {
  const pc = priorChecks(clip, truth.profile, truth.intent)
  const changes: AnimChange[] = pc.filter((p) => !p.ok && p.fix).map((p) => p.fix!)
  if (checks.scores.sliding < 8) changes.push({ kind: 'fix', check: 'sliding', why: '[rubric:cleanliness] the support foot slides' })
  const obj = objectiveScore(clip, truth).objective
  const overall = Math.max(0, Math.min(9.6, 2.5 + obj * 0.75))
  return withMustFix({ scores: scoresAt(overall), overall: animOverall(scoresAt(overall)), summary: `honest round`, changes: changes.slice(0, 5), checks, references: [] })
}

// ------------------------------------------------------------------ the pipeline before this change

interface LegacyIteration {
  n: number
  clip: AnimClip
  critique: AnimCritique
}

// The refine loop as it was: the next round always continues from the last one, every change is
// applied as given, and the best round is the one with the highest critic score (fewer failed
// named parts first).
async function legacyRefineLoop(initial: AnimClip, critique: (clip: AnimClip, n: number) => AnimCritique, max: number, threshold: number): Promise<{ best: LegacyIteration; iterations: LegacyIteration[] }> {
  const iterations: LegacyIteration[] = []
  let clip = initial
  for (let n = 1; n <= max; n++) {
    const c = critique(clip, n)
    const it = { n, clip, critique: c }
    iterations.push(it)
    if ((c.overall >= threshold && !c.mustFix?.length) || n === max) break
    const r = applyAnimChanges(clip, c.changes)
    if (!r.applied.length) break
    clip = { ...r.clip, patches: [...(clip.patches ?? []), ...r.applied] }
  }
  return { best: iterations.reduce((a, b) => betterIteration(a, b), iterations[0]), iterations }
}

// ------------------------------------------------------------------ metrics

export interface CaseMetrics {
  lead: boolean
  swing: number
  priors: number
  smooth: number
  slide: number
  objective: number
  kept: boolean
  rounds: number
  bestRound: number
}

function metrics(clip: AnimClip, first: AnimClip, c: EvalCase, truth: QualityContext, rounds: number, bestRound: number): CaseMetrics {
  const o = objectiveScore(clip, truth)
  const o1 = objectiveScore(first, truth)
  const refDeg = truth.intent?.lead?.refDeg
  let lead = true
  let swing = 1
  if (c.lead === 'head') {
    const m = measureParts(clip, [{ part: 'head', source: 'eval' }])[0]
    lead = m.ok
    swing = Math.round((m.rangeDeg / 30) * 100) / 100
  } else {
    const m = measureParts(clip, [{ part: c.lead, source: 'eval' }], truth.intent?.lead ?? { limb: c.lead, minDeg: 14, warnDeg: 24 })[0]
    lead = m.ok
    swing = refDeg ? Math.round((m.rangeDeg / refDeg) * 100) / 100 : 1
  }
  return { lead, swing, priors: priorScore(o.checks.priors ?? []), smooth: smoothScore(clip, truth.profile?.priors?.smooth), slide: o.checks.slideStuds, objective: o.objective, kept: o.objective >= o1.objective - 0.05, rounds, bestRound }
}

// ------------------------------------------------------------------ run

export interface EvalRow {
  id: string
  critic: 'biased' | 'helpful'
  before: CaseMetrics
  after: CaseMetrics
}

export interface EvalReport {
  rows: EvalRow[]
  intent: { id: string; expected: string; before: string; after: string }[]
}

export async function runAnimEval(opts: { rounds?: number; threshold?: number } = {}): Promise<EvalReport> {
  const max = opts.rounds ?? 4
  const threshold = opts.threshold ?? 9.5
  const rows: EvalRow[] = []
  const intents: EvalReport['intent'] = []
  for (const c of EVAL_CASES) {
    const { refs, draft, tags } = caseLibrary(c)
    const profile = buildProfile(tags[0] ?? '*', refs) as AnimStyleProfile
    const intent: MotionIntent = motionIntent(c.prompt, tags, refs.map((r) => r.clip))
    const truth: QualityContext = { intent, profile }
    // What the old checks knew: the named parts only (no lead, no references, no priors).
    const legacyIntent: MotionIntent = { parts: requestedParts(c.prompt, tags) }
    const legacyProfile: AnimStyleProfile = { ...profile }
    delete legacyProfile.priors
    const leadName = (i: MotionIntent) => i.lead?.limb ?? (i.parts.some((p) => p.part === 'head') ? 'head' : i.parts.map((p) => p.part).join('+') || 'none')
    intents.push({ id: c.id, expected: c.lead, before: leadName(legacyIntent), after: leadName(intent) })
    for (const [name, critic] of [['biased', biasedCritic], ['helpful', helpfulCritic]] as const) {
      const before = await legacyRefineLoop(draft, (clip, n) => critic(clip, n, runChecks(clip, legacyProfile, { intent: legacyIntent }), c, truth), max, threshold)
      const after = await animRefineLoop(
        draft,
        {
          render: async () => ({ frames: [], times: [] }),
          critique: async (clip, _f, _t, n) => critic(clip, n, runChecks(clip, profile, { intent }), c, truth),
          score: (clip, cr) => iterationScore(cr, clip, truth),
          apply: (clip, changes) => guardedApply(clip, changes, truth)
        },
        { maxIterations: max, threshold }
      )
      rows.push({
        id: c.id,
        critic: name,
        before: metrics(before.best.clip, draft, c, truth, before.iterations.length, before.best.n),
        after: metrics(after.best.clip, draft, c, truth, after.iterations.length, after.best.n)
      })
    }
  }
  return { rows, intent: intents }
}

export function summarize(rows: EvalRow[], side: 'before' | 'after') {
  const n = rows.length || 1
  const avg = (f: (m: CaseMetrics) => number) => Math.round((rows.reduce((s, r) => s + f(r[side]), 0) / n) * 100) / 100
  return { lead: rows.filter((r) => r[side].lead).length, kept: rows.filter((r) => r[side].kept).length, swing: avg((m) => m.swing), priors: avg((m) => m.priors), smooth: avg((m) => m.smooth), slide: avg((m) => m.slide), objective: avg((m) => m.objective), total: rows.length }
}

export function formatReport(r: EvalReport): string {
  const lines: string[] = []
  const f = (m: CaseMetrics) => `${m.lead ? 'yes' : 'NO '}  ${m.swing.toFixed(2).padStart(5)}  ${m.priors.toFixed(1).padStart(4)}  ${m.smooth.toFixed(1).padStart(4)}  ${m.slide.toFixed(2).padStart(5)}  ${m.objective.toFixed(1).padStart(4)}  ${m.kept ? 'yes' : 'NO '}  #${m.bestRound}/${m.rounds}`
  lines.push('Animation Lab offline eval (fake critics, no model / renderer / Lune)')
  lines.push('')
  lines.push('Lead limb inferred from the prompt + library:')
  for (const i of r.intent) lines.push(`  ${i.id.padEnd(16)} expected ${i.expected.padEnd(9)} before ${i.before.padEnd(9)} after ${i.after}`)
  lines.push('')
  lines.push(`${'case'.padEnd(16)} ${'critic'.padEnd(8)} side   lead  swing  pri  smth  slide   obj  kept  best`)
  for (const row of r.rows) {
    lines.push(`${row.id.padEnd(16)} ${row.critic.padEnd(8)} before ${f(row.before)}`)
    lines.push(`${''.padEnd(16)} ${''.padEnd(8)} after  ${f(row.after)}`)
  }
  for (const critic of ['biased', 'helpful'] as const) {
    const rows = r.rows.filter((x) => x.critic === critic)
    const b = summarize(rows, 'before')
    const a = summarize(rows, 'after')
    lines.push('')
    lines.push(`${critic} critic (${rows.length} prompts)      before -> after`)
    lines.push(`  lead limb correct          ${b.lead}/${b.total} -> ${a.lead}/${a.total}`)
    lines.push(`  lead swing vs references   ${b.swing} -> ${a.swing}`)
    lines.push(`  prior conformance (0-10)   ${b.priors} -> ${a.priors}`)
    lines.push(`  smoothness (0-10)          ${b.smooth} -> ${a.smooth}`)
    lines.push(`  foot sliding (studs)       ${b.slide} -> ${a.slide}`)
    lines.push(`  objective (0-10)           ${b.objective} -> ${a.objective}`)
    lines.push(`  no regression vs round 1   ${b.kept}/${b.total} -> ${a.kept}/${a.total}`)
  }
  return lines.join('\n')
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const report = await runAnimEval()
  console.log(formatReport(report))
}
