// Art page: prompt box with presets and a cost estimate, a gallery of concepts by date, and a detail
// view (regenerate, variations, edit, import to Roblox, copy id, insert a Vide ImageLabel, save,
// send to chat, delete with undo). Keys never reach this page; it only sees whether they are set.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ArtCostEstimate, ArtGenerateInput, ArtItem, ArtQuality, ArtRegistryEntry, ArtSettings, ArtStatus, ArtStyleId } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import { CODEX_IMAGE_NOTE } from '@shared/artTypes'
import { attachImageToChat } from '../../assistant/attachments'
import { insertIntoComponent, isComponentPath, videImageLabel, IMAGES_REQUIRE } from './videSnippet'
import './art.css'

const SIZES = ['1024x1024', '1536x1024', '1024x1536', '1920x1088', 'auto']
const QUALITIES: ArtQuality[] = ['low', 'medium', 'high', 'xhigh', 'max']
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(n < 1 ? 3 : 2)}`)
const base = (p: string) => p.split(/[\\/]/).pop() ?? p
const regName = (s: string) =>
  s
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w[0].toUpperCase() + w.slice(1))
    .join('')
    .replace(/^(\d)/, 'Image$1')
    .slice(0, 60) || 'Image'

function dayLabel(date: string): string {
  const d = new Date()
  const iso = (t: Date) => `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`
  if (date === iso(d)) return 'Today'
  d.setDate(d.getDate() - 1)
  if (date === iso(d)) return 'Yesterday'
  return ''
}

// Cached previews: path -> data URL.
const thumbCache = new Map<string, string>()
function useThumb(path: string | null, full = false): string | null {
  const key = path ? `${full ? 'f:' : ''}${path}` : ''
  const [url, setUrl] = useState<string | null>(key ? (thumbCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!path) return setUrl(null)
    const hit = thumbCache.get(key)
    if (hit) return setUrl(hit)
    let live = true
    setUrl(null)
    window.harness
      .artThumbnail(path, full)
      .then((u) => {
        thumbCache.set(key, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return url
}

function Thumb({ item, selected, onSelect }: { item: ArtItem; selected: boolean; onSelect: () => void }) {
  const url = useThumb(item.path)
  return (
    <button className={`art-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected} title={item.prompt || item.path}>
      <div className={`art-img${item.background === 'transparent' ? ' checker' : ''}`}>{url ? <img src={url} alt={item.prompt || base(item.path)} loading="lazy" draggable={false} /> : <span className="art-ph" />}</div>
      <div className="art-cap">
        <span className="art-name">
          {item.slug}-{item.index}
        </span>
        {item.roblox && <span className="tag ok" title={item.roblox.uri}>rbx</span>}
        {item.source === 'agent' && <span className="tag hot" title="Made by an agent">ai</span>}
      </div>
    </button>
  )
}

function KeyCard({ status, onStatus }: { status: ArtStatus; onStatus: (s: ArtStatus) => void }) {
  const { actions } = useStore()
  const [key, setKey] = useState('')
  const [scope, setScope] = useState<'project' | 'global'>('project')
  const [ids, setIds] = useState({ user: status.settings.creatorUserId ? String(status.settings.creatorUserId) : '', group: status.settings.creatorGroupId ? String(status.settings.creatorGroupId) : '' })
  const save = async (patch: Partial<ArtSettings>) => {
    try {
      onStatus(await window.harness.artSetSettings(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save art settings', detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <section className="set-sec art-setup">
      <h2>
        Roblox import <span className="grow" />
        {status.robloxKey ? <span className="badge-o ok">key {status.robloxKeySource === 'release' ? 'from Release' : 'set'}</span> : <span className="badge-o warn">no key</span>}
      </h2>
      <p className="note">
        Create an Open Cloud API key at{' '}
        <a href="https://create.roblox.com/dashboard/credentials" target="_blank" rel="noreferrer">
          create.roblox.com/dashboard/credentials
        </a>{' '}
        with the <span className="mono">Assets API</span> and the scopes <span className="mono">asset:read</span> + <span className="mono">asset:write</span> (it can be the same key as Release; add the scopes there). Group-owned images need a group key. The key stays in the OS keychain.
      </p>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Open Cloud API key</div>
          <div className="note">write-only{status.robloxKeySource === 'release' ? ' · using the Release key until you set one here' : ''}</div>
        </div>
        <form className="set-ctl" onSubmit={async (e) => (e.preventDefault(), key.trim() && (onStatus(await window.harness.artSetRobloxKey(key.trim(), scope).catch((err) => (actions.toast({ text: 'Key not saved', detail: errorText(err), kind: 'err' }), status))), setKey('')))}>
          <input className="input" type="password" style={{ width: 180 }} value={key} onChange={(e) => setKey(e.target.value)} placeholder="Open Cloud API key" autoComplete="off" spellCheck={false} aria-label="Open Cloud API key" />
          <select className="input" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'global')} aria-label="Key scope">
            <option value="project">this project</option>
            <option value="global">all projects</option>
          </select>
          <button className="btn small primary" disabled={!key.trim()}>Save</button>
          {status.robloxKeySource === 'art' && (
            <button type="button" className="btn small danger" onClick={async () => onStatus(await window.harness.artClearRobloxKey('project'))}>
              Clear
            </button>
          )}
        </form>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Creator</div>
          <div className="note">Your Roblox user ID, or a group ID for group-owned assets.</div>
        </div>
        <form className="set-ctl" onSubmit={(e) => (e.preventDefault(), void save(ids.group ? { creatorGroupId: Number(ids.group) } : { creatorUserId: Number(ids.user) || undefined }))}>
          <input className="input" inputMode="numeric" style={{ width: 110 }} placeholder="User ID" value={ids.user} onChange={(e) => setIds({ user: e.target.value.replace(/\D/g, ''), group: '' })} aria-label="Creator user ID" />
          <input className="input" inputMode="numeric" style={{ width: 110 }} placeholder="Group ID" value={ids.group} onChange={(e) => setIds({ group: e.target.value.replace(/\D/g, ''), user: '' })} aria-label="Creator group ID" />
          <button className="btn small" disabled={!ids.user && !ids.group}>Set</button>
        </form>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Asset type</div>
          <div className="note">Image ids work directly in ImageLabel.Image; Decal also makes a decal.</div>
        </div>
        <div className="set-ctl">
          <div className="seg">
            {(['Image', 'Decal'] as const).map((t) => (
              <button key={t} className={status.settings.assetType === t ? 'on' : ''} onClick={() => void save({ assetType: t })}>
                {t}
              </button>
            ))}
          </div>
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Git</div>
          <div className="note">art/concepts is tracked by default; files over 5 MB go in art/.gitignore.</div>
        </div>
        <div className="set-ctl">
          <select className="input" value={status.settings.gitPolicy} onChange={(e) => void save({ gitPolicy: e.target.value as ArtSettings['gitPolicy'] })} aria-label="Git policy">
            <option value="track-small">track, ignore files over 5 MB</option>
            <option value="track">track everything</option>
            <option value="ignore">ignore art/</option>
          </select>
        </div>
      </div>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Daily image budget</div>
          <div className="note">Generations (yours and agents') stop at this estimate per day. 0 = no cap. Not used on the Codex (ChatGPT plan) backend.</div>
        </div>
        <div className="set-ctl">
          <div className="unit-input">
            <span className="unit">$</span>
            <input className="input" inputMode="decimal" defaultValue={status.settings.dailyCapUsd} onBlur={(e) => void save({ dailyCapUsd: Math.max(0, Number(e.target.value) || 0) })} aria-label="Daily budget in dollars" />
          </div>
        </div>
      </div>
    </section>
  )
}

function Detail({ item, status, registry, onClose, onChanged, onCompose }: {
  item: ArtItem
  status: ArtStatus
  registry: ArtRegistryEntry[]
  onClose: () => void
  onChanged: (next?: ArtItem) => void
  onCompose: (patch: Partial<ArtGenerateInput>, run?: boolean) => void
}) {
  const { state, actions } = useStore()
  const full = useThumb(item.path, true)
  const [name, setName] = useState(item.roblox?.name ?? regName(item.slug))
  const [busy, setBusy] = useState<string | null>(null)
  const [target, setTarget] = useState('')
  useEffect(() => setName(item.roblox?.name ?? regName(item.slug)), [item.path])
  const components = useMemo(() => {
    const paths = new Set<string>()
    for (const g of state.scripts) for (const s of g.scripts) if (s.path && isComponentPath(s.path)) paths.add(s.path)
    for (const f of state.files) if (isComponentPath(f.path)) paths.add(f.path)
    return [...paths].sort()
  }, [state.scripts, state.files])
  const inRegistry = registry.find((e) => e.name === name)

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (e) {
      actions.toast({ text: `${label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const upload = () =>
    run('Import', async () => {
      const r = await window.harness.artImportToRoblox({ path: item.path, name })
      onChanged(r.item)
      actions.toast({ text: `Uploaded ${r.uri}`, detail: r.registry ? `${r.registry.path}: ${r.registry.name}${r.registry.changed ? '' : ' (unchanged)'}` : undefined, kind: 'ok', action: { label: 'Copy id', run: () => void actions.copy(r.uri, 'Asset id') } })
    })
  const remove = () =>
    run('Delete', async () => {
      const { undoId } = await window.harness.artDelete(item.path)
      onClose()
      onChanged()
      actions.toast({ text: `Deleted ${base(item.path)}`, kind: 'info', ms: 8000, action: { label: 'Undo', run: () => void window.harness.artUndoDelete(undoId).then(() => onChanged()) } })
    })
  const insert = (path: string) =>
    run('Insert', async () => {
      const line = await insertIntoComponent(path, name, (p) => actions.openFile(p))
      if (line === null) throw new Error(`could not open ${path}`)
      actions.toast({ text: `Inserted ImageLabel in ${base(path)}:${line}`, detail: 'Unsaved; move it into the right children table and save.', kind: 'ok' })
    })
  const sizeTxt = item.width && item.height ? `${item.width}×${item.height}` : item.size

  return (
    <aside className="art-detail" aria-label="Concept details">
      <div className="art-detail-head">
        <span className="mono grow ellipsis" title={item.path}>
          {base(item.path)}
        </span>
        <button className="btn ghost small" onClick={onClose} aria-label="Close details">
          <Icon name="x" size={12} />
        </button>
      </div>
      <div className={`art-preview${item.background === 'transparent' ? ' checker' : ''}`}>{full ? <img src={full} alt={item.prompt || base(item.path)} /> : <span className="art-ph" />}</div>
      {item.prompt && <p className="art-prompt">{item.prompt}</p>}
      <dl className="art-meta">
        <dt>model</dt>
        <dd>{item.model}</dd>
        <dt>size</dt>
        <dd>
          {sizeTxt} · {item.quality}
          {item.background === 'transparent' ? ' · transparent' : ''}
        </dd>
        <dt>cost</dt>
        <dd>≈ {usd(item.costUsd)}</dd>
        <dt>made</dt>
        <dd>
          {new Date(item.createdAt).toLocaleString()} · {item.source === 'agent' ? 'agent' : 'you'}
          {item.mode === 'edit' ? ' · edit' : ''}
        </dd>
        {item.referencePaths?.length ? (
          <>
            <dt>refs</dt>
            <dd className="ellipsis">{item.referencePaths.map(base).join(', ')}</dd>
          </>
        ) : null}
        {item.roblox && (
          <>
            <dt>roblox</dt>
            <dd>
              <span className="mono">{item.roblox.uri}</span>
              {item.roblox.moderation && <span className={`tag ${/APPROVED/.test(item.roblox.moderation) ? 'ok' : 'warn'}`}>{item.roblox.moderation.replace('MODERATION_STATE_', '').toLowerCase()}</span>}
            </dd>
          </>
        )}
        {item.savedAs && (
          <>
            <dt>saved</dt>
            <dd className="mono">{item.savedAs}</dd>
          </>
        )}
      </dl>

      <div className="art-actions">
        <button className="btn small" disabled={!!busy || !item.prompt} onClick={() => onCompose({ prompt: item.prompt, style: item.style, size: item.size, quality: item.quality as ArtQuality, transparent: item.background === 'transparent', referencePaths: item.referencePaths ?? [] }, true)}>
          <Icon name="restart" size={12} /> Regenerate
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => onCompose({ prompt: item.prompt ? `Variation of this image: ${item.prompt}` : 'A variation of this image, same subject and style', style: item.style, transparent: item.background === 'transparent', referencePaths: [item.path], n: 2 }, true)}>
          <Icon name="trio" size={12} /> Variations
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => onCompose({ prompt: '', style: item.style, transparent: item.background === 'transparent', referencePaths: [item.path], n: 1 })} title="Write what to change; optional mask">
          <Icon name="pencil" size={12} /> Edit…
        </button>
        <button className="btn small" onClick={() => void attachImageToChat({ path: item.absPath, name: base(item.path) })}>
          <Icon name="at" size={12} /> Send to chat
        </button>
      </div>

      <div className="art-import">
        <div className="set-sub">Use in the game</div>
        <div className="row">
          <input className="input mono grow" value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9_]/g, ''))} aria-label="Registry name" spellCheck={false} />
          <button className="btn small primary" disabled={!!busy || !status.robloxKey || !name || (!status.settings.creatorUserId && !status.settings.creatorGroupId)} onClick={() => void upload()} title={!status.robloxKey ? 'Add an Open Cloud key below' : !status.settings.creatorUserId && !status.settings.creatorGroupId ? 'Set the creator below' : `Upload as ${status.settings.assetType} and add Images.${name}`}>
            <Icon name="upload" size={12} /> {busy === 'Import' ? 'Uploading…' : item.roblox ? 'Re-upload' : 'Import to Roblox'}
          </button>
        </div>
        <div className="note">
          {inRegistry ? (
            <>
              <span className="mono">Images.{inRegistry.name}</span> = <span className="mono">{inRegistry.uri}</span> in src/shared/Assets/Images.luau
            </>
          ) : (
            'Uploads, then writes the id into src/shared/Assets/Images.luau (sorted; created if missing).'
          )}
        </div>
        <div className="art-actions">
          <button className="btn small" disabled={!item.roblox} onClick={() => void actions.copy(item.roblox!.uri, 'Asset id')}>
            <Icon name="copy" size={12} /> Copy rbxassetid
          </button>
          <button className="btn small" onClick={() => void actions.copy(item.path, 'Path')}>
            <Icon name="link" size={12} /> Copy path
          </button>
          <button className="btn small" disabled={!item.roblox} onClick={() => void actions.copy(`${IMAGES_REQUIRE}\n\n${videImageLabel(item.roblox?.name ?? name)}`, 'Vide snippet')} title="Vide ImageLabel using Images.<Name>">
            <Icon name="code" size={12} /> Copy Vide snippet
          </button>
          <button className="btn small" disabled={!!busy} onClick={() => void run('Save', async () => onChanged(await window.harness.artSaveToProject(item.path, name)))} title={`Copy to art/ui/${name}.png without uploading`}>
            <Icon name="download" size={12} /> Save to project
          </button>
        </div>
        <div className="row art-insert">
          <select className="input grow" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="Vide component" disabled={!item.roblox || !components.length}>
            <option value="">{components.length ? 'Insert ImageLabel into component…' : 'No UI component files found'}</option>
            {components.map((p) => (
              <option key={p} value={p}>
                {p.replace(/^src\//, '')}
              </option>
            ))}
          </select>
          <button className="btn small" disabled={!item.roblox || !target || !!busy} onClick={() => void insert(target)}>
            Insert
          </button>
        </div>
      </div>
      <div className="art-actions end">
        <button className="btn small danger" disabled={!!busy} onClick={() => void remove()}>
          <Icon name="trash" size={12} /> Delete
        </button>
      </div>
    </aside>
  )
}

export function ArtPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<ArtStatus | null>(null)
  const [items, setItems] = useState<ArtItem[]>([])
  const [registry, setRegistry] = useState<ArtRegistryEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [prompt, setPrompt] = useState('')
  const [style, setStyle] = useState<ArtStyleId>('none')
  const [size, setSize] = useState('1024x1024')
  const [quality, setQuality] = useState<ArtQuality | ''>('')
  const [transparent, setTransparent] = useState(false)
  const [n, setN] = useState(2)
  const [refs, setRefs] = useState<string[]>([])
  const [mask, setMask] = useState<string | null>(null)
  const [estimate, setEstimate] = useState<ArtCostEstimate | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [drag, setDrag] = useState(false)
  const [filter, setFilter] = useState('')
  const [showSetup, setShowSetup] = useState(false)
  const promptRef = useRef<HTMLTextAreaElement>(null)

  const load = useCallback(async () => {
    try {
      const [s, list, reg] = await Promise.all([h.artStatus(), h.artList(), h.artRegistry()])
      setStatus(s)
      setItems(list)
      setRegistry(reg)
    } catch (e) {
      actions.toast({ text: 'Could not load art', detail: errorText(e), kind: 'err' })
    }
  }, [actions])

  useEffect(() => {
    void load()
  }, [state.project?.root])
  useEffect(() => {
    const off1 = h.on('art:changed', () => void load())
    const off2 = h.on('art:progress', (p) => setBusy(p.stage === 'done' || p.stage === 'failed' ? null : `${p.stage}${p.detail ? ` · ${p.detail}` : ''}`))
    return () => (off1(), off2())
  }, [load])

  const input = useMemo<ArtGenerateInput>(
    () => ({ prompt, style, size, ...(quality ? { quality } : {}), transparent, n, referencePaths: refs, ...(mask ? { maskPath: mask } : {}) }),
    [prompt, style, size, quality, transparent, n, refs, mask]
  )
  useEffect(() => {
    let live = true
    const t = setTimeout(() => void h.artEstimate(input).then((e) => live && setEstimate(e)).catch(() => undefined), 150)
    return () => ((live = false), clearTimeout(t))
  }, [input, items.length])

  const applyStyle = (id: ArtStyleId) => {
    setStyle(id)
    const p = status?.styles.find((s) => s.id === id)
    if (p?.size) setSize(p.size)
    if (p?.transparent !== undefined) setTransparent(p.transparent)
  }

  const generate = async (override?: Partial<ArtGenerateInput>) => {
    const req = { ...input, ...override }
    if (!req.prompt.trim()) return promptRef.current?.focus()
    setBusy('generating')
    try {
      const made = await h.artGenerate(req)
      await load()
      if (made[0]) setSelected(made[0].path)
      actions.toast({ text: `Generated ${made.length} image${made.length === 1 ? '' : 's'}`, detail: `${made[0]?.model} · ≈ ${usd(made.reduce((s, i) => s + i.costUsd, 0))}`, kind: 'ok' })
    } catch (e) {
      actions.toast({ text: 'Generation failed', detail: errorText(e), kind: 'err', ms: 10000 })
    } finally {
      setBusy(null)
    }
  }

  const compose = (patch: Partial<ArtGenerateInput>, run = false) => {
    if (patch.prompt !== undefined) setPrompt(patch.prompt)
    if (patch.style) setStyle(patch.style)
    if (patch.size) setSize(patch.size)
    if (patch.quality) setQuality(patch.quality)
    if (patch.transparent !== undefined) setTransparent(patch.transparent)
    if (patch.n) setN(patch.n)
    setRefs(patch.referencePaths ?? [])
    setMask(null)
    if (run) void generate(patch)
    else setTimeout(() => promptRef.current?.focus())
  }

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const files = [...e.dataTransfer.files].filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name))
    const paths = files.map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean)
    const inner = e.dataTransfer.getData('text/x-forge-art')
    const next = [...refs, ...paths, ...(inner ? [inner] : [])].filter((p, i, a) => a.indexOf(p) === i).slice(0, 8)
    if (!paths.length && !inner) actions.toast({ text: 'Drop PNG, JPEG or WEBP images', kind: 'info' })
    setRefs(next)
  }

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return q ? items.filter((i) => i.path.toLowerCase().includes(q) || i.prompt.toLowerCase().includes(q)) : items
  }, [items, filter])
  const byDay = useMemo(() => {
    const m = new Map<string, ArtItem[]>()
    for (const i of shown) m.set(i.date, [...(m.get(i.date) ?? []), i])
    return [...m]
  }, [shown])
  const current = items.find((i) => i.path === selected) ?? null
  const overCap = !!estimate && estimate.dailyCapUsd > 0 && estimate.spentTodayUsd + estimate.totalUsd > estimate.dailyCapUsd
  // Image backend 'codex': the ChatGPT plan through the Codex CLI (no key, cost or cap; Codex picks the size).
  const codex = status?.settings.backend === 'codex'
  const canGenerate = codex ? !!status?.codex?.ready : !!status?.openaiKey

  if (!state.project) {
    return (
      <div className="page">
        <div className="empty">Open a project to make art concepts.</div>
      </div>
    )
  }

  return (
    <div className="page">
      <div className="page-inner art">
        <div className="page-head">
          <div>
            <h1>Art</h1>
            <div className="sub">
              {state.project.name} · {items.length} concept{items.length === 1 ? '' : 's'}
              {estimate ? ` · today ${usd(estimate.spentTodayUsd)}${estimate.dailyCapUsd ? ` of ${usd(estimate.dailyCapUsd)}` : ''}` : ''}
            </div>
          </div>
          <div className="actions">
            {status && (
              <select
                className="input"
                value={codex ? 'codex' : 'api'}
                onChange={async (e) => setStatus(await h.artSetSettings({ backend: e.target.value === 'codex' ? 'codex' : 'api' }))}
                aria-label="Image backend"
                title="Who makes the images here, in Thumbnail Lab and for VFX textures"
              >
                <option value="api">OpenAI API key</option>
                <option value="codex">Codex (ChatGPT plan)</option>
              </select>
            )}
            {status && !codex && (
              <select className="input" value={status.settings.model} onChange={async (e) => setStatus(await h.artSetSettings({ model: e.target.value as ArtSettings['model'] }))} aria-label="Image model">
                {status.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            )}
            <button className={`btn${showSetup ? ' primary' : ''}`} onClick={() => setShowSetup((v) => !v)} aria-expanded={showSetup}>
              <Icon name="key" size={12} /> Roblox import
            </button>
            <button className="btn" onClick={() => actions.ask('Ask OpenAI to make concepts for ')} title="Let the agent write an art-directed prompt and call generate_image">
              <Icon name="at" size={12} /> Ask the agent
            </button>
          </div>
        </div>

        {status && codex && !status.codex?.ready && (
          <div className="callout warn row">
            <span className="grow">{status.codex?.detail ?? 'Codex is not ready.'} Images on the Codex backend use your ChatGPT plan through the Codex CLI.</span>
            <button className="btn small" onClick={() => actions.openSettings('codex')}>Open Settings</button>
          </div>
        )}
        {status && codex && status.codex?.ready && status.codex.detail.includes('API key') && <div className="callout warn">{status.codex.detail}</div>}
        {status && !codex && !status.openaiKey && (
          <div className="callout warn row">
            <span className="grow">Image generation uses your OpenAI API key. Add it under Settings → Providers → OpenAI.</span>
            <button className="btn small" onClick={() => actions.openSettings('openai')}>Open Settings</button>
          </div>
        )}
        {status && showSetup && <KeyCard status={status} onStatus={setStatus} />}

        <section className={`set-sec art-compose${drag ? ' drag' : ''}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
          <h2>
            Prompt <span className="grow" />
            {refs.length > 0 && <span className="tag info">edit · {refs.length} ref{refs.length === 1 ? '' : 's'}</span>}
          </h2>
          <textarea
            ref={promptRef}
            className="input art-prompt-input"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => (e.metaKey || e.ctrlKey) && e.key === 'Enter' && void generate()}
            placeholder="A glossy green Shop button with a coin icon, chunky dark outline, readable at phone size"
            spellCheck
            aria-label="Prompt"
          />
          <div className="art-presets" role="group" aria-label="Style preset">
            {status?.styles.map((s) => (
              <button key={s.id} className={`badge-o${style === s.id ? ' hot' : ''}`} onClick={() => applyStyle(s.id)} aria-pressed={style === s.id} title={s.direction || 'No extra art direction'}>
                {s.label}
              </button>
            ))}
          </div>
          <div className="art-opts">
            <label className="art-opt">
              <span>size</span>
              <select className="input" value={size} onChange={(e) => setSize(e.target.value)} disabled={codex} title={codex ? 'Codex picks the size itself (auto)' : undefined}>
                {[...new Set([...SIZES, size])].map((s) => (
                  <option key={s} value={s}>
                    {s}
                  </option>
                ))}
              </select>
            </label>
            <label className="art-opt">
              <span>quality</span>
              <select className="input" value={quality} onChange={(e) => setQuality(e.target.value as ArtQuality | '')} disabled={codex} title={codex ? 'Codex picks the quality itself (auto)' : undefined}>
                <option value="">default ({status?.settings.quality ?? 'high'})</option>
                {QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
            <label className="art-opt">
              <span>variants</span>
              <div className="seg">
                {[1, 2, 3, 4].map((k) => (
                  <button key={k} className={n === k ? 'on' : ''} onClick={() => setN(k)} type="button">
                    {k}
                  </button>
                ))}
              </div>
            </label>
            <label className="art-opt">
              <span>transparent</span>
              <input type="checkbox" className="switch" checked={transparent} onChange={(e) => setTransparent(e.target.checked)} aria-label="Transparent background" />
            </label>
          </div>
          <div className="art-refs">
            {refs.map((r) => (
              <span key={r} className="badge-o art-ref" title={r}>
                <Icon name="file" size={11} /> {base(r)}
                <button className="art-x" onClick={() => setRefs(refs.filter((x) => x !== r))} aria-label={`Remove ${base(r)}`}>
                  <Icon name="x" size={10} />
                </button>
              </span>
            ))}
            {mask && (
              <span className="badge-o art-ref" title={mask}>
                mask {base(mask)}
                <button className="art-x" onClick={() => setMask(null)} aria-label="Remove mask">
                  <Icon name="x" size={10} />
                </button>
              </span>
            )}
            <button className="btn small ghost" onClick={async () => setRefs([...refs, ...(await h.artChooseReferences())].slice(0, 8))}>
              <Icon name="plus" size={11} /> Reference image
            </button>
            {refs.length > 0 && !mask && !codex && (
              <button className="btn small ghost" onClick={async () => setMask((await h.artChooseReferences())[0] ?? null)} title="PNG with transparent pixels where the first reference should change">
                <Icon name="plus" size={11} /> Mask (optional)
              </button>
            )}
            <span className="note">{refs.length ? 'References turn this into an edit.' : 'Drop a screenshot or concept here to edit or riff on it.'}</span>
          </div>
          <div className="art-go">
            <span className={`note grow${overCap ? ' err-text' : ''}`}>
              {codex ? (
                <>{CODEX_IMAGE_NOTE}{mask ? ' Masks need the API backend.' : ''}</>
              ) : estimate ? (
                <>
                  ≈ <b className="mono">{usd(estimate.totalUsd)}</b> · {estimate.n} × {estimate.size} {estimate.quality} · {estimate.model}
                  {overCap ? ` · over today's ${usd(estimate.dailyCapUsd)} budget` : ''}
                </>
              ) : (
                'estimating…'
              )}
            </span>
            {busy && (
              <span className="art-busy note">
                <span className="spinner" aria-hidden /> {busy}
              </span>
            )}
            <button className="btn primary" disabled={!!busy || !prompt.trim() || !canGenerate || (!codex && overCap)} onClick={() => void generate()}>
              <Icon name="play" size={11} /> Generate
            </button>
          </div>
        </section>

        <div className={`art-body${current ? ' has-detail' : ''}`}>
          <div className="art-gallery">
            <div className="row art-gal-head">
              <input className="input grow" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter by name or prompt" aria-label="Filter concepts" />
              <span className="note">{shown.length} shown</span>
            </div>
            {!items.length && (
              <div className="empty">
                <Icon name="image" size={22} className="i" />
                No concepts yet. Write a prompt above, or ask the agent: “ask OpenAI to make 3 shop button concepts”.
              </div>
            )}
            {byDay.map(([day, list]) => (
              <div key={day} className="art-day">
                <div className="set-sub">
                  {day}
                  {dayLabel(day) ? ` · ${dayLabel(day)}` : ''} <span className="faint">· {list.length}</span>
                </div>
                <div className="art-grid">
                  {list.map((i) => (
                    <div key={i.path} draggable onDragStart={(e) => e.dataTransfer.setData('text/x-forge-art', i.path)}>
                      <Thumb item={i} selected={i.path === selected} onSelect={() => setSelected(i.path === selected ? null : i.path)} />
                    </div>
                  ))}
                </div>
              </div>
            ))}
          </div>
          {current && status && <Detail item={current} status={status} registry={registry} onClose={() => setSelected(null)} onChanged={() => void load()} onCompose={compose} />}
        </div>
      </div>
    </div>
  )
}
