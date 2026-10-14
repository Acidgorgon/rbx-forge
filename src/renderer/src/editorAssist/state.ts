// Editor assist status in the renderer (settings, StyLua found, completion provider), shared by the
// editor, the status bar toggle and Settings. Loaded on first use; main pushes changes
// ('editorAssist:status'); provider key changes re-read it.
import { useEffect, useSyncExternalStore } from 'react'
import type { EditorAssistSettings, EditorAssistStatus } from '@shared/types'
import type { ToastInput } from '../store'

let status: EditorAssistStatus | null = null
const listeners = new Set<() => void>()
let started = false

function set(next: EditorAssistStatus): void {
  status = next
  for (const l of listeners) l()
}

export function refreshEditorAssist(): Promise<void> {
  const h = window.harness
  if (typeof h?.editorAssistStatus !== 'function') return Promise.resolve()
  return h.editorAssistStatus().then(set, () => undefined)
}

function start(): void {
  if (started) return
  started = true
  const h = window.harness
  if (!h) return
  h.on('editorAssist:status', set)
  // A key saved / removed changes which completion provider is ready.
  h.on('providers:changed', () => void refreshEditorAssist())
  // A project switch can change which StyLua (rokit shim) is found.
  h.on('project:changed', () => void refreshEditorAssist())
  // StyLua installed (or a key exported) in a terminal while Forge was in the background.
  window.addEventListener('focus', () => void refreshEditorAssist())
  void refreshEditorAssist()
}

export function editorAssistStatus(): EditorAssistStatus | null {
  start()
  return status
}

export function useEditorAssist(): EditorAssistStatus | null {
  useEffect(start, [])
  return useSyncExternalStore(
    (l) => {
      listeners.add(l)
      return () => listeners.delete(l)
    },
    () => status
  )
}

export async function setEditorAssist(patch: Partial<EditorAssistSettings>): Promise<void> {
  set(await window.harness.editorAssistSetSettings(patch))
}

// Toasts from the editor-assist modules (set by the editor once mounted).
let toastFn: ((t: ToastInput) => void) | null = null
export function setAssistToast(fn: ((t: ToastInput) => void) | null): void {
  toastFn = fn
}
export function assistToast(t: ToastInput): void {
  toastFn?.(t)
}
