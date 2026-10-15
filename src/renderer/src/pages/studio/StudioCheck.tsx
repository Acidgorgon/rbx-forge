// Studio check UI shared by the VFX Lab, Animation Lab and Ability Composer: a "Studio check" button
// next to Refine / Critique, and a panel (the labs' "studio" tab) with the bridge status, the
// "critique in Studio when connected" setting and the last check's frames, Studio next to the preview
// at each beat. The work happens in main (services/studio); the plugin plays the item in Studio.
import { useCallback, useEffect, useState } from 'react'
import type { StudioCheckKind, StudioCheckRecord, StudioProgress, StudioStatus } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { StudioTargetPicker } from './StudioTarget'
import './studio.css'

const LIVE = new Set<StudioProgress['phase']>(['queued', 'waiting', 'staging', 'capturing', 'preview', 'critique'])

export function useStudioStatus(): [StudioStatus | null, () => void] {
  const [status, setStatus] = useState<StudioStatus | null>(null)
  const refresh = useCallback(() => {
    window.harness.studioStatus().then(setStatus).catch(() => undefined)
  }, [])
  useEffect(() => {
    refresh()
    const off = window.harness.on('studio:bridge', (s) => s && setStatus(s))
    // The plugin's "connected" fades after a while without polls: re-check now and then.
    const t = setInterval(refresh, 10_000)
    return () => {
      off()
      clearInterval(t)
    }
  }, [refresh])
  return [status, refresh]
}

export function useStudioProgress(kind: StudioCheckKind, id: string): StudioProgress | null {
  const [p, setP] = useState<StudioProgress | null>(null)
  useEffect(() => {
    setP(null)
    return window.harness.on('studio:progress', (x) => {
      if (x.kind === kind && x.id === id) setP(x)
    })
  }, [kind, id])
  return p
}

const STATE_TAG: Record<StudioStatus['state'], { text: string; cls: string }> = {
  ready: { text: 'connected', cls: 'ok' },
  'no-plugin': { text: 'no plugin', cls: 'warn' },
  'plugin-outdated': { text: 'update plugin', cls: 'warn' },
  'studio-offline': { text: 'studio offline', cls: '' },
  'no-capture': { text: 'no capture', cls: 'warn' },
  busy: { text: 'busy', cls: 'info' },
  'server-error': { text: 'bridge error', cls: 'err' },
  unsupported: { text: 'unavailable', cls: '' }
}

export function StudioStateTag({ status }: { status: StudioStatus | null }) {
  if (!status) return null
  const t = STATE_TAG[status.state]
  return (
    <span className={`tag ${t.cls}`} title={status.message}>
      {t.text}
    </span>
  )
}

// Runs a check (critique on) and reports it; `before` saves pending edits first.
export function useRunStudioCheck(kind: StudioCheckKind, id: string, opts: { before?: () => Promise<void> | void; after?: (r: StudioCheckRecord) => void } = {}) {
  const { actions } = useStore()
  const [running, setRunning] = useState(false)
  const run = async () => {
    if (running) return
    setRunning(true)
    try {
      await opts.before?.()
      const r = await window.harness.studioCheck(kind, id, { critique: true })
      actions.toast({ text: `Studio check · ${r.frames.length} frame${r.frames.length === 1 ? '' : 's'}${r.critique ? ` · ${r.critique.overall.toFixed(1)}/10` : ''}`, detail: r.critique?.summary ?? `Captured in ${r.window ?? 'Studio'}.`, kind: 'ok', ms: 4000 })
      opts.after?.(r)
    } catch (e) {
      actions.toast({ text: 'Studio check failed', detail: errorText(e), kind: 'err', ms: 6000 })
    } finally {
      setRunning(false)
    }
  }
  return { run, running }
}

export function StudioCheckButton({ kind, id, before, onShow }: { kind: StudioCheckKind; id: string; before?: () => Promise<void> | void; onShow?: () => void }) {
  const [status] = useStudioStatus()
  const { run, running } = useRunStudioCheck(kind, id, { before, after: () => onShow?.() })
  const ready = status?.state === 'ready'
  const title = ready ? `Play it in Roblox Studio (${status!.studio.place ?? 'Studio'}), capture the key beats and critique them` : `${status?.message ?? 'Checking the Studio connection…'} (opens the Studio tab)`
  return (
    <button className="btn small" onClick={() => (ready ? void run() : onShow?.())} disabled={running} title={title} aria-label="Studio check">
      {running ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Studio check
      <span className={`studio-dot ${ready ? 'on' : status?.state === 'studio-offline' || !status ? '' : 'warn'}`} aria-hidden />
    </button>
  )
}

function useStudioFile(kind: StudioCheckKind, id: string, file: string | undefined, stamp: number): string | null {
  const [url, setUrl] = useState<string | null>(null)
  useEffect(() => {
    if (!file) return setUrl(null)
    let live = true
    window.harness
      .studioFile(kind, id, file)
      .then((u) => live && setUrl(u))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [kind, id, file, stamp])
  return url
}

function Shot({ kind, id, file, stamp, label }: { kind: StudioCheckKind; id: string; file?: string; stamp: number; label: string }) {
  const url = useStudioFile(kind, id, file, stamp)
  if (!file) return <div className="studio-shot empty-shot faint">no {label}</div>
  return <div className="studio-shot">{url ? <img src={url} alt={label} /> : <span className="spinner" aria-hidden />}</div>
}

const PHASE_TEXT: Record<StudioProgress['phase'], string> = {
  queued: 'queued',
  waiting: 'waiting for Studio',
  staging: 'staging',
  capturing: 'capturing',
  preview: 'preview frames',
  critique: 'critique',
  done: 'done',
  error: 'error'
}

export function StudioCheckPanel({ kind, id, before }: { kind: StudioCheckKind; id: string; before?: () => Promise<void> | void }) {
  const { actions } = useStore()
  const [status, refresh] = useStudioStatus()
  const progress = useStudioProgress(kind, id)
  const [record, setRecord] = useState<StudioCheckRecord | null>(null)
  const [installing, setInstalling] = useState(false)
  const { run, running } = useRunStudioCheck(kind, id, { before, after: setRecord })

  useEffect(() => {
    let live = true
    setRecord(null)
    window.harness
      .studioLastCheck(kind, id)
      .then((r) => live && setRecord(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [kind, id])

  const install = async () => {
    setInstalling(true)
    try {
      await window.harness.studioInstallPlugin()
      actions.toast({ text: 'Forge Bridge plugin installed', detail: 'Restart Roblox Studio (or reopen your place) to load it. Studio asks once to allow HTTP requests to 127.0.0.1 and script injection: allow both.', kind: 'ok', ms: 8000 })
      refresh()
    } catch (e) {
      actions.toast({ text: 'Install failed', detail: errorText(e), kind: 'err' })
    } finally {
      setInstalling(false)
    }
  }
  const setPrefer = (on: boolean) => void window.harness.studioSetPrefer(on).catch((e) => actions.toast({ text: 'Setting not saved', detail: errorText(e), kind: 'err' }))

  const live = progress && LIVE.has(progress.phase)
  const state = status?.state
  const canInstall = state === 'no-plugin' || state === 'plugin-outdated' || (!!status?.plugin.dir && state !== 'unsupported')
  return (
    <div className="studio-panel">
      <div className="studio-status">
        <Icon name="studio" size={13} />
        <b>Roblox Studio</b>
        <StudioStateTag status={status} />
        <span className="studio-msg">{status?.message ?? 'Checking…'}</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={refresh} aria-label="Refresh Studio status" title="Refresh">
          <Icon name="sync" size={11} />
        </button>
      </div>

      <div className="studio-row">
        {canInstall && (
          <button className={`btn small${state === 'no-plugin' || state === 'plugin-outdated' ? ' primary' : ''}`} onClick={() => void install()} disabled={installing} title={status?.plugin.file ?? 'Studio plugins folder'}>
            {installing ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} {status?.plugin.installed ? 'Reinstall plugin' : 'Install plugin'}
          </button>
        )}
        {status?.plugin.dir && (
          <button className="btn small ghost" onClick={() => void window.harness.studioOpenPluginsFolder()} title={status.plugin.dir}>
            <Icon name="folder" size={11} /> Plugins folder
          </button>
        )}
        <label className="studio-prefer" title="Refine loops and the ability critique use Studio frames while Studio is connected, and the preview otherwise">
          <input type="checkbox" className="switch" checked={!!status?.prefer} onChange={(e) => setPrefer(e.target.checked)} /> critique in Studio when connected
        </label>
        <span className="grow" />
        <StudioTargetPicker />
        <button className="btn small primary" onClick={() => void run()} disabled={running || state !== 'ready'} title={state === 'ready' ? 'Play in Studio, capture the beats, critique' : status?.message}>
          {running ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Run Studio check
        </button>
      </div>

      {live && (
        <div className="studio-progress mono" aria-live="polite">
          <span className="spinner" aria-hidden /> {PHASE_TEXT[progress!.phase]}
          {progress!.message ? ` · ${progress!.message}` : ''}
        </div>
      )}
      {progress?.phase === 'error' && !live && <div className="studio-error">{progress.message}</div>}

      {record ? (
        <div className="studio-result">
          <div className="studio-meta mono">
            <span>{new Date(record.at).toLocaleString()}</span>
            <span>{record.mode}</span>
            {record.place && <span>{record.place}</span>}
            <span>{(record.ms / 1000).toFixed(1)} s</span>
            {!record.crop && <span className="warn-text">viewport not found: whole window</span>}
          </div>
          {record.critique && (
            <p className="studio-critique">
              <b className="mono">{record.critique.overall.toFixed(1)}</b> {record.critique.summary}
            </p>
          )}
          <div className="studio-grid" role="list">
            <div className="studio-colhead">
              <span />
              <span>Studio</span>
              <span>Preview</span>
            </div>
            {record.frames.map((f) => (
              <div key={f.file} className="studio-beat" role="listitem">
                <div className="studio-beat-label">
                  <b>{f.label}</b>
                  <span className="mono faint">{f.t.toFixed(2)} s</span>
                  {f.offsetMs !== undefined && <span className="mono faint" title="Capture offset from the beat time">{f.offsetMs >= 0 ? '+' : ''}{f.offsetMs} ms</span>}
                </div>
                <Shot kind={kind} id={id} file={f.file} stamp={record.at} label="Studio frame" />
                <Shot kind={kind} id={id} file={f.preview} stamp={record.at} label="preview" />
              </div>
            ))}
          </div>
          {record.drift && record.drift.length > 0 && (
            <div className="studio-drift mono">
              stages in Studio: {record.drift.map((d) => `${d.label} ${d.planned.toFixed(2)}→${d.actual.toFixed(2)}`).join(' · ')}
            </div>
          )}
        </div>
      ) : (
        !live && (
          <div className="empty studio-empty">
            <Icon name="studio" size={22} className="i" />
            <div>Play this in your real Roblox Studio and judge what players will see.</div>
            <div className="faint">Install the Forge Bridge plugin once, keep Studio open and visible (not minimised) during the check. Forge records the Studio window; on macOS allow Screen Recording for Forge.</div>
          </div>
        )
      )}
    </div>
  )
}
