// "Add to game" dialog: pick the place and the folder (suggested from the project layout, the last
// choice remembered per lab), see the exact files, tick each existing file you want overwritten
// after reading its diff, then write. AddToGameButton is the lab-page button.
import { useEffect, useMemo, useState } from 'react'
import type { AddToGameOptions, AddToGamePlan, AddToGameResult, AddToGameTarget } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Dialog } from '../../shell/Overlays'
import { errorText } from '../../lib/format'
import { openAddToGame } from './events'
import './qolc.css'

const LAB_LABEL: Record<string, string> = { vfx: 'VFX effect', anim: 'Animation', ability: 'Ability' }
const STATUS_TAG: Record<string, string> = { new: 'ok', changed: 'warn', same: '', kept: 'info' }
const sameTarget = (a: AddToGameTarget | null, b: AddToGameTarget | null) => !!a && !!b && a.placeFile === b.placeFile && a.instance.join('/') === b.instance.join('/')

export function AddToGameButton({ lab, id, disabled, title, compact }: { lab: string; id: string; disabled?: boolean; title?: string; compact?: boolean }) {
  return (
    <button className={`btn small${compact ? ' ghost' : ''}`} onClick={() => openAddToGame(lab, id)} disabled={disabled} title={title ?? 'Pick the place and folder, review the files, write them into the game'}>
      <Icon name="download" size={11} /> Add to game
    </button>
  )
}

export function AddToGameDialog({ lab, id, onClose }: { lab: string; id: string; onClose: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const [opts, setOpts] = useState<AddToGameOptions | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<AddToGameTarget | null>(null)
  const [plan, setPlan] = useState<AddToGamePlan | null>(null)
  const [planning, setPlanning] = useState(false)
  const [confirmed, setConfirmed] = useState<Set<string>>(new Set())
  const [openDiff, setOpenDiff] = useState<string | null>(null)
  const [writing, setWriting] = useState(false)
  const [result, setResult] = useState<AddToGameResult | null>(null)
  const [uploading, setUploading] = useState<string | null>(null)

  const load = async () => {
    try {
      const o = await h.addToGameOptions(lab, id)
      setOpts(o)
      setTarget((t) => t ?? o.suggested)
    } catch (e) {
      setError(errorText(e))
    }
  }
  useEffect(() => {
    void load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lab, id])

  useEffect(() => {
    if (!target) return
    let live = true
    setPlanning(true)
    setConfirmed(new Set())
    setOpenDiff(null)
    h.addToGamePreview(lab, id, target)
      .then((p) => live && (setPlan(p), setError(null)))
      .catch((e) => live && (setPlan(null), setError(errorText(e))))
      .finally(() => live && setPlanning(false))
    return () => {
      live = false
    }
  }, [lab, id, target, h])

  const place = target?.placeFile ?? opts?.places[0]?.file ?? ''
  const placeTargets = useMemo(() => (opts ? opts.targets.filter((t) => t.placeFile === place) : []), [opts, place])
  const changed = plan?.files.filter((f) => f.status === 'changed') ?? []
  const toWrite = plan ? plan.files.filter((f) => f.status === 'new' || (f.status === 'changed' && confirmed.has(f.path))).length : 0

  const pickPlace = (file: string) => {
    const t = opts?.targets.find((x) => x.placeFile === file && x.recommended) ?? opts?.targets.find((x) => x.placeFile === file)
    setTarget(t ? { placeFile: t.placeFile, instance: t.instance } : null)
  }

  const upload = async (texId: string) => {
    setUploading(texId)
    try {
      await h.vfxTexUpload(texId)
      actions.toast({ text: 'Texture uploaded', kind: 'ok', ms: 2500 })
      await load()
      if (target) setTarget({ ...target })
    } catch (e) {
      actions.toast({ text: 'Upload failed', detail: errorText(e), kind: 'err' })
    } finally {
      setUploading(null)
    }
  }

  const write = async () => {
    if (!target) return
    setWriting(true)
    try {
      const r = await h.addToGameApply(lab, id, target, [...confirmed])
      setResult(r)
      actions.toast({ text: r.written.length ? `Added to the game: ${r.written.length} file${r.written.length === 1 ? '' : 's'}` : 'Nothing written', detail: r.skipped.length ? `${r.skipped.length} left as they are` : undefined, kind: r.written.length ? 'ok' : 'info', ms: 4000 })
    } catch (e) {
      actions.toast({ text: 'Add to game failed', detail: errorText(e), kind: 'err' })
    } finally {
      setWriting(false)
    }
  }

  const title = `Add to game${opts ? `: ${opts.name}` : ''}`
  return (
    <Dialog title={title} onClose={onClose} width={720}>
      <p className="a2g-sub">{LAB_LABEL[lab] ?? lab} · files go where Rojo maps the folder, nothing existing changes unless you tick it.</p>
      {error && !plan && <div className="a2g-error"><Icon name="warn" size={12} /> {error}</div>}
      {!opts && !error && <div className="doc-empty"><span className="spinner" aria-hidden /> Reading the project layout…</div>}
      {opts && !result && (
        <>
          {opts.places.length > 1 && (
            <div className="a2g-field">
              <span className="a2g-label">Place</span>
              <div className="seg" role="radiogroup" aria-label="Place">
                {opts.places.map((p) => (
                  <button key={p.file} role="radio" aria-checked={p.file === place} className={p.file === place ? 'on' : ''} onClick={() => pickPlace(p.file)} title={p.file}>
                    {p.name}
                    {p.isDefault ? <span className="faint"> · default</span> : null}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div className="a2g-field">
            <span className="a2g-label">Folder{opts.remembered && sameTarget(target, opts.suggested) ? <span className="faint"> · last used</span> : null}</span>
            <ul className="a2g-targets" role="radiogroup" aria-label="Folder">
              {placeTargets.map((t) => {
                const on = sameTarget(target, t)
                return (
                  <li key={t.dir}>
                    <button role="radio" aria-checked={on} className={`a2g-target${on ? ' on' : ''}`} onClick={() => setTarget({ placeFile: t.placeFile, instance: t.instance })}>
                      <span className={`a2g-radio${on ? ' on' : ''}`} aria-hidden />
                      <span className="a2g-tmain">
                        <span className="a2g-tlabel">{t.label}</span>
                        <span className="a2g-tdir mono">{t.dir}/{t.exists ? '' : <span className="faint"> (new folder)</span>}</span>
                      </span>
                      {t.recommended && <span className="tag ok">suggested</span>}
                      <span className="a2g-reason note">{t.reason}</span>
                    </button>
                  </li>
                )
              })}
              {!placeTargets.length && <li className="note">No folder in {place} that Rojo maps to disk on the {opts.realm} side.</li>}
            </ul>
          </div>
          {(opts.notes.length > 0 || !!opts.uploads?.length) && (
            <div className="a2g-notes">
              {opts.notes.map((n) => (
                <div key={n} className="note"><Icon name="info" size={11} /> {n}</div>
              ))}
              {opts.uploads?.map((u) => (
                <div key={u.id} className="a2g-upload">
                  <span className="mono">{u.label}</span>
                  <button className="btn small" onClick={() => void upload(u.id)} disabled={!!uploading}>
                    {uploading === u.id ? <span className="spinner" aria-hidden /> : <Icon name="upload" size={11} />} Upload to Roblox
                  </button>
                </div>
              ))}
            </div>
          )}
          <div className="a2g-field">
            <span className="a2g-label">Files {planning && <span className="spinner" aria-hidden />}</span>
            {error && plan === null && <div className="a2g-error">{error}</div>}
            {plan && (
              <ul className={`a2g-files${planning ? ' stale' : ''}`}>
                {plan.files.map((f) => (
                  <li key={f.path} className={`a2g-file ${f.status}`}>
                    <div className="a2g-frow">
                      <span className={`tag ${STATUS_TAG[f.status]}`}>{f.status === 'same' ? 'unchanged' : f.status === 'kept' ? 'kept' : f.status}</span>
                      <span className="mono a2g-path" title={f.path}>{f.path}</span>
                      <span className="faint a2g-role">{f.role}</span>
                      {f.status === 'changed' && (
                        <>
                          <button className="btn small ghost" onClick={() => setOpenDiff(openDiff === f.path ? null : f.path)} aria-expanded={openDiff === f.path}>
                            <Icon name="diff" size={11} /> Diff
                          </button>
                          <label className="a2g-confirm">
                            <input
                              type="checkbox"
                              checked={confirmed.has(f.path)}
                              onChange={(e) => {
                                const next = new Set(confirmed)
                                if (e.target.checked) next.add(f.path)
                                else next.delete(f.path)
                                setConfirmed(next)
                              }}
                            />
                            Overwrite
                          </label>
                        </>
                      )}
                      {f.note && <span className="note">{f.note}</span>}
                    </div>
                    {openDiff === f.path && f.diff && (
                      <pre className="a2g-diff" aria-label={`Diff of ${f.path}`}>
                        {f.diff.split('\n').map((line, i) => (
                          <span key={i} className={line.startsWith('+') && !line.startsWith('+++') ? 'add' : line.startsWith('-') && !line.startsWith('---') ? 'del' : line.startsWith('@@') ? 'hunk' : ''}>
                            {line || ' '}
                          </span>
                        ))}
                      </pre>
                    )}
                  </li>
                ))}
              </ul>
            )}
            {plan?.warnings.map((w) => (
              <div key={w} className="note a2g-warn"><Icon name="warn" size={11} /> {w}</div>
            ))}
            {plan?.requirePath && <div className="note">Require: <code>{plan.requirePath}</code></div>}
          </div>
          <div className="actions">
            {changed.length > 0 && confirmed.size < changed.length && <span className="note a2g-hint">{changed.length - confirmed.size} changed file{changed.length - confirmed.size === 1 ? '' : 's'} will be left as is.</span>}
            <button className="btn ghost" onClick={onClose}>Cancel</button>
            <button className="btn primary" onClick={() => void write()} disabled={!plan || planning || writing || toWrite === 0}>
              {writing ? <span className="spinner" aria-hidden /> : <Icon name="download" size={12} />} {toWrite ? `Write ${toWrite} file${toWrite === 1 ? '' : 's'}` : 'Up to date'}
            </button>
          </div>
        </>
      )}
      {result && (
        <div className="a2g-result">
          <div className="a2g-label">Written</div>
          <ul className="a2g-files">
            {result.written.map((p) => (
              <li key={p} className="a2g-file new">
                <div className="a2g-frow">
                  <span className="tag ok">written</span>
                  <button className="btn-link mono a2g-path" onClick={() => void actions.openFile(p)} title="Open file">{p}</button>
                </div>
              </li>
            ))}
            {result.skipped.map((p) => (
              <li key={p} className="a2g-file kept">
                <div className="a2g-frow">
                  <span className="tag">left as is</span>
                  <span className="mono a2g-path">{p}</span>
                </div>
              </li>
            ))}
            {!result.written.length && !result.skipped.length && <li className="note">Everything was already up to date.</li>}
          </ul>
          {result.command && (
            <div className="a2g-cmd">
              <code>{result.command}</code>
              <button className="btn small" onClick={() => void actions.copy(result.command!, 'command-bar line')}>
                <Icon name="copy" size={11} /> Copy
              </button>
            </div>
          )}
          <div className="actions">
            <button className="btn primary" onClick={onClose}>Done</button>
          </div>
        </div>
      )}
    </Dialog>
  )
}
