// Prompt assembly for the Thumbnail Lab (pure): the generation prompt (brief + style profile + base
// images from the real game), the refine prompt, the critic prompt / parser, and the no-copy guard.
//
// References teach style only. The guard works on three levels:
//  1. forbiddenTerms(): the reference names and game names the user gave are never sent; a brief that
//     names them has those words removed (and the UI says so).
//  2. The prompt itself tells the image model to make original artwork from the game's own
//     screenshots and not to reproduce characters, logos, title text or layouts of other games.
//  3. The critic is asked for "copyFlags" (anything that looks taken from another game or not from the
//     base screenshots); copyGuardFlags() adds any forbidden term it finds in the critique, and
//     flagged variations are capped on th-honest so pick-best never chooses them.

import { principleCriticBlock } from '../principles/select.ts'
import type { PrincipleCheck, PrincipleWeights } from '../principles/types.ts'
import { restatementBlock } from '../restate/prompt.ts'
import type { Restatement } from '../restate/types.ts'
import { renderSections, THUMB_RULES } from './builder.ts'
import type { PromptSection, ThumbRef } from './types.ts'

export const MAX_TEXT_WORDS = 3

// Words too generic to forbid even when they appear in a reference name ("simulator", "obby"...).
const GENERIC = new Set(
  'the a an of and or in on to for with my your our roblox game games thumbnail thumbnails image png jpg jpeg webp screenshot ref reference simulator sim obby tycoon rpg tower defense defence horror story escape tag survival battle royale fps update new free pet pets anime fighting race racing'.split(' ')
)

const norm = (s: string) => s.replace(/\.(png|jpe?g|webp|gif|bmp)$/i, '').replace(/[_-]+/g, ' ').replace(/\s+/g, ' ').trim()
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Names to keep out of prompts: each reference's game and name, as whole phrases, plus their
// distinctive single words (not generic genre words, at least 4 letters).
export function forbiddenTerms(refs: Pick<ThumbRef, 'name' | 'game'>[], extra: string[] = []): string[] {
  const out = new Set<string>()
  for (const raw of [...refs.flatMap((r) => [r.game ?? '', r.name]), ...extra]) {
    const phrase = norm(raw)
    if (!phrase || /^(image|ref|reference|thumbnail|screenshot)?\s*\d*$/i.test(phrase)) continue
    const words = phrase.split(' ').filter((w) => w.length >= 4 && !GENERIC.has(w.toLowerCase()) && !/^\d+$/.test(w))
    // A phrase counts when it has a distinctive word, or a number in a multi-word name ("Pet Simulator 99").
    if (words.length || (phrase.includes(' ') && /\d/.test(phrase))) out.add(phrase.toLowerCase())
    for (const w of words) out.add(w.toLowerCase())
  }
  // The project's own game name is allowed (it is the game being advertised).
  return [...out].sort((a, b) => b.length - a.length)
}

// Forbidden terms found in a text (word boundaries, case-insensitive).
export function copyGuard(text: string, forbidden: string[], allow: string[] = []): string[] {
  const hits: string[] = []
  const allowed = allow.map((a) => a.toLowerCase())
  for (const f of forbidden) {
    if (allowed.some((a) => a.includes(f))) continue
    if (new RegExp(`(^|[^a-z0-9])${esc(f)}([^a-z0-9]|$)`, 'i').test(text) && !hits.some((h) => h.includes(f))) hits.push(f)
  }
  return hits
}

// Removes forbidden terms from a brief.
export function scrubBrief(brief: string, forbidden: string[], allow: string[] = []): { text: string; removed: string[] } {
  const removed = copyGuard(brief, forbidden, allow)
  let text = brief
  for (const f of removed) text = text.replace(new RegExp(`(^|[^a-z0-9])${esc(f)}(?=[^a-z0-9]|$)`, 'gi'), '$1')
  text = text.replace(/\b(like|from|in the style of|similar to)\s+(?=[,.;]|$)/gi, '').replace(/\s{2,}/g, ' ').replace(/\s+([,.;])/g, '$1').replace(/[,;]+(?=[.,;]|$)/g, '').trim()
  return { text, removed }
}

export interface PromptInput {
  brief: string
  // The style profile's text (style.ts profileSummary), when one is picked.
  style?: string
  // How many base images from the game are attached (edit call), first.
  bases: number
  // How many style reference images follow them (style only).
  styleRefs?: number
  // The game being advertised (the project's name), allowed in the prompt.
  gameName?: string
  restatement?: Restatement | null
  // The user's taste, learned from ratings and CTR (taste.ts tasteLines).
  taste?: string[]
  // Prompt builder sections (builder.ts): when present they replace the brief / style / taste lines.
  // The honesty lines (bases, style references, copy rule) and the thumbnail rules always stay.
  sections?: PromptSection[]
}

export const COPY_RULE =
  'Original artwork only: do not reproduce characters, mascots, logos, title text, UI or signature layouts from any other game, brand or the style references. Style references only inform colour, lighting, framing and text treatment.'

export function generationPrompt(input: PromptInput, forbidden: string[] = []): { prompt: string; removed: string[] } {
  const { text: brief, removed } = scrubBrief(input.brief, forbidden, input.gameName ? [input.gameName] : [])
  const lines: string[] = []
  lines.push(`A Roblox experience thumbnail, 16:9 landscape, for ${input.gameName ? `the game "${input.gameName}"` : 'this game'}.`)
  if (input.bases > 0) {
    lines.push(
      `Build it from the attached ${input.bases === 1 ? 'screenshot' : `${input.bases} screenshots`} of the real game: keep its environment, avatars, items and art style recognisable, and dramatise them with camera framing, lighting, effects and composition. Do not add mechanics, UI, characters or places that are not in these screenshots.`
    )
  } else lines.push('Show only what the game really contains, as described below; do not invent mechanics, UI or characters that are not in it.')
  if (input.styleRefs) lines.push(`The last ${input.styleRefs === 1 ? 'attached image is a style reference' : `${input.styleRefs} attached images are style references`} from other games: borrow only colour, lighting, framing and text treatment from ${input.styleRefs === 1 ? 'it' : 'them'}; nothing in ${input.styleRefs === 1 ? 'it' : 'them'} (characters, logos, words, layout) may appear in the thumbnail.`)
  if (input.sections?.length) {
    const scrubbed = input.sections.map((s) => ({ ...s, text: scrubBrief(s.text, forbidden, input.gameName ? [input.gameName] : []).text }))
    for (const s of input.sections) for (const r of copyGuard(s.text, forbidden, input.gameName ? [input.gameName] : [])) if (!removed.includes(r)) removed.push(r)
    lines.push(renderSections(scrubbed))
    // The platform rules stay even when the user edited them away.
    if (!scrubbed.some((s) => s.key === 'roblox' && s.text.includes(THUMB_RULES))) lines.push(`Thumbnail rules: ${THUMB_RULES}`)
  } else {
    lines.push(`What it shows: ${brief || 'the most exciting moment of the game'}`)
    if (input.style) lines.push(`Style: ${input.style}.`)
    lines.push(`Thumbnail rules: ${THUMB_RULES}`)
    if (input.taste?.length) lines.push(`This creator's taste: ${input.taste.join('; ')}.`)
  }
  lines.push(COPY_RULE)
  const block = restatementBlock(input.restatement)
  if (block) lines.push(block)
  return { prompt: lines.join('\n'), removed }
}

// The refine edit: the chosen variation is the first image, the base screenshots follow.
export function refinePrompt(input: PromptInput & { changes: string[]; note?: string }, forbidden: string[] = []): { prompt: string; removed: string[] } {
  const base = generationPrompt(input, forbidden)
  const changes = [...(input.note?.trim() ? [input.note.trim()] : []), ...input.changes].slice(0, 6)
  const head = [
    'Revise the first attached image (a thumbnail draft). Keep its composition, subject and everything that works; change only this:',
    ...changes.map((c) => `- ${scrubBrief(c, forbidden).text}`),
    input.bases > 0 ? 'The other attached images are screenshots of the real game: stay true to them.' : ''
  ].filter(Boolean)
  return { prompt: `${head.join('\n')}\n\n${base.prompt}`, removed: base.removed }
}

// ---------------------------------------------------------------- critic

export const CRITIC_SYSTEM = [
  'You are a Roblox thumbnail art director judging a generated experience thumbnail for click-through on the discovery page, and its honesty.',
  'The first image is the thumbnail. Any further images are real screenshots of the game it must represent.',
  'Judge it as it looks at phone size as well as full size. Be concrete: what you see and where.',
  'Answer with JSON only.'
].join('\n')

export function criticPrompt(input: { brief: string; restatement?: Restatement | null; style?: string; bases: number; ids: string[]; measured: PrincipleCheck[]; weights?: PrincipleWeights; focus?: string[] }): string {
  const lines = [`Brief: ${input.brief}`]
  const block = restatementBlock(input.restatement)
  if (block) lines.push(block)
  if (input.style) lines.push(`Intended style: ${input.style}`)
  lines.push(input.bases ? `Honesty: compare with the ${input.bases} game screenshot(s); flag anything not in the game.` : 'Honesty: no game screenshots were attached; flag anything that looks invented or from another game.')
  lines.push(
    principleCriticBlock(input.ids, {
      weights: input.weights,
      measured: Object.fromEntries(input.measured.map((m) => [m.id, { score: m.score, note: m.note }])),
      focus: input.focus
    })
  )
  lines.push(
    `JSON: {"overall": 0-10, "summary": "<one line>", "textWords": <words of text you can read>, "changes": ["<most important change first>", ...up to 5], "copyFlags": ["<anything that looks like another game's character, logo, title text or UI, or is not in the game screenshots>"], "principles": [...]}`
  )
  return lines.join('\n\n')
}

export interface ParsedCritique {
  overall: number
  summary: string
  changes: string[]
  copyFlags: string[]
  textWords: number | null
  raw: Record<string, unknown>
}

export function parseCritique(raw: string): ParsedCritique | null {
  const text = String(raw ?? '').replace(/```(?:json)?/g, '')
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const overall = Number(j.overall)
  const list = (v: unknown, n: number) => (Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x : typeof x === 'object' && x ? String((x as { change?: unknown; what?: unknown }).change ?? (x as { what?: unknown }).what ?? '') : '')).map((x) => x.trim().slice(0, 240)).filter(Boolean).slice(0, n) : [])
  const words = Number(j.textWords)
  return {
    overall: Number.isFinite(overall) ? Math.max(0, Math.min(10, Math.round(overall * 10) / 10)) : 5,
    summary: String(j.summary ?? '').trim().slice(0, 300),
    changes: list(j.changes, 5),
    copyFlags: list(j.copyFlags ?? j.copy_flags, 5).filter((f) => !/^(none|no|n\/a|nothing)\.?$/i.test(f)),
    textWords: Number.isFinite(words) && words >= 0 ? Math.round(words) : null,
    raw: j
  }
}

// The critic's copy flags plus any forbidden term in the critique text.
export function copyGuardFlags(critique: Pick<ParsedCritique, 'summary' | 'changes' | 'copyFlags'>, forbidden: string[], allow: string[] = []): string[] {
  const hits = copyGuard([critique.summary, ...critique.changes, ...critique.copyFlags].join(' \n '), forbidden, allow)
  return [...critique.copyFlags, ...hits.map((h) => `mentions "${h}" from a style reference`)].slice(0, 6)
}

// Text-length principle from the words the critic read (over three words costs points).
export function textCheck(words: number | null): PrincipleCheck | null {
  if (words == null) return null
  const score = words <= MAX_TEXT_WORDS ? 10 : Math.max(0, 10 - (words - MAX_TEXT_WORDS) * 2)
  return { id: 'th-text', score, note: `${words} word${words === 1 ? '' : 's'} of text`, ...(score < 8 ? { fix: `Cut the text to ${MAX_TEXT_WORDS} words or fewer` } : {}) }
}
