import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  MAX_GROUPS,
  activateTab,
  activeTabOf,
  allTabIds,
  canSplit,
  closeGroup,
  closeOthers,
  closeTab,
  closeTabEverywhere,
  copyTab,
  dropZoneAt,
  focusGroupAt,
  groupOrder,
  groupsWithTab,
  initialGroups,
  joinAll,
  moveSash,
  moveTab,
  openTab,
  otherGroup,
  renameTab,
  retainTabs,
  sanitizeGroups,
  serializeGroups,
  splitGroup,
  type GroupsState,
  type LayoutNode
} from '../src/shared/editorGroups.ts'
import { parseSession, serializeSession, emptySession } from '../src/shared/qol/session.ts'

const tabsOf = (gs: GroupsState, id: string) => gs.groups.find((g) => g.id === id)!.tabs
const shape = (n: LayoutNode): unknown => (n.type === 'group' ? n.id : { [n.dir]: n.children.map(shape) })
const near = (a: number[], b: number[]) => assert.ok(a.length === b.length && a.every((x, i) => Math.abs(x - b[i]) < 1e-9), `${a} != ${b}`)

test('groups: open adds after the active tab, reopening activates', () => {
  let gs = initialGroups(['forge'])
  gs = openTab(gs, 'file:a')
  gs = openTab(gs, 'file:b')
  gs = activateTab(gs, 'g1', 'file:a')
  gs = openTab(gs, 'file:c')
  assert.deepEqual(tabsOf(gs, 'g1'), ['forge', 'file:a', 'file:c', 'file:b'])
  gs = openTab(gs, 'file:b')
  assert.equal(activeTabOf(gs), 'file:b')
  assert.deepEqual(tabsOf(gs, 'g1'), ['forge', 'file:a', 'file:c', 'file:b'])
  // Preview replacement keeps the slot.
  gs = openTab(gs, 'file:d', { replace: 'file:c' })
  assert.deepEqual(tabsOf(gs, 'g1'), ['forge', 'file:a', 'file:d', 'file:b'])
})

test('groups: split right moves a tab into a new group; copy keeps it in both', () => {
  let gs = initialGroups(['file:a', 'file:b'], 'file:b')
  gs = splitGroup(gs, 'g1', 'right', 'file:b', { from: 'g1' })
  assert.deepEqual(shape(gs.root), { row: ['g1', 'g2'] })
  assert.deepEqual(tabsOf(gs, 'g1'), ['file:a'])
  assert.deepEqual(tabsOf(gs, 'g2'), ['file:b'])
  assert.equal(gs.activeGroup, 'g2')
  assert.equal(activeTabOf(gs), 'file:b')
  gs = splitGroup(gs, 'g2', 'bottom', 'file:b', { from: 'g2', copy: true })
  assert.deepEqual(shape(gs.root), { row: ['g1', { col: ['g2', 'g3'] }] })
  assert.deepEqual(groupsWithTab(gs, 'file:b'), ['g2', 'g3'])
  assert.deepEqual(allTabIds(gs), ['file:a', 'file:b'])
})

test('groups: same-direction splits share one split node, halving the target', () => {
  let gs = initialGroups(['a', 'b', 'c'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = splitGroup(gs, 'g1', 'right', 'c', { from: 'g1' })
  assert.deepEqual(shape(gs.root), { row: ['g1', 'g3', 'g2'] })
  assert.equal(gs.root.type, 'split')
  if (gs.root.type === 'split') near(gs.root.sizes, [0.25, 0.25, 0.5])
  // Left / top insert before the target.
  let t = initialGroups(['a', 'b'])
  t = splitGroup(t, 'g1', 'left', 'b', { from: 'g1' })
  assert.deepEqual(groupOrder(t), ['g2', 'g1'])
  t = splitGroup(t, 'g1', 'top', 'a', { from: 'g1', copy: true })
  assert.deepEqual(shape(t.root), { row: ['g2', { col: ['g3', 'g1'] }] })
})

test('groups: at most four groups, except when moving a group\'s only tab', () => {
  let gs = initialGroups(['a', 'b', 'c', 'd', 'e'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = splitGroup(gs, 'g2', 'right', 'c', { from: 'g1' })
  gs = splitGroup(gs, 'g3', 'bottom', 'd', { from: 'g1' })
  assert.equal(gs.groups.length, MAX_GROUPS)
  assert.equal(canSplit(gs, { from: 'g1', tabId: 'e' }), false)
  const same = splitGroup(gs, 'g1', 'bottom', 'e', { from: 'g1' })
  assert.equal(same, gs)
  // g4 has one tab: moving it elsewhere frees its slot.
  assert.equal(canSplit(gs, { from: 'g4', tabId: 'd' }), true)
  const moved = splitGroup(gs, 'g1', 'bottom', 'd', { from: 'g4' })
  assert.equal(moved.groups.length, MAX_GROUPS)
  assert.deepEqual(groupsWithTab(moved, 'd').length, 1)
  assert.equal(canSplit(gs, { from: 'g4', tabId: 'd', copy: true }), false)
})

test('groups: splitting a group\'s only tab off itself does nothing', () => {
  const gs = initialGroups(['a'])
  assert.equal(splitGroup(gs, 'g1', 'right', 'a', { from: 'g1' }), gs)
  assert.equal(splitGroup(gs, 'g1', 'right', 'a', { from: 'g1', copy: true }).groups.length, 2)
})

test('groups: closing the last tab of a group collapses it; the last group stays', () => {
  let gs = initialGroups(['a', 'b', 'c'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = splitGroup(gs, 'g2', 'bottom', 'c', { from: 'g1' })
  assert.deepEqual(shape(gs.root), { row: ['g1', { col: ['g2', 'g3'] }] })
  gs = closeTab(gs, 'g2', 'b')
  // The column split with one child left is replaced by that child.
  assert.deepEqual(shape(gs.root), { row: ['g1', 'g3'] })
  assert.equal(gs.groups.length, 2)
  gs = closeTab(gs, 'g3', 'c')
  assert.deepEqual(shape(gs.root), 'g1')
  assert.equal(gs.activeGroup, 'g1')
  gs = closeTab(gs, 'g1', 'a')
  assert.equal(gs.groups.length, 1)
  assert.deepEqual(tabsOf(gs, 'g1'), [])
  assert.equal(activeTabOf(gs), null)
})

test('groups: collapsing merges a same-direction child split into its parent', () => {
  let gs = initialGroups(['a', 'b', 'c', 'd'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' }) // row [g1 g2]
  gs = splitGroup(gs, 'g2', 'bottom', 'c', { from: 'g1' }) // row [g1 col[g2 g3]]
  gs = splitGroup(gs, 'g3', 'right', 'd', { from: 'g1' }) // row [g1 col[g2 row[g3 g4]]]
  assert.deepEqual(shape(gs.root), { row: ['g1', { col: ['g2', { row: ['g3', 'g4'] }] }] })
  gs = closeTab(gs, 'g2', 'b')
  assert.deepEqual(shape(gs.root), { row: ['g1', 'g3', 'g4'] })
  if (gs.root.type === 'split') near(gs.root.sizes, [0.5, 0.25, 0.25])
})

test('groups: closing the active tab activates its right neighbour, else the left one', () => {
  let gs = initialGroups(['a', 'b', 'c'], 'b')
  gs = closeTab(gs, 'g1', 'b')
  assert.equal(activeTabOf(gs), 'c')
  gs = closeTab(gs, 'g1', 'c')
  assert.equal(activeTabOf(gs), 'a')
  // Closing an inactive tab keeps the active one.
  let h = initialGroups(['a', 'b', 'c'], 'c')
  h = closeTab(h, 'g1', 'a')
  assert.equal(activeTabOf(h), 'c')
})

test('groups: closing an active group hands focus to its neighbour', () => {
  let gs = initialGroups(['a', 'b', 'c'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = splitGroup(gs, 'g2', 'right', 'c', { from: 'g1' })
  assert.deepEqual(groupOrder(gs), ['g1', 'g2', 'g3'])
  gs = focusGroupAt(gs, 1)
  gs = closeGroup(gs, 'g2')
  assert.deepEqual(groupOrder(gs), ['g1', 'g3'])
  assert.equal(gs.activeGroup, 'g1')
  assert.equal(closeGroup(initialGroups(['a']), 'g1').groups.length, 1)
})

test('groups: reorder within a strip uses shown positions', () => {
  let gs = initialGroups(['a', 'b', 'c', 'd'])
  gs = moveTab(gs, 'a', 'g1', 'g1', 3) // drop before d
  assert.deepEqual(tabsOf(gs, 'g1'), ['b', 'c', 'a', 'd'])
  gs = moveTab(gs, 'd', 'g1', 'g1', 0)
  assert.deepEqual(tabsOf(gs, 'g1'), ['d', 'b', 'c', 'a'])
  gs = moveTab(gs, 'b', 'g1', 'g1', 99)
  assert.deepEqual(tabsOf(gs, 'g1'), ['d', 'c', 'a', 'b'])
  assert.equal(activeTabOf(gs), 'b')
})

test('groups: move to another group at an index; source collapses when emptied', () => {
  let gs = initialGroups(['a', 'b'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = openTab(gs, 'c', { group: 'g2' })
  gs = moveTab(gs, 'a', 'g1', 'g2', 1)
  assert.deepEqual(shape(gs.root), 'g2')
  assert.deepEqual(tabsOf(gs, 'g2'), ['b', 'a', 'c'])
  assert.equal(gs.activeGroup, 'g2')
  assert.equal(activeTabOf(gs), 'a')
  // A file already open in the target is not duplicated.
  let h = initialGroups(['x', 'y'])
  h = splitGroup(h, 'g1', 'right', 'x', { from: 'g1', copy: true })
  h = moveTab(h, 'x', 'g1', 'g2', 0)
  assert.deepEqual(tabsOf(h, 'g2'), ['x'])
  assert.deepEqual(tabsOf(h, 'g1'), ['y'])
})

test('groups: copy, close everywhere, retain, close others', () => {
  let gs = initialGroups(['a', 'b', 'c'])
  gs = splitGroup(gs, 'g1', 'right', 'c', { from: 'g1' })
  gs = copyTab(gs, 'a', 'g2')
  assert.deepEqual(tabsOf(gs, 'g2'), ['c', 'a'])
  gs = closeTabEverywhere(gs, 'a')
  assert.deepEqual(allTabIds(gs), ['b', 'c'])
  const kept = retainTabs(gs, (t) => t !== 'c')
  assert.deepEqual(shape(kept.root), 'g1')
  let h = initialGroups(['a', 'b', 'c', 'd'])
  h = closeOthers(h, 'g1', 'c', (t) => t !== 'a')
  assert.deepEqual(tabsOf(h, 'g1'), ['a', 'c'])
  assert.equal(activeTabOf(h), 'c')
})

test('groups: other group wraps in reading order; join all', () => {
  let gs = initialGroups(['a', 'b', 'c'])
  assert.equal(otherGroup(gs, 'g1'), null)
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = splitGroup(gs, 'g1', 'bottom', 'c', { from: 'g1', copy: true })
  assert.deepEqual(groupOrder(gs), ['g1', 'g3', 'g2'])
  assert.equal(otherGroup(gs, 'g1'), 'g3')
  assert.equal(otherGroup(gs, 'g2'), 'g1')
  const one = joinAll(gs)
  assert.equal(one.groups.length, 1)
  assert.deepEqual(tabsOf(one, 'g1'), ['a', 'c', 'b'])
  assert.equal(activeTabOf(one), activeTabOf(gs))
})

test('groups: rename follows into every group without duplicates', () => {
  let gs = initialGroups(['file:a', 'file:b'], 'file:a')
  gs = splitGroup(gs, 'g1', 'right', 'file:a', { from: 'g1', copy: true })
  gs = renameTab(gs, 'file:a', 'file:z')
  assert.deepEqual(tabsOf(gs, 'g1'), ['file:z', 'file:b'])
  assert.deepEqual(tabsOf(gs, 'g2'), ['file:z'])
  assert.equal(activeTabOf(gs), 'file:z')
  const h = renameTab(initialGroups(['file:a', 'file:z']), 'file:a', 'file:z')
  assert.deepEqual(tabsOf(h, 'g1'), ['file:z'])
})

test('groups: sash moves keep both sides at the minimum', () => {
  let gs = initialGroups(['a', 'b'])
  gs = splitGroup(gs, 'g1', 'right', 'b', { from: 'g1' })
  gs = moveSash(gs, [], 0, 0.2)
  if (gs.root.type === 'split') near(gs.root.sizes, [0.7, 0.3])
  gs = moveSash(gs, [], 0, 5)
  if (gs.root.type === 'split') near(gs.root.sizes, [0.92, 0.08])
  assert.equal(moveSash(gs, [3], 0, 0.1), gs)
})

test('groups: drop zones pick the nearest edge band, else the centre', () => {
  assert.equal(dropZoneAt(0.1, 0.5), 'left')
  assert.equal(dropZoneAt(0.9, 0.4), 'right')
  assert.equal(dropZoneAt(0.5, 0.05), 'top')
  assert.equal(dropZoneAt(0.4, 0.95), 'bottom')
  assert.equal(dropZoneAt(0.5, 0.5), 'center')
  assert.equal(dropZoneAt(0.05, 0.02), 'top')
})

test('groups: saved layouts round-trip and bad ones are rejected or repaired', () => {
  let gs = initialGroups(['forge', 'file:a', 'file:b'])
  gs = splitGroup(gs, 'g1', 'right', 'file:b', { from: 'g1' })
  gs = splitGroup(gs, 'g2', 'bottom', 'file:a', { from: 'g1', copy: true })
  const saved = JSON.parse(JSON.stringify(serializeGroups(gs)))
  assert.deepEqual(sanitizeGroups(saved, () => true), gs)
  // A tab that no longer exists drops out; a group left empty collapses.
  const without = sanitizeGroups(saved, (t) => t !== 'file:b')!
  assert.deepEqual(shape(without.root), { row: ['g1', 'g3'] })
  // Broken trees: a group twice, a missing group, too many groups, junk.
  assert.equal(sanitizeGroups({ ...saved, root: { type: 'split', dir: 'row', children: [{ type: 'group', id: 'g1' }, { type: 'group', id: 'g1' }], sizes: [1, 1] } }, () => true), null)
  assert.equal(sanitizeGroups({ ...saved, root: { type: 'group', id: 'g1' } }, () => true), null)
  assert.equal(sanitizeGroups({ groups: [1, 2, 3, 4, 5].map((n) => ({ id: `g${n}`, tabs: [] })), root: { type: 'group', id: 'g1' } }, () => true), null)
  assert.equal(sanitizeGroups('nope', () => true), null)
  // Bad sizes are evened out; an unknown active group falls back to the first.
  const fixed = sanitizeGroups({ groups: [{ id: 'g1', tabs: ['a'] }, { id: 'g2', tabs: ['b'], active: 'zz' }], root: { type: 'split', dir: 'row', children: [{ type: 'group', id: 'g1' }, { type: 'group', id: 'g2' }], sizes: [-1, 'x'] }, activeGroup: 'g9' }, () => true)!
  assert.equal(fixed.activeGroup, 'g1')
  assert.equal(fixed.groups[1].active, 'b')
  if (fixed.root.type === 'split') near(fixed.root.sizes, [0.5, 0.5])
})

test('groups: the session file keeps a project\'s layout and drops tabs it no longer has', () => {
  let gs = initialGroups(['forge', 'file:a', 'file:b'])
  gs = splitGroup(gs, 'g1', 'right', 'file:b', { from: 'g1' })
  const state = emptySession()
  state.projects['/p'] = { tabs: [{ id: 'forge', kind: 'forge', title: 'Forge' }, { id: 'file:a', kind: 'file', title: 'a', path: 'a' }, { id: 'file:b', kind: 'file', title: 'b', path: 'b' }], activeTab: 'file:b', groups: serializeGroups(gs), cursors: {}, labs: {}, savedAt: 1 }
  assert.deepEqual(parseSession(serializeSession(state)).projects['/p'].groups, gs)
  // The tab list wins: a group tab missing from it is dropped (and its emptied group collapses).
  state.projects['/p'].tabs = state.projects['/p'].tabs.slice(0, 2)
  assert.deepEqual(shape(parseSession(serializeSession(state)).projects['/p'].groups!.root), 'g1')
  // Older files without groups still parse.
  delete state.projects['/p'].groups
  assert.equal(parseSession(serializeSession(state)).projects['/p'].groups, undefined)
})
