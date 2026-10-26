// Workbench shell (SPEC §7): titlebar, activity bar, side panel, editor area + bottom panel,
// Assistant panel, status bar, and the overlays (palette, menus, dialogs, toasts).
import { useEffect, useRef, type CSSProperties } from 'react'
import { StoreProvider, useStore, type SideView } from './store'
import { Titlebar } from './shell/Titlebar'
import { ActivityBar } from './shell/ActivityBar'
import { StatusBar } from './shell/StatusBar'
import { EditorArea } from './shell/EditorArea'
import { BottomPanel } from './shell/BottomPanel'
import { Palette } from './shell/Palette'
import { Dialogs, Toasts } from './shell/Overlays'
import { QolcOverlays } from './pages/qolc/QolcOverlays'
import { buildCommands, keySpec, normalizeSpec } from './shell/commands'
import { ExplorerView } from './views/ExplorerView'
import { ScriptsView } from './views/ScriptsView'
import { SearchView } from './views/SearchView'
import { EventsView } from './views/EventsView'
import { SyncView } from './views/SyncView'
import { TestsView } from './views/TestsView'
import { TeamView } from './views/TeamView'
import { AssistantPanel } from './assistant/AssistantPanel'
import { ToolchainGate } from './setup/Toolchain'
import { terminalOwnsKey } from './terminal/session'
import { QolRoot } from './qol/QolRoot'
import { startScm } from './views/scmState'
import { activeGroupOf } from '@shared/editorGroups'
import { focusGroupAt } from './shell/groupActions'
import './shell/workbench.css'
import './views/views.css'
import './pages/pages.css'
import './assistant/assistant.css'

// Drag handle between panels: 300ms hover delay before the ember line, double-click resets,
// dragging past the minimum by 40px collapses.
function Resizer({ axis, value, min, max, reset, invert, onChange, onCollapse }: { axis: 'x' | 'y'; value: number; min: number; max: () => number; reset: number; invert?: boolean; onChange: (v: number) => void; onCollapse: () => void }) {
  const ref = useRef<HTMLDivElement>(null)
  const onDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return
    e.preventDefault()
    const start = axis === 'x' ? e.clientX : e.clientY
    const startValue = value
    const el = ref.current
    el?.classList.add('dragging')
    document.body.classList.add('resizing')
    document.body.style.setProperty('--resize-cursor', axis === 'x' ? 'col-resize' : 'row-resize')
    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
      const next = startValue + (invert ? -delta : delta)
      if (next < min - 40) {
        up()
        onCollapse()
        return
      }
      onChange(Math.round(Math.max(min, Math.min(max(), next))))
    }
    const up = () => {
      el?.classList.remove('dragging')
      document.body.classList.remove('resizing')
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return <div ref={ref} className={`resizer${axis === 'y' ? ' h' : ''}`} onPointerDown={onDown} onDoubleClick={() => onChange(reset)} role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} />
}

const VIEWS: Record<SideView, () => React.ReactElement> = {
  explorer: ExplorerView,
  search: SearchView,
  scripts: ScriptsView,
  events: EventsView,
  sync: SyncView,
  tests: TestsView,
  team: TeamView
}

function SidePanel() {
  const { state } = useStore()
  const View = VIEWS[state.layout.sideView] ?? ExplorerView
  return (
    <aside className="panel side" aria-label="Side panel" aria-hidden={!state.layout.sideOpen}>
      <div className="panel-inner" key={state.layout.sideView}>
        <View />
      </div>
    </aside>
  )
}

// Global shortcuts, captured before Monaco so ⌘K / ⌘P / ⌘B / ⌘J / ⌘L work everywhere.
function useShortcuts() {
  const { state, actions } = useStore()
  const ref = useRef({ state, actions })
  ref.current = { state, actions }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || ref.current.state.dialog) return
      const spec = keySpec(e)
      // Focus in the integrated terminal: shell keys (Ctrl+R, Ctrl+K...) go to the shell.
      if (terminalOwnsKey(e, spec)) return
      const { state: s, actions: a } = ref.current
      // Palette entry points.
      if (spec === 'mod+k' || spec === 'mod+shift+p') {
        e.preventDefault()
        e.stopPropagation()
        a.openPalette('>')
        return
      }
      if (spec === 'mod+p') {
        e.preventDefault()
        e.stopPropagation()
        a.openPalette('')
        return
      }
      // Tabs.
      if (spec === 'ctrl+tab' || spec === 'mod+tab' || spec === 'ctrl+shift+tab' || spec === 'mod+shift+tab' || spec === 'alt+mod+arrowright' || spec === 'alt+mod+arrowleft') {
        // Cycles the active editor group's tabs.
        const group = activeGroupOf(s.editor)
        const back = spec.includes('shift') || spec.endsWith('arrowleft')
        const i = group.tabs.indexOf(s.activeTab)
        const next = group.tabs[(i + (back ? -1 : 1) + group.tabs.length) % group.tabs.length]
        if (next) {
          e.preventDefault()
          e.stopPropagation()
          a.activateTab(next, group.id)
        }
        return
      }
      // ⌘1…⌘4 focus editor group 1-4 once the editor is split; otherwise (and ⌘5…⌘9) the nth tab
      // of the active group.
      const digit = /^mod\+([1-9])$/.exec(spec)
      if (digit) {
        const n = Number(digit[1])
        if (s.editor.groups.length > 1 && n <= 4) {
          e.preventDefault()
          e.stopPropagation()
          if (n <= s.editor.groups.length) focusGroupAt(a, n - 1)
          return
        }
        const group = activeGroupOf(s.editor)
        const t = group.tabs[n - 1]
        if (t) {
          e.preventDefault()
          e.stopPropagation()
          a.activateTab(t, group.id)
        }
        return
      }
      if (s.palette) return
      // Leave tree/editor-local keys (F2, ⌘D, ⌘Z…) alone; match registered command shortcuts.
      const cmd = buildCommands(s, a).find((c) => c.keys && normalizeSpec(c.keys) === normalizeSpec(spec))
      if (!cmd) return
      // ⌘S only when a file is active; ⌘W closes the tab.
      e.preventDefault()
      e.stopPropagation()
      cmd.run()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function Shell() {
  const { state, actions } = useStore()
  const l = state.layout
  useShortcuts()
  // Source control: the saved commit message draft reaches main at startup (the auto-sync skips its
  // commit while there is one), not only once the Sync view opens.
  useEffect(() => startScm(), [])

  // Narrow windows: never keep both side panels open below 1180px. The panel opened last wins, so
  // opening the side panel while narrow hides the Assistant (and the other way round).
  const prev = useRef({ side: l.sideOpen, right: l.rightOpen })
  useEffect(() => {
    const check = () => {
      if (window.innerWidth >= 1180 || !l.sideOpen || !l.rightOpen) return
      if (!prev.current.side) actions.setLayout({ rightOpen: false })
      else actions.setLayout({ sideOpen: false, sideAuto: true })
    }
    check()
    prev.current = { side: l.sideOpen, right: l.rightOpen }
    const onResize = () => {
      if (window.innerWidth < 1180 && l.sideOpen && l.rightOpen) actions.setLayout({ sideOpen: false, sideAuto: true })
    }
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [l.sideOpen, l.rightOpen])

  const style = {
    '--side-w': `${l.sideW}px`,
    '--right-w': `${l.rightW}px`,
    '--bottom-h': `${l.bottomH}px`,
    '--toast-right': l.rightOpen ? `${l.rightW}px` : '0px'
  } as CSSProperties

  return (
    <div className={`app${l.sideOpen ? '' : ' side-off'}${l.rightOpen ? '' : ' right-off'}${l.bottomOpen ? '' : ' bottom-off'}`} style={style}>
      <Titlebar />
      <div className="body">
        <ActivityBar />
        <SidePanel />
        {l.sideOpen && <Resizer axis="x" value={l.sideW} min={200} max={() => 480} reset={268} onChange={(v) => actions.setLayout({ sideW: v })} onCollapse={() => actions.setLayout({ sideOpen: false })} />}
        <main className="center">
          <EditorArea />
          {l.bottomOpen && <Resizer axis="y" invert value={l.bottomH} min={120} max={() => Math.round((window.innerHeight - 62) * 0.6)} reset={214} onChange={(v) => actions.setLayout({ bottomH: v })} onCollapse={() => actions.setLayout({ bottomOpen: false })} />}
          <BottomPanel />
        </main>
        {l.rightOpen && <Resizer axis="x" invert value={l.rightW} min={300} max={() => 560} reset={360} onChange={(v) => actions.setLayout({ rightW: v })} onCollapse={() => actions.toggleRight(false)} />}
        <AssistantPanel />
      </div>
      <StatusBar />
      <Palette />
      <Dialogs />
      <Toasts />
      <QolcOverlays />
      <ToolchainGate />
      <QolRoot />
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Shell />
    </StoreProvider>
  )
}
