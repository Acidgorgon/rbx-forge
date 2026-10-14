// Types for the Analytics service (main process). Plain data only, so the integrator can mirror them
// into src/shared/types.ts (see CONTRACT.md) and return results over IPC as is. Nothing here imports
// electron.

import type { FetchLike, KeyValueStore, SecretStore, Sleep } from '../release/types.ts'

export type { FetchLike, KeyValueStore, SecretStore, Sleep }

// ---------------------------------------------------------------- series

// Analytics Query API granularities (create.roblox.com/docs/cloud/guides/analytics).
export type ApiGranularity = 'OneMinute' | 'HalfHour' | 'OneHour' | 'OneDay' | 'OneWeek' | 'OneMonth' | 'None'

// The short names agents and the UI use.
export type Granularity = 'minute' | 'halfhour' | 'hour' | 'day' | 'week' | 'month' | 'total'

// Where a series came from.
//  api    = Open Cloud Analytics Query API (needs an API key with universe.analytics:read)
//  csv    = a chart the creator exported from the Creator Dashboard and imported into Forge
//  public = Forge's own snapshots of the public games API (visits/playing/favorites/votes)
export type SeriesSource = 'api' | 'csv' | 'public'

// How values combine when a range or bucket is summarised.
//  sum  = additive counts (visits, revenue, sessions, impressions)
//  mean = rates, averages, and per-day uniques such as DAU (summing DAU gives user-days, not users)
//  last = gauges / cumulative counters (MAU, lifetime visits, favorites)
//  max  = peaks (concurrent players)
export type Aggregation = 'sum' | 'mean' | 'last' | 'max'

export interface SeriesPoint {
  // ISO date "YYYY-MM-DD" for day+ buckets, full ISO timestamp for sub-day buckets.
  t: string
  v: number
  // Set when the API marked the point Projected (may still change) or NotStatisticallySignificant.
  flag?: 'projected' | 'insignificant'
}

export interface Series {
  metric: string
  source: SeriesSource
  granularity: Granularity
  unit: string
  aggregation: Aggregation
  // Dimension -> value for one breakdown series (e.g. { AcquisitionSource: "Search" }).
  breakdown?: Record<string, string>
  points: SeriesPoint[]
}

export interface DateRange {
  // Inclusive start, exclusive end, both ISO "YYYY-MM-DD" (UTC days) or full ISO timestamps.
  start: string
  end: string
}

export interface MetricFilter {
  dimension: string
  values: string[]
  operation?: 'In' | 'NotIn' | 'GreaterThan' | 'GreaterThanOrEqual' | 'LessThan' | 'LessThanOrEqual' | 'Match'
}

export interface SeriesQuery {
  metric: string
  range: DateRange
  granularity: Granularity
  breakdown?: string[]
  filter?: MetricFilter[]
  // Top-N breakdown series (API: only with granularity "total" and a breakdown).
  limit?: number
}

// ---------------------------------------------------------------- public stats

export interface PublicStats {
  universeId: number
  rootPlaceId?: number
  name?: string
  visits: number
  playing: number
  favorites: number
  upVotes?: number
  downVotes?: number
  maxPlayers?: number
  updated?: string
}

// One line of the local history file (JSON Lines).
export interface PublicSnapshot {
  at: string // ISO timestamp
  visits: number
  playing: number
  favorites: number
  up?: number
  down?: number
}

// ---------------------------------------------------------------- catalog (Open Cloud)

export interface CatalogItem {
  kind: 'gamePass' | 'developerProduct'
  id: number
  name: string
  isForSale: boolean
  priceRobux?: number
  created?: string
  updated?: string
}

// ---------------------------------------------------------------- insights

export type SignalSeverity = 'info' | 'good' | 'warn' | 'bad'

export interface Signal {
  id: string
  metric: string
  severity: SignalSeverity
  // One sentence a person (or agent) can act on.
  text: string
  // The numbers behind it so the signal is explainable.
  evidence: Record<string, number | string | null>
}

export interface ReleaseMarker {
  tag: string
  // ISO timestamp or date.
  at: string
}

export interface KpiDelta {
  metric: string
  label: string
  unit: string
  source: SeriesSource
  current: number | null
  previous: number | null
  // Relative change (0.12 = +12%); null when previous is 0/missing.
  change: number | null
}

// ---------------------------------------------------------------- status

export interface AnalyticsStatus {
  universeId: number | null
  placeId: number | null
  hasApiKey: boolean
  // Last API auth problem (401/403) so the UI can explain the missing scope.
  apiProblem?: string
  poller: { running: boolean; intervalMinutes: number; snapshots: number; lastAt?: string }
  imports: ImportSummary[]
  // No key and public stats not turned on: Forge makes no Roblox calls (the page shows how to add a key).
  keyless?: boolean
}

export interface ImportSummary {
  metric: string
  label: string
  points: number
  first?: string
  last?: string
  breakdown?: Record<string, string>
  importedAt: string
  file?: string
}

export interface CsvImportResult {
  series: ImportSummary[]
  warnings: string[]
}
