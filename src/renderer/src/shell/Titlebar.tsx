// Titlebar (SPEC §7.1): brand, project + place switchers, omnibox, Sync, Serve, panel toggles, theme.
import { useRef, useState } from 'react'
import { useStore } from '../store'
import { AnvilMark, Wordmark } from '../components/Brand'
import { Icon } from '../components/Icons'
import { useMenu, type MenuEntry } from '../components/Menu'
import { isMac, keyHint, errorText } from '../lib/format'
import { sparks } from '../lib/sparks'
import { setThemeMode, useAppearance } from '../theme'
import { requestBugReport } from '../qol/QolRoot'
import { helpMenuItems } from './helpMenu'

function parentDir(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts.length > 1 ? parts[parts.length - 2] : ''
}

export function Titlebar() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const appearance = useAppearance()
  const [syncing, setSyncing] = useState(false)
  const serveRef = useRef<HTMLButtonElement>(null)
  const git = state.git
  const rojo = state.services.find((s) => s.id === 'rojo')
  const place = state.places.find((p) => p.file === state.activePlace)
  const port = place?.servePort ?? 34872
  const l = state.layout

  const projectMenu = (el: HTMLElement) => {
    const items: MenuEntry[] = [
      { header: state.project?.root ?? 'No project open', mono: true },
      { label: 'New project…', icon: <Icon name="folderPlus" />, sub: 'GenTree or empty Rojo project', onSelect: () => actions.openDialog({ kind: 'newProject' }) },
      { label: 'Open folder…', icon: <Icon name="folder" />, hint: keyHint('mod+o'), onSelect: () => void actions.openProject() },
      { label: 'Join a project…', icon: <Icon name="team" />, sub: 'clone · rokit install · wally install', onSelect: () => actions.openDialog({ kind: 'joinProject' }) },
      'separator',
      { label: 'Start feature branch…', icon: <Icon name="branch" />, disabled: !git?.isRepo, reason: 'Not a git repository', onSelect: () => actions.openDialog({ kind: 'featureBranch' }) },
      { label: 'Open pull request…', icon: <Icon name="pr" />, disabled: !git?.hasRemote, reason: 'No git remote', onSelect: () => actions.openDialog({ kind: 'pullRequest' }) },
      { label: 'Copy project path', icon: <Icon name="copy" />, disabled: !state.project, onSelect: () => state.project && void actions.copy(state.project.root, 'project path') }
    ]
    menu.openUnder(el, items, { minWidth: 260 })
  }

  const placeMenu = (el: HTMLElement) => {
    const items: MenuEntry[] = [{ header: 'Places in this project' }]
    for (const p of state.places) {
      items.push({
        label: p.name,
        sub: `${p.file} · :${p.servePort}${p.servePlaceIds.length ? ` · ${p.servePlaceIds.join(', ')}` : ''}`,
        checked: p.file === state.activePlace,
        onSelect: () => p.file !== state.activePlace && void actions.setActivePlace(p.file)
      })
    }
    if (state.appSettings) {
      items.push('separator', {
        label: state.appSettings.serveAllPlaces ? 'Serving all places' : 'Serve all places',
        sub: state.appSettings.serveAllPlaces ? 'rojo serves every *.project.json' : 'rojo serves only the active place',
        checked: state.appSettings.serveAllPlaces,
        onSelect: () => void actions.setAppSettings({ serveAllPlaces: !state.appSettings!.serveAllPlaces })
      })
    }
    menu.openUnder(el, items, { minWidth: 280 })
  }

  const sync = async (el: HTMLElement) => {
    if (!git?.isRepo) {
      actions.showSide('sync')
      return
    }
    setSyncing(true)
    try {
      const next = await window.harness.syncNow()
      actions.set({ git: next })
      if (!next.error && !next.conflicts.length) {
        sparks(el)
        actions.toast({ text: 'Synced with collaborators', detail: `${next.branch ?? ''} · up to date`, kind: 'ok', ms: 3000 })
      } else actions.toast({ text: next.conflicts.length ? 'Sync stopped on a conflict' : 'Sync failed', detail: next.error ?? next.conflicts.join(', '), kind: 'err', action: { label: 'Open', run: () => actions.showSide('sync') } })
    } catch (e) {
      actions.toast({ text: 'Sync failed', detail: errorText(e), kind: 'err' })
    } finally {
      setSyncing(false)
    }
  }

  const serve = async () => {
    const h = window.harness
    try {
      if (rojo?.state === 'running') {
        sparks(serveRef.current)
        await h.restartService('rojo')
      } else {
        sparks(serveRef.current)
        await h.startService('rojo')
      }
    } catch (e) {
      actions.toast({ text: 'Rojo could not start', detail: errorText(e), kind: 'err', action: { label: 'Show log', run: () => actions.showBottom('output', ['rojo']) } })
    }
  }

  const serveState = rojo?.state === 'running' ? 'running' : rojo?.state === 'crashed' ? 'crashed' : rojo?.state === 'starting' ? 'starting' : 'stopped'

  return (
    <header className={`titlebar${isMac ? ' mac' : ''}`}>
      <div className="brand" title="RBX Forge">
        <AnvilMark />
        <Wordmark />
      </div>
      <button className="proj" onClick={(e) => projectMenu(e.currentTarget)} title={state.project?.root ?? 'Open a project'}>
        {state.project ? (
          <>
            <span className="pdir">{parentDir(state.project.root)}/</span>
            <span className="pname">{state.project.name}</span>
            <span className="pdir">:&nbsp;</span>
            <span className="pctx">{place?.name && state.places.length > 1 ? place.name : git?.branch ?? 'no git'}</span>
          </>
        ) : (
          <span>No project open</span>
        )}
      </button>
      {state.places.length > 1 && (
        <button className="pill" onClick={(e) => placeMenu(e.currentTarget)} title={`Active place: ${place?.file ?? ''}${state.appSettings?.serveAllPlaces ? ' (serving all places)' : ''}`}>
          <Icon name="flag" size={12} />
          <span className="place-name">{place?.name ?? 'place'}</span>
          {state.appSettings?.serveAllPlaces && <span className="faint">+all</span>}
          <span className="caret">▼</span>
        </button>
      )}
      {git?.branch && (
        <button className="pill opt-branch" onClick={(e) => projectMenu(e.currentTarget)} title="Branch">
          <Icon name="branch" size={12} />
          {git.branch}
          <span className="caret">▼</span>
        </button>
      )}
      <button className="omni" onClick={() => actions.openPalette('')} title={`Go to file (${keyHint('mod+p')}) · Commands (${keyHint('mod+k')})`}>
        <span className="omni-gt">&gt;</span>
        <span className="omni-text">search scripts, instances, commands</span>
        <kbd>{keyHint('mod+k')}</kbd>
      </button>
      <div className="tb-right">
        <button className="pill sync-btn" onClick={(e) => void sync(e.currentTarget)} title={git?.isRepo ? `Sync with collaborators (${keyHint('mod+shift+s')})` : 'Set up git'} disabled={syncing}>
          <Icon name="sync" size={14} className={syncing ? 'spin' : undefined} />
          <span className="tb-label">Sync</span>
          {!!git?.behind && <span className="behind">↓{git.behind}</span>}
          {!!git?.ahead && <span className="ahead">↑{git.ahead}</span>}
          {!!state.studioConflicts.length && <span className="count-dot" title="Studio conflicts" style={{ background: 'var(--warn)' }}>{state.studioConflicts.length}</span>}
        </button>
        <button
          ref={serveRef}
          className={`btn-forge ${serveState}`}
          onClick={() => void serve()}
          title={serveState === 'running' ? `Rojo is serving on :${port} · click to restart (${keyHint('mod+shift+r')})` : serveState === 'crashed' ? `Rojo crashed: ${rojo?.detail ?? ''} · click to restart` : 'Start rojo serve'}
          disabled={serveState === 'starting'}
        >
          {serveState === 'starting' ? <span className="spinner" /> : serveState === 'crashed' ? <Icon name="restart" size={12} /> : serveState === 'running' ? <span className="led ok" /> : <Icon name="play" size={12} />}
          {serveState === 'running' ? 'Serving' : serveState === 'crashed' ? 'Crashed' : serveState === 'starting' ? 'Starting' : 'Serve'}
          <span style={{ opacity: 0.7, fontSize: 11 }}>:{port}</span>
        </button>
        <span className="tb-sep" />
        <button className={`tb-btn${l.sideOpen ? ' on' : ''}`} onClick={() => actions.toggleSide()} title={`Toggle side panel (${keyHint('mod+b')})`} aria-pressed={l.sideOpen}>
          <Icon name="panelL" />
        </button>
        <button className={`tb-btn${l.bottomOpen ? ' on' : ''}`} onClick={() => actions.toggleBottom()} title={`Toggle bottom panel (${keyHint('mod+j')})`} aria-pressed={l.bottomOpen}>
          <Icon name="panelB" />
        </button>
        <button className={`tb-btn${l.rightOpen ? ' on' : ''}`} onClick={() => actions.toggleRight()} title={`Toggle Assistant (${keyHint('mod+l')})`} aria-pressed={l.rightOpen}>
          <Icon name="panelR" />
        </button>
        <button className="tb-btn" onClick={requestBugReport} title="Report a bug (screenshot + logs, saved on this computer)" aria-label="Report a bug">
          <Icon name="bug" />
        </button>
        <button className="tb-btn" onClick={(e) => menu.openUnder(e.currentTarget, helpMenuItems(actions), { minWidth: 280 })} title="Help: Forge Doctor, report a bug" aria-label="Help">
          <Icon name="info" />
        </button>
        <button
          className="tb-btn"
          onClick={() => setThemeMode(appearance.resolved === 'dark' ? 'light' : 'dark')}
          onContextMenu={(e) =>
            menu.openAt(e, [
              { header: 'Theme' },
              { label: 'Dark', icon: <Icon name="moon" />, checked: appearance.theme === 'dark', onSelect: () => setThemeMode('dark') },
              { label: 'Light', icon: <Icon name="sun" />, checked: appearance.theme === 'light', onSelect: () => setThemeMode('light') },
              { label: 'System', icon: <Icon name="monitor" />, checked: appearance.theme === 'system', onSelect: () => setThemeMode('system') }
            ])
          }
          title={`Theme: ${appearance.theme} (right-click for System)`}
        >
          <Icon name={appearance.resolved === 'dark' ? 'sun' : 'moon'} />
        </button>
      </div>
      {menu.node}
    </header>
  )
}
