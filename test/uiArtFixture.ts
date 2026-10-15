// Synthetic UI art for the Thumbnail Lab UI art tests (thumbsPromptEval, thumbsUiArt).
import { blank, type Rgba } from '../src/shared/vfx/tex/image.ts'

// A rounded button: dark outline (o px), corner radius r, a top-lit fill, on bg (null = transparent).
export function button(w: number, h: number, bw: number, bh: number, r: number, bg: [number, number, number] | null, fill: [number, number, number] = [40, 220, 60], o = 8): Rgba {
  const img = blank(w, h)
  const x0 = (w - bw) / 2
  const y0 = (h - bh) / 2
  const inRound = (px: number, py: number, ww: number, hh: number, rr: number) => {
    if (px < 0 || py < 0 || px > ww || py > hh) return false
    const cx = Math.min(Math.max(px, rr), ww - rr)
    const cy = Math.min(Math.max(py, rr), hh - rr)
    return Math.hypot(px - cx, py - cy) <= rr
  }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const px = x - x0
      const py = y - y0
      if (inRound(px, py, bw, bh, r)) {
        if (inRound(px - o, py - o, bw - 2 * o, bh - 2 * o, Math.max(1, r - o))) {
          const t = py / bh
          img.data.set([fill[0], Math.round(fill[1] * (1 - 0.25 * t)), fill[2], 255], i)
        } else img.data.set([20, 30, 20, 255], i)
      } else if (bg) img.data.set([...bg, 255], i)
    }
  return img
}

