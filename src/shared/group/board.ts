// The per-chat Board: decisions, open questions and conclusions. Auto-filled from Conclusion and
// plan cards, editable by the user, persisted with the chat, and handed to guests as a short block
// in their context pack instead of long history. Pure.

import type { BoardItem, BoardKind, ConclusionData } from './types.ts'

export const BOARD_MAX_ITEMS = 60
export const BOARD_TEXT_MAX = 400
const KINDS: BoardKind[] = ['decision', 'question', 'conclusion']

let seq = 0
export function boardId(): string {
  return `b${Date.now().toString(36)}${(seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

const norm = (s: string) => s.toLowerCase().replace(/[*_`]/g, '').replace(/\s+/g, ' ').trim()

// Drops malformed items, clips text, keeps the newest BOARD_MAX_ITEMS.
export function normalizeBoard(raw: unknown): BoardItem[] {
  if (!Array.isArray(raw)) return []
  const out: BoardItem[] = []
  for (const r of raw) {
    if (!r || typeof r !== 'object') continue
    const o = r as Record<string, unknown>
    const kind = KINDS.includes(o.kind as BoardKind) ? (o.kind as BoardKind) : null
    const text = typeof o.text === 'string' ? o.text.trim().slice(0, BOARD_TEXT_MAX) : ''
    if (!kind || !text) continue
    const item: BoardItem = { id: typeof o.id === 'string' && o.id ? o.id.slice(0, 64) : boardId(), kind, text, at: typeof o.at === 'number' ? o.at : Date.now() }
    const src = o.source as Record<string, unknown> | undefined
    if (src && typeof src.messageId === 'string' && (src.card === 'conclusion' || src.card === 'plan')) item.source = { messageId: src.messageId, card: src.card }
    if (o.edited === true) item.edited = true
    if (o.done === true) item.done = true
    out.push(item)
  }
  return out.slice(-BOARD_MAX_ITEMS)
}

// Replaces the auto-filled items of one source message (user-edited ones stay) and adds new ones,
// skipping text already on the board.
export function fillFromSource(board: BoardItem[], source: NonNullable<BoardItem['source']>, items: { kind: BoardKind; text: string }[], at = Date.now()): BoardItem[] {
  const kept = board.filter((b) => b.edited || b.source?.messageId !== source.messageId)
  const seen = new Set(kept.map((b) => `${b.kind}:${norm(b.text)}`))
  const add: BoardItem[] = []
  for (const it of items) {
    const text = it.text.trim().slice(0, BOARD_TEXT_MAX)
    const key = `${it.kind}:${norm(text)}`
    if (!text || seen.has(key)) continue
    seen.add(key)
    add.push({ id: boardId(), kind: it.kind, text, at, source })
  }
  return [...kept, ...add].slice(-BOARD_MAX_ITEMS)
}

function firstSentences(text: string, max = 280): string {
  const t = text.replace(/\s+/g, ' ').trim()
  if (t.length <= max) return t
  const cut = t.slice(0, max)
  const dot = cut.lastIndexOf('. ')
  return (dot > 80 ? cut.slice(0, dot + 1) : cut.trimEnd() + '…').trim()
}

export function boardFromConclusion(board: BoardItem[], messageId: string, c: Pick<ConclusionData, 'answer' | 'agreed' | 'disagreed' | 'question'>, at = Date.now()): BoardItem[] {
  const items: { kind: BoardKind; text: string }[] = [
    { kind: 'conclusion', text: `${firstSentences(c.question, 90)} → ${firstSentences(c.answer)}` },
    ...c.agreed.map((p) => ({ kind: 'decision' as const, text: p.text })),
    ...c.disagreed.map((p) => ({ kind: 'question' as const, text: p.text }))
  ]
  return fillFromSource(board, { messageId, card: 'conclusion' }, items, at)
}

function sectionItems(text: string, heading: RegExp): string[] {
  const sec = text.split(/\n(?=#{1,4}\s)/).find((s) => heading.test(s.trim()))
  if (!sec) return []
  return sec
    .split('\n')
    .slice(1)
    .map((l) => /^\s*(?:[-*+]|\d+[.)])\s+(.+)$/.exec(l)?.[1]?.trim())
    .filter((x): x is string => !!x && !/^none\.?$/i.test(x))
}

// Roundtable plan: Agreements -> decisions, Disagreements -> open questions, Recommendation -> one
// conclusion line.
export function boardFromPlan(board: BoardItem[], messageId: string, plan: string, topic?: string, at = Date.now()): BoardItem[] {
  const rec = sectionItems(plan, /^#{1,4}\s*(final\s+)?recommendation/i)
  const items: { kind: BoardKind; text: string }[] = [
    ...sectionItems(plan, /^#{1,4}\s*agreements?/i).map((text) => ({ kind: 'decision' as const, text })),
    ...sectionItems(plan, /^#{1,4}\s*disagreements?/i).map((text) => ({ kind: 'question' as const, text })),
    ...(rec.length ? [{ kind: 'conclusion' as const, text: `${topic ? `${firstSentences(topic, 90)} → ` : ''}${rec.length} step plan: ${firstSentences(rec[0], 160)}` }] : [])
  ]
  return fillFromSource(board, { messageId, card: 'plan' }, items, at)
}

// The board as a context-pack block (open questions that were ticked off are left out). Empty
// board -> ''.
export function boardPack(board: BoardItem[] | undefined, maxChars = 1800): string {
  if (!board?.length) return ''
  const group = (kind: BoardKind) => board.filter((b) => b.kind === kind && !b.done).map((b) => `- ${b.text.replace(/\s+/g, ' ')}`)
  const parts: string[] = []
  const add = (title: string, lines: string[]) => lines.length && parts.push(`${title}:\n${lines.slice(-12).join('\n')}`)
  add('Decisions', group('decision'))
  add('Open questions', group('question'))
  add('Conclusions', group('conclusion'))
  if (!parts.length) return ''
  const out = `## Board (shared decisions; trust these over older chat)\n${parts.join('\n')}`
  return out.length <= maxChars ? out : out.slice(0, maxChars - 1).trimEnd() + '…'
}
