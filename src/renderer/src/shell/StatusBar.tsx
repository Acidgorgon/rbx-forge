// Status bar (SPEC §7.7): home, branch, services, problems, realm, cursor, LSP, assistant meter, bell.
import { useEffect, useRef, useState } from 'react'
import type { ServiceStatus } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { useMenu, type MenuEntry } from '../components/Menu'
import { useCursor } from '../lib/cursor'
import { realmOfFile } from '../lib/roblox'
import { ago, fmtTokens, fmtUsd } from '../lib/format'
import { useProblems } from './problems'
import { UpdatePill } from '../updates/UpdatePill'
import { SpendPill } from '../pages/qolc/Spend'

export function ledOf(s: ServiceStatus | undefined): 'ok' | 'warn' | 'err' | 'idle' {
  if (!s) return 'idle'
  if (s.state === 'running') return 'ok'
  if (s.state === 'starting') return 'warn'
  if (s.state === 'crashed') return 'err'
  return 'idle'
}

const LABEL: Record<string, string> = { rojo: 'Rojo', dev: 'Watcher', studioSync: 'Studio', lsp: 'luau-lsp' }

function ServiceSegment({ s, port }: { s: ServiceStatus; port?: number }) {
  const { actions } = useStore()
  const menu = useMenu()
  const led = ledOf(s)
  const prev = useRef(s.state)
  const [flash, setFlash] = useState(false)
  useEffect(() => {
    if (s.state === 'crashed' && prev.current !== 'crashed') {
      setFlash(true)
      const t = setTimeout(() => setFlash(false), 950)
      prev.current = s.state
      return () => clearTimeout(t)
    }
    prev.current = s.state
  }, [s.state])
  const h = window.harness
  const items: MenuEntry[] = [
    { header: `${s.label} · ${s.state}`, mono: true },
    { label: 'Show log', icon: <Icon name="terminal" />, onSelect: () => actions.showBottom('output', [s.id]) },
    { label: s.state === 'running' ? 'Restart' : 'Start', icon: <Icon name="restart" />, onSelect: () => void (s.state === 'running' ? h.restartService(s.id) : h.startService(s.id)) },
    { label: 'Stop', icon: <Icon name="stop" />, disabled: s.state === 'stopped' || s.state === 'missing', onSelect: () => void h.stopService(s.id) }
  ]
  const detail = s.state === 'crashed' ? 'Crashed' : s.state === 'starting' ? (s.id === 'studioSync' ? 'connecting…' : 'starting…') : s.state === 'missing' ? 'not found' : s.state === 'stopped' ? 'stopped' : s.id === 'rojo' && port ? `:${port}` : ''
  return (
    <>
      <span
        className={`sb${s.state === 'crashed' ? ' crash' : ''}${flash ? ' flash-err' : ''}${s.id === 'studioSync' ? ' opt-1' : ''}`}
        title={`${s.label}: ${s.detail ?? s.state}${s.restarts ? ` · ${s.restarts} restarts` : ''}\nClick: show log · right-click: restart / stop`}
        onClick={() => actions.showBottom('output', [s.id])}
        onContextMenu={(e) => menu.openAt(e, items, { direction: 'up' })}
      >
        <span className={`led ${led}`} />
        {LABEL[s.id] ?? s.label}
        {detail && <span className="mono sb-detail" style={{ color: s.state === 'crashed' ? 'inherit' : 'var(--fg-faint)' }}>{detail}</span>}
      </span>
      {menu.node}
    </>
  )
}

export function StatusBar() {
  const { state, actions } = useStore()
  const cursor = useCursor()
  const problems = useProblems()
  const menu = useMenu()
  const git = state.git
  const place = state.places.find((p) => p.file === state.activePlace)
  const services = state.services.filter((s) => s.id !== 'lsp')
  const lspService = state.services.find((s) => s.id === 'lsp')
  const errors = problems.filter((p) => p.severity === 'error').length
  const warnings = problems.filter((p) => p.severity === 'warning').length
  const realm = state.activeFile ? (state.activeFile.endsWith('.blink') ? 'blink' : realmOfFile(state.activeFile)) : null
  const chatUsage = state.usage.chat?.totals
  const live = state.usage.chat?.live
  const tokens = (chatUsage ? chatUsage.input + chatUsage.output + chatUsage.cacheRead + chatUsage.cacheWrite : 0) + (live ? live.input + live.output : 0)
  const cost = (chatUsage?.costUsd ?? 0) + (live?.costUsd ?? 0)
  const lspLed = state.lsp.state === 'ready' ? 'ok' : state.lsp.state === 'starting' ? 'warn' : lspService ? ledOf(lspService) : 'idle'
  const unread = state.notifications.length

  const bell = (el: HTMLElement) => {
    const items: MenuEntry[] = [{ header: 'Notifications' }]
    if (!state.notifications.length) items.push({ label: 'Nothing yet', disabled: true })
    for (const n of state.notifications.slice(0, 12)) {
      items.push({ label: n.text, sub: `${n.detail ? n.detail + ' · ' : ''}${ago(n.at)}`, icon: <Icon name={n.kind === 'err' ? 'err' : n.kind === 'ok' ? 'check' : 'info'} />, onSelect: () => n.action?.run() })
    }
    if (state.notifications.length) items.push('separator', { label: 'Clear', onSelect: () => actions.set({ notifications: [] }) })
    menu.openAbove(el, items, { minWidth: 320 })
  }

  return (
    <footer className="status">
      <span className="sb home" onClick={() => actions.openPage('forge')} title="Open the Forge tab">
        <Icon name="hammer" size={12} />
        {state.project?.name ?? 'RBX Forge'}
      </span>
      {git?.isRepo && (
        <span className="sb" onClick={() => actions.showSide('sync')} title={`${git.branch ?? 'detached'} · ${git.behind} behind · ${git.ahead} ahead · ${git.dirty} changed\nLast sync ${ago(git.lastSync)}`}>
          <Icon name="branch" size={12} />
          {git.branch ?? 'detached'}
          {!!git.behind && <span className="mono" style={{ color: 'var(--ember-text)' }}>↓{git.behind}</span>}
          {!!git.ahead && <span className="mono">↑{git.ahead}</span>}
        </span>
      )}
      {place && state.places.length > 1 && (
        <span className="sb opt-2" onClick={() => actions.openPalette('>Switch place')} title={`Active place ${place.file}`}>
          <Icon name="flag" size={12} />
          {place.name}
        </span>
      )}
      {services.map((s) => (
        <ServiceSegment key={s.id} s={s} port={place?.servePort} />
      ))}
      <span className="sb-sp" />
      <UpdatePill />
      <span className="sb" onClick={() => actions.showBottom('problems')} title="Problems">
        <Icon name="warn" size={12} style={{ color: warnings ? 'var(--warn)' : undefined }} />
        {warnings}
        <Icon name="err" size={12} style={{ color: errors ? 'var(--err)' : 'var(--fg-faint)' }} />
        {errors}
      </span>
      {realm && (
        <span className="sb static opt-2">
          <span className={`tag ${realm}`}>{realm}</span>
        </span>
      )}
      {cursor && state.activeFile && (
        <span className="sb mono" onClick={() => actions.openPalette(':')} title="Go to line">
          Ln {cursor.line}, Col {cursor.column}
          {cursor.selected > 0 && <span className="faint">({cursor.selected} sel)</span>}
        </span>
      )}
      {cursor && state.activeFile && <span className="sb static opt-1">{cursor.insertSpaces ? 'Spaces' : 'Tabs'}: {cursor.tabSize}</span>}
      <span className="sb opt-1" title={`luau-lsp: ${state.lsp.detail ?? lspService?.detail ?? state.lsp.state}`} onClick={() => actions.showBottom('output', ['lsp'])}>
        <span className={`led ${lspLed}`} />
        luau-lsp
      </span>
      <SpendPill />
      <span className="sb" onClick={() => actions.toggleRight()} title={`Assistant this thread: ${fmtTokens(tokens)} tokens · ${fmtUsd(cost)}\nToday: ${fmtUsd(state.usage.day?.totals.costUsd ?? 0)}`}>
        <Icon name="hammer" size={12} />
        <span className="mono">{fmtTokens(tokens)} · {fmtUsd(cost)}</span>
      </span>
      <span className="sb" onClick={(e) => bell(e.currentTarget)} title="Notifications">
        <Icon name="bell" size={12} />
        {unread > 0 && <span className="mono faint">{unread}</span>}
      </span>
      {menu.node}
    </footer>
  )
}
