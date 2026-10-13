import { z, type ZodRawShape } from 'zod'
import { formatAcquisition, formatCatalog, formatCompare, formatOverview, formatSeriesResult, formatStatus } from './format.ts'
import { OVERVIEW_METRICS, parseGranularity, PUBLIC_METRICS, resolveMetricName } from './metrics.ts'
import type { AnalyticsService } from './service.ts'
import { analyticsSnippet, INSTRUMENTATION_HINTS, type SnippetKind } from './snippets.ts'

// Agent tools for analytics. Each is structurally a GentreeTool from src/main/agent/tools.ts
// ({ name, description, inputSchema: zod raw shape, handler }) so the integrator can append them to the
// gentree tool list unchanged (SDK MCP server and OpenAI loop both work). Kept here, not in agent/,
// so this module has no dependency on the agent code. All are read-only.

export type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export interface AnalyticsTool<S extends ZodRawShape = ZodRawShape> {
  name: string
  description: string
  inputSchema: S
  handler: (args: z.infer<z.ZodObject<S>>, extra: unknown) => Promise<ToolResult>
}

function tool<S extends ZodRawShape>(name: string, description: string, inputSchema: S, handler: (args: z.infer<z.ZodObject<S>>) => Promise<string>): AnalyticsTool<S> {
  return {
    name,
    description,
    inputSchema,
    handler: async (args) => {
      try {
        return { content: [{ type: 'text', text: await handler(args) }] }
      } catch (error) {
        return { content: [{ type: 'text', text: `${name} failed: ${(error as Error).message}` }], isError: true }
      }
    }
  }
}

const RANGE = z.string().optional().describe('"7d", "28d", "12w", or "2026-09-01..2026-09-30" (inclusive days, UTC). Relative ranges end yesterday (data lags ~1 day).')

const RELATE_TO_CODE = `Relating numbers to code: (1) when a KPI moves, check the "releases in range" line and the release-impact signals, then read that tag's changelog / git log for the features touched (git log <prevTag>..<tag>) — a D1 drop right after a release usually means onboarding or first-session changes; a crash-rate or memory jump points at that release's client code (break down by PlaceVersion). (2) Map metric -> GenTree area: retention/session length -> core loop Services + onboarding Controllers; payer conversion/ARPPU -> shop Controller, MarketplaceService ProcessReceipt, Features/<Shop>; crashes/FPS/memory -> client Controllers, UI, effects; acquisition (impressions, plays/impression) -> thumbnail/icon/title/description, not code. (3) If a question cannot be answered because the event is not tracked, propose instrumentation with analytics_instrument.`

export function createAnalyticsTools(service: AnalyticsService): AnalyticsTool<any>[] {
  const metric = (m: string) => resolveMetricName(m) ?? m
  return [
    tool(
      'analytics_overview',
      `Key KPIs for this experience over a period with period-over-period change, live public stats, and computed signals (week-over-week moves, matured retention cohort deltas, anomalies, release impact). Start here. Default KPIs: ${OVERVIEW_METRICS.join(', ')}. Values are API data when an Open Cloud key is set, else imported dashboard CSVs, else Forge's public snapshots (each line says which). Retention windows are shifted back so only matured cohorts count. ${RELATE_TO_CODE}`,
      {
        range: RANGE,
        metrics: z.array(z.string()).optional().describe('Override the KPI list (API metric names or aliases like "dau", "d7 retention").')
      },
      async (a) => formatOverview(await service.overview({ range: a.range, metrics: a.metrics?.map(metric) }))
    ),
    tool(
      'analytics_series',
      `Time series for one metric, compact: a header (metric, source, unit, aggregation, total) then values in order from the start date ("_" = no data, "~" = projected, "?" = not significant). Any Analytics Query API metric name works (case-sensitive), e.g. DailyActiveUsers, Visits, ForwardD1Retention, ForwardD7Retention, AverageSessionLengthMinutes, DailyRevenue, PayingUsersCVR, AverageRevenuePerPayingUser, ItemMonetizationRevenue (breakdown ProductType/ProductKey = revenue per pass/product), UniqueUsersWithImpressions, ClientCrashRate15m, ServerCrashCount, ClientFpsP50, ClientMemoryUsageP90, PeakConcurrentPlayers (performance metrics keep 28 days), CustomEventCount (breakdown CustomEventName), FunnelStepCompletionRate (granularity total, breakdown FunnelStep, filter FunnelName), EconomyTransactionAmount (breakdown FlowType/CurrencyType). Public no-key metrics: ${PUBLIC_METRICS.join(', ')}. Imported CSV-only metrics are named csv.<slug>. Breakdowns: Platform, OperatingSystem, Country, AgeGroupV2, IsNewUser, AcquisitionSource, PlaceVersion, ... (not every metric supports every dimension). Prefer coarse granularity and short ranges to save tokens and the 30-queries/minute API budget. ${RELATE_TO_CODE}`,
      {
        metric: z.string().describe('API metric name or alias'),
        range: RANGE,
        granularity: z.string().optional().describe('minute|halfhour|hour (performance only) | day | week | month | total'),
        breakdown: z.array(z.string()).optional().describe('Dimension names, e.g. ["Platform"]'),
        filter: z
          .array(z.object({ dimension: z.string(), values: z.array(z.string()), operation: z.enum(['In', 'NotIn', 'GreaterThan', 'GreaterThanOrEqual', 'LessThan', 'LessThanOrEqual', 'Match']).optional() }))
          .optional(),
        limit: z.number().int().positive().max(100).optional().describe('Top-N breakdown series (granularity total only)'),
        source: z.enum(['auto', 'api', 'csv', 'public']).optional()
      },
      async (a) =>
        formatSeriesResult(
          await service.series({ metric: metric(a.metric), range: a.range, granularity: parseGranularity(a.granularity, 'day'), breakdown: a.breakdown, filter: a.filter, limit: a.limit, source: a.source })
        )
    ),
    tool(
      'analytics_compare',
      `Compare metrics between two periods (A vs B; B defaults to the equal-length period just before A). Use it for before/after a release (A = "2026-10-01..2026-10-07", B = "2026-09-24..2026-09-30"), a weekend vs a weekday, or an update vs the last one. Change is relative (+12% = A is 12% above B), using each metric's aggregation (sum for counts, mean for rates/DAU). ${RELATE_TO_CODE}`,
      {
        metrics: z.array(z.string()).min(1).max(12),
        a: z.string().describe('Period A (range syntax)'),
        b: z.string().optional().describe('Period B (range syntax); default = the period before A')
      },
      async (a) => formatCompare(await service.compare({ metrics: a.metrics.map(metric), a: a.a, b: a.b }))
    ),
    tool(
      'acquisition_report',
      'How players find the experience: unique users with impressions and with plays per acquisition source (Home recommendations, Search, Friends, Sponsored ads, ...) this period vs the previous one, plays per impression, qualified plays, home-recommendation play-through / qualified PTR / deep-engagement rates, new vs returning DAU, plus public-snapshot trends (new visits, new favorites, like ratio). Falling impressions = less distribution (often engagement/retention feeding the recommender); falling plays/impression = thumbnail, icon, title or age rating not converting; low qualified share = players bounce in the first minutes (check spawn/loading/onboarding). Acquisition is mostly fixed outside code; say so when that is the case.',
      { range: RANGE },
      async (a) => formatAcquisition(await service.acquisition({ range: a.range }))
    ),
    tool(
      'analytics_instrument',
      `Luau snippets that add AnalyticsService instrumentation the GenTree way (server Features/<Name>/<Name>Service.luau wrapper + shared config listing event names). kind: setup (create the wrapper once), custom (core-loop event), onboarding (one-time funnel), funnel (recurring shop funnel with a GUID per visit), economy (currency source/sink), progression. When to suggest which: ${INSTRUMENTATION_HINTS.map((h) => `${h.when} -> ${h.kind} (${h.why})`).join('; ')}. Events are server-only, recorded only in published games, and appear in analytics after up to 24 h. Show the snippet and where it goes; write files only if the person agrees.`,
      {
        kind: z.enum(['setup', 'custom', 'onboarding', 'funnel', 'economy', 'progression']),
        feature: z.string().optional().describe('Wrapper feature name (default Telemetry)'),
        eventName: z.string().optional(),
        funnelName: z.string().optional(),
        steps: z.array(z.string()).max(20).optional(),
        currency: z.string().optional(),
        flow: z.enum(['Source', 'Sink']).optional(),
        transactionType: z.string().optional(),
        itemSku: z.string().optional(),
        callSite: z.string().optional().describe('Where the call goes, e.g. "ShopService.Purchase"')
      },
      async (a) => {
        const s = analyticsSnippet(a.kind as SnippetKind, a)
        const parts: string[] = []
        for (const f of s.files) parts.push(`--- ${f.path}\n${f.code}`)
        if (s.call) parts.push(`--- call site\n${s.call}`)
        parts.push('notes:\n- ' + s.notes.join('\n- '))
        return parts.join('\n')
      }
    ),
    tool(
      'analytics_status',
      'What analytics data Forge can see for this experience: universe/place IDs, whether an Open Cloud API key is set (and any scope problem), the public-stats poller, and which dashboard CSVs were imported (metric and date span). Also lists game passes and developer products with prices when the key has game-pass:read / developer-product:read, and recent analytics alert incidents (universe.analytics.alert:read). Use it when data is missing to tell the person exactly what to set up.',
      { catalog: z.boolean().optional().describe('Also list passes/products (default true)'), incidents: z.boolean().optional().describe('Also list alert incidents of the last 7 days (default true)') },
      async (a) => {
        const parts = [formatStatus(await service.status())]
        if (a.catalog !== false) {
          const c = await service.catalog()
          parts.push('catalog:\n' + formatCatalog(c.items) + (c.notes.length ? '\nnotes: ' + c.notes.join(' | ') : ''))
        }
        if (a.incidents !== false) {
          const i = await service.incidents(7)
          parts.push(
            'alert incidents (7d): ' +
              (i.incidents.length ? '\n' + i.incidents.map((x) => `${x.status} ${x.severity ?? ''} ${x.alert} ${x.metric} value=${x.firingValue ?? '?'} opened=${x.openedAt ?? '?'}`).join('\n') : 'none') +
              (i.notes.length ? '\nnotes: ' + i.notes.join(' | ') : '')
          )
        }
        return parts.join('\n')
      }
    )
  ]
}
