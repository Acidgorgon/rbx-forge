// Principle views shared by the VFX Lab, the Animation Lab and the Ability Composer: the compact
// per-principle scorecard in critiques / iterations (score bar, where it came from, the user's
// weight, note and fix on expand, focus marked) and "Your priorities", the weights learned from the
// user's ratings (shared/principles/learn.ts) with a reset.
import { useEffect, useState } from 'react'
import type { PrincipleDomain, PrincipleScore, PrincipleView } from '@shared/types'
import { principle, principleLabel } from '@shared/principles/catalog'
import { Icon } from '../../components/Icons'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'
import './principles.css'

const SRC: Record<PrincipleScore['source'], string> = { code: 'measured', critic: 'critic', both: 'critic+measured' }

export function PrincipleScorecard({ principles, focus = [], score, weights }: { principles?: PrincipleScore[]; focus?: string[]; score?: number; weights?: Record<string, number> }) {
  if (!principles?.length) return null
  // Focus first (in order), then lowest score first.
  const rows = [...principles].sort((a, b) => {
    const fa = focus.indexOf(a.id)
    const fb = focus.indexOf(b.id)
    if (fa >= 0 || fb >= 0) return (fa < 0 ? 99 : fa) - (fb < 0 ? 99 : fb)
    return a.score - b.score
  })
  return (
    <div className="pr-card" role="group" aria-label="Principle scores">
      <div className="pr-head mono">
        <span>principles</span>
        {score != null && <b>{score.toFixed(1)}</b>}
        {focus.length > 0 && (
          <span className="pr-focus" title="What the next round fixes first (lowest score x your weight)">
            focus <span>{focus.map(principleLabel).join(' › ')}</span>
          </span>
        )}
      </div>
      {rows.map((p) => {
        const w = weights?.[p.id]
        const on = focus.includes(p.id)
        return (
          <details key={p.id} className={`pr-row${on ? ' focus' : ''}`}>
            <summary title={principle(p.id)?.rule}>
              <span className="pr-sig mono" aria-hidden>
                {on ? '›' : ' '}
              </span>
              <span className="pr-name mono">{principleLabel(p.id)}</span>
              <span className="pr-bar" aria-hidden>
                <i style={{ width: `${p.score * 10}%` }} className={p.score < 5 ? 'low' : p.score < 7 ? 'mid' : ''} />
              </span>
              <b className="mono">{p.score.toFixed(1)}</b>
              <span className={`pr-src mono ${p.source}`} title={SRC[p.source]}>
                {p.source === 'both' ? 'c+m' : p.source === 'code' ? 'm' : 'c'}
              </span>
              <span className="pr-w mono" title="Your learned weight for this principle">
                {w != null && Math.abs(w - 1) >= 0.05 ? `×${w.toFixed(1)}` : ''}
              </span>
            </summary>
            <div className="pr-body">
              <p>{p.note || principle(p.id)?.rule}</p>
              {p.fix && (
                <p className="pr-fix">
                  <span className="mono">fix</span> {p.fix}
                </p>
              )}
              {p.measured != null && <p className="faint mono">measured {p.measured.toFixed(1)} · critic and code averaged</p>}
            </div>
          </details>
        )
      })}
    </div>
  )
}

// The learned weights for the scorecards (refreshed when a rating changes them).
export function usePrincipleWeights(): Record<string, number> {
  const [w, setW] = useState<Record<string, number>>({})
  useEffect(() => {
    let live = true
    const load = () =>
      window.harness
        .principlesView()
        .then((v) => live && setW(v.profile.weights))
        .catch(() => undefined)
    void load()
    const off = window.harness.on('principles:changed', () => void load())
    return () => {
      live = false
      off()
    }
  }, [])
  return w
}

const LAB_LABEL: Record<string, string> = { vfx: 'vfx', anim: 'anim', ability: 'move' }

// "Your priorities": how much each principle counts for this user, learned from their ratings.
export function PrinciplePriorities({ domains }: { domains: PrincipleDomain[] }) {
  const { actions } = useStore()
  const [view, setView] = useState<PrincipleView | null>(null)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let live = true
    const load = () =>
      window.harness
        .principlesView()
        .then((v) => live && setView(v))
        .catch((e) => actions.toast({ text: 'Could not load your priorities', detail: errorText(e), kind: 'err' }))
    void load()
    const off = window.harness.on('principles:changed', () => void load())
    return () => {
      live = false
      off()
    }
  }, [])
  if (!view) return <div className="empty">loading…</div>
  const { profile } = view
  const reset = async () => {
    if (!window.confirm('Forget every rating the priorities were learned from? Weights go back to neutral.')) return
    setBusy(true)
    try {
      setView(await window.harness.principlesReset())
    } catch (e) {
      actions.toast({ text: 'Reset failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  const items = view.catalogue.filter((p) => domains.includes(p.domain)).map((p) => ({ ...p, w: profile.weights[p.id] ?? 1, ev: profile.evidence[p.id] }))
  items.sort((a, b) => b.w - a.w || a.name.localeCompare(b.name))
  return (
    <section className="pr-prio" aria-label="Your priorities">
      <div className="pr-prio-head">
        <div>
          <h3 className="mono">Your priorities</h3>
          <p className="note">
            Learned from {profile.ratings} rating{profile.ratings === 1 ? '' : 's'}: thumbs down on a result whose weak point was a principle raises it; thumbs up despite one lowers it; your notes count too. Higher weights count more in the score and get fixed first.
          </p>
        </div>
        <button className="btn small ghost" onClick={() => void reset()} disabled={busy || !profile.ratings} title="Forget the ratings (weights back to neutral)">
          <Icon name="undo" size={11} /> Reset
        </button>
      </div>
      <ul className="pr-prio-list" role="list">
        {items.map((p) => {
          const d = p.w - 1
          return (
            <li key={p.id} className={d > 0.05 ? 'up' : d < -0.05 ? 'down' : ''}>
              <span className="pr-name mono" title={p.rule}>
                {domains.length > 1 && <span className="faint">{p.domain === 'vfx' ? 'fx·' : 'an·'}</span>}
                {principleLabel(p.id)}
                {p.measured && <span className="faint" title="Measured in code as well as judged by the critic"> ·m</span>}
              </span>
              <span className="pr-wbar" aria-hidden>
                <span className="pr-mid" />
                <i style={d >= 0 ? { left: '50%', width: `${Math.min(50, (d / 1.5) * 50)}%` } : { right: '50%', width: `${Math.min(50, (-d / 0.6) * 50)}%` }} />
              </span>
              <b className="mono">×{p.w.toFixed(2)}</b>
              <span className="pr-ev faint mono" title={p.ev ? `${p.ev.up} liked (mean ${p.ev.upMean ?? '-'}) · ${p.ev.down} disliked (mean ${p.ev.downMean ?? '-'}) · ${p.ev.mentions} note mentions` : 'no ratings yet'}>
                {p.ev ? `${p.ev.up}↑ ${p.ev.down}↓${p.ev.mentions ? ` ${p.ev.mentions}✎` : ''}` : '—'}
              </span>
            </li>
          )
        })}
      </ul>
      {view.recent.length > 0 && (
        <details className="pr-recent">
          <summary className="mono">recent ratings · {view.recent.length}</summary>
          <ul>
            {view.recent.map((f) => (
              <li key={`${f.lab}-${f.entryId}-${f.at}`} className="mono">
                <span className={f.rating === 'up' ? 'ok' : 'err'}>{f.rating === 'up' ? '↑' : '↓'}</span> <span className="faint">{LAB_LABEL[f.lab]}</span> {f.name ?? f.entryId}
                {f.notes ? <span className="faint"> — “{f.notes.slice(0, 80)}”</span> : null}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}
