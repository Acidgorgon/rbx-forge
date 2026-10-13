// Memory tab: what Forge's agents have learned. Lists user memories, project memories (committed in
// .forge/memory, shared with the team) and skills with search; view, edit, delete, pin and promote
// user -> project; a "learned recently" feed; the reflection and style-profile settings.
import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ImportPreview, MemoryEntry, MemoryFeedItem, MemoryInput, MemoryKind, MemoryListing, MemoryScope, MemorySettings, MemoryType, ReflectionMode } from '@shared/types'
import { useStore } from '../../store'
import { Icon } from '../../components/Icons'
import { Markdown } from '../../components/Markdown'
import { ago, errorText, plural } from '../../lib/format'
import { ExportDialog, ImportDialog, SyncCard, usePackRequests } from './MemoryPack'
import './memory.css'

type Filter = 'all' | 'user' | 'project' | 'skills'
const FILTERS: { id: Filter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'user', label: 'User' },
  { id: 'project', label: 'Project' },
  { id: 'skills', label: 'Skills' }
]
const TYPES: MemoryType[] = ['user', 'project', 'feedback', 'reference']
const MODES: { id: ReflectionMode; label: string; hint: string }[] = [
  { id: 'ask', label: 'Ask', hint: 'Proposals appear as a card in the chat to save, edit or dismiss.' },
  { id: 'auto', label: 'Auto', hint: 'Proposals are saved right away and show up in the feed.' },
  { id: 'off', label: 'Off', hint: 'No background review. Agents still save when you tell them to.' }
]
const ACTION_TEXT: Record<MemoryFeedItem['action'], string> = {
  saved: 'remembered',
  updated: 'updated',
  merged: 'merged a near-duplicate into',
  forgot: 'forgot',
  skill: 'learned the skill',
  style: 'profiled code style in',
  promoted: 'shared with the team',
  proposed: 'proposed',
  dismissed: 'dismissed'
}
const SOURCE_TEXT: Record<MemoryFeedItem['source'], string> = { agent: 'agent', reflection: 'reflection', style: 'style pass', user: 'you' }

const keyOf = (e: { scope: MemoryScope; kind: MemoryKind; name: string }) => `${e.scope}:${e.kind}:${e.name}`
const tagOf = (e: MemoryEntry) => (e.kind === 'skill' ? 'skill' : e.type ?? e.scope)

function Editor({ initial, previous, projectOpen, onSaved, onCancel }: { initial: MemoryInput; previous?: MemoryEntry; projectOpen: boolean; onSaved: (e: MemoryEntry) => void; onCancel: () => void }) {
  const [d, setD] = useState<MemoryInput>(initial)
  const [err, setErr] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const kind = d.kind ?? 'memory'
  const save = async () => {
    setBusy(true)
    setErr(null)
    try {
      const r = await window.harness.memorySave(d, previous ? { scope: previous.scope, kind: previous.kind, name: previous.name } : undefined)
      onSaved(r.entry)
    } catch (e) {
      setErr(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="mem-editor">
      <div className="mem-field">
        <span className="mem-label">Kind</span>
        <div className="seg" role="radiogroup" aria-label="Kind">
          {(['memory', 'skill'] as MemoryKind[]).map((k) => (
            <button key={k} role="radio" aria-checked={kind === k} className={kind === k ? 'on' : ''} onClick={() => setD({ ...d, kind: k })}>{k === 'memory' ? 'Memory' : 'Skill'}</button>
          ))}
        </div>
      </div>
      <div className="mem-field">
        <span className="mem-label">Scope</span>
        <div className="seg" role="radiogroup" aria-label="Scope">
          {(['user', 'project'] as MemoryScope[]).map((s) => (
            <button key={s} role="radio" aria-checked={d.scope === s} className={d.scope === s ? 'on' : ''} disabled={s === 'project' && !projectOpen} onClick={() => setD({ ...d, scope: s })}>
              {s === 'user' ? 'User (all projects)' : 'Project (team)'}
            </button>
          ))}
        </div>
      </div>
      {kind === 'memory' && (
        <div className="mem-field">
          <span className="mem-label">Type</span>
          <div className="seg" role="radiogroup" aria-label="Type">
            {TYPES.map((t) => (
              <button key={t} role="radio" aria-checked={(d.type ?? (d.scope === 'user' ? 'user' : 'project')) === t} className={(d.type ?? (d.scope === 'user' ? 'user' : 'project')) === t ? 'on' : ''} onClick={() => setD({ ...d, type: t })}>{t}</button>
            ))}
          </div>
        </div>
      )}
      <label className="mem-field">
        <span className="mem-label">Name</span>
        <input className="input mono grow" value={d.name} placeholder="kebab-case-name" onChange={(e) => setD({ ...d, name: e.target.value })} />
      </label>
      <label className="mem-field">
        <span className="mem-label">{kind === 'skill' ? 'When' : 'Line'}</span>
        <input className="input grow" value={d.description} maxLength={200} placeholder={kind === 'skill' ? 'When to use this skill (one line)' : 'One line: what this is (this is all prompts see)'} onChange={(e) => setD({ ...d, description: e.target.value })} />
      </label>
      <textarea className="input mono mem-body-input" rows={12} value={d.body} placeholder={kind === 'skill' ? '1. First step…\n2. …' : 'The fact, and why it matters.'} onChange={(e) => setD({ ...d, body: e.target.value })} aria-label="Body" />
      {err && <div className="callout err">{err}</div>}
      <div className="row">
        <button className="btn primary" disabled={busy} onClick={() => void save()}><Icon name="check" size={13} /> Save</button>
        <button className="btn" disabled={busy} onClick={onCancel}>Cancel</button>
        <span className="note grow">Secrets are refused. Project memory is committed with the game.</span>
      </div>
    </div>
  )
}

function Detail({ e, onEdit, onChanged, onDeleted }: { e: MemoryEntry; onEdit: () => void; onChanged: (sel?: string) => void; onDeleted: () => void }) {
  const { actions } = useStore()
  const h = window.harness
  const run = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn()
      if (ok) actions.toast({ text: ok, kind: 'ok', ms: 2400 })
    } catch (err) {
      actions.toast({ text: 'Memory action failed', detail: errorText(err), kind: 'err' })
    }
  }
  return (
    <div className="mem-detail">
      <div className="mem-detail-head">
        <div className="grow" style={{ minWidth: 0 }}>
          <div className="mem-detail-name mono">{e.name}</div>
          <div className="mem-detail-desc">{e.description}</div>
        </div>
      </div>
      <div className="mem-meta">
        <span className={`tag ${e.scope === 'project' ? 'info' : ''}`}>{e.scope}</span>
        <span className={`tag ${e.kind === 'skill' ? 'hot' : ''}`}>{tagOf(e)}</span>
        {e.pinned && <span className="tag warn">pinned</span>}
        <span className="faint">{plural(e.uses, 'use')}</span>
        <span className="faint">used {e.lastUsed ? ago(e.lastUsed) : 'never'}</span>
        <span className="faint">added {ago(e.created)}</span>
        <span className="faint mono ellipsis" title={e.file}>{e.scope === 'project' ? `.forge/memory/${e.file}` : e.file}</span>
      </div>
      <div className="mem-actions">
        <button className="mini-btn" onClick={onEdit}><Icon name="pencil" size={12} /> Edit</button>
        <button className="mini-btn" onClick={() => void run(() => h.memoryPin(e.scope, e.kind, e.name, !e.pinned)).then(() => onChanged())}>
          <Icon name="pin" size={12} /> {e.pinned ? 'Unpin' : 'Pin'}
        </button>
        {e.scope === 'user' && (
          <button className="mini-btn" title="Move to .forge/memory so teammates' agents know it too" onClick={() => void run(() => h.memoryPromote(e.kind, e.name), `Shared ${e.name} with the team`).then(() => onChanged(keyOf({ ...e, scope: 'project' })))}>
            <Icon name="team" size={12} /> Promote to project
          </button>
        )}
        <span className="grow" />
        <button
          className="mini-btn mem-danger"
          onClick={() =>
            actions.openDialog({
              kind: 'confirm',
              title: `Delete ${e.kind} "${e.name}"?`,
              body: e.scope === 'project' ? 'The file is removed from .forge/memory; commit the change to remove it for the team.' : 'Agents will no longer see it.',
              confirm: 'Delete',
              danger: true,
              run: () => void run(() => h.memoryDelete(e.scope, e.kind, e.name), `Deleted ${e.name}`).then(onDeleted)
            })
          }
        >
          <Icon name="trash" size={12} /> Delete
        </button>
      </div>
      <div className="mem-body"><Markdown text={e.body} /></div>
    </div>
  )
}

export function MemoryPage() {
  const { state, actions } = useStore()
  const h = window.harness
  const [listing, setListing] = useState<MemoryListing | null>(null)
  const [query, setQuery] = useState('')
  const [ranked, setRanked] = useState<MemoryEntry[] | null>(null)
  const [filter, setFilter] = useState<Filter>('all')
  const [sel, setSel] = useState<string | null>(null)
  const [mode, setMode] = useState<'view' | 'edit' | 'new'>('view')
  const [feed, setFeed] = useState<MemoryFeedItem[]>([])
  const [feedAll, setFeedAll] = useState(false)
  const [settings, setSettings] = useState<MemorySettings | null>(null)
  const [styleBusy, setStyleBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)
  const [exporting, setExporting] = useState(false)
  const [importing, setImporting] = useState<ImportPreview | null>(null)

  const openImport = useCallback(async () => {
    try {
      const p = await h.packOpen()
      if (p) setImporting(p)
    } catch (e) {
      actions.toast({ text: 'Could not open the pack', detail: errorText(e), kind: 'err' })
    }
  }, [])
  usePackRequests(useCallback((k: 'export' | 'import') => (k === 'export' ? setExporting(true) : void openImport()), [openImport]))

  const load = useCallback(async () => {
    try {
      const [l, f] = await Promise.all([h.memoryList(), h.memoryFeed()])
      setListing(l)
      setFeed(f)
      setErr(null)
    } catch (e) {
      setErr(errorText(e))
    }
  }, [])

  useEffect(() => {
    void load()
    void h.memoryGetSettings().then(setSettings).catch(() => undefined)
    const off = h.on('memory:changed', () => void load())
    const off2 = h.on('memory:proposals', () => void h.memoryFeed().then(setFeed).catch(() => undefined))
    return () => {
      off()
      off2()
    }
  }, [load, state.project?.root])

  // Ranked search on the main side (BM25 over name, description, body), debounced.
  useEffect(() => {
    const q = query.trim()
    if (!q) {
      setRanked(null)
      return
    }
    const t = setTimeout(() => void h.memorySearch(q).then(setRanked).catch(() => setRanked([])), 160)
    return () => clearTimeout(t)
  }, [query, listing])

  const all = useMemo(() => (listing ? [...listing.project, ...listing.user] : []), [listing])
  const shown = useMemo(() => {
    const base = ranked ?? [...all].sort((a, b) => Number(!!b.pinned) - Number(!!a.pinned) || b.lastUsed - a.lastUsed || a.name.localeCompare(b.name))
    return base.filter((e) => (filter === 'all' ? true : filter === 'skills' ? e.kind === 'skill' : e.kind === 'memory' && e.scope === filter))
  }, [all, ranked, filter])
  const selected = all.find((e) => keyOf(e) === sel) ?? null
  useEffect(() => {
    if (mode === 'view' && !selected && shown.length) setSel(keyOf(shown[0]))
  }, [shown, selected, mode])

  const counts = {
    all: all.length,
    user: all.filter((e) => e.kind === 'memory' && e.scope === 'user').length,
    project: all.filter((e) => e.kind === 'memory' && e.scope === 'project').length,
    skills: all.filter((e) => e.kind === 'skill').length
  }
  const projectOpen = !!listing?.projectRoot

  const analyze = async () => {
    setStyleBusy(true)
    try {
      const r = await h.memoryAnalyzeStyle()
      if (r.result) {
        actions.toast({ text: 'Style profile saved', detail: `${r.profile.files} Luau files analyzed`, kind: 'ok' })
        setFilter('all')
        setQuery('')
        setMode('view')
        setSel(keyOf(r.result.entry))
      } else actions.toast({ text: 'No Luau files found to analyze', kind: 'info' })
    } catch (e) {
      actions.toast({ text: 'Style analysis failed', detail: errorText(e), kind: 'err' })
    } finally {
      setStyleBusy(false)
    }
  }
  const setSetting = async (patch: Partial<MemorySettings>) => {
    try {
      setSettings(await h.memorySetSettings(patch))
    } catch (e) {
      actions.toast({ text: 'Could not save the setting', detail: errorText(e), kind: 'err' })
    }
  }

  const blank: MemoryInput = { scope: projectOpen ? 'project' : 'user', kind: filter === 'skills' ? 'skill' : 'memory', name: '', description: '', body: '' }
  const feedShown = feedAll ? feed : feed.slice(0, 6)

  return (
    <div className="page">
      <div className="page-inner memory">
        <div className="page-head">
          <div>
            <h1>Memory</h1>
            <div className="sub">What Forge's agents have learned about you and this game. Prompts only get names and one-line descriptions; agents read the rest with recall and use_skill.</div>
          </div>
          <div className="actions">
            <button className="btn" onClick={() => void openImport()} title="Import memories and skills from a .forgepack file"><Icon name="upload" size={13} /> Import…</button>
            <button className="btn" onClick={() => setExporting(true)} title="Save memories and skills to a .forgepack file for another device"><Icon name="download" size={13} /> Export…</button>
            <button className="btn" disabled={!projectOpen || styleBusy} onClick={() => void analyze()} title={projectOpen ? "Read this project's Luau and save its style as a project memory" : 'Open a project first'}>
              {styleBusy ? <span className="spinner" /> : <Icon name="code" size={13} />} Learn code style
            </button>
            <button className="btn primary" onClick={() => (setMode('new'), setSel(null))}><Icon name="plus" size={13} /> New</button>
          </div>
        </div>

        {err && <div className="callout err">{err}</div>}

        <section className="set-sec mem-browser">
          <div className="mem-toolbar">
            <label className="mem-search">
              <Icon name="search" size={13} />
              <input className="input" value={query} placeholder="Search memories and skills" onChange={(e) => setQuery(e.target.value)} aria-label="Search memories and skills" />
            </label>
            <div className="seg" role="tablist" aria-label="Filter">
              {FILTERS.map((f) => (
                <button key={f.id} role="tab" aria-selected={filter === f.id} className={filter === f.id ? 'on' : ''} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="faint">{counts[f.id]}</span>
                </button>
              ))}
            </div>
          </div>
          <div className="mem-split">
            <div className="mem-list" role="listbox" aria-label="Memories">
              {!listing ? (
                <div className="note mem-pad">Loading…</div>
              ) : !shown.length ? (
                <div className="empty">
                  <Icon name="memory" size={20} className="i" />
                  <div>{query ? 'Nothing matches.' : 'Nothing learned yet.'}</div>
                  <div className="note">Agents save when you correct them or state a preference, when they find a non-obvious project fact, or after a procedure works.</div>
                </div>
              ) : (
                shown.map((e) => (
                  <button key={keyOf(e)} role="option" aria-selected={sel === keyOf(e)} className={`mem-row${sel === keyOf(e) && mode !== 'new' ? ' on' : ''}`} onClick={() => (setSel(keyOf(e)), setMode('view'))}>
                    <div className="mem-row-top">
                      {e.pinned && <Icon name="pin" size={11} className="mem-pin" />}
                      <span className="mono ellipsis grow">{e.name}</span>
                      <span className={`tag ${e.kind === 'skill' ? 'hot' : e.scope === 'project' ? 'info' : ''}`}>{e.kind === 'skill' ? `${e.scope} skill` : e.type === e.scope ? e.scope : `${e.scope}·${e.type}`}</span>
                    </div>
                    <div className="mem-row-desc ellipsis">{e.description}</div>
                  </button>
                ))
              )}
            </div>
            <div className="mem-pane">
              {mode === 'new' ? (
                <Editor key="new" initial={blank} projectOpen={projectOpen} onCancel={() => setMode('view')} onSaved={(e) => (setMode('view'), setSel(keyOf(e)), void load())} />
              ) : selected && mode === 'edit' ? (
                <Editor
                  key={`edit:${keyOf(selected)}`}
                  initial={{ scope: selected.scope, kind: selected.kind, type: selected.type, name: selected.name, description: selected.description, body: selected.body }}
                  previous={selected}
                  projectOpen={projectOpen}
                  onCancel={() => setMode('view')}
                  onSaved={(e) => (setMode('view'), setSel(keyOf(e)), void load())}
                />
              ) : selected ? (
                <Detail e={selected} onEdit={() => setMode('edit')} onChanged={(s) => (s && setSel(s), void load())} onDeleted={() => (setSel(null), void load())} />
              ) : (
                <div className="note mem-pad">Select a memory or skill.</div>
              )}
            </div>
          </div>
        </section>

        <div className="mem-bottom">
          <section className="set-sec">
            <h2>What Forge has learned recently</h2>
            {!feed.length ? (
              <div className="note">Nothing yet. New memories, skills and proposals show up here.</div>
            ) : (
              <ul className="mem-feed">
                {feedShown.map((f, i) => (
                  <li key={`${f.at}-${i}`}>
                    <span className="faint mem-feed-at">{ago(f.at)}</span>
                    <span className="mem-feed-text">
                      <span className="faint">{SOURCE_TEXT[f.source]}</span> {ACTION_TEXT[f.action]}{' '}
                      <button
                        className="mem-link mono"
                        onClick={() => {
                          const k = keyOf(f)
                          if (all.some((e) => keyOf(e) === k)) {
                            setQuery('')
                            setFilter('all')
                            setMode('view')
                            setSel(k)
                          }
                        }}
                      >
                        {f.name}
                      </button>{' '}
                      <span className={`tag ${f.scope === 'project' ? 'info' : ''}`}>{f.scope}</span>
                      {f.description && <span className="note mem-feed-desc">{f.description}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {feed.length > 6 && (
              <button className="mini-btn" onClick={() => setFeedAll(!feedAll)}>{feedAll ? 'Show less' : `Show all ${feed.length}`}</button>
            )}
          </section>

          <section className="set-sec">
            <h2>Learning</h2>
            <div className="set-row">
              <div className="set-text">
                <div className="set-title">Review chats in the background</div>
                <div className="note">{MODES.find((m) => m.id === settings?.reflection)?.hint ?? 'A cheap model reads a finished chat and proposes memories and skills.'}</div>
              </div>
              <div className="set-ctl">
                <div className="seg" role="radiogroup" aria-label="Background review">
                  {MODES.map((m) => (
                    <button key={m.id} role="radio" aria-checked={settings?.reflection === m.id} className={settings?.reflection === m.id ? 'on' : ''} disabled={!settings} onClick={() => void setSetting({ reflection: m.id })}>
                      {m.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="set-row">
              <div className="set-text">
                <div className="set-title">Learn code style when a project opens</div>
                <div className="note">Builds the Luau style profile once per project if none exists yet. Runs locally; no model calls.</div>
              </div>
              <div className="set-ctl">
                <input type="checkbox" className="switch" checked={!!settings?.styleOnOpen} disabled={!settings} onChange={(e) => void setSetting({ styleOnOpen: e.target.checked })} aria-label="Learn code style when a project opens" />
              </div>
            </div>
            <div className="note mem-where">
              User memory: Forge's data folder (memory/). Project memory: <span className="mono">.forge/memory/</span>. Commit it so your teammates' agents share it.
            </div>
          </section>
        </div>

        <SyncCard />
      </div>
      {exporting && <ExportDialog onClose={() => setExporting(false)} />}
      {importing && <ImportDialog preview={importing} onClose={() => (setImporting(null), void load())} />}
    </div>
  )
}
