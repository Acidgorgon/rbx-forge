// Events tab: the Blink networking contract (events.blink and its imports), grouped by scope.
// Click a row to open its declaration; right-click to copy the generated API call.
import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import type { BlinkDiagnostic, BlinkEvent, BlinkTypeDecl } from '@shared/types'
import { blinkUsage } from '@shared/blinkUsage'
import { useStore } from '../store'
import { ClassIcon } from '../components/ClassIcon'
import { IconChevron, IconCopy } from '../components/Icons'
import { Menu, type MenuEntry } from '../components/Menu'
import { FilterBox } from './common'

const TOP = 'Top level'
const TYPES = '__types'

function fullName(x: { scope: string[]; name: string }): string {
  return [...x.scope, x.name].join('.')
}

function iconClass(ev: BlinkEvent): string {
  if (ev.kind === 'function') return 'RemoteFunction'
  return ev.type === 'Unreliable' ? 'UnreliableRemoteEvent' : 'RemoteEvent'
}

function Direction({ ev }: { ev: BlinkEvent }) {
  if (ev.kind === 'function') {
    return <span className="ev-dir ev-dir-fn" title="Client invokes, server returns">Client ⇄ Server</span>
  }
  const s2c = ev.from !== 'Client'
  return (
    <span className={`ev-dir ${s2c ? 'ev-dir-s2c' : 'ev-dir-c2s'}`} title={`From: ${ev.from ?? '?'}`}>
      {s2c ? 'Server → Client' : 'Client → Server'}
    </span>
  )
}

function shape(ev: BlinkEvent): string {
  if (ev.kind === 'function') return `${ev.data ?? '()'} → ${ev.return ?? '()'}`
  return ev.data ?? '(no data)'
}

function DiagnosticsBanner({ diagnostics, onOpen }: { diagnostics: BlinkDiagnostic[]; onOpen: (d: BlinkDiagnostic) => void }) {
  return (
    <div className="blink-banner" role="alert">
      <div className="blink-banner-head">
        <span className="blink-banner-dot" aria-hidden />
        <span>Blink can't compile {diagnostics.length > 1 ? `(${diagnostics.length} errors)` : ''}</span>
      </div>
      {diagnostics.map((d, k) => (
        <button key={k} className="blink-diag" onClick={() => onOpen(d)} title="Open at this position">
          <span className="blink-diag-loc">
            {d.file}:{d.line}:{d.column}
            {d.code && <span className="blink-diag-code">{d.code}</span>}
          </span>
          <span className="blink-diag-msg">{d.message}</span>
          {d.detail && <span className="blink-diag-detail">{d.detail}</span>}
        </button>
      ))}
      <div className="blink-banner-note">Generated files keep their last good version until this compiles.</div>
    </div>
  )
}

export function EventsPanel() {
  const { state, actions } = useStore()
  const blink = state.blink
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set([TYPES]))
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const closeMenu = useCallback(() => setMenu(null), [])
  const q = filter.trim().toLowerCase()

  const groups = useMemo(() => {
    const events = blink?.events ?? []
    const match = (ev: BlinkEvent) =>
      !q || fullName(ev).toLowerCase().includes(q) || (ev.data ?? '').toLowerCase().includes(q) || (ev.return ?? '').toLowerCase().includes(q)
    const byScope = new Map<string, BlinkEvent[]>()
    for (const ev of events) {
      if (!match(ev)) continue
      const key = ev.scope.join('.') || TOP
      if (!byScope.has(key)) byScope.set(key, [])
      byScope.get(key)!.push(ev)
    }
    return [...byScope.entries()]
      .sort(([a], [b]) => (a === TOP ? -1 : b === TOP ? 1 : a.localeCompare(b)))
      .map(([scope, list]) => ({ scope, events: list }))
  }, [blink, q])

  const types = useMemo(
    () => (blink?.types ?? []).filter((t) => !q || fullName(t).toLowerCase().includes(q)),
    [blink, q]
  )

  const toggle = (key: string) =>
    setCollapsed((c) => {
      const n = new Set(c)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const open = (x: { file: string; line: number; column?: number }) => void actions.openFileAt(x.file, x.line, x.column ?? 1)

  const onContext = (e: MouseEvent, ev: BlinkEvent) => {
    e.preventDefault()
    if (!blink) return
    const usage = blinkUsage(ev, blink)
    const name = fullName(ev)
    const items: MenuEntry[] = [
      { header: name },
      {
        label: 'Copy usage',
        icon: <IconCopy size={14} />,
        hint: 'server + client',
        onSelect: () => void actions.copy(`${usage.server}\n\n${usage.client}\n`, `usage of ${name}`)
      },
      { label: 'Copy server usage', hint: blink.requirePaths?.server ? 'server' : undefined, onSelect: () => void actions.copy(usage.server + '\n', `server usage of ${name}`) },
      { label: 'Copy client usage', hint: blink.requirePaths?.client ? 'client' : undefined, onSelect: () => void actions.copy(usage.client + '\n', `client usage of ${name}`) },
      'separator',
      { label: `Open in ${ev.file}`, hint: `line ${ev.line}`, onSelect: () => open(ev) },
      { label: 'Copy name', onSelect: () => void actions.copy(name) },
      { label: 'Insert into chat', onSelect: () => actions.insertIntoComposer(`the Blink ${ev.kind} \`${name}\` (${ev.file}:${ev.line})`) }
    ]
    setMenu({ x: e.clientX, y: e.clientY, items })
  }

  if (!blink || !blink.file) {
    return (
      <div className="panel">
        <div className="side-empty events-empty">
          {blink ? 'No events.blink in this project.' : 'Loading events…'}
          {blink && <div className="muted small">Blink networking events are declared in events.blink at the project root.</div>}
        </div>
      </div>
    )
  }

  const diagnostics = blink.diagnostics
  const total = blink.events.length
  const outputs = blink.outputs ?? {}

  return (
    <div className="panel events-panel">
      <div className="panel-head">
        <FilterBox value={filter} onChange={setFilter} placeholder="Filter events" />
      </div>
      {diagnostics.length > 0 && (
        <DiagnosticsBanner diagnostics={diagnostics} onOpen={(d) => open(d)} />
      )}
      <div className="events-meta">
        <button className="link-btn mono" onClick={() => open({ file: blink.file!, line: 1 })} title="Open events.blink">
          {blink.file}
        </button>
        <span className="events-meta-sep">·</span>
        <span>{total} declared</span>
        <span className="crumbs-fill" />
        {blink.checking ? (
          <span className="events-status">checking…</span>
        ) : blink.checker === 'missing' ? (
          <span className="events-status warn" title={blink.checkerDetail}>blink not found</span>
        ) : diagnostics.length === 0 && blink.checkedAt ? (
          <span className="events-status ok" title={blink.checkerDetail}>compiles</span>
        ) : null}
      </div>
      <div className="groups">
        {groups.length === 0 && <div className="side-empty">{q ? 'No matching events' : 'No events yet. Declare one in events.blink.'}</div>}
        {groups.map((g) => {
          const isCollapsed = !q && collapsed.has(g.scope)
          return (
            <section key={g.scope} className="group">
              <button className="group-head" onClick={() => toggle(g.scope)}>
                <span className={`twisty${isCollapsed ? '' : ' open'}`}>
                  <IconChevron size={12} />
                </span>
                <span className="group-name">{g.scope === TOP ? TOP : `scope ${g.scope}`}</span>
                <span className="count">{g.events.length}</span>
              </button>
              {!isCollapsed &&
                g.events.map((ev) => (
                  <div
                    key={`${ev.file}:${ev.line}:${ev.name}`}
                    className={`event-row${diagnostics.some((d) => d.file === ev.file && d.line >= ev.line && d.line <= (ev.endLine ?? ev.line)) ? ' has-error' : ''}`}
                    onClick={() => open(ev)}
                    onContextMenu={(e) => onContext(e, ev)}
                    title={`${fullName(ev)} — ${ev.file}:${ev.line}\nRight-click to copy usage`}
                  >
                    <div className="event-line">
                      <ClassIcon className={iconClass(ev)} size={13} />
                      <span className="event-name">{ev.name}</span>
                      <Direction ev={ev} />
                    </div>
                    <div className="event-chips">
                      {ev.kind === 'function' ? (
                        <>
                          <span className="ev-chip">function</span>
                          {ev.yield && <span className="ev-chip">{ev.yield}</span>}
                        </>
                      ) : (
                        <>
                          {ev.type && <span className={`ev-chip${ev.type === 'Unreliable' ? ' ev-unreliable' : ''}`}>{ev.type}</span>}
                          {ev.call && <span className="ev-chip">{ev.call}</span>}
                          {ev.poll && <span className="ev-chip">Poll</span>}
                        </>
                      )}
                    </div>
                    <div className="event-data mono" title={shape(ev)}>{shape(ev)}</div>
                  </div>
                ))}
            </section>
          )
        })}

        {types.length > 0 && (
          <section className="group">
            <button className="group-head" onClick={() => toggle(TYPES)}>
              <span className={`twisty${!q && collapsed.has(TYPES) ? '' : ' open'}`}>
                <IconChevron size={12} />
              </span>
              <span className="group-name">Types</span>
              <span className="count">{types.length}</span>
            </button>
            {!(!q && collapsed.has(TYPES)) &&
              types.map((t: BlinkTypeDecl) => (
                <div
                  key={`${t.file}:${t.line}:${t.name}`}
                  className="type-row"
                  onClick={() => open(t)}
                  title={`${t.kind} ${fullName(t)}${t.definition ? ` ${t.definition}` : ''}`}
                >
                  <span className={`type-kind kind-${t.kind}`}>{t.kind}</span>
                  <span className="type-name">{fullName(t)}{t.generics ? `<${t.generics.join(', ')}>` : ''}</span>
                  {t.exported && <span className="ev-chip">export</span>}
                  <span className="type-def mono">{t.members ? `{ ${t.members.join(', ')} }` : t.definition}</span>
                </div>
              ))}
          </section>
        )}
      </div>
      {(outputs.client || outputs.server) && (
        <div className="events-outputs">
          <span className="muted">Generates</span>
          {outputs.server && (
            <button className="link-btn mono" onClick={() => void actions.openFile(outputs.server!)} title={`${outputs.server}${blink.requirePaths?.server ? `\n${blink.requirePaths.server}` : ''}`}>
              {outputs.server.split('/').pop()}
            </button>
          )}
          {outputs.client && (
            <button className="link-btn mono" onClick={() => void actions.openFile(outputs.client!)} title={`${outputs.client}${blink.requirePaths?.client ? `\n${blink.requirePaths.client}` : ''}`}>
              {outputs.client.split('/').pop()}
            </button>
          )}
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  )
}
