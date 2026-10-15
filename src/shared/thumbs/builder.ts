// Prompt builder for the Thumbnail Lab and its UI art mode (pure): a short ask ("player escaping a
// giant shark", "green BUY button", "coin, gem, heart icons") becomes a structured image prompt in
// editable sections: subject, composition, camera, lighting, palette, style, text, Roblox rules,
// output and avoid. The rules here are the minimum-effort path (no model needed); a Labs model can
// expand the draft (expandSystem / mergeExpansion) and the user can edit any section before Make.
//
// Roblox conventions the rules carry:
//  - thumbnails: one focal point readable at 160x90 on the discovery page, at most three big words,
//    the bottom 15% kept quiet, colours that pop on Roblox's dark and light pages;
//  - UI assets: transparent background, readable at real phone size, 9-slice friendly buttons and
//    panels (uniform border, ornaments only in the corners, plain stretchable centre: ImageLabel
//    ScaleType Slice + SliceCenter), no baked-in labels unless asked (TextLabels localise), icon sets
//    sharing outline weight, light direction, perspective and padding;
//  - HUD mockups: clear of Roblox's top bar (menu / chat buttons top-left) and the mobile thumbstick
//    (bottom-left) and jump button (bottom-right).

import type { PromptMode, PromptSection, SectionKey, ThumbStyleProfile, UiAssetKind, UiKit } from './types.ts'

export const SECTION_ORDER: readonly SectionKey[] = ['subject', 'composition', 'camera', 'lighting', 'palette', 'style', 'text', 'roblox', 'output', 'avoid']
export const SECTION_LABELS: Record<SectionKey, string> = {
  subject: 'Subject',
  composition: 'Composition',
  camera: 'Camera',
  lighting: 'Lighting',
  palette: 'Palette',
  style: 'Style',
  text: 'Text',
  roblox: 'Roblox rules',
  output: 'Output',
  avoid: 'Avoid'
}
// Sections a model may rewrite when it expands the draft; the rest are the platform's constraints.
export const MODEL_KEYS: readonly SectionKey[] = ['subject', 'composition', 'camera', 'lighting', 'palette', 'style', 'text']

export const MAX_THUMB_WORDS = 3
export const MAX_SET_ICONS = 12
const MAX_SECTION = 700

export const UI_KINDS: Record<UiAssetKind, { label: string; transparent: boolean; n: number; example: string; does: string }> = {
  button: { label: 'Button', transparent: true, n: 4, example: 'a green BUY button, glossy simulator style', does: 'one 9-slice friendly button, transparent background' },
  panel: { label: 'Panel', transparent: true, n: 3, example: 'a wooden shop window frame, fantasy', does: 'an empty window / frame that stretches (9-slice)' },
  icon: { label: 'Icon', transparent: true, n: 4, example: 'a golden coin with a star', does: 'one object icon, readable at 48 px' },
  'icon-set': { label: 'Icon set', transparent: true, n: 3, example: 'coin, gem, heart, key, potion', does: 'matching icons: the best first icon anchors the rest' },
  hud: { label: 'HUD mockup', transparent: false, n: 2, example: 'a racing HUD with speed, lap and boost', does: 'a full-screen 16:9 layout concept' }
}
export const UI_KIND_IDS = Object.keys(UI_KINDS) as UiAssetKind[]

export function isUiKind(v: unknown): v is UiAssetKind {
  return typeof v === 'string' && v in UI_KINDS
}

// Generation size per kind and image model. The gpt-image-2 families take any WIDTHxHEIGHT with both
// sides multiples of 16 and an aspect within 1:3..3:1; older models only 1024x1024, 1536x1024 and
// 1024x1536 (shared/thumbs/size.ts has the source notes).
export function uiGenSize(kind: UiAssetKind, model: string, shape: 'square' | 'wide' | 'tall' = 'square'): string {
  const v2 = /^gpt-image-2/.test(model)
  if (kind === 'hud') return v2 ? '1920x1088' : '1536x1024'
  if (kind === 'button') return v2 ? '1536x576' : '1536x1024'
  if (kind === 'panel') return shape === 'wide' ? '1536x1024' : shape === 'tall' ? '1024x1536' : '1024x1024'
  return '1024x1024'
}

// ------------------------------------------------------------------ reading the ask

interface Genre {
  id: string
  re: RegExp
  lighting: string
  palette: string
  // The palette for UI assets when the thumbnail one talks about a backdrop.
  uiPalette?: string
  ui: string
  camera?: string
}

// Ordered: the first match wins.
export const GENRES: readonly Genre[] = [
  {
    id: 'horror',
    re: /\b(horror|scary|creepy|haunted|monster|ghost|zombie|backrooms|nightmare|doors|spooky|cursed|killer)\b/,
    lighting: 'Dark, cold blue-green ambient with one hard warm key light on the subject and a strong rim light; deep shadows and a little fog for depth',
    palette: 'Desaturated cold blues and teals with one hot accent (red or orange) on the threat',
    ui: 'Grim, worn UI: scratched metal or old wood frames, muted colours, one blood-red accent',
    camera: 'Close-up, low angle, the threat looming large behind or above the subject'
  },
  {
    id: 'simulator',
    re: /\b(simulator|sim|pets?|eggs?|hatch\w*|clicker|legendary|mythic|rebirth|upgrades?|grind|coins?|gems?|rewards?|shop)\b/,
    lighting: 'Bright, sunny key light from the upper left, soft bounce light, glossy specular highlights and sparkles on the rewards',
    palette: 'Candy-bright saturated colours: bright cyan-blue, lime green, gold and hot pink; warm gold for rewards',
    ui: 'Chunky, glossy, bubbly simulator UI: thick dark outlines, rounded corners, bright top-lit gradients and a glossy highlight streak'
  },
  {
    id: 'obby',
    re: /\b(obby|parkour|lava|tower|climb\w*|obstacles?|jump\w*)\b/,
    lighting: 'Clear bright daylight with crisp shadows; glowing lava or neon hazards',
    palette: 'Bright primary colours; glowing orange-red hazards against a clean blue sky',
    uiPalette: 'Bright primary colours with glowing orange-red accents',
    ui: 'Clean, bold, playful UI: flat bright fills, thick outlines, rounded shapes'
  },
  {
    id: 'tycoon',
    re: /\b(tycoon|factory|money|cash|business|restaurant|empire|millionaire|bank)\b/,
    lighting: 'Warm, bright light with golden highlights; money and machines glinting',
    palette: 'Money green and gold with clean whites and a bold blue sky',
    uiPalette: 'Money green and gold with clean whites',
    ui: 'Polished business UI: green and gold, rounded cards, coin and cash motifs, clean outlines',
    camera: 'Medium-wide shot: the subject in front of a big, impressive build'
  },
  {
    id: 'combat',
    re: /\b(fight\w*|battle\w*|boss|swords?|guns?|combat|pvp|war|attack\w*|weapons?|duel|ninja|samurai|anime|powers?|abilit\w+|katana|blade|arena)\b/,
    lighting: 'Dramatic: warm key light and a cool rim light, impact flashes, sparks and energy glow around the action',
    palette: 'High-contrast complementary pairs (orange vs teal, purple vs gold) with glowing energy accents',
    ui: 'Sharp, heroic UI: angular beveled metal or energy frames, strong contrast, glowing accents',
    camera: 'Close-up, low angle with a wide lens: the clash or power move at the moment of impact'
  },
  {
    id: 'racing',
    re: /\b(rac(e|es|ing)|cars?|drift\w*|speed\w*|kart|finish line|track|lap|boost)\b/,
    lighting: 'Bright sun with motion streaks, speed lines and dust; glints on the paint',
    palette: 'Bold racing colours: red, yellow and electric blue against a motion-blurred background',
    uiPalette: 'Bold racing colours: red, yellow and electric blue with white and black accents',
    ui: 'Fast, sporty HUD style: slanted shapes, italic chunky numbers, chevrons, high-contrast colours',
    camera: 'Low, dynamic three-quarter angle with strong motion blur on the background'
  },
  {
    id: 'scifi',
    re: /\b(sci-?fi|space|robots?|aliens?|cyber\w*|neon|future|futuristic|lasers?|mechs?|galaxy|planets?)\b/,
    lighting: 'Neon rim lights and emissive glows in a dark scene, volumetric light beams',
    palette: 'Deep navy and black with neon cyan, magenta and lime accents',
    ui: 'Sleek sci-fi UI: thin glowing borders, cut corners, translucent dark panels, neon accents'
  },
  {
    id: 'fantasy',
    re: /\b(fantasy|magic\w*|wizards?|dragons?|castles?|medieval|rpg|quests?|dungeons?|kingdom|spells?|potions?)\b/,
    lighting: 'Warm magical light: golden key light, glowing spell effects, soft god rays',
    palette: 'Rich royal purple, emerald and gold with warm torch-light orange',
    ui: 'Ornate fantasy UI: carved wood or stone frames, gold trim, parchment fills, gem accents'
  },
  {
    id: 'cozy',
    re: /\b(cozy|cosy|cute|kawaii|roleplay|rp|house|home|cafe|farm\w*|garden|pastel|adopt)\b/,
    lighting: 'Soft, warm daylight with gentle shadows and a cosy glow',
    palette: 'Soft pastels: peach, mint, lavender and cream with one saturated accent',
    ui: 'Soft, friendly UI: pastel fills, very rounded corners, gentle shadows, thin warm outlines'
  }
]

const DEFAULT_GENRE: Omit<Genre, 're'> = {
  id: 'default',
  lighting: 'Bright key light from the upper left and a strong rim light separating the subject from the background',
  palette: "Saturated, high-contrast colours; the subject's colour contrasts the background",
  uiPalette: 'Saturated, high-contrast colours that stay readable on any game background',
  ui: 'Clean, bold Roblox game UI: thick dark outline, rounded corners, a top-lit gradient fill and a soft inner highlight'
}

const EMOTIONS: [RegExp, string][] = [
  [/\b(shock\w*|surpris\w*|omg|stunned|jaw)\b/, 'shocked, wide-eyed, open-mouthed'],
  [/\b(scared|fear\w*|terrified|panic\w*|escap\w*|running away|flee\w*|chase\w*)\b/, 'terrified, fleeing in panic'],
  [/\b(angry|rage|furious|mad)\b/, 'angry and determined'],
  [/\b(happy|celebrat\w*|win\w*|victory|cheer\w*|party)\b/, 'joyful, celebrating'],
  [/\b(excit\w*|hype\w*|amazed|wow)\b/, 'excited and amazed'],
  [/\b(sad|cry\w*|lonely)\b/, 'sad, tearful']
]

const CHARACTER_RE = /\b(players?|avatars?|noobs?|characters?|kids?|boys?|girls?|heroe?s?|guys?|people|friends|npcs?|faces?|me|you|bacon|pro)\b/
const COLOR_RE = /\b(red|orange|yellow|gold(en)?|green|lime|teal|cyan|blue|navy|purple|violet|magenta|pink|white|black|silver|grey|gray|brown|bronze|rainbow|pastel|neon)\b/g
const STYLE_RE = /\b(glossy|flat|cartoon(y)?|pixel(ated)?|neon|metal(lic)?|wood(en)?|stone|crystal|cute|minimal(ist)?|3d|2d|hand-?drawn|sci-?fi|fantasy|retro|vaporwave|chunky|bubbly|sleek|grunge|gritty|low-?poly|anime|realistic|painterly|sketchy|clean|modern|futuristic|medieval|toy-?like|clay|plastic|glass)\b/g

export interface AskInfo {
  subject: string
  genre: Omit<Genre, 're'>
  emotion?: string
  characters: boolean
  // Words in quotes: the only text the image may show.
  quoted: string[]
  colors: string[]
  styles: string[]
  // ALL-CAPS words that look like a label the user may want written ("BUY", "VIP").
  caps: string[]
}

const NOT_LABELS = new Set(['UI', 'GUI', 'HUD', 'RPG', 'FPS', 'PVP', 'NPC', 'XP', '2D', '3D', 'OK', 'TV', 'RP', 'UGC', 'AI'])

const clean = (s: string) => s.replace(/\s+/g, ' ').trim()
const cap = (s: string, n = MAX_SECTION) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s)
const sentence = (s: string) => {
  const t = clean(s)
  if (!t) return ''
  return /[.!?…]$/.test(t) ? t : `${t}.`
}
const uniq = <T>(xs: T[]) => [...new Set(xs)]

export function analyzeAsk(ask: string): AskInfo {
  const raw = clean(String(ask ?? ''))
  const lower = raw.toLowerCase()
  const quoted = [...raw.matchAll(/["“”]([^"“”]{1,40})["“”]/g)].map((m) => clean(m[1])).filter(Boolean)
  const subject = clean(
    raw
      .replace(/^(please\s+)?(make|create|draw|generate|design|give me)\s+(me\s+)?/i, '')
      .replace(/^(an?\s+)?(roblox\s+)?(thumbnail|image|picture)\s+(of|for|showing)\s+/i, '')
  ).replace(/[.\s]+$/, '')
  const genre = GENRES.find((g) => g.re.test(lower)) ?? { ...DEFAULT_GENRE, re: /$^/ }
  const { re: _re, ...g } = genre as Genre
  return {
    subject,
    genre: g,
    emotion: EMOTIONS.find(([re]) => re.test(lower))?.[1],
    characters: CHARACTER_RE.test(lower),
    quoted: uniq(quoted),
    colors: uniq([...lower.matchAll(COLOR_RE)].map((m) => m[0])),
    styles: uniq([...lower.matchAll(STYLE_RE)].map((m) => m[0])),
    caps: uniq([...raw.replace(/["“”][^"“”]*["“”]/g, ' ').matchAll(/\b[A-Z][A-Z0-9!?]{1,11}\b/g)].map((m) => m[0]).filter((w) => !NOT_LABELS.has(w)))
  }
}

const SINGULAR_KEEP = /(ss|us|is|ics)$/
function singular(w: string): string {
  const s = w.trim()
  if (s.length <= 3 || SINGULAR_KEEP.test(s)) return s
  if (/ies$/.test(s)) return `${s.slice(0, -3)}y`
  if (/(ch|sh|x|z)es$/.test(s)) return s.slice(0, -2)
  return s.endsWith('s') ? s.slice(0, -1) : s
}

// Icon names from an ask: "coin, gem, heart and key icons", "icons for coins / gems / hearts",
// "shop icons: sword, shield, potion". Style clauses ("in a glossy style") are dropped.
export function splitNames(ask: string): string[] {
  let s = clean(String(ask ?? ''))
  if (s.includes(':')) s = s.slice(s.indexOf(':') + 1)
  s = s
    .replace(/^(please\s+)?(make|create|draw|generate|design)\s+(me\s+)?/i, '')
    .replace(/^(an?\s+|the\s+)?(consistent\s+|matching\s+)?(set of\s+|icon set\s+(of|for)\s+|icons?\s+(for|of)\s+)/i, '')
  const parts = s
    .split(/\s*(?:,|;|\/|\+|\n|\band\b|&)\s*/i)
    .map((p) =>
      p
        .replace(/\s+icons?\b.*$/i, '')
        .replace(/\s+(in|with)\s+(a|an|the)\s+.*$/i, '')
        .replace(/\s+(style|look|theme)\b.*$/i, '')
        .replace(/^(an?|the)\s+/i, '')
        .replace(/[."]+$/g, '')
        .trim()
    )
    .filter((p) => p && p.length <= 40 && !/^(icons?|set|ui)$/i.test(p))
    .map((p) => p.split(' ').map((w, i, a) => (i === a.length - 1 ? singular(w) : w)).join(' ').toLowerCase())
  return uniq(parts).slice(0, MAX_SET_ICONS)
}

// ------------------------------------------------------------------ building

export interface BuildContext {
  ask: string
  mode: PromptMode
  gameName?: string
  // Thumbnails: the chosen style profile, the user's learned taste, base screenshots attached.
  profile?: Pick<ThumbStyleProfile, 'summary' | 'card'> | null
  taste?: string[]
  bases?: number
  // UI art: the learned kit, the icon names, the generation size.
  kit?: UiKit | null
  names?: string[]
  size?: string
}

const sec = (key: SectionKey, text: string, source: PromptSection['source'] = 'rules'): PromptSection => ({ key, label: SECTION_LABELS[key], text: cap(clean(text)), source })

const FRAMING_CAMERA: Record<string, string> = {
  'close-up': 'Close-up on the subject, slightly low angle, wide-angle lens for drama (exaggerated perspective)',
  medium: 'Medium shot: the subject from the waist up with the action around it, slightly low angle',
  scene: 'Wide shot that shows the place, with the subject still large in the foreground'
}

export const THUMB_RULES = `One focal point that reads at phone size (160 px wide); strong value contrast and a rim light or outline separating the subject; saturated colours that stand out on both dark and light pages; at most ${MAX_THUMB_WORDS} large words of text or none, never the game's full title; keep the bottom 15% free of text and key elements.`

function thumbSections(c: BuildContext, a: AskInfo): PromptSection[] {
  const p = c.profile
  const out: PromptSection[] = []
  const who = a.characters ? ` Roblox avatars${a.emotion ? ` look ${a.emotion}` : ' with big, readable expressions'}; faces large enough to read on a phone.` : a.emotion ? ` Mood: ${a.emotion}.` : ''
  out.push(sec('subject', `${sentence(a.subject || 'the most exciting moment of the game')}${who}`))
  const comp = p?.card.compositions[0]
  out.push(
    sec(
      'composition',
      `${comp ? `${sentence(comp)} ` : ''}One clear focal point: the subject big (about half the frame height) on the left or right third, the action or threat opposite it; a simple, depth-blurred background; a strong diagonal flow.${a.quoted.length || (p && p.card.text.share >= 0.5) ? ' Leave room for the title words in the top third.' : ''}`,
      comp ? 'kit' : 'rules'
    )
  )
  out.push(sec('camera', sentence(p ? FRAMING_CAMERA[p.card.framing.mode] : (a.genre.camera ?? 'Medium close-up, slightly low angle, a wide lens for energy')), p ? 'kit' : 'rules'))
  out.push(sec('lighting', `${a.genre.lighting}.`))
  const pal = p?.card.palette.length ? `Palette around ${p.card.palette.slice(0, 5).join(' ')} (${p.card.saturation} saturation)` : a.colors.length ? `Built around ${a.colors.join(', ')}, saturated and high-contrast` : a.genre.palette
  out.push(sec('palette', /contrast/i.test(pal) ? sentence(pal) : `${pal}; the subject's colours contrast the background.`, p?.card.palette.length ? 'kit' : 'rules'))
  const baseStyle = p ? `From the style profile: ${p.summary}` : 'Polished 3D Roblox render: blocky avatars with smooth plastic materials, stylised and clean, crisp edges, rich colour, a slight glow on key elements'
  const style = [baseStyle, extraStyles(a.styles, baseStyle), c.taste?.length ? `This creator's taste: ${c.taste.join('; ')}` : '']
  out.push(sec('style', style.filter(Boolean).map(sentence).join(' '), p || c.taste?.length ? 'kit' : 'rules'))
  const words = a.quoted.join(' ').split(/\s+/).filter(Boolean)
  const font = p?.card.text.font ? `, ${p.card.text.font}` : ''
  const where = p?.card.text.placement ? ` at the ${p.card.text.placement}` : ' in the top third'
  out.push(
    sec(
      'text',
      words.length
        ? `Title text exactly "${words.slice(0, 8).join(' ')}" (spelled correctly, nothing else written), big chunky letters with a thick dark outline and a bright gradient fill${font}${where}, slightly tilted.`
        : p && p.card.text.share >= 0.5 && p.card.text.words > 0
          ? `One or two big punchy words (not the game's title)${font}${where}, thick outline, readable at phone size.`
          : 'No text: the picture tells the story.'
    )
  )
  out.push(sec('roblox', THUMB_RULES))
  out.push(sec('output', '16:9 landscape image framed for 1920x1080; full-bleed artwork with no borders, frames or letterboxing.'))
  out.push(sec('avoid', "Roblox logos or interface, other games' characters or logos, watermarks, borders, tiny unreadable details, a cluttered background, a blurry subject, broken avatar anatomy."))
  return out
}

// Style words from the ask that the base style line does not already say.
function extraStyles(styles: string[], base: string): string {
  const more = styles.filter((w) => !base.toLowerCase().includes(w))
  return more.length ? `Look: ${more.join(', ')}` : ''
}

const KIND_NOUN: Record<UiAssetKind, string> = { button: 'button', panel: 'panel', icon: 'icon', 'icon-set': 'icon', hud: 'HUD mockup' }

function uiSubject(kind: UiAssetKind, a: AskInfo, names: string[]): string {
  const s = a.subject.replace(/\b(ui|gui)\b/gi, '').replace(/\s+/g, ' ').trim()
  const label = a.quoted[0]
  switch (kind) {
    case 'button':
      return `A single game UI button: ${s || 'a primary action button'}.${label ? ` It reads "${label}".` : ''}`
    case 'panel':
      return `An empty game UI panel (a window frame): ${s || 'a general menu window'}. The inside is left empty for content added in Roblox.`
    case 'icon':
      return `A single game icon: ${s || 'a reward item'}.`
    case 'icon-set':
      return `One icon from a matching set of game icons (${names.length ? names.join(', ') : 'the items named below'}). This icon: {icon}.`
    case 'hud':
      return `A full-screen game HUD mockup: ${s || 'the main gameplay HUD'}.`
  }
}

function uiSections(c: BuildContext, a: AskInfo): PromptSection[] {
  const kind = c.mode as UiAssetKind
  const kit = c.kit && c.kit.samples > 0 ? c.kit : null
  const names = c.names?.length ? c.names : kind === 'icon-set' ? splitNames(c.ask) : []
  const flat = a.styles.includes('flat') || a.styles.includes('2d') || a.styles.includes('minimal') || a.styles.includes('minimalist')
  const out: PromptSection[] = [sec('subject', uiSubject(kind, a, names))]
  const comp: Record<UiAssetKind, string> = {
    button: 'The button alone, centred, about 85% of the canvas width with even empty padding all round; a wide rounded-rectangle or pill shape that does not touch the canvas edges.',
    panel: 'The panel alone, centred, about 90% of the canvas; a rounded-rectangle frame with an optional header strip at the top; the centre is a plain, empty fill with no content, icons or text.',
    icon: 'One object, centred, filling about 80% of the canvas with even padding; a bold, instantly recognisable silhouette; no scene, ground or extra objects.',
    'icon-set': 'One object, centred, filling about 80% of the canvas with the same padding as every other icon in the set; a bold, recognisable silhouette; no scene, ground or extra objects.',
    hud: "A 16:9 game screen: blurred gameplay behind; HUD elements around the edges: currency and stats top-left below Roblox's top bar, menu buttons down one side, the main action buttons or hotbar bottom-centre; the centre of the screen stays clear for gameplay."
  }
  out.push(sec('composition', comp[kind]))
  const camera: Record<UiAssetKind, string> = {
    button: 'Straight-on orthographic front view: no perspective, tilt or 3D rotation; flat to the screen.',
    panel: 'Straight-on orthographic front view: no perspective, tilt or 3D rotation; flat to the screen.',
    icon: flat ? 'Flat, straight-on 2D view.' : 'Slight three-quarter view from a little above, like a toy product shot.',
    'icon-set': flat ? 'Flat, straight-on 2D view, identical for every icon.' : 'Slight three-quarter view from a little above, identical for every icon in the set.',
    hud: 'A straight-on screen capture, exactly as the player sees it.'
  }
  out.push(sec('camera', camera[kind]))
  const light: Record<UiAssetKind, string> = {
    button: 'Soft key light from the top: a lighter top edge or glossy highlight and a darker bottom bevel / lip (about 10% of the height) so it looks pressable; no cast shadow outside the shape.',
    panel: 'Even, soft top light: a subtle highlight on the top edge and a soft inner shadow along the border; no cast shadow outside the shape.',
    icon: 'Key light from the top-left with a crisp specular highlight and soft ambient occlusion; no cast shadow on the ground.',
    'icon-set': 'Key light from the top-left on every icon, a crisp specular highlight and soft ambient occlusion; no cast shadow on the ground.',
    hud: `${a.genre.lighting} on the gameplay behind; the HUD itself evenly lit and crisp.`
  }
  out.push(sec('lighting', light[kind]))
  const meaning = kind === 'button' ? ' The colour says what it does: green to go / buy, red to close or for danger, gold for rewards, blue for info.' : ''
  const palette = kit?.palette.length
    ? sec('palette', `Use this game's UI palette: ${kit.palette.slice(0, 6).join(' ')}.${meaning} One main fill with a lighter top and a darker shade, a dark outline and a light highlight.`, 'kit')
    : sec('palette', `${a.colors.length ? `Built around ${a.colors.join(', ')}` : kind === 'hud' ? a.genre.palette : (a.genre.uiPalette ?? a.genre.palette)}.${meaning} One main fill with a lighter top and a darker shade, a dark outline and a light highlight.`)
  out.push(palette)
  const kitLook = kit ? [kit.look.stroke, kit.look.corners, kit.look.shading].filter(Boolean) : []
  out.push(
    sec(
      'style',
      [kitLook.length ? `Match this game's UI kit: ${kitLook.join(', ')}` : a.genre.ui, extraStyles(a.styles, kitLook.length ? kitLook.join(' ') : a.genre.ui), 'Crisp vector-clean edges, bold readable shapes, polished mobile-game finish'].filter(Boolean).map(sentence).join(' '),
      kitLook.length ? 'kit' : 'rules'
    )
  )
  const typo = kit?.look.typography ? ` Lettering feel: ${kit.look.typography}.` : ''
  const label = a.quoted[0]
  const text: Record<UiAssetKind, string> = {
    button: label ? `The label "${label}" exactly (spelled correctly, nothing else written): chunky rounded bold sans-serif, white with a dark outline, centred, about 45% of the button height.${typo}` : 'No text, letters or numbers: the label is a separate Roblox TextLabel so it can be localised.',
    panel: label ? `Only the title "${label}" on the header strip, chunky bold letters with an outline.${typo} No other text or placeholder content.` : 'No text and no placeholder content: the title and content are added in Roblox.',
    icon: label ? `Only "${label}" if it is part of the object; otherwise no text.` : 'No text, letters or numbers.',
    'icon-set': 'No text, letters or numbers on any icon.',
    hud: `Only short placeholder numbers and one-word labels (e.g. 1,250 and "Shop"); no sentences.${typo}`
  }
  out.push(sec('text', text[kind], typo ? 'kit' : 'rules'))
  const rules: Record<UiAssetKind, string> = {
    button: 'Readable at its real size on a phone (about 150x56 px): bold shapes, a thick outline, no fine details. 9-slice friendly: outline and corners the same thickness all the way round, the middle a smooth flat or simple vertical-gradient fill, so it stretches cleanly as an ImageLabel with ScaleType Slice.',
    panel: '9-slice friendly: uniform border thickness, any ornaments only in the four corners, plain stretchable edges and centre (ImageLabel ScaleType Slice); reads cleanly at 400x300 px on a phone.',
    icon: 'Readable at 48x48 px (hotbar and shop tiles): a thick outline, few colours, one clear shape; nothing touches the canvas edge.',
    'icon-set': 'Readable at 48x48 px: a thick outline, few colours, one clear shape. Every icon in the set shares the same outline weight, light direction, perspective, padding, saturation and rendering style; nothing touches the canvas edge.',
    hud: "Keep the top strip clear for Roblox's top bar (menu, chat and backpack buttons, top-left), the bottom-left and bottom-right corners clear for the mobile thumbstick and jump button; touch targets at least 44 px; everything readable on a phone."
  }
  out.push(sec('roblox', rules[kind]))
  const size = c.size ? `, ${c.size}` : ''
  out.push(sec('output', kind === 'hud' ? `Opaque 16:9 image${size}.` : `PNG with a truly transparent background (alpha)${size}; only the ${KIND_NOUN[kind]} itself, nothing behind it.`))
  const avoid =
    kind === 'hud'
      ? 'Real brand logos, unreadable tiny text, clutter in the centre of the screen, watermarks.'
      : `A background or scene behind it, a drawn checkerboard "transparency" pattern, a device mockup or hand, watermarks or signatures, brand logos, blurry or noisy edges${label ? '' : ', any text'}.`
  out.push(sec('avoid', [avoid, ...(kit?.avoid ?? []).map((x) => `${x[0].toUpperCase()}${x.slice(1)}.`)].join(' '), kit?.avoid.length ? 'kit' : 'rules'))
  return out
}

export function buildSections(c: BuildContext): PromptSection[] {
  const a = analyzeAsk(c.ask)
  return c.mode === 'thumbnail' ? thumbSections(c, a) : uiSections(c, a)
}

export function sectionText(sections: PromptSection[] | undefined, key: SectionKey): string {
  return sections?.find((s) => s.key === key)?.text ?? ''
}

// Sections from the UI (or a stored thumbnail): known keys only, in order, trimmed and capped.
export function normalizeSections(list: unknown): PromptSection[] | undefined {
  if (!Array.isArray(list)) return undefined
  const out: PromptSection[] = []
  for (const key of SECTION_ORDER) {
    const s = list.find((x) => x && typeof x === 'object' && (x as { key?: unknown }).key === key) as Partial<PromptSection> | undefined
    if (!s) continue
    const src = s.source === 'model' || s.source === 'kit' || s.source === 'user' ? s.source : 'rules'
    out.push({ key, label: SECTION_LABELS[key], text: cap(clean(String(s.text ?? '')), 1200), source: src })
  }
  return out.length ? out : undefined
}

// "Subject: ...\nComposition: ..." (empty sections are left out).
export function renderSections(sections: PromptSection[], vars: Record<string, string> = {}): string {
  return sections
    .filter((s) => s.text.trim())
    .map((s) => `${s.label}: ${s.text.replace(/\{(\w+)\}/g, (m, k: string) => vars[k] ?? m)}`)
    .join('\n')
}

// The full UI prompt: header, reference roles, sections. `icon` fills {icon} for icon sets (and is
// appended when the user's edit removed the placeholder).
export function uiPrompt(sections: PromptSection[], o: { kind: UiAssetKind; gameName?: string; icon?: string; anchor?: boolean; kitRefs?: number }): string {
  const head = `Roblox game UI asset (${UI_KINDS[o.kind].label.toLowerCase()}) for ${o.gameName ? `the game "${o.gameName}"` : 'a Roblox game'}.`
  const refs: string[] = []
  if (o.anchor) refs.push('The first attached image is the first icon of this set: match its outline weight and colour, lighting, perspective, padding, saturation and rendering exactly, but draw a different object.')
  if (o.kitRefs) refs.push(`${o.anchor ? `The next ${o.kitRefs === 1 ? 'attached image is' : `${o.kitRefs} attached images are`}` : `The attached ${o.kitRefs === 1 ? 'image is' : `${o.kitRefs} images are`}`} UI from this game's kit: match ${o.kitRefs === 1 ? 'its' : 'their'} style (outline, corners, shading, palette, lettering), not ${o.kitRefs === 1 ? 'its' : 'their'} content.`)
  let body = renderSections(sections, o.icon ? { icon: o.icon } : {})
  if (o.icon && !sections.some((s) => s.text.includes('{icon}'))) body = `${body}\nThis icon: ${o.icon}.`
  return [head, ...refs, body, 'Original artwork only: no logos, characters or UI copied from other games or brands.'].join('\n')
}

// ------------------------------------------------------------------ lint

const SCENE_RE = /\b(landscape|sky|room|forest|city|scene behind|backdrop|environment|beach|street|on a table)\b/i

export function lintSections(sections: PromptSection[], mode: PromptMode, names: string[] = []): string[] {
  const w: string[] = []
  const text = (k: SectionKey) => sectionText(sections, k)
  const subj = text('subject').replace(/\{icon\}/g, '').replace(/^(a single game ui button|a single game icon|an empty game ui panel[^:]*|a full-screen game hud mockup)\s*:?\s*/i, '')
  if (subj.replace(/[^a-z0-9]/gi, '').length < 3) w.push('The subject is empty: say what to draw.')
  if (mode === 'thumbnail') {
    const quoted = [...text('text').matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(' ')
    const n = quoted.split(/\s+/).filter(Boolean).length
    if (n > MAX_THUMB_WORDS) w.push(`The title has ${n} words; thumbnails read best with ${MAX_THUMB_WORDS} or fewer.`)
    if (!/bottom 15%/i.test(text('roblox'))) w.push('The Roblox rules lost the "bottom 15% clear" safe area.')
  } else {
    const kind = mode as UiAssetKind
    if (UI_KINDS[kind].transparent) {
      const describing = (['subject', 'composition', 'style', 'palette', 'lighting'] as SectionKey[]).map(text).join(' ')
      if (SCENE_RE.test(describing)) w.push('This asset is exported with a transparent background, but the prompt describes a scene behind it.')
      if (!/transparent/i.test(text('output'))) w.push('The output section no longer asks for a transparent background.')
    }
    if ((kind === 'button' || kind === 'panel') && !/slice/i.test(text('roblox'))) w.push('No 9-slice guidance: the asset may not stretch cleanly in Roblox.')
    if (kind === 'icon-set' && names.length < 2) w.push('Name at least two icons (comma separated), e.g. "coin, gem, heart".')
  }
  const total = sections.reduce((s, x) => s + x.text.length + x.label.length + 2, 0)
  if (total > 6000) w.push(`The prompt is long (${total} characters); image models follow short, concrete prompts better.`)
  return w
}

// ------------------------------------------------------------------ model expansion

export const EXPAND_SYSTEM = [
  'You are an art director writing prompts for an image model (GPT Image) for a Roblox game.',
  'Turn the request and the draft into concrete, visual sections: shapes, materials, colours, lighting and layout a painter could follow. Keep what the draft already gets right.',
  'Never name other games, brands, franchises or their characters. Do not add text to the image unless the request quotes it.',
  'Answer with JSON only: {"subject":"","composition":"","camera":"","lighting":"","palette":"","style":"","text":""}, each at most 320 characters.'
].join('\n')

export function expandPrompt(ask: string, mode: PromptMode, draft: PromptSection[]): string {
  const what = mode === 'thumbnail' ? 'a 16:9 Roblox experience thumbnail' : `a Roblox UI ${UI_KINDS[mode].label.toLowerCase()}${UI_KINDS[mode].transparent ? ' on a transparent background' : ''}`
  return [`Request: ${ask}`, `Making: ${what}`, 'Draft (keep its Roblox rules, output and avoid lines; improve the rest):', renderSections(draft)].join('\n\n')
}

// The model's sections over the draft. Platform sections stay; text stays "no text" when the ask
// quoted nothing; names from other games are scrubbed. Null when the answer is not JSON.
export function mergeExpansion(draft: PromptSection[], raw: string, o: { scrub?: (s: string) => string; allowText?: boolean } = {}): PromptSection[] | null {
  const t = String(raw ?? '').replace(/```(?:json)?/g, '')
  const s = t.indexOf('{')
  const e = t.lastIndexOf('}')
  if (s < 0 || e <= s) return null
  let j: Record<string, unknown>
  try {
    j = JSON.parse(t.slice(s, e + 1)) as Record<string, unknown>
  } catch {
    return null
  }
  const scrub = o.scrub ?? ((x: string) => x)
  let changed = 0
  const out = draft.map((d) => {
    if (!MODEL_KEYS.includes(d.key)) return d
    if (d.key === 'text' && !o.allowText) return d
    const v = j[d.key]
    if (typeof v !== 'string' || !clean(v)) return d
    // Keep the {icon} placeholder an icon-set subject needs.
    let text = cap(clean(scrub(v)), 420)
    if (d.text.includes('{icon}') && !text.includes('{icon}')) text = `${text} This icon: {icon}.`
    if (text === d.text) return d
    changed++
    return { ...d, text, source: 'model' as const }
  })
  return changed ? out : null
}
