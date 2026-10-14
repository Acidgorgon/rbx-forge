// VFX Lab bulk import: the review list before effects are added (files dropped on the lab, or the
// Roblox Studio selection read through the Forge Bridge), the Studio VFX-folder picker when nothing
// is selected, progress ("n of m"), and duplicates ("already in library") with Import anyway.
// Same look as the texture import review (textures.css tex-imp-*).
import { useEffect, useState } from 'react'
import type { VfxImportProgress, VfxImportResult, VfxImportRow, VfxImportScan, VfxScope, VfxStudioPack } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'
import './textures.css'

type Edit = { include: boolean; name: string }

export function importProgressText(p: VfxImportProgress | null): string | null {
  if (!p || p.phase === 'done') return null
  const n = p.total ? ` ${p.done} of ${p.total}` : ''
  const what = p.phase === 'reading' ? 'Reading from Studio' : p.phase === 'receiving' ? 'Receiving' : p.phase === 'importing' ? 'Importing' : 'Loading meshes'
  return `${what}${n}${p.label && p.phase !== 'receiving' ? ` · ${p.label}` : ''}`
}

export function useImportProgress(): VfxImportProgress | null {
  const [p, setP] = useState<VfxImportProgress | null>(null)
  useEffect(() => window.harness.on('vfx:import', (x) => setP(x.phase === 'done' ? null : x)), [])
  return p
}

function dupOf(r: VfxImportRow, scope: VfxScope): string | null {
  return r.duplicates.find((d) => d.scope === scope)?.name ?? null
}

function defaults(scan: VfxImportScan, scope: VfxScope): Record<string, Edit> {
  return Object.fromEntries(scan.rows.map((r) => [r.key, { include: !dupOf(r, scope) && !r.sameAs, name: r.name }]))
}

function Row({ r, e, scope, rows, onEdit }: { r: VfxImportRow; e: Edit; scope: VfxScope; rows: VfxImportRow[]; onEdit: (p: Partial<Edit>) => void }) {
  const dup = dupOf(r, scope)
  const same = r.sameAs ? rows.find((x) => x.key === r.sameAs) : null
  const s = r.stats
  const layers = [s.emitters && `${s.emitters} emitter${s.emitters === 1 ? '' : 's'}`, s.beams && `${s.beams} beam${s.beams === 1 ? '' : 's'}`, s.trails && `${s.trails} trail${s.trails === 1 ? '' : 's'}`, s.lights && `${s.lights} light${s.lights === 1 ? '' : 's'}`, s.parts && `${s.parts} part${s.parts === 1 ? '' : 's'}`].filter(Boolean).join(' · ')
  return (
    <li className={`tex-imp-row vfx-imp-row${e.include ? '' : ' off'}`} data-testid="vfx-import-row">
      <input type="checkbox" checked={e.include} onChange={(ev) => onEdit({ include: ev.target.checked })} aria-label={`Import ${e.name}`} />
      <div className="tex-imp-main">
        <div className="tex-imp-line">
          <input className="input" value={e.name} onChange={(ev) => onEdit({ name: ev.target.value })} aria-label="Name" />
          <span className="faint mono">{layers || 'no layers'}</span>
        </div>
        <span className="faint mono tex-imp-label" title={r.origin}>
          {r.origin}
          {r.notes.length ? ` · ${r.notes.join(' · ')}` : ''}
        </span>
        {dup && (
          <span className="note vfx-imp-dup">
            already in library: <b>{dup}</b>
            {!e.include && (
              <button className="btn small ghost" onClick={() => onEdit({ include: true })}>
                Import anyway
              </button>
            )}
          </span>
        )}
        {!dup && same && (
          <span className="note vfx-imp-dup">
            same effect as <b>{same.name}</b> above
            {!e.include && (
              <button className="btn small ghost" onClick={() => onEdit({ include: true })}>
                Import anyway
              </button>
            )}
          </span>
        )}
      </div>
    </li>
  )
}

function PackPicker({ packs, busy, onRead }: { packs: VfxStudioPack[]; busy: boolean; onRead: (packs: VfxStudioPack[]) => void }) {
  const [chosen, setChosen] = useState<Set<string>>(new Set(packs.slice(0, 1).map((p) => p.key)))
  return (
    <div className="vfx-imp-packs">
      <ul className="tex-imp-list">
        {packs.map((p) => (
          <li key={p.key} className="tex-imp-row">
            <label className="vfx-imp-pack">
              <input type="checkbox" checked={chosen.has(p.key)} onChange={(e) => setChosen((s) => (e.target.checked ? new Set([...s, p.key]) : new Set([...s].filter((k) => k !== p.key))))} />
              <span className="mono">{p.fullName}</span>
              <span className="faint">
                {p.className} · {p.effects} effect{p.effects === 1 ? '' : 's'}
                {p.children > p.effects ? ` of ${p.children} children` : ''}
              </span>
            </label>
          </li>
        ))}
      </ul>
      <div className="row">
        <span className="grow" />
        <button className="btn small primary" disabled={!chosen.size || busy} onClick={() => onRead(packs.filter((p) => chosen.has(p.key)))}>
          <Icon name="studio" size={11} /> Read {chosen.size} folder{chosen.size === 1 ? '' : 's'}
        </button>
      </div>
    </div>
  )
}

export function EffectImportReview({ scan, scope: initialScope, projectOpen, onClose, onDone, onRescan }: { scan: VfxImportScan; scope: VfxScope; projectOpen: boolean; onClose: () => void; onDone: (r: VfxImportResult) => void; onRescan: (packs: VfxStudioPack[]) => void }) {
  const { actions } = useStore()
  const [scope, setScope] = useState<VfxScope>(initialScope)
  const [edit, setEdit] = useState<Record<string, Edit>>(() => defaults(scan, initialScope))
  const [busy, setBusy] = useState(false)
  const progress = useImportProgress()
  useEffect(() => setEdit(defaults(scan, scope)), [scan.scanId])
  const chosen = scan.rows.filter((r) => edit[r.key]?.include)
  const dups = scan.rows.filter((r) => dupOf(r, scope) || r.sameAs).length
  const commit = async () => {
    setBusy(true)
    try {
      const r = await window.harness.vfxImportCommit({ scanId: scan.scanId, scope, rows: chosen.map((x) => ({ key: x.key, name: edit[x.key].name.trim() || x.name })) })
      onDone(r)
    } catch (e) {
      actions.toast({ text: 'Import failed', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(false)
    }
  }
  const all = (on: boolean) => setEdit(Object.fromEntries(scan.rows.map((r) => [r.key, { ...edit[r.key], include: on }])))
  return (
    <section className="set-sec tex-imp-review vfx-imp-review" aria-label="Review import">
      <div className="row">
        <b className="mono">{scan.packs ? 'VFX folders in Studio' : `import ${chosen.length} of ${scan.rows.length}`}</b>
        {!scan.packs && <span className="faint">{scan.source === 'studio' ? 'from the Studio selection' : 'from the dropped files'}{dups ? ` · ${dups} already in the library or repeated (unchecked)` : ''}</span>}
        <span className="grow" />
        {!scan.packs && scan.rows.length > 1 && (
          <>
            <button className="btn small ghost" onClick={() => all(true)}>
              all
            </button>
            <button className="btn small ghost" onClick={() => all(false)}>
              none
            </button>
          </>
        )}
        <button className="btn small ghost" onClick={onClose} aria-label="Close the import review">
          <Icon name="x" size={11} />
        </button>
      </div>
      {!!scan.notes.length && <p className="note tex-hint">{scan.notes.join(' ')}</p>}
      {!!scan.skipped.length && <p className="note tex-hint">Skipped {scan.skipped.length}: {scan.skipped.slice(0, 3).map((s) => `${s.file.split(/[\\/]/).pop()} (${s.reason})`).join('; ')}</p>}
      {scan.packs ? (
        <PackPicker packs={scan.packs} busy={!!progress} onRead={onRescan} />
      ) : (
        <>
          <ul className="tex-imp-list">
            {scan.rows.map((r) => (
              <Row key={r.key} r={r} e={edit[r.key] ?? { include: false, name: r.name }} scope={scope} rows={scan.rows} onEdit={(p) => setEdit({ ...edit, [r.key]: { ...edit[r.key], ...p } })} />
            ))}
          </ul>
          {!!scan.media.length && <p className="note">Also imports {scan.media.length} reference image{scan.media.length === 1 ? '' : 's'} / video{scan.media.length === 1 ? '' : 's'}.</p>}
          <div className="row">
            <select className="input tex-imp-scope" value={scope} onChange={(e) => (setScope(e.target.value as VfxScope), setEdit(defaults(scan, e.target.value as VfxScope)))} aria-label="Import into">
              <option value="user">your library</option>
              <option value="project" disabled={!projectOpen}>
                this project
              </option>
            </select>
            {progress && <span className="note mono" aria-live="polite">{importProgressText(progress)}</span>}
            <span className="grow" />
            <button className="btn small ghost" onClick={onClose}>
              Cancel
            </button>
            <button className="btn small primary" disabled={(!chosen.length && !scan.media.length) || busy} onClick={() => void commit()} data-testid="vfx-import-commit">
              {busy ? <span className="spinner" aria-hidden /> : <Icon name="download" size={11} />} Import {chosen.length}
            </button>
          </div>
        </>
      )}
    </section>
  )
}
