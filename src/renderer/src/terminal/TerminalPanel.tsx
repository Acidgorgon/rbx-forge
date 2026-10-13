// Bottom panel "Terminal" tab: tabs of integrated terminals (node-pty + xterm.js), shell picker,
// tasks, find, and the assistant's run_in_terminal confirmation.
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { TerminalInfo } from '@shared/types'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { useMenu, type MenuEntry } from '../components/Menu'
import { useTheme } from '../theme'
import { keyHint } from '../lib/format'
import {
  applyTheme,
  confirmRun,
  drainEarly,
  killTerminal,
  newTerminal,
  renameTerminal,
  runTask,
  setActive,
  setDefaultShell,
  setFindHandler,
  setPathOpener,
  startTerminals,
  termStore,
  xtermFor
} from './session'
import './terminal.css'

export function useTerminals() {
  useEffect(() => startTerminals(), [])
  return useSyncExternalStore(termStore.subscribe, termStore.get)
}

function Tab({ t, active }: { t: TerminalInfo; active: boolean }) {
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(t.title)
  const icon = t.kind === 'agent' ? 'bot' : t.kind === 'task' ? 'play' : 'terminal'
  const led = t.exited ? (t.exitCode && t.exitCode !== 0 ? 'err' : 'idle') : 'ok'
  return (
    <span
      className={`chip term-chip${active ? ' on' : ''}${t.exited ? ' exited' : ''}`}
      role="tab"
      aria-selected={active}
      tabIndex={0}
      title={`${t.title} · ${t.shellLabel}${t.pid ? ` · pid ${t.pid}` : ''}${t.command ? `\n${t.command}` : ''}\nDouble-click to rename`}
      onClick={() => setActive(t.id)}
      onKeyDown={(e) => e.key === 'Enter' && setActive(t.id)}
      onDoubleClick={() => {
        setValue(t.title)
        setEditing(true)
      }}
      onAuxClick={(e) => e.button === 1 && killTerminal(t.id)}
    >
      <span className={`led ${led}`} />
      <Icon name={icon} size={11} />
      {editing ? (
        <input
          className="term-rename"
          autoFocus
          value={value}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          onClick={(e) => e.stopPropagation()}
          onBlur={() => {
            setEditing(false)
            if (value.trim() && value !== t.title) void renameTerminal(t.id, value)
          }}
          onKeyDown={(e) => {
            e.stopPropagation()
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            if (e.key === 'Escape') {
              setValue(t.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <span className="ellipsis">{t.title}</span>
      )}
      <button
        className="term-x"
        title="Kill terminal"
        aria-label={`Kill ${t.title}`}
        onClick={(e) => {
          e.stopPropagation()
          killTerminal(t.id)
        }}
      >
        <Icon name="x" size={10} />
      </button>
    </span>
  )
}

// Mounts the active terminal's xterm element, keeps it fitted to the panel, and focuses it.
function XtermView({ id, focusNonce, visible }: { id: string; focusNonce: number; visible: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  useLayoutEffect(() => {
    const container = ref.current
    if (!container) return
    const entry = xtermFor(id)
    container.appendChild(entry.host)
    if (!entry.term.element) {
      entry.term.open(entry.host)
      const early = drainEarly(id)
      if (early) entry.term.write(early)
    }
    let frame = 0
    const fit = () => {
      cancelAnimationFrame(frame)
      frame = requestAnimationFrame(() => {
        if (container.clientWidth > 0 && container.clientHeight > 0) {
          try {
            entry.fit.fit()
          } catch {
            // not laid out yet
          }
        }
      })
    }
    fit()
    // Font metrics change once JetBrains Mono finishes loading.
    void document.fonts?.ready.then(fit)
    const observer = new ResizeObserver(fit)
    observer.observe(container)
    return () => {
      observer.disconnect()
      cancelAnimationFrame(frame)
      entry.host.remove()
    }
  }, [id])
  useEffect(() => {
    if (visible) requestAnimationFrame(() => xtermFor(id).term.focus())
  }, [id, focusNonce, visible])
  return <div className="term-view" ref={ref} />
}

function FindBar({ id, onClose }: { id: string; onClose: () => void }) {
  const [q, setQ] = useState('')
  const [caseSensitive, setCase] = useState(false)
  const [regex, setRegex] = useState(false)
  const [miss, setMiss] = useState(false)
  const search = xtermFor(id).search
  const find = (back = false, incremental = false) => {
    if (!q) return setMiss(false)
    const opts = { caseSensitive, regex, incremental }
    let found = false
    try {
      found = back ? search.findPrevious(q, opts) : search.findNext(q, opts)
    } catch {
      found = false
    }
    setMiss(!found)
  }
  useEffect(() => find(false, true), [q, caseSensitive, regex])
  const close = () => {
    search.clearDecorations()
    xtermFor(id).term.clearSelection()
    onClose()
    xtermFor(id).term.focus()
  }
  return (
    <div className={`term-find${miss ? ' miss' : ''}`} role="search">
      <Icon name="search" size={12} />
      <input
        autoFocus
        value={q}
        placeholder="Find in terminal"
        spellCheck={false}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault()
            find(e.shiftKey)
          }
          if (e.key === 'Escape') close()
        }}
      />
      <button className={`term-opt${caseSensitive ? ' on' : ''}`} title="Match case" onClick={() => setCase(!caseSensitive)}>Aa</button>
      <button className={`term-opt${regex ? ' on' : ''}`} title="Regular expression" onClick={() => setRegex(!regex)}>.*</button>
      <button className="icon-btn" title="Previous (Shift+Enter)" onClick={() => find(true)}>
        <Icon name="arrowUp" size={12} />
      </button>
      <button className="icon-btn" title="Next (Enter)" onClick={() => find()}>
        <Icon name="arrowDown" size={12} />
      </button>
      <button className="icon-btn" title="Close (Esc)" onClick={close}>
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}

export function TerminalPanel() {
  const { state: app, actions } = useStore()
  const s = useTerminals()
  const theme = useTheme()
  const menu = useMenu()
  const [finding, setFinding] = useState(false)
  const active = s.list.find((t) => t.id === s.active) ?? null
  const visible = app.layout.bottomOpen && app.layout.bottomTab === 'shell'

  useEffect(() => {
    // The theme tokens are already applied to <html> when useTheme changes.
    requestAnimationFrame(applyTheme)
  }, [theme])
  useEffect(() => {
    setPathOpener((path, line) => void (line ? actions.openFileAt(path, line) : actions.openFile(path)))
    setFindHandler(() => setFinding(true))
    return () => {
      setPathOpener(null)
      setFindHandler(null)
    }
  }, [])
  // Opening the tab with no terminal starts one (like VS Code's Ctrl+`).
  const autoStarted = useRef(false)
  useEffect(() => {
    if (!visible) {
      autoStarted.current = false
      return
    }
    if (!s.list.length && app.project && s.shells.length && !s.error && !autoStarted.current) {
      autoStarted.current = true
      void newTerminal()
    }
  }, [visible, s.list.length, app.project, s.shells.length])

  const shellItems = (): MenuEntry[] => [
    { header: 'New terminal' },
    ...s.shells.map((sh) => ({ label: sh.label, sub: sh.path, checked: sh.default, onSelect: () => void newTerminal(sh.id) })),
    'separator',
    { header: 'Default shell' },
    ...s.shells.map((sh) => ({ label: sh.label, checked: sh.default, onSelect: () => void setDefaultShell(sh.id) })),
    'separator',
    { header: 'Run task' },
    ...s.tasks.map((t) => ({ label: t.label, sub: t.detail, icon: <Icon name="play" size={12} />, onSelect: () => void runTask(t.id) }))
  ]

  return (
    <div className="term-panel">
      <div className="bp-tools term-tools">
        <div className="chips" role="tablist" aria-label="Terminals">
          {s.list.map((t) => (
            <Tab key={t.id} t={t} active={t.id === s.active} />
          ))}
        </div>
        <button className="icon-btn" title="New terminal" aria-label="New terminal" onClick={() => void newTerminal()} disabled={!app.project}>
          <Icon name="plus" size={13} />
        </button>
        <button className="icon-btn" title="Shells and tasks" aria-label="Shells and tasks" onClick={(e) => menu.openUnder(e.currentTarget, shellItems(), { minWidth: 240 })}>
          <Icon name="chevDown" size={13} />
        </button>
        <span className="grow" />
        {active && (
          <span className="note mono faint ellipsis term-meta">
            {active.shellLabel}
            {active.exited ? ` · exited${active.exitCode ? ` ${active.exitCode}` : ''}` : active.pid ? ` · pid ${active.pid}` : ''}
          </span>
        )}
        <button className={`icon-btn${finding ? ' on' : ''}`} title={`Find (${keyHint('mod+f')})`} disabled={!active} onClick={() => setFinding(!finding)}>
          <Icon name="search" size={13} />
        </button>
        <button className="icon-btn" title="Clear" disabled={!active} onClick={() => active && xtermFor(active.id).term.clear()}>
          <Icon name="collapse" size={13} />
        </button>
        <button className="icon-btn" title="Kill terminal" disabled={!active} onClick={() => active && killTerminal(active.id)}>
          <Icon name="trash" size={13} />
        </button>
      </div>
      {s.pending.map((p) => (
        <div key={p.id} className="term-confirm" role="alertdialog" aria-label="Assistant wants to run a command">
          <span className="term-confirm-tag">
            <Icon name="bot" size={12} /> assistant
          </span>
          <span className="term-confirm-text">
            wants to run <code className="selectable">{p.command}</code>
            <span className="faint"> in {p.cwd.split(/[\\/]/).pop()}</span>
          </span>
          <span className="grow" />
          <button className="mini-btn" onClick={() => confirmRun(p.id, false)}>Deny</button>
          <button className="mini-btn hot" autoFocus onClick={() => confirmRun(p.id, true)}>
            <Icon name="play" size={11} /> Run
          </button>
        </div>
      ))}
      <div className="term-body">
        {finding && active && <FindBar id={active.id} onClose={() => setFinding(false)} />}
        {active ? (
          <XtermView key={active.id} id={active.id} focusNonce={s.focusNonce} visible={visible} />
        ) : (
          <div className="empty">
            <Icon name="terminal" />
            {s.error ? <span className="term-error mono">{s.error}</span> : <span>{app.project ? 'No terminal open.' : 'Open a project to use the terminal.'}</span>}
            <span className="note">
              Runs in the project root with Rokit tools on PATH · {keyHint('ctrl+`')} toggles
            </span>
            {app.project && (
              <div className="row">
                <button className="btn" onClick={() => void newTerminal()}>
                  <Icon name="plus" size={12} /> New terminal
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {menu.node}
    </div>
  )
}
