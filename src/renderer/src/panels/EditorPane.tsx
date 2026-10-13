import { useEffect, useRef } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import { useStore } from '../store'
import { languageForPath, monaco } from '../monaco'
import { ClassIcon } from '../components/ClassIcon'
import { IconClose, IconCopy } from '../components/Icons'
import { useTheme } from '../theme'
import { startLuauLsp } from '../lsp'

function kindOf(path: string): string {
  if (path.endsWith('.blink')) return 'RemoteEvent'
  if (path.endsWith('.server.luau') || path.endsWith('.server.lua')) return 'Script'
  if (path.endsWith('.client.luau') || path.endsWith('.client.lua')) return 'LocalScript'
  return 'ModuleScript'
}

function tabName(path: string): string {
  const parts = path.split('/')
  const file = parts[parts.length - 1]
  // init.luau files are named after their folder in Roblox.
  if (/^init(\.(server|client))?\.luau?$/.test(file) && parts.length > 1) return parts[parts.length - 2]
  return file.replace(/\.(server|client)?\.?luau?$/, '').replace(/\.$/, '') || file
}

export function EditorPane() {
  const { state, actions } = useStore()
  const theme = useTheme()
  const file = state.files.find((f) => f.path === state.activeFile)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const activeRef = useRef<string | null>(null)
  activeRef.current = state.activeFile

  const actionsRef = useRef(actions)
  actionsRef.current = actions
  // Position to reveal once a file opened by go-to-definition is showing in the editor.
  const pendingReveal = useRef<{ path: string; position: { lineNumber: number; column: number } } | null>(null)

  const script = state.scripts.flatMap((g) => g.scripts).find((s) => s.path === state.activeFile)
  // Blink output files are regenerated from events.blink: read-only here.
  const blinkOutputs = state.blink?.outputs
  const generatedBy = file && blinkOutputs && (file.path === blinkOutputs.client || file.path === blinkOutputs.server || file.path === blinkOutputs.types) ? state.blink?.file ?? 'events.blink' : null

  const revealPending = () => {
    const pending = pendingReveal.current
    const editor = editorRef.current
    const model = editor?.getModel()
    if (!pending || !editor || !model || model.uri.path.replace(/^\/+/, '') !== pending.path) return
    pendingReveal.current = null
    editor.setPosition(pending.position)
    editor.revealPositionInCenter(pending.position)
    editor.focus()
  }

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      if (activeRef.current) void actions.saveFile(activeRef.current)
    })
    // Luau language features (luau-lsp). Starts once; a no-op in the browser preview mock.
    startLuauLsp(monaco, {
      openPath: (path, position) => {
        if (position) pendingReveal.current = { path, position }
        void actionsRef.current.openFile(path).then(() => setTimeout(revealPending))
      }
    })
    revealPending()
  }

  useEffect(() => {
    const timer = setTimeout(revealPending)
    return () => clearTimeout(timer)
  }, [state.activeFile, file?.loading])

  // openFileAt (Events tab): reveal the requested line once that file shows in the editor.
  useEffect(() => {
    const reveal = state.reveal
    if (!reveal || reveal.path !== state.activeFile || file?.loading) return
    pendingReveal.current = { path: reveal.path, position: { lineNumber: reveal.line, column: reveal.column } }
    actions.set({ reveal: null })
    const timer = setTimeout(revealPending)
    return () => clearTimeout(timer)
  }, [state.reveal, state.activeFile, file?.loading])

  // Blink compile errors as markers on events.blink and its imports.
  useEffect(() => {
    const diagnostics = state.blink?.diagnostics ?? []
    const apply = (model: monaco.editor.ITextModel) => {
      const path = model.uri.path.replace(/^\/+/, '')
      const markers = diagnostics
        .filter((d) => d.file === path)
        .map((d) => {
          const endLine = d.endLine ?? d.line
          const endColumn = d.endColumn ?? (endLine === d.line ? model.getLineMaxColumn(Math.min(d.line, model.getLineCount())) : model.getLineMaxColumn(Math.min(endLine, model.getLineCount())))
          return {
            severity: d.severity === 'warning' ? monaco.MarkerSeverity.Warning : monaco.MarkerSeverity.Error,
            message: d.detail ? `${d.message}\n${d.detail}` : d.message,
            source: 'blink',
            code: d.code,
            startLineNumber: d.line,
            startColumn: d.column,
            endLineNumber: endLine,
            endColumn: Math.max(endColumn, d.column + 1),
            relatedInformation: d.related?.map((r) => ({
              resource: monaco.Uri.file(r.file),
              message: r.message,
              startLineNumber: r.line,
              startColumn: r.column,
              endLineNumber: r.line,
              endColumn: r.column + 1
            }))
          }
        })
      monaco.editor.setModelMarkers(model, 'blink', markers)
    }
    monaco.editor.getModels().forEach(apply)
    // The editor creates its model after this effect when a file opens.
    const sub = monaco.editor.onDidCreateModel(apply)
    return () => sub.dispose()
  }, [state.blink])

  // Ctrl/Cmd+S also works when focus is outside Monaco (tabs, header).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's' && activeRef.current) {
        e.preventDefault()
        void actions.saveFile(activeRef.current)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [actions])

  return (
    <section className="editor-pane">
      <div className="tabs" role="tablist">
        {state.files.map((f) => {
          const dirty = f.current !== f.saved
          return (
            <div
              key={f.path}
              role="tab"
              aria-selected={f.path === state.activeFile}
              className={`tab${f.path === state.activeFile ? ' active' : ''}${dirty ? ' dirty' : ''}`}
              onClick={() => actions.set({ activeFile: f.path })}
              onMouseDown={(e) => {
                if (e.button === 1) {
                  e.preventDefault()
                  actions.closeFile(f.path)
                }
              }}
              title={f.path}
            >
              <ClassIcon className={kindOf(f.path)} size={13} />
              <span className="tab-name">{tabName(f.path)}</span>
              <button
                className="tab-close"
                title={dirty ? 'Unsaved changes — close' : 'Close'}
                onClick={(e) => {
                  e.stopPropagation()
                  if (dirty && !confirm(`Close ${tabName(f.path)} without saving?`)) return
                  actions.closeFile(f.path)
                }}
              >
                <span className="dirty-dot" />
                <IconClose size={12} />
              </button>
            </div>
          )
        })}
        <div className="tabs-fill" />
        <button className="icon-btn" title="Close editor" onClick={() => state.files.slice().forEach((f) => f.current === f.saved && actions.closeFile(f.path))}>
          <IconClose size={14} />
        </button>
      </div>
      {file && (
        <div className="editor-crumbs">
          <span className="crumb-path">{file.path}</span>
          {script && <span className={`realm realm-${script.realm}`}>{script.realm}</span>}
          <span className="crumbs-fill" />
          {file.current !== file.saved ? (
            <button className="btn small" onClick={() => void actions.saveFile(file.path)}>
              Save <kbd>{navigator.platform.includes('Mac') ? '⌘S' : 'Ctrl+S'}</kbd>
            </button>
          ) : (
            <span className="saved-note">Saved</span>
          )}
          <button className="icon-btn" title="Copy file path" onClick={() => void actions.copy(file.path)}>
            <IconCopy size={14} />
          </button>
        </div>
      )}
      {file && generatedBy && (
        <div className="generated-bar" role="note">
          <span className="generated-dot" aria-hidden />
          <span>Generated by Blink — edit <button className="link-btn" onClick={() => void actions.openFile(generatedBy)}>{generatedBy}</button></span>
          <span className="crumbs-fill" />
          <span className="generated-ro">read-only</span>
        </div>
      )}
      <div className="editor-host">
        {file && !file.loading ? (
          <Editor
            key={theme}
            path={file.path}
            language={languageForPath(file.path)}
            theme={theme === 'dark' ? 'harness-dark' : 'harness-light'}
            value={file.current}
            onChange={(v) => actions.editFile(file.path, v ?? '')}
            onMount={onMount}
            options={{
              fontFamily: '"JetBrains Mono", "SF Mono", Menlo, Consolas, "DejaVu Sans Mono", monospace',
              fontSize: 13,
              lineHeight: 20,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              smoothScrolling: true,
              renderLineHighlight: 'all',
              padding: { top: 12, bottom: 12 },
              tabSize: 4,
              insertSpaces: false,
              automaticLayout: true,
              guides: { indentation: true },
              scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
              overviewRulerBorder: false,
              hideCursorInOverviewRuler: true,
              readOnly: !!generatedBy,
              readOnlyMessage: generatedBy ? { value: `Generated by Blink. Edit ${generatedBy} instead.` } : undefined
            }}
          />
        ) : (
          <div className="editor-loading">Loading…</div>
        )}
      </div>
    </section>
  )
}
