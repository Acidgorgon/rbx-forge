// Grounding for Make and compose: one place that turns a request plus the user's library into what
// the generators need (the closest effects, the learned recipe for the request's kind / element,
// the real textures by role), the no-model candidates (remixes of the closest effects, else the
// archetype draft), the finishing pass every generated effect gets (real textures on placeholder
// layers, numbers far outside the user's ranges pulled in) and the code pick between variations.
// Pure code: the service adds the model calls and rendering; the offline eval runs the same steps.

import { vfxPrincipleChecks } from '../principles/vfxChecks.ts'
import { draftSpec, libraryTextures } from './draft.ts'
import { chooseRecipe, fitToPriors, priorLines, PRIOR_MIN_SAMPLES } from './priors.ts'
import { extractRecipe } from './recipes.ts'
import { remixEffect } from './remix.ts'
import { bankLines, bankTextureChanges, effectDigest, effectTextureBank, feedbackBoost, nearestEffects, readRequest, remixable, type TextureBank, type VfxFeedback, type VfxMatch, type VfxRequest } from './retrieve.ts'
import { knownTextures, scoreEffect, type QualityScore } from './quality.ts'
import { applyChanges, effectFromSpec, shortTitle, SpecError, type VfxSpec } from './spec.ts'
import { flatTags } from './tags.ts'
import type { VfxEffect, VfxEntry, VfxRecipe } from './types.ts'

export interface GroundContext {
  entries: VfxEntry[]
  // Learned recipes (recipes.json); missing types are computed from the library on the fly.
  recipes?: VfxRecipe[]
  feedback?: VfxFeedback | null
  // Draft roles -> texture library refs under the texture policy (their picks win over the bank).
  libraryRoles?: Record<string, string>
  // forgetex refs of the texture library (count as reuse).
  libraryRefs?: string[]
}

export interface Grounding {
  req: VfxRequest
  tags: string[]
  matches: VfxMatch[]
  recipe: VfxRecipe | null
  bank: TextureBank
  near: string[]
  known: Set<string>
  ctx: GroundContext
}

export function ground(text: string, ctx: GroundContext, opts: { exclude?: string; limit?: number } = {}): Grounding {
  const req = readRequest(text)
  const tags = flatTags(req.groups)
  const matches = nearestEffects(req, ctx.entries, { feedback: ctx.feedback, exclude: opts.exclude, limit: opts.limit ?? 5 })
  let recipe = chooseRecipe(ctx.recipes ?? [], tags)
  if (!recipe || recipe.samples < PRIOR_MIN_SAMPLES) {
    // Not learned (or too thin): from the library now, most specific key first.
    const keys = [...req.groups.kind.flatMap((k) => req.groups.element.map((el) => `${k}+${el}`)), ...req.groups.kind]
    for (const k of keys) {
      const r = extractRecipe(k, ctx.entries, { boost: (e) => feedbackBoost(ctx.feedback, e.id) })
      if (r && r.samples >= PRIOR_MIN_SAMPLES) {
        recipe = r
        break
      }
    }
    // A type the request does not name: the closest effect's kind.
    if (!recipe && matches[0]) {
      const kind = matches[0].entry.tagGroups?.kind?.[0]
      if (kind) recipe = chooseRecipe(ctx.recipes ?? [], [kind]) ?? extractRecipe(kind, ctx.entries)
    }
  }
  const bank = effectTextureBank(ctx.entries)
  const known = knownTextures(
    ctx.entries.filter((e) => e.effect).map((e) => e.effect!),
    ctx.libraryRefs ?? []
  )
  return { req, tags, matches, recipe, bank, near: matches.slice(0, 3).map((m) => m.entry.id), known, ctx }
}

// Prompt lines: the closest effects (compact per-layer digests), the learned ranges for the type and
// the real textures by role.
export function groundingLines(g: Grounding, opts: { maxRefs?: number; script?: boolean } = {}): string[] {
  const lines: string[] = []
  const refs = g.matches.slice(0, opts.maxRefs ?? 3)
  if (refs.length) {
    lines.push(
      `Closest effects in the user's own library (real effects they made or bought; match their scale, timing, textures and colour treatment${opts.script ? '; pass their texture ids to kit spawns with texture = "rbxassetid://..."' : ''}):\n${refs.map((m) => `${effectDigest(m.entry.effect!)}\n  (why close: ${m.why.join('; ') || 'similar'})`).join('\n')}`
    )
  }
  const pl = priorLines(g.recipe)
  if (pl.length) lines.push(`Learned ranges for "${g.recipe!.tag}" from ${g.recipe!.samples} of the user's effects (stay inside these unless the request asks otherwise):\n${pl.map((l) => `- ${l}`).join('\n')}`)
  const bl = bankLines(g.bank, g.near)
  if (bl.length) lines.push(`Real textures from the user's effects by layer role (use these exact ids, keep their flipbook layout; never invent asset ids):\n${bl.slice(0, 14).map((l) => `- ${l}`).join('\n')}`)
  return lines
}

export interface Candidate {
  effect: VfxEffect
  basedOn: string[]
  how: 'remix' | 'draft' | 'model-remix' | 'model-draft' | 'model-script' | 'script'
  notes: string[]
  // Draft candidates: the spec (the model's starting point); model answers: their description / tags.
  spec?: VfxSpec
  description?: string
  tags?: string[]
}

// The finishing pass: real textures on layers still on placeholders, then the numbers far outside
// the user's ranges pulled in. Changes that do not apply are skipped.
export function finishEffect(effect: VfxEffect, g: Grounding): { effect: VfxEffect; notes: string[] } {
  const notes: string[] = []
  const skipRoles = Object.keys(g.ctx.libraryRoles ?? {})
  let next = effect
  let swapped = 0
  for (const ch of bankTextureChanges(next, g.bank, { near: g.near, skipRoles })) {
    try {
      next = applyChanges(next, [ch])
      if (ch.prop === 'Texture') swapped++
    } catch (e) {
      if (!(e instanceof SpecError)) throw e
    }
  }
  if (swapped) notes.push(`${swapped} layer(s) use textures from your effects`)
  const fit = fitToPriors(next, g.recipe)
  if (fit.applied.length) notes.push(`${fit.applied.length} value(s) pulled into your ${g.recipe!.tag} ranges (${fit.applied.slice(0, 3).map((i) => `${i.name} ${i.prop}`).join(', ')})`)
  return { effect: fit.effect, notes }
}

// Candidates without a model: remixes of the closest effects that are close enough (up to n, each
// from a different base), else the archetype draft with library textures.
export function singleCandidates(text: string, g: Grounding, n = 1): Candidate[] {
  const name = shortTitle(text)
  const out: Candidate[] = []
  for (const m of g.matches) {
    if (out.length >= n) break
    if (!remixable(m, g.req) || m.entry.effect?.script) continue
    const r = remixEffect(m.entry, g.req, name)
    const f = finishEffect(r.effect, g)
    out.push({ effect: f.effect, basedOn: [m.entry.id], how: 'remix', notes: [...r.notes, ...f.notes] })
  }
  if (!out.length) out.push(draftCandidate(text, g))
  return out
}

export function draftCandidate(text: string, g: Grounding): Candidate {
  const spec = draftSpec(text, { recipe: g.recipe, textures: { ...libraryTextures(g.ctx.entries), ...(g.ctx.libraryRoles ?? {}) } })
  const f = finishEffect(effectFromSpec(spec), g)
  return { effect: f.effect, basedOn: g.near.slice(0, 2), how: 'draft', notes: f.notes, spec, description: spec.description, tags: spec.tags }
}

export interface CodePick {
  index: number
  scores: (QualityScore & { principles: number; total: number })[]
}

// The best candidate by code: library fit (quality.ts) blended with the principle checks.
export function pickByCode(cands: Candidate[], g: Grounding): CodePick {
  const scores = cands.map((c) => {
    const q = scoreEffect(c.effect, { recipe: g.recipe, known: g.known })
    const checks = safeChecks(c.effect)
    const principles = checks.length ? checks.reduce((a, x) => a + x.score, 0) / checks.length : 5
    return { ...q, principles: Math.round(principles * 100) / 100, total: Math.round((0.75 * q.overall + 0.25 * principles) * 100) / 100 }
  })
  let index = 0
  for (let i = 1; i < scores.length; i++) if (scores[i].total > scores[index].total) index = i
  return { index, scores }
}

function safeChecks(e: VfxEffect) {
  try {
    return vfxPrincipleChecks(e)
  } catch {
    return []
  }
}
