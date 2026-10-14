// IPC handlers (EditorAssistApi): StyLua formatting, editor settings (autosave, format on save, AI
// completions) and inline completions. No electron imports.

import type { EditorAssistSettings, EditorAssistStatus, InlineCompletionRequest } from '../../../shared/editorAssist/types.ts'
import { effectiveEditorAssist, normalizeEditorAssist } from '../../../shared/editorAssist/policy.ts'
import { findStylua, formatWithStylua, type FormatDeps } from './format.ts'
import { InlineCompletions, type CompletionDeps } from './completions.ts'

export const EDITOR_ASSIST_SETTING = 'editorAssist'

export interface EditorAssistDeps {
  root(): string | null
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  emit(status: EditorAssistStatus): void
  completions: CompletionDeps
  format?: FormatDeps
}

export function createEditorAssistWiring(deps: EditorAssistDeps): { handlers: Record<string, (...args: any[]) => unknown>; completions: InlineCompletions; status(): Promise<EditorAssistStatus>; refresh(): Promise<void> } {
  const completions = new InlineCompletions(deps.completions)
  const settings = (): EditorAssistSettings => normalizeEditorAssist(deps.getSetting(EDITOR_ASSIST_SETTING, null))

  const status = async (): Promise<EditorAssistStatus> => {
    const s = settings()
    const path = findStylua(deps.format)
    const c = await completions.status()
    return { settings: s, stylua: path ? { found: true, path } : { found: false }, completions: c, effective: effectiveEditorAssist(s, !!path, c.ready) }
  }
  const refresh = async () => deps.emit(await status())

  const handlers: Record<string, (...args: any[]) => unknown> = {
    editorAssistStatus: () => status(),
    editorAssistSetSettings: async (patch: unknown) => {
      const p = patch && typeof patch === 'object' ? (patch as Record<string, unknown>) : {}
      const next = normalizeEditorAssist({ ...settings(), ...p })
      deps.setSetting(EDITOR_ASSIST_SETTING, next)
      const s = await status()
      deps.emit(s)
      return s
    },
    formatLuau: async (path: unknown, text: unknown) => {
      const root = deps.root()
      if (!root) return { ok: false, error: 'No project is open.' }
      if (typeof path !== 'string' || typeof text !== 'string') return { ok: false, error: 'Bad format request.' }
      return formatWithStylua(root, path, text, deps.format)
    },
    inlineComplete: (req: unknown) => completions.complete((req && typeof req === 'object' ? req : {}) as InlineCompletionRequest),
    inlineCompleteCancel: (id: unknown) => completions.cancel(String(id ?? ''))
  }
  return { handlers, completions, status, refresh }
}
