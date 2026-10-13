// Script tab: the effect's Luau timeline (fx:spawn kit rigs, fx:tween, fx:emit, fx:stage...) in
// Monaco. Run records it with Lune in main and previews the result without saving; Save stores it on
// the entry and writes Timeline.luau next to the effect's module. Errors come back with a line
// number and show as a marker on that line.
import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { VfxEffect, VfxEntry, VfxScriptResult } from '@shared/types'
import { SCRIPT_TEMPLATE } from '@shared/vfx/compile'
import { VFX_EXAMPLES } from '@shared/vfx/examples'
import { monaco } from '../../monaco'
import { useAppearance } from '../../theme'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { prefersReducedMotion } from './motion'

const OWNER = 'vfx-timeline'

export function ScriptPanel({ entry, effect, onPreview }: { entry: VfxEntry; effect: VfxEffect; onPreview: (effect: VfxEffect) => void }) {
  const { actions } = useStore()
  const appearance = useAppearance()
  const saved = entry.effect?.script ?? ''
  const [code, setCode] = useState(effect.script || saved || SCRIPT_TEMPLATE)
  const [result, setResult] = useState<VfxScriptResult | null>(null)
  const [busy, setBusy] = useState<'run' | 'save' | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const codeRef = useRef(code)
  codeRef.current = code
  const dirty = code !== (saved || SCRIPT_TEMPLATE)

  useEffect(() => {
    setCode(entry.effect?.script || SCRIPT_TEMPLATE)
    setResult(null)
  }, [entry.id])

  // Error marker on the failing line.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const line = result && !result.ok && result.error?.line ? Math.min(result.error.line, model.getLineCount()) : 0
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      line
        ? [{ severity: monaco.MarkerSeverity.Error, message: result!.error!.message, source: 'timeline', startLineNumber: line, startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }]
        : []
    )
    if (line) editorRef.current!.revealLineInCenterIfOutsideViewport(line)
  }, [result])

  const run = async (save: boolean) => {
    if (busy) return
    setBusy(save ? 'save' : 'run')
    try {
      const r = await window.harness.vfxRunScript(codeRef.current, { id: entry.id, save })
      setResult(r)
      if (r.ok && r.effect) onPreview(r.effect)
      if (r.ok && save) actions.toast({ text: 'Timeline saved', detail: entry.written ? `${entry.written.module.replace(/init\.luau$/, 'Timeline.luau')} updated` : undefined, kind: 'ok', ms: 2400 })
    } catch (e) {
      setResult({ ok: false, error: { message: errorText(e) }, prints: [], warnings: [], summary: '' })
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

  const loadExample = (key: string) => {
    const ex = VFX_EXAMPLES.find((e) => e.key === key)
    if (!ex) return
    if (dirty && code.trim() && !confirm(`Replace the script with the ${ex.name} example?`)) return
    setCode(ex.script)
  }

  const smooth = appearance.motion === 'full' && !prefersReducedMotion()
  const err = result && !result.ok ? result.error : null
  return (
    <div className="vfx-script">
      <div className="vfx-script-bar">
        <button className="btn small primary" onClick={() => void run(false)} disabled={!!busy} title="Record the script and preview it (Ctrl/Cmd+Enter); nothing is saved">
          {busy === 'run' ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Run
        </button>
        <button className="btn small" onClick={() => void run(true)} disabled={!!busy} title="Run, then save the timeline on this effect and write Timeline.luau (Ctrl/Cmd+S)">
          {busy === 'save' ? <span className="spinner" aria-hidden /> : <Icon name="check" size={11} />} Save
        </button>
        <button className="btn small ghost" onClick={() => (setCode(saved || SCRIPT_TEMPLATE), setResult(null))} disabled={!dirty} title="Back to the saved script">
          <Icon name="undo" size={11} /> Revert
        </button>
        {dirty && <span className="note">unsaved</span>}
        <span className="grow" />
        <select className="input" value="" onChange={(e) => loadExample(e.target.value)} aria-label="Load an example script">
          <option value="" disabled>
            examples…
          </option>
          {VFX_EXAMPLES.map((e) => (
            <option key={e.key} value={e.key}>
              {e.name}
            </option>
          ))}
        </select>
      </div>
      <div className="vfx-script-editor">
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
        {!result && <span className="faint">Run records the script with Lune (Ctrl/Cmd+Enter) and previews it; the Studio module plays the same script with the ForgeFX runtime.</span>}
        {err && (
          <button className="vfx-script-err" onClick={() => err.line && (editorRef.current?.setPosition({ lineNumber: err.line, column: 1 }), editorRef.current?.revealLineInCenter(err.line), editorRef.current?.focus())}>
            <Icon name="err" size={11} /> {err.line ? `line ${err.line}: ` : ''}
            {err.message}
          </button>
        )}
        {result?.ok && (
          <span className="vfx-script-ok">
            <Icon name="check" size={11} /> {result.effect?.stages?.length ?? 0} stages · {result.effect?.cues.length ?? 0} cues · {result.effect?.duration.toFixed(2)}s
          </span>
        )}
        {result?.warnings.map((w, i) => (
          <span key={i} className="vfx-script-warn">
            <Icon name="warn" size={11} /> {w}
          </span>
        ))}
        {!!result?.prints.length && <pre className="vfx-script-print">{result.prints.join('\n')}</pre>}
        {result?.ok && result.summary && (
          <details>
            <summary>cues</summary>
            <pre>{result.summary}</pre>
          </details>
        )}
      </div>
    </div>
  )
}
