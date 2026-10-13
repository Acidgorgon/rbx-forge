// Placeholder particle textures drawn on a canvas, used when a texture is a built-in rbxasset://
// (not shipped with Forge) or an asset the thumbnails API cannot return. White on transparent, so
// Color tints them like Roblox tints a texture. Flipbook layouts get a grid of slightly varied cells
// so frame changes stay visible.

export type PlaceholderKind = 'soft' | 'spark' | 'smoke' | 'ring' | 'trail' | 'beam'

function cell(ctx: CanvasRenderingContext2D, kind: PlaceholderKind, x: number, y: number, s: number, variant: number): void {
  const cx = x + s / 2
  const cy = y + s / 2
  const r = s / 2
  ctx.save()
  ctx.beginPath()
  ctx.rect(x, y, s, s)
  ctx.clip()
  switch (kind) {
    case 'spark': {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r)
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.25, 'rgba(255,255,255,0.8)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.translate(cx, cy)
      ctx.scale(0.35, 1)
      ctx.translate(-cx, -cy)
      ctx.fillStyle = g
      ctx.fillRect(x, y, s, s)
      break
    }
    case 'smoke': {
      // A lumpy puff: overlapping soft blobs, varied per cell.
      let seed = 17 + variant * 31
      const rand = () => ((seed = (seed * 9301 + 49297) % 233280) / 233280)
      for (let i = 0; i < 9; i++) {
        const bx = cx + (rand() - 0.5) * r * 0.9
        const by = cy + (rand() - 0.5) * r * 0.9
        const br = r * (0.35 + rand() * 0.3)
        const g = ctx.createRadialGradient(bx, by, 0, bx, by, br)
        g.addColorStop(0, 'rgba(255,255,255,0.45)')
        g.addColorStop(1, 'rgba(255,255,255,0)')
        ctx.fillStyle = g
        ctx.fillRect(x, y, s, s)
      }
      break
    }
    case 'ring': {
      const g = ctx.createRadialGradient(cx, cy, r * 0.55, cx, cy, r * 0.95)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.55, 'rgba(255,255,255,1)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, y, s, s)
      break
    }
    case 'trail':
    case 'beam': {
      // Soft edges across the width (v), solid along the length (u).
      const g = ctx.createLinearGradient(x, y, x, y + s)
      g.addColorStop(0, 'rgba(255,255,255,0)')
      g.addColorStop(0.5, 'rgba(255,255,255,1)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, y, s, s)
      break
    }
    default: {
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * (0.92 - (variant % 4) * 0.04))
      g.addColorStop(0, 'rgba(255,255,255,1)')
      g.addColorStop(0.35, 'rgba(255,255,255,0.65)')
      g.addColorStop(1, 'rgba(255,255,255,0)')
      ctx.fillStyle = g
      ctx.fillRect(x, y, s, s)
    }
  }
  ctx.restore()
}

export function placeholderTexture(kind: PlaceholderKind, grid: [number, number] = [1, 1]): HTMLCanvasElement {
  const [cols, rows] = grid
  const size = Math.max(32, Math.floor(256 / Math.max(cols, rows)))
  const canvas = document.createElement('canvas')
  canvas.width = size * cols
  canvas.height = size * rows
  const ctx = canvas.getContext('2d')!
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) cell(ctx, kind, c * size, r * size, size, r * cols + c)
  return canvas
}
