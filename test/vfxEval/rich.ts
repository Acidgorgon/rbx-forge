// Richness benchmark: the "I taught it a lot and it still makes simple effects" case. A library shaped
// like a real import (richLibrary.ts: 36 auto-tagged effects, 4-12 emitters, beams, trails,
// flipbooks, staggered EmitCount / EmitDelay bursts), prompts the way a user types them, and a fake
// SMALL model that answers the way a Haiku-class model tends to:
//   - Make, remix path: it "cleans up" the copy: most layers set to emit [] / Enabled false (the old
//     remix prompt told it how), plus a colour tweak;
//   - Make, draft path: a two-layer spec (core + glow);
//   - Make, variation pick: one gutted variation next to the plain copy, a small critic picks the
//     sparse one;
//   - Compose (the Lab's default "sequence" mode): a two-call script, an expanding shockwave shell
//     and a flash: the translucent dome + four-point flare seen in the Lab.
// "before" is the pipeline as it was (edits applied as answered, compose on an empty base, the code
// pick without richness); "after" is the current one (layer guard, spec enrichment, compose on the
// library copy aligned to the impact beat, richness in the pick). Metric: richness (richness.ts:
// layers, roles, beams / trails and burst beats against the closest library effects), 0..1.
// No model calls, no Lune (the fake compose script is fed as recorded ops).

import { compileTimeline, finishRun, type RecordedOp } from '../../src/shared/vfx/compile.ts'
import { draftScript } from '../../src/shared/vfx/choreo.ts'
import { alignBaseToStage, composeBase, draftCandidate, enrichSpec, finishEffect, ground, pickByCode, singleCandidates, type Candidate, type Grounding } from '../../src/shared/vfx/ground.ts'
import { extractRecipes } from '../../src/shared/vfx/recipes.ts'
import { remixable, type VfxRequest, type VfxMatch } from '../../src/shared/vfx/retrieve.ts'
import { guardLayerEdits, richness, richnessScore, RICH_MIN, tooSimple } from '../../src/shared/vfx/richness.ts'
import { allNodes } from '../../src/shared/vfx/analyze.ts'
import { applyChanges, effectFromSpec, SpecError, type VfxSpec } from '../../src/shared/vfx/spec.ts'
import type { VfxChange, VfxEffect, VfxEntry } from '../../src/shared/vfx/types.ts'
import { richLibrary } from './richLibrary.ts'

export const RICH_PROMPTS = [
  'purple energy blast',
  'dark purple explosion',
  'red lightning punch',
  'fire slash',
  'blue orb that explodes',
  'black flash impact',
  'ice ground spikes',
  'electric beam attack',
  'hollow purple but red',
  'golden aura powerup',
  'water dragon',
  'crimson slash with sparks',
  'huge nuke explosion',
  'cursed technique red',
  'portal opening',
  'healing rain'
]

export interface RichCell {
  layers: number
  richness: number
}
export interface RichRow {
  prompt: string
  target: number
  base: string
  make: { before: RichCell; after: RichCell }
  pick: { before: RichCell; after: RichCell }
  compose: { before: RichCell; after: RichCell }
}
export interface RichReport {
  rows: RichRow[]
  library: { effects: number; meanLayers: number; meanBeats: number }
  mean: { make: { before: number; after: number }; pick: { before: number; after: number }; compose: { before: number; after: number }; layersBefore: number; layersAfter: number }
  // Prompts whose result is "too simple" next to the closest effects.
  tooSimple: { before: number; after: number }
  // Name-only prompts ("hollow purple but red") that start from the named effect.
  remixed: { before: number; after: number; of: number }
}

const cell = (e: VfxEffect, g: Grounding): RichCell => ({ layers: richness(e).layers, richness: richnessScore(e, g.target) })

// The fake small model's remix answer: hide everything but the first two layers, tint the core.
export function smallModelRemixChanges(effect: VfxEffect): VfxChange[] {
  const layers = allNodes(effect.roots).filter((n) => ['ParticleEmitter', 'Beam', 'Trail'].includes(n.className))
  const out: VfxChange[] = []
  layers.forEach((n, i) => {
    if (i < 2) return
    if (n.className === 'ParticleEmitter') out.push({ node: n.id, prop: 'emit', value: [], why: 'simplify' })
    out.push({ node: n.id, prop: 'Enabled', value: false, why: 'simplify' })
  })
  if (layers[0]) out.push({ node: layers[0].id, prop: 'LightEmission', value: 1, why: 'hotter core' })
  return out
}

// The fake small model's whole spec: a core and a glow.
export function smallModelSpec(text: string): VfxSpec {
  return {
    name: 'SmallDraft',
    description: text,
    duration: 1.2,
    layers: [
      { name: 'Core', class: 'ParticleEmitter', props: { Lifetime: [0.3, 0.5], Speed: [0, 1], Size: [[0, 1], [0.2, 4], [1, 0]], Transparency: [[0, 0], [1, 1]], Color: ['#ffffff', '#b06bff'], LightEmission: 1 }, emit: [{ at: 0, count: 6 }] },
      { name: 'Glow', class: 'ParticleEmitter', props: { Lifetime: [0.4, 0.5], Speed: 0, Size: [[0, 3], [1, 6]], Transparency: [[0, 0.5], [1, 1]], Color: '#b06bff', LightEmission: 1 }, emit: [{ at: 0, count: 1 }] }
    ]
  }
}

// The fake small model's compose script, as the recorder would report it: a shockwave shell (the
// dome) and a flash (the four-point flare), one impact beat.
export const DOME_FLARE_OPS: RecordedOp[] = [
  { op: 'stage', at: 0, label: 'charge' },
  { op: 'stage', at: 0.3, label: 'impact' },
  { op: 'spawn', at: 0.3, kind: 'shockwave', opts: { name: 'Dome', color: { __t: 'c3', r: 0.62, g: 0.3, b: 1 }, size: 14 } },
  { op: 'spawn', at: 0.3, kind: 'flash', opts: { name: 'Flare', color: { __t: 'c3', r: 0.85, g: 0.7, b: 1 } } },
  { op: 'stage', at: 0.8, label: 'dissipate' }
]
const DOME_SCRIPT = '-- fake small-model script: shockwave + flash'

function applyAll(e: VfxEffect, changes: VfxChange[]): VfxEffect {
  let next = e
  for (const c of changes) {
    try {
      next = applyChanges(next, [c])
    } catch (err) {
      if (!(err instanceof SpecError)) throw err
    }
  }
  return next
}

// The retrieval rule before name matches: a request with no kind / element never remixed.
function legacyRemixable(m: VfxMatch | undefined, req: VfxRequest): boolean {
  if (!m) return false
  if (req.groups.kind.length && !m.kindMatch) return false
  if (!req.groups.kind.length && !req.groups.element.length) return false
  return m.score >= 6
}

function legacyStart(text: string, g: Grounding): Candidate {
  const m = g.matches.find((x) => !x.entry.effect?.script)
  return m && legacyRemixable(m, g.req) ? singleCandidates(text, g, 1)[0] : draftCandidate(text, g)
}

export async function runRichEval(opts: { lune?: { lune: string; runtimeDir: string } | null; entries?: VfxEntry[] } = {}): Promise<RichReport> {
  const entries = opts.entries ?? richLibrary()
  const timeline = opts.lune ? (await import('../../src/main/services/vfx/lune.ts')).luneTimeline : null
  const recipes = extractRecipes(entries)
  const rows: RichRow[] = []
  let remixedBefore = 0
  let remixedAfter = 0
  let named = 0
  for (const prompt of RICH_PROMPTS) {
    const g = ground(prompt, { entries, recipes })
    // ---- Make with the small model
    const oldStart = legacyStart(prompt, g)
    const newStart = singleCandidates(prompt, g, 1)[0]
    const makeOne = (start: Candidate, guarded: boolean): VfxEffect => {
      if (start.how === 'remix') {
        const changes = smallModelRemixChanges(start.effect)
        const kept = guarded ? guardLayerEdits(start.effect, changes, prompt).kept : changes
        return finishEffect(applyAll(start.effect, kept), g).effect
      }
      const answer = smallModelSpec(prompt)
      const spec = guarded ? enrichSpec(answer, start.spec, g, prompt).spec : answer
      return finishEffect(effectFromSpec(spec), g).effect
    }
    const makeBefore = makeOne(oldStart, false)
    const makeAfter = makeOne(newStart, true)
    // ---- Variations: the plain copy, a gutted one, the small draft; the old pick vs the new one
    const variants = (start: Candidate, guarded: boolean): Candidate[] => [
      { ...start, how: 'model-remix' as const },
      { ...start, effect: makeOne(start, guarded), how: 'model-remix' as const },
      { ...start, effect: finishEffect(effectFromSpec(smallModelSpec(prompt)), g).effect, how: 'model-draft' as const }
    ]
    const vb = variants(oldStart, false)
    const oldScores = pickByCode(vb, g).scores.map((s) => 0.75 * s.overall + 0.25 * s.principles)
    const oldPick = oldScores.indexOf(Math.max(...oldScores))
    const va = variants(newStart, true)
    const newPick = pickByCode(va, g).index
    // ---- Compose with the small model's dome + flare script
    const composeBefore = finishEffect(compileTimeline({ name: 'Seq', roots: [], cues: [], duration: 2 }, DOME_FLARE_OPS, DOME_SCRIPT).effect, g).effect
    const base = composeBase(prompt, g)
    const composed = compileTimeline(base ? { ...base.effect, name: 'Seq' } : { name: 'Seq', roots: [], cues: [], duration: 2 }, DOME_FLARE_OPS, DOME_SCRIPT).effect
    let composeAfter = finishEffect(base ? alignBaseToStage(composed).effect : composed, g).effect
    // No library base and a sparse script: the built-in draft sequence joins the pick (needs Lune).
    if (!base && timeline && tooSimple(composeAfter, g.target, prompt)) {
      const script = draftScript(prompt)
      const run = finishRun({ name: 'Seq', roots: [], cues: [], duration: 2 }, script, await timeline(script, opts.lune!))
      if (run.ok && run.effect) {
        const cands: Candidate[] = [{ effect: composeAfter, basedOn: [], how: 'model-script', notes: [] }, { effect: finishEffect(run.effect, g).effect, basedOn: [], how: 'script', notes: [] }]
        composeAfter = cands[pickByCode(cands, g).index].effect
      }
    }
    if (!g.req.groups.kind.length && !g.req.groups.element.length && g.matches[0]?.nameMatch) {
      named++
      if (oldStart.how === 'remix') remixedBefore++
      if (newStart.how === 'remix' && remixable(g.matches[0], g.req)) remixedAfter++
    }
    rows.push({
      prompt,
      target: g.target?.layers ?? 0,
      base: newStart.how === 'remix' ? g.matches.find((m) => m.entry.id === newStart.basedOn[0])?.entry.name ?? '?' : 'draft',
      make: { before: cell(makeBefore, g), after: cell(makeAfter, g) },
      pick: { before: cell(vb[oldPick].effect, g), after: cell(va[newPick].effect, g) },
      compose: { before: cell(composeBefore, g), after: cell(composeAfter, g) }
    })
  }
  const m = (f: (r: RichRow) => number) => Math.round((rows.reduce((a, r) => a + f(r), 0) / rows.length) * 1000) / 1000
  const simple = (pick: (r: RichRow) => RichCell) => rows.filter((r) => pick(r).richness < RICH_MIN).length
  const lib = entries.filter((e) => e.effect).map((e) => richness(e.effect!))
  return {
    rows,
    library: { effects: lib.length, meanLayers: Math.round((lib.reduce((a, r) => a + r.layers, 0) / lib.length) * 10) / 10, meanBeats: Math.round((lib.reduce((a, r) => a + r.beats, 0) / lib.length) * 10) / 10 },
    mean: {
      make: { before: m((r) => r.make.before.richness), after: m((r) => r.make.after.richness) },
      pick: { before: m((r) => r.pick.before.richness), after: m((r) => r.pick.after.richness) },
      compose: { before: m((r) => r.compose.before.richness), after: m((r) => r.compose.after.richness) },
      layersBefore: m((r) => (r.make.before.layers + r.compose.before.layers) / 2),
      layersAfter: m((r) => (r.make.after.layers + r.compose.after.layers) / 2)
    },
    tooSimple: {
      before: simple((r) => r.make.before) + simple((r) => r.pick.before) + simple((r) => r.compose.before),
      after: simple((r) => r.make.after) + simple((r) => r.pick.after) + simple((r) => r.compose.after)
    },
    remixed: { before: remixedBefore, after: remixedAfter, of: named }
  }
}

export function formatRichReport(r: RichReport): string {
  const c = (x: RichCell) => `${String(x.layers).padStart(2)}L ${Math.round(x.richness * 100).toString().padStart(3)}%`
  const n = r.rows.length
  return [
    `VFX richness benchmark (small-model fake): ${n} prompts, auto-tagged library of ${r.library.effects} effects (mean ${r.library.meanLayers} layers, ${r.library.meanBeats} beats)`,
    `${'prompt'.padEnd(26)} ${'target'.padStart(6)}  ${'make before -> after'.padEnd(22)}  ${'pick before -> after'.padEnd(22)}  ${'compose before -> after'.padEnd(22)}  base`,
    ...r.rows.map((row) => `${row.prompt.padEnd(26)} ${String(row.target).padStart(5)}L  ${c(row.make.before)} -> ${c(row.make.after)}  ${c(row.pick.before)} -> ${c(row.pick.after)}  ${c(row.compose.before)} -> ${c(row.compose.after)}  ${row.base}`),
    '',
    `mean richness: make ${pct(r.mean.make.before)} -> ${pct(r.mean.make.after)}, variation pick ${pct(r.mean.pick.before)} -> ${pct(r.mean.pick.after)}, compose ${pct(r.mean.compose.before)} -> ${pct(r.mean.compose.after)}`,
    `mean layers (make + compose): ${r.mean.layersBefore} -> ${r.mean.layersAfter}`,
    `results under ${Math.round(RICH_MIN * 100)}% richness (of ${n * 3}): ${r.tooSimple.before} -> ${r.tooSimple.after}`,
    `name-only prompts that start from the named effect: ${r.remixed.before} -> ${r.remixed.after} of ${r.remixed.of}`
  ].join('\n')
}

const pct = (x: number) => `${Math.round(x * 100)}%`
