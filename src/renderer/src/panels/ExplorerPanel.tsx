import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react'
import type { TreeNode } from '@shared/types'
import { robloxPaths } from '@shared/robloxPath'
import { useStore } from '../store'
import { ClassIcon } from '../components/ClassIcon'
import { IconChevron, IconCopy } from '../components/Icons'
import { Menu, type MenuEntry } from '../components/Menu'
import { copyPaths, pathMenu, type PathTarget } from '../components/pathActions'
import { FilterBox, useCopyShortcut } from './common'

interface Row {
  key: string
  node: TreeNode
  depth: number
  instancePath: string[]
  hasChildren: boolean
  // Parent is Studio-only too (only the top of a Studio-only subtree gets the marker).
  parentStudio: boolean
}

// Skip a DataModel root if the backend sends one.
function roots(tree: TreeNode[]): TreeNode[] {
  if (tree.length === 1 && tree[0].className === 'DataModel') return tree[0].children
  return tree
}

function matches(node: TreeNode, q: string): boolean {
  if (node.name.toLowerCase().includes(q) || node.className.toLowerCase().includes(q)) return true
  return node.children.some((c) => matches(c, q))
}

const DEFAULT_OPEN = new Set(['ReplicatedStorage', 'ReplicatedStorage/Shared', 'ServerScriptService', 'ServerScriptService/Server', 'StarterPlayer', 'StarterPlayer/StarterPlayerScripts'])

export function ExplorerPanel() {
  const { state, actions } = useStore()
  const [filter, setFilter] = useState('')
  const [open, setOpen] = useState<Set<string>>(DEFAULT_OPEN)
  const [selected, setSelected] = useState<string[]>([])
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuEntry[] } | null>(null)
  const q = filter.trim().toLowerCase()

  const rows = useMemo(() => {
    const out: Row[] = []
    const walk = (nodes: TreeNode[], depth: number, parent: string[], parentStudio = false) => {
      nodes.forEach((node) => {
        if (q && !matches(node, q)) return
        const instancePath = [...parent, node.name]
        const key = instancePath.join('/')
        const hasChildren = node.children.length > 0
        out.push({ key, node, depth, instancePath, hasChildren, parentStudio })
        if (hasChildren && (q ? true : open.has(key))) walk(node.children, depth + 1, instancePath, node.origin === 'studio')
      })
    }
    walk(roots(state.tree), 0, [])
    return out
  }, [state.tree, open, q])

  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows])
  const toTarget = (r: Row): PathTarget => ({ name: r.node.name, className: r.node.className, instancePath: r.instancePath, filePath: r.node.filePath })
  const selection = useMemo(() => selected.map((k) => byKey.get(k)).filter((r): r is Row => !!r).map(toTarget), [selected, byKey])

  useCopyShortcut(selection)

  const toggle = (key: string) =>
    setOpen((s) => {
      const n = new Set(s)
      if (n.has(key)) n.delete(key)
      else n.add(key)
      return n
    })

  const onRowClick = (e: MouseEvent, r: Row) => {
    if (e.metaKey || e.ctrlKey) {
      setSelected((s) => (s.includes(r.key) ? s.filter((k) => k !== r.key) : [...s, r.key]))
      return
    }
    if (e.shiftKey && selected.length) {
      const a = rows.findIndex((x) => x.key === selected[selected.length - 1])
      const b = rows.findIndex((x) => x.key === r.key)
      const [lo, hi] = a < b ? [a, b] : [b, a]
      setSelected(rows.slice(lo, hi + 1).map((x) => x.key))
      return
    }
    setSelected([r.key])
    if (r.node.filePath) void actions.openFile(r.node.filePath)
    else if (r.hasChildren) toggle(r.key)
  }

  const onContext = (e: MouseEvent, r: Row) => {
    e.preventDefault()
    let sel = selection
    if (!selected.includes(r.key)) {
      setSelected([r.key])
      sel = [toTarget(r)]
    }
    setMenu({ x: e.clientX, y: e.clientY, items: pathMenu(actions, toTarget(r), sel) })
  }

  const closeMenu = useCallback(() => setMenu(null), [])

  useEffect(() => {
    if (q) return
    setSelected((s) => s.filter((k) => byKey.has(k)))
  }, [byKey, q])

  const studioCount = useMemo(() => {
    let n = 0
    const walk = (ns: TreeNode[]) => ns.forEach((x) => {
      if (x.origin === 'studio') n++
      walk(x.children)
    })
    walk(state.tree)
    return n
  }, [state.tree])

  return (
    <div className="panel">
      <div className="panel-head">
        <FilterBox value={filter} onChange={setFilter} placeholder="Filter instances" />
      </div>
      <div className="tree-legend" title={'Repo: defined by files under src/ (Rojo).\nStudio: only in the live Studio place (assets, maps, UI built in Studio).\nRight-click any row for copy actions.'}>
        <span><i className="legend-dot both" />Repo</span>
        <span><i className="legend-dot studio" />Studio only{studioCount ? ` · ${studioCount}` : ''}</span>
        <span className="legend-hint">Right-click to copy paths</span>
      </div>
      <div className="tree" role="tree" aria-multiselectable>
        {rows.length === 0 && <div className="side-empty">{q ? 'No matches' : 'No instances yet'}</div>}
        {rows.map((r) => {
          const isOpen = q ? true : open.has(r.key)
          const isSel = selected.includes(r.key)
          const isActive = !!r.node.filePath && r.node.filePath === state.activeFile
          const origin = r.node.origin ?? 'repo'
          return (
            <div
              key={r.key}
              role="treeitem"
              aria-selected={isSel}
              aria-expanded={r.hasChildren ? isOpen : undefined}
              className={`tree-row${isSel ? ' selected' : ''}${isActive ? ' active' : ''}${origin === 'studio' ? ' studio' : ''}`}
              style={{ paddingLeft: 6 + r.depth * 14 }}
              onClick={(e) => onRowClick(e, r)}
              onContextMenu={(e) => onContext(e, r)}
              title={`${robloxPaths(r.instancePath).dot}\n${r.node.className}${r.node.filePath ? `\n${r.node.filePath}` : ''}${origin === 'studio' ? '\nStudio only (not in the repo)' : ''}`}
            >
              <span
                className={`twisty${r.hasChildren ? '' : ' none'}${isOpen ? ' open' : ''}`}
                onClick={(e) => {
                  e.stopPropagation()
                  if (r.hasChildren) toggle(r.key)
                }}
              >
                {r.hasChildren && <IconChevron size={12} />}
              </span>
              <ClassIcon className={r.node.className} />
              <span className="tree-name">{r.node.name}</span>
              {origin === 'studio' && !r.parentStudio && <span className="origin-tag">Studio</span>}
              <button
                className="row-copy"
                title="Copy Roblox path"
                onClick={(e) => {
                  e.stopPropagation()
                  copyPaths(actions, [toTarget(r)])
                }}
              >
                <IconCopy size={13} />
              </button>
            </div>
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
