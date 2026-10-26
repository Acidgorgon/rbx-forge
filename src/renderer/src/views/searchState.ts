// Search view state and flows, outside React so the query and its results survive switching side views
// and the palette's "Search: …" commands share them. Typing re-runs the search after 250 ms and cancels
// the one still running; results stream in from main (search:files) tagged with the run's id, and any
// older run's chunks are dropped. Replaces go through main (services/search.ts), which keeps a copy of
// each changed file and skips files with unsaved editor edits; Replace All asks first, through the
// app's dialog.
import { useSyncExternalStore } from 'react'
import type { ReplaceRequest, ReplaceResult, SearchFileResult, SearchMatch, SearchOptions, SearchSummary } from '@shared/types'
import type { Actions } from '../store'
import { errorText } from '../lib/format'
import { basename } from '../lib/roblox'

export interface SearchState {
  query: string
  replacement: string
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  preserveCase: boolean
  include: string
  exclude: string
  useIgnore: boolean
  // The "files to include / exclude" inputs are shown; the replace row is shown.
  details: boolean
  replaceOpen: boolean
  files: SearchFileResult[]
  summary: SearchSummary | null
  // The options the shown results were found with (the replacement preview and Replace use these).
  ran: SearchOptions | null
  running: boolean
  // The search or replace failed (not a bad regex: that is summary.error).
  error: string | null
  replacing: boolean
  // Collapsed files.
  collapsed: ReadonlySet<string>
  // Bumped to focus the search box (or the replace box) and select its text.
  focusNonce: number
  focusReplace: boolean
}

const OPTIONS_KEY = 'forge.search.options'
const OPTION_KEYS = ['caseSensitive', 'wholeWord', 'regex', 'preserveCase', 'include', 'exclude', 'useIgnore', 'details'] as const

function loadOptions(): Partial<SearchState> {
  try {
    const saved = JSON.parse(localStorage.getItem(OPTIONS_KEY) ?? '{}') as Record<string, unknown>
    const out: Record<string, unknown> = {}
    for (const k of OPTION_KEYS) if (typeof saved[k] === typeof initial[k]) out[k] = saved[k]
    return out as Partial<SearchState>
  } catch {
    return {}
  }
}

const initial: SearchState = {
  query: '',
  replacement: '',
  caseSensitive: false,
  wholeWord: false,
  regex: false,
  preserveCase: false,
  include: '',
  exclude: '',
  useIgnore: true,
  details: false,
  replaceOpen: false,
  files: [],
  summary: null,
  ran: null,
  running: false,
  error: null,
  replacing: false,
  collapsed: new Set(),
  focusNonce: 0,
  focusReplace: false
}

let state: SearchState = { ...initial, ...loadOptions() }
const listeners = new Set<() => void>()

function set(patch: Partial<SearchState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const searchStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}

export function useSearch(): SearchState {
  return useSyncExternalStore(searchStore.subscribe, searchStore.get)
}

function saveOptions(): void {
  try {
    localStorage.setItem(OPTIONS_KEY, JSON.stringify(Object.fromEntries(OPTION_KEYS.map((k) => [k, state[k]]))))
  } catch {
    // storage unavailable: the options last until the window closes
  }
}

const optionsOf = (s: SearchState): SearchOptions => ({ query: s.query, caseSensitive: s.caseSensitive, wholeWord: s.wholeWord, regex: s.regex, include: s.include, exclude: s.exclude, useIgnore: s.useIgnore })

// ---------------------------------------------------------------- running a search

let seq = 0
let current: string | null = null
let timer: ReturnType<typeof setTimeout> | null = null
let started = false

// Once per window: results of the running search, and a new project empties the view.
export function startSearch(): void {
  if (started) return
  started = true
  const h = window.harness
  h.on('search:files', ({ id, files }) => {
    if (id !== current) return
    set({ files: [...state.files, ...files] })
  })
  h.on('project:changed', () => {
    cancel()
    set({ files: [], summary: null, ran: null, running: false, error: null, collapsed: new Set() })
  })
}

function cancel(): void {
  if (timer) clearTimeout(timer)
  timer = null
  if (current) void window.harness.searchCancel(current).catch(() => undefined)
  current = null
}

// Searches now (Enter, Refresh, or the debounce firing).
export async function runSearch(): Promise<void> {
  startSearch()
  cancel()
  if (!state.query) {
    set({ files: [], summary: null, ran: null, running: false, error: null })
    return
  }
  const id = `search-${++seq}`
  current = id
  const options = optionsOf(state)
  set({ files: [], summary: null, ran: options, running: true, error: null, collapsed: new Set() })
  try {
    const summary = await window.harness.searchFiles(id, options)
    if (current !== id) return
    set({ summary, running: false })
  } catch (e) {
    if (current !== id) return
    set({ running: false, error: errorText(e) })
  } finally {
    if (current === id) current = null
  }
}

// Typing: search again 250 ms after the last keystroke.
function soon(): void {
  cancel()
  if (!state.query) return void runSearch()
  set({ running: true })
  timer = setTimeout(() => {
    timer = null
    void runSearch()
  }, 250)
}

export function setQuery(query: string): void {
  set({ query })
  soon()
}

export function setReplacement(replacement: string): void {
  set({ replacement })
}

// A toggle or a glob changed: the saved options follow, and the search runs again.
export function setOption(patch: Partial<Pick<SearchState, 'caseSensitive' | 'wholeWord' | 'regex' | 'include' | 'exclude' | 'useIgnore'>>): void {
  set(patch)
  saveOptions()
  soon()
}

export function setView(patch: Partial<Pick<SearchState, 'details' | 'replaceOpen' | 'preserveCase'>>): void {
  set(patch)
  saveOptions()
}

export function clearSearch(): void {
  cancel()
  set({ query: '', files: [], summary: null, ran: null, running: false, error: null, collapsed: new Set() })
}

// The palette and Ctrl+Shift+F: show the view's box, seeded with the editor's selection.
export function focusSearch(options: { seed?: string; replace?: boolean } = {}): void {
  const seed = options.seed?.trim()
  set({ focusNonce: state.focusNonce + 1, focusReplace: !!options.replace, ...(options.replace ? { replaceOpen: true } : {}) })
  if (seed && seed !== state.query) setQuery(seed)
  else if (seed && !state.summary && !state.running) void runSearch()
}

export function toggleCollapsed(path: string): void {
  const next = new Set(state.collapsed)
  if (!next.delete(path)) next.add(path)
  set({ collapsed: next })
}

export function collapseAll(collapse: boolean): void {
  set({ collapsed: collapse ? new Set(state.files.map((f) => f.path)) : new Set() })
}

export const allCollapsed = (s: SearchState) => s.files.length > 0 && s.files.every((f) => s.collapsed.has(f.path))

// Takes a match or a whole file out of the results (it is then left out of Replace All).
export function dismiss(path: string, match?: SearchMatch): void {
  const files = state.files
    .map((f) => (f.path !== path ? f : match ? { ...f, matches: f.matches.filter((m) => m !== match) } : null))
    .filter((f): f is SearchFileResult => !!f && f.matches.length > 0)
  set({ files })
}

// ---------------------------------------------------------------- replacing

export const count = (n: number, word: string) => `${n} ${n === 1 ? word : /(ch|sh|s|x)$/.test(word) ? `${word}es` : `${word}s`}`
const SHOWN = 12

export type ReplaceScope = { kind: 'all' } | { kind: 'file'; path: string } | { kind: 'match'; path: string; match: SearchMatch }

function targetsFor(scope: ReplaceScope, dirty: ReadonlySet<string>): { targets: ReplaceRequest['targets']; skippedDirty: string[]; matches: number; files: { path: string; count: number }[] } {
  const files = scope.kind === 'all' ? state.files : state.files.filter((f) => f.path === scope.path)
  const targets: ReplaceRequest['targets'] = []
  const skippedDirty: string[] = []
  const counted: { path: string; count: number }[] = []
  let matches = 0
  for (const f of files) {
    if (dirty.has(f.path)) {
      skippedDirty.push(f.path)
      continue
    }
    const list = scope.kind === 'match' ? [scope.match] : f.matches
    targets.push({ path: f.path, only: list.map((m) => ({ line: m.line, col: m.col })) })
    counted.push({ path: f.path, count: list.length })
    matches += list.length
  }
  return { targets, skippedDirty, matches, files: counted }
}

async function doReplace(actions: Actions, request: ReplaceRequest): Promise<void> {
  set({ replacing: true })
  let result: ReplaceResult
  try {
    result = await window.harness.replaceInFiles(request)
  } catch (e) {
    set({ replacing: false })
    actions.toast({ text: 'Replace failed', detail: errorText(e), kind: 'err' })
    return
  }
  set({ replacing: false })
  if (result.error) {
    actions.toast({ text: 'Nothing was replaced', detail: result.error, kind: 'err' })
    return
  }
  const left = result.skipped.map((s) => `${basename(s.path)}: ${s.reason}`)
  const detail = [result.backup ? `Copies in ${result.backup}/` : '', ...left.slice(0, 3), left.length > 3 ? `and ${left.length - 3} more skipped` : '', result.stale ? `${count(result.stale, 'match')} had moved since the search` : ''].filter(Boolean).join('\n')
  if (!result.replaced) actions.toast({ text: 'Nothing was replaced', detail: detail || undefined, kind: 'err' })
  else actions.toast({ text: `Replaced ${count(result.replaced, 'match')} in ${count(result.files.length, 'file')}`, detail: detail || undefined, kind: left.length || result.stale ? 'info' : 'ok', ms: 6000 })
  // What is left (skipped files, matches of the new text) shows after a fresh search.
  void runSearch()
}

// Replace All asks first. A file's or a match's Replace goes straight through (the copy is kept).
export function replace(actions: Actions, scope: ReplaceScope, dirtyPaths: string[]): void {
  if (state.replacing || state.running || !state.ran || !state.query) return
  if (scope.kind === 'all' && state.summary?.limitHit) return void actions.toast({ text: 'Too many results to replace them all', detail: 'Only the first results are listed. Refine the search (or use files to include / exclude) first.', kind: 'info' })
  const { targets, skippedDirty, matches, files } = targetsFor(scope, new Set(dirtyPaths))
  if (!targets.length) {
    if (skippedDirty.length) actions.toast({ text: `${basename(skippedDirty[0])} has unsaved changes`, detail: 'Save or discard them in the editor first; Search replaces what is on disk.', kind: 'info' })
    return
  }
  const { query, caseSensitive, wholeWord, regex } = state.ran
  const request: ReplaceRequest = { options: { query, caseSensitive, wholeWord, regex }, replacement: state.replacement, preserveCase: state.preserveCase, targets, dirty: dirtyPaths }
  if (scope.kind !== 'all') return void doReplace(actions, request)
  const shown = files.slice(0, SHOWN).map((f) => `${f.path} (${f.count})`)
  actions.openDialog({
    kind: 'confirm',
    title: `Replace ${count(matches, 'match')} in ${count(files.length, 'file')}?`,
    body: `“${state.ran.query}” becomes “${state.replacement}”${state.preserveCase ? ' (keeping the letter case)' : ''}. Forge keeps a copy of each changed file in .forge/sync/trash first.${skippedDirty.length ? ` ${count(skippedDirty.length, 'file')} with unsaved changes in the editor ${skippedDirty.length === 1 ? 'is' : 'are'} left alone.` : ''}`,
    list: files.length > SHOWN ? [...shown, `… and ${files.length - SHOWN} more`] : shown,
    confirm: `Replace ${count(matches, 'match')}`,
    danger: true,
    run: () => void doReplace(actions, request)
  })
}
