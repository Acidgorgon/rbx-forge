// AI inline completions (ghost text, Tab accepts, Esc dismisses) for Luau files. Debounced and
// cancelled by Monaco on every keystroke; main picks the model (services/editorAssist/completions.ts),
// charges the usage meter and refuses while a spending cap is reached. Only a short window around
// the cursor is sent, never for secret-looking files.
import type * as Monaco from 'monaco-editor'
import { cursorAllowsSuggestion, isSecretPath, requireLines, trimPrefix, trimSuffix } from '@shared/editorAssist/completion'
import { editorAssistStatus } from './state'

export const INLINE_DEBOUNCE_MS = 300

const pathOf = (model: Monaco.editor.ITextModel) => model.uri.path.replace(/^\/+/, '')

// Last reason completions returned nothing worth telling (cap reached, provider error), for the
// status bar tooltip.
let lastNote = ''
const noteListeners = new Set<() => void>()
export function completionNote(): string {
  return lastNote
}
export function onCompletionNote(fn: () => void): () => void {
  noteListeners.add(fn)
  return () => noteListeners.delete(fn)
}
function setNote(note: string): void {
  if (note === lastNote) return
  lastNote = note
  for (const l of noteListeners) l()
}

function sleep(ms: number, token: Monaco.CancellationToken): Promise<boolean> {
  return new Promise((resolve) => {
    if (token.isCancellationRequested) return resolve(false)
    const t = setTimeout(() => {
      sub.dispose()
      resolve(!token.isCancellationRequested)
    }, ms)
    const sub = token.onCancellationRequested(() => {
      clearTimeout(t)
      sub.dispose()
      resolve(false)
    })
  })
}

let seq = 0
let registered: Monaco.IDisposable | null = null

export function registerInlineCompletions(monaco: typeof Monaco): void {
  if (registered) return
  const none = { items: [] as Monaco.languages.InlineCompletion[] }
  registered = monaco.languages.registerInlineCompletionsProvider('luau', {
    displayName: 'AI completions',
    provideInlineCompletions: async (model, position, context, token) => {
      const status = editorAssistStatus()
      if (!status?.effective.aiCompletions || !status.completions.ready) return none
      // The suggest widget is open: its items win.
      if (context.selectedSuggestionInfo) return none
      const path = pathOf(model)
      if (model.uri.scheme !== 'file' || isSecretPath(path)) return none
      const line = model.getLineContent(position.lineNumber)
      if (!cursorAllowsSuggestion(line.slice(position.column - 1))) return none
      const explicit = context.triggerKind === monaco.languages.InlineCompletionTriggerKind.Explicit
      if (!explicit && !(await sleep(INLINE_DEBOUNCE_MS, token))) return none
      if (model.isDisposed()) return none
      const version = model.getVersionId()
      const text = model.getValue()
      const offset = model.getOffsetAt(position)
      const prefix = trimPrefix(text.slice(Math.max(0, offset - 8000), offset))
      // Nothing typed yet on an empty file: no guess.
      if (!prefix.trim()) return none
      const suffix = trimSuffix(text.slice(offset, offset + 4000))
      const id = `ic${++seq}`
      const cancel = token.onCancellationRequested(() => void window.harness.inlineCompleteCancel(id).catch(() => undefined))
      try {
        const r = await window.harness.inlineComplete({ id, path, languageId: model.getLanguageId(), prefix, suffix, requires: requireLines(text) })
        setNote(r.note ?? '')
        if (token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== version || !r.text) return none
        return { items: [{ insertText: r.text, range: new monaco.Range(position.lineNumber, position.column, position.lineNumber, position.column) }] }
      } catch {
        return none
      } finally {
        cancel.dispose()
      }
    },
    disposeInlineCompletions: () => undefined
  })
}
