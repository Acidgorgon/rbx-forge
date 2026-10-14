// Monaco host for file tabs. Each editor group (split editor) keeps one editor instance mounted while
// it has a file open (hidden behind page tabs). Models are shared by path, so the same file in two
// groups is one buffer (edits show in both) with its own scroll / cursor per group. App-wide pieces
// (markers -> Problems, model disposal, save hooks) live in useEditorServices, mounted once.
import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useStore, type ProblemItem } from '../store'
import { languageForPath, monaco } from '../monaco'
import { useAppearance } from '../theme'
import { startLuauLsp } from '../lsp'
import { setCursor } from '../lib/cursor'
import { markCursorUsed, rememberCursor, takeCursor } from '../qol/sessionStore'
import { formatBeforeSave, registerStyluaFormatter } from '../editorAssist/format'
import { registerInlineCompletions } from '../editorAssist/inline'
import { setBeforeSave } from '../editorAssist/saveHooks'
import { setAssistToast } from '../editorAssist/state'
import { useAutoSave } from '../editorAssist/autosave'
import { focusGroup } from '@shared/editorGroups'

const pathOf = (model: monaco.editor.ITextModel) => model.uri.path.replace(/^\/+/, '')

function severityOf(s: monaco.MarkerSeverity): ProblemItem['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error'
  if (s === monaco.MarkerSeverity.Warning) return 'warning'
  return 'info'
}

// Last view state (scroll, cursor, folds) per path from any group: a file opened in a second group
// starts where the first one was.
const lastViewState = new Map<string, monaco.editor.ICodeEditorViewState>()

// App-wide editor wiring, mounted once (EditorArea) however many editors there are.
export function useEditorServices(): void {
  const { state, actions } = useStore()
  const appearance = useAppearance()
  const actionsRef = useRef(actions)
  actionsRef.current = actions

  // StyLua (Format Document, format on save) and AI ghost text; toasts go to the app.
  useEffect(() => {
    setAssistToast((t) => actionsRef.current.toast(t))
    setBeforeSave((p, contents, reason) => formatBeforeSave(monaco, p, contents, reason))
    return () => {
      setBeforeSave(null)
      setAssistToast(null)
    }
  }, [])

  // Theme follows the app.
  useEffect(() => {
    monaco.editor.setTheme(appearance.resolved === 'dark' ? 'forge-dark' : 'forge-light')
  }, [appearance.resolved])

  // Dispose models of files that were closed (editors keep models between tab switches). With no
  // file open at all this drops every model, so a file with the same path in the next project does
  // not reopen the old project's text (Monaco reuses a model by path).
  const openPaths = state.files.map((f) => f.path).join('\n')
  useEffect(() => {
    const open = new Set(openPaths ? openPaths.split('\n') : [])
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme === 'file' && !open.has(pathOf(m)) && !m.isAttachedToEditor()) {
        lastViewState.delete(pathOf(m))
        m.dispose()
      }
    }
  }, [openPaths])
  useEffect(
    () => () => {
      for (const m of monaco.editor.getModels()) if (m.uri.scheme === 'file' && !m.isAttachedToEditor()) m.dispose()
    },
    []
  )

  // Nothing shows a file: no cursor in the status bar.
  useEffect(() => {
    if (!state.activeFile) setCursor(null)
  }, [state.activeFile])

  // Markers (luau-lsp, Blink) feed the Problems panel and status bar.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null
    const collect = () => {
      timer = null
      const items: ProblemItem[] = monaco.editor
        .getModelMarkers({})
        .filter((m) => m.severity >= monaco.MarkerSeverity.Info)
        .map((m) => ({
          path: m.resource.path.replace(/^\/+/, ''),
          line: m.startLineNumber,
          col: m.startColumn,
          message: m.message,
          severity: severityOf(m.severity),
          source: m.source || m.owner,
          code: typeof m.code === 'string' ? m.code : m.code?.value
        }))
      actionsRef.current.set({ editorProblems: items })
    }
    const sub = monaco.editor.onDidChangeMarkers(() => {
      if (!timer) timer = setTimeout(collect, 150)
    })
    return () => {
      sub.dispose()
      if (timer) clearTimeout(timer)
    }
  }, [])

  // Blink compile errors as markers on events.blink and its imports.
  useEffect(() => {
    const diagnostics = state.blink?.diagnostics ?? []
    const apply = (model: monaco.editor.ITextModel) => {
      const p = pathOf(model)
      const lines = model.getLineCount()
      const markers = diagnostics
        .filter((d) => d.file === p)
        .map((d) => {
          const endLine = Math.min(d.endLine ?? d.line, lines)
          const endColumn = d.endColumn ?? model.getLineMaxColumn(Math.max(1, endLine))
          return {
            severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
            message: d.detail ? `${d.message}\n${d.detail}` : d.message,
            source: 'blink',
            code: d.code,
            startLineNumber: d.line,
            startColumn: d.column,
            endLineNumber: endLine,
            endColumn: Math.max(endColumn, d.column + 1),
            relatedInformation: d.related?.map((r) => ({ resource: monaco.Uri.file(r.file), message: r.message, startLineNumber: r.line, startColumn: r.column, endLineNumber: r.line, endColumn: r.column + 1 }))
          }
        })
      monaco.editor.setModelMarkers(model, 'blink', markers)
    }
    monaco.editor.getModels().forEach(apply)
    const sub = monaco.editor.onDidCreateModel(apply)
    return () => sub.dispose()
  }, [state.blink])
}

export function CodeEditor({ path, readOnlyReason, visible, active, groupId }: { path: string; readOnlyReason: string | null; visible: boolean; active: boolean; groupId: string }) {
  const { state, actions } = useStore()
  const appearance = useAppearance()
  const file = state.files.find((f) => f.path === path)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const activeRef = useRef(active)
  activeRef.current = active
  const pendingReveal = useRef<{ path: string; position: { lineNumber: number; column: number } } | null>(null)
  const stateReveal = useRef(state.reveal)
  stateReveal.current = state.reveal
  // This editor's own view state per path (the same file in another group scrolls on its own).
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>())
  // The path the view state events belong to (Monaco fires scroll events mid model swap).
  const shownPath = useRef<string | null>(null)
  const smooth = appearance.motion === 'full' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const revealPending = () => {
    const pending = pendingReveal.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pending || !editor || !model || pathOf(model) !== pending.path) return
    pendingReveal.current = null
    editor.setPosition(pending.position)
    editor.revealPositionInCenter(pending.position)
    editor.focus()
  }

  // The status bar shows the cursor of the active group's editor.
  const publishCursor = () => {
    if (!activeRef.current) return
    const editor = editorRef.current
    const model = editor?.getModel()
    const pos = editor?.getPosition()
    if (!editor || !model || !pos) return setCursor(null)
    rememberCursor(pathOf(model), { line: pos.lineNumber, column: pos.column })
    const opts = model.getOptions()
    const sel = editor.getSelection()
    setCursor({ line: pos.lineNumber, column: pos.column, tabSize: opts.tabSize, insertSpaces: opts.insertSpaces, selected: sel && !sel.isEmpty() ? model.getValueLengthInRange(sel) : 0 })
  }

  const saveView = () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || pathOf(model) !== shownPath.current) return
    const v = editor.saveViewState()
    if (!v) return
    viewStates.current.set(shownPath.current, v)
    lastViewState.set(shownPath.current, v)
  }

  // Autosave (Settings > Editor; default: on focus change).
  useAutoSave(editorInstance, path)

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    setEditorInstance(editor)
    registerStyluaFormatter(monaco)
    registerInlineCompletions(monaco)
    editor.onDidChangeCursorSelection(() => {
      saveView()
      publishCursor()
    })
    editor.onDidScrollChange(saveView)
    // Typing or clicking into an editor makes its group the active one.
    editor.onDidFocusEditorText(() => actionsRef.current.editorGroups((gs) => focusGroup(gs, groupId)))
    // Showing a file: this editor's last view of it, else another group's, else (first showing this
    // session) its saved cursor. A pending reveal wins over all of them.
    const showModel = () => {
      const model = editor.getModel()
      if (!model) return
      const p = pathOf(model)
      shownPath.current = p
      if (pendingReveal.current?.path === p || stateReveal.current?.path === p) return markCursorUsed(p)
      const view = viewStates.current.get(p) ?? lastViewState.get(p)
      if (view) {
        markCursorUsed(p)
        editor.restoreViewState(view)
        return
      }
      const pos = takeCursor(p)
      if (pos && pos.line <= model.getLineCount()) {
        editor.setPosition({ lineNumber: pos.line, column: pos.column })
        editor.revealPositionInCenter({ lineNumber: pos.line, column: pos.column })
      }
    }
    editor.onDidChangeModel(() => {
      showModel()
      setTimeout(publishCursor)
    })
    showModel()
    publishCursor()
    // Once for the app (a no-op when already started). Go to definition in another file opens it in
    // the active group and reveals the position there.
    startLuauLsp(monaco, {
      openPath: (p, position) => {
        if (position) void actionsRef.current.openFileAt(p, position.lineNumber, position.column)
        else void actionsRef.current.openFile(p)
      },
      onStatus: (s, detail) => actionsRef.current.set({ lsp: { state: s, detail } })
    })
    revealPending()
  }

  useEffect(() => {
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [path, file?.loading])

  useEffect(() => {
    if (visible) setTimeout(() => editorRef.current?.layout())
  }, [visible])

  useEffect(() => {
    if (!active) return
    if (visible) publishCursor()
    else setCursor(null)
  }, [active, visible])

  // openFileAt / palette ":" — the active group reveals once the file shows.
  useEffect(() => {
    const reveal = state.reveal
    if (!active || !reveal || reveal.path !== path || file?.loading) return
    pendingReveal.current = { path: reveal.path, position: { lineNumber: reveal.line, column: reveal.column } }
    actions.set({ reveal: null })
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [state.reveal, path, file?.loading, active])

  if (!file || file.loading) return <div className="editor-loading"><span className="spinner" /></div>

  return (
    <Editor
      path={file.path}
      keepCurrentModel
      saveViewState={false}
      language={languageForPath(file.path)}
      theme={appearance.resolved === 'dark' ? 'forge-dark' : 'forge-light'}
      value={file.current}
      onChange={(v) => actions.editFile(file.path, v ?? '')}
      onMount={onMount}
      loading={<div className="editor-loading"><span className="spinner" /></div>}
      options={{
        fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
        fontSize: 13,
        lineHeight: 20,
        fontLigatures: false,
        minimap: { enabled: true, renderCharacters: false, maxColumn: 80, showSlider: 'mouseover' },
        scrollBeyondLastLine: false,
        smoothScrolling: smooth,
        cursorSmoothCaretAnimation: smooth ? 'on' : 'off',
        cursorBlinking: smooth ? 'smooth' : 'blink',
        renderLineHighlight: 'all',
        stickyScroll: { enabled: true },
        bracketPairColorization: { enabled: false },
        padding: { top: 10, bottom: 10 },
        tabSize: 4,
        insertSpaces: false,
        automaticLayout: true,
        guides: { indentation: true },
        scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10, useShadows: false },
        overviewRulerBorder: false,
        hideCursorInOverviewRuler: true,
        fixedOverflowWidgets: true,
        // Quick fixes (luau-lsp code actions): the light bulb shows on lines that have one; Ctrl+. / ⌘.
        lightbulb: { enabled: monaco.editor.ShowLightbulbIconMode.OnCode },
        // AI ghost text (editorAssist/inline.ts): Tab accepts, Esc dismisses.
        inlineSuggest: { enabled: true, showToolbar: 'onHover', suppressSuggestions: false },
        readOnly: !!readOnlyReason,
        readOnlyMessage: readOnlyReason ? { value: readOnlyReason } : undefined
      }}
    />
  )
}
