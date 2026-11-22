// Helpers linking principle selection and user-rating score collection to UI Motion Lab.
import { selectPrinciples } from './select.ts'
import type { PrincipleCheck, PrincipleLab, PrincipleWeights } from './types.ts'

export const CRITIC_PRINCIPLES = 8

export function principleIds(lab: PrincipleLab, request: string, opts: { weights?: PrincipleWeights; looped?: boolean } = {}): string[] {
  return selectPrinciples(lab, request, { weights: opts.weights, max: CRITIC_PRINCIPLES, looped: opts.looped }).map((p) => p.id)
}

// Per-principle scores of a rated result, for weight learning: its last critique's principles, or
// the code checks alone when it was never critiqued.
export function scoresForRating(principles: { id: string; score: number }[] | undefined, fallback: () => PrincipleCheck[]): Record<string, number> {
  const list = principles?.length ? principles : fallback()
  return Object.fromEntries(list.map((p) => [p.id, p.score]))
}
