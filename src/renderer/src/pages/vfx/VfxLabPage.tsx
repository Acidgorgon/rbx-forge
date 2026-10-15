// VFX Lab: a reference library of Roblox effects (imported .rbxm/.rbxmx, images, gifs, videos and
// generated effects), "Make a ___ effect" (draft -> render -> critique -> refine, in main), and a
// detail view with the live three.js preview, the parameter editor (writes back to the effect's
// Luau module and .rbxmx) and the iteration history side by side.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { usePersisted } from '../../qol/sessionStore'
import type { LiveStatus, VfxEffect, VfxEntry, VfxImportResult, VfxImportScan, VfxLabStatus, VfxRecipe, VfxRefineProgress, VfxScope, VfxStudioPack } from '@shared/types'
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
import { EffectImportReview, importProgressText, rowName, useImportProgress } from './EffectImport'
import { DuplicatesPanel, LiveControls, liveLine, matchesTagFilter, TagFilters, TagGroupEditor, type TagFilter } from './LibraryTools'
import { nameFromTags, tagGroupsOf } from '@shared/vfx/tags'
import { chooseRecipe, fitToPriors, priorFit } from '@shared/vfx/priors'
import { smallModelHint, type LabModels } from '@shared/labModels'

const IMPORT_HINT = '.rbxm · .rbxmx · .rbxl places · folders · png/jpg · video refs: mp4/webm/mov/gif'
// After a bulk import of more than this many effects the lab offers to learn from them.
const LEARN_OFFER_MIN = 10
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

function Card({ entry, selected, checked, selecting, progress, onSelect }: { entry: VfxEntry; selected: boolean; checked?: boolean; selecting?: boolean; progress?: VfxRefineProgress; onSelect: (e: React.MouseEvent) => void }) {
  const thumb = entry.thumbs[0] ?? (entry.kind === 'media' && entry.media?.[0]?.mime.startsWith('image') ? entry.media[0].file : undefined)
  const url = useEntryFile(entry.id, thumb, entry.updatedAt)
  const g = tagGroupsOf(entry)
  const shown = [...g.kind, ...g.element, ...g.custom, ...g.timing].slice(0, 4)
  return (
    <button className={`vfx-card${selected ? ' on' : ''}${checked ? ' checked' : ''}`} onClick={onSelect} aria-pressed={selecting ? !!checked : selected} title={`${entry.description || entry.name}${entry.sourceName && entry.sourceName !== entry.name ? `\nfrom: ${entry.sourceName}` : ''}`} data-testid="vfx-card">
      {selecting && <span className={`vfx-check${checked ? ' on' : ''}`} aria-hidden>{checked ? <Icon name="check" size={10} /> : null}</span>}
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
      {entry.sourceName && entry.sourceName !== entry.name && (
        <div className="vfx-from faint mono" title={`Original name: ${entry.sourceName}`} data-testid="vfx-card-from">
          from: {entry.sourceName}
        </div>
      )}
      <div className="vfx-tags">
        {shown.map((t) => (
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

// The entry's name: rename (the user's: bulk "Name from tags" leaves it), name it from its tags
// ("Lightning Impact"), or go back to its original name. Layers inside keep their names.
function EntryName({ entry }: { entry: VfxEntry }) {
  const { actions } = useStore()
  const [text, setText] = useState(entry.name)
  useEffect(() => setText(entry.name), [entry.id, entry.name])
  const tagName = nameFromTags(tagGroupsOf(entry), '')
  const rename = async (name: string) => {
    if (!name.trim() || name.trim() === entry.name) return setText(entry.name)
    try {
      await window.harness.vfxUpdate(entry.id, { name: name.trim() })
    } catch (e) {
      actions.toast({ text: 'Rename failed', detail: errorText(e), kind: 'err' })
    }
  }
  const fromTags = async () => {
    try {
      const r = await window.harness.vfxNameFromTags([entry.id], { force: true })
      if (!r.renamed.length) actions.toast({ text: r.noTags ? 'No kind, element or custom tag to name it by' : 'Already named from its tags', kind: 'info', ms: 2500 })
    } catch (e) {
      actions.toast({ text: 'Name from tags failed', detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <div className="vfx-name-edit">
      <input className="input" value={text} onChange={(e) => setText(e.target.value)} onBlur={() => void rename(text)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} aria-label="Effect name" data-testid="vfx-entry-name" />
      {entry.effect && (
        <button className="btn small ghost" disabled={!tagName} onClick={() => void fromTags()} title={tagName ? `Rename to “${tagName}” (from its tags; the original name stays searchable)` : 'No kind, element or custom tag to name it by'} data-testid="vfx-name-from-tags">
          Name from tags
        </button>
      )}
      {entry.sourceName && entry.sourceName !== entry.name && (
        <button className="btn small ghost" onClick={() => void rename(entry.sourceName!)} title="Back to its name in the file / in Studio">
          Use “{entry.sourceName}”
        </button>
      )}
      {entry.nameFrom && <span className="faint mono">{entry.nameFrom === 'tags' ? 'named from tags' : 'named by you'}</span>}
    </div>
  )
}

function Detail({ entry, entries, progress, recipes, live, onClose, onTrashed }: { entry: VfxEntry; entries: VfxEntry[]; progress?: VfxRefineProgress; recipes: VfxRecipe[]; live: LiveStatus | null; onClose: () => void; onTrashed: (batch: string, n: number) => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [tab, setTab] = useState<'params' | 'script' | 'iterations' | 'studio' | 'info'>(entry.effect ? (entry.effect.script ? 'script' : 'params') : 'info')
  const [draft, setDraft] = useState<VfxEffect | undefined>(entry.effect)
  const [saving, setSaving] = useState(false)
  const [comparing, setComparing] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingRef = useRef<VfxEffect | null>(null)
  // What each layer does, inferred from its properties (names in imported effects mean nothing).
  const roles = useMemo(() => (draft ? layerRoles(draft) : []), [draft])

  // A new entry, or a server-side update (refine wrote a better version) while no edit is pending.
  useEffect(() => {
    if (!pendingRef.current) setDraft(entry.effect)
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

  // Live in Studio / Loop: Studio gets the effect as it is here (edits included; main debounces).
  const liveOn = !!live && live.state !== 'off'
  useEffect(() => {
    if (liveOn && draft) void h.vfxLiveSet({ key: entry.id, effect: draft, label: entry.name }).catch(() => undefined)
  }, [liveOn, entry.id, draft])
  const looping = liveOn && live?.pinned === entry.id
  const loop = async () => {
    try {
      if (looping) await h.vfxLiveStop({ loop: true })
      else if (draft) await h.vfxLiveStart({ pin: entry.id, current: { key: entry.id, effect: draft, label: entry.name } })
    } catch (e) {
      actions.toast({ text: 'Loop in Studio failed', detail: errorText(e), kind: 'err' })
    }
  }

  const warnings = useMemo(() => (draft ? dedupeWarnings(perfWarnings(draft)) : []), [draft])
  const refining = !!progress && progress.phase !== 'done' && progress.phase !== 'error'
  const recipe = useMemo(() => chooseRecipe(recipes, entry.tags), [recipes, entry.tags.join('|')])
  // Generated effects against the learned ranges of the user's effects of this type (imported ones
  // are the references themselves).
  const fit = useMemo(() => (draft && entry.kind === 'generated' ? priorFit(draft, recipe) : null), [draft, recipe, entry.kind])
  const fitToLibrary = () => {
    if (!draft) return
    const r = fitToPriors(draft, recipe, { all: true })
    if (!r.applied.length) return
    edit(r.effect)
    actions.toast({ text: `${r.applied.length} value${r.applied.length === 1 ? '' : 's'} fitted to your ${recipe!.tag.replace('+', ' ')} effects`, kind: 'ok', ms: 2600 })
  }
  const nameOf = (id: string) => entries.find((e) => e.id === id)?.name ?? id

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
    try {
      const r = await h.vfxTrash([entry.id])
      onTrashed(r.batch, r.removed.length)
      onClose()
    } catch (e) {
      actions.toast({ text: 'Delete failed', detail: errorText(e), kind: 'err' })
    }
  }

  return (
    <section className="vfx-detail" aria-label={`${entry.name} details`}>
      <div className="vfx-detail-head">
        <Icon name="sparkle" size={13} />
        <b className="vfx-title">{entry.name}</b>
        {entry.sourceName && entry.sourceName !== entry.name && (
          <span className="faint mono vfx-title-from" title="Its name in the file / in Studio (searchable)" data-testid="vfx-detail-from">
            from: {entry.sourceName}
          </span>
        )}
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
          <button className={`btn small${looping ? ' on' : ''}`} aria-pressed={looping} onClick={() => void loop()} title={looping ? 'Stop the loop (removes what it spawned in Studio)' : 'Replay it in Studio every duration + gap until Stop or another effect is picked (Forge Bridge plugin; the camera stays where you put it)'} data-testid="vfx-loop">
            <Icon name={looping ? 'stop' : 'restart'} size={11} /> {looping ? 'Stop loop' : 'Loop'}
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

      {fit && fit.issues.length > 0 && (
        <div className="vfx-fit" data-testid="vfx-library-fit">
          <div className="row">
            <Icon name="memory" size={11} />
            <span className="grow note">
              {fit.issues.length} of {fit.checks} values outside your {recipe!.tag.replace('+', ' ')} effects ({recipe!.samples} learned)
            </span>
            <button className="btn small" onClick={fitToLibrary} title="Move these values to the middle of what your own effects of this type use">
              Fit to my library
            </button>
          </div>
          <ul>
            {fit.issues.slice(0, 4).map((i) => (
              <li key={`${i.node}|${i.prop}`} className={i.far ? 'far' : ''}>
                {i.message}
              </li>
            ))}
            {fit.issues.length > 4 && <li className="faint">and {fit.issues.length - 4} more</li>}
          </ul>
        </div>
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
            <dt>name</dt>
            <dd>
              <EntryName entry={entry} />
            </dd>
            <dt>tags</dt>
            <dd>
              <TagGroupEditor entry={entry} />
            </dd>
            <dt>origin</dt>
            <dd className="mono">{entry.origin}</dd>
            {(!!entry.basedOn?.length || !!entry.makeNotes?.length) && (
              <>
                <dt>made from</dt>
                <dd data-testid="vfx-made-from">
                  {entry.basedOn?.length ? entry.basedOn.map(nameOf).join(', ') : <span className="faint">no library effect</span>}
                  {!!entry.makeNotes?.length && (
                    <ul className="vfx-import-notes">
                      {entry.makeNotes.map((n) => (
                        <li key={n} className="note">
                          {n}
                        </li>
                      ))}
                    </ul>
                  )}
                </dd>
              </>
            )}
            {entry.pick && (
              <>
                <dt>variations</dt>
                <dd className="note">
                  kept {String.fromCharCode(65 + entry.pick.chosen)} of {entry.pick.of} ({entry.pick.by === 'critic' ? 'the critic' : 'the code checks'}: {entry.pick.why})
                  {entry.pick.scores && <span className="faint mono"> · {entry.pick.scores.map((x, i) => `${String.fromCharCode(65 + i)} ${x.toFixed(1)}`).join(' · ')}</span>}
                </dd>
              </>
            )}
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
                  <span className="mono">vfx-recipe-{recipe.tag.replace(/[^a-z0-9-]+/gi, '-')}</span> <span className="faint">· {recipe.samples} samples</span>
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
  const [tagFilter, setTagFilter] = useState<TagFilter>({})
  // Bulk import review (files or Studio), the learn offer after a big import, library selection.
  const [scan, setScan] = useState<VfxImportScan | null>(null)
  const [learnOffer, setLearnOffer] = useState<number | null>(null)
  const [selecting, setSelecting] = useState(false)
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [anchor, setAnchor] = useState<string | null>(null)
  const [showDups, setShowDups] = useState(false)
  const importProgress = useImportProgress()
  // Live in Studio (persisted toggle) and the loop state from main.
  const [liveOn, setLiveOn] = usePersisted<boolean>('vfx.live', false)
  const [live, setLive] = useState<LiveStatus | null>(null)
  const [scope, setScope] = useState<VfxScope>('user')
  const [prompt, setPrompt] = useState('')
  const [iters, setIters] = useState(4)
  // Variations per Make: the critic (or the library-fit checks) keeps one.
  const [variations, setVariations] = usePersisted<number>('vfx.variations', 3)
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
  // Settings > Labs: a small drafting model is called out next to Make (never switched silently).
  const [labModels, setLabModels] = useState<LabModels | null>(null)
  useEffect(() => {
    void h.getLabModels?.().then(setLabModels, () => setLabModels({}))
  }, [h])
  const smallHint = smallModelHint('default', labModels?.default || state.defaultModel?.model)

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
    const off3 = h.on('vfx:live', (st) => {
      setLive(st)
      if (st.error && st.state !== 'looping') actions.toast({ text: 'Live in Studio', detail: st.error, kind: 'err', ms: 5000 })
      // Forge gave up (Studio kept failing to start it): the toggle goes off with it.
      if (st.state === 'off' && st.error) setLiveOn(false)
    })
    return () => (off1(), off2(), off3())
  }, [load])
  // The header toggle starts / stops the live loop (a Loop on one entry stops with it too).
  useEffect(() => {
    void (liveOn ? h.vfxLiveStart({}) : h.vfxLiveStop({ follow: true }))
      .then(setLive)
      .catch(() => undefined)
  }, [liveOn])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((e) => matchesTagFilter(e, tagFilter) && words.every((w) => `${e.name} ${e.sourceName ?? ''} ${e.description} ${e.tags.join(' ')}`.toLowerCase().includes(w)))
  }, [entries, query, tagFilter])

  const current = entries.find((e) => e.id === selected) ?? null

  // Deleted entries go to the library trash until the next start: Undo for 10 s.
  const trashed = (batch: string, n: number) => {
    if (!n) return
    setChecked(new Set())
    actions.toast({
      text: `Deleted ${n} effect${n === 1 ? '' : 's'}`,
      kind: 'info',
      ms: 10_000,
      action: {
        label: 'Undo',
        run: () =>
          void h
            .vfxRestore(batch)
            .then((r) => actions.toast({ text: `Restored ${r.restored.length}`, kind: 'ok', ms: 2500 }))
            .catch((e) => actions.toast({ text: 'Undo failed', detail: errorText(e), kind: 'err' }))
      }
    })
  }
  const imported = async (r: VfxImportResult) => {
    setScan(null)
    await load()
    if (r.added[0]) setSelected(r.added[0].id)
    const models = r.added.filter((e) => e.kind === 'model').length
    actions.toast({
      text: `Imported ${r.added.length} effect${r.added.length === 1 ? '' : 's'}`,
      detail:
        [
          r.duplicates?.length ? `${r.duplicates.length} already in the library (skipped)` : '',
          r.meshes ? `meshes: ${r.meshes.loaded} of ${r.meshes.total} loaded` : '',
          r.skipped.length ? `Skipped ${r.skipped.length}: ${r.skipped.slice(0, 3).map((s) => `${s.file.split(/[\\/]/).pop()} (${s.reason})`).join('; ')}` : '',
          ...(r.notes ?? []).slice(0, 2).map((n) => `${n.file.split(/[\\/]/).pop()}: ${n.notes.join(' ')}`)
        ]
          .filter(Boolean)
          .join('\n') || undefined,
      kind: r.added.length ? 'ok' : 'info'
    })
    if (models > LEARN_OFFER_MIN) setLearnOffer(models)
  }
  // Files: scan first; one effect with nothing to decide imports at once, more open the review.
  const importPaths = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(`reading ${paths.length} item${paths.length === 1 ? '' : 's'}…`)
    try {
      const sc = await h.vfxImportScan(paths)
      const decide = sc.rows.length > 1 || sc.rows.some((r) => r.duplicates.some((d) => d.scope === scope) || r.sameAs)
      if (decide) setScan(sc)
      else if (sc.rows.length || sc.media.length) await imported(await h.vfxImportCommit({ scanId: sc.scanId, scope, rows: sc.rows.map((r) => ({ key: r.key, name: rowName(r, sc.nameFromTags !== false) })) }))
      else actions.toast({ text: 'Nothing to import', detail: sc.skipped.slice(0, 3).map((s) => `${s.file.split(/[\\/]/).pop()} (${s.reason})`).join('; ') || undefined, kind: 'info' })
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const fromStudio = async (packs?: VfxStudioPack[]) => {
    setBusy(packs ? 'reading the folders in Studio…' : 'reading the Studio selection…')
    try {
      const sc = await h.vfxStudioScan(packs ? { packs: packs.map((p) => p.path) } : {})
      if (!sc.rows.length && !sc.packs?.length) actions.toast({ text: 'Nothing to import from Studio', detail: sc.notes.join(' ') || undefined, kind: 'info' })
      else setScan(sc)
    } catch (e) {
      actions.toast({ text: 'Import from Studio failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const pick = (e: VfxEntry, ev: React.MouseEvent) => {
    if (selecting || ev.ctrlKey || ev.metaKey || ev.shiftKey) {
      setSelecting(true)
      const next = new Set(checked)
      if (ev.shiftKey && anchor) {
        const a = shown.findIndex((x) => x.id === anchor)
        const b = shown.findIndex((x) => x.id === e.id)
        if (a >= 0 && b >= 0) for (const x of shown.slice(Math.min(a, b), Math.max(a, b) + 1)) next.add(x.id)
      } else if (next.has(e.id)) next.delete(e.id)
      else next.add(e.id)
      setAnchor(e.id)
      setChecked(next)
      return
    }
    setSelected(e.id === selected ? null : e.id)
  }
  const deleteChecked = async () => {
    try {
      const r = await h.vfxTrash([...checked])
      if (selected && checked.has(selected)) setSelected(null)
      trashed(r.batch, r.removed.length)
      setSelecting(false)
    } catch (e) {
      actions.toast({ text: 'Delete failed', detail: errorText(e), kind: 'err' })
    }
  }
  const clearLibrary = async () => {
    const n = entries.filter((e) => e.scope === scope).length
    if (!n) return actions.toast({ text: `The ${scope === 'user' ? 'user' : 'project'} library is already empty`, kind: 'info' })
    if (!confirm(`Clear the ${scope === 'user' ? 'user' : 'project'} library? This moves all ${n} effect${n === 1 ? '' : 's'} to the trash (Undo for 10 s; emptied when Forge restarts).`)) return
    try {
      const r = await h.vfxClear(scope)
      setSelected(null)
      trashed(r.batch, r.removed.length)
    } catch (e) {
      actions.toast({ text: 'Clear failed', detail: errorText(e), kind: 'err' })
    }
  }
  const retag = async () => {
    setBusy('re-tagging…')
    try {
      const r = await h.vfxRetag()
      actions.toast({ text: `Re-tagged ${r.changed} of ${r.total}${r.renamed ? ` · ${r.renamed} renamed` : ''}`, detail: `Kind, element and timing come from names, layer roles and colours; tags you edited stay.${r.renamed ? ' Effects named from their tags follow the new tags.' : ''}`, kind: 'ok', ms: 4000 })
    } catch (e) {
      actions.toast({ text: 'Re-tag failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  // "Name from tags": the selected effects, or every imported model; names chosen on purpose
  // (renamed by you, made effects, examples) stay unless generic ("Particles").
  const nameChecked = async (ids: string[] | null) => {
    if (!ids && !confirm('Name every imported effect from its tags (e.g. “Particles” → “Lightning Impact”)? The original names stay searchable and shown as “from: …”; effects you renamed keep their names.')) return
    setBusy('naming from tags…')
    try {
      const r = await h.vfxNameFromTags(ids)
      const detail = [r.kept ? `${r.kept} named on purpose kept` : '', r.unchanged ? `${r.unchanged} already named so` : '', r.noTags ? `${r.noTags} with no kind / element / custom tag` : ''].filter(Boolean).join(' · ')
      actions.toast({ text: `Renamed ${r.renamed.length} of ${r.total} from their tags`, detail: detail || undefined, kind: r.renamed.length ? 'ok' : 'info', ms: 4000 })
    } catch (e) {
      actions.toast({ text: 'Name from tags failed', detail: errorText(e), kind: 'err' })
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
    setLearnOffer(null)
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
        const r = await h.vfxCompose(what, { maxIterations: iters, threshold, variations, ...(pin ? { reference: pin.id } : {}), ...(g.restatement ? { restatement: g.restatement } : {}) })
        if (!r.ok || !r.entry) throw new Error(r.error ? `${r.error.line ? `line ${r.error.line}: ` : ''}${r.error.message}` : 'the timeline did not compile')
        await load()
        setSelected(r.entry.id)
        if (r.entry.modelNote) actions.toast({ text: `${r.entry.name}: drafted without a model`, detail: r.entry.modelNote, kind: 'err', ms: 12_000 })
        if (r.warnings.length) actions.toast({ text: `${r.entry.name}: ${r.warnings.length} timeline warning${r.warnings.length === 1 ? '' : 's'}`, detail: r.warnings.slice(0, 2).join(' · '), kind: 'info', ms: 4000 })
      } else {
        const entry = await h.vfxMake(what, { maxIterations: iters, threshold, variations })
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
            <LiveControls live={live} enabled={liveOn} onToggle={setLiveOn} onSettings={(st) => void h.vfxLiveSettings(st).then(setLive)} />
          </div>
        </div>
        {liveLine(live) && (
          <div className="callout row vfx-live-line" role="status" data-testid="vfx-live-line">
            <span className={`vfx-live-dot ${live!.state}`} aria-hidden />
            <span className="grow note">{liveLine(live)}</span>
            <button className="btn small" onClick={() => (setLiveOn(false), void h.vfxLiveStop().then(setLive))}>
              <Icon name="stop" size={11} /> Stop
            </button>
          </div>
        )}
        {learnOffer && (
          <div className="callout row" role="status" data-testid="vfx-learn-offer">
            <Icon name="memory" size={12} />
            <span className="grow note">Imported {learnOffer} effects. Learn recipes (per kind, and per kind + element) from them now?</span>
            <button className="btn small primary" onClick={() => void learn()} disabled={!!busy}>
              Learn from these now
            </button>
            <button className="btn small ghost" onClick={() => setLearnOffer(null)} aria-label="Not now">
              <Icon name="x" size={11} />
            </button>
          </div>
        )}

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
              <button type="button" className={mode === 'sequence' ? 'on' : ''} aria-pressed={mode === 'sequence'} onClick={() => setMode('sequence')} title="Multi-stage: a timeline script (anticipation, charge, release, impact, dissipate) built around a copy of your closest library effect; kit rigs when nothing in the library is close">
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
            <label className="art-opt" title="Make this many versions and keep the best (the critic looks at frames of each; without a critic model the library-fit checks pick)">
              <span>variations</span>
              <div className="seg" data-testid="vfx-variations">
                {[1, 3].map((k) => (
                  <button type="button" key={k} className={variations === k ? 'on' : ''} onClick={() => setVariations(k)} aria-pressed={variations === k}>
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
          {smallHint && (
            <p className="note warn vfx-small-model" role="note" data-testid="vfx-small-model">
              {smallHint} (Settings &gt; Labs)
            </p>
          )}
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
                    <span className="spinner" aria-hidden /> {importProgressText(importProgress) ?? busy}
                  </>
                ) : (
                  <>
                    <Icon name="download" size={13} /> Drop references here <span className="faint mono">{IMPORT_HINT}</span>
                  </>
                )}
              </div>
              <div className="tex-imp-bar vfx-lib-bar">
                <button className="btn small" disabled={!!busy} onClick={() => void fromStudio()} title={status?.studio ? 'Import the effects selected in Roblox Studio (nothing selected: pick a VFX folder). Read-only.' : 'Open the place in Roblox Studio with the Forge Bridge plugin on (Studio tab)'} data-testid="vfx-import-studio">
                  <Icon name="studio" size={11} /> Import from Studio
                </button>
                <span className="grow" />
                {selecting ? (
                  <>
                    <span className="note mono">{checked.size} selected</span>
                    <button className="btn small ghost" onClick={() => setChecked(new Set(shown.map((e) => e.id)))}>
                      all shown
                    </button>
                    <button className="btn small" disabled={!checked.size || !!busy} onClick={() => void nameChecked([...checked])} title="Rename the selected effects from their tags (element + kind, e.g. Lightning Impact); the original names stay searchable" data-testid="vfx-name-selected">
                      Name from tags
                    </button>
                    <button className="btn small danger" disabled={!checked.size} onClick={() => void deleteChecked()} data-testid="vfx-delete-selected">
                      <Icon name="trash" size={11} /> Delete selected
                    </button>
                    <button className="btn small ghost" onClick={() => (setSelecting(false), setChecked(new Set()))}>
                      Done
                    </button>
                  </>
                ) : (
                  <>
                    <button className="btn small ghost" disabled={!entries.length} onClick={() => setSelecting(true)} title="Select effects (or Ctrl / Shift-click cards) to delete several at once">
                      Select
                    </button>
                    <button className="btn small ghost" disabled={!entries.length} onClick={() => setShowDups(true)} title="Effects imported more than once (same content)">
                      Find duplicates
                    </button>
                    <button className="btn small ghost" disabled={!entries.length || !!busy} onClick={() => void retag()} title="Recompute kind / element / timing tags from names, layer roles and colours (your edits stay)">
                      Re-tag library
                    </button>
                    <button className="btn small ghost" disabled={!entries.some((e) => e.kind === 'model') || !!busy} onClick={() => void nameChecked(null)} title="Rename every imported effect from its tags (e.g. Particles → Lightning Impact); the original names stay searchable, names you chose stay" data-testid="vfx-name-all">
                      Name from tags…
                    </button>
                    <button className="btn small ghost danger" disabled={!entries.length} onClick={() => void clearLibrary()} title="Move every effect of the library chosen above (your library / this project) to the trash">
                      Clear library…
                    </button>
                  </>
                )}
              </div>
              {scan && <EffectImportReview scan={scan} scope={scope} projectOpen={!!status?.projectRoot} onClose={() => setScan(null)} onDone={(r) => void imported(r)} onRescan={(packs) => void fromStudio(packs)} />}
              {showDups && <DuplicatesPanel onClose={() => setShowDups(false)} onRemoved={(batch, n) => (setShowDups(false), trashed(batch, n))} />}
              <div className="row vfx-lib-head">
                <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, tag or description" aria-label="Search library" />
                <span className="note">{shown.length} shown</span>
              </div>
              <TagFilters entries={entries} filter={tagFilter} onChange={setTagFilter} />
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
                    <Card key={e.id} entry={e} selected={e.id === selected} selecting={selecting} checked={checked.has(e.id)} progress={progress[e.id]} onSelect={(ev) => pick(e, ev)} />
                  )
                )}
              </div>
            </div>
            {current &&
              (current.video ? (
                <RefDetail key={current.id} lab="vfx" entry={current} onClose={() => setSelected(null)} onMade={(id) => void load().then(() => setSelected(id))} onPin={(r) => (setPin(r), setMode('sequence'))} />
              ) : (
                <Detail key={current.id} entry={current} entries={entries} progress={progress[current.id]} recipes={recipes} live={live} onClose={() => setSelected(null)} onTrashed={trashed} />
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
