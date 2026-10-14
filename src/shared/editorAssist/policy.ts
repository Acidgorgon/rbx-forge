// Pure rules for editor assist: settings normalisation, when autosave saves, when save formats,
// and the minimal edit that turns one text into another (applied as one undo step).

import { DEFAULT_EDITOR_ASSIST, type AutoSaveMode, type EditorAssistSettings } from './types.ts'

const AUTO_SAVE_MODES: AutoSaveMode[] = ['off', 'afterDelay', 'onFocusChange']

export function normalizeEditorAssist(raw: unknown): EditorAssistSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const triState = (v: unknown, d: boolean | null) => (typeof v === 'boolean' || v === null ? v : d)
  const delay = Number(r.autoSaveDelayMs)
  return {
    formatOnSave: triState(r.formatOnSave, DEFAULT_EDITOR_ASSIST.formatOnSave),
    formatOnAutoSave: typeof r.formatOnAutoSave === 'boolean' ? r.formatOnAutoSave : DEFAULT_EDITOR_ASSIST.formatOnAutoSave,
    autoSave: AUTO_SAVE_MODES.includes(r.autoSave as AutoSaveMode) ? (r.autoSave as AutoSaveMode) : DEFAULT_EDITOR_ASSIST.autoSave,
    autoSaveDelayMs: Number.isFinite(delay) ? Math.min(60_000, Math.max(200, Math.round(delay))) : DEFAULT_EDITOR_ASSIST.autoSaveDelayMs,
    aiCompletions: triState(r.aiCompletions, DEFAULT_EDITOR_ASSIST.aiCompletions)
  }
}

export function effectiveEditorAssist(s: EditorAssistSettings, styluaFound: boolean, providerReady: boolean): { formatOnSave: boolean; aiCompletions: boolean } {
  return {
    formatOnSave: s.formatOnSave ?? styluaFound,
    aiCompletions: s.aiCompletions ?? providerReady
  }
}

export function isLuauPath(path: string): boolean {
  return /\.(luau|lua)$/i.test(path)
}

// What made autosave consider a file: the edit delay ran out, the user switched tabs, the editor
// lost focus (palette, explorer, chat...), or the window lost focus (alt-tab to Studio).
export type AutoSaveTrigger = 'delay' | 'tabSwitch' | 'editorBlur' | 'windowBlur'

export interface AutoSaveCandidate {
  path: string
  dirty: boolean
  loading?: boolean
  // A held Studio / Forge Sync conflict for this file: never autosaved (the user picks a side in
  // the conflict tab; a manual Ctrl+S still saves).
  conflicted?: boolean
  readOnly?: boolean
}

export function shouldAutoSave(mode: AutoSaveMode, trigger: AutoSaveTrigger, file: AutoSaveCandidate): boolean {
  if (!file.dirty || file.loading || file.conflicted || file.readOnly) return false
  if (mode === 'afterDelay') return trigger === 'delay'
  if (mode === 'onFocusChange') return trigger !== 'delay'
  return false
}

export type SaveReason = 'manual' | 'auto'

// Format on save: only Luau/Lua, only with format-on-save on, and on autosave only when asked.
export function shouldFormatOnSave(o: { reason: SaveReason; path: string; formatOnSave: boolean; formatOnAutoSave: boolean }): boolean {
  if (!isLuauPath(o.path) || !o.formatOnSave) return false
  return o.reason === 'manual' || o.formatOnAutoSave
}

// The smallest single replacement (by common prefix / suffix) turning `from` into `to`, as string
// offsets into `from`. null when they are equal. Applied as one edit, so it is one undo step and the
// cursor and scroll position outside the changed span stay put.
export function minimalEdit(from: string, to: string): { start: number; end: number; text: string } | null {
  if (from === to) return null
  let start = 0
  const max = Math.min(from.length, to.length)
  while (start < max && from.charCodeAt(start) === to.charCodeAt(start)) start++
  let endFrom = from.length
  let endTo = to.length
  while (endFrom > start && endTo > start && from.charCodeAt(endFrom - 1) === to.charCodeAt(endTo - 1)) {
    endFrom--
    endTo--
  }
  // Never split a CRLF pair or a surrogate pair at either end.
  while (start > 0 && (isLowSurrogate(from.charCodeAt(start)) || (from[start - 1] === '\r' && from[start] === '\n'))) start--
  while (endFrom < from.length && endTo < to.length && (isLowSurrogate(from.charCodeAt(endFrom)) || (from[endFrom - 1] === '\r' && from[endFrom] === '\n'))) {
    endFrom++
    endTo++
  }
  return { start, end: endFrom, text: to.slice(start, endTo) }
}

function isLowSurrogate(c: number): boolean {
  return c >= 0xdc00 && c <= 0xdfff
}
