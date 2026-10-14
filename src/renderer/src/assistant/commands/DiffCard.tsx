// Edit-with-approval diff card (ChatMessage.diff): the change a write tool wants to make, hunk by
// hunk. Accept all, Reject, or untick hunks and accept the rest (Forge applies only those).
// Non-file actions (add_blink_event, Bash, Studio tools) show the call and Accept / Reject.
import { useEffect, useState } from 'react'
import type { ChatMessage } from '@shared/types'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'
import './modes.css'

const STATE = { pending: 'waiting for you', accepted: 'accepted', rejected: 'rejected', partial: 'partly accepted', expired: 'expired' } as const

// expanded: shown inside an opened activity row, so the hunks show without another click.
export function DiffCard({ m, expanded }: { m: ChatMessage; expanded?: boolean }) {
  const { state, actions } = useStore()
  const d = m.diff!
  const sessionId = m.sessionId ?? state.activeChatId
  const live = d.state === 'pending'
  const [on, setOn] = useState<Set<number>>(() => new Set(d.hunks.map((h) => h.id)))
  const [open, setOpen] = useState(live || !!expanded)
  const [sending, setSending] = useState(false)
  useEffect(() => {
    if (!live && !expanded) setOpen(false)
  }, [live])

  const decide = async (accept: boolean) => {
    if (!sessionId) return
    setSending(true)
    try {
      await window.harness.reviewChatEdit(sessionId, m.id, accept ? { accept, ...(on.size < d.hunks.length ? { hunks: [...on] } : {}) } : { accept })
    } catch (e) {
      actions.toast({ text: 'Could not answer the change', detail: errorText(e), kind: 'err' })
    } finally {
      setSending(false)
    }
  }

  const toggle = (id: number) =>
    setOn((cur) => {
      const next = new Set(cur)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const accepted = d.state === 'partial' ? new Set(d.accepted ?? []) : null
  const ok = d.state === 'accepted' || d.state === 'partial'
  const many = d.hunks.length > 1 && !d.whole
  return (
    <div className={`cm-card cm-edit${ok ? ' done' : live ? '' : ' off'}${open ? '' : ' collapsed'}`} role="group" aria-label={`Change to ${d.path || d.tool}`}>
      <div className="cm-head">
        <span className="cm-kind">
          <span className="cm-sigil" aria-hidden>
            ±
          </span>{' '}
          {d.path ? (d.created ? 'new file' : 'edit') : 'action'}
        </span>
        {d.path ? (
          <span className="cm-diff-path" title={d.path}>
            {d.path.split('/').pop()}
            <span className="cm-diff-dir">{d.path.includes('/') ? ` ${d.path.slice(0, d.path.lastIndexOf('/'))}` : ''}</span>
          </span>
        ) : (
          <span className="cm-sub">{d.tool}</span>
        )}
        {d.path && (
          <>
            <span className="cm-add">+{d.added}</span>
            <span className="cm-del">−{d.removed}</span>
          </>
        )}
        <span className={`cm-state ${live ? 'pending' : ok ? 'ok' : d.state === 'rejected' ? 'bad' : ''}`}>{STATE[d.state]}</span>
      </div>
      {d.path ? (
        <div className="cm-hunks">
          {d.hunks.map((h) => {
            const skip = live ? !on.has(h.id) : accepted ? !accepted.has(h.id) : false
            return (
              <div key={h.id} className={`cm-hunk${skip ? ' skip' : ''}`}>
                <div className="cm-hunk-head">
                  {many && live ? (
                    <label>
                      <input type="checkbox" checked={on.has(h.id)} onChange={() => toggle(h.id)} aria-label={`Hunk ${h.id}`} />
                      hunk {h.id}
                    </label>
                  ) : (
                    <span>hunk {h.id}</span>
                  )}
                  <span>
                    @@ −{h.oldStart + 1},{h.oldLines} +{h.newStart + 1},{h.newLines} @@
                  </span>
                </div>
                <pre className="cm-code selectable">
                  {h.lines.map((l, i) => (
                    <span key={i} className={`cm-ln ${l.t === '+' ? 'add' : l.t === '-' ? 'del' : 'ctx'}`}>
                      {l.s || ' '}
                    </span>
                  ))}
                </pre>
              </div>
            )
          })}
          {d.whole && <div className="cm-action">Large change: only the start of each hunk is shown; accept or reject it as a whole.</div>}
        </div>
      ) : (
        <div className="cm-action">{d.action || d.tool}</div>
      )}
      {(live || d.path) && (
        <div className="cm-actions">
          {live ? (
            <>
              <button type="button" className="btn primary" disabled={sending || (many && on.size === 0)} onClick={() => void decide(true)}>
                {many && on.size < d.hunks.length ? `Accept ${on.size} of ${d.hunks.length}` : 'Accept'}
              </button>
              <button type="button" className="btn" disabled={sending} onClick={() => void decide(false)}>
                Reject
              </button>
              <span className="grow" />
              {many && (
                <button type="button" className="btn ghost small" onClick={() => setOn(on.size === d.hunks.length ? new Set() : new Set(d.hunks.map((h) => h.id)))}>
                  {on.size === d.hunks.length ? 'Untick all' : 'Tick all'}
                </button>
              )}
            </>
          ) : (
            <button type="button" className="btn ghost small cm-toggle" onClick={() => setOpen(!open)}>
              {open ? 'Hide diff' : 'Show diff'}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
