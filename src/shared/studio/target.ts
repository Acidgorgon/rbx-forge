// Studio target: which Roblox Studio window gets Forge Bridge jobs when several places are open
// (Test in Studio / Live in Studio, Studio checks, imports). Each Studio window's plugin polls the
// bridge with its place name and PlaceId, so a job can name the place it is for; a job without a
// target goes to whichever window polls first (one place open: that one). The choice is kept per
// project (settings key STUDIO_TARGETS_SETTING, by project root). Plain data shared by main, preload
// and renderer. No electron imports (tested in test/studioTarget.test.ts).

export interface StudioTarget {
  // Roblox PlaceId; 0 / absent for an unpublished place (then the place name identifies it).
  placeId?: number
  place?: string
}

// A Studio window polling the bridge right now.
export interface StudioPlace extends StudioTarget {
  key: string
  pluginVersion?: number
  lastSeen: number
  // When this window started polling (its current connection); the newest is the default target.
  since: number
  // Linked to the open project's active place (its PlaceId is in the place's servePlaceIds).
  linked?: boolean
}

export interface StudioPlaces {
  places: StudioPlace[]
  // The place picked in Forge for this project (kept while it is not connected).
  chosen: StudioTarget | null
  // Where jobs go now: the chosen place when connected, else (2+ places, nothing chosen) the
  // linked / newest one; null = any Studio window (untargeted).
  target: string | null
  why: TargetWhy
}

export type TargetWhy = 'chosen' | 'linked' | 'newest' | 'lost' | 'single' | 'none'

// Settings key: { [projectRoot]: StudioTarget } ('' when no project is open).
export const STUDIO_TARGETS_SETTING = 'studio.targets'

export function targetKey(t: StudioTarget): string {
  return `${t.placeId && t.placeId > 0 ? t.placeId : 0}|${t.place ?? ''}`
}

// A published place is matched by PlaceId (its name can repeat across games); an unpublished one
// (PlaceId 0: "Place1", local files) by its name.
export function matchesTarget(t: StudioTarget, place: StudioTarget): boolean {
  if (t.placeId && t.placeId > 0) return place.placeId === t.placeId
  if (!t.place) return false
  return !(place.placeId && place.placeId > 0) && place.place === t.place
}

export function sameTarget(a: StudioTarget | null | undefined, b: StudioTarget | null | undefined): boolean {
  if (!a || !b) return !a && !b
  return targetKey(a) === targetKey(b)
}

// From IPC / settings: a valid target or null.
export function cleanTarget(v: unknown): StudioTarget | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  const placeId = typeof o.placeId === 'number' && Number.isInteger(o.placeId) && o.placeId > 0 ? o.placeId : undefined
  const place = typeof o.place === 'string' && o.place.trim() ? o.place.slice(0, 100) : undefined
  if (!placeId && !place) return null
  return { ...(placeId ? { placeId } : {}), ...(place ? { place } : {}) }
}

// Where jobs go: the chosen place while it is connected; a chosen place that is not connected falls
// back to any window ('lost'); with nothing chosen and 2+ windows, the one linked to the project's
// active place, else the one that connected last. One window (or none): untargeted.
export function resolveTarget(places: StudioPlace[], chosen: StudioTarget | null, linkedIds: number[] = []): { target: StudioPlace | null; why: TargetWhy } {
  if (chosen) {
    const hit = places.find((p) => matchesTarget(chosen, p))
    return hit ? { target: hit, why: 'chosen' } : { target: null, why: 'lost' }
  }
  if (places.length < 2) return { target: null, why: places.length ? 'single' : 'none' }
  const linked = places.filter((p) => p.placeId && linkedIds.includes(p.placeId))
  const newest = [...(linked.length ? linked : places)].sort((a, b) => b.since - a.since || a.key.localeCompare(b.key))[0]
  return { target: newest, why: linked.length ? 'linked' : 'newest' }
}

export function placeLabel(p: StudioTarget): string {
  const name = p.place || 'Untitled place'
  return p.placeId && p.placeId > 0 ? `${name} (${p.placeId})` : name
}
