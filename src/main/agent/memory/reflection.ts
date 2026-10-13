// Background "reflection" after a chat: the cheap model reads the recent transcript (plus the current
// indexes, so it does not re-propose what is already known) and proposes memories and skills as
// JSON. parseProposals validates that output; the service then saves (auto) or shows a card (ask).

import { unsafeReason } from './safety.ts'
import { LIMITS, slugify } from './store.ts'
import type { MemoryInput, MemoryScope, MemoryType } from './types.ts'

// Plain-data view of a chat message (shared ChatMessage is structurally compatible).
export interface TranscriptMessage {
  role: 'user' | 'assistant' | 'tool' | 'system'
  text: string
  tool?: { name: string; input: string }
}

export const MAX_PROPOSALS = 4
const TRANSCRIPT_CHARS = 9000
const MESSAGE_CHARS = 1200

export const REFLECTION_SYSTEM = `You review a finished conversation between a game developer and their coding agent (Roblox, Luau, Rojo, GenTree template, Blink networking, Vide UI) and decide what is worth remembering for future sessions.

Propose at most ${MAX_PROPOSALS} items, and usually zero or one. Propose only:
- a preference or correction the person stated (how they like code or answers, naming, models, workflow) -> scope "user", type "user" or "feedback";
- a durable, non-obvious fact about this game (a convention, a decision and why, an architecture fact) -> scope "project", type "project" or "reference";
- a multi-step procedure that succeeded and is likely to recur -> kind "skill" with numbered steps in body.
Never propose secrets, credentials, personal data, one-off task details, facts obvious from the code, or anything already in the existing index (if an existing entry should change, reuse its exact name).

Reply with JSON only, no prose:
{"items":[{"kind":"memory"|"skill","scope":"user"|"project","type":"user"|"project"|"feedback"|"reference","name":"kebab-case-name","description":"one line","body":"markdown","reason":"why this is worth keeping"}]}
Reply {"items":[]} when nothing qualifies.`

function clip(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s
}

// Compact transcript: user and assistant text, tool calls as one line, newest kept when cutting.
export function transcriptText(messages: TranscriptMessage[], cap = TRANSCRIPT_CHARS): string {
  const lines: string[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    if (m.role === 'tool') {
      lines.push(`[tool ${m.tool?.name ?? ''} ${clip(m.tool?.input ?? '', 120)}]`)
      continue
    }
    lines.push(`${m.role === 'user' ? 'USER' : 'AGENT'}: ${clip(m.text.trim(), MESSAGE_CHARS)}`)
  }
  const out: string[] = []
  let used = 0
  for (let i = lines.length - 1; i >= 0; i--) {
    if (used + lines[i].length > cap) break
    out.unshift(lines[i])
    used += lines[i].length + 1
  }
  return out.join('\n')
}

// Worth reflecting on: at least one user turn with some substance (or a correction).
export function worthReflecting(messages: TranscriptMessage[]): boolean {
  const users = messages.filter((m) => m.role === 'user')
  if (!users.length) return false
  const chars = users.reduce((s, m) => s + m.text.length, 0)
  const corrected = users.some((m) => /\b(no|don't|do not|never|always|prefer|instead|actually|stop|i like|i want)\b/i.test(m.text))
  return users.length >= 2 || chars >= 160 || corrected
}

export function reflectionPrompt(messages: TranscriptMessage[], existingIndex: string): string {
  return `Existing memory index (do not repeat these; reuse a name to update one):\n${existingIndex.trim() || '(empty)'}\n\nConversation:\n${transcriptText(messages)}`
}

export interface ParsedProposal {
  input: MemoryInput
  reason?: string
}

// First top-level JSON object in the text (models sometimes wrap it in a fence or prose).
function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const src = fenced ? fenced[1] : text
  const start = src.indexOf('{')
  if (start < 0) return null
  let depth = 0
  let inStr = false
  let esc = false
  for (let i = start; i < src.length; i++) {
    const c = src[i]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{') depth++
    else if (c === '}' && --depth === 0) {
      try {
        return JSON.parse(src.slice(start, i + 1))
      } catch {
        return null
      }
    }
  }
  return null
}

const TYPES = new Set<MemoryType>(['user', 'project', 'feedback', 'reference'])

// Validates the model's JSON: drops malformed, oversized and secret-like items; caps the count.
export function parseProposals(text: string): ParsedProposal[] {
  const json = extractJson(text) as { items?: unknown } | unknown[] | null
  const items = Array.isArray(json) ? json : Array.isArray((json as { items?: unknown })?.items) ? ((json as { items: unknown[] }).items) : []
  const out: ParsedProposal[] = []
  const seen = new Set<string>()
  for (const raw of items) {
    if (!raw || typeof raw !== 'object') continue
    const r = raw as Record<string, unknown>
    const kind = r.kind === 'skill' ? 'skill' : 'memory'
    const scope: MemoryScope = r.scope === 'user' ? 'user' : 'project'
    const name = slugify(String(r.name ?? ''))
    const description = String(r.description ?? '').replace(/\s+/g, ' ').trim()
    let body = typeof r.body === 'string' ? r.body : Array.isArray(r.steps) ? (r.steps as unknown[]).map((s, i) => `${i + 1}. ${String(s)}`).join('\n') : ''
    body = body.trim()
    if (!name || !description || !body) continue
    if (description.length > LIMITS.description) continue
    if (body.length > (kind === 'skill' ? LIMITS.skillBody : LIMITS.memoryBody)) continue
    if (unsafeReason(`${name}\n${description}\n${body}`)) continue
    const key = `${kind}:${scope}:${name}`
    if (seen.has(key)) continue
    seen.add(key)
    const type = TYPES.has(r.type as MemoryType) ? (r.type as MemoryType) : scope === 'user' ? 'user' : 'project'
    const input: MemoryInput = { scope, kind, name, description, body, ...(kind === 'memory' ? { type } : {}) }
    const reason = typeof r.reason === 'string' && r.reason.trim() ? r.reason.trim().slice(0, 200) : undefined
    out.push({ input, ...(reason ? { reason } : {}) })
    if (out.length >= MAX_PROPOSALS) break
  }
  return out
}
