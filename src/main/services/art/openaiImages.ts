// OpenAI Images API client (generations and edits). No electron imports.
//
// Verified on developers.openai.com (2026-10-13):
//  - POST https://api.openai.com/v1/images/generations
//    https://developers.openai.com/api/reference/resources/images/methods/generate
//    model: gpt-image-2.5-flare | gpt-image-2.5-sunburst (+ -2026-09-08 snapshots) | gpt-image-2 |
//      gpt-image-1.5 | gpt-image-1 | gpt-image-1-mini | chatgpt-image-latest (dall-e-2/3 retired 2026-05-12)
//    prompt <= 32000 chars; n 1-10; size auto | 1024x1024 | 1536x1024 | 1024x1536, and on the
//      gpt-image-2 family WIDTHxHEIGHT with both sides divisible by 16, aspect 1:3..3:1, max 3840x2160;
//    quality low | medium | high | auto, plus xhigh | max on the 2.5 models;
//    background transparent | opaque | auto ("When using transparent, set the output format to png or
//      webp"; transparent is GA on 2.5 flare/sunburst, preview on gpt-image-2);
//    output_format png | jpeg | webp; output_compression 0-100 (jpeg/webp); moderation low | auto.
//    GPT image models always return base64: data[].b64_json. usage is only documented for gpt-image-1.
//  - POST https://api.openai.com/v1/images/edits (JSON body)
//    https://developers.openai.com/api/reference/resources/images/methods/edit
//    images: [{ image_url: <URL or base64 data URL> } | { file_id }] (up to 16 for GPT image models);
//    mask: { image_url } | { file_id }; input_fidelity high|low (omit for gpt-image-2+); default model
//    gpt-image-2.5-sunburst; same size/quality/background/output_format/n as generations.
//  - The Responses API image_generation tool exists too (guide: /api/docs/guides/image-generation); the
//    Images API is used here because it returns n variants in one call and needs no mainline model.
//  - Guide: you may need API Organization Verification before using GPT Image models (403 says so).

export const OPENAI_BASE = 'https://api.openai.com/v1'

export type ArtFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }
) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>

export type Sleep = (ms: number) => Promise<void>
export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function globalArtFetch(): ArtFetch {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available')
  return globalThis.fetch as unknown as ArtFetch
}

export class ImageApiError extends Error {
  readonly status?: number
  readonly retryAfterSeconds?: number
  constructor(message: string, status?: number, retryAfterSeconds?: number) {
    super(message)
    this.name = 'ImageApiError'
    this.status = status
    this.retryAfterSeconds = retryAfterSeconds
  }
}

export interface ImageRequest {
  model: string
  prompt: string
  n: number
  size: string
  quality: string
  background: 'transparent' | 'opaque' | 'auto'
  outputFormat: 'png' | 'webp' | 'jpeg'
}

export interface EditRequest extends ImageRequest {
  // data: URLs (base64) of the reference images, first is the one the mask applies to.
  images: string[]
  mask?: string
}

export interface ImageResponse {
  images: Buffer[]
  outputFormat?: string
  size?: string
  quality?: string
  background?: string
  usage?: { input_tokens?: number; output_tokens?: number; total_tokens?: number }
}

export interface ClientOptions {
  apiKey: string
  fetch?: ArtFetch
  sleep?: Sleep
  // Extra attempts after 429 / 5xx (default 3).
  retries?: number
  baseUrl?: string
  signal?: AbortSignal
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const s = Number(value)
  if (Number.isFinite(s) && s >= 0) return s
  const d = Date.parse(value)
  return Number.isNaN(d) ? undefined : Math.max(0, (d - now) / 1000)
}

function errorMessage(body: string): string | undefined {
  try {
    const json = JSON.parse(body) as { error?: { message?: string; code?: string } }
    if (json.error?.message) return json.error.message
  } catch {
    // not JSON
  }
  const t = body.trim()
  return t ? t.slice(0, 300) : undefined
}

function explain(status: number, body: string): string {
  const detail = errorMessage(body)
  const help: Record<number, string> = {
    400: 'OpenAI rejected the image request (400)',
    401: 'The OpenAI API key is not valid (401). Check it in Settings > Providers > OpenAI',
    403: 'OpenAI refused the request (403). GPT Image models may need API Organization Verification on platform.openai.com',
    429: 'OpenAI rate limit or quota reached (429)'
  }
  const head = help[status] ?? (status >= 500 ? `OpenAI server error (${status})` : `Unexpected response ${status} from OpenAI`)
  return detail ? `${head}: ${detail}` : head
}

// Exponential backoff on 429 and 5xx, honouring Retry-After (capped at 60 s).
export async function postJson(path: string, payload: unknown, options: ClientOptions): Promise<unknown> {
  const fetch = options.fetch ?? globalArtFetch()
  const sleep = options.sleep ?? defaultSleep
  const base = (options.baseUrl ?? OPENAI_BASE).replace(/\/+$/, '')
  let retries = options.retries ?? 3
  let attempt = 0
  for (;;) {
    let res: Awaited<ReturnType<ArtFetch>>
    try {
      res = await fetch(`${base}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${options.apiKey}`, 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
        ...(options.signal ? { signal: options.signal } : {})
      })
    } catch (error) {
      throw new ImageApiError(`Could not reach OpenAI: ${(error as Error).message}`)
    }
    const body = await res.text()
    if (res.ok) {
      try {
        return JSON.parse(body)
      } catch {
        throw new ImageApiError(`OpenAI returned invalid JSON: ${body.slice(0, 200)}`, res.status)
      }
    }
    const retryAfter = parseRetryAfter(res.headers.get('retry-after'))
    const retriable = res.status === 429 || res.status >= 500
    // A 429 for an exhausted quota will not clear by waiting.
    const quota = res.status === 429 && /insufficient_quota|billing/i.test(body)
    if (retriable && !quota && retries > 0) {
      retries--
      const wait = Math.min(60, retryAfter ?? 2 ** attempt * 2)
      attempt++
      await sleep(wait * 1000)
      continue
    }
    throw new ImageApiError(explain(res.status, body), res.status, retryAfter)
  }
}

function common(req: ImageRequest): Record<string, unknown> {
  const out: Record<string, unknown> = { model: req.model, prompt: req.prompt, n: req.n, size: req.size, quality: req.quality, output_format: req.outputFormat }
  if (req.background !== 'auto') out.background = req.background
  return out
}

function parseImages(json: unknown): ImageResponse {
  const j = json as { data?: { b64_json?: string }[]; output_format?: string; size?: string; quality?: string; background?: string; usage?: ImageResponse['usage'] }
  const images = (j.data ?? []).map((d) => d.b64_json).filter((b): b is string => typeof b === 'string' && b.length > 0).map((b) => Buffer.from(b, 'base64'))
  if (!images.length) throw new ImageApiError('OpenAI returned no images')
  return { images, outputFormat: j.output_format, size: j.size, quality: j.quality, background: j.background, ...(j.usage ? { usage: j.usage } : {}) }
}

export function generationPayload(req: ImageRequest): Record<string, unknown> {
  return common(req)
}

export function editPayload(req: EditRequest): Record<string, unknown> {
  const out = common(req)
  out.images = req.images.map((u) => ({ image_url: u }))
  if (req.mask) out.mask = { image_url: req.mask }
  // input_fidelity: only gpt-image-1 / 1.5 accept "high" (omit for gpt-image-2 and later).
  if (req.model === 'gpt-image-1' || req.model === 'gpt-image-1.5') out.input_fidelity = 'high'
  return out
}

export async function generateImages(req: ImageRequest, options: ClientOptions): Promise<ImageResponse> {
  return parseImages(await postJson('/images/generations', generationPayload(req), options))
}

export async function editImages(req: EditRequest, options: ClientOptions): Promise<ImageResponse> {
  if (!req.images.length) throw new ImageApiError('An edit needs at least one reference image')
  if (req.images.length > 16) throw new ImageApiError('At most 16 reference images')
  return parseImages(await postJson('/images/edits', editPayload(req), options))
}

// ---------------------------------------------------------------- sizes

export const STANDARD_SIZES = ['auto', '1024x1024', '1536x1024', '1024x1536'] as const

export function validSize(model: string, size: string): string | null {
  if ((STANDARD_SIZES as readonly string[]).includes(size)) return null
  const m = /^(\d+)x(\d+)$/.exec(size)
  if (!m) return `size must be auto, 1024x1024, 1536x1024, 1024x1536 or WIDTHxHEIGHT`
  if (!/^gpt-image-2/.test(model)) return `${model} only supports ${STANDARD_SIZES.join(', ')}`
  const w = Number(m[1])
  const h = Number(m[2])
  if (w % 16 || h % 16) return 'width and height must be multiples of 16'
  if (w / h > 3 || h / w > 3) return 'aspect ratio must be between 1:3 and 3:1'
  if (w * h > 3840 * 2160 || Math.max(w, h) > 3840) return 'at most 3840x2160'
  return null
}

// ---------------------------------------------------------------- image bytes

export function mimeOf(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/bmp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (buf.length >= 4 && String.fromCharCode(...buf.subarray(0, 4)) === 'GIF8') return 'image/gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return null
}

// PNG width/height from the IHDR chunk.
export function pngSize(buf: Uint8Array): { width: number; height: number } | null {
  if (mimeOf(buf) !== 'image/png' || buf.length < 24) return null
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength)
  return { width: view.getUint32(16), height: view.getUint32(20) }
}

export function toDataUrl(buf: Uint8Array): string {
  const mime = mimeOf(buf) ?? 'application/octet-stream'
  return `data:${mime};base64,${Buffer.from(buf).toString('base64')}`
}
