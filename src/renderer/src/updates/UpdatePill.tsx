// Status bar pill for self-update: "Update 0.2.1 ready, restart" (install mode) or "Update 0.2.1
// available, download" (macOS manual mode). Quiet while downloading, hidden otherwise.
import { useState } from 'react'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { useMenu, type MenuEntry } from '../components/Menu'
import { useRestartForUpdate, useUpdate } from './useUpdate'
import './updates.css'

export function openUpdateSettings(openPage: (kind: 'settings') => void): void {
  openPage('settings')
  // The page mounts on the next frame; scroll once it is there.
  setTimeout(() => document.getElementById('set-updates')?.scrollIntoView({ block: 'start' }), 60)
}

export function UpdatePill() {
  const update = useUpdate()
  const { actions } = useStore()
  const restart = useRestartForUpdate()
  const menu = useMenu()
  // "Later" hides the pill for this version until something changes.
  const [hidden, setHidden] = useState<string | null>(null)
  if (!update?.offer) return null
  const v = update.offer.version
  const key = `${update.phase}:${v}`
  if (hidden === key) return null

  if (update.phase === 'downloading') {
    return (
      <span className="sb opt-1 upd-dl" title={`Downloading RBX Forge ${v} in the background`} onClick={() => openUpdateSettings(actions.openPage)}>
        <Icon name="download" size={12} />
        <span className="mono">{v} · {update.percent ?? 0}%</span>
      </span>
    )
  }

  const ready = update.phase === 'ready' && update.mode === 'install'
  const manual = update.phase === 'available' && update.mode === 'manual'
  if (!ready && !manual) return null

  const items: MenuEntry[] = [
    { header: `RBX Forge ${v}`, mono: true },
    ready
      ? { label: 'Restart now', icon: <Icon name="restart" />, onSelect: restart }
      : { label: 'Open the download page', icon: <Icon name="external" />, onSelect: () => void window.harness.updateOpenRelease() },
    { label: "What's new", icon: <Icon name="info" />, onSelect: () => openUpdateSettings(actions.openPage) },
    { label: 'Later', icon: <Icon name="clock" />, onSelect: () => setHidden(key) }
  ]
  return (
    <>
      <button
        className="upd-pill"
        title={ready ? `RBX Forge ${v} is downloaded. Restart to install it, or it installs when you quit.\nRight-click for more.` : `RBX Forge ${v} is out. This Mac installs it from the release page.\nRight-click for more.`}
        onClick={() => (ready ? restart() : void window.harness.updateOpenRelease())}
        onContextMenu={(e) => menu.openAt(e, items, { direction: 'up' })}
      >
        <Icon name={ready ? 'restart' : 'download'} size={11} />
        {ready ? `Update ${v} ready, restart` : `Update ${v} available, download`}
      </button>
      {menu.node}
    </>
  )
}
