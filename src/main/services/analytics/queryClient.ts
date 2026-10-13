import { API_GRANULARITY, metricInfo } from './metrics.ts'
import { fillInteriorGaps, parseTime } from './series.ts'
import type { DateRange, FetchLike, Granularity, MetricFilter, Series, SeriesPoint, SeriesQuery, Sleep } from './types.ts'

// Open Cloud Analytics Query API client.
//
// Verified against the official docs (2026-10-13):
//  - Guide:     https://create.roblox.com/docs/cloud/guides/analytics
//  - Reference: https://create.roblox.com/docs/cloud/reference/features/analytics (all endpoints [BETA])
//  - Metrics:   https://create.roblox.com/docs/cloud/guides/analytics/metrics
//  - Announced: https://devforum.roblox.com/t/new-opencloud-apis-for-analytics-events-experiments-and-thumbnail-personalization/4828676 (2026-08-24)
//
//  POST https://apis.roblox.com/analytics-query-api/v1/universes/{universeId}/metrics
//    body { metric, granularity, startTime (RFC 3339, inclusive), endTime (exclusive), breakdown?, filter?, limit? }
//  POST .../v1/universes/{universeId}/dimension-values   body { metric, dimensions, startTime, endTime, filter?, granularity?, limit? }
//  GET  https://apis.roblox.com/analytics-query-api/{path}  polls an operation (path from a 202 / done:false body)
//  Auth: x-api-key with the universe-analytics system, operation universe.analytics:read, experience added
//    to the key's Access Permissions (OAuth 2.0 bearer is listed on the reference, but the scope's
//    availability to OAuth apps was unconfirmed in the announcement thread; Forge uses API keys).
//  Rate limits: POSTs 30/minute, operation GETs 3000/minute, per API key owner. 429 -> exponential
//    backoff starting at 1 s. 429 with code 3000 = the query exceeds the data-point budget (narrow it;
//    retrying does not help). 400 code 2001 = bad field / unsupported granularity or dimension / start
//    beyond retention. 500 code 2000 and 503 code 2002 are retryable. 504 code 1000 = query timed out.
//  Response: { path, done, metadata, response: { values: [{ breakdowns: [{dimension,value,displayValue?}],
//    dataPoints: [{ time, value, stringValues?, status? }] }] } } or { done: true, error: { code, message } }.
//  Points: status Valid | Projected | NotStatisticallySignificant. Days with no activity are omitted.

export const ANALYTICS_BASE = 'https://apis.roblox.com/analytics-query-api'
export const ANALYTICS_SCOPE = 'universe.analytics:read'
export const ANALYTICS_POSTS_PER_MINUTE = 30

export type AnalyticsErrorKind =
  | 'no-key'
  | 'invalid-request' // 400 (code 2001)
  | 'unauthorized' // 401
  | 'forbidden' // 403
  | 'not-found' // 404
  | 'budget' // 429 code 3000: too many data points
  | 'rate-limited' // 429
  | 'server' // 5xx
  | 'timeout' // 504 code 1000, or polling took too long
  | 'network'
  | 'unknown'

export class AnalyticsApiError extends Error {
  readonly kind: AnalyticsErrorKind
  readonly status?: number
  readonly code?: number | string
  constructor(kind: AnalyticsErrorKind, message: string, extra: { status?: number; code?: number | string } = {}) {
    super(message)
    this.name = 'AnalyticsApiError'
    this.kind = kind
    this.status = extra.status
    this.code = extra.code
  }
}

export interface AnalyticsClientOptions {
  getApiKey: () => Promise<string | undefined>
  fetch?: FetchLike
  sleep?: Sleep
  now?: () => number
  // Cache lifetime for day+ granularities (default 15 min) and sub-day ones (default 2 min).
  cacheTtlMs?: number
  shortCacheTtlMs?: number
  // Retries after 429 (not budget) / 500 / 503 (default 3).
  maxRetries?: number
  // Give up polling an async operation after this long (default 90 s).
  pollTimeoutMs?: number
  // Client-side POST limiter (default 30/min, the documented limit).
  postsPerMinute?: number
  // Longest the limiter will wait for a free slot before failing with rate-limited (default 65 s).
  maxQueueWaitMs?: number
}

interface Operation {
  path?: string
  done?: boolean
  response?: { values?: RawValue[] }
  error?: { code?: number | string; message?: string }
}
interface RawValue {
  breakdowns?: { dimension: string; value: string; displayValue?: string }[]
  dataPoints?: { time: string; value: number | string | null; status?: string; stringValues?: string[] }[]
}

const defaultSleep: Sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function globalFetch(): FetchLike {
  if (typeof globalThis.fetch !== 'function') throw new AnalyticsApiError('network', 'fetch is not available')
  return globalThis.fetch as unknown as FetchLike
}

export function rfc3339(dateOrIso: string): string {
  return new Date(parseTime(dateOrIso)).toISOString().replace('.000Z', 'Z')
}

const SUB_DAY: Granularity[] = ['minute', 'halfhour', 'hour']

export class AnalyticsQueryClient {
  private readonly opts: Required<Omit<AnalyticsClientOptions, 'getApiKey' | 'fetch'>> & Pick<AnalyticsClientOptions, 'getApiKey' | 'fetch'>
  private readonly cache = new Map<string, { at: number; value: unknown }>()
  private readonly inflight = new Map<string, Promise<unknown>>()
  private readonly posts: number[] = []
  // Last auth failure, for the status panel.
  lastAuthProblem: string | undefined

  constructor(options: AnalyticsClientOptions) {
    this.opts = {
      sleep: defaultSleep,
      now: Date.now,
      cacheTtlMs: 15 * 60_000,
      shortCacheTtlMs: 2 * 60_000,
      maxRetries: 3,
      pollTimeoutMs: 90_000,
      postsPerMinute: ANALYTICS_POSTS_PER_MINUTE,
      maxQueueWaitMs: 65_000,
      ...options
    }
  }

  clearCache(): void {
    this.cache.clear()
  }

  // Normalised series for one metric query (one series per breakdown combination).
  async metrics(universeId: number, query: SeriesQuery): Promise<Series[]> {
    const info = metricInfo(query.metric)
    const body: Record<string, unknown> = {
      metric: query.metric,
      granularity: API_GRANULARITY[query.granularity],
      startTime: rfc3339(query.range.start),
      endTime: rfc3339(query.range.end)
    }
    if (query.breakdown?.length) body.breakdown = query.breakdown
    if (query.filter?.length) body.filter = query.filter.map((f) => ({ dimension: f.dimension, values: f.values, operation: f.operation ?? 'In' }))
    if (query.limit && query.granularity === 'total' && query.breakdown?.length) body.limit = query.limit
    const ttl = SUB_DAY.includes(query.granularity) ? this.opts.shortCacheTtlMs : this.opts.cacheTtlMs
    const op = (await this.cached(`m:${universeId}:${JSON.stringify(body)}`, ttl, () => this.run(universeId, 'metrics', body))) as Operation
    const values = op.response?.values ?? []
    return values.map((value) => {
      const breakdown: Record<string, string> = {}
      for (const b of value.breakdowns ?? []) {
        breakdown[b.dimension] = b.value
        if (b.displayValue && b.displayValue !== b.value) breakdown[`${b.dimension}Label`] = b.displayValue
      }
      const points: SeriesPoint[] = []
      for (const dp of value.dataPoints ?? []) {
        const v = typeof dp.value === 'number' ? dp.value : Number(dp.value)
        if (!Number.isFinite(v)) continue
        const t = SUB_DAY.includes(query.granularity) ? new Date(parseTime(dp.time)).toISOString().slice(0, 16) + 'Z' : new Date(parseTime(dp.time)).toISOString().slice(0, 10)
        const point: SeriesPoint = { t, v }
        if (dp.status === 'Projected') point.flag = 'projected'
        else if (dp.status === 'NotStatisticallySignificant') point.flag = 'insignificant'
        points.push(point)
      }
      points.sort((a, b) => parseTime(a.t) - parseTime(b.t))
      const series: Series = {
        metric: query.metric,
        source: 'api',
        granularity: query.granularity,
        unit: info.unit,
        aggregation: info.aggregation,
        points
      }
      if (Object.keys(breakdown).length) series.breakdown = breakdown
      return fillInteriorGaps(series)
    })
  }

  // Values a dimension can take for a metric (e.g. the AcquisitionSource or CustomEventName values).
  async dimensionValues(
    universeId: number,
    metric: string,
    dimensions: string[],
    range: DateRange,
    filter?: MetricFilter[],
    limit?: number
  ): Promise<Record<string, { value: string; displayValue?: string }[]>> {
    const body: Record<string, unknown> = { metric, dimensions, startTime: rfc3339(range.start), endTime: rfc3339(range.end) }
    if (filter?.length) body.filter = filter.map((f) => ({ dimension: f.dimension, values: f.values, operation: f.operation ?? 'In' }))
    if (limit) body.limit = limit
    const op = (await this.cached(`d:${universeId}:${JSON.stringify(body)}`, this.opts.cacheTtlMs, () => this.run(universeId, 'dimension-values', body))) as {
      response?: { values?: { dimension: string; values: { value: string; displayValue?: string }[] }[] }
    }
    const out: Record<string, { value: string; displayValue?: string }[]> = {}
    for (const entry of op.response?.values ?? []) out[entry.dimension] = entry.values ?? []
    return out
  }

  private async cached(key: string, ttl: number, load: () => Promise<unknown>): Promise<unknown> {
    const hit = this.cache.get(key)
    if (hit && this.opts.now() - hit.at < ttl) return hit.value
    const pending = this.inflight.get(key)
    if (pending) return pending
    const promise = load()
      .then((value) => {
        this.cache.set(key, { at: this.opts.now(), value })
        return value
      })
      .finally(() => this.inflight.delete(key))
    this.inflight.set(key, promise)
    return promise
  }

  private async apiKey(): Promise<string> {
    const key = (await this.opts.getApiKey())?.trim()
    if (!key) throw new AnalyticsApiError('no-key', `No Open Cloud API key for analytics. Create one at create.roblox.com/dashboard/credentials with the universe-analytics system (${ANALYTICS_SCOPE}) on this experience, then add it in Forge's Analytics panel.`)
    return key
  }

  // Sliding-window limiter for POSTs (documented 30/min per key owner).
  private async takeSlot(): Promise<void> {
    const windowMs = 60_000
    for (;;) {
      const now = this.opts.now()
      while (this.posts.length && now - this.posts[0] >= windowMs) this.posts.shift()
      if (this.posts.length < this.opts.postsPerMinute) {
        this.posts.push(now)
        return
      }
      const wait = this.posts[0] + windowMs - now
      if (wait > this.opts.maxQueueWaitMs) throw new AnalyticsApiError('rate-limited', `Analytics API allows ${this.opts.postsPerMinute} queries per minute; try again in ${Math.ceil(wait / 1000)} s.`)
      await this.opts.sleep(wait)
    }
  }

  private async run(universeId: number, kind: 'metrics' | 'dimension-values', body: Record<string, unknown>): Promise<Operation> {
    const key = await this.apiKey()
    const url = `${ANALYTICS_BASE}/v1/universes/${universeId}/${kind}`
    let attempt = 0
    for (;;) {
      await this.takeSlot()
      const res = await this.send(url, key, 'POST', JSON.stringify(body))
      const retry = this.retryDelay(res, attempt)
      if (retry !== null) {
        attempt++
        await this.opts.sleep(retry)
        continue
      }
      let op = this.check(res)
      const started = this.opts.now()
      let delay = 1000
      while (!op.done) {
        if (!op.path) throw new AnalyticsApiError('unknown', 'Analytics API returned a pending operation without a path')
        if (this.opts.now() - started > this.opts.pollTimeoutMs) throw new AnalyticsApiError('timeout', 'The analytics query is still running on Roblox; try again shortly or use a shorter range / coarser granularity.')
        await this.opts.sleep(delay)
        delay = Math.min(5000, Math.round(delay * 1.5))
        const poll = await this.send(`${ANALYTICS_BASE}/${op.path.replace(/^\//, '')}`, key, 'GET')
        const pollRetry = this.retryDelay(poll, 0)
        if (pollRetry !== null) {
          await this.opts.sleep(pollRetry)
          continue
        }
        op = this.check(poll)
      }
      if (op.error) throw this.operationError(op.error)
      this.lastAuthProblem = undefined
      return op
    }
  }

  private async send(url: string, key: string, method: 'GET' | 'POST', body?: string): Promise<{ status: number; text: string; retryAfter: string | null }> {
    const fetch = this.opts.fetch ?? globalFetch()
    try {
      const headers: Record<string, string> = { 'x-api-key': key, accept: 'application/json' }
      if (body) headers['content-type'] = 'application/json'
      const res = await fetch(url, { method, headers, body })
      return { status: res.status, text: await res.text(), retryAfter: res.headers.get('retry-after') }
    } catch (error) {
      throw new AnalyticsApiError('network', `Could not reach Roblox: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // ms to wait before retrying, or null when the response should not be retried.
  private retryDelay(res: { status: number; text: string; retryAfter: string | null }, attempt: number): number | null {
    if (attempt >= this.opts.maxRetries) return null
    const code = errorCode(res.text)
    if (res.status === 429 && String(code) !== '3000') {
      const header = Number(res.retryAfter)
      return Number.isFinite(header) && header > 0 ? Math.min(60_000, header * 1000) : 1000 * 2 ** attempt
    }
    if (res.status === 500 || res.status === 503) return 1000 * 2 ** attempt
    return null
  }

  private check(res: { status: number; text: string }): Operation {
    if (res.status === 200 || res.status === 202) {
      try {
        const op = JSON.parse(res.text) as Operation
        if (res.status === 202 && op.done === undefined) op.done = false
        return op
      } catch {
        throw new AnalyticsApiError('unknown', `Unexpected analytics response: ${res.text.slice(0, 200)}`)
      }
    }
    const code = errorCode(res.text)
    const detail = errorMessage(res.text)
    const said = detail ? ` Roblox said: ${detail}` : ''
    switch (res.status) {
      case 400:
        throw new AnalyticsApiError('invalid-request', `Analytics query rejected (400${code ? ` code ${code}` : ''}): unsupported metric, granularity or dimension, or the start is beyond the metric's retention.${said}`, { status: 400, code })
      case 401:
      case 403: {
        const msg = `The API key cannot read analytics for this experience (${res.status}). Give it the universe-analytics system with ${ANALYTICS_SCOPE} and add the experience under Access Permissions; also check it is not expired and its IP allow-list includes this computer.${said}`
        this.lastAuthProblem = msg
        throw new AnalyticsApiError(res.status === 401 ? 'unauthorized' : 'forbidden', msg, { status: res.status, code })
      }
      case 404:
        throw new AnalyticsApiError('not-found', `Unknown universe or operation (404). Check the universe ID.${said}`, { status: 404, code })
      case 429:
        if (String(code) === '3000') throw new AnalyticsApiError('budget', `The query asks for too many data points (429 code 3000). Use a shorter range, a coarser granularity, fewer breakdowns or a limit.${said}`, { status: 429, code })
        throw new AnalyticsApiError('rate-limited', `Analytics API rate limit hit (429). It allows ${ANALYTICS_POSTS_PER_MINUTE} queries per minute.${said}`, { status: 429, code })
      case 504:
        throw new AnalyticsApiError('timeout', `The analytics query timed out (504). Shorten the range or reduce breakdowns.${said}`, { status: 504, code })
      default:
        throw new AnalyticsApiError(res.status >= 500 ? 'server' : 'unknown', `Analytics API error ${res.status}.${said}`, { status: res.status, code })
    }
  }

  private operationError(error: { code?: number | string; message?: string }): AnalyticsApiError {
    const code = error.code
    const message = error.message ?? 'unknown error'
    if (String(code) === '3000') return new AnalyticsApiError('budget', `Query exceeds the data-point budget: ${message}`, { code })
    if (String(code) === '1000') return new AnalyticsApiError('timeout', `Query timed out: ${message}`, { code })
    if (String(code) === '2001') return new AnalyticsApiError('invalid-request', `Invalid query: ${message}`, { code })
    return new AnalyticsApiError('server', `Analytics query failed (${code ?? '?'}): ${message}`, { code })
  }
}

function parseJson(text: string): Record<string, unknown> | undefined {
  try {
    const v = JSON.parse(text)
    return v && typeof v === 'object' ? (v as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function errorCode(text: string): number | string | undefined {
  const json = parseJson(text)
  if (!json) return undefined
  const err = (json.error && typeof json.error === 'object' ? json.error : json) as Record<string, unknown>
  const code = err.code
  return typeof code === 'number' || typeof code === 'string' ? code : undefined
}

function errorMessage(text: string): string | undefined {
  const json = parseJson(text)
  if (!json) return text.trim() ? text.trim().slice(0, 300) : undefined
  const err = (json.error && typeof json.error === 'object' ? json.error : json) as Record<string, unknown>
  if (typeof err.message === 'string') return err.message
  if (Array.isArray(json.errors) && json.errors.length) {
    const first = json.errors[0] as { message?: string }
    if (first?.message) return first.message
  }
  return undefined
}
