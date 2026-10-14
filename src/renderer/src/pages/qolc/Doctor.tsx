// Forge Doctor dialog (Help menu, command palette, Settings): one run, a green / amber / red list
// grouped by area, each problem with a one-click fix or the exact instruction, and Copy as Markdown
// for a bug report. DoctorBanner is the one-line summary at the top of Settings.
import { useCallback, useEffect, useState } from 'react'
import type { DoctorCheck, DoctorReport, DoctorStatus } from '@shared/types'
import { doctorMarkdown } from '@shared/doctor/format'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Dialog } from '../../shell/Overlays'
import { errorText } from '../../lib/format'
import { goTo, openDoctor } from './events'
import './qolc.css'

const TAG: Record<DoctorStatus, string> = { ok: 'ok', warn: 'warn', fail: 'err', skip: '' }
const WORD: Record<DoctorStatus, string> = { ok: 'ok', warn: 'warn', fail: 'fail', skip: 'skip' }
const RANK: Record<DoctorStatus, number> = { fail: 0, warn: 1, ok: 2, skip: 3 }

function useDoctorReport(): [DoctorReport | null, (r: DoctorReport) => void] {
  const [report, setReport] = useState<DoctorReport | null>(null)
  useEffect(() => {
    void window.harness.doctorLast().then((r) => r && setReport(r)).catch(() => undefined)
    return window.harness.on('doctor:report', setReport)
  }, [])
  return [report, setReport]
}

function CheckRow({ c, onFixed }: { c: DoctorCheck; onFixed: () => void }) {
  const { actions } = useStore()
  const [busy, setBusy] = useState(false)
  const fix = c.fix
  const runAction = async () => {
    if (!fix || fix.kind !== 'action') return
    setBusy(true)
    try {
      const r = await window.harness.doctorFix(fix.action)
      actions.toast({ text: r.ok ? r.message : `${fix.label} failed`, detail: r.ok ? undefined : r.message, kind: r.ok ? 'ok' : 'err' })
      if (r.ok) onFixed()
    } catch (e) {
      actions.toast({ text: `${fix.label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <li className={`doc-row ${c.status}`}>
      <span className={`tag ${TAG[c.status]}`}>{WORD[c.status]}</span>
      <div className="doc-main">
        <div className="doc-title">{c.title}</div>
        <div className="doc-detail">{c.detail}</div>
        {fix?.kind === 'instruction' && (c.status === 'warn' || c.status === 'fail') && (
          <div className="doc-instr">
            <span>{fix.text}</span>
            {fix.command && (
              <span className="doc-cmd">
                <code>{fix.command}</code>
                <button className="btn small ghost" onClick={() => void actions.copy(fix.command!, 'command')} aria-label="Copy command">
                  <Icon name="copy" size={11} />
                </button>
              </span>
            )}
            {fix.url && (
              <a className="doc-link" href={fix.url} target="_blank" rel="noreferrer">
                {fix.url.replace(/^https:\/\//, '')} <Icon name="external" size={10} />
              </a>
            )}
          </div>
        )}
      </div>
      <div className="doc-fix">
        {fix?.kind === 'action' && (c.status === 'warn' || c.status === 'fail') && (
          <button className="btn small" onClick={() => void runAction()} disabled={busy}>
            {busy ? <span className="spinner" aria-hidden /> : <Icon name="tool" size={11} />} {fix.label}
          </button>
        )}
        {fix?.kind === 'open' && (c.status === 'warn' || c.status === 'fail') && (
          <button className="btn small ghost" onClick={() => goTo(fix.target, actions)}>
            {fix.label} <Icon name="arrowRight" size={11} />
          </button>
        )}
      </div>
    </li>
  )
}

export function DoctorDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useStore()
  const [report, setReport] = useDoctorReport()
  const [running, setRunning] = useState(false)
  const [onlyProblems, setOnlyProblems] = useState(false)
  const run = useCallback(async () => {
    setRunning(true)
    try {
      setReport(await window.harness.doctorRun())
    } catch (e) {
      actions.toast({ text: 'Forge Doctor failed', detail: errorText(e), kind: 'err' })
    } finally {
      setRunning(false)
    }
  }, [actions, setReport])
  useEffect(() => {
    void run()
  }, [run])
  const checks = report ? report.checks.filter((c) => !onlyProblems || c.status === 'warn' || c.status === 'fail') : []
  const groups: { group: string; items: DoctorCheck[] }[] = []
  for (const c of checks) {
    let g = groups.find((x) => x.group === c.group)
    if (!g) groups.push((g = { group: c.group, items: [] }))
    g.items.push(c)
  }
  for (const g of groups) g.items.sort((a, b) => RANK[a.status] - RANK[b.status])
  return (
    <Dialog title="Forge Doctor" onClose={onClose} width={780}>
      <div className="doc-head">
        {report ? (
          <span className="doc-sum" aria-live="polite">
            <span className={`led ${report.overall === 'fail' ? 'err' : report.overall === 'warn' ? 'warn' : 'ok'}`} />
            {report.counts.fail ? <span className="tag err">{report.counts.fail} failing</span> : null}
            {report.counts.warn ? <span className="tag warn">{report.counts.warn} to check</span> : null}
            <span className="tag ok">{report.counts.ok} ok</span>
            <span className="faint mono">{running ? 'checking…' : `${(report.ms / 1000).toFixed(1)} s`}</span>
          </span>
        ) : (
          <span className="faint">{running ? 'Checking toolchain, Studio, ports, sync, keys, disk and the project…' : 'Not run yet'}</span>
        )}
        <span className="doc-sp" />
        <label className="doc-toggle">
          <input type="checkbox" className="switch" checked={onlyProblems} onChange={(e) => setOnlyProblems(e.target.checked)} /> Only problems
        </label>
        <button className="btn small" onClick={() => report && void actions.copy(doctorMarkdown(report), 'Doctor report (Markdown)')} disabled={!report}>
          <Icon name="copy" size={11} /> Copy as Markdown
        </button>
        <button className="btn small primary" onClick={() => void run()} disabled={running}>
          {running ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Run again
        </button>
      </div>
      <div className={`doc-body${running && report ? ' stale' : ''}`}>
        {!report && running && <div className="doc-empty"><span className="spinner" aria-hidden /> Running checks…</div>}
        {report && !checks.length && <div className="doc-empty"><Icon name="check" size={14} /> Nothing to fix.</div>}
        {groups.map((g) => (
          <section key={g.group} className="doc-group">
            <h3>{g.group}</h3>
            <ul>
              {g.items.map((c) => (
                <CheckRow key={c.id} c={c} onFixed={() => void run()} />
              ))}
            </ul>
          </section>
        ))}
      </div>
      <div className="note doc-foot">Keys are only reported as set or missing; Copy as Markdown never includes them and shortens home paths to ~.</div>
    </Dialog>
  )
}

// One line at the top of Settings: the last result, or a prompt to run the Doctor.
export function DoctorBanner() {
  const [report] = useDoctorReport()
  const bad = report ? report.counts.fail + report.counts.warn : 0
  return (
    <div className={`doc-banner${report ? ` ${report.overall}` : ''}`}>
      <span className={`led ${!report ? 'idle' : report.overall === 'fail' ? 'err' : report.overall === 'warn' ? 'warn' : 'ok'}`} />
      <div className="doc-banner-text">
        <strong>Forge Doctor</strong>
        <span className="note">
          {!report ? 'Checks the toolchain, Studio + Forge Bridge, ports, sync, keys, disk and the project in one go.' : bad ? `${report.counts.fail} failing, ${report.counts.warn} to check, last run ${new Date(report.at).toLocaleTimeString()}.` : `All ${report.counts.ok} checks pass (last run ${new Date(report.at).toLocaleTimeString()}).`}
        </span>
      </div>
      <button className="btn small" onClick={openDoctor}>
        <Icon name="check" size={11} /> {report ? 'Open' : 'Run Doctor'}
      </button>
    </div>
  )
}
