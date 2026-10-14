// Thumbnail Lab building blocks: image loading, variation cards, the discovery-page preview strip,
// reference cards and style profile cards.
import { useEffect, useState } from 'react'
import type { Thumb, ThumbRef, ThumbStyleProfile } from '@shared/types'
import { ctrTotals, formatCtr } from '@shared/thumbs/ctr'
import { Icon } from '../../components/Icons'

// Library files as data URLs, cached per kind + id + which + update time.
const cache = new Map<string, string | null>()
export function useThumbFile(kind: 'ref' | 'base' | 'thumb', id: string | undefined, which: 'image' | 's256' | 's160' = 'image', stamp = 0): string | null {
  const key = id ? `${kind}/${id}/${which}@${stamp}` : ''
  const [url, setUrl] = useState<string | null>(key ? (cache.get(key) ?? null) : null)
  useEffect(() => {
    if (!id) return setUrl(null)
    if (cache.has(key)) return setUrl(cache.get(key) ?? null)
    let live = true
    window.harness
      .thumbFile(kind, id, which)
      .then((u) => {
        cache.set(key, u)
        if (live) setUrl(u)
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
  }, [key])
  return url
}

export const score = (t: Thumb) => t.critique?.overall ?? null
const tone = (s: number | null) => (s == null ? '' : s >= 8 ? 'ok' : s >= 6 ? 'info' : 'warn')

export function ThumbCard({ thumb, best, selected, onSelect }: { thumb: Thumb; best?: boolean; selected: boolean; onSelect: () => void }) {
  const url = useThumbFile('thumb', thumb.id, 'image', thumb.updatedAt)
  const s = score(thumb)
  const flagged = (thumb.critique?.copyFlags.length ?? 0) > 0
  return (
    <button className={`th-card${selected ? ' on' : ''}${best ? ' best' : ''}`} onClick={onSelect} aria-pressed={selected} title={thumb.critique?.summary || thumb.brief}>
      <div className="th-img">
        {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="th-ph" />}
        <span className="th-badges">
          {best && <span className="tag ok">best</span>}
          {flagged && <span className="tag err">copy?</span>}
          {thumb.round > 0 && <span className="tag info">r{thumb.round}</span>}
        </span>
        {s != null && <span className={`th-score mono ${tone(s)}`}>{s.toFixed(1)}</span>}
      </div>
      <div className="th-cap">
        <span className="mono faint">#{thumb.id.split('-').pop()}</span>
        <span className="th-cap-name">{thumb.critique?.by === 'code' ? 'measured' : (thumb.critique?.summary ?? '')}</span>
        {thumb.rating === 'up' && <span className="tag ok">+1</span>}
        {thumb.rating === 'down' && <span className="tag err">−1</span>}
        {thumb.ship && <span className="tag ok">ship</span>}
        {thumb.roblox && <span className="tag info">uploaded</span>}
      </div>
    </button>
  )
}

// One tile as it sits on the discovery page: the thumbnail at its real pixel size and the meta line.
function Tile({ thumb, size, game }: { thumb: Thumb; size: 's256' | 's160'; game: string }) {
  const url = useThumbFile('thumb', thumb.id, size, thumb.updatedAt)
  const w = size === 's256' ? 256 : 160
  return (
    <figure className={`th-tile ${size}`} style={{ width: w }}>
      <div className="th-tile-img" style={{ width: w, height: (w * 9) / 16 }}>
        {url && <img src={url} alt={`#${thumb.id.split('-').pop()} at ${w}px`} width={w} height={(w * 9) / 16} draggable={false} />}
      </div>
      <figcaption>
        <span className="th-tile-title">{game}</span>
        <span className="th-tile-meta">
          <Icon name="check" size={9} /> 91% · 2.4K playing
        </span>
      </figcaption>
    </figure>
  )
}

// How the variations look on Roblox's discovery page (phone and desktop tile sizes, dark / light).
export function DiscoveryStrip({ thumbs, game }: { thumbs: Thumb[]; game: string }) {
  const [theme, setTheme] = useState<'dark' | 'light'>('dark')
  if (!thumbs.length) return null
  return (
    <section className="th-disc" aria-label="Discovery page preview">
      <div className="th-disc-head">
        <span className="mono">discovery preview</span>
        <span className="faint">real pixel sizes: 160×90 (phone) and 256×144 (desktop)</span>
        <span className="grow" />
        <div className="seg" role="group" aria-label="Page theme">
          {(['dark', 'light'] as const).map((t) => (
            <button key={t} className={theme === t ? 'on' : ''} aria-pressed={theme === t} onClick={() => setTheme(t)}>
              {t}
            </button>
          ))}
        </div>
      </div>
      <div className={`th-disc-page ${theme}`}>
        <div className="th-disc-row" aria-label="Phone tiles">
          {thumbs.map((t) => (
            <Tile key={t.id} thumb={t} size="s160" game={game} />
          ))}
        </div>
        <div className="th-disc-row" aria-label="Desktop tiles">
          {thumbs.map((t) => (
            <Tile key={t.id} thumb={t} size="s256" game={game} />
          ))}
        </div>
      </div>
    </section>
  )
}

export function Swatches({ colors, size = 12 }: { colors: string[]; size?: number }) {
  return (
    <span className="th-sw" aria-label={`palette ${colors.join(' ')}`}>
      {colors.map((c) => (
        <i key={c} style={{ background: c, width: size, height: size }} title={c} />
      ))}
    </span>
  )
}

export function RefCard({ r, selected, onToggle, onDelete }: { r: ThumbRef; selected: boolean; onToggle: () => void; onDelete: () => void }) {
  const url = useThumbFile('ref', r.id, 'image', r.updatedAt)
  const c = r.card
  return (
    <article className={`th-ref${selected ? ' on' : ''}`}>
      <button className="th-img" onClick={onToggle} aria-pressed={selected} title={selected ? 'Selected for a style profile' : 'Select for a style profile'}>
        {url ? <img src={url} alt="" loading="lazy" draggable={false} /> : <span className="th-ph" />}
        <span className="th-check" aria-hidden>{selected && <Icon name="check" size={11} />}</span>
      </button>
      <div className="th-ref-body">
        <div className="th-ref-head">
          <span className="th-ref-name mono">{r.name}</span>
          <button className="btn small ghost danger" onClick={onDelete} aria-label={`Delete ${r.name}`}>
            <Icon name="trash" size={10} />
          </button>
        </div>
        {r.game && <span className="faint th-ref-game">from {r.game} · style only</span>}
        {c ? (
          <>
            <div className="th-chips">
              <span className="badge-o">{c.framing}</span>
              <span className="badge-o">{c.saturation}</span>
              {c.text.present ? <span className="badge-o">{c.text.words}w {c.text.size}</span> : <span className="badge-o">no text</span>}
              {c.outline && <span className="badge-o">outline</span>}
              {c.rimLight && <span className="badge-o">rim</span>}
              {c.glow && <span className="badge-o">glow</span>}
              {c.emotion && <span className="badge-o">{c.emotion}</span>}
            </div>
            <div className="th-ref-meta mono">
              <Swatches colors={c.palette.length ? c.palette : r.stats.palette.map((p) => p.hex)} />
              <span>focal {c.focalContrast.toFixed(0)}</span>
              <span>clutter {c.clutter.toFixed(0)}</span>
            </div>
          </>
        ) : (
          <span className="note">
            <span className="spinner" aria-hidden /> reading the style…
          </span>
        )}
        {r.analyzeError && <span className="note err-text">{r.analyzeError}</span>}
      </div>
    </article>
  )
}

const pct = (x: number) => `${Math.round(x * 100)}%`

export function ProfileCard({ p, refs, active, onUse, onDelete }: { p: ThumbStyleProfile; refs: ThumbRef[]; active: boolean; onUse: () => void; onDelete: () => void }) {
  const mine = p.refIds.map((id) => refs.find((r) => r.id === id)).filter((r): r is ThumbRef => !!r)
  const bars: [string, number][] = [
    ['outline', p.card.outline],
    ['rim light', p.card.rimLight],
    ['glow', p.card.glow],
    ['text', p.card.text.share]
  ]
  return (
    <article className={`th-prof${active ? ' on' : ''}`}>
      <header className="th-prof-head">
        <b className="mono">{p.name}</b>
        <span className="badge-o">{p.scope}</span>
        <span className="faint">{mine.length} ref{mine.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className={`btn small${active ? ' primary' : ''}`} onClick={onUse} aria-pressed={active}>
          {active ? 'in use' : 'use'}
        </button>
        <button className="btn small ghost danger" onClick={onDelete} aria-label={`Delete ${p.name}`}>
          <Icon name="trash" size={10} />
        </button>
      </header>
      <div className="th-prof-refs">
        {mine.slice(0, 6).map((r) => (
          <MiniRef key={r.id} r={r} />
        ))}
      </div>
      <div className="th-prof-grid">
        <div className="th-prof-col">
          <div className="th-chips">
            <span className="badge-o">
              {p.card.framing.mode} {pct(p.card.framing.share)}
            </span>
            <span className="badge-o">{p.card.saturation}</span>
            {p.card.emotions.map((e) => (
              <span key={e} className="badge-o">
                {e}
              </span>
            ))}
          </div>
          <Swatches colors={p.card.palette} size={16} />
          <span className="mono faint">
            focal {p.card.focalContrast.toFixed(1)} · clutter {p.card.clutter.toFixed(1)} · contrast {p.stats.contrast.toFixed(2)}
          </span>
        </div>
        <div className="th-prof-col">
          {bars.map(([k, v]) => (
            <div key={k} className="vfx-rub" title={`${k}: ${pct(v)} of the references`}>
              <span>{k}</span>
              <span className="vfx-bar">
                <i style={{ width: pct(v) }} className={v < 0.5 ? 'low' : ''} />
              </span>
              <b>{pct(v)}</b>
            </div>
          ))}
        </div>
      </div>
      <p className="th-prof-sum" title="This is the style text that goes into the prompt (fields only, never names or copied text)">
        <span className="faint mono">prompt style ›</span> {p.summary}
      </p>
    </article>
  )
}

function MiniRef({ r }: { r: ThumbRef }) {
  const url = useThumbFile('ref', r.id, 'image', r.updatedAt)
  return <span className="th-mini">{url && <img src={url} alt={r.name} draggable={false} />}</span>
}

export function ctrText(t: Thumb): string {
  const tot = ctrTotals(t.ctr)
  return tot.impressions ? `${formatCtr(tot.ctr)} · ${tot.clicks.toLocaleString()} / ${tot.impressions.toLocaleString()}` : '–'
}
