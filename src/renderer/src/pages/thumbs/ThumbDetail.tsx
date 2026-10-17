// The critique panel for one variation: the image, rating / would ship, refine with a note, the
// principle scorecard (critic + code checks), copy-guard flags, small-size numbers, CTR entry and the
// Roblox actions (upload as an Image asset; adding it to the experience's thumbnails behind a confirm).
// Clicking the image opens it fullscreen.
import { useState } from 'react'
import type { Thumb, ThumbStatus } from '@shared/types'
import { ctrOf, ctrTotals, formatCtr, wilson } from '@shared/thumbs/ctr'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Lightbox } from '../../components/Lightbox'
import { errorText } from '../../lib/format'
import { PrincipleScorecard, usePrincipleWeights } from '../principles/Principles'
import { RestatedBrief } from '../../components/RestateCard'
import { useThumbFile } from './parts'

export function ThumbDetail({ thumb, status, busy, onClose, onRefined }: { thumb: Thumb; status: ThumbStatus | null; busy: string | null; onClose: () => void; onRefined: (id: string) => void }) {
  const { actions } = useStore()
  const h = window.harness
  const url = useThumbFile('thumb', thumb.id, 'image', thumb.updatedAt)
  const weights = usePrincipleWeights()
  const [note, setNote] = useState('')
  const [working, setWorking] = useState<string | null>(null)
  const [ctr, setCtr] = useState({ impressions: '', clicks: '', period: '' })
  const [confirmExp, setConfirmExp] = useState(false)
  const [full, setFull] = useState(false)
  const [universe, setUniverse] = useState(String(status?.universeId ?? ''))
  const c = thumb.critique
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
  const rate = (r: 'up' | 'down') => run('rating', () => h.thumbRate(thumb.id, thumb.rating === r ? null : r))
  const refine = () =>
    run('refine', async () => {
      const r = await h.thumbRefine(thumb.id, { ...(note.trim() ? { note: note.trim() } : {}), rounds: 1 })
      setNote('')
      if (r.thumbs[0]) onRefined(r.thumbs[0].id)
    })
  const addCtr = () =>
    run(
      'CTR entry',
      async () => {
        await h.thumbAddCtr(thumb.id, { impressions: Number(ctr.impressions), clicks: Number(ctr.clicks), ...(ctr.period.trim() ? { period: ctr.period.trim() } : {}) })
        setCtr({ impressions: '', clicks: '', period: '' })
      },
      'CTR saved: it now counts as a strong taste label'
    )
  const setExperience = () =>
    run(
      'adding to the experience',
      async () => {
        await h.thumbSetExperience(thumb.id, { universeId: Number(universe), languageCode: status?.settings.languageCode })
        setConfirmExp(false)
      },
      'Added to the experience thumbnails. Reorder them in Creator Hub.'
    )
  const tot = ctrTotals(thumb.ctr)
  const ci = tot.impressions ? wilson(tot.clicks, tot.impressions) : null
  const flags = c?.copyFlags ?? []
  const refining = working === 'refine' || (busy?.startsWith('refining') ?? false)

  return (
    <section className="vfx-detail th-detail" aria-label={`Variation ${thumb.id} critique`}>
      <div className="vfx-detail-head">
        <Icon name="thumbnail" size={13} />
        <b className="vfx-title">#{thumb.id.split('-').pop()}</b>
        {c && <span className="vfx-score mono">{c.overall.toFixed(1)}</span>}
        <span className="faint mono">{c?.by === 'code' ? 'measured' : 'critic'}</span>
        <span className="grow" />
        <button className={`btn small ghost${thumb.rating === 'up' ? ' on' : ''}`} aria-pressed={thumb.rating === 'up'} onClick={() => void rate('up')} title="Good: teaches your taste">
          +1
        </button>
        <button className={`btn small ghost${thumb.rating === 'down' ? ' on' : ''}`} aria-pressed={thumb.rating === 'down'} onClick={() => void rate('down')} title="Bad: teaches what to avoid">
          −1
        </button>
        <button className={`btn small${thumb.ship ? ' on' : ''}`} aria-pressed={!!thumb.ship} onClick={() => void run('ship', () => h.thumbShip(thumb.id, !thumb.ship))} title="Would ship this: a stronger taste label than +1">
          <Icon name="check" size={11} /> would ship
        </button>
        <button className="btn small ghost" onClick={onClose} aria-label="Close critique">
          <Icon name="x" size={12} />
        </button>
      </div>

      <button type="button" className="th-big" onClick={() => setFull(true)} disabled={!url} aria-label="View fullscreen" title="View fullscreen">
        {url ? <img src={url} alt={`Variation ${thumb.id}`} draggable={false} /> : <span className="th-ph" />}
      </button>
      {full && url && <Lightbox items={[{ key: thumb.id, name: `Variation #${thumb.id.split('-').pop()}`, src: url }]} index={0} onIndex={() => undefined} onClose={() => setFull(false)} />}

      <div className="vfx-actions">
        <input className="input grow th-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="what to change (optional): bigger shark, fewer words…" aria-label="Refine note" />
        <button className="btn small primary" onClick={() => void refine()} disabled={refining} title="Edit this variation with the critic's changes (and your note), then critique the result">
          {refining ? <span className="spinner" aria-hidden /> : <Icon name="restart" size={11} />} Refine
        </button>
        <button className="btn small" onClick={() => void run('critique', () => h.thumbCritique(thumb.id))} disabled={!!working}>
          {working === 'critique' ? <span className="spinner" aria-hidden /> : <Icon name="eye" size={11} />} Critique
        </button>
        <button className="btn small" onClick={() => void run('use as reference', () => h.thumbUseAsRef(thumb.id), 'Added to your references: put it in a style profile')} disabled={!!working} title="Add this variation to your references, so a style profile can carry its look into later thumbnails">
          <Icon name="pin" size={11} /> Use as reference
        </button>
      </div>

      {flags.length > 0 && (
        <div className="callout err row" role="alert">
          <Icon name="warn" size={12} />
          <span className="grow note">
            <b>Copy guard:</b> {flags.join(' · ')}. Thumbnails must show your own game; this one will not be picked as best.
          </span>
        </div>
      )}

      {thumb.restatement && (
        <div className="note">
          <span className="faint mono">brief ›</span> <RestatedBrief r={thumb.restatement} />
        </div>
      )}
      {c && <p className="vfx-iter-sum">{c.summary}</p>}
      {c && <PrincipleScorecard principles={c.principles} focus={c.focus} score={c.overall} weights={weights} />}
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
        <dt>small</dt>
        <dd className="mono">
          legible {thumb.report.legibility160.toFixed(1)} @160 · {thumb.report.legibility256.toFixed(1)} @256 · focal {thumb.report.focal160.toFixed(1)} · detail kept {Math.round(thumb.report.detailKept * 100)}%
        </dd>
        <dt>colour</dt>
        <dd className="mono">
          sat {thumb.stats.saturation.toFixed(2)} · vivid {Math.round(thumb.stats.vivid * 100)}% · contrast {thumb.stats.contrast.toFixed(2)} · pop dark {Math.round(thumb.report.popDark * 100)}% / light {Math.round(thumb.report.popLight * 100)}%
        </dd>
        <dt>made</dt>
        <dd className="mono">
          {thumb.model} · {thumb.genSize} → 1920×1080 · {thumb.quality} · ${thumb.costUsd.toFixed(3)}
          {thumb.parentId ? ` · refined from #${thumb.parentId.split('-').pop()}` : ''}
        </dd>
      </dl>

      <section className="th-ctr" aria-label="Click-through rate">
        <div className="th-sec-head">
          <span className="mono">CTR</span>
          <span className="faint">from Creator Hub analytics after it ran as a thumbnail; real clicks outweigh ratings</span>
          <span className="grow" />
          {tot.impressions > 0 && (
            <span className="mono">
              {formatCtr(tot.ctr)} {ci && <span className="faint">({formatCtr(ci.low)}–{formatCtr(ci.high)})</span>}
            </span>
          )}
        </div>
        {thumb.ctr.length > 0 && (
          <table className="th-table">
            <thead>
              <tr>
                <th>period</th>
                <th className="num">impressions</th>
                <th className="num">clicks</th>
                <th className="num">CTR</th>
                <th aria-label="Remove" />
              </tr>
            </thead>
            <tbody>
              {thumb.ctr.map((r, i) => (
                <tr key={i}>
                  <td>{r.period ?? new Date(r.at).toLocaleDateString()}</td>
                  <td className="num mono">{r.impressions.toLocaleString()}</td>
                  <td className="num mono">{r.clicks.toLocaleString()}</td>
                  <td className="num mono">{formatCtr(ctrOf(r))}</td>
                  <td>
                    <button className="btn small ghost" onClick={() => void run('remove CTR', () => h.thumbRemoveCtr(thumb.id, i))} aria-label="Remove this row">
                      <Icon name="x" size={10} />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <form
          className="th-ctr-form"
          onSubmit={(e) => {
            e.preventDefault()
            void addCtr()
          }}
        >
          <input className="input mono" inputMode="numeric" value={ctr.impressions} onChange={(e) => setCtr({ ...ctr, impressions: e.target.value })} placeholder="impressions" aria-label="Impressions" />
          <input className="input mono" inputMode="numeric" value={ctr.clicks} onChange={(e) => setCtr({ ...ctr, clicks: e.target.value })} placeholder="clicks" aria-label="Clicks" />
          <input className="input" value={ctr.period} onChange={(e) => setCtr({ ...ctr, period: e.target.value })} placeholder="period (optional)" aria-label="Period" />
          <button className="btn small" disabled={!ctr.impressions || ctr.clicks === ''}>
            <Icon name="plus" size={10} /> Add
          </button>
        </form>
      </section>

      <div className="vfx-actions th-roblox">
        <button className="btn small" disabled={!!thumb.roblox || !!working || !status?.robloxKey} onClick={() => void run('upload', () => h.thumbUpload(thumb.id), 'Uploaded as an Image asset')} title={status?.robloxKey ? 'Open Cloud Assets API, as an Image' : 'Add an Open Cloud key on the Art page'}>
          {working === 'upload' ? <span className="spinner" aria-hidden /> : <Icon name="upload" size={11} />} {thumb.roblox ? 'Uploaded' : 'Upload to Roblox'}
        </button>
        {thumb.roblox && (
          <button className="btn small ghost mono" onClick={() => void actions.copy(thumb.roblox!.uri, 'Asset id')} title="Copy the asset id">
            {thumb.roblox.uri}
            {thumb.roblox.moderation ? ` · ${thumb.roblox.moderation}` : ''}
          </button>
        )}
        <span className="grow" />
        {thumb.experience ? (
          <span className="tag ok" title={`media ${thumb.experience.mediaAssetId}`}>
            on experience {thumb.experience.universeId}
          </span>
        ) : (
          <button className="btn small" onClick={() => setConfirmExp(true)} disabled={!status?.robloxKey}>
            <Icon name="external" size={11} /> Add to experience…
          </button>
        )}
        <button className="btn small ghost danger" onClick={() => confirm('Delete this variation?') && void run('delete', () => h.thumbDelete(thumb.id).then(onClose))} aria-label="Delete variation">
          <Icon name="trash" size={11} />
        </button>
      </div>
      {confirmExp && (
        <div className="callout th-confirm" role="dialog" aria-label="Add to the experience thumbnails">
          <p className="note">
            This adds the image to your live experience's thumbnails through Roblox's <b>experimental</b> Open Cloud thumbnail API (the key needs <span className="mono">legacy-universe:manage</span>). Players see it once Roblox approves it. You can also upload it in Creator Hub: your experience › Places › Thumbnails.
          </p>
          <div className="row">
            <label className="art-opt">
              <span>universe id</span>
              <input className="input mono" inputMode="numeric" value={universe} onChange={(e) => setUniverse(e.target.value.replace(/\D/g, ''))} aria-label="Universe id" />
            </label>
            <span className="grow" />
            <button className="btn small" onClick={() => setConfirmExp(false)}>
              Cancel
            </button>
            <button className="btn small primary" disabled={!universe || working === 'adding to the experience'} onClick={() => void setExperience()}>
              {working === 'adding to the experience' ? <span className="spinner" aria-hidden /> : null} Yes, add it
            </button>
          </div>
        </div>
      )}
      <details className="vfx-changes">
        <summary>prompt</summary>
        <pre className="th-prompt mono">{thumb.prompt}</pre>
      </details>
    </section>
  )
}
