// The prompt builder panel shared by thumbnails and UI art: "Build" turns the short ask into the
// structured sections (rules, the style profile / UI kit and your taste); "Expand with AI" asks the
// Labs model to flesh them out. Every section is editable; Make sends the edited sections. Lint
// warnings and the rendered text update as you type (shared/thumbs/builder.ts, pure).
import { useEffect, useMemo, useState } from 'react'
import type { BuildPromptInput, BuiltPrompt, PromptMode, PromptSection } from '@shared/types'
import { lintSections, renderSections } from '@shared/thumbs/builder'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { useStore } from '../../store'

export interface BuilderState {
  built: BuiltPrompt | null
  // The ask it was built from (an edit to the ask makes it stale).
  ask: string
  sections: PromptSection[]
}

export const EMPTY_BUILDER: BuilderState = { built: null, ask: '', sections: [] }

// The sections Make should send: only when built for this ask and mode.
export function builderSections(b: BuilderState, ask: string, mode: PromptMode): PromptSection[] | undefined {
  return b.built && b.built.mode === mode && b.ask.trim() === ask.trim() && b.sections.length ? b.sections : undefined
}

const SOURCE_LABEL: Record<NonNullable<PromptSection['source']>, string> = { rules: 'rules', model: 'AI', kit: 'kit', user: 'you' }

export function PromptBuilder({ mode, ask, input, state, setState, open, setOpen }: { mode: PromptMode; ask: string; input: Omit<BuildPromptInput, 'ask' | 'mode' | 'model'>; state: BuilderState; setState: (s: BuilderState) => void; open: boolean; setOpen: (o: boolean) => void }) {
  const { actions } = useStore()
  const [busy, setBusy] = useState<'rules' | 'model' | null>(null)
  const stale = !!state.built && (state.ask.trim() !== ask.trim() || state.built.mode !== mode)
  const warnings = useMemo(() => (state.built ? lintSections(state.sections, mode, state.built.names) : []), [state.sections, mode, state.built])
  const preview = useMemo(() => renderSections(state.sections, state.built?.names?.[0] ? { icon: state.built.names[0] } : {}), [state.sections, state.built])

  const build = async (model: boolean) => {
    if (!ask.trim() || busy) return
    setBusy(model ? 'model' : 'rules')
    try {
      const b = await window.harness.thumbBuildPrompt({ ...input, ask: ask.trim(), mode, model })
      setState({ built: b, ask: ask.trim(), sections: b.sections })
      setOpen(true)
    } catch (e) {
      actions.toast({ text: 'Could not build the prompt', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  // Rebuilding on mode change keeps the panel honest (sections differ per kind).
  useEffect(() => {
    if (state.built && state.built.mode !== mode) setState(EMPTY_BUILDER)
  }, [mode])

  const edit = (key: PromptSection['key'], text: string) => setState({ ...state, sections: state.sections.map((s) => (s.key === key ? { ...s, text, source: 'user' } : s)) })

  return (
    <section className={`th-builder${open ? ' open' : ''}`} aria-label="Prompt builder">
      <div className="th-builder-head">
        <button type="button" className="btn small ghost th-builder-toggle" onClick={() => setOpen(!open)} aria-expanded={open}>
          <Icon name={open ? 'chevDown' : 'chev'} size={10} /> prompt builder
        </button>
        <span className="faint th-builder-state">
          {!state.built ? 'Make builds it from your ask automatically; open it to see and edit every part.' : stale ? 'The ask changed: rebuild, or Make uses a fresh rule draft.' : `${state.built.by === 'model' ? 'expanded by AI' : 'built by the rules'} · Make sends these sections${state.sections.some((s) => s.source === 'user') ? ' (with your edits)' : ''}`}
        </span>
        <span className="grow" />
        <button type="button" className="btn small" onClick={() => void build(false)} disabled={!ask.trim() || !!busy} title="Turn the ask into structured sections with the Roblox rules (no model, instant)">
          {busy === 'rules' ? <span className="spinner" aria-hidden /> : <Icon name="list" size={10} />} Build
        </button>
        <button type="button" className="btn small" onClick={() => void build(true)} disabled={!ask.trim() || !!busy} title="Ask the Labs model (cheap tier) to make the sections more concrete; the Roblox rules stay">
          {busy === 'model' ? <span className="spinner" aria-hidden /> : <Icon name="sparkle" size={10} />} Expand with AI
        </button>
        {state.built && (
          <button type="button" className="btn small ghost" onClick={() => setState(EMPTY_BUILDER)} title="Drop the sections: Make builds a fresh draft">
            <Icon name="x" size={10} /> Clear
          </button>
        )}
      </div>
      {open && state.built && (
        <div className="th-builder-body">
          {state.built.notes.length > 0 && (
            <ul className="th-builder-notes note">
              {state.built.notes.map((n) => (
                <li key={n}>{n}</li>
              ))}
            </ul>
          )}
          {warnings.length > 0 && (
            <div className="callout warn row th-builder-warn" role="status">
              <Icon name="warn" size={12} />
              <span className="grow note">{warnings.join(' ')}</span>
            </div>
          )}
          <div className="th-sections">
            {state.sections.map((s) => (
              <label key={s.key} className={`th-section src-${s.source ?? 'rules'}`}>
                <span className="th-section-head">
                  <span className="mono">{s.label}</span>
                  <span className="th-src" title={`from ${SOURCE_LABEL[s.source ?? 'rules']}`}>
                    {SOURCE_LABEL[s.source ?? 'rules']}
                  </span>
                </span>
                <textarea className="input th-section-text" rows={s.text.length > 160 ? 3 : 2} value={s.text} onChange={(e) => edit(s.key, e.target.value)} aria-label={`${s.label} section`} spellCheck />
              </label>
            ))}
          </div>
          <details className="vfx-changes">
            <summary>as sent ({preview.length} characters, plus the fixed honesty and reference lines)</summary>
            <pre className="th-prompt mono">{preview}</pre>
            <button type="button" className="btn small ghost" onClick={() => void actions.copy(preview, 'Prompt')}>
              <Icon name="copy" size={10} /> Copy
            </button>
          </details>
        </div>
      )}
    </section>
  )
}
