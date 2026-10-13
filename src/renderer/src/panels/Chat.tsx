import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import type { ChatMessage } from '@shared/types'
import { useStore } from '../store'
import { Markdown } from '../components/Markdown'
import { IconArrowUp, IconChevron, IconKey, IconRobot, IconStop, IconTool } from '../components/Icons'

const SUGGESTIONS = [
  { title: 'Sync with my collaborators', sub: 'Pull, merge and check Studio edits' },
  { title: 'Add a feature called Inventory', sub: 'Shared folder, service and controller' },
  { title: 'Explain how my services start', sub: 'Walk through ModuleLoader' },
  { title: 'Run test agents on the shop flow', sub: 'Play-test purchases end to end' }
]

function greeting(): string {
  const h = new Date().getHours()
  if (h < 5) return 'Up late'
  if (h < 12) return 'Good morning'
  if (h < 18) return 'Good afternoon'
  return 'Good evening'
}

type Item = { kind: 'msg'; m: ChatMessage } | { kind: 'tools'; ms: ChatMessage[]; id: string }

function group(messages: ChatMessage[]): Item[] {
  const out: Item[] = []
  for (const m of messages) {
    if (m.role === 'tool') {
      const last = out[out.length - 1]
      if (last && last.kind === 'tools' && last.ms[0].agentId === m.agentId) last.ms.push(m)
      else out.push({ kind: 'tools', ms: [m], id: m.id })
    } else out.push({ kind: 'msg', m })
  }
  return out
}

export function ToolChip({ m }: { m: ChatMessage }) {
  const [open, setOpen] = useState(false)
  const hasBody = !!m.text.trim()
  return (
    <div className={`tool-chip${open ? ' open' : ''}`}>
      <button className="tool-chip-head" onClick={() => hasBody && setOpen(!open)} disabled={!hasBody} title={m.tool ? `${m.tool.name} ${m.tool.input}` : undefined}>
        <IconTool size={13} />
        <span className="tool-name">{m.tool?.name ?? 'tool'}</span>
        {m.tool?.input && <span className="tool-input">{m.tool.input}</span>}
        {hasBody && <IconChevron size={12} className="tool-caret" />}
      </button>
      {open && <pre className="tool-body">{m.text}</pre>}
    </div>
  )
}

function AgentTag({ id }: { id: string }) {
  const { state } = useStore()
  const agent = state.agents.find((a) => a.id === id)
  const n = state.agents.findIndex((a) => a.id === id)
  return (
    <span className="agent-tag" title={agent?.scenario}>
      <IconRobot size={12} />
      Agent {n >= 0 ? state.agents.length - n : ''}
      {agent && <span className={`state-dot s-${agent.state}`} />}
    </span>
  )
}

function Message({ m }: { m: ChatMessage }) {
  if (m.role === 'user') {
    return (
      <div className="msg user">
        <div className="bubble">{m.text}</div>
      </div>
    )
  }
  if (m.role === 'system') {
    return <div className="msg system">{m.text}</div>
  }
  const fromAgent = m.agentId && m.agentId !== 'main'
  return (
    <div className={`msg assistant${fromAgent ? ' from-agent' : ''}`}>
      {fromAgent && <AgentTag id={m.agentId} />}
      <Markdown text={m.text} />
    </div>
  )
}

function ApiKeyCard() {
  const { actions } = useStore()
  const [key, setKey] = useState('')
  const [saving, setSaving] = useState(false)
  return (
    <div className="key-card">
      <div className="key-card-icon"><IconKey size={18} /></div>
      <div className="key-card-main">
        <div className="key-card-title">Connect your Anthropic API key</div>
        <div className="key-card-sub">The harness talks to Claude with your own key. It is stored locally on this machine.</div>
        <form
          className="key-form"
          onSubmit={async (e) => {
            e.preventDefault()
            if (!key.trim()) return
            setSaving(true)
            try {
              await window.harness.setApiKey(key.trim())
              actions.set({ hasApiKey: await window.harness.hasApiKey() })
              actions.toast('API key saved')
            } finally {
              setSaving(false)
            }
          }}
        >
          <input type="password" placeholder="sk-ant-…" value={key} onChange={(e) => setKey(e.target.value)} spellCheck={false} autoComplete="off" />
          <button className="btn primary" disabled={!key.trim() || saving}>{saving ? 'Saving…' : 'Save key'}</button>
        </form>
      </div>
    </div>
  )
}

// Insert requests already applied (survives the composer remounting).
let handledInsert = 0

function Composer({ busy, onSend, onStop, big }: { busy: boolean; onSend: (t: string) => void; onStop: () => void; big?: boolean }) {
  const { state } = useStore()
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = Math.min(el.scrollHeight, 260) + 'px'
  }, [text])

  useEffect(() => {
    const ins = state.composerInsert
    if (!ins || ins.nonce === handledInsert) return
    handledInsert = ins.nonce
    setText((t) => (t && !/\s$/.test(t) ? t + ' ' : t) + ins.text + ' ')
    requestAnimationFrame(() => {
      const el = ref.current
      if (!el) return
      el.focus()
      el.selectionStart = el.selectionEnd = el.value.length
    })
  }, [state.composerInsert])

  useEffect(() => {
    ref.current?.focus()
  }, [state.activeChatId])

  const submit = () => {
    const t = text.trim()
    if (!t || busy) return
    onSend(t)
    setText('')
  }

  const onKey = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div className={`composer${big ? ' big' : ''}`}>
      <div className="composer-box" onClick={() => ref.current?.focus()}>
        <textarea
          ref={ref}
          rows={1}
          value={text}
          placeholder={busy ? 'Claude is working…' : 'Ask about your game, or tell Claude what to build'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
        />
        <div className="composer-row">
          <span className="composer-context">
            {state.project ? <>Working in <b>{state.project.name}</b></> : 'No project open'}
          </span>
          {busy ? (
            <button className="send-btn stop" onClick={onStop} title="Stop">
              <IconStop size={14} />
            </button>
          ) : (
            <button className="send-btn" onClick={submit} disabled={!text.trim()} title="Send (Enter)">
              <IconArrowUp size={16} />
            </button>
          )}
        </div>
      </div>
      {!big && (
        <div className="composer-hint">
          <span><kbd>Enter</kbd> to send</span>
          <span><kbd>Shift</kbd>+<kbd>Enter</kbd> new line</span>
          <span className="hint-sep">Claude can edit files and run tools in this project.</span>
        </div>
      )}
    </div>
  )
}

export function Chat() {
  const { state, actions } = useStore()
  const id = state.activeChatId
  const messages = useMemo(() => (id ? state.messages[id] ?? [] : []), [id, state.messages])
  const busy = id ? !!state.busy[id] : false
  const items = useMemo(() => group(messages), [messages])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  useLayoutEffect(() => {
    const el = scroller.current
    if (el && stick.current) el.scrollTop = el.scrollHeight
  }, [items, busy])

  const send = (t: string) => {
    stick.current = true
    void actions.send(t)
  }

  const last = messages[messages.length - 1]
  const thinking = busy && (!last || last.role !== 'assistant' || last.agentId !== 'main')
  const title = state.chats.find((c) => c.id === id)?.title

  if (messages.length === 0) {
    return (
      <div className="chat empty">
        <div className="empty-wrap">
          <div className="hello">
            <span className="hello-mark" aria-hidden>
              <svg width="30" height="30" viewBox="0 0 24 24">
                <path d="M12 2.5l2.2 6.3 6.6.2-5.3 4 1.9 6.4L12 15.6l-5.4 3.8 1.9-6.4-5.3-4 6.6-.2z" fill="currentColor" />
              </svg>
            </span>
            <h1>{greeting()}</h1>
          </div>
          <p className="hello-sub">What should we build in {state.project?.name ?? 'your game'} today?</p>
          {state.hasApiKey === false && <ApiKeyCard />}
          <Composer busy={busy} onSend={send} onStop={() => void actions.stop()} big />
          <div className="suggestions">
            {SUGGESTIONS.map((s) => (
              <button key={s.title} className="suggestion" onClick={() => send(s.title)}>
                <span className="suggestion-title">{s.title}</span>
                <span className="suggestion-sub">{s.sub}</span>
              </button>
            ))}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="chat">
      <div className="chat-header">
        <span className="chat-header-title">{title ?? 'Chat'}</span>
      </div>
      <div
        className="chat-scroll"
        ref={scroller}
        onScroll={(e) => {
          const el = e.currentTarget
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
        }}
      >
        <div className="thread">
          {state.hasApiKey === false && <ApiKeyCard />}
          {items.map((it) =>
            it.kind === 'msg' ? (
              <Message key={it.m.id} m={it.m} />
            ) : (
              <div key={it.id} className="tool-row">
                {it.ms[0].agentId !== 'main' && <AgentTag id={it.ms[0].agentId} />}
                {it.ms.map((m) => (
                  <ToolChip key={m.id} m={m} />
                ))}
              </div>
            )
          )}
          {thinking && (
            <div className="thinking" aria-label="Claude is thinking">
              <span /><span /><span />
            </div>
          )}
        </div>
      </div>
      <div className="chat-bottom">
        <Composer busy={busy} onSend={send} onStop={() => void actions.stop()} />
      </div>
    </div>
  )
}
