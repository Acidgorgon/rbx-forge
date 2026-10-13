import { useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { LogLine } from '@shared/types'
import { useStore } from '../store'
import { Drawer } from '../components/Drawer'
import { IconTerminal } from '../components/Icons'
import { FilterBox } from './common'

const SOURCES: { id: LogLine['service'] | 'all'; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'dev', label: 'Dev' },
  { id: 'rojo', label: 'Rojo' },
  { id: 'lsp', label: 'LSP' },
  { id: 'studioSync', label: 'Studio' },
  { id: 'git', label: 'Git' },
  { id: 'agent', label: 'Agent' },
  { id: 'harness', label: 'Harness' }
]

const fmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false })

export function LogsDrawer() {
  const { state, actions } = useStore()
  const [text, setText] = useState('')
  const [follow, setFollow] = useState(true)
  const ref = useRef<HTMLDivElement>(null)
  const filter = state.logFilter

  const lines = useMemo(() => {
    const q = text.trim().toLowerCase()
    return state.logs.filter((l) => (filter === 'all' || l.service === filter) && (!q || l.text.toLowerCase().includes(q)))
  }, [state.logs, filter, text])

  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [lines, follow])

  return (
    <Drawer title="Logs" icon={<IconTerminal />} subtitle={`${lines.length} lines`} width={720} onClose={() => actions.set({ drawer: null })}>
      <div className="logs-tools">
        <div className="seg">
          {SOURCES.map((s) => (
            <button key={s.id} className={filter === s.id ? 'active' : ''} onClick={() => actions.set({ logFilter: s.id })}>
              {s.label}
            </button>
          ))}
        </div>
        <FilterBox value={text} onChange={setText} placeholder="Search logs" />
        <label className="check">
          <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
          Auto-scroll
        </label>
      </div>
      <div
        className="logs"
        ref={ref}
        onScroll={(e) => {
          const el = e.currentTarget
          const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24
          if (atBottom !== follow) setFollow(atBottom)
        }}
      >
        {lines.length === 0 && <div className="logs-empty">No log lines yet.</div>}
        {lines.map((l, i) => (
          <div key={i} className={`log-line ${l.stream}`}>
            <span className="log-time">{fmt(l.at)}</span>
            <span className={`log-src src-${l.service}`}>{l.service}</span>
            <span className="log-text">{l.text}</span>
          </div>
        ))}
      </div>
    </Drawer>
  )
}
