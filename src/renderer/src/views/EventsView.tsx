// Events (Blink): one group per root .blink file (blink.files), events and functions with their
// direction, type and data; diagnostics; copy usage; generated outputs read-only; new event form.
import { useMemo, useState, type MouseEvent } from 'react'
import type { BlinkEvent, BlinkModel } from '@shared/types'
import { blinkUsage } from '@shared/blinkUsage'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ClassIcon } from '../components/ClassIcon'
import { useMenu, type MenuEntry } from '../components/Menu'
import { ago } from '../lib/format'

const fullName = (x: { scope: string[]; name: string }) => [...x.scope, x.name].join('.')

function Dir({ ev }: { ev: BlinkEvent }) {
  if (ev.kind === 'function') return <span className="dir fn" title="Client invokes, server returns">C⇄S</span>
  const s2c = ev.from !== 'Client'
  return <span className={`dir ${s2c ? 's2c' : 'c2s'}`} title={`From: ${ev.from ?? '?'}`}>{s2c ? 'S→C' : 'C→S'}</span>
}

function FileGroup({ model, q, collapsed, toggle }: { model: BlinkModel; q: string; collapsed: Set<string>; toggle: (k: string) => void }) {
  const { state, actions } = useStore()
  const menu = useMenu()
  const file = model.file ?? 'events.blink'
  const events = model.events.filter((ev) => !q || fullName(ev).toLowerCase().includes(q) || (ev.data ?? '').toLowerCase().includes(q))
  const types = model.types.filter((t) => !q || fullName(t).toLowerCase().includes(q))
  const errors = model.diagnostics.filter((d) => d.severity === 'error').length
  const closed = collapsed.has(file)
  const typesKey = `${file}#types`
  const open = (x: { file: string; line: number; column?: number }) => void actions.openFileAt(x.file, x.line, x.column ?? 1)

  const evMenu = (e: MouseEvent, ev: BlinkEvent) => {
    const usage = blinkUsage(ev, model)
    const name = fullName(ev)
    const items: MenuEntry[] = [
      { header: name, mono: true },
      { label: 'Copy usage', icon: <Icon name="copy" />, sub: 'server + client snippets', onSelect: () => void actions.copy(`${usage.server}\n\n${usage.client}\n`, `usage of ${name}`) },
      { label: 'Copy server usage', icon: <Icon name="code" />, onSelect: () => void actions.copy(usage.server + '\n', `server usage of ${name}`) },
      { label: 'Copy client usage', icon: <Icon name="code" />, onSelect: () => void actions.copy(usage.client + '\n', `client usage of ${name}`) },
      'separator',
      { label: `Open in ${ev.file}`, icon: <Icon name="file" />, hint: `:${ev.line}`, onSelect: () => open(ev) },
      { label: 'Copy name', icon: <Icon name="copy" />, onSelect: () => void actions.copy(name) },
      { label: 'Ask Assistant about this event', icon: <Icon name="at" />, onSelect: () => actions.ask(`Blink ${ev.kind} \`${name}\` in ${ev.file} `) }
    ]
    menu.openAt(e, items)
  }

  return (
    <section className="vsec">
      <div className="vsec-head" style={{ cursor: 'pointer' }} onClick={() => toggle(file)}>
        <Icon name={closed ? 'chev' : 'chevDown'} size={12} />
        <span style={{ textTransform: 'none', letterSpacing: 'var(--track)', color: 'var(--fg-2)' }}>{file}</span>
        <span className="count">{model.events.length}</span>
        <span className="grow" />
        {model.checking ? <span className="spinner" title="Compiling" /> : errors ? <span className="tag err">{errors} error{errors === 1 ? '' : 's'}</span> : model.checker === 'missing' ? <span className="tag warn" title={model.checkerDetail}>no blink</span> : <span className="tag ok" title={model.checkedAt ? `checked ${ago(model.checkedAt)}` : ''}>ok</span>}
        <button className="icon-btn" style={{ width: 20, height: 20 }} title={`Open ${file}`} onClick={(e) => (e.stopPropagation(), void actions.openFile(file))}>
          <Icon name="external" size={12} />
        </button>
      </div>
      {!closed && (
        <>
          {model.diagnostics.map((d, i) => (
            <div key={i} className="diag" onClick={() => open(d)} title="Open at this position">
              <div>{d.code && <span className="mono">{d.code} </span>}{d.message}</div>
              <div className="sub">{d.file}:{d.line}:{d.column}{d.detail ? ` · ${d.detail}` : ''}</div>
            </div>
          ))}
          {events.map((ev) => (
            <div key={`${ev.file}:${ev.line}`} className={`lrow${state.activeFile === ev.file ? '' : ''}`} style={{ paddingLeft: 22 }} onClick={() => open(ev)} onContextMenu={(e) => evMenu(e, ev)} title={`${fullName(ev)}\n${ev.kind === 'function' ? `${ev.data ?? '()'} → ${ev.return ?? '()'}` : ev.data ?? '(no data)'}\n${ev.type ?? ''} ${ev.call ?? ev.yield ?? ''}`}>
              <ClassIcon className={ev.kind === 'function' ? 'RemoteFunction' : ev.type === 'Unreliable' ? 'UnreliableRemoteEvent' : 'RemoteEvent'} size={14} />
              <span className="ellipsis grow">
                {ev.scope.length > 0 && <span className="faint">{ev.scope.join('.')}.</span>}
                {ev.name}
              </span>
              {ev.type === 'Unreliable' && <span className="tag">unrel</span>}
              <Dir ev={ev} />
            </div>
          ))}
          {!events.length && !model.diagnostics.length && <div className="note" style={{ padding: '2px 22px' }}>{q ? 'No events match.' : 'No events in this file.'}</div>}
          {types.length > 0 && (
            <>
              <div className="lrow" style={{ paddingLeft: 22, color: 'var(--fg-muted)' }} onClick={() => toggle(typesKey)}>
                <Icon name={collapsed.has(typesKey) ? 'chev' : 'chevDown'} size={11} />
                <span className="grow">types</span>
                <span className="count">{types.length}</span>
              </div>
              {!collapsed.has(typesKey) &&
                types.map((t) => (
                  <div key={`${t.file}:${t.line}`} className="lrow" style={{ paddingLeft: 38 }} onClick={() => open(t)} title={t.definition}>
                    <span className="tag">{t.kind}</span>
                    <span className="ellipsis grow">{fullName(t)}</span>
                  </div>
                ))}
            </>
          )}
          {model.outputs && (
            <div className="note" style={{ padding: '6px 22px 0' }}>
              {(['client', 'server', 'types'] as const).map((k) =>
                model.outputs?.[k] ? (
                  <div key={k} className="row" style={{ gap: 6, cursor: 'pointer' }} onClick={() => void actions.openFile(model.outputs![k]!)} title="Generated, read-only">
                    <Icon name="lock" size={11} />
                    <span className="ellipsis">{model.outputs[k]}</span>
                  </div>
                ) : null
              )}
            </div>
          )}
        </>
      )}
      {menu.node}
    </section>
  )
}

export function EventsView() {
  const { state, actions } = useStore()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set())
  const q = filter.trim().toLowerCase()
  const models = useMemo(() => {
    const b = state.blink
    if (!b) return []
    if (b.files?.length) return b.files
    return b.file ? [b] : []
  }, [state.blink])
  const toggle = (k: string) => setCollapsed((c) => { const n = new Set(c); n.has(k) ? n.delete(k) : n.add(k); return n })
  const total = models.reduce((n, m) => n + m.events.length, 0)

  const createFile = async () => {
    const contents = `option ClientOutput = "src/shared/events/client.luau"\noption ServerOutput = "src/server/events/server.luau"\n\nevent Ping {\n\tFrom: Client,\n\tType: Reliable,\n\tCall: SingleSync,\n\tData: u8\n}\n`
    try {
      await window.harness.writeFile('events.blink', contents)
      void actions.openFile('events.blink')
    } catch (e) {
      actions.toast({ text: 'Could not create events.blink', detail: String((e as Error).message), kind: 'err' })
    }
  }

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Events · Blink</span>
        <span className="count" style={{ marginRight: 6 }}>{total}</span>
        <button className="icon-btn" title="New Blink event" onClick={() => actions.requestCreate('Blink')}>
          <Icon name="plus" size={14} />
        </button>
      </div>
      <label className="filter">
        <Icon name="search" size={12} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter events, data types" spellCheck={false} />
      </label>
      <div className="panel-body">
        {!models.length ? (
          <div className="empty">
            <Icon name="bolt" />
            <span>No Blink file. Create events.blink with client and server outputs?</span>
            {state.project && <button className="btn" onClick={() => void createFile()}>Create events.blink</button>}
          </div>
        ) : (
          models.map((m) => <FileGroup key={m.file ?? 'events.blink'} model={m} q={q} collapsed={collapsed} toggle={toggle} />)
        )}
        {state.blink?.blinkVersion && <div className="note" style={{ padding: '4px 12px' }}>blink {state.blink.blinkVersion}{state.blink.checkedAt ? ` · checked ${ago(state.blink.checkedAt)}` : ''}</div>}
      </div>
    </>
  )
}
