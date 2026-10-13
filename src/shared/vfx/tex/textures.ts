// Custom VFX textures: library item type, the forgetex:// references effects use before (and
// after) upload, the swap to rbxassetid:// on export, AI prompt presets per texture type, and the
// texture suggestions the critic can make. Pure code (main, renderer, tests).
//
// References in an effect's Texture property:
//   forgetex://<id>                a texture in the library (user or project). The preview loads its
//                                  local PNG; on export it becomes rbxassetid://<asset> once uploaded.
//   forgetex://gen/<type>?k=v&...  a procedural texture request (no library item yet): the preview
//                                  draws it on the fly; saving an effect turns it into a library item.
//                                  Lets the composer, the critic and the kit ask for a texture by shape.
//
// Upload facts (creator-docs, read 2026-10-13):
//  - Open Cloud Assets API (cloud/guides/usage-assets.md): assetType "Decal" or "Image", .png/.jpeg/
//    .bmp/.tga, "Must be smaller than 8000x8000 pixels", 20 MB; the operation's response.assetId is
//    the id to use as rbxassetid://<assetId> (moderationResult.moderationState Reviewing / Approved /
//    Rejected, reference/cloud/assets/v1.json ModerationResult).
//  - projects/assets/index.md: "rbxassetid ... is a common standard for properties such as
//    Class.Decal.ColorMapContent, Class.ParticleEmitter.Texture".
//  - Forge uploads particle and beam textures as assetType "Image": the id it returns is the image
//    itself. A "Decal" asset is a wrapper around an image; Studio converts a pasted decal id to its
//    image id, but a decal id written into a Texture property by a script or a .rbxmx file does not
//    render (DevForum "Stop creating decal assets", 2018; the Studio conversion is only in the
//    Properties window). So VFX textures always upload as Image, whatever the Art page's default.

import type { TintMode, FlipbookLayout } from './image.ts'
import { PROCEDURAL_INFO, PROCEDURAL_PARAMS, PROCEDURAL_TYPES, resolveParams, type ProceduralParams, type ProceduralType } from './procedural.ts'
import type { VfxChange, VfxEffect, VfxNode } from '../types.ts'

export const TEX_SCHEME = 'forgetex://'
export const TEX_ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/

// What a texture is for (AI prompt presets and tags). Procedural types are a subset.
export const TEXTURE_KINDS = ['glow', 'wisp', 'spark', 'smoke', 'ring', 'shockwave', 'crack', 'star', 'slash', 'flare', 'debris', 'other'] as const
export type TextureKind = (typeof TEXTURE_KINDS)[number]

export type TextureScope = 'user' | 'project'
export type ModerationState = 'Reviewing' | 'Approved' | 'Rejected' | 'Unknown'

export interface TextureUpload {
  assetId: string
  uri: string
  uploadedAt: number
  moderation: ModerationState
  checkedAt?: number
  operationId?: string
}

export interface VfxTexture {
  id: string
  scope: TextureScope
  name: string
  kind: TextureKind
  description: string
  tags: string[]
  source: 'procedural' | 'ai'
  // Procedural recipe (re-creatable exactly), or the AI prompt and model.
  procedural?: { type: ProceduralType; params: ProceduralParams; seed: number }
  prompt?: string
  model?: string
  costUsd?: number
  tint: TintMode
  // Square, power of two.
  size: number
  flipbook?: { layout: FlipbookLayout; frames: number }
  createdAt: number
  updatedAt: number
  rating?: 'up' | 'down'
  roblox?: TextureUpload
  // Files inside the item folder.
  file: string
  preview: string
}

// ------------------------------------------------------------------ references

export function texRef(id: string): string {
  return `${TEX_SCHEME}${id}`
}

export type ParsedTexRef = { kind: 'id'; id: string } | { kind: 'gen'; type: ProceduralType; params: ProceduralParams; seed: number; frames: number; tint: TintMode }

export function isTexRef(ref: unknown): ref is string {
  return typeof ref === 'string' && ref.startsWith(TEX_SCHEME)
}

export function parseTexRef(ref: string): ParsedTexRef | null {
  if (!isTexRef(ref)) return null
  const rest = ref.slice(TEX_SCHEME.length).trim()
  if (rest.startsWith('gen/')) {
    const [path, query = ''] = rest.slice(4).split('?')
    const type = path.toLowerCase() as ProceduralType
    if (!PROCEDURAL_TYPES.includes(type)) return null
    const q = new Map(query.split('&').filter(Boolean).map((kv) => kv.split('=').map(decodeURIComponent) as [string, string]))
    const params: ProceduralParams = {}
    for (const k of Object.keys(PROCEDURAL_PARAMS[type])) if (q.has(k) && Number.isFinite(Number(q.get(k)))) params[k] = Number(q.get(k))
    const frames = Number(q.get('frames') ?? 1)
    const tint = q.get('tint') === 'grey' ? 'grey' : 'white'
    return { kind: 'gen', type, params: resolveParams(type, params), seed: Math.max(0, Math.floor(Number(q.get('seed') ?? 1)) || 0), frames: [4, 16, 64].includes(frames) ? frames : 1, tint }
  }
  return TEX_ID_RE.test(rest) ? { kind: 'id', id: rest } : null
}

// Canonical gen ref (params in the spec's order, defaults included), so equal requests share a key.
export function genRef(type: ProceduralType, params: ProceduralParams = {}, opts: { seed?: number; frames?: number; tint?: TintMode } = {}): string {
  const p = resolveParams(type, params)
  const q = Object.keys(PROCEDURAL_PARAMS[type]).map((k) => `${k}=${p[k]}`)
  q.push(`seed=${Math.max(0, Math.floor(opts.seed ?? 1))}`)
  if (opts.frames && opts.frames > 1) q.push(`frames=${opts.frames}`)
  if (opts.tint === 'grey') q.push('tint=grey')
  return `${TEX_SCHEME}gen/${type}?${q.join('&')}`
}

// Texture-like properties per class (what the swap touches).
const TEXTURE_PROPS: Record<string, string[]> = { ParticleEmitter: ['Texture'], Beam: ['Texture'], Trail: ['Texture'], MeshPart: ['TextureID'], SpecialMesh: ['TextureId'] }

function walk(nodes: VfxNode[], fn: (n: VfxNode) => void): void {
  for (const n of nodes) {
    fn(n)
    walk(n.children, fn)
  }
}

// Every forgetex:// reference in an effect (nodes, cue props, kit patches), de-duplicated.
export function texRefsIn(effect: VfxEffect): string[] {
  const out = new Set<string>()
  walk(effect.roots, (n) => {
    for (const p of TEXTURE_PROPS[n.className] ?? []) if (isTexRef(n.props[p])) out.add(n.props[p] as string)
  })
  for (const c of effect.patches ?? []) if (/^texture/i.test(c.prop) && isTexRef(c.value)) out.add(c.value as string)
  if (effect.script) for (const m of effect.script.matchAll(/forgetex:\/\/[^"'\s)]+/g)) out.add(m[0])
  return [...out]
}

// Replaces references with map[ref] (missing keys are left alone). Also rewrites the timeline script
// and patches, so a script re-run keeps the new reference.
export function swapTextureRefs(effect: VfxEffect, map: Record<string, string>): VfxEffect {
  const keys = Object.keys(map)
  if (!keys.length) return effect
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  walk(next.roots, (n) => {
    for (const p of TEXTURE_PROPS[n.className] ?? []) {
      const v = n.props[p]
      if (typeof v === 'string' && map[v] !== undefined) n.props[p] = map[v]
    }
  })
  if (next.patches) next.patches = next.patches.map((c) => (typeof c.value === 'string' && map[c.value] !== undefined ? { ...c, value: map[c.value] } : c))
  if (next.script) {
    let s = next.script
    for (const k of keys.sort((a, b) => b.length - a.length)) s = s.split(k).join(map[k])
    next.script = s
  }
  return next
}

// Flipbook textures carry their layout: nodes that use one get FlipbookLayout set (when still None)
// and a mode that suits it, so picking a flipbook texture just works.
export function applyFlipbookLayouts(effect: VfxEffect, lookup: (ref: string) => { layout: FlipbookLayout; frames: number } | null | undefined): VfxEffect {
  let changed = false
  const next: VfxEffect = JSON.parse(JSON.stringify(effect))
  walk(next.roots, (n) => {
    if (n.className !== 'ParticleEmitter' || !isTexRef(n.props.Texture)) return
    const fb = lookup(n.props.Texture as string)
    if (!fb) return
    if (!n.props.FlipbookLayout || n.props.FlipbookLayout === 'None') {
      n.props.FlipbookLayout = fb.layout
      if (!n.props.FlipbookMode) n.props.FlipbookMode = 'OneShot'
      changed = true
    }
  })
  return changed ? next : effect
}

export interface ExportPlan {
  effect: VfxEffect
  // Refs swapped to rbxassetid, refs that fell back to a built-in (not uploaded yet / rejected).
  swapped: Record<string, string>
  fallbacks: { ref: string; to: string; reason: string }[]
}

export const BUILTIN_SPARKLES = 'rbxasset://textures/particles/sparkles_main.dds'
export const BUILTIN_SMOKE = 'rbxasset://textures/particles/smoke_main.dds'

// The built-in that stands in for a custom texture until it is uploaded (Beams / Trails: none).
export function builtinFallback(kind: TextureKind | ProceduralType | undefined, className: string): string {
  if (className === 'Beam' || className === 'Trail') return ''
  return kind === 'smoke' ? BUILTIN_SMOKE : BUILTIN_SPARKLES
}

// Effect for the project files: every forgetex:// reference becomes its uploaded rbxassetid://, or,
// when the texture is not uploaded (or was rejected by moderation), a built-in fallback so the game
// never ships a reference Roblox cannot load. `info` describes a library texture by id.
export function exportEffect(effect: VfxEffect, info: (ref: string) => { uri?: string; moderation?: ModerationState; kind?: TextureKind | ProceduralType } | null): ExportPlan {
  const swapped: Record<string, string> = {}
  const fallbacks: ExportPlan['fallbacks'] = []
  // ref -> kind of a texture that cannot be used yet (fallback chosen per node class below).
  const pending = new Map<string, TextureKind | ProceduralType | undefined>()
  for (const ref of texRefsIn(effect)) {
    const parsed = parseTexRef(ref)
    const i = info(ref)
    if (i?.uri && i.moderation !== 'Rejected') {
      swapped[ref] = i.uri
      continue
    }
    const kind = i?.kind ?? (parsed?.kind === 'gen' ? parsed.type : undefined)
    pending.set(ref, kind)
    fallbacks.push({ ref, to: builtinFallback(kind, 'ParticleEmitter'), reason: !i ? 'not in the texture library' : i.moderation === 'Rejected' ? 'rejected by Roblox moderation' : 'not uploaded to Roblox yet' })
  }
  // Script and patches: the particle fallback (kit rigs are mostly emitters).
  const map: Record<string, string> = { ...swapped }
  for (const [ref, kind] of pending) map[ref] = builtinFallback(kind, 'ParticleEmitter')
  const next = swapTextureRefs(effect, map)
  // Nodes: a Beam / Trail falls back to no texture (a solid strip), emitters to a built-in particle.
  walkPair(effect.roots, next.roots, (orig, n) => {
    for (const p of TEXTURE_PROPS[n.className] ?? []) {
      const ref = orig.props[p]
      if (typeof ref === 'string' && pending.has(ref)) n.props[p] = builtinFallback(pending.get(ref), n.className)
    }
  })
  return { effect: next, swapped, fallbacks }
}

function walkPair(a: VfxNode[], b: VfxNode[], fn: (orig: VfxNode, copy: VfxNode) => void): void {
  for (let i = 0; i < a.length && i < b.length; i++) {
    fn(a[i], b[i])
    walkPair(a[i].children, b[i].children, fn)
  }
}

// ------------------------------------------------------------------ AI prompt presets

export interface TexturePreset {
  kind: TextureKind
  label: string
  // Art direction appended to the user's description.
  direction: string
  // The procedural type that covers this kind for free (when there is one).
  procedural?: ProceduralType
  tint: TintMode
}

const COMMON =
  'A single isolated VFX sprite for a game particle system, centred in the frame with generous empty margin on all sides, nothing touching the edges. Transparent background (alpha), no backdrop, no ground, no shadow, no text, no frame, no border, no watermark. Soft feathered edges that fade to fully transparent. Pure white and light grey luminance only (it is tinted in-engine), high contrast between the bright core and the falloff.'

export const TEXTURE_PRESETS: TexturePreset[] = [
  { kind: 'glow', label: 'Glow', direction: 'A soft round energy glow: a bright hot centre with a smooth gaussian falloff.', procedural: 'glow', tint: 'white' },
  { kind: 'wisp', label: 'Energy wisp', direction: 'A curling wisp of magical energy, flowing ribbon-like strands with thin bright filaments, organic and swirling, like a stylised flame tongue.', tint: 'white' },
  { kind: 'spark', label: 'Spark', direction: 'A thin elongated spark streak, vertical, bright needle-like core tapering at both ends, with a tiny glow.', procedural: 'spark', tint: 'white' },
  { kind: 'smoke', label: 'Smoke puff', direction: 'A billowy cartoon smoke puff, soft cauliflower lumps with internal shading (lit from the top), wispy broken edges.', procedural: 'smoke', tint: 'grey' },
  { kind: 'ring', label: 'Ring', direction: 'A thin circular ring of light, even thickness, soft glow on both edges, empty centre.', procedural: 'ring', tint: 'white' },
  { kind: 'shockwave', label: 'Shockwave', direction: 'A shockwave ring seen from above: a thick distorted circular band with motion streaks and a broken, energetic outer edge, empty centre.', procedural: 'ring', tint: 'white' },
  { kind: 'crack', label: 'Crack', direction: 'Ground cracks radiating from the centre, jagged branching fissures with a faint inner glow, viewed from above.', procedural: 'crack', tint: 'white' },
  { kind: 'star', label: 'Star glint', direction: 'A four-pointed star glint, long thin rays with a small bright core, crisp and clean.', procedural: 'star', tint: 'white' },
  { kind: 'slash', label: 'Slash arc', direction: 'A sword slash arc: a crescent blade trail, sharp bright leading edge, soft trailing edge that fades, thick in the middle and tapering to points at both ends.', procedural: 'slash', tint: 'white' },
  { kind: 'flare', label: 'Flare', direction: 'An anime-style impact flare: a burst of sharp radial spikes of varied length around a bright core.', procedural: 'star', tint: 'white' },
  { kind: 'debris', label: 'Debris chunk', direction: 'A single small rock debris chunk, angular, stylised, light grey with simple shading.', tint: 'grey' },
  { kind: 'other', label: 'Other', direction: '', tint: 'white' }
]

export function texturePreset(kind: TextureKind | string | undefined): TexturePreset {
  return TEXTURE_PRESETS.find((p) => p.kind === kind) ?? TEXTURE_PRESETS[TEXTURE_PRESETS.length - 1]
}

export function texturePrompt(kind: TextureKind, description: string, tint: TintMode): string {
  const preset = texturePreset(kind)
  const parts = [description.trim() || preset.label, preset.direction, COMMON]
  if (tint === 'color') parts[2] = COMMON.replace('Pure white and light grey luminance only (it is tinted in-engine), h', 'Rich saturated colours, h')
  return parts.filter(Boolean).join('\n\n')
}

// Guess a kind from free text ("purple energy wisps" -> wisp).
export function kindFromText(text: string): TextureKind {
  const t = text.toLowerCase()
  const rules: [TextureKind, RegExp][] = [
    ['shockwave', /shock ?wave|blast ring|impact ring/],
    ['ring', /\bring|circle|halo|portal/],
    ['slash', /slash|swipe|arc|crescent|blade/],
    ['crack', /crack|fissure|shatter|fracture|lightning branch/],
    ['spark', /spark|ember|streak|needle/],
    ['smoke', /smoke|dust|fog|cloud|puff|steam/],
    ['star', /star|twinkle|glint|sparkle/],
    ['flare', /flare|burst|spike/],
    ['wisp', /wisp|flame|fire|swirl|energy|aura/],
    ['debris', /rock|debris|chunk|stone/],
    ['glow', /glow|orb|light|bloom/]
  ]
  return rules.find(([, re]) => re.test(t))?.[0] ?? 'other'
}

// ------------------------------------------------------------------ critic suggestions

const SPARKLES_RE = /sparkles_main/i
const SMOKE_RE = /smoke_main/i

// Better-texture actions from parameters alone: built-in textures used for a role they do not fit
// (sparkles on smoke, a soft dot on a VelocityParallel spark, an untextured flat ring...). Values are
// forgetex://gen refs, so applying one costs nothing and the preview shows it at once.
export function textureSuggestions(effect: VfxEffect, roleOf: (n: VfxNode) => string): VfxChange[] {
  const out: VfxChange[] = []
  walk(effect.roots, (n) => {
    if (n.className !== 'ParticleEmitter') return
    const tex = String(n.props.Texture ?? BUILTIN_SPARKLES)
    if (isTexRef(tex) || /^rbxassetid:\/\//.test(tex)) return
    const role = roleOf(n)
    const name = n.name.toLowerCase()
    if ((role === 'smoke' || /smoke|dust/.test(name)) && SPARKLES_RE.test(tex)) out.push({ node: n.name, prop: 'Texture', value: genRef('smoke', {}, { tint: 'grey' }), why: 'smoke reads as a puff with a noise texture, not sparkles' })
    else if ((role === 'sparks' || n.props.Orientation === 'VelocityParallel') && SPARKLES_RE.test(tex)) out.push({ node: n.name, prop: 'Texture', value: genRef('spark'), why: 'stretched sparks need a streak texture' })
    else if (/ring|shock/.test(name) && !SMOKE_RE.test(tex)) out.push({ node: n.name, prop: 'Texture', value: genRef('ring'), why: 'a ring layer needs a ring texture' })
    else if (/crack/.test(name)) out.push({ node: n.name, prop: 'Texture', value: genRef('crack'), why: 'a crack texture instead of a dot' })
    else if (/slash|swipe/.test(name)) out.push({ node: n.name, prop: 'Texture', value: genRef('slash'), why: 'a crescent slash texture' })
  })
  return out.slice(0, 3)
}

// For prompts and tool results: one line per library texture.
export function textureLine(t: VfxTexture): string {
  const fb = t.flipbook ? ` flipbook ${t.flipbook.layout}` : ''
  const up = t.roblox ? ` uploaded ${t.roblox.uri} (${t.roblox.moderation})` : ' local only'
  const rate = t.rating ? ` ${t.rating === 'up' ? 'liked' : 'disliked'}` : ''
  return `${texRef(t.id)} [${t.scope} ${t.kind} ${t.source} ${t.tint}${fb}${rate}]${up}: ${t.name}${t.description ? ` - ${t.description.slice(0, 100)}` : ''}`
}

export const PROCEDURAL_GUIDE = `Custom textures: set Texture (or the kit's texture option) to "forgetex://<id>" for a library texture (vfx_texture_list), or ask for a free procedural one by shape with "forgetex://gen/<type>" (${PROCEDURAL_TYPES.map((t) => `${t}: ${PROCEDURAL_INFO[t].use}`).join('; ')}). Optional query params, e.g. "forgetex://gen/ring?thickness=0.05&seed=2", "forgetex://gen/smoke?frames=16" (a 4x4 flipbook: also set FlipbookLayout "Grid4x4" and FlipbookMode "OneShot"). Textures are white so Color tints them. Use built-in rbxasset textures when they already fit.`
