// Script tab: the clip's Luau timeline (a:pose kit poses, a:ik, a:plant, a:overlap, a:marker...) in
// Monaco. Run records it with Lune in main and previews the result without saving; Save stores it on
// the entry (and its exported files). Errors come back with a line number and show as a marker.
import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { AnimClip, AnimEntry, AnimScriptResult } from '@shared/types'
import { ANIM_SCRIPT_TEMPLATE } from '@shared/anim/compile'
import { ANIM_EXAMPLES } from '@shared/anim/examples'
import { monaco } from '../../monaco'
import { useAppearance } from '../../theme'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { prefersReducedMotion } from '../vfx/motion'

const OWNER = 'anim-timeline'

export function AnimScriptPanel({ entry, onPreview }: { entry: AnimEntry; onPreview: (clip: AnimClip) => void }) {
  const { actions } = useStore()
  const appearance = useAppearance()
  const saved = entry.clip.script ?? ''
  const [code, setCode] = useState(saved || ANIM_SCRIPT_TEMPLATE)
  const [result, setResult] = useState<AnimScriptResult | null>(null)
  const [busy, setBusy] = useState<'run' | 'save' | null>(null)
  const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null)
  const codeRef = useRef(code)
  codeRef.current = code
  const dirty = code !== (saved || ANIM_SCRIPT_TEMPLATE)

  useEffect(() => {
    setCode(entry.clip.script || ANIM_SCRIPT_TEMPLATE)
    setResult(null)
  }, [entry.id])

  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (!model) return
    const line = result && !result.ok && result.error?.line ? Math.min(result.error.line, model.getLineCount()) : 0
    monaco.editor.setModelMarkers(
      model,
      OWNER,
      line
        ? [{ severity: monaco.MarkerSeverity.Error, message: result!.error!.message, source: 'anim', startLineNumber: line, startColumn: model.getLineFirstNonWhitespaceColumn(line) || 1, endLineNumber: line, endColumn: model.getLineMaxColumn(line) }]
        : []
    )
    if (line) editorRef.current!.revealLineInCenterIfOutsideViewport(line)
  }, [result])

  const run = async (save: boolean) => {
    if (busy) return
    setBusy(save ? 'save' : 'run')
    try {
      const r = await window.harness.animRunScript(codeRef.current, { id: entry.id, save })
      setResult(r)
      if (r.ok && r.clip) onPreview(r.clip)
      if (r.ok && save) actions.toast({ text: 'Script saved', detail: entry.written ? `${entry.written.model} updated` : undefined, kind: 'ok', ms: 2400 })
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
    const ex = ANIM_EXAMPLES.find((e) => e.key === key)
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
        <button className="btn small" onClick={() => void run(true)} disabled={!!busy} title="Run, then save the script and keys on this clip (Ctrl/Cmd+S)">
          {busy === 'save' ? <span className="spinner" aria-hidden /> : <Icon name="check" size={11} />} Save
        </button>
        <button className="btn small ghost" onClick={() => (setCode(saved || ANIM_SCRIPT_TEMPLATE), setResult(null))} disabled={!dirty} title="Back to the saved script">
          <Icon name="undo" size={11} /> Revert
        </button>
        {dirty && <span className="note">unsaved</span>}
        {!saved && entry.kind === 'imported' && <span className="note">imported keys · a script replaces them</span>}
        <span className="grow" />
        <select className="input" value="" onChange={(e) => loadExample(e.target.value)} aria-label="Load an example script">
          <option value="" disabled>
            examples…
          </option>
          {ANIM_EXAMPLES.map((e) => (
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
        {!result && <span className="faint">Run records the script with Lune (Ctrl/Cmd+Enter): kit poses, IK, foot plants and overlap become R15 keyframes.</span>}
        {err && (
          <button className="vfx-script-err" onClick={() => err.line && (editorRef.current?.setPosition({ lineNumber: err.line, column: 1 }), editorRef.current?.revealLineInCenter(err.line), editorRef.current?.focus())}>
            <Icon name="err" size={11} /> {err.line ? `line ${err.line}: ` : ''}
            {err.message}
          </button>
        )}
        {result?.ok && result.clip && (
          <span className="vfx-script-ok">
            <Icon name="check" size={11} /> {result.clip.duration.toFixed(2)}s · {result.clip.markers.length} markers · {result.clip.beats?.length ?? 0} beats{result.checks ? ` · checks ${result.checks.overall}/10` : ''}
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
            <summary>keys</summary>
            <pre>{result.summary}</pre>
          </details>
        )}
      </div>
    </div>
  )
}
