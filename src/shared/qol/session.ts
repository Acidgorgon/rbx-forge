// "Pick up where you left off": the versioned session state file (userData/session-state.json).
// Open tabs + active tab and editor cursors per project, panel layout, per-chat scroll + drafts, per-lab
// selections. Parsing is tolerant: unknown or broken entries are dropped, never fatal. Pure.
import { sanitizeGroups, type GroupsState } from '../editorGroups.ts'

export const SESSION_VERSION = 2
export const SESSION_FILE = 'session-state.json'

const MAX_TABS = 40
const MAX_CURSORS = 200
const MAX_PROJECTS = 30
const MAX_CHATS = 100
const MAX_DRAFT = 20_000
const MAX_LAB_KEYS = 100

export interface SessionTab {
  id: string
  kind: string
  title: string
  path?: string
  agentId?: string
}

export interface CursorPos {
  line: number
  column: number
}

export interface ProjectSession {
  tabs: SessionTab[]
  activeTab: string
  // Split editor layout (groups of tab ids + the split tree); absent = one group with every tab.
  groups?: GroupsState
  // Repo-relative path -> last cursor.
  cursors: Record<string, CursorPos>
  // Lab page state, e.g. "vfx.selected" -> entry id, "vfx.view" -> "effects".
  labs: Record<string, string | number | boolean | null>
  savedAt: number
}

export interface ChatViewState {
  // Pixels from the top; atBottom wins (keeps following the newest message).
  scroll?: number
  atBottom?: boolean
  draft?: string
}

export interface SessionState {
  version: typeof SESSION_VERSION
  savedAt: number
  // Workbench panels (store Layout); merged over defaults on restore.
  layout?: Record<string, string | number | boolean>
  activeChatId?: string | null
  projects: Record<string, ProjectSession>
  chats: Record<string, ChatViewState>
}

// v1 (before per-project state): one flat tab list for whatever project was open.
export interface SessionStateV1 {
  version: 1
  project?: string
  tabs?: unknown
  activeTab?: unknown
  layout?: unknown
  cursors?: unknown
}

export function emptySession(): SessionState {
  return { version: SESSION_VERSION, savedAt: 0, projects: {}, chats: {} }
}

export function emptyProjectSession(): ProjectSession {
  return { tabs: [], activeTab: 'forge', cursors: {}, labs: {}, savedAt: 0 }
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const num = (v: unknown): number | undefined => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)

function cleanTab(v: unknown): SessionTab | null {
  if (!isObj(v) || !isStr(v.id) || !v.id || !isStr(v.kind) || !v.kind) return null
  const tab: SessionTab = { id: v.id, kind: v.kind, title: isStr(v.title) ? v.title : v.id }
  if (isStr(v.path) && v.path) tab.path = v.path
  if (isStr(v.agentId) && v.agentId) tab.agentId = v.agentId
  if ((tab.kind === 'file' || tab.kind === 'conflict') && !tab.path) return null
  return tab
}

function cleanCursors(v: unknown): Record<string, CursorPos> {
  const out: Record<string, CursorPos> = {}
  if (!isObj(v)) return out
  for (const [path, c] of Object.entries(v).slice(-MAX_CURSORS)) {
    if (!isObj(c)) continue
    const line = num(c.line)
    const column = num(c.column)
    if (line && line >= 1 && column && column >= 1) out[path] = { line: Math.floor(line), column: Math.floor(column) }
  }
  return out
}

function cleanLabs(v: unknown): ProjectSession['labs'] {
  const out: ProjectSession['labs'] = {}
  if (!isObj(v)) return out
  for (const [k, value] of Object.entries(v).slice(-MAX_LAB_KEYS)) {
    if (value === null || isStr(value) || typeof value === 'boolean' || num(value) !== undefined) out[k] = value as string | number | boolean | null
  }
  return out
}

export function cleanProjectSession(v: unknown): ProjectSession | null {
  if (!isObj(v)) return null
  const seen = new Set<string>()
  const tabs: SessionTab[] = []
  for (const raw of Array.isArray(v.tabs) ? v.tabs : []) {
    const tab = cleanTab(raw)
    if (!tab || seen.has(tab.id)) continue
    seen.add(tab.id)
    tabs.push(tab)
    if (tabs.length >= MAX_TABS) break
  }
  const out: ProjectSession = {
    tabs,
    activeTab: isStr(v.activeTab) && v.activeTab ? v.activeTab : tabs[0]?.id ?? 'forge',
    cursors: cleanCursors(v.cursors),
    labs: cleanLabs(v.labs),
    savedAt: num(v.savedAt) ?? 0
  }
  const groups = v.groups === undefined ? null : sanitizeGroups(v.groups, (id) => seen.has(id))
  if (groups) out.groups = groups
  return out
}

function cleanLayout(v: unknown): SessionState['layout'] {
  if (!isObj(v)) return undefined
  const out: Record<string, string | number | boolean> = {}
  for (const [k, value] of Object.entries(v)) if (isStr(value) || typeof value === 'boolean' || num(value) !== undefined) out[k] = value as string | number | boolean
  return Object.keys(out).length ? out : undefined
}

function cleanChat(v: unknown): ChatViewState | null {
  if (!isObj(v)) return null
  const out: ChatViewState = {}
  const scroll = num(v.scroll)
  if (scroll !== undefined && scroll >= 0) out.scroll = Math.round(scroll)
  if (typeof v.atBottom === 'boolean') out.atBottom = v.atBottom
  if (isStr(v.draft) && v.draft) out.draft = v.draft.slice(0, MAX_DRAFT)
  return Object.keys(out).length ? out : null
}

// v1 -> v2: the flat tab list belongs to the project that was open (or nowhere when unknown).
function fromV1(v: SessionStateV1): SessionState {
  const state = emptySession()
  const layout = cleanLayout(v.layout)
  if (layout) state.layout = layout
  if (isStr(v.project) && v.project) {
    const ps = cleanProjectSession({ tabs: v.tabs, activeTab: v.activeTab, cursors: v.cursors })
    if (ps) state.projects[v.project] = ps
  }
  return state
}

// Any parsed JSON -> a valid current-version state. Newer versions are read field by field (what we
// understand survives), so a downgrade after an update does not lose everything.
export function migrateSession(raw: unknown): SessionState {
  if (!isObj(raw)) return emptySession()
  const version = num(raw.version) ?? 0
  if (version === 1) return fromV1(raw as unknown as SessionStateV1)
  if (version < 1) return emptySession()
  const state = emptySession()
  state.savedAt = num(raw.savedAt) ?? 0
  const layout = cleanLayout(raw.layout)
  if (layout) state.layout = layout
  if (isStr(raw.activeChatId) || raw.activeChatId === null) state.activeChatId = raw.activeChatId as string | null
  if (isObj(raw.projects)) {
    const entries = Object.entries(raw.projects)
      .map(([root, ps]) => [root, cleanProjectSession(ps)] as const)
      .filter((e): e is readonly [string, ProjectSession] => !!e[1] && !!e[0])
      .sort((a, b) => b[1].savedAt - a[1].savedAt)
      .slice(0, MAX_PROJECTS)
    for (const [root, ps] of entries) state.projects[root] = ps
  }
  if (isObj(raw.chats)) {
    for (const [id, c] of Object.entries(raw.chats).slice(-MAX_CHATS)) {
      const chat = cleanChat(c)
      if (chat && id) state.chats[id] = chat
    }
  }
  return state
}

export function parseSession(text: string | null | undefined): SessionState {
  if (!text) return emptySession()
  try {
    return migrateSession(JSON.parse(text))
  } catch {
    return emptySession()
  }
}

export function serializeSession(state: SessionState): string {
  return JSON.stringify(migrateSession({ ...state, version: SESSION_VERSION }), null, 1)
}

export interface RestoreChecks {
  // Does this repo-relative file still exist?
  fileExists: (path: string) => boolean
  // Page kinds this build can open.
  knownPages: ReadonlySet<string>
  // Open Studio conflicts (a conflict tab only comes back while its conflict is still open).
  conflicts?: ReadonlySet<string>
}

// What to reopen for a project: tabs whose file / page / conflict is gone are skipped, cursors of
// deleted files dropped, the active tab falls back to the first surviving tab.
export function restorePlan(ps: ProjectSession, checks: RestoreChecks): { tabs: SessionTab[]; activeTab: string; cursors: Record<string, CursorPos> } {
  const tabs = ps.tabs.filter((t) => {
    if (t.kind === 'file') return !!t.path && checks.fileExists(t.path)
    if (t.kind === 'conflict') return !!t.path && !!checks.conflicts?.has(t.path)
    if (t.kind === 'transcript') return false
    return checks.knownPages.has(t.kind)
  })
  const cursors: Record<string, CursorPos> = {}
  for (const [path, c] of Object.entries(ps.cursors)) if (checks.fileExists(path)) cursors[path] = c
  const activeTab = tabs.some((t) => t.id === ps.activeTab) ? ps.activeTab : (tabs[0]?.id ?? 'forge')
  return { tabs, activeTab, cursors }
}
