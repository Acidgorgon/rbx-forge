// Workbench shell (SPEC §7): titlebar, activity bar, side panel, editor area + bottom panel,
// Assistant panel, status bar, and the overlays (palette, menus, dialogs, toasts).
import { memo, useEffect, useRef, type CSSProperties } from 'react'
import { StoreProvider, useActions, useGetState, useStoreSelector, type SideView } from './store'
import { Titlebar as TitlebarView } from './shell/Titlebar'
import { ActivityBar as ActivityBarView } from './shell/ActivityBar'
import { StatusBar as StatusBarView } from './shell/StatusBar'
import { EditorArea as EditorAreaView } from './shell/EditorArea'
import { BottomPanel as BottomPanelView } from './shell/BottomPanel'
import { Palette as PaletteView } from './shell/Palette'
import { Dialogs as DialogsView, Toasts as ToastsView } from './shell/Overlays'
import { QolcOverlays as QolcOverlaysView } from './pages/qolc/QolcOverlays'
import { buildCommands, isBoundKey, keySpec, normalizeSpec } from './shell/commands'
import { ExplorerView } from './views/ExplorerView'
import { ScriptsView } from './views/ScriptsView'
import { SearchView } from './views/SearchView'
import { EventsView } from './views/EventsView'
import { SyncView } from './views/SyncView'
import { TestsView } from './views/TestsView'
import { TeamView } from './views/TeamView'
import { AssistantPanel as AssistantPanelView } from './assistant/AssistantPanel'
import { ToolchainGate as ToolchainGateView } from './setup/Toolchain'
import { terminalOwnsKey } from './terminal/session'
import { QolRoot as QolRootView } from './qol/QolRoot'
import { startScm } from './views/scmState'
import { activeGroupOf } from '@shared/editorGroups'
import { focusGroupAt } from './shell/groupActions'
import './shell/workbench.css'
import './views/views.css'
import './pages/pages.css'
import './assistant/assistant.css'

// The workbench's parts take no props: memo keeps a Shell re-render (a layout change) from
// re-rendering all of them; each one subscribes to the store slice it reads.
const Titlebar = memo(TitlebarView)
const ActivityBar = memo(ActivityBarView)
const StatusBar = memo(StatusBarView)
const EditorArea = memo(EditorAreaView)
const BottomPanel = memo(BottomPanelView)
const Palette = memo(PaletteView)
const Dialogs = memo(DialogsView)
const Toasts = memo(ToastsView)
const QolcOverlays = memo(QolcOverlaysView)
const AssistantPanel = memo(AssistantPanelView)
const ToolchainGate = memo(ToolchainGateView)
const QolRoot = memo(QolRootView)

// Drag handle between panels: 300ms hover delay before the ember line, double-click resets,
// dragging past the minimum by 40px collapses. While dragging, onPreview moves the panel (CSS
// variables, no React render); the size is committed to the store once, on release.
function Resizer({ axis, value, min, max, reset, invert, onPreview, onChange, onCollapse }: { axis: 'x' | 'y'; value: number; min: number; max: () => number; reset: number; invert?: boolean; onPreview: (v: number) => void; onChange: (v: number) => void; onCollapse: () => void }) {
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
    let last: number | null = null
    let frame = 0
    const move = (ev: PointerEvent) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start
      const next = startValue + (invert ? -delta : delta)
      if (next < min - 40) {
        up()
        onCollapse()
        return
      }
      last = Math.round(Math.max(min, Math.min(max(), next)))
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0
          if (last !== null) onPreview(last)
        })
      }
    }
    const up = () => {
      cancelAnimationFrame(frame)
      frame = 0
      if (last !== null) {
        onPreview(last)
        onChange(last)
      }
      last = null
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

const SidePanel = memo(function SidePanel() {
  const sideView = useStoreSelector((s) => s.layout.sideView)
  const sideOpen = useStoreSelector((s) => s.layout.sideOpen)
  const View = VIEWS[sideView] ?? ExplorerView
  return (
    <aside className="panel side" aria-label="Side panel" aria-hidden={!sideOpen}>
      <div className="panel-inner" key={sideView}>
        <View />
      </div>
    </aside>
  )
})

// Global shortcuts, captured before Monaco so ⌘K / ⌘P / ⌘B / ⌘J / ⌘L work everywhere.
function useShortcuts() {
  const actions = useActions()
  const getState = useGetState()
  const ref = useRef({ getState, actions })
  ref.current = { getState, actions }
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Plain typing (no Ctrl / ⌘ / Alt) is never a global shortcut: return before any work, since
      // this runs for every keystroke in the editor.
      if (e.isComposing || !(e.ctrlKey || e.metaKey || e.altKey)) return
      if (ref.current.getState().dialog) return
      const spec = keySpec(e)
      // Focus in the integrated terminal: shell keys (Ctrl+R, Ctrl+K...) go to the shell.
      if (terminalOwnsKey(e, spec)) return
      const a = ref.current.actions
      const s = ref.current.getState()
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
      // Built only for a key that some command binds (commands.tsx BOUND_KEYS), not for every chord.
      if (!isBoundKey(spec)) return
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
  const actions = useActions()
  const l = useStoreSelector((s) => s.layout)
  const appRef = useRef<HTMLDivElement>(null)
  // Drag preview: the panel sizes are CSS variables on .app, set directly until the drag ends.
  const preview = (name: string, v: number) => {
    appRef.current?.style.setProperty(name, `${v}px`)
    if (name === '--right-w' && l.rightOpen) appRef.current?.style.setProperty('--toast-right', `${v}px`)
  }
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
    <div ref={appRef} className={`app${l.sideOpen ? '' : ' side-off'}${l.rightOpen ? '' : ' right-off'}${l.bottomOpen ? '' : ' bottom-off'}`} style={style}>
      <Titlebar />
      <div className="body">
        <ActivityBar />
        <SidePanel />
        {l.sideOpen && <Resizer axis="x" value={l.sideW} min={200} max={() => 480} reset={268} onPreview={(v) => preview('--side-w', v)} onChange={(v) => actions.setLayout({ sideW: v })} onCollapse={() => actions.setLayout({ sideOpen: false })} />}
        <main className="center">
          <EditorArea />
          {l.bottomOpen && <Resizer axis="y" invert value={l.bottomH} min={120} max={() => Math.round((window.innerHeight - 62) * 0.6)} reset={214} onPreview={(v) => preview('--bottom-h', v)} onChange={(v) => actions.setLayout({ bottomH: v })} onCollapse={() => actions.setLayout({ bottomOpen: false })} />}
          <BottomPanel />
        </main>
        {l.rightOpen && <Resizer axis="x" invert value={l.rightW} min={300} max={() => 560} reset={360} onPreview={(v) => preview('--right-w', v)} onChange={(v) => actions.setLayout({ rightW: v })} onCollapse={() => actions.toggleRight(false)} />}
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
