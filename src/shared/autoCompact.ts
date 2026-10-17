// Auto-compact: when a chat's context reaches a share of the model's window, the older turns are
// summarized and the chat continues from the summary. One setting (Settings > AI > Chat) drives every
// provider path Forge controls: the OpenAI-compatible loop compacts itself at the threshold; the Agent
// SDK gets the threshold as its own auto-compact trigger; the Codex CLI manages its thread's context
// itself (only /compact and the meter apply there). Pure: shared by main and the renderer.

import type { ProviderId } from './types.ts'

export interface AutoCompactSettings {
  enabled: boolean
  // Percent of the context window at which compaction starts.
  pct: number
}

export const AUTO_COMPACT_DEFAULT: AutoCompactSettings = { enabled: true, pct: 80 }
// The slider's range: below 50% compaction would run every few turns (each one is a cache miss);
// above 95% the next request can overflow before it runs.
export const AUTO_COMPACT_MIN_PCT = 50
export const AUTO_COMPACT_MAX_PCT = 95

export function clampCompactPct(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v)
  if (!Number.isFinite(n)) return AUTO_COMPACT_DEFAULT.pct
  return Math.round(Math.min(AUTO_COMPACT_MAX_PCT, Math.max(AUTO_COMPACT_MIN_PCT, n)))
}

// Settings keys 'autoCompact' (boolean) and 'autoCompactPct' (number).
export function readAutoCompact(get: <T>(key: string, fallback: T) => T): AutoCompactSettings {
  return { enabled: get<unknown>('autoCompact', true) !== false, pct: clampCompactPct(get<unknown>('autoCompactPct', AUTO_COMPACT_DEFAULT.pct)) }
}

// Context window Forge assumes for a chat model. Claude: 200k (1M for the "[1m]" variants); the
// OpenAI-compatible loop: what the provider reported (OpenRouter context_length), else `fallback`
// (the compactWindowTokens setting); Codex: unknown, the CLI keeps its own window.
export const CLAUDE_WINDOW = 200_000
export const CLAUDE_LONG_WINDOW = 1_000_000
export const OAI_WINDOW = 120_000

export function contextWindow(provider: ProviderId, model: string, opts: { reported?: number; fallback?: number } = {}): number | null {
  if (provider === 'codex') return null
  if (provider === 'anthropic') return /\[1m\]$/i.test(model.trim()) ? CLAUDE_LONG_WINDOW : CLAUDE_WINDOW
  if (opts.reported && opts.reported > 0) return opts.reported
  return opts.fallback && opts.fallback > 0 ? opts.fallback : OAI_WINDOW
}

// Token count at which auto-compact runs (null: off or no known window).
export function compactTrigger(window: number | null, s: AutoCompactSettings): number | null {
  if (!s.enabled || !window) return null
  return Math.round((window * clampCompactPct(s.pct)) / 100)
}

// What a compaction shrinks the history to: half the trigger (80% -> 40%), so it runs rarely and in
// big steps (each one rewrites the prompt prefix, a cache miss).
export function compactTarget(trigger: number): number {
  return Math.round(trigger / 2)
}

// Agent SDK: the CLI's own trigger as an env override (percent of its window), or off.
export function sdkCompactEnv(s: AutoCompactSettings): Record<string, string> {
  return s.enabled ? { CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: String(clampCompactPct(s.pct)) } : { DISABLE_AUTO_COMPACT: '1' }
}

// "142k", "1.2M": the divider and meter form.
export function fmtCompactTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '?'
  if (n < 1000) return String(Math.round(n))
  if (n < 1_000_000) return `${n < 10_000 ? (n / 1000).toFixed(1).replace(/\.0$/, '') : Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// The divider line: "Compacted · 142k → 48k tokens" (after unknown: "Compacted · 142k tokens").
export function compactLabel(before: number, after?: number): string {
  return after !== undefined && after >= 0 ? `Compacted · ${fmtCompactTokens(before)} → ${fmtCompactTokens(after)} tokens` : `Compacted · ${fmtCompactTokens(before)} tokens`
}
