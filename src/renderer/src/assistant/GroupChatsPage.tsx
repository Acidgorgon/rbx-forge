// Group chats page: every group chat with its participants and last activity, a "new group chat"
// form that picks the host and guests up front, and a roomy view of one chat: participants rail,
// the conversation, and a roundtable/plan panel (round controls, guest tools, usage per model,
// the latest plan with "Make task list"). Reuses the Assistant's messages and composer and the
// group chat pieces in GroupChat.tsx; the open chat is the store's active chat.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChatMessage, ChatSession, ModelChoice, OrchestrateMode } from '@shared/types'
import { makeParticipant, sameModel } from '@shared/modelResolve'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { ModelPicker, ProviderMark } from '../components/ModelPicker'
import { ago, errorText } from '../lib/format'
import { MemoryProposals } from '../pages/memory/MemoryProposals'
import { Composer } from './AssistantPanel'
import { MessageList } from './Thread'
import { EffortPicker, RouteSummary } from './EffortPicker'
import { accentOf, ChecklistCard, participants } from './GroupChat'
import { BoardPanel, ConsultSettings, fmtUsd } from './GroupCards'
import './groupspage.css'

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

function lastActivity(chat: ChatSession, messages: ChatMessage[] | undefined): number {
  const last = messages?.[messages.length - 1]?.at
  return Math.max(chat.createdAt, last ?? 0, chat.lastAt ?? 0)
}

// ---------------------------------------------------------------- list + new

function NewGroupChat({ onCreated, onCancel }: { onCreated: (id: string) => void; onCancel?: () => void }) {
  const { state, actions } = useStore()
  const [host, setHost] = useState<ModelChoice | null>(state.defaultModel)
  const [guests, setGuests] = useState<ModelChoice[]>([])
  const [title, setTitle] = useState('')
  const [creating, setCreating] = useState(false)
  useEffect(() => {
    if (!host && state.defaultModel) setHost(state.defaultModel)
  }, [state.defaultModel])
  const taken = [host, ...guests].filter((x): x is ModelChoice => !!x)
  const people = host ? [makeParticipant(host, 'host'), ...guests.map((g, i) => makeParticipant(g, 'guest', [makeParticipant(host, 'host').alias, ...guests.slice(0, i).map((x) => makeParticipant(x, 'guest').alias)]))] : []

  const create = async () => {
    if (!host || !guests.length) return
    setCreating(true)
    try {
      const chat = await window.harness.newChat(host, { guests, ...(title.trim() ? { title: title.trim() } : {}) })
      actions.set({ chats: [chat, ...state.chats.filter((c) => c.id !== chat.id)] })
      onCreated(chat.id)
    } catch (e) {
      actions.toast({ text: 'Could not create the group chat', detail: errorText(e), kind: 'err' })
    } finally {
      setCreating(false)
    }
  }

  return (
    <section className="set-sec gp-new" aria-label="New group chat">
      <h2>
        New group chat <span className="grow" />
        {onCancel && (
          <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel">
            <Icon name="x" size={13} />
          </button>
        )}
      </h2>
      <div className="gp-new-grid">
        <label className="gp-lbl">Host</label>
        <div className="gp-new-ctl">
          <ModelPicker variant="field" direction="down" value={host} providers={state.providers} onChange={(c) => setHost(c)} onAddKey={(p) => actions.openSettings(p)} />
          <span className="note">Owns the project and is the only one that edits files.</span>
        </div>
        <label className="gp-lbl">Guests</label>
        <div className="gp-new-ctl">
          <div className="gp-guests">
            {people.slice(1).map((p, i) => (
              <span key={`${p.provider}/${p.model}`} className="gp-chip">
                <ProviderMark id={p.provider} size={14} />
                <span>{p.label}</span>
                <span className="faint">@{p.alias}</span>
                <button type="button" aria-label={`Remove ${p.label}`} onClick={() => setGuests(guests.filter((_, j) => j !== i))}>
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
            <ModelPicker
              value={null}
              providers={state.providers}
              direction="down"
              placeholder={guests.length ? 'Add' : 'Add a guest'}
              icon={<Icon name="plus" size={12} />}
              onChange={(c) => {
                if (taken.some((t) => sameModel(t, c))) return
                setGuests([...guests, c])
              }}
              onAddKey={(p) => actions.openSettings(p)}
            />
          </div>
          <span className="note">Read-only advisers. @mention them, or start a roundtable.</span>
        </div>
        <label className="gp-lbl" htmlFor="gp-title">Title</label>
        <div className="gp-new-ctl">
          <input id="gp-title" className="input" placeholder="optional, e.g. Shop exploit plan" value={title} onChange={(e) => setTitle(e.target.value)} />
        </div>
      </div>
      <div className="gp-new-actions">
        <span className="note grow">{guests.length ? `${guests.length + 1} participants` : 'Add at least one guest.'}</span>
        <button type="button" className="btn primary" onClick={() => void create()} disabled={!host || !guests.length || creating}>
          {creating ? 'Creating…' : 'Create group chat'}
        </button>
      </div>
    </section>
  )
}

function GroupList({ onOpen }: { onOpen: (id: string) => void }) {
  const { state } = useStore()
  const groups = useMemo(
    () =>
      state.chats
        .filter((c) => c.guests?.length)
        .map((c) => ({ c, at: lastActivity(c, state.messages[c.id]) }))
        .sort((a, b) => b.at - a.at),
    [state.chats, state.messages]
  )
  const [creating, setCreating] = useState(false)
  const showForm = creating || !groups.length
  return (
    <div className="page gp-list-page">
      <div className="page-inner">
        <div className="page-head">
          <div>
            <h1>Group chats</h1>
            <div className="sub">Several models in one conversation: a host that edits, guests that advise, roundtables that end in a plan.</div>
          </div>
          <div className="actions">
            {!showForm && (
              <button type="button" className="btn primary" onClick={() => setCreating(true)}>
                <Icon name="plus" size={12} /> New group chat
              </button>
            )}
          </div>
        </div>
        {showForm && <NewGroupChat onCreated={onOpen} onCancel={groups.length ? () => setCreating(false) : undefined} />}
        {groups.length > 0 && (
          <div className="gp-table" role="list">
            {groups.map(({ c, at }) => {
              const people = participants(c)
              const tokens = (c.usage ?? []).reduce((n, u) => n + u.input + u.output, 0)
              const busy = !!state.busy[c.id]
              return (
                <button key={c.id} type="button" role="listitem" className={`gp-row${c.id === state.activeChatId ? ' on' : ''}`} onClick={() => onOpen(c.id)}>
                  <span className="gp-row-title">
                    {busy ? <span className="lav-dot pulse" /> : <Icon name="round" size={13} />}
                    <span className="ellipsis">{c.title}</span>
                  </span>
                  <span className="gp-row-people">
                    {people.map((p) => (
                      <span key={`${p.provider}/${p.model}`} className={`gp-person${p.role === 'host' ? ' host' : ''}`} title={`${p.label} · ${p.provider}/${p.model}${p.role === 'host' ? ' · host' : ''}`}>
                        <span className={`gc-dot gc-a${accentOf(c, p)}`} />
                        {p.label}
                      </span>
                    ))}
                  </span>
                  <span className="gp-row-meta">
                    {tokens > 0 && <span>{fmtTokens(tokens)} tok</span>}
                    <span>{ago(at)}</span>
                  </span>
                </button>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- open chat

function ParticipantsRail({ chat, onBack }: { chat: ChatSession; onBack: () => void }) {
  const { state, actions } = useStore()
  const busy = !!state.busy[chat.id]
  const people = participants(chat)
  const usage = chat.usage ?? []
  return (
    <aside className="gp-rail" aria-label="Participants">
      <button type="button" className="gp-back" onClick={onBack}>
        <Icon name="chev" size={11} style={{ transform: 'rotate(180deg)' }} /> All group chats
      </button>
      <div className="gp-sec-label">Participants · {people.length}</div>
      <div className="gp-people">
        {people.map((p) => {
          const u = usage.find((x) => x.provider === p.provider && x.model === p.model)
          return (
            <div key={`${p.provider}/${p.model}`} className={`gp-pcard gc-a${accentOf(chat, p)}`}>
              <span className="gp-pmark">
                <ProviderMark id={p.provider} size={18} />
              </span>
              <span className="gp-pinfo">
                <span className="gp-pname">
                  <span className={`gc-t${accentOf(chat, p)}`}>{p.label}</span>
                  {p.role === 'host' && <span className="gc-role">host</span>}
                </span>
                <span className="gp-psub">@{p.alias} · {p.role === 'host' ? 'edits files' : 'read-only'}</span>
                {u && <span className="gp-psub">{fmtTokens(u.input)} in · {fmtTokens(u.output)} out</span>}
              </span>
              {p.role === 'guest' && (
                <button type="button" className="icon-btn gp-premove" aria-label={`Remove ${p.label}`} title="Remove from the chat" disabled={busy} onClick={() => void actions.removeGuest(p.alias)}>
                  <Icon name="x" size={12} />
                </button>
              )}
            </div>
          )
        })}
      </div>
      <ModelPicker value={null} providers={state.providers} direction="down" placeholder="Add a model" icon={<Icon name="plus" size={12} />} disabled={busy} onChange={(c) => void actions.addGuest(c)} onAddKey={(p) => actions.openSettings(p)} />
      <div className="gp-rail-foot note">
        @alias asks one guest directly. “Ask sol … and report back” runs a consult that ends in a Conclusion card.
      </div>
    </aside>
  )
}

function RoundPanel({ chat }: { chat: ChatSession }) {
  const { state, actions } = useStore()
  const busy = !!state.busy[chat.id]
  const [topic, setTopic] = useState('')
  const [rounds, setRounds] = useState(2)
  const messages = state.messages[chat.id] ?? []
  const plan = [...messages].reverse().find((m) => m.card === 'plan')
  const checklist = plan ? messages.slice(messages.indexOf(plan)).find((m) => m.card === 'checklist') : undefined
  const usage = chat.usage ?? []
  const max = Math.max(1, ...usage.map((u) => u.input + u.output))
  const total = usage.reduce((n, u) => n + u.input + u.output, 0)
  const cost = usage.reduce((n, u) => n + (u.costUsd ?? 0), 0)
  const start = () => {
    if (!topic.trim() || busy) return
    void actions.startRoundtable(topic.trim(), rounds)
    setTopic('')
  }
  return (
    <aside className="gp-side" aria-label="Roundtable and plan">
      <section className="gp-box">
        <div className="gp-sec-label">Roundtable</div>
        <textarea
          className="input gp-topic"
          rows={3}
          placeholder="Topic, e.g. How should we save player data?"
          value={topic}
          disabled={busy}
          onChange={(e) => setTopic(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) start()
          }}
        />
        <div className="gp-line">
          <span className="gp-k">Rounds</span>
          <div className="seg" role="radiogroup" aria-label="Rounds">
            {[1, 2, 3, 4].map((n) => (
              <button key={n} type="button" role="radio" aria-checked={rounds === n} className={rounds === n ? 'on' : ''} onClick={() => setRounds(n)}>
                {n}
              </button>
            ))}
          </div>
        </div>
        <div className="gp-line">
          {busy ? (
            <button type="button" className="btn grow" onClick={() => void actions.stop()}>
              <Icon name="stop" size={11} /> Stop
            </button>
          ) : (
            <button type="button" className="btn primary grow" onClick={start} disabled={!topic.trim()}>
              <Icon name="round" size={12} /> Start roundtable
            </button>
          )}
        </div>
        <label className="gp-line gp-toggle">
          <span className="gp-k grow">Guests can read project files</span>
          <input type="checkbox" className="switch" checked={chat.guestTools !== false} onChange={(e) => void actions.setGuestTools(e.target.checked)} aria-label="Guests can read project files" />
        </label>
      </section>

      <BoardPanel chat={chat} />
      <ConsultSettings chat={chat} />

      <section className="gp-box">
        <div className="gp-sec-label">
          Usage <span className="grow" />
          {total > 0 && <span className="faint">{fmtTokens(total)} tokens{cost > 0 ? ` · ${fmtUsd(cost)}` : ''}</span>}
        </div>
        {usage.length ? (
          <div className="gp-usage">
            {usage.map((u) => (
              <div key={`${u.provider}/${u.model}`} className="gp-urow" title={`${u.label}: ${u.input} in · ${u.output} out · ${u.calls} call${u.calls === 1 ? '' : 's'}${u.costUsd !== undefined ? ` · ${fmtUsd(u.costUsd)}` : ' · no price known'}`}>
                <span className="gp-uname ellipsis">
                  <span className={`gc-dot gc-a${accentOf(chat, u)}`} /> {u.label}
                </span>
                <span className="gp-ubar">
                  <span className={`gc-a${accentOf(chat, u)}`} style={{ width: `${Math.round(((u.input + u.output) / max) * 100)}%` }} />
                </span>
                <span className="gp-unum">{u.costUsd ? fmtUsd(u.costUsd) : fmtTokens(u.input + u.output)}</span>
              </div>
            ))}
          </div>
        ) : (
          <div className="note">No tokens used yet.</div>
        )}
      </section>

      <section className="gp-box gp-plan">
        <div className="gp-sec-label">
          Plan <span className="grow" />
          {plan?.speaker && <span className="faint">by {plan.speaker.label}</span>}
        </div>
        {plan ? (
          <>
            <div className="gp-plan-body">
              <Markdown text={plan.text} />
            </div>
            <div className="gp-line">
              <button type="button" className="btn" onClick={() => void actions.copy(plan.text, 'the plan')}>
                <Icon name="copy" size={11} /> Copy
              </button>
              <button type="button" className="btn primary grow" onClick={() => void actions.planToChecklist(plan.id)} disabled={busy}>
                <Icon name="check" size={11} /> Make task list
              </button>
            </div>
            {checklist && <ChecklistCard m={checklist} />}
          </>
        ) : (
          <div className="note">A roundtable ends with the host's plan: agreements, disagreements and the steps to take.</div>
        )}
      </section>
    </aside>
  )
}

function Conversation({ chat }: { chat: ChatSession }) {
  const { state } = useStore()
  const messages = state.messages[chat.id] ?? []
  const busy = !!state.busy[chat.id]
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const [mode, setMode] = useState<OrchestrateMode>('single')
  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [messages, busy, chat.todos])
  const last = messages[messages.length - 1]
  const thinking = busy && (!last || last.role !== 'assistant')
  const choice = { provider: chat.provider, model: chat.model }
  return (
    <section className="gp-conv" aria-label="Conversation">
      <div className="gp-conv-head">
        <span className="gp-conv-title ellipsis">{chat.title}</span>
        <EffortPicker chat={chat} choice={choice} />
        <RouteSummary chat={chat} />
      </div>
      <div
        className="gp-scroll as-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="gp-thread">
          {!messages.length && <div className="as-empty">@ to ask a guest · enter to send · start a roundtable on the right</div>}
          <MessageList chat={chat} messages={messages} busy={busy} thinking={thinking} />
          <MemoryProposals sessionId={chat.id} />
        </div>
      </div>
      <div className="gp-composer">
        <Composer mode={mode} setMode={setMode} />
      </div>
    </section>
  )
}

export function GroupChatsPage() {
  const { state, actions } = useStore()
  const active = state.chats.find((c) => c.id === state.activeChatId)
  const [openId, setOpenId] = useState<string | null>(active?.guests?.length ? active.id : null)
  const open = openId ? state.chats.find((c) => c.id === openId) : undefined

  // Follow the Assistant: switching it to another group chat opens that one here.
  useEffect(() => {
    if (!openId) return
    if (state.activeChatId !== openId) setOpenId(active?.guests?.length ? active.id : null)
  }, [state.activeChatId])

  // Opening a room makes space: the side, bottom and Assistant panels close (the Assistant would
  // show the same chat). Reopen them from the toolbar as usual.
  const openChat = (id: string) => {
    setOpenId(id)
    if (state.activeChatId !== id) void actions.selectChat(id)
    actions.setLayout({ sideOpen: false, bottomOpen: false })
    actions.toggleRight(false)
  }

  if (!open) return <GroupList onOpen={openChat} />
  return (
    <div className="gp-wrap">
      <div className="gp-room">
        <ParticipantsRail chat={open} onBack={() => setOpenId(null)} />
        <Conversation chat={open} />
        <RoundPanel chat={open} />
      </div>
    </div>
  )
}
