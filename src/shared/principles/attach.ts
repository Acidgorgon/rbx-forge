// Putting the principle framework on each lab's critique: pick the principles relevant to the
// request, run the code checks for the measurable ones, merge them with the critic's per-principle
// scores, blend the weighted principle score into the overall, set the focus (lowest-scoring,
// highest-weight principles) and put the changes that raise the focus first. The services call these
// after parsing the critic (or the numbers-only critique); the browser mocks call them too.

import type { CritiqueContext } from '../ability/critique.ts'
import type { Ability, AbilityCritique, AbilityChange } from '../ability/types.ts'
import type { AnimCheckReport, AnimClip, AnimCritique } from '../anim/model.ts'
import type { VfxCritique, VfxEffect } from '../vfx/types.ts'
import { abilityPrincipleChecks } from './abilityChecks.ts'
import { animPrincipleChecks } from './animChecks.ts'
import { orderChanges, parsePrincipleScores, scorePrinciples } from './score.ts'
import { principleCriticBlock, selectPrinciples } from './select.ts'
import type { PrincipleCheck, PrincipleLab, PrincipleWeights } from './types.ts'
import { vfxPrincipleChecks } from './vfxChecks.ts'

export const CRITIC_PRINCIPLES = 8

export interface AttachOptions {
  request: string
  // The critic's raw answer (its "principles" list is read from it).
  raw?: string
  weights?: PrincipleWeights
}

export function principleIds(lab: PrincipleLab, request: string, opts: { weights?: PrincipleWeights; looped?: boolean } = {}): string[] {
  return selectPrinciples(lab, request, { weights: opts.weights, max: CRITIC_PRINCIPLES, looped: opts.looped }).map((p) => p.id)
}

const only = (checks: PrincipleCheck[], ids: string[]) => checks.filter((c) => ids.includes(c.id))

export function withVfxPrinciples(c: VfxCritique, effect: VfxEffect, opts: AttachOptions): VfxCritique {
  const ids = principleIds('vfx', opts.request, opts)
  const r = scorePrinciples(c.overall, parsePrincipleScores(opts.raw, ids), only(vfxPrincipleChecks(effect), ids), opts.weights)
  return { ...c, overall: r.overall, principles: r.principles, ...(r.principleScore != null ? { principleScore: r.principleScore } : {}), focus: r.focus, changes: orderChanges(c.changes, r.focus) }
}

export function withAnimPrinciples(c: AnimCritique, clip: AnimClip, opts: AttachOptions & { checks?: AnimCheckReport | null }): AnimCritique {
  const ids = principleIds('anim', opts.request, { weights: opts.weights, looped: clip.looped })
  const r = scorePrinciples(c.overall, parsePrincipleScores(opts.raw, ids), only(animPrincipleChecks(clip, opts.checks ?? c.checks), ids), opts.weights)
  return { ...c, overall: r.overall, principles: r.principles, ...(r.principleScore != null ? { principleScore: r.principleScore } : {}), focus: r.focus, changes: orderChanges(c.changes, r.focus) }
}

export function withAbilityPrinciples(c: AbilityCritique, ability: Ability, ctx: CritiqueContext, opts: AttachOptions & { effect?: VfxEffect | null }): AbilityCritique {
  const ids = principleIds('ability', opts.request, opts)
  const r = scorePrinciples(c.overall, parsePrincipleScores(opts.raw, ids), only(abilityPrincipleChecks(ability, ctx, { checks: c.checks, effect: opts.effect }), ids), opts.weights)
  const vision = c.vision ? { ...c.vision, changes: orderChanges<AbilityChange>(c.vision.changes, r.focus) } : undefined
  return { ...c, ...(vision ? { vision } : {}), overall: r.overall, principles: r.principles, ...(r.principleScore != null ? { principleScore: r.principleScore } : {}), focus: r.focus }
}

// The critic's principle section for a lab: the relevant principles with the code measurements and
// the focus carried over from the previous round.
export function vfxCriticPrinciples(effect: VfxEffect, request: string, opts: { weights?: PrincipleWeights; focus?: string[] } = {}): string {
  const ids = principleIds('vfx', request, opts)
  const measured = Object.fromEntries(only(vfxPrincipleChecks(effect), ids).map((c) => [c.id, c]))
  return principleCriticBlock(ids, { weights: opts.weights, measured, focus: opts.focus })
}

export function animCriticPrinciples(clip: AnimClip, request: string, opts: { weights?: PrincipleWeights; focus?: string[]; checks?: AnimCheckReport | null } = {}): string {
  const ids = principleIds('anim', request, { weights: opts.weights, looped: clip.looped })
  const measured = Object.fromEntries(only(animPrincipleChecks(clip, opts.checks), ids).map((c) => [c.id, c]))
  return principleCriticBlock(ids, { weights: opts.weights, measured, focus: opts.focus })
}

export function abilityCriticPrinciples(ability: Ability, ctx: CritiqueContext, request: string, opts: { weights?: PrincipleWeights; focus?: string[]; effect?: VfxEffect | null } = {}): string {
  const ids = principleIds('ability', request, opts)
  const measured = Object.fromEntries(only(abilityPrincipleChecks(ability, ctx, { effect: opts.effect }), ids).map((c) => [c.id, c]))
  return principleCriticBlock(ids, { weights: opts.weights, measured, focus: opts.focus })
}

// Per-principle scores of a rated result, for weight learning: its last critique's principles, or
// the code checks alone when it was never critiqued.
export function scoresForRating(principles: { id: string; score: number }[] | undefined, fallback: () => PrincipleCheck[]): Record<string, number> {
  const list = principles?.length ? principles : fallback()
  return Object.fromEntries(list.map((p) => [p.id, p.score]))
}
