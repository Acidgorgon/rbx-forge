// Animation Lab: a library of R15 and R6 clips (imported KeyframeSequences and BVH, built-in examples and
// generated clips) with tags, ratings, notes and "avoid" examples; the learned style profiles and the
// library coverage; "Animate a ___" (script draft -> keys -> checks -> render / critique / refine, in
// main); and a detail view with the live preview, timeline, Script tab, checks and iterations. The
// header's R15 / R6 switch sets the project rig new clips use; a clip converts between rigs in its detail.
// The move set picker (Combat / Football / Movement & emotes, plus the project's own move types) sets
// which tags the tagger, coverage, suggestions and drafts use; "Re-tag library" applies a new set.
// The Animate row makes clips "From scratch" (the model writes keys) or "Remix closest" (the closest
// library clip edited with planned ops, shared/anim/remix.ts); a remixed clip's ops are editable in
// its Remix tab and re-apply to the base clip.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { usePersisted } from '../../qol/sessionStore'
import type { AnimClip, AnimCoverage, AnimEntry, AnimImportPreview, AnimLabStatus, AnimRefineProgress, AnimScope, AnimStyle, AnimStyleProfile, LearnedPose, R15Joint, RigType } from '@shared/types'
import type { AnimMoveSets, AnimRemixMode, RemixCandidate } from '@shared/animTypes'
import { describeRemixOp, REMIX_OPS, REMIX_PARAMS, REMIX_PART_LABEL, REMIX_PARTS, type RemixOp, type RemixOpKind, type RemixPart } from '@shared/anim/remix'
import { MOVE_SETS, thinLabels, type ResolvedMoveSet } from '@shared/anim/movesets'
import { missingParts } from '@shared/anim/bodyparts'
import { ANIM_RUBRIC_KEYS } from '@shared/anim/model'
import { convertClip, RIG_CONVERT_WARNING } from '@shared/anim/convert'
import { clipRig } from '@shared/anim/sample'
import { MOVE_TAGS } from '@shared/anim/style'
import { qeulerDeg, xfToCf } from '@shared/anim/math'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { AnimPreview } from './AnimPreview'
import { AnimScriptPanel } from './AnimScriptPanel'
import { figureDataUrl } from './figure'
import { StudioCheckButton, StudioCheckPanel } from '../studio/StudioCheck'
import { RefCard, RefCompare, RefDetail } from '../videoref/RefViews'
import { RefImport } from '../videoref/RefImport'
import { isRefFile } from '../videoref/decode'
import { PrinciplePriorities, PrincipleScorecard, usePrincipleWeights } from '../principles/Principles'
import { principleLabel } from '@shared/principles/catalog'
import '../vfx/vfx.css'
import { AnimCompare, CompareButton } from '../compare/LabCompare'
import './anim.css'
import { LabCostLine, LabDecisions } from '../gating/LabGating'
import { useRestateGate } from '../../components/useRestateGate'
import { RestatedBrief } from '../../components/RestateCard'
import { AddToGameButton } from '../qolc/AddToGame'

const IMPORT_HINT = '.rbxm · .rbxmx (KeyframeSequence) · .bvh (mocap; FBX: export BVH from Blender) · folders · video refs: mp4/webm/mov/gif'
const EXAMPLES = [
  { key: 'sign-push', label: 'Sign → palm push' },
  { key: 'dash-punch', label: 'Dash punch' },
  { key: 'hit-reaction', label: 'Hit reaction' }
]
const KNOWN_TAGS = Object.keys(MOVE_TAGS)
// Tag suggestions: the active move set's tags first (AnimLabPage provides them).
const TagsContext = createContext<string[]>(KNOWN_TAGS)

// Best iteration: fewer failed requirements (a named body part that stopped moving) first, then the score.
function bestOf<T extends { critique?: AnimIteration['critique'] }>(its: T[]): T {
  const fails = (it: T) => missingParts(it.critique?.checks?.motion).length
  return its.reduce((a, b) => (fails(b) !== fails(a) ? (fails(b) < fails(a) ? b : a) : (b.critique?.overall ?? 0) > (a.critique?.overall ?? 0) ? b : a), its[0])
}
type AnimIteration = NonNullable<AnimEntry['iterations']>[number]

const bad = (e: AnimEntry) => e.quality === 'avoid' || e.rating === 'down'

function peakTime(clip: AnimClip): number {
  const b = clip.beats?.find((x) => /release|strike|action|hit|impact|extend|sign|kick/i.test(x.label))
  if (b) return Math.min(clip.duration, b.at + 0.06)
  const m = clip.markers.find((x) => x.t > 0)
  return m ? m.t : clip.duration * (clip.looped ? 0.5 : 0.45)
}

const thumbCache = new Map<string, string>()
function thumbOf(e: AnimEntry): string {
  const key = `${e.id}@${e.updatedAt}`
  let u = thumbCache.get(key)
  if (!u) {
    u = figureDataUrl(e.clip, peakTime(e.clip), { width: 200, height: 150 })
    thumbCache.set(key, u)
  }
  return u
}

const fileCache = new Map<string, string | null>()
function useEntryFile(id: string, file: string | undefined): string | null {
  const key = file ? `${id}/${file}` : ''
  const [url, setUrl] = useState<string | null>(key ? (fileCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!file) return setUrl(null)
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null)
    let live = true
    window.harness
      .animFile(id, file)
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

const qualityTag = (e: AnimEntry) =>
  bad(e) ? <span className="tag err">avoid</span> : e.quality === 'good' || e.rating === 'up' ? <span className="tag ok">liked</span> : e.quality === 'reference' ? <span className="tag info">ref</span> : null

// Editable tag pills: click × to drop one, type + Enter (or comma) to add, suggestions below.
export function TagPills({ tags, onChange, suggest: given, label = 'Tags' }: { tags: string[]; onChange: (tags: string[]) => void; suggest?: string[]; label?: string }) {
  const known = useContext(TagsContext)
  const suggest = given ?? known
  const [text, setText] = useState('')
  const add = (raw: string) => {
    const t = raw.toLowerCase().trim().replace(/[^a-z0-9 -]/g, '')
    if (t && !tags.includes(t)) onChange([...tags, t])
    setText('')
  }
  const rest = suggest.filter((s) => !tags.includes(s)).slice(0, 8)
  return (
    <div className="anim-pills" role="group" aria-label={label}>
      {tags.map((t) => (
        <span key={t} className="anim-pill">
          {t}
          <button type="button" onClick={() => onChange(tags.filter((x) => x !== t))} aria-label={`Remove tag ${t}`}>
            ×
          </button>
        </span>
      ))}
      <input
        className="anim-pill-in mono"
        value={text}
        placeholder="+ tag"
        aria-label={`Add to ${label.toLowerCase()}`}
        onChange={(e) => (e.target.value.endsWith(',') ? add(e.target.value.slice(0, -1)) : setText(e.target.value))}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            add(text)
          } else if (e.key === 'Backspace' && !text && tags.length) onChange(tags.slice(0, -1))
        }}
        list="anim-tag-list"
      />
      {rest.length > 0 && (
        <span className="anim-pill-sugg">
          {rest.slice(0, 5).map((s) => (
            <button key={s} type="button" className="anim-pill-add" onClick={() => add(s)}>
              +{s}
            </button>
          ))}
        </span>
      )}
    </div>
  )
}

function Card({ entry, selected, progress, onSelect }: { entry: AnimEntry; selected: boolean; progress?: AnimRefineProgress; onSelect: () => void }) {
  return (
    <button className={`vfx-card anim-card${selected ? ' on' : ''}${bad(entry) ? ' avoid' : ''}`} onClick={onSelect} aria-pressed={selected} title={entry.description || entry.name}>
      <div className="vfx-thumb anim-thumb">
        <img src={thumbOf(entry)} alt="" draggable={false} />
        <span className="anim-dur mono">
          {entry.clip.duration.toFixed(2)}s{entry.clip.looped ? ' ⟳' : ''}
        </span>
        {progress && progress.phase !== 'done' && progress.phase !== 'error' && (
          <span className="vfx-thumb-busy mono">
            <span className="spinner" aria-hidden /> {progress.phase} {progress.iteration}
          </span>
        )}
      </div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {qualityTag(entry)}
        <span className="faint mono">
          {entry.remix ? 'remix' : entry.kind === 'generated' ? 'made' : entry.clip.source === 'bvh' ? 'bvh' : 'rbxm'}
          {clipRig(entry.clip) === 'R6' ? <span className="anim-rig-b">R6</span> : null}
        </span>
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

// The active set's move types: built-ins as plain chips, custom ones removable, plus an input to add one.
function MoveTypes({ set, onAdd, onRemove }: { set: ResolvedMoveSet; onAdd: (tag: string, description: string) => Promise<boolean>; onRemove: (tag: string) => void }) {
  const [tag, setTag] = useState('')
  const [desc, setDesc] = useState('')
  const add = async () => {
    if (!tag.trim()) return
    if (await onAdd(tag, desc)) (setTag(''), setDesc(''))
  }
  return (
    <div className="anim-types">
      <span className="faint mono">{set.name.toLowerCase()} move types</span>
      <span className="anim-types-list">
        {set.tags.map((t) =>
          t.custom ? (
            <span key={t.tag} className="anim-pill" title={t.description}>
              {t.tag}
              <button type="button" onClick={() => onRemove(t.tag)} aria-label={`Remove move type ${t.tag}`}>
                ×
              </button>
            </span>
          ) : (
            <span key={t.tag} className="vfx-tag" title={t.description}>
              {t.tag}
            </span>
          )
        )}
      </span>
      <form
        className="row anim-types-add"
        onSubmit={(e) => {
          e.preventDefault()
          void add()
        }}
      >
        <input className="input mono" value={tag} onChange={(e) => setTag(e.target.value)} placeholder="+ move type" aria-label="New move type" maxLength={24} />
        <input className="input grow" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="what it is (the tagger, drafter and critic read this)" aria-label="Move type description" maxLength={200} />
        <button className="btn small" disabled={!tag.trim()}>
          Add
        </button>
      </form>
    </div>
  )
}

function Coverage({ coverage, onTag, set, onRetag, retagging, onAddType, onRemoveType }: { coverage: AnimCoverage | null; onTag: (t: string) => void; set: ResolvedMoveSet | null; onRetag: () => void; retagging: boolean; onAddType: (tag: string, description: string) => Promise<boolean>; onRemoveType: (tag: string) => void }) {
  if (!coverage) return null
  const rows = coverage.tags.filter((r) => r.clips || r.disliked || coverage.thin.includes(r.tag)).slice(0, 12)
  const max = Math.max(1, ...rows.map((r) => r.clips + r.disliked))
  const labels = set ? thinLabels(coverage.thin, set) : coverage.thin.map((t) => `${t} clips`)
  return (
    <details className="anim-cov" open>
      <summary>
        <span className="mono">coverage</span>
        {set && <span className="faint"> · {set.name}</span>}
        {coverage.thin.length > 0 && <span className="faint"> · thin: {coverage.thin.join(', ')}</span>}
      </summary>
      <div className="anim-cov-rows">
        {rows.map((r) => (
          <button key={r.tag} className={`anim-cov-row${coverage.thin.includes(r.tag) ? ' thin' : ''}`} onClick={() => onTag(r.tag)} title={`${r.clips} usable clip(s), ${r.liked} liked, ${r.disliked} marked avoid`}>
            <span className="mono anim-cov-tag">{r.tag}</span>
            <span className="anim-cov-bar" aria-hidden>
              <i className="ok" style={{ width: `${(r.liked / max) * 100}%` }} />
              <i style={{ width: `${(Math.max(0, r.clips - r.liked) / max) * 100}%` }} />
              <i className="bad" style={{ width: `${(r.disliked / max) * 100}%` }} />
            </span>
            <span className="mono anim-cov-n">
              {r.clips}
              {r.liked ? <span className="ok-t"> ▲{r.liked}</span> : null}
              {r.disliked ? <span className="err-t"> ▼{r.disliked}</span> : null}
            </span>
          </button>
        ))}
      </div>
      {coverage.thin.length > 0 && (
        <p className="note anim-cov-hint">
          Feed it next: {labels.slice(0, 4).join(', ')}. Three or more good references per move type give a stable style profile; mark bad ones as avoid so the critic knows what not to do.
        </p>
      )}
      {set && (
        <>
          <div className="row anim-cov-retag">
            <span className="note grow">Tags look wrong for this set? Re-tagging reads names, files and notes (and the cheap model when one is set up); clips nothing matches keep their tags.</span>
            <button className="btn small" onClick={onRetag} disabled={retagging} title={`Re-run auto-tagging on the whole library with the ${set.name} move types`}>
              {retagging ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Re-tag library with {set.name}
            </button>
          </div>
          <MoveTypes set={set} onAdd={onAddType} onRemove={onRemoveType} />
        </>
      )}
    </details>
  )
}

function poseClip(p: LearnedPose): AnimClip {
  const tracks: AnimClip['tracks'] = {}
  for (const [j, e] of Object.entries(p.joints) as [R15Joint, [number, number, number]][]) tracks[j] = [{ t: 0, cf: xfToCf({ p: [0, 0, 0], q: qeulerDeg(e) }) }]
  if (p.root) tracks.Root = [{ t: 0, cf: xfToCf({ p: [0, 0, 0], q: qeulerDeg(p.root) }) }]
  const clip: AnimClip = { name: p.id, duration: 0.1, looped: false, priority: 'Action', tracks, markers: [] }
  // R6 learned poses (ids "r6-...") are measured on the R15 view: draw them on the R6 dummy.
  return p.id.startsWith('r6-') ? convertClip(clip, 'R6') : clip
}

function Pct({ label, p, max }: { label: string; p: { p10: number; median: number; p90: number }; max: number }) {
  const x = (v: number) => `${Math.min(100, (v / max) * 100)}%`
  return (
    <div className="anim-pct" title={`${label}: p10 ${p.p10.toFixed(2)} s · median ${p.median.toFixed(2)} s · p90 ${p.p90.toFixed(2)} s`}>
      <span>{label}</span>
      <span className="anim-pct-bar">
        <i style={{ left: x(p.p10), width: `calc(${x(p.p90)} - ${x(p.p10)})` }} />
        <b style={{ left: x(p.median) }} />
      </span>
      <em className="mono">{p.median.toFixed(2)}s</em>
    </div>
  )
}

function ProfileCard({ p }: { p: AnimStyleProfile }) {
  const max = Math.max(0.6, p.timing.anticipation.p90, p.timing.action.p90, p.timing.recovery.p90, p.timing.holds.p90)
  return (
    <article className="anim-prof">
      <header>
        <b className="mono">{p.tag === '*' ? 'all moves' : p.tag}</b>
        <span className="faint">
          {p.samples} clip{p.samples === 1 ? '' : 's'}
          {p.liked ? ` · ${p.liked} liked` : ''}
        </span>
        <span className="grow" />
        {p.rig === 'R6' && <span className="anim-rig-b">R6</span>}
        <span className="mono faint">anim-style-{p.rig === 'R6' ? 'r6-' : ''}{p.tag === '*' ? 'overall' : p.tag}</span>
      </header>
      {p.samples > 0 && (
        <>
          <div className="anim-pcts">
            <Pct label="anticipation" p={p.timing.anticipation} max={max} />
            <Pct label="action" p={p.timing.action} max={max} />
            <Pct label="recovery" p={p.timing.recovery} max={max} />
            <Pct label="holds" p={p.timing.holds} max={max} />
          </div>
          <div className="anim-prof-nums mono">
            overshoot {Math.round(p.overshoot.median * 100)}% · spread {p.spread.median.toFixed(2)}× · {p.keyRate.median.toFixed(1)} keys/s
            {p.easing[0] ? ` · ${p.easing.slice(0, 2).map((e) => `${e.style} ${Math.round(e.share * 100)}%`).join(', ')}` : ''}
          </div>
          {p.poses.length > 0 && (
            <div className="anim-poses" aria-label="Learned pose vocabulary">
              {p.poses.slice(0, 6).map((x) => (
                <figure key={x.id} title={`a:pose("learned:${x.id}") · phase ${x.phase} · ${x.count} keys`}>
                  <img src={figureDataUrl(poseClip(x), 0, { width: 84, height: 84, travel: false })} alt={`Learned pose ${x.id}`} />
                  <figcaption className="mono">{x.id}</figcaption>
                </figure>
              ))}
            </div>
          )}
          {p.notes.length > 0 && (
            <ul className="anim-notes">
              {p.notes.map((n, i) => (
                <li key={i}>{n}</li>
              ))}
            </ul>
          )}
        </>
      )}
      {p.avoid.length > 0 && (
        <div className="anim-avoid">
          <span className="tag err">avoid</span> {p.avoid.join(' · ')}
        </div>
      )}
    </article>
  )
}

function StyleView({ style, onLearn, busy }: { style: AnimStyle | null; onLearn: () => void; busy: boolean }) {
  const profiles = [...(style?.profiles ?? []), ...(style?.overall ? [style.overall] : []), ...(style?.r6?.profiles ?? []), ...(style?.r6?.overall ? [style.r6.overall] : [])]
  return (
    <div className="anim-style">
      <div className="row anim-style-head">
        <span className="note grow">
          Measured from your library (no model): timing per beat, easing, overshoot, silhouette and a pose vocabulary per move type. Liked clips count double; avoid clips only add "avoid" notes. Saved as memory skills on Learn.
        </span>
        <button className="btn small" onClick={onLearn} disabled={busy}>
          <Icon name="memory" size={11} /> Learn
        </button>
      </div>
      {!profiles.length && <div className="empty">No profiles yet. Import reference clips (or add the examples), then Learn.</div>}
      {profiles.map((p) => (
        <ProfileCard key={`${p.rig ?? 'R15'}-${p.tag}`} p={p} />
      ))}
    </div>
  )
}

function Frame({ id, file }: { id: string; file: string }) {
  const url = useEntryFile(id, file)
  return <div className="vfx-frame anim-frame">{url ? <img src={url} alt={file} loading="lazy" draggable={false} /> : <span className="vfx-frame-ph" />}</div>
}

function Iterations({ entry, onRestore }: { entry: AnimEntry; onRestore: (clip: AnimClip, n: number) => void }) {
  const its = entry.iterations ?? []
  const weights = usePrincipleWeights()
  if (!its.length) return <div className="empty">No iterations yet. Refine renders the key beats, critiques them against your style and the checks, applies the changes and keeps each step here.</div>
  const best = bestOf(its)
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
          {it.frames.length > 0 ? (
            <div className="vfx-frames">
              {it.frames.slice(0, 4).map((f) => (
                <Frame key={f} id={entry.id} file={f} />
              ))}
            </div>
          ) : (
            <div className="vfx-frames">
              {it.times.slice(0, 4).map((t) => (
                <div key={t} className="vfx-frame anim-frame">
                  <img src={figureDataUrl(it.clip, t, { width: 160, height: 120 })} alt={`t=${t}`} />
                </div>
              ))}
            </div>
          )}
          {it.critique && (
            <>
              <div className="vfx-rubric">
                {ANIM_RUBRIC_KEYS.map((k) => (
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
              {it.critique.mustFix?.length ? (
                <ul className="vfx-warn">
                  {it.critique.mustFix.map((m, i) => (
                    <li key={i} className="error">
                      <Icon name="warn" size={11} /> Must fix: {m}
                    </li>
                  ))}
                </ul>
              ) : null}
              <p className="vfx-iter-sum">{it.critique.summary.replace(/^Must fix:[^]*?\.\s/, '')}</p>
              {it.critique.changes.length > 0 && (
                <details className="vfx-changes">
                  <summary>
                    {it.critique.changes.length} change{it.critique.changes.length === 1 ? '' : 's'} for next
                  </summary>
                  <ul>
                    {it.critique.changes.map((c, i) => (
                      <li key={i}>
                        <span className="mono">{c.kind === 'offset' ? `${c.joint} @${c.at.toFixed(2)}` : c.kind === 'retime' ? `retime ${c.from.toFixed(2)}–${c.to.toFixed(2)} ×${c.scale}` : c.kind === 'ease' ? `ease ${c.style} @${c.at.toFixed(2)}` : `fix ${c.check}`}</span> {c.principle && <span className="pr-chg mono">{principleLabel(c.principle)}</span>} {c.why ?? ''}
                      </li>
                    ))}
                  </ul>
                </details>
              )}
            </>
          )}
          <button className="btn small ghost" onClick={() => onRestore(it.clip, it.n)}>
            <Icon name="undo" size={11} /> Use #{it.n}
          </button>
        </article>
      ))}
    </div>
  )
}

function Checks({ entry }: { entry: AnimEntry }) {
  const [report, setReport] = useState<Awaited<ReturnType<typeof window.harness.animChecks>> | null>(null)
  useEffect(() => {
    let live = true
    void window.harness
      .animChecks(entry.id)
      .then((r) => live && setReport(r))
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [entry.id, entry.updatedAt])
  if (!report) return <div className="empty">Checking…</div>
  return (
    <div className="anim-checks">
      <div className="vfx-rubric anim-check-bars">
        {Object.entries(report.scores).map(([k, v]) => (
          <div key={k} className="vfx-rub">
            <span>{k}</span>
            <span className="vfx-bar">
              <i style={{ width: `${v * 10}%` }} className={v < 5 ? 'low' : ''} />
            </span>
            <b>{v.toFixed(1)}</b>
          </div>
        ))}
      </div>
      <p className="mono note">
        overall {report.overall}/10 · slide {report.slideStuds.toFixed(2)} studs · worst limit {report.worstLimitDeg.toFixed(0)}° · overlap {report.penetrationStuds.toFixed(2)} studs · spread {report.spread.toFixed(2)}×
      </p>
      {report.issues.length ? (
        <ul className="vfx-warn">
          {report.issues.map((i, n) => (
            <li key={n} className={i.severity === 'error' ? 'error' : i.severity}>
              <Icon name={i.severity === 'info' ? 'info' : 'warn'} size={11} /> {i.at !== undefined ? <span className="mono">{i.at.toFixed(2)}s</span> : null} {i.message}
            </li>
          ))}
        </ul>
      ) : (
        <p className="note">No issues: feet stay planted, joints stay in range, limbs stay out of the body.</p>
      )}
    </div>
  )
}

const remixUsable = (e: AnimEntry) => e.kind !== 'media' && !e.video && !bad(e)

function defaultOp(kind: RemixOpKind, clips: AnimEntry[]): RemixOp {
  const params = Object.fromEntries(REMIX_PARAMS[kind].map((p) => [p.key, p.def]))
  const clip = clips[0]?.id ?? ''
  switch (kind) {
    case 'amplitude':
      return { op: 'amplitude', part: 'all', scale: params.scale }
    case 'transplant':
      return { op: 'transplant', clip, part: 'upper' }
    case 'blend':
      return { op: 'blend', clip, at: params.at, from: params.from, window: params.window }
    default:
      return { op: kind, ...params } as RemixOp
  }
}

// A remixed clip's origin: the base clip, the edit ops as editable values, and Re-apply (the ops run
// again on the base, or on another base clip picked here).
function RemixPanel({ entry, entries, disabled, onOpen }: { entry: AnimEntry; entries: AnimEntry[]; disabled: boolean; onOpen: (id: string) => void }) {
  const { actions } = useStore()
  const origin = entry.remix!
  const [ops, setOps] = useState<RemixOp[]>(origin.ops)
  const [base, setBase] = useState(origin.base)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setOps(origin.ops)
    setBase(origin.base)
  }, [entry.id, entry.updatedAt])
  const clips = useMemo(() => entries.filter((e) => e.id !== entry.id && remixUsable(e)), [entries, entry.id])
  const others = clips.filter((e) => e.id !== base)
  const baseEntry = entries.find((e) => e.id === base)
  const names = useMemo(() => Object.fromEntries(entries.map((e) => [e.id, e.name])), [entries])
  const dirty = base !== origin.base || JSON.stringify(ops) !== JSON.stringify(origin.ops)
  const set = (i: number, patch: Partial<RemixOp>) => setOps(ops.map((o, n) => (n === i ? ({ ...o, ...patch } as RemixOp) : o)))
  const move = (i: number, d: -1 | 1) => {
    const j = i + d
    if (j < 0 || j >= ops.length) return
    const next = [...ops]
    ;[next[i], next[j]] = [next[j], next[i]]
    setOps(next)
  }
  const apply = async () => {
    setBusy(true)
    try {
      await window.harness.animRemixApply(entry.id, ops, { base })
      actions.toast({ text: 'Re-applied the ops', detail: `${ops.length} op${ops.length === 1 ? '' : 's'} on ${baseEntry?.name ?? origin.baseName}`, kind: 'ok', ms: 2200 })
    } catch (e) {
      actions.toast({ text: 'Re-apply failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  const sourceLabel = { model: 'planned by the model', heuristic: 'planned from the prompt words (no model)', critic: 'tuned by the critic loop', user: 'edited by you' }[origin.source]
  return (
    <div className="anim-remix">
      <div className="row anim-remix-head">
        <span className="faint mono">from</span>
        {baseEntry ? (
          <button className="btn small ghost anim-remix-base" onClick={() => onOpen(baseEntry.id)} title="Open the base clip">
            <Icon name="figure" size={11} /> {baseEntry.name}
          </button>
        ) : (
          <span className="err-t mono" title="The base clip was deleted: pick another one to re-apply">{origin.baseName} (missing)</span>
        )}
        <select className="input anim-remix-pick" value={base} onChange={(e) => setBase(e.target.value)} aria-label="Base clip" disabled={disabled || busy}>
          {!baseEntry && <option value={origin.base}>{origin.baseName} (missing)</option>}
          {clips.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
              {e.tags.length ? ` · ${e.tags.slice(0, 2).join(', ')}` : ''}
            </option>
          ))}
        </select>
        <span className="grow" />
        <span className="faint note">{sourceLabel}</span>
      </div>
      <p className="note">Motion comes from the base clip; these ops edit it in order. Change values and Re-apply (Refine tunes these params, never the keys).</p>
      {!ops.length && <div className="empty">No ops: the clip is the base clip as is. Add one below.</div>}
      <ol className="anim-remix-ops">
        {ops.map((o, i) => (
          <li key={i} className="anim-remix-op">
            <div className="row">
              <b className="mono">{o.op}</b>
              <span className="faint grow anim-remix-desc">{describeRemixOp(o, names)}</span>
              <button className="btn small ghost" onClick={() => move(i, -1)} disabled={i === 0 || disabled} aria-label={`Move ${o.op} up`}>
                ↑
              </button>
              <button className="btn small ghost" onClick={() => move(i, 1)} disabled={i === ops.length - 1 || disabled} aria-label={`Move ${o.op} down`}>
                ↓
              </button>
              <button className="btn small ghost danger" onClick={() => setOps(ops.filter((_, n) => n !== i))} disabled={disabled} aria-label={`Remove ${o.op}`}>
                <Icon name="x" size={10} />
              </button>
            </div>
            {(o.op === 'amplitude' || o.op === 'transplant') && (
              <label className="anim-remix-param">
                <span>part</span>
                <select className="input" value={o.part} onChange={(e) => set(i, { part: e.target.value as RemixPart })} disabled={disabled}>
                  {REMIX_PARTS.map((p) => (
                    <option key={p} value={p}>
                      {REMIX_PART_LABEL[p]}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {(o.op === 'blend' || o.op === 'transplant') && (
              <label className="anim-remix-param">
                <span>{o.op === 'blend' ? 'into' : 'from'}</span>
                <select className="input" value={o.clip} onChange={(e) => set(i, { clip: e.target.value })} disabled={disabled}>
                  {!others.some((c) => c.id === o.clip) && <option value={o.clip}>{names[o.clip] ?? o.clip}</option>}
                  {others.map((c) => (
                    <option key={c.id} value={c.id}>
                      {c.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {REMIX_PARAMS[o.op].map((p) => {
              const v = Number((o as Record<string, unknown>)[p.key] ?? p.def)
              return (
                <label key={p.key} className="anim-remix-param">
                  <span>{p.label}</span>
                  <input type="range" min={p.min} max={p.max} step={p.step} value={v} onChange={(e) => set(i, { [p.key]: Number(e.target.value) } as Partial<RemixOp>)} disabled={disabled} aria-label={`${o.op} ${p.label}`} />
                  <input className="input mono anim-remix-num" type="number" min={p.min} max={p.max} step={p.step} value={v} onChange={(e) => Number.isFinite(Number(e.target.value)) && set(i, { [p.key]: Math.min(p.max, Math.max(p.min, Number(e.target.value))) } as Partial<RemixOp>)} disabled={disabled} aria-label={`${o.op} ${p.label} value`} />
                  <em className="faint">{p.unit}</em>
                </label>
              )
            })}
          </li>
        ))}
      </ol>
      <div className="row">
        <select
          className="input anim-remix-add"
          value=""
          onChange={(e) => e.target.value && setOps([...ops, defaultOp(e.target.value as RemixOpKind, others)])}
          aria-label="Add an op"
          disabled={disabled || ops.length >= 8}
        >
          <option value="">+ add op…</option>
          {REMIX_OPS.filter((k) => (k !== 'blend' && k !== 'transplant') || others.length > 0).map((k) => (
            <option key={k} value={k}>
              {k}
            </option>
          ))}
        </select>
        <span className="grow" />
        <button className="btn small ghost" onClick={() => (setOps(origin.ops), setBase(origin.base))} disabled={!dirty || busy}>
          Reset
        </button>
        <button className="btn small primary" onClick={() => void apply()} disabled={disabled || busy || (!dirty && !!baseEntry)} title="Run the ops on the base clip again">
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Re-apply
        </button>
      </div>
    </div>
  )
}

function Detail({ entry, entries, progress, status, onClose, onOpen }: { entry: AnimEntry; entries: AnimEntry[]; progress?: AnimRefineProgress; status: AnimLabStatus | null; onClose: () => void; onOpen: (id: string) => void }) {
  const { actions } = useStore()
  const h = window.harness
  const firstTab = (e: AnimEntry) => (e.remix ? 'remix' : e.clip.script ? 'script' : 'info')
  const [tab, setTab] = useState<'remix' | 'script' | 'checks' | 'iterations' | 'studio' | 'info'>(firstTab(entry))
  const [clip, setClip] = useState<AnimClip>(entry.clip)
  const [notes, setNotes] = useState(entry.notes)
  const [busy, setBusy] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  useEffect(() => {
    setClip(entry.clip)
    setNotes(entry.notes)
  }, [entry.id, entry.updatedAt])
  useEffect(() => setTab(firstTab(entry)), [entry.id])

  const refining = !!progress && progress.phase !== 'done' && progress.phase !== 'error'
  const refs = useMemo(() => entries.filter((e) => e.id !== entry.id && e.kind !== 'media' && !bad(e) && e.tags.some((t) => entry.tags.includes(t))).slice(0, 12), [entries, entry])
  const reference = entry.reference ? entries.find((e) => e.id === entry.reference)?.clip ?? null : null
  const rig = clipRig(entry.clip)
  const other: RigType = rig === 'R6' ? 'R15' : 'R6'
  const [converting, setConverting] = useState(false)
  useEffect(() => setConverting(false), [entry.id])
  const convert = (copy: boolean) =>
    act('Convert', async () => {
      const r = await h.animConvert(entry.id, other, { copy })
      setConverting(false)
      actions.toast({ text: copy ? `Copied as ${other}: ${r.entry.name}` : `Converted to ${other}`, detail: r.warning, kind: 'ok', ms: 5000 })
    })

  const rate = async (r: 'up' | 'down') => {
    try {
      await h.animRate(entry.id, entry.rating === r ? null : r)
      if (entry.rating !== r) actions.toast({ text: r === 'up' ? 'Liked: a reference for its tags' : 'Marked avoid: never a reference', detail: 'Style profile, memory and the critic are updated.', kind: 'ok', ms: 2600 })
    } catch (e) {
      actions.toast({ text: 'Rating failed', detail: errorText(e), kind: 'err' })
    }
  }
  const act = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      actions.toast({ text: `${label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const exportIt = () =>
    act('Export', async () => {
      const r = await h.animExport(entry.id)
      await actions.copy(r.command, 'Studio command')
      actions.toast({ text: 'Written to the project', detail: `${r.module} + ${r.model.split('/').pop()} → ${r.instancePath}. The copied line plays it on your character in Studio.`, kind: 'ok', ms: 7000 })
    })
  const upload = () =>
    act('Upload', async () => {
      const r = await h.animUpload(entry.id)
      await actions.copy(r.uri, 'Animation id')
      actions.toast({ text: `Uploaded: ${r.uri}`, detail: r.module ? `AnimationId written into ${r.module}.` : 'Copied. Export to write it into a module.', kind: 'ok', ms: 7000 })
    })
  const remove = async () => {
    if (!confirm(`Delete ${entry.name} from the ${entry.scope} library?`)) return
    await h.animDelete(entry.id).catch((e) => actions.toast({ text: 'Delete failed', detail: errorText(e), kind: 'err' }))
    onClose()
  }

  return (
    <section className="vfx-detail anim-detail" aria-label={`${entry.name} details`}>
      <div className="vfx-detail-head">
        <Icon name="figure" size={13} />
        <b className="vfx-title">{entry.name}</b>
        <span className="badge-o">{entry.scope}</span>
        <span className="anim-rig-b" title={rig === 'R6' ? 'R6: Torso, Head and one part per arm / leg (RootJoint, Neck, shoulders, hips)' : 'R15: 15 parts'}>
          {rig}
        </span>
        {qualityTag(entry)}
        <span className="grow" />
        <button className={`btn small ghost${entry.rating === 'up' ? ' on' : ''}`} aria-pressed={entry.rating === 'up'} onClick={() => void rate('up')} title="Good: use as a reference, save as an example">
          +1
        </button>
        <button className={`btn small ghost${entry.rating === 'down' ? ' on bad' : ''}`} aria-pressed={entry.rating === 'down'} onClick={() => void rate('down')} title="Bad: mark avoid (never a reference; feeds avoid notes)">
          −1
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={12} />
        </button>
      </div>

      <AnimPreview clip={clip} reference={reference} references={refs} onReference={(id) => void h.animUpdate(entry.id, { reference: id })} />

      <div className="vfx-actions">
        {refining ? (
          <>
            <span className="vfx-progress mono" aria-live="polite">
              <span className="spinner" aria-hidden /> #{progress!.iteration} {progress!.phase}
              {progress!.score != null ? ` · ${progress!.score.toFixed(1)}` : ''}
              {progress!.message ? ` · ${progress!.message.slice(0, 80)}` : ''}
            </span>
            <button className="btn small" onClick={() => void h.animCancel(entry.id)}>
              <Icon name="stop" size={11} /> Cancel
            </button>
          </>
        ) : (
          <button className="btn small primary" onClick={() => void act('Refine', async () => (await h.animRefine(entry.id), setTab('iterations')))} title="Render the key beats, critique, adjust, repeat">
            <Icon name="restart" size={11} /> Refine
          </button>
        )}
        <StudioCheckButton kind="anim" id={entry.id} onShow={() => setTab('studio')} />
        <CompareButton onClick={() => setComparing(true)} count={entry.iterations?.length} />
        <button className="btn small" onClick={() => void exportIt()} disabled={!status?.projectRoot || !!busy} title="Write src/shared/Animations/<Name>/init.luau + Sequence.rbxmx and copy a command-bar line">
          {busy === 'Export' ? <span className="spinner" aria-hidden /> : <Icon name="studio" size={11} />} Export
        </button>
        <AddToGameButton lab="anim" id={entry.id} disabled={!status?.projectRoot || !!busy} />
        <button className="btn small" onClick={() => void upload()} disabled={!status?.upload || !!busy} title={status?.upload ? 'Upload as an Animation asset with Open Cloud (Art page key)' : 'Add an Open Cloud key (asset:read + asset:write) and creator on the Art page'}>
          {busy === 'Upload' ? <span className="spinner" aria-hidden /> : <Icon name="upload" size={11} />} Upload
        </button>
        {entry.roblox && <span className="note mono">rbxassetid://{entry.roblox.assetId}</span>}
        {entry.written && !entry.roblox && <span className="note mono vfx-written" title={`${entry.written.module}\n${entry.written.model}`}>{entry.written.module}</span>}
        <span className="grow" />
        <button className={`btn small ghost${converting ? ' on' : ''}`} onClick={() => setConverting(!converting)} disabled={!!busy || refining} aria-expanded={converting} title={`Convert this clip to ${other}`}>
          {busy === 'Convert' ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} To {other}
        </button>
        <button className="btn small ghost danger" onClick={() => void remove()} aria-label="Delete">
          <Icon name="trash" size={11} />
        </button>
      </div>
      {converting && (
        <div className="callout anim-convert" role="alertdialog" aria-label={`Convert to ${other}`}>
          <Icon name="warn" size={12} />
          <div className="grow">
            <b className="mono">
              {rig} → {other}
            </b>
            <p className="note">{RIG_CONVERT_WARNING[other]}</p>
            <div className="row">
              <button className="btn small primary" onClick={() => void convert(false)} disabled={!!busy}>
                Convert
              </button>
              <button className="btn small" onClick={() => void convert(true)} disabled={!!busy} title="Keep this clip and add a converted copy">
                Make a copy
              </button>
              <button className="btn small ghost" onClick={() => setConverting(false)}>
                Cancel
              </button>
            </div>
          </div>
        </div>
      )}
      <p className="note anim-idnote">
        Roblox plays animations by asset id: upload the clip (Upload, or publish Sequence.rbxmx from Studio's Animation Editor) and the id goes into the module's AnimationId. Until then the module registers the sequence with KeyframeSequenceProvider, which only works in Studio.
      </p>

      <div className="seg vfx-tabs" role="tablist">
        {([...(entry.remix ? (['remix'] as const) : []), 'script', 'checks', 'iterations', 'studio', 'info'] as const).map((k) => (
          <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => setTab(k)}>
            {k}
            {k === 'iterations' && entry.iterations?.length ? ` · ${entry.iterations.length}` : ''}
            {k === 'checks' && entry.clip.markers.length ? '' : ''}
          </button>
        ))}
      </div>

      {tab === 'remix' && entry.remix && <RemixPanel entry={entry} entries={entries} disabled={refining} onOpen={onOpen} />}
      {tab === 'script' && <AnimScriptPanel entry={entry} onPreview={setClip} />}
      {tab === 'checks' && <Checks entry={entry} />}
      {tab === 'studio' && <StudioCheckPanel kind="anim" id={entry.id} />}
      {tab === 'iterations' && entry.refId && <PinnedCompare entry={entry} />}
      {comparing && <AnimCompare entry={entry} onClose={() => setComparing(false)} onUse={(c, label) => void h.animUpdate(entry.id, { clip: c }).then(() => actions.toast({ text: `Using ${label}`, kind: 'ok', ms: 2000 }))} />}
      {tab === 'iterations' && <Iterations entry={entry} onRestore={(c, n) => void h.animUpdate(entry.id, { clip: c }).then(() => actions.toast({ text: `Using iteration #${n}`, kind: 'ok', ms: 2000 }))} />}
      {tab === 'iterations' && <LabDecisions lab="anim" entryId={entry.id} />}
      {tab === 'info' && (
        <div className="vfx-info">
          <p className="vfx-desc">{entry.description || <span className="faint">No description.</span>}</p>
          <dl className="vfx-meta anim-meta">
            <dt>tags</dt>
            <dd>
              <TagPills tags={entry.tags} onChange={(tags) => void h.animUpdate(entry.id, { tags })} />
            </dd>
            <dt>quality</dt>
            <dd>
              <div className="seg" role="group" aria-label="Quality">
                {([null, 'reference', 'good', 'avoid'] as const).map((q) => (
                  <button key={q ?? 'none'} className={(entry.quality ?? null) === q ? 'on' : ''} aria-pressed={(entry.quality ?? null) === q} onClick={() => void h.animUpdate(entry.id, { quality: q })}>
                    {q ?? 'normal'}
                  </button>
                ))}
              </div>
            </dd>
            <dt>notes</dt>
            <dd>
              <textarea className="input anim-notes-in" rows={2} value={notes} placeholder="What makes it good or bad (the drafter and critic read this)" onChange={(e) => setNotes(e.target.value)} onBlur={() => notes !== entry.notes && void h.animUpdate(entry.id, { notes })} aria-label="Notes" />
            </dd>
            <dt>clip</dt>
            <dd className="mono">
              {rig} · {entry.clip.duration.toFixed(2)}s · {entry.clip.priority}
              {entry.clip.looped ? ' · looped' : ''} · {Object.keys(entry.clip.tracks).length} joints
              {entry.stats ? ` · ${entry.stats.keys} keys` : ''}
            </dd>
            <dt>markers</dt>
            <dd className="mono">{entry.clip.markers.map((m) => `${m.name} @ ${m.t.toFixed(2)}s`).join('  ') || '—'}</dd>
            {entry.stats && (
              <>
                <dt>timing</dt>
                <dd className="mono">
                  anticipation {entry.stats.anticipation.toFixed(2)}s · action {entry.stats.action.toFixed(2)}s · recovery {entry.stats.recovery.toFixed(2)}s · holds {entry.stats.holds.toFixed(2)}s · overshoot {Math.round(entry.stats.overshoot * 100)}%
                </dd>
              </>
            )}
            <dt>origin</dt>
            <dd className="mono">
              {entry.origin}
              {entry.remix ? ` · remix of ${entry.remix.baseName}` : ''}
            </dd>
            {entry.restatement && (
              <>
                <dt>confirmed brief</dt>
                <dd>
                  <RestatedBrief r={entry.restatement} />
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
          </dl>
        </div>
      )}
    </section>
  )
}

interface ImportRow extends AnimImportPreview {
  tags: string[]
  quality: 'reference' | 'good' | 'avoid' | null
}

function ImportReview({ rows, scope, onChange, onCancel, onImport, busy, convert, onConvert }: { rows: ImportRow[]; scope: AnimScope; onChange: (rows: ImportRow[]) => void; onCancel: () => void; onImport: () => void; busy: boolean; convert: RigType | null; onConvert: (r: RigType | null) => void }) {
  const ok = rows.filter((r) => !r.error)
  const set = (i: number, patch: Partial<ImportRow>) => onChange(rows.map((r, n) => (n === i ? { ...r, ...patch } : r)))
  return (
    <section className="set-sec anim-review" aria-label="Review import">
      <div className="row">
        <b className="mono">import {ok.length} clip{ok.length === 1 ? '' : 's'}</b>
        <span className="faint">into {scope === 'user' ? 'your library' : 'this project'} · tags are suggested from the name and the motion; edit them, mark bad examples as avoid</span>
      </div>
      <ul className="anim-review-list">
        {rows.map((r, i) => (
          <li key={`${r.file}-${r.name}-${i}`} className={r.error ? 'err' : ''}>
            <span className="anim-review-name mono" title={r.file}>
              {r.name}
              <span className="faint">
                {' '}
                {r.error ? '' : `${r.rig === 'R6' ? 'R6 · ' : ''}${r.duration.toFixed(2)}s${r.looped ? ' ⟳' : ''}${r.markers ? ` · ${r.markers} markers` : ''}`}
              </span>
            </span>
            {r.error ? (
              <span className="note err-t">{r.error}</span>
            ) : (
              <>
                <TagPills tags={r.tags} onChange={(tags) => set(i, { tags })} label={`Tags for ${r.name}`} />
                <div className="seg anim-q" role="group" aria-label={`Quality of ${r.name}`}>
                  {([null, 'good', 'avoid'] as const).map((q) => (
                    <button key={q ?? 'none'} type="button" className={r.quality === q ? 'on' : ''} aria-pressed={r.quality === q} onClick={() => set(i, { quality: q })}>
                      {q ?? 'normal'}
                    </button>
                  ))}
                </div>
              </>
            )}
          </li>
        ))}
      </ul>
      <div className="row">
        <span className="faint mono">rig</span>
        <div className="seg" role="radiogroup" aria-label="Rig of the imported clips">
          {([null, 'R15', 'R6'] as const).map((r) => (
            <button key={r ?? 'keep'} type="button" role="radio" aria-checked={convert === r} className={convert === r ? 'on' : ''} onClick={() => onConvert(r)} title={r ? RIG_CONVERT_WARNING[r] : 'Each clip keeps its own rig (R6 KeyframeSequences stay R6)'}>
              {r ? `all ${r}` : 'keep'}
            </button>
          ))}
        </div>
        <span className="grow" />
        <button className="btn small ghost" onClick={onCancel}>
          Cancel
        </button>
        <button className="btn small primary" onClick={onImport} disabled={!ok.length || busy}>
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} Import {ok.length}
        </button>
      </div>
    </section>
  )
}

// The best iteration's rendered beats next to the pinned video reference's key frames.
function PinnedCompare({ entry }: { entry: AnimEntry }) {
  const its = entry.iterations ?? []
  const best = its.length ? bestOf(its) : null
  return <RefCompare lab="anim" refId={entry.refId!} entryId={entry.id} frames={best?.frames ?? []} times={best?.times} match={best?.critique?.match} matchNotes={best?.critique?.matchNotes} clip={best?.clip ?? entry.clip} iteration={best?.n} />
}

export function AnimLabPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<AnimLabStatus | null>(null)
  const [entries, setEntries] = useState<AnimEntry[]>([])
  const [style, setStyle] = useState<AnimStyle | null>(null)
  const [cov, setCov] = useState<AnimCoverage | null>(null)
  // Selection and library tab survive restarts (qol/sessionStore).
  const [selected, setSelected] = usePersisted<string | null>('anim.selected', null)
  const [query, setQuery] = useState('')
  const [tag, setTag] = useState<string | null>(null)
  const [scope, setScope] = useState<AnimScope>('user')
  const [view, setView] = usePersisted<'library' | 'style' | 'priorities'>('anim.view', 'library')
  const [prompt, setPrompt] = useState('')
  const [iters, setIters] = useState(4)
  const [threshold, setThreshold] = useState(7.5)
  const [making, setMaking] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [review, setReview] = useState<ImportRow[] | null>(null)
  const [importRig, setImportRig] = useState<RigType | null>(null)
  const [progress, setProgress] = useState<Record<string, AnimRefineProgress>>({})
  // Video reference import review (a dropped / picked clip), and the reference pinned to Make.
  const [refImport, setRefImport] = useState<{ file: File | null } | null>(null)
  const [pin, setPin] = useState<{ id: string; name: string } | null>(null)
  const [moveSets, setMoveSets] = useState<AnimMoveSets | null>(null)
  const [retagOffer, setRetagOffer] = useState(false)
  const [retagging, setRetagging] = useState(false)
  // Remix closest: the persisted mode, the closest clips for the prompt and a picked base clip.
  const [remixMode, setRemixMode] = useState<AnimRemixMode>('auto')
  const [cands, setCands] = useState<RemixCandidate[]>([])
  const [baseId, setBaseId] = useState<string | null>(null)
  const moveSet = moveSets?.active ?? null
  const knownTags = useMemo(() => {
    const mine = moveSet?.tags.map((t) => t.tag) ?? []
    return [...new Set([...mine, ...(moveSet && moveSet.id !== 'combat' ? [] : KNOWN_TAGS)])]
  }, [moveSet])
  const switchSet = async (id: string) => {
    if (id === moveSet?.id) return
    try {
      const next = await h.animSetMoveSet(id)
      setRetagOffer(entries.length > 0)
      await load()
      actions.toast({ text: `Move set: ${next.name}`, detail: 'Existing tags are kept. Re-tag the library to sort it into the new move types.', kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Could not switch the move set', detail: errorText(e), kind: 'err' })
    }
  }
  const retag = async () => {
    if (!moveSet || retagging) return
    setRetagging(true)
    try {
      const r = await h.animRetag()
      setRetagOffer(false)
      await load()
      actions.toast({ text: `Re-tagged ${r.changed} of ${r.total} clip${r.total === 1 ? '' : 's'} with ${moveSet.name}`, detail: r.source === 'model' ? 'Tagged by the cheap Labs model; profiles re-measured.' : 'Tagged from names, files and notes (no model set up); profiles re-measured. Clips nothing matched keep their tags.', kind: 'ok', ms: 5000 })
    } catch (e) {
      actions.toast({ text: 'Re-tag failed', detail: errorText(e), kind: 'err' })
    } finally {
      setRetagging(false)
    }
  }
  const addType = async (tag: string, description: string) => {
    try {
      await h.animAddMoveTag({ tag, ...(description.trim() ? { description: description.trim() } : {}) })
      await load()
      return true
    } catch (e) {
      actions.toast({ text: 'Could not add the move type', detail: errorText(e), kind: 'err' })
      return false
    }
  }
  const removeType = async (tag: string) => {
    try {
      await h.animRemoveMoveTag(tag)
      await load()
    } catch (e) {
      actions.toast({ text: 'Could not remove the move type', detail: errorText(e), kind: 'err' })
    }
  }
  const rig: RigType = status?.rig ?? 'R15'
  const switchRig = async (r: RigType) => {
    if (r === rig) return
    try {
      await h.animSetRig(r)
      await load()
      actions.toast({ text: `New clips use ${r}`, detail: r === 'R6' ? 'Scripts, the kit, IK, checks and export use the R6 body (Torso, Head, one part per limb). Existing clips keep their rig.' : 'Existing clips keep their rig; convert one from its detail view.', kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Could not switch the rig', detail: errorText(e), kind: 'err' })
    }
  }

  const load = useCallback(async () => {
    try {
      const [s, list, st, c, ms, mode] = await Promise.all([h.animStatus(), h.animList(), h.animStyle(), h.animCoverage(), h.animMoveSets(), h.animRemixMode().catch(() => 'auto' as const)])
      setMoveSets(ms)
      setRemixMode(mode)
      setStatus(s)
      setEntries(list)
      setStyle(st)
      setCov(c)
    } catch (e) {
      actions.toast({ text: 'Could not load the animation library', detail: errorText(e), kind: 'err' })
    }
  }, [actions])

  useEffect(() => {
    void load()
  }, [state.project?.root])
  useEffect(() => {
    const off1 = h.on('anim:changed', () => void load())
    const off2 = h.on('anim:progress', (p) => {
      setProgress((m) => ({ ...m, [p.entryId]: p }))
      if (p.phase === 'error') actions.toast({ text: 'Refine stopped', detail: p.message, kind: 'err' })
      if (p.phase === 'done') actions.toast({ text: `Refine finished${p.score != null ? ` · ${p.score.toFixed(1)}/10` : ''}`, detail: p.message, kind: 'ok', ms: 3500 })
    })
    return () => (off1(), off2())
  }, [load])

  const allTags = useMemo(() => {
    const count = new Map<string, number>()
    for (const e of entries) for (const t of e.tags) count.set(t, (count.get(t) ?? 0) + 1)
    return [...count.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 16)
  }, [entries])

  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return entries.filter((e) => (!tag || e.tags.includes(tag)) && words.every((w) => `${e.name} ${e.description} ${e.tags.join(' ')} ${e.notes}`.toLowerCase().includes(w)))
  }, [entries, query, tag])
  const current = entries.find((e) => e.id === selected) ?? null

  // Closest library clips for the prompt (debounced; re-run when the library changes).
  useEffect(() => {
    const what = prompt.trim()
    if (!what) return setCands([])
    let live = true
    const timer = setTimeout(() => {
      void h
        .animRemixCandidates(what)
        .then((r) => live && setCands(r.candidates))
        .catch(() => live && setCands([]))
    }, 250)
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [prompt, entries])
  const remixClips = useMemo(() => entries.filter(remixUsable), [entries])
  const typed = useMemo(() => {
    const known = new Set(moveSet?.tags.map((t) => t.tag) ?? [])
    return remixClips.some((e) => e.tags.some((t) => known.has(t)))
  }, [remixClips, moveSet])
  const pickedBase = baseId ? entries.find((e) => e.id === baseId) ?? null : null
  const autoBase = pickedBase ?? (cands[0] ? entries.find((e) => e.id === cands[0].id) ?? null : null)
  // auto: remix when the library has a usable clip of the request's move type (any typed clip before typing).
  const remixOn = remixMode === 'remix' || (remixMode === 'auto' && (prompt.trim() ? !!autoBase : typed))
  const chooseMode = (m: 'remix' | 'scratch') => {
    setRemixMode(m)
    void h.animSetRemixMode(m).catch(() => undefined)
  }

  // Import: preview first (suggested tags as pills), then import each file with its tags / quality.
  const startImport = async (paths: string[]) => {
    if (!paths.length) return
    setBusy(`reading ${paths.length} item${paths.length === 1 ? '' : 's'}…`)
    try {
      const pre = await h.animPreviewImport(paths)
      setReview(pre.map((p) => ({ ...p, tags: p.suggestedTags, quality: null })))
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const doImport = async () => {
    if (!review) return
    setBusy('importing…')
    let added = 0
    const skipped: string[] = []
    try {
      const files = [...new Set(review.filter((r) => !r.error).map((r) => r.file))]
      for (const f of files) {
        const row = review.find((r) => r.file === f && !r.error)!
        const r = await h.animImport([f], scope, { tags: row.tags, ...(row.quality ? { quality: row.quality } : {}), ...(importRig ? { convert: importRig } : {}) })
        added += r.added.length
        skipped.push(...r.skipped.map((s) => `${s.file.split(/[\\/]/).pop()} (${s.reason})`))
        if (r.added[0] && !selected) setSelected(r.added[0].id)
      }
      setReview(null)
      await load()
      actions.toast({ text: `Imported ${added} clip${added === 1 ? '' : 's'}`, detail: skipped.length ? `Skipped: ${skipped.slice(0, 3).join('; ')}` : 'The style profile is updated.', kind: added ? 'ok' : 'info' })
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    // Clips and GIFs open the video reference review; animations import as before.
    const files = [...e.dataTransfer.files]
    const clip = files.find(isRefFile)
    if (clip) setRefImport({ file: clip })
    void startImport(files.filter((f) => !isRefFile(f)).map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean))
  }
  const learn = async () => {
    setBusy('learning…')
    try {
      const r = await h.animLearn()
      setStyle(r.style)
      actions.toast({ text: `${r.style.profiles.length} style profile${r.style.profiles.length === 1 ? '' : 's'} learned`, detail: r.saved.length ? `Saved to memory: ${r.saved.join(', ')}` : r.errors.join('; ') || undefined, kind: r.errors.length ? 'info' : 'ok' })
    } catch (e) {
      actions.toast({ text: 'Learning failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const restate = useRestateGate('anim')
  const make = async () => {
    const what = prompt.trim()
    if (!what || making) return
    setMaking(true)
    try {
      // Restate first: the confirmed reading of the brief goes into compose (null = cancelled).
      const g = await restate.gate(what)
      if (!g) return
      const remixing = remixOn && !pin
      if (remixing && !autoBase) throw new Error('No library clip matches this move type: pick a base clip, import a reference clip, or switch to From scratch.')
      const r = remixing
        ? await h.animRemix(what, { maxIterations: iters, threshold, scope, rig, base: autoBase!.id, ...(g.restatement ? { restatement: g.restatement } : {}) })
        : await h.animCompose(what, { maxIterations: iters, threshold, scope, rig, ...(pin ? { reference: pin.id } : {}), ...(g.restatement ? { restatement: g.restatement } : {}) })
      if (!r.ok || !r.entry) throw new Error(r.error ? `${r.error.line ? `line ${r.error.line}: ` : ''}${r.error.message}` : 'the script did not compile')
      await load()
      setSelected(r.entry.id)
      setView('library')
      setPrompt('')
      setBaseId(null)
    } catch (e) {
      actions.toast({ text: 'Could not make the animation', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
    }
  }
  const addExample = async (key: string) => {
    try {
      const entry = await h.animAddExample(rig === 'R6' ? `${key}-r6` : key)
      await load()
      setSelected(entry.id)
      setView('library')
    } catch (e) {
      actions.toast({ text: 'Could not add the example', detail: errorText(e), kind: 'err' })
    }
  }
  const choose = async () => void startImport(await h.animChooseImport())

  return (
    <TagsContext.Provider value={knownTags}>
    <div className="page">
      <datalist id="anim-tag-list">
        {knownTags.map((t) => (
          <option key={t} value={t} />
        ))}
      </datalist>
      <div className="page-inner vfx anim">
        <div className="page-head">
          <div>
            <h1>Animation Lab</h1>
            <div className="sub">
              {status ? `${status.rig} · ${status.entries.user} in your library · ${status.entries.project} in this project · ${status.profiles} style profile${status.profiles === 1 ? '' : 's'}` : 'loading…'}
              {status && !status.projectRoot ? ' · open a project to export' : ''}
            </div>
          </div>
          <div className="actions">
            <div className="seg anim-rig" role="radiogroup" aria-label="Rig for new clips" title={status?.projectRoot ? 'Rig for new clips in this project (.forge/anim/settings.json)' : 'Default rig for new clips'}>
              {(['R15', 'R6'] as const).map((r) => (
                <button key={r} role="radio" aria-checked={rig === r} className={rig === r ? 'on' : ''} onClick={() => void switchRig(r)}>
                  {r}
                </button>
              ))}
            </div>
            <select className="input anim-set" value={moveSet?.id ?? 'combat'} onChange={(e) => void switchSet(e.target.value)} aria-label="Move set" title={moveSet ? `${moveSet.description}${status?.projectRoot ? ' (per project: .forge/anim/settings.json)' : ''}` : 'Move set'}>
              {(moveSets?.sets ?? MOVE_SETS).map((x) => (
                <option key={x.id} value={x.id}>
                  {x.name.toLowerCase()} moves
                </option>
              ))}
            </select>
            <select className="input" value={scope} onChange={(e) => setScope(e.target.value as AnimScope)} aria-label="Library for imports and new clips">
              <option value="user">your library</option>
              <option value="project" disabled={!status?.projectRoot}>
                this project
              </option>
            </select>
            <button className="btn" onClick={() => void choose()}>
              <Icon name="upload" size={12} /> Import
            </button>
            <button className="btn" onClick={() => setRefImport({ file: null })} title="A clip or GIF to animate something like it: trim, crop, analyse beats, holds and fast motion">
              <Icon name="image" size={12} /> Video ref
            </button>
            <button className="btn" onClick={() => void learn()} disabled={!entries.length || !!busy} title="Measure style profiles per move type and save them as memory skills">
              <Icon name="memory" size={12} /> Learn
            </button>
          </div>
        </div>

        {status && (!status.lune.available || !status.vision) && (
          <div className="callout row">
            <Icon name="info" size={12} />
            <span className="grow note">
              {!status.lune.available && <>Lune not found: .rbxmx and .bvh imports still work; .rbxm imports and timeline scripts need Lune (Settings → Toolchain). </>}
              {!status.vision && <>No model set up: drafts come from the built-in archetypes and critiques use the automatic checks only. </>}
            </span>
          </div>
        )}

        {retagOffer && moveSet && (
          <div className="callout row anim-retag-offer" role="status">
            <Icon name="info" size={12} />
            <span className="grow note">
              Now using <b>{moveSet.name}</b> move types ({moveSet.tags.slice(0, 6).map((t) => t.tag).join(', ')}…). Your clips keep their old tags until you re-tag.
            </span>
            <button className="btn small primary" onClick={() => void retag()} disabled={retagging}>
              {retagging ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Re-tag library with {moveSet.name}
            </button>
            <button className="btn small ghost" onClick={() => setRetagOffer(false)} aria-label="Dismiss">
              <Icon name="x" size={11} />
            </button>
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
              <span className="vfx-prompt-sigil">›</span> Animate
            </span>
            <input className="input grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={moveSet?.placeholder ?? 'a heavy overhead punch with a long windup'} aria-label="Animation to make" spellCheck />
            {pin && (
              <span className="badge-o hot vfx-make-pin" title="Pinned video reference: Make animates like it">
                like {pin.name}
                <button type="button" className="btn small ghost" onClick={() => setPin(null)} aria-label="Unpin the reference">
                  <Icon name="x" size={10} />
                </button>
              </span>
            )}
            <div className="seg anim-mode" role="radiogroup" aria-label="How to make the clip" title={remixMode === 'auto' ? 'Auto: remix when the library has a clip of this move type (click to fix a mode for this project)' : 'Saved for this project'}>
              <button type="button" role="radio" aria-checked={!remixOn} className={!remixOn ? 'on' : ''} onClick={() => chooseMode('scratch')} title="The model writes the keys from scratch (timeline script)">
                From scratch
              </button>
              <button type="button" role="radio" aria-checked={remixOn} className={remixOn ? 'on' : ''} onClick={() => chooseMode('remix')} title="Start from the closest library clip and edit it (speed, mirror, trim, amplitude, blend...): the motion stays human">
                Remix closest
              </button>
            </div>
            <button className="btn primary" disabled={!prompt.trim() || making}>
              {making && !restate.waiting ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make
            </button>
          </form>
          {remixOn && !pin && (
            <div className="row anim-remix-from" aria-live="polite">
              <Icon name="figure" size={11} />
              {autoBase ? (
                <span className="note">
                  from <b>{autoBase.name}</b>
                  {!pickedBase && cands[0]?.matched.length ? <span className="faint"> · closest {cands[0].matched.join(', ')}</span> : null}
                  {pickedBase ? <span className="faint"> · picked</span> : null}
                </span>
              ) : (
                <span className="note">{prompt.trim() ? 'No library clip of this move type: pick a base clip' : 'Type the move: the closest library clip is the starting point'}</span>
              )}
              <select className="input anim-remix-pick" value={baseId ?? ''} onChange={(e) => setBaseId(e.target.value || null)} aria-label="Base clip to remix">
                <option value="">{cands.length ? 'closest match' : 'pick a base clip…'}</option>
                {cands.length > 0 && (
                  <optgroup label="closest">
                    {cands.map((c) => (
                      <option key={c.id} value={c.id}>
                        {c.name} · {c.tags.slice(0, 2).join(', ')}
                      </option>
                    ))}
                  </optgroup>
                )}
                <optgroup label="library">
                  {remixClips
                    .filter((e) => !cands.some((c) => c.id === e.id))
                    .map((e) => (
                      <option key={e.id} value={e.id}>
                        {e.name}
                        {e.tags.length ? ` · ${e.tags.slice(0, 2).join(', ')}` : ''}
                      </option>
                    ))}
                </optgroup>
              </select>
              {remixMode === 'auto' && <span className="faint mono">auto</span>}
            </div>
          )}
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
              {(moveSet?.suggestions ?? MOVE_SETS[0].suggestions).map((s) => (
                <button key={s} type="button" className="badge-o" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </span>
            <span className="vfx-examples">
              <span className="faint mono">examples</span>
              {EXAMPLES.map((x) => (
                <button key={x.key} type="button" className="badge-o" onClick={() => void addExample(x.key)} title={`Add the ${rig} version of this built-in scripted example to the library and open it`}>
                  {x.label}
                  {rig === 'R6' ? ' · R6' : ''}
                </button>
              ))}
            </span>
          </div>
          <LabCostLine lab="anim" />
        </section>

        {review && <ImportReview rows={review} scope={scope} onChange={setReview} onCancel={() => setReview(null)} onImport={() => void doImport()} busy={!!busy} convert={importRig} onConvert={setImportRig} />}

        <div className={`vfx-body${current ? ' has-detail' : ''}`}>
          <div className="vfx-lib">
            <div className="seg anim-view" role="tablist" aria-label="Library view">
              <button role="tab" aria-selected={view === 'library'} className={view === 'library' ? 'on' : ''} onClick={() => setView('library')}>
                library · {entries.length}
              </button>
              <button role="tab" aria-selected={view === 'style'} className={view === 'style' ? 'on' : ''} onClick={() => setView('style')}>
                style · {(style?.profiles.length ?? 0) + (style?.r6?.profiles.length ?? 0)}
              </button>
              <button role="tab" aria-selected={view === 'priorities'} className={view === 'priorities' ? 'on' : ''} onClick={() => setView('priorities')} title="Which animation principles count most for you, learned from your ratings">
                priorities
              </button>
            </div>
            {view === 'priorities' ? (
              <PrinciplePriorities domains={['anim']} />
            ) : view === 'style' ? (
              <StyleView style={style} onLearn={() => void learn()} busy={!!busy} />
            ) : (
              <>
                <div
                  className={`vfx-drop${drag ? ' drag' : ''}`}
                  onDragOver={(e) => (e.preventDefault(), setDrag(true))}
                  onDragLeave={() => setDrag(false)}
                  onDrop={onDrop}
                  role="button"
                  tabIndex={0}
                  onClick={() => void choose()}
                  onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void choose())}
                >
                  {busy ? (
                    <>
                      <span className="spinner" aria-hidden /> {busy}
                    </>
                  ) : (
                    <>
                      <Icon name="download" size={13} /> Drop reference animations here <span className="faint mono">{IMPORT_HINT}</span>
                    </>
                  )}
                </div>
                <Coverage coverage={cov} onTag={(t) => setTag(tag === t ? null : t)} set={moveSet} onRetag={() => void retag()} retagging={retagging} onAddType={addType} onRemoveType={(t) => void removeType(t)} />
                <div className="row vfx-lib-head">
                  <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, tag, notes" aria-label="Search library" />
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
                    <Icon name="figure" size={22} className="i" />
                    The library is empty. Drop KeyframeSequences (.rbxm / .rbxmx) or BVH mocap above, add the built-in examples, or animate something.
                  </div>
                )}
                <div className="vfx-grid">
                  {shown.map((e) =>
                    e.video ? (
                      <RefCard key={e.id} lab="anim" entry={e} selected={e.id === selected} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
                    ) : (
                      <Card key={e.id} entry={e} selected={e.id === selected} progress={progress[e.id]} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
                    )
                  )}
                </div>
              </>
            )}
          </div>
          {current &&
            (current.video ? (
              <RefDetail key={current.id} lab="anim" entry={current} onClose={() => setSelected(null)} onMade={(id) => void load().then(() => (setSelected(id), setView('library')))} onPin={setPin} />
            ) : (
              <Detail key={current.id} entry={current} entries={entries} progress={progress[current.id]} status={status} onClose={() => setSelected(null)} onOpen={(id) => setSelected(id)} />
            ))}
        </div>
        {refImport && (
          <RefImport
            lab="anim"
            scope={scope}
            file={refImport.file}
            onClose={() => setRefImport(null)}
            onSaved={(r) => {
              setRefImport(null)
              void load().then(() => (setSelected(r.id), setView('library')))
            }}
          />
        )}
      </div>
    </div>
    </TagsContext.Provider>
  )
}
