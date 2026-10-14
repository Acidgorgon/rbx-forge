// Renderer side of "pick up where you left off": the session state (userData/session-state.json via
// qolLoadSession / qolSaveSession) held in memory, saved debounced. Chat drafts + scroll, editor
// cursors and lab selections write here; QolRoot restores tabs and layout from it on start.
import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react'
import { emptyProjectSession, emptySession, type CursorPos, type ProjectSession, type SessionState } from '@shared/qol/session'

let state: SessionState = emptySession()
let loaded = false
let loading: Promise<SessionState> | null = null
let root: string | null = null
let version = 0
let timer: ReturnType<typeof setTimeout> | null = null
// Cursors restored once per path per app session (later file opens keep Monaco's own state).
const cursorsUsed = new Set<string>()
const listeners = new Set<() => void>()

function changed(save = true): void {
  version++
  for (const l of listeners) l()
  if (save && loaded) schedule()
}

function schedule(): void {
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 800)
}

export function flush(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (!loaded) return
  void window.harness.qolSaveSession(state).catch(() => undefined)
}

export function loadSession(): Promise<SessionState> {
  if (!loading) {
    loading = window.harness
      .qolLoadSession()
      .catch(() => emptySession())
      .then((s) => {
        // Keep anything written before the load finished (drafts typed in the first second).
        state = { ...s, chats: { ...s.chats, ...state.chats } }
        loaded = true
        changed(false)
        return state
      })
  }
  return loading
}

export function session(): SessionState {
  return state
}

export function setRoot(next: string | null): void {
  root = next
  changed(false)
}

// Lab selections also work with no project open: they go under "*".
const key = () => root ?? '*'

function project(): ProjectSession | null {
  return state.projects[key()] ?? null
}

export function updateProject(patch: Partial<ProjectSession>): void {
  const k = key()
  const cur = state.projects[k] ?? emptyProjectSession()
  state = { ...state, projects: { ...state.projects, [k]: { ...cur, ...patch, savedAt: Date.now() } } }
  changed()
}

export function setLayoutState(layout: SessionState['layout']): void {
  state = { ...state, layout }
  changed()
}

export function setActiveChat(id: string | null): void {
  if (state.activeChatId === id) return
  state = { ...state, activeChatId: id }
  changed()
}

// ---- chats
const chatKey = (id: string | null) => id ?? 'new'

export function chatView(id: string | null) {
  return state.chats[chatKey(id)]
}

export function rememberChat(id: string | null, patch: { draft?: string; scroll?: number; atBottom?: boolean }): void {
  const key = chatKey(id)
  const cur = state.chats[key] ?? {}
  const next = { ...cur, ...patch }
  if (next.draft === '') delete next.draft
  if (cur.draft === next.draft && cur.scroll === next.scroll && cur.atBottom === next.atBottom) return
  state = { ...state, chats: { ...state.chats, [key]: next } }
  changed()
}

// Composer draft per chat: restores the draft when the chat changes (or the session loads), saves on edit.
export function useChatDraft(id: string | null, text: string, setText: (t: string) => void): void {
  const shown = useRef<string | null | undefined>(undefined)
  const v = useSessionVersion()
  useEffect(() => {
    if (shown.current === id && loaded) return
    if (!loaded) return
    const first = shown.current === undefined
    shown.current = id
    const draft = chatView(id)?.draft ?? ''
    if (draft || !first) setText(draft)
  }, [id, v])
  useEffect(() => {
    if (shown.current === undefined || shown.current !== id) return
    rememberChat(id, { draft: text })
  }, [text])
}

// ---- editor cursors
export function rememberCursor(path: string, pos: CursorPos): void {
  // Not before the saved cursor was restored (Monaco reports 1:1 while it swaps models).
  if (!cursorsUsed.has(path)) return
  const ps = project()
  const cursors = { ...(ps?.cursors ?? {}) }
  const cur = cursors[path]
  if (cur && cur.line === pos.line && cur.column === pos.column) return
  delete cursors[path]
  cursors[path] = pos
  updateProject({ cursors })
}

// The saved cursor for a file the first time it shows in this app session.
export function takeCursor(path: string): CursorPos | null {
  if (cursorsUsed.has(path)) return null
  cursorsUsed.add(path)
  return project()?.cursors[path] ?? null
}

export function markCursorUsed(path: string): void {
  cursorsUsed.add(path)
}

// ---- lab selections ("vfx.selected", "anim.view" ...)
type LabValue = string | number | boolean | null

export function labValue(key: string): LabValue | undefined {
  return project()?.labs[key]
}

export function setLabValue(key: string, value: LabValue): void {
  if (project()?.labs[key] === value) return
  updateProject({ labs: { ...(project()?.labs ?? {}), [key]: value } })
}

function subscribe(l: () => void): () => void {
  listeners.add(l)
  return () => listeners.delete(l)
}

export function useSessionVersion(): number {
  return useSyncExternalStore(subscribe, () => version)
}

// useState that survives restarts (per project). Falls back to `initial` when nothing is saved.
export function usePersisted<T extends LabValue>(key: string, initial: T): [T, (next: T) => void] {
  useSessionVersion()
  const saved = labValue(key)
  const value = (saved === undefined ? initial : saved) as T
  const set = useCallback((next: T) => setLabValue(key, next), [key])
  return [value, set]
}

if (typeof window !== 'undefined') window.addEventListener('beforeunload', flush)
