// Image resolution for the UI preview. No electron imports.
//
//   rbxassetid://N    an Art concept uploaded as N (art/concepts sidecars) -> the local PNG;
//                     else Roblox's public thumbnails API (thumbnails.roblox.com/v1/assets, no auth),
//                     which returns a CDN URL of a rendered thumbnail (420x420, so 9-slice margins
//                     are approximate). Asset delivery (the original file) needs a .ROBLOSECURITY
//                     cookie per Roblox's docs, which Forge does not ask for.
//   rbxthumb://...    the matching thumbnails endpoint (avatars, game icons, badges, passes).
//   art/... or *.png  a project file -> data: URL.
//   rbxasset://...    engine textures are not available outside Studio: placeholder.

import { readFile } from 'node:fs/promises'
import { extname } from 'node:path'
import { parseImage, parseThumbnailResponse, thumbnailRequest } from '../../../shared/uiPreview/assets.ts'
import type { UiImageInfo } from '../../../shared/uiPreviewTypes.ts'
import { insideRoot, listConcepts } from '../art/store.ts'

export type FetchLike = (url: string, init?: { signal?: AbortSignal; headers?: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

export interface ImageResolverDeps {
  root: () => string | null
  fetch?: FetchLike
  now?: () => number
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif', '.svg': 'image/svg+xml' }
const RETRY_MS = 5 * 60_000
const MAX_LOCAL_BYTES = 8 * 1024 * 1024

export class ImageResolver {
  private cache = new Map<string, { info: UiImageInfo; at: number }>()
  private concepts: { at: number; byId: Map<string, string> } | null = null

  private deps: ImageResolverDeps

  constructor(deps: ImageResolverDeps) {
    this.deps = deps
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now()
  }

  clear(): void {
    this.cache.clear()
    this.concepts = null
  }

  private async conceptFor(id: string): Promise<string | null> {
    const root = this.deps.root()
    if (!root) return null
    if (!this.concepts || this.now() - this.concepts.at > 30_000) {
      const byId = new Map<string, string>()
      for (const item of await listConcepts(root).catch(() => [])) if (item.roblox?.assetId) byId.set(String(item.roblox.assetId), item.path)
      this.concepts = { at: this.now(), byId }
    }
    return this.concepts.byId.get(id) ?? null
  }

  private async local(rel: string): Promise<UiImageInfo> {
    const root = this.deps.root()
    const inside = root ? insideRoot(root, rel) : null
    if (!root || !inside) return { state: 'placeholder', reason: `${rel} is outside the project` }
    const mime = MIME[extname(inside).toLowerCase()]
    if (!mime) return { state: 'placeholder', reason: `unsupported image type ${extname(inside)}` }
    try {
      const bytes = await readFile(`${root}/${inside}`)
      if (bytes.length > MAX_LOCAL_BYTES) return { state: 'placeholder', reason: 'image file is over 8 MB' }
      return { state: 'ok', url: `data:${mime};base64,${bytes.toString('base64')}` }
    } catch {
      return { state: 'placeholder', reason: `${inside} not found` }
    }
  }

  private async thumbnail(url: string): Promise<UiImageInfo> {
    const fetchFn = this.deps.fetch ?? (globalThis.fetch as unknown as FetchLike | undefined)
    if (!fetchFn) return { state: 'placeholder', reason: 'no network access' }
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 8000)
      const res = await fetchFn(url, { signal: controller.signal, headers: { accept: 'application/json' } }).finally(() => clearTimeout(timer))
      if (!res.ok) return { state: 'placeholder', reason: `thumbnails API returned ${res.status}` }
      const parsed = parseThumbnailResponse(await res.json())
      if (!parsed) return { state: 'placeholder', reason: 'no thumbnail for this id' }
      if (parsed.state === 'Completed' && parsed.imageUrl) return { state: 'ok', url: parsed.imageUrl }
      return { state: 'placeholder', reason: parsed.state === 'Blocked' ? 'moderated or private asset' : `thumbnail ${parsed.state.toLowerCase()}` }
    } catch (error) {
      return { state: 'placeholder', reason: `offline (${(error as Error).name === 'AbortError' ? 'timed out' : (error as Error).message})` }
    }
  }

  async resolve(ref: string): Promise<UiImageInfo> {
    const cached = this.cache.get(ref)
    if (cached && (cached.info.state === 'ok' || this.now() - cached.at < RETRY_MS)) return cached.info
    const info = await this.resolveFresh(ref)
    this.cache.set(ref, { info, at: this.now() })
    return info
  }

  private async resolveFresh(ref: string): Promise<UiImageInfo> {
    const parsed = parseImage(ref)
    switch (parsed.kind) {
      case 'none':
        return { state: 'placeholder', reason: 'not an image reference' }
      case 'engine':
        return { state: 'placeholder', reason: `engine texture ${parsed.path} (Studio only)` }
      case 'file':
        return this.local(parsed.path)
      case 'url':
        return { state: 'ok', url: parsed.url }
      case 'asset': {
        const concept = await this.conceptFor(parsed.id)
        if (concept) {
          const local = await this.local(concept)
          if (local.state === 'ok') return local
        }
        return this.thumbnail(thumbnailRequest(parsed)!)
      }
      case 'thumb':
        return this.thumbnail(thumbnailRequest(parsed)!)
    }
  }

  async resolveAll(refs: string[]): Promise<Record<string, UiImageInfo>> {
    const unique = [...new Set(refs.filter((r) => typeof r === 'string' && r.trim()))].slice(0, 200)
    const out: Record<string, UiImageInfo> = {}
    await Promise.all(unique.map(async (r) => (out[r] = await this.resolve(r))))
    return out
  }
}
