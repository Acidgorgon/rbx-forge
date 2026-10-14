// UI Motion Lab: import a Figma frame / component, then give it a feel. The live preview runs the
// generated Luau runtime (hover and click drive the springs for real), the effect stack edits a JSON
// spec, compare puts 2-3 stacks side by side, the timeline shows the state transitions, and the
// critique scores captured frames against the UI motion principles. Export writes a client module
// (<Name>Effects.luau) and a story into the project. Mirrors the VFX Lab layout.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { MotionSpec, UiComponentRef, UiMotionEntry, UiMotionExportResult, UiMotionStatus } from '@shared/types'
import { compileMotionModule, labSpecJson } from '@shared/uimotion/compile'
import { MOTION_PRESETS, EFFECT_LIBRARY, normalizeSpec, presetSpec } from '@shared/uimotion/spec'
import { uiPrincipleChecks } from '@shared/principles/uiChecks'
import { principleLabel } from '@shared/principles/catalog'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText, ago } from '../../lib/format'
import { useRestateGate } from '../../components/useRestateGate'
import { RestatedBrief } from '../../components/RestateCard'
import { PrinciplePriorities, PrincipleScorecard, usePrincipleWeights } from '../principles/Principles'
import { LabCostLine, LabDecisions } from '../gating/LabGating'
import { MotionStage, type MotionStageHandle } from './MotionStage'
import { EffectStack } from './EffectStack'
import { MotionTimeline } from './MotionTimeline'
import { FigmaImport } from './FigmaImport'
import type { StageMode } from '../uipreview/Stage'
import '../vfx/vfx.css'
import './uimotion.css'

const SUGGESTIONS = ['snappy and tight', 'bouncy play button', 'juicy shop button with a shine', 'calm menu card that floats', 'satisfying claim reward button']

const fileCache = new Map<string, string | null>()
function useEntryFile(id: string, file: string | undefined, stamp = 0): string | null {
  const key = file ? `${id}/${file}@${stamp}` : ''
  const [url, setUrl] = useState<string | null>(key ? (fileCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!file) return setUrl(null)
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null)
    let live = true
    window.harness
      .uiMotionFile(id, file)
      .then((u) => {
        fileCache.set(key, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return url
}

type CompareChoice = string | null // 'preset:<key>' | 'entry:<id>'

function Frame({ id, file, label, stamp }: { id: string; file: string; label: string; stamp: number }) {
  const url = useEntryFile(id, file, stamp)
  return (
    <figure className="um-frame">
      <div className="vfx-frame">{url ? <img src={url} alt={label} loading="lazy" draggable={false} /> : <span className="vfx-frame-ph" />}</div>
      <figcaption className="mono faint">{label}</figcaption>
    </figure>
  )
}

function Card({ entry, selected, onSelect }: { entry: UiMotionEntry; selected: boolean; onSelect: () => void }) {
  const kinds = [...new Set(entry.spec.targets.flatMap((t) => t.effects.map((e) => e.kind)))]
  const thumb = useEntryFile(entry.id, entry.thumbs[0], entry.updatedAt)
  return (
    <button className={`vfx-card um-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected}>
      <div className="vfx-thumb um-thumb">
        {thumb ? <img src={thumb} alt="" draggable={false} /> : <span className="um-chip-demo mono" aria-hidden>{entry.name.slice(0, 14)}</span>}
      </div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {entry.quality === 'good' && <span className="tag ok">good</span>}
        {entry.quality === 'avoid' && <span className="tag err">avoid</span>}
        {entry.critique && <span className="faint mono">{entry.critique.overall.toFixed(1)}</span>}
      </div>
      <div className="vfx-tags">
        {kinds.map((k) => (
          <span key={k} className="vfx-tag">
            {k}
          </span>
        ))}
        <span className="faint mono um-scope">{entry.scope}</span>
      </div>
    </button>
  )
}

export function UiMotionLabPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const weights = usePrincipleWeights()
  const [status, setStatus] = useState<UiMotionStatus | null>(null)
  const [entries, setEntries] = useState<UiMotionEntry[]>([])
  const [components, setComponents] = useState<UiComponentRef[]>([])
  const [componentName, setComponentName] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [draft, setDraft] = useState<MotionSpec>(() => presetSpec('snappy', '', 'Scratch'))
  const [path, setPath] = useState('')
  const [mode, setMode] = useState<StageMode>('interact')
  const [reduced, setReduced] = useState(false)
  const [compare, setCompare] = useState<CompareChoice[]>([])
  const [tab, setTab] = useState<'stack' | 'critique' | 'luau' | 'export' | 'info'>('stack')
  const [view, setView] = useState<'stacks' | 'priorities'>('stacks')
  const [prompt, setPrompt] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [showImport, setShowImport] = useState(false)
  const [exported, setExported] = useState<UiMotionExportResult | null>(null)
  const [stageStatus, setStageStatus] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const stage = useRef<MotionStageHandle>(null)
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const restate = useRestateGate('uimotion')

  const load = useCallback(async () => {
    try {
      const [s, list, comps] = await Promise.all([h.uiMotionStatus(), h.uiMotionList(), h.uiMotionComponents()])
      setStatus(s)
      setEntries(list)
      setComponents(comps)
      setComponentName((cur) => (cur && comps.some((c) => c.name === cur) ? cur : (comps[0]?.name ?? null)))
    } catch (e) {
      actions.toast({ text: 'Could not load the UI Motion Lab', detail: errorText(e), kind: 'err' })
    }
  }, [actions])
  useEffect(() => void load(), [state.project?.root])
  useEffect(() => h.on('uimotion:changed', () => void load()), [load])

  const component = components.find((c) => c.name === componentName) ?? null
  const current = entries.find((e) => e.id === selected) ?? null

  // Selecting a stack loads its spec into the editor (and its component, when imported here).
  const pick = (e: UiMotionEntry | null) => {
    // An edit still waiting for its autosave goes to the stack it was made on, not lost.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      if (selected) void h.uiMotionSave(draft, { id: selected }).catch((err) => actions.toast({ text: 'Could not save the stack', detail: errorText(err), kind: 'err' }))
      // Re-picking the stack being edited keeps the editor as it is.
      if (e && e.id === selected) return
    }
    setSelected(e?.id ?? null)
    setExported(null)
    if (!e) return
    setDraft(e.spec)
    setPath(e.spec.targets.find((t) => t.effects.length)?.path ?? '')
    if (e.component && components.some((c) => c.name === e.component)) setComponentName(e.component)
  }
  useEffect(() => {
    if (!selected && entries.length && !current) pick(entries[0])
  }, [entries.length])

  // Edits autosave into the selected stack.
  const edit = (spec: MotionSpec) => {
    setDraft(spec)
    if (!selected) return
    if (saveTimer.current) clearTimeout(saveTimer.current)
    const id = selected
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null
      void h.uiMotionSave(spec, { id }).catch((e) => actions.toast({ text: 'Could not save the stack', detail: errorText(e), kind: 'err' }))
    }, 500)
  }
  const flush = async () => {
    if (saveTimer.current && selected) {
      clearTimeout(saveTimer.current)
      saveTimer.current = null
      await h.uiMotionSave(draft, { id: selected })
    }
  }

  const specFor = (c: CompareChoice): { spec: MotionSpec; label: string } | null => {
    if (!c) return null
    if (c.startsWith('preset:')) {
      const p = MOTION_PRESETS.find((x) => `preset:${x.key}` === c)
      return p ? { spec: presetSpec(p.key, path), label: p.label } : null
    }
    const e = entries.find((x) => `entry:${x.id}` === c)
    return e ? { spec: e.spec, label: e.name } : null
  }
  const slots = useMemo(() => {
    const main = { spec: labSpecJson(draft), label: current?.name ?? draft.name }
    const rest = compare.map(specFor).filter(Boolean).map((s) => ({ spec: labSpecJson(s!.spec), label: s!.label }))
    return [main, ...rest].slice(0, 3)
  }, [draft, compare, entries, path, current?.name])

  const make = async () => {
    const what = prompt.trim()
    if (!what || busy) return
    setBusy('make')
    try {
      const g = await restate.gate(what)
      if (!g) return
      const r = await h.uiMotionCompose(what, { ...(g.restatement ? { restatement: g.restatement } : {}), ...(component ? { component: component.name } : {}), current: draft })
      await load()
      pick(r.entry)
      setPrompt('')
      actions.toast({ text: `${r.entry.name}: ${r.entry.spec.targets.flatMap((t) => t.effects.map((e) => e.kind)).join(' + ')}`, detail: [r.source === 'model' ? 'composed by the model' : 'from a preset', ...r.notes].join(' · '), kind: r.source === 'model' ? 'ok' : 'info', ms: 4500 })
    } catch (e) {
      actions.toast({ text: 'Could not compose the stack', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  const saveNew = async (spec: MotionSpec, origin: string, name?: string) => {
    try {
      const e = await h.uiMotionSave(spec, { origin, ...(component ? { component: component.name } : {}), ...(name ? { name } : {}) })
      await load()
      pick(e)
    } catch (err) {
      actions.toast({ text: 'Could not save the stack', detail: errorText(err), kind: 'err' })
    }
  }

  const critique = async (apply: boolean) => {
    if (!current) return
    setBusy('critique')
    setTab('critique')
    try {
      await flush()
      const shots = apply ? { frames: [], labels: [] } : ((await stage.current?.capture()) ?? { frames: [], labels: [] })
      const r = await h.uiMotionCritique(current.id, { ...shots, apply })
      await load()
      if (apply) setDraft(r.entry.spec)
      if (apply && r.applied.length) actions.toast({ text: `Applied ${r.applied.length} change${r.applied.length === 1 ? '' : 's'}`, detail: r.applied.join(', '), kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Critique failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  const rate = async (r: 'up' | 'down') => {
    if (!current) return
    try {
      await h.uiMotionRate(current.id, current.rating === r ? null : r)
      await load()
    } catch (e) {
      actions.toast({ text: 'Could not rate', detail: errorText(e), kind: 'err' })
    }
  }

  const doExport = async () => {
    if (!current) return
    setBusy('export')
    try {
      await flush()
      const r = await h.uiMotionExport(current.id, component ? { component: component.name } : undefined)
      setExported(r)
      setTab('export')
      actions.toast({ text: `Wrote ${r.module}`, detail: r.story ? `story: ${r.story}` : undefined, kind: r.warnings.length ? 'info' : 'ok', ms: 3500 })
      await load()
    } catch (e) {
      actions.toast({ text: 'Export failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  const remove = async () => {
    if (!current) return
    // A pending autosave would recreate nothing and only fail with "no motion stack".
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = null
    await h.uiMotionDelete(current.id).catch(() => undefined)
    setSelected(null)
    await load()
  }

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((e) => words.every((w) => `${e.name} ${e.description} ${e.origin}`.toLowerCase().includes(w)))
  }, [entries, query])

  const luau = useMemo(() => (tab === 'luau' ? compileMotionModule(normalizeSpec(draft, draft.name), { source: component ? `${component.name} / ${draft.name}` : draft.name }) : ''), [tab, draft, component?.name])
  const liveChecks = useMemo(() => uiPrincipleChecks(normalizeSpec(draft, draft.name)), [draft])
  const c = current?.critique

  return (
    <div className="page">
      <div className="page-inner vfx uimotion">
        <div className="page-head">
          <div>
            <h1>UI Motion Lab</h1>
            <div className="sub">
              {status ? `${components.length} imported · ${status.entries.project} stacks in this project · ${status.entries.user} in your library` : 'loading…'}
              {status && !status.projectRoot ? ' · open a project to import and export' : ''}
            </div>
          </div>
          <div className="actions">
            <button className={`btn${showImport ? ' on' : ''}`} onClick={() => setShowImport((s) => !s)} aria-expanded={showImport}>
              <Icon name="download" size={12} /> Import from Figma
            </button>
            <button className="btn" onClick={() => void saveNew(draft, 'manual', `${draft.name}Copy`)} title="Save the current stack as a new entry">
              <Icon name="plus" size={12} /> Save as new
            </button>
          </div>
        </div>

        {status && (!status.vision || !status.lune || !status.projectRoot) && (
          <div className="callout row">
            <Icon name="info" size={12} />
            <span className="grow note">
              {!status.projectRoot && <>Open a game project: imports, the live preview and exports live in it. </>}
              {!status.lune && <>Lune not found: the live preview needs it (Settings › Toolchain). </>}
              {!status.vision && <>No vision model: critiques use the UI principle checks only. </>}
            </span>
          </div>
        )}

        {showImport && (
          <FigmaImport
            onClose={() => setShowImport(false)}
            onDone={(r) => {
              void load().then(() => setComponentName(r.component.name))
            }}
          />
        )}

        <section className="set-sec vfx-make">
          <form
            className="vfx-make-row"
            onSubmit={(e) => {
              e.preventDefault()
              void make()
            }}
          >
            <span className="vfx-make-lead mono">
              <span className="vfx-prompt-sigil">›</span> Make it feel
            </span>
            <input className="input grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="snappy, with a little bounce on click and a shine every few seconds" aria-label="Describe the feel" spellCheck />
            <button className="btn primary" disabled={!prompt.trim() || !!busy}>
              {busy === 'make' && !restate.waiting ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make
            </button>
          </form>
          {restate.node}
          <div className="vfx-make-opts">
            <span className="vfx-sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="badge-o" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </span>
            <span className="vfx-examples">
              <span className="faint mono">presets</span>
              {MOTION_PRESETS.map((p) => (
                <button key={p.key} type="button" className="badge-o" title={p.feel} onClick={() => void saveNew(presetSpec(p.key, ''), `preset:${p.key}`, `${component?.name ?? ''}${p.label}`)}>
                  {p.label}
                </button>
              ))}
            </span>
          </div>
          <LabCostLine lab="uimotion" />
        </section>

        <div className="um-work">
          <section className="um-preview" aria-label="Live preview">
            <div className="row um-bar">
              <select className="input um-comp" value={componentName ?? ''} onChange={(e) => setComponentName(e.target.value || null)} aria-label="Component">
                {!components.length && <option value="">no imported UI</option>}
                {components.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              <span className="seg um-seg" role="group" aria-label="Preview mode">
                <button className={mode === 'interact' ? 'on' : ''} aria-pressed={mode === 'interact'} onClick={() => setMode('interact')} title="Hover and click drive the effects">
                  interact
                </button>
                <button className={mode === 'edit' ? 'on' : ''} aria-pressed={mode === 'edit'} onClick={() => setMode('edit')} title="Click an element to edit its effects">
                  select
                </button>
              </span>
              <label className="um-check mono">
                <input type="checkbox" checked={reduced} onChange={(e) => setReduced(e.target.checked)} /> reduced motion
              </label>
              <span className="grow" />
              <button className="btn small" onClick={() => stage.current?.trigger('appear')} disabled={!draft.targets.some((t) => t.effects.some((e) => e.kind === 'appear'))} title="Effects.show()">
                appear
              </button>
              <button className="btn small" onClick={() => stage.current?.trigger('disappear')} disabled={!draft.targets.some((t) => t.effects.some((e) => e.kind === 'disappear'))} title="Effects.hide()">
                disappear
              </button>
            </div>
            <MotionStage ref={stage} component={component} slots={slots} reduced={reduced} mode={mode} selectedPath={path} onSelectPath={(p) => (setPath(p), setTab('stack'))} onStatus={setStageStatus} />
            {stageStatus && (
              <p className="note warn mono um-stage-msg">
                <Icon name="warn" size={11} /> {stageStatus}
              </p>
            )}
            <div className="row um-compare" role="group" aria-label="Compare">
              <span className="faint mono">compare</span>
              {[0, 1].map((i) => (
                <select
                  key={i}
                  className="input"
                  value={compare[i] ?? ''}
                  aria-label={`Compare slot ${i + 2}`}
                  onChange={(e) => {
                    const next = [...compare]
                    next[i] = e.target.value || null
                    setCompare(next.filter((x, k) => x || k < next.length - 1))
                  }}
                >
                  <option value="">—</option>
                  <optgroup label="presets">
                    {MOTION_PRESETS.map((p) => (
                      <option key={p.key} value={`preset:${p.key}`}>
                        {p.label}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="library">
                    {entries
                      .filter((e) => e.id !== selected)
                      .map((e) => (
                        <option key={e.id} value={`entry:${e.id}`}>
                          {e.name}
                        </option>
                      ))}
                  </optgroup>
                </select>
              ))}
              <span className="note">same element, side by side; hover them in turn</span>
            </div>
            <MotionTimeline spec={draft} path={path} reduced={reduced} onReplay={() => stage.current?.replay()} />
          </section>

          <section className="vfx-detail um-detail" aria-label="Stack">
            <div className="vfx-detail-head">
              <Icon name="tap" size={13} />
              <b className="vfx-title">{current?.name ?? `${draft.name} (unsaved)`}</b>
              {current && <span className="badge-o">{current.scope}</span>}
              <span className="grow" />
              {current && (
                <>
                  <button className={`btn small ghost${current.rating === 'up' ? ' on' : ''}`} aria-pressed={current.rating === 'up'} onClick={() => void rate('up')} title="Keep: save to your library as an example of a good feel">
                    +1
                  </button>
                  <button className={`btn small ghost${current.rating === 'down' ? ' on' : ''}`} aria-pressed={current.rating === 'down'} onClick={() => void rate('down')} title="Bad: remember what to avoid">
                    −1
                  </button>
                </>
              )}
              {!current && (
                <button className="btn small primary" onClick={() => void saveNew(draft, 'manual')}>
                  Save
                </button>
              )}
            </div>
            <div className="vfx-actions">
              <button className="btn small primary" onClick={() => void critique(false)} disabled={!current || !!busy} title="Capture frames from the live preview (rest, hover, pressed, released, settled) and score them against the UI motion principles">
                {busy === 'critique' ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
              </button>
              <button className="btn small" onClick={() => void doExport()} disabled={!current || !!busy || !status?.projectRoot} title={status?.projectRoot ? 'Write the client module and a story into the game' : 'Open a project to export'}>
                {busy === 'export' ? <span className="spinner" aria-hidden /> : <Icon name="code" size={11} />} Export
              </button>
              {current?.written && <span className="note mono vfx-written">{current.written.module}</span>}
              <span className="grow" />
              {current && (
                <button className="btn small ghost danger" onClick={() => void remove()} aria-label="Delete stack">
                  <Icon name="trash" size={11} />
                </button>
              )}
            </div>
            <div className="seg vfx-tabs" role="tablist">
              {(['stack', 'critique', 'luau', 'export', 'info'] as const).map((k) => (
                <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
                  {k}
                  {k === 'critique' && c ? ` · ${c.overall.toFixed(1)}` : ''}
                </button>
              ))}
            </div>

            {tab === 'stack' && <EffectStack spec={draft} path={path} elements={component?.elements ?? []} onPath={setPath} onChange={edit} />}

            {tab === 'critique' && (
              <div className="um-crit">
                <ul className="um-checks" aria-label="UI principle checks (live)">
                  {liveChecks.map((x) => (
                    <li key={x.id} className={x.score >= 8 ? 'ok' : x.score >= 5 ? 'warn' : 'err'}>
                      <span className="mono um-ck-id">{principleLabel(x.id)}</span>
                      <span className="vfx-bar um-ck-bar">
                        <i style={{ width: `${x.score * 10}%` }} className={x.score < 5 ? 'low' : ''} />
                      </span>
                      <b className="mono">{x.score.toFixed(1)}</b>
                      <span className="um-ck-note">
                        {x.note}
                        {x.fix ? <span className="faint"> → {x.fix}</span> : null}
                      </span>
                    </li>
                  ))}
                </ul>
                {!current && <p className="note">Save the stack to run the critique (it captures frames from the live preview).</p>}
                {c?.vision && (
                  <div className="um-vision">
                    <div className="vfx-rubric">
                      {(Object.keys(c.vision.scores) as (keyof typeof c.vision.scores)[]).map((k) => (
                        <div key={k} className="vfx-rub" title={`${k}: ${c.vision!.scores[k]}`}>
                          <span>{k}</span>
                          <span className="vfx-bar">
                            <i style={{ width: `${c.vision!.scores[k] * 10}%` }} className={c.vision!.scores[k] < 5 ? 'low' : ''} />
                          </span>
                          <b>{c.vision!.scores[k].toFixed(1)}</b>
                        </div>
                      ))}
                    </div>
                    <p className="vfx-iter-sum">{c.vision.summary}</p>
                    {c.vision.changes.length > 0 && (
                      <ul className="um-changes">
                        {c.vision.changes.map((ch, i) => (
                          <li key={i} className="mono">
                            {ch.path || 'root'}.{ch.kind}.{ch.field}
                            {ch.value !== undefined && ch.field !== 'remove' ? ` → ${typeof ch.value === 'object' ? JSON.stringify(ch.value) : String(ch.value)}` : ''}
                            {ch.why && <span className="faint"> · {ch.why}</span>}
                          </li>
                        ))}
                      </ul>
                    )}
                    {c.vision.changes.length > 0 && (
                      <button className="btn small" onClick={() => void critique(true)} disabled={!!busy}>
                        <Icon name="check" size={11} /> Apply changes
                      </button>
                    )}
                  </div>
                )}
                {c && !c.vision && <p className="note">{c.summary}</p>}
                {c?.principles && <PrincipleScorecard principles={c.principles} focus={c.focus} score={c.principleScore} weights={weights} />}
                {c && c.frames.length > 0 && (
                  <div className="um-frames">
                    {c.frames.map((f, i) => (
                      <Frame key={f} id={current!.id} file={f} stamp={c.at} label={['rest', 'hover', 'pressed', 'released', 'settled'][i] ?? f} />
                    ))}
                  </div>
                )}
                {current && <LabDecisions lab="uimotion" entryId={current.id} />}
              </div>
            )}

            {tab === 'luau' && (
              <div className="um-luau">
                <div className="row">
                  <span className="note">
                    Client module · TweenService + RenderStepped springs · cleans up its connections · <span className="mono">require(m).attach(button)</span>
                  </span>
                  <span className="grow" />
                  <button className="btn small" onClick={() => void navigator.clipboard?.writeText(luau).then(() => actions.toast({ text: 'Copied the module', kind: 'ok', ms: 1600 }))}>
                    <Icon name="copy" size={11} /> Copy
                  </button>
                </div>
                <pre className="um-code mono" tabIndex={0}>
                  {luau}
                </pre>
              </div>
            )}

            {tab === 'export' && (
              <div className="um-export">
                <p className="note">
                  Writes <span className="mono">{status?.uiDir ?? 'src/shared/Interface'}/Motion/{draft.name}Effects.luau</span>
                  {component ? (
                    <>
                      {' '}
                      and a story for <span className="mono">{component.name}</span> next to its storybook
                    </>
                  ) : null}
                  , following the project file's mapping (Rojo / Forge Sync).
                </p>
                <button className="btn primary small" onClick={() => void doExport()} disabled={!current || !!busy || !status?.projectRoot}>
                  <Icon name="code" size={11} /> Export to project
                </button>
                {exported && (
                  <div className="um-report">
                    <ul className="mono um-files-list">
                      {exported.files.map((f) => (
                        <li key={f}>
                          <Icon name="check" size={10} /> {f}
                        </li>
                      ))}
                    </ul>
                    {exported.requirePath && (
                      <pre className="um-code mono">{`local Effects = require(${exported.requirePath})\nlocal motion = Effects.attach(button) -- motion.destroy() when the UI goes away`}</pre>
                    )}
                    {exported.warnings.map((w, i) => (
                      <p key={i} className="note warn">
                        <Icon name="warn" size={11} /> {w}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            {tab === 'info' && (
              <div className="vfx-info">
                <dl className="vfx-meta">
                  <dt>made from</dt>
                  <dd className="mono">{current?.origin ?? 'unsaved'}</dd>
                  {current?.restatement && (
                    <>
                      <dt>confirmed brief</dt>
                      <dd>
                        <RestatedBrief r={current.restatement} />
                      </dd>
                    </>
                  )}
                  <dt>component</dt>
                  <dd className="mono">{component ? `${component.name} · ${component.module}` : 'none'}</dd>
                  {component?.from && (
                    <>
                      <dt>imported</dt>
                      <dd className="mono">
                        {component.from} · {ago(component.importedAt)}
                      </dd>
                      <dt>mapping</dt>
                      <dd>{component.summary || 'exact'}</dd>
                    </>
                  )}
                  <dt>effects</dt>
                  <dd className="mono">
                    {draft.targets
                      .filter((t) => t.effects.length)
                      .map((t) => `${t.path || 'root'}: ${t.effects.map((e) => EFFECT_LIBRARY[e.kind].label).join(', ')}`)
                      .join(' · ') || 'none'}
                  </dd>
                  <dt>spring model</dt>
                  <dd>x″ = −ω²(x − goal) − 2ζωx′, ω = 2π·frequency, ζ = damping; stepped in closed form each frame (frame-rate independent), same as Quenty's Spring (Speed = ω, Damper = ζ).</dd>
                </dl>
              </div>
            )}
          </section>
        </div>

        <div className="seg vfx-view" role="tablist" aria-label="Library">
          <button role="tab" aria-selected={view === 'stacks'} className={view === 'stacks' ? 'on' : ''} onClick={() => setView('stacks')}>
            stacks
          </button>
          <button role="tab" aria-selected={view === 'priorities'} className={view === 'priorities' ? 'on' : ''} onClick={() => setView('priorities')} title="Which UI motion principles count most for you, learned from your ratings">
            priorities
          </button>
        </div>
        {view === 'priorities' && <PrinciplePriorities domains={['ui']} />}
        <div className="vfx-lib um-lib-list" hidden={view !== 'stacks'}>
          <div className="row vfx-lib-head">
            <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search stacks" aria-label="Search stacks" />
            <span className="note">{shown.length} shown</span>
          </div>
          {!entries.length && status && (
            <div className="empty">
              <Icon name="tap" size={22} className="i" />
              No stacks yet. Describe a feel above or start from a preset.
            </div>
          )}
          <div className="vfx-grid">
            {shown.map((e) => (
              <Card key={e.id} entry={e} selected={e.id === selected} onSelect={() => pick(e.id === selected ? null : e)} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
