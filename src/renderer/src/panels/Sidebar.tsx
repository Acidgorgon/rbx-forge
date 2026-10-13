import { useStore } from '../store'
import { IconChat, IconFolder, IconPlus, IconSidebar } from '../components/Icons'
import { ExplorerPanel } from './ExplorerPanel'
import { ScriptsPanel } from './ScriptsPanel'

function relTime(t: number): string {
  const d = Date.now() - t
  if (d < 60_000) return 'now'
  if (d < 3600_000) return `${Math.floor(d / 60_000)}m`
  if (d < 86400_000) return `${Math.floor(d / 3600_000)}h`
  return `${Math.floor(d / 86400_000)}d`
}

export function Sidebar() {
  const { state, actions } = useStore()
  const { project, chats, activeChatId, sidebarTab } = state

  return (
    <aside className="sidebar">
      <div className="sidebar-top">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg width="18" height="18" viewBox="0 0 24 24">
              <path d="M12 2.5l2.2 6.3 6.6.2-5.3 4 1.9 6.4L12 15.6l-5.4 3.8 1.9-6.4-5.3-4 6.6-.2z" fill="currentColor" />
            </svg>
          </div>
          <div className="brand-text">
            <div className="brand-name" title={project?.root}>{project?.name ?? 'No project'}</div>
            <div className="brand-sub">{project ? shortRoot(project.root) : 'Open a GenTree folder'}</div>
          </div>
          <button className="icon-btn" title="Hide sidebar" onClick={() => actions.set({ sidebarOpen: false })}>
            <IconSidebar />
          </button>
        </div>

        <button className="side-action primary" onClick={() => void actions.newChat()}>
          <span className="side-action-icon"><IconPlus size={15} /></span>
          New chat
        </button>
        <button className="side-action" onClick={() => void actions.openProject()}>
          <span className="side-action-icon"><IconFolder size={15} /></span>
          Open project…
        </button>
      </div>

      <div className="side-section chats">
        <div className="side-label">Recents</div>
        <div className="chat-list">
          {chats.length === 0 && <div className="side-empty">No chats yet</div>}
          {chats.map((c) => (
            <button
              key={c.id}
              className={`chat-item${c.id === activeChatId ? ' active' : ''}`}
              onClick={() => void actions.selectChat(c.id)}
              title={c.title}
            >
              <IconChat size={14} />
              <span className="chat-title">{c.title}</span>
              {state.busy[c.id] ? <span className="busy-dot" /> : <span className="chat-time">{relTime(c.createdAt)}</span>}
            </button>
          ))}
        </div>
      </div>

      <div className="side-tabs" role="tablist">
        <button role="tab" aria-selected={sidebarTab === 'explorer'} className={sidebarTab === 'explorer' ? 'active' : ''} onClick={() => actions.set({ sidebarTab: 'explorer' })}>
          Explorer
        </button>
        <button role="tab" aria-selected={sidebarTab === 'scripts'} className={sidebarTab === 'scripts' ? 'active' : ''} onClick={() => actions.set({ sidebarTab: 'scripts' })}>
          Scripts
        </button>
      </div>
      <div className="side-panel">{sidebarTab === 'explorer' ? <ExplorerPanel /> : <ScriptsPanel />}</div>
    </aside>
  )
}

function shortRoot(root: string): string {
  const parts = root.split(/[\\/]/).filter(Boolean)
  return parts.length > 2 ? `…/${parts.slice(-2).join('/')}` : root
}
