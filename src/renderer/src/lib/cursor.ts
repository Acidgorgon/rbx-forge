// Editor cursor position for the status bar, kept outside the app store so moving the caret
// does not re-render the whole workbench.
import { useSyncExternalStore } from 'react'

export interface CursorInfo {
  line: number
  column: number
  tabSize: number
  insertSpaces: boolean
  selected: number
}

let current: CursorInfo | null = null
const listeners = new Set<() => void>()

export function setCursor(next: CursorInfo | null): void {
  current = next
  listeners.forEach((l) => l())
}

export function useCursor(): CursorInfo | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => current
  )
}
