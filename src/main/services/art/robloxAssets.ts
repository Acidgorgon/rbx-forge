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
//  - Animation assets (Animation Lab): the same Create Asset call with assetType "Animation" and a
//    .rbxm / .rbxmx file holding a KeyframeSequence, content type model/x-rbxm, up to 20 MB
//    (usage-assets "Supported asset types and limits" table).
//  - Model assets (FBX upload inbox, roblox_upload_model): the same call with assetType "Model" and
//    an .fbx file, content type model/fbx, up to 20 MB (the table also lists .gltf / .glb / .rbxm;
//    Forge sends FBX only). Roblox imports it as a Model holding one or more MeshParts and stores it
//    as a package (Toolbox > Inventory > My Packages, or Group Packages). Moderation states are
//    Reviewing / Rejected / Approved (OpenAPI ModerationResult; the guide's example spells them
//    MODERATION_STATE_APPROVED). Example request in the guide:
//      --form 'request={"assetType":"Model","displayName":"Name","description":"...",
//               "creationContext":{"creator":{"userId":"${userId}"}}}'
//      --form 'fileContent=@"/filepath/model.fbx";type=model/fbx'

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
  assetType: 'Image' | 'Decal' | 'Animation' | 'Model' | 'Audio'
  // Defaults to the image type sniffed from the bytes (contentTypeFor).
  contentType?: string
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
    413: 'The file is too large for Roblox (413): uploads are limited to 20 MB',
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
    { name: 'fileContent', value: input.bytes, fileName: input.fileName, contentType: input.contentType ?? contentTypeFor(input.bytes) }
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

export const ANIMATION_CONTENT_TYPE = 'model/x-rbxm'

// A KeyframeSequence (.rbxm / .rbxmx bytes) as an Animation asset (Animation Lab upload).
export function uploadAnimationAsset(input: Omit<UploadInput, 'assetType' | 'contentType'>): Promise<UploadResult> {
  if (!/\.rbxmx?$/i.test(input.fileName)) throw new AssetUploadError('Animation uploads must be .rbxm or .rbxmx files')
  if (!input.bytes.byteLength) throw new AssetUploadError('The animation file is empty')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AssetUploadError('Roblox accepts animation files up to 20 MB')
  return uploadImageAsset({ ...input, assetType: 'Animation', contentType: ANIMATION_CONTENT_TYPE })
}

export const MODEL_CONTENT_TYPE = 'model/fbx'

// FBX binary files start with "Kaydara FBX Binary"; ASCII FBX files open with a "; FBX" comment.
export function looksLikeFbx(bytes: Uint8Array): boolean {
  const head = Buffer.from(bytes.subarray(0, 1024)).toString('latin1')
  return head.startsWith('Kaydara FBX Binary') || /^\s*;\s*FBX\b/.test(head) || /FBXHeaderExtension/.test(head)
}

// Turns a failed operation (Operation.error: code + message, no HTTP status here) into a message that
// says what to change. HTTP errors already carry statusHelp's explanation and pass through.
export function modelUploadErrorText(message: string, status?: number): string {
  if (status !== undefined) return message
  if (/moderat|rejected|inappropriate/i.test(message)) return `Roblox moderation rejected the model. Rename it or change the mesh, then upload again. (${message})`
  if (/permission|forbidden|unauthori[sz]ed|scope/i.test(message)) {
    return `The Open Cloud key cannot create Model assets for this creator. Give it the Assets API with ${ASSET_SCOPES.join(' + ')}; a group creator needs a key owned by that group. (${message})`
  }
  if (/too large|file size|size limit|exceed/i.test(message)) return `Roblox refused the file size: Model uploads are limited to 20 MB. Decimate the mesh or split it. (${message})`
  return message
}

// An .fbx file as a Model asset. Moderation "Rejected" is an error; "Reviewing" still returns the id
// (Studio can insert it once moderation approves it).
export async function uploadModelAsset(input: Omit<UploadInput, 'assetType' | 'contentType'>): Promise<UploadResult> {
  if (!/\.fbx$/i.test(input.fileName)) throw new AssetUploadError('Model uploads must be .fbx files')
  if (!input.bytes.byteLength) throw new AssetUploadError('The FBX file is empty')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AssetUploadError(`Roblox accepts model files up to 20 MB; this one is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)
  if (!looksLikeFbx(input.bytes)) throw new AssetUploadError('That file is not an FBX (no FBX header)')
  let result: UploadResult
  try {
    // Mesh processing takes longer than images; wait up to 5 minutes by default.
    result = await uploadImageAsset({ timeoutMs: 300_000, ...input, assetType: 'Model', contentType: MODEL_CONTENT_TYPE })
  } catch (error) {
    if (error instanceof AssetUploadError) throw new AssetUploadError(modelUploadErrorText(error.message, error.status), error.status)
    throw error
  }
  if (result.moderation && /rejected/i.test(result.moderation)) {
    throw new AssetUploadError(`Roblox moderation rejected the model (asset ${result.assetId}). Rename it or change the mesh, then upload again.`)
  }
  return result
}

// ---------------------------------------------------------------- audio and image files (upload inbox)

// Audio assets: .mp3 / .ogg / .wav / .flac (usage-assets "Supported asset types and limits"), up to
// 20 MB and 7 minutes. Roblox caps audio uploads per month by account verification; that limit and a
// missing audio permission come back as operation errors and are explained by audioUploadErrorText.
export const AUDIO_CONTENT_TYPES: Record<string, string> = { mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', flac: 'audio/flac' }
export const IMAGE_CONTENT_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', bmp: 'image/bmp', tga: 'image/tga' }

const extOf = (fileName: string) => /\.([a-z0-9]+)$/i.exec(fileName)?.[1]?.toLowerCase() ?? ''

// The audio format from the first bytes, so a renamed file is caught before it reaches Roblox.
export function sniffAudio(bytes: Uint8Array): 'mp3' | 'ogg' | 'wav' | 'flac' | null {
  const head = Buffer.from(bytes.subarray(0, 12)).toString('latin1')
  if (head.startsWith('ID3') || (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)) return 'mp3'
  if (head.startsWith('OggS')) return 'ogg'
  if (head.startsWith('RIFF') && head.slice(8, 12) === 'WAVE') return 'wav'
  if (head.startsWith('fLaC')) return 'flac'
  return null
}

// Operation errors (no HTTP status) and 403s for audio/images, phrased as what to change.
export function mediaUploadErrorText(kind: 'Audio' | 'Image' | 'Decal', message: string, status?: number): string {
  const what = kind === 'Audio' ? 'audio' : 'images'
  if (status === 403 || (status === undefined && /permission|forbidden|unauthori[sz]ed|scope/i.test(message))) {
    return `The Open Cloud key cannot upload ${what} for this creator. On create.roblox.com > Open Cloud > API Keys, give the key the Assets API with ${ASSET_SCOPES.join(' + ')} (asset:write covers audio, decals and images), allow this IP, and use a key owned by the group when the creator is a group. (${message})`
  }
  if (status !== undefined) return message
  if (/moderat|rejected|inappropriate|copyright/i.test(message)) return `Roblox moderation rejected the ${kind === 'Audio' ? 'sound' : 'image'}. (${message})`
  if (kind === 'Audio' && /quota|limit|verif|exceed/i.test(message)) {
    return `Roblox refused the audio upload: the account's monthly audio upload limit is reached, or the file is too long (7 minutes) or too large (20 MB). ID-verified accounts get a higher monthly limit (Creator Hub shows the remaining quota). (${message})`
  }
  if (/too large|file size|size limit|exceed|dimension/i.test(message)) return `Roblox refused the file: ${kind === 'Audio' ? 'audio is limited to 20 MB and 7 minutes' : 'images are limited to 20 MB and 8000x8000 pixels'}. (${message})`
  return message
}

// An audio file as an Audio asset. "Reviewing" still returns the id; "Rejected" is an error.
export async function uploadAudioAsset(input: Omit<UploadInput, 'assetType' | 'contentType'>): Promise<UploadResult> {
  const ext = extOf(input.fileName)
  if (!AUDIO_CONTENT_TYPES[ext]) throw new AssetUploadError('Audio uploads must be .mp3, .ogg, .wav or .flac files')
  if (!input.bytes.byteLength) throw new AssetUploadError('The audio file is empty')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AssetUploadError(`Roblox accepts audio files up to 20 MB; this one is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)
  const sniffed = sniffAudio(input.bytes)
  if (!sniffed) throw new AssetUploadError(`That file is not ${ext.toUpperCase()} audio (unknown header)`)
  return finishMedia('Audio', () => uploadImageAsset({ timeoutMs: 300_000, ...input, assetType: 'Audio', contentType: AUDIO_CONTENT_TYPES[sniffed] }))
}

// A .png / .jpg / .bmp / .tga file as an Image (rbxassetid for ImageLabel/SurfaceAppearance) or a Decal.
export async function uploadMediaImageAsset(input: Omit<UploadInput, 'contentType' | 'assetType'> & { assetType: 'Image' | 'Decal' }): Promise<UploadResult> {
  const ext = extOf(input.fileName)
  if (!IMAGE_CONTENT_TYPES[ext]) throw new AssetUploadError('Image uploads must be .png, .jpg, .jpeg, .bmp or .tga files')
  if (!input.bytes.byteLength) throw new AssetUploadError('The image is empty')
  if (input.bytes.byteLength > MAX_UPLOAD_BYTES) throw new AssetUploadError(`Roblox accepts images up to 20 MB; this one is ${(input.bytes.byteLength / 1024 / 1024).toFixed(1)} MB`)
  // TGA has no magic bytes; every other format must match its header.
  const contentType = ext === 'tga' ? IMAGE_CONTENT_TYPES.tga : contentTypeFor(input.bytes)
  return finishMedia(input.assetType, () => uploadImageAsset({ ...input, contentType }))
}

async function finishMedia(kind: 'Audio' | 'Image' | 'Decal', run: () => Promise<UploadResult>): Promise<UploadResult> {
  let result: UploadResult
  try {
    result = await run()
  } catch (error) {
    if (error instanceof AssetUploadError) throw new AssetUploadError(mediaUploadErrorText(kind, error.message, error.status), error.status)
    throw error
  }
  if (result.moderation && /rejected/i.test(result.moderation)) {
    throw new AssetUploadError(`Roblox moderation rejected the ${kind === 'Audio' ? 'sound' : 'image'} (asset ${result.assetId}).`)
  }
  return result
}
