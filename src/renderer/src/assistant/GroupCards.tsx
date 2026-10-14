// Group chat v2 cards and panels: the Conclusion card (converging consult), the patch proposal card
// (a guest's unified diff: Apply / Ask host to merge / Dismiss), the compact cross-check review
// card, the Settings link on "model not set up" notices, the Board panel and the consult settings.
import { useEffect, useMemo, useState } from 'react'
import type { BoardItem, BoardKind, ChatMessage, ChatSession, GroupSettings, ModelChoice } from '@shared/types'
import { modelLabel } from '@shared/modelResolve'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { InlineMarkdown, Markdown } from '../components/Markdown'
import { ProviderMark } from '../components/ModelPicker'
import { errorText } from '../lib/format'
import { accentOf, useActiveChat } from './GroupChat'
import './groupcards.css'

function fmtTokens(n: number): string {
  if (n < 1000) return String(n)
  return n < 100_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`
}

export function fmtUsd(n: number | undefined): string {
  if (n === undefined) return ''
  if (n === 0) return '$0'
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`
}

const ENDED: Record<string, string> = { agreed: 'agreed', cap: 'hit the turn cap', budget: 'hit the cost cap', stopped: 'stopped', error: 'ended early' }

async function run(label: string, fn: () => Promise<unknown>, toast: (t: { text: string; detail?: string; kind?: 'err' }) => void) {
  try {
    await fn()
  } catch (e) {
    toast({ text: label, detail: errorText(e), kind: 'err' })
  }
}

// ---------------------------------------------------------------- conclusion

export function ConclusionCard({ m }: { m: ChatMessage }) {
  const { state, actions } = useStore()
  const chat = useActiveChat()
  const c = m.conclusion
  if (!c) return null
  const busy = chat ? !!state.busy[chat.id] : false
  const [host, guest] = c.participants
  const accent = (p?: { provider: ModelChoice['provider']; model: string }) => (p ? accentOf(chat, p) : 0)
  return (
    <div className={`gc-card gx-conclusion gc-b${accent(host)}`}>
      <div className="gc-card-head">
        <span className="gc-card-kind">
          <Icon name="flag" size={13} /> Conclusion
        </span>
        <span className={`gx-badge conf-${c.confidence}`} title={c.confidenceWhy}>
          {c.confidence} confidence
        </span>
      </div>
      <div className="gx-sub">
        <span className={`gc-t${accent(host)}`}>{host?.label}</span>
        <span className="gx-arrow">↔</span>
        <span className={`gc-t${accent(guest)}`}>{guest?.label}</span>
        <span className="gx-dot">·</span>
        <span>
          {ENDED[c.ended] ?? c.ended} after {c.turns} of {c.maxTurns} exchange{c.maxTurns === 1 ? '' : 's'}
        </span>
      </div>
      {c.question && (
        <div className="gx-question">
          <span className="gx-k">Question</span>
          <span className="md">
            <InlineMarkdown text={c.question.length > 220 ? c.question.slice(0, 219) + '…' : c.question} />
          </span>
        </div>
      )}
      <div className="gc-card-body gx-answer">
        <Markdown text={c.answer} />
      </div>
      <div className="gx-cols">
        <section>
          <div className="gx-k">Agreed</div>
          {c.agreed.length ? (
            <ul className="gx-points ok">
              {c.agreed.map((p, i) => (
                <li key={i}>
                  <span className="md">
                    <InlineMarkdown text={p.text} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="gx-none">nothing explicit</div>
          )}
        </section>
        <section>
          <div className="gx-k">Disagreed</div>
          {c.disagreed.length ? (
            <ul className="gx-points warn">
              {c.disagreed.map((p, i) => (
                <li key={i}>
                  <span className="md">
                    <InlineMarkdown text={p.text} />
                  </span>
                  {p.by?.length ? (
                    <span className="gx-by">
                      {p.by.map((b) => {
                        const who = c.participants.find((x) => x.label === b)
                        return (
                          <span key={b} className={`gx-who gc-t${accent(who)}`}>
                            {b}
                          </span>
                        )
                      })}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : (
            <div className="gx-none">none: they agree</div>
          )}
        </section>
      </div>
      <div className="gx-checks">
        <div className="gx-k">What each model checked</div>
        {c.checks.map((k) => {
          const who = c.participants.find((x) => x.label === k.label)
          return (
            <div key={k.label} className="gx-check-row">
              <span className={`gx-check-who gc-t${accent(who)}`}>
                {who && <ProviderMark id={who.provider} size={13} />} {k.label}
              </span>
              <span className="gx-check-list">
                {k.checked.length ? k.checked.map((x, i) => <code key={i}>{x}</code>) : <span className="gx-none">reasoned from the context only</span>}
              </span>
            </div>
          )
        })}
      </div>
      <div className="gc-card-actions">
        <button type="button" className="btn" onClick={() => void actions.copy(m.text, 'the conclusion')}>
          <Icon name="copy" size={12} /> Copy
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={() => void actions.send('Go ahead with the conclusion above.')}>
          <Icon name="play" size={12} /> Go ahead
        </button>
        <span className="grow" />
        <span className="gx-meta">
          {fmtTokens(c.tokens)} tokens{c.costUsd !== undefined ? ` · ${fmtUsd(c.costUsd)}` : ''}
        </span>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- patch proposal

function DiffBody({ diff }: { diff: string }) {
  const lines = useMemo(() => diff.replace(/\n$/, '').split('\n'), [diff])
  return (
    <pre className="gx-diff" aria-label="Proposed diff">
      {lines.map((l, i) => {
        const cls = l.startsWith('+++') || l.startsWith('---') ? 'f' : l.startsWith('@@') ? 'h' : l[0] === '+' ? 'a' : l[0] === '-' ? 'd' : ''
        return (
          <span key={i} className={cls}>
            {l || ' '}
            {'\n'}
          </span>
        )
      })}
    </pre>
  )
}

const PATCH_STATE: Record<string, string> = { proposed: 'proposed', applied: 'applied', merging: 'host merging', failed: 'did not apply', dismissed: 'dismissed' }

export function PatchCard({ m }: { m: ChatMessage }) {
  const { state, actions } = useStore()
  const chat = useActiveChat()
  const p = m.patch
  const [open, setOpen] = useState(p?.state === 'proposed' && (p?.diff.split('\n').length ?? 0) <= 40)
  if (!p || !chat) return null
  const busy = !!state.busy[chat.id]
  const live = p.state === 'proposed' || p.state === 'failed'
  const a = accentOf(chat, p.by)
  return (
    <div className={`gc-card gx-patch gc-b${a} st-${p.state}`}>
      <div className="gc-card-head">
        <span className="gc-card-kind">
          <Icon name="diff" size={13} /> Patch proposal
        </span>
        <span className="gc-card-by">
          by <b className={`gc-t${a}`}>{p.by.label}</b> · <span className={`gx-state st-${p.state}`}>{PATCH_STATE[p.state] ?? p.state}</span>
        </span>
      </div>
      <button type="button" className="gx-files" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name={open ? 'chevDown' : 'chev'} size={11} />
        <span className="gx-file-list">
          {p.files.map((f) => (
            <span key={f.path} className="gx-file">
              <code>{f.path}</code>
              {f.created && <span className="gx-tag">new</span>}
              <span className="gx-add">+{f.added}</span>
              <span className="gx-del">−{f.removed}</span>
            </span>
          ))}
        </span>
      </button>
      {open && <DiffBody diff={p.diff} />}
      {p.detail && <div className={`gx-detail st-${p.state}`}>{p.detail}</div>}
      {live && (
        <div className="gc-card-actions">
          <button type="button" className="btn primary" disabled={busy} title="The host writes the patch as proposed (all files or none)" onClick={() => void run('Could not apply the patch', () => window.harness.applyPatchProposal(chat.id, m.id), actions.toast)}>
            <Icon name="check" size={12} /> Apply
          </button>
          <button type="button" className="btn" disabled={busy} title="The host checks the patch against the current files, adapts it and writes it" onClick={() => void run('Could not hand the patch to the host', () => window.harness.mergePatchProposal(chat.id, m.id), actions.toast)}>
            <Icon name="bot" size={12} /> Ask host to merge
          </button>
          <span className="grow" />
          <button type="button" className="btn ghost" disabled={busy} onClick={() => void run('Could not dismiss', () => window.harness.dismissPatchProposal(chat.id, m.id), actions.toast)}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------- cross-check review

const REVIEW_STATE: Record<string, string> = { reviewed: '', pending: 'host is fixing the blocking findings', addressed: 'host addressed the blocking findings', skipped: 'no answer' }

export function ReviewCard({ m }: { m: ChatMessage }) {
  const chat = useActiveChat()
  const r = m.review
  const [open, setOpen] = useState(r?.verdict === 'changes')
  if (!r) return null
  const a = accentOf(chat, r.reviewer)
  const blocking = r.findings.filter((f) => f.severity === 'blocking').length
  return (
    <div className={`gc-card gx-review v-${r.verdict}`}>
      <button type="button" className="gx-review-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="eye" size={13} />
        <span className="gc-card-kind">Cross-check</span>
        <span className={`gc-t${a} gx-reviewer`}>{r.reviewer.label}</span>
        <span className="gx-faint">
          {r.files.length} file{r.files.length === 1 ? '' : 's'}
        </span>
        <span className="grow" />
        <span className={`gx-badge ${r.verdict === 'approve' ? 'conf-high' : 'conf-low'}`}>{r.verdict === 'approve' ? 'approved' : `${blocking} blocking`}</span>
        <Icon name={open ? 'chevDown' : 'chev'} size={11} />
      </button>
      {open && (
        <div className="gx-review-body">
          {r.findings.length ? (
            <ul className="gx-findings">
              {r.findings.map((f, i) => (
                <li key={i} className={f.severity}>
                  <span className={`gx-sev ${f.severity}`}>{f.severity === 'blocking' ? 'blocking' : 'note'}</span>
                  {f.file && (
                    <code className="gx-loc">
                      {f.file}
                      {f.line ? `:${f.line}` : ''}
                    </code>
                  )}
                  <span className="md">
                    <InlineMarkdown text={f.text} />
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <div className="gx-none">No findings.</div>
          )}
          <div className="gx-faint gx-files-line">{r.files.join(' · ')}</div>
        </div>
      )}
      {REVIEW_STATE[r.state] && <div className={`gx-detail rs-${r.state}`}>{REVIEW_STATE[r.state]}</div>}
    </div>
  )
}

// ---------------------------------------------------------------- consult stance

const STANCE_LINE = /\n?\s*\**\s*stance\s*\**\s*[:=-]\s*\**\s*(agree|agreed|partial|partly|partially|disagree|disagreed)\b[^\n]*\s*$/i

// A consult reply's trailing "STANCE: x" line, split off for a pill.
export function splitStance(text: string): { text: string; stance: 'agree' | 'partial' | 'disagree' | null } {
  const m = STANCE_LINE.exec(text)
  if (!m) return { text, stance: null }
  const w = m[1].toLowerCase()
  return { text: text.slice(0, m.index).trimEnd(), stance: w.startsWith('dis') ? 'disagree' : w.startsWith('part') ? 'partial' : 'agree' }
}

export function StancePill({ stance }: { stance: 'agree' | 'partial' | 'disagree' }) {
  const cls = stance === 'agree' ? 'conf-high' : stance === 'partial' ? 'conf-medium' : 'conf-low'
  return <span className={`gx-badge gx-stance ${cls}`}>{stance === 'agree' ? 'agrees' : stance === 'partial' ? 'partly agrees' : 'disagrees'}</span>
}

// ---------------------------------------------------------------- "not set up" notice

export function SettingsNotice({ m }: { m: ChatMessage }) {
  const { actions } = useStore()
  return (
    <div className="m-system selectable gx-notice">
      <span>{m.text}</span>
      <button type="button" className="link-btn" onClick={() => actions.openSettings(m.settingsLink)}>
        Open Settings → Providers
      </button>
    </div>
  )
}

// ---------------------------------------------------------------- board

const KIND_LABEL: Record<BoardKind, string> = { decision: 'Decisions', question: 'Open questions', conclusion: 'Conclusions' }
const KINDS: BoardKind[] = ['decision', 'question', 'conclusion']

function newId() {
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function BoardRow({ item, onChange, onRemove }: { item: BoardItem; onChange: (b: BoardItem) => void; onRemove: () => void }) {
  const [edit, setEdit] = useState(false)
  const [text, setText] = useState(item.text)
  useEffect(() => setText(item.text), [item.text])
  const commit = () => {
    setEdit(false)
    const t = text.trim()
    if (t && t !== item.text) onChange({ ...item, text: t, edited: true })
    else setText(item.text)
  }
  return (
    <li className={`gx-brow${item.done ? ' done' : ''}`}>
      {item.kind === 'question' ? (
        <input type="checkbox" checked={!!item.done} aria-label="Resolved" onChange={(e) => onChange({ ...item, done: e.target.checked })} />
      ) : (
        <span className={`gx-bmark ${item.kind}`} aria-hidden />
      )}
      {edit ? (
        <textarea
          className="input gx-bedit"
          rows={2}
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault()
              commit()
            }
            if (e.key === 'Escape') {
              setText(item.text)
              setEdit(false)
            }
          }}
        />
      ) : (
        <button type="button" className="gx-btext" title={item.source ? `from a ${item.source.card} card · click to edit` : 'click to edit'} onClick={() => setEdit(true)}>
          <InlineMarkdown text={item.text} />
          {item.source && !item.edited && <span className="gx-auto">auto</span>}
        </button>
      )}
      <button type="button" className="icon-btn gx-bx" aria-label="Remove" onClick={onRemove}>
        <Icon name="x" size={11} />
      </button>
    </li>
  )
}

export function BoardPanel({ chat }: { chat: ChatSession }) {
  const { actions } = useStore()
  const [items, setItems] = useState<BoardItem[]>(chat.board ?? [])
  const [adding, setAdding] = useState<BoardKind>('decision')
  const [draft, setDraft] = useState('')
  useEffect(() => setItems(chat.board ?? []), [chat.board])
  const save = (next: BoardItem[]) => {
    setItems(next)
    void run('Could not save the board', () => window.harness.saveBoard(chat.id, next), actions.toast)
  }
  const add = () => {
    const t = draft.trim()
    if (!t) return
    save([...items, { id: newId(), kind: adding, text: t, at: Date.now(), edited: true }])
    setDraft('')
  }
  const open = items.filter((b) => b.kind === 'question' && !b.done).length
  return (
    <section className="gp-box gx-board" aria-label="Board">
      <div className="gp-sec-label">
        <Icon name="board" size={12} /> Board <span className="grow" />
        <span className="faint">{items.length ? `${items.length} item${items.length === 1 ? '' : 's'}${open ? ` · ${open} open` : ''}` : ''}</span>
      </div>
      {items.length ? (
        KINDS.map((k) => {
          const list = items.filter((b) => b.kind === k)
          if (!list.length) return null
          return (
            <div key={k} className="gx-bsec">
              <div className="gx-k">{KIND_LABEL[k]}</div>
              <ul className="gx-blist">
                {list.map((b) => (
                  <BoardRow key={b.id} item={b} onChange={(nb) => save(items.map((x) => (x.id === b.id ? nb : x)))} onRemove={() => save(items.filter((x) => x.id !== b.id))} />
                ))}
              </ul>
            </div>
          )
        })
      ) : (
        <div className="note">Conclusions and plans fill the board. Guests read it instead of the long history.</div>
      )}
      <div className="gx-badd">
        <select className="input gx-bkind" value={adding} onChange={(e) => setAdding(e.target.value as BoardKind)} aria-label="Kind">
          <option value="decision">decision</option>
          <option value="question">question</option>
          <option value="conclusion">conclusion</option>
        </select>
        <input
          className="input grow"
          placeholder="Add to the board"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') add()
          }}
        />
      </div>
    </section>
  )
}

// ---------------------------------------------------------------- consult settings

export function ConsultSettings({ chat }: { chat: ChatSession }) {
  const { state, actions } = useStore()
  const [s, setS] = useState<GroupSettings | null>(null)
  useEffect(() => {
    void window.harness.getGroupSettings().then(setS, () => setS(null))
  }, [])
  const patch = (next: Partial<GroupSettings>) => {
    if (s) setS({ ...s, ...next })
    void window.harness.setGroupSettings(next).then(setS, (e) => actions.toast({ text: 'Could not save', detail: errorText(e), kind: 'err' }))
  }
  const reviewers = useMemo(() => {
    const out: ModelChoice[] = []
    for (const p of state.providers ?? []) {
      if (!p.ready || p.id === chat.provider) continue
      for (const model of p.models) out.push({ provider: p.id, model })
    }
    return out
  }, [state.providers, chat.provider])
  if (!s) return null
  return (
    <section className="gp-box gx-settings" aria-label="Consult settings">
      <div className="gp-sec-label">
        <Icon name="gear" size={12} /> Consults
      </div>
      <div className="note gx-hint">“ask sol … and report back”, “check with gemini”, “second opinion from opus”</div>
      <div className="gp-line">
        <span className="gp-k grow">Exchanges before concluding</span>
        <div className="seg" role="radiogroup" aria-label="Exchanges">
          {[1, 2, 3, 4, 5].map((n) => (
            <button key={n} type="button" role="radio" aria-checked={s.consultTurns === n} className={s.consultTurns === n ? 'on' : ''} onClick={() => patch({ consultTurns: n })}>
              {n}
            </button>
          ))}
        </div>
      </div>
      <div className="gp-line">
        <span className="gp-k grow">Cap per consult</span>
        <input
          className="input gx-num"
          type="number"
          min={5}
          step={10}
          aria-label="Token cap (thousands)"
          value={Math.round(s.consultMaxTokens / 1000)}
          onChange={(e) => patch({ consultMaxTokens: Math.max(5, Number(e.target.value) || 5) * 1000 })}
        />
        <span className="gp-k">k tok</span>
        <input className="input gx-num" type="number" min={0} step={0.25} aria-label="Cost cap (USD)" value={s.consultMaxUsd} onChange={(e) => patch({ consultMaxUsd: Math.max(0, Number(e.target.value) || 0) })} />
        <span className="gp-k">$</span>
      </div>
      <label className="gp-line gp-toggle">
        <span className="gp-k grow">Cross-check multi-file edits</span>
        <input type="checkbox" className="switch" checked={s.crossCheck} onChange={(e) => patch({ crossCheck: e.target.checked })} aria-label="Cross-check multi-file edits" />
      </label>
      {s.crossCheck && (
        <div className="gp-line">
          <span className="gp-k">with</span>
          <select className="input grow" value={s.crossCheckModel} onChange={(e) => patch({ crossCheckModel: e.target.value })} aria-label="Reviewer model">
            <option value="">auto (a guest from another provider)</option>
            {reviewers.map((r) => (
              <option key={`${r.provider}/${r.model}`} value={`${r.provider}/${r.model}`}>
                {modelLabel(r.model)} · {r.provider}
              </option>
            ))}
          </select>
        </div>
      )}
      {s.crossCheck && !reviewers.length && (
        <div className="note gx-warn">
          No model from another provider is set up.{' '}
          <button type="button" className="link-btn" onClick={() => actions.openSettings()}>
            Settings → Providers
          </button>
        </div>
      )}
    </section>
  )
}
