import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { StoreProvider, useStore } from './store'
import { Sidebar } from './panels/Sidebar'
import { Chat } from './panels/Chat'
import { StatusBar } from './panels/StatusBar'
import { LogsDrawer } from './panels/LogsDrawer'
import { AgentsDrawer } from './panels/AgentsDrawer'
import { PackagesDrawer } from './panels/PackagesDrawer'
import { SettingsDrawer } from './panels/SettingsDrawer'
import { IconSidebar } from './components/Icons'

// Monaco is large: load it the first time a script or the Sync drawer opens.
const EditorPane = lazy(() => import('./panels/EditorPane').then((m) => ({ default: m.EditorPane })))
const SyncDrawer = lazy(() => import('./panels/SyncDrawer').then((m) => ({ default: m.SyncDrawer })))

function Toasts() {
  const { state } = useStore()
  return (
    <div className="toasts" aria-live="polite">
      {state.toasts.map((t) => (
        <div key={t.id} className="toast">{t.text}</div>
      ))}
    </div>
  )
}

function Workspace() {
  const { state, actions } = useStore()
  const hasEditor = state.files.length > 0
  const [split, setSplit] = useState(0.5)
  const mainRef = useRef<HTMLDivElement>(null)
  const dragging = useRef(false)

  useEffect(() => {
    const move = (e: MouseEvent) => {
      if (!dragging.current || !mainRef.current) return
      const r = mainRef.current.getBoundingClientRect()
      setSplit(Math.min(0.75, Math.max(0.3, (e.clientX - r.left) / r.width)))
    }
    const up = () => {
      dragging.current = false
      document.body.classList.remove('resizing')
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
    return () => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
  }, [])

  // Ctrl/Cmd+B toggles the sidebar.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'b') {
        const t = e.target as HTMLElement | null
        if (t?.closest('.monaco-editor')) return
        e.preventDefault()
        actions.set({ sidebarOpen: !state.sidebarOpen })
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions, state.sidebarOpen])

  return (
    <div className={`app${state.sidebarOpen ? '' : ' sidebar-closed'}`}>
      {state.sidebarOpen && <Sidebar />}
      <main className="main" ref={mainRef}>
        {!state.sidebarOpen && (
          <button className="icon-btn floating-toggle" title="Show sidebar (Ctrl+B)" onClick={() => actions.set({ sidebarOpen: true })}>
            <IconSidebar />
          </button>
        )}
        <div className="chat-pane" style={hasEditor ? { width: `${split * 100}%` } : undefined}>
          <Chat />
        </div>
        {hasEditor && (
          <>
            <div
              className="splitter"
              onMouseDown={(e) => {
                e.preventDefault()
                dragging.current = true
                document.body.classList.add('resizing')
              }}
              onDoubleClick={() => setSplit(0.5)}
            />
            <Suspense fallback={<section className="editor-pane"><div className="editor-loading">Loading editor…</div></section>}>
              <EditorPane />
            </Suspense>
          </>
        )}
      </main>
      <StatusBar />
      {state.drawer === 'logs' && <LogsDrawer />}
      {state.drawer === 'agents' && <AgentsDrawer />}
      {state.drawer === 'packages' && <PackagesDrawer />}
      {state.drawer === 'settings' && <SettingsDrawer />}
      {state.drawer === 'sync' && (
        <Suspense fallback={null}>
          <SyncDrawer />
        </Suspense>
      )}
      <Toasts />
    </div>
  )
}

export function App() {
  return (
    <StoreProvider>
      <Workspace />
    </StoreProvider>
  )
}
