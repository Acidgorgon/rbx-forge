// Pure helpers for the chat thread (no React, no DOM): turns the message list into display items.
// Consecutive tool calls (and edit / action cards that are already decided) fold into one activity
// group with a one-line summary; a card that still waits for a decision stays its own item; the
// agent's task list (update_todos) shows once, as a checklist at its latest update.

import type { ChatMessage } from '../../../shared/types.ts'

export type ChatItem =
  | { kind: 'msg'; m: ChatMessage }
  | { kind: 'activity'; id: string; entries: ChatMessage[] }
  | { kind: 'todos'; id: string }

// One line of an expanded activity group: a tool call, its decided card, or both.
export interface ActivityRow {
  key: string
  tool?: ChatMessage
  diff?: ChatMessage
}

export function isTodoTool(m: ChatMessage): boolean {
  return m.role === 'tool' && /(^|__|:)update_todos$/.test(m.tool?.name ?? '')
}

// A decided card (accepted / rejected / partial / expired) folds into the activity around it.
function settledCard(m: ChatMessage): boolean {
  return !!m.diff && m.diff.state !== 'pending' && !m.command
}

function groupKey(m: ChatMessage): string {
  return `${m.agentId}|${m.speaker?.provider ?? ''}|${m.speaker?.model ?? ''}`
}

// showTodos: the chat has a task list to show (ChatSession.todos).
export function buildItems(messages: ChatMessage[], showTodos = false): ChatItem[] {
  let lastTodo = -1
  if (showTodos) for (let i = messages.length - 1; i >= 0; i--) if (isTodoTool(messages[i]) && messages[i].agentId === 'main') {
    lastTodo = i
    break
  }
  const out: ChatItem[] = []
  messages.forEach((m, i) => {
    if (i === lastTodo) {
      out.push({ kind: 'todos', id: `todos-${m.id}` })
      return
    }
    if (m.role === 'tool' || settledCard(m)) {
      const last = out[out.length - 1]
      if (last?.kind === 'activity' && groupKey(last.entries[0]) === groupKey(m)) last.entries.push(m)
      else out.push({ kind: 'activity', id: m.id, entries: [m] })
      return
    }
    // Empty assistant text (a tool-only step) adds nothing between tool calls.
    if (m.role === 'assistant' && !m.text.trim() && !m.images?.length && !m.card && !m.diff && !m.planMode) return
    out.push({ kind: 'msg', m })
  })
  return out
}

function sameTool(toolName: string, cardTool: string): boolean {
  return toolName === cardTool || toolName.endsWith(`:${cardTool}`) || toolName.endsWith(`__${cardTool}`)
}

// Pairs each card with the tool call that asked for it (the chip comes first, the card after), so an
// expanded group lists every call once.
export function activityRows(entries: ChatMessage[]): ActivityRow[] {
  const rows: ActivityRow[] = []
  for (const m of entries) {
    if (m.diff) {
      const row = rows.find((r) => r.tool && !r.diff && sameTool(r.tool.tool?.name ?? '', m.diff!.tool))
      if (row) row.diff = m
      else rows.push({ key: m.id, diff: m })
    } else rows.push({ key: m.id, tool: m })
  }
  return rows
}

export function toolFailed(m: ChatMessage): boolean {
  return /^(error|failed)\b/i.test(m.text.trim())
}

function bare(name: string): string {
  return name.replace(/^.*(__|:)/, '')
}

function inputPath(input: string | undefined): string | null {
  const m = /(?:^|\s)(?:path|file_path|file)=(\S+)/.exec(input ?? '')
  return m ? m[1] : null
}

const READ = /^(read_script|read_file|Read|NotebookRead|project_overview|project_map|explorer_tree|list_scripts|blink_events|wally_info|inspect_instance)$/
const SEARCH = /^(search_code|find_symbol|find_instance|Grep|Glob|wally_search|WebSearch|WebFetch|search_.*)$/
const WRITE = /^(write_script|edit_script|Edit|Write|MultiEdit|NotebookEdit|create_script|delete_script)$/
const RUN = /^(Bash|run_in_terminal|run_code|execute_luau)$/
const TEST = /^(run_tests|run_test_agents|blink_check|lint|run_lint)$/

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`

// "Edited 2 files, added 2 Blink events, read 3 files". Empty when nothing stands out.
export function activitySummary(entries: ChatMessage[]): string {
  const rows = activityRows(entries)
  const edited = new Set<string>()
  const created = new Set<string>()
  let blink = 0
  let features = 0
  let read = 0
  let search = 0
  let run = 0
  let tests = 0
  let tasks = 0
  let actions = 0
  let rejected = 0
  let failed = 0
  for (const r of rows) {
    const d = r.diff?.diff
    const name = bare(r.tool?.tool?.name ?? d?.tool ?? '')
    if (d && (d.state === 'rejected' || d.state === 'expired')) {
      rejected++
      continue
    }
    if (r.tool && toolFailed(r.tool)) failed++
    if (d?.path) {
      ;(d.created ? created : edited).add(d.path)
      continue
    }
    if (name === 'update_todos') tasks++
    else if (name === 'add_blink_event') blink++
    else if (name === 'new_feature') features++
    else if (WRITE.test(name)) {
      const p = inputPath(r.tool?.tool?.input)
      edited.add(p ?? `#${r.key}`)
    } else if (READ.test(name)) read++
    else if (SEARCH.test(name)) search++
    else if (RUN.test(name)) run++
    else if (TEST.test(name)) tests++
    else actions++
  }
  const parts: string[] = []
  if (created.size) parts.push(`created ${plural(created.size, 'file')}`)
  if (edited.size) parts.push(`edited ${plural(edited.size, 'file')}`)
  if (features) parts.push(`added ${plural(features, 'feature')}`)
  if (blink) parts.push(`added ${plural(blink, 'Blink event')}`)
  if (run) parts.push(`ran ${plural(run, 'command')}`)
  if (tests) parts.push(tests === 1 ? 'ran a check' : `ran ${tests} checks`)
  if (read) parts.push(`read ${plural(read, 'file')}`)
  if (search) parts.push(search === 1 ? 'searched' : `searched ${search} times`)
  if (tasks && !parts.length) parts.push('updated the task list')
  if (actions && !parts.length) parts.push(plural(actions, 'action'))
  if (rejected) parts.push(`${rejected} rejected`)
  if (failed) parts.push(`${failed} failed`)
  const text = parts.slice(0, 4).join(', ')
  return text ? text[0].toUpperCase() + text.slice(1) : ''
}

// Tool calls in a group (a call and its card count once).
export function callCount(entries: ChatMessage[]): number {
  return activityRows(entries).length
}

// "Running read_script" for the live line, from the newest call of the turn.
export function runningLabel(m: ChatMessage | undefined): string {
  if (!m || m.role !== 'tool') return 'Thinking'
  const name = bare(m.tool?.name ?? 'tool')
  if (RUN.test(name)) return 'Running a command'
  if (READ.test(name)) return `Reading${inputPath(m.tool?.input) ? ` ${inputPath(m.tool?.input)!.split('/').pop()}` : ''}`
  if (SEARCH.test(name)) return 'Searching'
  if (WRITE.test(name)) return `Editing${inputPath(m.tool?.input) ? ` ${inputPath(m.tool?.input)!.split('/').pop()}` : ''}`
  return `Running ${name}`
}

// 12s, 2m 1s, 1h 3m.
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}
