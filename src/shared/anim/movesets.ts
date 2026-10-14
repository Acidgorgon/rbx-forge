// Move sets: which move types (tags) the Animation Lab sorts a library into. Combat is the default and
// is exactly the original tag list (MOVE_TAGS / CORE_TAGS in style.ts); Football and Movement & emotes
// are built in; a project can add its own move types to the active set. The active set drives the
// auto-tagger, coverage ("feed it next"), reference picking, the compose / critic prompts and the
// built-in draft (each tag names the closest archetype script). Pure code: no model, no electron.
//
// Settings live with the rig in .forge/anim/settings.json under "moveSet" (see AnimService).

import type { AnimClip, AnimEntry } from './model.ts'
import type { Archetype } from './draft.ts'
import { autoTags, CORE_TAGS, MOVE_TAGS } from './style.ts'
import { measureClip } from './measure.ts'

export interface MoveTagDef {
  tag: string
  // One line for the auto-tagger, the drafter and the critic.
  description: string
  // Regex source (case-insensitive) matched against names, notes and requests.
  pattern: string
  // A regex source that vetoes the tag (e.g. "diving header" is not a keeper save).
  not?: string
  // Coverage wording ("Feed it next: shots, headers").
  label: string
  // The built-in draft used for this tag when no model is set up.
  archetype: Archetype
  custom?: boolean
}

export interface MoveSetDef {
  id: string
  name: string
  description: string
  tags: MoveTagDef[]
  // The move types coverage expects (thin when fewer than three usable clips).
  core: string[]
  // Example requests under the Animate box.
  suggestions: string[]
  placeholder: string
}

export interface CustomMoveTag {
  tag: string
  description?: string
  // Extra words that suggest the tag (default: the tag itself).
  words?: string[]
  // Closest built-in tag of the set (its archetype drafts this move without a model).
  like?: string
}

export interface MoveSetSettings {
  set: string
  // Custom move types per set id.
  custom: Record<string, CustomMoveTag[]>
}

// What the renderer gets (serialisable).
export interface ResolvedMoveSet extends MoveSetDef {
  custom: CustomMoveTag[]
}

export const DEFAULT_MOVE_SET = 'combat'

const COMBAT_DESC: Record<string, [string, string, Archetype]> = {
  attack: ['Melee strike: punch, slash, swing or combo hit.', 'attacks', 'punch'],
  kick: ['A kick: front, roundhouse, sweep or stomp.', 'kicks', 'kick'],
  cast: ['Ability or spell: charge, channel and release a projectile or blast.', 'casts', 'cast'],
  sign: ['Hand sign or seal before an ability.', 'signs', 'sign_push'],
  dash: ['Dash, dodge, roll or evade: a fast burst of travel.', 'dashes', 'dash'],
  idle: ['Looping stance or breathing idle.', 'idles', 'idle'],
  hit: ['Hit reaction: stagger, flinch, knockback.', 'hit reactions', 'hit'],
  block: ['Block, parry or guard.', 'blocks', 'block'],
  jump: ['Jump or leap.', 'jumps', 'jump'],
  land: ['Landing or impact absorb.', 'landings', 'jump'],
  walk: ['Walk cycle.', 'walks', 'idle'],
  run: ['Run or sprint cycle.', 'runs', 'dash'],
  emote: ['Emote: dance, wave, taunt, bow or cheer.', 'emotes', 'celebrate']
}

const combat: MoveSetDef = {
  id: 'combat',
  name: 'Combat',
  description: 'Fighting games and abilities: attacks, casts, dashes, hit reactions.',
  tags: Object.entries(MOVE_TAGS).map(([tag, re]) => {
    const [description, label, archetype] = COMBAT_DESC[tag] ?? [`${tag} moves.`, `${tag} clips`, 'punch' as Archetype]
    return { tag, description, pattern: re.source, label, archetype }
  }),
  core: [...CORE_TAGS],
  suggestions: ['heavy overhead punch', 'quick jab', 'roundhouse kick', 'dodge roll back', 'fireball cast', 'stagger from a hit', 'combat idle'],
  placeholder: 'a heavy overhead punch with a long windup'
}

const T = (tag: string, description: string, pattern: string, label: string, archetype: Archetype, not?: string): MoveTagDef => ({ tag, description, pattern, label, archetype, ...(not ? { not } : {}) })

const football: MoveSetDef = {
  id: 'football',
  name: 'Football',
  description: 'Football (soccer): shots, passes, headers, skills, celebrations, tackles and keeper saves.',
  tags: [
    T('shot', 'Shot on goal: plant foot, big backswing, strike through the ball (power shot, volley, chip, curler, free kick, penalty).', String.raw`\b(shot|shots|shoot\w*|strike|striker|volley\w*|bicycle|overhead\s?kick|scissor\w*|chip|finesse|curl\w*|penalty|pk|free\s?kick|power\s?shot|knuckle\w*|rabona|toe\s?poke|kick\w*|finish\w*)\b`, 'shots', 'kick'),
    T('pass', 'Pass or cross: shorter backswing than a shot, side-foot or laces through the ball, follow-through toward the target.', String.raw`\b(pass\w*|cross|crosses|crossing|through\s?ball|lob\w*|long\s?ball|assist|back\s?heel\w*|one\s?two|clearance|clear)\b`, 'passes', 'kick'),
    T('header', 'Header: jump (or lean), arch back, then snap the neck and torso forward to meet the ball with the forehead.', String.raw`\b(head\w*|nod)\b`, 'headers', 'header', String.raw`\b(head\s?(?:shot|stamp|lock)|headless|ahead)\b`),
    T('dribble', 'Dribble or skill move: small fast touches, feints, step-overs, flicks, juggling.', String.raw`\b(dribbl\w*|skill\w*|step\s?overs?|elastico|nutmeg|rainbow|roulette|cruyff|feint\w*|flick\w*|juggl\w*|keepy\s?uppy|trick\w*|scoop|croqueta|drag\s?back)\b`, 'dribbles and skills', 'dash'),
    T('celebration', 'Goal celebration: big readable pose, arms out or overhead, knee slide, jump, point to the crowd; often held.', String.raw`\b(celebrat\w*|celly|cele|siu+|knee\s?slide|backflip|dab|griddy|cheer\w*|emote|dance|fist\s?pump|calma|shush|hype|taunt|victory|winner)\b`, 'celebrations', 'celebrate'),
    T('tackle', 'Tackle: slide or standing tackle, low lunge with the leg reaching for the ball.', String.raw`\b(tackl\w*|slide|sliding|intercept\w*|shoulder\s?charge|challenge|foul|block)\b`, 'tackles', 'slide', String.raw`\bknee\s?slide\b`),
    T('save', 'Goalkeeper action: set stance, dive to one side with arms reaching, catch, parry or punch the ball away.', String.raw`\b(save|saves|saving|keeper\w*|goalie|goal\s?keeper\w*|gk|dive|diving|catch\w*|parry|punch\s?(?:out|away|clear)|claim|fingertip)\b`, 'keeper saves', 'save', String.raw`\b(diving\s?header|dive\s?header)\b`),
    T('trap', 'First touch: trap or control the ball with foot, thigh or chest, cushioning it down.', String.raw`\b(trap\w*|first\s?touch|control\w*|chest\s?(?:it|down)|receiv\w*|cushion\w*|settle)\b`, 'first touches', 'trap'),
    T('throw', 'Throw-in: ball behind the head with both hands, arch back, throw forward.', String.raw`\b(throw\s?in|throw\w*)\b`, 'throw-ins', 'cast'),
    T('idle', 'Looping stance between plays (ready stance, keeper ready, breathing).', String.raw`\b(idle|breath\w*|stance|ready|wait\w*|loop)\b`, 'idles', 'idle'),
    T('run', 'Run or sprint cycle (with or without the ball).', String.raw`\b(run\w*|sprint\w*|jog\w*|walk\w*)\b`, 'runs', 'dash')
  ],
  core: ['shot', 'pass', 'header', 'dribble', 'celebration', 'tackle', 'save', 'idle'],
  suggestions: ['power shot with a big backswing', 'diving header', 'step-over skill', 'knee slide celebration', 'slide tackle', 'keeper diving save', 'chest trap', 'long pass'],
  placeholder: 'a power shot with a big backswing and follow-through'
}

const movement: MoveSetDef = {
  id: 'movement',
  name: 'Movement & emotes',
  description: 'Locomotion and social: idles, walks, runs, jumps, climbs, emotes and dances.',
  tags: [
    T('idle', 'Looping idle or stance.', String.raw`\b(idle|breath\w*|stance|ready|wait\w*|loop)\b`, 'idles', 'idle'),
    T('walk', 'Walk cycle.', String.raw`\b(walk\w*|stroll\w*|sneak\w*|crouch\s?walk)\b`, 'walks', 'idle'),
    T('run', 'Run or sprint cycle.', String.raw`\b(run\w*|sprint\w*|jog\w*)\b`, 'runs', 'dash'),
    T('jump', 'Jump, leap or double jump.', String.raw`\b(jump\w*|leap\w*|hop\w*|vault\w*|air)\b`, 'jumps', 'jump'),
    T('land', 'Landing or fall recovery.', String.raw`\b(land\w*|fall\w*|impact)\b`, 'landings', 'jump'),
    T('dash', 'Dash, dodge or roll.', String.raw`\b(dash\w*|dodg\w*|roll\w*|slide|evade)\b`, 'dashes', 'dash'),
    T('climb', 'Climb or ledge grab.', String.raw`\b(climb\w*|ledge|hang\w*|mantle)\b`, 'climbs', 'jump'),
    T('swim', 'Swim cycle.', String.raw`\b(swim\w*|tread\w*|paddl\w*)\b`, 'swims', 'idle'),
    T('emote', 'Emote: wave, point, bow, cheer, taunt.', String.raw`\b(emote|wave|waving|point\w*|bow|cheer\w*|taunt|clap\w*|salute|shrug|laugh\w*|celebrat\w*)\b`, 'emotes', 'celebrate'),
    T('dance', 'Dance loop.', String.raw`\b(danc\w*|groove|griddy|floss|dab)\b`, 'dances', 'celebrate'),
    T('sit', 'Sit, lie down or rest.', String.raw`\b(sit\w*|seat\w*|lie|lying|sleep\w*|rest)\b`, 'sits', 'idle')
  ],
  core: ['idle', 'walk', 'run', 'jump', 'emote'],
  suggestions: ['relaxed idle', 'happy wave', 'running jump', 'ledge climb', 'victory dance', 'sit down'],
  placeholder: 'a happy wave with a little bounce'
}

export const MOVE_SETS: MoveSetDef[] = [combat, football, movement]

export function moveSetDef(id: string | null | undefined): MoveSetDef {
  return MOVE_SETS.find((s) => s.id === id) ?? combat
}

// ------------------------------------------------------------------ settings

export const cleanTag = (t: unknown) =>
  String(t ?? '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9 -]/g, '')
    .slice(0, 24)

export function normalizeMoveSetSettings(raw: unknown): MoveSetSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as { set?: unknown; custom?: unknown }
  const set = MOVE_SETS.some((s) => s.id === r.set) ? String(r.set) : DEFAULT_MOVE_SET
  const custom: Record<string, CustomMoveTag[]> = {}
  if (r.custom && typeof r.custom === 'object') {
    for (const [id, list] of Object.entries(r.custom as Record<string, unknown>)) {
      if (!MOVE_SETS.some((s) => s.id === id) || !Array.isArray(list)) continue
      const seen = new Set<string>()
      const out: CustomMoveTag[] = []
      for (const x of list) {
        const c = normalizeCustomTag(x)
        if (c && !seen.has(c.tag)) {
          seen.add(c.tag)
          out.push(c)
        }
      }
      if (out.length) custom[id] = out.slice(0, 32)
    }
  }
  return { set, custom }
}

export function normalizeCustomTag(raw: unknown): CustomMoveTag | null {
  const x = (raw && typeof raw === 'object' ? raw : { tag: raw }) as { tag?: unknown; description?: unknown; words?: unknown; like?: unknown }
  const tag = cleanTag(x.tag)
  if (!tag || tag === 'example' || tag === 'video') return null
  const words = Array.isArray(x.words) ? [...new Set(x.words.map((w) => String(w).toLowerCase().trim().replace(/[^a-z0-9 -]/g, '')).filter((w) => w.length > 1))].slice(0, 12) : []
  return {
    tag,
    ...(typeof x.description === 'string' && x.description.trim() ? { description: x.description.trim().slice(0, 200) } : {}),
    ...(words.length ? { words } : {}),
    ...(typeof x.like === 'string' && cleanTag(x.like) ? { like: cleanTag(x.like) } : {})
  }
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/[ -]+/g, '[\\s_-]?')

// The active set with the project's custom move types appended.
export function resolveMoveSet(settings: MoveSetSettings | null | undefined): ResolvedMoveSet {
  const s = normalizeMoveSetSettings(settings)
  const def = moveSetDef(s.set)
  const custom = s.custom[def.id] ?? []
  const tags = [...def.tags]
  for (const c of custom) {
    if (tags.some((t) => t.tag === c.tag)) continue
    const like = c.like ? def.tags.find((t) => t.tag === c.like) : undefined
    const words = [c.tag, ...(c.words ?? [])]
    tags.push({
      tag: c.tag,
      description: c.description ?? `${c.tag} (custom move type).`,
      pattern: `\\b(${words.map(escape).join('|')})\\w*\\b`,
      label: `${c.tag} clips`,
      archetype: like?.archetype ?? def.tags.find((t) => new RegExp(t.pattern, 'i').test(words.join(' ')))?.archetype ?? 'punch',
      custom: true
    })
  }
  return { ...def, tags, core: [...def.core, ...custom.map((c) => c.tag).filter((t) => !def.core.includes(t))], custom }
}

// Every tag any built-in set (or a custom type of any set) knows: style profiles are kept for all of
// them, so switching sets never drops a learned profile.
export function allKnownTags(settings?: MoveSetSettings | null): string[] {
  const s = normalizeMoveSetSettings(settings)
  const out = new Set<string>()
  for (const d of MOVE_SETS) for (const t of d.tags) out.add(t.tag)
  for (const list of Object.values(s.custom)) for (const c of list) out.add(c.tag)
  return [...out]
}

// ------------------------------------------------------------------ tagging

const reCache = new Map<string, RegExp>()
const re = (src: string) => {
  let r = reCache.get(src)
  if (!r) {
    r = new RegExp(src, 'i')
    reCache.set(src, r)
  }
  return r
}

const words = (text: string) => String(text ?? '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ')

// Tags of the set suggested by a request, a file name or notes.
export function setPromptTags(text: string, set: MoveSetDef): string[] {
  const w = words(text)
  const out: string[] = []
  for (const t of set.tags) if (re(t.pattern).test(w) && !(t.not && re(t.not).test(w))) out.push(t.tag)
  return out
}

// Suggested tags for an imported clip under a set. Combat keeps the original auto-tagger (names plus
// motion guesses); other sets use the words first and only add motion guesses that are safe across
// sports (a calm loop is an idle; a looped clip that travels is a run).
export function setAutoTags(clip: AnimClip, fileName: string, set: MoveSetDef): string[] {
  if (set.id === 'combat' && !set.tags.some((t) => t.custom)) return autoTags(clip, fileName)
  if (set.id === 'combat') return [...new Set([...autoTags(clip, fileName), ...setPromptTags(`${clip.name} ${fileName}`, set).filter((t) => set.tags.find((x) => x.tag === t)?.custom)])].slice(0, 6)
  const tags = new Set(setPromptTags(`${clip.name} ${fileName}`, set))
  const has = (t: string) => set.tags.some((x) => x.tag === t)
  if (!tags.size) {
    const s = measureClip(clip)
    if (clip.looped && s.spread < 1.3 && s.duration >= 1.2 && has('idle')) tags.add('idle')
    else if (clip.looped && s.keyRate > 3 && has('run')) tags.add('run')
  }
  return [...tags].slice(0, 6)
}

// Built-in tags of other sets (and nothing of this one): re-tagging replaces these when it finds a
// tag of the active set for a clip (a celebration that was guessed "dash, attack" becomes "celebration").
export function foreignTags(set: MoveSetDef): Set<string> {
  const mine = new Set(set.tags.map((t) => t.tag))
  const out = new Set<string>()
  for (const d of MOVE_SETS) for (const t of d.tags) if (!mine.has(t.tag)) out.add(t.tag)
  return out
}

export interface RetagChange {
  id: string
  before: string[]
  after: string[]
}

// The words of an entry the heuristic reads: name, origin (file name or request) and notes.
export const entryText = (e: Pick<AnimEntry, 'name' | 'origin' | 'notes'>) => `${e.name} ${e.origin ?? ''} ${e.notes ?? ''}`

// Merges new set tags into an entry's tags. With found tags, other sets' built-in tags are dropped
// (custom and unknown tags, "example" and "video" always stay); without, nothing changes.
export function mergeRetag(before: string[], found: string[], set: MoveSetDef): string[] {
  if (!found.length) return before
  const foreign = foreignTags(set)
  const kept = before.filter((t) => !foreign.has(t))
  return [...new Set([...kept, ...found])].slice(0, 16)
}

// Keyword re-tag (no model): name, origin and notes against the set's words, plus the safe motion
// guesses. Returns only the entries whose tags change.
export function heuristicRetag(entries: AnimEntry[], set: MoveSetDef): RetagChange[] {
  const out: RetagChange[] = []
  for (const e of entries) {
    let found = setPromptTags(entryText(e), set)
    if (!found.length && e.kind !== 'media' && e.clip) found = setAutoTags(e.clip, '', set).filter((t) => !e.tags.includes(t))
    const after = mergeRetag(e.tags, found, set)
    if (after.join('|') !== e.tags.join('|')) out.push({ id: e.id, before: e.tags, after })
  }
  return out
}

// "shot: ...\npass: ..." for the tagger, the drafter and the critic.
export function moveSetGuide(set: MoveSetDef, only?: string[]): string {
  const tags = only?.length ? set.tags.filter((t) => only.includes(t.tag)) : set.tags
  return tags.map((t) => `- ${t.tag}: ${t.description}`).join('\n')
}

// The archetype the built-in draft uses for a request under a set (null: no tag matched).
export function setArchetype(text: string, set: MoveSetDef): Archetype | null {
  const tags = setPromptTags(text, set)
  // Specific moves win over the catch-alls (a "header goal celebration" is a celebration;
  // a "diving save" is a save, not a run).
  const order = ['celebration', 'emote', 'dance', 'save', 'header', 'tackle', 'trap', 'throw', 'pass', 'shot', 'dribble']
  const first = order.find((t) => tags.includes(t)) ?? tags[0]
  return first ? set.tags.find((t) => t.tag === first)!.archetype : null
}

// Coverage rows / thin categories for a set (see coverage() in style.ts).
export function coverageOptions(set: MoveSetDef): { core: string[]; known: string[] } {
  return { core: set.core, known: set.tags.map((t) => t.tag) }
}

// "shots, headers" for the "Feed it next" hint.
export function thinLabels(thin: string[], set: MoveSetDef): string[] {
  return thin.map((t) => set.tags.find((x) => x.tag === t)?.label ?? `${t} clips`)
}
