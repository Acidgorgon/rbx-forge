// Import from Figma: paste (or drop) the Forge Figma plugin's "Send selection to Forge" JSON, or a
// Figma link fetched with the token stored in main (Settings > Integrations > Figma). Shows the
// mapping report: what was approximated or dropped, font substitutions and the files written.
import { useEffect, useRef, useState } from 'react'
import type { FigmaImportResult, FigmaTokenStatus } from '@shared/types'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { useStore } from '../../store'

export function MappingReportView({ result }: { result: FigmaImportResult }) {
  const r = result.report
  const notes = r.notes.filter((n) => n.level !== 'info')
  const subs = r.fonts.filter((f) => !f.exact)
  return (
    <div className="um-report">
      <div className="row">
        <Icon name="check" size={12} className="ok" />
        <b className="mono">{result.component.name}</b>
        <span className="faint mono">
          {r.size.w}×{r.size.h} · {Object.entries(r.counts).map(([k, v]) => `${v} ${k}`).join(' · ')}
        </span>
      </div>
      <p className="note">Mapping: {r.summary || 'exact'}.</p>
      {notes.length > 0 && (
        <ul className="um-notes">
          {notes.map((n, i) => (
            <li key={i} className={n.level}>
              <span className={`tag ${n.level === 'dropped' ? 'err' : 'warn'}`}>{n.level === 'dropped' ? 'dropped' : 'approx'}</span>
              <span className="mono">{n.what}</span>
              <span className="faint mono">{n.node}</span>
              <span className="um-note-d">{n.detail}</span>
            </li>
          ))}
        </ul>
      )}
      {subs.length > 0 && (
        <p className="note mono">
          fonts: {subs.map((f) => `${f.figma} → ${f.family} ${f.weight}`).join(' · ')}
        </p>
      )}
      <details className="um-files">
        <summary className="mono faint">{result.files.length} files written</summary>
        <ul className="mono">
          {result.files.map((f) => (
            <li key={f}>{f}</li>
          ))}
        </ul>
      </details>
      {result.warnings.map((w, i) => (
        <p key={i} className="note warn">
          <Icon name="warn" size={11} /> {w}
        </p>
      ))}
    </div>
  )
}

export function FigmaImport({ onDone, onClose }: { onDone: (r: FigmaImportResult) => void; onClose: () => void }) {
  const h = window.harness
  const { actions } = useStore()
  const [tab, setTab] = useState<'plugin' | 'link'>('plugin')
  const [json, setJson] = useState('')
  const [url, setUrl] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [token, setToken] = useState<FigmaTokenStatus | null>(null)
  const [result, setResult] = useState<FigmaImportResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const fileRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    void h.uiMotionFigmaToken().then(setToken).catch(() => undefined)
    return h.on('uimotion:changed', () => void h.uiMotionFigmaToken().then(setToken).catch(() => undefined))
  }, [])

  const run = async () => {
    setBusy(true)
    setError(null)
    try {
      const opts = name.trim() ? { name: name.trim() } : undefined
      const r = tab === 'plugin' ? await h.uiMotionImportFigmaDoc(json, opts) : await h.uiMotionImportFigmaUrl(url.trim(), opts)
      setResult(r)
      onDone(r)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="set-sec um-import" aria-label="Import from Figma">
      <div className="row">
        <Icon name="download" size={12} />
        <b>Import from Figma</b>
        <span className="seg um-seg">
          <button className={tab === 'plugin' ? 'on' : ''} aria-pressed={tab === 'plugin'} onClick={() => setTab('plugin')}>
            plugin JSON
          </button>
          <button className={tab === 'link' ? 'on' : ''} aria-pressed={tab === 'link'} onClick={() => setTab('link')}>
            Figma link
          </button>
        </span>
        <span className="grow" />
        <button className="btn small ghost" onClick={onClose} aria-label="Close import">
          <Icon name="x" size={12} />
        </button>
      </div>
      {tab === 'plugin' ? (
        <>
          <p className="note">
            In Figma: select any frame or component, run <span className="mono">Plugins › Forge UI › Send selection to Forge</span>, then Copy (or Download) and paste here. Works on any layer; no token needed.
          </p>
          <textarea
            className="input mono um-json"
            value={json}
            onChange={(e) => setJson(e.target.value)}
            placeholder='{"format":"forge-figma", ...}'
            aria-label="Forge Figma JSON"
            spellCheck={false}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault()
              const f = e.dataTransfer.files[0]
              if (f) void f.text().then(setJson)
            }}
          />
          <input ref={fileRef} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && void e.target.files[0].text().then(setJson)} />
        </>
      ) : (
        <>
          <p className="note">
            Right-click the frame in Figma › <span className="mono">Copy link to selection</span>. Forge fetches it with the Figma REST API (file nodes + image renders) using your personal access token, which stays in this computer's keychain.
          </p>
          <input className="input mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.figma.com/design/<file>/<name>?node-id=1-2" aria-label="Figma link" />
          {token && !token.set && (
            <p className="note warn">
              <Icon name="key" size={11} /> No Figma token yet.{' '}
              <button className="btn small" onClick={() => actions.openPage('settings')}>
                Settings › Integrations
              </button>
            </p>
          )}
        </>
      )}
      <div className="row">
        <input className="input um-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Name (default: the layer name)" aria-label="Component name" />
        {tab === 'plugin' && (
          <button className="btn small" onClick={() => fileRef.current?.click()}>
            Open file…
          </button>
        )}
        <span className="grow" />
        <button className="btn primary" disabled={busy || (tab === 'plugin' ? !json.trim() : !url.trim())} onClick={() => void run()}>
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} Import
        </button>
      </div>
      {error && (
        <p className="note err" role="alert">
          <Icon name="err" size={11} /> {error}
        </p>
      )}
      {result && <MappingReportView result={result} />}
    </section>
  )
}
