// VFX Lab textures: make custom particle / beam textures (procedural for free, or AI through the
// Art page's OpenAI key and budget), browse the texture library (user + project, rated, tagged),
// upload to Roblox as Image assets and track moderation. Effects reference a texture as
// forgetex://<id>; the preview uses the local file at once and the project files get rbxassetid://
// once it is uploaded.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { TextureGenerateInput, TextureStatus, TintMode, VfxTexture } from '@shared/types'
import { PROCEDURAL_INFO, PROCEDURAL_PARAMS, PROCEDURAL_TYPES, type ProceduralType } from '@shared/vfx/tex/procedural'
import { texRef, TEXTURE_PRESETS, texturePreset, type TextureKind } from '@shared/vfx/tex/textures'
import { FLIPBOOK_GRID } from '@shared/vfx/tex/image'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import './textures.css'

const TINTS: { id: TintMode; label: string; help: string }[] = [
  { id: 'white', label: 'white', help: 'White on transparent: ParticleEmitter.Color / Beam.Color give it any colour, so one texture serves every palette (this is how Roblox’s own sparkles work).' },
  { id: 'grey', label: 'greyscale', help: 'Greyscale with alpha: Color still tints it, and the darker shading stays darker, which gives smoke and debris depth.' },
  { id: 'color', label: 'colour', help: 'Keeps the image’s own colours (AI only). Color multiplies it, so leave Color white to see them as made.' }
]
const FRAMES: { n: number; label: string }[] = [
  { n: 1, label: 'single' },
  { n: 4, label: '2×2' },
  { n: 16, label: '4×4' },
  { n: 64, label: '8×8' }
]

// Texture files as data URLs, cached per id + file + update time.
const urlCache = new Map<string, string | null>()
export function useTextureUrl(t: Pick<VfxTexture, 'id' | 'updatedAt'> | null, which: 'texture' | 'preview' = 'preview'): string | null {
  const key = t ? `${t.id}/${which}@${t.updatedAt}` : ''
  const [url, setUrl] = useState<string | null>(key ? (urlCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!t) return setUrl(null)
    if (urlCache.has(key)) return setUrl(urlCache.get(key) ?? null)
    let live = true
    window.harness
      .vfxTexFile(t.id, which)
      .then((u) => {
        urlCache.set(key, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return url
}

const usd = (v: number) => (v === 0 ? '$0' : v < 0.01 ? '<$0.01' : `$${v.toFixed(v < 1 ? 3 : 2)}`)

export function UploadBadge({ t }: { t: VfxTexture }) {
  if (!t.roblox) return <span className="tag">local</span>
  const m = t.roblox.moderation
  return <span className={`tag ${m === 'Approved' ? 'ok' : m === 'Rejected' ? 'err' : 'warn'}`}>{m === 'Approved' ? 'uploaded' : m === 'Rejected' ? 'rejected' : m === 'Reviewing' ? 'in review' : 'uploaded?'}</span>
}

function TexCard({ t, selected, onSelect }: { t: VfxTexture; selected: boolean; onSelect: () => void }) {
  const url = useTextureUrl(t)
  return (
    <button className={`tex-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected} title={`${t.name}\n${texRef(t.id)}`}>
      <div className="tex-thumb">{url ? <img src={url} alt="" draggable={false} loading="lazy" /> : <span className="spinner" aria-hidden />}</div>
      <div className="tex-cap">
        <span className="tex-name">{t.name}</span>
        {t.rating && <span className={`tag ${t.rating === 'up' ? 'ok' : 'err'}`}>{t.rating === 'up' ? '+1' : '−1'}</span>}
      </div>
      <div className="tex-badges">
        <span className="faint mono">{t.source === 'ai' ? 'ai' : 'proc'}</span>
        {t.flipbook && <span className="faint mono">{t.flipbook.layout.replace('Grid', '')}</span>}
        <span className="faint mono">{t.scope}</span>
        <UploadBadge t={t} />
      </div>
    </button>
  )
}

// Animated flipbook: steps through the cells with CSS (paused when reduced motion is on).
function FlipbookPreview({ url, layout }: { url: string; layout: keyof typeof FLIPBOOK_GRID }) {
  const n = FLIPBOOK_GRID[layout]
  const [frame, setFrame] = useState(0)
  const reduce = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
  useEffect(() => {
    if (reduce) return
    const id = setInterval(() => setFrame((f) => (f + 1) % (n * n)), 1000 / 12)
    return () => clearInterval(id)
  }, [n, reduce])
  const x = frame % n
  const y = Math.floor(frame / n)
  return (
    <div className="tex-flip" role="img" aria-label={`Flipbook ${layout}, frame ${frame + 1} of ${n * n}`}>
      <div className="tex-flip-cell" style={{ backgroundImage: `url(${url})`, backgroundSize: `${n * 100}% ${n * 100}%`, backgroundPosition: `${n > 1 ? (x / (n - 1)) * 100 : 0}% ${n > 1 ? (y / (n - 1)) * 100 : 0}%` }} />
      <span className="mono faint tex-flip-n">
        {frame + 1}/{n * n}
      </span>
    </div>
  )
}

function TexDetail({ t, status, onClose }: { t: VfxTexture; status: TextureStatus | null; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const url = useTextureUrl(t)
  const [tags, setTags] = useState(t.tags.join(', '))
  const [name, setName] = useState(t.name)
  const [busy, setBusy] = useState<string | null>(null)
  useEffect(() => {
    setTags(t.tags.join(', '))
    setName(t.name)
  }, [t.id, t.updatedAt])
  const ref = texRef(t.id)
  const run = async (label: string, fn: () => Promise<unknown>, ok?: string) => {
    setBusy(label)
    try {
      await fn()
      if (ok) actions.toast({ text: ok, kind: 'ok', ms: 2600 })
    } catch (e) {
      actions.toast({ text: `${label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const rate = (r: 'up' | 'down') => run('Rating', () => h.vfxTexRate(t.id, t.rating === r ? null : r), t.rating === r ? undefined : r === 'up' ? 'Saved as a liked texture (memory updated)' : 'Noted as a texture to avoid')
  const canUpload = !!status?.robloxKey && !!status?.creator
  return (
    <section className="vfx-detail tex-detail" aria-label={`${t.name} details`}>
      <div className="vfx-detail-head">
        <Icon name="image" size={13} />
        <b className="vfx-title">{t.name}</b>
        <span className="badge-o">{t.scope}</span>
        <UploadBadge t={t} />
        <span className="grow" />
        <button className={`btn small ghost${t.rating === 'up' ? ' on' : ''}`} aria-pressed={t.rating === 'up'} onClick={() => void rate('up')} title="Good: prefer it for this kind of layer">
          +1
        </button>
        <button className={`btn small ghost${t.rating === 'down' ? ' on' : ''}`} aria-pressed={t.rating === 'down'} onClick={() => void rate('down')} title="Bad: remember to avoid it">
          −1
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className="tex-views">
        <div className="tex-big">{url ? <img src={url} alt={`${t.name} on black`} draggable={false} /> : <span className="spinner" aria-hidden />}</div>
        {t.flipbook && url && <FlipbookPreview url={url} layout={t.flipbook.layout} />}
      </div>
      <div className="vfx-actions">
        <button className="btn small" onClick={() => void actions.copy(ref, 'Texture reference')} title="Paste into any Texture property, or the kit's texture option">
          <Icon name="copy" size={11} /> <span className="mono">{ref}</span>
        </button>
        {!t.roblox && (
          <button className="btn small primary" disabled={!canUpload || !!busy} onClick={() => void run('Upload', () => h.vfxTexUpload(t.id), 'Uploaded as an Image asset')} title={canUpload ? 'Open Cloud upload as an Image asset; effects get its rbxassetid when written to the project' : 'Set the Open Cloud key and creator on the Art page first'}>
            {busy === 'Upload' ? <span className="spinner" aria-hidden /> : <Icon name="upload" size={11} />} Upload to Roblox
          </button>
        )}
        {t.roblox && (
          <>
            <span className="note mono">{t.roblox.uri}</span>
            <button className="btn small" disabled={!!busy} onClick={() => void run('Moderation check', () => h.vfxTexCheck(t.id))} title="Ask Roblox for the moderation state">
              {busy === 'Moderation check' ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Check
            </button>
          </>
        )}
        <span className="grow" />
        <button className="btn small ghost danger" aria-label="Delete texture" onClick={() => confirm(`Delete ${t.name}?`) && void run('Delete', async () => (await h.vfxTexDelete(t.id), onClose()))}>
          <Icon name="trash" size={11} />
        </button>
      </div>
      {!t.roblox && <p className="note tex-hint">Local until uploaded: the preview uses this file now; exported effects use a built-in texture in its place until it is uploaded.</p>}
      {t.roblox?.moderation === 'Reviewing' && <p className="note tex-hint">Roblox is reviewing it; it shows as blank in game until approved. Check again later.</p>}
      {t.roblox?.moderation === 'Rejected' && <p className="note tex-hint err">Rejected by moderation: exported effects fall back to a built-in texture.</p>}
      <dl className="vfx-meta">
        <dt>name</dt>
        <dd>
          <input className="input" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name.trim() && name !== t.name && void h.vfxTexUpdate(t.id, { name })} aria-label="Name" />
        </dd>
        <dt>tags</dt>
        <dd>
          <input className="input" value={tags} onChange={(e) => setTags(e.target.value)} onBlur={() => tags !== t.tags.join(', ') && void h.vfxTexUpdate(t.id, { tags: tags.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean) })} aria-label="Tags" />
        </dd>
        <dt>kind</dt>
        <dd className="mono">
          {t.kind} · {t.tint} · {t.size}px{t.flipbook ? ` · ${t.flipbook.layout} (${t.flipbook.frames} frames)` : ''}
        </dd>
        <dt>made</dt>
        <dd className="mono">
          {t.procedural ? `procedural ${t.procedural.type} seed ${t.procedural.seed} · ${Object.entries(t.procedural.params).map(([k, v]) => `${k} ${Math.round(v * 1000) / 1000}`).join(', ')}` : `${t.model ?? 'AI'}${t.costUsd ? ` · ${usd(t.costUsd)}` : ''}`}
        </dd>
        {t.description && (
          <>
            <dt>about</dt>
            <dd>{t.description}</dd>
          </>
        )}
        {t.flipbook && (
          <>
            <dt>use</dt>
            <dd className="mono">FlipbookLayout {t.flipbook.layout} · FlipbookMode OneShot or Loop</dd>
          </>
        )}
      </dl>
    </section>
  )
}

function Generator({ status, onMade }: { status: TextureStatus | null; onMade: (items: VfxTexture[]) => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [ai, setAi] = useState(false)
  const [kind, setKind] = useState<TextureKind>('ring')
  const [type, setType] = useState<ProceduralType>('ring')
  const [params, setParams] = useState<Record<string, number>>({})
  const [seed, setSeed] = useState(1)
  const [tint, setTint] = useState<TintMode>('white')
  const [frames, setFrames] = useState(1)
  const [desc, setDesc] = useState('')
  const [variants, setVariants] = useState(2)
  const [scope, setScope] = useState<'project' | 'user'>('project')
  const [preview, setPreview] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)

  // Live procedural preview (debounced while dragging).
  useEffect(() => {
    if (ai) return
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      h.vfxTexPreview({ type, params, seed, tint: tint === 'color' ? 'white' : tint, frames })
        .then(setPreview)
        .catch(() => setPreview(null))
    }, 120)
    return () => clearTimeout(timer.current)
  }, [ai, type, JSON.stringify(params), seed, tint, frames])

  const pickKind = (k: TextureKind) => {
    setKind(k)
    const p = texturePreset(k)
    if (p.procedural) {
      setType(p.procedural)
      setParams({})
    }
    setTint(p.tint)
  }
  const pickType = (t: ProceduralType) => {
    setType(t)
    setParams({})
    setKind(t as TextureKind)
    setTint(t === 'smoke' ? 'grey' : 'white')
  }
  const count = ai ? (frames === 4 ? 4 : frames > 4 ? 1 : variants) : 0
  const cost = status ? status.perImageUsd * count : 0
  const over = !!status && status.dailyCapUsd > 0 && status.spentTodayUsd + cost > status.dailyCapUsd

  const make = async () => {
    setBusy(true)
    try {
      const input: TextureGenerateInput = ai
        ? { ai: true, kind, description: desc, tint, frames, n: variants, scope }
        : { procedural: { type, params, seed }, kind, tint: tint === 'color' ? 'white' : tint, frames, scope }
      const items = await h.vfxTexGenerate(input)
      onMade(items)
      actions.toast({ text: `${items.length} texture${items.length === 1 ? '' : 's'} added`, detail: `Use ${texRef(items[0].id)} as Texture, or pick it in the params tab.`, kind: 'ok', ms: 3500 })
    } catch (e) {
      actions.toast({ text: 'Could not make the texture', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }

  const tintHelp = TINTS.find((x) => x.id === tint)!.help
  return (
    <section className="set-sec tex-gen" aria-label="Make a texture">
      <div className="tex-gen-row">
        <div className="seg" role="group" aria-label="Generator">
          <button type="button" className={!ai ? 'on' : ''} aria-pressed={!ai} onClick={() => setAi(false)} title="Drawn in code from parameters: free, instant, exact">
            procedural · free
          </button>
          <button type="button" className={ai ? 'on' : ''} aria-pressed={ai} onClick={() => (setAi(true), tint === 'grey' || setTint(texturePreset(kind).tint))} disabled={status ? !status.openaiKey : false} title={status && !status.openaiKey ? 'Add an OpenAI key in Settings > Providers' : 'OpenAI image model (Art page model and daily budget)'}>
            AI
          </button>
        </div>
        {ai ? (
          <>
            <select className="input" value={kind} onChange={(e) => pickKind(e.target.value as TextureKind)} aria-label="Texture kind">
              {TEXTURE_PRESETS.map((p) => (
                <option key={p.kind} value={p.kind}>
                  {p.label}
                </option>
              ))}
            </select>
            <input className="input grow mono" value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="purple energy wisp with thin filaments" aria-label="Describe the texture" />
          </>
        ) : (
          <div className="seg tex-types" role="group" aria-label="Shape">
            {PROCEDURAL_TYPES.map((t) => (
              <button key={t} type="button" className={type === t ? 'on' : ''} aria-pressed={type === t} onClick={() => pickType(t)} title={PROCEDURAL_INFO[t].use}>
                {t}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="tex-gen-body">
        {!ai && (
          <div className="tex-live" aria-label="Live preview">
            {preview ? <img src={preview} alt={`${type} preview`} draggable={false} /> : <span className="spinner" aria-hidden />}
          </div>
        )}
        <div className="tex-opts">
          {!ai &&
            Object.entries(PROCEDURAL_PARAMS[type]).map(([k, s]) => (
              <label key={k} className="tex-param">
                <span className="faint mono">{s.label}</span>
                <input type="range" min={s.min} max={s.max} step={s.step} value={params[k] ?? s.default} onChange={(e) => setParams({ ...params, [k]: Number(e.target.value) })} aria-label={s.label} />
                <span className="mono tex-val">{Math.round((params[k] ?? s.default) * 1000) / 1000}</span>
              </label>
            ))}
          {!ai && (
            <label className="tex-param">
              <span className="faint mono">seed</span>
              <input className="input mono tex-seed" type="number" min={0} max={100000} value={seed} onChange={(e) => setSeed(Math.max(0, Math.floor(Number(e.target.value) || 0)))} aria-label="Seed" />
              <button type="button" className="btn small ghost" onClick={() => setSeed(Math.floor(Math.random() * 10000))} title="Random seed">
                <Icon name="restart" size={11} />
              </button>
            </label>
          )}
          <div className="tex-opt-row">
            <span className="faint mono">tint</span>
            <div className="seg" role="group" aria-label="Tint mode">
              {TINTS.filter((x) => ai || x.id !== 'color').map((x) => (
                <button key={x.id} type="button" className={tint === x.id ? 'on' : ''} aria-pressed={tint === x.id} onClick={() => setTint(x.id)}>
                  {x.label}
                </button>
              ))}
            </div>
          </div>
          <p className="note tex-tint-help">{tintHelp}</p>
          <div className="tex-opt-row">
            <span className="faint mono">frames</span>
            <div className="seg" role="group" aria-label="Flipbook">
              {FRAMES.map((f) => (
                <button key={f.n} type="button" className={frames === f.n ? 'on' : ''} aria-pressed={frames === f.n} onClick={() => setFrames(f.n)} title={f.n > 1 ? `Flipbook Grid${f.label.replace('×', 'x')} (${f.n} frames)` : 'One texture'}>
                  {f.label}
                </button>
              ))}
            </div>
            {ai && frames === 1 && (
              <>
                <span className="faint mono">variants</span>
                <div className="seg" role="group" aria-label="Variants">
                  {[1, 2, 4].map((k) => (
                    <button key={k} type="button" className={variants === k ? 'on' : ''} aria-pressed={variants === k} onClick={() => setVariants(k)}>
                      {k}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          {frames > 1 && (
            <p className="note tex-tint-help">
              {ai ? (frames === 4 ? 'Four AI variants on one 2×2 sheet: use FlipbookMode Random or Loop for organic flicker.' : 'One AI image, evolved in code (grows, turns and dissolves) across the frames: use FlipbookMode OneShot.') : 'The shape evolves across the frames (rings expand, cracks grow, smoke thins out): use FlipbookMode OneShot.'} Sheets are a power of two up to 1024 px, an exact multiple of the grid (Roblox requires it), with transparent spacing between frames.
            </p>
          )}
        </div>
      </div>

      <div className="tex-gen-foot">
        <select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'user')} aria-label="Save to">
          <option value="project" disabled={!status?.project}>
            this project
          </option>
          <option value="user">your library</option>
        </select>
        {ai && status && (
          <span className={`note mono${over ? ' err' : ''}`}>
            ≈ {usd(cost)} · {usd(status.spentTodayUsd)} of {usd(status.dailyCapUsd)} today · {status.model}
          </span>
        )}
        {!ai && <span className="note">Free and exact: the same parameters always give the same texture.</span>}
        <span className="grow" />
        <button className="btn primary" disabled={busy || (ai && (!desc.trim() && kind === 'other')) || over} onClick={() => void make()}>
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="sparkle" size={11} />} {ai ? 'Generate' : 'Add texture'}
        </button>
      </div>
    </section>
  )
}

export function TextureLab() {
  const { actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<TextureStatus | null>(null)
  const [items, setItems] = useState<VfxTexture[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [kind, setKind] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const [s, list] = await Promise.all([h.vfxTexStatus(), h.vfxTexList()])
      setStatus(s)
      setItems(list)
    } catch (e) {
      actions.toast({ text: 'Could not load textures', detail: errorText(e), kind: 'err' })
    }
  }, [actions])
  useEffect(() => {
    void load()
    return h.on('vfx:textures', () => void load())
  }, [load])

  const kinds = useMemo(() => {
    const m = new Map<string, number>()
    for (const t of items) m.set(t.kind, (m.get(t.kind) ?? 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [items])
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean)
    return items.filter((t) => (!kind || t.kind === kind) && words.every((w) => `${t.name} ${t.kind} ${t.tags.join(' ')} ${t.description}`.toLowerCase().includes(w)))
  }, [items, query, kind])
  const current = items.find((t) => t.id === selected) ?? null

  return (
    <div className="tex-lab">
      <Generator status={status} onMade={(made) => (void load(), setSelected(made[0]?.id ?? null))} />
      <div className={`vfx-body${current ? ' has-detail' : ''}`}>
        <div className="vfx-lib">
          <div className="row vfx-lib-head">
            <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search textures" aria-label="Search textures" />
            <span className="note">
              {status ? `${status.counts.project} project · ${status.counts.user} yours` : ''} · {shown.length} shown
            </span>
          </div>
          {kinds.length > 1 && (
            <div className="vfx-chips" role="group" aria-label="Filter by kind">
              {kinds.map(([k, n]) => (
                <button key={k} className={`badge-o${kind === k ? ' hot' : ''}`} aria-pressed={kind === k} onClick={() => setKind(kind === k ? null : k)}>
                  {k} <span className="faint">{n}</span>
                </button>
              ))}
            </div>
          )}
          {!items.length && status && (
            <div className="empty">
              <Icon name="image" size={22} className="i" />
              No custom textures yet. Shape one above (free), or describe one for the AI. Effects can also ask for a procedural texture by shape: forgetex://gen/ring.
            </div>
          )}
          <div className="tex-grid">
            {shown.map((t) => (
              <TexCard key={t.id} t={t} selected={t.id === selected} onSelect={() => setSelected(t.id === selected ? null : t.id)} />
            ))}
          </div>
        </div>
        {current && <TexDetail key={current.id} t={current} status={status} onClose={() => setSelected(null)} />}
      </div>
    </div>
  )
}
