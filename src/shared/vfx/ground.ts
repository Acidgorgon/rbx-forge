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
import { hueDelta, recolor, recolorScript, remixEffect, rescale, rescaleScript, targetHue } from './remix.ts'
import { bankLines, bankTextureChanges, effectDigest, effectTextureBank, feedbackBoost, nearestEffects, readRequest, remixable, type TextureBank, type VfxFeedback, type VfxMatch, type VfxRequest } from './retrieve.ts'
import { knownTextures, scoreEffect, type QualityScore } from './quality.ts'
import { applyChanges, effectFromSpec, shortTitle, SpecError, type VfxLayerSpec, type VfxSpec } from './spec.ts'
import { flatTags, words } from './tags.ts'
import { allNodes, nodeRole } from './analyze.ts'
import { asksSimpler, richnessLine, richnessScore, richTarget, tooSimple, type RichTarget } from './richness.ts'
import { evalColorSequence } from './sequence.ts'
import type { ColorSequence, VfxEffect, VfxEntry, VfxRecipe } from './types.ts'

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
  // How rich the user's closest effects are (layers, roles, beams / trails, beats).
  target: RichTarget | null
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
  return { req, tags, matches, recipe, bank, near: matches.slice(0, 3).map((m) => m.entry.id), known, target: richTarget(matches), ctx }
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
  if (g.target) lines.push(`How rich the user's closest effects are (${g.target.from.join(', ')}): about ${g.target.layers} visible layers (${g.target.roles.join(', ')})${g.target.beams ? ', beams' : ''}${g.target.trails ? ', a trail' : ''}, bursts staggered over ${g.target.beats} beats. Match that richness; do not simplify unless the request asks for it.`)
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

// From scratch (the Lab's "From scratch" toggle): the grounded draft, never a copy of a library
// effect; the library only shapes it (learned ranges, real textures by role, richness).
export function scratchCandidate(text: string, g: Grounding): Candidate {
  return { ...draftCandidate(text, g), basedOn: [] }
}

export function scratchNote(g: Grounding): string {
  const refs = g.matches.slice(0, 3).map((m) => `"${m.entry.name.slice(0, 40)}"`)
  return `from scratch (library used as a style guide${refs.length ? `: ${refs.join(', ')} for ranges, textures and richness; none copied` : ''})`
}

export interface CodePick {
  index: number
  scores: (QualityScore & { principles: number; richness: number; total: number })[]
}

// The best candidate by code: library fit (quality.ts) blended with the principle checks and, when
// the library has close effects, how rich it is next to them (a sparse variation never wins over
// one that keeps the user's layering just because its few numbers sit inside the ranges).
export function pickByCode(cands: Candidate[], g: Grounding): CodePick {
  const scores = cands.map((c) => {
    const q = scoreEffect(c.effect, { recipe: g.recipe, known: g.known })
    const checks = safeChecks(c.effect)
    const principles = checks.length ? checks.reduce((a, x) => a + x.score, 0) / checks.length : 5
    const rich = richnessScore(c.effect, g.target)
    const total = g.target ? 0.6 * q.overall + 0.2 * principles + 2 * rich : 0.75 * q.overall + 0.25 * principles
    return { ...q, principles: Math.round(principles * 100) / 100, richness: rich, total: Math.round(total * 100) / 100 }
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

// ------------------------------------------------------------------ richness of model answers

// A model's whole spec that came out much sparser than the user's effects (small models write two
// or three layers): the starting draft's layers whose job the answer left out are added back, so
// the result has the draft's layering at least. Returns the spec unchanged when it is rich enough
// or the request asks for something simpler.
export function enrichSpec(spec: VfxSpec, start: VfxSpec | undefined, g: Grounding, text: string): { spec: VfxSpec; added: string[] } {
  if (!start?.layers?.length || !Array.isArray(spec.layers) || asksSimpler(text)) return { spec, added: [] }
  let effect: VfxEffect
  try {
    effect = effectFromSpec(spec)
  } catch {
    return { spec, added: [] }
  }
  const target = g.target ?? { layers: start.layers.length, roles: [], beams: false, trails: false, beats: 1, from: ['the starting draft'] }
  if (!tooSimple(effect, target, text) && spec.layers.length >= Math.min(start.layers.length, target.layers)) return { spec, added: [] }
  const roleOf = (l: VfxLayerSpec) => {
    try {
      const e = effectFromSpec({ name: 'X', layers: [l] })
      const n = allNodes(e.roots).find((x) => x.className === l.class)
      return n ? nodeRole(n) : 'other'
    } catch {
      return 'other'
    }
  }
  const have = new Set(spec.layers.map(roleOf))
  const names = new Set(spec.layers.map((l) => String(l.name)))
  const added: string[] = []
  const layers = [...spec.layers]
  const add = (l: VfxLayerSpec) => {
    let name = String(l.name)
    while (names.has(name)) name += '2'
    names.add(name)
    layers.push({ ...l, name })
    added.push(name)
  }
  // The jobs the answer left out first, then the rest of the draft (it is the floor).
  const rest: VfxLayerSpec[] = []
  for (const l of start.layers) {
    const role = roleOf(l)
    if (have.has(role) && role !== 'other') rest.push(l)
    else if (layers.length < 16) (have.add(role), add(l))
  }
  for (const l of rest) if (layers.length < 16) add(l)
  return { spec: { ...spec, layers }, added }
}

// ------------------------------------------------------------------ compose on a library copy

// The library copy a composed sequence is built on: the remix of the closest effect (when one is
// close enough), with every node name made unique ("1", "1_2", ...) so the script and the game
// runtime can name each layer.
export function composeBase(text: string, g: Grounding): Candidate | null {
  const c = singleCandidates(text, g, 1)[0]
  if (!c || c.how !== 'remix' || !c.basedOn[0]) return null
  const effect: VfxEffect = JSON.parse(JSON.stringify(c.effect))
  delete effect.script
  delete effect.patches
  delete effect.stages
  const seen = new Map<string, number>()
  for (const n of allNodes(effect.roots)) {
    const k = n.name.toLowerCase()
    const i = (seen.get(k) ?? 0) + 1
    seen.set(k, i)
    if (i > 1) n.name = `${n.name}_${i}`
  }
  return { ...c, effect }
}

// ------------------------------------------------------------------ build on a scripted effect

// A scripted effect from the user's library (a timeline script: kit rigs spawned, tweened and staged
// over time, like Hollow Purple's orbs that converge and merge). Its look lives in the script, so a
// copy of its layers played as one burst (composeBase) loses it: a request that names it (or whose
// closest close-enough effect is one) builds on the script itself.
export interface ScriptBase {
  match: VfxMatch
  // The whole effect, copied: script, stages, patches, roots and cues.
  effect: VfxEffect
  name: string
  // Request words beyond the effect's name ("hollow purple but red" -> ["red"]).
  extra: string[]
  // The request is just the effect's name: the result is a faithful copy.
  asIs: boolean
  // Deterministic tweaks the request names (used without a model): hue turn in degrees, size factor.
  hueDelta: number
  hue: number | null
  scale: number
}

// Words that do not ask for a change ("make hollow purple again", "my Hollow Purple effect").
const FILLER = new Set(['a', 'an', 'the', 'make', 'create', 'build', 'do', 'please', 'effect', 'vfx', 'fx', 'sequence', 'my', 'me', 'mine', 'own', 'again', 'copy', 'version', 'another', 'new', 'one', 'of', 'like', 'same', 'exactly', 'as', 'is', 'it', 'remake', 'redo', 'recreate', 'from', 'library', 'use', 'using', 'i', 'want', 'give', 'show', 'play', 'can', 'you', 'but', 'and', 'that', 'this', 'just', 'in', 'to'])

// Scripted library effects worth building on: the user's own (imported / liked / examples they
// added), not an unrated earlier result of the Lab; any one the request names by name.
function scriptedOwn(e: VfxEntry): boolean {
  return e.kind !== 'generated' || e.rating === 'up' || e.quality === 'good' || String(e.origin ?? '').startsWith('example:')
}

export function scriptedBase(text: string, g: Grounding): ScriptBase | null {
  const scripted = (m: VfxMatch) => !!m.entry.effect?.script && remixable(m, g.req)
  const named = g.matches.find((m) => m.nameMatch && scripted(m))
  const first = g.matches.find((m) => remixable(m, g.req))
  const m = named ?? (first && scripted(first) && scriptedOwn(first.entry) ? first : undefined)
  if (!m) return null
  const effect: VfxEffect = JSON.parse(JSON.stringify(m.entry.effect))
  const own = new Set(words(m.entry.name))
  const extra = words(text).filter((w) => !own.has(w) && !FILLER.has(w))
  const sub = readRequest(extra.join(' '))
  const hue = extra.length ? targetHue(sub, m.entry) : null
  const delta = hue === null ? 0 : hueDelta(effect, hue)
  return { match: m, effect, name: m.entry.name, extra, asIs: extra.length === 0, hueDelta: delta, hue: delta ? hue : null, scale: sub.scale }
}

// The script with the request's deterministic tweaks (colour turn, size) written into it.
export function tweakScript(sb: ScriptBase): { script: string; notes: string[] } {
  let script = sb.effect.script ?? ''
  const notes: string[] = []
  if (sb.hueDelta) {
    const r = recolorScript(script, sb.hueDelta)
    if (r.changed) (script = r.script), notes.push(`recoloured in its script (${r.changed} colour${r.changed === 1 ? '' : 's'}, hue ${sb.hueDelta > 0 ? '+' : ''}${sb.hueDelta} deg)`)
  }
  if (sb.scale !== 1) {
    const r = rescaleScript(script, sb.scale)
    if (r.changed) (script = r.script), notes.push(`${sb.scale > 1 ? 'scaled up' : 'scaled down'} x${sb.scale} in its script`)
  }
  return { script, notes }
}

// The tweaks on the recorded layers, for when the script cannot be re-recorded (no Lune).
export function tweakRecorded(sb: ScriptBase): VfxEffect {
  let e: VfxEffect = JSON.parse(JSON.stringify(sb.effect))
  if (sb.hue !== null) e = recolor(e, sb.hue).effect
  if (sb.scale !== 1) e = rescale(e, sb.scale)
  return e
}

// The finishing pass for an effect built on a scripted effect: the user's layers keep their own
// textures and numbers (it is their effect); only layers the edit added get real textures from the
// library in place of placeholders.
export function finishScriptRemix(effect: VfxEffect, original: VfxEffect, g: Grounding): { effect: VfxEffect; notes: string[] } {
  const had = new Set(allNodes(original.roots).map((n) => n.name))
  const skipRoles = Object.keys(g.ctx.libraryRoles ?? {})
  let next = effect
  let swapped = 0
  for (const ch of bankTextureChanges(next, g.bank, { near: g.near, skipRoles })) {
    if (had.has(ch.node)) continue
    try {
      next = applyChanges(next, [ch])
      if (ch.prop === 'Texture') swapped++
    } catch (e) {
      if (!(e instanceof SpecError)) throw e
    }
  }
  return { effect: next, notes: swapped ? [`${swapped} new layer(s) use textures from your effects`] : [] }
}

// Layer lines of a base for the compose prompt ("1 [core] ParticleEmitter, emits 3 at 0 s").
export function baseLayerLines(effect: VfxEffect): string[] {
  const out: string[] = []
  for (const n of allNodes(effect.roots)) {
    if (!['ParticleEmitter', 'Beam', 'Trail'].includes(n.className)) continue
    const cues = effect.cues.filter((c) => c.target === n.id)
    const emits = cues.filter((c) => c.action === 'emit').map((c) => `${c.count ?? 16}@${Math.round(c.at * 100) / 100}s`)
    out.push(`${n.name} [${nodeRole(n)}] ${n.className}${emits.length ? `, emits ${emits.slice(0, 3).join(' ')}` : ''}`)
  }
  return out
}

const IMPACT_STAGE = /impact|hit|explo|burst|slam|land|strike|clash|detonat|boom|blast|merge|collide|pop/i
const RELEASE_STAGE = /release|fire|launch|shoot|cast|unleash|throw|swing|slash|cut|attack/i

// After a script compiled on a library copy: the copy's own cues (not the script's) start at the
// impact beat (else the release), so the copy is the payoff of the choreography instead of playing
// on top of the anticipation. Returns the effect unchanged when there is no such stage.
export function alignBaseToStage(effect: VfxEffect): { effect: VfxEffect; at: number | null } {
  const stages = effect.stages ?? []
  const stage = stages.find((s) => IMPACT_STAGE.test(s.label)) ?? stages.find((s) => RELEASE_STAGE.test(s.label))
  const base = effect.cues.filter((c) => !c.script && !c.prelude && !c.spawn)
  if (!stage || !base.length || stage.at <= 0.01) return { effect, at: null }
  const first = Math.min(...base.map((c) => c.at))
  const shift = stage.at - first
  if (shift <= 0.01) return { effect, at: null }
  const next: VfxEffect = { ...effect, cues: effect.cues.map((c) => (!c.script && !c.prelude && !c.spawn ? { ...c, at: Math.round((c.at + shift) * 1000) / 1000 } : c)).sort((a, b) => a.at - b.at) }
  // Long enough for the copy to finish after the shift.
  const nodes = new Map(allNodes(next.roots).map((n) => [n.id, n]))
  let end = next.duration
  for (const c of next.cues) {
    if (c.script || c.prelude || c.spawn) continue
    const n = nodes.get(c.target)
    const life = n?.className === 'ParticleEmitter' ? Math.min(3, Number((n.props.Lifetime as number[] | undefined)?.[1] ?? 1)) : 0.3
    end = Math.max(end, c.at + life + 0.1)
  }
  next.duration = Math.min(15, Math.round(end * 100) / 100)
  return { effect: next, at: stage.at }
}

// The choreography the Lab writes itself around a library copy when no model script is used:
// a gather / glow anticipation at the root, the copy's burst on "impact", a light spike, then the
// dissipate. Names are prefixed so they never take a layer name of the copy.
export function libraryScript(text: string, baseName: string, color: { main: [number, number, number]; hot: [number, number, number] }): string {
  const c3 = (c: [number, number, number]) => `Color3.new(${c.map((x) => Math.round(x * 1000) / 1000).join(', ')})`
  return `-- ${text.replace(/\s+/g, ' ').trim().slice(0, 100)} (built on your "${baseName.replace(/[\r\n]/g, ' ')}" by RBX Forge: tune the anticipation, the copy plays on "impact")
return function(fx)
	local MAIN = ${c3(color.main)}
	local HOT = ${c3(color.hot)}
	fx:stage("anticipation")
	fx:spawn("charge", { name = "ForgeGather", color = MAIN, size = 3, rate = 70 })
	local edge = fx:spawn("glow", { name = "ForgeEdge", color = MAIN, size = 2.5 })
	fx:tween(edge.Glow, 0.45, { Rate = 22 }, "Quad", "In")
	fx:wait(0.5)
	fx:stage("impact")
	fx:disable("ForgeGather")
	fx:disable("ForgeEdge")
	fx:spawn("light", { name = "ForgeLight", color = HOT, brightness = 10 })
	fx:wait(0.3)
	fx:disable("ForgeLight")
	fx:wait(0.3)
	fx:stage("dissipate")
	fx:wait(0.5)
end
`
}

// Notes for the entry: where it started and how rich it came out next to the user's effects.
export function richnessNotes(effect: VfxEffect, g: Grounding, text: string): string[] {
  if (!g.target) return []
  const notes = [richnessLine(effect, g.target)]
  if (tooSimple(effect, g.target, text)) notes.push(`sparser than your ${g.target.from[0]}${g.target.from.length > 1 ? ' and similar effects' : ''}: add layers or pick a richer variation (or ask for "simple" when that is the point)`)
  return notes
}

// The copy's own colours for the choreography the Lab writes around it: the hot start and the
// middle of its brightest additive emitter.
export function baseColors(effect: VfxEffect): { main: [number, number, number]; hot: [number, number, number] } {
  const ems = allNodes(effect.roots).filter((n) => n.className === 'ParticleEmitter' && Array.isArray(n.props.Color) && Number(n.props.LightEmission ?? 0) >= 0.5)
  const n = ems[0]
  if (!n) return { main: [0.6, 0.45, 1], hot: [1, 1, 1] }
  const seq = n.props.Color as unknown as ColorSequence
  return { main: evalColorSequence(seq, 0.5) as [number, number, number], hot: evalColorSequence(seq, 0) as [number, number, number] }
}
