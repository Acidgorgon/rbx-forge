// Forge Sync in the Source control view: per place, whether Studio has been checked before Rojo
// serves (gate), conflicts with a 3-way compare (opens the conflict tab), first-run bulk choice,
// "Commit teammate edits", recent Studio -> disk activity and the legacy plugin banner.
import { useEffect, useState } from 'react'
import type { GateState, PlaceSyncStatus, SyncAction, SyncEntry, SyncRef, SyncStatus } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ago, errorText } from '../lib/format'
import { basename } from '../lib/roblox'
import './forgesync.css'

export function useForgeSync(): [SyncStatus | null, (s: SyncStatus) => void] {
  const [status, setStatus] = useState<SyncStatus | null>(null)
  useEffect(() => {
    let live = true
    void window.harness.syncStatus().then((s) => live && setStatus(s)).catch(() => undefined)
    const off = window.harness.on('sync:status', (s) => setStatus(s))
    return () => {
      live = false
      off()
    }
  }, [])
  return [status, setStatus]
}

const GATE: Record<GateState, { cls: string; label: string; hint: string }> = {
  idle: { cls: '', label: 'no studio', hint: 'No Studio session for this place yet: Rojo serves normally.' },
  checking: { cls: 'info', label: 'checking', hint: 'Reading Studio first. Rojo waits so it cannot overwrite teammate edits.' },
  clear: { cls: 'ok', label: 'clear', hint: 'Studio and disk agree. Rojo serves.' },
  blocked: { cls: 'warn', label: 'held', hint: 'Conflicts or Studio-only scripts held. Rojo waits until you pick a side or pull them to disk (or serve anyway).' }
}

const ACTION: Partial<Record<SyncAction, { letter: string; cls: string; label: string }>> = {
  pulled: { letter: 'P', cls: 'ok', label: 'pulled from Studio' },
  merged: { letter: 'M', cls: 'ok', label: 'merged (both changed)' },
  created: { letter: 'A', cls: 'ok', label: 'new in Studio' },
  renamed: { letter: 'R', cls: 'info', label: 'renamed in Studio' },
  trashed: { letter: 'D', cls: 'err', label: 'deleted in Studio (moved to .forge/sync/trash)' },
  conflict: { letter: '!', cls: 'warn', label: 'conflict held' },
  'disk-ahead': { letter: '↑', cls: '', label: 'disk ahead: Rojo will push it' },
  unmapped: { letter: 'S', cls: '', label: 'stays in Studio' }
}

const COUNT_ORDER: SyncAction[] = ['same', 'pulled', 'merged', 'created', 'renamed', 'trashed', 'disk-ahead', 'conflict']

// What kind of reference each property is, for the one-line summary.
const REF_KIND: Record<string, string> = { Value: 'ObjectValue', Part0: 'welds', Part1: 'welds', Attachment0: 'attachments', Attachment1: 'attachments', PrimaryPart: 'PrimaryPart' }

export function refsSummary(refs: SyncRef[], total: number): string {
  const kinds = [...new Set(refs.map((r) => REF_KIND[r.property] ?? r.property))]
  const shown = kinds.slice(0, 2).join(', ') + (kinds.length > 2 || total > refs.length ? '…' : '')
  return `${total} reference${total === 1 ? " isn't" : "s aren't"} synced (${shown}); they stay in Studio only`
}

function countsText(p: PlaceSyncStatus): string {
  const parts = COUNT_ORDER.filter((a) => p.counts[a]).map((a) => `${p.counts[a]} ${a === 'disk-ahead' ? 'disk ahead' : a}`)
  return parts.join(' · ') || (p.connected ? 'waiting for the snapshot' : 'open the place in Studio')
}

export function ForgeSyncSection({ status, setStatus }: { status: SyncStatus | null; setStatus: (s: SyncStatus) => void }) {
  const { state, actions } = useStore()
  const [busy, setBusy] = useState<string | null>(null)
  const [showPending, setShowPending] = useState(false)
  const [showRefs, setShowRefs] = useState(false)
  const [showOnly, setShowOnly] = useState<string | null>(null)

  if (!status || status.engine !== 'forge') return null
  const conflicts = state.studioConflicts.filter((c) => c.placeKey)
  const placeName = (p: PlaceSyncStatus) => p.place?.name || state.places.find((x) => x.file === p.projectFile)?.name || p.projectFile.replace(/\.project\.json$/, '')

  const act = async (key: string, run: () => Promise<SyncStatus | void>, ok?: string) => {
    setBusy(key)
    try {
      const next = await run()
      if (next) setStatus(next)
      if (ok) actions.toast({ text: ok, kind: 'ok', ms: 2500 })
      await actions.refreshSync()
    } catch (e) {
      actions.toast({ text: 'Forge Sync', detail: errorText(e), kind: 'err' })
    } finally {
      setBusy(null)
    }
  }

  const commit = () =>
    act('commit', async () => {
      const r = await window.harness.syncCommitStudioEdits()
      if (r.error) throw new Error(r.error)
      actions.toast({ text: `Committed ${r.committed.length} teammate edit${r.committed.length === 1 ? '' : 's'}`, detail: r.message, kind: 'ok' })
      return window.harness.syncStatus()
    })

  const pending = status.pendingStudioEdits

  return (
    <section className="vsec fs">
      <div className="vsec-head">
        Studio sync
        <span className="count">{status.places.filter((p) => p.connected).length}/{status.places.length}</span>
        <span className="grow" />
        <button className="link-btn" onClick={() => actions.openPage('settings')} title="Settings > Sync">settings</button>
      </div>

      {status.legacyPluginInstalled && (
        <div className="callout warn fs-callout">
          <div>
            The old Studio sync plugin is still installed{status.legacyPlugins?.length ? ` (${status.legacyPlugins.join(', ')})` : ''}. It would sync the same scripts a second time.
          </div>
          <button className="mini-btn" disabled={busy === 'legacy'} onClick={() => void act('legacy', () => window.harness.syncDisableLegacyPlugin(), 'Old plugin disabled. Restart Studio to unload it.')}>
            {busy === 'legacy' ? 'Disabling…' : 'Disable it'}
          </button>
        </div>
      )}
      {status.notice && (
        <div className={`callout ${status.notice.level === 'warn' ? 'warn' : 'info'} fs-callout`} role="status">
          <div>{status.notice.text}</div>
          {status.notice.action === 'install-plugin' && (
            <button
              className="mini-btn hot"
              style={{ alignSelf: 'flex-start' }}
              disabled={busy === 'plugin'}
              onClick={() =>
                void act('plugin', async () => {
                  await window.harness.studioInstallPlugin()
                  actions.toast({ text: 'Forge Bridge plugin installed', detail: 'Restart Roblox Studio to load it.', kind: 'ok' })
                  return window.harness.syncStatus()
                })
              }
            >
              {busy === 'plugin' ? 'Installing…' : 'Install plugin'}
            </button>
          )}
        </div>
      )}
      {status.warning && <div className="callout warn fs-callout">{status.warning}</div>}
      {!!status.unsyncedRefs?.length && (
        <div className="fs-refs">
          <div className="lrow" onClick={() => setShowRefs(!showRefs)} title="Instance references (ObjectValue.Value, Weld/Motor6D Part0/Part1, Beam/Trail/constraint attachments, Model.PrimaryPart) are not written to disk. Rojo leaves them as they are in Studio, but a fresh place built from the repo will not have them.">
            <Icon name="warn" size={13} style={{ color: 'var(--warn)', flex: 'none' }} />
            <span className="grow fs-refs-line">{refsSummary(status.unsyncedRefs, status.unsyncedRefsTotal ?? status.unsyncedRefs.length)}</span>
            <span className="link-btn">{showRefs ? 'hide' : 'list'}</span>
          </div>
          {showRefs && (
            <div className="fs-refs-list">
              {status.unsyncedRefs.map((r, i) => (
                <div key={`${r.path.join('.')}:${r.property}:${i}`} className="lrow static" title={`${r.path.join('.')}.${r.property}`}>
                  <span className="grow ellipsis mono">{r.path.slice(-2).join('.')}</span>
                  <span className="sub mono">{r.property}</span>
                </div>
              ))}
              {(status.unsyncedRefsTotal ?? 0) > status.unsyncedRefs.length && <div className="fs-sub note">and {status.unsyncedRefsTotal! - status.unsyncedRefs.length} more</div>}
            </div>
          )}
        </div>
      )}

      {status.places.map((p) => {
        const g = GATE[p.gate]
        const mine = conflicts.filter((c) => c.placeKey === p.placeKey)
        const firstRun = mine.filter((c) => c.reason === 'first-run')
        return (
          <div key={p.placeKey + p.projectFile} className="fs-place">
            <div className="lrow static" title={`${p.projectFile}${p.place?.placeId ? ` · place ${p.place.placeId}` : ''}\n${g.hint}`}>
              <span className={`fs-dot${p.connected ? ' on' : ''}`} title={p.connected ? 'Studio connected' : 'Studio not connected'} />
              <span className="grow ellipsis">{placeName(p)}</span>
              <span className={`tag ${g.cls}`}>{p.gate === 'blocked' ? (p.conflicts || !p.studioOnly?.holds ? `${p.conflicts} held` : `${p.studioOnly.count} not on disk`) : g.label}</span>
            </div>
            <div className="fs-sub note">{countsText(p)}{p.lastSnapshot ? ` · checked ${ago(p.lastSnapshot)}` : ''}</div>
            {p.leftInStudio && (
              <div className="fs-sub note ellipsis" title={`${p.leftInStudio.note}\n\nRojo only manages what a $path maps; Studio-only instances outside it, or under $ignoreUnknownInstances, are place content and are never written to the repo on their own.`}>
                {p.leftInStudio.note}
              </div>
            )}
            {!!p.missingRoots?.length && (
              <div className="fs-sub note" style={{ color: 'var(--warn)' }} title="Nothing under these is synced until they exist in Studio (connect Rojo in Studio to build them).">
                not in Studio yet: {p.missingRoots.join(', ')}
              </div>
            )}

            {p.studioOnly && (
              <div className="callout warn fs-callout fs-studio-only" role="alert">
                <div>
                  {p.studioOnly.count} script{p.studioOnly.count === 1 ? ' exists' : 's exist'} only in Studio, not on disk yet. Rojo would delete {p.studioOnly.count === 1 ? 'it' : 'them'} from Studio when it connects
                  {p.studioOnly.holds && p.gate === 'blocked' ? ', so rojo serve is held.' : '.'}
                  {p.studioOnly.pullable < p.studioOnly.count ? ` ${p.studioOnly.count - p.studioOnly.pullable} cannot be written as they are (see the list).` : ''}
                </div>
                <div className="row">
                  {p.studioOnly.pullable > 0 && (
                    <button
                      className="mini-btn hot"
                      disabled={!!busy}
                      title="Write the Studio copies to disk (they become new files to commit)"
                      onClick={() => void act(`pull:${p.placeKey}`, () => window.harness.syncPullStudioOnly(p.placeKey), `Pulled ${p.studioOnly!.pullable} Studio-only script${p.studioOnly!.pullable === 1 ? '' : 's'} to disk`)}
                    >
                      Pull to disk ({p.studioOnly.pullable})
                    </button>
                  )}
                  <button className="link-btn" onClick={() => setShowOnly(showOnly === p.placeKey ? null : p.placeKey)}>{showOnly === p.placeKey ? 'hide' : 'list'}</button>
                </div>
                {showOnly === p.placeKey && (
                  <div className="fs-refs-list">
                    {p.studioOnly.items.map((i) => (
                      <div key={i.instancePath.join('.')} className="lrow" onClick={() => actions.revealInstance(i.instancePath)} title={`${i.instancePath.join('.')}\n${i.file ? `${i.file}\n` : ''}${i.reason}`}>
                        <span className="grow ellipsis mono">{i.instancePath.slice(-2).join('.')}</span>
                        <span className="sub">{i.canPull ? 'pull' : 'rename in Studio'}</span>
                      </div>
                    ))}
                    {p.studioOnly.count > p.studioOnly.items.length && <div className="fs-sub note">and {p.studioOnly.count - p.studioOnly.items.length} more</div>}
                  </div>
                )}
              </div>
            )}

            {firstRun.length > 0 && (
              <div className="callout info fs-callout">
                <div>
                  First sync for {placeName(p)}: {firstRun.length} file{firstRun.length === 1 ? '' : 's'} differ and there is no shared version yet. Which side is right?
                </div>
                <div className="row">
                  <button className="mini-btn hot" disabled={!!busy} onClick={() => void act(`all:${p.placeKey}`, () => window.harness.syncResolveAll(p.placeKey, 'studio', 'first-run'), 'Studio versions written to disk')}>Studio wins</button>
                  <button className="mini-btn" disabled={!!busy} title="Keep the disk versions (Rojo pushes them). Scripts only Studio has are not deleted: they stay listed (and rojo held) until you pull them to disk or serve anyway." onClick={() => void act(`all:${p.placeKey}`, () => window.harness.syncResolveAll(p.placeKey, 'disk', 'first-run'), 'Kept the disk versions')}>Disk wins</button>
                </div>
              </div>
            )}

            {mine.map((c) => (
              <div key={c.path} className="lrow fs-conflict" onClick={() => actions.openConflict(c.path)} title={`Compare (3-way)\n${c.path}\n${c.instancePath?.join('.') ?? ''}\n${c.reason === 'first-run' ? 'first sync, no shared version yet' : c.reason === 'deleted-vs-edited' ? 'deleted on one side, edited on the other' : 'changed in Studio and on disk'}`}>
                <Icon name="diff" size={14} style={{ color: 'var(--warn)' }} />
                <span className="grow ellipsis">{basename(c.path)}</span>
                <button className="mini-btn" disabled={!!busy} title="Write the Studio version to disk" onClick={(e) => (e.stopPropagation(), void act(`c:${c.path}`, () => window.harness.syncResolve(c.placeKey!, c.path, 'studio')))}>Studio</button>
                <button className="mini-btn" disabled={!!busy} title="Keep the disk version (Rojo pushes it to Studio)" onClick={(e) => (e.stopPropagation(), void act(`c:${c.path}`, () => window.harness.syncResolve(c.placeKey!, c.path, 'disk')))}>Disk</button>
              </div>
            ))}

            {p.gate === 'blocked' && (
              <div className="row fs-actions">
                <button className="mini-btn" disabled={!!busy} title="Rojo serves now; Studio edits in the held files may be overwritten, and Rojo may offer to delete Studio-only scripts" onClick={() => void act(`serve:${p.placeKey}`, () => window.harness.syncServeAnyway(p.placeKey))}>Serve anyway</button>
              </div>
            )}
          </div>
        )
      })}

      {status.unlinked?.map((u) => {
        const target = state.activePlace || 'default.project.json'
        const targetName = state.places.find((x) => x.file === target)?.name || state.project?.name || target.replace(/\.project\.json$/, '')
        return (
          <div key={u.id} className="fs-place fs-unlinked">
            <div className="lrow static" title={`${u.why}.\n\nForge Sync only syncs Studio places linked to this project: a published place listed in servePlaceIds (or tools/studio-sync.json placeIds), or one you link here. Other places (VFX scratch places, other games) can stay open for Studio checks; nothing from them is written, trashed or held.`}>
              <span className="fs-dot" />
              <span className="grow ellipsis">Not linked: {u.name}</span>
              <button
                className="mini-btn"
                disabled={!!busy || !u.canLink}
                title={u.canLink ? `Sync this Studio place with ${targetName} (${target}). Its first sync waits until you pick a side.` : u.why}
                onClick={() => void act(`link:${u.id}`, () => window.harness.syncLinkPlace(u.id, target), `Linked ${u.name} to ${targetName}. Its first sync waits for your choice.`)}
              >
                Link
              </button>
            </div>
            <div className="fs-sub note">Not synced: nothing from this place is written to disk or holds Rojo.{u.canLink ? ` Link it to sync it with ${targetName}.` : ` ${u.why}.`}</div>
          </div>
        )
      })}

      <div className="fs-commit">
        <button className={`btn${pending.length ? ' primary' : ''}`} disabled={!pending.length || busy === 'commit'} onClick={() => void commit()} title="Commits only the files Forge wrote from Studio">
          <Icon name="check" size={12} /> {busy === 'commit' ? 'Committing…' : `Commit teammate edits (${pending.length})`}
        </button>
        {pending.length > 0 && (
          <button className="link-btn" onClick={() => setShowPending(!showPending)}>{showPending ? 'hide' : 'files'}</button>
        )}
      </div>
      {showPending && pending.map((f) => (
        <div key={f} className="lrow" style={{ paddingLeft: 22 }} onClick={() => void actions.openFile(f)} title={f}>
          <span className="grow ellipsis">{f}</span>
        </div>
      ))}

      {status.recent.length > 0 && (
        <>
          <div className="lrow static fs-recent-head">Recent from Studio</div>
          {status.recent.slice(0, 12).map((e, i) => (
            <RecentRow key={`${e.file}:${e.at}:${i}`} entry={e} onOpen={() => (e.action === 'conflict' ? actions.openConflict(e.file) : e.action === 'unmapped' ? actions.revealInstance(e.instancePath) : e.action !== 'trashed' && void actions.openFile(e.file))} />
          ))}
        </>
      )}
    </section>
  )
}

function RecentRow({ entry, onOpen }: { entry: SyncEntry; onOpen: () => void }) {
  const a = ACTION[entry.action] ?? { letter: '·', cls: '', label: entry.action }
  return (
    <div className="lrow fs-recent" onClick={onOpen} title={`${a.label}${entry.note ? `: ${entry.note}` : ''}\n${entry.from ? `${entry.from} → ` : ''}${entry.file ? `${entry.file}\n` : ''}${entry.instancePath.join('.')}`}>
      <span className={`mono fs-letter ${a.cls}`}>{a.letter}</span>
      <span className="ellipsis fs-name">{entry.instancePath.at(-1) ?? basename(entry.file)}</span>
      <span className="grow ellipsis faint fs-parent">{entry.instancePath.slice(-3, -1).join('.')}</span>
      <span className="sub">{ago(entry.at)}</span>
    </div>
  )
}
