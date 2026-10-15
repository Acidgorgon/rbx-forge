// Code metrics for a generated effect against the user's library (no model, no render): how close
// its numbers are to the learned priors (realism), whether it has the layer roles the user's effects
// of this type have (coverage), how many of its textured layers reuse real library textures instead
// of placeholders (texture reuse), and timing sanity (fades, size curves, cues inside the play, a
// sensible length, a particle budget). Used to pick between variations without a vision model and
// by the offline benchmark (npm run eval:vfx).

import { allNodes, emitterRole, nodeRole, peakParticles, PERF } from './analyze.ts'
import { prop } from './schema.ts'
import { curveShape, evalNumberSequence } from './sequence.ts'
import { priorFit } from './priors.ts'
import { assetTexture } from './retrieve.ts'
import type { NumberSequence, VfxEffect, VfxRecipe } from './types.ts'

export interface QualityScore {
  // 0..1 each; overall 0..10.
  realism: number
  coverage: number
  textureReuse: number
  timing: number
  overall: number
  notes: string[]
}

export interface QualityContext {
  recipe?: VfxRecipe | null
  // Textures that exist in the user's library (rbxassetid from their effects, forgetex ids of
  // library textures). Anything else (built-in placeholders, procedural requests) is not reuse.
  known?: Set<string>
}

export const QUALITY_WEIGHTS = { realism: 0.35, coverage: 0.2, textureReuse: 0.25, timing: 0.2 }

const r3 = (x: number) => Math.round(x * 1000) / 1000

export function scoreEffect(effect: VfxEffect, ctx: QualityContext = {}): QualityScore {
  const notes: string[] = []
  // Realism: share of checked numbers inside the learned p10-p90 ranges.
  const fit = priorFit(effect, ctx.recipe)
  const realism = fit.checks ? 1 - fit.issues.length / fit.checks : 0.5
  if (fit.issues.length) notes.push(`${fit.issues.length} of ${fit.checks} numbers outside the learned ranges`)
  // Coverage: the recipe's main roles present, and an emitter count in the usual range.
  const nodes = allNodes(effect.roots)
  const roles = new Set(nodes.map((n) => (n.className === 'ParticleEmitter' ? emitterRole(n) : nodeRole(n))))
  let coverage = 0.5
  if (ctx.recipe) {
    const want = ctx.recipe.layers.filter((l) => l.share >= 0.15 && l.role !== 'other').map((l) => l.role)
    const have = want.filter((r) => roles.has(r as never))
    const roleShare = want.length ? have.length / want.length : 1
    const em = nodes.filter((n) => n.className === 'ParticleEmitter').length
    const er = ctx.recipe.ranges['effect.emitters']
    const countOk = er ? (em >= Math.floor(er.p10) && em <= Math.ceil(er.p90) ? 1 : em >= er.p10 / 2 && em <= er.p90 * 2 ? 0.5 : 0) : 1
    coverage = 0.7 * roleShare + 0.3 * countOk
    if (want.length > have.length) notes.push(`missing ${want.filter((r) => !have.includes(r)).join(', ')}`)
  }
  // Texture reuse.
  const textured = nodes.filter((n) => n.className === 'ParticleEmitter' || n.className === 'Beam' || n.className === 'Trail')
  const reused = textured.filter((n) => {
    const t = n.props.Texture
    const a = assetTexture(t)
    if (a) return !ctx.known || ctx.known.has(a)
    return typeof t === 'string' && t.startsWith('forgetex://') && !t.startsWith('forgetex://gen/') && (!ctx.known || ctx.known.has(t))
  })
  const textureReuse = textured.length ? reused.length / textured.length : 0
  if (textured.length > reused.length) notes.push(`${textured.length - reused.length} layer(s) on placeholder textures`)
  // Timing sanity.
  let pass = 0
  let total = 0
  const t = (ok: boolean, why: string) => {
    total++
    if (ok) pass++
    else notes.push(why)
  }
  const emitters = nodes.filter((n) => n.className === 'ParticleEmitter')
  const pops = emitters.filter((n) => evalNumberSequence(prop<NumberSequence>(n, 'Transparency'), 1) < 0.85)
  t(!pops.length, `${pops.length} emitter(s) pop at the end of life`)
  const flat = emitters.filter((n) => curveShape(prop<NumberSequence>(n, 'Size')) === 'constant' && emitterRole(n) !== 'glow')
  t(!flat.length, `${flat.length} emitter(s) keep a constant size`)
  const late = effect.cues.filter((c) => c.at > effect.duration + 1e-3)
  t(!late.length, `${late.length} cue(s) after the end of the play`)
  const firstAt = Math.min(...effect.cues.filter((c) => c.action === 'emit' || c.action === 'enable').map((c) => c.at), emitters.some((n) => prop<boolean>(n, 'Enabled') !== false && prop<number>(n, 'Rate') > 0) ? 0 : Infinity)
  t(firstAt <= Math.max(0.3, effect.duration * 0.4), 'nothing happens early in the play')
  const dr = ctx.recipe?.ranges['effect.duration']
  if (dr) t(effect.duration >= dr.p10 / 1.6 && effect.duration <= dr.p90 * 1.6, `one play is ${effect.duration} s (your effects: ${dr.p10}-${dr.p90} s)`)
  t(peakParticles(effect) <= PERF.particlesWarn, 'over the particle budget')
  const timing = total ? pass / total : 0
  const overall = Math.round(10 * (QUALITY_WEIGHTS.realism * realism + QUALITY_WEIGHTS.coverage * coverage + QUALITY_WEIGHTS.textureReuse * textureReuse + QUALITY_WEIGHTS.timing * timing) * 100) / 100
  return { realism: r3(realism), coverage: r3(coverage), textureReuse: r3(textureReuse), timing: r3(timing), overall, notes }
}

// Every texture the library's effects use (rbxassetid) plus the library textures (forgetex ids).
export function knownTextures(effects: VfxEffect[], libraryRefs: string[] = []): Set<string> {
  const out = new Set<string>(libraryRefs)
  for (const e of effects) for (const n of allNodes(e.roots)) {
    const a = assetTexture(n.props.Texture)
    if (a) out.add(a)
  }
  return out
}
