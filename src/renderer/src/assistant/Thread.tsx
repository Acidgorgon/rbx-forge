// The chat thread, shared by the Assistant panel and the Group chats page: messages in a readable
// font, tool activity folded into one expandable line per run of calls, the agent's task list as a
// checklist card updated in place, decisions (pending edits) kept prominent, and a live
// "Running … 12s" line while a turn works. Long threads render their newest items first.
import { memo, useEffect, useMemo, useState } from 'react'
// Readable chat font (Settings > Appearance > Chat font switches back to monospace).
import '@fontsource/source-sans-3/latin-400.css'
import '@fontsource/source-sans-3/latin-400-italic.css'
import '@fontsource/source-sans-3/latin-600.css'
import type { ChatMessage, ChatSession } from '@shared/types'
import type { ChatTodo } from '@shared/chatModes'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { ChecklistCard, isGroup, PlanCard, SpeakerHead } from './GroupChat'
import { MessageImages } from './ChatImages'
import { RestateMessage } from './RestateMessage'
import { ConclusionCard, PatchCard, ReviewCard, SettingsNotice, splitStance, StancePill } from './GroupCards'
import { ModeBadge } from './commands/ModePill'
import { PlanModeCard } from './commands/PlanModeCard'
import { DiffCard } from './commands/DiffCard'
import { CommandOutput } from './commands/slash'
import { activityRows, activitySummary, buildItems, callCount, elapsed, runningLabel, toolFailed, type ActivityRow, type ChatItem } from './chatItems'
import { compactLabel } from '@shared/autoCompact'

// ---------------------------------------------------------------- time

// Re-renders every second while `on`.
export function useTick(on: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

// When the running turn started: the newest user message (survives a reload mid-turn).
export function turnStart(messages: ChatMessage[]): number | null {
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'user' && messages[i].agentId === 'main') return messages[i].at
  return null
}

// ---------------------------------------------------------------- messages

export function AgentTag({ id }: { id: string }) {
  const { state, actions } = useStore()
  const agent = state.agents.find((a) => a.id === id)
  return (
    <button className="agent-tag" title={agent?.scenario} onClick={() => actions.openTranscript(id, agent ? `Agent: ${agent.scenario.slice(0, 24)}` : 'Agent')}>
      <Icon name="bot" size={12} /> agent {agent ? `· ${agent.state}` : ''}
    </button>
  )
}

export const Message = memo(function Message({ m, chat }: { m: ChatMessage; chat?: ChatSession }) {
  if (m.role === 'user') {
    return (
      <div className="m-user">
        {m.mode && <ModeBadge mode={m.mode} />}
        <div className="m-bubble">
          {m.text && <div className="m-text selectable">{m.text}</div>}
          {m.images?.length ? <MessageImages images={m.images} size="sm" /> : null}
        </div>
      </div>
    )
  }
  if (m.compact) return <CompactDivider m={m} />
  if (m.command) return <CommandOutput m={m} />
  if (m.role === 'system') return m.settingsLink ? <SettingsNotice m={m} /> : <div className="m-system selectable">{m.text}</div>
  if (m.planMode) return <PlanModeCard m={m} />
  if (m.diff) return <DiffCard m={m} />
  if (m.card === 'plan') return <PlanCard m={m} />
  if (m.card === 'checklist') return <ChecklistCard m={m} />
  if (m.card === 'restate' && m.restate) return <RestateMessage m={m} />
  if (m.card === 'conclusion' && m.conclusion) return <ConclusionCard m={m} />
  if (m.card === 'patch' && m.patch) return <PatchCard m={m} />
  if (m.card === 'review' && m.review) return <ReviewCard m={m} />
  const fromAgent = m.agentId && m.agentId !== 'main'
  const group = isGroup(chat)
  const host = !!chat && !!m.speaker && m.speaker.provider === chat.provider && m.speaker.model === chat.model
  const st = m.speaker && group ? splitStance(m.text) : { text: m.text, stance: null }
  return (
    <div className="m-assistant selectable">
      {fromAgent && <AgentTag id={m.agentId} />}
      {m.speaker && group && <SpeakerHead s={m.speaker} host={host} chat={chat} />}
      {st.text && <Markdown text={st.text} />}
      {st.stance && <StancePill stance={st.stance} />}
      {m.images?.length ? <MessageImages images={m.images} attachable /> : null}
    </div>
  )
})

// A compaction (auto or /compact): one divider line; the summary folds out under it.
function CompactDivider({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const c = m.compact!
  const label = `${compactLabel(c.before, c.after)} · ${c.trigger === 'manual' ? m.command ?? '/compact' : 'auto'}`
  return (
    <div className={`m-compact${open ? ' open' : ''}`} data-testid="compact-divider">
      <button type="button" className="mc-line" onClick={() => c.summary && setOpen(!open)} aria-expanded={c.summary ? open : undefined} disabled={!c.summary} title={c.summary ? 'Show the summary the chat continues from' : undefined}>
        <span className="mc-rule" aria-hidden />
        {c.summary && <Icon name={open ? 'chevDown' : 'chev'} size={10} />}
        <span className="mc-label">{label}</span>
        <span className="mc-rule" aria-hidden />
      </button>
      {open && c.summary && (
        <div className="mc-summary selectable">
          <Markdown text={c.summary} />
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- activity

function RowIcon({ row, running }: { row: ActivityRow; running: boolean }) {
  if (running) return <span className="spinner ta-spin" />
  const d = row.diff?.diff
  if (d && (d.state === 'rejected' || d.state === 'expired')) return <Icon name="x" size={12} className="tool-bad" />
  if (row.tool && toolFailed(row.tool)) return <Icon name="x" size={12} className="tool-bad" />
  return <Icon name="check" size={12} className="tool-ok" />
}

function ActivityLine({ row, running }: { row: ActivityRow; running: boolean }) {
  const [open, setOpen] = useState(false)
  const d = row.diff?.diff
  const name = row.tool?.tool?.name ?? d?.tool ?? 'tool'
  const input = d?.path || row.tool?.tool?.input || d?.action || ''
  const body = row.tool?.text.trim() ?? ''
  const canOpen = !!row.diff || !!body
  return (
    <div className={`ta-row${open ? ' open' : ''}`}>
      <button className="ta-row-head" onClick={() => canOpen && setOpen(!open)} title={`${name} ${row.tool?.tool?.input ?? d?.action ?? ''}`} aria-expanded={canOpen ? open : undefined}>
        <RowIcon row={row} running={running} />
        <span className="tool-name">{name}</span>
        <span className="tool-input">{input}</span>
        {d?.path ? (
          <span className="ta-delta">
            <span className="cm-add">+{d.added}</span> <span className="cm-del">−{d.removed}</span>
          </span>
        ) : d && d.state !== 'accepted' ? (
          <span className={`ta-state ${d.state}`}>{d.state}</span>
        ) : null}
      </button>
      {open && (row.diff ? <div className="ta-diff"><DiffCard m={row.diff} expanded /></div> : <pre className="tool-body selectable">{body}</pre>)}
    </div>
  )
}

// One line for a run of tool calls ("Edited 2 files, read 3 files · 7 tool calls"); click to list them.
export const Activity = memo(function Activity({ entries, live }: { entries: ChatMessage[]; live: boolean }) {
  const [open, setOpen] = useState(false)
  const rows = useMemo(() => activityRows(entries), [entries])
  const summary = useMemo(() => activitySummary(entries), [entries])
  const calls = callCount(entries)
  const last = rows[rows.length - 1]
  const lastIsCall = !!last?.tool && !last.diff
  const label = summary || `${calls} tool call${calls === 1 ? '' : 's'}`
  return (
    <div className={`ta${open ? ' open' : ''}${live ? ' live' : ''}`}>
      {entries[0].agentId !== 'main' && <AgentTag id={entries[0].agentId} />}
      <button className="ta-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevDown' : 'chev'} size={11} className="ta-caret" />
        <span className="ta-label">{label}</span>
        {summary && <span className="ta-count">· {calls} tool call{calls === 1 ? '' : 's'}</span>}
      </button>
      {open && (
        <div className="ta-rows">
          {rows.map((r, i) => (
            <ActivityLine key={r.key} row={r} running={live && lastIsCall && i === rows.length - 1} />
          ))}
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------- task list

export function TodoCard({ todos }: { todos: ChatTodo[] }) {
  const done = todos.filter((t) => t.state === 'done').length
  return (
    <div className="todo-card" role="list" aria-label={`Tasks: ${done} of ${todos.length} done`}>
      {todos.map((t, i) => (
        <div key={i} role="listitem" className={`todo ${t.state}`}>
          <span className="todo-mark" aria-hidden>
            {t.state === 'done' ? <Icon name="check" size={9} strokeWidth={3} /> : null}
          </span>
          <span className="todo-text">{t.text}</span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------- live line

function WorkingLine({ messages, label }: { messages: ChatMessage[]; label?: string }) {
  const now = useTick(true)
  const start = turnStart(messages)
  const last = messages[messages.length - 1]
  const waiting = messages.some((m) => m.diff?.state === 'pending' || m.planMode?.state === 'pending')
  const text = label ?? (waiting ? 'Waiting for your decision' : runningLabel(last))
  return (
    <div className="working" aria-label="Working" role="status">
      <span className="working-dots" aria-hidden>
        <span /><span /><span />
      </span>
      <span className="working-text">{text}</span>
      {start && <span className="working-time">{elapsed(now - start)}</span>}
    </div>
  )
}

// ---------------------------------------------------------------- list

// Items rendered at first in a long thread; older ones come back with "Show earlier".
const WINDOW = 160

export function MessageList({ chat, messages, busy, thinking }: { chat?: ChatSession; messages: ChatMessage[]; busy: boolean; thinking: boolean }) {
  const todos = chat?.todos
  const items = useMemo(() => buildItems(messages, !!todos?.length), [messages, !!todos?.length])
  const [shown, setShown] = useState(WINDOW)
  const id = chat?.id
  useEffect(() => setShown(WINDOW), [id])
  const from = Math.max(0, items.length - shown)
  const visible = from ? items.slice(from) : items
  const lastIdx = items.length - 1
  const render = (it: ChatItem, i: number) => {
    if (it.kind === 'msg') return <Message key={it.m.id} m={it.m} chat={chat} />
    if (it.kind === 'todos') return todos?.length ? <TodoCard key={it.id} todos={todos} /> : null
    return <Activity key={it.id} entries={it.entries} live={busy && from + i === lastIdx} />
  }
  return (
    <>
      {from > 0 && (
        <button className="as-earlier" onClick={() => setShown((n) => n + WINDOW)}>
          Show {Math.min(from, WINDOW)} earlier
        </button>
      )}
      {visible.map(render)}
      {busy && (thinking || items[lastIdx]?.kind !== 'msg') && <WorkingLine messages={messages} />}
    </>
  )
}
