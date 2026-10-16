// Activity bar (SPEC §7.2): side views on top, wide pages (Packages, Release, Analytics, Settings) below.
import { useRef, useState, type ReactNode } from 'react'
import { useStore, type PageKind, type SideView } from '../store'
import { Icon, type IconName } from '../components/Icons'
import { keyHint } from '../lib/format'

// Tooltip timing shared by the bar: 500ms to show, then instant for 800ms after one closes.
let warmUntil = 0

function Tip({ label, keys, children }: { label: string; keys?: string; children: (bind: { onMouseEnter: (e: React.MouseEvent) => void; onMouseLeave: () => void }) => ReactNode }) {
  const [tip, setTip] = useState<{ x: number; y: number } | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const bind = {
    onMouseEnter: (e: React.MouseEvent) => {
      const r = (e.currentTarget as HTMLElement).getBoundingClientRect()
      const show = () => setTip({ x: r.right + 8, y: r.top + r.height / 2 - 12 })
      if (Date.now() < warmUntil) show()
      else timer.current = setTimeout(show, 500)
    },
    onMouseLeave: () => {
      if (timer.current) clearTimeout(timer.current)
      if (tip) warmUntil = Date.now() + 800
      setTip(null)
    }
  }
  return (
    <>
      {children(bind)}
      {tip && (
        <div className="tip" style={{ left: tip.x, top: tip.y }}>
          {label}
          {keys && <kbd>{keyHint(keys)}</kbd>}
        </div>
      )}
    </>
  )
}

interface Item {
  icon: IconName
  label: string
  keys?: string
  view?: SideView
  page?: PageKind
  badge?: { n: number; err?: boolean } | null
  dot?: boolean
}

export function ActivityBar() {
  const { state, actions } = useStore()
  const l = state.layout
  const blinkErrors = state.blink?.diagnostics.filter((d) => d.severity === 'error').length ?? 0
  const behind = (state.git?.behind ?? 0) + state.studioConflicts.length + (state.git?.conflicts.length ?? 0)
  const agentsRunning = state.agents.some((a) => a.state === 'running' || a.state === 'queued') || state.tests.running || state.boards.some((b) => b.state === 'running' || b.state === 'planning' || b.state === 'integrating')
  const testFails = (state.tests.last?.failed ?? 0) + state.agents.filter((a) => a.state === 'failed' || a.state === 'error').length
  const outdated = 0
  const contested = state.claims.filter((c) => c.contested).length
  const activePage = state.tabs.find((t) => t.id === state.activeTab)?.kind

  const top: Item[] = [
    { icon: 'tree', label: 'Explorer', keys: 'mod+shift+e', view: 'explorer' },
    { icon: 'script', label: 'Scripts', keys: 'mod+shift+f', view: 'scripts' },
    { icon: 'bolt', label: 'Events (Blink)', keys: 'mod+shift+v', view: 'events', badge: blinkErrors ? { n: blinkErrors, err: true } : null },
    { icon: 'branch', label: 'Source control & Sync', keys: 'mod+shift+g', view: 'sync', badge: behind ? { n: behind } : null },
    { icon: 'flask', label: 'Tests & agents', keys: 'mod+shift+a', view: 'tests', dot: agentsRunning, badge: !agentsRunning && testFails ? { n: testFails, err: true } : null },
    { icon: 'team', label: 'Team', view: 'team', badge: contested ? { n: contested } : null }
  ]
  const groupBusy = state.chats.some((c) => c.guests?.length && state.busy[c.id])
  const bottom: Item[] = [
    { icon: 'round', label: 'Group chats', page: 'groups', dot: groupBusy },
    { icon: 'package', label: 'Packages (Wally, Rokit)', page: 'packages', badge: outdated ? { n: outdated } : null },
    { icon: 'rocket', label: 'Release', page: 'release' },
    { icon: 'chart', label: 'Analytics', page: 'analytics' },
    { icon: 'image', label: 'Art (image concepts)', page: 'art' },
    { icon: 'sparkle', label: 'VFX Lab', page: 'vfx' },
    { icon: 'figure', label: 'Animation Lab', page: 'anim' },
    { icon: 'bolt', label: 'Ability Composer', page: 'ability' },
    { icon: 'thumbnail', label: 'Thumbnail Lab', page: 'thumbs' },
    { icon: 'tap', label: 'UI Motion Lab', page: 'uimotion' },
    { icon: 'cube', label: 'Model Lab', page: 'model' },
    { icon: 'monitor', label: 'UI Preview (stories)', page: 'uipreview' },
    { icon: 'memory', label: 'Memory & skills', page: 'memory' },
    { icon: 'gear', label: 'Settings', keys: 'mod+comma', page: 'settings' }
  ]

  const render = (it: Item) => {
    const on = it.view ? l.sideOpen && l.sideView === it.view : activePage === it.page
    return (
      <Tip key={it.label} label={it.label} keys={it.keys}>
        {(bind) => (
          <button
            className={`act${on ? ' on' : ''}`}
            aria-label={it.label}
            aria-pressed={on}
            onClick={() => (it.view ? actions.showSide(it.view) : actions.openPage(it.page!))}
            {...bind}
          >
            <Icon name={it.icon} />
            {it.badge && <span className={`badge${it.badge.err ? ' err' : ''}`}>{it.badge.n > 99 ? '99+' : it.badge.n}</span>}
            {it.dot && <span className="dot" />}
          </button>
        )}
      </Tip>
    )
  }

  return (
    <nav className="activity" aria-label="Views">
      {top.map(render)}
      <div className="act-spacer" />
      {bottom.map(render)}
    </nav>
  )
}
