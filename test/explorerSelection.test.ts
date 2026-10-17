// Explorer multi-select: the selection model (Ctrl/Cmd-click, Shift-click ranges, Ctrl/Cmd+A,
// Shift+Arrow, pruning on filter changes), the batch-delete plan (parent + child deletes only the
// parent, read-only rows skipped), main's batch trash with one Rojo pause, and the batched Delete in
// Studio jobs.
import assert from 'node:assert/strict'
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import {
  clearKeys,
  clickSelect,
  collapseEntries,
  collapseInstancePaths,
  EMPTY_SELECTION,
  moveFocus,
  nameList,
  planDelete,
  pruneSelection,
  rangeKeys,
  selectAll,
  single,
  uniqueKey,
  unselectedInside,
  unselectedNote,
  type DeleteCandidate,
  type Selection
} from '../src/shared/explorerSelection.ts'
import { trashEntries } from '../src/main/services/fileOps.ts'
import { RojoPause } from '../src/main/services/rojoRestart.ts'
import { deleteManyInStudio, DELETE_PLUGIN_VERSION, type DeleteBridge } from '../src/main/services/studio/deleteInstance.ts'
import type { BridgeJob } from '../src/shared/studio/protocol.ts'
import { makeProject, write } from './fixture.ts'

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

const ROWS = ['A', 'A/a1', 'A/a2', 'B', 'B/b1', 'C']
const keys = (s: Selection) => [...s.keys]

// ---- selection model

test('plain click selects one row and makes it the anchor and focus', () => {
  const s = clickSelect(EMPTY_SELECTION, ROWS, 'A/a2')
  assert.deepEqual(s, { keys: ['A/a2'], anchor: 'A/a2', focus: 'A/a2' })
  assert.deepEqual(clickSelect(selectAll(s, ROWS), ROWS, 'C'), single('C'), 'a plain click drops a multi-selection')
})

test('Ctrl/Cmd-click toggles rows in and out, kept in visible order', () => {
  let s = clickSelect(EMPTY_SELECTION, ROWS, 'C')
  s = clickSelect(s, ROWS, 'A', { toggle: true })
  assert.deepEqual(keys(s), ['A', 'C'])
  assert.equal(s.anchor, 'A')
  assert.equal(s.focus, 'A')
  s = clickSelect(s, ROWS, 'B/b1', { toggle: true })
  assert.deepEqual(keys(s), ['A', 'B/b1', 'C'])
  s = clickSelect(s, ROWS, 'A', { toggle: true })
  assert.deepEqual(keys(s), ['B/b1', 'C'], 'toggling a selected row removes it')
  assert.equal(s.focus, 'A', 'the toggled-off row keeps the keyboard focus')
  // Toggling the only selected row off: nothing is selected (Delete, Enter, F2 then act on nothing;
  // the view draws the focus outline on the cursor row instead).
  const off = clickSelect(single('B'), ROWS, 'B', { toggle: true })
  assert.deepEqual(off, { keys: [], anchor: 'B', focus: 'B' })
})

test('Shift-click selects the range from the anchor, either direction; Ctrl+Shift adds it', () => {
  let s = clickSelect(EMPTY_SELECTION, ROWS, 'A/a2')
  s = clickSelect(s, ROWS, 'B/b1', { range: true })
  assert.deepEqual(keys(s), ['A/a2', 'B', 'B/b1'])
  assert.equal(s.anchor, 'A/a2', 'the anchor stays put')
  assert.equal(s.focus, 'B/b1')
  s = clickSelect(s, ROWS, 'A', { range: true })
  assert.deepEqual(keys(s), ['A', 'A/a1', 'A/a2'], 'a second Shift-click re-ranges from the same anchor')
  // Ctrl-click C (new anchor), then Ctrl+Shift-click B: the range C..B is added to what was selected.
  s = clickSelect(clickSelect(single('A'), ROWS, 'C', { toggle: true }), ROWS, 'B', { toggle: true, range: true })
  assert.deepEqual(keys(s), ['A', 'B', 'B/b1', 'C'])
  // No anchor yet: Shift-click selects just that row.
  assert.deepEqual(keys(clickSelect(EMPTY_SELECTION, ROWS, 'B', { range: true })), ['B'])
  assert.deepEqual(rangeKeys(ROWS, 'C', 'B'), ['B', 'B/b1', 'C'])
  assert.deepEqual(rangeKeys(ROWS, 'C', 'gone'), [])
})

test('Ctrl/Cmd+A selects every visible row; Esc (clearKeys) clears the keys and keeps the cursor', () => {
  const s = selectAll(single('B'), ROWS)
  assert.deepEqual(keys(s), ROWS)
  assert.equal(s.focus, 'B', 'the focus stays where it was')
  assert.deepEqual(selectAll(single('B'), []), EMPTY_SELECTION)
  assert.deepEqual(keys(EMPTY_SELECTION), [])
  const cleared = clearKeys(s)
  assert.deepEqual(cleared, { keys: [], anchor: 'B', focus: 'B' })
  assert.equal(clearKeys(cleared), cleared, 'already clear: the same object')
  assert.equal(clearKeys(EMPTY_SELECTION), EMPTY_SELECTION)
  // Esc, then Down: the row after the old cursor, not the first row.
  assert.deepEqual(moveFocus(clearKeys(single('A/a2')), ROWS, 1), single('B'))
  assert.deepEqual(moveFocus(clearKeys(single('A/a2')), ROWS, -1), single('A/a1'))
})

// A Game view filter keeps each match's ancestors on screen as context rows. The reviewer probe:
// filter "combat" shows Features and Services (src/shared/Features, src/server/Services) only as the
// way to the two Combat matches.
const FILTERED = [
  'ReplicatedStorage',
  'ReplicatedStorage/Shared',
  'ReplicatedStorage/Shared/Features',
  'ReplicatedStorage/Shared/Features/Combat',
  'ServerScriptService',
  'ServerScriptService/Server',
  'ServerScriptService/Server/Services',
  'ServerScriptService/Server/Services/CombatService'
]
const CONTEXT = new Set(FILTERED.filter((k) => !/Combat/.test(k.split('/').pop()!)))

test('filter context rows stay out of Ctrl/Cmd+A and Shift ranges; a click still selects one', () => {
  const all = selectAll(EMPTY_SELECTION, FILTERED, CONTEXT)
  assert.deepEqual(keys(all), ['ReplicatedStorage/Shared/Features/Combat', 'ServerScriptService/Server/Services/CombatService'], 'only the matches, not their ancestors')
  assert.equal(all.anchor, 'ReplicatedStorage/Shared/Features/Combat')
  const range = clickSelect(single('ReplicatedStorage/Shared/Features/Combat'), FILTERED, 'ServerScriptService/Server/Services/CombatService', { range: true }, CONTEXT)
  assert.deepEqual(keys(range), ['ReplicatedStorage/Shared/Features/Combat', 'ServerScriptService/Server/Services/CombatService'], 'the Services row between the two ends is left out')
  // Shift+Down across context rows: the cursor walks over them, the range skips them.
  let s = single('ReplicatedStorage/Shared/Features/Combat')
  for (let i = 0; i < 4; i++) s = moveFocus(s, FILTERED, 1, true, CONTEXT)
  assert.equal(s.focus, 'ServerScriptService/Server/Services/CombatService')
  assert.deepEqual(keys(s), ['ReplicatedStorage/Shared/Features/Combat', 'ServerScriptService/Server/Services/CombatService'])
  // A Shift-click that ends on a context row selects only the matches in between.
  assert.deepEqual(keys(clickSelect(single('ReplicatedStorage/Shared/Features/Combat'), FILTERED, 'ServerScriptService/Server', { range: true }, CONTEXT)), ['ReplicatedStorage/Shared/Features/Combat'])
  // Clicking or Ctrl/Cmd-clicking a context row directly still selects it.
  assert.deepEqual(keys(clickSelect(all, FILTERED, 'ServerScriptService/Server/Services', { toggle: true }, CONTEXT)), ['ReplicatedStorage/Shared/Features/Combat', 'ServerScriptService/Server/Services', 'ServerScriptService/Server/Services/CombatService'])
  assert.deepEqual(clickSelect(all, FILTERED, 'ServerScriptService/Server/Services', {}, CONTEXT), single('ServerScriptService/Server/Services'))
  // So the delete plan of a filtered select-all is the two Combat entries, not every feature and service.
  const at: Record<string, string> = {
    'ReplicatedStorage/Shared/Features': 'src/shared/Features',
    'ReplicatedStorage/Shared/Features/Combat': 'src/shared/Features/Combat',
    'ServerScriptService/Server/Services': 'src/server/Services',
    'ServerScriptService/Server/Services/CombatService': 'src/server/Services/CombatService.luau'
  }
  const plan = planDelete(keys(all).map((k) => disk(k, at[k], !k.endsWith('Service'))))
  assert.deepEqual(plan.disk.map((d) => d.path), ['src/shared/Features/Combat', 'src/server/Services/CombatService.luau'])
})

test('uniqueKey: same-named siblings get their own keys (#2, #3), clashes with a real "#2" name too', () => {
  const used = new Set<string>()
  assert.equal(uniqueKey(used, 'Workspace/Foo'), 'Workspace/Foo')
  assert.equal(uniqueKey(used, 'Workspace/Foo'), 'Workspace/Foo#2')
  assert.equal(uniqueKey(used, 'Workspace/Foo'), 'Workspace/Foo#3')
  assert.equal(uniqueKey(used, 'Workspace/Foo#2'), 'Workspace/Foo#2#2', 'a sibling really named "Foo#2" does not take the duplicate\'s key')
  assert.equal(uniqueKey(used, 'Workspace/Bar'), 'Workspace/Bar')
  // One click selects one of the two rows, so the batch is one row, not both.
  const rows = ['Workspace', 'Workspace/Foo', 'Workspace/Foo#2']
  assert.deepEqual(keys(clickSelect(EMPTY_SELECTION, rows, 'Workspace/Foo#2')), ['Workspace/Foo#2'])
})

test('Arrow keys move one row; Shift+Arrow extends from the anchor and can shrink back', () => {
  let s = moveFocus(EMPTY_SELECTION, ROWS, 1)
  assert.deepEqual(s, single('A'), 'from nothing, Down starts at the first row')
  s = moveFocus(single('A/a2'), ROWS, 1)
  assert.deepEqual(s, single('B'))
  assert.deepEqual(moveFocus(single('C'), ROWS, 1), single('C'), 'stays on the last row')
  s = moveFocus(single('A/a1'), ROWS, 1, true)
  s = moveFocus(s, ROWS, 1, true)
  assert.deepEqual(keys(s), ['A/a1', 'A/a2', 'B'])
  assert.equal(s.anchor, 'A/a1')
  assert.equal(s.focus, 'B')
  s = moveFocus(s, ROWS, -1, true)
  assert.deepEqual(keys(s), ['A/a1', 'A/a2'], 'Shift+Up shrinks the range toward the anchor')
  s = moveFocus(moveFocus(moveFocus(s, ROWS, -1, true), ROWS, -1, true), ROWS, -1, true)
  assert.deepEqual(keys(s), ['A', 'A/a1'], 'and grows past it the other way')
  assert.deepEqual(moveFocus(s, ROWS, 1), single('A/a1'), 'a plain arrow drops back to one row')
})

test('pruneSelection keeps only still-visible rows (filter, collapse, delete) and is identity-stable', () => {
  const s = clickSelect(clickSelect(single('A/a1'), ROWS, 'B', { toggle: true }), ROWS, 'C', { toggle: true })
  assert.equal(pruneSelection(s, ROWS), s, 'nothing changed: the same object (no re-render loop)')
  const filtered = pruneSelection(s, ['A', 'A/a1', 'C'])
  assert.deepEqual(keys(filtered), ['A/a1', 'C'])
  assert.equal(filtered.focus, 'C')
  const gone = pruneSelection(s, ['A', 'B'])
  assert.deepEqual(keys(gone), ['B'])
  assert.equal(gone.focus, null, 'a focus that disappeared is cleared')
  assert.equal(gone.anchor, null)
  // Clearing the filter later does not bring the dropped rows back.
  assert.deepEqual(keys(pruneSelection(gone, ROWS)), ['B'])
  assert.equal(pruneSelection(s, []), EMPTY_SELECTION)
})

// ---- batch delete plan

// Game view rows (keys are instance paths) carry their instance path; Files view rows ("f:...") do not.
const ipOf = (key: string) => (key.startsWith('f:') ? undefined : key.split('/'))
const disk = (key: string, path: string, isDir = false, file?: string): DeleteCandidate => ({ key, name: key.split('/').pop()!, kind: 'disk', path, isDir, file, instancePath: ipOf(key) })
const studio = (key: string, instancePath = key.split('/')): DeleteCandidate => ({ key, name: instancePath[instancePath.length - 1], kind: 'studio', instancePath, className: 'Model' })
const skip = (key: string, reason = 'Wally package, read-only', path?: string): DeleteCandidate => ({ key, name: key.split('/').pop()!, kind: 'skip', reason, path, instancePath: ipOf(key) })

test('planDelete: parent and child both selected deletes only the parent', () => {
  const plan = planDelete([
    disk('ServerScriptService/Server/Data', 'src/server/Data', true),
    disk('ServerScriptService/Server/Data/PlayerData', 'src/server/Data/PlayerData.luau'),
    disk('ServerScriptService/Server/Handlers/Join', 'src/server/Handlers/Join.server.luau')
  ])
  assert.deepEqual(plan.disk.map((d) => d.path), ['src/server/Data', 'src/server/Handlers/Join.server.luau'])
  assert.equal(plan.covered, 1)
  // Files view keys ("f:...") nest by path, not by key prefix.
  const files = planDelete([disk('f:src/shared/Modules', 'src/shared/Modules', true), disk('f:src/shared/Modules/ModuleLoader.luau', 'src/shared/Modules/ModuleLoader.luau'), disk('f:src/shared/ModulesX.luau', 'src/shared/ModulesX.luau')])
  assert.deepEqual(files.disk.map((d) => d.path), ['src/shared/Modules', 'src/shared/ModulesX.luau'], 'a sibling with a longer name is not "inside"')
  // An init script's folder and the folder row are the same entry: one delete.
  const same = planDelete([disk('Rs/Shared/Features/Inventory', 'src/shared/Features/Inventory', true), disk('f:src/shared/Features/Inventory', 'src/shared/Features/Inventory', true)])
  assert.equal(same.disk.length, 1)
  assert.equal(same.covered, 1)
})

test('planDelete: read-only rows are skipped with their reason; Studio-only rows nest by instance', () => {
  const plan = planDelete([
    skip('ReplicatedStorage/Packages'),
    skip('ReplicatedStorage/Shared/Net', 'generated by Blink'),
    disk('ReplicatedStorage/Shared/Util', 'src/shared/Util.luau'),
    studio('Workspace/Map'),
    studio('Workspace/Map/Tree'),
    studio('Workspace/Lights')
  ])
  assert.deepEqual(plan.disk.map((d) => d.path), ['src/shared/Util.luau'])
  assert.deepEqual(plan.skipped.map((s) => [s.name, s.reason]), [['Packages', 'Wally package, read-only'], ['Net', 'generated by Blink']])
  assert.deepEqual(plan.studio.map((s) => s.instancePath.join('.')), ['Workspace.Map', 'Workspace.Lights'])
  assert.equal(plan.covered, 1)
  // A read-only row inside a folder that is deleted goes with the folder (not listed as skipped).
  const inside = planDelete([disk('Rs/Shared/Interface', 'src/shared/Interface', true), skip('Rs/Shared/Interface/Gen', 'generated by Blink', 'src/shared/Interface/Gen.luau')])
  assert.deepEqual(inside.skipped, [])
  assert.equal(inside.covered, 1)
  // Rows with no file of their own (a .model.json's children) go with the instance that holds them.
  const model = planDelete([disk('Ws/Shared/Props', 'src/shared/Props.model.json'), skip('Ws/Shared/Props/Part', 'no file or folder of its own')])
  assert.deepEqual(model.skipped, [])
  assert.equal(model.covered, 1)
  // A skipped parent does not swallow its selected children.
  const mount = planDelete([skip('ServerScriptService/Server', 'mapped in the project file'), disk('ServerScriptService/Server/A', 'src/server/A.luau')])
  assert.equal(mount.disk.length, 1)
  assert.equal(mount.skipped.length, 1)
})

test('planDelete: nesting compares instance names one by one and disk entries by path, not by key prefix', () => {
  // Studio instance names may contain "/": Workspace.Foo and Workspace["Foo/Bar"] are siblings even
  // though the key "Workspace/Foo/Bar" starts with "Workspace/Foo/".
  const slash = planDelete([studio('Workspace/Foo'), studio('Workspace/Foo/Bar', ['Workspace', 'Foo/Bar'])])
  assert.deepEqual(slash.studio.map((s) => s.instancePath), [['Workspace', 'Foo'], ['Workspace', 'Foo/Bar']])
  assert.equal(slash.covered, 0)
  // A child instance a nested project-file mapping puts elsewhere on disk is not inside its parent's folder.
  const nested = planDelete([disk('Rs/Shared/Features', 'src/shared/Features', true), disk('Rs/Shared/Features/Extra/Thing', 'vendor/Extra/Thing.luau')])
  assert.deepEqual(nested.disk.map((d) => d.path), ['src/shared/Features', 'vendor/Extra/Thing.luau'])
  const mount = planDelete([disk('Rs/Shared/Features', 'src/shared/Features', true), skip('Rs/Shared/Features/Extra', 'mapped in the project file', 'vendor/Extra')])
  assert.deepEqual(mount.skipped.map((s) => s.name), ['Extra'], 'a mount under a selected folder is reported as left out, not as going along')
  // A Studio-only instance inside a selected repo folder goes with it (Rojo removes the folder instance).
  const under = planDelete([disk('Ws/Map', 'src/shared/Map', true), studio('Ws/Map/Tree')])
  assert.deepEqual(under.studio, [])
  assert.equal(under.covered, 1)
})

test('unselectedInside / unselectedNote: files a batch folder holds that were not selected', () => {
  const files = [
    'src/server/Services/CombatService.luau',
    'src/server/Services/DataService.luau',
    'src/server/Services/ShopService.luau',
    'src/server/Services/Shop/init.luau',
    'src/server/Services/Shop/Items.luau',
    'src/shared/Features/Combat/init.luau',
    'src/shared/Features/Combat/Types.luau',
    'src/shared/Util.luau'
  ]
  // The Services folder (a context row Ctrl-clicked) plus one file in it: the other three files and
  // the Shop folder's two were not selected.
  const cands = [disk('Sss/Server/Services', 'src/server/Services', true), disk('Sss/Server/Services/CombatService', 'src/server/Services/CombatService.luau')]
  const plan = planDelete(cands)
  assert.deepEqual(unselectedInside(plan, cands, files), [{ path: 'src/server/Services', count: 4 }])
  // A selected subfolder takes its files with it; an init-script row counts its own file as selected.
  const more = [...cands, disk('Sss/Server/Services/Shop', 'src/server/Services/Shop', true, 'src/server/Services/Shop/init.luau')]
  assert.deepEqual(unselectedInside(planDelete(more), more, files), [{ path: 'src/server/Services', count: 2 }])
  const combat = [disk('Rs/Shared/Features/Combat', 'src/shared/Features/Combat', true, 'src/shared/Features/Combat/init.luau')]
  assert.deepEqual(unselectedInside(planDelete(combat), combat, files), [{ path: 'src/shared/Features/Combat', count: 1 }], 'Types.luau is hidden; init.luau is the row itself')
  // Files only, or a folder whose files were all picked: nothing to warn about.
  const plain = [disk('a', 'src/shared/Util.luau'), disk('b', 'src/server/Services/DataService.luau')]
  assert.deepEqual(unselectedInside(planDelete(plain), plain, files), [])
  const whole = [disk('f:src/shared/Features/Combat', 'src/shared/Features/Combat', true), disk('f:src/shared/Features/Combat/init.luau', 'src/shared/Features/Combat/init.luau'), disk('f:src/shared/Features/Combat/Types.luau', 'src/shared/Features/Combat/Types.luau')]
  assert.deepEqual(unselectedInside(planDelete(whole), whole, files), [])

  assert.equal(unselectedNote([]), '')
  assert.equal(unselectedNote([{ path: 'src/server/Services', count: 23 }]), 'src/server/Services/ also holds 23 files you did not select. They go too.')
  assert.equal(unselectedNote([{ path: 'src/a', count: 1 }]), 'src/a/ also holds 1 file you did not select. It goes too.')
  assert.equal(
    unselectedNote([{ path: 'a', count: 1 }, { path: 'b', count: 2 }, { path: 'c', count: 3 }, { path: 'd', count: 4 }, { path: 'e', count: 1 }]),
    'a/ also holds 1 file you did not select; b/ also holds 2 files you did not select; c/ also holds 3 files you did not select, and 2 more folders hold 5 more files. They go too.'
  )
})

test('collapseEntries / collapseInstancePaths / nameList', () => {
  assert.deepEqual(
    collapseEntries([{ path: 'src/a', isDir: true }, { path: 'src/a/b.luau' }, { path: 'src/ab.luau' }, { path: 'src/ab.luau' }]),
    [{ path: 'src/a', isDir: true }, { path: 'src/ab.luau' }]
  )
  assert.deepEqual(collapseEntries([{ path: 'src/a/b.luau' }, { path: 'src/a/b.luau/x' }]).length, 2, 'a file never covers anything')
  assert.deepEqual(
    collapseInstancePaths([{ instancePath: ['Workspace', 'Map', 'Tree'] }, { instancePath: ['Workspace', 'Map'] }, { instancePath: ['Workspace', 'Map'] }, { instancePath: ['Workspace', 'Mapper'] }]).map((x) => x.instancePath.join('.')),
    ['Workspace.Map', 'Workspace.Mapper']
  )
  assert.equal(nameList(['a']), 'a')
  assert.equal(nameList(['a', 'b', 'c']), 'a, b and c')
  assert.equal(nameList(['a', 'b', 'c', 'd', 'e', 'f']), 'a, b, c, d and 2 more')
})

// ---- main: the batch trash and its Rojo pause

const MOUNTS = ['src/shared', 'Packages', 'src/server', 'src/ServerStorage', 'src/client']

test('trashEntries: each entry once, children of a listed folder go with it, failures listed not thrown', async () => {
  const root = makeProject()
  roots.push(root)
  write(root, 'src/server/Handlers/Join.server.luau', 'print(1)\n')
  const trashed: string[] = []
  const trash = async (full: string) => {
    trashed.push(full)
    rmSync(full, { recursive: true, force: true })
  }
  const r = await trashEntries(
    root,
    MOUNTS,
    [
      { path: 'src/server/Features/Inventory/InventoryService.luau' },
      { path: 'src/server/Features/Inventory/init.server.luau' },
      { path: 'src/server/Handlers/Join.server.luau' },
      { path: 'src/server', isDir: true },
      { path: 'src/server/Nope.luau' }
    ],
    trash,
    () => Date.UTC(2026, 9, 17, 0, 45)
  )
  assert.deepEqual(trashed, [join(root, 'src/server/Features/Inventory'), join(root, 'src/server/Handlers/Join.server.luau')], 'the init script trashes its folder; the module inside is not trashed on its own')
  // Each keeps a copy in one project trash folder first.
  const stamp = '.forge/sync/trash/2026-10-17T00-45-00-000Z'
  assert.deepEqual(r.changes, [
    { from: 'src/server/Features/Inventory', to: null, isDir: true, backup: `${stamp}/src/server/Features/Inventory` },
    { from: 'src/server/Handlers/Join.server.luau', to: null, isDir: false, backup: `${stamp}/src/server/Handlers/Join.server.luau` }
  ])
  assert.deepEqual(r.failed.map((f) => f.path), ['src/server', 'src/server/Nope.luau'])
  assert.match(r.failed[0].error, /mapped/)
  assert.match(r.failed[1].error, /no longer exists/)
  assert.ok(existsSync(join(root, 'src/server/Data/PlayerData.luau')), 'the refused mount was left alone')
})

test('RojoPause.aroundPaths: one pause around a batch with a folder, none for files only', async () => {
  const root = makeProject()
  roots.push(root)
  const calls: string[] = []
  const pause = new RojoPause({
    pause: async (reason) => {
      calls.push(`pause:${reason}`)
      return true
    },
    resume: async () => {
      calls.push('resume')
    },
    settleMs: 10
  })
  const files = [join(root, 'src/server/Data/PlayerData.luau'), join(root, 'src/shared/Modules/ModuleLoader.luau')]
  await pause.aroundPaths(files, async () => calls.push('files'), 'folder delete')
  assert.deepEqual(calls, ['files'], 'files only: rojo keeps serving')
  const mixed = [...files, join(root, 'src/shared/Interface'), join(root, 'src/server/Features/Inventory')]
  await pause.aroundPaths(mixed, async () => {
    calls.push('batch')
  }, 'folder delete')
  for (let i = 0; i < 100 && !calls.includes('resume'); i++) await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(calls, ['files', 'pause:folder delete', 'batch', 'resume'], 'one pause and one resume for the whole batch')
})

// ---- main: batched Delete in Studio

function fakeBridge(fail: (job: BridgeJob) => string | null = () => null): DeleteBridge & { runs: BridgeJob[]; up: boolean } {
  const b = {
    runs: [] as BridgeJob[],
    up: true,
    connected: () => b.up,
    studio: () => ({ pluginVersion: DELETE_PLUGIN_VERSION }),
    busy: () => null,
    run: async (job: BridgeJob) => {
      b.runs.push(job)
      const why = fail(job)
      if (why) throw new Error(why)
    }
  }
  return b
}

test('deleteManyInStudio: one job per instance in turn, nested ones skipped, a failure does not stop the rest', async () => {
  const bridge = fakeBridge((job) => (job.target?.path.join('.') === 'Workspace.Lights' ? 'Lights is locked' : null))
  let n = 0
  const deps = { bridge, refusal: (p: string[]) => (p.length < 2 ? `${p[0]} is a service` : null), newId: () => `job-${++n}` }
  const r = await deleteManyInStudio(deps, [
    { instancePath: ['Workspace', 'Map'], className: 'Model' },
    { instancePath: ['Workspace', 'Map', 'Tree'], className: 'Model' },
    { instancePath: ['Workspace', 'Lights'], className: 'Folder' },
    { instancePath: ['Lighting'] },
    { instancePath: ['Workspace', 'Baseplate'], className: 'Part' }
  ])
  assert.deepEqual(bridge.runs.map((j) => j.target?.path.join('.')), ['Workspace.Map', 'Workspace.Lights', 'Workspace.Baseplate'])
  assert.deepEqual(bridge.runs.map((j) => j.id), ['job-1', 'job-2', 'job-3'])
  assert.deepEqual(r.deleted, [['Workspace', 'Map'], ['Workspace', 'Baseplate']])
  assert.deepEqual(r.failed.map((f) => [f.instancePath.join('.'), f.error]), [['Workspace.Lights', 'Lights is locked'], ['Lighting', 'Lighting is a service']])
  // Studio gone mid-batch: the rest are reported, not run.
  const gone = fakeBridge()
  const deps2 = { bridge: gone, refusal: () => null }
  gone.run = async (job) => {
    gone.runs.push(job)
    gone.up = false
  }
  const r2 = await deleteManyInStudio(deps2, [{ instancePath: ['Workspace', 'A'] }, { instancePath: ['Workspace', 'B'] }])
  assert.equal(gone.runs.length, 1)
  assert.deepEqual(r2.deleted, [['Workspace', 'A']])
  assert.deepEqual(r2.failed, [{ instancePath: ['Workspace', 'B'], error: 'Studio disconnected' }])
})
