// UI art mode of the Thumbnail Lab: "Make a button / panel / icon / icon set / HUD mockup of ___"
// through the same image backend. Candidates come back on a transparency checkerboard, ranked by one
// cheap critic call (or the code checks); icon sets show in order at their real 48 px size; the
// detail panel previews the asset at real size and stretched through its 9-slice SliceCenter, and
// keeps / +1 / "use as reference" teach the UI kit that later prompts carry.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ThumbEstimate, ThumbStatus, ThumbsEvents, UiAsset, UiAssetKind, UiKit } from '@shared/types'
import { UI_KINDS, UI_KIND_IDS, splitNames } from '@shared/thumbs/builder'
import { uiLuau, uiScore } from '@shared/thumbs/uiart'
import { CODEX_IMAGE_NOTE } from '@shared/artTypes'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { Swatches, useThumbFile } from './parts'
import { builderSections, EMPTY_BUILDER, PromptBuilder, type BuilderState } from './PromptBuilder'

type Tab = 'latest' | 'library' | 'kit'
const QUALITIES = ['low', 'medium', 'high']
const usd = (x: number) => `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`
const tone = (s: number) => (s >= 8 ? 'ok' : s >= 6 ? 'info' : 'warn')

function UiTile({ a, best, selected, onSelect }: { a: UiAsset; best?: boolean; selected: boolean; onSelect: () => void }) {
  const url = useThumbFile('ui', a.id, 'image', a.updatedAt)
  const s = uiScore(a)
  return (
    <button className={`th-card th-ui-card${selected ? ' on' : ''}${best ? ' best' : ''}`} onClick={onSelect} aria-pressed={selected} title={a.critique?.summary || a.ask}>
      <div className={`th-ui-well kind-${a.kind}`}>
        {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="th-ph" />}
        <span className="th-badges">
          {best && <span className="tag ok">best</span>}
          {a.setIndex === 0 && a.kind === 'icon-set' && <span className="tag info">anchor</span>}
          {a.keep && <span className="tag ok">kept</span>}
          {a.pinned && <span className="tag info">ref</span>}
        </span>
        <span className={`th-score mono ${tone(s)}`}>{s.toFixed(1)}</span>
      </div>
      <div className="th-cap">
        <span className="mono faint">#{a.id.split('-').pop()}</span>
        <span className="th-cap-name">{a.kind === 'icon-set' ? a.name : a.critique?.by === 'code' ? 'measured' : (a.critique?.summary ?? '')}</span>
        {a.rating === 'up' && <span className="tag ok">+1</span>}
        {a.rating === 'down' && <span className="tag err">−1</span>}
      </div>
    </button>
  )
}

// One icon at its real size on Roblox-like dark and light backgrounds.
function SetIcon({ a, size }: { a: UiAsset; size: number }) {
  const url = useThumbFile('ui', a.id, 'image', a.updatedAt)
  return <span className="th-set-icon" style={{ width: size, height: size }}>{url && <img src={url} alt={a.name} width={size} height={size} draggable={false} />}</span>
}

function SetStrip({ set }: { set: UiAsset[] }) {
  if (set.length < 2) return null
  return (
    <section className="th-disc th-set" aria-label="Icon set at real size">
      <div className="th-disc-head">
        <span className="mono">the set</span>
        <span className="faint">in order, at 48 px (hotbar / shop tile) and 96 px, on dark and light</span>
      </div>
      {(['dark', 'light'] as const).map((t) => (
        <div key={t} className={`th-disc-page ${t} th-set-row`}>
          {set.map((a) => (
            <figure key={a.id} className="th-set-fig">
              <SetIcon a={a} size={48} />
              <figcaption>{a.name}</figcaption>
            </figure>
          ))}
          <span className="th-set-gap" />
          {set.map((a) => (
            <SetIcon key={a.id} a={a} size={96} />
          ))}
        </div>
      ))}
    </section>
  )
}

// The asset stretched through its SliceCenter (CSS border-image does the same 9-slice as Roblox).
function SliceStretch({ url, a, w, h }: { url: string; a: UiAsset; w: number; h: number }) {
  const s = a.slice!
  const k = Math.min(1, (a.kind === 'button' ? 56 : 120) / a.height)
  const ins = [s.y0, a.width - s.x1, a.height - s.y1, s.x0]
  return (
    <span
      className="th-slice-box"
      style={{
        width: w,
        height: h,
        borderStyle: 'solid',
        borderWidth: ins.map((v) => `${Math.round(v * k)}px`).join(' '),
        borderImageSource: `url(${url})`,
        borderImageSlice: `${ins.join(' ')} fill`,
        borderImageWidth: ins.map((v) => `${Math.round(v * k)}px`).join(' ')
      }}
      title={`${w}×${h} through SliceCenter ${s.x0},${s.y0} → ${s.x1},${s.y1}`}
    />
  )
}

function RealSize({ a, url }: { a: UiAsset; url: string }) {
  const [w, h] = a.kind === 'button' ? [150, Math.round((150 * a.height) / a.width)] : a.kind === 'panel' ? [200, Math.round((200 * a.height) / a.width)] : [48, 48]
  const stretch: [number, number][] = a.kind === 'button' ? [[260, 56], [110, 48]] : a.kind === 'panel' ? [[300, 150], [150, 220]] : []
  return (
    <section className="th-real" aria-label="At real size">
      <div className="th-disc-head">
        <span className="mono">real size</span>
        <span className="faint">{a.kind === 'icon' || a.kind === 'icon-set' ? '48 px on a phone hotbar' : `${w}×${h} on a phone`}{a.slice && stretch.length ? ' · stretched with its 9-slice' : ''}</span>
      </div>
      {(['dark', 'light'] as const).map((t) => (
        <div key={t} className={`th-disc-page ${t} th-real-row`}>
          <img src={url} alt="" width={w} height={h} draggable={false} />
          {a.slice && stretch.map(([sw, sh]) => <SliceStretch key={`${sw}x${sh}`} url={url} a={a} w={sw} h={sh} />)}
        </div>
      ))}
    </section>
  )
}

function UiDetail({ a, status, onClose }: { a: UiAsset; status: ThumbStatus | null; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const url = useThumbFile('ui', a.id, 'image', a.updatedAt)
  const [working, setWorking] = useState<string | null>(null)
  const [exported, setExported] = useState<{ path: string; luau: string } | null>(null)
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setWorking(label)
    try {
      await fn()
      if (ok) actions.toast({ text: ok, kind: 'ok', ms: 2600 })
    } catch (e) {
      actions.toast({ text: `${label[0].toUpperCase()}${label.slice(1)} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setWorking(null)
    }
  }
  const c = a.critique
  const scores: [string, number][] = c ? [['brief', c.scores.brief], ['readability', c.scores.readability], ['consistency', c.scores.consistency], ['clean', c.scores.clean]] : []
  return (
    <section className="vfx-detail th-detail th-ui-detail" aria-label={`UI asset ${a.id}`}>
      <div className="vfx-detail-head">
        <Icon name="image" size={13} />
        <b className="vfx-title">#{a.id.split('-').pop()} {a.name}</b>
        <span className="vfx-score mono">{uiScore(a).toFixed(1)}</span>
        <span className="faint mono">{c?.by === 'critic' ? 'critic' : 'measured'}</span>
        <span className="grow" />
        <button className={`btn small ghost${a.rating === 'up' ? ' on' : ''}`} aria-pressed={a.rating === 'up'} onClick={() => void run('rating', () => h.thumbUiRate(a.id, a.rating === 'up' ? null : 'up'))} title="Good: teaches the kit">
          +1
        </button>
        <button className={`btn small ghost${a.rating === 'down' ? ' on' : ''}`} aria-pressed={a.rating === 'down'} onClick={() => void run('rating', () => h.thumbUiRate(a.id, a.rating === 'down' ? null : 'down'))} title="Bad: teaches what to avoid">
          −1
        </button>
        <button className={`btn small${a.keep ? ' on' : ''}`} aria-pressed={!!a.keep} onClick={() => void run('keep', () => h.thumbUiKeep(a.id, !a.keep))} title="Keep: the strongest kit label (palette, outline, corners, shading)">
          <Icon name="check" size={11} /> keep
        </button>
        <button className={`btn small${a.pinned ? ' on' : ''}`} aria-pressed={!!a.pinned} onClick={() => void run('reference', () => h.thumbUiPin(a.id, !a.pinned))} title="Use as reference: attached as an edit reference to every later UI prompt">
          <Icon name="pin" size={11} /> use as ref
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className={`th-ui-well big kind-${a.kind}`}>{url ? <img src={url} alt={a.name} draggable={false} /> : <span className="th-ph" />}</div>
      {url && a.kind !== 'hud' && <RealSize a={a} url={url} />}
      <div className="vfx-actions">
        <button className="btn small" onClick={() => void run('critique', () => h.thumbUiCritique(a.id))} disabled={!!working}>
          {working === 'critique' ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
        </button>
        <button className="btn small" onClick={() => void run('export', async () => setExported(await h.thumbUiExport(a.id)), 'Exported into the project')} disabled={!!working || !status?.project} title={status?.project ? 'Write the PNG into art/ui/ in the project (and get the Luau to use it)' : 'Open a project first'}>
          {working === 'export' ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} Export to project
        </button>
        <button className="btn small" onClick={() => void run('upload', () => h.thumbUiUpload(a.id), 'Uploaded as an Image asset')} disabled={!!a.roblox || !!working || !status?.robloxKey} title={status?.robloxKey ? 'Open Cloud Assets API, as an Image' : 'Add an Open Cloud key on the Art page'}>
          {working === 'upload' ? <span className="spinner" aria-hidden /> : <Icon name="upload" size={11} />} {a.roblox ? a.roblox.uri : 'Upload to Roblox'}
        </button>
        <button className="btn small ghost" onClick={() => void actions.copy(uiLuau(a, { width: a.width, height: a.height }), 'Luau')} title="Luau for an ImageLabel (SliceCenter for buttons and panels)">
          <Icon name="code" size={11} /> Copy Luau
        </button>
        <span className="grow" />
        <button className="btn small ghost danger" onClick={() => confirm('Delete this UI asset?') && void run('delete', () => h.thumbUiDelete(a.id).then(onClose))} aria-label="Delete UI asset">
          <Icon name="trash" size={11} />
        </button>
      </div>
      {exported && (
        <div className="callout row th-exported">
          <Icon name="check" size={12} />
          <span className="grow note">
            Saved <span className="mono">{exported.path}</span>
          </span>
          <button className="btn small ghost" onClick={() => void actions.copy(exported.luau, 'Luau')}>
            <Icon name="copy" size={10} /> Luau
          </button>
        </div>
      )}
      {c && <p className="vfx-iter-sum">{c.summary}</p>}
      {scores.length > 0 && c?.by === 'critic' && (
        <div className="vfx-rubric">
          {scores.map(([k, v]) => (
            <div key={k} className="vfx-rub">
              <span>{k}</span>
              <span className="vfx-bar">
                <i style={{ width: `${v * 10}%` }} className={v < 6 ? 'low' : ''} />
              </span>
              <b>{v.toFixed(0)}</b>
            </div>
          ))}
        </div>
      )}
      <div className="vfx-rubric" aria-label="Measured checks">
        {a.checks.map((x) => (
          <div key={x.id} className="vfx-rub" title={x.note}>
            <span>{x.label}</span>
            <span className="vfx-bar">
              <i style={{ width: `${x.score * 10}%` }} className={x.score < 6 ? 'low' : ''} />
            </span>
            <b>{x.score.toFixed(0)}</b>
          </div>
        ))}
      </div>
      {c && c.changes.length > 0 && (
        <details className="vfx-changes" open>
          <summary>next changes ({c.changes.length})</summary>
          <ul>
            {c.changes.map((x, i) => (
              <li key={i}>{x}</li>
            ))}
          </ul>
        </details>
      )}
      <dl className="vfx-meta th-meta">
        <dt>look</dt>
        <dd className="mono">
          {a.look ? [a.look.stroke, a.look.corners, a.look.shading, a.look.typography].filter(Boolean).join(' · ') : `${a.stats.outline} outline · corners ${Math.round(a.stats.corner * 100)}% · ${a.stats.topLit ? 'top-lit' : a.stats.flatness > 0.8 ? 'flat' : 'shaded'}`}
        </dd>
        <dt>colour</dt>
        <dd>
          <Swatches colors={a.stats.palette.map((p) => p.hex)} />
        </dd>
        {a.slice && (
          <>
            <dt>9-slice</dt>
            <dd className="mono">
              SliceCenter {a.slice.x0}, {a.slice.y0} → {a.slice.x1}, {a.slice.y1} of {a.width}×{a.height}
            </dd>
          </>
        )}
        <dt>made</dt>
        <dd className="mono">
          {a.model} · {a.genSize} → {a.width}×{a.height} · {a.quality} · ${a.costUsd.toFixed(3)}
          {a.keyed ? ' · background keyed out' : ''}
          {a.refIds.length ? ` · ${a.refIds.length} ref${a.refIds.length === 1 ? '' : 's'}` : ''}
          {a.exportedTo ? ` · ${a.exportedTo}` : ''}
        </dd>
      </dl>
      <details className="vfx-changes">
        <summary>prompt</summary>
        <pre className="th-prompt mono">{a.prompt}</pre>
      </details>
    </section>
  )
}

function KitView({ kit, assets, onOpen }: { kit: UiKit | null; assets: UiAsset[]; onOpen: (id: string) => void }) {
  if (!kit || (!kit.samples && !kit.refIds.length))
    return <div className="empty">No UI kit yet. Keep or +1 the UI art you like (and "use as ref" the best): its palette, outline, corners, shading and lettering then go into every later UI prompt, with the pinned images as references.</div>
  const refs = kit.refIds.map((id) => assets.find((a) => a.id === id)).filter((a): a is UiAsset => !!a)
  return (
    <section className="th-prof th-kit" aria-label="UI kit">
      <header className="th-prof-head">
        <b className="mono">your UI kit</b>
        <span className="faint">
          learned from {kit.samples} kept / +1 asset{kit.samples === 1 ? '' : 's'} · attached to UI prompts (turn off per Make)
        </span>
      </header>
      <Swatches colors={kit.palette} size={18} />
      <ul className="th-taste-lines">
        {[kit.look.stroke, kit.look.corners, kit.look.shading, kit.look.typography ? `lettering: ${kit.look.typography}` : ''].filter(Boolean).map((l) => (
          <li key={l}>{l}</li>
        ))}
        {kit.avoid.map((l) => (
          <li key={l} className="err-text">
            {l}
          </li>
        ))}
      </ul>
      {refs.length > 0 && (
        <>
          <span className="faint">references sent with each UI prompt (first two):</span>
          <div className="th-kit-refs">
            {refs.map((a) => (
              <button key={a.id} className="th-kit-ref" onClick={() => onOpen(a.id)} title={a.name}>
                <SetIcon a={a} size={64} />
              </button>
            ))}
          </div>
        </>
      )}
    </section>
  )
}

export function UiArtView({ status, ready }: { status: ThumbStatus | null; ready: boolean }) {
  const { actions } = useStore()
  const h = window.harness
  const [assets, setAssets] = useState<UiAsset[]>([])
  const [kit, setKit] = useState<UiKit | null>(null)
  const [kind, setKind] = useState<UiAssetKind>('button')
  const [ask, setAsk] = useState('')
  const [names, setNames] = useState('')
  const [shape, setShape] = useState<'square' | 'wide' | 'tall'>('square')
  const [n, setN] = useState(UI_KINDS.button.n)
  const [quality, setQuality] = useState('high')
  const [useKit, setUseKit] = useState(true)
  const [builder, setBuilder] = useState<BuilderState>(EMPTY_BUILDER)
  const [builderOpen, setBuilderOpen] = useState(false)
  const [estimate, setEstimate] = useState<ThumbEstimate | null>(null)
  const [making, setMaking] = useState(false)
  const [progress, setProgress] = useState<ThumbsEvents['thumbs:progress'] | null>(null)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [last, setLast] = useState<{ id: string; bestId?: string; set?: string[]; notes: string[] } | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [tab, setTab] = useState<Tab>('latest')
  const [filter, setFilter] = useState<UiAssetKind | 'all'>('all')

  const load = useCallback(async () => {
    try {
      const [list, k] = await Promise.all([h.thumbUiList(), h.thumbUiKit()])
      setAssets(list)
      setKit(k)
    } catch (e) {
      actions.toast({ text: 'Could not load UI art', detail: errorText(e), kind: 'err' })
    }
  }, [actions])
  useEffect(() => {
    void load()
    const off1 = h.on('thumbs:changed', () => void load())
    const off2 = h.on('thumbs:progress', (p) => p.batchId.startsWith('ua-') && setProgress(p.done ? null : p))
    return () => (off1(), off2())
  }, [load])
  useEffect(() => setN(UI_KINDS[kind].n), [kind])
  useEffect(() => {
    if (status) setQuality(status.settings.quality)
  }, [status?.settings.quality])

  const nameList = useMemo(() => (kind === 'icon-set' ? (names.trim() ? splitNames(names) : splitNames(ask)) : []), [kind, names, ask])
  const input = useMemo(() => ({ ask: ask.trim() || 'x', kind, n, quality, useKit, ...(kind === 'icon-set' ? { names: nameList } : {}), ...(kind === 'panel' ? { shape } : {}) }), [ask, kind, n, quality, useKit, nameList, shape])
  useEffect(() => {
    let live = true
    h.thumbUiEstimate(input)
      .then((e) => live && setEstimate(e))
      .catch(() => live && setEstimate(null))
    return () => {
      live = false
    }
  }, [input, status?.settings.model, status?.spentTodayUsd])

  const batches = useMemo(() => {
    const m = new Map<string, UiAsset[]>()
    for (const a of [...assets].sort((x, y) => x.createdAt - y.createdAt || x.id.localeCompare(y.id, undefined, { numeric: true }))) m.set(a.batchId, [...(m.get(a.batchId) ?? []), a])
    return [...m.entries()].map(([id, list]) => ({ id, list, at: Math.max(...list.map((a) => a.createdAt)) })).sort((a, b) => b.at - a.at)
  }, [assets])
  const batch = batches.find((b) => b.id === batchId) ?? batches[0] ?? null
  const set = useMemo(() => {
    if (!batch || batch.list[0]?.kind !== 'icon-set') return []
    const order = last?.id === batch.id && last.set ? last.set : null
    const members = batch.list.filter((a) => (a.setIndex ?? 0) > 0)
    const anchorId = order?.[0] ?? members[0]?.refIds[0]
    const anchor = batch.list.find((a) => a.id === anchorId)
    return [...(anchor ? [anchor] : []), ...members.sort((a, b) => (a.setIndex ?? 0) - (b.setIndex ?? 0))]
  }, [batch, last])
  const bestId = batch ? (last?.id === batch.id ? last.bestId : undefined) ?? [...batch.list].filter((a) => !a.setIndex).sort((a, b) => uiScore(b) - uiScore(a))[0]?.id : undefined
  const current = assets.find((a) => a.id === selected) ?? null
  const shown = useMemo(() => assets.filter((a) => filter === 'all' || a.kind === filter || (filter === 'icon' && a.kind === 'icon-set')), [assets, filter])

  const make = async () => {
    const what = ask.trim()
    if (!what || making) return
    setMaking(true)
    try {
      const sections = builderSections(builder, what, kind)
      const r = await h.thumbUiGenerate({ ...input, ask: what, ...(sections ? { sections } : {}) })
      await load()
      setBatchId(r.id)
      setLast({ id: r.id, bestId: r.bestId, set: r.set, notes: r.notes })
      setSelected(r.bestId ?? r.assets[0]?.id ?? null)
      setTab('latest')
      actions.toast({ text: r.set ? `Icon set: ${r.set.length} icons` : `${r.assets.length} candidate${r.assets.length === 1 ? '' : 's'} made`, detail: r.notes.join(' ') || (r.bestId ? `Best: #${r.bestId.split('-').pop()}` : undefined), kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Could not make UI art', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
      setProgress(null)
    }
  }
  const kitOn = !!kit && kit.samples + kit.refIds.length > 0

  return (
    <>
      <section className="set-sec vfx-make th-make th-ui-make">
        <div className="seg th-kinds" role="radiogroup" aria-label="UI asset kind">
          {UI_KIND_IDS.map((k) => (
            <button key={k} type="button" role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setKind(k)} title={UI_KINDS[k].does}>
              {UI_KINDS[k].label}
            </button>
          ))}
        </div>
        <form
          className="vfx-make-row"
          onSubmit={(e) => {
            e.preventDefault()
            void make()
          }}
        >
          <span className="vfx-make-lead mono">
            <span className="vfx-prompt-sigil">›</span> Make {kind === 'icon-set' ? 'icons:' : `a ${UI_KINDS[kind].label.toLowerCase()}:`}
          </span>
          <input className="input grow" value={ask} onChange={(e) => setAsk(e.target.value)} placeholder={UI_KINDS[kind].example} aria-label="UI asset to make" spellCheck />
          <button className="btn primary" disabled={!ask.trim() || making || !ready || (kind === 'icon-set' && nameList.length < 2)}>
            {making ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make {kind === 'icon-set' ? `${nameList.length || ''} icons`.trim() : n}
          </button>
        </form>
        {progress && (
          <div className="vfx-progress th-progress" role="status">
            <span className="spinner" aria-hidden /> {progress.stage}
            {progress.detail ? <span className="faint"> · {progress.detail}</span> : null}
          </div>
        )}
        <div className="vfx-make-opts">
          {kind === 'icon-set' && (
            <label className="art-opt th-names">
              <span>icons</span>
              <input className="input" value={names} onChange={(e) => setNames(e.target.value)} placeholder={nameList.length ? nameList.join(', ') : 'coin, gem, heart, key'} aria-label="Icon names" />
            </label>
          )}
          {kind === 'panel' && (
            <label className="art-opt">
              <span>shape</span>
              <div className="seg">
                {(['square', 'wide', 'tall'] as const).map((s) => (
                  <button type="button" key={s} className={shape === s ? 'on' : ''} onClick={() => setShape(s)} aria-pressed={shape === s}>
                    {s}
                  </button>
                ))}
              </div>
            </label>
          )}
          <label className="art-opt">
            <span>{kind === 'icon-set' ? 'first-icon picks' : 'candidates'}</span>
            <div className="seg">
              {[1, 2, 3, 4, 6].map((k) => (
                <button type="button" key={k} className={n === k ? 'on' : ''} onClick={() => setN(k)} aria-pressed={n === k}>
                  {k}
                </button>
              ))}
            </div>
          </label>
          <label className="art-opt">
            <span>quality</span>
            <div className="seg">
              {QUALITIES.map((q) => (
                <button type="button" key={q} className={quality === q ? 'on' : ''} onClick={() => setQuality(q)} aria-pressed={quality === q}>
                  {q}
                </button>
              ))}
            </div>
          </label>
          <label className="art-opt th-kit-toggle" title={kitOn ? kit!.lines.join(' · ') : 'Keep or +1 UI art to build a kit'}>
            <input type="checkbox" checked={useKit && kitOn} disabled={!kitOn} onChange={(e) => setUseKit(e.target.checked)} />
            <span>my UI kit</span>
            {kitOn ? <Swatches colors={kit!.palette.slice(0, 5)} /> : <span className="faint">none yet</span>}
          </label>
        </div>
        <PromptBuilder mode={kind} ask={ask} input={{ ...(kind === 'icon-set' ? { names: nameList } : {}) }} state={builder} setState={setBuilder} open={builderOpen} setOpen={setBuilderOpen} />
        {estimate && status?.codex && (
          <div className="note th-est">
            {estimate.n} image{estimate.n === 1 ? '' : 's'} × Codex (ChatGPT plan) · transparent PNG · {CODEX_IMAGE_NOTE}
          </div>
        )}
        {estimate && !status?.codex && (
          <div className={`note mono th-est${estimate.overCap ? ' err-text' : ''}`}>
            {estimate.n} × {usd(estimate.perImageUsd)} ≈ {usd(estimate.totalUsd)} · {estimate.model} {estimate.quality} at {estimate.genSize}
            {UI_KINDS[kind].transparent ? ' · transparent PNG' : ''} · today {usd(estimate.spentTodayUsd)} / {usd(estimate.dailyCapUsd)}
            {estimate.overCap ? ' · over the daily cap' : ''}
          </div>
        )}
      </section>

      <div className="seg vfx-view" role="tablist" aria-label="UI art">
        {(['latest', 'library', 'kit'] as Tab[]).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'library' && assets.length ? <span className="faint"> {assets.length}</span> : null}
            {t === 'kit' && kit?.samples ? <span className="faint"> {kit.samples}</span> : null}
          </button>
        ))}
      </div>

      {tab === 'kit' && <KitView kit={kit} assets={assets} onOpen={(id) => (setSelected(id), setTab('library'))} />}

      {tab !== 'kit' && (
        <div className={`vfx-body th-body${current ? ' has-detail' : ''}`}>
          <div className="vfx-lib">
            {tab === 'latest' &&
              (batch ? (
                <>
                  {batches.length > 1 && (
                    <div className="row th-batches">
                      <select className="input th-sel" value={batch.id} onChange={(e) => (setBatchId(e.target.value), setSelected(null))} aria-label="Batch">
                        {batches.map((b) => (
                          <option key={b.id} value={b.id}>
                            {new Date(b.at).toLocaleString()} · {UI_KINDS[b.list[0].kind].label} · {b.list[0].ask.slice(0, 40)} ({b.list.length})
                          </option>
                        ))}
                      </select>
                    </div>
                  )}
                  <div className="th-batch-head">
                    <span className="mono">{batch.list[0].ask}</span>
                    <span className="faint">
                      {UI_KINDS[batch.list[0].kind].label} · {batch.list.length} image{batch.list.length === 1 ? '' : 's'} · ranked by {batch.list.some((a) => a.critique?.by === 'critic') ? 'the critic + code checks' : 'the code checks'}
                    </span>
                  </div>
                  {last?.id === batch.id && last.notes.length > 0 && <div className="note">{last.notes.join(' ')}</div>}
                  <div className="th-grid th-ui-grid">
                    {batch.list.map((a) => (
                      <UiTile key={a.id} a={a} best={a.id === bestId} selected={a.id === selected} onSelect={() => setSelected(a.id === selected ? null : a.id)} />
                    ))}
                  </div>
                  <SetStrip set={set} />
                </>
              ) : (
                <div className="empty">
                  <Icon name="image" size={22} className="i" />
                  No UI art yet. Pick a kind, describe it in a few words ("green BUY button, glossy") and press Make: the builder adds the Roblox rules (transparent background, readable on a phone, 9-slice friendly).
                </div>
              ))}
            {tab === 'library' && (
              <>
                <div className="row vfx-lib-head">
                  <div className="seg" role="group" aria-label="Filter by kind">
                    {(['all', 'button', 'panel', 'icon', 'hud'] as const).map((f) => (
                      <button key={f} className={filter === f ? 'on' : ''} aria-pressed={filter === f} onClick={() => setFilter(f)}>
                        {f === 'all' ? 'all' : f === 'icon' ? 'icons' : `${UI_KINDS[f].label.toLowerCase()}s`}
                      </button>
                    ))}
                  </div>
                  <span className="note">{shown.length} shown</span>
                </div>
                <div className="th-grid th-ui-grid">
                  {shown.map((a) => (
                    <UiTile key={a.id} a={a} selected={a.id === selected} onSelect={() => setSelected(a.id === selected ? null : a.id)} />
                  ))}
                </div>
              </>
            )}
          </div>
          {current && <UiDetail key={current.id} a={current} status={status} onClose={() => setSelected(null)} />}
        </div>
      )}
    </>
  )
}
