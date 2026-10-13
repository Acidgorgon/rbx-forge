// Reflection proposals for one chat: after a chat goes quiet, the cheap model may propose memories
// or skills (memory setting "ask"). Each shows as a small card to save, edit-then-save or dismiss.
// Renders nothing when there are none. Mounted under the chat's message list.
import { useEffect, useState } from 'react'
import type { MemoryInput, MemoryProposal, MemoryScope } from '@shared/types'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import './memory.css'

function ProposalCard({ p, onDone }: { p: MemoryProposal; onDone: () => void }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState<MemoryInput>(p.input)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const skill = (p.input.kind ?? 'memory') === 'skill'

  const save = async (edited?: MemoryInput) => {
    setBusy(true)
    setErr(null)
    try {
      await window.harness.memoryAcceptProposal(p.id, edited)
      onDone()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="mem-prop" role="group" aria-label={`Proposed ${skill ? 'skill' : 'memory'} ${p.input.name}`}>
      <div className="mem-prop-head">
        <Icon name="memory" size={13} />
        <span className="mem-prop-title">{skill ? 'Save this skill?' : 'Remember this?'}</span>
        <span className={`tag ${p.input.scope === 'project' ? 'info' : ''}`}>{p.input.scope}</span>
        <span className="tag">{skill ? 'skill' : p.input.type ?? 'memory'}</span>
      </div>
      {!editing ? (
        <>
          <div className="mem-prop-name mono">{p.input.name}</div>
          <div className="mem-prop-desc">{p.input.description}</div>
          {p.reason && <div className="note mem-prop-why">{p.reason}</div>}
        </>
      ) : (
        <div className="mem-prop-edit">
          <div className="seg" role="radiogroup" aria-label="Scope">
            {(['user', 'project'] as MemoryScope[]).map((s) => (
              <button key={s} role="radio" aria-checked={draft.scope === s} className={draft.scope === s ? 'on' : ''} onClick={() => setDraft({ ...draft, scope: s })}>
                {s === 'user' ? 'Me (all projects)' : 'This project (team)'}
              </button>
            ))}
          </div>
          <input className="input mono" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label="Name" />
          <input className="input" value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label="One-line description" />
          <textarea className="input mono" rows={5} value={draft.body} onChange={(e) => setDraft({ ...draft, body: e.target.value })} aria-label="Body" />
        </div>
      )}
      {err && <div className="callout err">{err}</div>}
      <div className="mem-prop-actions">
        {editing ? (
          <>
            <button className="mini-btn hot" disabled={busy} onClick={() => void save(draft)}><Icon name="check" size={12} /> Save</button>
            <button className="mini-btn" disabled={busy} onClick={() => (setEditing(false), setDraft(p.input))}>Cancel</button>
          </>
        ) : (
          <>
            <button className="mini-btn hot" disabled={busy} onClick={() => void save()}><Icon name="check" size={12} /> Save</button>
            <button className="mini-btn" disabled={busy} onClick={() => setEditing(true)}><Icon name="pencil" size={12} /> Edit</button>
          </>
        )}
        <span className="grow" />
        <button className="mini-btn" disabled={busy} onClick={() => void window.harness.memoryDismissProposal(p.id).then(onDone)} aria-label="Dismiss">Dismiss</button>
      </div>
    </div>
  )
}

export function MemoryProposals({ sessionId }: { sessionId: string | null }) {
  const [list, setList] = useState<MemoryProposal[]>([])
  useEffect(() => {
    setList([])
    const h = window.harness
    if (!sessionId || typeof h?.memoryProposals !== 'function') return
    let live = true
    void h.memoryProposals(sessionId).then((ps) => live && setList(ps)).catch(() => undefined)
    const off = h.on('memory:proposals', (e) => {
      if (e.sessionId === sessionId) setList(e.proposals)
    })
    return () => {
      live = false
      off()
    }
  }, [sessionId])
  if (!sessionId || !list.length) return null
  const refresh = () => void window.harness.memoryProposals(sessionId).then(setList).catch(() => undefined)
  return (
    <div className="mem-props" aria-live="polite">
      {list.map((p) => (
        <ProposalCard key={p.id} p={p} onDone={refresh} />
      ))}
    </div>
  )
}
