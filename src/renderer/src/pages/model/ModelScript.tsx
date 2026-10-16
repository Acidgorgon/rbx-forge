// Script tab: the model's BlockyKit build script in Monaco. Run builds it with Lune and previews the
// result without saving; Save stores it on the entry. A failing line gets an error marker.
import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { ModelBuild, ModelEntry } from '@shared/types'
import { monaco } from '../../monaco'
import { useAppearance } from '../../theme'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { prefersReducedMotion } from '../vfx/motion'

const OWNER = 'model-build'

export function ModelScript({ entry, onBuild, onSaved }: { entry: ModelEntry; onBuild: (build: ModelBuild) => void; onSaved: (entry: ModelEntry, build: ModelBuild) => void }) {
  const appearance = useAppearance()
  const [code, setCode] = useState(entry.script)
  const [result, setResult] = useState<ModelBuild | null>(null)
  const [busy, setBusy] = useState<'run' | 'save' | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const codeRef = useRef(code)
  codeRef.current = code
  const dirty = code !== entry.script

  useEffect(() => {
    setCode(entry.script)
    setResult(null)
  }, [entry.id, entry.script])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const line = result && !result.ok && result.error?.line ? Math.min(result.error.line, model.getLineCount()) : 0
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      line
        ? [{ severity: monaco.MarkerSeverity.Error, message: result!.error!.message, source: 'build', startLineNumber: line, startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }]
        : []
    )
    if (line) editorRef.current!.revealLineInCenterIfOutsideViewport(line)
  }, [result])

  const run = async (save: boolean) => {
    if (busy) return
    setBusy(save ? 'save' : 'run')
    try {
      if (save) {
        const r = await window.harness.modelSave(entry.id, { script: codeRef.current })
        setResult(r.build)
        onSaved(r.entry, r.build)
      } else {
        const r = await window.harness.modelRun(codeRef.current, { name: entry.name })
        setResult(r)
        if (r.ok) onBuild(r)
      }
    } catch (e) {
      setResult({ ok: false, parts: [], prints: [], warnings: [], error: { message: errorText(e) } })
    } finally {
      setBusy(null)
    }
  }
  const runRef = useRef(run)
  runRef.current = run

  const onMount: OnMount = (editor) => {
    editorRef.current = editor
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => void runRef.current(false))
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => void runRef.current(true))
  }

  const smooth = appearance.motion === 'full' && !prefersReducedMotion()
  const err = result && !result.ok ? result.error : null
  return (
    <div className="vfx-script">
      <div className="vfx-script-bar">
        <button className="btn small primary" onClick={() => void run(false)} disabled={!!busy} title="Build the script in the Lune sandbox and preview it (Ctrl/Cmd+Enter); nothing is saved" data-testid="model-script-run">
          {busy === 'run' ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Run
        </button>
        <button className="btn small" onClick={() => void run(true)} disabled={!!busy} title="Build and save the script on this model (Ctrl/Cmd+S)">
          {busy === 'save' ? <span className="spinner" aria-hidden /> : <Icon name="check" size={11} />} Save
        </button>
        <button className="btn small ghost" onClick={() => (setCode(entry.script), setResult(null))} disabled={!dirty} title="Back to the saved script">
          <Icon name="undo" size={11} /> Revert
        </button>
        {dirty && <span className="note">unsaved</span>}
        <span className="grow" />
        <span className="note mono">{code.length.toLocaleString('en-US')} chars</span>
      </div>
      <div className="vfx-script-editor model-script-editor">
        <Editor
          language="luau"
          theme={appearance.resolved === 'dark' ? 'forge-dark' : 'forge-light'}
          value={code}
          onChange={(v) => setCode(v ?? '')}
          onMount={onMount}
          loading={<div className="editor-loading"><span className="spinner" /></div>}
          options={{
            fontFamily: '"JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace',
            fontSize: 12.5,
            lineHeight: 19,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            smoothScrolling: smooth,
            cursorBlinking: smooth ? 'smooth' : 'blink',
            renderLineHighlight: 'line',
            padding: { top: 8, bottom: 8 },
            tabSize: 4,
            insertSpaces: false,
            automaticLayout: true,
            scrollbar: { verticalScrollbarSize: 8, horizontalScrollbarSize: 8, useShadows: false },
            overviewRulerBorder: false,
            hideCursorInOverviewRuler: true,
            fixedOverflowWidgets: true,
            stickyScroll: { enabled: false }
          }}
        />
      </div>
      <div className="vfx-script-out mono" aria-live="polite">
        {!result && <span className="faint">Run builds the script with Lune (Ctrl/Cmd+Enter) and previews it; Build in Studio runs the same script with the same BlockyKit.</span>}
        {err && (
          <button className="vfx-script-err" onClick={() => err.line && (editorRef.current?.setPosition({ lineNumber: err.line, column: 1 }), editorRef.current?.revealLineInCenter(err.line), editorRef.current?.focus())}>
            <Icon name="err" size={11} /> {err.line ? `line ${err.line}: ` : ''}
            {err.message}
          </button>
        )}
        {result?.ok && (
          <span className="vfx-script-ok">
            <Icon name="check" size={11} /> {result.parts.length} parts{result.stats ? ` · ${result.stats.motors} motors · ${result.stats.assemblies} assembl${result.stats.assemblies === 1 ? 'y' : 'ies'}` : ''}
          </span>
        )}
        {result?.warnings.map((w, i) => (
          <span key={i} className="vfx-script-warn">
            <Icon name="warn" size={11} /> {w}
          </span>
        ))}
        {!!result?.prints.length && <pre className="vfx-script-print">{result.prints.join('\n')}</pre>}
      </div>
    </div>
  )
}
