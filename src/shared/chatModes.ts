// Chat modes (Claude Code parity): Ask, Plan, Edit with approval, Auto-accept edits. Shared by main
// (tool gating, plan / diff cards) and the renderer (mode pill, cards). No imports: plain data and
// pure helpers, so tests and both processes load it directly.

export type ChatMode = 'ask' | 'plan' | 'edit' | 'auto'
// The modes a plan can run in once approved.
export type RunMode = 'edit' | 'auto'

export const DEFAULT_CHAT_MODE: ChatMode = 'edit'

export const CHAT_MODES: { id: ChatMode; label: string; short: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', short: 'ask', hint: 'Read-only Q&A: reads and searches, never writes' },
  { id: 'plan', label: 'Plan', short: 'plan', hint: 'Investigates read-only, then proposes a plan to approve' },
  { id: 'edit', label: 'Edit with approval', short: 'edit', hint: 'Every file edit waits for your Accept / Reject' },
  { id: 'auto', label: 'Auto-accept edits', short: 'auto-accept', hint: 'Edits inside the project apply without asking' }
]

export function isChatMode(v: unknown): v is ChatMode {
  return v === 'ask' || v === 'plan' || v === 'edit' || v === 'auto'
}

// Shift+Tab order.
export function nextChatMode(m: ChatMode): ChatMode {
  const i = CHAT_MODES.findIndex((x) => x.id === m)
  return CHAT_MODES[(i + 1) % CHAT_MODES.length].id
}

// Modes in which the agent may never change the project.
export function isReadOnlyMode(m: ChatMode): boolean {
  return m === 'ask' || m === 'plan'
}

export function modeLabel(m: ChatMode): string {
  return CHAT_MODES.find((x) => x.id === m)?.label ?? m
}

// ---------------------------------------------------------------- plan card

export type PlanState = 'pending' | 'approved' | 'kept' | 'superseded'

export interface PlanCardData {
  // The plan as markdown (the person's edit once edited).
  text: string
  steps: string[]
  files: string[]
  risks: string[]
  summary?: string
  state: PlanState
  edited?: boolean
  // Approved: the mode it ran in.
  runMode?: RunMode
}

const SECTION = /^\s{0,3}(?:#{1,6}\s*|\*\*)?\s*(steps?|plan|implementation|files?(?: to (?:change|touch|edit))?|files touched|risks?(?: and [a-z ]+)?|concerns|caveats|summary|goal|overview)\s*:?\s*(?:\*\*)?\s*:?\s*$/i

// Reads a markdown plan into steps / files / risks. Lenient: numbered or bulleted items under
// headings like "Steps", "Files", "Risks"; without headings every list item is a step.
export function parsePlan(text: string): Pick<PlanCardData, 'steps' | 'files' | 'risks' | 'summary'> {
  const steps: string[] = []
  const files: string[] = []
  const risks: string[] = []
  const summary: string[] = []
  let section: 'steps' | 'files' | 'risks' | 'summary' | null = null
  for (const raw of String(text ?? '').replace(/\r\n/g, '\n').split('\n')) {
    const h = SECTION.exec(raw)
    if (h) {
      const k = h[1].toLowerCase()
      section = /^file/.test(k) ? 'files' : /^(risk|concern|caveat)/.test(k) ? 'risks' : /^(summary|goal|overview)/.test(k) ? 'summary' : 'steps'
      continue
    }
    const item = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(raw)
    if (item) {
      const v = item[1].trim()
      if (!v) continue
      if (section === 'files') files.push(v)
      else if (section === 'risks') risks.push(v)
      else if (section === 'summary') summary.push(v)
      else if (/^\s*\d+[.)]/.test(raw) || section === 'steps' || !section) steps.push(v)
      continue
    }
    if (section === 'summary' || (!section && !steps.length)) {
      const t = raw.replace(/^#+\s*/, '').trim()
      if (t) summary.push(t)
    }
  }
  // File paths mentioned in steps when there is no files section.
  if (!files.length) {
    const seen = new Set<string>()
    for (const s of steps) for (const m of s.matchAll(/`([^`\s]+\.(?:luau|lua|blink|toml|json|md))`/g)) if (!seen.has(m[1])) (seen.add(m[1]), files.push(m[1]))
  }
  const out: Pick<PlanCardData, 'steps' | 'files' | 'risks' | 'summary'> = { steps, files, risks }
  const s = summary.join(' ').trim()
  if (s) out.summary = s.slice(0, 400)
  return out
}

export function planCard(text: string): PlanCardData {
  return { text: text.trim(), ...parsePlan(text), state: 'pending' }
}

// The prompt that runs an approved plan.
export function planRunPrompt(plan: PlanCardData): string {
  return `Execute this approved plan now. Follow it step by step; if something in it turns out to be wrong, say so and adapt.\n\n${plan.text}`
}

// What the agent is told about the format in Plan mode (all providers).
export const PLAN_FORMAT = `Write the plan in markdown with these sections:
## Summary
One or two sentences.
## Steps
1. Numbered, concrete steps.
## Files
- \`path/to/file.luau\` - what changes
## Risks
- What could break, and how to check it.`

// ---------------------------------------------------------------- diff card

export type DiffLine = { t: ' ' | '-' | '+'; s: string }

export interface DiffHunk {
  id: number
  // 0-based line index in the old text where the hunk starts, and how many old lines it spans.
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export type DiffState = 'pending' | 'accepted' | 'rejected' | 'partial' | 'expired'

export interface DiffCardData {
  // Repo-relative path ('' for an action without a file, e.g. add_blink_event).
  path: string
  tool: string
  // For non-file actions: a one-line summary of what will run.
  action?: string
  created?: boolean
  hunks: DiffHunk[]
  added: number
  removed: number
  state: DiffState
  // Accepted hunk ids (partial).
  accepted?: number[]
  // Diff too large to show by hunk: accept or reject as a whole.
  whole?: boolean
}

export function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  return lines
}

// Line diff -> hunks with `context` lines around each change. Common prefix/suffix are trimmed,
// then an LCS table runs on the middle (capped; past the cap the middle is one replace hunk).
export function diffLines(before: string, after: string, context = 3, cap = 4_000_000): DiffHunk[] {
  const a = splitLines(before)
  const b = splitLines(after)
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  // Edit script over the whole file: ' ' keeps, '-' removes, '+' adds (old index i, new index j).
  const ops: DiffLine[] = []
  for (let i = 0; i < pre; i++) ops.push({ t: ' ', s: a[i] })
  const n = am.length
  const m = bm.length
  if (n && m && (n + 1) * (m + 1) <= cap) {
    const w = m + 1
    const L = new Uint32Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) L[i * w + j] = am[i] === bm[j] ? L[(i + 1) * w + j + 1] + 1 : Math.max(L[(i + 1) * w + j], L[i * w + j + 1])
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) (ops.push({ t: ' ', s: am[i] }), i++, j++)
      else if (L[(i + 1) * w + j] >= L[i * w + j + 1]) ops.push({ t: '-', s: am[i++] })
      else ops.push({ t: '+', s: bm[j++] })
    }
    while (i < n) ops.push({ t: '-', s: am[i++] })
    while (j < m) ops.push({ t: '+', s: bm[j++] })
  } else {
    for (const s of am) ops.push({ t: '-', s })
    for (const s of bm) ops.push({ t: '+', s })
  }
  for (let i = a.length - suf; i < a.length; i++) ops.push({ t: ' ', s: a[i] })

  // Group changes into hunks.
  const hunks: DiffHunk[] = []
  let oi = 0
  let ni = 0
  const pos: { o: number; n: number }[] = ops.map((op) => {
    const p = { o: oi, n: ni }
    if (op.t !== '+') oi++
    if (op.t !== '-') ni++
    return p
  })
  let k = 0
  let prevStop = 0
  while (k < ops.length) {
    if (ops[k].t === ' ') {
      k++
      continue
    }
    const start = Math.max(prevStop, k - context)
    let end = k
    // Merge with the next change when at most 2*context unchanged lines separate them.
    for (;;) {
      while (end < ops.length && ops[end].t !== ' ') end++
      let g = end
      while (g < ops.length && ops[g].t === ' ') g++
      if (g < ops.length && g - end <= 2 * context) end = g
      else break
    }
    const stop = Math.min(ops.length, end + context)
    const lines = ops.slice(start, stop)
    const p = pos[start]
    hunks.push({
      id: hunks.length + 1,
      oldStart: p.o,
      oldLines: lines.filter((l) => l.t !== '+').length,
      newStart: p.n,
      newLines: lines.filter((l) => l.t !== '-').length,
      lines
    })
    k = stop
    prevStop = stop
  }
  return hunks
}

// Applies the accepted hunks to `before`; rejected hunks keep the old lines.
export function applyHunks(before: string, hunks: DiffHunk[], accepted: Iterable<number>): string {
  const ok = new Set(accepted)
  const a = splitLines(before)
  const out: string[] = []
  let cursor = 0
  for (const h of [...hunks].sort((x, y) => x.oldStart - y.oldStart)) {
    for (; cursor < h.oldStart; cursor++) out.push(a[cursor])
    for (const l of h.lines) {
      if (ok.has(h.id) ? l.t !== '-' : l.t !== '+') out.push(l.s)
    }
    cursor = h.oldStart + h.oldLines
  }
  for (; cursor < a.length; cursor++) out.push(a[cursor])
  return out.join('\n')
}

export function diffCard(path: string, tool: string, before: string | null, after: string, maxHunkLines = 1500): DiffCardData {
  const hunks = diffLines(before ?? '', after)
  let added = 0
  let removed = 0
  for (const h of hunks) for (const l of h.lines) l.t === '+' ? added++ : l.t === '-' ? removed++ : 0
  const total = hunks.reduce((n, h) => n + h.lines.length, 0)
  const card: DiffCardData = { path, tool, hunks, added, removed, state: 'pending' }
  if (before === null) card.created = true
  if (total > maxHunkLines) {
    card.whole = true
    card.hunks = hunks.map((h) => ({ ...h, lines: h.lines.slice(0, 40) }))
  }
  return card
}

// ---------------------------------------------------------------- todos (/todos)

export type TodoState = 'pending' | 'in_progress' | 'done'

export interface ChatTodo {
  text: string
  state: TodoState
}

// ---------------------------------------------------------------- checkpoints (/rewind)

export interface CheckpointInfo {
  id: string
  at: number
  // The user message this checkpoint was taken before.
  messageId: string
  label: string
  // Snapshot commit in the shadow repo (.forge/checkpoints).
  commit: string
}

export type RewindWhat = 'both' | 'files' | 'chat'
