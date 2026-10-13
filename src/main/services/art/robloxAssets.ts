// Roblox Open Cloud Assets API: upload an image as an Image/Decal asset and poll the operation.
// No electron imports.
//
// Verified 2026-10-13:
//  - Guide https://create.roblox.com/docs/cloud/guides/usage-assets
//    POST https://apis.roblox.com/assets/v1/assets, header x-api-key, multipart/form-data with
//    `request` (JSON: assetType, displayName, description, creationContext.creator.userId | groupId)
//    and `fileContent` (the file with its content type). Decal/Image: .png .jpeg .bmp .tga
//    (image/png, image/jpeg, image/bmp, image/tga), smaller than 8000x8000, files up to 20 MB.
//    Images cannot be updated later. The call returns an Operation; poll
//    GET https://apis.roblox.com/assets/v1/operations/{operationId} until done, then
//    response.assetId (example "2205400862") and response.moderationResult.moderationState.
//  - OpenAPI (Roblox/creator-docs content/en-us/reference/cloud/assets/v1.json):
//    Create Asset scopes asset:read + asset:write, 120 req/min per API key owner;
//    Get Operation scope asset:read, 300/min with a 100 per 60 s throttle per key.
//    Operation { path: "operations/{id}", done: bool, error?: { code, message }, response?: Asset }.
//    creationContext.expectedPrice (Robux) fails the operation with 400 when the fee is higher.

import { randomUUID } from 'node:crypto'
import { defaultSleep, globalArtFetch, mimeOf, parseRetryAfter, type ArtFetch, type Sleep } from './openaiImages.ts'

export const ASSETS_BASE = 'https://apis.roblox.com/assets/v1'
export const ASSET_SCOPES = ['asset:read', 'asset:write'] as const
export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024

export class AssetUploadError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AssetUploadError'
    this.status = status
  }
}

export interface Creator {
  userId?: number
  groupId?: number
}

export interface UploadInput {
  apiKey: string
  bytes: Uint8Array
  fileName: string
  displayName: string
  description?: string
  assetType: 'Image' | 'Decal'
  creator: Creator
  fetch?: ArtFetch
  sleep?: Sleep
  // Poll: first delay, max delay and give-up time (ms).
  pollStartMs?: number
  pollMaxMs?: number
  timeoutMs?: number
  now?: () => number
  onProgress?: (stage: string) => void
}

export interface UploadResult {
  assetId: string
  uri: string
  operationId: string
  moderation?: string
}

function detail(body: string): string | undefined {
  try {
    const j = JSON.parse(body) as Record<string, unknown>
    if (typeof j.message === 'string') return j.message
    if (Array.isArray(j.errors) && j.errors[0] && typeof (j.errors[0] as { message?: unknown }).message === 'string') return (j.errors[0] as { message: string }).message
    if (j.error && typeof j.error === 'object' && typeof (j.error as { message?: unknown }).message === 'string') return (j.error as { message: string }).message
    if (typeof j.error === 'string') return j.error
  } catch {
    // plain text
  }
  const t = body.trim()
  return t ? t.slice(0, 300) : undefined
}

function statusHelp(status: number, body: string): string {
  const d = detail(body)
  const help: Record<number, string> = {
    400: 'Roblox rejected the upload (400)',
    401: 'The Open Cloud API key is not valid (401): expired, revoked, or this IP is not allowed',
    403: `The Open Cloud API key cannot create assets (403). Give it the Assets API with ${ASSET_SCOPES.join(' + ')} and make sure the creator matches the key owner or group`,
    404: 'Roblox did not find that resource (404)',
    429: 'Too many requests to Roblox (429)'
  }
  const head = help[status] ?? (status >= 500 ? `Roblox server error (${status})` : `Unexpected response ${status} from Roblox`)
  return d ? `${head}: ${d}` : head
}

export function contentTypeFor(bytes: Uint8Array): string {
  const m = mimeOf(bytes)
  if (m === 'image/png' || m === 'image/jpeg' || m === 'image/bmp') return m
  throw new AssetUploadError('Roblox accepts PNG, JPEG, BMP or TGA images; regenerate as PNG to upload')
}

// multipart/form-data body built by hand so it is deterministic and testable.
export function multipartBody(parts: { name: string; value: string | Uint8Array; fileName?: string; contentType?: string }[], boundary = `forge${randomUUID().replace(/-/g, '')}`): { body: Uint8Array; contentType: string } {
  const chunks: Buffer[] = []
  for (const p of parts) {
    let head = `--${boundary}\r\nContent-Disposition: form-data; name="${p.name}"`
    if (p.fileName) head += `; filename="${p.fileName.replace(/["\r\n]/g, '_')}"`
    head += '\r\n'
    if (p.contentType) head += `Content-Type: ${p.contentType}\r\n`
    chunks.push(Buffer.from(head + '\r\n', 'utf8'), typeof p.value === 'string' ? Buffer.from(p.value, 'utf8') : Buffer.from(p.value), Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: new Uint8Array(Buffer.concat(chunks)), contentType: `multipart/form-data; boundary=${boundary}` }
}

export function assetRequestJson(input: Pick<UploadInput, 'assetType' | 'displayName' | 'description' | 'creator'>): string {
  const creator = input.creator.groupId ? { groupId: String(input.creator.groupId) } : { userId: String(input.creator.userId) }
  return JSON.stringify({
    assetType: input.assetType,
    displayName: input.displayName.slice(0, 50),
    description: (input.description ?? '').slice(0, 1000),
    creationContext: { creator }
  })
}

function operationIdOf(json: { path?: string; operationId?: string }): string | undefined {
  if (typeof json.operationId === 'string') return json.operationId
  const m = /operations\/([^/?]+)/.exec(json.path ?? '')
  return m?.[1]
}

interface Operation {
  path?: string
  operationId?: string
  done?: boolean
  error?: { code?: number; message?: string }
  response?: { assetId?: string | number; path?: string; moderationResult?: { moderationState?: string } }
}

async function send(fetch: ArtFetch, sleep: Sleep, url: string, init: Parameters<ArtFetch>[1], retries = 3): Promise<{ status: number; body: string }> {
  let attempt = 0
  for (;;) {
    let res: Awaited<ReturnType<ArtFetch>>
    try {
      res = await fetch(url, init)
    } catch (error) {
      throw new AssetUploadError(`Could not reach Roblox: ${(error as Error).message}`)
    }
    const body = await res.text()
    if ((res.status === 429 || res.status === 503) && attempt < retries) {
      const wait = Math.min(60, parseRetryAfter(res.headers.get('retry-after')) ?? 2 ** attempt * 2)
      attempt++
      await sleep(wait * 1000)
      continue
    }
    return { status: res.status, body }
  }
}

function assetIdFrom(op: Operation): string | undefined {
  const r = op.response
  if (!r) return undefined
  if (r.assetId !== undefined && /^\d+$/.test(String(r.assetId))) return String(r.assetId)
  const m = /assets\/(\d+)/.exec(r.path ?? '')
  return m?.[1]
}

export async function uploadImageAsset(input: UploadInput): Promise<UploadResult> {
  const apiKey = input.apiKey?.trim()
  if (!apiKey) throw new AssetUploadError('No Open Cloud API key. Add one on the Art page (Assets API: asset:read + asset:write).')
  if (!input.creator.userId && !input.creator.groupId) throw new AssetUploadError('Set the Roblox creator (your user ID or a group ID) on the Art page first.')
  if (!input.bytes.byteLength) throw new AssetUploadError('The image is empty')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AssetUploadError('Roblox accepts images up to 20 MB')
  const fetch = input.fetch ?? globalArtFetch()
  const sleep = input.sleep ?? defaultSleep
  const now = input.now ?? Date.now
  const { body, contentType } = multipartBody([
    { name: 'request', value: assetRequestJson(input) },
    { name: 'fileContent', value: input.bytes, fileName: input.fileName, contentType: contentTypeFor(input.bytes) }
  ])
  input.onProgress?.('uploading')
  const created = await send(fetch, sleep, `${ASSETS_BASE}/assets`, { method: 'POST', headers: { 'x-api-key': apiKey, 'content-type': contentType, accept: 'application/json' }, body })
  if (created.status < 200 || created.status >= 300) throw new AssetUploadError(statusHelp(created.status, created.body), created.status)
  let op: Operation
  try {
    op = JSON.parse(created.body) as Operation
  } catch {
    throw new AssetUploadError(`Unexpected create response: ${created.body.slice(0, 200)}`)
  }
  const operationId = operationIdOf(op)
  let delay = input.pollStartMs ?? 1000
  const maxDelay = input.pollMaxMs ?? 5000
  const deadline = now() + (input.timeoutMs ?? 120_000)
  input.onProgress?.('processing')
  while (!op.done) {
    if (!operationId) throw new AssetUploadError(`Roblox returned no operation id: ${created.body.slice(0, 200)}`)
    if (now() > deadline) throw new AssetUploadError(`Roblox is still processing the upload (operation ${operationId}); check Creator Hub later`)
    await sleep(delay)
    delay = Math.min(maxDelay, Math.round(delay * 1.6))
    const polled = await send(fetch, sleep, `${ASSETS_BASE}/operations/${encodeURIComponent(operationId)}`, { method: 'GET', headers: { 'x-api-key': apiKey, accept: 'application/json' } })
    if (polled.status < 200 || polled.status >= 300) throw new AssetUploadError(statusHelp(polled.status, polled.body), polled.status)
    try {
      op = JSON.parse(polled.body) as Operation
    } catch {
      throw new AssetUploadError(`Unexpected operation response: ${polled.body.slice(0, 200)}`)
    }
  }
  if (op.error) throw new AssetUploadError(`Roblox could not create the asset: ${op.error.message ?? `code ${op.error.code}`}`)
  const assetId = assetIdFrom(op)
  if (!assetId) throw new AssetUploadError('Roblox finished the upload but returned no asset id')
  const moderation = op.response?.moderationResult?.moderationState
  return { assetId, uri: `rbxassetid://${assetId}`, operationId: operationId ?? '', ...(moderation ? { moderation } : {}) }
}
