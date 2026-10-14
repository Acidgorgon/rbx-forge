// Editor groups (split editor): which tabs each group holds and how the groups tile the editor area.
// A layout is a tree: leaves are groups, split nodes lay their children out side by side ('row') or
// stacked ('col') with fractional sizes. Every operation returns a new state; a group that loses its
// last tab collapses (its space goes to the neighbour), except the last group, which stays (empty).
// Pure, no DOM (tested in test/editorGroups.test.ts).

export const MAX_GROUPS = 4
// Smallest share a group may be resized to (of its split).
export const MIN_SIZE = 0.08

export type Edge = 'left' | 'right' | 'top' | 'bottom'
export type SplitDir = 'row' | 'col'

export interface EditorGroup {
  id: string
  // Tab ids, in strip order. A file tab id may appear in several groups (same file, own view);
  // page tabs (labs, settings…) are kept in one group at a time by the store.
  tabs: string[]
  active: string | null
}

export type LayoutNode = { type: 'group'; id: string } | { type: 'split'; dir: SplitDir; children: LayoutNode[]; sizes: number[] }

export interface GroupsState {
  groups: EditorGroup[]
  root: LayoutNode
  activeGroup: string
}

// ---------------------------------------------------------------- reading

export function initialGroups(tabs: string[] = [], active: string | null = tabs[0] ?? null): GroupsState {
  return { groups: [{ id: 'g1', tabs: [...tabs], active: active && tabs.includes(active) ? active : tabs[0] ?? null }], root: { type: 'group', id: 'g1' }, activeGroup: 'g1' }
}

// Group ids in reading order (left to right, top to bottom through the tree).
export function groupOrder(gs: GroupsState): string[] {
  const out: string[] = []
  const walk = (n: LayoutNode) => (n.type === 'group' ? out.push(n.id) : n.children.forEach(walk))
  walk(gs.root)
  return out
}

export function getGroup(gs: GroupsState, id: string): EditorGroup | undefined {
  return gs.groups.find((g) => g.id === id)
}

export function activeGroupOf(gs: GroupsState): EditorGroup {
  return getGroup(gs, gs.activeGroup) ?? gs.groups[0]
}

export function activeTabOf(gs: GroupsState): string | null {
  return activeGroupOf(gs)?.active ?? null
}

export function groupsWithTab(gs: GroupsState, tabId: string): string[] {
  return groupOrder(gs).filter((id) => getGroup(gs, id)?.tabs.includes(tabId))
}

// Every tab id once, in group reading order.
export function allTabIds(gs: GroupsState): string[] {
  const seen = new Set<string>()
  for (const id of groupOrder(gs)) for (const t of getGroup(gs, id)?.tabs ?? []) seen.add(t)
  return [...seen]
}

// The group after `id` in reading order (wrapping), or null with a single group.
export function otherGroup(gs: GroupsState, id: string): string | null {
  const order = groupOrder(gs)
  if (order.length < 2) return null
  const i = order.indexOf(id)
  return order[(i + 1) % order.length]
}

// ---------------------------------------------------------------- small helpers

function nextGroupId(gs: GroupsState): string {
  for (let n = 1; ; n++) if (!gs.groups.some((g) => g.id === `g${n}`)) return `g${n}`
}

function setGroup(gs: GroupsState, group: EditorGroup): GroupsState {
  return { ...gs, groups: gs.groups.map((g) => (g.id === group.id ? group : g)) }
}

function clampIndex(i: number | undefined, len: number): number {
  if (i === undefined || !Number.isFinite(i)) return len
  return Math.max(0, Math.min(len, Math.floor(i)))
}

// The neighbour that becomes active when `tabs[idx]` leaves (the tab to its right, else its left).
function neighbourAfterRemoval(tabs: string[], idx: number): string | null {
  const rest = tabs.filter((_, i) => i !== idx)
  return rest[idx] ?? rest[idx - 1] ?? null
}

function normalize(sizes: number[]): number[] {
  const clean = sizes.map((s) => (Number.isFinite(s) && s > 0 ? s : 0))
  const sum = clean.reduce((a, b) => a + b, 0)
  if (sum <= 0) return sizes.map(() => 1 / sizes.length)
  return clean.map((s) => s / sum)
}

// ---------------------------------------------------------------- tree edits

// Removes the leaf for `id`; a split left with one child is replaced by that child, and a child split
// running the same way as its new parent is merged into it. The removed share goes to the neighbour.
function removeLeaf(node: LayoutNode, id: string): LayoutNode | null {
  if (node.type === 'group') return node.id === id ? null : node
  const shares = node.sizes.slice()
  const children: LayoutNode[] = []
  const sizes: number[] = []
  for (let i = 0; i < node.children.length; i++) {
    const next = removeLeaf(node.children[i], id)
    if (next) {
      children.push(next)
      sizes.push(shares[i])
    } else if (sizes.length) sizes[sizes.length - 1] += shares[i]
    // Give the share to the previous survivor, or to the next child.
    else if (i + 1 < shares.length) shares[i + 1] += shares[i]
  }
  if (!children.length) return null
  if (children.length === 1) return children[0]
  return flatten({ type: 'split', dir: node.dir, children, sizes: normalize(sizes) })
}

function flatten(node: LayoutNode): LayoutNode {
  if (node.type === 'group') return node
  const children: LayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((c, i) => {
    if (c.type === 'split' && c.dir === node.dir) {
      c.children.forEach((cc, j) => {
        children.push(cc)
        sizes.push(node.sizes[i] * c.sizes[j])
      })
    } else {
      children.push(c)
      sizes.push(node.sizes[i])
    }
  })
  return { ...node, children, sizes: normalize(sizes) }
}

// Puts leaf `add` next to leaf `target` on `edge`. A split running the same way gains a child (the
// target's share is halved between the two); otherwise the target becomes a two-way split.
function insertLeaf(node: LayoutNode, target: string, edge: Edge, add: string): LayoutNode {
  const dir: SplitDir = edge === 'left' || edge === 'right' ? 'row' : 'col'
  const after = edge === 'right' || edge === 'bottom'
  const leaf: LayoutNode = { type: 'group', id: add }
  if (node.type === 'group') {
    if (node.id !== target) return node
    return { type: 'split', dir, children: after ? [node, leaf] : [leaf, node], sizes: [0.5, 0.5] }
  }
  const i = node.children.findIndex((c) => c.type === 'group' && c.id === target)
  if (i >= 0 && node.dir === dir) {
    const half = node.sizes[i] / 2
    const children = node.children.slice()
    const sizes = node.sizes.slice()
    children.splice(after ? i + 1 : i, 0, leaf)
    sizes.splice(i, 1, half, half)
    return { ...node, children, sizes }
  }
  return { ...node, children: node.children.map((c) => insertLeaf(c, target, edge, add)) }
}

function dropGroup(gs: GroupsState, id: string): GroupsState {
  if (gs.groups.length <= 1) return gs
  const order = groupOrder(gs)
  const root = removeLeaf(gs.root, id) ?? { type: 'group', id: order.find((g) => g !== id)! }
  const groups = gs.groups.filter((g) => g.id !== id)
  let activeGroup = gs.activeGroup
  if (activeGroup === id) {
    const i = order.indexOf(id)
    activeGroup = order[i - 1] ?? order[i + 1] ?? groups[0].id
  }
  return { groups, root, activeGroup }
}

function collapseIfEmpty(gs: GroupsState, id: string): GroupsState {
  const g = getGroup(gs, id)
  return g && !g.tabs.length ? dropGroup(gs, id) : gs
}

// ---------------------------------------------------------------- operations

export function focusGroup(gs: GroupsState, id: string): GroupsState {
  return getGroup(gs, id) && gs.activeGroup !== id ? { ...gs, activeGroup: id } : gs
}

// Focus by position (Ctrl+1..4): index 0 is the first group in reading order.
export function focusGroupAt(gs: GroupsState, index: number): GroupsState {
  const id = groupOrder(gs)[index]
  return id ? focusGroup(gs, id) : gs
}

export function activateTab(gs: GroupsState, groupId: string, tabId: string): GroupsState {
  const g = getGroup(gs, groupId)
  if (!g || !g.tabs.includes(tabId)) return gs
  const next = g.active === tabId ? gs : setGroup(gs, { ...g, active: tabId })
  return focusGroup(next, groupId)
}

// Adds a tab to a group (default: the active one) right after its active tab, or at `index`, or in
// place of `replace` (preview tabs). Already there: activated (and moved when `index` is given).
export function openTab(gs: GroupsState, tabId: string, opts: { group?: string; index?: number; replace?: string } = {}): GroupsState {
  const gid = opts.group ?? gs.activeGroup
  const g = getGroup(gs, gid)
  if (!g) return gs
  let tabs = g.tabs
  if (tabs.includes(tabId)) {
    if (opts.index !== undefined) return moveTab(gs, tabId, gid, gid, opts.index)
    return activateTab(gs, gid, tabId)
  }
  const r = opts.replace ? tabs.indexOf(opts.replace) : -1
  if (r >= 0) tabs = tabs.map((t, i) => (i === r ? tabId : t))
  else {
    const at = opts.index !== undefined ? clampIndex(opts.index, tabs.length) : g.active && tabs.includes(g.active) ? tabs.indexOf(g.active) + 1 : tabs.length
    tabs = [...tabs.slice(0, at), tabId, ...tabs.slice(at)]
  }
  return { ...setGroup(gs, { ...g, tabs, active: tabId }), activeGroup: gid }
}

// Closes a tab in one group. A group left empty collapses unless it is the only one.
export function closeTab(gs: GroupsState, groupId: string, tabId: string): GroupsState {
  const g = getGroup(gs, groupId)
  if (!g) return gs
  const idx = g.tabs.indexOf(tabId)
  if (idx < 0) return gs
  const tabs = g.tabs.filter((t) => t !== tabId)
  const active = g.active === tabId || !g.active || !tabs.includes(g.active) ? neighbourAfterRemoval(g.tabs, idx) : g.active
  return collapseIfEmpty(setGroup(gs, { ...g, tabs, active }), groupId)
}

// Closes a tab in every group (file deleted, project switched…).
export function closeTabEverywhere(gs: GroupsState, tabId: string): GroupsState {
  let next = gs
  for (const id of groupsWithTab(gs, tabId)) next = closeTab(next, id, tabId)
  return next
}

// Keeps only the tabs `keep` accepts (collapsing groups left empty).
export function retainTabs(gs: GroupsState, keep: (tabId: string) => boolean): GroupsState {
  let next = gs
  for (const id of allTabIds(gs)) if (!keep(id)) next = closeTabEverywhere(next, id)
  return next
}

// Closes every tab of the group except `keepId` (and those `canClose` refuses, e.g. unsaved files).
export function closeOthers(gs: GroupsState, groupId: string, keepId: string, canClose: (tabId: string) => boolean = () => true): GroupsState {
  const g = getGroup(gs, groupId)
  if (!g) return gs
  let next = gs
  for (const t of g.tabs) if (t !== keepId && canClose(t)) next = closeTab(next, groupId, t)
  return activateTab(next, groupId, keepId)
}

// Moves a tab within a strip (reorder, from === to) or into another group at `index` (end when
// omitted). The source group collapses when it empties; the target group becomes active.
export function moveTab(gs: GroupsState, tabId: string, from: string, to: string, index?: number): GroupsState {
  const src = getGroup(gs, from)
  const dst = getGroup(gs, to)
  if (!src || !dst || !src.tabs.includes(tabId)) return gs
  if (from === to) {
    const cur = src.tabs.indexOf(tabId)
    const rest = src.tabs.filter((t) => t !== tabId)
    // `index` counts positions in the strip as it is shown (with the dragged tab still in it).
    let at = clampIndex(index, src.tabs.length)
    if (at > cur) at--
    const tabs = [...rest.slice(0, at), tabId, ...rest.slice(at)]
    return { ...setGroup(gs, { ...src, tabs, active: tabId }), activeGroup: from }
  }
  let next = gs
  const dstTabs = dst.tabs.filter((t) => t !== tabId)
  const at = clampIndex(index, dstTabs.length)
  next = setGroup(next, { ...dst, tabs: [...dstTabs.slice(0, at), tabId, ...dstTabs.slice(at)], active: tabId })
  next = { ...next, activeGroup: to }
  next = closeTab(next, from, tabId)
  return { ...next, activeGroup: to }
}

// Opens the same tab in another group too (a second view of one file).
export function copyTab(gs: GroupsState, tabId: string, to: string, index?: number): GroupsState {
  if (!getGroup(gs, to)) return gs
  return openTab(gs, tabId, { group: to, index: index ?? getGroup(gs, to)!.tabs.length })
}

export function canSplit(gs: GroupsState, opts: { from?: string; tabId?: string; copy?: boolean } = {}): boolean {
  if (gs.groups.length < MAX_GROUPS) return true
  // Moving the only tab out of a group frees that group.
  const src = opts.from ? getGroup(gs, opts.from) : undefined
  return !opts.copy && !!src && src.tabs.length === 1 && src.tabs[0] === opts.tabId
}

// Opens `tabId` in a new group on `edge` of group `target`. With `from` and no `copy` the tab moves
// out of `from` (which collapses if it empties). No-op past MAX_GROUPS.
export function splitGroup(gs: GroupsState, target: string, edge: Edge, tabId: string, opts: { from?: string; copy?: boolean } = {}): GroupsState {
  if (!getGroup(gs, target) || !canSplit(gs, { from: opts.from, tabId, copy: opts.copy })) return gs
  // Splitting a group's only tab off itself would just recreate it.
  if (opts.from === target && !opts.copy && getGroup(gs, target)!.tabs.length === 1) return gs
  const id = nextGroupId(gs)
  let next: GroupsState = { groups: [...gs.groups, { id, tabs: [tabId], active: tabId }], root: insertLeaf(gs.root, target, edge, id), activeGroup: id }
  if (opts.from && !opts.copy) next = closeTab(next, opts.from, tabId)
  return { ...next, activeGroup: id }
}

// Closes a whole group (its tabs go with it). The last group cannot be closed.
export function closeGroup(gs: GroupsState, id: string): GroupsState {
  return dropGroup(gs, id)
}

// All groups' tabs into the first group (in reading order), one group left.
export function joinAll(gs: GroupsState): GroupsState {
  const order = groupOrder(gs)
  const first = getGroup(gs, order[0])!
  const tabs = allTabIds(gs)
  const active = activeTabOf(gs) ?? first.active
  return { groups: [{ id: first.id, tabs, active }], root: { type: 'group', id: first.id }, activeGroup: first.id }
}

// A tab id changed (file renamed): every group follows; a group that held both keeps one.
export function renameTab(gs: GroupsState, from: string, to: string): GroupsState {
  if (from === to) return gs
  return {
    ...gs,
    groups: gs.groups.map((g) => {
      if (!g.tabs.includes(from)) return g
      const tabs: string[] = []
      for (const t of g.tabs) {
        const id = t === from ? to : t
        if (!tabs.includes(id)) tabs.push(id)
      }
      return { ...g, tabs, active: g.active === from ? to : g.active }
    })
  }
}

// Sets the sizes of the split at `path` (child indices from the root).
export function resizeSplit(gs: GroupsState, path: number[], sizes: number[]): GroupsState {
  const set = (node: LayoutNode, depth: number): LayoutNode => {
    if (node.type === 'group') return node
    if (depth === path.length) {
      if (sizes.length !== node.children.length) return node
      const n = normalize(sizes.map((s) => Math.max(MIN_SIZE, s)))
      return { ...node, sizes: n }
    }
    const i = path[depth]
    if (i < 0 || i >= node.children.length) return node
    return { ...node, children: node.children.map((c, j) => (j === i ? set(c, depth + 1) : c)) }
  }
  return { ...gs, root: set(gs.root, 0) }
}

// Moves the sash between children `index` and `index + 1` of the split at `path` by `delta` (a
// fraction of that split), keeping both sides at MIN_SIZE or more.
export function moveSash(gs: GroupsState, path: number[], index: number, delta: number): GroupsState {
  const node = nodeAt(gs.root, path)
  if (!node || node.type !== 'split' || index < 0 || index + 1 >= node.sizes.length) return gs
  const a = node.sizes[index]
  const b = node.sizes[index + 1]
  const d = Math.max(MIN_SIZE - a, Math.min(b - MIN_SIZE, delta))
  const sizes = node.sizes.slice()
  sizes[index] = a + d
  sizes[index + 1] = b - d
  return resizeSplit(gs, path, sizes)
}

export function nodeAt(root: LayoutNode, path: number[]): LayoutNode | null {
  let node: LayoutNode = root
  for (const i of path) {
    if (node.type !== 'split' || !node.children[i]) return null
    node = node.children[i]
  }
  return node
}

// ---------------------------------------------------------------- drop targets

export type DropZone = Edge | 'center'

// Where a drop at (x, y), as fractions of a group's body, lands: the nearest edge within `edgeBand`
// of it splits that way, anything else moves into the group.
export function dropZoneAt(x: number, y: number, edgeBand = 0.28): DropZone {
  const d: [DropZone, number][] = [
    ['left', x],
    ['right', 1 - x],
    ['top', y],
    ['bottom', 1 - y]
  ]
  d.sort((p, q) => p[1] - q[1])
  return d[0][1] <= edgeBand ? d[0][0] : 'center'
}

// ---------------------------------------------------------------- persistence

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v)

// A saved layout back into a valid state: unknown tabs dropped, emptied groups collapsed, the tree
// checked (each group exactly once, at most MAX_GROUPS, sizes matching). null when unusable.
export function sanitizeGroups(raw: unknown, validTab: (tabId: string) => boolean): GroupsState | null {
  if (!isObj(raw) || !Array.isArray(raw.groups) || !isObj(raw.root)) return null
  const groups: EditorGroup[] = []
  for (const g of raw.groups) {
    if (!isObj(g) || typeof g.id !== 'string' || !g.id || groups.some((x) => x.id === g.id)) continue
    const tabs: string[] = []
    for (const t of Array.isArray(g.tabs) ? g.tabs : []) if (typeof t === 'string' && validTab(t) && !tabs.includes(t)) tabs.push(t)
    const active = typeof g.active === 'string' && tabs.includes(g.active) ? g.active : tabs[0] ?? null
    groups.push({ id: g.id, tabs, active })
  }
  if (!groups.length || groups.length > MAX_GROUPS) return null
  const used = new Set<string>()
  const parse = (n: unknown, depth: number): LayoutNode | null => {
    if (!isObj(n) || depth > 8) return null
    if (n.type === 'group') {
      if (typeof n.id !== 'string' || used.has(n.id) || !groups.some((g) => g.id === n.id)) return null
      used.add(n.id)
      return { type: 'group', id: n.id }
    }
    if (n.type !== 'split' || (n.dir !== 'row' && n.dir !== 'col') || !Array.isArray(n.children) || n.children.length < 2) return null
    const children: LayoutNode[] = []
    for (const c of n.children) {
      const p = parse(c, depth + 1)
      if (!p) return null
      children.push(p)
    }
    const sizes = Array.isArray(n.sizes) && n.sizes.length === children.length && n.sizes.every((s) => typeof s === 'number' && Number.isFinite(s) && s > 0) ? normalize(n.sizes as number[]) : children.map(() => 1 / children.length)
    return { type: 'split', dir: n.dir, children, sizes }
  }
  const root = parse(raw.root, 0)
  if (!root || used.size !== groups.length) return null
  const activeGroup = typeof raw.activeGroup === 'string' && used.has(raw.activeGroup) ? raw.activeGroup : groupOrder({ groups, root, activeGroup: '' })[0]
  let gs: GroupsState = { groups, root: flatten(root), activeGroup }
  for (const g of groups) if (!g.tabs.length) gs = collapseIfEmpty(gs, g.id)
  return gs
}

// The plain JSON shape saved per project (same as the state; copied so callers can't alias it).
export function serializeGroups(gs: GroupsState): GroupsState {
  return JSON.parse(JSON.stringify(gs)) as GroupsState
}
