// Lab gating UI: the per-lab cost line ("cost per kept"), the small Decisions list on a lab entry,
// and the Settings > Labs block (gate + decision model modes, model status, Retrain, cost table).
import { useCallback, useEffect, useState } from 'react'
import type { GateDecision, GateMode, GatingView, LabId, ModelMode } from '@shared/types'
import { COST_TIERS, DECISION_INFO, GATE_INFO, LAB_NAMES } from '@shared/gating/types'
import { formatTokens, formatUsd } from '@shared/gating/costs'
import { useStore } from '../../store'
import { errorText } from '../../lib/format'
import './gating.css'

export function useGating(filter: { lab?: LabId; entryId?: string; limit?: number } = {}): { view: GatingView | null; reload: () => Promise<void> } {
  const [view, setView] = useState<GatingView | null>(null)
  const key = `${filter.lab ?? ''}|${filter.entryId ?? ''}|${filter.limit ?? ''}`
  const reload = useCallback(async () => {
    try {
      setView(await window.harness.labGatingView(filter))
    } catch {
      setView(null)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  useEffect(() => {
    void reload()
    const off = window.harness.on('labs:gating', (p) => {
      if (!p.lab || !filter.lab || p.lab === filter.lab) void reload()
    })
    return off
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reload])
  return { view, reload }
}

const MODE_TEXT: Record<GateMode, string> = { shadow: 'shadow', on: 'on', off: 'off' }

// One line under a lab's Make bar: what kept results cost, and what the gates (would) save.
export function LabCostLine({ lab }: { lab: LabId }) {
  const { view } = useGating({ lab, limit: 1 })
  const row = view?.costs.find((c) => c.lab === lab)
  if (!view || !row) return null
  const saved = view.settings.gates === 'on' ? row.saved : row.wouldSave
  return (
    <div className="gate-line mono" title="Model spend for this lab divided by the results you kept (rated up, saved or exported). Settings > Labs has the table.">
      <span className="faint">cost per kept</span>
      <b>{formatUsd(row.costPerKept)}</b>
      <span className="faint">
        {row.kept} kept / {row.runs} run{row.runs === 1 ? '' : 's'} · {formatUsd(row.costUsd)}
      </span>
      <span className={`tag${view.settings.gates === 'on' ? ' ok' : view.settings.gates === 'shadow' ? ' info' : ''}`}>gates {MODE_TEXT[view.settings.gates]}</span>
      {saved > 0 && (
        <span className="faint">
          ~{formatTokens(saved)} tokens {view.settings.gates === 'on' ? 'saved' : 'would be saved'}
        </span>
      )}
    </div>
  )
}

function ago(at: number): string {
  const s = Math.max(0, (Date.now() - at) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  return `${Math.floor(s / 86400)}d`
}

function outcomeTone(d: GateDecision): string {
  if (d.acted) return 'ok'
  if (d.outcome.startsWith('would')) return 'info'
  return ''
}

export function DecisionRow({ d, showLab }: { d: GateDecision; showLab?: boolean }) {
  return (
    <li className="gate-dec">
      <span className="gate-dec-gate mono">{GATE_INFO[d.gate].label}</span>
      <span className={`tag ${outcomeTone(d)}`}>{d.outcome}</span>
      {d.by === 'model' && <span className="tag hot" title="Decided by the learned decision model">model</span>}
      {d.unsure && <span className="tag warn" title="The code heuristic was in its grey zone">unsure</span>}
      <span className="gate-dec-in faint ellipsis" title={d.inputs}>
        {showLab ? `${LAB_NAMES[d.lab]}: ` : ''}
        {d.inputs}
        {d.modelP !== undefined ? ` · model p=${d.modelP.toFixed(2)}${d.modelSays ? ` (says ${d.modelSays})` : ''}` : ''}
      </span>
      {d.tokensSaved > 0 && <span className="gate-dec-save mono">~{formatTokens(d.tokensSaved)}</span>}
      <span className="faint mono gate-dec-at">{ago(d.at)}</span>
    </li>
  )
}

// "Decisions" on a lab entry: what the gates decided for it.
export function LabDecisions({ lab, entryId }: { lab: LabId; entryId: string }) {
  const { view } = useGating({ lab, entryId, limit: 12 })
  const ds = view?.decisions ?? []
  if (!view || (!ds.length && view.settings.gates === 'off')) return null
  return (
    <section className="gate-decs" aria-label="Decisions">
      <header className="gate-decs-head">
        <span className="gate-decs-title">Decisions</span>
        <span className="faint mono">gates {view.settings.gates}</span>
      </header>
      {ds.length ? (
        <ul className="gate-dec-list">
          {ds.map((d) => (
            <DecisionRow key={d.id} d={d} />
          ))}
        </ul>
      ) : (
        <div className="note">No gate decisions for this one yet. They show up from the second refine round on.</div>
      )}
    </section>
  )
}

function Seg<T extends string>({ value, options, onChange, label }: { value: T; options: [T, string][]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="seg" role="group" aria-label={label}>
      {options.map(([v, text]) => (
        <button key={v} type="button" className={value === v ? 'on' : ''} aria-pressed={value === v} onClick={() => onChange(v)}>
          {text}
        </button>
      ))}
    </div>
  )
}

// Settings > Labs: gates, decision models, the cost table.
export function GatingSettings() {
  const { actions } = useStore()
  const { view, reload } = useGating({ limit: 8 })
  const [busy, setBusy] = useState(false)
  if (!view) return <div className="note">Loading...</div>
  const set = async (patch: { gates?: GateMode; models?: ModelMode }) => {
    try {
      await window.harness.labGatingSet(patch)
      await reload()
    } catch (e) {
      actions.toast({ text: 'Could not save the gating settings', detail: errorText(e), kind: 'err' })
    }
  }
  const retrain = async () => {
    setBusy(true)
    try {
      await window.harness.labGatingRetrain()
      await reload()
      actions.toast({ text: 'Decision models retrained', kind: 'ok', ms: 2000 })
    } catch (e) {
      actions.toast({ text: 'Retrain failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="gate-set">
      <h3 className="set-sub">Saving tokens</h3>
      <div className="set-row">
        <div className="set-text grow">
          <div className="set-title">Decision gates</div>
          <div className="note">
            Cheap checks in code before a model call: skip the critic when the frames did not change, stop when the score plateaus, decide retries of a failed compose. Shadow logs what
            they would do and changes nothing; off is the old behaviour.
          </div>
        </div>
        <div className="set-ctl">
          <Seg<GateMode> label="Decision gates" value={view.settings.gates} options={[['off', 'Off'], ['shadow', 'Shadow'], ['on', 'On']]} onChange={(v) => void set({ gates: v })} />
        </div>
      </div>
      <div className="set-row">
        <div className="set-text grow">
          <div className="set-title">Decision models</div>
          <div className="note">
            Small classifiers trained on this computer from the gate log (free, no downloads). A model only decides instead of the code once it has {view.settings.minExamples} labelled
            examples and beats the code on held-out examples.
          </div>
        </div>
        <div className="set-ctl">
          <Seg<ModelMode> label="Decision models" value={view.settings.models} options={[['off', 'Off'], ['shadow', 'Shadow'], ['on', 'On']]} onChange={(v) => void set({ models: v })} />
        </div>
      </div>
      <details className="set-more">
        <summary>Model status, cost per kept result and latest decisions</summary>
        <ul className="gate-models" aria-label="Decision models">
          {view.models.map((m) => (
            <li key={m.type} className="gate-model">
              <span className="gate-model-name">{DECISION_INFO[m.type].label}</span>
              <span className="faint gate-model-q ellipsis" title={DECISION_INFO[m.type].question}>
                {DECISION_INFO[m.type].question}
              </span>
              {m.state === 'active' ? (
                <span className="tag ok" title={`Held-out accuracy on ${m.holdout} examples`}>
                  active, {Math.round((m.modelAcc ?? 0) * 100)}% vs heuristic {Math.round((m.heuristicAcc ?? 0) * 100)}%
                </span>
              ) : m.state === 'not-better' ? (
                <span className="tag warn" title="Enough examples, but it does not beat the code yet: the code decides">
                  {Math.round((m.modelAcc ?? 0) * 100)}% vs heuristic {Math.round((m.heuristicAcc ?? 0) * 100)}%
                </span>
              ) : (
                <span className="tag">
                  learning ({Math.min(m.labelled, m.needed)}/{m.needed})
                </span>
              )}
            </li>
          ))}
        </ul>
        <div className="row gate-actions">
          <button className="btn small" disabled={busy} onClick={() => void retrain()}>
            {busy ? <span className="spinner" aria-hidden /> : null} Retrain
          </button>
          <span className="grow" />
          <button
            className="btn small ghost"
            onClick={async () => {
              await window.harness.labGatingReset()
              await reload()
            }}
          >
            Clear log and costs
          </button>
        </div>
        <h3 className="set-sub">Cost per kept result</h3>
        <div className="gate-tbl-wrap">
          <table className="tbl gate-tbl">
            <thead>
              <tr>
                <th>Lab</th>
                <th>Kept / runs</th>
                <th>Per kept</th>
                {COST_TIERS.map((t) => (
                  <th key={t}>{t}</th>
                ))}
                <th title="Tokens the gates saved (on) or would have saved (shadow)">Saved</th>
              </tr>
            </thead>
            <tbody>
              {view.costs.map((r) => (
                <tr key={r.lab}>
                  <td>{LAB_NAMES[r.lab]}</td>
                  <td>
                    {r.kept} / {r.runs}
                  </td>
                  <td>{formatUsd(r.costPerKept)}</td>
                  {COST_TIERS.map((t) => (
                    <td key={t} title={r.tiers[t] ? `${r.tiers[t]!.calls} calls, ${formatUsd(r.tiers[t]!.costUsd)}, ${formatTokens(r.tiers[t]!.tokens)} tokens` : ''}>
                      {r.tiers[t] ? formatUsd(r.tiers[t]!.costPerKept ?? r.tiers[t]!.costUsd) : '—'}
                    </td>
                  ))}
                  <td>{r.saved ? `${formatTokens(r.saved)}` : r.wouldSave ? <span className="faint">({formatTokens(r.wouldSave)})</span> : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="note">Kept = rated up, saved or exported. Tier columns are spend per kept result (total spend while nothing is kept). Brackets: would be saved in shadow.</div>
        {view.decisions.length > 0 && (
          <>
            <h3 className="set-sub">Latest decisions</h3>
            <ul className="gate-dec-list">
              {view.decisions.map((d) => (
                <DecisionRow key={d.id} d={d} showLab />
              ))}
            </ul>
          </>
        )}
      </details>
    </div>
  )
}
