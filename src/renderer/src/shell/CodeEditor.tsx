// Monaco host for file tabs. Each editor group (split editor) keeps one editor instance mounted while
// it has a file open (hidden behind page tabs). Models are shared by path, so the same file in two
// groups is one buffer (edits show in both) with its own scroll / cursor per group. App-wide pieces
// (markers -> Problems, model disposal, save hooks) live in useEditorServices, mounted once.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
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
import { sameProblems } from '../lib/sameProblems'

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
  const problemsRef = useRef(state.editorProblems)
  problemsRef.current = state.editorProblems

  // StyLua (Format Document, format on save) and AI ghost text; toasts go to the app.
  useEffect(() => {
    setAssistToast((t) => actionsRef.current.toast(t))
    // The store sees an edit one render after Monaco does, and a burst of typing can starve that render
    // (Ctrl+S right after the last key): the model is the truth, so a save writes its text.
    setBeforeSave(async (p, contents, reason) => {
      const live = monaco.editor.getModels().find((m) => m.uri.scheme === 'file' && pathOf(m) === p)?.getValue() ?? contents
      return (await formatBeforeSave(monaco, p, live, reason)) ?? (live !== contents ? live : null)
    })
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
      // Marker events fire for every re-analysis; an unchanged list must not re-render the app.
      if (!sameProblems(items, problemsRef.current)) actionsRef.current.set({ editorProblems: items })
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
  const ready = !!file && !file.loading
  // The path the Monaco model shows. A file that is still loading (or gone) keeps the previous one
  // under a spinner, so the editor is built once per group and not again on every first open.
  const modelPath = useRef<string | null>(null)
  if (ready) modelPath.current = path
  const editorPath = modelPath.current
  const shownFile = editorPath === path ? file : editorPath ? state.files.find((f) => f.path === editorPath) : undefined
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const [editorInstance, setEditorInstance] = useState<monaco.editor.IStandaloneCodeEditor | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const activeRef = useRef(active)
  activeRef.current = active
  const pendingReveal = useRef<{ path: string; position: { lineNumber: number; column: number }; end?: { lineNumber: number; column: number } } | null>(null)
  const stateReveal = useRef(state.reveal)
  stateReveal.current = state.reveal
  // This editor's own view state per path (the same file in another group scrolls on its own).
  const viewStates = useRef(new Map<string, monaco.editor.ICodeEditorViewState>())
  // The path the view state events belong to (Monaco fires scroll events mid model swap).
  const shownPath = useRef<string | null>(null)
  const smoothBlink = appearance.motion === 'full' && !window.matchMedia('(prefers-reduced-motion: reduce)').matches

  const revealPending = () => {
    const pending = pendingReveal.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pending || !editor || !model || pathOf(model) !== pending.path) return
    pendingReveal.current = null
    if (pending.end) editor.setSelection({ startLineNumber: pending.position.lineNumber, startColumn: pending.position.column, endLineNumber: pending.end.lineNumber, endColumn: pending.end.column })
    else editor.setPosition(pending.position)
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
    const opts = model.getOptions()
    const sel = editor.getSelection()
    setCursor({ line: pos.lineNumber, column: pos.column, tabSize: opts.tabSize, insertSpaces: opts.insertSpaces, selected: sel && !sel.isEmpty() ? model.getValueLengthInRange(sel) : 0 })
  }

  // The cursor is also kept for the next session (qol/sessionStore).
  const rememberNow = () => {
    if (!activeRef.current) return
    const model = editorRef.current?.getModel()
    const pos = editorRef.current?.getPosition()
    if (model && pos) rememberCursor(pathOf(model), { line: pos.lineNumber, column: pos.column })
  }

  // Selection events fire per keystroke and per drag step: the status bar trails them by 100 ms and
  // the session store by 1 s (flushed when the editor blurs or switches file).
  const statusTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const rememberTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const cursorMoved = () => {
    if (!statusTimer.current) {
      statusTimer.current = setTimeout(() => {
        statusTimer.current = null
        publishCursor()
      }, 100)
    }
    if (!rememberTimer.current) {
      rememberTimer.current = setTimeout(() => {
        rememberTimer.current = null
        rememberNow()
      }, 1000)
    }
  }
  const flushCursor = () => {
    if (rememberTimer.current) {
      clearTimeout(rememberTimer.current)
      rememberTimer.current = null
      rememberNow()
    }
  }

  // Scroll / cursor / folds are saved when the editor blurs and just before it swaps files (not per
  // scroll or selection event; saveViewState walks the view model).
  const saveView = () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!editor || !model || pathOf(model) !== shownPath.current) return
    const v = editor.saveViewState()
    if (!v) return
    viewStates.current.set(shownPath.current, v)
    lastViewState.set(shownPath.current, v)
  }
  // Layout cleanups run before the commit's passive effects, where @monaco-editor/react swaps the model.
  useLayoutEffect(
    () => () => {
      saveView()
      flushCursor()
    },
    [editorPath]
  )
  useEffect(
    () => () => {
      if (statusTimer.current) clearTimeout(statusTimer.current)
    },
    []
  )

  // Autosave (Settings > Editor; default: on focus change).
  useAutoSave(editorInstance, path)

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    setEditorInstance(editor)
    registerStyluaFormatter(monaco)
    registerInlineCompletions(monaco)
    editor.onDidChangeCursorSelection(cursorMoved)
    editor.onDidBlurEditorText(() => {
      saveView()
      flushCursor()
    })
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

  // Text sync is one way per direction, so typing does no whole-file compare: the editor is
  // uncontrolled (defaultValue seeds a new model, onChange feeds the store) and a text that did not
  // come from this editor (reload from disk, format on save) is pushed into the model below.
  const lastEdit = useRef<{ path: string; text: string; echoed: boolean } | null>(null)
  const applying = useRef(false)
  const onChange = useCallback((v: string | undefined) => {
    const model = editorRef.current?.getModel()
    if (!model || applying.current) return
    const text = v ?? ''
    const p = pathOf(model)
    lastEdit.current = { path: p, text, echoed: false }
    actionsRef.current.editFile(p, text)
  }, [])

  const storedText = shownFile?.current
  useEffect(() => {
    const editor = editorInstance
    const model = editor?.getModel()
    if (!editor || !model || storedText === undefined || !editorPath || pathOf(model) !== editorPath) return
    const last = lastEdit.current
    if (last && last.path === editorPath) {
      // The store handing back what this editor sent; or still behind a newer keystroke.
      if (last.text === storedText) {
        last.echoed = true
        return
      }
      if (!last.echoed) return
    }
    if (model.getValue() === storedText) return
    applying.current = true
    try {
      // An undoable edit, like typing; a read-only editor ignores edits, so it takes the whole text.
      if (editor.getOption(monaco.editor.EditorOption.readOnly)) editor.setValue(storedText)
      else {
        editor.executeEdits('', [{ range: model.getFullModelRange(), text: storedText, forceMoveMarkers: true }])
        editor.pushUndoStop()
      }
    } finally {
      applying.current = false
    }
    lastEdit.current = { path: editorPath, text: storedText, echoed: true }
  }, [storedText, editorInstance, editorPath])

  // Built once per setting; a fresh object per render makes @monaco-editor/react call updateOptions
  // (and Monaco re-validate every option) on each store change.
  const frozen = !ready
  const options = useMemo<monaco.editor.IStandaloneEditorConstructionOptions>(
    () => ({
      fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
      fontSize: 13,
      lineHeight: 20,
      fontLigatures: false,
      minimap: { enabled: true, renderCharacters: false, maxColumn: 80, showSlider: 'mouseover' },
      scrollBeyondLastLine: false,
      // Animated scrolling and caret movement cost frames on every scroll and keystroke.
      smoothScrolling: false,
      cursorSmoothCaretAnimation: 'off',
      cursorBlinking: smoothBlink ? 'smooth' : 'blink',
      renderLineHighlight: 'line',
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
      // No typing into the previous file while the next one loads under the spinner.
      readOnly: frozen || !!readOnlyReason,
      readOnlyMessage: readOnlyReason ? { value: readOnlyReason } : undefined
    }),
    [smoothBlink, readOnlyReason, frozen]
  )

  useEffect(() => {
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [path, file?.loading])

  useEffect(() => {
    if (visible) setTimeout(() => editorRef.current?.layout())
    else saveView()
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
    pendingReveal.current = { path: reveal.path, position: { lineNumber: reveal.line, column: reveal.column }, ...(reveal.end ? { end: { lineNumber: reveal.end.line, column: reveal.end.column } } : {}) }
    actions.set({ reveal: null })
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [state.reveal, path, file?.loading, active])

  const spinner = <div className="editor-loading"><span className="spinner" /></div>
  if (!editorPath) return spinner

  return (
    <>
      <Editor
        path={editorPath}
        keepCurrentModel
        saveViewState={false}
        language={languageForPath(editorPath)}
        theme={appearance.resolved === 'dark' ? 'forge-dark' : 'forge-light'}
        defaultValue={shownFile?.current}
        onChange={onChange}
        onMount={onMount}
        loading={spinner}
        options={options}
      />
      {!ready && <div className="editor-loading" style={{ position: 'absolute', inset: 0, zIndex: 2, background: 'var(--bg-editor)' }}><span className="spinner" /></div>}
    </>
  )
}
