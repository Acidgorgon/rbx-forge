// Fast, dependency-free token estimator used by the budget layer (project map, search output,
// tool-output truncation, history compaction, budget checks).
//
// It is an estimate, not a tokenizer: about chars/4 for prose, with two code-aware tweaks:
// - runs of whitespace (indentation, blank lines) count as one character, since BPE tokenizers
//   merge them into few tokens;
// - punctuation-dense text (Luau, JSON, paths) uses a smaller divisor, since symbols like
//   `(`, `.`, `:`, `"` mostly become their own tokens.
// Calibrated loosely against the Claude and GPT tokenizers on Luau and English: within ~15% for
// typical code and prose, and it errs on the high side, which is the safe side for budgets.
// Newer tokenizers (Claude Haiku 5.5, Opus 4.7+) count ~1x-1.35x the older ones; the provider's
// reported usage is the source of truth for billing — use this only for planning and caps.

const PROSE_DIVISOR = 4
const CODE_DIVISOR = 3.4
// Share of non-space characters that are punctuation above which text counts as code.
const CODE_PUNCT_RATIO = 0.08
// Fixed per-message overhead of chat formats (role markers, separators).
export const MESSAGE_OVERHEAD_TOKENS = 4

function isSpace(c: number): boolean {
  return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12
}

function isWordChar(c: number): boolean {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c === 95 || c > 127
}

// Estimated token count of `text`. O(n), no allocation.
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0
  let effective = 0
  let punct = 0
  let nonAscii = 0
  let inSpace = false
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (isSpace(c)) {
      if (!inSpace) effective++
      inSpace = true
      continue
    }
    inSpace = false
    effective++
    if (c > 127) nonAscii++
    else if (!isWordChar(c)) punct++
  }
  const visible = effective || 1
  const divisor = punct / visible > CODE_PUNCT_RATIO ? CODE_DIVISOR : PROSE_DIVISOR
  // Non-ASCII (CJK, emoji) is closer to one token per character or two.
  const ascii = effective - nonAscii
  return Math.ceil(ascii / divisor + nonAscii * 0.75)
}

// Estimate for a JSON-serializable value (tool inputs, schemas).
export function estimateJsonTokens(value: unknown): number {
  if (value === undefined) return 0
  try {
    return estimateTokens(typeof value === 'string' ? value : JSON.stringify(value))
  } catch {
    return 0
  }
}

// Minimal message shape shared by the OpenAI-compatible loop and compaction.
export interface TokenMessage {
  role: string
  content?: string | null
  tool_calls?: { id?: string; type?: string; function?: { name?: string; arguments?: string }; [extra: string]: unknown }[]
  [extra: string]: unknown
}

export function estimateMessageTokens(m: TokenMessage): number {
  let n = MESSAGE_OVERHEAD_TOKENS + estimateTokens(m.content ?? '')
  if (Array.isArray(m.tool_calls)) {
    for (const call of m.tool_calls) {
      n += MESSAGE_OVERHEAD_TOKENS + estimateTokens(call.function?.name ?? '') + estimateTokens(call.function?.arguments ?? '')
    }
  }
  return n
}

export function estimateMessagesTokens(messages: readonly TokenMessage[]): number {
  let n = 0
  for (const m of messages) n += estimateMessageTokens(m)
  return n
}

// Compact human form: 950, 1.2k, 34k, 1.5M.
export function formatTokens(n: number): string {
  if (!Number.isFinite(n)) return '?'
  const a = Math.abs(n)
  if (a < 1000) return String(Math.round(n))
  if (a < 10_000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k'
  if (a < 1_000_000) return Math.round(n / 1000) + 'k'
  return (n / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
}
