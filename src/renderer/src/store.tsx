// App state: one reducer fed by HarnessApi calls and HarnessEvents, plus the workbench layout
// (panels, tabs, palette) persisted per machine in localStorage.
import { createContext, useContext, useEffect, useMemo, useReducer, useRef, type ReactNode } from 'react'
import type { ChatMode } from '@shared/chatModes'
import type {
  AppSettings,
  BlinkModel,
  BoardView,
  ChatImage,
  ChatMessage,
  ChatSession,
  EffortChoice,
  ClaimView,
  GitStatus,
  LogLine,
  LuneStatus,
  ModelChoice,
  PlaceInfo,
  ProjectInfo,
  ProviderId,
  ProviderInfo,
  RunRequest,
  RunSummary,
  ScriptGroup,
  ServiceStatus,
  SpecFile,
  StudioConflict,
  SyncSettings,
  TestAgent,
  TestCaseResult,
  TreeNode,
  UsageSnapshot
} from '@shared/types'
import { basename, instanceNameOfFile } from './lib/roblox'
import { errorText } from './lib/format'
import { isUnder, movedPath, type PathChange, type TrashBatchResult } from '@shared/fileOps'
import { diskReloadAction, openPathsIn } from './lib/diskReload'
import type { SaveReason } from '@shared/editorAssist/policy'
import { runBeforeSave } from './editorAssist/saveHooks'
import * as EG from '@shared/editorGroups'
import { scriptInjectionToasts } from '@shared/studio/errors'
import type { GroupsState } from '@shared/editorGroups'

// ---------------------------------------------------------------- types

export type SideView = 'explorer' | 'scripts' | 'events' | 'sync' | 'tests' | 'team'
export type BottomTab = 'output' | 'problems' | 'terminal' | 'shell'
export type PageKind = 'forge' | 'settings' | 'packages' | 'release' | 'analytics' | 'memory' | 'groups' | 'art' | 'uipreview' | 'vfx' | 'anim' | 'ability' | 'thumbs' | 'uimotion' | 'model'
export type TabKind = PageKind | 'file' | 'conflict' | 'transcript'

export interface Tab {
  id: string
  kind: TabKind
  title: string
  // file / conflict: repo-relative path
  path?: string
  // Preview tabs (single click) are italic and replaced by the next preview.
  preview?: boolean
  // transcript: chat id to read with getChat (test agent id, or orch:<run>:<task>)
  agentId?: string
}

export interface OpenFile {
  path: string
  saved: string
  current: string
  loading: boolean
}

export interface ToastSpec {
  id: number
  text: string
  detail?: string
  kind?: 'info' | 'ok' | 'err' | 'hot'
  action?: { label: string; run: () => void }
  // Auto-dismiss after this many ms (default 6000; 0 = stays).
  ms?: number
  at: number
}

export interface ProblemItem {
  path: string
  line: number
  col: number
  message: string
  severity: 'error' | 'warning' | 'info'
  source: string
  code?: string
}

export interface Layout {
  sideOpen: boolean
  sideView: SideView
  sideW: number
  bottomOpen: boolean
  bottomH: number
  bottomTab: BottomTab
  rightOpen: boolean
  rightW: number
  // Side panel was collapsed automatically when the Assistant opened on a narrow window.
  sideAuto: boolean
}

export interface TestsState {
  status: LuneStatus | null
  specs: SpecFile[]
  last: RunSummary | null
  running: boolean
  live: TestCaseResult[]
  files: string[]
  watching: boolean
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
  places: PlaceInfo[]
  activePlace: string | null
  appSettings: AppSettings | null
  chats: ChatSession[]
  activeChatId: string | null
  messages: Record<string, ChatMessage[]>
  busy: Record<string, boolean>
  streamingSession: string | null
  agents: TestAgent[]
  agentMessages: Record<string, ChatMessage[]>
  hasApiKey: boolean | null
  providers: ProviderInfo[] | null
  defaultModel: ModelChoice | null
  pendingModel: ModelChoice | null
  // Effort picked before the chat exists (applied by newChat).
  pendingEffort: EffortChoice | null
  settingsFocus: ProviderId | null
  blink: BlinkModel | null
  usage: { chat: UsageSnapshot | null; day: UsageSnapshot | null; agents: Record<string, UsageSnapshot> }
  boards: BoardView[]
  tests: TestsState
  claims: ClaimView[]
  // Editor
  files: OpenFile[]
  // Every open tab once (a file open in two groups is one entry); `editor` says which group shows what.
  tabs: Tab[]
  // Split editor: groups, their tabs and the layout tree (@shared/editorGroups).
  editor: GroupsState
  // The active group's active tab.
  activeTab: string
  // Path of the active file tab (null for pages).
  activeFile: string | null
  recent: string[]
  reveal: { path: string; line: number; column: number; nonce: number } | null
  editorProblems: ProblemItem[]
  lint: ProblemItem[]
  lintAt: number | null
  lsp: { state: 'starting' | 'ready' | 'stopped' | 'off'; detail?: string }
  // UI
  layout: Layout
  logServices: string[]
  palette: { prefix: string; nonce: number } | null
  composerInsert: { text: string; nonce: number } | null
  toasts: ToastSpec[]
  notifications: ToastSpec[]
  explorerReveal: { instancePath: string[]; nonce: number } | null
  // Explorer create flow requested from elsewhere (palette, Forge tab, shortcut).
  createRequest: { kind: CreateKind; nonce: number } | null
  dialog: DialogRequest | null
}

export type DialogRequest =
  | { kind: 'renameFeature'; from?: string }
  | { kind: 'renamePath'; path: string; isDir: boolean }
  | { kind: 'joinProject' }
  | { kind: 'newProject' }
  | { kind: 'blinkEvent' }
  | { kind: 'featureBranch' }
  | { kind: 'pullRequest' }
  // list: paths shown under the body; dontAsk: the AppSettings switch a "Don't ask again" box turns off.
  | { kind: 'confirm'; title: string; body: string; confirm: string; danger?: boolean; run: () => void; list?: string[]; dontAsk?: 'confirmFileDelete' | 'confirmStudioDelete' }

export type CreateKind = 'ModuleScript' | 'Script' | 'LocalScript' | 'Feature' | 'Folder' | 'Blink'

// ---------------------------------------------------------------- layout persistence

const LAYOUT_KEY = 'forge.layout.v1'
// Labs model-call failures already shown (lab|error -> time), so a refine loop does not stack toasts.
const labErrorSeen = new Map<string, number>()
// Studio blocking the Forge Bridge plugin's script writes (Script Injection off), from any Studio job:
// one toast with the steps instead of one per failed job.
const studioInjectionToast = scriptInjectionToasts()
const LAB_NAMES: Record<string, string> = { vfx: 'VFX Lab', anim: 'Animation Lab', ability: 'Ability Composer', thumbs: 'Thumbnail Lab', uimotion: 'UI Motion Lab', model: 'Model Lab' }
const DEFAULT_LAYOUT: Layout = { sideOpen: true, sideView: 'explorer', sideW: 268, bottomOpen: true, bottomH: 214, bottomTab: 'output', rightOpen: true, rightW: 360, sideAuto: false }

function loadLayout(): Layout {
  try {
    const raw = JSON.parse(localStorage.getItem(LAYOUT_KEY) ?? '{}') as Partial<Layout>
    return { ...DEFAULT_LAYOUT, ...raw }
  } catch {
    return DEFAULT_LAYOUT
  }
}

function saveLayout(l: Layout): void {
  try {
    localStorage.setItem(LAYOUT_KEY, JSON.stringify(l))
  } catch {
    // Not persisted.
  }
}

const FORGE_TAB: Tab = { id: 'forge', kind: 'forge', title: 'Forge' }

const initial: State = {
  project: null,
  tree: [],
  scripts: [],
  services: [],
  logs: [],
  git: null,
  studioConflicts: [],
  syncSettings: null,
  places: [],
  activePlace: null,
  appSettings: null,
  chats: [],
  activeChatId: null,
  messages: {},
  busy: {},
  streamingSession: null,
  agents: [],
  agentMessages: {},
  hasApiKey: null,
  providers: null,
  defaultModel: null,
  pendingModel: null,
  pendingEffort: null,
  settingsFocus: null,
  blink: null,
  usage: { chat: null, day: null, agents: {} },
  boards: [],
  tests: { status: null, specs: [], last: null, running: false, live: [], files: [], watching: false },
  claims: [],
  files: [],
  tabs: [FORGE_TAB],
  editor: EG.initialGroups(['forge'], 'forge'),
  activeTab: 'forge',
  activeFile: null,
  recent: [],
  reveal: null,
  editorProblems: [],
  lint: [],
  lintAt: null,
  lsp: { state: 'off' },
  layout: loadLayout(),
  logServices: [],
  palette: null,
  composerInsert: null,
  toasts: [],
  notifications: [],
  explorerReveal: null,
  createRequest: null,
  dialog: null
}

// ---------------------------------------------------------------- reducer

type Action =
  | { type: 'set'; patch: Partial<State> }
  | { type: 'layout'; patch: Partial<Layout> }
  | { type: 'log'; line: LogLine }
  | { type: 'logs'; lines: LogLine[] }
  | { type: 'chatMessages'; sessionId: string; messages: ChatMessage[] }
  | { type: 'agentMessages'; agentId: string; messages: ChatMessage[] }
  | { type: 'chatMessage'; message: ChatMessage }
  | { type: 'busy'; sessionId: string; busy: boolean }
  | { type: 'openTab'; tab: Tab; preview?: boolean }
  | { type: 'projectSwitched' }
  | { type: 'activate'; id: string; group?: string }
  | { type: 'pin'; id: string }
  // Without `group`: closes the tab in every group.
  | { type: 'closeTab'; id: string; group?: string }
  | { type: 'groups'; update: (gs: GroupsState) => GroupsState }
  | { type: 'restoreGroups'; raw: unknown }
  | { type: 'fileLoaded'; path: string; contents: string }
  | { type: 'fileEdit'; path: string; contents: string }
  | { type: 'fileSaved'; path: string; contents: string }
  // The file changed on disk while its tab was clean: applies only if the tab is still clean at `saved`.
  | { type: 'fileReloaded'; path: string; contents: string; saved: string }
  // An Explorer rename (to) or delete (to: null) of a file or folder: its tabs follow or close.
  | { type: 'pathChanged'; from: string; to: string | null }
  | { type: 'toast'; toast: ToastSpec }
  | { type: 'dropToast'; id: number }
  | { type: 'board'; board: BoardView }
  | { type: 'tests'; patch: Partial<TestsState> }
  | { type: 'testResult'; result: TestCaseResult }

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

// Applies a new group state: drops tabs no group shows (and their file buffers), puts the Forge tab
// back when nothing is open, and derives activeTab / activeFile / recent from the active group.
function withGroups(state: State, editor: GroupsState, registry: Tab[] = state.tabs): State {
  if (!EG.allTabIds(editor).length) editor = EG.openTab(editor, FORGE_TAB.id)
  const byId = new Map(registry.map((t) => [t.id, t]))
  if (!byId.has(FORGE_TAB.id)) byId.set(FORGE_TAB.id, FORGE_TAB)
  editor = EG.retainTabs(editor, (id) => byId.has(id))
  if (!EG.allTabIds(editor).length) editor = EG.openTab(editor, FORGE_TAB.id)
  const tabs = EG.allTabIds(editor).map((id) => byId.get(id)!)
  const openPaths = new Set(tabs.filter((t) => t.kind === 'file' && t.path).map((t) => t.path!))
  // Buffers of file tabs that just closed go; others (none expected) are left alone.
  const closedPaths = new Set(state.tabs.filter((t) => t.kind === 'file' && t.path && !openPaths.has(t.path)).map((t) => t.path!))
  const files = closedPaths.size ? state.files.filter((f) => !closedPaths.has(f.path)) : state.files
  const activeTab = EG.activeTabOf(editor) ?? tabs[0].id
  const tab = tabs.find((t) => t.id === activeTab)
  const activeFile = tab?.kind === 'file' ? tab.path ?? null : null
  let recent = state.recent
  if (activeFile && recent[0] !== activeFile) recent = [activeFile, ...recent.filter((p) => p !== activeFile)].slice(0, 20)
  return { ...state, tabs, files, editor, activeTab, activeFile, recent }
}

// Activates a tab: in `group`, else in the active group when it has it, else where it is open.
function withActive(state: State, id: string, group?: string): State {
  const gs = state.editor
  const where = group && EG.getGroup(gs, group)?.tabs.includes(id) ? group : EG.activeGroupOf(gs).tabs.includes(id) ? gs.activeGroup : EG.groupsWithTab(gs, id)[0]
  if (!where) return state
  return withGroups(state, EG.activateTab(gs, where, id))
}

function reducer(state: State, a: Action): State {
  switch (a.type) {
    case 'set':
      return { ...state, ...a.patch }
    case 'projectSwitched': {
      // File and conflict tabs hold repo-relative paths of the previous project: saving one would
      // write into the new project. Close them with their buffers.
      const keep = new Set(state.tabs.filter((t) => t.kind !== 'file' && t.kind !== 'conflict').map((t) => t.id))
      return withGroups({ ...state, files: [] }, EG.retainTabs(state.editor, (id) => keep.has(id)))
    }
    case 'layout': {
      const layout = { ...state.layout, ...a.patch }
      saveLayout(layout)
      return { ...state, layout }
    }
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
      let list = a.messages
      for (const m of state.agentMessages[a.agentId] ?? []) list = upsert(list, m)
      return { ...state, agentMessages: { ...state.agentMessages, [a.agentId]: list } }
    }
    case 'chatMessage': {
      const m = a.message
      let next = state
      const fromAgent = !!m.agentId && m.agentId !== 'main'
      if (fromAgent && !m.sessionId) {
        const list = state.agentMessages[m.agentId] ?? []
        next = { ...next, agentMessages: { ...next.agentMessages, [m.agentId]: upsert(list, m) } }
      }
      const sid = m.sessionId ?? (fromAgent ? null : state.streamingSession ?? state.activeChatId)
      if (!sid) return next
      return { ...next, messages: { ...next.messages, [sid]: upsert(next.messages[sid] ?? [], m) } }
    }
    case 'busy':
      return { ...state, busy: { ...state.busy, [a.sessionId]: a.busy }, streamingSession: a.busy ? a.sessionId : state.streamingSession }
    case 'openTab': {
      const gs = state.editor
      const group = EG.activeGroupOf(gs)
      const existing = state.tabs.find((t) => t.id === a.tab.id)
      // Opening a preview tab for real pins it.
      const pinned = existing && !a.preview && existing.preview ? state.tabs.map((t) => (t.id === existing.id ? { ...t, preview: false } : t)) : state.tabs
      if (existing) {
        // Pages, conflicts and transcripts live in one group: show them where they are. A file opens in
        // the active group (a second view when another group has it).
        const where = existing.kind === 'file' ? (group.tabs.includes(existing.id) ? group.id : null) : EG.groupsWithTab(gs, existing.id)[0] ?? null
        if (where) return withGroups({ ...state, tabs: pinned }, EG.activateTab(gs, where, existing.id), pinned)
        return withGroups({ ...state, tabs: pinned }, EG.openTab(gs, existing.id, { group: group.id }), pinned)
      }
      const tab = { ...a.tab, preview: !!a.preview }
      if (a.preview) {
        // Replace this group's preview tab (dropping its clean buffer when no other group shows it).
        const prevId = group.tabs.find((id) => state.tabs.find((t) => t.id === id)?.preview)
        const prev = prevId ? state.tabs.find((t) => t.id === prevId) : undefined
        if (prev) {
          const buf = prev.path ? state.files.find((f) => f.path === prev.path) : null
          if (!buf || buf.current === buf.saved) {
            const registry = [...state.tabs, tab]
            return withGroups(addBuffer(state, tab), EG.openTab(gs, tab.id, { group: group.id, replace: prev.id }), registry)
          }
        }
      }
      return withGroups(addBuffer(state, tab), EG.openTab(gs, tab.id, { group: group.id }), [...state.tabs, tab])
    }
    case 'activate':
      return withActive(state, a.id, a.group)
    case 'pin':
      return { ...state, tabs: state.tabs.map((t) => (t.id === a.id ? { ...t, preview: false } : t)) }
    case 'closeTab': {
      if (!state.tabs.some((t) => t.id === a.id)) return state
      return withGroups(state, a.group ? EG.closeTab(state.editor, a.group, a.id) : EG.closeTabEverywhere(state.editor, a.id))
    }
    case 'groups': {
      const editor = a.update(state.editor)
      return editor === state.editor ? state : withGroups(state, editor)
    }
    case 'restoreGroups': {
      const ids = new Set(state.tabs.map((t) => t.id))
      const restored = EG.sanitizeGroups(a.raw, (id) => ids.has(id))
      if (!restored) return state
      // Tabs open now but missing from the saved layout stay, in the first group.
      const first = EG.groupOrder(restored)[0]
      let gs = restored
      for (const id of EG.allTabIds(state.editor)) if (!EG.groupsWithTab(gs, id).length) gs = EG.openTab(gs, id, { group: first })
      return withGroups(state, { ...gs, activeGroup: restored.activeGroup })
    }
    case 'fileLoaded':
      return { ...state, files: state.files.map((f) => (f.path === a.path ? { ...f, saved: a.contents, current: a.contents, loading: false } : f)) }
    case 'fileEdit': {
      // The first edit pins a preview tab.
      const tabs = state.tabs.some((t) => t.kind === 'file' && t.path === a.path && t.preview) ? state.tabs.map((t) => (t.kind === 'file' && t.path === a.path ? { ...t, preview: false } : t)) : state.tabs
      return { ...state, tabs, files: state.files.map((f) => (f.path === a.path ? { ...f, current: a.contents } : f)) }
    }
    case 'fileReloaded':
      return { ...state, files: state.files.map((f) => (f.path === a.path && !f.loading && f.saved === a.saved && f.current === a.saved ? { ...f, saved: a.contents, current: a.contents } : f)) }
    case 'fileSaved':
      return { ...state, files: state.files.map((f) => (f.path === a.path ? { ...f, saved: a.contents } : f)) }
    case 'pathChanged': {
      const hit = (path?: string) => !!path && isUnder(path, a.from)
      if (a.to === null) {
        let next = state
        for (const t of state.tabs) if ((t.kind === 'file' || t.kind === 'conflict') && hit(t.path)) next = reducer(next, { type: 'closeTab', id: t.id })
        return { ...next, files: next.files.filter((f) => !hit(f.path)), recent: next.recent.filter((p) => !hit(p)) }
      }
      const move = (path: string) => movedPath(path, a.from, a.to!) ?? path
      let editor = state.editor
      const tabs = state.tabs.map((t) => {
        if ((t.kind !== 'file' && t.kind !== 'conflict') || !hit(t.path)) return t
        const path = move(t.path!)
        const next = t.kind === 'file' ? { ...t, id: `file:${path}`, path, title: tabTitle(path) } : { ...t, id: `conflict:${path}`, path, title: `${tabTitle(path)} ⇄ Studio` }
        editor = EG.renameTab(editor, t.id, next.id)
        return next
      })
      const files = state.files.map((f) => (hit(f.path) ? { ...f, path: move(f.path) } : f))
      // The renamed tabs replace the old entries (no buffers to drop: they moved with them).
      return withGroups({ ...state, tabs, files, recent: state.recent.map(move) }, editor, tabs)
    }
    case 'toast': {
      const toasts = [...state.toasts, a.toast].slice(-3)
      return { ...state, toasts, notifications: [a.toast, ...state.notifications].slice(0, 50) }
    }
    case 'dropToast':
      return { ...state, toasts: state.toasts.filter((t) => t.id !== a.id) }
    case 'board': {
      const i = state.boards.findIndex((b) => b.runId === a.board.runId)
      const boards = i >= 0 ? state.boards.map((b, j) => (j === i ? a.board : b)) : [a.board, ...state.boards]
      return { ...state, boards }
    }
    case 'tests':
      return { ...state, tests: { ...state.tests, ...a.patch } }
    case 'testResult':
      return { ...state, tests: { ...state.tests, live: [...state.tests.live, a.result] } }
  }
}

function addBuffer(state: State, tab: Tab): State {
  if (tab.kind !== 'file' || !tab.path || state.files.some((f) => f.path === tab.path)) return state
  return { ...state, files: [...state.files, { path: tab.path, saved: '', current: '', loading: true }] }
}

// ---------------------------------------------------------------- actions

export interface ToastInput {
  text: string
  detail?: string
  kind?: ToastSpec['kind']
  action?: ToastSpec['action']
  ms?: number
}

export interface Actions {
  set(patch: Partial<State>): void
  setLayout(patch: Partial<Layout>): void
  openProject(): Promise<void>
  // Tabs and files
  openFile(path: string, options?: { preview?: boolean }): Promise<void>
  openFileAt(path: string, line: number, column?: number): Promise<void>
  openPage(kind: PageKind): void
  openConflict(path: string): void
  openTranscript(agentId: string, title: string): void
  // `group`: the editor group (split editor) to act in; default the active group / wherever it is.
  activateTab(id: string, group?: string): void
  pinTab(id: string): void
  // Without `group` the tab closes in every group.
  closeTab(id: string, group?: string): void
  // Split editor: any change to the groups (see @shared/editorGroups and shell/editorGroups.ts).
  editorGroups(update: (gs: GroupsState) => GroupsState): void
  // A layout saved by QolRoot, applied over the tabs open now.
  restoreGroups(raw: unknown): void
  editFile(path: string, contents: string): void
  // reason 'auto' = autosave (editorAssist/autosave): skipped when nothing changed, and formats only
  // when "format on autosave" is on.
  saveFile(path: string, opts?: { reason?: SaveReason }): Promise<void>
  reloadFile(path: string): Promise<void>
  // Explorer rename / move to trash; open tabs follow the new path or close (unsaved edits included:
  // the Explorer asks first).
  renamePath(path: string, name: string, isDir?: boolean): Promise<PathChange>
  trashPath(path: string, isDir?: boolean): Promise<PathChange>
  // Explorer multi-select delete: one batch in main; each entry that went closes its tabs.
  trashPaths(entries: { path: string; isDir?: boolean }[]): Promise<TrashBatchResult>
  // Panels
  showSide(view: SideView): void
  toggleSide(): void
  toggleBottom(tab?: BottomTab): void
  showBottom(tab: BottomTab, services?: string[]): void
  toggleRight(open?: boolean): void
  openPalette(prefix?: string): void
  requestCreate(kind: CreateKind): void
  openDialog(dialog: DialogRequest | null): void
  revealInstance(instancePath: string[]): void
  // Feedback
  toast(input: string | ToastInput): void
  copy(text: string, label?: string): Promise<void>
  insertIntoComposer(text: string): void
  ask(text: string): void
  // Chat
  selectChat(id: string): Promise<void>
  newChat(): Promise<void>
  // Asks in the app's confirm dialog, then deletes the chats (deleteChats).
  askDeleteChats(ids: string[]): void
  // Deletes chats for good. When the active chat goes, its neighbour in the list opens (or a fresh chat).
  deleteChats(ids: string[]): Promise<void>
  // opts.mode: this message only in that chat mode (/ask, /plan).
  send(text: string, images?: ChatImage[], opts?: { mode?: ChatMode }): Promise<void>
  // The active chat's id, creating the chat first when there is none (slash commands).
  ensureChat(): Promise<string>
  stop(): Promise<void>
  chooseModel(choice: ModelChoice): Promise<void>
  openSettings(focus?: ProviderId): void
  refreshProviders(): Promise<void>
  addGuest(choice: ModelChoice): Promise<void>
  removeGuest(alias: string): Promise<void>
  setGuestTools(on: boolean): Promise<void>
  startRoundtable(topic: string, rounds: number): Promise<void>
  planToChecklist(messageId: string): Promise<void>
  startOrchestration(text: string): Promise<void>
  loadAgentTranscript(agentId: string): Promise<void>
  // Project services
  refreshSync(): Promise<void>
  setActivePlace(file: string): Promise<void>
  setAppSettings(patch: Partial<AppSettings>): Promise<void>
  restartService(id: ServiceStatus['id']): Promise<void>
  // Tests
  runTests(request: RunRequest): Promise<RunSummary | null>
  refreshTests(): Promise<void>
  createSpec(modulePath: string): Promise<void>
  runLint(): Promise<void>
}

const Ctx = createContext<{ state: State; actions: Actions } | null>(null)

export function useStore(): { state: State; actions: Actions } {
  const v = useContext(Ctx)
  if (!v) throw new Error('useStore outside StoreProvider')
  return v
}

export function tabTitle(path: string): string {
  if (/\.(luau?)$/.test(path)) return instanceNameOfFile(path)
  return basename(path)
}

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initial)
  const stateRef = useRef(state)
  stateRef.current = state
  const h = window.harness

  const actions = useMemo<Actions>(() => {
    // In-flight saves per path (saveFile chains them).
    const saving = new Map<string, Promise<void>>()
    const toast = (input: string | ToastInput) => {
      const spec = studioInjectionToast(typeof input === 'string' ? { text: input } : input)
      if (!spec) return
      dispatch({ type: 'toast', toast: { id: Date.now() + Math.random(), at: Date.now(), ...spec } })
    }
    const loadProjectData = async () => {
      const [tree, scripts, places, active] = await Promise.all([h.getTree(), h.getScripts(), h.listPlaces().catch(() => []), h.getActivePlace().catch(() => null)])
      dispatch({ type: 'set', patch: { tree, scripts, places, activePlace: active?.file ?? null } })
    }
    const loadFile = async (path: string) => {
      try {
        dispatch({ type: 'fileLoaded', path, contents: await h.readFile(path) })
      } catch (e) {
        dispatch({ type: 'fileLoaded', path, contents: `-- Could not read ${path}: ${errorText(e)}\n` })
      }
    }
    const ensureChat = async (): Promise<string> => {
      let id = stateRef.current.activeChatId
      if (id) return id
      const pe = stateRef.current.pendingEffort
      const chat = await h.newChat(stateRef.current.pendingModel ?? undefined, pe ? { effort: pe } : undefined)
      id = chat.id
      dispatch({ type: 'set', patch: { activeChatId: id, pendingModel: null, pendingEffort: null, chats: [chat, ...stateRef.current.chats.filter((c) => c.id !== chat.id)] } })
      dispatch({ type: 'chatMessages', sessionId: id, messages: [] })
      return id
    }
    const updateChat = (chat: ChatSession) => dispatch({ type: 'set', patch: { chats: stateRef.current.chats.map((c) => (c.id === chat.id ? chat : c)) } })
    const layout = (patch: Partial<Layout>) => dispatch({ type: 'layout', patch })

    const self: Actions = {
      set: (patch) => dispatch({ type: 'set', patch }),
      setLayout: layout,
      async openProject() {
        const unsaved = stateRef.current.files.filter((f) => f.current !== f.saved).length
        if (unsaved && !window.confirm(`${unsaved} file${unsaved === 1 ? ' has' : 's have'} unsaved changes. Opening another project closes ${unsaved === 1 ? 'it' : 'them'} without saving. Continue?`)) return
        try {
          const project = await h.openProject()
          if (project) {
            dispatch({ type: 'set', patch: { project } })
            await loadProjectData()
          }
        } catch (e) {
          toast({ text: 'Could not open the project', detail: errorText(e), kind: 'err' })
        }
      },

      async openFile(path, options) {
        const had = stateRef.current.files.some((f) => f.path === path)
        dispatch({ type: 'openTab', tab: { id: `file:${path}`, kind: 'file', title: tabTitle(path), path }, preview: options?.preview })
        if (!had) await loadFile(path)
      },
      async openFileAt(path, line, column = 1) {
        dispatch({ type: 'set', patch: { reveal: { path, line, column, nonce: Date.now() } } })
        await self.openFile(path)
      },
      openPage(kind) {
        const titles: Record<PageKind, string> = { forge: 'Forge', settings: 'Settings', packages: 'Packages', release: 'Release', analytics: 'Analytics', memory: 'Memory', groups: 'Group chats', art: 'Art', uipreview: 'UI Preview', vfx: 'VFX Lab', anim: 'Animation Lab', ability: 'Ability Composer', thumbs: 'Thumbnail Lab', uimotion: 'UI Motion Lab', model: 'Model Lab' }
        dispatch({ type: 'openTab', tab: { id: kind, kind, title: titles[kind] } })
      },
      openConflict(path) {
        dispatch({ type: 'openTab', tab: { id: `conflict:${path}`, kind: 'conflict', title: `${tabTitle(path)} ⇄ Studio`, path } })
      },
      openTranscript(agentId, title) {
        dispatch({ type: 'openTab', tab: { id: `transcript:${agentId}`, kind: 'transcript', title, agentId } })
      },
      activateTab: (id, group) => dispatch({ type: 'activate', id, group }),
      pinTab: (id) => dispatch({ type: 'pin', id }),
      closeTab: (id, group) => dispatch({ type: 'closeTab', id, group }),
      editorGroups: (update) => dispatch({ type: 'groups', update }),
      restoreGroups: (raw) => dispatch({ type: 'restoreGroups', raw }),
      editFile: (path, contents) => dispatch({ type: 'fileEdit', path, contents }),
      async saveFile(path, opts) {
        const reason = opts?.reason ?? 'manual'
        // Saves of one file run one after another, so an older text never lands on disk last.
        const run = async () => {
          const f = stateRef.current.files.find((x) => x.path === path)
          if (!f || f.loading) return
          if (reason === 'auto' && f.current === f.saved) return
          // Format on save (StyLua) rewrites the buffer first, as one undo step.
          const contents = await runBeforeSave(path, f.current, reason)
          if (contents !== f.current) dispatch({ type: 'fileEdit', path, contents })
          try {
            await h.writeFile(path, contents)
            dispatch({ type: 'fileSaved', path, contents })
          } catch (e) {
            toast({ text: `Could not save ${basename(path)}`, detail: errorText(e), kind: 'err' })
          }
        }
        const next = (saving.get(path) ?? Promise.resolve()).then(run, run)
        saving.set(path, next)
        await next
        if (saving.get(path) === next) saving.delete(path)
      },
      async reloadFile(path) {
        if (stateRef.current.files.some((f) => f.path === path)) await loadFile(path)
      },
      async renamePath(path, name, isDir) {
        const change = await h.renamePath(path, name, isDir)
        dispatch({ type: 'pathChanged', from: change.from, to: change.to })
        return change
      },
      async trashPath(path, isDir) {
        const change = await h.trashPath(path, isDir)
        dispatch({ type: 'pathChanged', from: change.from, to: null })
        return change
      },
      async trashPaths(entries) {
        const result = await h.trashPaths(entries)
        for (const change of result.changes) dispatch({ type: 'pathChanged', from: change.from, to: null })
        return result
      },

      showSide(view) {
        const l = stateRef.current.layout
        if (l.sideOpen && l.sideView === view) layout({ sideOpen: false, sideAuto: false })
        else layout({ sideOpen: true, sideView: view, sideAuto: false })
      },
      toggleSide() {
        layout({ sideOpen: !stateRef.current.layout.sideOpen, sideAuto: false })
      },
      toggleBottom(tab) {
        const l = stateRef.current.layout
        if (tab && l.bottomOpen && l.bottomTab !== tab) layout({ bottomTab: tab })
        else layout({ bottomOpen: !l.bottomOpen, ...(tab ? { bottomTab: tab } : {}) })
      },
      showBottom(tab, services) {
        layout({ bottomOpen: true, bottomTab: tab })
        if (services) dispatch({ type: 'set', patch: { logServices: services } })
      },
      toggleRight(open) {
        const l = stateRef.current.layout
        const next = open ?? !l.rightOpen
        if (next === l.rightOpen) return
        // Below 1180px the Assistant borrows the side panel's room and gives it back on close.
        if (next && window.innerWidth < 1180 && l.sideOpen) layout({ rightOpen: true, sideOpen: false, sideAuto: true })
        else if (!next && l.sideAuto) layout({ rightOpen: false, sideOpen: true, sideAuto: false })
        else layout({ rightOpen: next })
      },
      openPalette(prefix = '') {
        dispatch({ type: 'set', patch: { palette: { prefix, nonce: Date.now() } } })
      },
      openDialog(dialog) {
        dispatch({ type: 'set', patch: { dialog } })
      },
      requestCreate(kind) {
        if (kind === 'Blink') {
          dispatch({ type: 'set', patch: { dialog: { kind: 'blinkEvent' } } })
          return
        }
        layout({ sideOpen: true, sideView: 'explorer' })
        dispatch({ type: 'set', patch: { createRequest: { kind, nonce: Date.now() } } })
      },
      revealInstance(instancePath) {
        layout({ sideOpen: true, sideView: 'explorer' })
        dispatch({ type: 'set', patch: { explorerReveal: { instancePath, nonce: Date.now() } } })
      },

      toast,
      async copy(text, label) {
        try {
          await navigator.clipboard.writeText(text)
          toast({ text: `Copied ${label ?? 'to clipboard'}`, detail: label ? undefined : text, kind: 'ok', ms: 2600 })
        } catch {
          toast({ text: 'Clipboard is not available', kind: 'err' })
        }
      },
      insertIntoComposer(text) {
        dispatch({ type: 'set', patch: { composerInsert: { text, nonce: Date.now() } } })
        self.toggleRight(true)
      },
      ask(text) {
        self.toggleRight(true)
        dispatch({ type: 'set', patch: { composerInsert: { text, nonce: Date.now() } } })
      },

      async selectChat(id) {
        dispatch({ type: 'set', patch: { activeChatId: id } })
        const [messages, usage] = await Promise.all([h.getChat(id), h.getUsage('chat', id).catch(() => null)])
        dispatch({ type: 'chatMessages', sessionId: id, messages })
        dispatch({ type: 'set', patch: { usage: { ...stateRef.current.usage, chat: usage } } })
      },
      async newChat() {
        dispatch({ type: 'set', patch: { activeChatId: null, pendingModel: null, pendingEffort: null, usage: { ...stateRef.current.usage, chat: null } } })
      },
      askDeleteChats(ids) {
        const list = stateRef.current.chats.filter((c) => ids.includes(c.id))
        if (!list.length) return
        const one = list.length === 1
        const running = list.filter((c) => stateRef.current.busy[c.id]).length
        self.openDialog({
          kind: 'confirm',
          title: one ? `Delete “${list[0].title || 'Untitled'}”?` : `Delete ${list.length} chats?`,
          body: `${one ? 'The conversation, its images and its /rewind checkpoints are' : 'Their conversations, images and /rewind checkpoints are'} deleted for good. Project files stay as they are.${!running ? '' : one ? ' It is still working; the turn is stopped first.' : ` ${running} of them ${running === 1 ? 'is' : 'are'} still working; those turns are stopped first.`}`,
          confirm: one ? 'Delete chat' : `Delete ${list.length} chats`,
          danger: true,
          ...(one ? {} : { list: list.slice(0, 12).map((c) => c.title || 'Untitled').concat(list.length > 12 ? [`…and ${list.length - 12} more`] : []) }),
          run: () => void self.deleteChats(list.map((c) => c.id))
        })
      },
      async deleteChats(ids) {
        if (!ids.length) return
        const before = stateRef.current.chats
        try {
          await h.deleteChats(ids)
        } catch (e) {
          toast({ text: ids.length === 1 ? 'Could not delete the chat' : 'Could not delete the chats', detail: errorText(e), kind: 'err' })
          return
        }
        const gone = new Set(ids)
        const cur = stateRef.current
        const messages = { ...cur.messages }
        const busy = { ...cur.busy }
        for (const id of ids) {
          delete messages[id]
          delete busy[id]
        }
        dispatch({ type: 'set', patch: { chats: cur.chats.filter((c) => !gone.has(c.id)), messages, busy, ...(cur.streamingSession && gone.has(cur.streamingSession) ? { streamingSession: null } : {}) } })
        const active = cur.activeChatId
        if (active && gone.has(active)) {
          const at = before.findIndex((c) => c.id === active)
          const next = before.slice(at + 1).find((c) => !gone.has(c.id)) ?? before.slice(0, Math.max(0, at)).reverse().find((c) => !gone.has(c.id))
          if (next) await self.selectChat(next.id)
          else await self.newChat()
        }
        toast({ text: ids.length === 1 ? 'Chat deleted' : `${ids.length} chats deleted`, kind: 'ok' })
      },
      ensureChat: () => ensureChat(),
      async send(text, images = [], opts = {}) {
        let id: string
        try {
          id = await ensureChat()
        } catch (e) {
          toast({ text: 'Could not start a chat', detail: errorText(e), kind: 'err' })
          return
        }
        const local: ChatMessage = { id: `local-${Date.now()}`, role: 'user', text, at: Date.now(), agentId: 'main', sessionId: id, ...(images.length ? { images } : {}), ...(opts.mode ? { mode: opts.mode } : {}) }
        dispatch({ type: 'chatMessage', message: local })
        dispatch({ type: 'busy', sessionId: id, busy: true })
        try {
          if (opts.mode) await h.sendChatMode(id, text, opts.mode, images.length ? images.map((i) => i.id) : undefined)
          else await h.sendChat(id, text, images.length ? images.map((i) => i.id) : undefined)
        } catch (e) {
          dispatch({ type: 'busy', sessionId: id, busy: false })
          dispatch({ type: 'chatMessage', message: { id: `err-${Date.now()}`, role: 'system', text: `Could not send: ${errorText(e)}`, at: Date.now(), agentId: 'main', sessionId: id } })
        }
      },
      async stop() {
        const id = stateRef.current.activeChatId
        if (id) await h.stopChat(id)
      },
      async chooseModel(choice) {
        const id = stateRef.current.activeChatId
        if (!id) {
          dispatch({ type: 'set', patch: { pendingModel: choice } })
          return
        }
        dispatch({ type: 'set', patch: { chats: stateRef.current.chats.map((c) => (c.id === id ? { ...c, ...choice } : c)) } })
        try {
          await h.setChatModel(id, choice.provider, choice.model)
        } catch (e) {
          toast({ text: 'Could not switch model', detail: errorText(e), kind: 'err' })
        }
      },
      openSettings(focus) {
        self.openPage('settings')
        dispatch({ type: 'set', patch: { settingsFocus: focus ?? null } })
      },
      async refreshProviders() {
        const [providers, defaultModel] = await Promise.all([h.listProviders(), h.getDefaultModel()])
        dispatch({ type: 'set', patch: { providers, defaultModel, hasApiKey: providers.some((p) => p.id === 'anthropic' && p.ready) } })
      },
      async addGuest(choice) {
        try {
          const id = await ensureChat()
          updateChat(await h.addGuest(id, choice))
        } catch (e) {
          toast({ text: 'Could not add the model', detail: errorText(e), kind: 'err' })
        }
      },
      async removeGuest(alias) {
        const id = stateRef.current.activeChatId
        if (id) updateChat(await h.removeGuest(id, alias))
      },
      async setGuestTools(on) {
        const id = stateRef.current.activeChatId
        if (id) updateChat(await h.setGuestTools(id, on))
      },
      async startRoundtable(topic, rounds) {
        const id = stateRef.current.activeChatId
        if (!id) return
        dispatch({ type: 'busy', sessionId: id, busy: true })
        try {
          await h.startRoundtable(id, topic, rounds)
        } catch (e) {
          dispatch({ type: 'busy', sessionId: id, busy: false })
          toast({ text: 'Could not start the roundtable', detail: errorText(e), kind: 'err' })
        }
      },
      async planToChecklist(messageId) {
        const id = stateRef.current.activeChatId
        if (!id) return
        try {
          await h.planToChecklist(id, messageId)
        } catch (e) {
          toast({ text: 'Could not make a task list', detail: errorText(e), kind: 'err' })
        }
      },
      async startOrchestration(text) {
        try {
          const id = await ensureChat()
          const board = await h.startOrchestration(id, text, stateRef.current.pendingModel ?? undefined)
          dispatch({ type: 'board', board })
        } catch (e) {
          toast({ text: 'Could not start the team run', detail: errorText(e), kind: 'err' })
        }
      },
      async loadAgentTranscript(agentId) {
        try {
          dispatch({ type: 'agentMessages', agentId, messages: await h.getChat(agentId) })
        } catch {
          // Not available yet; live events still arrive.
        }
      },

      async refreshSync() {
        const [git, studioConflicts, syncSettings] = await Promise.all([h.getGitStatus(), h.getStudioConflicts(), h.getSyncSettings()])
        dispatch({ type: 'set', patch: { git, studioConflicts, syncSettings } })
      },
      async setActivePlace(file) {
        try {
          const place = await h.setActivePlace(file)
          dispatch({ type: 'set', patch: { activePlace: place.file } })
          toast({ text: `Switched to ${place.name}`, detail: `${place.file} · rojo :${place.servePort}`, kind: 'ok', ms: 3000 })
        } catch (e) {
          toast({ text: 'Could not switch place', detail: errorText(e), kind: 'err' })
        }
      },
      async setAppSettings(patch) {
        // Show the change at once: the switches are controlled by appSettings, so waiting for the
        // main process would flip a clicked switch back until the reply arrives.
        const before = stateRef.current.appSettings
        if (before) dispatch({ type: 'set', patch: { appSettings: { ...before, ...patch } } })
        try {
          dispatch({ type: 'set', patch: { appSettings: await h.setAppSettings(patch) } })
        } catch (e) {
          if (before) dispatch({ type: 'set', patch: { appSettings: before } })
          toast({ text: 'Could not save the setting', detail: errorText(e), kind: 'err' })
        }
      },
      async restartService(id) {
        try {
          await h.restartService(id)
        } catch (e) {
          toast({ text: `Could not restart ${id}`, detail: errorText(e), kind: 'err' })
        }
      },

      async runTests(request) {
        dispatch({ type: 'tests', patch: { running: true, live: [] } })
        try {
          const summary = await h.testsRun(request)
          dispatch({ type: 'tests', patch: { last: summary, running: false } })
          return summary
        } catch (e) {
          dispatch({ type: 'tests', patch: { running: false } })
          toast({ text: 'Tests could not run', detail: errorText(e), kind: 'err' })
          return null
        }
      },
      async refreshTests() {
        const [status, specs, last] = await Promise.all([h.testsStatus().catch(() => null), h.testsDiscover().catch(() => []), h.testsLast().catch(() => null)])
        dispatch({ type: 'tests', patch: { status, specs, ...(last ? { last } : {}) } })
      },
      async createSpec(modulePath) {
        try {
          const result = await h.testsCreateSpec(modulePath)
          toast({ text: result.created ? `Spec created: ${basename(result.path)}` : `Spec already exists: ${basename(result.path)}`, detail: result.path, kind: 'ok' })
          await self.openFile(result.path)
          void self.refreshTests()
        } catch (e) {
          toast({ text: 'Could not create the spec', detail: errorText(e), kind: 'err' })
        }
      },
      async runLint() {
        try {
          const { selene, stylua } = await h.runLint()
          const lint: ProblemItem[] = [...selene.problems, ...stylua.problems].map((p) => ({ path: p.path, line: p.line, col: p.col, message: p.message, severity: p.severity, source: p.source, code: p.code }))
          dispatch({ type: 'set', patch: { lint, lintAt: Date.now() } })
          const notes = [selene.note, stylua.note].filter(Boolean).join(' · ')
          toast({ text: lint.length ? `Lint: ${lint.length} problem${lint.length === 1 ? '' : 's'}` : 'Lint: no problems', detail: notes || undefined, kind: lint.length ? 'info' : 'ok' })
        } catch (e) {
          toast({ text: 'Lint failed', detail: errorText(e), kind: 'err' })
        }
      }
    }
    return self
  }, [h])

  // Events and the first load.
  useEffect(() => {
    const set = (patch: Partial<State>) => dispatch({ type: 'set', patch })
    const reloadTree = async () => {
      const [tree, scripts, places, active] = await Promise.all([h.getTree(), h.getScripts(), h.listPlaces().catch(() => []), h.getActivePlace().catch(() => null)])
      set({ tree, scripts, places, activePlace: active?.file ?? null })
    }
    // Another writer changed open files on disk (Forge Sync pulling a Studio edit, the agent, git):
    // clean tabs show the new text; tabs with unsaved edits keep them and say so once per disk version.
    const warnedDisk = new Map<string, string>()
    const refreshOpen = async (changed: string[]) => {
      for (const path of openPathsIn(stateRef.current.files, changed)) {
        let disk: string
        try {
          disk = await h.readFile(path)
        } catch {
          continue
        }
        const buf = stateRef.current.files.find((f) => f.path === path)
        const what = diskReloadAction(buf, disk)
        if (what === 'reload') dispatch({ type: 'fileReloaded', path, contents: disk, saved: buf!.saved })
        else if (what === 'keep-edits' && warnedDisk.get(path) !== disk) {
          warnedDisk.set(path, disk)
          actions.toast({ text: `${basename(path)} changed on disk`, detail: 'Your unsaved edits are kept; saving overwrites the disk version.', kind: 'info' })
        }
      }
    }
    // Forge Sync dropped the session of a place that was never linked (one-time, per project).
    const syncDiscarded = (status: { discarded?: { id: string; text: string } } | null | undefined) => {
      const d = status?.discarded
      if (!d) return
      let seen = false
      try {
        seen = localStorage.getItem(`forge.sync.discarded:${d.id}`) === '1'
        localStorage.setItem(`forge.sync.discarded:${d.id}`, '1')
      } catch {
        // storage unavailable: show it anyway
      }
      if (!seen) actions.toast({ text: 'Forge Sync: unlinked place discarded', detail: d.text, kind: 'info', ms: 20_000 })
    }
    void h.syncStatus?.().then(syncDiscarded, () => undefined)
    const offs = [
      h.on('sync:status', (status) => syncDiscarded(status)),
      h.on('files:changed', (files) => void refreshOpen(files)),
      h.on('sync:entry', (entries) => void refreshOpen(entries.flatMap((e) => (e.from ? [e.file, e.from] : [e.file])))),
      h.on('services:status', (services) => set({ services })),
      h.on('log:line', (line) => dispatch({ type: 'log', line })),
      // A Labs model call failed: say why (once a minute per lab and error) instead of a silent fallback.
      h.on('labs:modelError', ({ lab, message }) => {
        const key = `${lab ?? ''}|${message}`
        const last = labErrorSeen.get(key) ?? 0
        if (Date.now() - last < 60_000) return
        labErrorSeen.set(key, Date.now())
        const name = lab ? LAB_NAMES[lab] : 'Labs'
        actions.toast({ text: `${name}: the model call failed, using the built-in fallback`, detail: message, kind: 'err', ms: 12_000 })
      }),
      h.on('project:changed', (project) => {
        const before = stateRef.current.project?.root ?? null
        if (before && before !== (project?.root ?? null)) {
          const unsaved = stateRef.current.files.filter((f) => f.current !== f.saved).map((f) => f.path)
          dispatch({ type: 'projectSwitched' })
          if (unsaved.length) actions.toast({ text: `Closed ${unsaved.length} unsaved file${unsaved.length === 1 ? '' : 's'} from the previous project`, detail: unsaved.join(', '), kind: 'err' })
        }
        set({ project })
        if (project) void reloadTree()
        else set({ tree: [], scripts: [], places: [], activePlace: null })
      }),
      h.on('tree:changed', (tree) => set({ tree })),
      h.on('scripts:changed', (scripts) => set({ scripts })),
      h.on('places:changed', ({ places, active }) => set({ places, activePlace: active })),
      h.on('git:status', (git) => set({ git })),
      h.on('studio:conflicts', (studioConflicts) => set({ studioConflicts })),
      h.on('chat:message', (message) => dispatch({ type: 'chatMessage', message })),
      h.on('chat:busy', ({ sessionId, busy }) => {
        dispatch({ type: 'busy', sessionId, busy })
        if (!busy) void h.listChats().then((chats) => set({ chats }))
      }),
      h.on('agents:changed', (agents) => set({ agents })),
      h.on('chat:updated', (chat) => set({ chats: stateRef.current.chats.map((c) => (c.id === chat.id ? chat : c)) })),
      h.on('blink:changed', (blink) => set({ blink })),
      h.on('providers:changed', (providers) => set({ providers, hasApiKey: providers.some((p) => p.id === 'anthropic' && p.ready) })),
      h.on('usage:changed', (snap) => {
        const u = stateRef.current.usage
        if (snap.scope === 'chat') {
          if (snap.id === stateRef.current.activeChatId) set({ usage: { ...u, chat: snap } })
        } else if (snap.scope === 'day') set({ usage: { ...u, day: snap } })
        else set({ usage: { ...u, agents: { ...u.agents, [snap.id]: snap } } })
      }),
      h.on('orchestrator:event', (ev) => {
        if (ev.type === 'board' || ev.type === 'finished') dispatch({ type: 'board', board: ev.board })
        else if (ev.type === 'task') {
          const b = stateRef.current.boards.find((x) => x.runId === ev.runId)
          if (b) dispatch({ type: 'board', board: { ...b, tasks: b.tasks.some((t) => t.id === ev.task.id) ? b.tasks.map((t) => (t.id === ev.task.id ? ev.task : t)) : [...b.tasks, ev.task] } })
        } else if (ev.type === 'change_request') {
          const b = stateRef.current.boards.find((x) => x.runId === ev.runId)
          if (b) dispatch({ type: 'board', board: { ...b, changeRequests: [...b.changeRequests, ev.request] } })
        } else if (ev.type === 'budget') {
          actions.toast({ text: ev.level === 'stop' ? 'Team run stopped by budget' : 'Team run near its budget', detail: ev.reason, kind: ev.level === 'stop' ? 'err' : 'info' })
        }
      }),
      h.on('tests:progress', (p) => {
        if (p.kind === 'start') dispatch({ type: 'tests', patch: { running: true, live: [], files: p.files } })
        else if (p.kind === 'test') dispatch({ type: 'testResult', result: p.result })
        else if (p.kind === 'end') dispatch({ type: 'tests', patch: { running: false, last: p.summary } })
      }),
      h.on('collab:claims', (claims) => set({ claims })),
      h.on('features:renamed', (r) => actions.toast({ text: `Feature renamed: ${r.from} → ${r.to}`, detail: `${r.moved.length} moves · ${r.updated.length} files updated`, kind: 'hot' })),
      h.on('release:webhookGone', () => actions.toast({ text: 'Discord webhook was deleted', detail: 'Add a new one in Release settings', kind: 'err' })),
      h.on('fbxInbox:upload', (e) =>
        actions.toast(e.status === 'done' ? { text: `Model uploaded: ${e.name ?? e.id} → ${e.assetId}`, detail: `rbxassetid://${e.assetId}`, kind: 'ok' } : { text: `Model upload failed: ${e.name ?? e.id}`, detail: e.error, kind: 'err' })
      )
    ]

    void (async () => {
      const [project, services, logs, git, studioConflicts, syncSettings, chats, agents, hasApiKey, appSettings] = await Promise.all([
        h.getProject(),
        h.getServices(),
        h.getLogs(),
        h.getGitStatus().catch(() => null),
        h.getStudioConflicts().catch(() => []),
        h.getSyncSettings().catch(() => null),
        h.listChats(),
        h.getAgents(),
        h.hasApiKey(),
        h.getAppSettings().catch(() => null)
      ])
      set({ project, services, git, studioConflicts, syncSettings, chats, agents, hasApiKey, appSettings })
      // Turns still running in main (the window reloaded mid-turn) show as working, with Stop.
      for (const c of chats) if (c.busy) dispatch({ type: 'busy', sessionId: c.id, busy: true })
      dispatch({ type: 'logs', lines: logs })
      void Promise.all([h.listProviders(), h.getDefaultModel()])
        .then(([providers, defaultModel]) => set({ providers, defaultModel }))
        .catch(() => set({ providers: [] }))
      void h.getBlink().then((blink) => set({ blink })).catch(() => undefined)
      void h.getUsage('day').then((day) => set({ usage: { ...stateRef.current.usage, day } })).catch(() => undefined)
      void h.getOrchestrations().then((boards) => set({ boards })).catch(() => undefined)
      void h.listClaims().then((claims) => set({ claims })).catch(() => undefined)
      void actions.refreshTests()
      if (project) await reloadTree()
    })()

    return () => offs.forEach((off) => off())
  }, [h, actions])

  const value = useMemo(() => ({ state, actions }), [state, actions])
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}
