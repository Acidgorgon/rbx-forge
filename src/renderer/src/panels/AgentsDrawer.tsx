import { useEffect, useState } from 'react'
import type { TestAgent } from '@shared/types'
import { useStore } from '../store'
import { Drawer } from '../components/Drawer'
import { Markdown } from '../components/Markdown'
import { IconChevron, IconPlay, IconRobot } from '../components/Icons'
import { ToolChip } from './Chat'

const label: Record<TestAgent['state'], string> = {
  queued: 'Queued',
  running: 'Running',
  passed: 'Passed',
  failed: 'Failed',
  error: 'Error',
  cancelled: 'Cancelled'
}

function duration(a: TestAgent): string {
  if (!a.startedAt) return ''
  const s = Math.round(((a.finishedAt ?? Date.now()) - a.startedAt) / 1000)
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`
}

function AgentCard({ a, index }: { a: TestAgent; index: number }) {
  const { state, actions } = useStore()
  const [open, setOpen] = useState(false)
  const messages = state.agentMessages[a.id] ?? []
  const live = a.state === 'running' || a.state === 'queued'
  return (
    <div className={`agent-card s-${a.state}`}>
      <button
        className="agent-head"
        onClick={() => {
          if (!open) void actions.loadAgentTranscript(a.id)
          setOpen(!open)
        }}
      >
        <span className={`twisty${open ? ' open' : ''}`}><IconChevron size={12} /></span>
        <span className="agent-num">#{index}</span>
        <span className="agent-scenario">{a.scenario}</span>
        <span className={`badge s-${a.state}`}>
          {live && <span className="spinner" />}
          {label[a.state]}
        </span>
      </button>
      {(a.summary || live) && (
        <div className="agent-summary">
          {a.summary ?? (a.state === 'queued' ? 'Waiting for a free Studio session…' : 'Playing the scenario…')}
          {duration(a) && <span className="agent-time">{duration(a)}</span>}
        </div>
      )}
      {open && (
        <div className="agent-log">
          {messages.length === 0 && <div className="muted small">No messages yet.</div>}
          {messages.map((m) =>
            m.role === 'tool' ? (
              <ToolChip key={m.id} m={m} />
            ) : m.role === 'system' ? (
              <div key={m.id} className="agent-sys">{m.text}</div>
            ) : (
              <div key={m.id} className="agent-msg"><Markdown text={m.text} /></div>
            )
          )}
        </div>
      )}
      {live && (
        <div className="agent-actions">
          <button className="btn small ghost" onClick={() => void window.harness.cancelAgent(a.id)}>Cancel</button>
        </div>
      )}
    </div>
  )
}

export function AgentsDrawer() {
  const { state, actions } = useStore()
  const [text, setText] = useState('')
  const [starting, setStarting] = useState(false)
  const scenarios = text.split('\n').map((s) => s.trim()).filter(Boolean)
  const running = state.agents.filter((a) => a.state === 'running').length
  const passed = state.agents.filter((a) => a.state === 'passed').length
  const failed = state.agents.filter((a) => a.state === 'failed' || a.state === 'error').length
  // Re-render every second while agents run so their timers tick.
  const [, tick] = useState(0)
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => tick((n) => n + 1), 1000)
    return () => clearInterval(t)
  }, [running])

  return (
    <Drawer
      title="Test agents"
      icon={<IconRobot />}
      subtitle={`${running} running · ${passed} passed · ${failed} failed`}
      width={640}
      onClose={() => actions.set({ drawer: null })}
    >
      <section className="card">
        <h3>New run</h3>
        <p className="muted small">One scenario per line. Each agent plays the game in its own Studio session and reports what it saw.</p>
        <textarea
          className="scenario-input"
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder={'Buy the starter sword with exactly 100 coins\nTry to buy with 0 coins and check the error toast'}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form ?? e.currentTarget.parentElement)?.querySelector<HTMLButtonElement>('.run-btn')?.click()
          }}
        />
        <div className="row-end">
          <span className="muted small">{scenarios.length ? `${scenarios.length} agent${scenarios.length > 1 ? 's' : ''}` : ''}</span>
          <button
            className="btn primary run-btn"
            disabled={!scenarios.length || starting}
            onClick={async () => {
              setStarting(true)
              try {
                await window.harness.runAgents(scenarios)
                setText('')
              } finally {
                setStarting(false)
              }
            }}
          >
            <IconPlay size={12} /> Run
          </button>
        </div>
      </section>

      <section className="section">
        <div className="section-head">
          <h3>Agents</h3>
          <span className="count">{state.agents.length}</span>
        </div>
        {state.agents.length === 0 && <p className="muted small">No agents yet.</p>}
        <div className="agent-list">
          {state.agents.map((a, i) => (
            <AgentCard key={a.id} a={a} index={state.agents.length - i} />
          ))}
        </div>
      </section>
    </Drawer>
  )
}
