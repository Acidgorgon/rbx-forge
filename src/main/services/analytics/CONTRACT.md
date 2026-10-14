# Analytics service: integration contract

Gives Forge's agents (and an Analytics panel) the experience's game analytics. Main-process only,
fetch-based, no electron imports, no new npm packages. Everything is exported from
`src/main/services/analytics/index.ts`. Tests: `test/analytics.test.ts` (API client, catalog,
service, tools), `test/analyticsCsv.test.ts` (dashboard CSV import), `test/analyticsInsights.test.ts`
(series math, insights, public stats + poller), `test/analyticsFake.test.ts` (fake fetch/clock).

| File | What it does |
|---|---|
| `types.ts` | Plain-data types (Series, PublicSnapshot, Signal, KpiDelta, AnalyticsStatus, ...) to mirror into `src/shared/types.ts` |
| `metrics.ts` | Metric catalog (label, unit, aggregation, good direction, granularities, retention, dimensions, aliases), `resolveMetricName`, `parseGranularity`, overview KPI list |
| `series.ts` | Range syntax (`7d`, `12w`, `2026-09-01..2026-09-30`), UTC bucketing, rebucket by aggregation, gap fill, compact text |
| `queryClient.ts` | Open Cloud **Analytics Query API** client: POST metrics / dimension-values, 202 polling, 30/min limiter, 429/5xx backoff, TTL cache, error mapping |
| `publicStats.ts` | `games.roblox.com` public stats (visits, playing, favorites, votes), JSONL snapshot history, `PublicStatsPoller`, `historySeries` |
| `catalog.ts` | Game passes / developer products (config + price), analytics alert incidents |
| `csvImport.ts` | Creator Dashboard CSV import (KPI chart exports, sales transaction CSV) -> same Series format; `ImportStore` in userData |
| `insights.ts` | Explainable signals without an LLM: week-over-week, period compare, matured retention cohort deltas, 3-sigma anomalies, release impact, conversion rates |
| `snippets.ts` | Luau AnalyticsService instrumentation snippets in GenTree layout |
| `service.ts` | `AnalyticsService` facade: source selection (API > CSV > public), overview / series / compare / acquisition / catalog / incidents / import |
| `format.ts` | Compact text renderers for tool output |
| `tools.ts` | `createAnalyticsTools(service)`: 6 agent tools, structurally `GentreeTool`s |

## 0. What Roblox exposes (checked 2026-10-13)

Sources: [Analytics guide](https://create.roblox.com/docs/cloud/guides/analytics),
[supported metrics](https://create.roblox.com/docs/cloud/guides/analytics/metrics),
[analytics reference](https://create.roblox.com/docs/cloud/reference/features/analytics) (endpoints `[BETA]`, 30 POST/min + 3000 poll GET/min per key owner),
[announcement 2026-08-24](https://devforum.roblox.com/t/new-opencloud-apis-for-analytics-events-experiments-and-thumbnail-personalization/4828676),
[alerts guide](https://create.roblox.com/docs/cloud/guides/alerts),
[game passes](https://create.roblox.com/docs/cloud/reference/features/game-passes),
[developer products](https://create.roblox.com/docs/cloud/reference/features/developer-products),
[games domain](https://create.roblox.com/docs/cloud/reference/domains/games),
[dashboard (export)](https://create.roblox.com/docs/production/analytics/analytics-dashboard),
[acquisition page](https://create.roblox.com/docs/production/analytics/acquisition),
[missing endpoints thread](https://devforum.roblox.com/t/endpoints-for-first-play-bounce-rate-and-creator-rewards/4752572).

API key permissions to create (create.roblox.com/dashboard/credentials, add the experience under Access Permissions):

| Need | System / operation |
|---|---|
| Metrics, dimension values | `universe-analytics` -> `universe.analytics:read` |
| Alert incidents (optional) | `universe.analytics.alert:read` |
| Game passes (optional) | `game-pass:read` |
| Developer products (optional) | `developer-product:read` |

OAuth 2.0: the reference lists per-authorization rate limits, but whether third-party OAuth apps can
get `universe.analytics:read` was unanswered in the announcement thread, so Forge uses API keys only.

Not available by any official API (use CSV import, or nothing): benchmarks vs similar experiences,
first-play bounce rate, creator rewards / engagement payouts, Premium payouts and upsell stats, DevEx
history, per-transaction sales history (only the 48-hour-refreshed sales CSV; the API has
`ItemMonetizationRevenue` revenue by product but no sale counts), the dashboard's Feedback / ratings
breakdowns and error-report page, share-link attribution, group-owned games for users without key
rights on the group. `llms.txt` on create.roblox.com still says DAU/MAU are not available by API;
that line predates the Analytics Query API and is stale.

## 1. Add to `src/shared/types.ts`

Mirror these (structurally identical to `analytics/types.ts` + `service.ts` results):

```ts
// ---- Analytics (main/services/analytics) ----
export type AnalyticsGranularity = 'minute' | 'halfhour' | 'hour' | 'day' | 'week' | 'month' | 'total'
export type AnalyticsSource = 'api' | 'csv' | 'public'
export interface AnalyticsPoint { t: string; v: number; flag?: 'projected' | 'insignificant' }
export interface AnalyticsSeries {
  metric: string
  source: AnalyticsSource
  granularity: AnalyticsGranularity
  unit: string
  aggregation: 'sum' | 'mean' | 'last' | 'max'
  breakdown?: Record<string, string>
  points: AnalyticsPoint[]
}
export interface AnalyticsRange { start: string; end: string } // inclusive start, exclusive end (UTC days)
export interface AnalyticsSignal { id: string; metric: string; severity: 'info' | 'good' | 'warn' | 'bad'; text: string; evidence: Record<string, number | string | null> }
export interface AnalyticsKpi { metric: string; label: string; unit: string; source: AnalyticsSource; current: number | null; previous: number | null; change: number | null }
export interface AnalyticsPublicStats { universeId: number; rootPlaceId?: number; name?: string; visits: number; playing: number; favorites: number; upVotes?: number; downVotes?: number; maxPlayers?: number; updated?: string }
export interface AnalyticsImportSummary { metric: string; label: string; points: number; first?: string; last?: string; breakdown?: Record<string, string>; importedAt: string; file?: string }
export interface AnalyticsStatus {
  universeId: number | null
  placeId: number | null
  hasApiKey: boolean
  apiProblem?: string
  poller: { running: boolean; intervalMinutes: number; snapshots: number; lastAt?: string }
  imports: AnalyticsImportSummary[]
}
export interface AnalyticsOverview { range: AnalyticsRange; previous: AnalyticsRange; kpis: AnalyticsKpi[]; signals: AnalyticsSignal[]; live?: AnalyticsPublicStats; notes: string[] }
export interface AnalyticsSeriesResult { range: AnalyticsRange; source: AnalyticsSource | null; series: AnalyticsSeries[]; notes: string[]; releases: { tag: string; at: string }[] }
export interface AnalyticsCompare { a: AnalyticsRange; b: AnalyticsRange; rows: { metric: string; label: string; unit: string; source: AnalyticsSource | null; a: number | null; b: number | null; change: number | null }[]; notes: string[] }
export interface AnalyticsAcquisition {
  range: AnalyticsRange
  previous: AnalyticsRange
  bySource: { source: string; impressions: number | null; impressionsPrev: number | null; plays: number | null; playsPrev: number | null; qualifiedPlays: number | null; playsPerImpression: number | null; playsPerImpressionPrev: number | null }[]
  totals: { impressions: number | null; plays: number | null; qualifiedPlays: number | null; impressionsChange: number | null; playsChange: number | null }
  homeRecs: { metric: string; label: string; current: number | null; previous: number | null; change: number | null }[]
  newVsReturning: { segment: string; dau: number | null; change: number | null }[]
  publicTrend: { newVisits: number | null; newVisitsChange: number | null; newFavorites: number | null; likeRatio: number | null }
  rates: Record<string, number | null>
  signals: AnalyticsSignal[]
  notes: string[]
}
export interface AnalyticsCatalogItem { kind: 'gamePass' | 'developerProduct'; id: number; name: string; isForSale: boolean; priceRobux?: number; created?: string; updated?: string }
export interface AnalyticsCsvImportResult { series: AnalyticsImportSummary[]; warnings: string[] }
```

## 2. Construct in `src/main/index.ts`

```ts
import { AnalyticsService, createAnalyticsTools } from './services/analytics/index.ts'
import { createEncryptedSecretStore } from './services/release/secrets.ts'

const analytics = new AnalyticsService({
  secrets: createEncryptedSecretStore(safeStorage, settings), // same store Release uses
  dataDir: join(app.getPath('userData'), 'analytics'),        // per-user, never the repo
  root,                                                       // project root (secret scoping)
  placeId: publish.placeId, universeId: publish.universeId,   // .forge/project.json "publish"
  getReleases,                                                // see below
  pollIntervalMinutes: settings.get('analytics.pollMinutes', 15),
  onSnapshot: (snapshot) => win?.webContents.send('analytics:snapshot', snapshot)
})
```

- On project open/switch: `analytics.configure({ root, placeId, universeId })`, then if
  `settings.get('analytics.poller', true)` and a place/universe is known, `(await analytics.publicPoller()).start()`.
  On project close and `before-quit`: `analytics.stopPoller()`.
- `getReleases: () => Promise<{ tag, at }[]>`: release tags with dates, e.g.
  `git for-each-ref --sort=creatordate --format='%(refname:short) %(creatordate:iso-strict)' 'refs/tags/v*'`
  (prefix from `publish.tagPrefix`). Used for release-impact signals and "releases in range" lines.
- The analytics key falls back to the Release drawer's Open Cloud key, so one key with both
  `universe-places:write` and `universe.analytics:read` works for both features.

## 3. IPC (`ipcMain.handle`) and preload

| Channel | Args | Returns |
|---|---|---|
| `analytics:status` | - | `AnalyticsStatus` |
| `analytics:setApiKey` | `{ key: string; scope?: 'project' \| 'global' }` | `AnalyticsStatus` (validate with `looksLikeApiKey` from release/openCloud.ts) |
| `analytics:clearApiKey` | `{ scope?: 'project' \| 'global' }` | `AnalyticsStatus` |
| `analytics:setExperience` | `{ placeId?: number; universeId?: number }` | `AnalyticsStatus` (calls `configure`; persisting to .forge/project.json is the Release service's job) |
| `analytics:overview` | `{ range?: string; metrics?: string[] }` | `AnalyticsOverview` |
| `analytics:series` | `{ metric; range?; granularity?; breakdown?; filter?; limit?; source? }` | `AnalyticsSeriesResult` |
| `analytics:acquisition` | `{ range?: string }` | `AnalyticsAcquisition` |
| `analytics:importCsv` | `{ path: string; metricHint?: string }` (renderer gets the path from a file dialog / drop) | `AnalyticsCsvImportResult` |
| `analytics:removeImport` | `{ metric: string; breakdown?: Record<string,string> }` | `boolean` (`(await importStore()).remove`) |
| `analytics:poller` | `{ running: boolean }` | `AnalyticsStatus` (start/stop; persist `analytics.poller`) |
| `analytics:pollNow` | - | `PublicSnapshot \| undefined` (`(await publicPoller()).pollNow(true)`) |
| `analytics:catalog` | - | `{ items: AnalyticsCatalogItem[]; notes: string[] }` |
| `analytics:snippet` | `{ kind; ...SnippetOptions }` | `Snippet` (from `analyticsSnippet`) |

Event: `analytics:snapshot` (main -> renderer) with the new `PublicSnapshot`
(`{ at, visits, playing, favorites, up?, down? }`): pass `onSnapshot` in the AnalyticsService deps. Errors: reject with
`error.message`; messages already explain the fix (missing scope, rate limit, no key).

Preload: `window.forge.analytics.{status, setApiKey, clearApiKey, setExperience, overview, series,
compare, acquisition, importCsv, removeImport, poller, pollNow, catalog, snippet, onSnapshot}`.

## 4. Agent tools

`createAnalyticsTools(analytics)` returns 6 objects shaped like `GentreeTool` (`name`,
`description`, `inputSchema` zod raw shape, `handler(args, extra) -> { content:[{type:'text',text}], isError? }`).
Append them to the gentree tool list in `src/main/agent/tools.ts` (both the SDK MCP server and the
OpenAI loop via `toFunctionSpecs`). All are read-only, so they belong in read-only/planner agents too.
Tool errors come back as `isError` text, never exceptions.

| Tool | Input | Output (compact text) |
|---|---|---|
| `analytics_overview` | `range?` (default 7d), `metrics?` | KPI lines `label: current (prev X, +N%) [metric, source]`, live public line, ranked signals, notes |
| `analytics_series` | `metric`, `range?`, `granularity?`, `breakdown?`, `filter?`, `limit?`, `source?` | header + `from <date> every <g>: v v v` (`_` gap, `~` projected, `?` insignificant), releases in range |
| `analytics_compare` | `metrics[]`, `a`, `b?` | `label: A=.. B=.. +N% [metric, source]` |
| `acquisition_report` | `range?` | totals, per-source table (impression users, play users, plays/impr, qualified), home-recs PTR, new vs returning DAU, public trend, signals |
| `analytics_instrument` | `kind` (setup/custom/onboarding/funnel/economy/progression) + names | GenTree files + call-site Luau + notes |
| `analytics_status` | `catalog?`, `incidents?` | key/universe/poller/imports, passes and products with prices, alert incidents |

Descriptions carry the guidance agents need: metric names, which source each number came from,
token/budget advice, how to relate moves to code (release tags -> `git log prevTag..tag`, metric ->
GenTree area), and when to propose instrumentation. Suggested system-prompt line for the main agent:
"For questions about how the game is doing, players, retention, revenue or acquisition, call
analytics_overview first, then drill down with analytics_series / acquisition_report."

## 5. UI (Analytics panel)

- **Setup card** (when `!hasApiKey` or `apiProblem`): explains the key permissions table above with a
  link to create.roblox.com/dashboard/credentials; key input (password field) -> `setApiKey`;
  place ID / universe ID fields when not in .forge/project.json. Without a key, the panel still works
  from public snapshots and CSV imports and says so.
- **KPI row**: tiles from `overview` (value, delta coloured by signal direction: `change` sign + the
  metric's good direction; never colour raw sign alone), source badge (API / CSV / Public), range
  picker (7d / 28d / 90d / custom).
- **Signals list**: `overview.signals` text with severity icon; release markers on charts from
  `series.releases`.
- **Charts**: line per series (`analytics:series`), granularity switch, breakdown dropdown
  (Platform, Country, AcquisitionSource, IsNewUser...), projected points dashed.
- **Acquisition tab**: per-source table from `acquisition`, plays/impression column, home-recs rates.
- **Imports**: drop zone / "Import dashboard CSV" button (`.csv`; a `.zip` sales export must be unzipped
  first), list of imported series with span and a remove button, import warnings shown inline.
- **Public tracking**: poller toggle + interval, snapshot count, "Snapshot now".
- **Catalog**: passes/products with prices (when the key has the scopes).
- **"Ask the agent"** button: starts a chat with "Review this experience's analytics for the last 7 days
  and suggest code changes" so the agent uses the tools above.

## 6. Data and privacy

API key: encrypted secret store only (`analytics.openCloudAnalyticsKey[.<projectScope>]`, then the
release key). Snapshots: `<userData>/analytics/<universeId>/public.jsonl`. Imports:
`<userData>/analytics/<universeId>/imports/*.json`. Nothing analytics-related is written to the repo
or `.forge/`. Instrumentation snippets are returned as text; agents write them only with consent.
