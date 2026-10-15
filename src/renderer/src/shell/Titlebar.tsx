// Titlebar (SPEC §7.1): brand, project + place switchers, omnibox, Sync, Serve, panel toggles, theme.
import { useEffect, useRef, useState } from 'react'
import { useStore } from '../store'
import { AnvilMark, Wordmark } from '../components/Brand'
import { Icon } from '../components/Icons'
import { useMenu, type MenuEntry } from '../components/Menu'
import { isMac, keyHint, errorText } from '../lib/format'
import { sparks } from '../lib/sparks'
import { setThemeMode, useAppearance } from '../theme'
import { requestBugReport } from '../qol/QolRoot'
import { helpMenuItems } from './helpMenu'
import { serveNotice, serveView } from '@shared/rojoView'

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

  // Forge Sync holds rojo serve for a place: open the conflicts, or serve that place anyway.
  const resolveHeld = () => actions.showSide('sync')
  const serveAnyway = async (file: string) => {
    try {
      const status = await window.harness.syncStatus()
      const held = status.places.filter((p) => p.projectFile === file && p.gate === 'blocked')
      if (!held.length) return actions.toast({ text: 'Nothing held', detail: `${file} is not held by Forge Sync any more`, kind: 'info', ms: 3000 })
      for (const p of held) await window.harness.syncServeAnyway(p.placeKey)
      actions.toast({ text: 'Serving anyway', detail: 'The held conflicts stay listed in Forge Sync', kind: 'ok', ms: 3000 })
      await actions.refreshSync()
    } catch (e) {
      actions.toast({ text: 'Could not serve anyway', detail: errorText(e), kind: 'err' })
    }
  }
  // No Studio check has cleared the place ('waiting'): serve it anyway, the user's call.
  const serveUnchecked = async (file: string) => {
    try {
      await window.harness.syncServeWithoutCheck(file)
      actions.toast({ text: 'Serving without a Studio check', detail: "Check Rojo's dialog in Studio before you accept: it may offer to delete scripts that exist only in Studio.", kind: 'info', ms: 6000 })
      await actions.refreshSync()
    } catch (e) {
      actions.toast({ text: 'Could not serve', detail: errorText(e), kind: 'err' })
    }
  }
  const heldMenu = (el: HTMLElement) => {
    const hold = rojo?.hold
    if (!hold) return
    if (hold.gate === 'waiting') {
      menu.openUnder(
        el,
        [
          { header: `rojo serve waits for Studio's first sync check: ${hold.file}`, mono: true },
          {
            label: hold.reason === 'unlinked' ? 'Link the Studio place…' : 'Studio sync…',
            icon: <Icon name="sync" />,
            sub: hold.reason === 'unlinked' ? "Studio's open place isn't linked to this project" : hold.reason === 'plugin' ? 'Restart Studio to load the new Forge Bridge plugin' : 'Open the place in Studio with the Forge Bridge plugin',
            onSelect: resolveHeld
          },
          { label: 'Serve without Studio check', icon: <Icon name="play" />, sub: 'Rojo may offer to delete scripts that exist only in Studio', onSelect: () => void serveUnchecked(hold.file) },
          { label: 'Show log', icon: <Icon name="terminal" />, onSelect: () => actions.showBottom('output', ['rojo']) }
        ],
        { minWidth: 320 }
      )
      return
    }
    menu.openUnder(
      el,
      [
        { header: hold.gate === 'blocked' ? `rojo serve waits: ${hold.file}` : `rojo serve waits for the Studio check: ${hold.file}`, mono: true },
        { label: 'Resolve conflicts…', icon: <Icon name="sync" />, sub: 'Pick Studio or disk per file, or pull Studio-only scripts to disk', onSelect: resolveHeld },
        { label: 'Serve anyway', icon: <Icon name="play" />, sub: 'Studio edits in the held files may be overwritten', disabled: hold.gate !== 'blocked', reason: 'Still checking', onSelect: () => void serveAnyway(hold.file) },
        { label: 'Show log', icon: <Icon name="terminal" />, onSelect: () => actions.showBottom('output', ['rojo']) }
      ],
      { minWidth: 300 }
    )
  }

  // Toasts for rojo restarting by itself, giving up, or being held on conflicts.
  const lastRojo = useRef(rojo)
  const announced = useRef(rojo?.restarts ?? 0)
  useEffect(() => {
    const { notice, announced: next } = serveNotice(lastRojo.current, rojo, announced.current)
    lastRojo.current = rojo
    announced.current = next
    if (!notice) return
    if (notice.kind === 'restarted') actions.toast({ text: 'Rojo crashed, restarted', detail: 'Reconnect the Rojo plugin in Studio if it disconnected', kind: 'info', action: { label: 'Show log', run: () => actions.showBottom('output', ['rojo']) } })
    else if (notice.kind === 'gave-up') actions.toast({ text: 'Rojo keeps crashing', detail: notice.detail, kind: 'err', ms: 0, action: { label: 'Restart', run: () => void window.harness.startService('rojo') } })
    else if (notice.kind === 'unchecked')
      actions.toast({
        text: notice.reason === 'unlinked' ? "Studio's place isn't linked: rojo serve waits" : 'Restart Studio: rojo serve waits',
        detail: `${notice.detail}.`,
        kind: 'hot',
        ms: 20000,
        action: { label: notice.reason === 'unlinked' ? 'Link…' : 'Open', run: resolveHeld }
      })
    else actions.toast({ text: 'rojo serve is held', detail: `${notice.file}: ${notice.detail || 'Studio sync conflicts'}. Resolve them or serve anyway.`, kind: 'hot', ms: 15000, action: { label: 'Resolve', run: resolveHeld } })
  }, [rojo])

  const serve = async () => {
    const h = window.harness
    if (rojo?.hold) return heldMenu(serveRef.current as HTMLElement)
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

  const view = serveView(rojo, port)
  const serveState = view.kind

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
          title={serveState === 'running' ? `${view.title} (${keyHint('mod+shift+r')})` : view.title}
          disabled={serveState === 'starting'}
          aria-haspopup={serveState === 'held' || serveState === 'checking' || serveState === 'waiting' ? 'menu' : undefined}
        >
          {serveState === 'starting' || serveState === 'checking' ? <span className="spinner" /> : serveState === 'held' || serveState === 'waiting' ? <Icon name="warn" size={12} /> : serveState === 'crashed' || serveState === 'failed' ? <Icon name="restart" size={12} /> : serveState === 'running' ? <span className="led ok" /> : <Icon name="play" size={12} />}
          {view.label}
          <span className="serve-port" style={{ opacity: 0.7, fontSize: 11 }}>:{port}</span>
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
