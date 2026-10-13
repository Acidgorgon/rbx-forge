// Pure helpers for image attachments (no DOM): the downscale size and which files are accepted.
// The canvas work lives in attachments.ts.

import { IMAGE_MAX_EDGE, IMAGE_MIMES } from '../../../shared/modelCaps.ts'

// Size an image is drawn at so its long edge is at most maxEdge; never upscales.
export function fitWithin(width: number, height: number, maxEdge = IMAGE_MAX_EDGE): { width: number; height: number; scaled: boolean } {
  const w = Math.max(0, Math.round(width))
  const h = Math.max(0, Math.round(height))
  const long = Math.max(w, h)
  if (!long || long <= maxEdge) return { width: w, height: h, scaled: false }
  const k = maxEdge / long
  return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)), scaled: true }
}

export function acceptedImageType(type: string): boolean {
  return (IMAGE_MIMES as readonly string[]).includes(type.toLowerCase())
}

// Output type after re-encoding: GIFs and PNGs keep transparency as PNG; WebP stays WebP; the rest JPEG.
export function encodeType(type: string): 'image/png' | 'image/jpeg' | 'image/webp' {
  const t = type.toLowerCase()
  if (t === 'image/webp') return 'image/webp'
  if (t === 'image/png' || t === 'image/gif') return 'image/png'
  return 'image/jpeg'
}

// Short size label for a thumbnail tooltip.
export function sizeLabel(bytes?: number, width?: number, height?: number): string {
  const dims = width && height ? `${width}×${height}` : ''
  const kb = bytes ? (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`) : ''
  return [dims, kb].filter(Boolean).join(' · ')
}
