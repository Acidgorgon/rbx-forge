// Theme (dark / light / system), motion (full / reduced / off) and the chat font (readable sans or
// the terminal monospace), applied as data-theme, data-motion and data-chat-font on <html> (SPEC §2, §6). "System" follows prefers-color-scheme and its changes;
// the user can always override it, so there is no bare @media colour block in the CSS.
import { useSyncExternalStore } from 'react'

export type ThemeMode = 'dark' | 'light' | 'system'
export type MotionMode = 'full' | 'reduced' | 'off'
export type Theme = 'dark' | 'light'
export type ChatFont = 'sans' | 'mono'

const KEY = 'forge.appearance'
const lightQuery = () => window.matchMedia('(prefers-color-scheme: light)')
const reduceQuery = () => window.matchMedia('(prefers-reduced-motion: reduce)')

let mode: ThemeMode = 'dark'
let motion: MotionMode = 'full'
let resolved: Theme = 'dark'
let chatFont: ChatFont = 'sans'
const listeners = new Set<() => void>()

function read(): void {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY) ?? '{}') as { theme?: ThemeMode; motion?: MotionMode; chatFont?: ChatFont }
    if (saved.theme === 'dark' || saved.theme === 'light' || saved.theme === 'system') mode = saved.theme
    if (saved.motion === 'full' || saved.motion === 'reduced' || saved.motion === 'off') motion = saved.motion
    if (saved.chatFont === 'sans' || saved.chatFont === 'mono') chatFont = saved.chatFont
  } catch {
    // Storage blocked: defaults.
  }
}

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ theme: mode, motion, chatFont }))
  } catch {
    // Not persisted; still applied for this session.
  }
}

function apply(): void {
  resolved = mode === 'system' ? (lightQuery().matches ? 'light' : 'dark') : mode
  const html = document.documentElement
  html.dataset.theme = resolved
  window.forgeFiles?.setTitlebarTheme?.(resolved)
  if (motion === 'full') delete html.dataset.motion
  else html.dataset.motion = motion
  html.dataset.chatFont = chatFont
  listeners.forEach((l) => l())
}

// Called once before the first render (main.tsx), so there is no flash of the wrong theme.
export function initAppearance(): void {
  read()
  apply()
  lightQuery().addEventListener('change', () => mode === 'system' && apply())
}

export function setThemeMode(next: ThemeMode): void {
  mode = next
  save()
  apply()
}

export function setMotionMode(next: MotionMode): void {
  motion = next
  save()
  apply()
}

export function setChatFont(next: ChatFont): void {
  chatFont = next
  save()
  apply()
}

export function getThemeMode(): ThemeMode {
  return mode
}

export function getMotionMode(): MotionMode {
  return motion
}

// Decorative motion allowed (sparks, smooth caret): neither the OS nor the app asks to reduce it.
export function motionAllowed(): boolean {
  return motion === 'full' && !reduceQuery().matches
}

const subscribe = (l: () => void) => {
  listeners.add(l)
  return () => listeners.delete(l)
}

// Resolved theme ('dark' | 'light') for Monaco and charts.
export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, () => resolved)
}

export function useAppearance(): { theme: ThemeMode; motion: MotionMode; resolved: Theme; chatFont: ChatFont } {
  const key = useSyncExternalStore(subscribe, () => `${mode}|${motion}|${resolved}|${chatFont}`)
  const [t, m, r, f] = key.split('|') as [ThemeMode, MotionMode, Theme, ChatFont]
  return { theme: t, motion: m, resolved: r, chatFont: f }
}
