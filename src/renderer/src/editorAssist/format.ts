// StyLua in the editor: the Luau document formatter (Format Document, Shift+Alt+F / Shift+Option+F,
// right-click > Format Document) and format on save. StyLua runs in main on the buffer's text
// (stdin); the result is applied to the model as ONE edit (one undo step), and only when the buffer
// did not change while StyLua ran. Errors never touch the buffer.
import type * as Monaco from 'monaco-editor'
import { isLuauPath, minimalEdit, shouldFormatOnSave, type SaveReason } from '@shared/editorAssist/policy'
import { openDoctor } from '../pages/qolc/events'
import { assistToast, editorAssistStatus, refreshEditorAssist } from './state'

type Model = Monaco.editor.ITextModel

const pathOf = (model: Model) => model.uri.path.replace(/^\/+/, '')

let hinted = false
let lastError = ''

// Formats `text` as `path`; null when StyLua is missing (one hint per session) or failed (toast).
export async function styluaFormat(path: string, text: string): Promise<string | null> {
  const r = await window.harness.formatLuau(path, text).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : String(e) }))
  if (r.ok) {
    lastError = ''
    return r.text
  }
  if ('missing' in r && r.missing) {
    void refreshEditorAssist()
    if (!hinted) {
      hinted = true
      assistToast({ text: 'StyLua is not installed, so Luau files are not formatted', detail: 'Install it with the toolchain (rokit), then format again. Forge Doctor shows how.', kind: 'info', action: { label: 'Open Doctor', run: openDoctor }, ms: 10_000 })
    }
    return null
  }
  // The same parse error on every save is shown once until it changes.
  if (r.error !== lastError) {
    lastError = r.error
    assistToast({ text: `Not formatted: ${path.split('/').pop()}`, detail: r.error, kind: 'err' })
  }
  return null
}

// The edit turning the model's text into `formatted`, as Monaco edits ([] = already formatted).
export function formatEdits(model: Model, formatted: string): Monaco.languages.TextEdit[] {
  const current = model.getValue()
  // StyLua writes \n; the model keeps its own end of line.
  const target = model.getEOL() === '\r\n' ? formatted.replace(/\r?\n/g, '\r\n') : formatted.replace(/\r\n/g, '\n')
  const edit = minimalEdit(current, target)
  if (!edit) return []
  const start = model.getPositionAt(edit.start)
  const end = model.getPositionAt(edit.end)
  return [{ range: { startLineNumber: start.lineNumber, startColumn: start.column, endLineNumber: end.lineNumber, endColumn: end.column }, text: edit.text }]
}

let registered: Monaco.IDisposable | null = null

// The Luau formatter (luau-lsp's own formatter only converts quotes, so it is not registered).
export function registerStyluaFormatter(monaco: typeof Monaco): void {
  if (registered) return
  registered = monaco.languages.registerDocumentFormattingEditProvider('luau', {
    displayName: 'StyLua',
    provideDocumentFormattingEdits: async (model, _options, token) => {
      const before = model.getVersionId()
      const formatted = await styluaFormat(pathOf(model), model.getValue())
      // Monaco drops edits for a changed model itself; this also covers a cancelled request.
      if (formatted === null || token.isCancellationRequested || model.isDisposed() || model.getVersionId() !== before) return []
      return formatEdits(model, formatted)
    }
  })
}

// Format on save (store.saveFile calls this through saveHooks). Returns the text to save, or null to
// save `contents` unchanged.
export async function formatBeforeSave(monaco: typeof Monaco, path: string, contents: string, reason: SaveReason): Promise<string | null> {
  if (!isLuauPath(path)) return null
  const s = editorAssistStatus()
  if (!s || !shouldFormatOnSave({ reason, path, formatOnSave: s.effective.formatOnSave, formatOnAutoSave: s.settings.formatOnAutoSave })) return null
  const model = monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && pathOf(m) === path)
  if (!model || model.isDisposed() || model.getValue() !== contents) return null
  const version = model.getVersionId()
  const formatted = await styluaFormat(path, contents)
  if (formatted === null || model.isDisposed()) return null
  // Typed while StyLua ran: save what is there, unformatted (the next save formats it).
  if (model.getVersionId() !== version) return null
  const edits = formatEdits(model, formatted)
  if (edits.length) {
    model.pushStackElement()
    model.pushEditOperations([], edits.map((e) => ({ range: e.range as Monaco.IRange, text: e.text, forceMoveMarkers: true })), () => null)
    model.pushStackElement()
  }
  return model.getValue()
}

// Palette "Format Document": runs Monaco's action on the editor showing `path`.
export function formatDocumentIn(monaco: typeof Monaco, path: string): void {
  const editor = monaco.editor.getEditors().find((e) => {
    const m = e.getModel()
    return !!m && pathOf(m) === path
  })
  if (!editor) return
  editor.focus()
  void editor.getAction('editor.action.formatDocument')?.run()
}
