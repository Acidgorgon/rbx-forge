// Retrieval for Make / compose / the critic: which of the user's own effects are closest to a request
// (kind, element, colours, timing and words, weighted by ratings and by how well remixes of each
// effect did), a compact per-layer digest of an effect for prompts, and the bank of real textures the
// library's effects use per layer role (with their flipbook settings), so generated layers reuse
// textures that exist instead of built-in placeholders or invented ids.
// Pure code (test/vfxQuality.test.ts, the offline eval in test/vfxEval).

import { allNodes, effectColors, emitterRole, nodeRole, type LayerRole } from './analyze.ts'
import { prop, SCHEMA } from './schema.ts'
import { evalColorSequence, hex, sequenceMax } from './sequence.ts'
import { requestTagGroups, tagGroupsOf, words, type TagGroups } from './tags.ts'
import { mainHue, targetHue } from './remix.ts'
import type { ColorSequence, NumberRange, NumberSequence, PropValue, VfxEffect, VfxEntry, VfxNode } from './types.ts'

// ------------------------------------------------------------------ feedback

// How remixes / examples of each library effect were rated (feedback.json in the VFX user folder):
// a generated effect remembers which effects it was based on; thumbs up / down on it count here.
export interface VfxFeedback {
  bases: Record<string, { up: number; down: number }>
}

export function emptyFeedback(): VfxFeedback {
  return { bases: {} }
}

export function normalizeFeedback(raw: unknown): VfxFeedback {
  const out = emptyFeedback()
  const b = (raw as { bases?: unknown })?.bases
  if (b && typeof b === 'object') {
    for (const [id, v] of Object.entries(b as Record<string, { up?: unknown; down?: unknown }>)) {
      const up = Math.max(0, Math.floor(Number(v?.up) || 0))
      const down = Math.max(0, Math.floor(Number(v?.down) || 0))
      if (up || down) out.bases[id] = { up, down }
    }
  }
  return out
}

// A rating on a generated effect -> the counts of the effects it was based on. `prev` is the rating it
// had before (changing a vote moves it instead of adding a second one).
export function recordFeedback(fb: VfxFeedback, basedOn: string[], rating: 'up' | 'down' | null, prev?: 'up' | 'down' | null): VfxFeedback {
  const next: VfxFeedback = { bases: { ...fb.bases } }
  for (const id of new Set(basedOn)) {
    const c = { ...(next.bases[id] ?? { up: 0, down: 0 }) }
    if (prev) c[prev] = Math.max(0, c[prev] - 1)
    if (rating) c[rating]++
    if (c.up || c.down) next.bases[id] = c
    else delete next.bases[id]
  }
  return next
}

// Score multiplier for an effect from its feedback: liked remixes raise it, disliked ones lower it.
export function feedbackBoost(fb: VfxFeedback | null | undefined, id: string): number {
  const c = fb?.bases[id]
  if (!c) return 1
  return Math.max(0.3, Math.min(2.5, 1 + 0.25 * c.up - 0.3 * c.down))
}

// ------------------------------------------------------------------ requests

const HUE_WORDS: Record<string, RegExp> = {
  red: /^(red|crimson|scarlet|blood\w*|ruby)$/,
  orange: /^(orange|amber)$/,
  yellow: /^(yellow|gold\w*|golden)$/,
  green: /^(green|toxic|poison\w*|acid\w*|emerald|lime)$/,
  cyan: /^(cyan|teal|aqua|turquoise)$/,
  blue: /^(blue|azure|sapphire|navy)$/,
  purple: /^(purple|violet|magenta|lilac|indigo)$/,
  pink: /^(pink|rose)$/,
  white: /^(white|silver|pale)$/,
  black: /^(black|obsidian)$/
}

const STOP = new Set(['the', 'and', 'with', 'that', 'effect', 'vfx', 'make', 'some', 'very', 'from', 'into', 'like', 'for', 'then', 'its', 'has', 'big', 'small', 'one'])

export interface VfxRequest {
  text: string
  groups: TagGroups
  hues: string[]
  words: string[]
  // Size words: big / huge -> 1.5, small / tiny -> 0.7.
  scale: number
}

export function readRequest(text: string): VfxRequest {
  const ws = words(text)
  const hues = Object.entries(HUE_WORDS)
    .filter(([, re]) => ws.some((w) => re.test(w)))
    .map(([h]) => h)
  const scale = ws.some((w) => /^(huge|massive|giant|enormous|big|large|massive|ultimate)$/.test(w)) ? 1.5 : ws.some((w) => /^(small|tiny|subtle|little|mini)$/.test(w)) ? 0.7 : 1
  return { text, groups: requestTagGroups(text), hues, words: [...new Set(ws.filter((w) => w.length > 2 && !STOP.has(w)))], scale }
}

// ------------------------------------------------------------------ nearest effects

export interface VfxMatch {
  entry: VfxEntry
  score: number
  kindMatch: boolean
  elementMatch: boolean
  // A request word is in the effect's name ("hollow purple but red" -> "Hollow Purple").
  nameMatch: boolean
  why: string[]
}

export interface NearestOptions {
  limit?: number
  exclude?: string
  feedback?: VfxFeedback | null
}

// The user's effects ranked for a request. Media entries, disliked effects and avoid examples are
// never returned. An effect of another kind than the request names counts far less.
export function nearestEffects(request: VfxRequest | string, entries: VfxEntry[], opts: NearestOptions = {}): VfxMatch[] {
  const req = typeof request === 'string' ? readRequest(request) : request
  const want = targetHue(req)
  const out: VfxMatch[] = []
  for (const e of entries) {
    if (!e.effect || e.kind === 'media' || e.quality === 'avoid' || e.rating === 'down' || e.id === opts.exclude) continue
    const g = tagGroupsOf(e)
    const why: string[] = []
    let s = 0
    const kinds = req.groups.kind.filter((k) => g.kind.includes(k))
    const elements = req.groups.element.filter((k) => g.element.includes(k))
    if (kinds.length) (s += 6 * kinds.length), why.push(`kind ${kinds.join('+')}`)
    if (elements.length) (s += 4 * elements.length), why.push(`element ${elements.join('+')}`)
    if (req.groups.timing.some((t) => g.timing.includes(t))) s += 1
    const colors = effectColors(e.effect)
    const hues = req.hues.filter((h) => colors.includes(h))
    if (hues.length) (s += 1.5 * hues.length + (colors[0] === hues[0] ? 0.5 : 0)), why.push(`colour ${hues.join('/')}`)
    // Close in hue to what the request asks for (less to recolour when remixing).
    if (want !== null && !elements.length) {
      const h = mainHue(e.effect)
      if (h !== null) s += 1.5 * Math.max(0, 1 - Math.abs(((((want - h) % 360) + 540) % 360) - 180) / 90)
    }
    // The original name of an entry named from its tags (or renamed) counts as its name too.
    const nameWords = new Set(words(`${e.name} ${e.sourceName ?? ''} ${e.kind === 'model' ? e.origin : ''}`))
    const layerWords = new Set(allNodes(e.effect.roots).flatMap((n) => words(n.name)))
    const desc = e.description.toLowerCase()
    const hit: string[] = []
    let named = 0
    for (const w of req.words) {
      let ws = 0
      if (nameWords.has(w)) (ws += 2), named++
      if (e.tags.includes(w)) ws += 2
      if (layerWords.has(w)) ws += 0.5
      if (desc.includes(w)) ws += 0.5
      if (ws) hit.push(w)
      s += ws
    }
    if (hit.length) why.push(`words ${hit.slice(0, 4).join(', ')}`)
    // The effect named by name: "hollow purple" is that effect, whatever its tags say.
    const ownSize = (n: string) => new Set(words(n).filter((w) => w.length > 2 && !STOP.has(w))).size
    const nameMatch = named > 0 && (named >= 2 || named >= ownSize(e.name) || (!!e.sourceName && named >= ownSize(e.sourceName)))
    if (nameMatch) s += 3
    if (s <= 0) continue
    const kindMatch = !req.groups.kind.length || kinds.length > 0
    if (!kindMatch && !nameMatch) s *= 0.35
    // Liked effects first; generated ones nobody rated are not the user's own work.
    if (e.rating === 'up') s *= 1.3
    else if (e.kind === 'generated' && e.quality !== 'good') s *= 0.7
    const boost = feedbackBoost(opts.feedback, e.id)
    if (boost !== 1) why.push(boost > 1 ? 'liked remixes' : 'disliked remixes')
    s *= boost
    out.push({ entry: e, score: Math.round(s * 100) / 100, kindMatch, elementMatch: !req.groups.element.length || elements.length > 0, nameMatch, why })
  }
  return out.sort((a, b) => b.score - a.score || b.entry.updatedAt - a.entry.updatedAt).slice(0, opts.limit ?? 5)
}

// Close enough to start from it (remix) instead of drafting from scratch: same kind (when the
// request names one) and a real overlap beyond that; or the effect named by name ("like Hollow
// Purple but red") whatever the request's kind words say.
export const REMIX_MIN_SCORE = 6
export function remixable(m: VfxMatch | undefined, req: VfxRequest): m is VfxMatch {
  if (!m) return false
  if (!m.entry.effect || emitterCount(m.entry.effect) <= 0) return false
  if (m.nameMatch && m.score >= REMIX_MIN_SCORE) return true
  if (req.groups.kind.length && !m.kindMatch) return false
  if (!req.groups.kind.length && !req.groups.element.length) return false
  return m.score >= REMIX_MIN_SCORE
}

function emitterCount(e: VfxEffect): number {
  return allNodes(e.roots).filter((n) => n.className === 'ParticleEmitter' || n.className === 'Beam' || n.className === 'Trail').length
}

// ------------------------------------------------------------------ digests

const r2 = (x: number) => Math.round(x * 100) / 100
const rangeText = (v: NumberRange) => (Math.abs(v[0] - v[1]) < 1e-3 ? `${r2(v[0])}` : `${r2(v[0])}-${r2(v[1])}`)

// One line per layer: role, class, texture (+flipbook), the numbers that set the look, bursts and
// colours. Much shorter than the full parameters; for the prompt's "closest effects" block.
export function effectDigest(effect: VfxEffect, max = 12): string {
  const lines: string[] = []
  for (const n of allNodes(effect.roots)) {
    if (lines.length >= max) break
    if (n.className === 'ParticleEmitter') {
      const bursts = effect.cues.filter((c) => c.target === n.id && c.action === 'emit')
      const tex = textureOf(n)
      const flip = prop<string>(n, 'FlipbookLayout')
      const bits = [
        `${n.name} [${emitterRole(n)}]`,
        tex ? `texture ${tex}${flip && flip !== 'None' ? ` ${flip}` : ''}` : '',
        `life ${rangeText(prop<NumberRange>(n, 'Lifetime'))}`,
        `speed ${rangeText(prop<NumberRange>(n, 'Speed'))}`,
        `size peak ${r2(sequenceMax(prop<NumberSequence>(n, 'Size')))}`,
        `LE ${r2(prop<number>(n, 'LightEmission'))}`,
        prop<number>(n, 'Drag') ? `drag ${r2(prop<number>(n, 'Drag'))}` : '',
        bursts.length ? `emit ${bursts.slice(0, 3).map((b) => `${b.count ?? 16}@${r2(b.at)}s`).join(' ')}` : prop<boolean>(n, 'Enabled') !== false ? `rate ${r2(prop<number>(n, 'Rate'))}` : '',
        `colour ${colorsOf(n).join('>')}`
      ].filter(Boolean)
      lines.push(bits.join(', '))
    } else if (n.className === 'Beam' || n.className === 'Trail') {
      const tex = textureOf(n)
      lines.push([`${n.name} [${nodeRole(n)}] ${n.className}`, tex ? `texture ${tex}` : '', n.className === 'Trail' ? `life ${r2(prop<number>(n, 'Lifetime'))}` : `width ${r2(prop<number>(n, 'Width0'))}`, `LE ${r2(prop<number>(n, 'LightEmission'))}`, `colour ${colorsOf(n).join('>')}`].filter(Boolean).join(', '))
    } else if (/Light$/.test(n.className)) {
      lines.push(`${n.name} [light] ${n.className} brightness ${r2(prop<number>(n, 'Brightness'))} range ${r2(prop<number>(n, 'Range'))}`)
    }
  }
  return `${effect.name} (${r2(effect.duration)} s):\n${lines.map((l) => `  - ${l}`).join('\n')}`
}

function colorsOf(n: VfxNode): string[] {
  const seq = n.props.Color
  if (!Array.isArray(seq) || !seq.length) return [hex([1, 1, 1])]
  if (typeof seq[0] === 'number') return [hex(seq as unknown as [number, number, number])]
  const cs = seq as ColorSequence
  return [...new Set([0, 0.5, 1].map((t) => hex(evalColorSequence(cs, t))))]
}

// ------------------------------------------------------------------ texture bank

// rbxassetid://123 and http://www.roblox.com/asset/?id=123 -> rbxassetid://123; anything else null.
export function assetTexture(v: unknown): string | null {
  if (typeof v !== 'string') return null
  const m = /^(?:rbxassetid:\/\/|https?:\/\/(?:www\.)?roblox\.com\/asset\/?\?id=)(\d+)$/i.exec(v.trim())
  return m ? `rbxassetid://${m[1]}` : null
}

function textureOf(n: VfxNode): string | null {
  const t = n.props.Texture
  return assetTexture(t) ?? (typeof t === 'string' && t.startsWith('forgetex://') ? t : null)
}

// Texture props that travel with a texture (a flipbook sheet needs its layout to look right).
const CARRY: Record<string, string[]> = {
  ParticleEmitter: ['FlipbookLayout', 'FlipbookMode', 'FlipbookFramerate', 'FlipbookStartRandom'],
  Beam: ['TextureMode', 'TextureLength', 'TextureSpeed'],
  Trail: ['TextureMode', 'TextureLength']
}

export interface BankTexture {
  texture: string
  className: string
  role: LayerRole
  // The props that go with it (flipbook layout, texture mode).
  props: Record<string, PropValue>
  // Layers using it across the library, and the effects they are in.
  uses: number
  entries: string[]
}

export type TextureBank = Map<string, BankTexture[]>

const bankKey = (className: string, role: string) => `${className === 'ParticleEmitter' ? 'pe' : className.toLowerCase()}:${role}`

// Every real texture (rbxassetid) the library's effects use, per class + layer role, most used first.
export function effectTextureBank(entries: VfxEntry[]): TextureBank {
  const byKey = new Map<string, Map<string, BankTexture>>()
  for (const e of entries) {
    if (!e.effect || e.kind === 'media' || e.quality === 'avoid' || e.rating === 'down') continue
    for (const n of allNodes(e.effect.roots)) {
      if (!CARRY[n.className]) continue
      const tex = assetTexture(n.props.Texture)
      if (!tex) continue
      const role = nodeRole(n)
      const key = bankKey(n.className, role)
      const m = byKey.get(key) ?? new Map<string, BankTexture>()
      const cur = m.get(tex)
      if (cur) {
        cur.uses += e.rating === 'up' ? 2 : 1
        if (!cur.entries.includes(e.id)) cur.entries.push(e.id)
      } else {
        const props: Record<string, PropValue> = {}
        for (const k of CARRY[n.className]) if (n.props[k] !== undefined) props[k] = n.props[k]
        m.set(tex, { texture: tex, className: n.className, role, props, uses: e.rating === 'up' ? 2 : 1, entries: [e.id] })
      }
      byKey.set(key, m)
    }
  }
  const bank: TextureBank = new Map()
  for (const [k, m] of byKey) bank.set(k, [...m.values()].sort((a, b) => b.uses - a.uses || a.texture.localeCompare(b.texture)))
  return bank
}

// The best real texture for a layer: same class and role, preferring ones the closest effects use.
export function bankPick(bank: TextureBank, className: string, role: string, near: string[] = []): BankTexture | null {
  let list = bank.get(bankKey(className, role)) ?? []
  // Beams and trails both draw strip textures: one can stand in for the other.
  if (!list.length && (className === 'Beam' || className === 'Trail')) {
    const other = className === 'Beam' ? 'Trail' : 'Beam'
    list = [...bank.entries()].filter(([k]) => k.startsWith(`${other.toLowerCase()}:`)).flatMap(([, v]) => v)
    if (!list.length) list = [...bank.entries()].filter(([k]) => k.startsWith(`${className.toLowerCase()}:`)).flatMap(([, v]) => v)
  }
  if (!list.length) return null
  const nearSet = new Set(near)
  const score = (t: BankTexture) => t.uses + 4 * t.entries.filter((id) => nearSet.has(id)).length
  return [...list].sort((a, b) => score(b) - score(a))[0]
}

// Textures by role for prompts ("sparks: rbxassetid://1 (Grid4x4), rbxassetid://2").
export function bankLines(bank: TextureBank, near: string[] = [], perRole = 2): string[] {
  const out: string[] = []
  for (const [key, list] of bank) {
    const [cls, role] = key.split(':')
    const nearSet = new Set(near)
    const sorted = [...list].sort((a, b) => b.uses + 4 * b.entries.filter((id) => nearSet.has(id)).length - (a.uses + 4 * a.entries.filter((id) => nearSet.has(id)).length))
    out.push(`${role} (${cls === 'pe' ? 'particles' : cls}): ${sorted.slice(0, perRole).map((t) => `${t.texture}${t.props.FlipbookLayout && t.props.FlipbookLayout !== 'None' ? ` flipbook ${t.props.FlipbookLayout}` : ''}`).join(', ')}`)
  }
  return out
}

// Layers still on a built-in placeholder (Roblox's default sparkles / smoke, any rbxasset:// file,
// or a beam / trail with no texture) take the bank's texture for their role, with its flipbook /
// texture-mode props. `skipRoles`: roles the texture library already covers (its picks win).
// Returns the changes (node keys: names on scripted effects so they survive re-runs, else ids).
export function bankTextureChanges(effect: VfxEffect, bank: TextureBank, opts: { near?: string[]; skipRoles?: string[] } = {}): { node: string; prop: string; value: unknown; why: string }[] {
  const changes: { node: string; prop: string; value: unknown; why: string }[] = []
  const seen = new Set<string>()
  const count = new Map<string, number>()
  for (const n of allNodes(effect.roots)) count.set(n.name, (count.get(n.name) ?? 0) + 1)
  const keyOf = (n: VfxNode) => (effect.script || (count.get(n.name) ?? 0) <= 1 ? n.name : n.id)
  for (const n of allNodes(effect.roots)) {
    if (!CARRY[n.className]) continue
    const cur = n.props.Texture
    const placeholder = cur === undefined || cur === '' || (typeof cur === 'string' && /^rbxasset:\/\//i.test(cur))
    if (!placeholder) continue
    const role = nodeRole(n)
    if (opts.skipRoles?.includes(role)) continue
    const key = keyOf(n)
    if (seen.has(key)) continue
    const pick = bankPick(bank, n.className, role, opts.near)
    if (!pick) continue
    seen.add(key)
    const why = `${role} texture from your effects (${pick.entries.length} use${pick.entries.length === 1 ? 's' : ''} it)`
    changes.push({ node: key, prop: 'Texture', value: pick.texture, why })
    for (const [k, v] of Object.entries(pick.props)) if (SCHEMA[n.className]?.[k]) changes.push({ node: key, prop: k, value: v, why })
  }
  return changes
}
