// Transcript tab for a test agent or an orchestrator task (chat id "orch:<run>:<task>").
import { useEffect, useMemo, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { Markdown } from '../components/Markdown'
import { fmtTime, fmtTokens, fmtUsd } from '../lib/format'

export function TranscriptPage({ agentId, title }: { agentId: string; title: string }) {
  const { state, actions } = useStore()
  const orch = /^orch:([^:]+):(.+)$/.exec(agentId)
  const [orchMessages, setOrchMessages] = useState<ChatMessage[] | null>(null)
  useEffect(() => {
    if (orch) {
      const load = () => void window.harness.getTaskTranscript(orch[1], orch[2]).then(setOrchMessages).catch(() => window.harness.getChat(agentId).then(setOrchMessages).catch(() => setOrchMessages([])))
      load()
      const t = setInterval(load, 3000)
      return () => clearInterval(t)
    }
    void actions.loadAgentTranscript(agentId)
  }, [agentId])
  const messages = orch ? orchMessages ?? [] : state.agentMessages[agentId] ?? []
  const agent = state.agents.find((a) => a.id === agentId)
  const task = orch ? state.boards.find((b) => b.runId === orch[1])?.tasks.find((t) => t.id === orch[2]) : undefined
  const meta = useMemo(() => {
    if (agent) return `${agent.state}${agent.model ? ` · ${agent.model}` : ''}${agent.usage ? ` · ${fmtTokens(agent.usage.input + agent.usage.output)} · ${fmtUsd(agent.usage.costUsd)}` : ''}`
    if (task) return `${task.role} · ${task.state} · ${task.model} · ${fmtTokens(task.tokens)} · ${fmtUsd(task.costUsd)}`
    return agentId
  }, [agent, task, agentId])
  return (
    <div className="page">
      <div className="page-inner" style={{ maxWidth: 820 }}>
        <div className="page-head">
          <div style={{ minWidth: 0 }}>
            <h1>{agent?.scenario ?? task?.goal ?? title}</h1>
            <div className="sub">{meta}</div>
          </div>
          <div className="actions">
            {(agent?.state === 'running' || agent?.state === 'queued') && <button className="btn" onClick={() => void window.harness.cancelAgent(agentId)}>Cancel</button>}
            {task && (task.state === 'running' || task.state === 'queued') && orch && <button className="btn" onClick={() => void window.harness.cancelOrchestrationTask(orch[1], orch[2])}>Cancel task</button>}
          </div>
        </div>
        {(agent?.summary || task?.summary) && (
          <div className="card">
            <h3>Report</h3>
            <Markdown text={(agent?.summary ?? task?.summary)!} />
            {task?.filesChanged.length ? (
              <div className="row" style={{ flexWrap: 'wrap', marginTop: 8 }}>
                {task.filesChanged.map((f) => <button key={f} className="badge-o" onClick={() => void actions.openFile(f)}>{f}</button>)}
              </div>
            ) : null}
          </div>
        )}
        <div className="transcript">
          {!messages.length && <div className="note">No messages yet.</div>}
          {messages.map((m) => (
            <div key={m.id} className={`tr-msg ${m.role}`}>
              <span className="tr-time">{fmtTime(m.at)}</span>
              {m.role === 'tool' ? (
                <span className="tr-tool"><Icon name="tool" size={12} /> <b>{m.tool?.name}</b> <span className="faint">{m.tool?.input}</span>{m.text && <pre>{m.text}</pre>}</span>
              ) : m.role === 'user' ? (
                <div className="m-user" style={{ flex: 1 }}><span className="m-who">task</span><div className="m-text">{m.text}</div></div>
              ) : (
                <div className="grow md-wrap"><Markdown text={m.text} /></div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
