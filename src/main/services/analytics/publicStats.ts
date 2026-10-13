import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { metricInfo } from './metrics.ts'
import { formatBucket, isoDay, parseTime, rebucket } from './series.ts'
import type { FetchLike, Granularity, PublicSnapshot, PublicStats, Series, SeriesPoint, Sleep } from './types.ts'

// Public experience stats (no auth) and a local snapshot history so trends exist without any API key.
//
//  GET https://games.roblox.com/v1/games?universeIds=1,2,...
//      -> { data: [{ id, rootPlaceId, name, playing, visits, maxPlayers, created, updated, favoritedCount, ... }] }
//  GET https://games.roblox.com/v1/games/votes?universeIds=1,2,...
//      -> { data: [{ id, upVotes, downVotes }] }
//  Both are listed without a cookie on https://create.roblox.com/docs/cloud/reference/domains/games
//  (marked Experimental / legacy web APIs, no published rate limit). Field names checked live on
//  universe 13058 on 2026-10-13. `visits` and `favoritedCount` are lifetime counters, `playing` is
//  the current concurrent player count, so trends come from differencing snapshots.

export const GAMES_BASE = 'https://games.roblox.com'

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function getJson(fetch: FetchLike, url: string, sleep: Sleep, retries = 2): Promise<unknown> {
  for (let attempt = 0; ; attempt++) {
    let res: Awaited<ReturnType<FetchLike>>
    try {
      res = await fetch(url, { method: 'GET', headers: { accept: 'application/json' } })
    } catch (error) {
      throw new Error(`Could not reach Roblox: ${error instanceof Error ? error.message : String(error)}`)
    }
    const text = await res.text()
    if ((res.status === 429 || res.status >= 500) && attempt < retries) {
      const after = Number(res.headers.get('retry-after'))
      await sleep(Number.isFinite(after) && after > 0 ? Math.min(60, after) * 1000 : 2000 * 2 ** attempt)
      continue
    }
    if (!res.ok) throw new Error(`games.roblox.com returned ${res.status}${res.status === 429 ? ' (rate limited)' : ''}`)
    try {
      return JSON.parse(text)
    } catch {
      throw new Error(`Unexpected games.roblox.com response: ${text.slice(0, 200)}`)
    }
  }
}

export async function fetchPublicStats(universeIds: number[], options: { fetch?: FetchLike; sleep?: Sleep } = {}): Promise<PublicStats[]> {
  if (!universeIds.length) return []
  const fetch = options.fetch ?? (globalThis.fetch as unknown as FetchLike)
  const sleep = options.sleep ?? defaultSleep
  const ids = universeIds.join(',')
  const [games, votes] = await Promise.all([
    getJson(fetch, `${GAMES_BASE}/v1/games?universeIds=${ids}`, sleep),
    getJson(fetch, `${GAMES_BASE}/v1/games/votes?universeIds=${ids}`, sleep).catch(() => ({ data: [] }))
  ])
  const voteMap = new Map<number, { upVotes?: number; downVotes?: number }>()
  for (const v of ((votes as { data?: unknown[] }).data ?? []) as { id: number; upVotes?: number; downVotes?: number }[]) voteMap.set(v.id, v)
  return (((games as { data?: unknown[] }).data ?? []) as Record<string, unknown>[]).map((g) => {
    const id = Number(g.id)
    const vote = voteMap.get(id)
    return {
      universeId: id,
      rootPlaceId: typeof g.rootPlaceId === 'number' ? g.rootPlaceId : undefined,
      name: typeof g.name === 'string' ? g.name : undefined,
      visits: Number(g.visits) || 0,
      playing: Number(g.playing) || 0,
      favorites: Number(g.favoritedCount) || 0,
      upVotes: vote?.upVotes,
      downVotes: vote?.downVotes,
      maxPlayers: typeof g.maxPlayers === 'number' ? g.maxPlayers : undefined,
      updated: typeof g.updated === 'string' ? g.updated : undefined
    }
  })
}

// ---------------------------------------------------------------- history file (JSON Lines)

export function readHistory(file: string): PublicSnapshot[] {
  if (!existsSync(file)) return []
  const out: PublicSnapshot[] = []
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue
    try {
      const s = JSON.parse(line) as PublicSnapshot
      if (typeof s.at === 'string' && Number.isFinite(s.visits)) out.push(s)
    } catch {
      // A torn last line (crash mid-write) is skipped, not fatal.
    }
  }
  return out.sort((a, b) => parseTime(a.at) - parseTime(b.at))
}

export function appendSnapshot(file: string, snapshot: PublicSnapshot): void {
  mkdirSync(dirname(file), { recursive: true })
  appendFileSync(file, JSON.stringify(snapshot) + '\n')
}

export function toSnapshot(stats: PublicStats, at: number): PublicSnapshot {
  const s: PublicSnapshot = { at: new Date(at).toISOString(), visits: stats.visits, playing: stats.playing, favorites: stats.favorites }
  if (stats.upVotes !== undefined) s.up = stats.upVotes
  if (stats.downVotes !== undefined) s.down = stats.downVotes
  return s
}

// Derives a public.* series from snapshots at hour/day/week/month granularity.
//  public.visits / public.newFavorites: growth of the lifetime counter per bucket (difference of the
//    last snapshot in the bucket and the last snapshot before it; the first bucket has no baseline and
//    is dropped). Counter resets (negative growth) are clamped to 0.
//  public.visitsTotal / public.favorites / public.likeRatio: last value in the bucket.
//  public.playing: mean of snapshots in the bucket; public.playingPeak: max.
export function historySeries(snapshots: PublicSnapshot[], metric: string, granularity: Granularity): Series {
  const info = metricInfo(metric)
  const base: Series = { metric, source: 'public', granularity, unit: info.unit, aggregation: info.aggregation, points: [] }
  if (!snapshots.length) return base
  const bucketG: Granularity = granularity === 'total' ? 'day' : granularity === 'minute' || granularity === 'halfhour' ? 'hour' : granularity
  const groups = new Map<string, PublicSnapshot[]>()
  for (const s of snapshots) {
    const key = formatBucket(bucketStartFor(parseTime(s.at), bucketG), bucketG)
    const list = groups.get(key) ?? []
    list.push(s)
    groups.set(key, list)
  }
  const keys = [...groups.keys()].sort((a, b) => parseTime(a) - parseTime(b))
  const points: SeriesPoint[] = []
  let prevLast: PublicSnapshot | undefined
  for (const key of keys) {
    const list = groups.get(key)!
    const last = list[list.length - 1]
    let v: number | undefined
    switch (metric) {
      case 'public.visits':
        v = prevLast ? Math.max(0, last.visits - prevLast.visits) : undefined
        break
      case 'public.newFavorites':
        v = prevLast ? Math.max(0, last.favorites - prevLast.favorites) : undefined
        break
      case 'public.visitsTotal':
        v = last.visits
        break
      case 'public.favorites':
        v = last.favorites
        break
      case 'public.likeRatio':
        v = last.up !== undefined && last.down !== undefined && last.up + last.down > 0 ? last.up / (last.up + last.down) : undefined
        break
      case 'public.playing':
        v = list.reduce((a, s) => a + s.playing, 0) / list.length
        break
      case 'public.playingPeak':
        v = Math.max(...list.map((s) => s.playing))
        break
      default:
        throw new Error(`Unknown public metric ${metric}`)
    }
    if (v !== undefined) points.push({ t: key, v })
    prevLast = last
  }
  const series = { ...base, granularity: bucketG, points }
  return granularity === 'total' ? rebucket(series, 'total') : series
}

function bucketStartFor(ms: number, g: Granularity): number {
  if (g === 'hour') return Math.floor(ms / 3_600_000) * 3_600_000
  if (g === 'day') return Math.floor(ms / 86_400_000) * 86_400_000
  if (g === 'week') {
    const d = Math.floor(ms / 86_400_000) * 86_400_000
    return d - ((new Date(d).getUTCDay() + 6) % 7) * 86_400_000
  }
  const date = new Date(ms)
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)
}

// ---------------------------------------------------------------- poller

export interface PollerOptions {
  universeId: number
  historyFile: string
  intervalMinutes?: number // default 15
  fetch?: FetchLike
  sleep?: Sleep
  now?: () => number
  // Skip writing when the previous snapshot is newer than this (default 5 min) unless forced.
  minGapMinutes?: number
  onSnapshot?: (snapshot: PublicSnapshot) => void
  onError?: (error: Error) => void
  // Timer injection for tests; defaults to setInterval/clearInterval.
  setInterval?: (fn: () => void, ms: number) => unknown
  clearInterval?: (handle: unknown) => void
}

export class PublicStatsPoller {
  private handle: unknown
  private readonly o: PollerOptions
  private lastAt: number | undefined

  constructor(options: PollerOptions) {
    this.o = options
    const history = readHistory(options.historyFile)
    if (history.length) this.lastAt = parseTime(history[history.length - 1].at)
  }

  get running(): boolean {
    return this.handle !== undefined
  }

  get intervalMinutes(): number {
    return this.o.intervalMinutes ?? 15
  }

  start(): void {
    if (this.handle !== undefined) return
    const set = this.o.setInterval ?? ((fn: () => void, ms: number) => setInterval(fn, ms))
    void this.pollNow().catch(() => undefined)
    this.handle = set(() => void this.pollNow().catch(() => undefined), this.intervalMinutes * 60_000)
  }

  stop(): void {
    if (this.handle === undefined) return
    const clear = this.o.clearInterval ?? ((h: unknown) => clearInterval(h as ReturnType<typeof setInterval>))
    clear(this.handle)
    this.handle = undefined
  }

  // Takes one snapshot; returns it, or undefined when skipped (too soon after the last one).
  async pollNow(force = false): Promise<PublicSnapshot | undefined> {
    const now = (this.o.now ?? Date.now)()
    const gap = (this.o.minGapMinutes ?? 5) * 60_000
    if (!force && this.lastAt !== undefined && now - this.lastAt < gap) return undefined
    try {
      const [stats] = await fetchPublicStats([this.o.universeId], { fetch: this.o.fetch, sleep: this.o.sleep })
      if (!stats) throw new Error(`games.roblox.com has no experience ${this.o.universeId}`)
      const snapshot = toSnapshot(stats, now)
      appendSnapshot(this.o.historyFile, snapshot)
      this.lastAt = now
      this.o.onSnapshot?.(snapshot)
      return snapshot
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      this.o.onError?.(err)
      throw err
    }
  }

  history(): PublicSnapshot[] {
    return readHistory(this.o.historyFile)
  }
}

export function describeSnapshotSpan(snapshots: PublicSnapshot[]): string {
  if (!snapshots.length) return 'no public snapshots yet'
  return `${snapshots.length} snapshots ${isoDay(parseTime(snapshots[0].at))}..${isoDay(parseTime(snapshots[snapshots.length - 1].at))}`
}
