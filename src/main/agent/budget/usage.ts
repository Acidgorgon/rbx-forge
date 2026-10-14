// Token usage and cost: normalizing provider usage objects, a price table, and a persistent ledger
// aggregated per message, chat, agent, model and day.
//
// Normalized form (all providers): input = uncached input tokens, cacheRead = prompt tokens served
// from cache, cacheWrite = prompt tokens written to cache, output = output tokens (including
// reasoning/thinking). Anthropic reports these four separately; OpenAI's prompt_tokens INCLUDES
// cached tokens, so input = prompt_tokens - cached_tokens - cache_write_tokens.
//
// Sources (checked 2026-10-13):
//   Anthropic: https://platform.claude.com/docs/en/about-claude/pricing
//   OpenAI:    https://developers.openai.com/api/docs/pricing and /docs/guides/prompt-caching
//   Gemini:    https://ai.google.dev/gemini-api/docs/pricing
// Models not on those pages are cost-unknown (never guessed). Ollama (local) costs 0.

import type { NonNullableUsage, ModelUsage, SDKMessage } from '@anthropic-ai/claude-agent-sdk'

export interface Usage {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  // Cost reported by the provider (SDK costUSD, OpenRouter usage.cost) or estimated from PRICES.
  costUsd?: number
}

export interface UsageRecord extends Usage {
  at: number
  provider: string
  model: string
  chatId?: string
  agentId?: string
  // 'provider' = reported by the API/SDK, 'estimate' = from the price table, 'unknown' = no price.
  costSource: 'provider' | 'estimate' | 'unknown'
  // Spending-cap source when neither chatId nor agentId says it (e.g. 'completions').
  source?: string
}

export interface UsageTotals {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  costUsd: number
  // Requests whose cost could not be priced (their tokens are still counted).
  unpricedRequests: number
  requests: number
  lastAt: number
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function emptyTotals(): UsageTotals {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0, unpricedRequests: 0, requests: 0, lastAt: 0 }
}

const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

export function addUsage(a: Usage, b: Usage): Usage {
  const out: Usage = {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite
  }
  if (a.costUsd !== undefined || b.costUsd !== undefined) out.costUsd = (a.costUsd ?? 0) + (b.costUsd ?? 0)
  return out
}

// All prompt-side tokens of a request (what the context window and long-context tiers see).
export function promptTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite
}

export function totalTokens(u: Usage): number {
  return u.input + u.cacheRead + u.cacheWrite + u.output
}

// ---------------------------------------------------------------------------------------------
// Normalizers

// Anthropic Messages API usage (also SDKAssistantMessage.message.usage and SDKResult.usage).
export function fromAnthropicUsage(u: Partial<NonNullableUsage> | Record<string, unknown> | null | undefined): Usage {
  const x = (u ?? {}) as Record<string, unknown>
  return {
    input: num(x.input_tokens),
    output: num(x.output_tokens),
    cacheRead: num(x.cache_read_input_tokens),
    cacheWrite: num(x.cache_creation_input_tokens)
  }
}

// Agent SDK per-model totals (SDKResultMessage.modelUsage values).
export function fromModelUsage(m: Partial<ModelUsage>): Usage {
  const out: Usage = {
    input: num(m.inputTokens),
    output: num(m.outputTokens),
    cacheRead: num(m.cacheReadInputTokens),
    cacheWrite: num(m.cacheCreationInputTokens)
  }
  if (typeof m.costUSD === 'number' && Number.isFinite(m.costUSD)) out.costUsd = Math.max(0, m.costUSD)
  return out
}

// OpenAI-compatible chat completions usage (final stream chunk with stream_options.include_usage,
// or the non-streamed response). Handles OpenAI, OpenRouter (usage.cost in USD), Gemini, Ollama.
export function fromOpenAiUsage(u: unknown): Usage | null {
  if (!u || typeof u !== 'object') return null
  const x = u as Record<string, any>
  if (x.prompt_tokens === undefined && x.completion_tokens === undefined && x.input_tokens === undefined) return null
  // Chat Completions uses prompt_/completion_; the Responses API (and some proxies) input_/output_.
  const prompt = num(x.prompt_tokens ?? x.input_tokens)
  const details = (x.prompt_tokens_details ?? x.input_tokens_details ?? {}) as Record<string, unknown>
  const cacheRead = Math.min(prompt, num(details.cached_tokens))
  const cacheWrite = Math.min(prompt - cacheRead, num(details.cache_write_tokens))
  const out: Usage = {
    input: prompt - cacheRead - cacheWrite,
    output: num(x.completion_tokens ?? x.output_tokens),
    cacheRead,
    cacheWrite
  }
  // OpenRouter returns the charged amount in usage.cost (credits = USD).
  if (typeof x.cost === 'number' && Number.isFinite(x.cost)) out.costUsd = Math.max(0, x.cost)
  return out
}

// ---------------------------------------------------------------------------------------------
// Prices, USD per million tokens.

export interface Price {
  input: number
  output: number
  cacheRead: number
  // 5-minute cache write (Anthropic) / cache write (OpenAI GPT-5.6+). Omitted = same as input.
  cacheWrite?: number
  // Higher prices when the request's prompt (input + cache) is over `threshold` tokens.
  long?: { threshold: number; input: number; output: number; cacheRead: number; cacheWrite?: number }
  // Price change on a date (YYYY-MM-DD, UTC): from then on `next` applies.
  changes?: { from: string; next: Omit<Price, 'changes'> }
}

export const PRICES: Record<string, Price> = {
  // Anthropic (platform.claude.com pricing). Cache write = 5m TTL price (1.25x); 1h TTL is 2x.
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-4-6': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-haiku-5-5': {
    input: 0.1,
    output: 0.5,
    cacheRead: 0.01,
    cacheWrite: 0.125,
    long: { threshold: 100_000, input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 }
  },
  'claude-haiku-4-5': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },

  // OpenAI Standard tier, short-context column. The page lists a long-context column without
  // stating the threshold, so long-context requests are under-estimated here (see INTEGRATION.md).
  // Cache writes on GPT-5.6+ cost 1.25x input (prompt-caching guide).
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175 },

  // Google Gemini API, paid Standard tier (text). Context caching storage per hour is not modeled.
  'gemini-3.8-flash': {
    input: 0.75,
    output: 3.75,
    cacheRead: 0.075,
    changes: { from: '2027-01-01', next: { input: 1.5, output: 7.5, cacheRead: 0.15 } }
  },
  'gemini-3.6-flash': {
    input: 0.75,
    output: 3.75,
    cacheRead: 0.075,
    changes: { from: '2027-01-01', next: { input: 1.5, output: 7.5, cacheRead: 0.15 } }
  },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025 },
  'gemini-3.1-pro-preview': {
    input: 2,
    output: 12,
    cacheRead: 0.2,
    long: { threshold: 200_000, input: 4, output: 18, cacheRead: 0.4 }
  },
  'gemini-3-flash-preview': { input: 0.5, output: 3, cacheRead: 0.05 }
}

// Canonical price-table key for a model id as providers spell it:
// "anthropic/claude-sonnet-5.5" -> "claude-sonnet-5-5", "claude-opus-5-5[1m]" -> "claude-opus-5-5",
// "models/gemini-3.8-flash" -> "gemini-3.8-flash", "claude-haiku-4-5-20251001" -> "claude-haiku-4-5".
export function canonicalModel(model: string): string {
  let m = model.trim().toLowerCase()
  m = m.replace(/\[[^\]]*\]$/, '')
  m = m.replace(/^models\//, '')
  m = m.replace(/^(anthropic|openai|google|google-ai-studio|vertex|bedrock)\//, '')
  m = m.replace(/^(us|eu|apac|global)\.anthropic\./, '').replace(/^anthropic\./, '')
  m = m.replace(/:free$|:beta$/, '')
  if (m.startsWith('claude-')) {
    m = m.replace(/(\d)\.(\d)/g, '$1-$2')
    m = m.replace(/-\d{8}$/, '').replace(/@\d{8}$/, '').replace(/-v\d+(:\d+)?$/, '')
  }
  return m
}

// Price for a model, or undefined when unknown. Matches exactly, then the longest table key that
// is a prefix followed by a dated/variant suffix (e.g. "gpt-6-luna-2026-09-01").
export function priceFor(model: string, at: number = Date.now()): Price | undefined {
  const key = canonicalModel(model)
  let p = PRICES[key]
  if (!p) {
    let best = ''
    for (const k of Object.keys(PRICES)) {
      if (key.startsWith(k + '-') && /^-(\d{4}-\d{2}-\d{2}|\d{8}|latest)$/.test(key.slice(k.length)) && k.length > best.length) best = k
    }
    if (best) p = PRICES[best]
  }
  if (!p) return undefined
  if (p.changes && new Date(at).toISOString().slice(0, 10) >= p.changes.from) return p.changes.next
  return p
}

// Estimated cost in USD, or undefined when the model has no known price. Ollama is free.
export function estimateCost(model: string, u: Usage, opts: { provider?: string; at?: number } = {}): number | undefined {
  if (opts.provider === 'ollama') return 0
  const p = priceFor(model, opts.at)
  if (!p) return undefined
  const tier = p.long && promptTokens(u) > p.long.threshold ? p.long : p
  const write = tier.cacheWrite ?? tier.input
  const cost = (u.input * tier.input + u.output * tier.output + u.cacheRead * tier.cacheRead + u.cacheWrite * write) / 1_000_000
  return Math.round(cost * 1e8) / 1e8
}

// Fills costUsd from the price table when the provider did not report one.
export function priced(model: string, u: Usage, opts: { provider?: string; at?: number } = {}): { usage: Usage; costSource: UsageRecord['costSource'] } {
  if (u.costUsd !== undefined) return { usage: u, costSource: 'provider' }
  const cost = estimateCost(model, u, opts)
  if (cost === undefined) return { usage: u, costSource: 'unknown' }
  return { usage: { ...u, costUsd: cost }, costSource: 'estimate' }
}

// ---------------------------------------------------------------------------------------------
// Agent SDK message tracking.

// Per-model cumulative totals the SDK reports on result messages (resumed sessions start from the
// totals saved in the transcript, so deltas are taken against the previous result).
export type SdkBaseline = Record<string, Usage>

function subUsage(a: Usage, b: Usage): Usage | null {
  const d: Usage = {
    input: a.input - b.input,
    output: a.output - b.output,
    cacheRead: a.cacheRead - b.cacheRead,
    cacheWrite: a.cacheWrite - b.cacheWrite
  }
  if (a.costUsd !== undefined) d.costUsd = a.costUsd - (b.costUsd ?? 0)
  if (d.input < 0 || d.output < 0 || d.cacheRead < 0 || d.cacheWrite < 0 || (d.costUsd ?? 0) < -1e-9) return null
  return d
}

// Turns a stream of SDK messages for one query() into usage records.
// - assistant messages feed a live (provisional) meter, de-duplicated by message id because a
//   streamed message arrives as several SDKAssistantMessages sharing one id and usage;
// - each result message's modelUsage is authoritative (includes subagents and internal calls);
//   the delta against the previous result/baseline becomes the persisted record.
// If the query ends without a result (abort, crash), finish() returns the provisional usage.
export class SdkUsageTracker {
  private seen = new Set<string>()
  private provisional = new Map<string, Usage>()
  private baseline: SdkBaseline
  private gotResult = false
  private defaultModel: string
  readonly provider = 'anthropic'

  constructor(defaultModel: string, baseline: SdkBaseline = {}) {
    this.defaultModel = defaultModel
    this.baseline = { ...baseline }
  }

  // Returns the records to persist for this message (only result messages produce any).
  onMessage(m: SDKMessage, at = Date.now()): UsageRecord[] {
    if (m.type === 'assistant') {
      const msg = m.message as { id?: string; model?: string; usage?: unknown }
      const id = msg?.id ?? m.uuid
      if (id && this.seen.has(id)) return []
      if (id) this.seen.add(id)
      const model = msg?.model || this.defaultModel
      this.provisional.set(model, addUsage(this.provisional.get(model) ?? emptyUsage(), fromAnthropicUsage(msg?.usage as any)))
      return []
    }
    if (m.type !== 'result') return []
    this.gotResult = true
    const records: UsageRecord[] = []
    const modelUsage = (m as { modelUsage?: Record<string, ModelUsage> }).modelUsage ?? {}
    const entries = Object.entries(modelUsage)
    if (!entries.length) {
      // Older/zeroed results: fall back to the main-loop usage + total cost.
      const u = fromAnthropicUsage((m as { usage?: unknown }).usage as any)
      const cost = (m as { total_cost_usd?: number }).total_cost_usd
      if (typeof cost === 'number') u.costUsd = cost
      const d = subUsage(u, this.baseline[this.defaultModel] ?? emptyUsage()) ?? u
      this.baseline[this.defaultModel] = u
      if (totalTokens(d) > 0) records.push(this.record(this.defaultModel, d, at))
    }
    for (const [model, mu] of entries) {
      const cur = fromModelUsage(mu)
      const prev = this.baseline[model]
      const d = prev ? (subUsage(cur, prev) ?? cur) : cur
      this.baseline[model] = cur
      if (totalTokens(d) > 0 || (d.costUsd ?? 0) > 0) {
        const unknown = (mu as { costBasis?: string }).costBasis === 'unknown'
        records.push(this.record(model, unknown ? { ...d, costUsd: undefined } : d, at))
      }
    }
    this.provisional.clear()
    return records
  }

  private record(model: string, u: Usage, at: number): UsageRecord {
    const { usage, costSource } = priced(model, u, { provider: this.provider, at })
    return { ...usage, at, provider: this.provider, model, costSource }
  }

  // Usage seen so far in this query but not yet covered by a result (for a live meter).
  live(): Usage {
    let u = emptyUsage()
    for (const [model, p] of this.provisional) {
      u = addUsage(u, { ...p, costUsd: estimateCost(model, p) ?? 0 })
    }
    return u
  }

  // Call when the query ends: records for usage never confirmed by a result.
  finish(at = Date.now()): UsageRecord[] {
    const out: UsageRecord[] = []
    for (const [model, u] of this.provisional) if (totalTokens(u) > 0) out.push(this.record(model, u, at))
    this.provisional.clear()
    return out
  }

  // Baseline to store for the session (pass it to the next tracker of a resumed session).
  snapshot(): SdkBaseline {
    return { ...this.baseline }
  }

  get sawResult(): boolean {
    return this.gotResult
  }
}

// ---------------------------------------------------------------------------------------------
// Ledger: aggregation + persistence through a settings-like store.

export interface SettingsStore {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
}

interface LedgerData {
  v: 1
  chats: Record<string, UsageTotals>
  agents: Record<string, UsageTotals>
  days: Record<string, UsageTotals>
  models: Record<string, UsageTotals>
  sdkBaselines: Record<string, SdkBaseline>
}

export interface LedgerOptions {
  key?: string
  // Debounce for settings writes; 0 writes synchronously. Default 1000.
  saveDelayMs?: number
  maxDays?: number
  maxChats?: number
  maxAgents?: number
}

// Local calendar day, YYYY-MM-DD.
export function dayKey(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

function addTo(t: UsageTotals, r: UsageRecord): UsageTotals {
  return {
    input: t.input + r.input,
    output: t.output + r.output,
    cacheRead: t.cacheRead + r.cacheRead,
    cacheWrite: t.cacheWrite + r.cacheWrite,
    costUsd: Math.round((t.costUsd + (r.costUsd ?? 0)) * 1e8) / 1e8,
    unpricedRequests: t.unpricedRequests + (r.costSource === 'unknown' ? 1 : 0),
    requests: t.requests + 1,
    lastAt: Math.max(t.lastAt, r.at)
  }
}

function prune(rec: Record<string, UsageTotals>, max: number): void {
  const keys = Object.keys(rec)
  if (keys.length <= max) return
  keys.sort((a, b) => rec[a].lastAt - rec[b].lastAt)
  for (const k of keys.slice(0, keys.length - max)) delete rec[k]
}

export class UsageLedger {
  private store: SettingsStore
  private key: string
  private data: LedgerData
  private opts: Required<Omit<LedgerOptions, 'key'>>
  private timer: ReturnType<typeof setTimeout> | null = null
  private listeners = new Set<(r: UsageRecord) => void>()

  constructor(store: SettingsStore, opts: LedgerOptions = {}) {
    this.store = store
    this.key = opts.key ?? 'usage'
    this.opts = {
      saveDelayMs: opts.saveDelayMs ?? 1000,
      maxDays: opts.maxDays ?? 120,
      maxChats: opts.maxChats ?? 200,
      maxAgents: opts.maxAgents ?? 200
    }
    const raw = store.getSetting<Partial<LedgerData> | null>(this.key, null)
    this.data = {
      v: 1,
      chats: { ...(raw?.chats ?? {}) },
      agents: { ...(raw?.agents ?? {}) },
      days: { ...(raw?.days ?? {}) },
      models: { ...(raw?.models ?? {}) },
      sdkBaselines: { ...(raw?.sdkBaselines ?? {}) }
    }
  }

  // Adds one record to its chat/agent, day and model totals.
  record(r: UsageRecord): void {
    if (r.chatId) this.data.chats[r.chatId] = addTo(this.data.chats[r.chatId] ?? emptyTotals(), r)
    if (r.agentId) this.data.agents[r.agentId] = addTo(this.data.agents[r.agentId] ?? emptyTotals(), r)
    const day = dayKey(r.at)
    this.data.days[day] = addTo(this.data.days[day] ?? emptyTotals(), r)
    const mk = `${r.provider}:${r.model}`
    this.data.models[mk] = addTo(this.data.models[mk] ?? emptyTotals(), r)
    for (const l of this.listeners) l(r)
    this.save()
  }

  recordAll(records: UsageRecord[], tag: { chatId?: string; agentId?: string } = {}): void {
    for (const r of records) this.record({ ...r, ...tag })
  }

  // Convenience for the OpenAI-compatible loop: one response's usage object.
  recordOpenAi(usage: unknown, ctx: { provider: string; model: string; chatId?: string; agentId?: string; at?: number }): UsageRecord | null {
    const u = fromOpenAiUsage(usage)
    if (!u) return null
    const at = ctx.at ?? Date.now()
    const { usage: pu, costSource } = priced(ctx.model, u, { provider: ctx.provider, at })
    const rec: UsageRecord = { ...pu, at, provider: ctx.provider, model: ctx.model, costSource, ...(ctx.chatId ? { chatId: ctx.chatId } : {}), ...(ctx.agentId ? { agentId: ctx.agentId } : {}) }
    this.record(rec)
    return rec
  }

  onRecord(fn: (r: UsageRecord) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  chat(id: string): UsageTotals {
    return { ...(this.data.chats[id] ?? emptyTotals()) }
  }

  agent(id: string): UsageTotals {
    return { ...(this.data.agents[id] ?? emptyTotals()) }
  }

  day(key: string = dayKey(Date.now())): UsageTotals {
    return { ...(this.data.days[key] ?? emptyTotals()) }
  }

  // Last `n` days, oldest first (missing days as zero totals).
  days(n = 7, now = Date.now()): { day: string; totals: UsageTotals }[] {
    const out: { day: string; totals: UsageTotals }[] = []
    for (let i = n - 1; i >= 0; i--) {
      const k = dayKey(now - i * 86_400_000)
      out.push({ day: k, totals: this.day(k) })
    }
    return out
  }

  models(): Record<string, UsageTotals> {
    return JSON.parse(JSON.stringify(this.data.models))
  }

  sdkBaseline(sessionId: string): SdkBaseline {
    return { ...(this.data.sdkBaselines[sessionId] ?? {}) }
  }

  setSdkBaseline(sessionId: string, baseline: SdkBaseline): void {
    this.data.sdkBaselines[sessionId] = baseline
    const ids = Object.keys(this.data.sdkBaselines)
    if (ids.length > this.opts.maxChats) for (const k of ids.slice(0, ids.length - this.opts.maxChats)) delete this.data.sdkBaselines[k]
    this.save()
  }

  forgetChat(id: string): void {
    delete this.data.chats[id]
    this.save()
  }

  private save(): void {
    if (this.opts.saveDelayMs <= 0) return this.flush()
    if (this.timer) return
    this.timer = setTimeout(() => this.flush(), this.opts.saveDelayMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    prune(this.data.days, this.opts.maxDays)
    prune(this.data.chats, this.opts.maxChats)
    prune(this.data.agents, this.opts.maxAgents)
    this.store.setSetting(this.key, this.data)
  }
}

export function formatUsd(n: number | undefined): string {
  if (n === undefined || !Number.isFinite(n)) return '$?'
  if (n === 0) return '$0'
  if (n < 0.01) return '<$0.01'
  return '$' + (n < 10 ? n.toFixed(2) : n.toFixed(1))
}
