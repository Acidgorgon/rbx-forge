// Source control & Sync: Source control on top (stage, commit with your message, pull / push; see
// SourceControlSection), then Forge Sync, team sync (Sync now), incoming changes (grouped by feature),
// local changes, Studio conflicts (open as diff tabs), pre-sync check, feature branch / PR, settings.
import { useEffect, useState } from 'react'
import type { IncomingChanges, PreSyncReport, SyncSettings } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText, keyHint } from '../lib/format'
import { basename } from '../lib/roblox'
import { sparks } from '../lib/sparks'
import { ForgeSyncSection, useForgeSync } from './ForgeSyncSection'
import { SourceControlSection } from './SourceControlSection'
import { useScm } from './scmState'

const STATUS_LETTER: Record<string, string> = { added: 'A', modified: 'M', deleted: 'D', renamed: 'R', copied: 'C', typechange: 'T', untracked: 'U', conflicted: '!', unknown: '?' }

export function SyncView() {
  const { state, actions } = useStore()
  const git = state.git
  const [syncing, setSyncing] = useState(false)
  const [incoming, setIncoming] = useState<IncomingChanges | null>(null)
  const [loadingIncoming, setLoadingIncoming] = useState(false)
  const [check, setCheck] = useState<PreSyncReport | null>(null)
  const [checking, setChecking] = useState(false)
  const [remote, setRemote] = useState('')
  const [settings, setSettings] = useState<SyncSettings | null>(state.syncSettings)
  const [forgeSync, setForgeSync] = useForgeSync()
  const scm = useScm()

  useEffect(() => {
    void actions.refreshSync()
  }, [actions])
  useEffect(() => setSettings(state.syncSettings), [state.syncSettings])

  const loadIncoming = async (summarize = false) => {
    setLoadingIncoming(true)
    try {
      setIncoming(await window.harness.incomingChanges({ summarize }))
    } catch (e) {
      actions.toast({ text: 'Could not read incoming changes', detail: errorText(e), kind: 'err' })
    } finally {
      setLoadingIncoming(false)
    }
  }
  useEffect(() => {
    if (git?.isRepo) void loadIncoming()
  }, [git?.isRepo, git?.behind])

  const syncNow = async (el: HTMLElement) => {
    setSyncing(true)
    try {
      const g = await window.harness.syncNow()
      actions.set({ git: g })
      if (!g.error && !g.conflicts.length) {
        sparks(el)
        actions.toast({ text: 'Synced with collaborators', kind: 'ok', ms: 3000 })
      }
      void loadIncoming()
    } catch (e) {
      actions.toast({ text: 'Sync failed', detail: errorText(e), kind: 'err' })
    } finally {
      setSyncing(false)
    }
  }

  const runCheck = async () => {
    setChecking(true)
    try {
      setCheck(await window.harness.preSyncCheck())
    } catch (e) {
      actions.toast({ text: 'Pre-sync check failed', detail: errorText(e), kind: 'err' })
    } finally {
      setChecking(false)
    }
  }

  const saveSettings = (s: SyncSettings) => {
    setSettings(s)
    void window.harness.setSyncSettings(s).then(() => actions.set({ syncSettings: s }))
  }

  const inSync = !!git?.isRepo && !git.behind && !git.ahead && !git.conflicts.length && !git.error

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Source control</span>
        <button className="icon-btn" title="Refresh" onClick={() => (void actions.refreshSync(), void loadIncoming())}>
          <Icon name="restart" size={14} />
        </button>
        <button className="icon-btn" title="Start feature branch…" onClick={() => actions.openDialog({ kind: 'featureBranch' })} disabled={!git?.isRepo}>
          <Icon name="branch" size={14} />
        </button>
        <button className="icon-btn" title="Open pull request…" onClick={() => actions.openDialog({ kind: 'pullRequest' })} disabled={!git?.hasRemote}>
          <Icon name="pr" size={14} />
        </button>
      </div>
      <div className="panel-body">
        {state.project && git?.isRepo && <SourceControlSection />}
        {state.project && <ForgeSyncSection status={forgeSync} setStatus={setForgeSync} />}
        {!state.project ? (
          <div className="empty"><Icon name="branch" /><span>Open a project first.</span></div>
        ) : git && !git.isRepo ? (
          <div className="vbox">
            <div style={{ marginBottom: 6 }}>Not a git repository yet.</div>
            <div className="note" style={{ marginBottom: 8 }}>Add your team's remote so Forge can pull and push for you.</div>
            <input className="input" style={{ width: '100%', marginBottom: 8 }} placeholder="https://github.com/you/game.git (optional)" value={remote} onChange={(e) => setRemote(e.target.value)} spellCheck={false} />
            <div className="row">
              <button className="btn primary" onClick={async () => actions.set({ git: await window.harness.initGit(remote.trim() || undefined) })}>Init git</button>
              <button className="btn ghost" onClick={() => actions.openDialog({ kind: 'joinProject' })}>Join a project…</button>
            </div>
          </div>
        ) : git ? (
          <>
            <div className="vbox">
              <div className="row">
                <span className={`badge-o ${git.conflicts.length || git.error ? 'err' : inSync ? 'ok' : 'warn'}`}>
                  {git.conflicts.length ? 'conflict' : git.error ? 'failed' : inSync ? 'in sync' : git.behind ? `${git.behind} behind` : `${git.ahead} ahead`}
                </span>
                <span className="grow ellipsis">Team sync{git.hasRemote ? '' : ' · no remote'}</span>
              </div>
              <div className="row note">
                <span>{git.dirty} changed · last sync {ago(git.lastSync)}{settings?.autoSyncMinutes ? ` · auto every ${settings.autoSyncMinutes} min` : ''}</span>
              </div>
              {git.error && git.error !== scm.error && <div className="err-text">{git.error}</div>}
              {git.note && <div className="note warn">{git.note}</div>}
              <div className="row" style={{ marginTop: 8 }}>
                <button className="btn primary" onClick={(e) => void syncNow(e.currentTarget)} disabled={syncing || !git.hasRemote}>
                  <Icon name="sync" size={12} className={syncing ? 'spin' : undefined} /> {syncing ? 'Syncing…' : 'Sync now'}
                </button>
                <span className="kc">{keyHint('mod+shift+s')}</span>
              </div>
            </div>

            {forgeSync?.engine !== 'forge' && <section className="vsec">
              <div className="vsec-head">Studio conflicts <span className="count">{state.studioConflicts.length}</span></div>
              {state.studioConflicts.length === 0 ? (
                <div className="note" style={{ padding: '0 12px' }}>Nothing held. Scripts edited in Studio flow into the repo.</div>
              ) : (
                state.studioConflicts.map((c) => (
                  <div key={c.path} className="lrow" onClick={() => actions.openConflict(c.path)} title={c.path}>
                    <Icon name="diff" size={14} style={{ color: 'var(--warn)' }} />
                    <span className="grow ellipsis">{basename(c.path)}</span>
                    <span className="sub">compare</span>
                  </div>
                ))
              )}
            </section>}

            <section className="vsec">
              <div className="vsec-head">
                Incoming {incoming && <span className="count">{incoming.commits.length}</span>}
                <span className="grow" />
                {loadingIncoming && <span className="spinner" />}
                <button className="link-btn" onClick={() => void loadIncoming(true)} disabled={loadingIncoming} title="Summarise the incoming changes with the assistant">summarize</button>
              </div>
              {incoming?.fetchError && <div className="warn-text" style={{ padding: '0 12px' }}>{incoming.fetchError}</div>}
              {incoming?.summary && <div className="vbox selectable" style={{ whiteSpace: 'pre-wrap' }}>{incoming.summary}</div>}
              {incoming && !incoming.commits.length && <div className="note" style={{ padding: '0 12px' }}>Up to date with {incoming.upstream ?? 'the remote'}.</div>}
              {incoming?.commits.slice(0, 8).map((c) => (
                <div key={c.hash} className="lrow static" title={`${c.hash}\n${c.email}`}>
                  <span className="who">{c.author.slice(0, 1).toUpperCase()}</span>
                  <span className="grow ellipsis">{c.subject}</span>
                  <span className="sub">{ago(c.at)}</span>
                </div>
              ))}
              {incoming?.groups.map((g) => (
                <div key={g.key}>
                  <div className="lrow static" style={{ color: 'var(--fg-muted)', fontSize: 11 }}>{g.label}</div>
                  {g.items.map((f) => (
                    <div key={f.path} className="lrow" style={{ paddingLeft: 22 }} onClick={() => void actions.openFile(f.path)} title={f.path}>
                      <span className="mono faint" style={{ width: 10 }}>{STATUS_LETTER[f.status]}</span>
                      <span className="grow ellipsis">{basename(f.path)}</span>
                      {incoming.overlap.includes(f.path) && <span className="tag warn" title="Also changed locally">overlap</span>}
                      <span className="sub"><span className="ok-text">+{f.added}</span> <span style={{ color: 'var(--err)' }}>−{f.deleted}</span></span>
                    </div>
                  ))}
                </div>
              ))}
              {incoming && incoming.local.length > 0 && (
                <>
                  <div className="lrow static" style={{ color: 'var(--fg-muted)', fontSize: 11 }}>Your local changes</div>
                  {incoming.local.map((f) => (
                    <div key={f.path} className="lrow" style={{ paddingLeft: 22 }} onClick={() => void actions.openFile(f.path)} title={f.path}>
                      <span className="mono faint" style={{ width: 10 }}>{STATUS_LETTER[f.status]}</span>
                      <span className="grow ellipsis">{basename(f.path)}</span>
                      <span className="sub">{f.feature ?? f.category}</span>
                    </div>
                  ))}
                </>
              )}
            </section>

            <section className="vsec">
              <div className="vsec-head">
                Pre-sync check
                <span className="grow" />
                <button className="link-btn" onClick={() => void runCheck()} disabled={checking}>{checking ? 'checking…' : 'run'}</button>
              </div>
              {check ? (
                <>
                  <div className="lrow static">
                    <span className={`badge-o ${check.ok ? (check.warnings ? 'warn' : 'ok') : 'err'}`}>{check.ok ? 'ok' : 'blocked'}</span>
                    <span className="sub">{check.files.length} files · {check.errors} errors · {check.warnings} warnings</span>
                  </div>
                  {check.problems.slice(0, 12).map((p, i) => (
                    <div key={i} className="lrow" style={{ paddingLeft: 22 }} onClick={() => void actions.openFileAt(p.path, p.line, p.col)}>
                      <Icon name={p.severity === 'error' ? 'err' : 'warn'} size={12} style={{ color: p.severity === 'error' ? 'var(--err)' : 'var(--warn)' }} />
                      <span className="grow ellipsis">{p.message}</span>
                      <span className="sub">{basename(p.path)}:{p.line}</span>
                    </div>
                  ))}
                  {check.notes.map((n, i) => <div key={i} className="note" style={{ padding: '0 12px' }}>{n}</div>)}
                </>
              ) : (
                <div className="note" style={{ padding: '0 12px' }}>selene + StyLua on the files you changed, before they reach your team.</div>
              )}
            </section>

            {settings && (
              <section className="vsec">
                <div className="vsec-head">Settings</div>
                <label className="lrow static">
                  <span className="grow">Auto sync every</span>
                  <input className="input" type="number" min={0} max={120} style={{ width: 56 }} value={settings.autoSyncMinutes} onChange={(e) => saveSettings({ ...settings, autoSyncMinutes: Math.max(0, Number(e.target.value) || 0) })} />
                  <span className="sub">min</span>
                </label>
                <label className="lrow static">
                  <span className="grow">Commit local work before pulling</span>
                  <input type="checkbox" className="switch" checked={settings.autoCommit} onChange={(e) => saveSettings({ ...settings, autoCommit: e.target.checked })} />
                </label>
              </section>
            )}
          </>
        ) : (
          <div className="empty"><span className="spinner" /></div>
        )}
      </div>
    </>
  )
}
