// Reuse first: how the VFX composer, drafter and critic pick textures (pure code, tested).
//
// The VFX Lab setting "Textures" (vfx.texturePolicy):
//   library-only   never make new textures: library textures that fit, else a built-in one
//   library-first  (default) library textures that fit the layer's kind; a free procedural texture
//                  only when nothing in the library fits
//   generate       the old behaviour: forgetex://gen/<type> requests become new procedural textures
// Disliked textures (thumbs down) are never picked, liked and imported ones come first.

import { emitterRole } from '../analyze.ts'
import { applyChanges } from '../spec.ts'
import type { VfxChange, VfxEffect, VfxNode } from '../types.ts'
import { BUILTIN_SMOKE, BUILTIN_SPARKLES, builtinFallback, isTexRef, kindFromText, parseTexRef, texRef, type TextureKind, type VfxTexture } from './textures.ts'

export const TEXTURE_POLICIES = ['library-only', 'library-first', 'generate'] as const
export type TexturePolicy = (typeof TEXTURE_POLICIES)[number]
export const DEFAULT_TEXTURE_POLICY: TexturePolicy = 'library-first'
export const TEXTURE_POLICY_SETTING = 'vfx.texturePolicy'

export const TEXTURE_POLICY_INFO: Record<TexturePolicy, { label: string; help: string }> = {
  'library-only': { label: 'library only', help: 'Never makes new textures: effects use your library textures that fit, else a built-in Roblox texture.' },
  'library-first': { label: 'library first', help: 'Effects reuse your library textures (imported and liked first); a free procedural one is made only when nothing fits.' },
  generate: { label: 'generate freely', help: 'Effects may ask for new procedural textures whenever a layer needs one.' }
}

export function normalizePolicy(v: unknown): TexturePolicy {
  return (TEXTURE_POLICIES as readonly string[]).includes(String(v)) ? (v as TexturePolicy) : DEFAULT_TEXTURE_POLICY
}

// Kinds that can stand in for each other (a lower score than an exact match).
const RELATED: Partial<Record<TextureKind, TextureKind[]>> = {
  ring: ['shockwave'],
  shockwave: ['ring'],
  star: ['flare', 'spark'],
  flare: ['star', 'glow'],
  glow: ['flare', 'wisp'],
  wisp: ['smoke', 'glow'],
  smoke: ['wisp', 'noise'],
  noise: ['smoke'],
  spark: ['star'],
  trail: ['beam'],
  beam: ['trail', 'noise'],
  slash: ['trail']
}

export interface TextureWant {
  kind: TextureKind
  className?: string
  words?: string[]
}

// How well a library texture fits; 0 = never (disliked, or the wrong shape for the class).
export function scoreTexture(t: VfxTexture, want: TextureWant): number {
  if (t.rating === 'down') return 0
  const strip = t.kind === 'beam' || t.kind === 'trail'
  const stripClass = want.className === 'Beam' || want.className === 'Trail'
  if (want.className === 'ParticleEmitter' && strip) return 0
  let s = 0
  if (t.kind === want.kind) s += 10
  else if (RELATED[want.kind]?.includes(t.kind)) s += 5
  else if (t.tags.includes(want.kind)) s += 6
  else return 0
  if (stripClass) s += strip ? 4 : -3
  for (const w of want.words ?? []) if (w.length > 2 && (t.tags.includes(w) || t.name.toLowerCase().includes(w))) s += 2
  if (t.rating === 'up') s += 5
  if (t.source === 'imported' || t.source === 'asset') s += 3
  if (t.tags.includes('auto')) s -= 2
  if (t.roblox && t.roblox.moderation !== 'Rejected') s += 1
  if (t.roblox?.moderation === 'Rejected') s -= 8
  return Math.max(0, s)
}

export function rankTextures(lib: VfxTexture[], want: TextureWant): VfxTexture[] {
  return lib
    .map((t) => ({ t, s: scoreTexture(t, want) }))
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s || b.t.updatedAt - a.t.updatedAt)
    .map((x) => x.t)
}

// The best library texture for a layer, or null. strict: an exact kind match that the user brought
// in or liked (used to replace built-in defaults, so only clear wins replace them).
export function pickLibraryTexture(lib: VfxTexture[], want: TextureWant, opts: { strict?: boolean } = {}): VfxTexture | null {
  const ranked = rankTextures(lib, want)
  const best = ranked[0]
  if (!best) return null
  if (opts.strict && !(best.kind === want.kind && (best.rating === 'up' || best.source === 'imported' || best.source === 'asset'))) return null
  return best
}

// What texture a node wants, from its current texture (a gen request names its shape), its class,
// its name and its role.
export function nodeWant(n: VfxNode): TextureWant | null {
  if (n.className !== 'ParticleEmitter' && n.className !== 'Beam' && n.className !== 'Trail') return null
  const tex = n.props.Texture
  const words = n.name.toLowerCase().replace(/([a-z])([A-Z])/g, '$1 $2').split(/[^a-z0-9]+/).filter(Boolean)
  const parsed = typeof tex === 'string' ? parseTexRef(tex) : null
  if (parsed?.kind === 'gen') return { kind: parsed.type as TextureKind, className: n.className, words }
  if (n.className !== 'ParticleEmitter') {
    const k = kindFromText(n.name)
    return { kind: k === 'slash' || k === 'other' ? (n.className === 'Beam' ? 'beam' : 'trail') : k, className: n.className, words }
  }
  const byName = kindFromText(n.name.replace(/([a-z])([A-Z])/g, '$1 $2'))
  if (byName !== 'other' && byName !== 'beam' && byName !== 'trail') return { kind: byName, className: n.className, words }
  const role = emitterRole(n)
  const map: Record<string, TextureKind> = { sparks: 'spark', smoke: 'smoke', glow: 'glow', core: 'glow', ring: 'ring', debris: 'debris', slash: 'slash', crack: 'crack', flash: 'flare' }
  return { kind: map[role] ?? 'glow', className: n.className, words }
}

export interface PolicyPick {
  node: string
  from: string
  to: string
  why: string
}

function walk(nodes: VfxNode[], fn: (n: VfxNode) => void): void {
  for (const n of nodes) {
    fn(n)
    walk(n.children, fn)
  }
}

const isBuiltinDefault = (v: unknown, className: string) => (className === 'ParticleEmitter' ? v === undefined || v === BUILTIN_SPARKLES || v === BUILTIN_SMOKE : v === undefined || v === '')

// Applies the texture policy to an effect the composer / drafter / critic produced:
//  - forgetex://gen/<type> requests: a fitting library texture instead (library-first / only); with
//    nothing fitting, library-only uses a built-in texture (nothing is generated);
//  - references to disliked textures: the best alternative, else a built-in;
//  - replaceBuiltins: kit and draft layers still on Roblox's default sparkles / smoke (or a Beam /
//    Trail with no texture) take an imported or liked library texture of their exact kind.
// Changes go through applyChanges, so scripted effects keep them as patches across re-runs.
export function applyTexturePolicy(effect: VfxEffect, lib: VfxTexture[], policy: TexturePolicy, opts: { replaceBuiltins?: boolean } = {}): { effect: VfxEffect; picks: PolicyPick[] } {
  const byId = new Map(lib.map((t) => [t.id, t]))
  const changes: VfxChange[] = []
  const picks: PolicyPick[] = []
  const seen = new Set<string>()
  walk(effect.roots, (n) => {
    const want = nodeWant(n)
    if (!want || seen.has(n.name)) return
    const cur = n.props.Texture
    let to: string | null = null
    let why = ''
    const parsed = isTexRef(cur) ? parseTexRef(cur) : null
    if (parsed?.kind === 'gen') {
      if (policy === 'generate') return
      const hit = pickLibraryTexture(lib, want)
      if (hit) {
        to = texRef(hit.id)
        why = `library ${hit.kind} texture "${hit.name}" instead of a new procedural ${parsed.type}`
      } else if (policy === 'library-only') {
        to = builtinFallback(want.kind, n.className)
        why = `no library texture fits ${want.kind}; textures are set to library only, so a built-in one`
      }
    } else if (parsed?.kind === 'id' && byId.get(parsed.id)?.rating === 'down') {
      const hit = pickLibraryTexture(lib.filter((t) => t.id !== parsed.id), want)
      to = hit ? texRef(hit.id) : builtinFallback(want.kind, n.className)
      why = `"${byId.get(parsed.id)!.name}" is disliked`
    } else if (opts.replaceBuiltins && policy !== 'generate' && isBuiltinDefault(cur, n.className)) {
      const hit = pickLibraryTexture(lib, want, { strict: true })
      if (hit) {
        to = texRef(hit.id)
        why = `${hit.source === 'imported' || hit.source === 'asset' ? 'imported' : 'liked'} ${hit.kind} texture "${hit.name}"`
      }
    }
    if (to === null || to === cur) return
    seen.add(n.name)
    changes.push({ node: n.name, prop: 'Texture', value: to, why })
    picks.push({ node: n.name, from: String(cur ?? ''), to, why })
  })
  if (!changes.length) return { effect, picks }
  try {
    return { effect: applyChanges(effect, changes), picks }
  } catch {
    return { effect, picks: [] }
  }
}

// Library lines for the composer / drafter prompts, grouped by kind (imported and liked first,
// disliked never), and the instruction for the policy.
export function libraryPromptLines(lib: VfxTexture[], policy: TexturePolicy, opts: { perKind?: number; max?: number } = {}): string[] {
  const usable = lib.filter((t) => t.rating !== 'down')
  const rank = (t: VfxTexture) => (t.rating === 'up' ? 4 : 0) + (t.source === 'imported' || t.source === 'asset' ? 3 : 0) + (t.tags.includes('auto') ? -1 : 0)
  const byKind = new Map<string, VfxTexture[]>()
  for (const t of [...usable].sort((a, b) => rank(b) - rank(a) || b.updatedAt - a.updatedAt)) {
    const list = byKind.get(t.kind) ?? []
    if (list.length < (opts.perKind ?? 4)) list.push(t)
    byKind.set(t.kind, list)
  }
  const lines: string[] = []
  let count = 0
  for (const [kind, list] of byKind) {
    if (count >= (opts.max ?? 40)) break
    const items = list.slice(0, (opts.max ?? 40) - count)
    count += items.length
    lines.push(`${kind}: ${items.map((t) => `${texRef(t.id)} "${t.name}"${t.analysis ? ` (${t.analysis.colorName}, ${t.analysis.edge})` : ''}${t.flipbook ? ` flipbook ${t.flipbook.layout}` : ''}${t.rating === 'up' ? ' liked' : ''}`).join('; ')}`)
  }
  const disliked = lib.filter((t) => t.rating === 'down').slice(0, 8)
  const rule =
    policy === 'library-only'
      ? 'Texture policy: LIBRARY ONLY. Use the library textures below (texture = "forgetex://<id>" in kit spawn options, or Texture on a layer) wherever one fits the layer; otherwise keep the built-in rbxasset textures. Never use forgetex://gen/... and never call vfx_texture_generate.'
      : policy === 'library-first'
        ? 'Texture policy: LIBRARY FIRST. For every particle, beam and trail layer, first look below for a library texture of that kind and use it (texture = "forgetex://<id>"); prefer imported and liked ones. Only ask for forgetex://gen/<type> when no library texture fits the layer.'
        : 'Texture policy: generate freely. Library textures below are welcome when they fit; forgetex://gen/<type> makes a new procedural texture.'
  return [rule, ...(lines.length ? ['Texture library by kind:', ...lines] : ['The texture library is empty.']), ...(disliked.length ? [`Never use these disliked textures: ${disliked.map((t) => texRef(t.id)).join(', ')}`] : [])]
}

// Draft layer roles -> a library texture (for shared/vfx/draft.ts draftSpec's textures option).
export function roleTextures(lib: VfxTexture[], policy: TexturePolicy): Record<string, string> {
  if (policy === 'generate') return {}
  const roles: Record<string, TextureKind> = { core: 'glow', glow: 'glow', sparks: 'spark', smoke: 'smoke', ring: 'ring' }
  const out: Record<string, string> = {}
  for (const [role, kind] of Object.entries(roles)) {
    const hit = pickLibraryTexture(lib, { kind, className: 'ParticleEmitter' }, { strict: true })
    if (hit) out[role] = texRef(hit.id)
  }
  return out
}

// Whether the agent may generate a new texture of this kind right now (vfx_texture_generate).
export function generationAllowed(lib: VfxTexture[], policy: TexturePolicy, kind: TextureKind, userAsked: boolean): { ok: true } | { ok: false; reason: string; alternatives: VfxTexture[] } {
  if (userAsked || policy === 'generate') return { ok: true }
  const alternatives = rankTextures(lib, { kind }).slice(0, 5)
  if (policy === 'library-only') return { ok: false, reason: 'The VFX Lab texture setting is "library only": use a library texture (or a built-in one) instead of making a new texture, unless the user explicitly asks for a new one (then pass user_asked: true).', alternatives }
  if (alternatives.length) return { ok: false, reason: `The library already has ${kind} textures and the texture setting is "library first": use one of these (pass user_asked: true only when the user explicitly asked for a new texture).`, alternatives }
  return { ok: true }
}
