// Offline eval of the prompt builder (pure): fixture asks -> the sections and the final prompt ->
// property checks a good Roblox image prompt must pass (subject kept, transparent UI, 9-slice
// guidance, safe areas, text policy, kit palette carried, icon names split, size rules, no names of
// other games, no contradictions, length). test/thumbsPromptEval.test.ts runs every case through the
// real builder and through ThumbService with fake image backends; a regression shows as a failed
// property with the text that broke it.

import { lintSections, sectionText } from './builder.ts'
import type { PromptMode, PromptSection, SectionKey, UiKit } from './types.ts'

export interface EvalExpect {
  // Words (case-insensitive) the subject section must keep from the ask.
  subject?: string[]
  // Per section: patterns that must / must not match.
  has?: Partial<Record<SectionKey, RegExp[]>>
  hasNot?: Partial<Record<SectionKey, RegExp[]>>
  // Anywhere in the final prompt.
  prompt?: RegExp[]
  promptNot?: RegExp[]
  transparent?: boolean
  slice?: boolean
  safeArea?: boolean
  // "no text" (true) or the exact words the text section must quote.
  noText?: boolean
  text?: string
  names?: string[]
  kitPalette?: boolean
  maxChars?: number
  // Lint: no warnings, or one matching.
  clean?: boolean
  warns?: RegExp
}

export interface EvalCase {
  id: string
  ask: string
  mode: PromptMode
  names?: string[]
  kit?: UiKit
  profile?: boolean
  gameName?: string
  forbidden?: string[]
  expect: EvalExpect
}

export interface EvalBuilt {
  sections: PromptSection[]
  prompt: string
  warnings?: string[]
  names?: string[]
}

export interface EvalResult {
  id: string
  checks: { name: string; pass: boolean; detail?: string }[]
  pass: boolean
}

const KIT: UiKit = {
  samples: 3,
  palette: ['#2ec4b6', '#ff9f1c', '#1b1b3a'],
  look: { stroke: 'thick dark outline', corners: 'pill-shaped, very rounded corners', shading: 'top-lit gradient with a glossy highlight', typography: 'chunky rounded sans' },
  refIds: [],
  lines: [],
  avoid: ['avoid thin or missing outlines']
}

// The style profile the "profile" cases build with.
export const EVAL_PROFILE = {
  summary: 'close-up framing; neon saturation, palette around #ff2d55 #ffd60a; thick outline around the subject; 1 big word of huge text at the top third',
  card: {
    framing: { mode: 'close-up' as const, share: 1 },
    palette: ['#ff2d55', '#ffd60a', '#1d1d6b'],
    saturation: 'neon' as const,
    outline: 1,
    rimLight: 1,
    glow: 0,
    text: { share: 1, words: 1, size: 'huge' as const, placement: 'top third', font: 'chunky outlined sans' },
    emotions: ['shock'],
    focalContrast: 8,
    clutter: 3,
    compositions: ['subject centred, reward bursting from the egg']
  }
}

export const PROMPT_EVAL_CASES: EvalCase[] = [
  {
    id: 'thumb-shark',
    ask: 'player escaping a giant shark, shocked face',
    mode: 'thumbnail',
    gameName: 'Shark Escape',
    expect: { subject: ['escaping', 'shark'], has: { subject: [/shocked|terrified/i], roblox: [/bottom 15%/, /160 px/] }, safeArea: true, noText: true, prompt: [/Shark Escape/, /16:9/], clean: true, maxChars: 4000 }
  },
  {
    id: 'thumb-title',
    ask: 'boss fight in the lava cave with the words "BOSS RUSH"',
    mode: 'thumbnail',
    expect: { subject: ['boss', 'lava'], text: 'BOSS RUSH', has: { lighting: [/rim light|impact|glow/i], camera: [/low angle/i] }, clean: true }
  },
  {
    id: 'thumb-long-title',
    ask: 'race to the finish "THE FASTEST CAR IN THE WORLD"',
    mode: 'thumbnail',
    expect: { warns: /words/ }
  },
  {
    id: 'thumb-horror',
    ask: 'a monster chasing kids through a dark hallway',
    mode: 'thumbnail',
    expect: { has: { lighting: [/dark|cold/i], palette: [/cold|desaturated/i] }, noText: true }
  },
  {
    id: 'thumb-profile',
    ask: 'opening a legendary egg',
    mode: 'thumbnail',
    profile: true,
    expect: { has: { palette: [/#ff2d55/], style: [/style profile/i], camera: [/close-up/i] }, clean: true }
  },
  {
    id: 'thumb-copy-guard',
    ask: 'like Blox Fruits, a pirate swinging a sword',
    mode: 'thumbnail',
    forbidden: ['blox fruits', 'blox', 'fruits'],
    expect: { promptNot: [/\bblox\b/i, /\bfruits\b/i], subject: ['pirate'] }
  },
  {
    id: 'button-buy',
    ask: 'a green BUY button, glossy simulator style',
    mode: 'button',
    expect: { subject: ['green', 'buy'], transparent: true, slice: true, noText: true, has: { camera: [/orthographic|straight-on/i], palette: [/green/i], style: [/glossy/i] }, clean: true }
  },
  {
    id: 'button-label',
    ask: 'red close button that says "X"',
    mode: 'button',
    expect: { transparent: true, slice: true, text: 'X', hasNot: { avoid: [/any text/] } }
  },
  {
    id: 'button-kit',
    ask: 'a play button',
    mode: 'button',
    kit: KIT,
    expect: { kitPalette: true, has: { style: [/thick dark outline/, /very rounded/], avoid: [/outlines/] }, transparent: true }
  },
  {
    id: 'panel-shop',
    ask: 'a wooden shop window frame, fantasy',
    mode: 'panel',
    expect: { transparent: true, slice: true, has: { composition: [/empty/i], roblox: [/corners/i], style: [/fantasy|wood/i] }, noText: true, clean: true }
  },
  {
    id: 'icon-coin',
    ask: 'a golden coin with a star',
    mode: 'icon',
    expect: { subject: ['coin', 'star'], transparent: true, has: { roblox: [/48x48/] }, noText: true, clean: true }
  },
  {
    id: 'icon-set-list',
    ask: 'coin, gem, heart and key icons in a glossy cartoon style',
    mode: 'icon-set',
    expect: { names: ['coin', 'gem', 'heart', 'key'], transparent: true, has: { subject: [/\{icon\}/], roblox: [/same outline weight/i], camera: [/identical/i] }, clean: true }
  },
  {
    id: 'icon-set-colon',
    ask: 'shop icons: swords, shields, potions',
    mode: 'icon-set',
    expect: { names: ['sword', 'shield', 'potion'] }
  },
  {
    id: 'icon-set-one',
    ask: 'a trophy icon',
    mode: 'icon-set',
    expect: { warns: /at least two icons/ }
  },
  {
    id: 'hud-racing',
    ask: 'a racing HUD with speed, lap and boost',
    mode: 'hud',
    expect: { transparent: false, safeArea: true, has: { roblox: [/top bar/i, /thumbstick/i, /jump button/i], output: [/16:9/] }, clean: true }
  }
]

// One case against what the builder produced.
export function evaluateCase(c: EvalCase, b: EvalBuilt): EvalResult {
  const checks: EvalResult['checks'] = []
  const sec = (k: SectionKey) => sectionText(b.sections, k)
  const add = (name: string, pass: boolean, detail?: string) => checks.push({ name, pass, ...(pass || !detail ? {} : { detail: detail.slice(0, 200) }) })
  const e = c.expect
  const order = b.sections.map((s) => s.key).join(',')
  add('has every section', ['subject', 'composition', 'camera', 'lighting', 'palette', 'style', 'text', 'roblox', 'output', 'avoid'].every((k) => b.sections.some((s) => s.key === k && s.text.trim())), order)
  for (const w of e.subject ?? []) add(`subject keeps "${w}"`, sec('subject').toLowerCase().includes(w.toLowerCase()), sec('subject'))
  for (const [k, list] of Object.entries(e.has ?? {})) for (const re of list ?? []) add(`${k} has ${re}`, re.test(sec(k as SectionKey)), sec(k as SectionKey))
  for (const [k, list] of Object.entries(e.hasNot ?? {})) for (const re of list ?? []) add(`${k} lacks ${re}`, !re.test(sec(k as SectionKey)), sec(k as SectionKey))
  for (const re of e.prompt ?? []) add(`prompt has ${re}`, re.test(b.prompt), b.prompt.slice(0, 200))
  for (const re of e.promptNot ?? []) add(`prompt lacks ${re}`, !re.test(b.prompt), (re.exec(b.prompt)?.index ?? -1) >= 0 ? b.prompt.slice(Math.max(0, re.exec(b.prompt)!.index - 60), re.exec(b.prompt)!.index + 60) : '')
  if (e.transparent === true) add('asks for a transparent background', /transparent background/i.test(sec('output')) && /background or scene behind/i.test(sec('avoid')), sec('output'))
  if (e.transparent === false) add('opaque output', !/transparent/i.test(sec('output')), sec('output'))
  if (e.slice) add('9-slice guidance', /9-slice/i.test(sec('roblox')) && /ScaleType Slice/i.test(sec('roblox')), sec('roblox'))
  if (e.safeArea) add('safe area', /bottom 15%|top bar/i.test(sec('roblox')), sec('roblox'))
  if (e.noText) add('no text', /^no text/i.test(sec('text')), sec('text'))
  if (e.text) add(`text is exactly "${e.text}"`, sec('text').includes(`"${e.text}"`) && /exactly/i.test(sec('text')), sec('text'))
  if (e.names) add(`names ${e.names.join(', ')}`, JSON.stringify(b.names ?? []) === JSON.stringify(e.names), JSON.stringify(b.names ?? []))
  if (e.kitPalette) add('kit palette carried', (c.kit?.palette ?? []).every((h) => sec('palette').includes(h)), sec('palette'))
  add('within length', b.prompt.length <= (e.maxChars ?? 6000), `${b.prompt.length} chars`)
  add('no unfilled placeholder in prompt', !/\{(?!icon\})\w+\}/.test(b.prompt), b.prompt)
  // Contradictions: a transparent asset must not describe a scene behind it.
  if (c.mode !== 'thumbnail' && c.mode !== 'hud') add('no scene behind a transparent asset', !/\b(landscape|sky|room|forest|city)\b/i.test(['subject', 'composition', 'style', 'palette', 'lighting'].map((k) => sec(k as SectionKey)).join(' ')), sec('composition'))
  const warnings = b.warnings ?? lintSections(b.sections, c.mode, b.names)
  if (e.clean) add('lint clean', warnings.length === 0, warnings.join(' | '))
  if (e.warns) add(`lint warns ${e.warns}`, warnings.some((w) => e.warns!.test(w)), warnings.join(' | ') || '(no warnings)')
  return { id: c.id, checks, pass: checks.every((x) => x.pass) }
}

export function evalSummary(results: EvalResult[]): { cases: number; passed: number; checks: number; failed: string[] } {
  const failed = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => `${r.id}: ${c.name}${c.detail ? ` (${c.detail})` : ''}`))
  return { cases: results.length, passed: results.filter((r) => r.pass).length, checks: results.reduce((s, r) => s + r.checks.length, 0), failed }
}
