// Style cards and style profiles (pure): the vision prompt that turns one reference thumbnail into a
// style card, parsing / normalising its answer, aggregating several cards (plus the code stats) into a
// named profile, and the profile's style text for the generation prompt. References teach style only:
// the card never records characters, logos, game names or the words of the text, and the profile
// text is built from the card's fields, not from free text a model wrote about the reference.

import type { Framing, ProfileCard, SaturationLevel, StyleCard, ThumbStyleProfile, TextSize, ThumbImageStats, ThumbRef } from './types.ts'

export const FRAMINGS: readonly Framing[] = ['close-up', 'medium', 'scene']
export const SATURATIONS: readonly SaturationLevel[] = ['muted', 'balanced', 'vivid', 'neon']
export const TEXT_SIZES: readonly TextSize[] = ['none', 'small', 'medium', 'large', 'huge']

const clip = (v: unknown, n: number) =>
  String(v ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, n)
const num10 = (v: unknown, d: number) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(0, Math.min(10, Math.round(n * 10) / 10)) : d
}
const bool = (v: unknown) => v === true || v === 'true' || v === 'yes'
const oneOf = <T extends string>(v: unknown, list: readonly T[], d: T): T => {
  const s = String(v ?? '').toLowerCase().trim()
  return (list as readonly string[]).includes(s) ? (s as T) : (list.find((x) => s.includes(x)) ?? d)
}

export const STYLE_SYSTEM = [
  'You analyse the visual STYLE of a Roblox game thumbnail so another thumbnail can borrow the style (never the content).',
  'Describe composition, framing, colour, lighting, text treatment, emotion and clutter in general terms. Do not name the game, characters, brands or logos, and do not quote the words of any text: only count them and describe size, placement and lettering style.',
  'Answer with JSON only.'
].join('\n')

export const STYLE_PROMPT = `Return:
{"composition": "<one line: layout, e.g. 'subject left third, threat looming right, diagonal'>",
 "framing": "close-up" | "medium" | "scene",
 "palette": ["#rrggbb", ... up to 5 dominant colours],
 "saturation": "muted" | "balanced" | "vivid" | "neon",
 "outline": true|false (thick outline around the subject),
 "rimLight": true|false,
 "glow": true|false (glows, bloom, light rays),
 "text": {"present": true|false, "words": <count>, "size": "none"|"small"|"medium"|"large"|"huge", "placement": "<e.g. top third, centred>", "font": "<lettering style, e.g. chunky outlined sans, slight tilt, gradient fill>"},
 "emotion": "<one or two words: shock, excitement, fear...>",
 "focalContrast": <0-10, how strongly one subject stands out>,
 "clutter": <0-10, 0 = very clean>,
 "notes": "<one line on what makes it clickable, in style terms only>"}`

const HEX = /#[0-9a-f]{6}\b/i

function extractJson(raw: string): Record<string, unknown> | null {
  const text = String(raw ?? '').replace(/```(?:json)?/g, '')
  const s = text.indexOf('{')
  const e = text.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  try {
    return JSON.parse(text.slice(s, e + 1)) as Record<string, unknown>
  } catch {
    return null
  }
}

// The model's answer -> a card (null when it is not JSON). Text fields are capped; names and quoted
// words the model slipped in are scrubbed from the free-text fields (see scrubNames).
export function parseStyleCard(raw: string | Record<string, unknown>, forbidden: string[] = []): StyleCard | null {
  const j = typeof raw === 'string' ? extractJson(raw) : raw
  if (!j) return null
  const t = (j.text && typeof j.text === 'object' ? j.text : {}) as Record<string, unknown>
  const words = Math.max(0, Math.min(30, Math.round(Number(t.words) || 0)))
  const present = bool(t.present) || words > 0
  const palette = (Array.isArray(j.palette) ? j.palette : [])
    .map((c) => HEX.exec(String(c))?.[0]?.toLowerCase())
    .filter((c): c is string => !!c)
    .slice(0, 5)
  const s = (v: unknown, n: number) => scrubNames(clip(v, n), forbidden)
  return {
    composition: s(j.composition, 160),
    framing: oneOf(j.framing, FRAMINGS, 'medium'),
    palette,
    saturation: oneOf(j.saturation, SATURATIONS, 'balanced'),
    outline: bool(j.outline),
    rimLight: bool(j.rimLight ?? j.rim_light),
    glow: bool(j.glow),
    text: {
      present,
      words: present ? Math.max(1, words) : 0,
      size: present ? oneOf(t.size, TEXT_SIZES, 'large') : 'none',
      placement: present ? s(t.placement, 60) : '',
      font: present ? s(t.font, 80) : ''
    },
    emotion: s(j.emotion, 40),
    focalContrast: num10(j.focalContrast ?? j.focal_contrast, 5),
    clutter: num10(j.clutter, 5),
    notes: s(j.notes, 200)
  }
}

// Removes quoted strings and the given names (game titles, character names) from free text.
export function scrubNames(text: string, forbidden: string[] = []): string {
  let out = text.replace(/["“”'‘’][^"“”'‘’]{1,40}["“”'‘’]/g, 'text')
  for (const f of forbidden) {
    const name = f.trim()
    if (name.length < 3) continue
    out = out.replace(new RegExp(name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), 'the reference')
  }
  return out.trim()
}

// A card from the code stats alone (no vision model): framing from centre focus and edge density,
// saturation from the vivid share, palette from the histogram.
export function cardFromStats(stats: ThumbImageStats): StyleCard {
  const saturation: SaturationLevel = stats.vivid > 0.45 ? 'neon' : stats.vivid > 0.22 ? 'vivid' : stats.saturation < 0.22 ? 'muted' : 'balanced'
  return {
    composition: stats.centerFocus > 1.2 ? 'subject centred' : 'spread across the frame',
    framing: stats.centerFocus > 1.35 && stats.edgeDensity < 0.18 ? 'close-up' : stats.edgeDensity > 0.24 ? 'scene' : 'medium',
    palette: stats.palette.slice(0, 5).map((p) => p.hex),
    saturation,
    outline: false,
    rimLight: false,
    glow: false,
    text: { present: false, words: 0, size: 'none', placement: '', font: '' },
    emotion: '',
    focalContrast: Math.round(Math.min(10, stats.centerFocus * 5) * 10) / 10,
    clutter: Math.round(Math.min(10, stats.edgeDensity * 35) * 10) / 10,
    notes: 'measured from the image only (no vision model)'
  }
}

function mode<T>(xs: T[], fallback: T): { mode: T; share: number } {
  if (!xs.length) return { mode: fallback, share: 0 }
  const m = new Map<T, number>()
  for (const x of xs) m.set(x, (m.get(x) ?? 0) + 1)
  let best = xs[0]
  for (const [k, v] of m) if (v > (m.get(best) ?? 0)) best = k
  return { mode: best, share: Math.round(((m.get(best) ?? 0) / xs.length) * 100) / 100 }
}

const share = (xs: boolean[]) => (xs.length ? Math.round((xs.filter(Boolean).length / xs.length) * 100) / 100 : 0)
const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : 0)

// Palette across references: every reference's colours weighted by their share, merged when close.
export function mergePalettes(list: { hex: string; share: number }[][], k = 6): string[] {
  const acc: { c: [number, number, number]; w: number }[] = []
  for (const pal of list) {
    for (const p of pal) {
      const m = /^#([0-9a-f]{6})$/i.exec(p.hex)
      if (!m) continue
      const n = parseInt(m[1], 16)
      const c: [number, number, number] = [(n >> 16) & 255, (n >> 8) & 255, n & 255]
      const near = acc.find((a) => Math.hypot(a.c[0] - c[0], a.c[1] - c[1], a.c[2] - c[2]) < 56)
      if (near) {
        const t = near.w + p.share
        near.c = near.c.map((v, i) => (v * near.w + c[i] * p.share) / t) as [number, number, number]
        near.w = t
      } else acc.push({ c, w: p.share })
    }
  }
  return acc
    .sort((a, b) => b.w - a.w)
    .slice(0, k)
    .map((a) => '#' + a.c.map((v) => Math.round(v).toString(16).padStart(2, '0')).join(''))
}

// Several references -> one profile card + mean stats. Cards missing (not analysed) fall back to the
// stats-only card.
export function aggregateProfile(refs: Pick<ThumbRef, 'card' | 'stats'>[]): { card: ProfileCard; stats: ThumbStyleProfile['stats'] } {
  const cards = refs.map((r) => r.card ?? cardFromStats(r.stats))
  const texts = cards.filter((c) => c.text.present)
  const emo = new Map<string, number>()
  for (const c of cards) for (const e of c.emotion.toLowerCase().split(/[,/]| and /).map((x) => x.trim()).filter(Boolean)) emo.set(e, (emo.get(e) ?? 0) + 1)
  const card: ProfileCard = {
    framing: mode(cards.map((c) => c.framing), 'medium' as Framing),
    palette: mergePalettes(refs.map((r, i) => (cards[i].palette.length ? cards[i].palette.map((hex, j) => ({ hex, share: 1 / (j + 1) })) : r.stats.palette))),
    saturation: mode(cards.map((c) => c.saturation), 'balanced' as SaturationLevel).mode,
    outline: share(cards.map((c) => c.outline)),
    rimLight: share(cards.map((c) => c.rimLight)),
    glow: share(cards.map((c) => c.glow)),
    text: {
      share: share(cards.map((c) => c.text.present)),
      words: texts.length ? Math.round(avg(texts.map((c) => c.text.words))) : 0,
      size: mode(texts.map((c) => c.text.size), 'none' as TextSize).mode,
      placement: mode(texts.map((c) => c.text.placement).filter(Boolean), '').mode,
      font: mode(texts.map((c) => c.text.font).filter(Boolean), '').mode
    },
    emotions: [...emo.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([e]) => e),
    focalContrast: Math.round(avg(cards.map((c) => c.focalContrast)) * 10) / 10,
    clutter: Math.round(avg(cards.map((c) => c.clutter)) * 10) / 10,
    compositions: [...new Set(cards.map((c) => c.composition).filter(Boolean))].slice(0, 3)
  }
  const stats: ThumbStyleProfile['stats'] = {
    saturation: avg(refs.map((r) => r.stats.saturation)),
    vivid: avg(refs.map((r) => r.stats.vivid)),
    luma: avg(refs.map((r) => r.stats.luma)),
    contrast: avg(refs.map((r) => r.stats.contrast)),
    colorfulness: avg(refs.map((r) => r.stats.colorfulness)),
    edgeDensity: avg(refs.map((r) => r.stats.edgeDensity)),
    centerFocus: avg(refs.map((r) => r.stats.centerFocus))
  }
  return { card, stats }
}

// The profile's style text for the prompt (fields only; no free text from the reference notes).
export function profileSummary(card: ProfileCard, stats?: ThumbStyleProfile['stats']): string {
  const parts: string[] = []
  parts.push(`${card.framing.mode} framing${card.compositions.length ? ` (${card.compositions[0]})` : ''}`)
  parts.push(`${card.saturation} saturation${card.palette.length ? `, palette around ${card.palette.slice(0, 5).join(' ')}` : ''}`)
  const light = [card.outline >= 0.5 ? 'thick outline around the subject' : '', card.rimLight >= 0.5 ? 'strong rim light' : '', card.glow >= 0.5 ? 'glow and bloom accents' : ''].filter(Boolean)
  if (light.length) parts.push(light.join(', '))
  if (card.text.share >= 0.5 && card.text.words > 0) parts.push(`${Math.min(3, card.text.words)} big word${Math.min(3, card.text.words) === 1 ? '' : 's'} of ${card.text.size} text${card.text.placement ? ` at the ${card.text.placement}` : ''}${card.text.font ? `, ${card.text.font}` : ''}`)
  else parts.push('little or no text')
  if (card.emotions.length) parts.push(`emotion: ${card.emotions.join(', ')}`)
  parts.push(card.focalContrast >= 7 ? 'one subject strongly separated from the background' : 'clear subject separation')
  parts.push(card.clutter <= 4 ? 'clean, uncluttered background' : 'busy but organised background')
  if (stats && stats.contrast > 0.2) parts.push('high value contrast')
  return parts.join('; ')
}
