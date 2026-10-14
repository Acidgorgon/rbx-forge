// Spending cap UI: Settings > Usage (caps, today / this month, per-provider and per-source
// breakdown, 14 days), the status-bar pill from 80% of a cap, and the alert toasts with
// "Raise cap for today".
import { useEffect, useState } from 'react'
import type { SpendSettings, SpendState } from '@shared/types'
import { SPEND_SOURCE_LABEL } from '@shared/spend/types'
import { useStore, type Actions } from '../../store'
import { Icon } from '../../components/Icons'
import { useMenu } from '../../components/Menu'
import { errorText, fmtUsd } from '../../lib/format'
import { openUsageSettings } from './events'
import './qolc.css'

export function useSpend(): SpendState | null {
  const [s, setS] = useState<SpendState | null>(null)
  useEffect(() => {
    void window.harness.spendState().then(setS).catch(() => undefined)
    return window.harness.on('spend:changed', setS)
  }, [])
  return s
}

const money = (n: number) => (n >= 100 ? `$${n.toFixed(0)}` : `$${n.toFixed(2)}`)

export async function raiseToday(actions: Actions, amount?: number): Promise<void> {
  try {
    const s = await window.harness.spendRaiseToday(amount)
    actions.toast({ text: `Cap raised for today by ${money(s.overrideToday)}`, detail: s.day.effectiveCap !== null ? `Today: ${money(s.day.spent)} of ${money(s.day.effectiveCap)}` : undefined, kind: 'ok', ms: 3500 })
  } catch (e) {
    actions.toast({ text: 'Could not raise the cap', detail: errorText(e), kind: 'err' })
  }
}

function Meter({ label, spent, cap, effective, level }: { label: string; spent: number; cap: number | null; effective: number | null; level: string }) {
  const pct = effective ? Math.min(100, (spent / effective) * 100) : 0
  return (
    <div className="spend-meter">
      <div className="spend-meter-top">
        <span>{label}</span>
        <span className="mono">
          {money(spent)}
          {effective !== null ? <span className="faint"> / {money(effective)}{cap !== null && effective !== cap ? ' (raised)' : ''}</span> : <span className="faint"> · no cap</span>}
        </span>
      </div>
      <div className="spend-bar" role="meter" aria-label={label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)}>
        <span className={`spend-fill ${level}`} style={{ width: `${pct}%` }} />
      </div>
    </div>
  )
}

function CapField({ label, value, onSave }: { label: string; value: number | null; onSave: (v: number | null) => void }) {
  const [text, setText] = useState(value === null ? '' : String(value))
  useEffect(() => setText(value === null ? '' : String(value)), [value])
  const commit = () => {
    const t = text.trim()
    const n = t === '' ? null : Number(t)
    if (n !== null && (!Number.isFinite(n) || n <= 0)) return setText(value === null ? '' : String(value))
    if (n !== value) onSave(n)
  }
  return (
    <label className="spend-cap">
      <span>{label}</span>
      <span className="spend-cap-input">
        <span className="faint">$</span>
        <input className="input mono" inputMode="decimal" placeholder="no cap" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === 'Enter' && commit()} aria-label={`${label} in USD`} />
      </span>
    </label>
  )
}

// Settings > Usage.
export function SpendSettingsSection() {
  const { actions } = useStore()
  const s = useSpend()
  const save = async (patch: Partial<SpendSettings>) => {
    try {
      await window.harness.spendSetSettings(patch)
    } catch (e) {
      actions.toast({ text: 'Could not save the cap', detail: errorText(e), kind: 'err' })
    }
  }
  if (!s) return <div className="note">Loading…</div>
  const max = Math.max(0.01, ...s.history.map((d) => d.total), s.settings.dailyUsd ?? 0)
  return (
    <div className="spend">
      <p className="note">
        One budget for every AI call Forge makes: chat, group chats, test agents, team runs, the Labs and image generation. At {Math.round(s.settings.warnAt * 100)}% you get a warning and a status-bar pill; at 100% new calls are refused until tomorrow (or the 1st for the monthly cap) unless you raise the cap for today. Kept only on this computer (app data folder, spend.json). Costs are the providers' reported amounts, or the price table's estimate.
      </p>
      <div className="spend-caps">
        <CapField label="Daily cap" value={s.settings.dailyUsd} onSave={(v) => void save({ dailyUsd: v })} />
        <CapField label="Monthly cap" value={s.settings.monthlyUsd} onSave={(v) => void save({ monthlyUsd: v })} />
        <label className="spend-cap">
          <span>Warn at</span>
          <select className="input" value={String(s.settings.warnAt)} onChange={(e) => void save({ warnAt: Number(e.target.value) })} aria-label="Warn at">
            {[0.5, 0.7, 0.8, 0.9].map((v) => (
              <option key={v} value={v}>{Math.round(v * 100)}%</option>
            ))}
          </select>
        </label>
      </div>
      <div className="spend-meters">
        <Meter label="Today" spent={s.day.spent} cap={s.day.cap} effective={s.day.effectiveCap} level={s.day.level} />
        <Meter label="This month" spent={s.month.spent} cap={s.month.cap} effective={s.month.effectiveCap} level={s.month.level} />
      </div>
      <div className="spend-actions">
        {s.level !== 'ok' && <span className={`tag ${s.level === 'stop' ? 'err' : 'warn'}`}>{s.level === 'stop' ? 'paused' : 'near cap'}</span>}
        {s.overrideToday > 0 && <span className="note">Raised by {money(s.overrideToday)} for today.</span>}
        <span className="doc-sp" />
        {s.overrideToday > 0 && (
          <button className="btn small ghost" onClick={() => void window.harness.spendClearOverride()}>
            Undo raise
          </button>
        )}
        <button className="btn small" onClick={() => void raiseToday(actions)} disabled={s.settings.dailyUsd === null && s.settings.monthlyUsd === null}>
          <Icon name="arrowUp" size={11} /> Raise cap for today (+{money(s.raiseStep)})
        </button>
      </div>
      <div className="spend-tables">
        <table className="spend-table">
          <caption>By provider</caption>
          <thead>
            <tr><th>Provider</th><th>Today</th><th>Month</th></tr>
          </thead>
          <tbody>
            {s.byProvider.length ? s.byProvider.map((r) => <tr key={r.provider}><td>{r.provider}</td><td className="mono">{fmtUsd(r.day)}</td><td className="mono">{fmtUsd(r.month)}</td></tr>) : <tr><td colSpan={3} className="faint">No AI calls this month.</td></tr>}
          </tbody>
        </table>
        <table className="spend-table">
          <caption>By feature</caption>
          <thead>
            <tr><th>Feature</th><th>Today</th><th>Month</th></tr>
          </thead>
          <tbody>
            {s.bySource.length ? s.bySource.map((r) => <tr key={r.source}><td>{SPEND_SOURCE_LABEL[r.source]}</td><td className="mono">{fmtUsd(r.day)}</td><td className="mono">{fmtUsd(r.month)}</td></tr>) : <tr><td colSpan={3} className="faint">Nothing yet.</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="spend-days" aria-label="Spend, last 14 days">
        {s.history.map((d) => (
          <div key={d.day} className="spend-day" title={`${d.day}: ${fmtUsd(d.total)}`}>
            <span className={`spend-day-bar${s.settings.dailyUsd && d.total >= s.settings.dailyUsd ? ' over' : ''}`} style={{ height: `${Math.max(2, (d.total / max) * 100)}%` }} />
            <span className="spend-day-label">{d.day.slice(8)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// Status-bar pill: shown from the warn threshold on.
export function SpendPill() {
  const { actions } = useStore()
  const s = useSpend()
  const menu = useMenu()
  if (!s || s.level === 'ok') return null
  const w = s.day.level !== 'ok' && (s.day.fraction >= s.month.fraction || s.month.level === 'ok') ? s.day : s.month
  const label = `${money(w.spent)}/${money(w.effectiveCap ?? 0)} ${w.kind === 'day' ? 'today' : 'month'}`
  return (
    <>
      <span
        className={`sb spend-pill ${s.level}`}
        role="button"
        tabIndex={0}
        title={s.level === 'stop' ? 'Spending cap reached: new AI calls are paused' : `AI spend is at ${Math.round(w.fraction * 100)}% of the cap`}
        onClick={(e) =>
          menu.openUnder(e.currentTarget, [
            { header: s.level === 'stop' ? 'Spending cap reached' : 'Near the spending cap' },
            { label: `Raise cap for today (+${money(s.raiseStep)})`, icon: <Icon name="arrowUp" />, onSelect: () => void raiseToday(actions) },
            { label: 'Usage settings…', icon: <Icon name="gear" />, onSelect: () => openUsageSettings(actions) }
          ], { minWidth: 240 })
        }
      >
        <span className={`tag ${s.level === 'stop' ? 'err' : 'warn'}`}>{s.level === 'stop' ? 'cap' : `${Math.round(w.fraction * 100)}%`}</span>
        <span className="mono">{label}</span>
      </span>
      {menu.node}
    </>
  )
}

// Toasts for threshold crossings and refused calls (mounted once by QolcOverlays).
export function useSpendAlerts(actions: Actions): void {
  useEffect(
    () =>
      window.harness.on('spend:alert', (a) => {
        actions.toast({
          text: a.level === 'stop' ? (a.refused ? 'AI call refused: spending cap reached' : 'Spending cap reached') : 'AI spend is near the cap',
          detail: a.text,
          kind: a.level === 'stop' ? 'err' : 'hot',
          ms: a.level === 'stop' ? 0 : 8000,
          action: a.level === 'stop' ? { label: 'Raise cap for today', run: () => void raiseToday(actions) } : { label: 'Usage', run: () => openUsageSettings(actions) }
        })
      }),
    [actions]
  )
}
