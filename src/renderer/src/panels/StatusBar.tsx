import { useCallback, useState, type MouseEvent } from 'react'
import type { ServiceStatus } from '@shared/types'
import { useStore } from '../store'
import { Menu, type MenuEntry } from '../components/Menu'
import { IconAlert, IconCheck, IconGit, IconPlay, IconRestart, IconRobot, IconSquare, IconTerminal } from '../components/Icons'

const stateLabel: Record<ServiceStatus['state'], string> = {
  running: 'Running',
  starting: 'Starting',
  stopped: 'Stopped',
  crashed: 'Crashed',
  missing: 'Not installed'
}

export function StatusBar() {
  const { state, actions } = useStore()
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const h = window.harness

  const openServiceMenu = (e: MouseEvent, s: ServiceStatus) => {
    const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const live = s.state === 'running' || s.state === 'starting'
    setMenu({
      x: r.left,
      y: r.top - 6,
      items: [
        { header: `${s.label} · ${stateLabel[s.state]}${s.pid ? ` · pid ${s.pid}` : ''}` },
        { label: 'Restart', icon: <IconRestart size={14} />, disabled: s.state === 'missing', onSelect: () => void h.restartService(s.id) },
        live
          ? { label: 'Stop', icon: <IconSquare size={14} />, onSelect: () => void h.stopService(s.id) }
          : { label: 'Start', icon: <IconPlay size={13} />, disabled: s.state === 'missing', onSelect: () => void h.startService(s.id) },
        'separator',
        { label: 'Show logs', icon: <IconTerminal size={14} />, onSelect: () => actions.set({ drawer: 'logs', logFilter: s.id }) }
      ]
    })
  }

  const git = state.git
  let gitText = 'Sync'
  let gitTone = 'muted'
  if (git) {
    if (!git.isRepo) gitText = 'Not a git repo'
    else if (git.conflicts.length) {
      gitText = `${git.conflicts.length} conflict${git.conflicts.length > 1 ? 's' : ''}`
      gitTone = 'bad'
    } else if (git.error) {
      gitText = 'Sync error'
      gitTone = 'bad'
    } else if (git.behind || git.ahead) {
      gitText = [git.behind ? `${git.behind} behind` : '', git.ahead ? `${git.ahead} ahead` : ''].filter(Boolean).join(' · ')
      gitTone = 'warn'
    } else {
      gitText = 'In sync'
      gitTone = 'ok'
    }
  }
  const studioN = state.studioConflicts.length
  const running = state.agents.filter((a) => a.state === 'running' || a.state === 'queued').length
  const failed = state.agents.filter((a) => a.state === 'failed' || a.state === 'error').length

  return (
    <footer className="statusbar">
      <div className="pill-group">
        {state.services.map((s) => (
          <button key={s.id} className={`pill svc s-${s.state}`} onClick={(e) => openServiceMenu(e, s)} title={`${s.label}: ${stateLabel[s.state]}${s.detail ? `\n${s.detail}` : ''}${s.restarts ? `\nRestarts: ${s.restarts}` : ''}`}>
            <span className="dot" />
            {s.label}
            {(s.state === 'crashed' || s.state === 'missing') && <span className="pill-note">{stateLabel[s.state]}</span>}
          </button>
        ))}
      </div>
      <div className="status-fill" />
      <button className={`pill tone-${gitTone}`} onClick={() => actions.set({ drawer: 'sync' })} title={git?.branch ? `Branch ${git.branch}` : 'Collaborator sync'}>
        {gitTone === 'ok' ? <IconCheck size={13} /> : <IconGit size={13} />}
        {gitText}
        {studioN > 0 && (
          <span className="pill-badge warn" title={`${studioN} Studio conflict${studioN > 1 ? 's' : ''}`}>
            <IconAlert size={11} /> {studioN} Studio
          </span>
        )}
      </button>
      <button className={`pill${running ? ' tone-accent' : ''}`} onClick={() => actions.set({ drawer: 'agents' })} title="Test agents">
        <IconRobot size={14} />
        {running ? `${running} running` : 'Agents'}
        {failed > 0 && !running && <span className="pill-badge bad">{failed} failed</span>}
        {running > 0 && <span className="spinner" />}
      </button>
      <button className="pill" onClick={() => actions.set({ drawer: 'logs' })} title="Logs">
        <IconTerminal size={14} />
        Logs
      </button>
      {menu && <Menu x={menu.x} y={menu.y} direction="up" items={menu.items} onClose={closeMenu} />}
    </footer>
  )
}
