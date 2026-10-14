// Ability Composer: one game "move" = an Animation Lab clip + VFX Lab effects on body parts + sound,
// camera shake, screen effects, hit-stop and root movement on one marker-synced timeline. Mirrors the
// VFX Lab: "Make a ___ move" (ability_compose in main), a library of moves, and a detail view with the
// live preview, the timeline, the editor, the critique (timing rules + vision critic) and the client
// Luau export. The labs stay separate: moves reference their items by id.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePersisted } from '../../qol/sessionStore'
import { timingChecks } from '@shared/ability/critique'
import { applyPatch } from '@shared/ability/model'
import { ABILITY_RUBRIC, type Ability, type AbilityEntry, type AbilityExportResult, type AbilityStatus, type TimeRef } from '@shared/ability/types'
import type { VfxEffect, VfxEntry } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { AbilityPreview } from './AbilityPreview'
import { Inspector } from './Inspector'
import { StudioCheckButton, StudioCheckPanel } from '../studio/StudioCheck'
import '../vfx/vfx.css'
import './ability.css'
import { PrinciplePriorities, PrincipleScorecard, usePrincipleWeights } from '../principles/Principles'
import { LabCostLine, LabDecisions } from '../gating/LabGating'
import { useRestateGate } from '../../components/useRestateGate'
import { RestatedBrief } from '../../components/RestateCard'

const SUGGESTIONS = ['charged palm blast that knocks me back', 'dash punch', 'ground slam shockwave', 'rising uppercut with sparks', 'quick sword slash']
const EXAMPLES = [{ key: 'hollow-purple', label: 'Hollow Purple' }]

const fileCache = new Map<string, string | null>()
function useAbilityFile(id: string, file: string | undefined, stamp = 0): string | null {
  const key = file ? `${id}/${file}@${stamp}` : ''
  const [url, setUrl] = useState<string | null>(key ? (fileCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!file) return setUrl(null)
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null)
    let live = true
    window.harness
      .abilityFile(id, file)
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

const qualityTag = (e: AbilityEntry) => (e.quality === 'avoid' ? <span className="tag err">avoid</span> : e.quality === 'good' ? <span className="tag ok">good</span> : null)

function Card({ entry, selected, onSelect }: { entry: AbilityEntry; selected: boolean; onSelect: () => void }) {
  const url = useAbilityFile(entry.id, entry.thumbs[0], entry.updatedAt)
  const a = entry.ability
  return (
    <button className={`vfx-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected} title={entry.description || entry.name}>
      <div className="vfx-thumb">{url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <Icon name="bolt" size={22} className="vfx-thumb-ph" />}</div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {qualityTag(entry)}
        <span className="faint mono">{a.duration.toFixed(1)}s</span>
      </div>
      <div className="ab-strip" aria-hidden>
        {a.events.map((e) => (
          <i key={e.id} className={`ab-k ${e.kind}`} />
        ))}
      </div>
    </button>
  )
}

function Frame({ id, file, label }: { id: string; file: string; label: string }) {
  const url = useAbilityFile(id, file)
  return (
    <figure className="ab-frame">
      <div className="vfx-frame">{url ? <img src={url} alt={label} loading="lazy" draggable={false} /> : <span className="vfx-frame-ph" />}</div>
      <figcaption className="mono faint">{label}</figcaption>
    </figure>
  )
}

function CritiquePanel({ entry, ability, busy, onCritique, ctx }: { entry: AbilityEntry; ability: Ability; busy: boolean; onCritique: (apply: boolean) => void; ctx: Parameters<typeof timingChecks>[1] }) {
  // Live timing checks for the current draft; the saved critique adds the vision critic.
  const checks = useMemo(() => timingChecks(ability, ctx), [ability, ctx])
  const c = entry.critique
  const failing = checks.filter((x) => !x.ok)
  const weights = usePrincipleWeights()
  return (
    <div className="ab-crit">
      <div className="ab-crit-bar">
        <button className="btn small primary" onClick={() => onCritique(false)} disabled={busy} title="Timing rules plus the vision critic on frames at the key beats">
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
        </button>
        <button className="btn small" onClick={() => onCritique(true)} disabled={busy || !failing.some((x) => x.fix)} title="Apply the timing fixes (and the critic's edits)">
          <Icon name="check" size={11} /> Fix timings
        </button>
        <span className="grow" />
        {c && (
          <span className="mono ab-score" title={`timing ${c.timingScore}/10${c.vision ? ` · vision ${c.vision.overall}/10` : ''}`}>
            {c.overall.toFixed(1)}
            <span className="faint">/10</span>
          </span>
        )}
      </div>
      <ul className="ab-checks">
        {checks.map((x, i) => (
          <li key={`${x.rule}-${i}`} className={x.ok ? 'ok' : x.level}>
            <Icon name={x.ok ? 'check' : x.level === 'error' ? 'err' : x.level === 'warn' ? 'warn' : 'info'} size={11} />
            <span>{x.message}</span>
          </li>
        ))}
      </ul>
      {c?.vision && (
        <div className="ab-vision">
          <div className="vfx-rubric">
            {ABILITY_RUBRIC.map((k) => (
              <div key={k} className="vfx-rub ab-rub" title={`${k}: ${c.vision!.scores[k]}`}>
                <span>{k}</span>
                <span className="vfx-bar">
                  <i style={{ width: `${(c.vision!.scores[k] ?? 0) * 10}%` }} className={(c.vision!.scores[k] ?? 0) < 5 ? 'low' : ''} />
                </span>
                <b>{(c.vision!.scores[k] ?? 0).toFixed(1)}</b>
              </div>
            ))}
          </div>
          <p className="vfx-iter-sum">{c.vision.summary}</p>
        </div>
      )}
      {c?.principles && (
        <div className="ab-principles">
          <PrincipleScorecard principles={c.principles} focus={c.focus} score={c.principleScore} weights={weights} />
        </div>
      )}
      {c && c.frames.length > 0 && (
        <div className="ab-frames">
          {c.frames.map((f, i) => (
            <Frame key={f} id={entry.id} file={f} label={c.beats[i] ? `${c.beats[i].label} ${c.beats[i].t.toFixed(2)}s` : f} />
          ))}
        </div>
      )}
      {c && !c.vision && <p className="note">Last critique used the timing rules only (no vision model or renderer).</p>}
    </div>
  )
}

function ExportPanel({ entry, status, onExport, result, busy }: { entry: AbilityEntry; status: AbilityStatus | null; onExport: () => void; result: AbilityExportResult | null; busy: boolean }) {
  const { actions } = useStore()
  return (
    <div className="ab-export">
      <div className="ab-crit-bar">
        <button className="btn small primary" onClick={onExport} disabled={busy || !status?.projectRoot} title={status?.projectRoot ? `Write ${status.exportDir}/${entry.name}.luau and AbilityRunner.luau` : 'Open a project first'}>
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="code" size={11} />} Export to game
        </button>
        <span className="note mono">{status?.exportDir ? `${status.exportDir}/` : 'open a project to export'}</span>
      </div>
      <p className="note">
        Client only: a data module with play() and the shared AbilityRunner (animation, VFX Lab modules on body parts, sounds, camera shake, screen effects, hit-stop, root velocity). Gameplay hooks go in <span className="mono">options.onMarker</span>.
      </p>
      {result && (
        <>
          <dl className="vfx-meta">
            <dt>files</dt>
            <dd className="mono">
              {result.files.map((f) => (
                <div key={f}>{f}</div>
              ))}
            </dd>
            {result.command && (
              <>
                <dt>play</dt>
                <dd className="mono ab-cmd">
                  <span>{result.command}</span>
                  <button className="btn small ghost" onClick={() => void actions.copy(result.command!, 'Play command')} aria-label="Copy the play command">
                    <Icon name="copy" size={11} />
                  </button>
                </dd>
              </>
            )}
          </dl>
          {result.warnings.length > 0 && (
            <ul className="vfx-warn">
              {result.warnings.map((w, i) => (
                <li key={i} className="warn">
                  <Icon name="warn" size={11} /> {w}
                </li>
              ))}
            </ul>
          )}
          <details className="ab-src">
            <summary className="mono">{entry.name}.luau</summary>
            <pre className="mono">{result.source}</pre>
          </details>
        </>
      )}
      {!result && entry.written && <p className="note mono">last export: {entry.written.module}</p>}
    </div>
  )
}

function Detail({ entry, status, vfxEntries, onClose }: { entry: AbilityEntry; status: AbilityStatus | null; vfxEntries: VfxEntry[]; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [draft, setDraft] = useState<Ability>(entry.ability)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<'edit' | 'critique' | 'studio' | 'export' | 'info'>('edit')
  const [saving, setSaving] = useState(false)
  const [busy, setBusy] = useState<'critique' | 'export' | null>(null)
  const [exported, setExported] = useState<AbilityExportResult | null>(null)
  const pending = useRef<Ability | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  useEffect(() => {
    if (!pending.current) setDraft(entry.ability)
  }, [entry.id, entry.updatedAt])

  const flush = useCallback(async () => {
    const next = pending.current
    if (!next) return
    pending.current = null
    setSaving(true)
    try {
      await h.abilitySave(next, { id: entry.id })
    } catch (e) {
      actions.toast({ text: 'Could not save the move', detail: errorText(e), kind: 'err' })
    } finally {
      setSaving(false)
    }
  }, [entry.id])
  useEffect(() => () => void flush(), [flush])

  const edit = (next: Ability) => {
    setDraft(next)
    pending.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 500)
  }
  const retime = (id: string, at: TimeRef) => {
    try {
      edit(applyPatch(draft, { events: [{ id, at }] }))
    } catch (e) {
      actions.toast({ text: 'Could not retime', detail: errorText(e), kind: 'err' })
    }
  }

  // VFX Lab effects by entry id (stable identity so the preview only reloads when they change).
  const ids = [...new Set(draft.events.flatMap((e) => (e.kind === 'vfx' ? [e.effect] : [])))].sort().join('|')
  const effects = useMemo(() => {
    const out: Record<string, VfxEffect> = {}
    for (const id of ids.split('|')) {
      const fx = vfxEntries.find((e) => e.id === id)?.effect
      if (fx) out[id] = fx
    }
    return out
  }, [ids, vfxEntries])
  const ctx = useMemo(() => ({ vfx: (id: string) => effects[id]?.duration, stages: (id: string) => effects[id]?.stages }), [effects])

  const rate = async (r: 'up' | 'down') => {
    try {
      await h.abilityRate(entry.id, entry.rating === r ? null : r)
      if (entry.rating !== r) actions.toast({ text: r === 'up' ? 'Saved as an example move' : 'Noted as something to avoid', detail: r === 'up' ? 'The assistant sees it as a memory skill when composing moves.' : 'Saved to memory as feedback.', kind: 'ok', ms: 2600 })
    } catch (e) {
      actions.toast({ text: 'Rating failed', detail: errorText(e), kind: 'err' })
    }
  }
  const critique = async (apply: boolean) => {
    setBusy('critique')
    try {
      await flush()
      const r = await h.abilityCritique(entry.id, { apply })
      setDraft(r.entry.ability)
      setTab('critique')
      actions.toast({ text: `Critique ${r.critique.overall.toFixed(1)}/10`, detail: apply ? (r.applied.length ? `Applied: ${r.applied.slice(0, 4).join(', ')}` : 'Nothing to apply.') : r.critique.summary, kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Critique failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const doExport = async () => {
    setBusy('export')
    try {
      await flush()
      const r = await h.abilityExport(entry.id)
      setExported(r)
      setTab('export')
      actions.toast({ text: `Exported ${entry.name}`, detail: r.files.join(' · '), kind: r.warnings.length ? 'info' : 'ok', ms: 4000 })
    } catch (e) {
      actions.toast({ text: 'Export failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${entry.name} from the ${entry.scope} library?`)) return
    await h.abilityDelete(entry.id).catch((e) => actions.toast({ text: 'Delete failed', detail: errorText(e), kind: 'err' }))
    onClose()
  }
  const issues = useMemo(() => timingChecks(draft, ctx).filter((c) => !c.ok && c.level !== 'info').length, [draft, ctx])

  return (
    <section className="vfx-detail ab-detail" aria-label={`${entry.name} details`}>
      <div className="vfx-detail-head">
        <Icon name="bolt" size={13} />
        <b className="vfx-title">{entry.name}</b>
        <span className="badge-o">{entry.scope}</span>
        {qualityTag(entry)}
        {saving && <span className="note">saving…</span>}
        <span className="grow" />
        <button className={`btn small ghost${entry.rating === 'up' ? ' on' : ''}`} aria-pressed={entry.rating === 'up'} onClick={() => void rate('up')} title="Good: save as an example move">
          +1
        </button>
        <button className={`btn small ghost${entry.rating === 'down' ? ' on' : ''}`} aria-pressed={entry.rating === 'down'} onClick={() => void rate('down')} title="Bad: remember what to avoid">
          −1
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={12} />
        </button>
      </div>

      <AbilityPreview
        ability={draft}
        effects={effects}
        selected={selected}
        onSelect={(id) => (setSelected(id), id && setTab('edit'))}
        onRetime={retime}
        onAnimationStart={(start) => edit(applyPatch(draft, { ability: { animation: { start } } }))}
        onSnapshot={entry.thumbs.length ? undefined : (png) => void h.abilitySaveThumb(entry.id, png).catch(() => undefined)}
      />

      <div className="vfx-actions">
        <button className="btn small primary" onClick={() => void critique(false)} disabled={!!busy}>
          {busy === 'critique' ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
        </button>
        <StudioCheckButton kind="ability" id={entry.id} before={flush} onShow={() => setTab('studio')} />
        <button className="btn small" onClick={() => void doExport()} disabled={!!busy || !status?.projectRoot} title={status?.projectRoot ? 'Write the client module and AbilityRunner into the game' : 'Open a project to export'}>
          <Icon name="code" size={11} /> Export
        </button>
        {issues > 0 && (
          <button className="badge-o ab-issues" onClick={() => setTab('critique')}>
            <Icon name="warn" size={10} /> {issues} timing issue{issues === 1 ? '' : 's'}
          </button>
        )}
        {entry.written && <span className="note mono vfx-written" title={`${entry.written.module}\n${entry.written.runner}`}>{entry.written.module}</span>}
        <span className="grow" />
        <button className="btn small ghost danger" onClick={() => void remove()} aria-label="Delete">
          <Icon name="trash" size={11} />
        </button>
      </div>

      <div className="seg vfx-tabs" role="tablist">
        {(['edit', 'critique', 'studio', 'export', 'info'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k}
            {k === 'critique' && entry.critique ? ` · ${entry.critique.overall.toFixed(1)}` : ''}
          </button>
        ))}
      </div>

      {tab === 'edit' && <Inspector ability={draft} selected={selected} t={0} vfxEntries={vfxEntries} onChange={edit} onSelect={setSelected} />}
      {tab === 'critique' && <CritiquePanel entry={entry} ability={draft} busy={busy === 'critique'} onCritique={(apply) => void critique(apply)} ctx={ctx} />}
      {tab === 'critique' && <LabDecisions lab="ability" entryId={entry.id} />}
      {tab === 'studio' && <StudioCheckPanel kind="ability" id={entry.id} before={flush} />}
      {tab === 'export' && <ExportPanel entry={entry} status={status} onExport={() => void doExport()} result={exported} busy={busy === 'export'} />}
      {tab === 'info' && (
        <div className="vfx-info">
          <p className="vfx-desc">{entry.description || <span className="faint">No description.</span>}</p>
          <dl className="vfx-meta">
            <dt>made from</dt>
            <dd className="mono">{entry.origin}</dd>
            {entry.restatement && (
              <>
                <dt>confirmed brief</dt>
                <dd>
                  <RestatedBrief r={entry.restatement} />
                </dd>
              </>
            )}
            <dt>tags</dt>
            <dd className="mono">{entry.tags.join(', ') || '—'}</dd>
            <dt>animation</dt>
            <dd className="mono">{draft.animation ? `${draft.animation.name} (${draft.animation.clip})${draft.animation.assetId ? ` · ${draft.animation.assetId}` : ' · no asset id yet'}` : 'none'}</dd>
            <dt>vfx</dt>
            <dd className="mono">{[...new Set(draft.events.flatMap((e) => (e.kind === 'vfx' ? [`${e.effectName} (${e.effect})`] : [])))].join(', ') || 'none'}</dd>
            <dt>sound</dt>
            <dd>Roblox asset ids, or local files for the preview (upload them for the game). Sound generation is not available.</dd>
            {entry.written && (
              <>
                <dt>files</dt>
                <dd className="mono">
                  {entry.written.module}
                  <br />
                  {entry.written.runner}
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  )
}

export function AbilityPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<AbilityStatus | null>(null)
  const [entries, setEntries] = useState<AbilityEntry[]>([])
  const [vfxEntries, setVfxEntries] = useState<VfxEntry[]>([])
  // Selection and library tab survive restarts (qol/sessionStore).
  const [selected, setSelected] = usePersisted<string | null>('ability.selected', null)
  const [query, setQuery] = useState('')
  const [prompt, setPrompt] = useState('')
  const [making, setMaking] = useState(false)
  const [view, setView] = usePersisted<'moves' | 'priorities'>('ability.view', 'moves')

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([h.abilityStatus(), h.abilityList()])
      setStatus(s)
      setEntries(list)
    } catch (e) {
      actions.toast({ text: 'Could not load the moves', detail: errorText(e), kind: 'err' })
    }
  }, [actions])
  const loadVfx = useCallback(async () => {
    setVfxEntries(await h.vfxList().catch(() => []))
  }, [])

  useEffect(() => {
    void load()
    void loadVfx()
  }, [state.project?.root])
  useEffect(() => {
    const off1 = h.on('ability:changed', () => void load())
    const off2 = h.on('vfx:changed', () => void loadVfx())
    return () => (off1(), off2())
  }, [load, loadVfx])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((e) => words.every((w) => `${e.name} ${e.description} ${e.tags.join(' ')} ${e.origin}`.toLowerCase().includes(w)))
  }, [entries, query])
  const current = entries.find((e) => e.id === selected) ?? null

  const restate = useRestateGate('ability')
  const make = async () => {
    const what = prompt.trim()
    if (!what || making) return
    setMaking(true)
    try {
      // Restate first: the confirmed reading of the brief goes into compose (null = cancelled).
      const g = await restate.gate(what)
      if (!g) return
      const r = await h.abilityCompose(what, g.restatement ? { restatement: g.restatement } : undefined)
      await Promise.all([load(), loadVfx()])
      setSelected(r.entry.id)
      setPrompt('')
      actions.toast({
        text: `${r.entry.name}: ${r.vfx ? r.vfx.name : 'no VFX'} + ${r.animation ? r.animation.name : 'no clip'}`,
        detail: [`timings by ${r.timing === 'model' ? 'the model' : 'the draft rules'}`, ...r.notes].join(' · '),
        kind: r.notes.length ? 'info' : 'ok',
        ms: 4500
      })
    } catch (e) {
      actions.toast({ text: 'Could not make the move', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
    }
  }
  const addExample = async (key: string) => {
    try {
      const entry = await h.abilityAddExample(key)
      await Promise.all([load(), loadVfx()])
      setSelected(entry.id)
    } catch (e) {
      actions.toast({ text: 'Could not add the example', detail: errorText(e), kind: 'err' })
    }
  }
  const blank = async () => {
    try {
      const entry = await h.abilitySave({ version: 1, name: 'NewMove', duration: 1.5, animation: null, events: [] }, { origin: 'manual' })
      await load()
      setSelected(entry.id)
    } catch (e) {
      actions.toast({ text: 'Could not create a move', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <div className="page">
      <div className="page-inner vfx ability">
        <div className="page-head">
          <div>
            <h1>Ability Composer</h1>
            <div className="sub">
              {status ? `${status.entries.user} in your library · ${status.entries.project} in this project` : 'loading…'}
              {status && !status.projectRoot ? ' · open a project to export moves' : ''}
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void blank()}>
              <Icon name="plus" size={12} /> New move
            </button>
          </div>
        </div>

        {status && (!status.vision || !status.lune) && (
          <div className="callout row">
            <Icon name="info" size={12} />
            <span className="grow note">
              {!status.vision && <>No vision model: critiques use the timing rules only. </>}
              {!status.lune && <>Lune not found: scripted VFX Lab effects need it to compile. </>}
            </span>
          </div>
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
              <span className="vfx-prompt-sigil">›</span> Make a
            </span>
            <input className="input grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="charged palm blast that knocks me back" aria-label="Move to make" spellCheck />
            <span className="vfx-make-lead mono">move</span>
            <button className="btn primary" disabled={!prompt.trim() || making}>
              {making && !restate.waiting ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make
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
              <span className="faint mono">examples</span>
              {EXAMPLES.map((x) => (
                <button key={x.key} type="button" className="badge-o" onClick={() => void addExample(x.key)} title="Add this built-in move (and the VFX it uses) and open it">
                  {x.label}
                </button>
              ))}
            </span>
          </div>
          <LabCostLine lab="ability" />
        </section>

        <div className="seg vfx-view" role="tablist" aria-label="Library">
          <button role="tab" aria-selected={view === 'moves'} className={view === 'moves' ? 'on' : ''} onClick={() => setView('moves')}>
            moves
          </button>
          <button role="tab" aria-selected={view === 'priorities'} className={view === 'priorities' ? 'on' : ''} onClick={() => setView('priorities')} title="Which animation and VFX principles count most for you, learned from your ratings">
            priorities
          </button>
        </div>
        {view === 'priorities' && <PrinciplePriorities domains={['anim', 'vfx']} />}
        <div className={`vfx-body${current ? ' has-detail' : ''}`} hidden={view !== 'moves'}>
          <div className="vfx-lib">
            <div className="row vfx-lib-head">
              <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search moves" aria-label="Search moves" />
              <span className="note">{shown.length} shown</span>
            </div>
            {!entries.length && status && (
              <div className="empty">
                <Icon name="bolt" size={22} className="i" />
                No moves yet. Describe one above, add the Hollow Purple example, or start a new move and add a clip and events.
              </div>
            )}
            <div className="vfx-grid">
              {shown.map((e) => (
                <Card key={e.id} entry={e} selected={e.id === selected} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
              ))}
            </div>
          </div>
          {current && <Detail key={current.id} entry={current} status={status} vfxEntries={vfxEntries} onClose={() => setSelected(null)} />}
        </div>
      </div>
    </div>
  )
}
