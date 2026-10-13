// Release tab: plan (mode detection, version bump, preflight checks streamed over release:check,
// editable changelog), run with live steps (release:step), Studio publish follow-up, history,
// write-only secrets (Open Cloud key, Discord webhook), team publish config and notifications.
import { useEffect, useMemo, useState } from 'react'
import type {
  BumpKind,
  CheckResult,
  NotificationToggles,
  PublishConfig,
  ReleaseHistoryEntry,
  ReleaseMode,
  ReleasePlan,
  ReleaseResult,
  ReleaseSecretKind,
  ReleaseSecretsStatus,
  ReleaseStep,
  ReleaseStepId,
  ReleaseUserSettings,
  SecretScope,
  VersionType
} from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText } from '../lib/format'

const MODE_LABEL: Record<ReleaseMode, string> = { studio: 'Studio publish', rojo: 'Rojo build', file: 'Place file' }
const MODE_DESC: Record<ReleaseMode, string> = {
  studio: 'Forge runs checks, writes the changelog, tags and notifies. You publish from Studio.',
  rojo: 'Forge builds the place with rojo and publishes it with Open Cloud. Only for fully Rojo-managed games.',
  file: 'Forge publishes a place file you exported from Studio (File > Save to File As) with Open Cloud.'
}
const STEP_LABEL: Record<ReleaseStepId, string> = { preflight: 'Checks', build: 'Build', publish: 'Publish', version: 'Version', tag: 'Tag', push: 'Push', notify: 'Notify' }
const CHECK_BADGE: Record<CheckResult['status'], string> = { pass: 'ok', warn: 'warn', fail: 'err', skip: '' }
const NOTIFY_LABEL: Record<keyof NotificationToggles, string> = { release: 'Releases', publish: 'Publishes', sync: 'Syncs', push: 'Pushes', 'test-failure': 'Test failures' }

function SecretRow({ kind, label, set, hint, onChange }: { kind: ReleaseSecretKind; label: string; set: boolean; hint?: string; onChange: (s: ReleaseSecretsStatus) => void }) {
  const { actions } = useStore()
  const [value, setValue] = useState('')
  const [scope, setScope] = useState<SecretScope>('project')
  const [editing, setEditing] = useState(false)
  const save = async () => {
    try {
      onChange(await window.harness.releaseSetSecret(kind, value.trim(), scope))
      setValue('')
      setEditing(false)
      actions.toast({ text: `${label} saved`, detail: scope === 'project' ? 'for this project, on this machine' : 'for every project, on this machine', kind: 'ok' })
    } catch (e) {
      actions.toast({ text: `Could not save ${label}`, detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <div className="set-row">
      <div className="set-text">
        <div className="set-title">{label}</div>
        <div className="note">{set ? (hint ? <span className="mono">{hint}</span> : 'set') : 'not set'} · write-only, kept in the OS keychain</div>
      </div>
      <div className="set-ctl">
        {set && !editing ? (
          <>
            <span className="badge-o ok">set</span>
            <button className="btn small" onClick={() => setEditing(true)}>Replace</button>
            <button className="btn small danger" onClick={async () => onChange(await window.harness.releaseClearSecret(kind, 'project'))}>Clear</button>
          </>
        ) : (
          <form className="row" onSubmit={(e) => (e.preventDefault(), value.trim() && void save())}>
            <input className="input" type="password" style={{ width: 200 }} value={value} onChange={(e) => setValue(e.target.value)} placeholder={kind === 'discordWebhook' ? 'https://discord.com/api/webhooks/...' : 'Open Cloud API key'} autoComplete="off" spellCheck={false} aria-label={label} />
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as SecretScope)} aria-label="Scope">
              <option value="project">this project</option>
              <option value="global">all projects</option>
            </select>
            <button className="btn small primary" disabled={!value.trim()}>Save</button>
            {editing && <button type="button" className="btn small ghost" onClick={() => setEditing(false)}>Cancel</button>}
          </form>
        )}
      </div>
    </div>
  )
}

export function ReleasePage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [plan, setPlan] = useState<ReleasePlan | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadErr, setLoadErr] = useState<string | null>(null)
  const [checks, setChecks] = useState<CheckResult[]>([])
  const [mode, setMode] = useState<ReleaseMode>('studio')
  const [bump, setBump] = useState<BumpKind>('patch')
  const [versionType, setVersionType] = useState<VersionType>('Published')
  const [changelog, setChangelog] = useState('')
  const [notify, setNotify] = useState(true)
  const [push, setPush] = useState(true)
  const [confirm, setConfirm] = useState(false)
  const [running, setRunning] = useState(false)
  const [steps, setSteps] = useState<ReleaseStep[]>([])
  const [result, setResult] = useState<ReleaseResult | null>(null)
  const [history, setHistory] = useState<ReleaseHistoryEntry[]>([])
  const [secrets, setSecrets] = useState<ReleaseSecretsStatus | null>(null)
  const [settings, setSettings] = useState<ReleaseUserSettings | null>(null)

  const load = async () => {
    setLoading(true)
    setLoadErr(null)
    setChecks([])
    try {
      const p = await h.releasePlan()
      setPlan(p)
      setMode(p.mode)
      setBump(p.version.suggestedBump)
      setVersionType(p.versionType)
      setChangelog(p.changelog.markdown)
      setChecks(p.preflight.checks)
    } catch (e) {
      setLoadErr(errorText(e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!state.project) return
    void load()
    void h.releaseHistory().then(setHistory).catch(() => setHistory([]))
    void h.releaseSecretsStatus().then(setSecrets).catch(() => undefined)
    void h.releaseGetSettings().then(setSettings).catch(() => undefined)
  }, [state.project?.root])

  useEffect(() => {
    const offCheck = h.on('release:check', ({ result }) => setChecks((c) => [...c.filter((x) => x.id !== result.id), result]))
    const offStep = h.on('release:step', ({ step }) => setSteps((s) => [...s.filter((x) => x.id !== step.id), step]))
    const offGone = h.on('release:webhookGone', () => {
      actions.toast({ text: 'Discord webhook was deleted', detail: 'Notifications are off until you set a new one.', kind: 'err' })
      void h.releaseSecretsStatus().then(setSecrets)
    })
    return () => (offCheck(), offStep(), offGone())
  }, [actions])

  const rerunChecks = async () => {
    setChecks([])
    try {
      const r = await h.releasePreflight()
      setChecks(r.checks)
      setPlan((p) => (p ? { ...p, preflight: r } : p))
    } catch (e) {
      actions.toast({ text: 'Checks failed to run', detail: errorText(e), kind: 'err' })
    }
  }

  const blockers = useMemo(() => checks.filter((c) => c.blocking && c.status === 'fail'), [checks])
  const needsKey = mode !== 'studio' && !plan?.hasOpenCloudKey && !secrets?.openCloudApiKey
  const needsConfirm = mode === 'rojo' && !confirm
  const canRun = !!plan && !running && !blockers.length && !needsKey && !needsConfirm && (mode !== 'file' || !!plan.placeFile?.exists)

  const run = async () => {
    if (!plan) return
    setRunning(true)
    setSteps([])
    setResult(null)
    try {
      const r = await h.releaseRun({ mode, bump, changelog, versionType, placeId: plan.placeId, universeId: plan.universeId, confirmToken: mode === 'rojo' ? plan.rojo?.confirmToken : undefined, push, notify })
      setResult(r)
      setSteps(r.steps)
      if (r.ok) {
        actions.toast({ text: `Released ${r.record?.tag ?? ''}`, detail: r.nextAction, kind: 'ok', ms: 6000 })
        setHistory(await h.releaseHistory())
        void load()
      } else actions.toast({ text: 'Release stopped', detail: r.error, kind: 'err' })
    } catch (e) {
      actions.toast({ text: 'Release failed', detail: errorText(e), kind: 'err' })
    } finally {
      setRunning(false)
    }
  }

  const savePublish = async (patch: Partial<PublishConfig>) => {
    try {
      await h.releaseSetProjectPublish({ mode, versionType, placeId: plan?.placeId, universeId: plan?.universeId, ...patch })
      actions.toast({ text: 'Team release settings saved', detail: '.forge/project.json · shared on next sync', kind: 'ok' })
      void load()
    } catch (e) {
      actions.toast({ text: 'Could not save', detail: errorText(e), kind: 'err' })
    }
  }

  const choosePlaceFile = async () => {
    const path = await h.releaseChoosePlaceFile()
    if (!path) return
    setSettings(await h.releaseSetSettings({ placeFile: path }))
    void load()
  }

  if (!state.project) {
    return (
      <div className="page"><div className="page-inner"><div className="empty"><Icon name="rocket" /><span>Open a project to release it.</span></div></div></div>
    )
  }

  const v = plan?.version
  const nextVersion = v?.next[bump]

  return (
    <div className="page">
      <div className="page-inner release">
        <div className="page-head">
          <div>
            <h1>Release</h1>
            <div className="sub">{v ? `current ${v.current ?? 'none'} · ${plan?.changelog.commits.length ?? 0} commits since ${plan?.changelog.since ?? 'the start'}` : loading ? 'Planning...' : ''}</div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void load()} disabled={loading}><Icon name="restart" size={12} className={loading ? 'spin' : undefined} /> Refresh</button>
            <button className="btn primary" disabled={!canRun} onClick={() => void run()} title={blockers.length ? 'Blocking checks failed' : needsKey ? 'Set an Open Cloud API key first' : needsConfirm ? 'Confirm the rojo build first' : undefined}>
              <Icon name="rocket" size={12} /> {running ? 'Releasing...' : `Release ${nextVersion ?? ''}`}
            </button>
          </div>
        </div>
        {loadErr && <div className="callout err">{loadErr}</div>}

        {plan && (
          <>
            {plan.warnings.map((w, i) => <div key={i} className="callout warn">{w}</div>)}

            <section className="set-sec">
              <h2>How</h2>
              <div className="mode-grid">
                {(['studio', 'rojo', 'file'] as ReleaseMode[]).map((m) => (
                  <button key={m} className={`mode-card${mode === m ? ' on' : ''}`} onClick={() => setMode(m)} disabled={m === 'rojo' && !plan.detection.fullyManaged} title={m === 'rojo' && !plan.detection.fullyManaged ? plan.detection.reasons.join('\n') : undefined}>
                    <span className="row"><span className={`radio${mode === m ? ' on' : ''}`} /><b>{MODE_LABEL[m]}</b>{plan.detection.mode === m && <span className="tag">{plan.detection.source}</span>}</span>
                    <span className="note">{MODE_DESC[m]}</span>
                  </button>
                ))}
              </div>
              {mode !== plan.mode && <div className="row-end"><span className="note grow">Make {MODE_LABEL[mode]} the team default?</span><button className="btn small" onClick={() => void savePublish({ mode })}>Save to project</button></div>}
              {mode === 'rojo' && plan.rojo && (
                <div className="vbox">
                  <div className="set-title">The build replaces these services in the live place</div>
                  <div className="row" style={{ flexWrap: 'wrap', gap: 4, margin: '6px 0' }}>{plan.rojo.services.map((s) => <span key={s} className="tag info">{s}</span>)}</div>
                  {plan.rojo.warnings.map((w, i) => <div key={i} className="warn-text">{w}</div>)}
                  <label className="row" style={{ marginTop: 6 }}><input type="checkbox" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} /> I understand anything not in the repo is removed from those services.</label>
                </div>
              )}
              {mode === 'file' && (
                <div className="set-row">
                  <div className="set-text">
                    <div className="set-title">Place file</div>
                    <div className="note ellipsis mono">{plan.placeFile?.path ?? settings?.placeFile ?? 'none chosen'}</div>
                    {plan.placeFile && !plan.placeFile.exists && <div className="err-text">File not found.</div>}
                    {plan.placeFile?.stale && <div className="warn-text">Exported before your latest commit. Export again from Studio.</div>}
                    {plan.placeFile?.unsupportedClasses?.length ? <div className="warn-text">Open Cloud will not update: {plan.placeFile.unsupportedClasses.join(', ')}</div> : null}
                  </div>
                  <div className="set-ctl"><button className="btn small" onClick={() => void choosePlaceFile()}>Choose...</button></div>
                </div>
              )}
              {mode !== 'studio' && (
                <div className="set-row">
                  <div className="set-text"><div className="set-title">Save as</div><div className="note">Saved versions are not live until published.</div></div>
                  <div className="set-ctl">
                    <div className="seg">{(['Published', 'Saved'] as VersionType[]).map((t) => <button key={t} className={versionType === t ? 'on' : ''} onClick={() => setVersionType(t)}>{t}</button>)}</div>
                  </div>
                </div>
              )}
            </section>

            <section className="set-sec">
              <h2>Version</h2>
              <div className="bump-row">
                {(['patch', 'minor', 'major'] as BumpKind[]).map((b) => (
                  <button key={b} className={`bump${bump === b ? ' on' : ''}`} onClick={() => setBump(b)}>
                    <span className="mono">{v?.next[b]}</span>
                    <span className="note">{b}{v?.suggestedBump === b ? ' · suggested' : ''}</span>
                  </button>
                ))}
              </div>
              <div className="note" style={{ marginTop: 6 }}>Recorded as {v?.storage === 'project' ? 'a tag and .forge/project.json' : 'a git tag'}{v?.latestTag ? ` · latest tag ${v.latestTag}` : ''}</div>
            </section>

            <section className="set-sec">
              <h2>Checks <span className="grow" /><button className="link-btn" onClick={() => void rerunChecks()}>run again</button></h2>
              {checks.map((c) => (
                <div key={c.id} className="lrow static check" title={c.details?.join('\n')}>
                  <span className={`badge-o ${CHECK_BADGE[c.status]}`} style={{ minWidth: 52, justifyContent: 'center' }}>{c.status}</span>
                  <span className="grow ellipsis">{c.label}{c.blocking ? '' : <span className="faint"> · advisory</span>}</span>
                  <span className="sub ellipsis" style={{ maxWidth: '50%' }}>{c.summary}</span>
                </div>
              ))}
              {!checks.length && <div className="lrow static"><span className="spinner" /> <span className="note">Running checks...</span></div>}
            </section>

            <section className="set-sec">
              <h2>Changelog <span className="grow" /><span className="note">{plan.changelog.authors.join(', ')}</span></h2>
              <textarea className="input mono changelog" rows={10} value={changelog} onChange={(e) => setChangelog(e.target.value)} spellCheck={false} aria-label="Changelog" />
              {plan.changelog.studio.length > 0 && <div className="note">{plan.changelog.studio.length} Studio edits pulled since the last release.</div>}
              <div className="row" style={{ marginTop: 8, gap: 16 }}>
                <label className="row"><input type="checkbox" checked={push} onChange={(e) => setPush(e.target.checked)} /> Push tag to the remote</label>
                <label className="row"><input type="checkbox" checked={notify} onChange={(e) => setNotify(e.target.checked)} disabled={!secrets?.discordWebhook} /> Post to Discord</label>
              </div>
            </section>
          </>
        )}

        {(steps.length > 0 || result) && (
          <section className="set-sec">
            <h2>Progress</h2>
            <div className="steps">
              {(['preflight', 'build', 'publish', 'version', 'tag', 'push', 'notify'] as ReleaseStepId[]).map((id) => {
                const s = steps.find((x) => x.id === id)
                if (!s) return null
                return (
                  <div key={id} className={`step ${s.state}`} title={s.message}>
                    {s.state === 'running' ? <span className="spinner" /> : <Icon name={s.state === 'done' ? 'check' : s.state === 'failed' ? 'err' : 'more'} size={12} />}
                    <span>{STEP_LABEL[id]}</span>
                    {s.message && <span className="faint ellipsis">{s.message}</span>}
                  </div>
                )
              })}
            </div>
            {result?.error && <div className="callout err">{result.error}</div>}
            {result?.nextAction && <div className="callout info">{result.nextAction}</div>}
          </section>
        )}

        <section className="set-sec">
          <h2>History</h2>
          {!history.length && <div className="note">No releases yet.</div>}
          {history.map((r) => (
            <div key={r.tag} className="lrow static" title={r.changelog}>
              <span className="mono">{r.tag}</span>
              <span className="tag">{r.mode ?? 'studio'}</span>
              {r.placeVersion !== undefined && <span className="sub">place v{r.placeVersion}</span>}
              <span className="grow ellipsis sub">{r.by} · {ago(r.at)}</span>
              {r.studioPublishPending ? (
                <button className="btn small primary" onClick={async () => { await h.releaseMarkStudioPublished(r.tag); setHistory(await h.releaseHistory()) }}>Mark published</button>
              ) : (
                <span className="badge-o ok">{r.versionType === 'Saved' ? 'saved' : 'live'}</span>
              )}
            </div>
          ))}
        </section>

        <section className="set-sec">
          <h2>Keys and notifications</h2>
          <p className="note">
            Open Cloud scopes: <span className="mono">universe-places:write</span> to publish; add <span className="mono">asset:read</span> + <span className="mono">asset:write</span> (Assets API) so the Art page can import images with the same key.
          </p>
          {secrets && (
            <>
              <SecretRow kind="openCloudApiKey" label="Open Cloud API key" set={secrets.openCloudApiKey} onChange={setSecrets} />
              <SecretRow kind="discordWebhook" label="Discord webhook" set={secrets.discordWebhook} hint={secrets.webhookHint} onChange={setSecrets} />
            </>
          )}
          {settings && (
            <div className="set-row">
              <div className="set-text">
                <div className="set-title">Post to Discord on</div>
                <div className="row" style={{ flexWrap: 'wrap', gap: 6, marginTop: 6 }}>
                  {(Object.keys(NOTIFY_LABEL) as (keyof NotificationToggles)[]).map((k) => (
                    <label key={k} className={`chip${settings.notifications[k] ? ' on' : ''}`}>
                      <input type="checkbox" className="sr-only" checked={settings.notifications[k]} onChange={async (e) => setSettings(await h.releaseSetSettings({ notifications: { ...settings.notifications, [k]: e.target.checked } }))} />
                      {NOTIFY_LABEL[k]}
                    </label>
                  ))}
                </div>
              </div>
              <div className="set-ctl">
                <button
                  className="btn small"
                  disabled={!secrets?.discordWebhook}
                  onClick={async () => {
                    const r = await h.releaseTestNotify()
                    actions.toast(r.sent ? { text: 'Test message sent', kind: 'ok' } : { text: 'Nothing sent', detail: r.error ?? r.skipped, kind: r.error ? 'err' : 'info' })
                  }}
                >
                  Send test
                </button>
              </div>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
