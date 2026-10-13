// Scripts: every script grouped by role (all ScriptCategory values, including Handlers, Skills,
// Protocols, Stories and Tests), filterable, with the same copy / spec / ask actions as the tree.
import { useMemo, useState, type MouseEvent } from 'react'
import type { ScriptCategory, ScriptEntry } from '@shared/types'
import { robloxPaths } from '@shared/robloxPath'
import { useStore } from '../store'
import { Icon } from '../components/Icons'
import { ClassIcon } from '../components/ClassIcon'
import { useMenu, type MenuEntry } from '../components/Menu'
import { requireExpression, featuresOf, scriptsFlat } from '../lib/roblox'
import { keyHint } from '../lib/format'

const ORDER: ScriptCategory[] = ['Configs', 'Data', 'Services', 'Handlers', 'Controllers', 'Skills', 'Modules', 'Protocols', 'Events', 'UI', 'Stories', 'Entry points', 'Tests', 'Other']
const COLLAPSE_KEY = 'forge.scripts.collapsed'

export function ScriptsView() {
  const { state, actions } = useStore()
  const menu = useMenu()
  const [filter, setFilter] = useState('')
  const [realm, setRealm] = useState<'all' | ScriptEntry['realm']>('all')
  const [collapsed, setCollapsed] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY) ?? '[]') as string[])
    } catch {
      return new Set()
    }
  })
  const q = filter.trim().toLowerCase()
  const places = state.places.length > 1

  const groups = useMemo(() => {
    const byCat = new Map(state.scripts.map((g) => [g.category, g.scripts]))
    return ORDER.map((category) => {
      const all = byCat.get(category) ?? []
      const scripts = all.filter((s) => (realm === 'all' || s.realm === realm) && (!q || s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) || (s.feature ?? '').toLowerCase().includes(q)))
      return { category, scripts, total: all.length }
    }).filter((g) => g.scripts.length > 0)
  }, [state.scripts, q, realm])
  const total = scriptsFlat(state.scripts).length

  const toggle = (c: string) =>
    setCollapsed((cur) => {
      const n = new Set(cur)
      n.has(c) ? n.delete(c) : n.add(c)
      try {
        localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...n]))
      } catch {
        // ignore
      }
      return n
    })

  const onMenu = (e: MouseEvent, s: ScriptEntry) => {
    const p = robloxPaths(s.instancePath)
    const feature = featuresOf(scriptsFlat(state.scripts)).find((f) => f.shared === s.path || f.service === s.path || f.controller === s.path)
    const isSpec = /\.spec\.luau?$/.test(s.path)
    const items: MenuEntry[] = [
      { header: p.dot, mono: true },
      { label: 'Open', icon: <Icon name="file" />, onSelect: () => void actions.openFile(s.path) },
      { label: 'Reveal in game tree', icon: <Icon name="reveal" />, hint: keyHint('alt+mod+r'), onSelect: () => actions.revealInstance(s.instancePath) },
      'separator',
      { label: 'Copy Roblox path', icon: <Icon name="copy" />, onSelect: () => void actions.copy(p.dot) },
      { label: 'Copy as GetService', icon: <Icon name="code" />, onSelect: () => void actions.copy(p.service) },
      { label: 'Copy require(…)', icon: <Icon name="code" />, onSelect: () => void actions.copy(requireExpression(s.instancePath), 'require') },
      { label: 'Copy file path', icon: <Icon name="copy" />, onSelect: () => void actions.copy(s.path, 'file path') },
      'separator'
    ]
    if (isSpec) items.push({ label: 'Run this spec', icon: <Icon name="flask" />, onSelect: () => void actions.runTests({ scope: { kind: 'file', file: s.path } }) })
    else if (s.kind === 'ModuleScript') items.push({ label: 'Create spec', icon: <Icon name="flask" />, sub: 'Lune test next to this module', onSelect: () => void actions.createSpec(s.path) })
    if (feature) items.push({ label: `Rename Feature ${feature.name}…`, icon: <Icon name="pencil" />, onSelect: () => actions.openDialog({ kind: 'renameFeature', from: feature.name }) })
    items.push({ label: 'Ask Assistant about this', icon: <Icon name="at" />, onSelect: () => actions.ask(`\`${s.path}\` `) })
    menu.openAt(e, items)
  }

  return (
    <>
      <div className="panel-head">
        <span className="panel-title">Scripts</span>
        <span className="count" style={{ marginRight: 6 }}>{total}</span>
        <button className="icon-btn" title={`New ModuleScript (${keyHint('mod+n')})`} onClick={() => actions.requestCreate('ModuleScript')}>
          <Icon name="plus" size={14} />
        </button>
        <button className="icon-btn" title="Collapse all" onClick={() => setCollapsed(new Set(ORDER))}>
          <Icon name="collapse" size={14} />
        </button>
      </div>
      <label className="filter">
        <Icon name="search" size={12} />
        <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="filter scripts, paths, features" spellCheck={false} onKeyDown={(e) => e.key === 'Escape' && setFilter('')} />
      </label>
      <div className="seg side-seg">
        {(['all', 'server', 'client', 'shared'] as const).map((r) => (
          <button key={r} className={realm === r ? 'on' : ''} onClick={() => setRealm(r)}>{r}</button>
        ))}
      </div>
      <div className="panel-body">
        {!groups.length && (
          <div className="empty">
            <Icon name="script" />
            <span>{q || realm !== 'all' ? 'No scripts match.' : state.project ? 'No scripts found under src/.' : 'Open a project to list its scripts.'}</span>
          </div>
        )}
        {groups.map((g) => {
          const isCollapsed = !q && collapsed.has(g.category)
          return (
            <section key={g.category}>
              <button className="ghead" onClick={() => toggle(g.category)}>
                <Icon name={isCollapsed ? 'chev' : 'chevDown'} size={12} />
                <span className="grow">{g.category}</span>
                <span className="count">{q || realm !== 'all' ? `${g.scripts.length}/${g.total}` : g.total}</span>
              </button>
              {!isCollapsed &&
                g.scripts.map((s) => (
                  <div
                    key={s.path}
                    className={`trow${state.activeFile === s.path ? ' active sel' : ''}`}
                    style={{ paddingLeft: 22 }}
                    onClick={() => void actions.openFile(s.path, { preview: true })}
                    onDoubleClick={() => void actions.openFile(s.path)}
                    onContextMenu={(e) => onMenu(e, s)}
                    title={`${s.path}\n${robloxPaths(s.instancePath).dot}`}
                  >
                    <ClassIcon className={s.kind} realm={s.realm} size={15} />
                    <span className="tname">{s.name}</span>
                    {s.feature && !s.name.includes(s.feature) && <span className="faint ellipsis" style={{ fontSize: 11 }}>{s.feature}</span>}
                    {places && s.places && s.places.length < state.places.length && <span className="tag" title={s.places.join(', ')}>{s.places.map((p) => p.replace('.project.json', '')).join(',')}</span>}
                    <span className={`tag ${s.realm}`}>{s.realm}</span>
                    <button
                      className="row-act"
                      title="Copy Roblox path"
                      onClick={(e) => {
                        e.stopPropagation()
                        void actions.copy(robloxPaths(s.instancePath).dot)
                      }}
                    >
                      <Icon name="copy" size={12} />
                    </button>
                  </div>
                ))}
            </section>
          )
        })}
      </div>
      {menu.node}
    </>
  )
}
