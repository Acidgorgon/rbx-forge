// VFX Lab textures: bring existing textures in (image files and whole folders, pasted asset ids,
// or the ids the open Studio place already uses), review the suggested kinds / tags / flipbook
// layouts, and the "Textures" setting that makes effects reuse the library first.
import { useState } from 'react'
import type { TextureImportRow, TextureImportScan, TexturePolicy, TextureStatus, VfxTexture } from '@shared/types'
import { TEXTURE_PRESETS, type TextureKind } from '@shared/vfx/tex/textures'
import { TEXTURE_POLICIES, TEXTURE_POLICY_INFO } from '@shared/vfx/tex/reuse'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'

export function TexturePolicyControl({ status, onChange }: { status: TextureStatus | null; onChange: () => void }) {
  const { actions } = useStore()
  const policy = status?.policy ?? 'library-first'
  const set = async (p: TexturePolicy) => {
    try {
      await window.harness.vfxTexSetPolicy(p)
      onChange()
    } catch (e) {
      actions.toast({ text: 'Could not change the texture setting', detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <div className="tex-policy">
      <span className="faint mono">textures</span>
      <div className="seg" role="radiogroup" aria-label="How effects pick textures">
        {TEXTURE_POLICIES.map((p) => (
          <button key={p} type="button" role="radio" aria-checked={policy === p} className={policy === p ? 'on' : ''} onClick={() => void set(p)} title={TEXTURE_POLICY_INFO[p].help}>
            {TEXTURE_POLICY_INFO[p].label}
            {p === 'library-first' ? ' (default)' : ''}
          </button>
        ))}
      </div>
      <span className="note">{TEXTURE_POLICY_INFO[policy].help}</span>
    </div>
  )
}

type Edit = { include: boolean; name: string; kind: TextureKind; tags: string; flipbook: boolean }

function edits(rows: TextureImportRow[]): Record<string, Edit> {
  return Object.fromEntries(rows.map((r) => [r.key, { include: !r.error && !r.duplicateOf, name: r.name, kind: r.kind, tags: r.tags.join(', '), flipbook: !!r.flipbook }]))
}

function ReviewRow({ r, e, onEdit }: { r: TextureImportRow; e: Edit; onEdit: (patch: Partial<Edit>) => void }) {
  return (
    <li className={`tex-imp-row${r.error ? ' err' : ''}${e.include ? '' : ' off'}`}>
      <input type="checkbox" checked={e.include} disabled={!!r.error} onChange={(ev) => onEdit({ include: ev.target.checked })} aria-label={`Import ${r.name}`} />
      <div className="tex-imp-thumb">{r.preview ? <img src={r.preview} alt="" draggable={false} /> : <Icon name="image" size={14} />}</div>
      <div className="tex-imp-main">
        <div className="tex-imp-line">
          <input className="input" value={e.name} onChange={(ev) => onEdit({ name: ev.target.value })} disabled={!!r.error} aria-label="Name" />
          <select className="input" value={e.kind} onChange={(ev) => onEdit({ kind: ev.target.value as TextureKind })} disabled={!!r.error} aria-label="Kind">
            {TEXTURE_PRESETS.map((p) => (
              <option key={p.kind} value={p.kind}>
                {p.kind}
              </option>
            ))}
          </select>
          {r.flipbook && (
            <label className="tex-imp-fb" title={`${r.flipbook.cols}×${r.flipbook.rows} sheet, ${r.flipbook.frames} frames (from the ${r.flipbook.source})`}>
              <input type="checkbox" checked={e.flipbook} onChange={(ev) => onEdit({ flipbook: ev.target.checked })} /> <span className="mono">{r.flipbook.layout.replace('Grid', '')}</span>
            </label>
          )}
          {r.vision && <span className="tag" title="Named by the vision model">ai</span>}
        </div>
        <input className="input mono tex-imp-tags" value={e.tags} onChange={(ev) => onEdit({ tags: ev.target.value })} disabled={!!r.error} aria-label="Tags" placeholder="tags" />
        <span className="faint mono tex-imp-label" title={r.paths?.join('\n') ?? r.label}>
          {r.label}
          {r.color && <i className="tex-imp-swatch" style={{ background: r.color }} aria-hidden />}
          {r.edge && ` · ${r.edge}`}
        </span>
        {r.error && <span className="note err-t">{r.error}</span>}
        {r.duplicateOf && <span className="note">already in the library ({r.duplicateOf})</span>}
        {!!r.notes.length && <span className="note">{r.notes.join(' · ')}</span>}
      </div>
    </li>
  )
}

export function TextureImport({ status, onImported }: { status: TextureStatus | null; onImported: (items: VfxTexture[]) => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [drag, setDrag] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [paste, setPaste] = useState<string | null>(null)
  const [vision, setVision] = useState(true)
  const [scan, setScan] = useState<TextureImportScan | null>(null)
  const [edit, setEdit] = useState<Record<string, Edit>>({})
  const [scope, setScope] = useState<'project' | 'user'>(status?.project ? 'project' : 'user')
  const useVision = vision && !!status?.vision

  const run = async (label: string, fn: () => Promise<TextureImportScan>) => {
    setBusy(label)
    try {
      const s = await fn()
      setScan(s)
      setEdit(edits(s.rows))
      if (!s.rows.length) actions.toast({ text: 'Nothing to import', detail: s.notes.join(' ') || undefined, kind: 'info' })
    } catch (e) {
      actions.toast({ text: `${label} failed`, detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const scanPaths = (paths: string[]) => paths.length && void run('Scanning', () => h.vfxTexImportScan(paths, { vision: useVision }))
  const pick = async (what: 'files' | 'folder') => scanPaths(await h.vfxTexImportPick(what))
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const paths = [...e.dataTransfer.files].map((f) => window.forgeFiles?.pathFor(f) ?? '').filter(Boolean)
    if (paths.length) scanPaths(paths)
    else {
      const text = e.dataTransfer.getData('text/plain')
      if (text) void run('Reading ids', () => h.vfxTexImportIds(text, { vision: useVision }))
    }
  }
  const commit = async () => {
    if (!scan) return
    const rows = scan.rows.filter((r) => edit[r.key]?.include && !r.error).map((r) => ({ key: r.key, name: edit[r.key].name, kind: edit[r.key].kind, tags: edit[r.key].tags.split(',').map((t) => t.trim().toLowerCase()).filter(Boolean), flipbook: edit[r.key].flipbook }))
    if (!rows.length) return
    setBusy('Importing')
    try {
      const made = await h.vfxTexImportCommit({ scanId: scan.scanId, scope, rows })
      actions.toast({ text: `${made.length} texture${made.length === 1 ? '' : 's'} imported`, detail: 'Effects reuse them first (Textures setting above).', kind: 'ok', ms: 3500 })
      setScan(null)
      onImported(made)
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }
  const chosen = scan ? scan.rows.filter((r) => edit[r.key]?.include && !r.error).length : 0
  const studioReady = !!status?.studio && (status.studio.connected || status.studio.liveTree)

  return (
    <section className="set-sec tex-imp" aria-label="Import textures">
      <div
        className={`vfx-drop tex-imp-drop${drag ? ' drag' : ''}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
        role="button"
        tabIndex={0}
        onClick={() => void pick('files')}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), void pick('files'))}
      >
        {busy ? (
          <>
            <span className="spinner" aria-hidden /> {busy}…
          </>
        ) : (
          <>
            <Icon name="download" size={13} /> Drop texture files or folders here <span className="faint mono">.png .jpg · folders are scanned inside · flipbook sheets (4x4, _8f) are detected · duplicates skipped</span>
          </>
        )}
      </div>
      <div className="tex-imp-bar">
        <button className="btn small" disabled={!!busy} onClick={() => void pick('files')}>
          <Icon name="image" size={11} /> Files…
        </button>
        <button className="btn small" disabled={!!busy} onClick={() => void pick('folder')}>
          <Icon name="folder" size={11} /> Folder…
        </button>
        <button className={`btn small${paste !== null ? ' on' : ''}`} disabled={!!busy} onClick={() => setPaste(paste === null ? '' : null)} title="rbxassetid://123, numbers, or Creator Store links: stored as library textures that use the existing asset (no upload)">
          <Icon name="copy" size={11} /> Paste asset ids
        </button>
        <button className="btn small" disabled={!!busy || !studioReady} onClick={() => void run('Reading Studio', () => h.vfxTexImportStudio({ vision: useVision }))} title={studioReady ? 'Every Texture used by a ParticleEmitter, Beam or Trail in the open place (read-only)' : 'Open the place in Roblox Studio with the Forge Bridge plugin (Studio tab), or turn on Forge Sync'}>
          <Icon name="studio" size={11} /> From Studio
        </button>
        <span className="grow" />
        {status?.vision && (
          <label className="tex-imp-vision" title="Names, kinds and descriptions from the Labs cheap model (Settings > Labs); image analysis always runs">
            <input type="checkbox" checked={vision} onChange={(e) => setVision(e.target.checked)} /> name with the vision model
          </label>
        )}
      </div>
      {paste !== null && (
        <div className="tex-imp-paste">
          <textarea className="input mono" rows={3} value={paste} onChange={(e) => setPaste(e.target.value)} placeholder={'rbxassetid://1234567\nhttps://create.roblox.com/store/asset/987654321/Fire-Sparks\n24242424, 55555555'} aria-label="Asset ids" />
          <button className="btn small primary" disabled={!!busy || !paste.trim()} onClick={() => void run('Reading ids', () => h.vfxTexImportIds(paste, { vision: useVision }))}>
            Look up
          </button>
        </div>
      )}
      {scan && (
        <div className="tex-imp-review" aria-label="Review import">
          <div className="row">
            <b className="mono">
              import {chosen} of {scan.rows.length}
            </b>
            <span className="faint">kind, tags and flipbook layout are suggested from the names and the pixels; edit them before importing</span>
          </div>
          {!!scan.notes.length && <p className="note tex-hint">{scan.notes.join(' ')}</p>}
          <ul className="tex-imp-list">
            {scan.rows.map((r) => (
              <ReviewRow key={r.key} r={r} e={edit[r.key]} onEdit={(patch) => setEdit({ ...edit, [r.key]: { ...edit[r.key], ...patch } })} />
            ))}
          </ul>
          <div className="row">
            <select className="input tex-imp-scope" value={scope} onChange={(e) => setScope(e.target.value as 'project' | 'user')} aria-label="Import into">
              <option value="project" disabled={!status?.project}>
                this project
              </option>
              <option value="user">your library</option>
            </select>
            <span className="grow" />
            <button className="btn small ghost" onClick={() => setScan(null)}>
              Cancel
            </button>
            <button className="btn small primary" disabled={!chosen || !!busy} onClick={() => void commit()}>
              {busy === 'Importing' ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} Import {chosen}
            </button>
          </div>
        </div>
      )}
    </section>
  )
}
