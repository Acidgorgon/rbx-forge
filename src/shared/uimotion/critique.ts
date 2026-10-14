// The UI Motion Lab critique, assembled the same way in main and the browser mock: the UI principle
// checks (measured on the simulated timeline), the critic's per-principle scores when it ran, the
// user's weights, the blended overall, the focus and the critic's changes ordered by it.

import { principleIds } from '../principles/attach.ts'
import { orderChanges, parsePrincipleScores, scorePrinciples } from '../principles/score.ts'
import type { PrincipleWeights } from '../principles/types.ts'
import { uiPrincipleChecks } from '../principles/uiChecks.ts'
import type { UiMotionCritique } from '../uiMotionTypes.ts'
import type { UiMotionVision } from './ai.ts'
import type { MotionSpec } from './spec.ts'

export function buildCritique(spec: MotionSpec, request: string, o: { at: number; raw?: string; vision?: UiMotionVision; weights?: PrincipleWeights; frames?: string[] }): UiMotionCritique {
  const checks = uiPrincipleChecks(spec)
  const ids = principleIds('uimotion', request, { weights: o.weights })
  const codeScore = checks.length ? checks.reduce((s, c) => s + c.score, 0) / checks.length : 5
  const rubric = o.vision ? (o.vision.overall + codeScore) / 2 : codeScore
  const r = scorePrinciples(Math.round(rubric * 10) / 10, parsePrincipleScores(o.raw, ids), checks.filter((c) => ids.includes(c.id)), o.weights)
  const vision = o.vision ? { ...o.vision, changes: orderChanges(o.vision.changes, r.focus) } : undefined
  const low = checks.filter((c) => c.score < 7).map((c) => `${c.id.replace(/^ui-/, '')}: ${c.note}`)
  return {
    at: o.at,
    overall: r.overall,
    summary: (vision?.summary || (low.length ? `Needs work: ${low.join('; ')}` : 'Principle checks pass: fast feedback, restrained overshoot, readable.')).slice(0, 600),
    checks,
    ...(vision ? { vision } : {}),
    principles: r.principles,
    ...(r.principleScore != null ? { principleScore: r.principleScore } : {}),
    focus: r.focus,
    frames: o.frames ?? []
  }
}
