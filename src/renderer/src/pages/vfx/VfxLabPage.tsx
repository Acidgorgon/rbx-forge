// VFX Lab: a reference library of Roblox effects (imported .rbxm/.rbxmx, images, gifs, videos and
// generated effects), "Make a ___ effect" (draft -> render -> critique -> refine, in main), and a
// detail view with the live three.js preview, the parameter editor (writes back to the effect's
// Luau module and .rbxmx) and the iteration history side by side.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePersisted } from '../../qol/sessionStore'
import type { VfxEffect, VfxEntry, VfxLabStatus, VfxRecipe, VfxRefineProgress, VfxScope } from '@shared/types'
import { RUBRIC_KEYS } from '@shared/vfx/types'
import { dedupeWarnings, IMPORT_VERSION, layerRoles, perfWarnings } from '@shared/vfx/analyze'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { VfxPreview } from './VfxPreview'
import { ParamEditor } from './ParamEditor'
import { ScriptPanel } from './ScriptPanel'
import { StudioCheckButton, StudioCheckPanel } from '../studio/StudioCheck'
import { TextureLab } from './TextureLab'
import { RefCard, RefCompare, RefDetail } from '../videoref/RefViews'
import { RefImport } from '../videoref/RefImport'
import { isRefFile } from '../videoref/decode'
import { PrinciplePriorities, PrincipleScorecard, usePrincipleWeights } from '../principles/Principles'
import { principleLabel } from '@shared/principles/catalog'
import { LabCostLine, LabDecisions } from '../gating/LabGating'
import './vfx.css'
import { CompareButton, VfxCompare } from '../compare/LabCompare'
import { useRestateGate } from '../../components/useRestateGate'
import { RestatedBrief } from '../../components/RestateCard'
import { AddToGameButton } from '../qolc/AddToGame'

const IMPORT_HINT = '.rbxm · .rbxmx · folders · png/jpg · video refs: mp4/webm/mov/gif'
const SUGGESTIONS = ['sword slash', 'fire aura', 'lightning impact', 'heal burst', 'dash trail', 'energy beam']
const SEQ_SUGGESTIONS = ['fireball that charges and explodes', 'charged lightning slash', 'ground slam shockwave', 'teleport blink', 'dragon breath sweep']
const EXAMPLES = [
  { key: 'hollow-purple', label: 'Hollow Purple' },
  { key: 'charge-slash', label: 'Charge slash' },
  { key: 'ground-slam', label: 'Ground slam' }
]

// Entry files as data URLs, cached per entry + file + update time.
const fileCache = new Map<string, string | null>()
function useEntryFile(id: string, file: string | undefined, stamp = 0): string | null {
  const key = file ? `${id}/${file}@${stamp}` : ''
  const [url, setUrl] = useState<string | null>(key ? (fileCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!file) return setUrl(null)
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null)
    let live = true
    window.harness
      .vfxFile(id, file)
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

const qualityTag = (e: VfxEntry) => (e.quality === 'avoid' ? <span className="tag err">avoid</span> : e.quality === 'good' ? <span className="tag ok">good</span> : e.quality === 'reference' ? <span className="tag info">ref</span> : null)
const kindLabel = (e: VfxEntry) => (e.kind === 'media' ? (e.media?.[0]?.mime.startsWith('video') ? 'video' : 'image') : e.kind === 'generated' ? 'made' : 'model')

function Card({ entry, selected, progress, onSelect }: { entry: VfxEntry; selected: boolean; progress?: VfxRefineProgress; onSelect: () => void }) {
  const thumb = entry.thumbs[0] ?? (entry.kind === 'media' && entry.media?.[0]?.mime.startsWith('image') ? entry.media[0].file : undefined)
  const url = useEntryFile(entry.id, thumb, entry.updatedAt)
  return (
    <button className={`vfx-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected} title={entry.description || entry.name}>
      <div className="vfx-thumb">
        {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <Icon name="sparkle" size={22} className="vfx-thumb-ph" />}
        {progress && progress.phase !== 'done' && progress.phase !== 'error' && (
          <span className="vfx-thumb-busy mono">
            <span className="spinner" aria-hidden /> {progress.phase} {progress.iteration}
          </span>
        )}
      </div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {qualityTag(entry)}
        <span className="faint mono">{kindLabel(entry)}</span>
      </div>
      <div className="vfx-tags">
        {entry.tags.slice(0, 4).map((t) => (
          <span key={t} className="vfx-tag">
            {t}
          </span>
        ))}
      </div>
    </button>
  )
}

function Frame({ id, file, label }: { id: string; file: string; label?: string }) {
  const url = useEntryFile(id, file)
  return <div className="vfx-frame">{url ? <img src={url} alt={label ?? file} loading="lazy" draggable={false} /> : <span className="vfx-frame-ph" />}</div>
}

function Iterations({ entry, onRestore }: { entry: VfxEntry; onRestore: (effect: VfxEffect, n: number) => void }) {
  const its = entry.iterations ?? []
  const weights = usePrincipleWeights()
  if (!its.length) return <div className="empty">No iterations yet. Refine runs render → critique → adjust and keeps each step here.</div>
  const best = its.reduce((a, b) => ((b.critique?.overall ?? 0) > (a.critique?.overall ?? 0) ? b : a), its[0])
  return (
    <div className="vfx-iters" role="list">
      {its.map((it) => (
        <article key={it.n} className={`vfx-iter${it === best ? ' best' : ''}`} role="listitem">
          <header className="vfx-iter-head">
            <span className="mono">#{it.n}</span>
            {it === best && <span className="tag ok">best</span>}
            <span className="grow" />
            {it.critique && <span className="vfx-score mono">{it.critique.overall.toFixed(1)}</span>}
          </header>
          <div className="vfx-frames">
            {it.frames.slice(0, 4).map((f) => (
              <Frame key={f} id={entry.id} file={f} />
            ))}
          </div>
          {it.critique && (
            <>
              <div className="vfx-rubric">
                {RUBRIC_KEYS.map((k) => (
                  <div key={k} className="vfx-rub" title={`${k}: ${it.critique!.scores[k]}`}>
                    <span>{k}</span>
                    <span className="vfx-bar">
                      <i style={{ width: `${(it.critique!.scores[k] ?? 0) * 10}%` }} className={(it.critique!.scores[k] ?? 0) < 5 ? 'low' : ''} />
                    </span>
                    <b>{(it.critique!.scores[k] ?? 0).toFixed(1)}</b>
                  </div>
                ))}
              </div>
              <PrincipleScorecard principles={it.critique.principles} focus={it.critique.focus} score={it.critique.principleScore} weights={weights} />
              <p className="vfx-iter-sum">{it.critique.summary}</p>
              {it.critique.changes.length > 0 && (
                <details className="vfx-changes">
                  <summary>{it.critique.changes.length} change{it.critique.changes.length === 1 ? '' : 's'} for next</summary>
                  <ul>
                    {it.critique.changes.map((c, i) => (
                      <li key={i}>
                        <span className="mono">
                          {c.node}.{c.prop}
                        </span>{' '}
                        {c.principle && <span className="pr-chg mono">{principleLabel(c.principle)}</span>} {c.why ?? ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <button className="btn small ghost" onClick={() => onRestore(it.effect, it.n)}>
            <Icon name="undo" size={11} /> Use #{it.n}
          </button>
        </article>
      ))}
    </div>
  )
}

function Media({ entry }: { entry: VfxEntry }) {
  const m = entry.media?.[0]
  const url = useEntryFile(entry.id, m?.file)
  if (!m) return null
  return <div className="vfx-media">{url ? m.mime.startsWith('video') ? <video src={url} controls loop muted playsInline /> : <img src={url} alt={entry.name} /> : <span className="spinner" />}</div>
}

function Detail({ entry, progress, recipes, onClose }: { entry: VfxEntry; progress?: VfxRefineProgress; recipes: VfxRecipe[]; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [tab, setTab] = useState<'params' | 'script' | 'iterations' | 'studio' | 'info'>(entry.effect ? (entry.effect.script ? 'script' : 'params') : 'info')
  const [draft, setDraft] = useState<VfxEffect | undefined>(entry.effect)
  const [saving, setSaving] = useState(false)
  const [tags, setTags] = useState(entry.tags.join(', '))
  const [comparing, setComparing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = useRef<VfxEffect | null>(null)
  // What each layer does, inferred from its properties (names in imported effects mean nothing).
  const roles = useMemo(() => (draft ? layerRoles(draft) : []), [draft])

  // A new entry, or a server-side update (refine wrote a better version) while no edit is pending.
  useEffect(() => {
    if (!pendingRef.current) setDraft(entry.effect)
    setTags(entry.tags.join(', '))
  }, [entry.id, entry.updatedAt])
  useEffect(() => setTab(entry.effect ? (entry.effect.script ? 'script' : 'params') : 'info'), [entry.id])

  const flush = useCallback(async () => {
    const next = pendingRef.current
    if (!next) return
    pendingRef.current = null
    setSaving(true)
    try {
      await h.vfxUpdate(entry.id, { effect: next })
    } catch (e) {
      actions.toast({ text: 'Could not save the effect', detail: errorText(e), kind: 'err' })
    } finally {
      setSaving(false)
    }
  }, [entry.id])
  useEffect(() => () => void flush(), [flush])

  const edit = (next: VfxEffect) => {
    setDraft(next)
    pendingRef.current = next
    clearTimeout(timer.current)
    timer.current = setTimeout(() => void flush(), 600)
  }

  const warnings = useMemo(() => (draft ? dedupeWarnings(perfWarnings(draft)) : []), [draft])
  const refining = !!progress && progress.phase !== 'done' && progress.phase !== 'error'
  const recipe = recipes.find((r) => entry.tags.includes(r.tag))

  const rate = async (r: 'up' | 'down') => {
    try {
      await h.vfxRate(entry.id, entry.rating === r ? null : r)
      if (entry.rating !== r) actions.toast({ text: r === 'up' ? 'Saved as a good example' : 'Noted as something to avoid', detail: 'Recipes and memory are updated.', kind: 'ok', ms: 2600 })
    } catch (e) {
      actions.toast({ text: 'Rating failed', detail: errorText(e), kind: 'err' })
    }
  }
  const studio = async () => {
    try {
      await flush()
      const r = await h.vfxTestInStudio(entry.id)
      await actions.copy(r.command, 'Studio command')
      actions.toast({
        text: r.rojo === 'unavailable' ? 'Written; start Rojo to sync it' : `Synced via Rojo${r.rojo === 'started' ? ' (started)' : ''}`,
        detail: `${r.module} → ${r.instancePath}. Paste the copied line into Studio's command bar to play it.`,
        kind: r.rojo === 'unavailable' ? 'info' : 'ok',
        ms: 7000
      })
    } catch (e) {
      actions.toast({ text: 'Test in Studio failed', detail: errorText(e), kind: 'err' })
    }
  }
  const refine = async () => {
    try {
      await flush()
      await h.vfxRefine(entry.id)
      setTab('iterations')
    } catch (e) {
      actions.toast({ text: 'Refine failed', detail: errorText(e), kind: 'err' })
    }
  }
  const [reimporting, setReimporting] = useState(false)
  const reimport = async () => {
    setReimporting(true)
    try {
      const e = await h.vfxReimport(entry.id)
      pendingRef.current = null
      setDraft(e.effect)
      actions.toast({ text: `${e.name} re-imported`, detail: e.importNotes?.slice(0, 2).join(' · '), kind: 'ok', ms: 3500 })
    } catch (err) {
      actions.toast({ text: 'Re-import failed', detail: errorText(err), kind: 'err' })
    } finally {
      setReimporting(false)
    }
  }
  const remove = async () => {
    if (!confirm(`Delete ${entry.name} from the ${entry.scope} library?`)) return
    await h.vfxDelete(entry.id).catch((e) => actions.toast({ text: 'Delete failed', detail: errorText(e), kind: 'err' }))
    onClose()
  }

  return (
    <section className="vfx-detail" aria-label={`${entry.name} details`}>
      <div className="vfx-detail-head">
        <Icon name="sparkle" size={13} />
        <b className="vfx-title">{entry.name}</b>
        <span className="badge-o">{entry.scope}</span>
        {qualityTag(entry)}
        {saving && <span className="note">saving…</span>}
        <span className="grow" />
        <button className={`btn small ghost${entry.rating === 'up' ? ' on' : ''}`} aria-pressed={entry.rating === 'up'} onClick={() => void rate('up')} title="Good: keep as a library example">
          +1
        </button>
        <button className={`btn small ghost${entry.rating === 'down' ? ' on' : ''}`} aria-pressed={entry.rating === 'down'} onClick={() => void rate('down')} title="Bad: remember what to avoid">
          −1
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={12} />
        </button>
      </div>

      {entry.kind === 'model' && (entry.importVersion ?? 1) < IMPORT_VERSION && (
        <div className="vfx-mesh-notice warn" role="status">
          <span>
            <Icon name="info" size={11} /> Imported with an older version of the VFX Lab: parts revealed by scripts, meshes, decals and script tweens may be missing.
          </span>
          <button className="btn small" onClick={() => void reimport()} disabled={reimporting}>
            {reimporting ? 'Re-importing…' : 'Re-import'}
          </button>
        </div>
      )}
      {draft ? <VfxPreview key={`${entry.id}:${entry.importVersion ?? 1}`} effect={draft} background={entry.kind === 'model' ? 'studio' : 'dark'} autoSnapshot={!entry.thumbs.length} onSnapshot={(png) => void h.vfxSaveThumb(entry.id, png).catch(() => undefined)} /> : <Media entry={entry} />}

      {draft && (
        <div className="vfx-actions">
          {refining ? (
            <>
              <span className="vfx-progress mono" aria-live="polite">
                <span className="spinner" aria-hidden /> #{progress!.iteration} {progress!.phase}
                {progress!.score != null ? ` · ${progress!.score.toFixed(1)}` : ''}
                {progress!.message ? ` · ${progress!.message}` : ''}
              </span>
              <button className="btn small" onClick={() => void h.vfxCancel(entry.id)}>
                <Icon name="stop" size={11} /> Cancel
              </button>
            </>
          ) : (
            <button className="btn small primary" onClick={() => void refine()} title="Render, critique against the closest references, adjust, repeat">
              <Icon name="restart" size={11} /> Refine
            </button>
          )}
          <StudioCheckButton kind="vfx" id={entry.id} before={flush} onShow={() => setTab('studio')} />
          <CompareButton onClick={() => void flush().then(() => setComparing(true))} count={entry.iterations?.length} />
          <button className="btn small" onClick={() => void studio()} title="Write src/shared/VFX/<Name>, sync with Rojo, copy a command-bar line">
            <Icon name="studio" size={11} /> Test in Studio
          </button>
          {entry.effect && <AddToGameButton lab="vfx" id={entry.id} />}
          {entry.written && <span className="note mono vfx-written" title={`${entry.written.module}\n${entry.written.model}`}>{entry.written.module}</span>}
          <span className="grow" />
          <button className="btn small ghost danger" onClick={() => void remove()} aria-label="Delete">
            <Icon name="trash" size={11} />
          </button>
        </div>
      )}

      {warnings.length > 0 && (
        <ul className="vfx-warn">
          {warnings.map((w, i) => (
            <li key={i} className={w.level}>
              <Icon name={w.level === 'info' ? 'info' : 'warn'} size={11} /> {w.message}
            </li>
          ))}
        </ul>
      )}

      <div className="seg vfx-tabs" role="tablist">
        {draft && (
          <button role="tab" aria-selected={tab === 'params'} className={tab === 'params' ? 'on' : ''} onClick={() => setTab('params')}>
            params
          </button>
        )}
        {draft && (
          <button role="tab" aria-selected={tab === 'script'} className={tab === 'script' ? 'on' : ''} onClick={() => setTab('script')} title="Luau timeline: stages, kit rigs, tweens">
            script{draft.stages?.length ? ` · ${draft.stages.length}` : ''}
          </button>
        )}
        {draft && (
          <button role="tab" aria-selected={tab === 'iterations'} className={tab === 'iterations' ? 'on' : ''} onClick={() => setTab('iterations')}>
            iterations{entry.iterations?.length ? ` · ${entry.iterations.length}` : ''}
          </button>
        )}
        {draft && (
          <button role="tab" aria-selected={tab === 'studio'} className={tab === 'studio' ? 'on' : ''} onClick={() => setTab('studio')} title="Studio check: the effect played in Roblox Studio, next to the preview">
            studio
          </button>
        )}
        <button role="tab" aria-selected={tab === 'info'} className={tab === 'info' ? 'on' : ''} onClick={() => setTab('info')}>
          info
        </button>
      </div>

      {comparing && <VfxCompare entry={entry} onClose={() => setComparing(false)} onUse={(e, label) => (edit(e), actions.toast({ text: `Using ${label}`, kind: 'ok', ms: 2000 }))} />}
      {tab === 'params' && draft && <ParamEditor effect={draft} onChange={edit} />}
      {tab === 'script' && draft && <ScriptPanel entry={entry} effect={draft} onPreview={setDraft} />}
      {tab === 'studio' && draft && <StudioCheckPanel kind="vfx" id={entry.id} before={flush} />}
      {tab === 'iterations' && draft && entry.refId && <PinnedCompare entry={entry} effect={draft} />}
      {tab === 'iterations' && draft && <Iterations entry={entry} onRestore={(e, n) => (edit(e), actions.toast({ text: `Using iteration #${n}`, kind: 'ok', ms: 2000 }))} />}
      {tab === 'iterations' && draft && <LabDecisions lab="vfx" entryId={entry.id} />}
      {tab === 'info' && (
        <div className="vfx-info">
          <p className="vfx-desc">{entry.description || <span className="faint">No description.</span>}</p>
          <dl className="vfx-meta">
            <dt>tags</dt>
            <dd>
              <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => tags !== entry.tags.join(', ') && void h.vfxUpdate(entry.id, { tags: tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean) })} aria-label="Tags" />
            </dd>
            <dt>origin</dt>
            <dd className="mono">{entry.origin}</dd>
            {entry.modelNote && (
              <>
                <dt>model</dt>
                <dd className="note vfx-model-note" role="note">
                  {entry.modelNote}
                </dd>
              </>
            )}
            {!!entry.importNotes?.length && (
              <>
                <dt>import</dt>
                <dd>
                  <ul className="vfx-import-notes">
                    {entry.importNotes.map((n) => (
                      <li key={n} className="note">
                        {n}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {entry.restatement && (
              <>
                <dt>confirmed brief</dt>
                <dd>
                  <RestatedBrief r={entry.restatement} />
                </dd>
              </>
            )}
            {entry.stats && (
              <>
                <dt>layers</dt>
                <dd className="mono">
                  {entry.stats.emitters} emitters · {entry.stats.beams} beams · {entry.stats.trails} trails · {entry.stats.lights} lights{entry.stats.meshes ? ` · ${entry.stats.meshes} meshes` : ''}
                </dd>
                <dt>budget</dt>
                <dd className="mono">
                  ~{entry.stats.particles} live particles · overdraw {entry.stats.overdraw.toFixed(1)}
                  {entry.stats.flipbooks ? ` · ${entry.stats.flipbooks} flipbooks` : ''}
                </dd>
                <dt>textures</dt>
                <dd className="mono vfx-tex">{entry.stats.textures.join('  ') || '—'}</dd>
              </>
            )}
            {roles.length > 0 && (
              <>
                <dt>roles</dt>
                <dd>
                  <ul className="vfx-roles" data-testid="vfx-roles">
                    {roles.map((r) => (
                      <li key={r.id} title={`${r.className}; inferred from its ${r.by}`}>
                        <span className="mono">{r.name}</span> → {r.label}
                      </li>
                    ))}
                  </ul>
                </dd>
              </>
            )}
            {entry.written && (
              <>
                <dt>files</dt>
                <dd className="mono">
                  {entry.written.module}
                  <br />
                  {entry.written.model}
                </dd>
              </>
            )}
            {recipe && (
              <>
                <dt>recipe</dt>
                <dd>
                  <span className="mono">vfx-recipe-{recipe.tag}</span> <span className="faint">· {recipe.samples} samples</span>
                </dd>
              </>
            )}
          </dl>
        </div>
      )}
    </section>
  )
}

// The best iteration's rendered beats next to the pinned video reference's key frames.
function PinnedCompare({ entry, effect }: { entry: VfxEntry; effect: VfxEffect }) {
  const its = entry.iterations ?? []
  const best = its.length ? its.reduce((a, b) => ((b.critique?.overall ?? 0) > (a.critique?.overall ?? 0) ? b : a), its[0]) : null
  return <RefCompare lab="vfx" refId={entry.refId!} entryId={entry.id} frames={best?.frames ?? []} match={best?.critique?.match} matchNotes={best?.critique?.matchNotes} effect={best?.effect ?? effect} iteration={best?.n} />
}

export function VfxLabPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<VfxLabStatus | null>(null)
  const [entries, setEntries] = useState<VfxEntry[]>([])
  const [recipes, setRecipes] = useState<VfxRecipe[]>([])
  // Selection and library tab survive restarts (qol/sessionStore).
  const [selected, setSelected] = usePersisted<string | null>('vfx.selected', null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [scope, setScope] = useState<VfxScope>('user')
  const [prompt, setPrompt] = useState('')
  const [iters, setIters] = useState(4)
  const [threshold, setThreshold] = useState(7.5)
  const [making, setMaking] = useState(false)
  // single: one burst of layers (draft spec); sequence: multi-stage timeline script with the kit.
  const [mode, setMode] = useState<'single' | 'sequence'>('sequence')
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [progress, setProgress] = useState<Record<string, VfxRefineProgress>>({})
  // Library view: effects, or the custom texture library (TextureLab).
  const [view, setView] = usePersisted<'effects' | 'textures' | 'priorities'>('vfx.view', 'effects')
  // Video reference import review (a dropped / picked clip), and the reference pinned to Make.
  const [refImport, setRefImport] = useState<{ file: File | null } | null>(null)
  const [pin, setPin] = useState<{ id: string; name: string } | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, list, rec] = await Promise.all([h.vfxStatus(), h.vfxList(), h.vfxRecipes()])
      setStatus(s)
      setEntries(list)
      setRecipes(rec)
    } catch (e) {
      actions.toast({ text: 'Could not load the VFX library', detail: errorText(e), kind: 'err' })
    }
  }, [actions])

  useEffect(() => {
    void load()
  }, [state.project?.root])
  useEffect(() => {
    const off1 = h.on('vfx:changed', () => void load())
    const off2 = h.on('vfx:progress', (p) => {
      setProgress((m) => ({ ...m, [p.entryId]: p }))
      if (p.phase === 'error') actions.toast({ text: 'Refine stopped', detail: p.message, kind: 'err' })
      if (p.phase === 'done') actions.toast({ text: `Refine finished${p.score != null ? ` · ${p.score.toFixed(1)}/10` : ''}`, detail: p.message, kind: 'ok', ms: 3500 })
    })
    return () => (off1(), off2())
  }, [load])

  const allTags = useMemo(() => {
    const count = new Map<string, number>()
    for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 18)
  }, [entries])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((e) => (!tag || e.tags.includes(tag)) && words.every((w) => `${e.name} ${e.description} ${e.tags.join(' ')}`.toLowerCase().includes(w)))
  }, [entries, query, tag])

  const current = entries.find((e) => e.id === selected) ?? null

  const importPaths = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(`importing ${paths.length} item${paths.length === 1 ? '' : 's'}…`)
    try {
      const r = await h.vfxImport(paths, scope)
      await load()
      if (r.added[0]) setSelected(r.added[0].id)
      actions.toast({
        text: `Imported ${r.added.length} effect${r.added.length === 1 ? '' : 's'}`,
        detail: [r.skipped.length ? `Skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `${s.file.split(/[\\/]/).pop()} (${s.reason})`).join('; ')}` : '', ...(r.notes ?? []).slice(0, 2).map((n) => `${n.file.split(/[\\/]/).pop()}: ${n.notes.join(' ')}`)].filter(Boolean).join('\n') || undefined,
        kind: r.added.length ? 'ok' : 'info'
      })
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    // Clips and GIFs open the video reference review; models and images import as before.
    const files = [...e.dataTransfer.files]
    const clip = files.find(isRefFile)
    if (clip) setRefImport({ file: clip })
    const paths = files.filter((f) => !isRefFile(f)).map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean)
    void importPaths(paths)
  }
  const learn = async () => {
    setBusy('learning recipes…')
    try {
      const r = await h.vfxLearn()
      setRecipes(r.recipes)
      actions.toast({ text: `${r.recipes.length} recipe${r.recipes.length === 1 ? '' : 's'} learned`, detail: r.saved.length ? `Saved to memory: ${r.saved.join(', ')}` : r.errors.join('; ') || undefined, kind: r.errors.length ? 'info' : 'ok' })
    } catch (e) {
      actions.toast({ text: 'Learning failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const restate = useRestateGate('vfx')
  const make = async () => {
    const what = prompt.trim()
    if (!what || making) return
    setMaking(true)
    try {
      if (mode === 'sequence' || pin) {
        // Restate first: the confirmed reading of the brief goes into compose (null = cancelled).
        const g = await restate.gate(what)
        if (!g) return
        const r = await h.vfxCompose(what, { maxIterations: iters, threshold, ...(pin ? { reference: pin.id } : {}), ...(g.restatement ? { restatement: g.restatement } : {}) })
        if (!r.ok || !r.entry) throw new Error(r.error ? `${r.error.line ? `line ${r.error.line}: ` : ''}${r.error.message}` : 'the timeline did not compile')
        await load()
        setSelected(r.entry.id)
        if (r.entry.modelNote) actions.toast({ text: `${r.entry.name}: drafted without a model`, detail: r.entry.modelNote, kind: 'err', ms: 12_000 })
        if (r.warnings.length) actions.toast({ text: `${r.entry.name}: ${r.warnings.length} timeline warning${r.warnings.length === 1 ? '' : 's'}`, detail: r.warnings.slice(0, 2).join(' · '), kind: 'info', ms: 4000 })
      } else {
        const entry = await h.vfxMake(what, { maxIterations: iters, threshold })
        await load()
        setSelected(entry.id)
        if (entry.modelNote) actions.toast({ text: `${entry.name}: drafted without a model`, detail: entry.modelNote, kind: 'err', ms: 12_000 })
      }
      setPrompt('')
    } catch (e) {
      actions.toast({ text: 'Could not make the effect', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
    }
  }

  const addExample = async (key: string) => {
    try {
      const entry = await h.vfxAddExample(key)
      await load()
      setSelected(entry.id)
    } catch (e) {
      actions.toast({ text: 'Could not add the example', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <div className="page">
      <div className="page-inner vfx">
        <div className="page-head">
          <div>
            <h1>VFX Lab</h1>
            <div className="sub">
              {status ? `${status.entries.user} in your library · ${status.entries.project} in this project · ${status.recipes} recipes` : 'loading…'}
              {status && !status.projectRoot ? ' · open a project to write effects' : ''}
            </div>
          </div>
          <div className="actions">
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as VfxScope)} aria-label="Import into" title="Where imports go">
              <option value="user">your library</option>
              <option value="project" disabled={!status?.projectRoot}>
                this project
              </option>
            </select>
            <button className="btn" onClick={async () => void importPaths(await h.vfxChooseImport())}>
              <Icon name="upload" size={12} /> Import
            </button>
            <button className="btn" onClick={() => setRefImport({ file: null })} title="A clip or GIF to make something like it: trim, crop, analyse beats, palette, glow and motion">
              <Icon name="image" size={12} /> Video ref
            </button>
            <button className="btn" onClick={() => void learn()} disabled={!entries.length || !!busy} title="Turn the library into per-type recipes and save them as memory skills">
              <Icon name="memory" size={12} /> Learn
            </button>
          </div>
        </div>

        {status && (!status.lune.available || !status.vision) && (
          <div className="callout row">
            <Icon name="info" size={12} />
            <span className="grow note">
              {!status.lune.available && <>Lune not found: .rbxmx imports still work; .rbxm imports and timeline scripts (sequences) need Lune (Settings → Toolchain). </>}
              {!status.vision && <>No vision model: critiques use parameter heuristics only. </>}
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
            <input className="input grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="purple sword slash with sparks" aria-label="Effect to make" spellCheck />
            <span className="vfx-make-lead mono">effect</span>
            {pin && (
              <span className="badge-o hot vfx-make-pin" title="Pinned video reference: Make composes a sequence like it">
                like {pin.name}
                <button type="button" className="btn small ghost" onClick={() => setPin(null)} aria-label="Unpin the reference">
                  <Icon name="x" size={10} />
                </button>
              </span>
            )}
            <div className="seg vfx-mode" role="group" aria-label="Kind of effect">
              <button type="button" className={mode === 'single' ? 'on' : ''} aria-pressed={mode === 'single'} onClick={() => setMode('single')} title="One burst of layers (emitters, beams, lights)">
                single
              </button>
              <button type="button" className={mode === 'sequence' ? 'on' : ''} aria-pressed={mode === 'sequence'} onClick={() => setMode('sequence')} title="Multi-stage: a timeline script that spawns kit rigs and tweens them (anticipation, charge, release, impact, dissipate)">
                sequence
              </button>
            </div>
            <button className="btn primary" disabled={!prompt.trim() || making}>
              {making && !restate.waiting ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make
            </button>
          </form>
          {restate.node}
          <div className="vfx-make-opts">
            <label className="art-opt">
              <span>iterations</span>
              <div className="seg">
                {[1, 2, 4, 6].map((k) => (
                  <button type="button" key={k} className={iters === k ? 'on' : ''} onClick={() => setIters(k)} aria-pressed={iters === k}>
                    {k}
                  </button>
                ))}
              </div>
            </label>
            <label className="art-opt">
              <span>stop at</span>
              <input className="input vfx-thr mono" type="number" min={1} max={10} step={0.5} value={threshold} onChange={(e) => setThreshold(Math.min(10, Math.max(1, Number(e.target.value) || 7.5)))} aria-label="Score threshold" />
              <span className="faint">/10</span>
            </label>
            <span className="vfx-sugg">
              {(mode === 'sequence' ? SEQ_SUGGESTIONS : SUGGESTIONS).map((s) => (
                <button key={s} type="button" className="badge-o" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </span>
            <span className="vfx-examples">
              <span className="faint mono">examples</span>
              {EXAMPLES.map((x) => (
                <button key={x.key} type="button" className="badge-o" onClick={() => void addExample(x.key)} title="Add this built-in scripted example to the library and open it">
                  {x.label}
                </button>
              ))}
            </span>
          </div>
          <LabCostLine lab="vfx" />
        </section>

        <div className="seg vfx-view" role="tablist" aria-label="Library">
          <button role="tab" aria-selected={view === 'effects'} className={view === 'effects' ? 'on' : ''} onClick={() => setView('effects')}>
            effects
          </button>
          <button role="tab" aria-selected={view === 'textures'} className={view === 'textures' ? 'on' : ''} onClick={() => setView('textures')} title="Custom particle and beam textures: procedural (free) or AI, upload to Roblox">
            textures
          </button>
          <button role="tab" aria-selected={view === 'priorities'} className={view === 'priorities' ? 'on' : ''} onClick={() => setView('priorities')} title="Which VFX principles count most for you, learned from your ratings">
            priorities
          </button>
        </div>
        {view === 'textures' && <TextureLab />}
        {view === 'priorities' && <PrinciplePriorities domains={['vfx']} />}
        {view === 'effects' && (
          <div className={`vfx-body${current ? ' has-detail' : ''}`}>
            <div className="vfx-lib">
              <div
                className={`vfx-drop${drag ? ' drag' : ''}`}
                onDragOver={(e) => (e.preventDefault(), setDrag(true))}
                onDragLeave={() => setDrag(false)}
                onDrop={onDrop}
                role="button"
                tabIndex={0}
                onClick={async () => void importPaths(await h.vfxChooseImport())}
                onKeyDown={async (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void importPaths(await h.vfxChooseImport()))}
              >
                {busy ? (
                  <>
                    <span className="spinner" aria-hidden /> {busy}
                  </>
                ) : (
                  <>
                    <Icon name="download" size={13} /> Drop references here <span className="faint mono">{IMPORT_HINT}</span>
                  </>
                )}
              </div>
              <div className="row vfx-lib-head">
                <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, tag or description" aria-label="Search library" />
                <span className="note">{shown.length} shown</span>
              </div>
              {allTags.length > 0 && (
                <div className="vfx-chips" role="group" aria-label="Filter by tag">
                  {allTags.map(([t, n]) => (
                    <button key={t} className={`badge-o${tag === t ? ' hot' : ''}`} aria-pressed={tag === t} onClick={() => setTag(tag === t ? null : t)}>
                      {t} <span className="faint">{n}</span>
                    </button>
                  ))}
                </div>
              )}
              {!entries.length && status && (
                <div className="empty">
                  <Icon name="sparkle" size={22} className="i" />
                  The library is empty. Drop .rbxm/.rbxmx effect models (or a folder of them) above, add reference gifs and videos, or make an effect.
                </div>
              )}
              <div className="vfx-grid">
                {shown.map((e) =>
                  e.video ? (
                    <RefCard key={e.id} lab="vfx" entry={e} selected={e.id === selected} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
                  ) : (
                    <Card key={e.id} entry={e} selected={e.id === selected} progress={progress[e.id]} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
                  )
                )}
              </div>
            </div>
            {current &&
              (current.video ? (
                <RefDetail key={current.id} lab="vfx" entry={current} onClose={() => setSelected(null)} onMade={(id) => void load().then(() => setSelected(id))} onPin={(r) => (setPin(r), setMode('sequence'))} />
              ) : (
                <Detail key={current.id} entry={current} progress={progress[current.id]} recipes={recipes} onClose={() => setSelected(null)} />
              ))}
          </div>
        )}
        {refImport && (
          <RefImport
            lab="vfx"
            scope={scope}
            file={refImport.file}
            onClose={() => setRefImport(null)}
            onSaved={(r) => {
              setRefImport(null)
              setView('effects')
              void load().then(() => setSelected(r.id))
            }}
          />
        )}
      </div>
    </div>
  )
}
