// Thumbnail Lab: reference thumbnails (style only) -> style profiles; bases from the real game
// (screenshots or a Studio capture); "Make a thumbnail of ___" generates N 1920x1080 variations in
// one image call, the critic scores each and picks the best; refine, rate, "would ship", manual CTR,
// upload to Roblox. Mirrors the VFX Lab layout (make box, tabs, grid + detail panel).
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { Thumb, ThumbBase, ThumbEstimate, ThumbRef, ThumbStatus, ThumbStyleProfile, TasteView, ThumbsEvents } from '@shared/types'
import { batchOf } from '@shared/thumbs/size'
import { CODEX_IMAGE_NOTE } from '@shared/artTypes'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { useRestateGate } from '../../components/useRestateGate'
import { PrinciplePriorities } from '../principles/Principles'
import { LabCostLine } from '../gating/LabGating'
import { DiscoveryStrip, ProfileCard, RefCard, ThumbCard, ctrText, useThumbFile } from './parts'
import { ThumbDetail } from './ThumbDetail'
import '../vfx/vfx.css'
import './thumbs.css'

type Tab = 'variations' | 'references' | 'styles' | 'library' | 'priorities'
const TABS: { id: Tab; title: string }[] = [
  { id: 'variations', title: 'The latest batch, the discovery preview and the critique' },
  { id: 'references', title: 'Thumbnails you like (from any game): they teach style only' },
  { id: 'styles', title: 'Named style profiles built from references' },
  { id: 'library', title: 'Every thumbnail made, with ratings and CTR' },
  { id: 'priorities', title: 'Which thumbnail principles count most for you' }
]
const SUGGESTIONS = ['escaping a giant shark', 'the boss fight in the lava cave', 'racing past the finish line', 'opening a legendary egg']
const QUALITIES = ['low', 'medium', 'high']
const usd = (x: number) => `$${x < 1 ? x.toFixed(3) : x.toFixed(2)}`

// The best of a batch: the server's pick when we have it, else the top critique without copy flags.
function bestOf(thumbs: Thumb[], picked?: string): string | undefined {
  if (picked && thumbs.some((t) => t.id === picked)) return picked
  const ok = thumbs.filter((t) => !(t.critique?.copyFlags.length ?? 0) && t.critique)
  return ok.sort((a, b) => b.critique!.overall - a.critique!.overall)[0]?.id
}

function BaseChip({ b, on, onToggle, onDelete }: { b: ThumbBase; on: boolean; onToggle: () => void; onDelete: () => void }) {
  const url = useThumbFile('base', b.id, 'image', b.createdAt)
  return (
    <span className={`th-base${on ? ' on' : ''}`}>
      <button type="button" className="th-base-img" onClick={onToggle} aria-pressed={on} title={on ? 'Used as a base (real game shot)' : 'Use as a base'}>
        {url ? <img src={url} alt="" draggable={false} /> : <span className="th-ph" />}
        <span className="th-check" aria-hidden>{on && <Icon name="check" size={10} />}</span>
      </button>
      <span className="th-base-name mono" title={b.name}>
        {b.source === 'studio' && <Icon name="studio" size={9} />} {b.name}
      </span>
      <button type="button" className="btn small ghost danger th-base-x" onClick={onDelete} aria-label={`Delete base ${b.name}`}>
        <Icon name="x" size={9} />
      </button>
    </span>
  )
}

function LibRow({ t, on, onOpen }: { t: Thumb; on: boolean; onOpen: () => void }) {
  const url = useThumbFile('thumb', t.id, 's160', t.updatedAt)
  return (
    <tr className={on ? 'on' : ''}>
      <td>
        <button className="th-lib-img" onClick={onOpen} aria-label={`Open #${t.id}`}>
          {url && <img src={url} alt="" width={96} height={54} draggable={false} />}
        </button>
      </td>
      <td className="th-lib-brief">
        <button className="th-link" onClick={onOpen}>
          {t.brief}
        </button>
        <span className="faint mono">
          {' '}
          #{t.id.split('-').pop()}
          {t.round ? ` r${t.round}` : ''} · {new Date(t.createdAt).toLocaleDateString()}
        </span>
      </td>
      <td className="num mono">{t.critique ? t.critique.overall.toFixed(1) : '–'}</td>
      <td>
        {t.rating === 'up' && <span className="tag ok">+1</span>}
        {t.rating === 'down' && <span className="tag err">−1</span>}
        {t.ship && <span className="tag ok">ship</span>}
      </td>
      <td className="num mono">{ctrText(t)}</td>
      <td>{t.experience ? <span className="tag ok">live</span> : t.roblox ? <span className="tag info">uploaded</span> : <span className="faint">–</span>}</td>
    </tr>
  )
}

export function ThumbLabPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<ThumbStatus | null>(null)
  const [refs, setRefs] = useState<ThumbRef[]>([])
  const [profiles, setProfiles] = useState<ThumbStyleProfile[]>([])
  const [bases, setBases] = useState<ThumbBase[]>([])
  const [thumbs, setThumbs] = useState<Thumb[]>([])
  const [taste, setTaste] = useState<TasteView | null>(null)
  const [tab, setTab] = useState<Tab>('variations')
  const [brief, setBrief] = useState('')
  const [profileId, setProfileId] = useState<string>('')
  const [baseIds, setBaseIds] = useState<string[]>([])
  const [n, setN] = useState(4)
  const [quality, setQuality] = useState('high')
  const [estimate, setEstimate] = useState<ThumbEstimate | null>(null)
  const [making, setMaking] = useState(false)
  const [batchId, setBatchId] = useState<string | null>(null)
  const [picked, setPicked] = useState<Record<string, string>>({})
  const [selected, setSelected] = useState<string | null>(null)
  const [progress, setProgress] = useState<ThumbsEvents['thumbs:progress'] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [url, setUrl] = useState('')
  const [game, setGame] = useState('')
  const [chosen, setChosen] = useState<string[]>([])
  const [profileName, setProfileName] = useState('')
  const [libQuery, setLibQuery] = useState('')
  const [baseInit, setBaseInit] = useState(false)

  const load = useCallback(async () => {
    try {
      const [s, r, p, b, t, tv] = await Promise.all([h.thumbStatus(), h.thumbRefs(), h.thumbProfiles(), h.thumbBases(), h.thumbList(), h.thumbTaste()])
      setStatus(s)
      setRefs(r)
      setProfiles(p)
      setBases(b)
      setThumbs(t)
      setTaste(tv)
    } catch (e) {
      actions.toast({ text: 'Could not load the Thumbnail Lab', detail: errorText(e), kind: 'err' })
    }
  }, [actions])

  useEffect(() => {
    void load()
  }, [state.project?.root])
  useEffect(() => {
    const off1 = h.on('thumbs:changed', () => void load())
    const off2 = h.on('thumbs:progress', (p) => setProgress(p.done ? null : p))
    return () => (off1(), off2())
  }, [load])
  // Defaults from the settings and the library, once.
  useEffect(() => {
    if (!status) return
    setN(status.settings.n)
    setQuality(status.settings.quality)
  }, [status?.settings.n, status?.settings.quality])
  useEffect(() => {
    if (!profileId && profiles[0]) setProfileId(profiles[0].id)
  }, [profiles])
  useEffect(() => {
    if (!baseInit && bases.length) {
      setBaseIds(bases.slice(0, 2).map((b) => b.id))
      setBaseInit(true)
    }
  }, [bases])

  const input = useMemo(() => ({ brief: brief.trim() || 'x', ...(profileId ? { profileId } : {}), baseIds, n, quality }), [brief, profileId, baseIds, n, quality])
  useEffect(() => {
    let live = true
    h.thumbEstimate(input)
      .then((e) => live && setEstimate(e))
      .catch(() => live && setEstimate(null))
    return () => {
      live = false
    }
  }, [input, status?.settings.model, status?.spentTodayUsd])

  // Batches, newest first.
  const batches = useMemo(() => {
    const m = new Map<string, Thumb[]>()
    for (const t of [...thumbs].sort((a, b) => a.createdAt - b.createdAt)) {
      const k = t.batchId || batchOf(t.id)
      m.set(k, [...(m.get(k) ?? []), t])
    }
    return [...m.entries()].map(([id, list]) => ({ id, thumbs: list, at: Math.max(...list.map((t) => t.createdAt)) })).sort((a, b) => b.at - a.at)
  }, [thumbs])
  const batch = batches.find((b) => b.id === batchId) ?? batches[0] ?? null
  const best = batch ? bestOf(batch.thumbs, picked[batch.id]) : undefined
  const current = thumbs.find((t) => t.id === selected) ?? null

  const restate = useRestateGate('thumbs')
  const make = async () => {
    const what = brief.trim()
    if (!what || making) return
    setMaking(true)
    try {
      const g = await restate.gate(what)
      if (!g) return
      const r = await h.thumbGenerate({ ...input, brief: what, ...(g.restatement ? { restatement: g.restatement } : {}), source: 'page' })
      await load()
      setBatchId(r.id)
      if (r.bestId) setPicked((m) => ({ ...m, [r.id]: r.bestId! }))
      setSelected(r.bestId ?? r.thumbs[0]?.id ?? null)
      setTab('variations')
      setBrief('')
      actions.toast({ text: `${r.thumbs.length} variation${r.thumbs.length === 1 ? '' : 's'} made`, detail: r.bestId ? `Best: #${r.bestId.split('-').pop()}` : undefined, kind: 'ok', ms: 3000 })
    } catch (e) {
      actions.toast({ text: 'Could not make thumbnails', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
      setProgress(null)
    }
  }

  const guard = async (label: string, fn: () => Promise<unknown>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      actions.toast({ text: `${label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const addRefs = (inputs: { paths?: string[]; urls?: string[]; dataUrls?: string[] }) =>
    guard('Adding references', async () => {
      const r = await h.thumbAddRefs({ ...inputs, ...(game.trim() ? { game: game.trim() } : {}) })
      await load()
      setTab('references')
      actions.toast({
        text: `${r.added.length} reference${r.added.length === 1 ? '' : 's'} added`,
        detail: r.skipped.length ? `Skipped: ${r.skipped.map((s) => `${s.item.slice(0, 40)} (${s.reason})`).join('; ')}` : 'Reading the style of each…',
        kind: r.added.length ? 'ok' : 'info'
      })
    })
  const chooseRefs = async () => {
    const paths = await h.thumbChooseImages()
    if (paths.length) await addRefs({ paths })
  }
  const addBases = async () => {
    const paths = await h.thumbChooseImages()
    if (!paths.length) return
    await guard('Adding screenshots', async () => {
      const added = await h.thumbAddBases(paths)
      await load()
      setBaseIds((ids) => [...ids, ...added.map((b) => b.id)].slice(-6))
    })
  }
  const capture = () =>
    guard('Studio capture', async () => {
      const b = await h.thumbCaptureStudio()
      await load()
      setBaseIds((ids) => [...ids, b.id].slice(-6))
      actions.toast({ text: 'Captured the Studio view', detail: b.name, kind: 'ok', ms: 2500 })
    })

  const readFiles = (files: File[]): Promise<string[]> =>
    Promise.all(
      files.map(
        (f) =>
          new Promise<string>((res) => {
            const fr = new FileReader()
            fr.onload = () => res(String(fr.result ?? ''))
            fr.onerror = () => res('')
            fr.readAsDataURL(f)
          })
      )
    ).then((l) => l.filter(Boolean))
  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const files = [...e.dataTransfer.files].filter((f) => f.type.startsWith('image/'))
    const paths = files.map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean)
    const urls = (e.dataTransfer.getData('text/uri-list') || '')
      .split(/\r?\n/)
      .filter((l) => /^https?:\/\//.test(l))
    if (paths.length) return addRefs({ paths, urls })
    if (files.length) return addRefs({ dataUrls: await readFiles(files), urls })
    if (urls.length) return addRefs({ urls })
  }
  const onPaste = async (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.files].filter((f) => f.type.startsWith('image/'))
    if (!files.length) return
    e.preventDefault()
    await addRefs({ dataUrls: await readFiles(files) })
  }
  const saveProfile = () =>
    guard('Saving the style profile', async () => {
      const p = await h.thumbSaveProfile({ name: profileName.trim() || `Style ${profiles.length + 1}`, refIds: chosen })
      setChosen([])
      setProfileName('')
      await load()
      setProfileId(p.id)
      setTab('styles')
    })

  const setModel = (model: string) => guard('Saving the model', async () => setStatus(await h.thumbSetSettings({ model })))
  const libShown = useMemo(() => {
    const w = libQuery.toLowerCase().split(/\s+/).filter(Boolean)
    return [...thumbs].sort((a, b) => b.createdAt - a.createdAt).filter((t) => w.every((x) => t.brief.toLowerCase().includes(x)))
  }, [thumbs, libQuery])
  const gameName = state.project?.name ?? 'Your experience'
  // Codex (ChatGPT plan) backend from the Art page: no key or cost.
  const imagesReady = status?.codex ? status.codex.ready : !!status?.openaiKey
  const ready = imagesReady && !!status?.project

  return (
    <div className="page">
      <div className="page-inner vfx th" onPaste={onPaste}>
        <div className="page-head">
          <div>
            <h1>Thumbnail Lab</h1>
            <div className="sub">
              {status ? `${status.counts.refs} references · ${status.counts.profiles} style${status.counts.profiles === 1 ? '' : 's'} · ${status.counts.bases} game shots · ${status.counts.thumbs} made` : 'loading…'}
              {taste && taste.samples > 0 ? ` · taste from ${taste.samples} labels${taste.ctrSamples ? ` (${taste.ctrSamples} CTR)` : ''}` : ''}
            </div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void chooseRefs()} title="Thumbnails you like from popular games: they teach the style only">
              <Icon name="image" size={12} /> Add references
            </button>
            <button className="btn" onClick={() => void capture()} disabled={!status?.project || !!busy} title={status?.studio.message ?? 'Capture the current Studio viewport as a base'}>
              <Icon name="studio" size={12} /> Capture Studio
            </button>
          </div>
        </div>

        {status && (!imagesReady || !status.project || !status.vision) && (
          <div className="callout row">
            <Icon name="info" size={12} />
            <span className="grow note">
              {status.codex && !status.codex.ready && <>Codex (ChatGPT plan) is the image backend but is not ready: {status.codex.detail} </>}
              {!status.codex && !status.openaiKey && <>No OpenAI key: add it on the Art page (it stays in the OS keychain). </>}
              {!status.project && <>Open a project: game shots and thumbnails are saved in it. </>}
              {!status.vision && <>No vision model: style cards and critiques use the code checks only. </>}
            </span>
          </div>
        )}

        <section className="set-sec vfx-make th-make">
          <form
            className="vfx-make-row"
            onSubmit={(e) => {
              e.preventDefault()
              void make()
            }}
          >
            <span className="vfx-make-lead mono">
              <span className="vfx-prompt-sigil">›</span> Make a thumbnail of
            </span>
            <input className="input grow" value={brief} onChange={(e) => setBrief(e.target.value)} placeholder="a player escaping a giant shark" aria-label="Thumbnail to make" spellCheck />
            <button className="btn primary" disabled={!brief.trim() || making || !ready}>
              {making && !restate.waiting ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Make {n}
            </button>
          </form>
          {restate.node}
          {progress && (
            <div className="vfx-progress th-progress" role="status">
              <span className="spinner" aria-hidden /> {progress.stage}
              {progress.detail ? <span className="faint"> · {progress.detail}</span> : null}
            </div>
          )}
          <div className="th-bases" role="group" aria-label="Game shots to build on">
            <span className="th-label mono">from the game</span>
            {bases.map((b) => (
              <BaseChip
                key={b.id}
                b={b}
                on={baseIds.includes(b.id)}
                onToggle={() => setBaseIds((ids) => (ids.includes(b.id) ? ids.filter((x) => x !== b.id) : [...ids, b.id].slice(-6)))}
                onDelete={() => void guard('Deleting the shot', async () => (await h.thumbDeleteBase(b.id), setBaseIds((ids) => ids.filter((x) => x !== b.id)), await load()))}
              />
            ))}
            <button type="button" className="btn small" onClick={() => void addBases()} disabled={!status?.project}>
              <Icon name="plus" size={10} /> screenshots
            </button>
            <button type="button" className="btn small" onClick={() => void capture()} disabled={!status?.project || !!busy}>
              <Icon name="studio" size={10} /> Capture Studio
            </button>
            {!bases.length && <span className="note">No game shots yet: without one the image is generated from the brief alone and may not look like your game.</span>}
          </div>
          <div className="vfx-make-opts">
            <label className="art-opt">
              <span>style</span>
              <select className="input th-sel" value={profileId} onChange={(e) => setProfileId(e.target.value)} aria-label="Style profile">
                <option value="">none</option>
                {profiles.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
            </label>
            <label className="art-opt">
              <span>variations</span>
              <div className="seg">
                {[1, 2, 4, 6, 10].map((k) => (
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
            <label className="art-opt">
              <span>model</span>
              <select className="input th-sel mono" value={status?.settings.model ?? ''} onChange={(e) => void setModel(e.target.value)} aria-label="Image model">
                {(status?.models ?? []).map((m) => (
                  <option key={m} value={m}>
                    {m}
                    {m === 'gpt-image-1-mini' ? ' (cheap)' : ''}
                  </option>
                ))}
              </select>
            </label>
            <span className="vfx-sugg">
              {SUGGESTIONS.map((s) => (
                <button key={s} type="button" className="badge-o" onClick={() => setBrief(s)}>
                  {s}
                </button>
              ))}
            </span>
          </div>
          {estimate && status?.codex && (
            <div className="note th-est">
              {estimate.n} × Codex (ChatGPT plan) → 1920×1080 · {CODEX_IMAGE_NOTE}
            </div>
          )}
          {estimate && !status?.codex && (
            <div className={`note mono th-est${estimate.overCap ? ' err-text' : ''}`}>
              {estimate.n} × {usd(estimate.perImageUsd)} = {usd(estimate.totalUsd)} · {estimate.model} {estimate.quality} at {estimate.genSize} → 1920×1080 · today {usd(estimate.spentTodayUsd)} / {usd(estimate.dailyCapUsd)}
              {estimate.overCap ? ' · over the daily cap' : ''}
            </div>
          )}
          <LabCostLine lab="thumbs" />
        </section>

        <div className="seg vfx-view" role="tablist" aria-label="Thumbnail Lab">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={tab === t.id ? 'on' : ''} onClick={() => setTab(t.id)} title={t.title}>
              {t.id}
              {t.id === 'references' && refs.length ? <span className="faint"> {refs.length}</span> : null}
              {t.id === 'styles' && profiles.length ? <span className="faint"> {profiles.length}</span> : null}
            </button>
          ))}
        </div>

        {tab === 'priorities' && <PrinciplePriorities domains={['thumb']} />}

        {tab === 'variations' && (
          <div className={`vfx-body th-body${current ? ' has-detail' : ''}`}>
            <div className="vfx-lib">
              {batches.length > 1 && (
                <div className="row th-batches">
                  <select className="input th-sel" value={batch?.id ?? ''} onChange={(e) => (setBatchId(e.target.value), setSelected(null))} aria-label="Batch">
                    {batches.map((b) => (
                      <option key={b.id} value={b.id}>
                        {new Date(b.at).toLocaleString()} · {b.thumbs[0].brief.slice(0, 48)} ({b.thumbs.length})
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {batch ? (
                <>
                  <div className="th-batch-head">
                    <span className="mono">{batch.thumbs[0].brief}</span>
                    <span className="faint">
                      {batch.thumbs.length} variation{batch.thumbs.length === 1 ? '' : 's'} · ranked by critic + your taste, copies never win
                    </span>
                  </div>
                  <div className="th-grid">
                    {batch.thumbs.map((t) => (
                      <ThumbCard key={t.id} thumb={t} best={t.id === best} selected={t.id === selected} onSelect={() => setSelected(t.id === selected ? null : t.id)} />
                    ))}
                  </div>
                  <DiscoveryStrip thumbs={batch.thumbs} game={gameName} />
                </>
              ) : (
                <div className="empty">
                  <Icon name="thumbnail" size={22} className="i" />
                  No thumbnails yet. Add a few references you like, capture your game in Studio, then make a thumbnail.
                </div>
              )}
            </div>
            {current && <ThumbDetail key={current.id} thumb={current} status={status} busy={busy} onClose={() => setSelected(null)} onRefined={(id) => void load().then(() => setSelected(id))} />}
          </div>
        )}

        {tab === 'references' && (
          <div className="th-refs">
            <div
              className={`vfx-drop${drag ? ' drag' : ''}`}
              onDragOver={(e) => (e.preventDefault(), setDrag(true))}
              onDragLeave={() => setDrag(false)}
              onDrop={(e) => void onDrop(e)}
              role="button"
              tabIndex={0}
              onClick={() => void chooseRefs()}
              onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void chooseRefs())}
            >
              {busy ? (
                <>
                  <span className="spinner" aria-hidden /> {busy}…
                </>
              ) : (
                <>
                  <Icon name="download" size={13} /> Drop, paste or pick thumbnails you like <span className="faint mono">png · jpg · webp · they teach style only: never characters, logos or text</span>
                </>
              )}
            </div>
            <form
              className="row th-url"
              onSubmit={(e) => {
                e.preventDefault()
                if (/^https?:\/\//.test(url.trim())) void addRefs({ urls: [url.trim()] }).then(() => setUrl(''))
              }}
            >
              <input className="input grow mono" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://… image URL (downloaded and kept locally)" aria-label="Image URL" />
              <input className="input th-game" value={game} onChange={(e) => setGame(e.target.value)} placeholder="from game (optional)" aria-label="Game it came from" />
              <button className="btn small" disabled={!/^https?:\/\//.test(url.trim())}>
                <Icon name="plus" size={10} /> Add
              </button>
            </form>
            {chosen.length > 0 && (
              <form
                className="callout row th-mkprof"
                onSubmit={(e) => {
                  e.preventDefault()
                  void saveProfile()
                }}
              >
                <span className="mono">{chosen.length} selected</span>
                <input className="input grow" value={profileName} onChange={(e) => setProfileName(e.target.value)} placeholder="style name, e.g. Big faces, loud colour" aria-label="Style profile name" />
                <button type="button" className="btn small ghost" onClick={() => setChosen([])}>
                  Clear
                </button>
                <button className="btn small primary">Make style profile</button>
              </form>
            )}
            {!refs.length && status && <div className="empty">No references yet. Drop thumbnails from games whose style you like; each gets a style card (framing, palette, outline, text, emotion).</div>}
            <div className="th-ref-grid">
              {refs.map((r) => (
                <RefCard
                  key={r.id}
                  r={r}
                  selected={chosen.includes(r.id)}
                  onToggle={() => setChosen((c) => (c.includes(r.id) ? c.filter((x) => x !== r.id) : [...c, r.id]))}
                  onDelete={() => void guard('Deleting the reference', async () => (await h.thumbDeleteRef(r.id), await load()))}
                />
              ))}
            </div>
          </div>
        )}

        {tab === 'styles' && (
          <div className="th-profs">
            {!profiles.length && <div className="empty">No style profiles. Select references on the references tab and make one.</div>}
            {profiles.map((p) => (
              <ProfileCard key={p.id} p={p} refs={refs} active={p.id === profileId} onUse={() => setProfileId(p.id === profileId ? '' : p.id)} onDelete={() => void guard('Deleting the style', async () => (await h.thumbDeleteProfile(p.id), await load()))} />
            ))}
          </div>
        )}

        {tab === 'library' && (
          <div className={`vfx-body th-body${current ? ' has-detail' : ''}`}>
            <div className="vfx-lib">
              {taste && (
                <section className="th-taste" aria-label="Learned taste">
                  <div className="th-sec-head">
                    <span className="mono">your taste</span>
                    <span className="faint">
                      {taste.samples ? `${taste.samples} labels (${taste.ctrSamples} from CTR, which count most) · ranks new variations` : 'rate variations, mark "would ship" or add CTR to teach it'}
                    </span>
                  </div>
                  {taste.lines.length > 0 && (
                    <ul className="th-taste-lines">
                      {taste.lines.map((l) => (
                        <li key={l}>{l}</li>
                      ))}
                    </ul>
                  )}
                </section>
              )}
              <div className="row vfx-lib-head">
                <input className="input grow" value={libQuery} onChange={(e) => setLibQuery(e.target.value)} placeholder="Search briefs" aria-label="Search thumbnails" />
                <span className="note">{libShown.length} shown</span>
              </div>
              <div className="th-lib-wrap">
                <table className="th-table th-lib">
                  <thead>
                    <tr>
                      <th aria-label="Image" />
                      <th>brief</th>
                      <th className="num">score</th>
                      <th>label</th>
                      <th className="num">CTR</th>
                      <th>roblox</th>
                    </tr>
                  </thead>
                  <tbody>
                    {libShown.map((t) => (
                      <LibRow key={t.id} t={t} on={t.id === selected} onOpen={() => setSelected(t.id === selected ? null : t.id)} />
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            {current && <ThumbDetail key={current.id} thumb={current} status={status} busy={busy} onClose={() => setSelected(null)} onRefined={(id) => void load().then(() => setSelected(id))} />}
          </div>
        )}
      </div>
    </div>
  )
}
