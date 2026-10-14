// "Restate first" card, shared by the chat (a restate message) and the Labs (before compose):
// Forge's reading of the request (goal, problem, up to 3 assumptions) with "Yes, go" and "Edit".
// Edit turns the fields into inputs; "Send back" confirms the edited reading.
import { forwardRef, useEffect, useLayoutEffect, useRef, useState, type TextareaHTMLAttributes } from 'react'
import type { RestateKind, Restatement } from '@shared/types'
import { restateLabels } from '@shared/restate/prompt'
import { normalizeRestatement } from '@shared/restate/types'
import './restate.css'

export interface RestateCardProps {
  restatement: Restatement
  kind: RestateKind
  state?: 'pending' | 'confirmed' | 'dismissed' | 'loading'
  edited?: boolean
  // Why the card is shown (heuristic reason), shown faint in the head.
  reason?: string
  // A confirm is in flight.
  busy?: boolean
  onConfirm?: (edited?: Restatement) => void
  // Labs: skip the card / close it.
  onCancel?: () => void
}

// A textarea that grows with its text (no inner scrolling while editing a short reading).
const AutoArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function AutoArea(props, outer) {
  const inner = useRef<HTMLTextAreaElement | null>(null)
  useLayoutEffect(() => {
    const el = inner.current
    if (!el) return
    el.style.height = '0px'
    el.style.height = `${Math.min(el.scrollHeight + 2, 240)}px`
  }, [props.value])
  return (
    <textarea
      {...props}
      ref={(el) => {
        inner.current = el
        if (typeof outer === 'function') outer(el)
        else if (outer) outer.current = el
      }}
    />
  )
})

const STATE_LABEL = { pending: 'waiting for you', confirmed: 'confirmed', dismissed: 'skipped', loading: 'reading…' } as const

export function RestateCard({ restatement, kind, state = 'pending', edited, reason, busy, onConfirm, onCancel }: RestateCardProps) {
  const l = restateLabels(kind)
  const [editing, setEditing] = useState(false)
  const [goal, setGoal] = useState(restatement.goal)
  const [problem, setProblem] = useState(restatement.problem)
  const [assumptions, setAssumptions] = useState(restatement.assumptions.join('\n'))
  const first = useRef<HTMLTextAreaElement>(null)
  const live = state === 'pending' && !!onConfirm

  useEffect(() => {
    if (editing) return
    setGoal(restatement.goal)
    setProblem(restatement.problem)
    setAssumptions(restatement.assumptions.join('\n'))
  }, [restatement, editing])
  useEffect(() => {
    if (editing) requestAnimationFrame(() => first.current?.focus())
  }, [editing])

  const draft = normalizeRestatement({ goal, problem, assumptions: assumptions.split('\n') })
  const sendBack = () => {
    if (!draft || busy) return
    setEditing(false)
    onConfirm?.(draft)
  }
  const kindLabel = kind === 'chat' ? 'restate first' : 'restated brief'
  const badge = state === 'confirmed' && edited ? 'confirmed · edited' : STATE_LABEL[state]

  return (
    <div className={`rs-card ${state}${editing ? ' editing' : ''}`} role="group" aria-label={kindLabel}>
      <div className="rs-head">
        <span className="rs-kind">
          <span className="rs-sigil" aria-hidden>
            ◇
          </span>{' '}
          {kindLabel}
        </span>
        {reason && state === 'pending' && <span className="rs-reason ellipsis" title={reason}>{reason}</span>}
        <span className={`rs-state ${state}`}>{badge}</span>
      </div>
      {editing ? (
        <div className="rs-body rs-form">
          <label className="rs-field">
            <span className="rs-label">{l.goal}</span>
            <AutoArea ref={first} className="input rs-input" rows={2} value={goal} onChange={(e) => setGoal(e.target.value)} aria-label={l.goal} />
          </label>
          <label className="rs-field">
            <span className="rs-label">{l.problem}</span>
            <AutoArea className="input rs-input" rows={2} value={problem} onChange={(e) => setProblem(e.target.value)} aria-label={l.problem} />
          </label>
          <label className="rs-field">
            <span className="rs-label">
              {l.assumptions} <span className="faint">· one per line, up to 3</span>
            </span>
            <AutoArea
              className="input rs-input"
              rows={3}
              value={assumptions}
              onChange={(e) => setAssumptions(e.target.value)}
              aria-label={l.assumptions}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault()
                  sendBack()
                }
              }}
            />
          </label>
        </div>
      ) : (
        <dl className="rs-body">
          <dt className="rs-label">{l.goal}</dt>
          <dd className="rs-text selectable">{restatement.goal}</dd>
          {restatement.problem && (
            <>
              <dt className="rs-label">{l.problem}</dt>
              <dd className="rs-text selectable">{restatement.problem}</dd>
            </>
          )}
          {restatement.assumptions.length > 0 && (
            <>
              <dt className="rs-label">{l.assumptions}</dt>
              <dd className="rs-text">
                <ul className="rs-list selectable">
                  {restatement.assumptions.map((a, i) => (
                    <li key={i}>{a}</li>
                  ))}
                </ul>
              </dd>
            </>
          )}
        </dl>
      )}
      {live && (
        <div className="rs-actions">
          {editing ? (
            <>
              <button type="button" className="btn primary" disabled={!draft || busy} onClick={sendBack} title="Confirm your edited reading (⌘↵)">
                {busy ? <span className="spinner" aria-hidden /> : null} Send back
              </button>
              <button type="button" className="btn ghost" onClick={() => setEditing(false)}>
                Cancel edit
              </button>
            </>
          ) : (
            <>
              <button type="button" className="btn primary" disabled={busy} onClick={() => onConfirm?.()}>
                {busy ? <span className="spinner" aria-hidden /> : null} Yes, go
              </button>
              <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
                Edit
              </button>
              {onCancel && (
                <button type="button" className="btn ghost rs-skip" disabled={busy} onClick={onCancel}>
                  Cancel
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}

// Compact line for a Labs entry's info tab: the confirmed reading the critic judges against.
export function RestatedBrief({ r }: { r: Restatement }) {
  return (
    <span className="rs-brief" title={[r.goal, r.problem, ...r.assumptions.map((a) => `- ${a}`)].filter(Boolean).join('\n')}>
      {r.goal}
      {r.problem && <span className="faint"> · {r.problem}</span>}
    </span>
  )
}
