// Adding an image to an experience's thumbnails through Open Cloud. No electron imports.
//
// Checked on the Creator Hub (2026-10-14):
//  - apis.roblox.com reference (create.roblox.com/docs/cloud/reference/domains/apis) and the
//    Localization feature page (create.roblox.com/docs/cloud/reference/features/localization):
//    POST https://apis.roblox.com/legacy-game-internationalization/v1/game-thumbnails/games/{gameId}/
//      language-codes/{languageCode}/image  "Uploads the game thumbnail." Auth: API Key (x-api-key) or
//      OAuth 2.0; scope legacy-universe:manage; 100 requests/min; marked Experimental. 200 returns
//      UploadImageForGameThumbnailResponse {"mediaAssetId": "string"}. gameId is the universe id.
//    The page does not document the request body. The cookie twin of this route on
//    gameinternationalization.roblox.com takes multipart/form-data with the file in "request.files";
//    that is what is sent here. Ordering is a separate call (.../images/order with mediaAssetIds),
//    so a new image is appended and the order is left to Creator Hub.
//  - The Thumbnails feature page (cloud/reference/features/thumbnails) has only read endpoints and
//    points to "publish" for uploads.
// Because it is experimental and changes what players see, the UI asks for a confirmation first.

import { randomUUID } from 'node:crypto'
import type { ArtFetch } from '../art/openaiImages.ts'

export const EXPERIENCE_THUMB_SCOPE = 'legacy-universe:manage'

export function experienceThumbUrl(universeId: number, languageCode: string): string {
  return `https://apis.roblox.com/legacy-game-internationalization/v1/game-thumbnails/games/${universeId}/language-codes/${encodeURIComponent(languageCode)}/image`
}

export class ExperienceThumbError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.status = status
  }
}

export function multipartFile(field: string, fileName: string, contentType: string, bytes: Uint8Array): { body: Buffer; contentType: string } {
  const boundary = `----forge${randomUUID().replace(/-/g, '')}`
  const head = Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${fileName.replace(/"/g, '')}"\r\nContent-Type: ${contentType}\r\n\r\n`)
  const tail = Buffer.from(`\r\n--${boundary}--\r\n`)
  return { body: Buffer.concat([head, Buffer.from(bytes), tail]), contentType: `multipart/form-data; boundary=${boundary}` }
}

export async function uploadExperienceThumbnail(input: { apiKey: string; universeId: number; languageCode: string; bytes: Uint8Array; fileName: string; fetch: ArtFetch }): Promise<{ mediaAssetId: string }> {
  if (!Number.isSafeInteger(input.universeId) || input.universeId <= 0) throw new ExperienceThumbError('Enter the experience\'s universe id (Creator Hub > your experience > the id in the URL or "Copy Universe ID").')
  if (!/^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(input.languageCode)) throw new ExperienceThumbError(`"${input.languageCode}" is not a language code (e.g. en).`)
  const form = multipartFile('request.files', input.fileName, 'image/png', input.bytes)
  let res: Awaited<ReturnType<ArtFetch>>
  try {
    res = await input.fetch(experienceThumbUrl(input.universeId, input.languageCode), { method: 'POST', headers: { 'x-api-key': input.apiKey, 'content-type': form.contentType, accept: 'application/json' }, body: form.body })
  } catch (e) {
    throw new ExperienceThumbError(`Could not reach Roblox: ${(e as Error).message}`)
  }
  const body = await res.text()
  if (!res.ok) {
    const hint =
      res.status === 401 || res.status === 403
        ? ` The Open Cloud key needs the ${EXPERIENCE_THUMB_SCOPE} scope for this experience (Creator Hub > Open Cloud > API Keys).`
        : res.status === 503
          ? ' Roblox says the feature is disabled right now; add it in Creator Hub instead.'
          : res.status === 400
            ? ' Check the universe id and that the language is the experience\'s source language.'
            : ''
    throw new ExperienceThumbError(`Roblox answered ${res.status}: ${body.slice(0, 200)}.${hint}`, res.status)
  }
  let id: unknown
  try {
    id = (JSON.parse(body) as { mediaAssetId?: unknown }).mediaAssetId
  } catch {
    id = undefined
  }
  if (typeof id !== 'string' && typeof id !== 'number') throw new ExperienceThumbError(`Roblox answered without a mediaAssetId: ${body.slice(0, 200)}`)
  return { mediaAssetId: String(id) }
}
