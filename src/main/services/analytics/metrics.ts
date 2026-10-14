import type { Aggregation, ApiGranularity, Granularity } from './types.ts'

// Catalog of Analytics Query API metrics Forge knows how to read and summarise.
// Source: https://create.roblox.com/docs/cloud/guides/analytics/metrics (checked 2026-10-13).
// Metric names are case-sensitive. Metrics not listed here still work through analytics_series (any
// name is passed through); they get defaults guessed from the name (see metricInfo).

export type MetricCategory =
  | 'engagement'
  | 'retention'
  | 'monetization'
  | 'acquisition'
  | 'performance'
  | 'economy'
  | 'funnel'
  | 'custom'
  | 'thumbnail'
  | 'public'
  | 'other'

export interface MetricInfo {
  id: string
  label: string
  category: MetricCategory
  unit: string
  aggregation: Aggregation
  // Which way is good: 'up' (more is better), 'down' (less is better), 'none'.
  better: 'up' | 'down' | 'none'
  granularities: Granularity[]
  // Days of history the API keeps for this metric.
  retentionDays: number
  // Dimensions the metric can be broken down by (subset worth showing to agents).
  dimensions?: string[]
  // Extra names people and CSV headers use for it (lower-case, compared after normalising).
  aliases?: string[]
  known: boolean
}

const STD = ['day', 'week', 'month', 'total'] as Granularity[]
const PERF = ['minute', 'halfhour', 'hour', 'day'] as Granularity[]
const DEMO = ['AgeGroupV2', 'Country', 'Gender', 'IsNewUser', 'Locale', 'OperatingSystem', 'Platform']
const ACQ_DIMS = ['AcquisitionSource', 'AgeGroupV2', 'Gender', 'IsNewUser', 'OperatingSystem', 'Platform']
const PERF_DIMS = ['MemoryGroup', 'OperatingSystem', 'Place', 'PlaceVersion', 'Platform']
const EVENT_DIMS = ['AgeGroup', 'CustomField01', 'CustomField02', 'CustomField03', 'Gender', 'IsNewUser', 'OperatingSystem', 'PayerStatus', 'Platform']

type Def = Omit<MetricInfo, 'id' | 'known' | 'retentionDays'> & { retentionDays?: number }

const DEFS: Record<string, Def> = {
  // ---- engagement
  DailyActiveUsers: { label: 'DAU', category: 'engagement', unit: 'users', aggregation: 'mean', better: 'up', granularities: STD, dimensions: ['AcquisitionSource', ...DEMO], aliases: ['dau', 'daily active users', 'daily users'] },
  MonthlyActiveUsers: { label: 'MAU', category: 'engagement', unit: 'users', aggregation: 'last', better: 'up', granularities: ['day'], dimensions: DEMO, aliases: ['mau', 'monthly active users'] },
  DauMauStickiness: { label: 'DAU/MAU', category: 'retention', unit: 'ratio', aggregation: 'mean', better: 'up', granularities: ['day'], dimensions: DEMO, aliases: ['stickiness', 'dau/mau', 'dau mau stickiness'] },
  Visits: { label: 'Visits', category: 'engagement', unit: 'visits', aggregation: 'sum', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['visits', 'plays', 'daily visits'] },
  AverageSessionLengthMinutes: { label: 'Avg session (min)', category: 'engagement', unit: 'min', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['average session time', 'avg session time', 'average session length', 'session length', 'avg. session time'] },
  AveragePlayTimeMinutesPerDAU: { label: 'Playtime/DAU (min)', category: 'engagement', unit: 'min', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['average playtime per dau', 'playtime per dau', 'avg. playtime per dau', 'average play time per user'] },
  TotalPlayTimeHours: { label: 'Playtime (h)', category: 'engagement', unit: 'hours', aggregation: 'sum', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['total playtime', 'playtime hours', 'total play time'] },
  TotalSessionsEndedInBucket: { label: 'Sessions', category: 'engagement', unit: 'sessions', aggregation: 'sum', better: 'up', granularities: STD, dimensions: ['SessionTimeBucket', 'Platform', 'OperatingSystem'], aliases: ['sessions', 'total sessions'] },

  // ---- retention
  ForwardD1Retention: { label: 'D1 retention', category: 'retention', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ['AcquisitionSource', ...DEMO], aliases: ['d1 retention', 'day 1 retention', 'd1', 'day-1 retention'] },
  ForwardD7Retention: { label: 'D7 retention', category: 'retention', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ['AcquisitionSource', ...DEMO], aliases: ['d7 retention', 'day 7 retention', 'd7', 'day-7 retention'] },
  ForwardD30Retention: { label: 'D30 retention', category: 'retention', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ['AcquisitionSource', ...DEMO], aliases: ['d30 retention', 'day 30 retention', 'd30', 'day-30 retention'] },
  DailyCohortRetention: { label: 'Daily cohort retention', category: 'retention', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ['CohortDay', 'AcquisitionSource', 'Platform'] },
  WeeklyCohortRetention: { label: 'Weekly cohort retention', category: 'retention', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['week', 'total'], dimensions: ['CohortWeek', 'AcquisitionSource', 'Platform'] },

  // ---- monetization
  DailyRevenue: { label: 'Revenue (R$)', category: 'monetization', unit: 'robux', aggregation: 'sum', better: 'up', granularities: STD, dimensions: ['RevenueSource', 'BalanceType', ...DEMO], aliases: ['revenue', 'daily revenue', 'robux', 'robux earned', 'total revenue'] },
  AverageRevenuePerPayingUser: { label: 'ARPPU', category: 'monetization', unit: 'robux', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['arppu', 'average revenue per paying user'] },
  AverageRevenuePerUser: { label: 'ARPDAU', category: 'monetization', unit: 'robux', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['arpu', 'arpdau', 'average revenue per user', 'average revenue per dau'] },
  PayingUsers: { label: 'Payers', category: 'monetization', unit: 'users', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['paying users', 'payers'] },
  PayingUsersCVR: { label: 'Payer conversion', category: 'monetization', unit: 'rate', aggregation: 'mean', better: 'up', granularities: STD, dimensions: DEMO, aliases: ['payer conversion', 'payer conversion rate', 'paying users cvr', 'conversion rate'] },
  ItemMonetizationRevenue: { label: 'Item revenue (R$)', category: 'monetization', unit: 'robux', aggregation: 'sum', better: 'up', granularities: ['hour', 'day', 'total'], dimensions: ['ProductType', 'ProductKey', 'SalesLocation'], aliases: ['item revenue', 'product revenue'] },

  // ---- acquisition
  UniqueUsersWithImpressions: { label: 'Users w/ impressions', category: 'acquisition', unit: 'users', aggregation: 'sum', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS, aliases: ['impressions', 'users with impressions', 'unique users with impressions'] },
  UniqueUsersWithClicks: { label: 'Users w/ clicks', category: 'acquisition', unit: 'users', aggregation: 'sum', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS, aliases: ['clicks', 'users with clicks'] },
  UniqueUsersWithPlaySessions: { label: 'Users w/ plays', category: 'acquisition', unit: 'users', aggregation: 'sum', better: 'up', granularities: ['day', 'week', 'total'], dimensions: ['FunnelSource', ...ACQ_DIMS], aliases: ['users with plays', 'unique users with plays', 'new users with plays'] },
  QualifiedUniqueUsersWithPlaySessions: { label: 'Users w/ qualified plays', category: 'acquisition', unit: 'users', aggregation: 'sum', better: 'up', granularities: ['day', 'week', 'total'], dimensions: ['FunnelSource', ...ACQ_DIMS], aliases: ['qualified plays', 'users with qualified plays'] },
  ImpressionCVR: { label: 'Impression CVR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS, aliases: ['impression cvr', 'play through rate', 'play-through rate', 'ptr'] },
  ClickCVR: { label: 'Click CVR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS, aliases: ['click cvr', 'click through rate', 'ctr'] },
  EndToEndCVR: { label: 'End-to-end CVR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS, aliases: ['end to end cvr'] },
  QualifiedEndToEndCVR: { label: 'Qualified E2E CVR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ACQ_DIMS },
  RFYPlayThroughRate: { label: 'Home recs PTR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day'], dimensions: ['AgeGroupV2', 'Gender'], aliases: ['recommended for you play through rate', 'home recommendations ptr'] },
  RFYQualifiedPTR: { label: 'Home recs qualified PTR', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day'], dimensions: ['AgeGroupV2', 'Gender'], aliases: ['qualified ptr', 'qualified play through rate'] },
  RFYDeepEngagementRate: { label: 'Home recs deep engagement', category: 'acquisition', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day'], dimensions: ['AgeGroupV2', 'Gender'] },

  // ---- thumbnails (30 days of history)
  ThumbnailImpressions: { label: 'Thumbnail impressions', category: 'thumbnail', unit: 'impressions', aggregation: 'sum', better: 'up', granularities: ['hour', 'day', 'total'], retentionDays: 30, dimensions: ['ThumbnailAsset', 'ThumbnailList'] },
  ThumbnailQualifiedPTR: { label: 'Thumbnail qualified PTR', category: 'thumbnail', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['hour', 'day', 'total'], retentionDays: 30, dimensions: ['ThumbnailAsset', 'ThumbnailList'] },
  ThumbnailQualifiedPlays: { label: 'Thumbnail qualified plays', category: 'thumbnail', unit: 'plays', aggregation: 'sum', better: 'up', granularities: ['hour', 'day', 'total'], retentionDays: 30, dimensions: ['ThumbnailAsset', 'ThumbnailList'] },

  // ---- performance (28 days of history)
  ClientCrashRate15m: { label: 'Client crash rate (15m)', category: 'performance', unit: 'rate', aggregation: 'mean', better: 'down', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS, aliases: ['crash rate', 'client crash rate'] },
  ClientCrashCount: { label: 'Client crashes', category: 'performance', unit: 'crashes', aggregation: 'sum', better: 'down', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS, aliases: ['client crashes', 'client crash count'] },
  ServerCrashCount: { label: 'Server crashes', category: 'performance', unit: 'crashes', aggregation: 'sum', better: 'down', granularities: PERF, retentionDays: 28, dimensions: ['CrashType', 'Place'], aliases: ['server crashes', 'server crash count'] },
  OomUnexpectedExits: { label: 'Out-of-memory exits', category: 'performance', unit: 'exits', aggregation: 'sum', better: 'down', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS },
  ClientFpsP50: { label: 'Client FPS p50', category: 'performance', unit: 'fps', aggregation: 'mean', better: 'up', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS, aliases: ['client fps', 'fps'] },
  ClientFpsP10: { label: 'Client FPS p10', category: 'performance', unit: 'fps', aggregation: 'mean', better: 'up', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS },
  ClientMemoryUsageP90: { label: 'Client memory p90', category: 'performance', unit: 'MB', aggregation: 'mean', better: 'down', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS, aliases: ['client memory'] },
  ServerFrameRateP50: { label: 'Server FPS p50', category: 'performance', unit: 'fps', aggregation: 'mean', better: 'up', granularities: PERF, retentionDays: 28, dimensions: ['Place'], aliases: ['server fps', 'server frame rate'] },
  MemoryUsageP90: { label: 'Server memory p90', category: 'performance', unit: 'MB', aggregation: 'mean', better: 'down', granularities: [...PERF, 'total'], retentionDays: 28, dimensions: ['MemoryUsageCategory', 'Place', 'ServerAgeBucket'], aliases: ['server memory'] },
  PeakConcurrentPlayers: { label: 'Peak CCU', category: 'performance', unit: 'players', aggregation: 'max', better: 'up', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS, aliases: ['peak concurrent players', 'ccu', 'peak ccu', 'concurrent users'] },
  SessionDurationSecondsP50: { label: 'Session duration p50 (s)', category: 'performance', unit: 's', aggregation: 'mean', better: 'up', granularities: PERF, retentionDays: 28, dimensions: PERF_DIMS },

  // ---- economy / funnels / custom events (AnalyticsService)
  EconomyTransactionAmount: { label: 'Economy amount', category: 'economy', unit: 'amount', aggregation: 'sum', better: 'none', granularities: ['hour', ...STD], dimensions: ['CurrencyType', 'FlowType', 'TransactionType', 'ItemSku', ...EVENT_DIMS] },
  EconomyTransactionCount: { label: 'Economy transactions', category: 'economy', unit: 'count', aggregation: 'sum', better: 'none', granularities: ['hour', ...STD], dimensions: ['CurrencyType', 'FlowType', 'TransactionType', 'ItemSku', ...EVENT_DIMS] },
  EconomyAverageWalletBalance: { label: 'Avg wallet balance', category: 'economy', unit: 'amount', aggregation: 'mean', better: 'none', granularities: ['hour', ...STD], dimensions: ['CurrencyType', ...EVENT_DIMS] },
  FunnelStepCompletionRate: { label: 'Funnel step completion', category: 'funnel', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['total'], dimensions: ['FunnelName', 'FunnelStep', ...EVENT_DIMS] },
  FunnelStepChurnRate: { label: 'Funnel step churn', category: 'funnel', unit: 'rate', aggregation: 'mean', better: 'down', granularities: ['total'], dimensions: ['FunnelName', 'FunnelStep', ...EVENT_DIMS] },
  FunnelUserStepCompletionRate: { label: 'Funnel user step completion', category: 'funnel', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['total'], dimensions: ['FunnelName', 'FunnelStep', ...EVENT_DIMS] },
  FunnelUserTotalCount: { label: 'Funnel users', category: 'funnel', unit: 'users', aggregation: 'sum', better: 'up', granularities: ['total'], dimensions: ['FunnelName', 'FunnelStep', ...EVENT_DIMS] },
  FunnelCohortCompletionRate: { label: 'Funnel cohort completion', category: 'funnel', unit: 'rate', aggregation: 'mean', better: 'up', granularities: ['day', 'total'], dimensions: ['FunnelName', 'FunnelStep', ...EVENT_DIMS] },
  CustomEventCount: { label: 'Custom event count', category: 'custom', unit: 'events', aggregation: 'sum', better: 'none', granularities: ['hour', ...STD], dimensions: ['CustomEventName', ...EVENT_DIMS] },
  CustomEventCountUser: { label: 'Custom event users', category: 'custom', unit: 'users', aggregation: 'sum', better: 'none', granularities: ['hour', ...STD], dimensions: ['CustomEventName', ...EVENT_DIMS] },
  CustomEventSumValue: { label: 'Custom event value sum', category: 'custom', unit: 'value', aggregation: 'sum', better: 'none', granularities: ['hour', ...STD], dimensions: ['CustomEventName', ...EVENT_DIMS] },
  CustomEventAvgValue: { label: 'Custom event avg value', category: 'custom', unit: 'value', aggregation: 'mean', better: 'none', granularities: ['hour', ...STD], dimensions: ['CustomEventName', ...EVENT_DIMS] },

  // ---- Forge public-stats series (from the local snapshot history, not the API)
  'public.visits': { label: 'New visits (public)', category: 'public', unit: 'visits', aggregation: 'sum', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.visitsTotal': { label: 'Lifetime visits (public)', category: 'public', unit: 'visits', aggregation: 'last', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.playing': { label: 'Playing now (public, avg of snapshots)', category: 'public', unit: 'players', aggregation: 'mean', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.playingPeak': { label: 'Playing peak (public snapshots)', category: 'public', unit: 'players', aggregation: 'max', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.favorites': { label: 'Favorites (public)', category: 'public', unit: 'favorites', aggregation: 'last', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.newFavorites': { label: 'New favorites (public)', category: 'public', unit: 'favorites', aggregation: 'sum', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 },
  'public.likeRatio': { label: 'Like ratio (public)', category: 'public', unit: 'ratio', aggregation: 'last', better: 'up', granularities: ['hour', 'day', 'week', 'month', 'total'], retentionDays: 100000 }
}

export const METRICS: Record<string, MetricInfo> = Object.fromEntries(
  Object.entries(DEFS).map(([id, def]) => [id, { id, known: true, retentionDays: def.retentionDays ?? 1468, ...def }])
)

export const PUBLIC_METRICS = Object.keys(METRICS).filter((id) => id.startsWith('public.'))

function normaliseName(text: string): string {
  return text.toLowerCase().replace(/[_\-]+/g, ' ').replace(/[^a-z0-9/ ]+/g, '').replace(/\s+/g, ' ').trim()
}

const ALIAS_INDEX = new Map<string, string>()
for (const info of Object.values(METRICS)) {
  ALIAS_INDEX.set(normaliseName(info.id), info.id)
  ALIAS_INDEX.set(normaliseName(info.label), info.id)
  for (const alias of info.aliases ?? []) ALIAS_INDEX.set(normaliseName(alias), info.id)
}

// Exact id, or a known alias ("dau", "D7 retention", "Average Session Time"); otherwise undefined.
export function resolveMetricName(text: string): string | undefined {
  const trimmed = text.trim()
  if (METRICS[trimmed]) return trimmed
  const caseless = Object.keys(METRICS).find((id) => id.toLowerCase() === trimmed.toLowerCase())
  if (caseless) return caseless
  return ALIAS_INDEX.get(normaliseName(trimmed))
}

// Info for any metric name. Unknown API metrics get defaults guessed from the name so they still
// summarise sensibly (rates/averages/percentiles -> mean, peaks -> max, everything else -> sum).
export function metricInfo(id: string): MetricInfo {
  const known = METRICS[id]
  if (known) return known
  const isPerf = /^(Client|Server|Cpu|Memory|Oom|Session|DataStore|MemoryStore|SpeechToText|TextToSpeech)/.test(id) || /P\d0$|Avg$/.test(id)
  const isRate = /(Rate|CVR|Ratio|PTR|Retention|Avg|Average|P\d0|Stickiness)/.test(id)
  const isPeak = /^Peak|Max/.test(id)
  const category: MetricCategory = id.startsWith('csv.')
    ? 'other'
    : /^Economy/.test(id)
      ? 'economy'
      : /^Funnel/.test(id)
        ? 'funnel'
        : /^CustomEvent/.test(id)
          ? 'custom'
          : /^Thumbnail/.test(id)
            ? 'thumbnail'
            : isPerf
              ? 'performance'
              : 'other'
  return {
    id,
    label: id,
    category,
    unit: isRate ? 'rate' : 'count',
    aggregation: isPeak ? 'max' : isRate ? 'mean' : 'sum',
    better: /Crash|Error|Churn|Oom|Abuse/.test(id) ? 'down' : 'none',
    granularities: isPerf ? PERF : ['hour', ...STD],
    retentionDays: isPerf ? 28 : 1468,
    known: false
  }
}

export const API_GRANULARITY: Record<Granularity, ApiGranularity> = {
  minute: 'OneMinute',
  halfhour: 'HalfHour',
  hour: 'OneHour',
  day: 'OneDay',
  week: 'OneWeek',
  month: 'OneMonth',
  total: 'None'
}

export function parseGranularity(text: string | undefined, fallback: Granularity = 'day'): Granularity {
  if (!text) return fallback
  const t = text.toLowerCase().replace(/[^a-z0-9]/g, '')
  const map: Record<string, Granularity> = {
    minute: 'minute', oneminute: 'minute', '1m': 'minute', min: 'minute',
    halfhour: 'halfhour', '30m': 'halfhour',
    hour: 'hour', onehour: 'hour', hourly: 'hour', '1h': 'hour', h: 'hour',
    day: 'day', oneday: 'day', daily: 'day', '1d': 'day', d: 'day',
    week: 'week', oneweek: 'week', weekly: 'week', '1w': 'week', w: 'week',
    month: 'month', onemonth: 'month', monthly: 'month',
    total: 'total', none: 'total', all: 'total'
  }
  return map[t] ?? fallback
}

// The core KPIs analytics_overview reports, in order.
export const OVERVIEW_METRICS = [
  'DailyActiveUsers',
  'Visits',
  'AverageSessionLengthMinutes',
  'AveragePlayTimeMinutesPerDAU',
  'ForwardD1Retention',
  'ForwardD7Retention',
  'DailyRevenue',
  'PayingUsersCVR',
  'AverageRevenuePerPayingUser',
  'UniqueUsersWithImpressions',
  'ClientCrashRate15m'
]

// Retention metrics need their cohort to mature before the value is final.
export const RETENTION_MATURITY_DAYS: Record<string, number> = {
  ForwardD1Retention: 1,
  ForwardD7Retention: 7,
  ForwardD30Retention: 30
}
