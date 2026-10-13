// Forge tab: the project dashboard. Quick create actions, service health with restart and logs,
// features, recent files and the project's state at a glance. Without a project: open or join.
import { useMemo } from 'react'
import type { ServiceStatus } from '@shared/types'
import { useStore, type CreateKind } from '../store'
import { Icon, type IconName } from '../components/Icons'
import { AnvilMark } from '../components/Brand'
import { FileGlyph } from '../components/ClassIcon'
import { featuresOf, scriptsFlat, basename } from '../lib/roblox'
import { keyHint, ago } from '../lib/format'
import { useProblems } from '../shell/problems'

const STATE_BADGE: Record<ServiceStatus['state'], string> = { running: 'ok', starting: 'info', stopped: '', crashed: 'err', missing: 'warn' }

function Welcome() {
  const { actions } = useStore()
  return (
    <div className="page">
      <div className="page-inner welcome">
        <div className="welcome-mark"><AnvilMark size={40} /></div>
        <h1>RBX Forge</h1>
        <p className="note">An editor for Roblox games built with Rojo. Open a project folder, or join your team's game from a git URL.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => void actions.openProject()}><Icon name="folder" size={13} /> Open folder...</button>
          <button className="btn" onClick={() => actions.openDialog({ kind: 'joinProject' })}><Icon name="download" size={13} /> Join a project...</button>
        </div>
        <div className="welcome-keys">
          <span><span className="kc">{keyHint('mod+k')}</span> commands</span>
          <span><span className="kc">{keyHint('mod+p')}</span> go to file</span>
          <span><span className="kc">{keyHint('mod+comma')}</span> settings</span>
        </div>
      </div>
    </div>
  )
}

export function ForgePage() {
  const { state, actions } = useStore()
  const problems = useProblems()
  const scripts = useMemo(() => scriptsFlat(state.scripts), [state.scripts])
  const features = useMemo(() => featuresOf(scripts), [scripts])
  if (!state.project) return <Welcome />

  const place = state.places.find((p) => p.file === state.activePlace)
  const errors = problems.filter((p) => p.severity === 'error').length
  const git = state.git
  const create = (kind: CreateKind) => {
    actions.showSide('explorer')
    actions.requestCreate(kind)
  }
  const QUICK: { label: string; icon: IconName; hint?: string; run: () => void }[] = [
    { label: 'New feature', icon: 'trio', hint: 'shared + Service + Controller', run: () => create('Feature') },
    { label: 'New ModuleScript', icon: 'filePlus', run: () => create('ModuleScript') },
    { label: 'New Script', icon: 'script', hint: 'server', run: () => create('Script') },
    { label: 'New LocalScript', icon: 'script', hint: 'client', run: () => create('LocalScript') },
    { label: 'New Blink event', icon: 'bolt', run: () => actions.openDialog({ kind: 'blinkEvent' }) },
    { label: 'Run tests', icon: 'flask', run: () => (actions.showSide('tests'), void actions.runTests({ scope: { kind: 'all' } })) },
    { label: 'Packages', icon: 'package', run: () => actions.openPage('packages') },
    { label: 'Release', icon: 'rocket', run: () => actions.openPage('release') },
    { label: 'Analytics', icon: 'chart', run: () => actions.openPage('analytics') }
  ]

  return (
    <div className="page">
      <div className="page-inner forge">
        <div className="page-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <h1 className="ellipsis"><span className="ast">*</span> {state.project.name}</h1>
            <div className="sub ellipsis mono" title={state.project.root}>{state.project.root}</div>
          </div>
          <div className="actions">
            {place && <span className="badge-o">{place.name}</span>}
            {git?.isRepo && <span className={`badge-o ${git.conflicts.length ? 'err' : git.behind || git.ahead ? 'warn' : 'ok'}`}>{git.branch ?? 'detached'} {git.behind ? `↓${git.behind}` : ''}{git.ahead ? ` ↑${git.ahead}` : ''}</span>}
            <button className={`badge-o ${errors ? 'err' : problems.length ? 'warn' : 'ok'}`} onClick={() => actions.showBottom('problems')}>{problems.length ? `${problems.length} problems` : 'no problems'}</button>
          </div>
        </div>

        <div className="dash">
          <section className="dcard quick">
            <h2>Create</h2>
            <div className="quick-grid">
              {QUICK.map((q) => (
                <button key={q.label} className="qbtn" onClick={q.run} title={q.hint}>
                  <Icon name={q.icon} size={14} />
                  <span className="ellipsis">{q.label}</span>
                </button>
              ))}
            </div>
          </section>

          <section className="dcard">
            <h2>Services <span className="grow" /><button className="link-btn" onClick={() => actions.showBottom('output')}>logs</button></h2>
            {state.services.map((s) => (
              <div key={s.id} className="lrow static">
                <span className={`badge-o ${STATE_BADGE[s.state]}`} style={{ minWidth: 70, justifyContent: 'center' }}>{s.state}</span>
                <span className="grow ellipsis" title={s.detail}>
                  {s.label}
                  {s.detail && <span className="faint"> · {s.detail}</span>}
                </span>
                {s.restarts > 0 && <span className="sub" title="Restarts">{s.restarts}x</span>}
                <button className="icon-btn" title={`Logs for ${s.label}`} onClick={() => actions.showBottom('output', [s.id])}><Icon name="terminal" size={13} /></button>
                <button className="icon-btn" title={`Restart ${s.label}`} disabled={s.state === 'missing'} onClick={() => void actions.restartService(s.id)}><Icon name="restart" size={13} /></button>
              </div>
            ))}
            {!state.services.length && <div className="note">No services.</div>}
          </section>

          <section className="dcard">
            <h2>Features <span className="count">{features.length}</span><span className="grow" /><button className="link-btn" onClick={() => create('Feature')}>new</button></h2>
            {features.slice(0, 10).map((f) => {
              const complete = !!(f.shared && f.service && f.controller)
              return (
                <div key={f.name} className="lrow" onClick={() => void actions.openFile((f.service ?? f.shared ?? f.controller)!)} title={[f.shared, f.service, f.controller].filter(Boolean).join('\n')}>
                  <Icon name="trio" size={13} />
                  <span className="grow ellipsis">{f.name}</span>
                  {!complete && <span className="tag warn">partial</span>}
                  <span className="sub">{[f.shared && 'sh', f.service && 'sv', f.controller && 'ct'].filter(Boolean).join(' ')}</span>
                </div>
              )
            })}
            {!features.length && <div className="note">No features yet. A feature is a shared module, a server Service and a client Controller.</div>}
          </section>

          <section className="dcard">
            <h2>Recent</h2>
            {state.recent.slice(0, 10).map((p) => (
              <div key={p} className="lrow" onClick={() => void actions.openFile(p)} title={p}>
                <FileGlyph path={p} size={14} />
                <span className="grow ellipsis">{basename(p)}</span>
                <span className="sub ellipsis" style={{ maxWidth: '50%' }}>{p.split('/').slice(0, -1).join('/')}</span>
              </div>
            ))}
            {!state.recent.length && <div className="note">Files you open show up here. <span className="kc">{keyHint('mod+p')}</span> to find one.</div>}
          </section>

          <section className="dcard">
            <h2>Team</h2>
            <div className="lrow" onClick={() => actions.showSide('sync')}>
              <Icon name="sync" size={13} />
              <span className="grow">{git?.isRepo ? (git.lastSync ? `last sync ${ago(git.lastSync)}` : 'not synced yet') : 'not a git repository'}</span>
              {git && git.dirty > 0 && <span className="sub">{git.dirty} changed</span>}
            </div>
            <div className="lrow" onClick={() => actions.showSide('sync')}>
              <Icon name="diff" size={13} />
              <span className="grow">Studio conflicts</span>
              <span className={state.studioConflicts.length ? 'count-dot' : 'sub'}>{state.studioConflicts.length}</span>
            </div>
            <div className="lrow" onClick={() => actions.showSide('team')}>
              <Icon name="team" size={13} />
              <span className="grow">Claims</span>
              <span className="sub">{state.claims.length}</span>
            </div>
            <div className="lrow" onClick={() => actions.showSide('tests')}>
              <Icon name="flask" size={13} />
              <span className="grow">Tests</span>
              <span className="sub">{state.tests.last ? `${state.tests.last.passed} passed · ${state.tests.last.failed} failed` : 'not run'}</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
