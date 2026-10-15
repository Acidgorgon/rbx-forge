// Learned parameter priors: the recipe ranges (p10 / median / p90 per layer role, learned from the
// user's own effects; recipes.ts) used as code checks with clear fixes, and as a light "fit" pass on
// generated effects (only values far outside what the user's effects use are pulled in). The same
// checks feed the numbers-only critique, the Make pipeline and the Library fit panel.
// Pure code (test/vfxQuality.test.ts).

import { allNodes, emitterRole } from './analyze.ts'
import { prop } from './schema.ts'
import { evalNumberSequence, sequenceMax } from './sequence.ts'
import { applyChanges, SpecError } from './spec.ts'
import { groupsFromTags } from './tags.ts'
import type { NumberRange, NumberSequence, VfxChange, VfxEffect, VfxNode, VfxRecipe } from './types.ts'

// A recipe needs this many effects behind it before its ranges are used as checks.
export const PRIOR_MIN_SAMPLES = 2
// "Far" outside the range: below p10 / FAR or above p90 x FAR (fit pulls only these in).
export const FAR = 1.6

export type PriorProp = 'Lifetime' | 'Speed' | 'Size' | 'LightEmission' | 'Drag' | 'Emit' | 'Transparency'

export interface PriorIssue {
  // Node key for applyChanges (name on scripted effects, else id) and the name to show.
  node: string
  name: string
  role: string
  prop: PriorProp
  key: string
  value: number
  range: { p10: number; median: number; p90: number }
  far: boolean
  message: string
  fix: VfxChange
}

export interface PriorFit {
  checks: number
  issues: PriorIssue[]
}

const r2 = (x: number) => Math.round(x * 100) / 100
const mean = (v: NumberRange) => (v[0] + v[1]) / 2

// The most specific recipe with enough samples for a set of tags: kind+element pairs, then kinds,
// then the other tags.
export function chooseRecipe(recipes: VfxRecipe[], tags: string[], minSamples = PRIOR_MIN_SAMPLES): VfxRecipe | null {
  const g = groupsFromTags(tags)
  const keys = [...g.kind.flatMap((k) => g.element.map((el) => `${k}+${el}`)), ...g.kind, ...tags]
  for (const min of [minSamples, 1]) {
    for (const k of keys) {
      const hit = recipes.find((r) => r.tag === k && r.samples >= min)
      if (hit) return hit
    }
  }
  return null
}

// Every emitter's numbers against the recipe's ranges for its role.
export function priorFit(effect: VfxEffect, recipe: VfxRecipe | null | undefined, opts: { minSamples?: number } = {}): PriorFit {
  const issues: PriorIssue[] = []
  let checks = 0
  if (!recipe || recipe.samples < (opts.minSamples ?? PRIOR_MIN_SAMPLES)) return { checks, issues }
  const nodes = allNodes(effect.roots).filter((n) => n.className === 'ParticleEmitter')
  const what = `your ${recipe.tag.replace('+', ' ')} effects`
  const keyOf = nodeKeys(effect)
  for (const n of nodes) {
    const role = emitterRole(n)
    const key = keyOf(n)
    const check = (p: PriorProp, k: string, value: number, fix: (target: number) => unknown, unit = '', far?: (v: number, r: PriorIssue['range']) => boolean) => {
      const range = recipe.ranges[k]
      if (!range || !Number.isFinite(value)) return
      checks++
      const [lo, hi] = band(range, recipe.samples, p === 'LightEmission' ? 1 : Infinity)
      if (value >= lo - 1e-6 && value <= hi + 1e-6) return
      const isFar = far ? far(value, range) : value < lo / FAR || value > hi * FAR
      const target = range.median
      const dir = value > range.p90 ? 'higher' : 'lower'
      issues.push({
        node: key,
        name: n.name,
        role,
        prop: p,
        key: k,
        value: r2(value),
        range,
        far: isFar,
        message: `${n.name} (${role}) ${label(p)} ${r2(value)}${unit} is ${dir} than ${what} (${range.p10}-${range.p90}${unit}, median ${range.median}${unit})`,
        fix: { node: key, prop: p, value: fix(target), why: `${role} ${label(p)} toward ${what} (median ${range.median}${unit})`, principle: PRINCIPLE[p] }
      })
    }
    const life = prop<NumberRange>(n, 'Lifetime')
    check('Lifetime', `${role}.Lifetime`, mean(life), (m) => scaleRange(life, m / Math.max(1e-3, mean(life))), ' s')
    const speed = prop<NumberRange>(n, 'Speed')
    if (Math.abs(mean(speed)) > 0.05) check('Speed', `${role}.Speed`, Math.abs(mean(speed)), (m) => scaleRange(speed, m / Math.max(1e-3, Math.abs(mean(speed)))))
    const size = prop<NumberSequence>(n, 'Size')
    const peak = sequenceMax(size)
    if (peak > 0) check('Size', `${role}.SizePeak`, peak, (m) => size.map((k) => (k.e ? [k.t, r2(k.v * (m / peak)), r2(k.e * (m / peak))] : [k.t, r2(k.v * (m / peak))])))
    // Blending and drag: "far" is an absolute gap (an additive layer turned to smoke, a drag that
    // stops particles dead), so deliberate tweaks (0.6 instead of 1) are left alone by the fit.
    check('LightEmission', `${role}.LightEmission`, prop<number>(n, 'LightEmission'), (m) => r2(m), '', (v, r) => Math.abs(v - Math.min(Math.max(v, r.p10), r.p90)) >= 0.5)
    const drag = prop<number>(n, 'Drag')
    check('Drag', `${role}.Drag`, drag, (m) => r2(m), '', (v, r) => Math.abs(v - Math.min(Math.max(v, r.p10), r.p90)) >= 5)
    const bursts = effect.cues.filter((c) => c.target === n.id && c.action === 'emit')
    if (bursts.length) {
      const top = Math.max(...bursts.map((b) => b.count ?? 16))
      check('Emit', `${role}.Burst`, top, (m) => bursts.map((b) => ({ at: b.at, count: Math.max(1, Math.round((b.count ?? 16) * (m / top))) })))
    }
    // Fade-out: when the user's effects of this role always end transparent, popping is an issue.
    const tr = prop<NumberSequence>(n, 'Transparency')
    const end = evalNumberSequence(tr, 1)
    const endRange = recipe.ranges[`${role}.TransparencyEnd`]
    if (endRange && endRange.p10 >= 0.85) {
      checks++
      if (end < 0.85)
        issues.push({
          node: key,
          name: n.name,
          role,
          prop: 'Transparency',
          key: `${role}.TransparencyEnd`,
          value: r2(end),
          range: endRange,
          far: end < 0.6,
          message: `${n.name} (${role}) ends at transparency ${r2(end)}: ${what} fade out to 1, so it pops`,
          fix: { node: key, prop: 'Transparency', value: [...tr.filter((k) => k.t < 0.75).map((k) => [k.t, k.v]), [1, 1]], why: 'fade out like your effects instead of popping', principle: 'fx-dissipation' }
        })
    }
  }
  return { checks, issues }
}

// The accepted band around p10-p90: a few samples only pin down a rough range, so the band is wider
// the fewer effects stand behind it (2 effects: +-35%, 8: +-18%, 30: +-9%).
export function band(range: { p10: number; p90: number }, samples: number, max = Infinity): [number, number] {
  const slack = 0.5 / Math.sqrt(Math.max(1, samples))
  const spread = Math.max(range.p90 - range.p10, Math.abs(range.p90) * 0.1)
  return [Math.max(range.p10 >= 0 ? 0 : -Infinity, range.p10 - spread * slack - Math.abs(range.p10) * slack * 0.5), Math.min(max, range.p90 + spread * slack + Math.abs(range.p90) * slack * 0.5)]
}

const PRINCIPLE: Record<PriorProp, string> = { Lifetime: 'fx-timing', Speed: 'fx-timing', Size: 'fx-shape', LightEmission: 'fx-contrast', Drag: 'fx-timing', Emit: 'fx-budget', Transparency: 'fx-dissipation' }

function label(p: PriorProp): string {
  return p === 'Size' ? 'size peak' : p === 'Emit' ? 'burst count' : p === 'LightEmission' ? 'LightEmission' : p.toLowerCase()
}

function scaleRange(v: NumberRange, k: number): number[] {
  return [r2(v[0] * k), r2(v[1] * k)]
}

// Pulls in the values that are far outside the learned ranges (or every issue with all: true).
// Changes go through applyChanges (scripted effects keep them as patches across re-runs).
export function fitToPriors(effect: VfxEffect, recipe: VfxRecipe | null | undefined, opts: { all?: boolean } = {}): { effect: VfxEffect; applied: PriorIssue[] } {
  const { issues } = priorFit(effect, recipe)
  const pick = issues.filter((i) => opts.all || i.far)
  let next = effect
  const applied: PriorIssue[] = []
  for (const i of pick) {
    try {
      next = applyChanges(next, [i.fix])
      applied.push(i)
    } catch (e) {
      if (!(e instanceof SpecError)) throw e
    }
  }
  return { effect: next, applied }
}

// Short text of the learned ranges per role, for prompts ("sparks: life 0.2-0.5 s, speed 18-40, ...").
export function priorLines(recipe: VfxRecipe | null | undefined, roles?: string[]): string[] {
  if (!recipe) return []
  const rg = (k: string, unit = '') => {
    const v = recipe.ranges[k]
    return v ? `${v.p10}-${v.p90}${unit}` : null
  }
  const lines: string[] = []
  for (const l of recipe.layers) {
    if (roles && !roles.includes(l.role)) continue
    const bits = [
      rg(`${l.role}.Lifetime`, ' s') && `life ${rg(`${l.role}.Lifetime`, ' s')}`,
      rg(`${l.role}.Speed`) && `speed ${rg(`${l.role}.Speed`)}`,
      rg(`${l.role}.SizePeak`) && `size peak ${rg(`${l.role}.SizePeak`)}`,
      rg(`${l.role}.LightEmission`) && `LightEmission ${rg(`${l.role}.LightEmission`)}`,
      rg(`${l.role}.Burst`) && `emit ${rg(`${l.role}.Burst`)}`,
      rg(`${l.role}.BurstAt`, ' s') && `first burst at ${rg(`${l.role}.BurstAt`, ' s')}`,
      rg(`${l.role}.Rate`) && `rate ${rg(`${l.role}.Rate`)}`
    ].filter(Boolean)
    if (bits.length) lines.push(`${l.role} (${Math.round(l.share * 100)}% of layers): ${bits.join(', ')}`)
  }
  const d = recipe.ranges['effect.duration']
  if (d) lines.push(`one play lasts ${d.p10}-${d.p90} s; ${recipe.emitters} emitters typical`)
  return lines
}

// How changes name a node: by name on scripted effects (patches survive re-runs) and when the name
// is unique, else by id (imported packs repeat names like "1SP").
export function nodeKeys(effect: VfxEffect): (n: VfxNode) => string {
  const count = new Map<string, number>()
  for (const n of allNodes(effect.roots)) count.set(n.name, (count.get(n.name) ?? 0) + 1)
  return (n) => (effect.script || (count.get(n.name) ?? 0) <= 1 ? n.name : n.id)
}
