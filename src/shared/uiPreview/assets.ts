// Fonts and images for the UI preview: Roblox font families -> CSS font stacks, and image
// content strings (rbxassetid://, rbxthumb://, http(s), local paths) -> what to fetch.
//
// Bundled substitutes (OFL-1.1, via @fontsource): Montserrat for Gotham (Roblox's GothamSSm is
// proprietary), Source Sans 3 for Source Sans Pro (the same family), Fredoka for Fredoka One.
// Builder Sans (Roblox's own font) is not redistributable here, so it maps to Source Sans 3. Other
// families use the font when the user has it installed, else a generic family.

import type { FontValue } from './protocol.ts'

const FAMILY_STACKS: Record<string, string> = {
  GothamSSm: '"Montserrat", "Gotham", "Gotham SSm", sans-serif',
  Gotham: '"Montserrat", "Gotham", sans-serif',
  Montserrat: '"Montserrat", sans-serif',
  SourceSansPro: '"Source Sans 3", "Source Sans Pro", sans-serif',
  BuilderSans: '"Builder Sans", "Source Sans 3", sans-serif',
  BuilderExtended: '"Builder Extended", "Montserrat", sans-serif',
  BuilderMono: '"Builder Mono", "JetBrains Mono", monospace',
  FredokaOne: '"Fredoka", "Fredoka One", sans-serif',
  Fredoka: '"Fredoka", sans-serif',
  LegacyArial: 'Arial, Helvetica, sans-serif',
  Arial: 'Arial, Helvetica, sans-serif',
  Roboto: '"Roboto", "Segoe UI", sans-serif',
  RobotoCondensed: '"Roboto Condensed", "Arial Narrow", sans-serif',
  RobotoMono: '"Roboto Mono", "JetBrains Mono", monospace',
  Inconsolata: '"Inconsolata", "JetBrains Mono", monospace',
  PressStart2P: '"Press Start 2P", "JetBrains Mono", monospace',
  Oswald: '"Oswald", "Arial Narrow", sans-serif',
  Nunito: '"Nunito", "Fredoka", sans-serif',
  LuckiestGuy: '"Luckiest Guy", "Fredoka", fantasy',
  Bangers: '"Bangers", "Impact", fantasy',
  TitilliumWeb: '"Titillium Web", sans-serif',
  Ubuntu: '"Ubuntu", sans-serif',
  Merriweather: '"Merriweather", Georgia, serif',
  EBGaramond: '"EB Garamond", Garamond, serif',
  ComicNeueAngular: '"Comic Neue", "Comic Sans MS", cursive',
  PermanentMarker: '"Permanent Marker", cursive',
  IndieFlower: '"Indie Flower", cursive',
  PatrickHand: '"Patrick Hand", cursive',
  SpecialElite: '"Special Elite", monospace',
  Michroma: '"Michroma", sans-serif',
  Jura: '"Jura", sans-serif'
}

// Legacy Enum.Font names whose family file name differs.
const FAMILY_ALIASES: Record<string, string> = { Arcade: 'PressStart2P', Code: 'Inconsolata', Cartoon: 'ComicNeueAngular', Garamond: 'EBGaramond' }

export const FONT_WEIGHTS: Record<string, number> = {
  Thin: 100,
  ExtraLight: 200,
  Light: 300,
  Regular: 400,
  Medium: 500,
  SemiBold: 600,
  Bold: 700,
  ExtraBold: 800,
  Heavy: 900
}

export function familyName(font: FontValue | undefined): string {
  const family = font?.family ?? 'rbxasset://fonts/families/SourceSansPro.json'
  const m = /families\/([A-Za-z0-9]+)\.json/i.exec(family) ?? /^rbxassetid:\/\/(\d+)/.exec(family)
  const name = m ? m[1] : 'SourceSansPro'
  return FAMILY_ALIASES[name] ?? name
}

export interface CssFont {
  family: string
  weight: number
  style: 'normal' | 'italic'
  // True when this is a bundled or same-family face (not a generic fallback).
  close: boolean
}

export function cssFont(font: FontValue | undefined): CssFont {
  const name = familyName(font)
  const stack = FAMILY_STACKS[name]
  return {
    family: stack ?? `"${name}", "Source Sans 3", sans-serif`,
    weight: FONT_WEIGHTS[font?.weight ?? 'Regular'] ?? 400,
    style: font?.style === 'Italic' ? 'italic' : 'normal',
    close: !!stack && /Montserrat|Source Sans|Fredoka|Arial|JetBrains/.test(stack.split(',')[0])
  }
}

// "italic 900 24px Montserrat, ..." for canvas measureText and CSS `font`.
export function cssFontShorthand(font: FontValue | undefined, sizePx: number): string {
  const f = cssFont(font)
  return `${f.style} ${f.weight} ${sizePx}px ${f.family}`
}

export type ImageRef =
  | { kind: 'none' }
  | { kind: 'asset'; id: string }
  | { kind: 'thumb'; type: string; id: string; w: number; h: number }
  | { kind: 'url'; url: string }
  | { kind: 'engine'; path: string }
  | { kind: 'file'; path: string }

// Parses an Image property value.
export function parseImage(value: string): ImageRef {
  const v = value.trim()
  if (!v) return { kind: 'none' }
  let m = /^rbxassetid:\/\/(\d+)/i.exec(v)
  if (m) return { kind: 'asset', id: m[1] }
  m = /^(?:https?:\/\/)?(?:www\.)?roblox\.com\/asset\/?\?id=(\d+)/i.exec(v)
  if (m) return { kind: 'asset', id: m[1] }
  if (/^\d+$/.test(v)) return { kind: 'asset', id: v }
  if (/^rbxthumb:\/\//i.test(v)) {
    const params = new URLSearchParams(v.replace(/^rbxthumb:\/\//i, ''))
    const id = params.get('id') ?? ''
    if (!/^\d+$/.test(id)) return { kind: 'none' }
    return { kind: 'thumb', type: params.get('type') ?? 'Asset', id, w: Number(params.get('w') ?? 150) || 150, h: Number(params.get('h') ?? 150) || 150 }
  }
  if (/^rbxasset:\/\//i.test(v)) return { kind: 'engine', path: v.replace(/^rbxasset:\/\//i, '') }
  if (/^https?:\/\//i.test(v)) return { kind: 'url', url: v }
  if (/\.(png|jpe?g|webp|gif|svg)$/i.test(v)) return { kind: 'file', path: v }
  return { kind: 'none' }
}

// Roblox's public thumbnails API (no auth): https://thumbnails.roblox.com/v1/... .
// Sizes must be ones the endpoint accepts; pick the smallest that covers the request.
const ASSET_SIZES = [30, 42, 50, 60, 75, 110, 140, 150, 160, 250, 256, 300, 352, 384, 420, 512, 700, 720, 768]
const HEADSHOT_SIZES = [48, 50, 60, 75, 100, 110, 150, 180, 352, 420, 720]

function pick(sizes: number[], want: number): number {
  return sizes.find((s) => s >= want) ?? sizes[sizes.length - 1]
}

export function thumbnailRequest(ref: ImageRef): string | null {
  if (ref.kind === 'asset') return `https://thumbnails.roblox.com/v1/assets?assetIds=${ref.id}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`
  if (ref.kind === 'thumb') {
    const want = Math.max(ref.w, ref.h)
    switch (ref.type) {
      case 'AvatarHeadShot': {
        const s = pick(HEADSHOT_SIZES, want)
        return `https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${ref.id}&size=${s}x${s}&format=Png&isCircular=false`
      }
      case 'AvatarBust': {
        const s = pick([48, 50, 60, 75, 100, 150, 180, 352, 420], want)
        return `https://thumbnails.roblox.com/v1/users/avatar-bust?userIds=${ref.id}&size=${s}x${s}&format=Png&isCircular=false`
      }
      case 'Avatar': {
        const s = pick([30, 48, 60, 75, 100, 110, 140, 150, 180, 352, 420, 720], want)
        return `https://thumbnails.roblox.com/v1/users/avatar?userIds=${ref.id}&size=${s}x${s}&format=Png&isCircular=false`
      }
      case 'GameIcon': {
        return `https://thumbnails.roblox.com/v1/games/icons?universeIds=${ref.id}&returnPolicy=PlaceHolder&size=${pick([50, 128, 150, 256, 420, 512], want)}x${pick([50, 128, 150, 256, 420, 512], want)}&format=Png&isCircular=false`
      }
      case 'BadgeIcon':
        return `https://thumbnails.roblox.com/v1/badges/icons?badgeIds=${ref.id}&size=150x150&format=Png&isCircular=false`
      case 'GamePass':
        return `https://thumbnails.roblox.com/v1/game-passes?gamePassIds=${ref.id}&size=150x150&format=Png&isCircular=false`
      default: {
        const s = pick(ASSET_SIZES, want)
        return `https://thumbnails.roblox.com/v1/assets?assetIds=${ref.id}&returnPolicy=PlaceHolder&size=${s}x${s}&format=Png&isCircular=false`
      }
    }
  }
  return null
}

// Response: { data: [{ targetId, state: "Completed" | "Pending" | "Blocked" | "Error", imageUrl }] }.
export function parseThumbnailResponse(json: unknown): { state: string; imageUrl?: string } | null {
  const data = (json as { data?: unknown })?.data
  if (!Array.isArray(data) || !data.length) return null
  const first = data[0] as { state?: unknown; imageUrl?: unknown }
  return { state: String(first.state ?? 'Error'), ...(typeof first.imageUrl === 'string' && first.imageUrl ? { imageUrl: first.imageUrl } : {}) }
}
