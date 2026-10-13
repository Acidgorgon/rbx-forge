import type { FetchLike, Sleep, VersionType } from './types.ts'

// Roblox Open Cloud: Place Publishing API and the place -> universe lookup.
//
// Verified against the official docs (October 2026):
//  - Guide: https://create.roblox.com/docs/cloud/guides/usage-place-publishing
//      POST https://apis.roblox.com/universes/v1/{universeId}/places/{placeId}/versions?versionType=Published
//      header x-api-key; Content-Type application/octet-stream (.rbxl) or application/xml (.rbxlx);
//      body = the place file; API key needs the universe-places API with Write on the experience.
//      Success body example: { "versionNumber": 7 }. HTTPS only.
//      Instances of EditableImage, EditableMesh, PartOperation, SurfaceAppearance and BaseWrap are not
//      updated by the API; publish from Studio after changing them.
//  - Reference: https://create.roblox.com/docs/cloud/reference/features/places (endpoint, Beta, API key)
//      scope universe-places:write; versionType "Saved" (saved, not published) | "Published" (saved and
//      published); responses 200 version number, 400 invalid request/file, 401 key not valid for the
//      operation, 403 publish not allowed on the place, 404 place/universe does not exist, 409 place not
//      part of the universe, 500 server error. Rate limit: 30 requests/minute per API key owner.
//  - Errors: https://create.roblox.com/docs/cloud/reference/errors — 429 RESOURCE_EXHAUSTED; v1 error
//      bodies are inconsistent ({errors:[{code,message}]}, {code,message}, {error,message,errorDetails},
//      or a validation problem object with title/errors), so messages are pulled from any of them.
//  - Place -> universe: GET https://apis.roblox.com/universes/v1/places/{placeId}/universe returns
//      {"universeId": 13058} with no authentication. This route is NOT on create.roblox.com's Open
//      Cloud reference; it is the public web API used by the community (devforum thread 780807) and was
//      checked live for place 1818. Because it is undocumented, a universeId in .forge/project.json
//      always wins and the lookup is only a convenience.

export const OPEN_CLOUD_BASE = 'https://apis.roblox.com'
export const PUBLISH_SCOPE = 'universe-places:write'
export const PUBLISH_RATE_LIMIT_PER_MINUTE = 30

export type OpenCloudErrorKind =
  | 'invalid-request' // 400
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not-found' // 404
  | 'conflict' // 409
  | 'rate-limited' // 429
  | 'server' // 5xx
  | 'network'
  | 'invalid-input'
  | 'unknown'

export class OpenCloudError extends Error {
  readonly kind: OpenCloudErrorKind
  readonly status?: number
  readonly retryAfterSeconds?: number
  readonly detail?: string
  constructor(kind: OpenCloudErrorKind, message: string, extra: { status?: number; retryAfterSeconds?: number; detail?: string } = {}) {
    super(message)
    this.name = 'OpenCloudError'
    this.kind = kind
    this.status = extra.status
    this.retryAfterSeconds = extra.retryAfterSeconds
    this.detail = extra.detail
  }
}

// Pulls a human message out of any of the documented v1/v2/gateway error shapes.
export function errorDetail(body: string): string | undefined {
  const text = body.trim()
  if (!text) return undefined
  try {
    const json = JSON.parse(text) as Record<string, unknown>
    if (Array.isArray(json.errors) && json.errors.length) {
      const first = json.errors[0] as Record<string, unknown> | string
      if (typeof first === 'string') return first
      if (first && typeof first.message === 'string') return first.message
    }
    if (json.errors && typeof json.errors === 'object' && !Array.isArray(json.errors)) {
      const messages = Object.values(json.errors as Record<string, unknown>).flat().filter((v) => typeof v === 'string')
      if (messages.length) return messages.join('; ')
    }
    for (const key of ['message', 'title', 'error']) if (typeof json[key] === 'string' && json[key]) return json[key] as string
  } catch {
    // Not JSON: a short plain-text body is still useful.
  }
  return text.length <= 300 ? text : text.slice(0, 300) + '…'
}

// Retry-After is either delta-seconds or an HTTP date.
export function parseRetryAfter(value: string | null, now = Date.now()): number | undefined {
  if (!value) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds) && seconds >= 0) return seconds
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, (date - now) / 1000)
}

const STATUS_HELP: Record<number, [OpenCloudErrorKind, string]> = {
  400: ['invalid-request', 'Roblox rejected the request or the place file (400). Re-export or rebuild the place and try again.'],
  401: ['unauthorized', `The Open Cloud API key is not valid for this (401). Check it is not expired or revoked and that its IP allow-list includes this computer.`],
  403: ['forbidden', `Publishing is not allowed on this place (403). The API key needs the universe-places API with Write (${PUBLISH_SCOPE}) on this experience.`],
  404: ['not-found', 'Roblox says the place or experience does not exist (404). Check the place ID and universe ID.'],
  409: ['conflict', 'That place is not part of that experience (409). Check the universe ID matches the place.'],
  429: ['rate-limited', `Too many publish requests (429). Open Cloud allows ${PUBLISH_RATE_LIMIT_PER_MINUTE} per minute per key owner; wait a moment and retry.`]
}

export function mapStatus(status: number, body: string, retryAfter: string | null): OpenCloudError {
  const detail = errorDetail(body)
  const known = STATUS_HELP[status]
  const [kind, help] = known ?? (status >= 500 ? ['server', `Roblox had a server error (${status}). Try again in a few minutes.`] : ['unknown', `Unexpected response ${status} from Roblox.`])
  const message = detail ? `${help} Roblox said: ${detail}` : help
  return new OpenCloudError(kind as OpenCloudErrorKind, message, { status, detail, retryAfterSeconds: status === 429 ? parseRetryAfter(retryAfter) : undefined })
}

function positiveId(value: unknown, name: string): number {
  const n = typeof value === 'string' && /^\d+$/.test(value.trim()) ? Number(value) : value
  if (typeof n !== 'number' || !Number.isSafeInteger(n) || n <= 0) throw new OpenCloudError('invalid-input', `${name} must be a positive whole number`)
  return n
}

export interface LookupOptions {
  fetch?: FetchLike
  sleep?: Sleep
  // Extra attempts after a 429 (default 1).
  retries?: number
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function globalFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') throw new OpenCloudError('network', 'fetch is not available')
  return globalThis.fetch as unknown as FetchLike
}

export async function lookupUniverseId(placeId: number | string, options: LookupOptions = {}): Promise<number> {
  const id = positiveId(placeId, 'Place ID')
  const fetch = options.fetch ?? globalFetch()
  const sleep = options.sleep ?? defaultSleep
  let retries = options.retries ?? 1
  for (;;) {
    let response: Awaited<ReturnType<FetchLike>>
    try {
      response = await fetch(`${OPEN_CLOUD_BASE}/universes/v1/places/${id}/universe`, { method: 'GET', headers: { accept: 'application/json' } })
    } catch (error) {
      throw new OpenCloudError('network', `Could not reach Roblox: ${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.text()
    if (response.status === 429 && retries > 0) {
      retries--
      await sleep(Math.min(30, parseRetryAfter(response.headers.get('retry-after')) ?? 2) * 1000)
      continue
    }
    if (!response.ok) {
      if (response.status === 404 || response.status === 400) throw new OpenCloudError('not-found', `No experience found for place ${id}.`, { status: response.status, detail: errorDetail(body) })
      throw mapStatus(response.status, body, response.headers.get('retry-after'))
    }
    try {
      const json = JSON.parse(body) as { universeId?: unknown }
      if (json.universeId === null) throw new OpenCloudError('not-found', `Place ${id} is not in an experience.`)
      return positiveId(json.universeId, 'universeId')
    } catch (error) {
      if (error instanceof OpenCloudError) throw error
      throw new OpenCloudError('unknown', `Unexpected universe lookup response: ${body.slice(0, 200)}`)
    }
  }
}

export function placeFormat(path: string): 'rbxl' | 'rbxlx' | null {
  const lower = path.toLowerCase()
  if (lower.endsWith('.rbxlx')) return 'rbxlx'
  if (lower.endsWith('.rbxl')) return 'rbxl'
  return null
}

export function contentTypeFor(format: 'rbxl' | 'rbxlx'): string {
  return format === 'rbxlx' ? 'application/xml' : 'application/octet-stream'
}

export interface PublishInput {
  universeId: number | string
  placeId: number | string
  apiKey: string
  versionType: VersionType
  // Place file bytes and their format.
  body: Uint8Array
  format: 'rbxl' | 'rbxlx'
  fetch?: FetchLike
}

export interface PublishOutcome {
  versionNumber: number
  versionType: VersionType
  placeId: number
  universeId: number
}

export function publishUrl(universeId: number, placeId: number, versionType: VersionType): string {
  return `${OPEN_CLOUD_BASE}/universes/v1/${universeId}/places/${placeId}/versions?versionType=${versionType}`
}

// The guide shows {"versionNumber": 7}; the reference types the 200 body as a string. Accept both.
export function parseVersionNumber(body: string): number | undefined {
  const text = body.trim()
  if (/^\d+$/.test(text)) return Number(text)
  try {
    const json = JSON.parse(text) as unknown
    if (typeof json === 'number') return json
    if (typeof json === 'string' && /^\d+$/.test(json)) return Number(json)
    if (json && typeof json === 'object' && 'versionNumber' in json) {
      const v = (json as { versionNumber: unknown }).versionNumber
      if (typeof v === 'number') return v
      if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
    }
  } catch {
    // fall through
  }
  return undefined
}

// One request, never retried: a retry after an ambiguous failure could publish twice.
export async function publishPlace(input: PublishInput): Promise<PublishOutcome> {
  const universeId = positiveId(input.universeId, 'Universe ID')
  const placeId = positiveId(input.placeId, 'Place ID')
  if (input.versionType !== 'Saved' && input.versionType !== 'Published') throw new OpenCloudError('invalid-input', 'versionType must be Saved or Published')
  const apiKey = input.apiKey?.trim()
  if (!apiKey) throw new OpenCloudError('invalid-input', 'No Open Cloud API key. Add one in the Release drawer.')
  if (!input.body?.byteLength) throw new OpenCloudError('invalid-input', 'The place file is empty')
  const fetch = input.fetch ?? globalFetch()
  let response: Awaited<ReturnType<FetchLike>>
  try {
    response = await fetch(publishUrl(universeId, placeId, input.versionType), {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'content-type': contentTypeFor(input.format), accept: 'application/json' },
      body: input.body
    })
  } catch (error) {
    throw new OpenCloudError('network', `Could not reach Roblox: ${error instanceof Error ? error.message : String(error)}`)
  }
  const body = await response.text()
  if (!response.ok) throw mapStatus(response.status, body, response.headers.get('retry-after'))
  const versionNumber = parseVersionNumber(body)
  if (versionNumber === undefined) throw new OpenCloudError('unknown', `Roblox accepted the upload but returned no version number: ${body.slice(0, 200)}`, { status: response.status })
  return { versionNumber, versionType: input.versionType, placeId, universeId }
}

// Rough shape check before a key is stored; Roblox keys are long opaque strings.
export function looksLikeApiKey(value: string): boolean {
  const v = value.trim()
  return v.length >= 20 && v.length <= 4096 && !/\s/.test(v)
}
