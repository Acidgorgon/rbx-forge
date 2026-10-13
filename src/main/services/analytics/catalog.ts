import type { CatalogItem, FetchLike, Sleep } from './types.ts'

// Monetization catalog (configuration only: names, prices, for-sale state) and analytics alert
// incidents, from Open Cloud. No sales counts or revenue come from these endpoints; revenue per
// product comes from the ItemMonetizationRevenue metric (breakdown ProductType / ProductKey).
//
//  GET https://apis.roblox.com/game-passes/v1/universes/{universeId}/game-passes/creator?pageSize&pageToken
//      scope game-pass:read, 10/s per key owner, [BETA]
//      -> { gamePasses: [{ gamePassId, name, description, isForSale, iconAssetId, createdTimestamp,
//           updatedTimestamp, priceInformation, isManagedPricingEnabled }], nextPageToken }
//      https://create.roblox.com/docs/cloud/reference/features/game-passes
//  GET https://apis.roblox.com/developer-products/v2/universes/{universeId}/developer-products/creator?pageSize&pageToken
//      scope developer-product:read, 10/s per key owner, [BETA]
//      -> { developerProducts: [{ productId, name, description, iconImageAssetId, universeId, isForSale,
//           storePageEnabled, priceInformation, isImmutable, createdTimestamp, updatedTimestamp,
//           isManagedPricingEnabled }], nextPageToken }
//      https://create.roblox.com/docs/cloud/reference/features/developer-products
//  GET https://apis.roblox.com/analytics-alert-control-plane/v1/resource/Universe/id/{universeId}/alerts/incidents?startTime&endTime
//      scope universe.analytics.alert:read; startTime within the last 30 days; incidents kept ~35 days
//      https://create.roblox.com/docs/cloud/guides/alerts
//
// priceInformation's inner shape is not spelled out on the reference page; the parser accepts the
// common spellings (defaultPriceInRobux, priceInRobux, price) and leaves the price out otherwise.

const BASE = 'https://apis.roblox.com'
const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export class CatalogError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'CatalogError'
    this.status = status
  }
}

interface Deps {
  apiKey: string
  fetch?: FetchLike
  sleep?: Sleep
  // Safety cap on pages (default 20 pages of 50).
  maxPages?: number
}

async function getPage(deps: Deps, url: string, scope: string): Promise<Record<string, unknown>> {
  const fetch = deps.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const sleep = deps.sleep ?? defaultSleep
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, { method: 'GET', headers: { 'x-api-key': deps.apiKey, accept: 'application/json' } })
    const text = await res.text()
    if ((res.status === 429 || res.status === 503) && attempt < 3) {
      await sleep(1000 * 2 ** attempt)
      continue
    }
    if (res.status === 401 || res.status === 403) throw new CatalogError(`The API key needs ${scope} on this experience (${res.status}).`, res.status)
    if (!res.ok) throw new CatalogError(`Open Cloud returned ${res.status}: ${text.slice(0, 200)}`, res.status)
    try {
      return JSON.parse(text) as Record<string, unknown>
    } catch {
      throw new CatalogError(`Unexpected Open Cloud response: ${text.slice(0, 200)}`)
    }
  }
}

export function priceOf(info: unknown): number | undefined {
  if (typeof info === 'number') return info
  if (!info || typeof info !== 'object') return undefined
  const o = info as Record<string, unknown>
  for (const key of ['defaultPriceInRobux', 'priceInRobux', 'price', 'robux']) {
    const v = o[key]
    if (typeof v === 'number') return v
    if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v)
  }
  return undefined
}

async function paged(deps: Deps, base: string, listKey: string, scope: string): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = []
  let token: string | undefined
  for (let page = 0; page < (deps.maxPages ?? 20); page++) {
    const url = `${base}?pageSize=50${token ? `&pageToken=${encodeURIComponent(token)}` : ''}`
    const json = await getPage(deps, url, scope)
    out.push(...((json[listKey] as Record<string, unknown>[] | undefined) ?? []))
    token = typeof json.nextPageToken === 'string' && json.nextPageToken ? json.nextPageToken : undefined
    if (!token) break
  }
  return out
}

export async function listGamePasses(universeId: number, deps: Deps): Promise<CatalogItem[]> {
  const rows = await paged(deps, `${BASE}/game-passes/v1/universes/${universeId}/game-passes/creator`, 'gamePasses', 'game-pass:read')
  return rows.map((r) => ({
    kind: 'gamePass' as const,
    id: Number(r.gamePassId),
    name: String(r.name ?? ''),
    isForSale: r.isForSale === true,
    priceRobux: priceOf(r.priceInformation),
    created: typeof r.createdTimestamp === 'string' ? r.createdTimestamp : undefined,
    updated: typeof r.updatedTimestamp === 'string' ? r.updatedTimestamp : undefined
  }))
}

export async function listDeveloperProducts(universeId: number, deps: Deps): Promise<CatalogItem[]> {
  const rows = await paged(deps, `${BASE}/developer-products/v2/universes/${universeId}/developer-products/creator`, 'developerProducts', 'developer-product:read')
  return rows.map((r) => ({
    kind: 'developerProduct' as const,
    id: Number(r.productId),
    name: String(r.name ?? ''),
    isForSale: r.isForSale === true,
    priceRobux: priceOf(r.priceInformation),
    created: typeof r.createdTimestamp === 'string' ? r.createdTimestamp : undefined,
    updated: typeof r.updatedTimestamp === 'string' ? r.updatedTimestamp : undefined
  }))
}

export interface AlertIncident {
  id: string
  status: string
  alert: string
  metric: string
  severity?: string
  openedAt?: string
  resolvedAt?: string
  firingValue?: number
}

export async function listAlertIncidents(universeId: number, range: { start: string; end: string }, deps: Deps): Promise<AlertIncident[]> {
  const url = `${BASE}/analytics-alert-control-plane/v1/resource/Universe/id/${universeId}/alerts/incidents?startTime=${encodeURIComponent(range.start)}&endTime=${encodeURIComponent(range.end)}`
  const json = (await getPage(deps, url, 'universe.analytics.alert:read')) as unknown
  const rows = (Array.isArray(json) ? json : ((json as Record<string, unknown>).incidents as unknown[]) ?? []) as Record<string, unknown>[]
  return rows.map((r) => {
    const cfg = (r.alertConfig ?? {}) as Record<string, unknown>
    const firing = ((r.latestFiringMetadata ?? r.firstFiringMetadata ?? {}) as Record<string, unknown>).firingCondition as Record<string, unknown> | undefined
    return {
      id: String(r.id ?? ''),
      status: String(r.status ?? ''),
      alert: String(cfg.name ?? cfg.id ?? ''),
      metric: String(cfg.metric ?? ''),
      severity: typeof cfg.severity === 'string' ? cfg.severity : undefined,
      openedAt: typeof r.openedAt === 'string' ? r.openedAt : undefined,
      resolvedAt: typeof r.resolvedAt === 'string' ? r.resolvedAt : undefined,
      firingValue: typeof firing?.firingValue === 'number' ? firing.firingValue : undefined
    }
  })
}
