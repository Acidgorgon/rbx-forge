// Bottom panel (SPEC §7.6): Output (service logs), Problems, Dev · Rojo raw output.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LogLine, ServiceId } from '@shared/types'
import { useStore, type BottomTab, type ProblemItem } from '../store'
import { Icon } from '../components/Icons'
import { FileGlyph } from '../components/ClassIcon'
import { useProblems } from './problems'
import { ledOf } from './StatusBar'
import { fmtTime, keyHint, ago } from '../lib/format'
import { basename } from '../lib/roblox'

const SOURCE_LABEL: Record<LogLine['service'], string> = { rojo: 'rojo', dev: 'watcher', lsp: 'luau-lsp', studioSync: 'studio', git: 'git', agent: 'agent', harness: 'forge' }
const SOURCE_COLOR: Record<LogLine['service'], string> = {
  rojo: 'var(--ember-text)',
  dev: 'var(--realm-shared)',
  lsp: 'var(--realm-server)',
  studioSync: 'var(--realm-studio)',
  git: 'var(--realm-client)',
  agent: 'var(--fg-2)',
  harness: 'var(--fg-muted)'
}
const CHIPS: LogLine['service'][] = ['rojo', 'dev', 'lsp', 'studioSync', 'git', 'agent', 'harness']

// Strips ANSI escapes; paths like src/... become links.
const ANSI = /\x1b\[[0-9;]*m/g
const PATH = /(src\/[\w./-]+\.(?:luau?|blink|json|toml)|[\w-]+\.blink)(?::(\d+))?(?::(\d+))?/g

function Message({ text, onOpen }: { text: string; onOpen: (path: string, line?: number) => void }) {
  const clean = text.replace(ANSI, '')
  const parts: React.ReactNode[] = []
  let last = 0
  for (const m of clean.matchAll(PATH)) {
    const i = m.index ?? 0
    if (i > last) parts.push(clean.slice(last, i))
    parts.push(
      <a key={i} href="#" onClick={(e) => (e.preventDefault(), onOpen(m[1], m[2] ? Number(m[2]) : undefined))}>
        {m[0]}
      </a>
    )
    last = i + m[0].length
  }
  if (last < clean.length) parts.push(clean.slice(last))
  return <>{parts}</>
}

function lineClass(l: LogLine): string {
  const t = l.text
  if (l.stream === 'stderr' || /\b(error|failed|crash)/i.test(t)) return ' bad'
  if (l.service === 'dev' && /^\s*(add|\+)/i.test(t)) return ' add'
  if (l.service === 'dev' && /^\s*(del|-)/i.test(t)) return ' del'
  if (/\bwarn/i.test(t)) return ' warn'
  return ''
}

function LogView({ lines, follow, setFollow }: { lines: LogLine[]; follow: boolean; setFollow: (v: boolean) => void }) {
  const { actions } = useStore()
  const ref = useRef<HTMLDivElement>(null)
  const seen = useRef(lines.length)
  const [unseen, setUnseen] = useState(0)
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    if (follow) {
      el.scrollTop = el.scrollHeight
      seen.current = lines.length
      setUnseen(0)
    } else setUnseen(Math.max(0, lines.length - seen.current))
  }, [lines, follow])
  const open = (path: string, line?: number) => void (line ? actions.openFileAt(path, line) : actions.openFile(path))
  return (
    <div className="out-wrap">
      <div
        className="out scroll selectable"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {lines.map((l, i) => (
          <div key={i} className={`ol${lineClass(l)}`}>
            <span className="ot">{fmtTime(l.at)}</span>
            <span className="os" style={{ color: SOURCE_COLOR[l.service] }}>{SOURCE_LABEL[l.service]}</span>
            <span className="om">
              <Message text={l.text} onOpen={open} />
            </span>
          </div>
        ))}
      </div>
      {!follow && unseen > 0 && (
        <button className="new-lines" onClick={() => setFollow(true)}>
          <Icon name="arrowDown" size={12} /> {unseen} new line{unseen === 1 ? '' : 's'}
        </button>
      )}
    </div>
  )
}

function Output() {
  const { state, actions } = useStore()
  const [filter, setFilter] = useState('')
  const [follow, setFollow] = useState(true)
  const selected = state.logServices
  const lines = useMemo(() => {
    const f = filter.trim().toLowerCase()
    return state.logs.filter((l) => (!selected.length || selected.includes(l.service)) && (!f || l.text.toLowerCase().includes(f)))
  }, [state.logs, selected, filter])
  const one = selected.length === 1 ? state.services.find((s) => s.id === selected[0]) : undefined
  const pick = (e: React.MouseEvent, id: LogLine['service'] | null) => {
    if (!id) return actions.set({ logServices: [] })
    if (e.altKey) actions.set({ logServices: selected.includes(id) ? selected.filter((x) => x !== id) : [...selected, id] })
    else actions.set({ logServices: selected.length === 1 && selected[0] === id ? [] : [id] })
  }
  return (
    <>
      <div className="bp-tools">
        <div className="chips">
          <button className={`chip${!selected.length ? ' on' : ''}`} onClick={(e) => pick(e, null)}>All</button>
          {CHIPS.map((id) => {
            const svc = state.services.find((s) => s.id === id)
            if (!svc && !state.logs.some((l) => l.service === id)) return null
            return (
              <button key={id} className={`chip${selected.includes(id) ? ' on' : ''}`} onClick={(e) => pick(e, id)} title="Alt-click to select several">
                {svc && <span className={`led ${ledOf(svc)}`} />}
                {SOURCE_LABEL[id]}
              </button>
            )
          })}
        </div>
        <span className="grow" />
        <label className="filter mini">
          <Icon name="filter" size={12} />
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter output" spellCheck={false} />
        </label>
        {one && (
          <button className="mini-btn" onClick={() => void actions.restartService(one.id)} title={`Restart ${one.label}`}>
            <Icon name="restart" size={12} /> Restart
          </button>
        )}
        <button className="icon-btn" title="Clear" onClick={() => actions.set({ logs: [] })}>
          <Icon name="trash" size={14} />
        </button>
      </div>
      {one && (one.state === 'stopped' || one.state === 'missing' || one.state === 'crashed') && !lines.length ? (
        <div className="empty">
          <span>{one.label} is {one.state === 'missing' ? 'not installed' : one.state}.</span>
          {one.detail && <span className="note mono">{one.detail}</span>}
          {one.state !== 'missing' && (
            <button className="btn" onClick={() => void window.harness.startService(one.id)}>
              <Icon name="play" size={12} /> Start
            </button>
          )}
        </div>
      ) : (
        <LogView lines={lines} follow={follow} setFollow={setFollow} />
      )}
    </>
  )
}

function Problems() {
  const { state, actions } = useStore()
  const problems = useProblems()
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const groups = useMemo(() => {
    const m = new Map<string, ProblemItem[]>()
    for (const p of problems) m.set(p.path, [...(m.get(p.path) ?? []), p])
    return [...m.entries()]
  }, [problems])
  if (!problems.length) {
    return (
      <div className="empty">
        <Icon name="check" style={{ color: 'var(--ok)' }} />
        <span>No problems.{state.lsp.state === 'ready' ? ' luau-lsp is watching the project.' : ''}</span>
        <span className="note">{state.lintAt ? `Lint ran ${ago(state.lintAt)}.` : 'selene and StyLua have not run yet.'}</span>
        <div className="row">
          <button className="btn" onClick={() => void actions.runLint()}>
            Run lint
          </button>
        </div>
      </div>
    )
  }
  return (
    <div className="probs scroll">
      <div className="bp-tools" style={{ position: 'sticky', top: 0 }}>
        <span className="note">{problems.length} problem{problems.length === 1 ? '' : 's'} in {groups.length} file{groups.length === 1 ? '' : 's'}</span>
        <span className="grow" />
        <button className="mini-btn" onClick={() => void actions.runLint()}>Run lint</button>
      </div>
      {groups.map(([path, items]) => (
        <div key={path}>
          <div className="pg" onClick={() => setCollapsed((c) => { const n = new Set(c); n.has(path) ? n.delete(path) : n.add(path); return n })}>
            <Icon name={collapsed.has(path) ? 'chev' : 'chevDown'} size={12} />
            <FileGlyph path={path} size={14} />
            <span>{basename(path)}</span>
            <span className="faint mono ellipsis" style={{ fontSize: 11 }}>{path}</span>
            <span className="count">{items.length}</span>
          </div>
          {!collapsed.has(path) &&
            items.map((p, i) => (
              <div key={i} className="pr" onClick={() => void actions.openFileAt(p.path, p.line, p.col)}>
                <Icon name={p.severity === 'error' ? 'err' : p.severity === 'warning' ? 'warn' : 'info'} size={13} style={{ color: p.severity === 'error' ? 'var(--err)' : p.severity === 'warning' ? 'var(--warn)' : 'var(--info)' }} />
                <span className="ellipsis grow selectable">{p.message.split('\n')[0]}</span>
                <span className="mono faint">[{p.line}, {p.col}]</span>
                <span className="mono faint">{p.source}{p.code ? `(${p.code})` : ''}</span>
              </div>
            ))}
        </div>
      ))}
    </div>
  )
}

function Terminal() {
  const { state, actions } = useStore()
  const [follow, setFollow] = useState(true)
  const lines = useMemo(() => state.logs.filter((l) => l.service === 'dev' || l.service === 'rojo'), [state.logs])
  const dev = state.services.find((s) => s.id === 'dev')
  const rojo = state.services.find((s) => s.id === 'rojo')
  return (
    <>
      <div className="bp-tools">
        {[dev, rojo].map((s) =>
          s ? (
            <span key={s.id} className="chip static">
              <span className={`led ${ledOf(s)}`} />
              {s.id === 'dev' ? './dev' : 'rojo serve'}
              <span className="faint mono">{s.pid ? `pid ${s.pid}` : s.state}</span>
            </span>
          ) : null
        )}
        <span className="grow" />
        <button className="mini-btn" onClick={() => void actions.restartService('dev')}>
          <Icon name="restart" size={12} /> Restart ./dev
        </button>
        <button className="mini-btn" onClick={() => void actions.restartService('rojo')}>
          <Icon name="restart" size={12} /> Restart rojo
        </button>
      </div>
      <LogView lines={lines} follow={follow} setFollow={setFollow} />
    </>
  )
}

export function BottomPanel() {
  const { state, actions } = useStore()
  const problems = useProblems()
  const tab = state.layout.bottomTab
  const errors = problems.filter((p) => p.severity === 'error').length
  const tabs: { id: BottomTab; label: string; badge?: React.ReactNode }[] = [
    { id: 'output', label: 'Output' },
    { id: 'problems', label: 'Problems', badge: problems.length ? <span className={`bp-badge${errors ? ' err' : ' warn'}`}>{problems.length}</span> : null },
    { id: 'terminal', label: 'Dev · Rojo' }
  ]
  // Crashes open Output filtered to the crashed service (unless the panel was closed recently).
  const prevStates = useRef<Record<string, string>>({})
  const closedAt = useRef(0)
  useEffect(() => {
    if (!state.layout.bottomOpen) closedAt.current = Date.now()
  }, [state.layout.bottomOpen])
  useEffect(() => {
    for (const s of state.services) {
      const before = prevStates.current[s.id]
      if (before && before !== 'crashed' && s.state === 'crashed' && Date.now() - closedAt.current > 5 * 60_000) actions.showBottom('output', [s.id as ServiceId])
      prevStates.current[s.id] = s.state
    }
  }, [state.services])

  return (
    <section className="panel bottom" aria-label="Bottom panel">
      <div className="panel-inner">
        <div className="bp-head">
          {tabs.map((t) => (
            <button key={t.id} className={`bp-tab${tab === t.id ? ' on' : ''}`} onClick={() => actions.setLayout({ bottomTab: t.id })}>
              {t.label}
              {t.badge}
            </button>
          ))}
          <span className="grow" />
          <button className="icon-btn" title={`Close (${keyHint('mod+j')})`} onClick={() => actions.toggleBottom()}>
            <Icon name="x" size={14} />
          </button>
        </div>
        <div className="bp-body">{tab === 'output' ? <Output /> : tab === 'problems' ? <Problems /> : <Terminal />}</div>
      </div>
    </section>
  )
}
