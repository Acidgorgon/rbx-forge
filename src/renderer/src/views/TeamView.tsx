// Team: who is working on what (claims), activity feed (commits + Studio pulls), open pull requests,
// history of the active file, team settings (.forge/project.json) and join-project.
import { useEffect, useState } from 'react'
import type { ActivityEntry, FileHistoryEntry, ForgeProjectConfigRead, OpenPullRequests } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText } from '../lib/format'
import { basename } from '../lib/roblox'

export function TeamView() {
  const { state, actions } = useStore()
  const [feed, setFeed] = useState<ActivityEntry[] | null>(null)
  const [who, setWho] = useState('')
  const [prs, setPrs] = useState<OpenPullRequests | null>(null)
  const [history, setHistory] = useState<FileHistoryEntry[] | null>(null)
  const [claimText, setClaimText] = useState('')
  const [config, setConfig] = useState<ForgeProjectConfigRead | null>(null)
  const [configText, setConfigText] = useState('')
  const [configOpen, setConfigOpen] = useState(false)
  const [configErr, setConfigErr] = useState<string | null>(null)
  const h = window.harness

  const loadFeed = () => void h.activityFeed({ limit: 30, author: who.trim() || undefined }).then(setFeed).catch(() => setFeed([]))
  useEffect(() => {
    if (!state.project) return
    loadFeed()
    void h.listOpenPRs().then(setPrs).catch((e) => setPrs({ available: false, prs: [], reason: errorText(e) }))
    void h.listClaims().then((claims) => actions.set({ claims })).catch(() => undefined)
    void h.getForgeConfig().then((c) => {
      setConfig(c)
      setConfigText(JSON.stringify(c.config, null, 2))
    }).catch(() => undefined)
  }, [state.project?.root])
  useEffect(() => {
    if (!state.activeFile || !state.git?.isRepo) return setHistory(null)
    void h.fileHistory(state.activeFile, 8).then(setHistory).catch(() => setHistory(null))
  }, [state.activeFile, state.git?.isRepo])

  const claim = async (what: string) => {
    try {
      actions.set({ claims: await h.claim(what) })
      setClaimText('')
    } catch (e) {
      actions.toast({ text: 'Could not claim', detail: errorText(e), kind: 'err' })
    }
  }
  const saveConfig = async () => {
    setConfigErr(null)
    try {
      const saved = await h.setForgeConfig(JSON.parse(configText))
      setConfig({ exists: true, config: saved })
      setConfigText(JSON.stringify(saved, null, 2))
      actions.toast({ text: 'Team settings saved', detail: '.forge/project.json · shared on next sync', kind: 'ok' })
    } catch (e) {
      setConfigErr(errorText(e))
    }
  }

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Team</span>
        <button className="icon-btn" title="Join a project…" onClick={() => actions.openDialog({ kind: 'joinProject' })}>
          <Icon name="download" size={14} />
        </button>
        <button className="icon-btn" title="Refresh" onClick={loadFeed}>
          <Icon name="restart" size={14} />
        </button>
      </div>
      <div className="panel-body">
        {!state.project ? (
          <div className="empty">
            <Icon name="team" />
            <span>Join your team's game, or open a project.</span>
            <div className="row">
              <button className="btn primary" onClick={() => actions.openDialog({ kind: 'joinProject' })}>Join a project…</button>
              <button className="btn" onClick={() => void actions.openProject()}>Open folder…</button>
            </div>
          </div>
        ) : (
          <>
            <section className="vsec">
              <div className="vsec-head">Claims <span className="count">{state.claims.length}</span></div>
              <div className="row" style={{ padding: '0 10px 6px' }}>
                <input className="input grow" placeholder={state.activeFile ? `claim ${basename(state.activeFile)} or a feature` : 'claim a file or feature'} value={claimText} onChange={(e) => setClaimText(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && (claimText.trim() || state.activeFile) && void claim(claimText.trim() || state.activeFile!)} spellCheck={false} />
                <button className="btn" disabled={!claimText.trim() && !state.activeFile} onClick={() => void claim(claimText.trim() || state.activeFile!)}>Claim</button>
              </div>
              {!state.claims.length && <div className="note" style={{ padding: '0 12px' }}>Nobody has claimed anything. Claims tell teammates what you are editing.</div>}
              {state.claims.map((c) => (
                <div key={`${c.who}:${c.what}`} className="lrow static" title={`${c.what}\n${c.who} since ${c.since}${c.note ? `\n${c.note}` : ''}${c.contested ? `\nAlso claimed by ${c.others.join(', ')}` : ''}`}>
                  <span className="who">{c.who.slice(0, 1).toUpperCase()}</span>
                  <span className="grow ellipsis">{c.what}</span>
                  {c.contested && <span className="tag warn">contested</span>}
                  {c.stale && <span className="tag">stale</span>}
                  <span className="sub">{c.mine ? 'you' : c.who}</span>
                  {c.mine && (
                    <button className="row-act" style={{ display: 'grid' }} title="Release" onClick={() => void h.releaseClaim(c.what).then((claims) => actions.set({ claims }))}>
                      <Icon name="x" size={11} />
                    </button>
                  )}
                </div>
              ))}
            </section>

            <section className="vsec">
              <div className="vsec-head">
                Pull requests {prs?.prs.length ? <span className="count">{prs.prs.length}</span> : null}
                <span className="grow" />
                <button className="link-btn" onClick={() => actions.openDialog({ kind: 'pullRequest' })} disabled={!state.git?.hasRemote}>open PR</button>
              </div>
              {prs && !prs.available && <div className="note" style={{ padding: '0 12px' }}>{prs.reason ?? 'GitHub CLI is not available.'}</div>}
              {prs?.available && !prs.prs.length && <div className="note" style={{ padding: '0 12px' }}>No open pull requests.</div>}
              {prs?.prs.map((p) => (
                <div key={p.number} className="lrow" onClick={() => window.open(p.url, '_blank')} title={`${p.branch} · ${p.author}`}>
                  <Icon name="pr" size={13} />
                  <span className="grow ellipsis">#{p.number} {p.title}</span>
                  {p.draft && <span className="tag">draft</span>}
                  <span className="sub">{p.author}</span>
                </div>
              ))}
            </section>

            <section className="vsec">
              <div className="vsec-head">Activity</div>
              <div className="row" style={{ padding: '0 10px 6px' }}>
                <input className="input grow" placeholder="filter by author, or Studio" value={who} onChange={(e) => setWho(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && loadFeed()} spellCheck={false} />
              </div>
              {feed === null && <div className="lrow static"><span className="spinner" /></div>}
              {feed?.length === 0 && <div className="note" style={{ padding: '0 12px' }}>No activity yet.</div>}
              {feed?.map((a, i) => (
                <div key={i} className="lrow" onClick={() => a.files[0] && void actions.openFile(a.files[0].path)} title={`${a.message}\n${a.files.map((f) => `${f.change} ${f.path}`).join('\n')}`}>
                  <span className="who" style={a.kind === 'studio' ? { background: 'var(--realm-studio)' } : undefined}>{a.kind === 'studio' ? 'S' : a.who.slice(0, 1).toUpperCase()}</span>
                  <span className="grow ellipsis">{a.message}</span>
                  <span className="sub">{a.files.length}f · {ago(a.at)}</span>
                </div>
              ))}
            </section>

            {history && state.activeFile && (
              <section className="vsec">
                <div className="vsec-head">History · {basename(state.activeFile)}</div>
                {!history.length && <div className="note" style={{ padding: '0 12px' }}>Not committed yet.</div>}
                {history.map((e) => (
                  <div key={e.commit} className="lrow static" title={`${e.commit}\n${e.path}`}>
                    <span className="who">{e.author.slice(0, 1).toUpperCase()}</span>
                    <span className="grow ellipsis">{e.subject}</span>
                    <span className="sub">{ago(e.at)}</span>
                  </div>
                ))}
              </section>
            )}

            <section className="vsec">
              <div className="vsec-head">
                Problems
                <span className="grow" />
                <button className="link-btn" onClick={() => void actions.runLint()}>run lint</button>
              </div>
              <div className="lrow" onClick={() => actions.showBottom('problems')}>
                <Icon name="warn" size={13} />
                <span className="grow">{state.lint.length} lint problem{state.lint.length === 1 ? '' : 's'}</span>
                <span className="sub">{state.lintAt ? ago(state.lintAt) : 'not run'}</span>
              </div>
            </section>

            <section className="vsec">
              <div className="vsec-head" style={{ cursor: 'pointer' }} onClick={() => setConfigOpen(!configOpen)}>
                <Icon name={configOpen ? 'chevDown' : 'chev'} size={12} /> Team settings
                <span className="grow" />
                <span className="sub" style={{ textTransform: 'none' }}>{config?.exists ? '.forge/project.json' : 'defaults'}</span>
              </div>
              {configOpen && (
                <div className="textarea-box">
                  <textarea className="input mono" rows={10} value={configText} onChange={(e) => setConfigText(e.target.value)} spellCheck={false} />
                  {config?.issues?.map((i, k) => <div key={k} className="warn-text">{i.path}: {i.message}</div>)}
                  {configErr && <div className="err-text">{configErr}</div>}
                  <div className="row-end">
                    <span className="note grow">Committed and shared. Never put secrets here.</span>
                    <button className="btn primary" onClick={() => void saveConfig()}>Save</button>
                  </div>
                </div>
              )}
            </section>
          </>
        )}
      </div>
    </>
  )
}
