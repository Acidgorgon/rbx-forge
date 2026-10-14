// Figma font families -> Roblox font families (rbxasset://fonts/families/<Name>.json, the list in
// the creator docs' Enum.Font / Font reference). Exact when Roblox ships the same family; otherwise
// the closest built-in family by style, with a fallback by generic class. Pure.

export const ROBLOX_FAMILIES = [
  'AccanthisADFStd', 'AmaticSC', 'Arimo', 'Balthazar', 'Bangers', 'BuilderExtended', 'BuilderMono', 'BuilderSans', 'ComicNeueAngular', 'Creepster', 'DenkOne',
  'Fondamento', 'FredokaOne', 'GothamSSm', 'GrenzeGotisch', 'Guru', 'HighwayGothic', 'Inconsolata', 'IndieFlower', 'JosefinSans', 'Jura', 'Kalam', 'LegacyArial',
  'LuckiestGuy', 'Merriweather', 'Michroma', 'Montserrat', 'Nunito', 'Oswald', 'PatrickHand', 'PermanentMarker', 'PressStart2P', 'Roboto', 'RobotoCondensed',
  'RobotoMono', 'RomanAntique', 'Sarpanch', 'SourceSansPro', 'SpecialElite', 'TitilliumWeb', 'Ubuntu', 'Zekton'
] as const

const key = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, '')

// Same family in Roblox (exact).
const EXACT: Record<string, string> = {}
for (const f of ROBLOX_FAMILIES) EXACT[key(f)] = f
Object.assign(EXACT, {
  gotham: 'GothamSSm',
  gothamssm: 'GothamSSm',
  sourcesans3: 'SourceSansPro',
  sourcesanspro: 'SourceSansPro',
  fredoka: 'FredokaOne',
  fredokaone: 'FredokaOne',
  pressstart2p: 'PressStart2P',
  buildersans: 'BuilderSans',
  accanthisadfstd: 'AccanthisADFStd'
})

// Close substitutes (approximated): same class of letterform.
const NEAR: Record<string, string> = {
  inter: 'BuilderSans',
  sfpro: 'BuilderSans',
  sfprodisplay: 'BuilderSans',
  sfprotext: 'BuilderSans',
  segoeui: 'BuilderSans',
  helvetica: 'Arimo',
  helveticaneue: 'Arimo',
  arial: 'Arimo',
  poppins: 'Montserrat',
  manrope: 'BuilderSans',
  dmsans: 'BuilderSans',
  figtree: 'BuilderSans',
  outfit: 'Montserrat',
  plusjakartasans: 'BuilderSans',
  lato: 'SourceSansPro',
  opensans: 'SourceSansPro',
  notosans: 'SourceSansPro',
  ibmplexsans: 'SourceSansPro',
  rubik: 'Nunito',
  quicksand: 'Nunito',
  varelaround: 'Nunito',
  baloo2: 'FredokaOne',
  baloo: 'FredokaOne',
  chewy: 'FredokaOne',
  lilitaone: 'LuckiestGuy',
  titanone: 'LuckiestGuy',
  bungee: 'LuckiestGuy',
  anton: 'Oswald',
  bebasneue: 'Oswald',
  impact: 'Oswald',
  barlowcondensed: 'RobotoCondensed',
  barlow: 'BuilderSans',
  orbitron: 'Michroma',
  exo2: 'TitilliumWeb',
  rajdhani: 'Sarpanch',
  playfairdisplay: 'Merriweather',
  georgia: 'Merriweather',
  timesnewroman: 'Merriweather',
  lora: 'Merriweather',
  jetbrainsmono: 'RobotoMono',
  firacode: 'RobotoMono',
  sfmono: 'RobotoMono',
  menlo: 'RobotoMono',
  couriernew: 'SpecialElite',
  comicneue: 'ComicNeueAngular',
  comicsansms: 'ComicNeueAngular'
}

export const ROBLOX_WEIGHTS: [number, string][] = [
  [100, 'Thin'],
  [200, 'ExtraLight'],
  [300, 'Light'],
  [400, 'Regular'],
  [500, 'Medium'],
  [600, 'SemiBold'],
  [700, 'Bold'],
  [800, 'ExtraBold'],
  [900, 'Heavy']
]

export function robloxWeight(weight: number | undefined): string {
  const w = Number.isFinite(weight) ? Number(weight) : 400
  let best = ROBLOX_WEIGHTS[3]
  for (const x of ROBLOX_WEIGHTS) if (Math.abs(x[0] - w) < Math.abs(best[0] - w)) best = x
  return best[1]
}

export interface FontMatch {
  figma: string
  family: string
  // rbxasset://fonts/families/<family>.json
  asset: string
  weight: string
  style: 'Normal' | 'Italic'
  exact: boolean
  // Why the substitute was picked (approximated fonts).
  reason?: string
}

export function mapFont(family: string | undefined, weight?: number, italic?: boolean, postScript?: string | null): FontMatch {
  const fam = (family ?? '').trim() || 'Inter'
  const k = key(fam)
  let out = EXACT[k]
  let exact = !!out
  let reason: string | undefined
  if (!out) {
    out = NEAR[k] ?? NEAR[key(fam.split(/\s+/)[0])]
    if (out) reason = `closest Roblox family to ${fam}`
  }
  if (!out) {
    const generic = /mono|code|consol|courier/i.test(fam + (postScript ?? '')) ? 'RobotoMono' : /serif|garamond|times|roman|book|slab/i.test(fam) && !/sans/i.test(fam) ? 'Merriweather' : /round|bubble|comic|cartoon/i.test(fam) ? 'FredokaOne' : 'BuilderSans'
    out = generic
    reason = `${fam} is not a Roblox font; fallback ${generic}`
  }
  exact = exact && !reason
  const style = italic || /italic|oblique/i.test(postScript ?? '') ? 'Italic' : 'Normal'
  return { figma: fam, family: out, asset: `rbxasset://fonts/families/${out}.json`, weight: robloxWeight(weight), style, exact, ...(reason ? { reason } : {}) }
}
