// "Split into layers", the pure parts shared by main (services/art/layers.ts) and the Art page: the
// vision prompt that proposes a layer list for a UI mockup, its parser, the per-layer generation
// prompt, default sizes, file paths and the Luau theme snippet. No node or electron imports.
//
// The split follows one rule: text, buttons, nav tabs and other interactive UI are rebuilt as real
// Roblox UI (TextLabel / TextButton / UIStroke ...), so only image layers are cut out of the concept:
// a background plate with every piece of UI, text and character removed, each distinct card / panel
// background texture (no text), logos and icons on transparent backgrounds, and optionally a
// character render on a transparent background.

import type { ArtLayerKind, ArtLayerManifest, ArtLayerSpec } from './artTypes.ts'

export const LAYER_KINDS: readonly ArtLayerKind[] = ['background', 'panel', 'icon', 'logo', 'character']
export const LAYER_KIND_LABELS: Record<ArtLayerKind, string> = {
  background: 'background plate',
  panel: 'panel texture',
  icon: 'icon',
  logo: 'logo',
  character: 'character'
}
export const MAX_LAYERS = 12
export const LAYERS_FILE = 'layers.json'
export const LAYER_SIZES = ['1024x1024', '1536x1024', '1024x1536'] as const

// PascalCase Luau identifier ("quick join card" -> QuickJoinCard), as registry.ts registryName.
export function layerName(raw: string, fallback = 'Layer'): string {
  const words = String(raw ?? '')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
  let name = words.map((w) => w[0].toUpperCase() + w.slice(1)).join('')
  if (!name) name = fallback
  if (/^\d/.test(name)) name = `${fallback}${name}`
  return name.slice(0, 60)
}

// ConceptName for a concept: its slug, plus the variant number after the first.
export function conceptLayerName(slug: string, index = 1): string {
  return layerName(`${slug}${index > 1 ? ` ${index}` : ''}`, 'Concept')
}

export const layersDir = (name: string) => `art/ui/${layerName(name, 'Concept')}/layers`
export const layersManifestPath = (name: string) => `${layersDir(name)}/${LAYERS_FILE}`
export const layerFile = (concept: string, layer: string) => `${layersDir(concept)}/${layerName(layer)}.png`

// Maps loose kind words from a model or a person onto the five kinds.
export function layerKind(raw: unknown): ArtLayerKind | null {
  const s = String(raw ?? '').toLowerCase().trim()
  if (!s) return null
  if ((LAYER_KINDS as readonly string[]).includes(s)) return s as ArtLayerKind
  if (/plate|scene|environment/.test(s)) return 'background'
  if (/panel|card|frame|texture|banner|window|plaque/.test(s)) return 'panel'
  if (/back|\bbg\b/.test(s)) return 'background'
  if (/logo|emblem|crest|badge|wordmark/.test(s)) return 'logo'
  if (/char|person|player|hero|figure|mascot|avatar/.test(s)) return 'character'
  if (/icon|symbol|glyph|pictogram/.test(s)) return 'icon'
  return null
}

// Background plates are opaque; everything else is cut out.
export const defaultTransparent = (kind: ArtLayerKind) => kind !== 'background'

// Size for a layer: the concept's own size for the background plate (when it is a plain WxH), a
// portrait frame for cards and characters, square for icons and logos.
export function defaultLayerSize(kind: ArtLayerKind, concept?: { width?: number; height?: number; size?: string }): string {
  if (kind === 'background') {
    const w = concept?.width
    const h = concept?.height
    if (w && h) return w > h ? '1536x1024' : w < h ? '1024x1536' : '1024x1024'
    return /^\d+x\d+$/.test(concept?.size ?? '') ? concept!.size! : '1536x1024'
  }
  if (kind === 'character') return '1024x1536'
  if (kind === 'panel') return '1024x1536'
  return '1024x1024'
}

const SIZE_RE = /^(auto|\d{2,4}x\d{2,4})$/

// Cleans a layer list (from the model, the page or an agent): known kinds, PascalCase unique names,
// a prompt, transparency by kind when unset, at most MAX_LAYERS.
export function normalizeLayerSpecs(raw: unknown, concept?: { width?: number; height?: number; size?: string }): ArtLayerSpec[] {
  const list = Array.isArray(raw) ? raw : []
  const out: ArtLayerSpec[] = []
  const seen = new Set<string>()
  for (const r of list) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const kind = layerKind(o.kind) ?? layerKind(o.name) ?? 'panel'
    const prompt = String(o.prompt ?? o.description ?? '').replace(/\s+/g, ' ').trim().slice(0, 4000)
    let name = layerName(String(o.name ?? ''), kind === 'background' ? 'Background' : 'Layer')
    if (!prompt && !o.name) continue
    let k = 2
    const stem = name
    while (seen.has(name)) name = `${stem}${k++}`
    seen.add(name)
    const size = typeof o.size === 'string' && SIZE_RE.test(o.size.trim()) ? o.size.trim() : defaultLayerSize(kind, concept)
    out.push({ name, kind, prompt: prompt || `${LAYER_KIND_LABELS[kind]} ${name}`, transparent: typeof o.transparent === 'boolean' ? o.transparent : defaultTransparent(kind), size })
    if (out.length >= MAX_LAYERS) break
  }
  return out
}

// ---------------------------------------------------------------- the vision proposal

export const LAYER_SYSTEM = `You are a senior Roblox UI artist. You look at a game UI mockup and decide which parts must be cut out as image assets and which are rebuilt as real Roblox UI.
Rules:
- Text, numbers, headlines, nav tabs, buttons, labels, prices, timers and simple shapes are NEVER image layers: they are rebuilt as TextLabel / TextButton / Frame with UICorner, UIStroke and UIGradient.
- Always propose exactly one background plate (kind "background"): the full scene with ALL UI, text, logos, cards, panels and characters removed.
- Propose one panel texture (kind "panel") per visually distinct card / panel / banner background that has painted detail a Frame cannot reproduce (illustration, texture, art inside the card). It has no text, no buttons and no icons on it. Cards that share a look share one layer.
- Propose logos (kind "logo") and icons (kind "icon") that are drawn art, each on a transparent background. Skip icons that are plain glyphs.
- If there is a character or mascot, propose one character render (kind "character") on a transparent background.
- Names are PascalCase keys for a Luau theme table, describing the role (Background, QuickJoinCard, RankedCard, ShopIcon, GameLogo, Striker).
- Each prompt is self-contained and describes exactly what to render for that layer (subject, materials, colours, lighting, framing), because the image model sees the mockup only as a style reference.
Answer with JSON only.`

export function layerProposalPrompt(o: { conceptPrompt?: string; width?: number; height?: number; hint?: string } = {}): string {
  return [
    'The attached image is a game UI mockup for a Roblox experience. Split it into image layers following the rules.',
    o.width && o.height ? `Mockup size: ${o.width}x${o.height}.` : '',
    o.conceptPrompt ? `It was generated from this brief: ${o.conceptPrompt.replace(/\s+/g, ' ').slice(0, 1500)}` : '',
    o.hint ? `The user adds: ${o.hint.slice(0, 600)}` : '',
    `Reply with {"layers":[{"name":"Background","kind":"background|panel|icon|logo|character","prompt":"...","transparent":false}]} and at most ${MAX_LAYERS} layers, background first.`
  ]
    .filter(Boolean)
    .join('\n')
}

// The model's answer -> raw layer objects (null when it holds no layer list).
export function parseLayerProposal(raw: string): unknown[] | null {
  const text = String(raw ?? '')
  const candidates: string[] = []
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  if (fence) candidates.push(fence[1])
  const a = text.indexOf('{')
  const b = text.lastIndexOf('}')
  if (a >= 0 && b > a) candidates.push(text.slice(a, b + 1))
  const la = text.indexOf('[')
  const lb = text.lastIndexOf(']')
  if (la >= 0 && lb > la) candidates.push(text.slice(la, lb + 1))
  for (const c of candidates) {
    try {
      const v = JSON.parse(c) as unknown
      const list = Array.isArray(v) ? v : v && typeof v === 'object' ? (v as { layers?: unknown }).layers : null
      if (Array.isArray(list) && list.length) return list
    } catch {
      // try the next candidate
    }
  }
  return null
}

// A starter list when no vision model is reachable: the person edits it before generating.
export function defaultLayerSpecs(concept?: { width?: number; height?: number; size?: string; prompt?: string }): ArtLayerSpec[] {
  const about = concept?.prompt ? ` of this scene: ${concept.prompt.replace(/\s+/g, ' ').slice(0, 300)}` : ''
  return normalizeLayerSpecs(
    [
      { name: 'Background', kind: 'background', prompt: `The background scene${about}, with every UI element, text, logo, card, panel and character removed.` },
      { name: 'CardTexture', kind: 'panel', prompt: 'The background texture of the main card / panel, front-on, without any text, buttons or icons on it.' },
      { name: 'Logo', kind: 'logo', prompt: 'The game logo or emblem alone.' }
    ],
    concept
  )
}

// ---------------------------------------------------------------- generation

const KIND_DIRECTION: Record<ArtLayerKind, string> = {
  background:
    'Output a clean background plate at the same framing, camera and aspect as the reference: remove ALL UI, text, numbers, logos, buttons, nav tabs, cards, panels, icons and characters, and paint plausible scenery where they were. Keep the depth, light sources and atmosphere.',
  panel:
    'Output one isolated card / panel background texture, front-on with no perspective, filling most of the frame with even padding: keep its shape, border, material and painted detail, but NO text, numbers, buttons or icons on it. Nothing outside its shape.',
  icon: 'Output one isolated icon, centered with generous padding, bold and readable at small size. No text, no frame around it unless it is part of the icon.',
  logo: 'Output the logo / emblem alone, centered with padding, drawn exactly as in the reference (keep its lettering only if the lettering is part of the logo mark).',
  character: 'Output the character alone, full figure in the same pose, outfit and lighting as the reference, no ground, no shadow plate, no UI.'
}

// Prompt for one layer: the layer's own prompt, the kind's direction, and the style lock to the
// concept (sent as the reference image).
export function layerPrompt(spec: ArtLayerSpec): string {
  return [
    `Asset layer "${spec.name}" (${LAYER_KIND_LABELS[spec.kind]}) cut from the attached game UI mockup: ${spec.prompt.trim()}`,
    KIND_DIRECTION[spec.kind],
    'Match the reference image exactly in art style, rendering, palette, lighting, materials and line weight, so this layer drops back into the same screen.',
    spec.transparent ? 'Fully transparent background around the subject (alpha), no backdrop colour, no checkerboard.' : '',
    'No text unless it is part of a logo, no watermark, no signature.'
  ]
    .filter(Boolean)
    .join('\n')
}

// ---------------------------------------------------------------- theme snippet

// `{ Background = "rbxassetid://…", QuickJoinCard = "rbxassetid://…" }` for the imported layers, in
// manifest order. Layers without an id yet are left out.
export function themeSnippet(m: Pick<ArtLayerManifest, 'layers'> | null | undefined): string {
  const rows = (m?.layers ?? []).filter((l) => l.uri)
  if (!rows.length) return '{}'
  return `{\n${rows.map((l) => `\t${layerName(l.name)} = "${l.uri}",`).join('\n')}\n}`
}
