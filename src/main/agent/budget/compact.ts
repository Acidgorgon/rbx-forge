// History compaction for the OpenAI-compatible loop (the Agent SDK compacts its own sessions).
//
// compactHistory keeps the system messages and the last N turns verbatim, truncates tool results
// (head/tail with "… N lines omitted"), and, when still over budget, replaces the older turns with
// one summary produced by an injected summarize() (a cheap model). Deterministic for a given
// summarize(); never splits a turn, so every tool result stays after the assistant call it answers.
//
// Prompt-cache note: compaction rewrites the history prefix, so the next request is a cache miss
// for everything after the system prompt. Compact rarely and in large steps (trigger near the
// budget, compact down to ~50% of it), not a little every turn.

import { estimateMessageTokens, estimateMessagesTokens, estimateTokens, type TokenMessage } from './tokens.ts'

export interface CompactMessage extends TokenMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
}

export const SUMMARY_MARKER = '[Summary of the earlier conversation]'
const CURRENT_MARKER = '[Current request]'

// Truncates text to about maxTokens, keeping the head and tail lines (60/40) and noting what was
// cut. Returns the input unchanged when it fits.
export function truncateToolOutput(text: string, maxTokens: number, opts: { headRatio?: number } = {}): string {
  if (maxTokens <= 0) return text ? `… ${text.split('\n').length} lines omitted` : text
  if (estimateTokens(text) <= maxTokens) return text
  const headRatio = Math.min(0.95, Math.max(0.05, opts.headRatio ?? 0.6))
  const trailingNewline = text.endsWith('\n')
  const lines = (trailingNewline ? text.slice(0, -1) : text).split('\n')
  // Reserve room for the marker line.
  const budget = Math.max(1, maxTokens - 8)

  if (lines.length < 3) {
    // One huge line (minified JSON, a long string): cut by characters.
    const total = text.length
    let keep = Math.floor(total * (budget / Math.max(1, estimateTokens(text))))
    keep = Math.max(16, Math.min(total - 1, keep))
    const head = Math.floor(keep * headRatio)
    const tail = keep - head
    return `${text.slice(0, head)}… ${total - head - tail} chars omitted …${text.slice(total - tail)}`
  }

  const headBudget = Math.floor(budget * headRatio)
  const tailBudget = budget - headBudget
  const head: string[] = []
  let used = 0
  for (const l of lines) {
    const t = estimateTokens(l) + 1
    if (used + t > headBudget) break
    head.push(l)
    used += t
  }
  const tail: string[] = []
  used = 0
  for (let i = lines.length - 1; i >= head.length; i--) {
    const t = estimateTokens(lines[i]) + 1
    if (used + t > tailBudget) break
    tail.unshift(lines[i])
    used += t
  }
  // A single line larger than the whole head budget: keep a clipped first line at least.
  if (!head.length) head.push(lines[0].slice(0, Math.max(16, headBudget * 3)) + '…')
  const omitted = lines.length - head.length - tail.length
  if (omitted <= 0) return text
  return [...head, `… ${omitted} lines omitted …`, ...tail].join('\n') + (trailingNewline ? '\n' : '')
}

// Splits history into leading system messages and turns. A turn starts at a user message and
// holds the assistant/tool messages that follow it. Messages before the first user message
// (other than leading system ones) join the first turn.
export function splitTurns<M extends CompactMessage>(messages: readonly M[]): { system: M[]; turns: M[][] } {
  const system: M[] = []
  let i = 0
  while (i < messages.length && messages[i].role === 'system') system.push(messages[i++])
  const turns: M[][] = []
  let cur: M[] = []
  for (; i < messages.length; i++) {
    const m = messages[i]
    if (m.role === 'user' && cur.some((x) => x.role === 'user')) {
      turns.push(cur)
      cur = []
    }
    cur.push(m)
  }
  if (cur.length) turns.push(cur)
  return { system, turns }
}

function toolName(turn: CompactMessage[], callId: unknown): string {
  for (const m of turn) {
    for (const c of (m.tool_calls ?? []) as { id?: string; function?: { name?: string } }[]) {
      if (c.id === callId) return c.function?.name ?? 'tool'
    }
  }
  return 'tool'
}

// Plain-text transcript of turns for the summarizer, with tool output cut hard.
export function transcript(turns: CompactMessage[][], toolTokens = 150): string {
  const out: string[] = []
  for (const turn of turns) {
    for (const m of turn) {
      if (m.role === 'user') out.push(`User: ${m.content ?? ''}`)
      else if (m.role === 'assistant') {
        if (m.content) out.push(`Assistant: ${m.content}`)
        for (const c of (m.tool_calls ?? []) as { function?: { name?: string; arguments?: string } }[]) {
          out.push(`Assistant called ${c.function?.name ?? 'tool'}(${truncateToolOutput(c.function?.arguments ?? '', 60)})`)
        }
      } else if (m.role === 'tool') {
        out.push(`${toolName(turn, m.tool_call_id)} result: ${truncateToolOutput(m.content ?? '', toolTokens)}`)
      } else if (m.role === 'system') out.push(`System: ${m.content ?? ''}`)
    }
  }
  return out.join('\n')
}

export const SUMMARY_INSTRUCTIONS = `Summarize this conversation between a user and a coding assistant working on a Roblox (Luau, Rojo) project, so the assistant can continue without the full history. Keep: the user's goals and constraints, decisions made, files and functions read or changed (with paths), errors found and their causes, and open tasks. Drop pleasantries and tool output details that are no longer needed. Use terse bullet points, at most 300 words.`

export interface CompactOptions {
  // Target size of the whole history after compaction.
  budgetTokens: number
  // Turns kept verbatim at the end (reduced to fit, never below 1). Default 4.
  keepTurns?: number
  // Max tokens per tool result in kept turns. Default 2000.
  toolMaxTokens?: number
  // Cap on the transcript handed to summarize(). Default 12000.
  summaryInputTokens?: number
  // Produces the summary (cheap model). Receives the transcript; prepend SUMMARY_INSTRUCTIONS
  // as its system prompt.
  summarize: (transcript: string) => Promise<string>
  // Where the summary goes: prefixed to the first kept user message (default; works on every
  // provider) or as an extra system message after the leading system messages.
  summaryAs?: 'user-prefix' | 'system'
}

export interface CompactResult<M> {
  messages: M[]
  tokensBefore: number
  tokensAfter: number
  // Turns replaced by the summary (0 when only tool results were truncated).
  summarizedTurns: number
  summary?: string
}

function truncateTools<M extends CompactMessage>(turn: M[], maxTokens: number): M[] {
  return turn.map((m) => (m.role === 'tool' && m.content && estimateTokens(m.content) > maxTokens ? { ...m, content: truncateToolOutput(m.content, maxTokens) } : m))
}

// True when the history is over `budgetTokens`. Use a trigger above the target, e.g.
// needsCompaction(h, 0.9 * window) then compactHistory(h, { budgetTokens: 0.5 * window }).
export function needsCompaction(messages: readonly CompactMessage[], budgetTokens: number): boolean {
  return estimateMessagesTokens(messages) > budgetTokens
}

export async function compactHistory<M extends CompactMessage>(messages: readonly M[], opts: CompactOptions): Promise<CompactResult<M>> {
  const tokensBefore = estimateMessagesTokens(messages)
  const toolMax = opts.toolMaxTokens ?? 2000
  const { system, turns } = splitTurns(messages)
  const trimmed = turns.map((t) => truncateTools(t, toolMax))
  const flat = (ts: M[][]) => [...system, ...ts.flat()]

  const afterTrim = flat(trimmed)
  const trimmedTokens = estimateMessagesTokens(afterTrim)
  if (trimmedTokens <= opts.budgetTokens || trimmed.length <= 1) {
    return { messages: afterTrim, tokensBefore, tokensAfter: trimmedTokens, summarizedTurns: 0 }
  }

  // Keep as many recent turns as fit (at most keepTurns, at least 1), leaving ~600 tokens for the summary.
  const reserve = 600
  const systemTokens = estimateMessagesTokens(system)
  let keep = Math.min(Math.max(1, opts.keepTurns ?? 4), trimmed.length - 1)
  const turnTokens = (t: M[]) => t.reduce((n, m) => n + estimateMessageTokens(m), 0)
  while (keep > 1) {
    const recent = trimmed.slice(trimmed.length - keep).reduce((n, t) => n + turnTokens(t), 0)
    if (systemTokens + recent + reserve <= opts.budgetTokens) break
    keep--
  }
  let kept = trimmed.slice(trimmed.length - keep)
  const old = trimmed.slice(0, trimmed.length - keep)

  // The only kept turn can still be over budget (huge tool outputs): squeeze its tool results.
  let squeeze = toolMax
  while (squeeze > 100 && systemTokens + kept.reduce((n, t) => n + turnTokens(t), 0) + reserve > opts.budgetTokens) {
    squeeze = Math.floor(squeeze / 2)
    kept = kept.map((t) => truncateTools(t, squeeze))
  }

  let text = transcript(old)
  const cap = opts.summaryInputTokens ?? 12_000
  if (estimateTokens(text) > cap) text = truncateToolOutput(text, cap, { headRatio: 0.3 })
  const summary = (await opts.summarize(text)).trim()

  let out: M[]
  if ((opts.summaryAs ?? 'user-prefix') === 'system') {
    out = [...system, { role: 'system', content: `${SUMMARY_MARKER}\n${summary}` } as M, ...kept.flat()]
  } else {
    const [first, ...rest] = kept
    const idx = first.findIndex((m) => m.role === 'user')
    const firstTurn = first.slice()
    if (idx >= 0) {
      const u = firstTurn[idx]
      firstTurn[idx] = { ...u, content: `${SUMMARY_MARKER}\n${summary}\n\n${CURRENT_MARKER}\n${u.content ?? ''}` }
    } else {
      firstTurn.unshift({ role: 'user', content: `${SUMMARY_MARKER}\n${summary}` } as M)
    }
    out = [...system, ...firstTurn, ...rest.flat()]
  }
  return { messages: out, tokensBefore, tokensAfter: estimateMessagesTokens(out), summarizedTurns: old.length, summary }
}
