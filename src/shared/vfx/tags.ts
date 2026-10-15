// VFX tags in groups: KIND (what the effect is), ELEMENT (what it is made of), TIMING (how it plays)
// and CUSTOM (the user's own, e.g. "ball trail", "goal" for a football game).
//
// Auto-tags need evidence, scored 0..1 per tag:
//   - the effect's own name / file name (strong) and its layer names (weak), split into words
//     (CamelCase too) so "ShockWave" never reads as water or "Sparks" as electric;
//   - layer roles (analyze.ts layerRoles: slash streaks, expanding rings, cracks, flashes, ...);
//   - dominant colours (colorWeights) together with a matching structure: water = blue / cyan AND
//     droplet / splash / ripple layers; electric = thin bright beams or jagged layers in cyan /
//     white / purple; fire = orange / red / yellow with flame flipbooks or rising cores; wind = pale
//     streaks; colour alone never makes an element.
// At most 2 kinds, 1-2 elements and 1 timing are kept, and at most AUTO_TAG_MAX overall, ranked by
// confidence. Groups the user edited are kept as the user left them on re-tag.
//
// Entries store the flat `tags` (search, older readers) and `tagGroups`; older entries with flat tags
// only are read through tagGroupsOf (legacy tags mapped onto the groups, the rest kept as custom).

import { allNodes, colorWeights, layerRoles, type TextureKindOf } from './analyze.ts'
import { prop } from './schema.ts'
import { curveShape } from './sequence.ts'
import type { NumberRange, NumberSequence, VfxEffect, VfxNode } from './types.ts'

export type TagGroup = 'kind' | 'element' | 'timing' | 'custom'
export type TagGroups = Record<TagGroup, string[]>
export const TAG_GROUP_ORDER: TagGroup[] = ['kind', 'element', 'timing', 'custom']
export const TAG_GROUP_LABEL: Record<TagGroup, string> = { kind: 'kind', element: 'element', timing: 'timing', custom: 'custom' }

export const KIND_TAGS = ['slash', 'impact', 'dash', 'aura', 'projectile', 'beam', 'explosion', 'charge', 'shockwave', 'trail', 'burst', 'ground-crack'] as const
export const ELEMENT_TAGS = ['fire', 'water', 'electric', 'wind', 'ice', 'dark', 'light', 'earth', 'energy'] as const
export const TIMING_TAGS = ['burst', 'loop', 'sustained', 'sequence'] as const
export const AUTO_TAG_MAX = 4

// Older tags -> their group (and name in it). Colour tags from the old tagger are dropped; anything
// else unknown is kept as a custom tag.
const LEGACY: Record<string, [TagGroup, string] | null> = {
  lightning: ['element', 'electric'],
  thunder: ['element', 'electric'],
  holy: ['element', 'light'],
  magic: ['element', 'energy'],
  arcane: ['element', 'energy'],
  startup: ['kind', 'charge'],
  'ground crack': ['kind', 'ground-crack'],
  crack: ['kind', 'ground-crack'],
  teleport: ['kind', 'dash'],
  ambient: ['timing', 'loop'],
  red: null,
  orange: null,
  yellow: null,
  green: null,
  cyan: null,
  blue: null,
  purple: null,
  pink: null,
  white: null,
  grey: null,
  black: null
}

export function emptyGroups(): TagGroups {
  return { kind: [], element: [], timing: [], custom: [] }
}

// One tag -> its group. Ambiguous "burst" is a KIND unless asked for timing.
export function classifyTag(raw: string): [TagGroup, string] | null {
  const t = raw.trim().toLowerCase()
  if (!t) return null
  if (t in LEGACY) return LEGACY[t]
  if ((KIND_TAGS as readonly string[]).includes(t)) return ['kind', t]
  if ((ELEMENT_TAGS as readonly string[]).includes(t)) return ['element', t]
  if ((TIMING_TAGS as readonly string[]).includes(t)) return ['timing', t]
  return ['custom', t.slice(0, 40)]
}

export function groupsFromTags(tags: string[]): TagGroups {
  const g = emptyGroups()
  for (const raw of tags) {
    const c = classifyTag(String(raw))
    if (c && !g[c[0]].includes(c[1])) g[c[0]].push(c[1])
  }
  return g
}

export function normalizeGroups(input: Partial<Record<TagGroup, unknown>> | null | undefined): TagGroups {
  const g = emptyGroups()
  for (const k of TAG_GROUP_ORDER) {
    const v = input?.[k]
    if (!Array.isArray(v)) continue
    for (const raw of v) {
      const t = String(raw).trim().toLowerCase().slice(0, 40)
      if (t && !g[k].includes(t)) g[k].push(t)
    }
  }
  return g
}

export function flatTags(g: TagGroups): string[] {
  return [...new Set(TAG_GROUP_ORDER.flatMap((k) => g[k]))].slice(0, 16)
}

// The groups of an entry (stored, or read from the flat tags of an older entry).
export function tagGroupsOf(e: { tags: string[]; tagGroups?: Partial<TagGroups> }): TagGroups {
  return e.tagGroups ? normalizeGroups(e.tagGroups) : groupsFromTags(e.tags ?? [])
}

// ------------------------------------------------------------------ evidence

export interface TagGuess {
  group: Exclude<TagGroup, 'custom'>
  tag: string
  confidence: number
  why: string
}

// "AuraImpact_2" -> ["aura", "impact", "2"]
export function words(text: string): string[] {
  return text
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

export const KIND_WORDS: Record<string, RegExp> = {
  slash: /^(slash\w*|swing|cut|sword|blade|katana|swipe|crescent|slice)$/,
  impact: /^(impact\w*|hit|punch|strike|smash|slam|landing|stomp)$/,
  dash: /^(dash\w*|blink|rush|lunge|teleport)$/,
  aura: /^(aura\w*|ki|chi|powerup|buff|idle|ambient|passive)$/,
  projectile: /^(projectile|bullet|fireball|orb|missile|shot|ball|bomb|arrow)$/,
  beam: /^(beam|laser|ray|kamehameha)$/,
  explosion: /^(explo\w*|blast|boom|nuke|detonat\w*|kaboom)$/,
  charge: /^(charge|charging|startup|windup|channel\w*|gather|activate\w*|activation)$/,
  shockwave: /^(shockwave|ring|ripple)$/,
  trail: /^(trail\w*)$/,
  burst: /^(burst|pop)$/,
  'ground-crack': /^(crack\w*|fissure|crater|quake|ground)$/
}
export const ELEMENT_WORDS: Record<string, RegExp> = {
  fire: /^(fire\w*|flame\w*|burn\w*|blaze|inferno|ember\w*|magma|lava|sun|solar|heat|hot|pyro)$/,
  water: /^(water|splash\w*|aqua|bubble\w*|rain|droplet\w*|drop|drops|ripple\w*|tide|ocean|hydro)$/,
  electric: /^(electric\w*|lightning|thunder|bolt|zap|volt|plasma)$/,
  wind: /^(wind|tornado|gust\w*|air|whirl\w*|cyclone|breeze|swirl\w*)$/,
  ice: /^(ice|icy|frost\w*|freez\w*|frozen|snow\w*|cryo|glacier|crystal\w*)$/,
  dark: /^(dark\w*|shadow\w*|void|abyss|curse\w*|demon\w*|evil|death)$/,
  light: /^(holy|divine|angel\w*|radiant|heal\w*|sacred|celestial)$/,
  earth: /^(earth|rock\w*|stone\w*|dirt|sand|mud|boulder\w*|rubble)$/,
  energy: /^(energy|magic\w*|arcane|mana|spell|cosmic|power)$/
}
// Layer words that are evidence for an element's structure.
const WATER_LAYER = /^(drop\w*|droplet\w*|splash\w*|ripple\w*|bubble\w*|water|foam|spray)$/
// (not "spark": ember sparks are in every kind of effect)
const ELECTRIC_LAYER = /^(lightning|bolt\w*|arc|arcs|zap\w*|electric\w*|static|volt)$/
const WIND_LAYER = /^(wind|gust\w*|swirl\w*|air|streak\w*|whirl\w*)$/
const FIRE_LAYER = /^(fire\w*|flame\w*|ember\w*|smoke|burn\w*)$/
const ICE_LAYER = /^(ice|shard\w*|crystal\w*|frost\w*|snow\w*)$/
const EARTH_LAYER = /^(rock\w*|debris|rubble|dirt|dust|stone\w*|chunk\w*)$/

function matchWords(ws: string[], re: RegExp): boolean {
  return ws.some((w) => re.test(w))
}

function timingOf(effect: VfxEffect, emitters: VfxNode[]): TagGuess {
  if (effect.script || (effect.stages?.length ?? 0) > 1) return { group: 'timing', tag: 'sequence', confidence: 0.9, why: 'timeline script / stages' }
  const emits = effect.cues.filter((c) => c.action === 'emit')
  const disables = effect.cues.filter((c) => c.action === 'disable')
  const enables = effect.cues.filter((c) => c.action === 'enable')
  const continuous = emitters.filter((e) => prop<boolean>(e, 'Enabled') !== false && prop<number>(e, 'Rate') > 0)
  if (enables.length && disables.length) {
    const on = Math.max(...disables.map((c) => c.at)) - Math.min(...enables.map((c) => c.at))
    if (on >= 0.8) return { group: 'timing', tag: 'sustained', confidence: 0.75, why: `emitters on for ${on.toFixed(1)} s` }
  }
  if (continuous.length && !disables.length && continuous.length >= emitters.length / 2) return { group: 'timing', tag: 'loop', confidence: emits.length ? 0.6 : 0.8, why: 'emitters stay on' }
  if (continuous.length && disables.length) return { group: 'timing', tag: 'sustained', confidence: 0.65, why: 'emitters switched off later' }
  return { group: 'timing', tag: 'burst', confidence: emits.length || emitters.length ? 0.8 : 0.5, why: emits.length ? 'emit bursts' : 'one-shot' }
}

// Every tag with evidence, highest confidence first (not capped).
export function tagEvidence(effect: VfxEffect, hint = '', kindOf?: TextureKindOf): TagGuess[] {
  const nodes = allNodes(effect.roots)
  const strong = words(`${effect.name} ${hint}`)
  const weak = words(nodes.map((n) => n.name).join(' '))
  const emitters = nodes.filter((n) => n.className === 'ParticleEmitter')
  const beams = nodes.filter((n) => n.className === 'Beam')
  const trails = nodes.filter((n) => n.className === 'Trail')
  const roles = layerRoles(effect, kindOf)
  const roleCount = (r: string) => roles.filter((x) => x.role === r).length
  const texKinds = new Set(nodes.map((n) => (typeof n.props.Texture === 'string' && kindOf ? kindOf(n.props.Texture) : null)).filter((k): k is string => !!k))
  const colors = colorWeights(effect)
  const c = (...names: string[]) => names.reduce((s, n) => s + (colors.get(n) ?? 0), 0)
  const warm = c('red', 'orange', 'yellow')
  const cool = c('cyan', 'blue')
  const pale = c('white', 'grey')
  const meanLE = emitters.length ? emitters.reduce((s, e) => s + prop<number>(e, 'LightEmission'), 0) / emitters.length : 0
  const timing = timingOf(effect, emitters)

  const score = new Map<string, { group: TagGuess['group']; s: number; why: string[] }>()
  const add = (group: TagGuess['group'], tag: string, s: number, why: string) => {
    const e = score.get(`${group}:${tag}`) ?? { group, s: 0, why: [] }
    e.s += s
    e.why.push(why)
    score.set(`${group}:${tag}`, e)
  }

  // ---- kind
  for (const [tag, re] of Object.entries(KIND_WORDS)) {
    if (matchWords(strong, re)) add('kind', tag, 0.9, 'name')
    else if (matchWords(weak, re)) add('kind', tag, 0.3, 'layer names')
  }
  if (roleCount('slash')) add('kind', 'slash', 0.55 + Math.min(0.15, 0.05 * roleCount('slash')), 'slash streak layers')
  const rings = roles.filter((r) => r.role === 'ring')
  if (rings.length) {
    const grows = rings.some((r) => {
      const n = nodes.find((x) => x.id === r.id)
      return !!n && n.className === 'ParticleEmitter' && ['grow', 'swell-decay'].includes(curveShape(prop<NumberSequence>(n, 'Size')))
    })
    add('kind', 'shockwave', grows ? 0.65 : 0.35, grows ? 'expanding ring' : 'ring layer')
  }
  if (roleCount('crack')) add('kind', 'ground-crack', 0.6, 'crack layers')
  if (trails.length) add('kind', 'trail', trails.length >= emitters.length ? 0.6 : 0.4, 'Trail')
  if (beams.length) add('kind', 'beam', beams.length >= emitters.length ? 0.6 : 0.35, 'Beam')
  const bursty = timing.tag === 'burst'
  const has = (r: string) => roleCount(r) > 0
  if (bursty && has('smoke') && (has('debris') || has('sparks')) && has('flash')) add('kind', 'explosion', 0.55, 'flash + smoke + debris burst')
  else if (bursty && (has('flash') || has('sparks')) && effect.duration <= 2) add('kind', 'impact', 0.5, 'short flash / sparks burst')
  if (timing.tag === 'loop' && emitters.length) add('kind', 'aura', 0.5 + (has('glow') ? 0.1 : 0), 'emitters stay on')
  if (effect.motion === 'dash') add('kind', 'dash', 0.5, 'dash motion')
  if (emitters.some((e) => {
    const sp = prop<NumberRange>(e, 'Speed')
    return sp[1] < 0 || (sp[0] < 0 && Math.abs(sp[0]) > Math.abs(sp[1]))
  }))
    add('kind', 'charge', 0.45, 'particles pulled inward')

  // ---- element
  for (const [tag, re] of Object.entries(ELEMENT_WORDS)) {
    if (matchWords(strong, re)) add('element', tag, 0.9, 'name')
  }
  const flipbookWarm = emitters.some((e) => prop<string>(e, 'FlipbookLayout') !== 'None' && prop<string>(e, 'FlipbookLayout') !== undefined && warm >= 0.4)
  const rising = emitters.some((e) => (prop<number[]>(e, 'Acceleration') ?? [0, 0, 0])[1] > 0)
  if (warm >= 0.5) {
    let s = 0.35
    const why = ['orange / red / yellow']
    if (flipbookWarm) (s += 0.3), why.push('flame flipbook')
    if (texKinds.has('fire') || texKinds.has('flame') || matchWords(weak, FIRE_LAYER)) (s += 0.3), why.push('flame layers')
    if (rising && (has('core') || has('smoke'))) (s += 0.15), why.push('rising core')
    add('element', 'fire', s, why.join(', '))
  }
  if (cool >= 0.4 && (matchWords(weak, WATER_LAYER) || texKinds.has('water') || texKinds.has('splash'))) add('element', 'water', 0.35 + 0.35, 'blue / cyan + droplet / splash layers')
  {
    const thinBright = beams.some((b) => Math.max(prop<number>(b, 'Width0'), prop<number>(b, 'Width1')) <= 1.2 && (prop<number>(b, 'LightEmission') >= 0.5 || prop<number>(b, 'Brightness') >= 2))
    const jagged = matchWords(weak, ELECTRIC_LAYER) || texKinds.has('lightning') || texKinds.has('electric')
    const tint = cool + c('purple') + pale
    let s = 0
    const why: string[] = []
    if (thinBright) (s += 0.3), why.push('thin bright beams')
    if (jagged) (s += 0.4), why.push('jagged / arc layers')
    if (s > 0 && tint >= 0.5) (s += 0.15), why.push('cyan / white / purple')
    if (s) add('element', 'electric', s, why.join(', '))
  }
  if (pale >= 0.6) {
    const streaks = trails.length > 0 || emitters.some((e) => prop<string>(e, 'Orientation') === 'VelocityParallel' || Math.max(0, ...(prop<NumberSequence>(e, 'Squash') ?? []).map((k) => Math.abs(k.v))) >= 0.5)
    const named = matchWords(weak, WIND_LAYER)
    if (streaks || named) add('element', 'wind', 0.3 + (streaks ? 0.25 : 0) + (named ? 0.35 : 0) + (meanLE < 0.5 ? 0.05 : 0), 'pale streaks')
  }
  if (cool + pale >= 0.6 && (matchWords(weak, ICE_LAYER) || texKinds.has('ice'))) add('element', 'ice', 0.65, 'cyan / white + shard / crystal layers')
  if (c('black', 'purple') >= 0.5 && meanLE < 0.3 && emitters.length) add('element', 'dark', 0.6, 'dark, non-glowing')
  if (c('yellow', 'white') >= 0.6 && meanLE >= 0.7 && has('glow') && !warm) add('element', 'light', 0.5, 'bright yellow-white glow')
  if (has('debris') && (matchWords(weak, EARTH_LAYER) || has('crack'))) add('element', 'earth', 0.6, 'rock / debris layers')

  const out: TagGuess[] = [...score.entries()].map(([k, v]) => ({ group: v.group, tag: k.slice(k.indexOf(':') + 1), confidence: Math.min(1, Math.round(v.s * 100) / 100), why: v.why.join('; ') }))
  // Saturated glowing colours with no element evidence: neutral energy.
  if (!out.some((g) => g.group === 'element' && g.confidence >= 0.6) && c('purple', 'pink', 'green', 'cyan', 'blue') >= 0.5 && meanLE >= 0.5) out.push({ group: 'element', tag: 'energy', confidence: 0.45, why: 'glowing saturated colours, no element evidence' })
  out.push(timing)
  return out.sort((a, b) => b.confidence - a.confidence)
}

// Kept auto-tags: kinds >= 0.5 (2nd only >= 0.6, max 2), elements >= 0.6 (2nd only >= 0.75, or the
// 0.45 energy fallback alone), one timing; then the AUTO_TAG_MAX best.
export function inferTags(effect: VfxEffect, hint = '', kindOf?: TextureKindOf): TagGuess[] {
  const all = tagEvidence(effect, hint, kindOf)
  const kinds = all.filter((g) => g.group === 'kind' && g.confidence >= 0.5)
  const elements = all.filter((g) => g.group === 'element' && g.confidence >= (g.tag === 'energy' ? 0.45 : 0.6))
  const timing = all.find((g) => g.group === 'timing')
  const kept: TagGuess[] = [...kinds.slice(0, 1), ...kinds.slice(1, 2).filter((g) => g.confidence >= 0.6), ...elements.slice(0, 1), ...elements.slice(1, 2).filter((g) => g.confidence >= 0.75), ...(timing ? [timing] : [])]
  // A kind tag "burst" plus timing "burst" says the same thing twice.
  const dedup = kept.filter((g, i) => !(g.group === 'timing' && g.tag === 'burst' && kept.some((x, j) => j !== i && x.group === 'kind' && x.tag === 'burst')))
  return dedup.sort((a, b) => b.confidence - a.confidence).slice(0, AUTO_TAG_MAX)
}

export function autoTagGroups(effect: VfxEffect, hint = '', kindOf?: TextureKindOf): { groups: TagGroups; auto: TagGuess[] } {
  const auto = inferTags(effect, hint, kindOf)
  const groups = emptyGroups()
  for (const g of auto) if (!groups[g.group].includes(g.tag)) groups[g.group].push(g.tag)
  return { groups, auto }
}

// Flat auto-tags (kind / element / timing words), for callers that keep a flat list.
export function autoTags(effect: VfxEffect, hint = '', kindOf?: TextureKindOf): string[] {
  return flatTags(autoTagGroups(effect, hint, kindOf).groups)
}

// Re-tag: auto groups replace the old auto groups; groups the user edited, and custom tags, stay.
export function retagGroups(current: TagGroups, auto: TagGroups, userGroups: TagGroup[] = []): TagGroups {
  const out = emptyGroups()
  for (const k of TAG_GROUP_ORDER) out[k] = k === 'custom' || userGroups.includes(k) ? [...current[k]] : [...auto[k]]
  return out
}

// Which groups changed between two tag sets (user edits).
export function changedGroups(before: TagGroups, after: TagGroups): TagGroup[] {
  return TAG_GROUP_ORDER.filter((k) => before[k].slice().sort().join('|') !== after[k].slice().sort().join('|'))
}

// Recipe keys: every KIND, and KIND+ELEMENT pairs ("slash+fire").
export function recipeKeys(e: { tags: string[]; tagGroups?: Partial<TagGroups> }): string[] {
  const g = tagGroupsOf(e)
  return [...g.kind, ...g.kind.flatMap((k) => g.element.map((el) => `${k}+${el}`))]
}

// A request ("purple sword slash with sparks") -> tag groups, with the same word lists the auto-tagger
// reads names with (sword -> slash, fireball -> projectile + fire, lightning -> electric), plus tags
// named directly. Timing: "loop" / "aura" style words -> loop, sequences stay with the caller.
export function requestTagGroups(text: string): TagGroups {
  const ws = words(text)
  const g = emptyGroups()
  const add = (k: TagGroup, t: string) => {
    if (!g[k].includes(t)) g[k].push(t)
  }
  for (const w of ws) {
    for (const [tag, re] of Object.entries(KIND_WORDS)) if (re.test(w)) add('kind', tag)
    for (const [tag, re] of Object.entries(ELEMENT_WORDS)) if (re.test(w)) add('element', tag)
    const c = classifyTag(w)
    if (c && c[0] !== 'custom') add(c[0], c[1])
  }
  // "fireball": a projectile made of fire.
  if (ws.some((w) => /^fireball/.test(w))) add('element', 'fire')
  if (ws.some((w) => /^(loop\w*|idle|ambient|passive|constant|looping)$/.test(w))) add('timing', 'loop')
  return g
}
