// Memory page: .forgepack Export… / Import… dialogs and the "Sync across devices" card.
// The command palette opens the dialogs through requestPack() (a window event + a pending flag,
// so the request survives the page mounting after the palette navigates to it).
import { useEffect, useMemo, useState } from 'react'
import type { BrainSyncMode, BrainSyncSettings, BrainSyncStatus, ExportCandidate, ExportCandidates, ImportChoice, ImportPreview, ImportPreviewItem } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Dialog } from '../../shell/Overlays'
import { ago, errorText, plural } from '../../lib/format'
import './pack.css'

// ------------------------------------------------------------------ palette bridge

type PackRequest = 'export' | 'import'
const EVENT = 'forge:memory-pack'
let pending: PackRequest | null = null

export function requestPack(kind: PackRequest): void {
  pending = kind
  window.dispatchEvent(new CustomEvent(EVENT, { detail: kind }))
}

export function usePackRequests(onRequest: (kind: PackRequest) => void): void {
  useEffect(() => {
    if (pending) {
      const k = pending
      pending = null
      onRequest(k)
    }
    const on = (e: Event) => {
      pending = null
      onRequest((e as CustomEvent<PackRequest>).detail)
    }
    window.addEventListener(EVENT, on)
    return () => window.removeEventListener(EVENT, on)
  }, [onRequest])
}

const KIND_LABEL: Record<string, string> = { memory: 'memory', skill: 'skill', extra: 'entry' }
const size = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`)

// ------------------------------------------------------------------ export

export function ExportDialog({ onClose }: { onClose: () => void }) {
  const { actions } = useStore()
  const [data, setData] = useState<ExportCandidates | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [mode, setMode] = useState<'all' | 'pick'>('all')
  const [withProject, setWithProject] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    window.harness
      .packCandidates()
      .then((d) => {
        setData(d)
        setPicked(new Set(d.items.filter((i) => !i.blocked && i.section !== 'project').map((i) => i.key)))
      })
      .catch((e) => setErr(errorText(e)))
  }, [])

  const chosen = useMemo(() => {
    if (!data) return []
    return data.items.filter((i) => !i.blocked && (mode === 'all' ? i.section !== 'project' || withProject : picked.has(i.key)))
  }, [data, mode, withProject, picked])
  const blocked = data?.items.filter((i) => i.blocked && (mode === 'pick' || i.section !== 'project' || withProject)) ?? []

  const toggle = (keys: string[], on: boolean) =>
    setPicked((p) => {
      const n = new Set(p)
      for (const k of keys) on ? n.add(k) : n.delete(k)
      return n
    })

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const keys = mode === 'all' && !blocked.length ? 'all' : chosen.map((i) => i.key)
      const r = await window.harness.packExport(keys, mode === 'all' && withProject)
      if (r) {
        actions.toast({ text: `Exported ${plural(r.manifest.items.length, 'item')}`, detail: r.path, kind: 'ok' })
        onClose()
      }
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Export memory" onClose={onClose} width={580}>
      <p>Writes a <span className="mono">.forgepack</span> file you can import on another device. Every file is checked for secrets again before it is written.</p>
      {!data ? (
        err ? <div className="callout err">{err}</div> : <div className="note pk-pad"><span className="spinner" /> Reading memory…</div>
      ) : (
        <>
          <div className="pk-bar">
            <div className="seg" role="radiogroup" aria-label="What to export">
              <button role="radio" aria-checked={mode === 'all'} className={mode === 'all' ? 'on' : ''} onClick={() => setMode('all')}>Everything</button>
              <button role="radio" aria-checked={mode === 'pick'} className={mode === 'pick' ? 'on' : ''} onClick={() => setMode('pick')}>Choose items</button>
            </div>
            {mode === 'all' && data.projectOpen && (
              <label className="pk-check">
                <input type="checkbox" checked={withProject} onChange={(e) => setWithProject(e.target.checked)} /> Include project memory
              </label>
            )}
          </div>
          <div className="pk-list" role="group" aria-label="Items">
            {data.sections.map((s) => {
              const items = data.items.filter((i) => i.section === s.id)
              if (!items.length) return null
              const inScope = mode === 'pick' || s.id !== 'project' || withProject
              const usable = items.filter((i) => !i.blocked).map((i) => i.key)
              const all = usable.length > 0 && usable.every((k) => picked.has(k))
              return (
                <div key={s.id} className={`pk-group${inScope ? '' : ' dim'}`}>
                  <div className="pk-group-head">
                    {mode === 'pick' && <input type="checkbox" checked={all} disabled={!usable.length} aria-label={`All of ${s.label}`} onChange={(e) => toggle(usable, e.target.checked)} />}
                    <span className="pk-group-name">{s.label}</span>
                    <span className="faint">{plural(items.length, 'item')}</span>
                  </div>
                  {mode === 'pick' &&
                    items.map((i) => <ExportRow key={i.key} item={i} on={picked.has(i.key)} onToggle={(on) => toggle([i.key], on)} />)}
                  {mode === 'all' && inScope && <div className="pk-names note">{items.filter((i) => !i.blocked).map((i) => i.name).join(' · ')}</div>}
                </div>
              )
            })}
          </div>
          {blocked.length > 0 && (
            <div className="callout warn pk-callout">
              {plural(blocked.length, 'item')} left out: the secret scanner flagged {blocked.length === 1 ? 'it' : 'them'} ({blocked.map((b) => b.name).join(', ')}). Edit {blocked.length === 1 ? 'it' : 'them'} on the Memory page to include.
            </div>
          )}
          {err && <div className="callout err pk-callout">{err}</div>}
        </>
      )}
      <div className="actions">
        <span className="note grow pk-sum">{data ? `${plural(chosen.length, 'item')} · ${size(chosen.reduce((n, i) => n + i.bytes, 0))} · from ${data.device}` : ''}</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={!data || !chosen.length || busy} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : <Icon name="download" size={13} />} Export…
        </button>
      </div>
    </Dialog>
  )
}

function ExportRow({ item, on, onToggle }: { item: ExportCandidate; on: boolean; onToggle: (on: boolean) => void }) {
  return (
    <label className={`pk-row${item.blocked ? ' blocked' : ''}`} title={item.blocked ?? item.description}>
      <input type="checkbox" checked={on && !item.blocked} disabled={!!item.blocked} onChange={(e) => onToggle(e.target.checked)} />
      <span className="mono ellipsis pk-name">{item.name}</span>
      <span className={`tag ${item.kind === 'skill' ? 'hot' : ''}`}>{KIND_LABEL[item.kind]}</span>
      {item.blocked ? <span className="tag err">secret</span> : <span className="faint pk-desc ellipsis">{item.description}</span>}
    </label>
  )
}

// ------------------------------------------------------------------ import

const STATUS_TAG: Record<ImportPreviewItem['status'], { cls: string; label: string }> = {
  new: { cls: 'ok', label: 'new' },
  conflict: { cls: 'warn', label: 'conflict' },
  similar: { cls: 'info', label: 'similar' },
  same: { cls: '', label: 'same' },
  blocked: { cls: 'err', label: 'blocked' }
}

const defaultChoice = (s: ImportPreviewItem['status']): ImportChoice => (s === 'new' || s === 'similar' ? 'theirs' : s === 'conflict' ? 'mine' : 'skip')

export function ImportDialog({ preview, onClose }: { preview: ImportPreview; onClose: () => void }) {
  const { actions } = useStore()
  const [choices, setChoices] = useState<Record<string, ImportChoice>>(() => Object.fromEntries(preview.items.map((i) => [i.key, defaultChoice(i.status)])))
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const counts = useMemo(() => {
    const c: Record<string, number> = {}
    for (const i of preview.items) c[i.status] = (c[i.status] ?? 0) + 1
    return c
  }, [preview])
  const conflicts = preview.items.filter((i) => i.status === 'conflict')
  const willChange = preview.items.filter((i) => i.status !== 'blocked' && i.status !== 'same' && choices[i.key] !== 'mine' && choices[i.key] !== 'skip').length
  const m = preview.manifest

  const setAll = (c: ImportChoice) => setChoices((prev) => ({ ...prev, ...Object.fromEntries(conflicts.map((i) => [i.key, c])) }))
  const allConflicts = conflicts.length && conflicts.every((i) => choices[i.key] === choices[conflicts[0].key]) ? choices[conflicts[0].key] : null

  const run = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.harness.packImport(preview.token, choices)
      const parts = [r.added && `${r.added} added`, r.replaced && `${r.replaced} replaced`, r.renamed && `${r.renamed} kept both`, r.merged && `${r.merged} merged`, r.skipped && `${r.skipped} skipped`].filter(Boolean)
      if (r.errors.length) actions.toast({ text: `Imported with ${plural(r.errors.length, 'problem')}`, detail: r.errors.map((e) => `${e.key}: ${e.error}`).join('\n'), kind: 'err' })
      else actions.toast({ text: 'Memory imported', detail: parts.join(' · '), kind: 'ok' })
      onClose()
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog title="Import memory" onClose={onClose} width={640}>
      <p>
        <span className="mono">{preview.file}</span> · from <b className="pk-strong">{m.device}</b> · packed {ago(m.created)}
        {m.app ? ` · ${m.app}` : ''}
      </p>
      <div className="pk-bar">
        <div className="pk-counts">
          {(['new', 'conflict', 'similar', 'same', 'blocked'] as const).map((s) =>
            counts[s] ? <span key={s} className={`tag ${STATUS_TAG[s].cls}`}>{counts[s]} {STATUS_TAG[s].label}</span> : null
          )}
        </div>
        {conflicts.length > 1 && (
          <div className="pk-bulk">
            <span className="faint">All conflicts</span>
            <ChoiceSeg value={allConflicts} onChange={setAll} options={[['mine', 'Keep mine'], ['theirs', 'Take theirs'], ['both', 'Keep both']]} label="All conflicts" />
          </div>
        )}
      </div>
      <div className="pk-list" role="group" aria-label="Pack contents">
        {preview.sections.map((s) => {
          const items = preview.items.filter((i) => i.section === s.id)
          if (!items.length) return null
          return (
            <div key={s.id} className="pk-group">
              <div className="pk-group-head">
                <span className="pk-group-name">{s.label}</span>
                <span className="faint">{plural(items.length, 'item')}</span>
              </div>
              {items.map((i) => (
                <ImportRow key={i.key} item={i} choice={choices[i.key]} onChoice={(c) => setChoices((p) => ({ ...p, [i.key]: c }))} />
              ))}
            </div>
          )
        })}
      </div>
      {err && <div className="callout err pk-callout">{err}</div>}
      <div className="actions">
        <span className="note grow pk-sum">Saved through the memory store: secrets are refused and near-duplicates merge.</span>
        <button className="btn ghost" onClick={onClose}>Cancel</button>
        <button className="btn primary" disabled={busy || !willChange} onClick={() => void run()}>
          {busy ? <span className="spinner" /> : <Icon name="upload" size={13} />} Import {willChange || ''}
        </button>
      </div>
    </Dialog>
  )
}

function ChoiceSeg({ value, onChange, options, label }: { value: ImportChoice | null; onChange: (c: ImportChoice) => void; options: [ImportChoice, string][]; label: string }) {
  return (
    <div className="seg pk-seg" role="radiogroup" aria-label={label}>
      {options.map(([id, text]) => (
        <button key={id} role="radio" aria-checked={value === id} className={value === id ? 'on' : ''} onClick={() => onChange(id)}>{text}</button>
      ))}
    </div>
  )
}

function ImportRow({ item, choice, onChoice }: { item: ImportPreviewItem; choice: ImportChoice; onChoice: (c: ImportChoice) => void }) {
  const tag = STATUS_TAG[item.status]
  const newer = item.local && item.updated && item.local.updated ? (item.updated > item.local.updated ? 'theirs is newer' : item.updated < item.local.updated ? 'mine is newer' : '') : ''
  return (
    <div className={`pk-irow ${item.status}`}>
      <div className="pk-irow-main">
        {item.status === 'new' && <input type="checkbox" checked={choice === 'theirs'} onChange={(e) => onChoice(e.target.checked ? 'theirs' : 'skip')} aria-label={`Import ${item.name}`} />}
        <span className="mono ellipsis pk-name">{item.name}</span>
        <span className={`tag ${item.kind === 'skill' ? 'hot' : ''}`}>{KIND_LABEL[item.kind]}</span>
        <span className={`tag ${tag.cls}`}>{tag.label}</span>
        <span className="grow" />
        {item.status === 'conflict' && <ChoiceSeg value={choice} onChange={onChoice} label={`Conflict for ${item.name}`} options={[['mine', 'Keep mine'], ['theirs', 'Take theirs'], ['both', 'Keep both']]} />}
        {item.status === 'similar' && <ChoiceSeg value={choice} onChange={onChoice} label={`Near-duplicate ${item.name}`} options={[['theirs', 'Merge'], ['both', 'Keep both'], ['skip', 'Skip']]} />}
      </div>
      <div className="pk-irow-sub note">
        {item.status === 'blocked' ? (
          <span className="pk-err">{item.reason}</span>
        ) : item.status === 'conflict' ? (
          <>
            Differs from yours{newer ? ` (${newer})` : ''}.{choice === 'both' && item.renameTo ? <> Saved as <span className="mono">{item.renameTo}</span>.</> : null}
          </>
        ) : item.status === 'similar' ? (
          <>
            Close to your <span className="mono">{item.local?.name}</span>.{choice === 'theirs' ? ' Merge updates it with this version.' : choice === 'both' ? ' Keeps both.' : ''}
          </>
        ) : item.status === 'same' ? (
          'Already here.'
        ) : (
          item.description || ' '
        )}
      </div>
    </div>
  )
}

// ------------------------------------------------------------------ sync card

const SYNC_MODES: { id: BrainSyncMode; label: string }[] = [
  { id: 'off', label: 'Off' },
  { id: 'git', label: 'Git repo' },
  { id: 'folder', label: 'Sync folder' }
]

export function SyncCard() {
  const { actions } = useStore()
  const h = window.harness
  const [settings, setSettings] = useState<BrainSyncSettings | null>(null)
  const [status, setStatus] = useState<BrainSyncStatus | null>(null)
  const [url, setUrl] = useState('')

  useEffect(() => {
    void h.brainSyncGetSettings().then((s) => (setSettings(s), setUrl(s.repoUrl))).catch(() => undefined)
    void h.brainSyncStatus().then(setStatus).catch(() => undefined)
    return h.on('brainsync:status', setStatus)
  }, [])

  const save = async (patch: Partial<BrainSyncSettings>) => {
    try {
      const s = await h.brainSyncSetSettings(patch)
      setSettings(s)
      setUrl(s.repoUrl)
    } catch (e) {
      actions.toast({ text: 'Could not save sync settings', detail: errorText(e), kind: 'err' })
    }
  }
  const chooseFolder = async () => {
    const f = await h.brainSyncChooseFolder().catch(() => null)
    if (f) await save({ folder: f, mode: 'folder' })
  }
  const syncNow = async () => {
    try {
      const s = await h.brainSyncNow()
      setStatus(s)
      if (s.state === 'error') actions.toast({ text: s.authProblem ? 'Sync needs a git sign-in' : 'Sync failed', detail: s.lastError, kind: 'err' })
    } catch (e) {
      actions.toast({ text: 'Sync failed', detail: errorText(e), kind: 'err' })
    }
  }

  const mode = settings?.mode ?? 'off'
  const st = status?.state ?? 'off'
  const stTag = st === 'syncing' ? <span className="tag info">syncing</span> : st === 'error' ? <span className="tag err">{status?.authProblem ? 'sign-in needed' : 'error'}</span> : st === 'idle' ? <span className="tag ok">on</span> : <span className="tag">off</span>
  const urlDirty = settings && url.trim() !== settings.repoUrl

  return (
    <section className="set-sec pk-sync" aria-label="Sync across devices">
      <h2>
        Sync across devices {stTag}
        <span className="grow" />
        <button className="mini-btn" disabled={mode === 'off' || st === 'syncing' || (mode === 'git' && !settings?.repoUrl) || (mode === 'folder' && !settings?.folder)} onClick={() => void syncNow()}>
          {st === 'syncing' ? <span className="spinner" /> : <Icon name="sync" size={12} />} Sync now
        </button>
      </h2>
      <div className="set-row">
        <div className="set-text">
          <div className="set-title">Mode</div>
          <div className="note">
            {mode === 'git'
              ? 'A private repo you own (e.g. forge-brain). Forge commits and pushes changes and pulls on start and every few minutes.'
              : mode === 'folder'
                ? 'A Dropbox, OneDrive or iCloud Drive folder. Forge mirrors memory into forge-brain/ inside it.'
                : 'Off. Export and import still work for one-off moves.'}
          </div>
        </div>
        <div className="set-ctl">
          <div className="seg" role="radiogroup" aria-label="Sync mode">
            {SYNC_MODES.map((m) => (
              <button key={m.id} role="radio" aria-checked={mode === m.id} className={mode === m.id ? 'on' : ''} disabled={!settings} onClick={() => (m.id === 'folder' && !settings?.folder ? void chooseFolder() : void save({ mode: m.id }))}>
                {m.label}
              </button>
            ))}
          </div>
        </div>
      </div>
      {mode === 'git' && (
        <div className="set-row pk-sync-target">
          <input className="input mono grow" value={url} placeholder="https://github.com/you/forge-brain.git" aria-label="Sync repo URL" onChange={(e) => setUrl(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && urlDirty && void save({ repoUrl: url })} />
          <button className="btn small" disabled={!urlDirty} onClick={() => void save({ repoUrl: url })}>Save</button>
        </div>
      )}
      {mode === 'folder' && (
        <div className="set-row pk-sync-target">
          <span className="mono ellipsis grow pk-path" title={settings?.folder}>{settings?.folder || 'No folder chosen'}</span>
          <button className="btn small" onClick={() => void chooseFolder()}>Choose…</button>
        </div>
      )}
      {mode !== 'off' && (
        <div className="pk-sync-status note">
          <span>{status?.lastSync ? `Last sync ${ago(status.lastSync)}` : 'Not synced yet'}</span>
          {status?.last && (
            <span className="faint">
              {status.last.pulled} pulled · {status.last.pushed} pushed{status.last.conflicts ? ` · ${plural(status.last.conflicts, 'conflict')}` : ''}
            </span>
          )}
          {status?.pending && <span className="faint">changes waiting</span>}
          <span className="faint grow pk-device">this device: {status?.device}</span>
        </div>
      )}
      {mode !== 'off' && status?.lastError && <div className={`callout ${status.state === 'error' ? 'err' : 'warn'}`}>{status.lastError}</div>}
      <div className="note pk-sync-foot">
        {mode === 'git' ? 'Uses your own git sign-in (Git Credential Manager on Windows, the Keychain on macOS, or SSH). Forge never stores a token. ' : ''}
        Syncs user memories, skills and the VFX library. Project memory travels with the game repo. When both devices change a file, the newer one wins and the other is kept as a <span className="mono">.conflict</span> copy.
      </div>
    </section>
  )
}
