// Model Lab: blocky, plated, voxel-style creature / guard / egg models out of Roblox Parts. A prompt
// (plus reference images dropped or pasted in) becomes a BlockyKit build script (main/services/model),
// built headlessly in Lune and drawn here with three.js; critic rounds snapshot the preview and let the
// AI compare it with the request and the references. Saved per project; "Build in Studio" builds the
// Model in Workspace through the Forge Bridge and selects it.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ModelBuild, ModelEntry, ModelProgress, ModelStatus, ModelTemplateId } from '@shared/types'
import { MODEL_TEMPLATE_IDS } from '@shared/model/types'
import { TEMPLATE_INFO } from '@shared/model/prompt'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { ago, errorText } from '../../lib/format'
import { ModelPreview } from './ModelPreview'
import { ModelScript } from './ModelScript'
import '../vfx/vfx.css'
import './model.css'

const MAX_REFS = 4
const MAX_REF_BYTES = 8 * 1024 * 1024
const SUGGESTIONS: Record<ModelTemplateId, string[]> = {
  creature: ['plated shark', 'spiky lava lizard', 'armoured beetle', 'sea serpent'],
  guard: ['spiky ice wolf guard', 'stone golem guard', 'crystal scorpion guard'],
  egg: ['pig egg', 'dragon egg with spikes', 'ocean egg with waves']
}

// Entry files as data URLs, cached per entry + file + stamp.
const fileCache = new Map<string, string | null>()
function useModelFile(id: string, file: string | undefined, stamp = 0): string | null {
  const key = file ? `${id}/${file}@${stamp}` : ''
  const [url, setUrl] = useState<string | null>(key ? (fileCache.get(key) ?? null) : null)
  useEffect(() => {
    if (!file) return setUrl(null)
    if (fileCache.has(key)) return setUrl(fileCache.get(key) ?? null)
    let live = true
    window.harness
      .modelFile(id, file)
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

function readImage(file: File): Promise<string | null> {
  if (!/^image\/(png|jpe?g|webp|gif)$/.test(file.type) || file.size > MAX_REF_BYTES) return Promise.resolve(null)
  return new Promise((resolve) => {
    const r = new FileReader()
    r.onload = () => resolve(typeof r.result === 'string' ? r.result : null)
    r.onerror = () => resolve(null)
    r.readAsDataURL(file)
  })
}

function Card({ entry, selected, busy, onSelect }: { entry: ModelEntry; selected: boolean; busy?: ModelProgress; onSelect: () => void }) {
  const url = useModelFile(entry.id, entry.thumb, entry.thumbStamp ?? 0)
  return (
    <button className={`vfx-card${selected ? ' on' : ''}`} onClick={onSelect} aria-pressed={selected} title={entry.prompt || entry.name} data-testid="model-card">
      <div className="vfx-thumb">
        {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <Icon name="cube" size={22} className="vfx-thumb-ph" />}
        {busy && busy.phase !== 'done' && busy.phase !== 'error' && (
          <span className="vfx-thumb-busy mono">
            <span className="spinner" aria-hidden /> {busy.phase}
            {busy.round ? ` ${busy.round}` : ''}
          </span>
        )}
      </div>
      <div className="vfx-cap">
        <span className="vfx-name">{entry.name}</span>
        {entry.error ? <span className="tag err">error</span> : null}
      </div>
      <div className="vfx-tags">
        <span className="vfx-tag">{entry.template}</span>
        <span className="vfx-tag">{entry.parts}p</span>
        <span className="faint mono model-ago">{ago(entry.updatedAt)}</span>
      </div>
    </button>
  )
}

function Refs({ refs, onRemove }: { refs: string[]; onRemove: (i: number) => void }) {
  if (!refs.length) return null
  return (
    <div className="model-refs" data-testid="model-refs">
      {refs.map((r, i) => (
        <span key={i} className="model-ref">
          <img src={r} alt={`reference ${i + 1}`} draggable={false} />
          <button type="button" className="btn small ghost" onClick={() => onRemove(i)} aria-label={`Remove reference ${i + 1}`}>
            <Icon name="x" size={10} />
          </button>
        </span>
      ))}
    </div>
  )
}

function SavedRefs({ entry }: { entry: ModelEntry }) {
  return (
    <div className="model-refs">
      {entry.refs.map((f) => (
        <SavedRef key={f} id={entry.id} file={f} />
      ))}
    </div>
  )
}
function SavedRef({ id, file }: { id: string; file: string }) {
  const url = useModelFile(id, file)
  return <span className="model-ref">{url ? <img src={url} alt={file} draggable={false} /> : null}</span>
}

function Frame({ id, file }: { id: string; file: string }) {
  const url = useModelFile(id, file)
  return <div className="vfx-frame model-frame">{url ? <img src={url} alt={file} loading="lazy" draggable={false} /> : <span className="vfx-frame-ph" />}</div>
}

function CriticLog({ entry }: { entry: ModelEntry }) {
  const rounds = entry.critic ?? []
  if (!rounds.length) return <div className="empty">No critic rounds yet. With the critic on, Generate snapshots the preview from three angles and lets the AI compare it with your request and references, then revise.</div>
  return (
    <div className="model-critic" role="list">
      {[...rounds].reverse().map((r) => (
        <article key={`${r.round}-${r.at}`} className="model-round" role="listitem">
          <header className="row">
            <span className="mono">round {r.round}</span>
            {r.changed ? <span className="tag ok">revised</span> : <span className="tag">kept</span>}
            {r.parts ? <span className="faint mono">{r.parts} parts</span> : null}
            <span className="grow" />
            <span className="faint mono">{ago(r.at)}</span>
          </header>
          <p className="note">{r.summary}</p>
          {r.error && <p className="note warn">{r.error}</p>}
          {r.frames.length > 0 && (
            <div className="model-frames">
              {r.frames.map((f) => (
                <Frame key={f} id={entry.id} file={f} />
              ))}
            </div>
          )}
        </article>
      ))}
    </div>
  )
}

function StudioBox({ entry, status, onSaved }: { entry: ModelEntry; status: ModelStatus | null; onSaved: (e: ModelEntry) => void }) {
  const { actions } = useStore()
  const [path, setPath] = useState(entry.guard?.path ?? '')
  const [area, setArea] = useState(entry.guard?.areaId ?? '')
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    setPath(entry.guard?.path ?? '')
    setArea(entry.guard?.areaId ?? '')
  }, [entry.id])
  const studio = status?.studio
  const build = async () => {
    setBusy(true)
    try {
      const guard = entry.template === 'guard' ? (path.trim() ? { path: path.trim(), areaId: area.trim() } : null) : undefined
      const r = await window.harness.modelBuildInStudio(entry.id, guard === undefined ? {} : { guard })
      actions.toast({ text: `Built ${r.name} in Studio`, detail: `${r.path} · ${r.parts} parts · selected (Ctrl+Z removes it)`, kind: 'ok', ms: 4000 })
      if (guard !== undefined) onSaved({ ...entry, ...(guard ? { guard } : {}) })
    } catch (e) {
      actions.toast({ text: 'Build in Studio failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="model-studio" data-testid="model-studio">
      {entry.template === 'guard' && (
        <div className="model-guard">
          <label className="art-opt grow" title="An existing guard Model in the place: its gameplay pieces (attributes, tags, scripts' targets) are copied onto the new model with kit:wireGuard. Leave empty for a visual-only model.">
            <span>copy gameplay from</span>
            <input className="input mono grow" value={path} onChange={(e) => setPath(e.target.value)} placeholder="Workspace.Guards.SharkGuard" aria-label="Existing guard path" />
          </label>
          <label className="art-opt" title="The area id the guard belongs to (AreaId attribute)">
            <span>area</span>
            <input className="input mono model-area" value={area} onChange={(e) => setArea(e.target.value)} placeholder="Area1" aria-label="Area id" />
          </label>
        </div>
      )}
      <div className="row">
        <button className="btn primary" onClick={() => void build()} disabled={busy || !studio?.canBuild || !entry.parts} title={studio?.message} data-testid="model-build-studio">
          {busy ? <span className="spinner" aria-hidden /> : <Icon name="studio" size={12} />} Build in Studio
        </button>
        <span className={`note${studio && !studio.canBuild ? ' warn' : ''}`}>{studio?.message ?? 'checking Studio…'}</span>
      </div>
    </div>
  )
}

function Detail({ entry, status, progress, onClose, onChanged }: { entry: ModelEntry; status: ModelStatus | null; progress?: ModelProgress; onClose: () => void; onChanged: (e?: ModelEntry) => void }) {
  const { actions } = useStore()
  const [build, setBuild] = useState<ModelBuild | null>(null)
  const [tab, setTab] = useState<'preview' | 'script' | 'critic'>('preview')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState<string | null>(null)
  const [renaming, setRenaming] = useState(false)
  const [name, setName] = useState(entry.name)
  const stamp = `${entry.id}@${entry.updatedAt}`
  useEffect(() => {
    let live = true
    setLoading(true)
    window.harness
      .modelLoad(entry.id)
      .then((r) => live && setBuild(r.build))
      .catch((e) => live && setBuild({ ok: false, parts: [], prints: [], warnings: [], error: { message: errorText(e) } }))
      .finally(() => live && setLoading(false))
    return () => {
      live = false
    }
  }, [stamp])
  useEffect(() => setName(entry.name), [entry.name])

  const thumbDue = entry.thumbStamp !== entry.updatedAt
  const onSnapshot = useCallback(
    (png: string) => {
      if (!thumbDue) return
      void window.harness.modelSaveThumb(entry.id, png).catch(() => undefined)
    },
    [entry.id, thumbDue]
  )

  const rename = async () => {
    setRenaming(false)
    if (!name.trim() || name.trim() === entry.name) return setName(entry.name)
    try {
      onChanged(await window.harness.modelRename(entry.id, name.trim()))
    } catch (e) {
      actions.toast({ text: 'Rename failed', detail: errorText(e), kind: 'err' })
    }
  }
  const remove = async () => {
    if (!confirm(`Delete the model "${entry.name}"? Its script, references and critic frames are removed.`)) return
    await window.harness.modelDelete(entry.id)
    onClose()
  }
  const act = async (what: 'rerun' | 'critique') => {
    setBusy(what)
    try {
      const r = what === 'rerun' ? await window.harness.modelGenerate(entry.prompt, { id: entry.id, template: entry.template }) : await window.harness.modelCritique(entry.id)
      setBuild(r.build)
      onChanged(r.entry)
      for (const n of r.notes) actions.toast({ text: n, kind: 'info', ms: 5000 })
    } catch (e) {
      actions.toast({ text: what === 'rerun' ? 'Re-run failed' : 'Critique failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const running = progress && progress.phase !== 'done' && progress.phase !== 'error'
  return (
    <div className="vfx-detail model-detail" data-testid="model-detail">
      <div className="vfx-detail-head">
        <Icon name="cube" size={13} />
        {renaming ? (
          <input className="input mono grow" value={name} autoFocus onChange={(e) => setName(e.target.value)} onBlur={() => void rename()} onKeyDown={(e) => (e.key === 'Enter' ? void rename() : e.key === 'Escape' ? (setName(entry.name), setRenaming(false)) : undefined)} aria-label="Model name" />
        ) : (
          <button className="vfx-title model-title" onClick={() => setRenaming(true)} title="Rename">
            {entry.name}
          </button>
        )}
        <span className="tag">{TEMPLATE_INFO[entry.template].label}</span>
        <span className="tag">{entry.origin === 'ai' ? 'AI' : entry.origin}</span>
        <span className="grow" />
        <button className="btn small ghost" onClick={onClose} aria-label="Close">
          <Icon name="x" size={11} />
        </button>
      </div>
      {entry.prompt && <p className="note model-prompt-line">“{entry.prompt}”</p>}
      {entry.refs.length > 0 && <SavedRefs entry={entry} />}
      {entry.modelError && <p className="note warn">The last AI run failed: {entry.modelError}</p>}
      <div className="vfx-actions">
        <button className="btn small" onClick={() => void act('rerun')} disabled={!!busy || !!running} title="Ask the AI again from the prompt and references, starting from this script (critic rounds follow when on)" data-testid="model-rerun">
          {busy === 'rerun' ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Re-run
        </button>
        <button className="btn small" onClick={() => void act('critique')} disabled={!!busy || !!running || !status?.vision || !build?.ok} title={status?.vision ? 'One critic round: snapshot the preview, compare with the request and references, revise' : 'Needs an AI model (Settings > Providers)'}>
          {busy === 'critique' ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
        </button>
        <span className="grow" />
        {running && (
          <span className="vfx-progress" aria-live="polite">
            <span className="spinner" aria-hidden /> {progress!.message}
          </span>
        )}
        <button className="btn small ghost danger" onClick={() => void remove()} title="Delete this model">
          <Icon name="trash" size={11} /> Delete
        </button>
      </div>
      <div className="seg vfx-tabs" role="tablist" aria-label="Model view">
        {(['preview', 'script', 'critic'] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>
            {t}
            {t === 'critic' && entry.critic?.length ? ` (${entry.critic.length})` : ''}
          </button>
        ))}
      </div>
      {tab === 'preview' &&
        (build ? (
          <ModelPreview build={build} name={entry.name} onSnapshot={thumbDue ? onSnapshot : undefined} />
        ) : (
          <div className="vfx-canvas model-canvas model-loading">{loading ? <span className="spinner" aria-hidden /> : null}</div>
        ))}
      {tab === 'script' && (
        <ModelScript
          entry={entry}
          onBuild={(b) => (setBuild(b), setTab('preview'))}
          onSaved={(e, b) => {
            setBuild(b)
            onChanged(e)
          }}
        />
      )}
      {tab === 'critic' && <CriticLog entry={entry} />}
      {entry.error && <p className="note err">The saved script does not build: {entry.error}</p>}
      <StudioBox entry={entry} status={status} onSaved={(e) => onChanged(e)} />
    </div>
  )
}

export function ModelLabPage() {
  const { actions } = useStore()
  const h = window.harness
  const [status, setStatus] = useState<ModelStatus | null>(null)
  const [entries, setEntries] = useState<ModelEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [template, setTemplate] = useState<ModelTemplateId>('creature')
  const [prompt, setPrompt] = useState('')
  const [refs, setRefs] = useState<string[]>([])
  const [drag, setDrag] = useState(false)
  const [making, setMaking] = useState(false)
  const [progress, setProgress] = useState<Record<string, ModelProgress>>({})
  const [runMsg, setRunMsg] = useState<ModelProgress | null>(null)
  const [query, setQuery] = useState('')
  const runRef = useRef<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)

  const load = useCallback(async () => {
    const [s, list] = await Promise.all([h.modelStatus().catch(() => null), h.modelList().catch(() => [] as ModelEntry[])])
    if (s) setStatus(s)
    setEntries(list)
    return list
  }, [])
  useEffect(() => {
    void load()
  }, [load])
  useEffect(() => h.on('model:changed', () => void load()), [load])
  useEffect(
    () =>
      h.on('model:progress', (p) => {
        if (p.id) setProgress((cur) => ({ ...cur, [p.id!]: p }))
        if (p.run && p.run === runRef.current) setRunMsg(p)
      }),
    []
  )
  // Studio connection changes the Build in Studio state.
  useEffect(() => h.on('studio:bridge', () => void h.modelStatus().then(setStatus).catch(() => undefined)), [])

  const addFiles = async (files: File[]) => {
    const urls = (await Promise.all(files.slice(0, MAX_REFS).map(readImage))).filter((u): u is string => !!u)
    if (files.length && !urls.length) actions.toast({ text: 'Reference images must be PNG, JPEG, WebP or GIF (up to 8 MB)', kind: 'err' })
    setRefs((cur) => [...cur, ...urls].slice(0, MAX_REFS))
  }
  const onPaste = (e: React.ClipboardEvent) => {
    const files = [...e.clipboardData.items].filter((i) => i.kind === 'file' && i.type.startsWith('image/')).map((i) => i.getAsFile()).filter((f): f is File => !!f)
    if (files.length) {
      e.preventDefault()
      void addFiles(files)
    }
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    void addFiles([...e.dataTransfer.files])
  }

  const settings = status?.settings ?? { critic: true, rounds: 2 }
  const setSettings = async (patch: Partial<typeof settings>) => {
    const next = await h.modelSetSettings(patch)
    setStatus((s) => (s ? { ...s, settings: next } : s))
  }

  const generate = async () => {
    if (making) return
    const text = prompt.trim() || TEMPLATE_INFO[template].prompt
    const run = `run-${Date.now().toString(36)}`
    runRef.current = run
    setMaking(true)
    setRunMsg({ run, phase: 'writing', message: 'Starting', at: Date.now() })
    try {
      const r = await h.modelGenerate(text, { template, refs, run })
      setRefs([])
      await load()
      setSelected(r.entry.id)
      for (const n of r.notes) actions.toast({ text: n, kind: 'info', ms: 6000 })
      if (!r.build.ok) actions.toast({ text: 'The build failed', detail: r.entry.error, kind: 'err' })
    } catch (e) {
      actions.toast({ text: 'Generate failed', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
      runRef.current = null
      setRunMsg(null)
    }
  }
  const fromTemplate = async () => {
    setMaking(true)
    try {
      const r = await h.modelFromTemplate(template, prompt.trim() ? { prompt: prompt.trim() } : {})
      await load()
      setSelected(r.entry.id)
    } catch (e) {
      actions.toast({ text: 'Could not add the template', detail: errorText(e), kind: 'err' })
    } finally {
      setMaking(false)
    }
  }

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? entries.filter((e) => `${e.name} ${e.prompt} ${e.template}`.toLowerCase().includes(q)) : entries
  }, [entries, query])
  const current = entries.find((e) => e.id === selected) ?? null

  return (
    <div className="page">
      <div className="page-inner vfx model-lab">
        <div className="page-head">
          <div>
            <h1>Model Lab</h1>
            <div className="sub">
              {status ? `${status.entries} model${status.entries === 1 ? '' : 's'} ${status.projectRoot ? 'in this project' : 'in your library (open a project to keep them with it)'}` : 'loading…'}
              {status?.lune.version ? ` · Lune ${status.lune.version}` : ''}
            </div>
          </div>
        </div>

        {status && (!status.lune.available || !status.vision) && (
          <div className="callout row" data-testid="model-callout">
            <Icon name="info" size={12} />
            <span className="grow note">
              {!status.lune.available && <>The preview builds scripts with Lune, which was not found{status.lune.hint ? `: ${status.lune.hint}` : ''} (Settings → Toolchain). </>}
              {!status.vision && <>No AI model is set up (Settings → Providers): Generate starts from the template and the critic is off. </>}
            </span>
          </div>
        )}

        <section className="set-sec vfx-make model-make" onPaste={onPaste}>
          <form
            className="vfx-make-row"
            onSubmit={(e) => {
              e.preventDefault()
              void generate()
            }}
          >
            <div className="seg" role="group" aria-label="Kind of model">
              {MODEL_TEMPLATE_IDS.map((t) => (
                <button type="button" key={t} className={template === t ? 'on' : ''} aria-pressed={template === t} onClick={() => setTemplate(t)} title={TEMPLATE_INFO[t].blurb} data-testid={`model-template-${t}`}>
                  {TEMPLATE_INFO[t].label.toLowerCase()}
                </button>
              ))}
            </div>
            <span className="vfx-make-lead mono">
              <span className="vfx-prompt-sigil">›</span>
            </span>
            <input className="input grow" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={TEMPLATE_INFO[template].prompt} aria-label="Model to make" spellCheck data-testid="model-prompt" />
            <button type="button" className="btn" onClick={() => fileInput.current?.click()} title="Add reference images (or drop / paste them here)">
              <Icon name="image" size={12} /> Refs
            </button>
            <button className="btn primary" disabled={making} data-testid="model-generate">
              {making ? <span className="spinner" aria-hidden /> : <Icon name="play" size={11} />} Generate
            </button>
            <button type="button" className="btn" onClick={() => void fromTemplate()} disabled={making} title="Add the built-in template script as a new model (no AI)" data-testid="model-from-template">
              From template
            </button>
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              hidden
              onChange={(e) => {
                void addFiles([...(e.target.files ?? [])])
                e.target.value = ''
              }}
            />
          </form>
          <div className={`vfx-drop model-drop${drag ? ' drag' : ''}`} onDragOver={(e) => (e.preventDefault(), setDrag(true))} onDragLeave={() => setDrag(false)} onDrop={onDrop}>
            {refs.length ? <Refs refs={refs} onRemove={(i) => setRefs((cur) => cur.filter((_, k) => k !== i))} /> : <><Icon name="download" size={13} /> Drop or paste up to {MAX_REFS} reference images</>}
          </div>
          <div className="vfx-make-opts">
            <label className="art-opt" title="Snapshot the preview from three angles and let the AI compare it with the request and references, then revise">
              <input type="checkbox" checked={settings.critic} onChange={(e) => void setSettings({ critic: e.target.checked })} data-testid="model-critic" />
              <span>critic</span>
            </label>
            <label className="art-opt">
              <span>rounds</span>
              <div className="seg">
                {[1, 2, 3].map((k) => (
                  <button type="button" key={k} className={settings.rounds === k ? 'on' : ''} onClick={() => void setSettings({ rounds: k })} aria-pressed={settings.rounds === k} disabled={!settings.critic}>
                    {k}
                  </button>
                ))}
              </div>
            </label>
            <span className="vfx-sugg">
              {SUGGESTIONS[template].map((s) => (
                <button key={s} type="button" className="badge-o" onClick={() => setPrompt(s)}>
                  {s}
                </button>
              ))}
            </span>
          </div>
          {runMsg && (
            <p className="vfx-progress model-run" aria-live="polite" data-testid="model-progress">
              <span className="spinner" aria-hidden /> {runMsg.message}
            </p>
          )}
        </section>

        <div className={`vfx-body${current ? ' has-detail' : ''}`}>
          <div className="vfx-lib">
            <div className="row vfx-lib-head">
              <input className="input grow" value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or prompt" aria-label="Search models" />
              <span className="note">{shown.length} shown</span>
            </div>
            {!entries.length && status && (
              <div className="empty">
                <Icon name="cube" size={22} className="i" />
                No models yet. Describe one above and Generate, or start From template.
              </div>
            )}
            <div className="vfx-grid">
              {shown.map((e) => (
                <Card key={e.id} entry={e} selected={e.id === selected} busy={progress[e.id]} onSelect={() => setSelected(e.id === selected ? null : e.id)} />
              ))}
            </div>
          </div>
          {current && <Detail key={current.id} entry={current} status={status} progress={progress[current.id]} onClose={() => setSelected(null)} onChanged={() => void load()} />}
        </div>
      </div>
    </div>
  )
}
