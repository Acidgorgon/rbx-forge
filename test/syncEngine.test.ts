import assert from 'node:assert/strict'
import * as nodeFs from 'node:fs/promises'
import { existsSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, sep } from 'node:path'
import { after, test } from 'node:test'
import type { GateState, StudioNode, SyncEntry } from '../src/shared/sync/types.ts'
import { placeKeyFor, SyncEngine, SyncResendError, type SyncFs } from '../src/main/services/sync/engine.ts'
import { fromDisk, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { readModel } from '../src/main/services/sync/modelJson.ts'
import { BaseStore, ensureSyncIgnored, hashText, migrateLegacy } from '../src/main/services/sync/store.ts'
import { edit, find, get, listFiles, makeFsfProject, MATCH_PLACE, MENU_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const RS = 'ReplicatedStorage'
const SSS = 'ServerScriptService'
const MOVES = [SSS, 'Server', 'Features', 'Skills', 'Moves']
const MENU_MOVES = [SSS, 'Server', 'Features', 'Skills', 'Moves']
const SKILLS = [RS, 'Shared', 'Skills']
const MATCH = { placeId: MATCH_PLACE, name: 'Arena' }
const MENU = { placeId: MENU_PLACE, name: 'Menu' }
const MK = String(MATCH_PLACE)
const NK = String(MENU_PLACE)

interface Ctx {
  root: string
  engine: SyncEngine
  match: PlaceMap
  menu: PlaceMap
  clock: { t: number }
}

async function setup(opts: { fs?: SyncFs; before?: (root: string) => void } = {}): Promise<Ctx> {
  const root = makeFsfProject()
  roots.push(root)
  opts.before?.(root)
  const clock = { t: Date.UTC(2026, 9, 14, 12, 0, 0) }
  const engine = new SyncEngine({ root, fs: opts.fs, now: () => clock.t++ })
  const maps = await engine.places()
  return { root, engine, clock, match: maps.find((m) => m.projectFile === 'default.project.json')!, menu: maps.find((m) => m.projectFile === 'menu.project.json')! }
}

async function snapshot(engine: SyncEngine, key: string, place: { placeId: number; name: string }, nodes: StudioNode[]): Promise<SyncEntry[]> {
  engine.beginSnapshot(key, place)
  for (let i = 0; i < nodes.length; i += 4) engine.addSnapshot(key, nodes.slice(i, i + 4))
  return engine.finishSnapshot(key)
}

const actions = (entries: SyncEntry[], action: string): string[] => entries.filter((e) => e.action === action).map((e) => e.file).sort()
const studio = (ctx: Ctx, map: PlaceMap = ctx.match): StudioNode[] => studioFromDisk(ctx.root, map)
const notForge = (rel: string): boolean => rel === '.forge' || rel === '.git'

// Both places agreed with the disk once (bases exist for both).
async function agreed(ctx: Ctx): Promise<void> {
  const a = await snapshot(ctx.engine, MK, MATCH, studio(ctx))
  assert.deepEqual(a.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
  const b = await snapshot(ctx.engine, NK, MENU, studio(ctx, ctx.menu))
  assert.deepEqual(b.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
}

// ---- store ----

test('BaseStore is content addressed, renames prefixes, survives reload and gc', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-store-'))
  roots.push(root)
  const store = new BaseStore(root)
  await store.set('1', 'src/a/x.luau', 'hello\r\n')
  await store.set('2', 'src/a/x.luau', 'hello')
  await store.set('1', 'src/a/y.luau', 'other\n')
  assert.equal((await store.get('1', 'src/a/x.luau'))!.hash, hashText('hello'))
  assert.equal((await store.get('2', 'src/a/x.luau'))!.text, 'hello')
  await store.rename('1', 'src/a', 'src/b')
  assert.deepEqual((await store.files('1')).sort(), ['src/b/x.luau', 'src/b/y.luau'])
  assert.deepEqual(await store.files('2'), ['src/a/x.luau'])
  await store.save()
  const again = new BaseStore(root)
  assert.equal((await again.get('1', 'src/b/y.luau'))!.text, 'other')
  await again.delete('1', 'src/b/y.luau')
  assert.equal(await again.gc(), 1)
  assert.equal((await again.get('2', 'src/a/x.luau'))!.text, 'hello')
  assert.match(get(root, '.gitignore'), /^\.forge\/sync\/$/m)
})

test('ensureSyncIgnored adds the line once and keeps CRLF', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-ignore-'))
  roots.push(root)
  writeFileSync(join(root, '.gitignore'), 'node_modules\r\nPackages/')
  assert.equal(await ensureSyncIgnored(root), true)
  assert.equal(await ensureSyncIgnored(root), false)
  assert.equal(get(root, '.gitignore'), 'node_modules\r\nPackages/\r\n# Forge Sync local state (per-machine)\r\n.forge/sync/\r\n')
})

// ---- gate + first snapshot ----

test('gate: idle -> checking -> clear, events fire, nothing is written when Studio matches disk', async () => {
  const ctx = await setup()
  const before = listFiles(ctx.root, notForge)
  const seen: GateState[] = []
  ctx.engine.on('changed', (key) => seen.push(ctx.engine.gate(key)))
  assert.equal(ctx.engine.gate(MK), 'idle')
  ctx.engine.beginSnapshot(MK, MATCH)
  assert.equal(ctx.engine.gate(MK), 'checking')
  ctx.engine.addSnapshot(MK, studio(ctx))
  const entries = await ctx.engine.finishSnapshot(MK)
  assert.equal(ctx.engine.gate(MK), 'clear')
  assert.deepEqual(seen, ['checking', 'clear'])
  assert.ok(entries.length > 10)
  assert.deepEqual(entries.filter((e) => e.action !== 'same' && e.action !== 'unmapped'), [])
  assert.deepEqual(listFiles(ctx.root, notForge), before)
  assert.match(get(ctx.root, '.gitignore'), /\.forge\/sync\//)
  const status = ctx.engine.statuses().find((s) => s.placeKey === MK)!
  assert.equal(status.projectFile, 'default.project.json')
  assert.equal(status.connected, true)
  ctx.engine.endSession(MK)
  assert.equal(ctx.engine.gate(MK), 'idle')
  assert.equal(placeKeyFor({ placeId: 0, name: 'Test' }), 'unpublished:Test')
  assert.deepEqual((await ctx.engine.configFor(MENU))!.roots.map((r) => r.join('.')).includes(`${SSS}.Server.Features.Skills.Moves`), true)
})

test('applyChanges before any snapshot asks for a resend', async () => {
  const ctx = await setup()
  await assert.rejects(ctx.engine.applyChanges(MK, []), SyncResendError)
  assert.throws(() => ctx.engine.addSnapshot(MK, []), SyncResendError)
})

// ---- the scenarios Forge Sync exists for ----

test("teammate's Team Create edit is captured before Rojo connects (pulled)", async () => {
  const ctx = await setup()
  await agreed(ctx)
  ctx.engine.endSession(MK)
  // Later: a teammate edited Catalog in Studio; Acid's disk still has the old copy.
  const newer = 'local Catalog = {}\n\nCatalog.list = { "Dash", "Guard" }\n\nreturn Catalog'
  const nodes = edit(studio(ctx), [...MOVES.slice(0, -1), 'Catalog'], { source: newer })
  const entries = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.deepEqual(actions(entries, 'pulled'), ['src/skills/Server/Catalog.luau'])
  assert.equal(get(ctx.root, 'src/skills/Server/Catalog.luau'), newer + '\n')
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test("menu Studio's stale copy does not overwrite a newer match edit (disk-ahead)", async () => {
  const ctx = await setup()
  await agreed(ctx)
  const newer = 'local Catalog = {}\nCatalog.list = { "Dash", "Blink" }\nreturn Catalog'
  const node = find(studio(ctx), [...MOVES.slice(0, -1), 'Catalog'])
  const pulled = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: newer } }])
  assert.deepEqual(actions(pulled, 'pulled'), ['src/skills/Server/Catalog.luau'])
  // The menu place still holds the old Catalog: its base says that is what it last agreed on.
  const menuNodes = studioFromDisk(ctx.root, ctx.menu).map((n) => (n.path.join('/') === [...MENU_MOVES.slice(0, -1), 'Catalog'].join('/') ? { ...n, source: 'local Catalog = {}\n\nCatalog.list = { "Dash" }\n\nreturn Catalog\n' } : n))
  ctx.engine.endSession(NK)
  const entries = await snapshot(ctx.engine, NK, MENU, menuNodes)
  assert.deepEqual(actions(entries, 'disk-ahead'), ['src/skills/Server/Catalog.luau'])
  assert.equal(get(ctx.root, 'src/skills/Server/Catalog.luau'), newer + '\n')
  assert.equal(ctx.engine.gate(NK), 'clear')
})

test('a new skill folder made in Studio becomes files plus Animations.model.json', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const base = [...MOVES, 'NewMove']
  const added = await ctx.engine.applyChanges(MK, [
    {
      kind: 'added',
      node: { id: 'n1', path: base, className: 'Folder' },
      descendants: [
        { id: 'n2', path: [...base, 'Config'], className: 'ModuleScript', source: 'return { damage = 5 }' },
        { id: 'n3', path: [...base, 'Server'], className: 'ModuleScript', source: 'return {}' },
        { id: 'n4', path: [...base, 'Animations'], className: 'Folder' },
        { id: 'n5', path: [...base, 'Animations', 'Swing'], className: 'Animation', properties: { AnimationId: 'rbxassetid://77' } },
        { id: 'n6', path: [...base, 'Animations', 'Recover'], className: 'Animation', properties: { AnimationId: 'rbxassetid://78' } }
      ]
    }
  ])
  const dir = 'src/skills/Server/Moves/NewMove'
  assert.deepEqual(actions(added, 'created'), [dir, `${dir}/Animations.model.json`, `${dir}/Config.luau`, `${dir}/Server.luau`])
  assert.equal(get(ctx.root, `${dir}/Config.luau`), 'return { damage = 5 }\n')
  const model = readModel(get(ctx.root, `${dir}/Animations.model.json`))
  assert.equal(model.className, 'Folder')
  assert.deepEqual(model.children.map((c) => [c.name, c.className, c.properties.AnimationId]), [['Recover', 'Animation', 'rbxassetid://78'], ['Swing', 'Animation', 'rbxassetid://77']])
  // The menu place maps the same Moves folder: its next snapshot without NewMove must not trash it
  // (no base for the menu place: Rojo will create it there).
  ctx.engine.endSession(NK)
  const menuNodes = studioFromDisk(ctx.root, ctx.menu).filter((n) => !n.path.includes('NewMove'))
  const menu = await snapshot(ctx.engine, NK, MENU, menuNodes)
  assert.ok(actions(menu, 'disk-ahead').includes(`${dir}/Config.luau`))
  assert.ok(existsSync(join(ctx.root, `${dir}/Config.luau`)))
  // A later property edit on one Animation rewrites the model file.
  const props = await ctx.engine.applyChanges(MK, [{ kind: 'props', node: { id: 'n5', path: [...base, 'Animations', 'Swing'], className: 'Animation', properties: { AnimationId: 'rbxassetid://99' } } }])
  assert.deepEqual(actions(props, 'pulled'), [`${dir}/Animations.model.json`])
  assert.match(get(ctx.root, `${dir}/Animations.model.json`), /rbxassetid:\/\/99/)
})

test('editing an existing PascalCase model keeps its style', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const path = [...MOVES, 'Dash', 'Animations', 'Left']
  const node = find(studio(ctx), path)
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'props', node: { ...node, properties: { AnimationId: 'rbxassetid://5555' } } }])
  assert.deepEqual(actions(entries, 'pulled'), ['src/skills/Server/Moves/Dash/Animations.model.json'])
  const text = get(ctx.root, 'src/skills/Server/Moves/Dash/Animations.model.json')
  assert.match(text, /"ClassName": "Animation"/)
  assert.match(text, /rbxassetid:\/\/5555/)
})

test('rename and move in Studio move the files and their bases', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const nodes = studio(ctx)
  const dash = find(nodes, [...SKILLS, 'Dash'])
  const renamed = await ctx.engine.applyChanges(MK, [{ kind: 'renamed', id: dash.id, from: dash.path, node: { ...dash, path: [...SKILLS, 'Sprint'] } }])
  assert.deepEqual(renamed.filter((e) => e.action === 'renamed').map((e) => [e.from, e.file]), [['src/skills/Definitions/Dash.luau', 'src/skills/Definitions/Sprint.luau']])
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Definitions/Dash.luau')))
  assert.equal(get(ctx.root, 'src/skills/Definitions/Sprint.luau'), 'return {\n\tname = "Dash",\n\tcooldown = 3,\n}\n')
  assert.deepEqual(actions(renamed, 'trashed'), [])

  // Move the whole Dash move folder into a new Archive folder.
  const moveDir = find(nodes, [...MOVES, 'Dash'])
  const moved = await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'arch', path: [...MOVES, 'Archive'], className: 'Folder' } },
    { kind: 'moved', id: moveDir.id, from: moveDir.path, node: { ...moveDir, path: [...MOVES, 'Archive', 'Dash'] } }
  ])
  assert.ok(moved.some((e) => e.action === 'renamed' && e.from === 'src/skills/Server/Moves/Dash' && e.file === 'src/skills/Server/Moves/Archive/Dash'))
  assert.ok(existsSync(join(ctx.root, 'src/skills/Server/Moves/Archive/Dash/Animations.model.json')))
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Server/Moves/Dash')))
  assert.deepEqual(actions(moved, 'trashed'), [])
  // Bases followed: a Studio edit to the moved Config is a plain pull, not a conflict.
  const config = { id: 'cfg', path: [...MOVES, 'Archive', 'Dash', 'Config'], className: 'ModuleScript', source: 'return { damage = 99 }' }
  const pulled = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: config }])
  assert.deepEqual(actions(pulled, 'pulled'), ['src/skills/Server/Moves/Archive/Dash/Config.luau'])
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a rename to an unsafe name is refused and keeps the old file', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const guard = find(studio(ctx), [...SKILLS, 'Guard'])
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'renamed', id: guard.id, from: guard.path, node: { ...guard, path: [...SKILLS, 'Guard/Block'] } }])
  assert.ok(entries.some((e) => e.action === 'unmapped' && /unsafe name/.test(e.note ?? '')))
  assert.ok(existsSync(join(ctx.root, 'src/skills/Definitions/Guard.luau')))
  assert.deepEqual(actions(entries, 'trashed'), [])
})

test('Studio delete moves the file to .forge/sync/trash; an edited disk copy becomes a conflict', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const guard = find(studio(ctx), [...SKILLS, 'Guard'])
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: guard.id, path: guard.path }])
  assert.deepEqual(actions(entries, 'trashed'), ['src/skills/Definitions/Guard.luau'])
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Definitions/Guard.luau')))
  const trash = join(ctx.root, '.forge/sync/trash')
  const [stamp] = readdirSync(trash)
  assert.equal(get(trash, `${stamp}/src/skills/Definitions/Guard.luau`), 'return { name = "Guard" }\n')

  // A deleted move folder whose Config was edited on disk: the rest is trashed, Config is held.
  put(ctx.root, 'src/skills/Server/Moves/Dash/Config.luau', 'return { damage = 11 }\n')
  const dash = find(studio(ctx), [...MOVES, 'Dash'])
  const del = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: dash.id, path: dash.path }])
  assert.deepEqual(actions(del, 'trashed'), ['src/skills/Server/Moves/Dash/Animations.model.json', 'src/skills/Server/Moves/Dash/Server.luau'])
  assert.deepEqual(actions(del, 'conflict'), ['src/skills/Server/Moves/Dash/Config.luau'])
  assert.equal(ctx.engine.conflicts(MK)[0].reason, 'deleted-vs-edited')
  assert.equal(ctx.engine.gate(MK), 'blocked')
  await ctx.engine.resolve(MK, 'src/skills/Server/Moves/Dash/Config.luau', 'disk')
  assert.equal(get(ctx.root, 'src/skills/Server/Moves/Dash/Config.luau'), 'return { damage = 11 }\n')
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('a full snapshot missing a file trashes it; a snapshot missing a whole root trashes nothing', async () => {
  const ctx = await setup()
  await agreed(ctx)
  ctx.engine.endSession(MK)
  const without = studio(ctx).filter((n) => n.path.join('/') !== [...SKILLS, 'Guard'].join('/'))
  const entries = await snapshot(ctx.engine, MK, MATCH, without)
  assert.deepEqual(actions(entries, 'trashed'), ['src/skills/Definitions/Guard.luau'])
  ctx.engine.endSession(MK)
  const noSkillsRoot = studio(ctx).filter((n) => !n.path.join('/').startsWith(MOVES.slice(0, -1).join('/')))
  const second = await snapshot(ctx.engine, MK, MATCH, noSkillsRoot)
  assert.deepEqual(actions(second, 'trashed'), [])
  assert.ok(existsSync(join(ctx.root, 'src/skills/Server/Catalog.luau')))
})

test('both changed: disjoint edits merge cleanly, overlapping edits conflict and block the gate', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const file = 'src/skills/Server/Moves/Dash/Config.luau'
  put(ctx.root, file, 'return {\n\tdamage = 12,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.4,\n}\n')
  const node = find(studio(ctx), [...MOVES, 'Dash', 'Config'])
  const merged = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: 'return {\n\tdamage = 10,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.6,\n}' } }])
  assert.deepEqual(actions(merged, 'merged'), [file])
  assert.equal(get(ctx.root, file), 'return {\n\tdamage = 12,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.6,\n}\n')
  assert.equal(ctx.engine.gate(MK), 'clear')
  // Rojo pushes the merge to Studio; Studio's next change equals the disk -> same.
  const same = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: get(ctx.root, file) } }])
  assert.deepEqual(actions(same, 'same'), [file])

  put(ctx.root, file, 'return {\n\tdamage = 13,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.6,\n}\n')
  const conflict = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: 'return {\n\tdamage = 14,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.6,\n}' } }])
  assert.deepEqual(actions(conflict, 'conflict'), [file])
  assert.equal(ctx.engine.gate(MK), 'blocked')
  const [info] = ctx.engine.conflicts()
  assert.equal(info.reason, 'both-changed')
  assert.match(info.base!, /damage = 12/)
  assert.match(info.disk, /damage = 13/)
  assert.match(info.studio, /damage = 14/)
  assert.match(get(ctx.root, file), /damage = 13/)
  await ctx.engine.resolve(MK, file, 'merged', 'return {\n\tdamage = 15,\n\trange = 4,\n\tspeed = 20,\n\tduration = 0.6,\n}\n')
  assert.match(get(ctx.root, file), /damage = 15/)
  assert.equal(ctx.engine.gate(MK), 'clear')
  assert.deepEqual(ctx.engine.conflicts(), [])
})

test('first run without bases: differences are first-run conflicts, resolveAll clears the gate', async () => {
  const ctx = await setup()
  const nodes = edit(edit(studio(ctx), [...SKILLS, 'Dash'], { source: 'return "studio dash"' }), [...SKILLS, 'Guard'], { source: 'return "studio guard"' })
  const entries = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.deepEqual(actions(entries, 'conflict'), ['src/skills/Definitions/Dash.luau', 'src/skills/Definitions/Guard.luau'])
  assert.ok(ctx.engine.conflicts(MK).every((c) => c.reason === 'first-run' && c.base === null))
  assert.equal(ctx.engine.gate(MK), 'blocked')
  assert.equal(await ctx.engine.resolveAll(MK, 'studio'), 2)
  assert.equal(get(ctx.root, 'src/skills/Definitions/Dash.luau'), 'return "studio dash"\n')
  assert.equal(ctx.engine.gate(MK), 'clear')

  // "Disk wins" on the menu place: disk untouched; the next snapshot says Rojo will push the disk.
  const menuNodes = edit(studioFromDisk(ctx.root, ctx.menu), [...MENU_MOVES, 'Dash', 'Server'], { source: 'return "menu studio"' })
  await snapshot(ctx.engine, NK, MENU, menuNodes)
  assert.equal(ctx.engine.gate(NK), 'blocked')
  await ctx.engine.resolveAll(NK, 'disk')
  assert.equal(ctx.engine.gate(NK), 'clear')
  assert.match(get(ctx.root, 'src/skills/Server/Moves/Dash/Server.luau'), /function Server.run/)
  ctx.engine.endSession(NK)
  const again = await snapshot(ctx.engine, NK, MENU, menuNodes)
  assert.deepEqual(actions(again, 'disk-ahead'), ['src/skills/Server/Moves/Dash/Server.luau'])
  assert.equal(ctx.engine.gate(NK), 'clear')
})

test('legacy .studio-sync/state.json is migrated: matching digests become full bases', async () => {
  const oldGuard = 'return { name = "Guard (old)" }\n'
  const ctx = await setup({
    before: (root) => {
      put(root, '.studio-sync/state.json', JSON.stringify({
        [`${MATCH_PLACE}|src/skills/Definitions/Dash.luau`]: hashText(get(root, 'src/skills/Definitions/Dash.luau')),
        'src/skills/Definitions/Guard.luau': hashText(oldGuard),
        'src/../../etc/passwd': hashText('x')
      }))
    }
  })
  // Dash: disk == legacy digest, Studio changed -> pulled.
  // Guard: legacy digest is of an older text (no content), disk and Studio both differ -> conflict, no base text.
  const nodes = edit(edit(studio(ctx), [...SKILLS, 'Dash'], { source: 'return "teammate"' }), [...SKILLS, 'Guard'], { source: 'return "studio guard"' })
  const entries = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.deepEqual(actions(entries, 'pulled'), ['src/skills/Definitions/Dash.luau'])
  assert.deepEqual(actions(entries, 'conflict'), ['src/skills/Definitions/Guard.luau'])
  const [c] = ctx.engine.conflicts(MK)
  assert.equal(c.reason, 'both-changed')
  assert.equal(c.base, null)
  // Migration runs once.
  const store = new BaseStore(ctx.root)
  assert.equal(await migrateLegacy(ctx.root, store, [MK]), 0)
})

test('init-file scripts: edits land in init.luau, a script with children becomes a directory', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const mc = find(studio(ctx), [...SKILLS, 'MatchController'])
  const pulled = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...mc, source: 'local MatchController = { v = 2 }\nreturn MatchController' } }])
  assert.deepEqual(actions(pulled, 'pulled'), ['src/skills/Client/init.luau'])
  const base = [...SKILLS, 'Combat']
  const added = await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'c1', path: base, className: 'ModuleScript', source: 'return "combat"' }, descendants: [{ id: 'c2', path: [...base, 'Hitbox'], className: 'ModuleScript', source: 'return "hitbox"' }, { id: 'c3', path: [...base, 'Runner'], className: 'Script', source: 'print(1)' }] }
  ])
  assert.deepEqual(actions(added, 'created'), ['src/skills/Definitions/Combat/Hitbox.luau', 'src/skills/Definitions/Combat/Runner.server.luau', 'src/skills/Definitions/Combat/init.luau'])
  // A Studio-made Script inside an existing server folder.
  const loop = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: { id: 'l1', path: [...MOVES, 'Dash', 'Loop'], className: 'Script', source: 'while true do task.wait() end', }, descendants: [{ id: 'l2', path: [...MOVES, 'Dash', 'Loop', 'Part'], className: 'ModuleScript', source: 'return 1' }] }])
  assert.deepEqual(actions(loop, 'created'), ['src/skills/Server/Moves/Dash/Loop/Part.luau', 'src/skills/Server/Moves/Dash/Loop/init.server.luau'])
})

test('RunContext scripts use .plugin, or .server plus a meta file', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const p = [...SKILLS]
  const entries = await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'r1', path: [...p, 'ClientRunner'], className: 'Script', runContext: 'Client', source: 'print("c")' } },
    { kind: 'added', node: { id: 'r2', path: [...p, 'Tool'], className: 'Script', runContext: 'Plugin', source: 'print("p")' } },
    { kind: 'added', node: { id: 'r3', path: [...p, 'Local'], className: 'LocalScript', source: 'print("l")' } }
  ])
  assert.deepEqual(actions(entries, 'created'), ['src/skills/Definitions/ClientRunner.meta.json', 'src/skills/Definitions/ClientRunner.server.luau', 'src/skills/Definitions/Local.client.luau', 'src/skills/Definitions/Tool.plugin.luau'])
  assert.deepEqual(JSON.parse(get(ctx.root, 'src/skills/Definitions/ClientRunner.meta.json')), { properties: { RunContext: 'Client' } })
  // Back to Legacy: the meta file drops RunContext.
  const back = await ctx.engine.applyChanges(MK, [{ kind: 'props', node: { id: 'r1', path: [...p, 'ClientRunner'], className: 'Script', source: 'print("c")' } }])
  assert.deepEqual(actions(back, 'pulled'), ['src/skills/Definitions/ClientRunner.meta.json'])
  assert.deepEqual(JSON.parse(get(ctx.root, 'src/skills/Definitions/ClientRunner.meta.json')), {})
  // A rename carries the adjacent meta file along.
  const rn = await ctx.engine.applyChanges(MK, [{ kind: 'renamed', id: 'r1', from: [...p, 'ClientRunner'], node: { id: 'r1', path: [...p, 'Runner2'], className: 'Script', runContext: 'Client', source: 'print("c")' } }])
  assert.deepEqual(rn.filter((e) => e.action === 'renamed').map((e) => e.file), ['src/skills/Definitions/Runner2.server.luau'])
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Definitions/ClientRunner.meta.json')))
  assert.deepEqual(actions(rn, 'pulled'), ['src/skills/Definitions/Runner2.meta.json'])
  assert.deepEqual(JSON.parse(get(ctx.root, 'src/skills/Definitions/Runner2.meta.json')), { properties: { RunContext: 'Client' } })
  assert.deepEqual(actions(rn, 'trashed'), [])
})

test('CRLF files stay CRLF; CRLF-only differences are not changes', async () => {
  const ctx = await setup({ before: (root) => put(root, 'src/skills/Definitions/Dash.luau', 'return {\r\n\tname = "Dash",\r\n}\r\n') })
  const entries = await snapshot(ctx.engine, MK, MATCH, studio(ctx).map((n) => (n.source ? { ...n, source: n.source.replace(/\r\n/g, '\n').replace(/\n$/, '') } : n)))
  assert.deepEqual(entries.filter((e) => e.action !== 'same' && e.action !== 'unmapped'), [])
  const node = find(studio(ctx), [...SKILLS, 'Dash'])
  const pulled = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: 'return {\n\tname = "Dash",\n\tcooldown = 5,\n}' } }])
  assert.deepEqual(actions(pulled, 'pulled'), ['src/skills/Definitions/Dash.luau'])
  assert.equal(get(ctx.root, 'src/skills/Definitions/Dash.luau'), 'return {\r\n\tname = "Dash",\r\n\tcooldown = 5,\r\n}\r\n')
})

test('unsafe instance names are refused, never written, and nothing outside the roots changes', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const before = listFiles(ctx.root, notForge)
  const bad = ['a/b', '..', 'x:y', 'trailing ', 'back\\slash', '.', 'init', 'Evil.server']
  const entries = await ctx.engine.applyChanges(MK, bad.map((name, i) => ({ kind: 'added' as const, node: { id: `u${i}`, path: [...SKILLS, name], className: 'ModuleScript', source: 'return "pwned"' }, descendants: [{ id: `v${i}`, path: [...SKILLS, name, 'Child'], className: 'ModuleScript', source: 'return 1' }] })))
  assert.equal(entries.filter((e) => e.action === 'unmapped' && /unsafe name/.test(e.note ?? '')).length, bad.length)
  assert.deepEqual(entries.filter((e) => e.action !== 'unmapped' && e.action !== 'same'), [])
  assert.deepEqual(listFiles(ctx.root, notForge), before)
  // Duplicate sibling names cannot both live on disk: both refused.
  const dup = await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'd1', path: [...SKILLS, 'Twin'], className: 'ModuleScript', source: 'return 1' } },
    { kind: 'added', node: { id: 'd2', path: [...SKILLS, 'twin'], className: 'ModuleScript', source: 'return 2' } }
  ])
  assert.equal(dup.filter((e) => e.note === 'duplicate sibling name').length, 2)
  assert.deepEqual(listFiles(ctx.root, notForge), before)
})

test('paths cannot escape: symlinked folders out of the project are refused', async () => {
  const outside = mkdtempSync(join(tmpdir(), 'forge-outside-'))
  roots.push(outside)
  const ctx = await setup({ before: (root) => symlinkSync(outside, join(root, 'src/skills/Definitions/Linked'), 'dir') })
  await agreed(ctx)
  const entries = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: { id: 'x', path: [...SKILLS, 'Linked', 'Payload'], className: 'ModuleScript', source: 'return 1' } }])
  assert.ok(entries.some((e) => e.action === 'unmapped' && /refus/.test(e.note ?? '')))
  assert.deepEqual(readdirSync(outside), [])
})

test('Packages, skip-listed folders and $ignoreUnknownInstances place content are left alone', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const before = listFiles(ctx.root, notForge)
  const entries = await ctx.engine.applyChanges(MK, [
    { kind: 'added', node: { id: 'p1', path: [RS, 'Packages', 'Evil'], className: 'ModuleScript', source: 'return 1' } },
    { kind: 'added', node: { id: 'p2', path: ['ServerStorage', 'Loot2'], className: 'ModuleScript', source: 'return 1' } },
    { kind: 'added', node: { id: 'p3', path: [RS, 'Shared', 'SpawnPart'], className: 'Part', properties: { Anchored: true } } }
  ])
  assert.deepEqual(entries.filter((e) => e.action !== 'unmapped' && e.action !== 'same'), [])
  assert.deepEqual(listFiles(ctx.root, notForge), before)
  // A script directly under the ignoreUnknown Shared root is still captured.
  const script = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: { id: 'p4', path: [RS, 'Shared', 'Modules', 'NewUtil'], className: 'ModuleScript', source: 'return 2' } }])
  assert.deepEqual(actions(script, 'created'), ['src/shared/Modules/NewUtil.luau'])
})

test('oversize scripts are never written or trashed', async () => {
  const ctx = await setup()
  await agreed(ctx)
  ctx.engine.endSession(MK)
  const nodes = edit(studio(ctx), [...SKILLS, 'Guard'], { source: undefined, oversize: true })
  const entries = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.ok(entries.some((e) => e.action === 'unmapped' && /oversize/.test(e.note ?? '')))
  assert.deepEqual(actions(entries, 'trashed'), [])
  assert.equal(get(ctx.root, 'src/skills/Definitions/Guard.luau'), 'return { name = "Guard" }\n')
})

test('writes are atomic (temp file + rename) and a failed write leaves the file intact', async () => {
  const writes: string[] = []
  const renames: [string, string][] = []
  let failRename = false
  const fs: SyncFs = {
    ...nodeFs,
    writeFile: (async (file: string, data: string, opts: unknown) => {
      writes.push(String(file))
      return nodeFs.writeFile(file, data, opts as 'utf8')
    }) as SyncFs['writeFile'],
    rename: (async (a: string, b: string) => {
      if (failRename && String(b).endsWith('Dash.luau')) throw new Error('disk full')
      renames.push([String(a), String(b)])
      return nodeFs.rename(a, b)
    }) as SyncFs['rename']
  }
  const ctx = await setup({ fs })
  await agreed(ctx)
  writes.length = 0
  renames.length = 0
  const node = find(studio(ctx), [...SKILLS, 'Dash'])
  await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: 'return "v2"' } }])
  const target = join(ctx.root, 'src/skills/Definitions/Dash.luau')
  const tmp = writes.find((w) => w.includes('Dash.luau'))!
  assert.match(tmp, /\.Dash\.luau\.\d+-[0-9a-f]+\.forge-tmp$/)
  assert.ok(renames.some(([a, b]) => a === tmp && b === target))
  assert.ok(!writes.includes(target))
  failRename = true
  const failed = await ctx.engine.applyChanges(MK, [{ kind: 'source', node: { ...node, source: 'return "v3"' } }])
  assert.ok(failed.some((e) => e.action === 'unmapped' && /disk full/.test(e.note ?? '')))
  assert.equal(get(ctx.root, 'src/skills/Definitions/Dash.luau'), 'return "v2"\n')
  assert.deepEqual(readdirSync(join(ctx.root, 'src/skills/Definitions')).filter((f) => f.endsWith('.forge-tmp')), [])
})

test('every file Forge writes stays inside mapped roots or .forge/sync', async () => {
  const ctx = await setup()
  const touched: string[] = []
  const nodes = studio(ctx)
  await snapshot(ctx.engine, MK, MATCH, edit(nodes, [...SKILLS, 'Dash'], { source: 'x' }))
  await ctx.engine.resolveAll(MK, 'studio')
  await ctx.engine.applyChanges(MK, [{ kind: 'added', node: { id: 'z', path: [...MOVES, 'Z'], className: 'Folder' }, descendants: [{ id: 'z1', path: [...MOVES, 'Z', 'A'], className: 'Animation' }] }])
  for (const f of listFiles(ctx.root)) touched.push(f)
  const allowed = (f: string): boolean => f.startsWith('.forge/sync/') || f.startsWith('src/') || f === '.gitignore' || f.endsWith('.project.json') || f.startsWith('tools/') || f.startsWith('Packages/')
  assert.deepEqual(touched.filter((f) => !allowed(f)), [])
  // And the project's own files outside src were not rewritten.
  assert.equal(JSON.parse(get(ctx.root, 'tools/studio-sync.json')).port, 34873)
})

test('empty Studio folders get a .gitkeep; it goes once the folder has children and comes back when it is empty', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const dir = 'src/skills/Server/Moves/NewMove'
  const keep = `${dir}/.gitkeep`
  const folder = { id: 'nm', path: [...MOVES, 'NewMove'], className: 'Folder' }
  // .gitkeep is not an instance.
  assert.equal(fromDisk(ctx.match, keep), null)

  const added = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: folder }])
  assert.ok(added.some((e) => e.action === 'created' && e.file === dir))
  assert.ok(added.some((e) => e.action === 'created' && e.file === keep))
  assert.equal(get(ctx.root, keep), '')
  // A full snapshot of the same Studio is a no-op (the .gitkeep is neither trashed nor rewritten).
  const nodes = [...studio(ctx).filter((n) => n.path.join('/') !== folder.path.join('/')), folder]
  const again = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.deepEqual(again.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
  assert.ok(existsSync(join(ctx.root, keep)))

  // A real child: the .gitkeep goes to the trash.
  const script = { id: 'nm1', path: [...folder.path, 'Config'], className: 'ModuleScript', source: 'return {}' }
  const child = await ctx.engine.applyChanges(MK, [{ kind: 'added', node: script }])
  assert.deepEqual(actions(child, 'created'), [`${dir}/Config.luau`])
  assert.deepEqual(actions(child, 'trashed'), [keep])
  assert.deepEqual(readdirSync(join(ctx.root, dir)), ['Config.luau'])

  // The last child deleted in Studio: script trashed, directory kept with a fresh .gitkeep.
  const removed = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: script.id, path: script.path }])
  assert.deepEqual(actions(removed, 'trashed'), [`${dir}/Config.luau`])
  assert.deepEqual(readdirSync(join(ctx.root, dir)), ['.gitkeep'])

  // The last child moved out to another folder: same.
  await ctx.engine.applyChanges(MK, [{ kind: 'added', node: script }])
  const moved = await ctx.engine.applyChanges(MK, [{ kind: 'moved', id: script.id, from: script.path, node: { ...script, path: [...MOVES, 'Dash', 'Extra'] } }])
  assert.ok(moved.some((e) => e.action === 'renamed' && e.file === 'src/skills/Server/Moves/Dash/Extra.luau'))
  assert.deepEqual(readdirSync(join(ctx.root, dir)), ['.gitkeep'])
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Server/Moves/Dash/.gitkeep')))

  // Renaming the empty folder carries the .gitkeep (and its base) along.
  const renamed = await ctx.engine.applyChanges(MK, [{ kind: 'renamed', id: folder.id, from: folder.path, node: { ...folder, path: [...MOVES, 'Later'] } }])
  assert.ok(renamed.some((e) => e.action === 'renamed' && e.file === 'src/skills/Server/Moves/Later'))
  assert.deepEqual(readdirSync(join(ctx.root, 'src/skills/Server/Moves/Later')), ['.gitkeep'])
  assert.ok(!existsSync(join(ctx.root, dir)))

  // The empty folder deleted in Studio: .gitkeep trashed and the directory pruned.
  const gone = await ctx.engine.applyChanges(MK, [{ kind: 'removed', id: folder.id, path: [...MOVES, 'Later'] }])
  assert.deepEqual(actions(gone, 'trashed'), ['src/skills/Server/Moves/Later/.gitkeep'])
  assert.ok(!existsSync(join(ctx.root, 'src/skills/Server/Moves/Later')))
  assert.equal(ctx.engine.gate(MK), 'clear')
})

test('an empty folder pulled from git (a .gitkeep without a base) is disk-ahead, not a Studio delete', async () => {
  const ctx = await setup()
  await agreed(ctx)
  put(ctx.root, 'src/skills/Server/Moves/FromGit/.gitkeep', '')
  const entries = await snapshot(ctx.engine, MK, MATCH, studio(ctx).filter((n) => n.path[n.path.length - 1] !== 'FromGit'))
  assert.deepEqual(actions(entries, 'disk-ahead'), ['src/skills/Server/Moves/FromGit/.gitkeep'])
  assert.deepEqual(actions(entries, 'trashed'), [])
  assert.ok(existsSync(join(ctx.root, 'src/skills/Server/Moves/FromGit/.gitkeep')))
  // Once Studio has it (Rojo created the Folder), it is a plain empty folder: nothing to do.
  const synced = await snapshot(ctx.engine, MK, MATCH, studio(ctx))
  assert.deepEqual(synced.filter((e) => !['same', 'unmapped'].includes(e.action)), [])
})

// ---- one file, several mounts / case-insensitive disks ----

test('a directory mounted twice in one place: an edit to one copy is pulled, not reverted by the stale copy', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-twice-'))
  roots.push(root)
  put(root, 'default.project.json', JSON.stringify({ name: 'X', servePlaceIds: [5], tree: { $className: 'DataModel', ReplicatedStorage: { Skills: { $path: 'src/skills' } }, ServerScriptService: { Skills: { $path: 'src/skills' } } } }))
  put(root, 'src/skills/A.luau', 'return 1\n')
  const engine = new SyncEngine({ root })
  const nodes = (a: string, b: string): StudioNode[] => [
    { id: '1', path: [RS, 'Skills'], className: 'Folder' },
    { id: '2', path: [RS, 'Skills', 'A'], className: 'ModuleScript', source: a },
    { id: '3', path: [SSS, 'Skills'], className: 'Folder' },
    { id: '4', path: [SSS, 'Skills', 'A'], className: 'ModuleScript', source: b }
  ]
  const place = { placeId: 5, name: 'X' }
  assert.deepEqual(actions(await snapshot(engine, '5', place, nodes('return 1', 'return 1')), 'same'), ['src/skills/A.luau'])
  // A teammate edits the Server copy; the Shared copy still has the old text.
  assert.deepEqual(actions(await snapshot(engine, '5', place, nodes('return 1', 'return 2')), 'pulled'), ['src/skills/A.luau'])
  assert.equal(get(root, 'src/skills/A.luau'), 'return 2\n')
  // Rojo pushed it to both; then the Shared copy is edited.
  assert.deepEqual(actions(await snapshot(engine, '5', place, nodes('return 3', 'return 2')), 'pulled'), ['src/skills/A.luau'])
  assert.equal(get(root, 'src/skills/A.luau'), 'return 3\n')
  // Both copies edited differently: held, nothing written.
  const both = await snapshot(engine, '5', place, nodes('return 4', 'return 5'))
  assert.deepEqual(actions(both, 'conflict'), ['src/skills/A.luau'])
  assert.equal(get(root, 'src/skills/A.luau'), 'return 3\n')
  assert.equal(engine.gate('5'), 'blocked')
})

// A case-insensitive view of a real directory (like NTFS / APFS): a path resolves to the existing entry
// whatever its case; a rename keeps the new spelling.
function caseInsensitiveFs(): SyncFs {
  const real = (p: string): string => {
    const parts = p.split(sep)
    let cur = parts[0] || sep
    for (let i = 1; i < parts.length; i++) {
      let names: string[] = []
      try {
        names = readdirSync(cur)
      } catch {
        // missing
      }
      const hit = names.find((n) => n === parts[i]) ?? names.find((n) => n.toLowerCase() === parts[i].toLowerCase())
      cur = join(cur, hit ?? parts[i])
    }
    return cur
  }
  const f = nodeFs as unknown as Record<string, (...args: unknown[]) => unknown>
  const wrap = (name: string) => (p: string, ...rest: unknown[]) => f[name](real(p), ...rest)
  const out: Record<string, unknown> = {}
  for (const name of ['readFile', 'writeFile', 'mkdir', 'readdir', 'stat', 'lstat', 'rm', 'rmdir', 'realpath']) out[name] = wrap(name)
  out.rename = (a: string, b: string) => nodeFs.rename(real(a), join(real(dirname(b)), basename(b)))
  return out as unknown as SyncFs
}

test('case-only renames in Studio on a case-insensitive disk rename the files instead of trashing them', async () => {
  const ctx = await setup({ fs: caseInsensitiveFs() })
  const nodes = studio(ctx)
  await snapshot(ctx.engine, MK, MATCH, nodes)
  // Renamed while Forge was not watching (a teammate in Team Create): only the next snapshot shows it.
  const renamed = nodes.map((n) => {
    const p = [...n.path]
    if (startsWithPath(p, [...SKILLS, 'Dash'])) p[SKILLS.length] = 'dash'
    if (startsWithPath(p, [...MOVES, 'Dash'])) p[MOVES.length] = 'DASH'
    return { ...n, path: p }
  })
  const entries = await snapshot(ctx.engine, MK, MATCH, renamed)
  assert.deepEqual(actions(entries, 'trashed'), [])
  assert.deepEqual(actions(entries, 'created'), [])
  assert.deepEqual(actions(entries, 'renamed'), ['src/skills/Definitions/dash.luau', 'src/skills/Server/Moves/DASH/Animations.model.json', 'src/skills/Server/Moves/DASH/Config.luau', 'src/skills/Server/Moves/DASH/Server.luau'])
  assert.deepEqual(readdirSync(join(ctx.root, 'src/skills/Definitions')).sort(), ['Guard.luau', 'dash.luau'])
  assert.deepEqual(readdirSync(join(ctx.root, 'src/skills/Server/Moves')), ['DASH'])
  assert.deepEqual(readdirSync(join(ctx.root, 'src/skills/Server/Moves/DASH')).sort(), ['Animations.model.json', 'Config.luau', 'Server.luau'])
  // Settled: the next snapshot changes nothing.
  const again = await snapshot(ctx.engine, MK, MATCH, renamed)
  assert.deepEqual(again.filter((e) => e.action !== 'same' && e.action !== 'unmapped'), [])
})

test('a case-only difference this place never synced (renamed on disk) is left for Rojo', async () => {
  const ctx = await setup({ fs: caseInsensitiveFs() })
  const nodes = studio(ctx).map((n) => (startsWithPath(n.path, [...SKILLS, 'Dash']) ? { ...n, path: [...SKILLS, 'DASH'] } : n))
  const entries = await snapshot(ctx.engine, MK, MATCH, nodes)
  assert.deepEqual(actions(entries, 'trashed'), [])
  assert.ok(entries.some((e) => e.file === 'src/skills/Definitions/Dash.luau' && e.action === 'disk-ahead'))
  assert.ok(existsSync(join(ctx.root, 'src/skills/Definitions/Dash.luau')))
})

function startsWithPath(path: string[], prefix: string[]): boolean {
  return prefix.length <= path.length && prefix.every((p, i) => path[i] === p)
}
