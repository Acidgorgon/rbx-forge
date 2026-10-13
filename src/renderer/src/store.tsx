// App state: one reducer fed by HarnessApi calls and HarnessEvents.
import { createContext, useCallback, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type {
  ChatMessage,
  ChatSession,
  GitStatus,
  LogLine,
  ProjectInfo,
  ScriptGroup,
  ServiceStatus,
  StudioConflict,
  SyncSettings,
  TestAgent,
  TreeNode
} from '@shared/types'

export type Drawer = 'logs' | 'sync' | 'agents' | null
export type SidebarTab = 'explorer' | 'scripts'

export interface OpenFile {
  path: string
  // Contents on disk (last load or save) and in the editor.
  saved: string
  current: string
  loading: boolean
}

export interface Toast {
  id: number
  text: string
}

export interface State {
  project: ProjectInfo | null
  tree: TreeNode[]
  scripts: ScriptGroup[]
  services: ServiceStatus[]
  logs: LogLine[]
  git: GitStatus | null
  studioConflicts: StudioConflict[]
  syncSettings: SyncSettings | null
  chats: ChatSession[]
  activeChatId: string | null
  messages: Record<string, ChatMessage[]>
  busy: Record<string, boolean>
  // Session that most recently went busy; events without a session id land there.
  streamingSession: string | null
  agents: TestAgent[]
  agentMessages: Record<string, ChatMessage[]>
  hasApiKey: boolean | null
  // UI
  sidebarOpen: boolean
  sidebarTab: SidebarTab
  drawer: Drawer
  logFilter: LogLine['service'] | 'all'
  files: OpenFile[]
  activeFile: string | null
  composerInsert: { text: string; nonce: number } | null
  toasts: Toast[]
}

const initial: State = {
  project: null,
  tree: [],
  scripts: [],
  services: [],
  logs: [],
  git: null,
  studioConflicts: [],
  syncSettings: null,
  chats: [],
  activeChatId: null,
  messages: {},
  busy: {},
  streamingSession: null,
  agents: [],
  agentMessages: {},
  hasApiKey: null,
  sidebarOpen: true,
  sidebarTab: 'scripts',
  drawer: null,
  logFilter: 'all',
  files: [],
  activeFile: null,
  composerInsert: null,
  toasts: []
}

type Action =
  | { type: 'set'; patch: Partial<State> }
  | { type: 'log'; line: LogLine }
  | { type: 'logs'; lines: LogLine[] }
  | { type: 'chatMessages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'agentMessages'; agentId: string; messages: ChatMessage[] }
  | { type: 'chatMessage'; message: ChatMessage }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'openFile'; path: string }
  | { type: 'fileLoaded'; path: string; contents: string }
  | { type: 'fileEdit'; path: string; contents: string }
  | { type: 'fileSaved'; path: string; contents: string }
  | { type: 'closeFile'; path: string }
  | { type: 'toast'; toast: Toast }
  | { type: 'dropToast'; id: number }

const MAX_LOGS = 4000

function upsert(list: ChatMessage[], m: ChatMessage): ChatMessage[] {
  const i = list.findIndex((x) => x.id === m.id)
  if (i >= 0) {
    const next = list.slice()
    next[i] = m
    return next
  }
  // Drop the optimistic copy of a user message once the backend echoes it.
  if (m.role === 'user') {
    const j = list.findIndex((x) => x.id.startsWith('local-') && x.text === m.text)
    if (j >= 0) {
      const next = list.slice()
      next[j] = m
      return next
    }
  }
  return [...list, m]
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'set':
      return { ...state, ...a.patch }
    case 'log': {
      const logs = state.logs.length >= MAX_LOGS ? state.logs.slice(-MAX_LOGS + 1) : state.logs.slice()
      logs.push(a.line)
      return { ...state, logs }
    }
    case 'logs':
      return { ...state, logs: a.lines.slice(-MAX_LOGS) }
    case 'chatMessages':
      return { ...state, messages: { ...state.messages, [a.sessionId]: a.messages } }
    case 'agentMessages': {
      // Merge a fetched transcript with anything that streamed in meanwhile.
      let list = a.messages
      for (const m of state.agentMessages[a.agentId] ?? []) list = upsert(list, m)
      return { ...state, agentMessages: { ...state.agentMessages, [a.agentId]: list } }
    }
    case 'chatMessage': {
      const m = a.message
      let next = state
      const fromAgent = !!m.agentId && m.agentId !== 'main'
      // Agent transcript = agent messages without a chat session; with a session id
      // they are the agent's report posted into that chat.
      if (fromAgent && !m.sessionId) {
        const list = state.agentMessages[m.agentId] ?? []
        next = { ...next, agentMessages: { ...next.agentMessages, [m.agentId]: upsert(list, m) } }
      }
      // No session id: a test agent's own transcript (only in the Agents drawer),
      // or an older backend, in which case it belongs to the streaming chat.
      const sid = m.sessionId ?? (fromAgent ? null : state.streamingSession ?? state.activeChatId)
      if (!sid) return next
      return { ...next, messages: { ...next.messages, [sid]: upsert(next.messages[sid] ?? [], m) } }
    }
    case 'busy':
      return {
        ...state,
        busy: { ...state.busy, [a.sessionId]: a.busy },
        streamingSession: a.busy ? a.sessionId : state.streamingSession
      }
    case 'openFile': {
      if (state.files.some((f) => f.path === a.path)) return { ...state, activeFile: a.path }
      return { ...state, files: [...state.files, { path: a.path, saved: '', current: '', loading: true }], activeFile: a.path }
    }
    case 'fileLoaded':
      return { ...state, files: state.files.map((f) => (f.path === a.path ? { ...f, saved: a.contents, current: a.contents, loading: false } : f)) }
    case 'fileEdit':
      return { ...state, files: state.files.map((f) => (f.path === a.path ? { ...f, current: a.contents } : f)) }
    case 'fileSaved':
      return { ...state, files: state.files.map((f) => (f.path === a.path ? { ...f, saved: a.contents } : f)) }
    case 'closeFile': {
      const idx = state.files.findIndex((f) => f.path === a.path)
      const files = state.files.filter((f) => f.path !== a.path)
      let activeFile = state.activeFile
      if (activeFile === a.path) activeFile = files[Math.min(idx, files.length - 1)]?.path ?? null
      return { ...state, files, activeFile }
    }
    case 'toast':
      return { ...state, toasts: [...state.toasts.slice(-2), a.toast] }
    case 'dropToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) }
  }
}

export interface Actions {
  set(patch: Partial<State>): void
  openProject(): Promise<void>
  selectChat(id: string): Promise<void>
  newChat(): Promise<void>
  send(text: string): Promise<void>
  stop(): Promise<void>
  openFile(path: string): Promise<void>
  editFile(path: string, contents: string): void
  saveFile(path: string): Promise<void>
  closeFile(path: string): void
  toast(text: string): void
  copy(text: string, label?: string): Promise<void>
  insertIntoComposer(text: string): void
  refreshSync(): Promise<void>
  loadAgentTranscript(agentId: string): Promise<void>
}

const Ctx = createContext<{ state: State; actions: Actions } | null>(null)

export function useStore(): { state: State; actions: Actions } {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStore outside StoreProvider')
  return v
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const stateRef = useRef(state)
  stateRef.current = state
  const h = window.harness

  const loadProjectData = useCallback(async () => {
    const [tree, scripts] = await Promise.all([h.getTree(), h.getScripts()])
    dispatch({ type: 'set', patch: { tree, scripts } })
  }, [h])

  useEffect(() => {
    const offs = [
      h.on('services:status', (services) => dispatch({ type: 'set', patch: { services } })),
      h.on('log:line', (line) => dispatch({ type: 'log', line })),
      h.on('project:changed', (project) => {
        dispatch({ type: 'set', patch: { project } })
        if (project) void loadProjectData()
        else dispatch({ type: 'set', patch: { tree: [], scripts: [] } })
      }),
      h.on('tree:changed', (tree) => dispatch({ type: 'set', patch: { tree } })),
      h.on('scripts:changed', (scripts) => dispatch({ type: 'set', patch: { scripts } })),
      h.on('git:status', (git) => dispatch({ type: 'set', patch: { git } })),
      h.on('studio:conflicts', (studioConflicts) => dispatch({ type: 'set', patch: { studioConflicts } })),
      h.on('chat:message', (message) => {
        dispatch({ type: 'chatMessage', message })
      }),
      h.on('chat:busy', ({ sessionId, busy }) => {
        dispatch({ type: 'busy', sessionId, busy })
        // Titles are usually set by the backend after the first reply.
        if (!busy) void h.listChats().then((chats) => dispatch({ type: 'set', patch: { chats } }))
      }),
      h.on('agents:changed', (agents) => dispatch({ type: 'set', patch: { agents } }))
    ]

    void (async () => {
      const [project, services, logs, git, studioConflicts, syncSettings, chats, agents, hasApiKey] = await Promise.all([
        h.getProject(),
        h.getServices(),
        h.getLogs(),
        h.getGitStatus().catch(() => null),
        h.getStudioConflicts().catch(() => []),
        h.getSyncSettings().catch(() => null),
        h.listChats(),
        h.getAgents(),
        h.hasApiKey()
      ])
      dispatch({ type: 'set', patch: { project, services, git, studioConflicts, syncSettings, chats, agents, hasApiKey } })
      dispatch({ type: 'logs', lines: logs })
      if (project) await loadProjectData()
    })()

    return () => offs.forEach((off) => off())
  }, [h, loadProjectData])

  const actions = useMemo<Actions>(() => {
    const toast = (text: string) => {
      const id = Date.now() + Math.random()
      dispatch({ type: 'toast', toast: { id, text } })
      setTimeout(() => dispatch({ type: 'dropToast', id }), 2400)
    }
    return {
      set: (patch) => dispatch({ type: 'set', patch }),
      async openProject() {
        const project = await h.openProject()
        if (project) {
          dispatch({ type: 'set', patch: { project } })
          await loadProjectData()
        }
      },
      async selectChat(id) {
        dispatch({ type: 'set', patch: { activeChatId: id } })
        const messages = await h.getChat(id)
        dispatch({ type: 'chatMessages', sessionId: id, messages })
      },
      async newChat() {
        dispatch({ type: 'set', patch: { activeChatId: null } })
      },
      async send(text) {
        let id = stateRef.current.activeChatId
        if (!id) {
          const chat = await h.newChat()
          id = chat.id
          dispatch({ type: 'set', patch: { activeChatId: id, chats: [chat, ...stateRef.current.chats.filter((c) => c.id !== chat.id)] } })
          dispatch({ type: 'chatMessages', sessionId: id, messages: [] })
        }
        const local: ChatMessage = { id: `local-${Date.now()}`, role: 'user', text, at: Date.now(), agentId: 'main', sessionId: id }
        dispatch({ type: 'chatMessage', message: local })
        dispatch({ type: 'busy', sessionId: id, busy: true })
        try {
          await h.sendChat(id, text)
        } catch (e) {
          dispatch({ type: 'busy', sessionId: id, busy: false })
          dispatch({
            type: 'chatMessage',
            message: { id: `err-${Date.now()}`, role: 'system', text: `Could not send: ${(e as Error).message}`, at: Date.now(), agentId: 'main', sessionId: id }
          })
        }
      },
      async stop() {
        const id = stateRef.current.activeChatId
        if (id) await h.stopChat(id)
      },
      async openFile(path) {
        const existing = stateRef.current.files.find((f) => f.path === path)
        dispatch({ type: 'openFile', path })
        if (existing) return
        try {
          const contents = await h.readFile(path)
          dispatch({ type: 'fileLoaded', path, contents })
        } catch (e) {
          dispatch({ type: 'fileLoaded', path, contents: `-- Could not read ${path}: ${(e as Error).message}\n` })
        }
      },
      editFile: (path, contents) => dispatch({ type: 'fileEdit', path, contents }),
      async saveFile(path) {
        const f = stateRef.current.files.find((x) => x.path === path)
        if (!f || f.loading) return
        const contents = f.current
        try {
          await h.writeFile(path, contents)
          dispatch({ type: 'fileSaved', path, contents })
          toast(`Saved ${path.split('/').pop()}`)
        } catch (e) {
          toast(`Save failed: ${(e as Error).message}`)
        }
      },
      closeFile: (path) => dispatch({ type: 'closeFile', path }),
      toast,
      async copy(text, label) {
        try {
          await navigator.clipboard.writeText(text)
          toast(`Copied ${label ?? text}`)
        } catch {
          toast('Clipboard is not available')
        }
      },
      insertIntoComposer(text) {
        dispatch({ type: 'set', patch: { composerInsert: { text, nonce: Date.now() } } })
      },
      async loadAgentTranscript(agentId) {
        try {
          const messages = await h.getChat(agentId)
          dispatch({ type: 'agentMessages', agentId, messages })
        } catch {
          // Transcript not available yet; live events still arrive.
        }
      },
      async refreshSync() {
        const [git, studioConflicts, syncSettings] = await Promise.all([h.getGitStatus(), h.getStudioConflicts(), h.getSyncSettings()])
        dispatch({ type: 'set', patch: { git, studioConflicts, syncSettings } })
      }
    }
  }, [h, loadProjectData])

  return <Ctx.Provider value={{ state, actions }}>{children}</Ctx.Provider>
}
