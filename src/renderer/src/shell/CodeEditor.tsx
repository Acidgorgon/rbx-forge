// Monaco host for file tabs. One editor instance stays mounted while any file is open (hidden behind
// page tabs), so luau-lsp starts once and models keep their undo stacks and view state.
import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useStore, type ProblemItem } from '../store'
import { languageForPath, monaco } from '../monaco'
import { useAppearance } from '../theme'
import { startLuauLsp } from '../lsp'
import { setCursor } from '../lib/cursor'

const pathOf = (model: monaco.editor.ITextModel) => model.uri.path.replace(/^\/+/, '')

function severityOf(s: monaco.MarkerSeverity): ProblemItem['severity'] {
  if (s === monaco.MarkerSeverity.Error) return 'error'
  if (s === monaco.MarkerSeverity.Warning) return 'warning'
  return 'info'
}

export function CodeEditor({ path, readOnlyReason, visible }: { path: string; readOnlyReason: string | null; visible: boolean }) {
  const { state, actions } = useStore()
  const appearance = useAppearance()
  const file = state.files.find((f) => f.path === path)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const pathRef = useRef(path)
  pathRef.current = path
  const pendingReveal = useRef<{ path: string; position: { lineNumber: number; column: number } } | null>(null)
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

  const publishCursor = () => {
    const editor = editorRef.current
    const model = editor?.getModel()
    const pos = editor?.getPosition()
    if (!editor || !model || !pos) return setCursor(null)
    const opts = model.getOptions()
    const sel = editor.getSelection()
    setCursor({ line: pos.lineNumber, column: pos.column, tabSize: opts.tabSize, insertSpaces: opts.insertSpaces, selected: sel && !sel.isEmpty() ? model.getValueLengthInRange(sel) : 0 })
  }

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.onDidChangeCursorSelection(publishCursor)
    editor.onDidChangeModel(() => setTimeout(publishCursor))
    publishCursor()
    startLuauLsp(monaco, {
      openPath: (p, position) => {
        if (position) pendingReveal.current = { path: p, position }
        void actionsRef.current.openFile(p).then(() => setTimeout(revealPending))
      },
      onStatus: (s, detail) => actionsRef.current.set({ lsp: { state: s, detail } })
    })
    revealPending()
  }

  // Theme follows the app.
  useEffect(() => {
    monaco.editor.setTheme(appearance.resolved === 'dark' ? 'forge-dark' : 'forge-light')
  }, [appearance.resolved])

  useEffect(() => {
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [path, file?.loading])

  useEffect(() => {
    if (visible) setTimeout(() => editorRef.current?.layout())
    else setCursor(null)
  }, [visible])

  // openFileAt / palette ":" — reveal once the file shows.
  useEffect(() => {
    const reveal = state.reveal
    if (!reveal || reveal.path !== path || file?.loading) return
    pendingReveal.current = { path: reveal.path, position: { lineNumber: reveal.line, column: reveal.column } }
    actions.set({ reveal: null })
    const t = setTimeout(revealPending)
    return () => clearTimeout(t)
  }, [state.reveal, path, file?.loading])

  // Dispose models of files that were closed (the editor keeps models between tab switches).
  const openPaths = state.files.map((f) => f.path).join('\n')
  useEffect(() => {
    const open = new Set(openPaths.split('\n'))
    for (const m of monaco.editor.getModels()) {
      if (m.uri.scheme === 'file' && !open.has(pathOf(m)) && !m.isAttachedToEditor()) m.dispose()
    }
  }, [openPaths])

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

  if (!file || file.loading) return <div className="editor-loading"><span className="spinner" /></div>

  return (
    <Editor
      path={file.path}
      keepCurrentModel
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
        readOnly: !!readOnlyReason,
        readOnlyMessage: readOnlyReason ? { value: readOnlyReason } : undefined
      }}
    />
  )
}
