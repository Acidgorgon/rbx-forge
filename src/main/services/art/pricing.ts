// Rough per-image cost estimates, shown before generating and written to each sidecar.
//
// Sources (checked 2026-10-13):
//  - developers.openai.com/api/docs/pricing: gpt-image-2.5-flare and -sunburst image output
//    $30.00 / 1M tokens, image input $8.00 / 1M, text input $5.00 / 1M (a second, half-price table is
//    listed too, the Batch / flex tier). The page points to the calculator in the image generation
//    guide for per-image numbers.
//  - Per-image output tokens from that calculator, as reported by apidog.com (read 2026-09-09):
//    1024x1024 low 196, medium 439, high 1756, xhigh 3122, max 7024; 1536x1024 low 158, medium 343,
//    high 1372, xhigh 2459, max 5488. gpt-image-2: 1024x1024 $0.006 / $0.053 / $0.211,
//    1536x1024 $0.005 / $0.041 / $0.165 (low / medium / high).
//  - gpt-image-1.5 / gpt-image-1-mini: NOT verified today (no per-image figures on the pricing page);
//    rough placeholders in the range of older published per-image prices.
// Real usage varies by prompt and model; these are estimates, never billing.

type Q = 'low' | 'medium' | 'high' | 'xhigh' | 'max'

const OUTPUT_PER_TOKEN_25 = 30 / 1_000_000
const TOKENS_25: Record<'square' | 'wide', Record<Q, number>> = {
  square: { low: 196, medium: 439, high: 1756, xhigh: 3122, max: 7024 },
  wide: { low: 158, medium: 343, high: 1372, xhigh: 2459, max: 5488 }
}

const PER_IMAGE: Record<string, Record<'square' | 'wide', Partial<Record<Q, number>>>> = {
  'gpt-image-2': { square: { low: 0.006, medium: 0.053, high: 0.211 }, wide: { low: 0.005, medium: 0.041, high: 0.165 } },
  'gpt-image-1.5': { square: { low: 0.009, medium: 0.034, high: 0.133 }, wide: { low: 0.013, medium: 0.05, high: 0.2 } },
  'gpt-image-1-mini': { square: { low: 0.005, medium: 0.011, high: 0.036 }, wide: { low: 0.006, medium: 0.015, high: 0.052 } }
}

// Image input for an edit, per reference image (about 1k tokens at $8 / 1M).
export const REFERENCE_IMAGE_USD = 0.008

function family(model: string): string {
  if (model.startsWith('gpt-image-2.5')) return 'gpt-image-2.5'
  if (model.startsWith('gpt-image-2')) return 'gpt-image-2'
  if (model.startsWith('gpt-image-1.5')) return 'gpt-image-1.5'
  if (model.startsWith('gpt-image-1-mini')) return 'gpt-image-1-mini'
  return 'gpt-image-2.5'
}

function dims(size: string): { w: number; h: number } {
  const m = /^(\d+)x(\d+)$/.exec(size)
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1024, h: 1024 }
}

export function estimateImageUsd(model: string, quality: string, size: string): number {
  const q: Q = (['low', 'medium', 'high', 'xhigh', 'max'] as const).includes(quality as Q) ? (quality as Q) : 'high'
  const { w, h } = dims(size)
  const shape: 'square' | 'wide' = w === h ? 'square' : 'wide'
  // Sizes beyond the standard three scale with pixel area against the base shape.
  const base = shape === 'square' ? 1024 * 1024 : 1536 * 1024
  const scale = Math.max(0.25, (w * h) / base)
  const fam = family(model)
  let usd: number
  if (fam === 'gpt-image-2.5') usd = TOKENS_25[shape][q] * OUTPUT_PER_TOKEN_25
  else {
    const table = PER_IMAGE[fam][shape]
    usd = table[q] ?? table.high ?? 0.2
  }
  return round(usd * scale)
}

export function estimateUsd(model: string, quality: string, size: string, n: number, references = 0): number {
  return round(estimateImageUsd(model, quality, size) * n + references * REFERENCE_IMAGE_USD)
}

export function round(usd: number): number {
  return Math.round(usd * 10000) / 10000
}

export function formatUsd(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `<$0.01`
  return `$${usd.toFixed(usd < 1 ? 3 : 2)}`
}
