// Offline VFX benchmark: a fixed prompt set against the fixture library (library.ts), scored by code
// metrics only (shared/vfx/quality.ts: realism vs the learned priors, layer coverage, texture reuse,
// timing sanity), no model calls. "before" is the Make pipeline as it was (the archetype draft with
// the learned recipe and the library's most common textures); "after" is the grounded pipeline
// (remix the closest effect, finish against the library, pick between variations). Sequences (the
// kit timeline drafts) run through Lune when it is installed.
//
// npm run eval:vfx prints the table; test/vfxEval.test.ts holds the numbers to a floor.

import { draftSpec, libraryTextures, promptTags } from '../../src/shared/vfx/draft.ts'
import { draftScript } from '../../src/shared/vfx/choreo.ts'
import { finishRun } from '../../src/shared/vfx/compile.ts'
import { finishEffect, ground, pickByCode, singleCandidates, type Grounding } from '../../src/shared/vfx/ground.ts'
import { scoreEffect, type QualityScore } from '../../src/shared/vfx/quality.ts'
import { extractRecipe, extractRecipes } from '../../src/shared/vfx/recipes.ts'
import { applyChanges, effectFromSpec } from '../../src/shared/vfx/spec.ts'
import { groupsFromTags } from '../../src/shared/vfx/tags.ts'
import type { VfxChange, VfxEffect, VfxEntry, VfxRecipe } from '../../src/shared/vfx/types.ts'
import { fixtureLibrary } from './library.ts'

// The prompt set, with the recipe key that is the yardstick for each (null: the library has nothing
// of that kind, so realism / coverage are neutral).
export const PROMPTS: { prompt: string; key: string | null }[] = [
  { prompt: 'fire sword slash with embers', key: 'slash+fire' },
  { prompt: 'blue lightning impact', key: 'impact+electric' },
  { prompt: 'ice slash', key: 'slash' },
  { prompt: 'dark purple explosion', key: 'explosion' },
  { prompt: 'holy light aura', key: 'aura' },
  { prompt: 'fireball projectile', key: 'projectile+fire' },
  { prompt: 'earth ground slam shockwave', key: 'shockwave' },
  { prompt: 'electric charge up', key: 'charge' },
  { prompt: 'wind dash', key: 'dash' },
  { prompt: 'huge fire explosion', key: 'explosion+fire' },
  { prompt: 'water splash impact', key: 'impact' },
  { prompt: 'green poison aura', key: 'aura' },
  { prompt: 'rock impact with debris', key: 'impact+earth' },
  { prompt: 'laser beam', key: null }
]

export type Metrics = Pick<QualityScore, 'realism' | 'coverage' | 'textureReuse' | 'timing' | 'overall'>

export interface EvalRow {
  prompt: string
  before: Metrics
  after: Metrics
  // After, with 3 variations and the code pick.
  pick3: Metrics
  how: string
}

export interface EvalReport {
  rows: EvalRow[]
  mean: { before: Metrics; after: Metrics; pick3: Metrics }
  heldOut: { before: Metrics; after: Metrics }
  // Variation pick with a fake model: the chosen variation's score vs the mean of the variations.
  fakeModelPick: { chosen: number; meanOfVariations: number; worst: number }
  sequences?: { before: Metrics; after: Metrics; prompts: number }
}

const KEYS: (keyof Metrics)[] = ['realism', 'coverage', 'textureReuse', 'timing', 'overall']

function mean(list: Metrics[]): Metrics {
  const out = {} as Metrics
  for (const k of KEYS) out[k] = Math.round((list.reduce((a, m) => a + m[k], 0) / Math.max(1, list.length)) * 1000) / 1000
  return out
}

const pickMetrics = (q: QualityScore): Metrics => ({ realism: q.realism, coverage: q.coverage, textureReuse: q.textureReuse, timing: q.timing, overall: q.overall })

// The old service.recipeFor (prompt tags -> learned recipe, else computed on the fly).
function legacyRecipe(prompt: string, recipes: VfxRecipe[], entries: VfxEntry[]): VfxRecipe | null {
  const t0 = promptTags(prompt)
  let tags = t0.length ? t0 : prompt.toLowerCase().split(/\W+/)
  const g = groupsFromTags(tags)
  tags = [...g.kind.flatMap((k) => g.element.map((el) => `${k}+${el}`)), ...tags]
  for (const t of tags) {
    const hit = recipes.find((r) => r.tag === t)
    if (hit) return hit
  }
  for (const t of tags) {
    const r = extractRecipe(t, entries)
    if (r) return r
  }
  return null
}

// The old Make without a model (and with a model that keeps its starting draft).
export function legacyMake(prompt: string, entries: VfxEntry[], recipes: VfxRecipe[]): VfxEffect {
  return effectFromSpec(draftSpec(prompt, { recipe: legacyRecipe(prompt, recipes, entries), textures: libraryTextures(entries) }))
}

export function newMake(prompt: string, entries: VfxEntry[], recipes: VfxRecipe[], variations = 1): { effect: VfxEffect; how: string; g: Grounding } {
  const g = ground(prompt, { entries, recipes })
  const cands = singleCandidates(prompt, g, variations)
  const i = cands.length > 1 ? pickByCode(cands, g).index : 0
  return { effect: cands[i].effect, how: `${cands[i].how}${cands[i].how === 'remix' ? ` of ${entries.find((e) => e.id === cands[i].basedOn[0])?.name}` : ''}`, g }
}

function yardstick(key: string | null, entries: VfxEntry[]): VfxRecipe | null {
  return key ? extractRecipe(key, entries) : null
}

function known(entries: VfxEntry[]): Set<string> {
  const g = ground('x', { entries })
  return g.known
}

// A fake model for Make's variations: the plain answer keeps the remix; B overshoots (every layer
// lives 5x longer and never fades out); C shrinks every layer to 30%. The pick should keep A.
export function fakeVariationChanges(effect: VfxEffect, variation: number): VfxChange[] {
  if (variation === 0) return []
  const out: VfxChange[] = []
  const seen = new Set<string>()
  const walk = (ns: VfxEffect['roots']) => {
    for (const n of ns) {
      if (n.className === 'ParticleEmitter' && !seen.has(n.name)) {
        seen.add(n.name)
        if (variation === 1) {
          const life = (n.props.Lifetime as number[]) ?? [1, 1]
          out.push({ node: n.name, prop: 'Lifetime', value: [life[0] * 5, life[1] * 5] }, { node: n.name, prop: 'Transparency', value: [[0, 0], [1, 0.2]] })
        } else {
          const size = (n.props.Size as { t: number; v: number }[]) ?? [{ t: 0, v: 1 }, { t: 1, v: 1 }]
          out.push({ node: n.name, prop: 'Size', value: size.map((k) => [k.t, k.v * 0.3]) })
        }
      }
      walk(n.children)
    }
  }
  walk(effect.roots)
  return out
}

export async function runEval(opts: { lune?: { lune: string; runtimeDir: string } | null } = {}): Promise<EvalReport> {
  const entries = fixtureLibrary()
  const recipes = extractRecipes(entries)
  const tex = known(entries)
  const rows: EvalRow[] = []
  const held: { before: Metrics; after: Metrics }[] = []
  const picks: { chosen: number; all: number[] }[] = []
  for (const p of PROMPTS) {
    const recipe = yardstick(p.key, entries)
    const score = (e: VfxEffect) => pickMetrics(scoreEffect(e, { recipe, known: tex }))
    const before = score(legacyMake(p.prompt, entries, recipes))
    const one = newMake(p.prompt, entries, recipes, 1)
    const three = newMake(p.prompt, entries, recipes, 3)
    rows.push({ prompt: p.prompt, before, after: score(one.effect), pick3: score(three.effect), how: one.how })
    // Held out: the closest effect is not in the library (the pipeline has to generalise).
    const top = one.g.matches[0]?.entry.id
    if (top) {
      const rest = entries.filter((e) => e.id !== top)
      const restRecipes = extractRecipes(rest)
      held.push({ before: score(legacyMake(p.prompt, rest, restRecipes)), after: score(newMake(p.prompt, rest, restRecipes, 1).effect) })
    }
    // Fake model: three variations of the remix, finished and picked by code.
    const g = one.g
    const variants = [0, 1, 2].map((v) => {
      let e = singleCandidates(p.prompt, g, 1)[0].effect
      for (const ch of fakeVariationChanges(e, v)) {
        try {
          e = applyChanges(e, [ch])
        } catch {
          /* a change the effect has no node for */
        }
      }
      return { effect: finishEffect(e, g).effect, basedOn: [], how: 'model-remix' as const, notes: [] }
    })
    const pick = pickByCode(variants, g)
    const totals = variants.map((v) => scoreEffect(v.effect, { recipe, known: tex }).overall)
    picks.push({ chosen: totals[pick.index], all: totals })
  }
  const report: EvalReport = {
    rows,
    mean: { before: mean(rows.map((r) => r.before)), after: mean(rows.map((r) => r.after)), pick3: mean(rows.map((r) => r.pick3)) },
    heldOut: { before: mean(held.map((h) => h.before)), after: mean(held.map((h) => h.after)) },
    fakeModelPick: {
      chosen: Math.round((picks.reduce((a, p) => a + p.chosen, 0) / picks.length) * 100) / 100,
      meanOfVariations: Math.round((picks.reduce((a, p) => a + p.all.reduce((x, y) => x + y, 0) / p.all.length, 0) / picks.length) * 100) / 100,
      worst: Math.round((picks.reduce((a, p) => a + Math.min(...p.all), 0) / picks.length) * 100) / 100
    }
  }
  if (opts.lune) {
    const { luneTimeline } = await import('../../src/main/services/vfx/lune.ts')
    const before: Metrics[] = []
    const after: Metrics[] = []
    for (const p of PROMPTS) {
      const recipe = yardstick(p.key, entries)
      const script = draftScript(p.prompt)
      const rec = await luneTimeline(script, opts.lune)
      const run = finishRun({ name: 'Seq', roots: [], cues: [], duration: 2 }, script, rec)
      if (!run.ok || !run.effect) continue
      const g = ground(p.prompt, { entries, recipes })
      before.push(pickMetrics(scoreEffect(run.effect, { recipe, known: tex })))
      after.push(pickMetrics(scoreEffect(finishEffect(run.effect, g).effect, { recipe, known: tex })))
    }
    report.sequences = { before: mean(before), after: mean(after), prompts: before.length }
  }
  return report
}

export function formatReport(r: EvalReport): string {
  const f = (m: Metrics) => `${m.overall.toFixed(2).padStart(5)}  real ${pct(m.realism)} cover ${pct(m.coverage)} tex ${pct(m.textureReuse)} time ${pct(m.timing)}`
  const lines = [
    `VFX Make benchmark: ${r.rows.length} prompts, fixture library of ${fixtureLibrary().length} effects (code metrics, no model calls)`,
    '',
    ...r.rows.map((row) => `${row.prompt.padEnd(30)} before ${row.before.overall.toFixed(2).padStart(5)}  after ${row.after.overall.toFixed(2).padStart(5)}  (${row.how})`),
    '',
    `mean before          ${f(r.mean.before)}`,
    `mean after           ${f(r.mean.after)}`,
    `mean after, pick 3   ${f(r.mean.pick3)}`,
    `held out (closest effect removed): before ${r.heldOut.before.overall.toFixed(2)}, after ${r.heldOut.after.overall.toFixed(2)}`,
    `fake-model variations: picked ${r.fakeModelPick.chosen.toFixed(2)} vs mean ${r.fakeModelPick.meanOfVariations.toFixed(2)} (worst ${r.fakeModelPick.worst.toFixed(2)})`,
    r.sequences ? `sequences (kit drafts via Lune, ${r.sequences.prompts}): before ${f(r.sequences.before)}\n${' '.repeat(38)}after  ${f(r.sequences.after)}` : 'sequences: skipped (Lune not found; set LUNE_PATH)'
  ]
  return lines.join('\n')
}

function pct(x: number): string {
  return `${Math.round(x * 100)}%`.padStart(4)
}
