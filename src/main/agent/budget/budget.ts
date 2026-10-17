// Budget guard (per test agent hard caps, per chat soft cap, optional daily cap) and a small,
// explainable model router.
//
// Token caps count "effective" tokens by default: input + cache writes + output + 10% of cache
// reads. Cache reads are re-sent context billed at 2.5-10% of input, so counting them fully would
// make long cached conversations look 10x more expensive than they are; counting them at zero would
// hide context growth. Set tokenMetric: 'total' to count every token.

import type { ProviderId } from '../../../shared/types.ts'
import { addUsage, emptyUsage, type Usage, type UsageLedger, type UsageTotals } from './usage.ts'

export type BudgetLevel = 'ok' | 'warn' | 'stop'

export interface BudgetLimits {
  // Hard caps for one test agent run.
  agentMaxTokens?: number
  agentMaxCostUsd?: number
  // Soft caps for one chat: warn (suggest compacting / a new chat / a cheaper model).
  chatSoftTokens?: number
  chatSoftCostUsd?: number
  // Optional hard caps for one chat.
  chatMaxCostUsd?: number
  // Optional hard cap for all spend in a local day.
  dailyMaxCostUsd?: number
  // Fraction of a cap at which 'warn' starts. Default 0.8.
  warnAt?: number
  tokenMetric?: 'effective' | 'total'
}

export const DEFAULT_LIMITS: Required<Pick<BudgetLimits, 'agentMaxTokens' | 'agentMaxCostUsd' | 'chatSoftTokens' | 'chatSoftCostUsd' | 'warnAt' | 'tokenMetric'>> = {
  agentMaxTokens: 400_000,
  agentMaxCostUsd: 1,
  chatSoftTokens: 300_000,
  chatSoftCostUsd: 2,
  warnAt: 0.8,
  tokenMetric: 'effective'
}

export const BUDGET_SETTING = 'budget'

// Limits from settings ('budget' key), over the defaults. Non-positive values disable a cap.
export function readLimits(getSetting: <T>(key: string, fallback: T) => T): BudgetLimits {
  const s = getSetting<Partial<BudgetLimits> | null>(BUDGET_SETTING, null) ?? {}
  const out: BudgetLimits = { ...DEFAULT_LIMITS }
  for (const [k, v] of Object.entries(s)) {
    if (k === 'tokenMetric') {
      if (v === 'effective' || v === 'total') out.tokenMetric = v
    } else if (typeof v === 'number' && Number.isFinite(v)) {
      ;(out as Record<string, unknown>)[k] = v > 0 ? v : undefined
    } else if (v === null) {
      ;(out as Record<string, unknown>)[k] = undefined
    }
  }
  return out
}

export function countTokens(u: Pick<Usage, 'input' | 'output' | 'cacheRead' | 'cacheWrite'>, metric: BudgetLimits['tokenMetric'] = 'effective'): number {
  if (metric === 'total') return u.input + u.output + u.cacheRead + u.cacheWrite
  return u.input + u.output + u.cacheWrite + Math.round(u.cacheRead * 0.1)
}

export interface BudgetCheck {
  level: BudgetLevel
  // Highest used/limit ratio among the caps checked (0 when none apply).
  fraction: number
  // Human-readable, e.g. "test agent used 412k of 400k tokens".
  reason?: string
  tokens: number
  costUsd: number
}

interface Cap {
  limit: number | undefined
  used: number
  hard: boolean
  label: string
}

function evaluate(caps: Cap[], warnAt: number, tokens: number, costUsd: number): BudgetCheck {
  const rank = { ok: 0, warn: 1, stop: 2 }
  let level: BudgetLevel = 'ok'
  let fraction = 0
  let worst = -1
  let reason: string | undefined
  for (const c of caps) {
    if (!c.limit || c.limit <= 0) continue
    const f = c.used / c.limit
    const l: BudgetLevel = f >= 1 ? (c.hard ? 'stop' : 'warn') : f >= warnAt ? 'warn' : 'ok'
    fraction = Math.max(fraction, f)
    if (l === 'ok') continue
    if (rank[l] > rank[level] || f > worst) {
      if (rank[l] < rank[level]) continue
      level = l
      worst = f
      reason = c.label
    }
  }
  return { level, fraction, ...(reason ? { reason } : {}), tokens, costUsd }
}

function fmtTok(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

function totalsPlus(t: UsageTotals | Usage, live?: Usage): Usage {
  const base: Usage = { input: t.input, output: t.output, cacheRead: t.cacheRead, cacheWrite: t.cacheWrite, costUsd: t.costUsd ?? 0 }
  return live ? addUsage(base, live) : base
}

// Pure check for one test agent: hard caps -> 'stop'.
export function checkAgent(used: Usage, limits: BudgetLimits, daySpend?: number): BudgetCheck {
  const warnAt = limits.warnAt ?? DEFAULT_LIMITS.warnAt
  const tokens = countTokens(used, limits.tokenMetric)
  const cost = used.costUsd ?? 0
  return evaluate(
    [
      { limit: limits.agentMaxTokens, used: tokens, hard: true, label: `test agent used ${fmtTok(tokens)} of ${fmtTok(limits.agentMaxTokens ?? 0)} tokens` },
      { limit: limits.agentMaxCostUsd, used: cost, hard: true, label: `test agent spent $${cost.toFixed(2)} of $${(limits.agentMaxCostUsd ?? 0).toFixed(2)}` },
      ...dayCap(limits, daySpend)
    ],
    warnAt,
    tokens,
    cost
  )
}

// Pure check for one chat: soft caps -> 'warn'; chatMaxCostUsd / daily cap -> 'stop'.
export function checkChat(used: Usage, limits: BudgetLimits, daySpend?: number): BudgetCheck {
  const warnAt = limits.warnAt ?? DEFAULT_LIMITS.warnAt
  const tokens = countTokens(used, limits.tokenMetric)
  const cost = used.costUsd ?? 0
  return evaluate(
    [
      { limit: limits.chatSoftTokens, used: tokens, hard: false, label: `chat is at ${fmtTok(tokens)} tokens (soft cap ${fmtTok(limits.chatSoftTokens ?? 0)}); consider a new chat or /compact` },
      { limit: limits.chatSoftCostUsd, used: cost, hard: false, label: `chat cost $${cost.toFixed(2)} (soft cap $${(limits.chatSoftCostUsd ?? 0).toFixed(2)})` },
      { limit: limits.chatMaxCostUsd, used: cost, hard: true, label: `chat reached its $${(limits.chatMaxCostUsd ?? 0).toFixed(2)} cap` },
      ...dayCap(limits, daySpend)
    ],
    warnAt,
    tokens,
    cost
  )
}

function dayCap(limits: BudgetLimits, daySpend: number | undefined): Cap[] {
  if (daySpend === undefined || !limits.dailyMaxCostUsd) return []
  return [{ limit: limits.dailyMaxCostUsd, used: daySpend, hard: true, label: `daily spend $${daySpend.toFixed(2)} reached the $${limits.dailyMaxCostUsd.toFixed(2)} cap` }]
}

// Ledger-backed guard. `live` is usage of the in-flight query not yet in the ledger
// (SdkUsageTracker.live(), or the OpenAI loop's running sum).
export class BudgetGuard {
  private ledger: UsageLedger
  private limits: () => BudgetLimits

  constructor(ledger: UsageLedger, limits: BudgetLimits | (() => BudgetLimits)) {
    this.ledger = ledger
    this.limits = typeof limits === 'function' ? limits : () => limits
  }

  check(scope: { agentId: string } | { chatId: string }, live?: Usage): BudgetCheck {
    const limits = this.limits()
    const day = this.ledger.day().costUsd + (live?.costUsd ?? 0)
    if ('agentId' in scope) return checkAgent(totalsPlus(this.ledger.agent(scope.agentId), live), limits, day)
    return checkChat(totalsPlus(this.ledger.chat(scope.chatId), live), limits, day)
  }

  // Predicate for runOpenAiLoop's stop(): true once the agent hits a hard cap.
  stopWhen(scope: { agentId: string } | { chatId: string }, live: () => Usage = emptyUsage): () => boolean {
    return () => this.check(scope, live()).level === 'stop'
  }

  // Agent SDK options enforcing the agent caps natively: maxBudgetUsd stops the query with an
  // error_max_budget_usd result. (The SDK has no token cap; the token cap is checked per message.)
  sdkOptions(scope: 'agent' | 'chat'): { maxBudgetUsd?: number } {
    const l = this.limits()
    const cap = scope === 'agent' ? l.agentMaxCostUsd : l.chatMaxCostUsd
    return cap && cap > 0 ? { maxBudgetUsd: cap } : {}
  }
}

// ---------------------------------------------------------------------------------------------
// Model router.

export type RouteTask = 'chat' | 'agent' | 'summary'
export type RouteTier = 'cheap' | 'big' | 'chosen'

export interface TierModels {
  cheap: string
  big: string
}

// Per-provider defaults. Anthropic: Haiku 5.5 / Opus 5.5. OpenAI: gpt-6-luna (the low-cost
// GPT-6 model; providers.extraBody sends reasoning_effort none for tools) / gpt-6-astra (flagship).
// Gemini: 3.5 Flash-Lite / 3.1 Pro preview. OpenRouter: Anthropic models via their slugs.
// Ollama and custom endpoints serve whatever the user installed: no routing.
export const TIER_DEFAULTS: Partial<Record<ProviderId, TierModels>> = {
  anthropic: { cheap: 'claude-haiku-5-5', big: 'claude-opus-5-5' },
  openai: { cheap: 'gpt-6-luna', big: 'gpt-6-astra' },
  gemini: { cheap: 'gemini-3.5-flash-lite', big: 'gemini-3.1-pro-preview' },
  openrouter: { cheap: 'anthropic/claude-haiku-5.5', big: 'anthropic/claude-opus-5.5' }
}

export interface RouteSettings {
  provider: ProviderId
  // The user's chosen model for this chat/provider (the default when no rule fires).
  model: string
  // Off: always use `model`. Default on.
  autoRoute?: boolean
  // Per-provider overrides of TIER_DEFAULTS.
  tiers?: Partial<Record<ProviderId, Partial<TierModels>>>
}

export interface RouteInput {
  task: RouteTask
  text: string
  settings: RouteSettings
  // Explicit model for this request (picker, "/model x"): always wins.
  override?: string
  // Model the ongoing chat already used. Routing never downgrades mid-chat: switching models
  // drops the provider's prompt cache (caches are per model), which costs more than it saves.
  previousModel?: string
}

export interface Route {
  provider: ProviderId
  model: string
  tier: RouteTier
  reason: string
}

const THINK_HARD = /\b(think (?:hard|harder|deeply|carefully)|ultrathink|deep dive|step[- ]by[- ]step plan)\b/i
const BIG_TASK = /\b(refactor\w*|re-?architect\w*|architecture|redesign\w*|rewrite\w*|migrat\w*|overhaul\w*|implement (?:a |the )?(?:new )?(?:system|feature|framework)|across (?:all|every|the (?:whole|entire))|every (?:service|controller|module|file|script)|all (?:services|controllers|modules|files|scripts)|whole (?:project|codebase|game)|entire (?:project|codebase|game)|multi-?file|race condition|memory leak|desync|why (?:does|doesn't|is|isn't)[^?]{40,})/i
const SIMPLE_ASK = /^(what|where|which|who|when|is|are|does|do|can|show|list|find|open|explain|rename|fix (?:the |this |a )?typo|how (?:do|can) i)\b/i
const PATHISH = /[\w-]+(?:\/[\w.-]+)+\.(?:luau|lua|blink|json|toml)|\b[A-Z][A-Za-z]+(?:Service|Controller)\b/g

export function tiersFor(settings: RouteSettings): TierModels | null {
  const d = TIER_DEFAULTS[settings.provider]
  const o = settings.tiers?.[settings.provider]
  const cheap = o?.cheap ?? d?.cheap
  const big = o?.big ?? d?.big
  return cheap && big ? { cheap, big } : null
}

// Picks a model with simple rules, each producing a one-line reason for the UI:
//   1. explicit override -> that model;            2. auto-routing off / no tiers -> chosen model;
//   3. summary or test agent -> cheap;             4. "think hard", refactors, multi-file -> big;
//   5. short simple question -> cheap;             6. otherwise -> the chosen model.
// Mid-chat (previousModel set) the result never moves to a cheaper tier than previousModel.
export function routeModel(input: RouteInput): Route {
  const { settings } = input
  const provider = settings.provider
  if (input.override?.trim()) return { provider, model: input.override.trim(), tier: 'chosen', reason: 'user override' }
  const tiers = tiersFor(settings)
  if (settings.autoRoute === false) return { provider, model: settings.model, tier: 'chosen', reason: 'auto-routing off' }
  if (!tiers) return { provider, model: settings.model, tier: 'chosen', reason: `no cheap/big models known for ${provider}` }

  const text = input.text ?? ''
  const pick = (tier: Exclude<RouteTier, 'chosen'>, reason: string): Route => ({ provider, model: tiers[tier], tier, reason })
  const chosen = (reason: string): Route => ({ provider, model: settings.model, tier: 'chosen', reason })

  let route: Route
  if (input.task === 'summary') route = pick('cheap', 'summaries use the cheap model')
  else if (input.task === 'agent') route = THINK_HARD.test(text) ? pick('big', 'scenario asks to think hard') : pick('cheap', 'test agents use the cheap model')
  else {
    const paths = new Set(text.match(PATHISH) ?? [])
    const big = THINK_HARD.exec(text) ?? BIG_TASK.exec(text)
    if (big) route = pick('big', `asks for "${big[0].trim().slice(0, 40)}"`)
    else if (paths.size >= 3) route = pick('big', `touches ${paths.size} files/modules`)
    else if (text.length > 2000) route = pick('big', 'long, detailed request')
    else if (text.length <= 160 && !text.includes('\n') && SIMPLE_ASK.test(text.trim()) && paths.size <= 1)
      route = pick('cheap', 'short, simple question')
    else route = chosen('default model')
  }

  // Never downgrade an ongoing chat (prompt cache is per model).
  if (input.previousModel && input.task === 'chat' && route.model !== input.previousModel) {
    const rank = (m: string) => (m === tiers.big ? 2 : m === tiers.cheap ? 0 : 1)
    if (rank(route.model) < rank(input.previousModel)) {
      return { provider, model: input.previousModel, tier: input.previousModel === tiers.big ? 'big' : input.previousModel === tiers.cheap ? 'cheap' : 'chosen', reason: `kept ${input.previousModel} (switching mid-chat drops the prompt cache)` }
    }
  }
  return route
}
