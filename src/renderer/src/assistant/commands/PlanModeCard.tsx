// Plan-mode plan card (ChatMessage.planMode): summary, steps, files, risks, and the three answers:
// "Approve & run" (switches the chat to the chosen edit mode and runs the plan), "Edit plan"
// (edit the markdown, then approve), "Keep planning" (close the card, stay in Plan mode).
import { useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { modeLabel, type RunMode } from '@shared/chatModes'
import { useStore } from '../../store'
import { Markdown } from '../../components/Markdown'
import { errorText } from '../../lib/format'
import './modes.css'

const STATE = { pending: 'waiting for you', approved: 'approved', kept: 'kept planning', superseded: 'replaced' } as const

function code(s: string) {
  // `path` - note -> path + note
  const m = /^`([^`]+)`\s*(?:[-–—:]\s*)?(.*)$/.exec(s)
  return m ? { path: m[1], note: m[2] } : { path: '', note: s }
}

function inline(s: string) {
  return s.split(/(`[^`]+`)/g).map((p, i) => (p.startsWith('`') && p.endsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : <span key={i}>{p}</span>))
}

export function PlanModeCard({ m }: { m: ChatMessage }) {
  const { state, actions } = useStore()
  const p = m.planMode!
  const sessionId = m.sessionId ?? state.activeChatId
  const busy = sessionId ? !!state.busy[sessionId] : false
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(p.text)
  const [runMode, setRunMode] = useState<RunMode>('edit')
  const [sending, setSending] = useState(false)
  const live = p.state === 'pending'

  const act = async (action: 'approve' | 'keep' | 'edit', text?: string) => {
    if (!sessionId) return
    setSending(true)
    try {
      await window.harness.planCardAction(sessionId, m.id, action, { runMode, ...(text !== undefined ? { text } : {}) })
      if (action === 'edit' || action === 'approve') setEditing(false)
      if (action === 'keep') actions.insertIntoComposer('')
    } catch (e) {
      actions.toast({ text: 'Could not update the plan', detail: errorText(e), kind: 'err' })
    } finally {
      setSending(false)
    }
  }

  const structured = p.steps.length > 0
  const badge = p.state === 'approved' && p.runMode ? `approved · ${modeLabel(p.runMode).toLowerCase()}` : STATE[p.state]
  return (
    <div className={`cm-card cm-plan${p.state === 'approved' ? ' done' : p.state === 'pending' ? '' : ' off'}`} role="group" aria-label="Plan">
      <div className="cm-head">
        <span className="cm-kind">
          <span className="cm-sigil" aria-hidden>
            ◇
          </span>{' '}
          plan
        </span>
        <span className="cm-sub">{p.edited ? 'edited by you' : `${p.steps.length} step${p.steps.length === 1 ? '' : 's'} · ${p.files.length} file${p.files.length === 1 ? '' : 's'}`}</span>
        <span className={`cm-state ${p.state === 'pending' ? 'pending' : p.state === 'approved' ? 'ok' : ''}`}>{badge}</span>
      </div>
      {editing ? (
        <div className="cm-plan-edit">
          <textarea
            className="input"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label="Edit the plan"
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                e.preventDefault()
                void act('approve', draft)
              }
            }}
          />
        </div>
      ) : structured ? (
        <div className="cm-plan-body selectable">
          {p.summary && (
            <>
              <div className="cm-label">Goal</div>
              <p className="cm-text">{inline(p.summary)}</p>
            </>
          )}
          <div className="cm-label">Steps</div>
          <ol className="cm-steps">
            {p.steps.map((s, i) => (
              <li key={i}>{inline(s)}</li>
            ))}
          </ol>
          {p.files.length > 0 && (
            <>
              <div className="cm-label">Files</div>
              <div className="cm-files">
                {p.files.map((f, i) => {
                  const c = code(f)
                  return (
                    <span key={i} className="cm-file" title={f}>
                      {c.path || c.note}
                    </span>
                  )
                })}
              </div>
            </>
          )}
          {p.risks.length > 0 && (
            <>
              <div className="cm-label">Risks</div>
              <ul className="cm-list cm-risks">
                {p.risks.map((r, i) => (
                  <li key={i}>
                    <span>{inline(r)}</span>
                  </li>
                ))}
              </ul>
            </>
          )}
        </div>
      ) : (
        <div className="cm-plan-md">
          <Markdown text={p.text} />
        </div>
      )}
      {live && (
        <div className="cm-actions">
          {editing ? (
            <>
              <button type="button" className="btn primary" disabled={busy || sending || !draft.trim()} onClick={() => void act('approve', draft)}>
                Approve &amp; run
              </button>
              <button type="button" className="btn" disabled={sending || !draft.trim()} onClick={() => void act('edit', draft)}>
                Save edit
              </button>
              <button type="button" className="btn ghost" onClick={() => (setEditing(false), setDraft(p.text))}>
                Cancel
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={busy || sending} onClick={() => void act('approve')} title={`Switch this chat to ${modeLabel(runMode)} and run the plan`}>
                Approve &amp; run
              </button>
              <span className="cm-runmode" role="radiogroup" aria-label="Run the plan in">
                {(['edit', 'auto'] as const).map((r) => (
                  <button key={r} type="button" role="radio" aria-checked={runMode === r} className={runMode === r ? 'on' : ''} onClick={() => setRunMode(r)} title={modeLabel(r)}>
                    {r === 'edit' ? 'with approval' : 'auto-accept'}
                  </button>
                ))}
              </span>
              <span className="grow" />
              <button type="button" className="btn" disabled={sending} onClick={() => (setDraft(p.text), setEditing(true))}>
                Edit plan
              </button>
              <button type="button" className="btn ghost" disabled={sending} onClick={() => void act('keep')}>
                Keep planning
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}
