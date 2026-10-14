// Place linking for Forge Sync: which Studio places belong to the open project. A place syncs only
// when it is linked:
//   - a published place whose PlaceId is in a *.project.json servePlaceIds (or tools/studio-sync.json
//     placeIds), or
//   - a place the user linked in Source Control ("Link"), kept in <project>/.forge/sync/links.json:
//     by PlaceId for a published place, by the link id the Forge Bridge plugin (v8) stores in the place
//     (ServerStorage attribute ForgeSyncLink) for an unpublished one.
// Never by place name: "Place1", "Place2" and every local .rbxlx file share PlaceId 0.
// No electron imports (tested in test/syncLinks.test.ts).

import * as nodeFs from 'node:fs/promises'
import { join } from 'node:path'
import { atomicWrite, ensureSyncIgnored } from './store.ts'

export const LINKS_FILE = '.forge/sync/links.json'

export interface PlaceLink {
  projectFile: string
  // Studio's place name when it was linked (display only, never used to match).
  name?: string
  at: number
}

interface LinksData {
  version: 1
  links: Record<string, PlaceLink>
  // Set once the one-time cleanup of sync state from unlinked places ran (see SyncService.start).
  recovered?: boolean
}

export interface MatchedPlace {
  projectFile: string
  placeKey: string
  via: 'config' | 'link'
}

// The key a link is stored under: `place:<PlaceId>` (published) or `local:<link id>` (unpublished).
export function linkKey(place: { placeId: number; linkId?: string }): string | null {
  if (place.placeId > 0) return `place:${place.placeId}`
  if (place.linkId) return `local:${place.linkId}`
  return null
}

// The engine's / base store's key for a linked place.
export function linkedPlaceKey(place: { placeId: number; linkId?: string }): string | null {
  if (place.placeId > 0) return String(place.placeId)
  if (place.linkId) return `local:${place.linkId}`
  return null
}

// Which place file a Studio place syncs with, or null when it is not linked to this project.
export function matchPlace(maps: { projectFile: string; placeIds: number[] }[], links: Record<string, PlaceLink>, place: { placeId: number; linkId?: string }): MatchedPlace | null {
  const placeKey = linkedPlaceKey(place)
  if (!placeKey) return null
  if (place.placeId > 0) {
    const hit = maps.find((m) => m.placeIds.includes(place.placeId))
    if (hit) return { projectFile: hit.projectFile, placeKey, via: 'config' }
  }
  const key = linkKey(place)
  const link = key ? links[key] : undefined
  if (link && maps.some((m) => m.projectFile === link.projectFile)) return { projectFile: link.projectFile, placeKey, via: 'link' }
  return null
}

// A base-store place key that a linked place could own: published ids configured or linked, and
// `local:<id>` links. Anything else (the old `unpublished:<name>` keys, unlisted ids) came from a
// place that was never linked.
export function isLinkedKey(maps: { projectFile: string; placeIds: number[] }[], links: Record<string, PlaceLink>, placeKey: string): boolean {
  if (/^\d+$/.test(placeKey)) return !!matchPlace(maps, links, { placeId: Number(placeKey) })
  if (placeKey.startsWith('local:')) return !!matchPlace(maps, links, { placeId: 0, linkId: placeKey.slice('local:'.length) })
  return false
}

export class PlaceLinks {
  private data: LinksData = { version: 1, links: {} }
  private loaded = false
  private readonly file: string
  private readonly root: string
  private readonly fs: typeof nodeFs

  constructor(root: string, fs: typeof nodeFs = nodeFs) {
    this.root = root
    this.file = join(root, ...LINKS_FILE.split('/'))
    this.fs = fs
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    try {
      const parsed = JSON.parse(await this.fs.readFile(this.file, 'utf8')) as LinksData
      if (parsed && parsed.version === 1 && parsed.links && typeof parsed.links === 'object') {
        const links: Record<string, PlaceLink> = {}
        for (const [k, v] of Object.entries(parsed.links)) {
          if (/^(place:\d+|local:[A-Za-z0-9-]{8,64})$/.test(k) && v && typeof v.projectFile === 'string') links[k] = { projectFile: v.projectFile, ...(typeof v.name === 'string' ? { name: v.name } : {}), at: Number(v.at) || 0 }
        }
        this.data = { version: 1, links, ...(parsed.recovered ? { recovered: true } : {}) }
      }
    } catch {
      // none yet
    }
  }

  all(): Record<string, PlaceLink> {
    return this.data.links
  }

  get recovered(): boolean {
    return this.data.recovered === true
  }

  async set(key: string, link: PlaceLink): Promise<void> {
    await this.load()
    this.data.links[key] = link
    await this.save()
  }

  async markRecovered(): Promise<void> {
    await this.load()
    this.data.recovered = true
    await this.save()
  }

  private async save(): Promise<void> {
    await atomicWrite(this.fs as never, this.file, JSON.stringify(this.data, null, 2) + '\n')
    await ensureSyncIgnored(this.root, this.fs as never).catch(() => false)
  }
}
