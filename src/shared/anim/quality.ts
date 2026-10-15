// Ranking refinement rounds and guarding the critic's edits (pure code, no model).
//
// Objective score (0..10) from code metrics only: the automatic checks, the motion intent (the named
// and lead parts move as much as they should, the lead is not out-moved), the learned priors and
// smoothness. An iteration's quality blends it with the critic's score (criticWeight, learned from
// the user's keeps and ratings, see service.ts), and a round is only accepted when it does not regress:
// it may not fail more requirements, drop the objective score by more than OBJECTIVE_TOLERANCE, or
// score below the best so far. Rejected rounds stay in the history but the next round starts from the
// best again (critique.ts animRefineLoop), so a critic that likes a later round more cannot trade the
// leg away.
//
// Guarded edits: the critic's changes are applied one at a time, small and targeted. An untargeted
// offset (no [prior:...] / [must-fix] / [rubric:...] tag, on a joint no check flagged) is capped hard;
// a change that shrinks the lead limb's swing or makes a named part stop moving is refused with the
// reason, so later rounds cannot drop the leg.

import type { AnimChange, AnimCheckReport, AnimClip, AnimCritique, AnimIterationScore, AnimStyleProfile } from './model.ts'
import { runChecks } from './checks.ts'
import { measureParts, missingParts, type PartMotion } from './bodyparts.ts'
import { applyAnimChanges, normalizeChange, type PatchContext } from './patch.ts'
import { priorScore, smoothScore, learnedLimits } from './priors.ts'
import { JOINT_LIMITS, JOINT_LIMITS_R6 } from './checks.ts'
import { clipRig } from './sample.ts'
import type { MotionIntent } from './intent.ts'

export const DEFAULT_CRITIC_WEIGHT = 0.5
export const CRITIC_WEIGHT_RANGE: [number, number] = [0.25, 0.75]
// How far the code metrics may drop below the best seen before a round counts as a regression.
export const OBJECTIVE_TOLERANCE = 0.4
// A round within this of the best's score is still a step to continue from (critics are noisy and a
// fix can take two rounds), but it only becomes the best when it scores higher.
export const QUALITY_TOLERANCE = 0.3
// The best may only move to a round whose code metrics are within this of the best seen, so a critic
// that scores every round higher cannot walk the clip downhill.
export const PROMOTE_TOLERANCE = 0.15
// The lead limb may not lose more than this share of the best round's swing.
export const LEAD_EROSION = 0.15

export interface QualityContext {
  intent?: MotionIntent | null
  profile?: AnimStyleProfile | null
  criticWeight?: number
}

const r1 = (v: number) => Math.round(v * 10) / 10

// 0..10: how fully the named / lead parts move (8 when the request names none).
export function intentScore(motion: PartMotion[] | undefined): number {
  if (!motion?.length) return 8
  let s = 0
  for (const m of motion) {
    let v = Math.min(1, m.rangeDeg / Math.max(1, m.warnDeg))
    if (m.outmovedBy) v *= Math.min(1, m.rangeDeg / Math.max(1, m.outmovedBy.rangeDeg))
    s += v
  }
  return r1((s / motion.length) * 10)
}

export interface ObjectiveResult {
  objective: number
  parts: AnimIterationScore['parts']
  checks: AnimCheckReport
  failures: number
  lead?: number
  leadRef?: number
}

// Code metrics of a clip. checks: the report already computed with the same intent and profile.
export function objectiveScore(clip: AnimClip, ctx: QualityContext = {}, checks?: AnimCheckReport | null): ObjectiveResult {
  const c = checks ?? runChecks(clip, ctx.profile ?? null, { intent: ctx.intent ?? null })
  // Feet: the checks' sliding score bottoms out at 0.7 studs; this keeps rewarding less sliding past that.
  const parts = { checks: c.overall, intent: intentScore(c.motion), priors: priorScore(c.priors ?? []), smooth: smoothScore(clip, ctx.profile?.priors?.smooth), feet: r1(10 * Math.exp(-c.slideStuds / 1.2)) }
  const objective = r1(parts.checks * 0.25 + parts.intent * 0.25 + parts.priors * 0.2 + parts.smooth * 0.15 + parts.feet * 0.15)
  const lm = c.motion?.find((m) => m.lead)
  return { objective, parts, checks: c, failures: missingParts(c.motion).length, ...(lm ? { lead: lm.rangeDeg } : {}), ...(lm?.refDeg ? { leadRef: lm.refDeg } : {}) }
}

export function clampCriticWeight(w: unknown): number {
  const x = Number(w)
  return Number.isFinite(x) ? Math.max(CRITIC_WEIGHT_RANGE[0], Math.min(CRITIC_WEIGHT_RANGE[1], x)) : DEFAULT_CRITIC_WEIGHT
}

// An iteration's score from its critique and its clip.
export function iterationScore(critique: AnimCritique, clip: AnimClip, ctx: QualityContext = {}): AnimIterationScore {
  const o = objectiveScore(clip, ctx, critique.checks?.motion !== undefined || critique.checks?.priors !== undefined ? critique.checks : null)
  const w = clampCriticWeight(ctx.criticWeight ?? DEFAULT_CRITIC_WEIGHT)
  const failures = Math.max(o.failures, missingParts(critique.checks?.motion).length)
  return { quality: r1(w * critique.overall + (1 - w) * o.objective), critic: critique.overall, objective: o.objective, parts: o.parts, failures, criticWeight: w, accepted: true, ...(o.lead !== undefined ? { lead: o.lead } : {}), ...(o.leadRef ? { leadRef: o.leadRef } : {}) }
}

// True when b ranks above a: fewer failed requirements first, then quality.
export function scoreBetter(a: AnimIterationScore, b: AnimIterationScore): boolean {
  if (a.failures !== b.failures) return b.failures < a.failures
  return b.quality > a.quality
}

// Whether a round is kept (the next round may continue from it) and whether it becomes the best.
// anchor: the highest code score of the kept rounds so far; leadAnchor: the widest lead swing of the
// kept rounds (so the swing cannot erode a little per round). A round is not kept when it fails more
// requirements than the best, lets the lead limb lose more than LEAD_EROSION of that swing (trimming
// a lead that overshoots the references by more than 20% is fine),
// drops the code metrics more than OBJECTIVE_TOLERANCE below the anchor or scores more than
// QUALITY_TOLERANCE below the best. It becomes the best when it fixes a failure, or scores higher
// with code metrics within PROMOTE_TOLERANCE of the anchor.
export function judgeRound(best: AnimIterationScore, cand: AnimIterationScore, anchor = best.objective, leadAnchor = best.lead): { accepted: boolean; promote: boolean; reason?: string } {
  if (cand.failures > best.failures) return { accepted: false, promote: false, reason: `it fails ${cand.failures} requirement${cand.failures === 1 ? '' : 's'} (the best fails ${best.failures})` }
  if (cand.failures < best.failures) return { accepted: true, promote: true }
  const leadBase = leadAnchor !== undefined && cand.leadRef ? Math.min(leadAnchor, cand.leadRef * 1.2) : leadAnchor
  if (leadBase !== undefined && cand.lead !== undefined && cand.lead < leadBase * (1 - LEAD_EROSION)) return { accepted: false, promote: false, reason: `the lead limb's swing dropped from ${leadBase.toFixed(0)}° to ${cand.lead.toFixed(0)}°` }
  if (cand.objective < anchor - OBJECTIVE_TOLERANCE) return { accepted: false, promote: false, reason: `the code metrics dropped from ${anchor.toFixed(1)} to ${cand.objective.toFixed(1)}` }
  if (cand.quality < best.quality - QUALITY_TOLERANCE) return { accepted: false, promote: false, reason: `it scored ${cand.quality.toFixed(1)}, below the best ${best.quality.toFixed(1)}` }
  // A round that pulls the lead in (not trimming an overshoot) only takes over when the code metrics
  // clearly improve too, not on the critic's word alone.
  const bestBase = best.lead !== undefined && cand.leadRef ? Math.min(best.lead, cand.leadRef * 1.2) : best.lead
  const pulledIn = bestBase !== undefined && cand.lead !== undefined && cand.lead < bestBase * 0.95 && !(cand.objective > best.objective + PROMOTE_TOLERANCE)
  return { accepted: true, promote: !pulledIn && cand.quality > best.quality && cand.objective >= anchor - PROMOTE_TOLERANCE }
}

// Compatibility: kept or not (see judgeRound).
export function acceptRound(best: AnimIterationScore, cand: AnimIterationScore): { ok: boolean; reason?: string } {
  const j = judgeRound(best, cand)
  return { ok: j.accepted, ...(j.reason ? { reason: j.reason } : {}) }
}

// ------------------------------------------------------------------ guarded edits

const TAGGED = /\[(?:prior:[\w-]+|must-fix|rubric:\w+)\]/i
const UNTARGETED_CAP = 15
const TARGETED_CAP = 35
const MAX_CHANGES = 6

function capOffset(c: AnimChange & { kind: 'offset' }, cap: number): AnimChange {
  const mag = Math.hypot(...c.rot)
  if (mag <= cap) return c
  const k = cap / mag
  return { ...c, rot: c.rot.map((x) => Math.round(x * k * 10) / 10) as [number, number, number] }
}

// The patch context for a clip under an intent and profile (lead foot not planted, learned limits).
export function patchContext(clip: AnimClip, ctx: QualityContext): PatchContext {
  const side = ctx.intent?.lead?.limb.startsWith('Left') ? 'left' : 'right'
  const base = clipRig(clip) === 'R6' ? JOINT_LIMITS_R6 : JOINT_LIMITS
  return {
    checks: (c) => runChecks(c, ctx.profile ?? null, { intent: ctx.intent ?? null }),
    ...(ctx.profile?.priors ? { limits: learnedLimits(ctx.profile.priors, base, side) } : {})
  }
}

// Applies the critic's changes one at a time with guards. flagged: joints the checks named (an
// offset there counts as targeted).
export function guardedApply(clip: AnimClip, changes: unknown[], ctx: QualityContext = {}): { clip: AnimClip; applied: AnimChange[]; rejected: { change: unknown; reason: string }[] } {
  const rejected: { change: unknown; reason: string }[] = []
  const applied: AnimChange[] = []
  const pctx = patchContext(clip, ctx)
  const intent = ctx.intent
  const parts = intent?.parts ?? []
  const measure = (c: AnimClip) => (parts.length ? measureParts(c, parts, intent?.lead) : [])
  const flagged = new Set<string>()
  const report = pctx.checks!(clip)
  for (const i of report.issues) if (i.joint) flagged.add(i.joint)
  for (const m of report.motion ?? []) if (m.joint && (!m.ok || m.rangeDeg < m.warnDeg)) flagged.add(m.joint)
  let cur = clip
  let before = measure(cur)
  let retimes = 0
  for (const raw of changes.slice(0, MAX_CHANGES + 4)) {
    if (applied.length >= MAX_CHANGES) {
      rejected.push({ change: raw, reason: `at most ${MAX_CHANGES} changes per round` })
      continue
    }
    let ch: AnimChange
    try {
      ch = normalizeChange(raw)
    } catch (e) {
      rejected.push({ change: raw, reason: (e as Error).message })
      continue
    }
    const why = (raw as { why?: unknown })?.why
    const tagged = TAGGED.test(String(why ?? '')) || typeof (raw as { prior?: unknown })?.prior === 'string'
    if (ch.kind === 'offset') ch = capOffset(ch, tagged || flagged.has(ch.joint) ? TARGETED_CAP : UNTARGETED_CAP)
    if (ch.kind === 'retime') {
      if (++retimes > 1) {
        rejected.push({ change: raw, reason: 'one retime per round (retimes compound)' })
        continue
      }
      ch = { ...ch, scale: Math.max(0.6, Math.min(1.7, ch.scale)) }
    }
    const r = applyAnimChanges(cur, [ch], pctx)
    if (r.rejected.length) {
      rejected.push({ change: raw, reason: r.rejected[0].reason })
      continue
    }
    const after = measure(r.clip)
    const lost = after.find((m, i) => before[i]?.ok && !m.ok)
    if (lost) {
      rejected.push({ change: raw, reason: `it would stop the ${lost.label} from doing the move (${before.find((b) => b.part === lost.part)?.rangeDeg.toFixed(0)}° -> ${lost.rangeDeg.toFixed(0)}°)` })
      continue
    }
    const leadBefore = before.find((m) => m.lead)
    const leadAfter = after.find((m) => m.lead)
    if (leadBefore && leadAfter && leadAfter.rangeDeg < leadBefore.rangeDeg * 0.85 && !(leadBefore.refDeg && leadAfter.rangeDeg >= leadBefore.refDeg * 1.2)) {
      rejected.push({ change: raw, reason: `it would shrink the ${leadAfter.label}'s swing (${leadBefore.rangeDeg.toFixed(0)}° -> ${leadAfter.rangeDeg.toFixed(0)}°), which leads this move` })
      continue
    }
    cur = r.clip
    before = after
    applied.push(...r.applied)
  }
  return { clip: cur, applied, rejected }
}

// The critic's changes at a fraction of their size (backtracking after a regressed round): offsets
// and retimes shrink toward no change; eases and fixes are kept.
export function dampChanges(changes: AnimChange[], f: number): AnimChange[] {
  return changes.map((c) => {
    if (c.kind === 'offset') return { ...c, rot: c.rot.map((x) => Math.round(x * f * 10) / 10) as [number, number, number] }
    if (c.kind === 'retime') return { ...c, scale: Math.round((1 + (c.scale - 1) * f) * 1000) / 1000 }
    return c
  })
}

// The best stored round of an entry: accepted rounds only, fewer failures first, then quality. Rounds
// saved before scoring existed rank by the critic's score.
export function bestIteration<T extends { score?: AnimIterationScore; critique?: AnimCritique }>(its: T[]): T | null {
  const scoreOf = (it: T): AnimIterationScore => it.score ?? { quality: it.critique?.overall ?? 0, critic: it.critique?.overall ?? 0, objective: it.critique?.checks?.overall ?? 0, parts: { checks: 0, intent: 0, priors: 0, smooth: 0 }, failures: missingParts(it.critique?.checks?.motion).length, criticWeight: 1, accepted: true }
  let best: T | null = null
  for (const it of its) {
    const s = scoreOf(it)
    if (!s.accepted) continue
    if (!best || scoreBetter(scoreOf(best), s)) best = it
  }
  return best ?? its[0] ?? null
}
