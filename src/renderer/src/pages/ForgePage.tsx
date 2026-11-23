// Forge tab: workflow status hub (Direct Forge Sync, Vanguards, Harbor Stack, StudioTurnLock),
// quick actions, service health with restart and logs, features, recent files, and project state.
import { useEffect, useMemo, useState } from 'react'
import { HARBOR_LIB_IDS } from '@shared/harborTypes'
import type { ForgeSyncSettings, HarborStatus, ServiceStatus, StudioLockStatus, SyncStatus, VanguardsStatus } from '@shared/types'
import { useStorePick, useActions, type CreateKind } from '../store'
import { Icon, type IconName } from '../components/Icons'
import { AnvilMark } from '../components/Brand'
import { FileGlyph } from '../components/ClassIcon'
import { featuresOf, scriptsFlat, basename } from '../lib/roblox'
import { keyHint, ago } from '../lib/format'
import { useProblems } from '../shell/problems'

const STATE_BADGE: Record<ServiceStatus['state'], string> = { running: 'ok', starting: 'info', stopped: '', crashed: 'err', missing: 'warn' }

function Welcome() {
  const actions = useActions()
  return (
    <div className="page">
      <div className="page-inner welcome">
        <div className="welcome-mark"><AnvilMark size={40} /></div>
        <h1>RBX Forge</h1>
        <p className="note">Roblox development workstation with Direct Forge Sync, Vanguards (<code>ror</code> / <code>rur</code> / <code>ree</code>) and the Harbor Stack.</p>
        <div className="row" style={{ justifyContent: 'center' }}>
          <button className="btn primary" onClick={() => actions.openDialog({ kind: 'newProject' })}><Icon name="folderPlus" size={13} /> New project...</button>
          <button className="btn" onClick={() => void actions.openProject()}><Icon name="folder" size={13} /> Open folder...</button>
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
  const actions = useActions()
  const state = useStorePick('activePlace', 'claims', 'git', 'places', 'project', 'recent', 'scripts', 'services', 'studioConflicts', 'tests')
  const problems = useProblems()
  const h = window.harness
  const scripts = useMemo(() => scriptsFlat(state.scripts), [state.scripts])
  const features = useMemo(() => featuresOf(scripts), [scripts])

  const [vg, setVg] = useState<VanguardsStatus | null>(null)
  const [hb, setHb] = useState<HarborStatus | null>(null)
  const [syncSet, setSyncSet] = useState<ForgeSyncSettings | null>(null)
  const [syncSt, setSyncSt] = useState<SyncStatus | null>(null)
  const [lockSt, setLockSt] = useState<StudioLockStatus | null>(null)

  useEffect(() => {
    if (!state.project) return
    void h.vanguardsStatus().then(setVg).catch(() => {})
    void h.harborStatus().then(setHb).catch(() => {})
    void h.forgeSyncSettings().then(setSyncSet).catch(() => {})
    void h.syncStatus().then(setSyncSt).catch(() => {})
    void h.studioLockStatus().then(setLockSt).catch(() => {})

    const offVg = h.on('vanguards:status', setVg)
    const offHb = h.on('harbor:status', setHb)
    const offSync = h.on('sync:status', setSyncSt)
    const offLock = h.on('studioLock:status', setLockSt)
    return () => {
      offVg()
      offHb()
      offSync()
      offLock()
    }
  }, [h, state.project?.root])

  if (!state.project) return <Welcome />

  const place = state.places.find((p) => p.file === state.activePlace)
  const errors = problems.filter((p) => p.severity === 'error').length
  const git = state.git
  const create = (kind: CreateKind) => {
    actions.showSide('explorer')
    actions.requestCreate(kind)
  }

  const syncEngine = syncSt?.engine ?? syncSet?.engine ?? 'forge'
  const syncLabel =
    syncEngine === 'forge-direct' ? 'Direct 2-way' : syncEngine === 'forge' ? 'Rojo Gated' : syncEngine === 'project' ? 'Project Sync' : 'Off'
  const connectedPlaces = syncSt?.places.filter((p) => p.connected).length ?? 0

  const detectedLibs = hb ? HARBOR_LIB_IDS.filter((id) => hb.libs[id].detected) : []
  const updatesBehind = vg?.repos ? Object.values(vg.repos).filter((r) => r.behind > 0).length : 0

  const QUICK: { label: string; icon: IconName; hint?: string; run: () => void }[] = [
    { label: 'New feature', icon: 'trio', hint: 'shared + Service + Controller', run: () => create('Feature') },
    { label: 'UI Preview (rur)', icon: 'monitor', hint: 'Lune + pixel-accurate rur renderer', run: () => actions.openPage('uipreview') },
    { label: 'Vanguards', icon: 'tool', hint: 'ror DX12, rur UI, ree, FM pipeline', run: () => actions.openPage('vanguards') },
    { label: 'Harbor Stack', icon: 'bolt', hint: 'Current, Ripple, Anchor, Tide, Lighthouse', run: () => actions.openPage('harbor') },
    { label: 'Model Lab', icon: 'cube', run: () => actions.openPage('model') },
    { label: 'UI Motion Lab', icon: 'tap', run: () => actions.openPage('uimotion') },
    { label: 'New Script', icon: 'script', hint: 'server', run: () => create('Script') },
    { label: 'New ModuleScript', icon: 'filePlus', run: () => create('ModuleScript') },
    { label: 'Run tests', icon: 'flask', run: () => (actions.showSide('tests'), void actions.runTests({ scope: { kind: 'all' } })) },
    { label: 'Memory & .md', icon: 'memory', run: () => actions.openPage('memory') },
    { label: 'Packages', icon: 'package', run: () => actions.openPage('packages') },
    { label: 'Release', icon: 'rocket', run: () => actions.openPage('release') }
  ]

  return (
    <div className="page">
      <div className="page-inner forge">
        <div className="page-head">
          <div className="grow" style={{ minWidth: 0 }}>
            <h1 className="ellipsis">
              <AnvilMark size={20} />
              <span className="ellipsis">{state.project.name}</span>
            </h1>
            <div className="sub ellipsis mono" title={state.project.root}>{state.project.root}</div>
          </div>
          <div className="actions">
            {place && <span className="badge-o">{place.name}</span>}
            {git?.isRepo && <span className={`badge-o ${git.conflicts.length ? 'err' : git.behind || git.ahead ? 'warn' : 'ok'}`}>{git.branch ?? 'detached'} {git.behind ? `↓${git.behind}` : ''}{git.ahead ? ` ↑${git.ahead}` : ''}</span>}
            <button className={`badge-o ${errors ? 'err' : problems.length ? 'warn' : 'ok'}`} onClick={() => actions.showBottom('problems')}>{problems.length ? `${problems.length} problems` : 'no problems'}</button>
          </div>
        </div>

        {/* Workflow Status Strip */}
        <div className="wf-strip">
          <div
            className="wf-card"
            role="button"
            tabIndex={0}
            onClick={() => actions.showSide('sync')}
            onKeyDown={(e) => e.key === 'Enter' && actions.showSide('sync')}
          >
            <div className="wf-head">
              <Icon name="sync" size={12} />
              <span>Forge Sync</span>
              <span className="grow" />
              <span className={`wf-dot ${syncEngine !== 'off' ? 'ok' : ''}`} />
            </div>
            <div className="wf-main">{syncLabel}</div>
            <div className="wf-sub">
              <span>{connectedPlaces > 0 ? `${connectedPlaces} Studio live` : 'No Studio linked'}</span>
              {syncSt?.pendingStudioEdits.length ? <span>· {syncSt.pendingStudioEdits.length} studio edits</span> : null}
            </div>
          </div>

          <div
            className="wf-card"
            role="button"
            tabIndex={0}
            onClick={() => actions.openPage('vanguards')}
            onKeyDown={(e) => e.key === 'Enter' && actions.openPage('vanguards')}
          >
            <div className="wf-head">
              <Icon name="tool" size={12} />
              <span>Vanguards</span>
              <span className="grow" />
              {updatesBehind > 0 && (
                <span className="badge-o" style={{ borderColor: 'var(--ember-lo)', color: 'var(--ember-text)' }}>
                  ↓{updatesBehind}
                </span>
              )}
            </div>
            <div className="wf-main">
              <div className="wf-dots">
                {(['ror', 'rur', 'ree'] as const).map((id) => (
                  <span key={id} className="wf-pill-dot">
                    <span className={`wf-dot ${vg?.tools[id].found ? 'ok' : ''}`} />
                    {id}
                  </span>
                ))}
              </div>
            </div>
            <div className="wf-sub">
              <span>MCP Bridge: {vg?.mcpBridge.running ? `on :${vg.mcpBridge.port}` : 'off'}</span>
              {vg?.autoUpdateRepos ? <span>· auto-update</span> : null}
            </div>
          </div>

          <div
            className="wf-card"
            role="button"
            tabIndex={0}
            onClick={() => actions.openPage('harbor')}
            onKeyDown={(e) => e.key === 'Enter' && actions.openPage('harbor')}
          >
            <div className="wf-head">
              <Icon name="bolt" size={12} />
              <span>Harbor Stack</span>
              <span className="grow" />
              <span className={`wf-dot ${hb?.watcherActive ? 'ok' : ''}`} />
            </div>
            <div className="wf-main">{detectedLibs.length} / {HARBOR_LIB_IDS.length} active</div>
            <div className="wf-sub">
              <span className="ellipsis">
                {detectedLibs.length ? detectedLibs.map((id) => hb!.libs[id].name).join(' · ') : 'Open to configure'}
              </span>
            </div>
          </div>

          <div className="wf-card static">
            <div className="wf-head">
              <Icon name="lock" size={12} />
              <span>Studio Turn Lock</span>
              <span className="grow" />
              <span className={`wf-dot ${lockSt?.holder ? 'warn' : 'ok'}`} />
            </div>
            <div className="wf-main">
              <span className="ellipsis">{lockSt?.holder ? `Held · ${lockSt.holder.owner}` : 'Idle (unlocked)'}</span>
              {lockSt?.holder && (
                <button
                  className="mini-btn"
                  onClick={() => void h.studioLockForceRelease('Released from dashboard').then(() => h.studioLockStatus().then(setLockSt))}
                >
                  Release
                </button>
              )}
            </div>
            <div className="wf-sub">
              <span>Queue: {lockSt?.queue.length ?? 0} waiting</span>
            </div>
          </div>
        </div>

        <div className="dash">
          <section className="dcard quick">
            <h2>Workstation &amp; Create</h2>
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
