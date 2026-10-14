// Report a bug: screenshot of the Forge window (taken before this dialog opened), what happened /
// expected, open page, project name (full path only when ticked), recent errors and the last 300 log
// lines, redacted. Saved under userData/bug-reports/<ts>/ and copied as markdown. Never uploads.
import { useEffect, useState } from 'react'
import type { BugReportInput, BugReportResult } from '@shared/types'
import { useStore } from '../store'
import { Dialog } from '../shell/Overlays'
import { Icon } from '../components/Icons'
import { errorText } from '../lib/format'

export function BugReportDialog({ screenshot, onClose }: { screenshot: boolean; onClose: () => void }) {
  const { state, actions } = useStore()
  const tab = state.tabs.find((t) => t.id === state.activeTab)
  const [what, setWhat] = useState('')
  const [expected, setExpected] = useState('')
  const [includeShot, setIncludeShot] = useState(screenshot)
  const [includePath, setIncludePath] = useState(false)
  const [preview, setPreview] = useState<string | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [result, setResult] = useState<BugReportResult | null>(null)

  const input = (): BugReportInput => ({
    what,
    expected,
    includePath,
    includeScreenshot: includeShot,
    page: tab ? (tab.kind === 'file' ? 'Editor' : tab.title) : undefined,
    tab: tab?.path ?? tab?.title
  })

  useEffect(() => {
    if (!showPreview) return
    const t = setTimeout(() => void window.harness.qolBugReportPreview(input()).then(setPreview).catch((e) => setPreview(`Could not build the preview: ${errorText(e)}`)), 250)
    return () => clearTimeout(t)
  }, [showPreview, what, expected, includePath, includeShot])

  const save = async () => {
    setSaving(true)
    try {
      setResult(await window.harness.qolBugReport(input()))
    } catch (e) {
      actions.toast({ text: 'Could not save the bug report', detail: errorText(e), kind: 'err' })
    } finally {
      setSaving(false)
    }
  }

  if (result) {
    return (
      <Dialog title="Bug report saved" onClose={onClose} width={520}>
        <p>
          The report is on your clipboard as markdown and saved on this computer. Nothing was uploaded: paste it where you want it, and attach the screenshot from the folder.
        </p>
        <div className="qol-path mono" title={result.dir}>{result.reportPath}</div>
        <div className="qol-facts">
          <span className="badge-o ok">copied</span>
          {result.screenshotPath && <span className="badge-o">screenshot.png</span>}
          {result.redactions > 0 && <span className="badge-o warn">{result.redactions} redacted</span>}
        </div>
        <div className="actions">
          <button className="btn ghost" onClick={() => void actions.copy(result.markdown, 'bug report')}>
            <Icon name="copy" size={12} /> Copy again
          </button>
          <button className="btn" onClick={() => void window.harness.qolRevealPath(result.reportPath)}>
            <Icon name="reveal" size={12} /> Reveal
          </button>
          <button className="btn primary" autoFocus onClick={onClose}>Done</button>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog title="Report a bug" onClose={onClose} width={560}>
      <p>Saved on this computer and copied to your clipboard. Keys, tokens, passwords and cookies in the logs are replaced with [REDACTED].</p>
      <label className="field qol-field">
        <span>What happened</span>
        <textarea className="input" rows={4} autoFocus value={what} onChange={(e) => setWhat(e.target.value)} placeholder="I pressed Refine on the purple slash and the preview went black…" />
      </label>
      <label className="field qol-field">
        <span>What you expected</span>
        <textarea className="input" rows={2} value={expected} onChange={(e) => setExpected(e.target.value)} placeholder="The refined effect to show up" />
      </label>
      <div className="qol-checks">
        <label className="qol-check">
          <input type="checkbox" checked={includeShot} disabled={!screenshot} onChange={(e) => setIncludeShot(e.target.checked)} />
          <span>Screenshot of the Forge window{screenshot ? '' : ' (not available)'}</span>
        </label>
        <label className="qol-check">
          <input type="checkbox" checked={includePath} onChange={(e) => setIncludePath(e.target.checked)} />
          <span>Full project path{state.project ? '' : ' (no project open)'}<span className="faint"> · otherwise only the name{state.project ? ` "${state.project.name}"` : ''}</span></span>
        </label>
      </div>
      <div className="qol-facts" aria-label="Also included">
        <span className="badge-o">{tab ? (tab.kind === 'file' ? tab.path : tab.title) : 'no tab'}</span>
        <span className="badge-o">app + OS version</span>
        <span className="badge-o">recent errors</span>
        <span className="badge-o">last 300 log lines</span>
        <button className="link-btn" onClick={() => setShowPreview((v) => !v)} aria-expanded={showPreview}>
          {showPreview ? 'Hide report' : 'Show report'}
        </button>
      </div>
      {showPreview && <pre className="qol-preview" aria-label="Report preview">{preview ?? 'Building…'}</pre>}
      <div className="actions">
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={saving} onClick={() => void save()}>
          {saving ? <span className="spinner" /> : <Icon name="download" size={12} />} Save and copy
        </button>
      </div>
    </Dialog>
  )
}
