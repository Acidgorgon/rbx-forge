// "Split into layers" for a UI mockup concept (Art page card, detail and fullscreen viewer): the
// vision model proposes the image layers (background plate, panel textures, icons, logos, a
// character), Acid edits, removes or adds layers, sees the cost against today's budget, and generates
// them with the page's image backend (the concept is the reference image). The saved set lives in
// art/ui/<ConceptName>/layers with layers.json; "Import all to Roblox" uploads each layer and the Luau
// theme table is ready to copy. Text and buttons are rebuilt as real Roblox UI, never cut out.
import { useEffect, useMemo, useState } from 'react'
import type { ArtItem, ArtLayer, ArtLayerKind, ArtLayerManifest, ArtLayerSpec, ArtLayersEstimate, ArtQuality, ArtStatus } from '@shared/types'
import { defaultLayerSize, defaultTransparent, LAYER_KIND_LABELS, LAYER_KINDS, LAYER_SIZES, layerName, layersDir, MAX_LAYERS, themeSnippet } from '@shared/artLayers'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Dialog } from '../../shell/Overlays'
import { errorText } from '../../lib/format'

const QUALITIES: ArtQuality[] = ['low', 'medium', 'high', 'xhigh', 'max']
const usd = (n: number) => (n === 0 ? '$0' : n < 0.01 ? '<$0.01' : `$${n.toFixed(n < 1 ? 3 : 2)}`)
const base = (p: string) => p.split(/[\\/]/).pop() ?? p

// A row in the editor: the spec plus a stable key for React.
type Row = ArtLayerSpec & { key: string }
let seq = 0
const row = (s: ArtLayerSpec): Row => ({ ...s, key: `l${++seq}` })
const specOf = ({ key: _k, ...s }: Row): ArtLayerSpec => (void _k, s)

// Layer previews, keyed by file + creation time (a regenerated layer gets a fresh preview).
const previews = new Map<string, string>()
function LayerThumb({ layer }: { layer: ArtLayer }) {
  const key = `${layer.file}@${layer.createdAt}`
  const [url, setUrl] = useState<string | null>(previews.get(key) ?? null)
  useEffect(() => {
    if (previews.has(key)) return setUrl(previews.get(key)!)
    let live = true
    void window.harness
      .artThumbnail(layer.file)
      .then((u) => {
        previews.set(key, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return <div className={`art-img${layer.transparent ? ' checker' : ''}`}>{url ? <img src={url} alt={layer.name} draggable={false} /> : <span className="art-ph" />}</div>
}

export function LayersPanel({ concept, status, onClose }: { concept: ArtItem; status: ArtStatus; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [rows, setRows] = useState<Row[]>([])
  const [name, setName] = useState('')
  const [quality, setQuality] = useState<ArtQuality | ''>('')
  const [note, setNote] = useState<string | null>(null)
  const [source, setSource] = useState<'vision' | 'default' | 'saved' | null>(null)
  const [manifest, setManifest] = useState<ArtLayerManifest | null>(null)
  const [estimate, setEstimate] = useState<ArtLayersEstimate | null>(null)
  const [busy, setBusy] = useState<string | null>('Loading…')
  const codex = status.settings.backend === 'codex'
  const canGenerate = codex ? !!status.codex?.ready : status.openaiKey
  const canImport = status.robloxKey && !!(status.settings.creatorUserId || status.settings.creatorGroupId)

  const propose = async () => {
    setBusy('Asking the vision model for layers…')
    try {
      const p = await h.artLayersPropose(concept.path)
      setRows(p.layers.map(row))
      setName((n) => n || p.name)
      setNote(p.note ?? null)
      setSource(p.source)
    } catch (e) {
      actions.toast({ text: 'Could not propose layers', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  // A concept split before opens on its saved layers (no vision call); otherwise propose.
  useEffect(() => {
    let live = true
    void (async () => {
      const saved = await h.artLayersGet(concept.path).catch(() => null)
      if (!live) return
      if (saved) {
        setManifest(saved)
        setName(saved.name)
        setRows(saved.layers.map((l) => row({ name: l.name, kind: l.kind, prompt: l.prompt, transparent: l.transparent, size: /^\d+x\d+$/.test(l.size) && (LAYER_SIZES as readonly string[]).includes(l.size) ? l.size : defaultLayerSize(l.kind, concept) })))
        setSource('saved')
        setBusy(null)
      } else await propose()
    })()
    return () => {
      live = false
    }
  }, [concept.path])

  const specs = useMemo(() => rows.map(specOf), [rows])
  useEffect(() => {
    if (!specs.length) return setEstimate(null)
    let live = true
    const t = setTimeout(() => void h.artLayersEstimate({ concept: concept.path, layers: specs, ...(quality ? { quality } : {}) }).then((e) => live && setEstimate(e)).catch(() => live && setEstimate(null)), 150)
    return () => ((live = false), clearTimeout(t))
  }, [specs, quality, concept.path])

  const edit = (key: string, patch: Partial<ArtLayerSpec>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)))
  const setKind = (key: string, kind: ArtLayerKind) => edit(key, { kind, transparent: defaultTransparent(kind), size: defaultLayerSize(kind, concept) })
  const add = () => setRows((rs) => [...rs, row({ name: `Layer${rs.length + 1}`, kind: 'icon', prompt: '', transparent: true, size: '1024x1024' })])
  const dupes = new Set(rows.map((r) => layerName(r.name)).filter((n, i, a) => a.indexOf(n) !== i))
  const invalid = rows.some((r) => !r.name.trim() || r.prompt.trim().length < 3) || dupes.size > 0

  const generate = async () => {
    setBusy(`Generating ${rows.length} layer${rows.length === 1 ? '' : 's'}…`)
    try {
      const m = await h.artLayersGenerate({ concept: concept.path, name, layers: specs, ...(quality ? { quality } : {}) })
      setManifest(m)
      setName(m.name)
      actions.toast({ text: `Generated ${specs.length} layer${specs.length === 1 ? '' : 's'}`, detail: `${layersDir(m.name)} · ≈ ${usd(estimate?.totalUsd ?? 0)}`, kind: 'ok' })
    } catch (e) {
      actions.toast({ text: 'Layer generation failed', detail: errorText(e), kind: 'err', ms: 10000 })
      // Layers made before the failure are saved: show them.
      const saved = await h.artLayersGet(concept.path).catch(() => null)
      if (saved) setManifest(saved)
    } finally {
      setBusy(null)
    }
  }

  const importAll = async (force = false) => {
    if (!manifest) return
    setBusy('Importing layers to Roblox…')
    try {
      const r = await h.artLayersImport(manifest.name, { force })
      setManifest(r.manifest)
      if (r.failed.length) actions.toast({ text: `Imported ${r.imported.length}, ${r.failed.length} failed`, detail: r.failed.map((f) => `${f.name}: ${f.error}`).join('\n'), kind: 'err', ms: 10000 })
      else actions.toast({ text: r.imported.length ? `Imported ${r.imported.length} layer${r.imported.length === 1 ? '' : 's'}` : 'Every layer already has an id', detail: 'Ids are in layers.json; copy the theme table below.', kind: 'ok' })
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err', ms: 10000 })
    } finally {
      setBusy(null)
    }
  }

  const snippet = themeSnippet(manifest)
  const missing = manifest ? manifest.layers.filter((l) => !l.uri).length : 0
  const overCap = !!estimate?.overCap

  return (
    <Dialog title={`Split into layers · ${base(concept.path)}`} onClose={onClose} width={980}>
      <div className="art-layers" data-testid="art-layers">
        <p>
          Text, numbers, buttons and nav tabs are rebuilt as real Roblox UI. Only the image layers are cut out of the concept, each generated with the concept as the reference so the style, palette and lighting match.
        </p>
        <div className="row art-layers-name">
          <label className="art-opt">
            <span>name</span>
            <input className="input mono" value={name} onChange={(e) => setName(e.target.value.replace(/[^A-Za-z0-9]/g, ''))} aria-label="Concept name" spellCheck={false} />
          </label>
          <span className="note grow ellipsis mono" title={`${layersDir(name || 'Concept')}/layers.json`}>
            {layersDir(name || 'Concept')}/
          </span>
          <button className="btn small ghost" disabled={!!busy} onClick={() => void propose()} title="Ask the vision model again (replaces the list below)">
            <Icon name="sparkle" size={11} /> {source === 'saved' ? 'Propose again' : 'Re-propose'}
          </button>
        </div>
        {source === 'default' && note && <div className="callout warn">{note}</div>}
        {source === 'saved' && <div className="note">Saved layers loaded. Edit and generate again to replace a layer; layers you remove here stay in the folder.</div>}

        <div className="art-layer-list" role="list" aria-label="Layers">
          {rows.map((r) => {
            const made = manifest?.layers.find((l) => l.name === layerName(r.name))
            return (
              <div key={r.key} className="art-layer" role="listitem" data-layer={r.name}>
                <div className="art-layer-thumb">{made ? <LayerThumb layer={made} /> : <div className="art-img"><span className="note">not made</span></div>}</div>
                <div className="art-layer-body">
                  <div className="row">
                    <input className={`input mono grow${dupes.has(layerName(r.name)) ? ' err' : ''}`} value={r.name} onChange={(e) => edit(r.key, { name: e.target.value.replace(/[^A-Za-z0-9]/g, '') })} aria-label="Layer name" spellCheck={false} />
                    <select className="input" value={r.kind} onChange={(e) => setKind(r.key, e.target.value as ArtLayerKind)} aria-label="Layer kind">
                      {LAYER_KINDS.map((k) => (
                        <option key={k} value={k}>
                          {LAYER_KIND_LABELS[k]}
                        </option>
                      ))}
                    </select>
                    <select className="input" value={r.size ?? '1024x1024'} onChange={(e) => edit(r.key, { size: e.target.value })} aria-label="Layer size" disabled={codex} title={codex ? 'Codex picks the size itself' : undefined}>
                      {[...new Set([...LAYER_SIZES, r.size ?? '1024x1024'])].map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                    <label className="art-opt" title="Transparent background">
                      <span>transparent</span>
                      <input type="checkbox" className="switch" checked={r.transparent} onChange={(e) => edit(r.key, { transparent: e.target.checked })} aria-label={`${r.name} transparent`} />
                    </label>
                    <button className="btn small ghost" onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} aria-label={`Remove ${r.name}`} title="Remove this layer">
                      <Icon name="x" size={11} />
                    </button>
                  </div>
                  <textarea className="input art-layer-prompt" value={r.prompt} onChange={(e) => edit(r.key, { prompt: e.target.value })} aria-label={`${r.name} prompt`} placeholder="What this layer shows, e.g. the green Quick Join card background without text" />
                  {made && (
                    <div className="note mono ellipsis" title={made.file}>
                      {made.size} · {made.uri ?? 'not imported'}
                    </div>
                  )}
                </div>
              </div>
            )
          })}
          {!rows.length && !busy && <div className="empty">No layers. Add one, or propose again.</div>}
        </div>
        <div className="row">
          <button className="btn small ghost" onClick={add} disabled={rows.length >= MAX_LAYERS}>
            <Icon name="plus" size={11} /> Add layer
          </button>
          <span className="grow" />
          {!codex && (
            <label className="art-opt">
              <span>quality</span>
              <select className="input" value={quality} onChange={(e) => setQuality(e.target.value as ArtQuality | '')} aria-label="Layer quality">
                <option value="">default ({status.settings.quality})</option>
                {QUALITIES.map((q) => (
                  <option key={q} value={q}>
                    {q}
                  </option>
                ))}
              </select>
            </label>
          )}
        </div>

        <div className="art-go">
          <span className={`note grow${overCap ? ' err-text' : ''}`} data-testid="art-layers-cost">
            {!estimate ? (
              rows.length ? 'estimating…' : ''
            ) : codex ? (
              <>{estimate.note}</>
            ) : (
              <>
                ≈ <b className="mono">{usd(estimate.totalUsd)}</b> · {rows.length} layer{rows.length === 1 ? '' : 's'} · {estimate.model} {estimate.quality} · today {usd(estimate.spentTodayUsd)}
                {estimate.dailyCapUsd ? ` of ${usd(estimate.dailyCapUsd)}` : ''}
                {overCap ? ` · over today's budget` : ''}
              </>
            )}
          </span>
          {busy && (
            <span className="art-busy note">
              <span className="spinner" aria-hidden /> {busy}
            </span>
          )}
          <button className="btn primary" disabled={!!busy || !rows.length || invalid || !canGenerate || overCap || !name} onClick={() => void generate()} title={!canGenerate ? (codex ? 'Codex is not ready' : 'Add an OpenAI API key in Settings') : invalid ? 'Every layer needs a unique name and a prompt' : undefined}>
            <Icon name="play" size={11} /> Generate {rows.length} layer{rows.length === 1 ? '' : 's'}
          </button>
        </div>

        {manifest && manifest.layers.length > 0 && (
          <section className="art-layers-out" aria-label="Generated layers">
            <div className="set-sub">
              {layersDir(manifest.name)} · {manifest.layers.length} layer{manifest.layers.length === 1 ? '' : 's'}
              {missing ? ` · ${missing} not imported` : ' · all imported'}
            </div>
            <div className="row">
              <button className="btn small primary" disabled={!!busy || !canImport || !missing} onClick={() => void importAll()} title={!status.robloxKey ? 'Add an Open Cloud key (Roblox import)' : !canImport ? 'Set the creator (Roblox import)' : `Upload each layer as an ${status.settings.assetType} asset`}>
                <Icon name="upload" size={12} /> Import all to Roblox
              </button>
              {!missing && (
                <button className="btn small ghost" disabled={!!busy || !canImport} onClick={() => void importAll(true)} title="Upload every layer again (new ids)">
                  Re-upload all
                </button>
              )}
              <span className="grow" />
              <button className="btn small" disabled={snippet === '{}'} onClick={() => void actions.copy(snippet, 'Theme table')}>
                <Icon name="copy" size={12} /> Copy theme
              </button>
            </div>
            <pre className="art-layers-snippet mono" data-testid="art-layers-snippet">{snippet === '{}' ? '-- Import the layers to fill the theme table' : snippet}</pre>
          </section>
        )}
      </div>
    </Dialog>
  )
}
