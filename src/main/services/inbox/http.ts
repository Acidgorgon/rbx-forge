// Minimal HTTP / sleep / image MIME helpers used by the Open Cloud Assets uploader and inbox.

export type HttpFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array; signal?: AbortSignal }
) => Promise<{ status: number; ok: boolean; headers: { get(name: string): string | null }; text(): Promise<string> }>

export type ArtFetch = HttpFetch

export type Sleep = (ms: number) => Promise<void>
export const defaultSleep: Sleep = (ms) => new Promise((r) => setTimeout(r, ms))

export function globalHttpFetch(): HttpFetch {
  if (typeof globalThis.fetch !== 'function') throw new Error('fetch is not available')
  return globalThis.fetch as unknown as HttpFetch
}

export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const s = Number(value)
  if (Number.isFinite(s) && s >= 0) return s
  const d = Date.parse(value)
  return Number.isNaN(d) ? undefined : Math.max(0, (d - now) / 1000)
}

export function mimeOf(buf: Uint8Array): 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif' | 'image/bmp' | null {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png'
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg'
  if (buf.length >= 12 && String.fromCharCode(...buf.subarray(0, 4)) === 'RIFF' && String.fromCharCode(...buf.subarray(8, 12)) === 'WEBP') return 'image/webp'
  if (buf.length >= 4 && String.fromCharCode(...buf.subarray(0, 4)) === 'GIF8') return 'image/gif'
  if (buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d) return 'image/bmp'
  return null
}
