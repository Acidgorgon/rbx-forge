// Browser text metrics for the UI preview layout (canvas measureText with the substitute fonts).
import { cssFontShorthand } from '@shared/uiPreview/assets'
import type { MeasureText } from '@shared/uiPreview/layout'
import type { FontValue } from '@shared/uiPreview/protocol'

let ctx: CanvasRenderingContext2D | null = null
const cache = new Map<string, { w: number; h: number }>()

function context(): CanvasRenderingContext2D | null {
  if (ctx) return ctx
  try {
    ctx = document.createElement('canvas').getContext('2d')
  } catch {
    ctx = null
  }
  return ctx
}

// Roblox lays text out on lines of TextSize * LineHeight pixels.
export const LINE_HEIGHT = 1

export const measureText: MeasureText = (text, font, size, wrapWidth) => {
  const key = `${font?.family}|${font?.weight}|${font?.style}|${size}|${wrapWidth ?? ''}|${text}`
  const hit = cache.get(key)
  if (hit) return hit
  const c = context()
  let result: { w: number; h: number }
  if (!c) {
    result = { w: text.length * size * 0.5, h: size * LINE_HEIGHT }
  } else {
    c.font = cssFontShorthand(font, size)
    const lines: string[] = []
    for (const para of text.split('\n')) {
      if (!wrapWidth || wrapWidth <= 0) {
        lines.push(para)
        continue
      }
      let line = ''
      for (const word of para.split(/(\s+)/)) {
        const next = line + word
        if (line && c.measureText(next.trimEnd()).width > wrapWidth) {
          lines.push(line.trimEnd())
          line = word.trimStart()
        } else line = next
      }
      lines.push(line)
    }
    const w = Math.max(0, ...lines.map((l) => c.measureText(l).width))
    result = { w, h: lines.length * size * LINE_HEIGHT }
  }
  if (cache.size > 5000) cache.clear()
  cache.set(key, result)
  return result
}

export function clearMeasureCache(): void {
  cache.clear()
}

// Loads the substitute faces a tree uses (web fonts load lazily, and canvas measurements taken
// before that use the fallback font). Resolves true when anything new loaded; the caller then
// clears the cache and lays out again.
const loadedFaces = new Set<string>()
export async function loadTreeFonts(fonts: (FontValue | undefined)[]): Promise<boolean> {
  const wanted = new Set(fonts.map((f) => cssFontShorthand(f, 16)))
  const fresh = [...wanted].filter((f) => !loadedFaces.has(f))
  if (!fresh.length || typeof document === 'undefined' || !document.fonts) return false
  await Promise.all(fresh.map((f) => document.fonts.load(f).catch(() => [])))
  for (const f of fresh) loadedFaces.add(f)
  clearMeasureCache()
  return true
}
