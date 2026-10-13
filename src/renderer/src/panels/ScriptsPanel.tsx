import { useCallback, useMemo, useState, type MouseEvent } from 'react'
import type { ScriptCategory, ScriptEntry } from '@shared/types'
import { robloxPaths } from '@shared/robloxPath'
import { useStore } from '../store'
import { ClassIcon } from '../components/ClassIcon'
import { IconChevron, IconCopy } from '../components/Icons'
import { Menu, type MenuEntry } from '../components/Menu'
import { copyPaths, pathMenu, type PathTarget } from '../components/pathActions'
import { FilterBox, useCopyShortcut } from './common'

const ORDER: ScriptCategory[] = ['Configs', 'Data', 'Services', 'Handlers', 'Controllers', 'Skills', 'Modules', 'Protocols', 'Events', 'UI', 'Stories', 'Entry points', 'Tests', 'Other']

const toTarget = (s: ScriptEntry): PathTarget => ({ name: s.name, className: s.kind, instancePath: s.instancePath, filePath: s.path })

export function ScriptsPanel() {
  const { state, actions } = useStore()
  const [filter, setFilter] = useState('')
  const [collapsed, setCollapsed] = useState<Set<ScriptCategory>>(new Set())
  const [selected, setSelected] = useState<string[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const q = filter.trim().toLowerCase()

  const groups = useMemo(() => {
    const byCat = new Map(state.scripts.map((g) => [g.category, g.scripts]))
    return ORDER.map((category) => {
      const all = byCat.get(category) ?? []
      const scripts = q
        ? all.filter((s) => s.name.toLowerCase().includes(q) || s.path.toLowerCase().includes(q) || (s.feature ?? '').toLowerCase().includes(q))
        : all
      return { category, scripts, total: all.length }
    }).filter((g) => g.scripts.length > 0)
  }, [state.scripts, q])

  const all = useMemo(() => groups.flatMap((g) => g.scripts), [groups])
  const selection = useMemo(() => all.filter((s) => selected.includes(s.path)).map(toTarget), [all, selected])
  useCopyShortcut(selection)
  const closeMenu = useCallback(() => setMenu(null), [])

  const onClick = (e: MouseEvent, s: ScriptEntry) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((cur) => (cur.includes(s.path) ? cur.filter((p) => p !== s.path) : [...cur, s.path]))
      return
    }
    setSelected([s.path])
    void actions.openFile(s.path)
  }

  const onContext = (e: MouseEvent, s: ScriptEntry) => {
    e.preventDefault()
    let sel = selection
    if (!selected.includes(s.path)) {
      setSelected([s.path])
      sel = [toTarget(s)]
    }
    setMenu({ x: e.clientX, y: e.clientY, items: pathMenu(actions, toTarget(s), sel) })
  }

  return (
    <div className="panel">
      <div className="panel-head">
        <FilterBox value={filter} onChange={setFilter} placeholder="Filter scripts" />
      </div>
      <div className="groups">
        {groups.length === 0 && <div className="side-empty">{q ? 'No matching scripts' : 'No scripts found'}</div>}
        {groups.map((g) => {
          const isCollapsed = !q && collapsed.has(g.category)
          return (
            <section key={g.category} className="group">
              <button
                className="group-head"
                onClick={() =>
                  setCollapsed((c) => {
                    const n = new Set(c)
                    if (n.has(g.category)) n.delete(g.category)
                    else n.add(g.category)
                    return n
                  })
                }
              >
                <span className={`twisty${isCollapsed ? '' : ' open'}`}>
                  <IconChevron size={12} />
                </span>
                <span className="group-name">{g.category}</span>
                <span className="count">{q ? `${g.scripts.length}/${g.total}` : g.total}</span>
              </button>
              {!isCollapsed &&
                g.scripts.map((s) => {
                  const isSel = selected.includes(s.path)
                  return (
                    <div
                      key={s.path}
                      className={`script-row${isSel ? ' selected' : ''}${state.activeFile === s.path ? ' active' : ''}`}
                      onClick={(e) => onClick(e, s)}
                      onContextMenu={(e) => onContext(e, s)}
                      title={`${s.path}\n${robloxPaths(s.instancePath).dot}`}
                    >
                      <ClassIcon className={s.kind} />
                      <span className="script-name">{s.name}</span>
                      {s.feature && !s.name.includes(s.feature) && <span className="feature-tag">{s.feature}</span>}
                      <span className={`realm realm-${s.realm}`}>{s.realm}</span>
                      <button
                        className="row-copy"
                        title="Copy Roblox path"
                        onClick={(e) => {
                          e.stopPropagation()
                          copyPaths(actions, [toTarget(s)])
                        }}
                      >
                        <IconCopy size={13} />
                      </button>
                    </div>
                  )
                })}
            </section>
          )
        })}
      </div>
      {selected.length > 1 && (
        <div className="selection-bar">
          <span>{selected.length} selected</span>
          <button className="btn small" onClick={() => copyPaths(actions, selection)}>
            <IconCopy size={13} /> Copy paths
          </button>
          <button className="btn small ghost" onClick={() => setSelected([])}>Clear</button>
        </div>
      )}
      {menu && <Menu x={menu.x} y={menu.y} items={menu.items} onClose={closeMenu} />}
    </div>
  )
}
