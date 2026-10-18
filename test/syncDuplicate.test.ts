// Forge Sync: same-name siblings (the FSF EmperorsShot bug), new-file writes guarded against Rojo,
// and drift (how far a place's Studio is behind disk).
import assert from 'node:assert/strict'
import { existsSync, rmSync, statSync, unlinkSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import type { StudioNode, SyncEntry } from '../src/shared/sync/types.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import type { PlaceMap } from '../src/main/services/sync/mapping.ts'
import { edit, find, get, makeFsfProject, MATCH_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const RS = 'ReplicatedStorage'
const SKILLS = [RS, 'Shared', 'Skills']
const MK = String(MATCH_PLACE)
const MATCH = { placeId: MATCH_PLACE, name: 'Arena' }
const ES = 'src/skills/Definitions/EmperorsShot.luau'
const ES_PATH = [...SKILLS, 'EmperorsShot']

interface Ctx {
  root: string
  engine: SyncEngine
  match: PlaceMap
  guarded: { projectFile: string; file: string }[]
}

async function setup(): Promise<Ctx> {
  const root = makeFsfProject()
  roots.push(root)
  const guarded: Ctx['guarded'] = []
  let t = Date.UTC(2026, 9, 17, 1, 0, 0)
  const engine = new SyncEngine({
    root,
    now: () => t++,
    guardNewFile: async (projectFile, file, fn) => {
      guarded.push({ projectFile, file })
      return fn()
    }
  })
  const maps = await engine.places()
  return { root, engine, guarded, match: maps.find((m) => m.projectFile === 'default.project.json')! }
}

async function snapshot(engine: SyncEngine, nodes: StudioNode[]): Promise<SyncEntry[]> {
  engine.beginSnapshot(MK, MATCH)
  engine.addSnapshot(MK, nodes)
  return engine.finishSnapshot(MK)
}

async function agreed(ctx: Ctx): Promise<StudioNode[]> {
  const nodes = studioFromDisk(ctx.root, ctx.match)
  const entries = await snapshot(ctx.engine, nodes)
  assert.deepEqual(entries.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
  assert.equal(ctx.engine.gate(MK), 'clear')
  return nodes
}

const module = (id: string, source: string): StudioNode => ({ id, path: ES_PATH, className: 'ModuleScript', source })
const V1 = 'return { name = "EmperorsShot", damage = 10 }\n'
const V2 = 'return { name = "EmperorsShot", damage = 25 }\n'

test('repro: a script made in Studio while Rojo serves, then Rojo adds a twin: held as a duplicate conflict, never silently dropped', async () => {
  const ctx = await setup()
  await agreed(ctx)

  // 1. The user makes EmperorsShot in Studio: Forge writes the new file, with rojo serve paused.
  const created = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: module('es1', V1) }])
  assert.deepEqual(created.filter((e) => e.action === 'created').map((e) => e.file), [ES])
  assert.equal(get(ctx.root, ES), V1)
  assert.deepEqual(ctx.guarded, [{ projectFile: 'default.project.json', file: ES }])

  // 2. Rojo (serving at that moment, before this fix) adds its own instance for the new file.
  const twin = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: module('rojo1', V1) }])
  const dup = twin.find((e) => e.action === 'conflict')
  assert.ok(dup, 'the twin is a conflict, not a silent refusal')
  assert.equal(dup.file, ES)
  assert.ok(!twin.some((e) => e.note === 'duplicate sibling name'), 'no bare refusal next to the conflict')
  assert.equal(ctx.engine.gate(MK), 'blocked', 'rojo serve waits: Rojo would delete one copy on connect')
  const [c] = ctx.engine.conflicts(MK)
  assert.equal(c.reason, 'duplicate')
  assert.equal(c.copies, 2)
  assert.match(c.note ?? '', /2 ModuleScripts named EmperorsShot in ReplicatedStorage\.Shared\.Skills/)
  assert.ok(existsSync(join(ctx.root, ES)), 'the file is kept')

  // 3. The user edits the Studio copy. Before the fix that edit never reached disk and was lost when
  //    Rojo reconnected. Now the conflict carries it as Studio's side.
  const edited = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: module('es1', V2) }])
  assert.ok(edited.some((e) => e.action === 'conflict' && e.file === ES))
  assert.equal(get(ctx.root, ES), V1, 'disk is not overwritten while held')
  const [c2] = ctx.engine.conflicts(MK)
  assert.equal(c2.studio, V2)
  assert.match(c2.note ?? '', /copy 1 \(ModuleScript\): 1 line\(s\) differ from disk|copy 1 \(ModuleScript\): 2 line\(s\) differ from disk/)
  assert.match(c2.note ?? '', /copy 2 \(ModuleScript\) = disk/)

  // 4. Take Studio: the edited copy goes to disk; the group is not held again while unchanged.
  await ctx.engine.resolve(MK, ES, 'studio')
  assert.equal(get(ctx.root, ES), V2)
  assert.equal(ctx.engine.conflicts(MK).length, 0)
  assert.equal(ctx.engine.gate(MK), 'clear')
  const again = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: module('es1', V2) }])
  assert.ok(!again.some((e) => e.action === 'conflict'), 'the decided group stays decided')

  // 5. A new edit to either copy changes the group: held again.
  const later = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: module('rojo1', V2 + '-- more\n') }])
  assert.ok(later.some((e) => e.action === 'conflict' && e.file === ES))

  // 6. The extra copy is deleted in Studio: one instance, synced normally.
  const gone = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: 'es1', path: ES_PATH }])
  assert.equal(ctx.engine.conflicts(MK).length, 0)
  assert.ok(gone.some((e) => e.file === ES && e.action === 'pulled'))
  assert.equal(get(ctx.root, ES), V2 + '-- more\n')
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a snapshot with same-name siblings (Studio reconnect) is held as a duplicate; Take disk keeps the file', async () => {
  const ctx = await setup()
  put(ctx.root, ES, V1)
  const nodes = studioFromDisk(ctx.root, ctx.match)
  await snapshot(ctx.engine, nodes)
  assert.equal(ctx.engine.gate(MK), 'clear')
  const twins = [...nodes, module('copy2', V2)]
  const entries = await snapshot(ctx.engine, twins)
  assert.ok(entries.some((e) => e.action === 'conflict' && e.file === ES))
  assert.equal(ctx.engine.gate(MK), 'blocked')
  const [c] = ctx.engine.conflicts(MK)
  assert.equal(c.reason, 'duplicate')
  assert.equal(c.studio, V2, "Studio's side is the copy that differs from the last synced version")
  await ctx.engine.resolve(MK, ES, 'disk')
  assert.equal(get(ctx.root, ES), V1)
  assert.equal(ctx.engine.gate(MK), 'clear')
  // The same twins in the next snapshot: not held again.
  const next = await snapshot(ctx.engine, twins)
  assert.ok(!next.some((e) => e.action === 'conflict'))
})

test('a source change with an unknown id next to same-name twins keeps both twins (no silent drop)', async () => {
  const ctx = await setup()
  put(ctx.root, ES, V1)
  const nodes = studioFromDisk(ctx.root, ctx.match)
  await snapshot(ctx.engine, [...nodes, module('copy2', V1)])
  assert.equal(ctx.engine.conflicts(MK).length, 1)
  // The plugin's id table was rebuilt: a source change arrives under an id Forge does not know.
  await ctx.engine.applyChanges(MK, [{ kind: 'source', node: module('fresh', V2) }])
  const tree = ctx.engine.liveTree(MK)!.nodes.filter((n) => n.path.join('/') === ES_PATH.join('/'))
  assert.ok(tree.length >= 2, `both twins are still known (had ${tree.length})`)
  assert.equal(ctx.engine.conflicts(MK)[0].reason, 'duplicate')
  assert.equal(get(ctx.root, ES), V1)
})

test('a source change with an unknown id for a single instance still replaces it (no false duplicate)', async () => {
  const ctx = await setup()
  const nodes = await agreed(ctx)
  const dash = find(nodes, [...SKILLS, 'Dash'])
  await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...dash, id: 'rebuilt', source: 'return { name = "Dash", cooldown = 2 }\n' } }])
  assert.equal(ctx.engine.conflicts(MK).length, 0)
  assert.equal(get(ctx.root, 'src/skills/Definitions/Dash.luau'), 'return { name = "Dash", cooldown = 2 }\n')
})

test('new files written for a Studio add go through guardNewFile; edits to existing files do not', async () => {
  const ctx = await setup()
  const nodes = await agreed(ctx)
  ctx.guarded.length = 0
  await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...find(nodes, [...SKILLS, 'Guard']), source: 'return { name = "Guard", block = true }\n' } }])
  assert.deepEqual(ctx.guarded, [], 'an edit of an existing file needs no pause')
  await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'f1', path: [...SKILLS, 'Ultimates'], className: 'Folder' }, descendants: [{ id: 'f1m', path: [...SKILLS, 'Ultimates', 'Nova'], className: 'ModuleScript', source: 'return {}\n' }] }
  ])
  const files = (ctx.guarded as Ctx['guarded']).map((g) => g.file).sort()
  assert.ok(files.includes('src/skills/Definitions/Ultimates/Nova.luau'), files.join(', '))
  assert.ok(existsSync(join(ctx.root, 'src/skills/Definitions/Ultimates/Nova.luau')))
})

test('drift: counts files changed and new on disk since the place last synced; one deleted on disk is counted apart', async () => {
  const ctx = await setup()
  assert.equal(await ctx.engine.drift('default.project.json', MK), null, 'never synced: nothing to say')
  await agreed(ctx)
  assert.deepEqual(await ctx.engine.drift('default.project.json', MK), { behind: 0, files: [] })
  // The FSF case: five edits on disk after Match's Studio last synced.
  put(ctx.root, 'src/skills/Definitions/Dash.luau', 'return { name = "Dash", cooldown = 1 }\n')
  put(ctx.root, 'src/server/Config/Admins.luau', 'return { 1, 2 }\n')
  put(ctx.root, 'src/server/Handlers/Combat.luau', 'return { hits = 3 }\n')
  put(ctx.root, ES, V1)
  unlinkSync(join(ctx.root, 'src/skills/Definitions/Guard.luau'))
  const old = new Date(Date.UTC(2026, 9, 16))
  utimesSync(join(ctx.root, 'src/server/Config/Admins.luau'), old, old)
  const d = (await ctx.engine.drift('default.project.json', MK))!
  assert.equal(d.behind, 4)
  assert.deepEqual([...d.files.map((f) => f.file)].sort(), [ES, 'src/server/Config/Admins.luau', 'src/server/Handlers/Combat.luau', 'src/skills/Definitions/Dash.luau'].sort())
  // Guard.luau is gone from disk while the live Studio still has it: deleted on disk, not behind.
  assert.deepEqual(d.deleted, ['src/skills/Definitions/Guard.luau'])
  assert.equal(d.files[d.files.length - 1].file, 'src/server/Config/Admins.luau', 'newest first')
  // A whitespace-only line-ending change is not drift.
  put(ctx.root, 'src/shared/Modules/Util.luau', 'return {}\r\n')
  assert.equal((await ctx.engine.drift('default.project.json', MK))!.behind, 4)
  // Unmapped files (Packages, skipped) are not counted.
  put(ctx.root, 'Packages/Extra.luau', 'return {}\n')
  assert.equal((await ctx.engine.drift('default.project.json', MK))!.behind, 4)
  assert.ok(statSync(join(ctx.root, ES)).isFile())
})

test('drift: a held conflict is not counted twice', async () => {
  const ctx = await setup()
  const nodes = await agreed(ctx)
  put(ctx.root, 'src/skills/Definitions/Dash.luau', 'return { name = "Dash", cooldown = 1 }\n')
  await snapshot(ctx.engine, edit(nodes, [...SKILLS, 'Dash'], { source: 'return { name = "Dash", cooldown = 9 }\n' }))
  assert.equal(ctx.engine.conflicts(MK).length, 1)
  assert.equal((await ctx.engine.drift('default.project.json', MK))!.behind, 0)
})
