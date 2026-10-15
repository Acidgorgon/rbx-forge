// "Learning" from the library: per effect type (tag), the parameter ranges and patterns seen in the
// references (layer roles, LightEmission, lifetimes, size-curve shapes, flipbooks, bursts, colours),
// plus "avoid" notes from disliked results. Recipes are saved as memory skills (vfx-recipe-<tag>) so
// prompts carry the one-line index and recall / use_skill pull the full numbers.

import { allNodes, effectColors, emitterRole, sizeShape } from './analyze.ts'
import { prop } from './schema.ts'
import { curveShape, evalNumberSequence, sequenceMax } from './sequence.ts'
import { flipbookFrames } from './simulate.ts'
import type { NumberRange, NumberSequence, VfxEntry, VfxRecipe } from './types.ts'
import { videoHintNote, videoHints } from '../videoref/prompt.ts'
import { tagGroupsOf } from './tags.ts'

export const RECIPE_PREFIX = 'vfx-recipe-'
// Tags that are colours or too generic to make a recipe of their own.
const NON_TYPE_TAGS = new Set(['red', 'orange', 'yellow', 'green', 'cyan', 'blue', 'purple', 'pink', 'white', 'grey', 'black'])

// Weighted quantile over (value, weight) samples (weights > 0): liked effects pull the ranges more.
function wquantile(samples: { v: number; w: number }[], q: number): number {
  const s = [...samples].filter((x) => x.w > 0).sort((a, b) => a.v - b.v)
  if (!s.length) return 0
  if (s.length === 1) return s[0].v
  // Midpoint cumulative weights (so equal weights match the unweighted quantile at the ends).
  const total = s.reduce((a, x) => a + x.w, 0)
  let acc = 0
  const pos = s.map((x) => {
    const mid = acc + x.w / 2
    acc += x.w
    return mid / total
  })
  const lo0 = pos[0]
  const hi0 = pos[pos.length - 1]
  const target = lo0 + (hi0 - lo0) * q
  for (let i = 1; i < s.length; i++) {
    if (pos[i] >= target) {
      const span = pos[i] - pos[i - 1] || 1
      return s[i - 1].v + (s[i].v - s[i - 1].v) * ((target - pos[i - 1]) / span)
    }
  }
  return s[s.length - 1].v
}

// How much one library entry counts when learning: liked effects twice, references once, generated
// results nobody rated half; disliked never (they only add "avoid" notes). `boost` is the feedback
// multiplier (effects whose remixes the user liked count more; see shared/vfx/retrieve.ts).
export function learnWeight(e: Pick<VfxEntry, 'rating' | 'quality' | 'kind'>, boost = 1): number {
  if (e.quality === 'avoid' || e.rating === 'down') return 0
  const base = e.rating === 'up' ? 2 : e.quality === 'good' ? 1.5 : e.kind === 'generated' ? 0.5 : 1
  return base * Math.max(0.25, Math.min(3, boost))
}

function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0
  const pos = (sorted.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo)
}

function r(x: number): number {
  return Math.round(x * 100) / 100
}

// Recipes are learned per KIND ("slash"), per KIND+ELEMENT pair ("slash+fire") and per custom tag
// ("goal"); pairs and custom tags need PAIR_MIN examples. Elements and timings alone are not
// effect types (a fire slash and a fire aura share little).
export const PAIR_MIN = 2
export function recipeTags(entries: VfxEntry[]): string[] {
  const counts = new Map<string, number>()
  const bump = (k: string) => counts.set(k, (counts.get(k) ?? 0) + 1)
  for (const e of entries) {
    if (!e.effect || learnWeight(e) <= 0) continue
    const g = tagGroupsOf(e)
    for (const k of g.kind) bump(k)
    for (const k of g.kind) for (const el of g.element) bump(`${k}+${el}`)
    for (const t of g.custom) if (!NON_TYPE_TAGS.has(t)) bump(t)
  }
  return [...counts.entries()]
    .filter(([t, n]) => n >= (t.includes('+') || !tagGroupsOf({ tags: [t] }).kind.length ? PAIR_MIN : 1))
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t)
}

// Entries a recipe key covers: "slash+fire" = kind slash and element fire; "slash" = the tag.
export function recipeMatches(e: VfxEntry, key: string): boolean {
  if (!key.includes('+')) return e.tags.includes(key) || tagGroupsOf(e).kind.includes(key) || tagGroupsOf(e).custom.includes(key)
  const [kind, element] = key.split('+')
  const g = tagGroupsOf(e)
  return g.kind.includes(kind) && g.element.includes(element)
}

// One recipe from the entries tagged `tag` (references and liked results; "avoid" entries only
// contribute notes).
export function extractRecipe(tag: string, entries: VfxEntry[], opts: { boost?: (e: VfxEntry) => number } = {}): VfxRecipe | null {
  const tagged = entries.filter((e) => recipeMatches(e, tag) && e.effect)
  const good = tagged.filter((e) => learnWeight(e) > 0)
  if (!good.length) return null
  const samples: Record<string, { v: number; w: number }[]> = {}
  let w = 1
  const add = (k: string, v: number) => {
    if (Number.isFinite(v)) (samples[k] ??= []).push({ v, w })
  }
  const roles = new Map<string, number>()
  const shapes: Record<string, number> = {}
  let emitterTotal = 0
  let flip = 0
  let burstEffects = 0
  const colorCount = new Map<string, number>()
  const emitterCounts: number[] = []
  for (const e of good) {
    w = learnWeight(e, opts.boost?.(e) ?? 1)
    const eff = e.effect!
    const emitters = allNodes(eff.roots).filter((n) => n.className === 'ParticleEmitter')
    emitterCounts.push(emitters.length)
    add('effect.duration', eff.duration)
    add('effect.emitters', emitters.length)
    if (eff.cues.some((c) => c.action === 'emit')) burstEffects++
    for (const c of effectColors(eff)) colorCount.set(c, (colorCount.get(c) ?? 0) + 1)
    for (const n of allNodes(eff.roots)) {
      if (n.className === 'Trail' || n.className === 'Beam') roles.set(n.className.toLowerCase(), (roles.get(n.className.toLowerCase()) ?? 0) + 1)
      if (/Light$/.test(n.className)) roles.set('light', (roles.get('light') ?? 0) + 1)
    }
    for (const n of emitters) {
      emitterTotal++
      const role = emitterRole(n)
      roles.set(role, (roles.get(role) ?? 0) + 1)
      const life = prop<NumberRange>(n, 'Lifetime')
      const speed = prop<NumberRange>(n, 'Speed')
      add('LightEmission', prop<number>(n, 'LightEmission'))
      add(`${role}.Lifetime`, (life[0] + life[1]) / 2)
      add(`${role}.Speed`, (speed[0] + speed[1]) / 2)
      add(`${role}.SizePeak`, sequenceMax(prop<NumberSequence>(n, 'Size')))
      add(`${role}.Drag`, prop<number>(n, 'Drag'))
      add(`${role}.LightEmission`, prop<number>(n, 'LightEmission'))
      add(`${role}.Brightness`, prop<number>(n, 'Brightness'))
      const bursts = eff.cues.filter((c) => c.target === n.id && c.action === 'emit')
      if (bursts.length) add(`${role}.Burst`, Math.max(...bursts.map((b) => b.count ?? 16)))
      else add(`${role}.Rate`, prop<number>(n, 'Rate'))
      const spread = prop<number[]>(n, 'SpreadAngle') ?? [0, 0]
      add(`${role}.Spread`, Math.max(spread[0], spread[1]))
      add(`${role}.TransparencyEnd`, evalNumberSequence(prop<NumberSequence>(n, 'Transparency'), 1))
      if (bursts.length) add(`${role}.BurstAt`, Math.min(...bursts.map((b) => b.at)))
      const shape = sizeShape(n)
      shapes[shape] = (shapes[shape] ?? 0) + 1
      const tshape = curveShape(prop<NumberSequence>(n, 'Transparency'))
      shapes[`transparency:${tshape}`] = (shapes[`transparency:${tshape}`] ?? 0) + 1
      if (flipbookFrames(n) > 1) flip++
    }
    for (const c of eff.cues) if (c.action === 'emit') add('burst.at', c.at)
  }
  const ranges: VfxRecipe['ranges'] = {}
  for (const [k, vs] of Object.entries(samples)) ranges[k] = { p10: r(wquantile(vs, 0.1)), median: r(wquantile(vs, 0.5)), p90: r(wquantile(vs, 0.9)) }
  const layerTotal = [...roles.values()].reduce((a, b) => a + b, 0) || 1
  const sortedCounts = [...emitterCounts].sort((a, b) => a - b)
  const avoid = tagged
    .filter((e) => e.quality === 'avoid' || e.rating === 'down')
    .map((e) => `${e.name}: ${e.description}`.slice(0, 160))
    .slice(0, 6)
  const notes: string[] = []
  const swell = shapes['swell-decay'] ?? 0
  if (emitterTotal && swell / emitterTotal >= 0.3) notes.push(`${Math.round((swell / emitterTotal) * 100)}% of emitters use a quick swell-then-decay Size curve (peak in the first 40% of life).`)
  const fadeOut = (shapes['transparency:grow'] ?? 0) + (shapes['transparency:pulse'] ?? 0) + (shapes['transparency:swell-decay'] ?? 0)
  if (emitterTotal && fadeOut / emitterTotal >= 0.5) notes.push('Transparency rises toward 1 by the end of life (fade out) on most emitters; avoid popping.')
  const le = ranges.LightEmission
  if (le && le.median >= 0.6) notes.push(`Mostly additive (LightEmission median ${le.median}); keep smoke layers near 0 so they darken.`)
  if (good.length >= 2 && sortedCounts.length) notes.push(`Typically ${quantile(sortedCounts, 0.5)} emitters (range ${sortedCounts[0]}-${sortedCounts[sortedCounts.length - 1]}).`)
  if (burstEffects / good.length >= 0.5) notes.push('Burst driven: emitters disabled, played with Emit(n) at cue times.')
  // Video references with this tag feed only their measured timing and palette (marked as such).
  const video = videoHints(tag, entries)
  if (video) notes.push(videoHintNote(video, 'vfx'))
  return {
    tag,
    samples: good.length,
    emitters: r(quantile(sortedCounts, 0.5)),
    layers: [...roles.entries()].sort((a, b) => b[1] - a[1]).map(([role, n]) => ({ role, share: r(n / layerTotal) })),
    ranges,
    sizeCurves: Object.fromEntries(Object.entries(shapes).filter(([k]) => !k.startsWith('transparency:'))),
    flipbookShare: emitterTotal ? r(flip / emitterTotal) : 0,
    burstShare: r(burstEffects / good.length),
    colors: [...colorCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([c]) => c),
    avoid,
    notes,
    ...(video ? { video } : {})
  }
}

export function extractRecipes(entries: VfxEntry[], minSamples = 1, opts: { boost?: (e: VfxEntry) => number } = {}): VfxRecipe[] {
  return recipeTags(entries)
    .map((t) => extractRecipe(t, entries, opts))
    .filter((x): x is VfxRecipe => !!x && x.samples >= minSamples)
}

// The memory skill for a recipe (agent/memory skill: name, when-to-use description, steps body).
export function recipeSkill(recipe: VfxRecipe, examples: string[] = []): { name: string; description: string; body: string } {
  const range = (k: string) => {
    const v = recipe.ranges[k]
    return v ? `${v.p10}-${v.p90} (median ${v.median})` : null
  }
  const roleLines = recipe.layers.map((l) => {
    const role = l.role
    const bits = [
      range(`${role}.Lifetime`) && `Lifetime ${range(`${role}.Lifetime`)}`,
      range(`${role}.Speed`) && `Speed ${range(`${role}.Speed`)}`,
      range(`${role}.SizePeak`) && `Size peak ${range(`${role}.SizePeak`)}`,
      range(`${role}.LightEmission`) && `LightEmission ${range(`${role}.LightEmission`)}`,
      range(`${role}.Rate`) && `Rate ${range(`${role}.Rate`)}`,
      range(`${role}.Burst`) && `Emit ${range(`${role}.Burst`)}`,
      range(`${role}.Drag`) && `Drag ${range(`${role}.Drag`)}`,
      range(`${role}.Spread`) && `Spread ${range(`${role}.Spread`)}`
    ].filter(Boolean)
    return `- **${role}** (${Math.round(l.share * 100)}% of layers)${bits.length ? `: ${bits.join('; ')}` : ''}`
  })
  const body = [
    `Learned from ${recipe.samples} reference effect${recipe.samples === 1 ? '' : 's'} tagged "${recipe.tag}" in the VFX library.`,
    '',
    '## Layers',
    ...roleLines,
    '',
    '## Patterns',
    ...recipe.notes.map((n) => `- ${n}`),
    `- Size curves: ${Object.entries(recipe.sizeCurves).map(([k, v]) => `${k} x${v}`).join(', ') || 'n/a'}`,
    `- Flipbooks on ${Math.round(recipe.flipbookShare * 100)}% of emitters; burst-driven in ${Math.round(recipe.burstShare * 100)}% of effects.`,
    recipe.ranges['burst.at'] ? `- Burst times (s): ${range('burst.at')}` : '',
    recipe.colors.length ? `- Palette: ${recipe.colors.join(', ')}` : '',
    '',
    ...(recipe.avoid.length ? ['## Avoid (disliked results)', ...recipe.avoid.map((a) => `- ${a}`), ''] : []),
    ...(examples.length ? ['## Closest references', ...examples.map((e) => `- ${e}`), ''] : []),
    '## Steps',
    `1. vfx_search_library {"query":"${recipe.tag}"} and read the closest references' layers.`,
    '2. vfx_create a spec with one layer per role above, numbers inside the ranges; additive core/glow/sparks, near-0 LightEmission smoke.',
    '3. vfx_render, compare with the references, then vfx_refine (or adjust and re-create) until the critique passes.',
    '4. For a multi-stage effect (anticipation, charge, release, impact, dissipate) use vfx_compose / vfx_set_script with the kit (vfx_kit), using these ranges for the layers.'
  ]
    .filter((l, i, a) => l !== '' || a[i - 1] !== '')
    .join('\n')
  const description = `Roblox ${recipe.tag} VFX: layer roles and parameter ranges from ${recipe.samples} reference${recipe.samples === 1 ? '' : 's'}; use when making a ${recipe.tag} effect`
  return { name: `${RECIPE_PREFIX}${recipe.tag.replace(/[^a-z0-9-]+/gi, '-').toLowerCase()}`, description: description.slice(0, 200), body: body.slice(0, 7900) }
}

// Built-in scripted recipes (multi-stage timeline examples: Hollow Purple, charge-and-slash,
// ground slam) live in examples.ts; re-exported here so recipe consumers find them in one place.
export { VFX_EXAMPLES, findExample, type VfxExample } from './examples.ts'
