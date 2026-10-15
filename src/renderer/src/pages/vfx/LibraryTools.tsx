// VFX Lab library tools: tag filters by group (kind / element / timing / custom), the tag editor of
// an entry, Find duplicates, and the Live in Studio controls.
import { useEffect, useMemo, useState } from 'react'
import type { LiveStatus, VfxEntry } from '@shared/types'
import { TAG_GROUP_ORDER, tagGroupsOf, type TagGroup, type TagGroups } from '@shared/vfx/tags'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { errorText } from '../../lib/format'

export type TagFilter = Partial<Record<TagGroup, string>>

export function matchesTagFilter(e: VfxEntry, f: TagFilter): boolean {
  const g = tagGroupsOf(e)
  return TAG_GROUP_ORDER.every((k) => !f[k] || g[k].includes(f[k]!))
}

// One row of chips per group (most used first).
export function TagFilters({ entries, filter, onChange }: { entries: VfxEntry[]; filter: TagFilter; onChange: (f: TagFilter) => void }) {
  const counts = useMemo(() => {
    const out = Object.fromEntries(TAG_GROUP_ORDER.map((k) => [k, new Map<string, number>()])) as Record<TagGroup, Map<string, number>>
    for (const e of entries) {
      const g = tagGroupsOf(e)
      for (const k of TAG_GROUP_ORDER) for (const t of g[k]) out[k].set(t, (out[k].get(t) ?? 0) + 1)
    }
    return out
  }, [entries])
  return (
    <div className="vfx-tag-groups">
      {TAG_GROUP_ORDER.map((k) => {
        const list = [...counts[k].entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 14)
        if (!list.length) return null
        return (
          <div key={k} className="vfx-chips" role="group" aria-label={`Filter by ${k}`}>
            <span className="vfx-chip-group mono">{k}</span>
            {list.map(([t, n]) => (
              <button key={t} className={`badge-o${filter[k] === t ? ' hot' : ''}`} aria-pressed={filter[k] === t} onClick={() => onChange({ ...filter, [k]: filter[k] === t ? undefined : t })}>
                {t} <span className="faint">{n}</span>
              </button>
            ))}
          </div>
        )
      })}
    </div>
  )
}

// Tags of one entry by group; edits mark the group as the user's (re-tag keeps it).
export function TagGroupEditor({ entry }: { entry: VfxEntry }) {
  const { actions } = useStore()
  const groups = tagGroupsOf(entry)
  const [text, setText] = useState<Record<TagGroup, string>>(() => Object.fromEntries(TAG_GROUP_ORDER.map((k) => [k, groups[k].join(', ')])) as Record<TagGroup, string>)
  useEffect(() => {
    const g = tagGroupsOf(entry)
    setText(Object.fromEntries(TAG_GROUP_ORDER.map((k) => [k, g[k].join(', ')])) as Record<TagGroup, string>)
  }, [entry.id, entry.updatedAt])
  const save = async (k: TagGroup) => {
    const list = text[k].split(',').map((t) => t.trim().toLowerCase()).filter(Boolean)
    if (list.join(', ') === groups[k].join(', ')) return
    try {
      await window.harness.vfxUpdate(entry.id, { tagGroups: { [k]: list } as Partial<TagGroups> })
    } catch (e) {
      actions.toast({ text: 'Could not save the tags', detail: errorText(e), kind: 'err' })
    }
  }
  const why = (k: TagGroup) => (entry.autoTagInfo ?? []).filter((a) => a.group === k).map((a) => `${a.tag} ${Math.round(a.confidence * 100)}%: ${a.why}`).join('\n')
  return (
    <div className="vfx-tag-edit">
      {TAG_GROUP_ORDER.map((k) => (
        <label key={k} className="vfx-tag-edit-row" title={why(k) || undefined}>
          <span className="mono faint">
            {k}
            {(entry.userTagGroups ?? []).includes(k) ? ' ·you' : ''}
          </span>
          <input className="input" value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} onBlur={() => void save(k)} onKeyDown={(e) => e.key === 'Enter' && (e.currentTarget as HTMLInputElement).blur()} aria-label={`${k} tags`} placeholder={k === 'custom' ? 'your own tags, e.g. ball trail, goal' : ''} />
        </label>
      ))}
    </div>
  )
}

// Groups of identical effects; "Remove extras" keeps the first of each group.
export function DuplicatesPanel({ onClose, onRemoved }: { onClose: () => void; onRemoved: (batch: string, n: number) => void }) {
  const { actions } = useStore()
  const [groups, setGroups] = useState<{ hash: string; scope: string; entries: VfxEntry[] }[] | null>(null)
  useEffect(() => {
    window.harness
      .vfxDuplicates()
      .then(setGroups)
      .catch((e) => actions.toast({ text: 'Could not look for duplicates', detail: errorText(e), kind: 'err' }))
  }, [])
  const extras = (groups ?? []).flatMap((g) => g.entries.slice(1).map((e) => e.id))
  const remove = async () => {
    try {
      const r = await window.harness.vfxTrash(extras)
      onRemoved(r.batch, r.removed.length)
    } catch (e) {
      actions.toast({ text: 'Could not remove the duplicates', detail: errorText(e), kind: 'err' })
    }
  }
  return (
    <section className="set-sec tex-imp-review vfx-dups" aria-label="Duplicates">
      <div className="row">
        <b className="mono">duplicates</b>
        <span className="faint">{groups ? (groups.length ? `${groups.length} effect${groups.length === 1 ? '' : 's'} imported more than once` : 'no duplicates: every effect is in the library once') : 'looking…'}</span>
        <span className="grow" />
        {!!extras.length && (
          <button className="btn small primary" onClick={() => void remove()} data-testid="vfx-dups-remove">
            <Icon name="trash" size={11} /> Remove {extras.length} extra{extras.length === 1 ? '' : 's'}
          </button>
        )}
        <button className="btn small ghost" onClick={onClose} aria-label="Close duplicates">
          <Icon name="x" size={11} />
        </button>
      </div>
      {!!groups?.length && (
        <ul className="tex-imp-list">
          {groups.map((g) => (
            <li key={`${g.scope}:${g.hash}`} className="tex-imp-row">
              <div className="tex-imp-main">
                <span>
                  keep <b>{g.entries[0].name}</b> <span className="faint">({g.scope})</span>
                </span>
                <span className="faint mono">remove: {g.entries.slice(1).map((e) => e.name).join(', ')}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

// Header toggle: Studio loops whatever is current. The gap / place options show while anything
// loops (a Loop from Test in Studio too).
export function LiveControls({ live, enabled, onToggle, onSettings }: { live: LiveStatus | null; enabled: boolean; onToggle: (on: boolean) => void; onSettings: (s: Partial<LiveStatus['settings']>) => void }) {
  const st = live?.state ?? 'off'
  const settings = live?.settings ?? { gap: 0.75, mode: 'dummy' as const }
  return (
    <span className={`vfx-live${enabled ? ' on' : ''}`}>
      <button className={`btn${enabled ? ' on' : ''}`} aria-pressed={enabled} onClick={() => onToggle(!enabled)} title="Live in Studio: Roblox Studio keeps replaying the effect you are looking at (selection, edits, refine iterations). Uses the Forge Bridge plugin; spawns go into Workspace.ForgeLivePreview and are removed when it stops.">
        <span className={`vfx-live-dot ${st}`} aria-hidden /> Live in Studio
      </button>
      {(enabled || st !== 'off') && (
        <>
          <label className="vfx-live-opt" title="Pause between replays (seconds)">
            gap
            <input className="input mono" type="number" min={0} max={10} step={0.25} value={settings.gap} onChange={(e) => onSettings({ gap: Number(e.target.value) })} aria-label="Gap between replays" />
          </label>
          <select className="input vfx-live-opt" value={settings.mode} onChange={(e) => onSettings({ mode: e.target.value as 'dummy' | 'origin' })} aria-label="Where Studio plays it">
            <option value="dummy">on the dummy</option>
            <option value="origin">at the origin</option>
          </select>
        </>
      )}
    </span>
  )
}

export function liveLine(live: LiveStatus | null): string | null {
  if (!live || live.state === 'off') return null
  if (live.state === 'looping') return `${live.pinned ? 'Looping' : 'Live'} in Studio${live.label ? ` · ${live.label}` : live.name ? ` · ${live.name}` : ''}${live.plays ? ` · ${live.plays} plays` : ''}${live.pinned && live.following ? ' · Live follows the lab after this loop' : ''}`
  if (live.state === 'paused') return 'Live in Studio paused while Studio runs another job'
  if (live.state === 'starting') return 'Starting the loop in Studio…'
  return live.message ?? (live.name ? 'Waiting for Studio…' : 'Live in Studio: pick an effect')
}
