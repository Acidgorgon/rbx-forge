// Renderer side of the integrated terminal: one xterm.js instance per main-process pty, kept alive
// outside React so terminals keep their screen while the bottom panel shows another tab or closes.
// State (list, active, pending assistant runs) is a tiny external store for useSyncExternalStore.

import { Terminal, type ITheme, type ILink } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import '@xterm/xterm/css/xterm.css'
import type { ShellInfo, TerminalInfo, TerminalRunRequest, TerminalTask } from '@shared/types'

export interface TermState {
  list: TerminalInfo[]
  active: string | null
  shells: ShellInfo[]
  tasks: TerminalTask[]
  pending: TerminalRunRequest[]
  // Bumped when main or a command asks to show/focus the terminal panel.
  focusNonce: number
  error: string | null
}

let state: TermState = { list: [], active: null, shells: [], tasks: [], pending: [], focusNonce: 0, error: null }
const listeners = new Set<() => void>()

function set(patch: Partial<TermState>): void {
  state = { ...state, ...patch }
  listeners.forEach((l) => l())
}

export const termStore = {
  get: () => state,
  subscribe: (l: () => void) => {
    listeners.add(l)
    return () => listeners.delete(l)
  }
}

// ---------------------------------------------------------------- xterm instances

export interface XtermEntry {
  term: Terminal
  fit: FitAddon
  search: SearchAddon
  // xterm renders into this element; the view moves it into its container.
  host: HTMLDivElement
}

const xterms = new Map<string, XtermEntry>()
const mac = /Mac|iPhone|iPad/.test(navigator.platform)
const windows = /Win/.test(navigator.platform)

// Opens repo paths (src/...luau:12) printed in the terminal in the editor; set by the view.
let openPath: ((path: string, line?: number) => void) | null = null
export function setPathOpener(fn: ((path: string, line?: number) => void) | null): void {
  openPath = fn
}

// Ctrl/Cmd+F inside a terminal: the view opens its find bar.
let onFind: (() => void) | null = null
export function setFindHandler(fn: (() => void) | null): void {
  onFind = fn
}

const PATH = /(?:\.\/)?((?:src|tests|tools)\/[\w./-]+\.(?:luau?|blink|json|toml|ps1|sh)|[\w-]+\.(?:blink|toml|json))(?::(\d+))?(?::(\d+))?/g

// ---------------------------------------------------------------- theme

function token(style: CSSStyleDeclaration, name: string, fallback: string): string {
  return style.getPropertyValue(name).trim() || fallback
}

function hex(value: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(value)
  if (!m) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

// t of the way from a to b (hex colours; a is returned when either is not #rrggbb).
function mix(a: string, b: string, t: number): string {
  const x = hex(a)
  const y = hex(b)
  if (!x || !y) return a
  return '#' + x.map((v, i) => Math.round(v + (y[i] - v) * t).toString(16).padStart(2, '0')).join('')
}

// ANSI palette from the theme tokens: the soft status hues (ok / warn / err / info / lavender /
// teal) instead of saturated xterm defaults, on the panel background.
export function xtermTheme(): ITheme {
  const s = getComputedStyle(document.documentElement)
  const light = document.documentElement.dataset.theme === 'light'
  const bg = token(s, '--bg-panel', light ? '#f4f4f2' : '#1a1a1a')
  const fg = token(s, '--fg', light ? '#2b2b2b' : '#c8c8c8')
  const red = token(s, '--err', '#f2a7b5')
  const green = token(s, '--ok', '#b5d99c')
  const yellow = token(s, '--warn', '#e5c07b')
  const blue = token(s, '--info', '#6fa8dc')
  const magenta = token(s, '--lav', '#c9b6f2')
  const cyan = token(s, '--gc-4', '#8fc9c0')
  const faint = token(s, '--fg-faint', '#5c5c5c')
  const muted = token(s, '--fg-muted', '#8a8a8a')
  // Brights: towards white on dark, towards black on light.
  const toward = light ? '#000000' : '#ffffff'
  const bright = (c: string) => mix(c, toward, light ? 0.18 : 0.28)
  return {
    background: bg,
    foreground: fg,
    cursor: token(s, '--ember', '#e07a5f'),
    cursorAccent: bg,
    selectionBackground: light ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.14)',
    selectionInactiveBackground: light ? 'rgba(0, 0, 0, 0.07)' : 'rgba(255, 255, 255, 0.08)',
    scrollbarSliderBackground: light ? 'rgba(0, 0, 0, 0.12)' : 'rgba(255, 255, 255, 0.08)',
    scrollbarSliderHoverBackground: light ? 'rgba(0, 0, 0, 0.2)' : 'rgba(255, 255, 255, 0.14)',
    scrollbarSliderActiveBackground: light ? 'rgba(0, 0, 0, 0.28)' : 'rgba(255, 255, 255, 0.2)',
    black: light ? fg : token(s, '--line-strong', '#333333'),
    red,
    green,
    yellow,
    blue,
    magenta,
    cyan,
    white: light ? muted : fg,
    brightBlack: faint,
    brightRed: bright(red),
    brightGreen: bright(green),
    brightYellow: bright(yellow),
    brightBlue: bright(blue),
    brightMagenta: bright(magenta),
    brightCyan: bright(cyan),
    brightWhite: light ? token(s, '--fg-2', '#4a4a4a') : mix(fg, '#ffffff', 0.5)
  }
}

export function applyTheme(): void {
  const theme = xtermTheme()
  const light = document.documentElement.dataset.theme === 'light'
  for (const { term } of xterms.values()) {
    term.options.theme = theme
    term.options.minimumContrastRatio = light ? 3 : 1
  }
}

// ---------------------------------------------------------------- clipboard keys

function copySelection(term: Terminal): void {
  const text = term.getSelection()
  if (text) void navigator.clipboard?.writeText(text).catch(() => document.execCommand('copy'))
}

async function pasteInto(term: Terminal): Promise<void> {
  try {
    const text = await navigator.clipboard.readText()
    if (text) term.paste(text)
  } catch {
    // Clipboard read refused: the native paste event (Edit menu / right-click) still works.
  }
}

// Copy/paste/find keys: ⌘C/⌘V on macOS; Ctrl+Shift+C/V everywhere else, plus Ctrl+C with a
// selection and Ctrl+V (like Windows Terminal). Returning false keeps xterm from turning them into
// control characters; the native copy/paste then fires once (Edit menu role or the textarea's
// default action) and xterm's own copy/paste listeners handle it.
function keyHandler(term: Terminal) {
  return (e: KeyboardEvent): boolean => {
    if (e.type !== 'keydown') return true
    const key = e.key.toLowerCase()
    const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
    if (mod && !e.altKey && key === 'f') {
      e.preventDefault()
      onFind?.()
      return false
    }
    // ⌘ shortcuts are never terminal input on macOS (copy, paste, app commands).
    if (mac) return !e.metaKey
    if (e.ctrlKey && !e.altKey && key === 'c' && (e.shiftKey || term.hasSelection())) return false
    if (e.ctrlKey && !e.altKey && key === 'v') return false
    if (e.shiftKey && key === 'insert') return false
    return true
  }
}

export function xtermFor(id: string): XtermEntry {
  let entry = xterms.get(id)
  if (entry) return entry
  const light = document.documentElement.dataset.theme === 'light'
  const term = new Terminal({
    fontFamily: "'JetBrains Mono', 'SF Mono', Menlo, Consolas, monospace",
    fontSize: 12,
    lineHeight: 1.25,
    letterSpacing: 0,
    cursorBlink: !document.documentElement.dataset.motion && !matchMedia('(prefers-reduced-motion: reduce)').matches,
    cursorStyle: 'bar',
    cursorInactiveStyle: 'outline',
    scrollback: 5000,
    allowProposedApi: false,
    macOptionIsMeta: false,
    smoothScrollDuration: 0,
    minimumContrastRatio: light ? 3 : 1,
    theme: xtermTheme(),
    ...(windows ? { windowsPty: { backend: 'conpty' as const } } : {})
  })
  const fit = new FitAddon()
  const search = new SearchAddon()
  term.loadAddon(fit)
  term.loadAddon(search)
  // http(s) links open in the browser (main's window-open handler); Ctrl/⌘-click like VS Code is
  // not required: a plain click opens.
  term.loadAddon(new WebLinksAddon((_e, uri) => void window.open(uri, '_blank')))
  term.registerLinkProvider({
    provideLinks(y, callback) {
      const line = term.buffer.active.getLine(y - 1)?.translateToString(true) ?? ''
      const links: ILink[] = []
      for (const m of line.matchAll(PATH)) {
        const start = (m.index ?? 0) + 1
        links.push({
          range: { start: { x: start, y }, end: { x: start + m[0].length - 1, y } },
          text: m[0],
          decorations: { underline: true, pointerCursor: true },
          activate: () => openPath?.(m[1], m[2] ? Number(m[2]) : undefined)
        })
      }
      callback(links.length ? links : undefined)
    }
  })
  term.attachCustomKeyEventHandler(keyHandler(term))
  term.onData((data) => void window.harness.terminalWrite(id, data))
  term.onResize(({ cols, rows }) => void window.harness.terminalResize(id, cols, rows))
  const host = document.createElement('div')
  host.className = 'term-host'
  // Right-click: copy the selection, else paste (Windows Terminal style).
  host.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (term.hasSelection()) {
      copySelection(term)
      term.clearSelection()
    } else void pasteInto(term)
  })
  entry = { term, fit, search, host }
  xterms.set(id, entry)
  return entry
}

function disposeXterm(id: string): void {
  const entry = xterms.get(id)
  if (!entry) return
  xterms.delete(id)
  entry.term.dispose()
  entry.host.remove()
}

// ---------------------------------------------------------------- events + actions

let started = false
// Output that arrived before the xterm existed (created lazily by the view).
const early = new Map<string, string>()

function write(id: string, data: string): void {
  const entry = xterms.get(id)
  if (entry) entry.term.write(data)
  else early.set(id, (early.get(id) ?? '') + data)
}

function reconcile(list: TerminalInfo[]): void {
  const ids = new Set(list.map((t) => t.id))
  for (const id of [...xterms.keys()]) if (!ids.has(id)) disposeXterm(id)
  for (const id of [...early.keys()]) if (!ids.has(id)) early.delete(id)
  const active = state.active && ids.has(state.active) ? state.active : (list[list.length - 1]?.id ?? null)
  set({ list, active })
}

// Called once by the view (and by commands) before using the store.
export function startTerminals(): void {
  if (started || !window.harness?.terminalList) return
  started = true
  const h = window.harness
  h.on('terminal:data', ({ id, data }) => write(id, data))
  h.on('terminal:list', (list) => reconcile(list))
  h.on('terminal:confirm', (pending) => set({ pending, ...(pending.length ? { focusNonce: state.focusNonce + 1 } : {}) }))
  h.on('terminal:focus', ({ id }) => set({ active: id, focusNonce: state.focusNonce + 1 }))
  // ./dev and ./check map to tools/*.ps1 on Windows when the project has them.
  h.on('project:changed', () => refreshTasks())
  void (async () => {
    const [list, shells, pending] = await Promise.all([h.terminalList(), h.terminalShells(), h.terminalPendingRuns()])
    // After a renderer reload: redraw what the ptys printed so far.
    for (const t of list) early.set(t.id, await h.terminalBuffer(t.id))
    set({ shells, pending })
    reconcile(list)
    refreshTasks()
  })().catch((e) => set({ error: String(e?.message ?? e) }))
}

// Takes the output buffered before the xterm was created (the view calls it right after xtermFor).
export function drainEarly(id: string): string {
  const data = early.get(id) ?? ''
  early.delete(id)
  return data
}

export function refreshTasks(): void {
  void window.harness.terminalTasks().then((tasks) => set({ tasks })).catch(() => undefined)
}

export function setActive(id: string): void {
  set({ active: id })
}

export function requestFocus(): void {
  set({ focusNonce: state.focusNonce + 1 })
}

export async function newTerminal(shellId?: string): Promise<TerminalInfo | null> {
  startTerminals()
  try {
    const info = await window.harness.terminalCreate(shellId ? { shellId } : {})
    set({ error: null })
    // terminal:list may arrive before or after; make the new one active either way.
    if (!state.list.some((t) => t.id === info.id)) set({ list: [...state.list, info] })
    set({ active: info.id, focusNonce: state.focusNonce + 1 })
    return info
  } catch (e) {
    set({ error: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
    return null
  }
}

export async function runTask(taskId: string): Promise<void> {
  startTerminals()
  try {
    const info = await window.harness.terminalRunTask(taskId)
    if (!state.list.some((t) => t.id === info.id)) set({ list: [...state.list, info] })
    set({ active: info.id, focusNonce: state.focusNonce + 1, error: null })
  } catch (e) {
    set({ error: String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '') })
  }
}

export function killTerminal(id: string): void {
  void window.harness.terminalKill(id)
  reconcile(state.list.filter((t) => t.id !== id))
}

export async function renameTerminal(id: string, title: string): Promise<void> {
  reconcile(await window.harness.terminalRename(id, title))
}

export async function setDefaultShell(shellId: string): Promise<void> {
  set({ shells: await window.harness.terminalSetDefaultShell(shellId) })
  refreshTasks()
}

export function confirmRun(requestId: string, allow: boolean): void {
  set({ pending: state.pending.filter((p) => p.id !== requestId) })
  void window.harness.terminalConfirmRun(requestId, allow)
}

// Key events inside a terminal that the terminal keeps (the app's global shortcuts skip them), so
// Ctrl+R, Ctrl+P, Ctrl+K... reach the shell. The app keeps Ctrl+`, ⌘ shortcuts on macOS, and
// Ctrl+Shift / Ctrl+J / Ctrl+P / Ctrl+Tab / Ctrl+1..9 elsewhere (VS Code's default skip list).
export function terminalOwnsKey(e: KeyboardEvent, spec: string): boolean {
  const target = e.target as HTMLElement | null
  if (!target?.closest?.('.xterm')) return false
  if (e.code === 'Backquote' && e.ctrlKey) return false
  if (mac) return !e.metaKey
  if (!e.ctrlKey) return true
  if (/^mod\+shift\+/.test(spec) && !/^mod\+shift\+[cv]$/.test(spec)) return false
  return !['mod+j', 'mod+p', 'mod+tab', 'mod+shift+tab', 'ctrl+tab', 'ctrl+shift+tab'].includes(spec) && !/^mod\+[1-9]$/.test(spec)
}
