// Studio-only scripts Forge Sync has not put on disk (bug report: GenTree, 0.6.1-quick.7). Studio had
// StarterPlayerScripts.Client.Controllers.OnboardingController.WakeUpCutscene (a ModuleScript with
// child ModuleScripts, one of them with its own child) while the disk did not, the Forge Sync gate was
// 'clear', and Rojo's connect offered to delete WakeUpCutscene from Studio.
//
// Forge writes such a module as soon as it sees it (first tests). What let it through was a base that
// said "Studio and disk agreed on this file" while the file was gone from disk: the engine read that as
// "deleted on disk, Rojo will push the delete" and cleared the gate. "Disk wins" on the first sync
// leaves exactly that for every script only Studio has; so does a git checkout / branch switch or a
// delete on disk while Studio was closed. Now every such script is listed, holds rojo serve when a
// snapshot (or a resolve) finds it, and "Pull to disk" writes it.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { gateDetail, SyncService } from '../src/main/services/sync/service.ts'
import { syncSummary } from '../src/main/services/sync/wire.ts'
import { run } from '../src/main/services/tools.ts'
import type { GateState, StudioNode, SyncEntry, SyncStatus } from '../src/shared/sync/types.ts'
import { put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const KEY = '7001'
const PLACE = { placeId: 7001, name: 'GenTree' }
const CLIENT = ['StarterPlayer', 'StarterPlayerScripts', 'Client']
const CONTROLLERS = [...CLIENT, 'Controllers']
const ONBOARDING = [...CONTROLLERS, 'OnboardingController']
const WAKE = [...ONBOARDING, 'WakeUpCutscene']
const DIR = 'src/client/Controllers/OnboardingController'
const WAKE_DIR = `${DIR}/WakeUpCutscene`
const WAKE_CHILDREN = ['Body', 'Lens', 'Motion', 'Overlay', 'Props', 'Sfx', 'Title']
// What Forge must write for WakeUpCutscene and its subtree.
const WAKE_FILES = [`${WAKE_DIR}/init.luau`, ...WAKE_CHILDREN.map((n) => (n === 'Props' ? `${WAKE_DIR}/Props/init.luau` : `${WAKE_DIR}/${n}.luau`)), `${WAKE_DIR}/Props/Toon.luau`].sort()

// The GenTree template's project file (every root $ignoreUnknownInstances) and the controllers around
// WakeUpCutscene: OnboardingController is a folder module with siblings that have children of their own.
function gentree(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-studio-only-'))
  roots.push(root)
  put(root, 'default.project.json', readFileSync(join(import.meta.dirname, 'fixtures', 'template', 'default.project.json'), 'utf8').replace('"name": "GenTree",', `"name": "GenTree",\n  "servePlaceIds": [${PLACE.placeId}],`))
  put(root, 'src/shared/Modules/ModuleLoader.luau', 'return {}\n')
  put(root, 'src/server/Features/.gitkeep', '')
  put(root, 'src/ServerStorage/.gitkeep', '')
  put(root, 'src/client/init.client.luau', 'require(script.Controllers.OnboardingController)\n')
  put(root, 'src/client/Controllers/DayNightController.luau', 'return { cycle = 600 }\n')
  put(root, `${DIR}/init.luau`, 'local Onboarding = {}\nreturn Onboarding\n')
  put(root, `${DIR}/ArrowTrail.luau`, 'return "arrow"\n')
  put(root, `${DIR}/CameraGuide.luau`, 'return "camera"\n')
  put(root, `${DIR}/Dialogue.luau`, 'return "dialogue"\n')
  put(root, `${DIR}/Guidance/init.luau`, 'return "guidance"\n')
  put(root, `${DIR}/Guidance/Steps.luau`, 'return { 1, 2 }\n')
  put(root, `${DIR}/TrainerCutscene/init.luau`, 'return "trainer"\n')
  put(root, `${DIR}/TrainerCutscene/Shots.luau`, 'return { "wide" }\n')
  return root
}

// WakeUpCutscene as Studio has it: a ModuleScript under the ModuleScript OnboardingController, with
// child ModuleScripts, Props holding Toon.
function wakeUp(tag = ''): StudioNode[] {
  const out: StudioNode[] = [{ id: 'wake', path: WAKE, className: 'ModuleScript', source: `local WakeUp = {}${tag}\nreturn WakeUp\n` }]
  for (const n of WAKE_CHILDREN) out.push({ id: `wake-${n}`, path: [...WAKE, n], className: 'ModuleScript', source: `return "${n}"\n` })
  out.push({ id: 'wake-toon', path: [...WAKE, 'Props', 'Toon'], className: 'ModuleScript', source: 'return "toon"\n' })
  return out
}

async function setup() {
  const root = gentree()
  const engine = new SyncEngine({ root })
  const [map] = await engine.places()
  const disk = () => studioFromDisk(root, map)
  const snapshot = async (nodes: StudioNode[]): Promise<SyncEntry[]> => {
    engine.beginSnapshot(KEY, PLACE)
    for (let i = 0; i < nodes.length; i += 5) engine.addSnapshot(KEY, nodes.slice(i, i + 5))
    return engine.finishSnapshot(KEY)
  }
  return { root, engine, disk, snapshot }
}

// The place agreed with the disk once (bases exist); Studio then has WakeUpCutscene too.
async function agreed(ctx: Awaited<ReturnType<typeof setup>>): Promise<void> {
  await ctx.snapshot(ctx.disk())
  assert.equal(await ctx.engine.resolveAll(KEY, 'studio'), 0)
  ctx.engine.endSession(KEY)
  await ctx.snapshot(ctx.disk())
  assert.equal(ctx.engine.gate(KEY), 'clear')
}

const files = (entries: SyncEntry[], action: string): string[] => entries.filter((e) => e.action === action).map((e) => e.file).sort()
const onDisk = (root: string, rel: string): boolean => existsSync(join(root, rel))
const studioOnlyPaths = (engine: SyncEngine): string[] => engine.studioOnly(KEY).items.map((i) => i.instancePath.slice(ONBOARDING.length).join('/'))

test('a Studio-only module with child modules under a folder module is written (snapshot)', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const entries = await ctx.snapshot([...ctx.disk(), ...wakeUp()])
  assert.deepEqual(files(entries, 'created'), WAKE_FILES)
  for (const f of WAKE_FILES) assert.ok(onDisk(ctx.root, f), f)
  assert.equal(readFileSync(join(ctx.root, `${WAKE_DIR}/Props/Toon.luau`), 'utf8'), 'return "toon"\n')
  assert.equal(ctx.engine.gate(KEY), 'clear')
  assert.deepEqual(ctx.engine.studioOnly(KEY), { items: [], holds: false })
})

test('a Studio-only module with children is written from the change stream, in one change or piece by piece', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const [wake, ...rest] = wakeUp()
  // A paste: one 'added' with every descendant.
  const pasted = await ctx.engine.applyChanges(KEY, [{ kind: 'added', node: wake, descendants: rest }])
  assert.deepEqual(files(pasted, 'created'), WAKE_FILES)
  assert.equal(ctx.engine.gate(KEY), 'clear')

  // Built by hand in Studio: the module first (a single file), then each child (it becomes a folder).
  const ctx2 = await setup()
  await agreed(ctx2)
  const single = await ctx2.engine.applyChanges(KEY, [{ kind: 'added', node: wake }])
  assert.deepEqual(files(single, 'created'), [`${DIR}/WakeUpCutscene.luau`])
  for (const n of rest) await ctx2.engine.applyChanges(KEY, [{ kind: 'added', node: n }])
  for (const f of WAKE_FILES) assert.ok(onDisk(ctx2.root, f), f)
  assert.ok(!onDisk(ctx2.root, `${DIR}/WakeUpCutscene.luau`), 'the single-file form went to the trash')
  assert.ok(!onDisk(ctx2.root, `${WAKE_DIR}/Props.luau`))
  assert.equal(ctx2.engine.gate(KEY), 'clear')
  assert.deepEqual(studioOnlyPaths(ctx2.engine), [])
})

test('a single-file parent module that gets a Studio-only child module tree becomes a folder module', async () => {
  const ctx = await setup()
  await agreed(ctx)
  // OnboardingController was a single file on disk: OnboardingController.luau.
  rmSync(join(ctx.root, DIR), { recursive: true })
  put(ctx.root, `${DIR}.luau`, 'local Onboarding = {}\nreturn Onboarding\n')
  ctx.engine.endSession(KEY)
  const nodes = ctx.disk()
  await ctx.snapshot(nodes)
  const entries = await ctx.snapshot([...nodes, ...wakeUp()])
  assert.deepEqual(files(entries, 'created'), [`${DIR}/init.luau`, ...WAKE_FILES].sort())
  assert.deepEqual(files(entries, 'trashed'), [`${DIR}.luau`])
  // Its base from the folder form (an older commit) did not read as "deleted on disk".
  assert.equal(entries.find((e) => e.file === `${DIR}/init.luau`)?.note, `form changed in Studio (was ${DIR}.luau)`)
  assert.equal(ctx.engine.gate(KEY), 'clear')
  assert.deepEqual(studioOnlyPaths(ctx.engine), [])
  // Studio removes WakeUpCutscene again: its files go to the trash, OnboardingController keeps its
  // init file (Rojo builds the same ModuleScript from it).
  const removed = await ctx.engine.applyChanges(KEY, [{ kind: 'removed', id: 'wake', path: WAKE }])
  assert.deepEqual(files(removed, 'trashed'), WAKE_FILES)
  assert.ok(onDisk(ctx.root, `${DIR}/init.luau`))
  assert.equal(ctx.engine.gate(KEY), 'clear')
  assert.deepEqual(studioOnlyPaths(ctx.engine), [])
})

test('regression: "Disk wins" on the first sync no longer lets Rojo delete scripts only Studio has; Pull to disk writes them', async () => {
  const ctx = await setup()
  // A newly linked place (no shared version yet): Studio has WakeUpCutscene and an edited controller.
  const studio = [...ctx.disk().map((n) => (n.path.join('/') === [...CONTROLLERS, 'DayNightController'].join('/') ? { ...n, source: 'return { cycle = 900 }\n' } : n)), ...wakeUp()]
  const first = await ctx.snapshot(studio)
  assert.equal(files(first, 'conflict').length, WAKE_FILES.length + 1)
  assert.equal(ctx.engine.gate(KEY), 'blocked')
  // Acid picks "Disk wins" (the repo is the truth). The edited controller: disk version kept, Rojo
  // pushes it. WakeUpCutscene has no disk version: before the fix the gate cleared here and Rojo's
  // connect offered to delete it from Studio.
  await ctx.engine.resolveAll(KEY, 'disk', 'first-run')
  assert.equal(ctx.engine.conflicts(KEY).length, 0)
  assert.equal(ctx.engine.gate(KEY), 'blocked', 'rojo stays held for the Studio-only scripts')
  const only = ctx.engine.studioOnly(KEY)
  assert.equal(only.holds, true)
  assert.deepEqual(only.items.map((i) => i.file).sort(), WAKE_FILES)
  assert.ok(only.items.every((i) => i.canPull && /removed from disk|"Disk"/.test(i.reason)), JSON.stringify(only.items[0]))
  assert.deepEqual(only.items[0].instancePath, WAKE)
  for (const f of WAKE_FILES) assert.ok(!onDisk(ctx.root, f))

  // Studio restarts before anyone acts: still held (the base says "agreed", the disk has nothing).
  ctx.engine.endSession(KEY)
  const again = await ctx.snapshot(studio)
  assert.deepEqual(files(again, 'disk-ahead').filter((f) => f.startsWith(WAKE_DIR)), WAKE_FILES)
  assert.equal(ctx.engine.gate(KEY), 'blocked')
  assert.equal(ctx.engine.studioOnly(KEY).items.length, WAKE_FILES.length)

  // Pull to disk: Studio's copies written, gate clear, nothing left for Rojo to delete.
  const pulled = await ctx.engine.pullStudioOnly(KEY)
  assert.deepEqual(files(pulled, 'created'), WAKE_FILES)
  assert.ok(pulled.every((e) => e.action !== 'created' || e.note === 'pulled to disk (only Studio had it)'))
  assert.equal(readFileSync(join(ctx.root, `${WAKE_DIR}/init.luau`), 'utf8'), 'local WakeUp = {}\nreturn WakeUp\n')
  assert.equal(ctx.engine.gate(KEY), 'clear')
  assert.deepEqual(ctx.engine.studioOnly(KEY), { items: [], holds: false })
  // The disk-wins choice for the edited controller stands.
  assert.equal(readFileSync(join(ctx.root, 'src/client/Controllers/DayNightController.luau'), 'utf8'), 'return { cycle = 600 }\n')
  // And the next Studio session agrees with the disk on WakeUpCutscene.
  ctx.engine.endSession(KEY)
  const later = await ctx.snapshot(studio)
  assert.deepEqual(later.filter((e) => e.file.startsWith(WAKE_DIR) && e.action !== 'same'), [])
})

test('regression: scripts the disk lost since the last sync (git checkout, delete while Studio was closed) hold rojo until pulled or served anyway', async () => {
  const ctx = await setup()
  await agreed(ctx)
  await ctx.snapshot([...ctx.disk(), ...wakeUp()])
  for (const f of WAKE_FILES) assert.ok(onDisk(ctx.root, f))
  // A branch switch without WakeUpCutscene while Studio was closed.
  ctx.engine.endSession(KEY)
  rmSync(join(ctx.root, WAKE_DIR), { recursive: true })
  const entries = await ctx.snapshot([...ctx.disk(), ...wakeUp()])
  assert.deepEqual(files(entries, 'disk-ahead'), WAKE_FILES)
  assert.equal(ctx.engine.gate(KEY), 'blocked')
  assert.deepEqual(studioOnlyPaths(ctx.engine), ['WakeUpCutscene', 'WakeUpCutscene/Body', 'WakeUpCutscene/Lens', 'WakeUpCutscene/Motion', 'WakeUpCutscene/Overlay', 'WakeUpCutscene/Props', 'WakeUpCutscene/Props/Toon', 'WakeUpCutscene/Sfx', 'WakeUpCutscene/Title'])
  // Deleting it in Studio (what serving anyway and accepting Rojo's patch does) clears the list.
  const removed = await ctx.engine.applyChanges(KEY, [{ kind: 'removed', id: 'wake', path: WAKE }])
  assert.deepEqual(files(removed, 'trashed'), [])
  assert.deepEqual(ctx.engine.studioOnly(KEY), { items: [], holds: false })
  assert.equal(ctx.engine.gate(KEY), 'clear')
})

test('during a live session a file deleted on disk is listed but does not stop rojo; a snapshot holds it', async () => {
  const ctx = await setup()
  await agreed(ctx)
  await ctx.snapshot([...ctx.disk(), ...wakeUp()])
  // Rojo is serving; the agent deletes Lens.luau and an unrelated Studio edit arrives before Rojo's
  // delete reaches Studio.
  rmSync(join(ctx.root, `${WAKE_DIR}/Lens.luau`))
  const edit = await ctx.engine.applyChanges(KEY, [{ kind: 'source', node: { id: 'wake-Body', path: [...WAKE, 'Body'], className: 'ModuleScript', source: 'return "body 2"\n' } }])
  assert.deepEqual(files(edit, 'pulled'), [`${WAKE_DIR}/Body.luau`])
  assert.deepEqual(studioOnlyPaths(ctx.engine), ['WakeUpCutscene/Lens'])
  assert.equal(ctx.engine.studioOnly(KEY).holds, false)
  assert.equal(ctx.engine.gate(KEY), 'clear')
  // Rojo's delete reaches Studio: gone from the list.
  await ctx.engine.applyChanges(KEY, [{ kind: 'removed', id: 'wake-Lens', path: [...WAKE, 'Lens'] }])
  assert.deepEqual(studioOnlyPaths(ctx.engine), [])
})

test('Studio-only scripts Forge cannot write are listed (not pullable); Rojo-ignored ones are not', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const big: StudioNode = { id: 'big', path: [...ONBOARDING, 'Huge'], className: 'ModuleScript', oversize: true }
  const unsafe: StudioNode = { id: 'bad', path: [...ONBOARDING, 'init'], className: 'ModuleScript', source: 'return 1' }
  const twinA: StudioNode = { id: 'ta', path: [...ONBOARDING, 'Twin'], className: 'ModuleScript', source: 'return 1' }
  const twinB: StudioNode = { id: 'tb', path: [...ONBOARDING, 'twin'], className: 'ModuleScript', source: 'return 2' }
  const underUnsafe: StudioNode = { id: 'bad-kid', path: [...ONBOARDING, 'init', 'Kid'], className: 'ModuleScript', source: 'return 3' }
  // Directly under the $ignoreUnknownInstances Client root: Rojo leaves it in Studio.
  const loose: StudioNode = { id: 'loose', path: [...CLIENT, 'Bad:Name'], className: 'LocalScript', source: 'print(1)' }
  await ctx.snapshot([...ctx.disk(), big, unsafe, twinA, twinB, underUnsafe, loose])
  const only = ctx.engine.studioOnly(KEY)
  assert.deepEqual(only.items.map((i) => i.instancePath.slice(ONBOARDING.length).join('/')), ['Huge', 'init', 'init/Kid'])
  assert.ok(only.items.every((i) => !i.canPull && !i.file))
  assert.match(only.items.find((i) => i.instancePath.at(-1) === 'Huge')!.reason, /too large/)
  assert.match(only.items.find((i) => i.instancePath.at(-1) === 'Kid')!.reason, /unsafe name/)
  // Same-name twins are a duplicate conflict (Studio's side and disk's), not a Studio-only item.
  assert.deepEqual(ctx.engine.conflicts(KEY).map((c) => [c.reason, c.copies]), [['duplicate', 2]])
  assert.equal(ctx.engine.gate(KEY), 'blocked')
  // Nothing to pull; renaming in Studio fixes it.
  assert.deepEqual(await ctx.engine.pullStudioOnly(KEY), [])
  await ctx.engine.applyChanges(KEY, [
    { kind: 'removed', id: 'big', path: big.path },
    { kind: 'renamed', id: 'bad', from: unsafe.path, node: { ...unsafe, path: [...ONBOARDING, 'Intro'] } },
    { kind: 'removed', id: 'tb', path: twinB.path }
  ])
  assert.ok(onDisk(ctx.root, `${DIR}/Intro/init.luau`) && onDisk(ctx.root, `${DIR}/Intro/Kid.luau`))
  // The twin left behind is written once the other one is gone.
  assert.ok(onDisk(ctx.root, `${DIR}/Twin.luau`))
  assert.deepEqual(ctx.engine.studioOnly(KEY), { items: [], holds: false })
  assert.equal(ctx.engine.gate(KEY), 'clear')
  // An oversize script whose file is on disk is not Studio-only.
  ctx.engine.endSession(KEY)
  await ctx.snapshot(ctx.disk().map((n) => (n.path.at(-1) === 'Dialogue' ? { ...n, source: undefined, oversize: true as const } : n)))
  assert.deepEqual(ctx.engine.studioOnly(KEY).items, [])
})

// Studio's Ctrl+D copies an instance under the same name (children included). Two siblings then share
// every path below them; the engine tells their subtrees apart by parent ids (the plugin sends nodes
// depth first), so a rename or delete of one carries exactly its own children.
test('a Ctrl+D copy of a module with children: renaming the copy carries its own children, deleting it leaves the original', async () => {
  const ctx = await setup()
  await agreed(ctx)
  const TRAINER = [...ONBOARDING, 'TrainerCutscene']
  const copy: StudioNode = { id: 'copy', path: TRAINER, className: 'ModuleScript', source: 'return "trainer"\n' }
  const copyShots: StudioNode = { id: 'copy-shots', path: [...TRAINER, 'Shots'], className: 'ModuleScript', source: 'return { "wide" }\n' }
  // Pasted: same name as the original, held as a duplicate conflict (rojo waits: it would delete one
  // copy on connect); the original's files stay.
  const pasted = await ctx.engine.applyChanges(KEY, [{ kind: 'added', node: copy, descendants: [copyShots] }])
  assert.deepEqual(files(pasted, 'trashed'), [])
  assert.ok(pasted.some((e) => e.action === 'conflict' && /2 ModuleScripts named TrainerCutscene/.test(e.note ?? '')))
  assert.equal(ctx.engine.gate(KEY), 'blocked')
  // Renamed: the copy and ITS Shots move to WakeUpCutscene; the original's Shots stays.
  const renamed = await ctx.engine.applyChanges(KEY, [{ kind: 'renamed', id: 'copy', from: TRAINER, node: { ...copy, path: WAKE } }])
  assert.deepEqual(files(renamed, 'created'), [`${WAKE_DIR}/Shots.luau`, `${WAKE_DIR}/init.luau`])
  assert.equal(readFileSync(join(ctx.root, `${DIR}/TrainerCutscene/Shots.luau`), 'utf8'), 'return { "wide" }\n')
  // Edits on either side land in their own file.
  const original = ctx.disk().find((n) => n.path.join('/') === [...TRAINER, 'Shots'].join('/'))!
  await ctx.engine.applyChanges(KEY, [
    { kind: 'source', node: { ...original, source: 'return { "close" }\n' } },
    { kind: 'source', node: { ...copyShots, path: [...WAKE, 'Shots'], source: 'return { "dawn" }\n' } }
  ])
  assert.equal(readFileSync(join(ctx.root, `${DIR}/TrainerCutscene/Shots.luau`), 'utf8'), 'return { "close" }\n')
  assert.equal(readFileSync(join(ctx.root, `${WAKE_DIR}/Shots.luau`), 'utf8'), 'return { "dawn" }\n')
  assert.equal(ctx.engine.gate(KEY), 'clear')
  assert.deepEqual(studioOnlyPaths(ctx.engine), [])

  // The same from a snapshot (both copies present, depth first), then the copy is deleted.
  ctx.engine.endSession(KEY)
  const underWake = (n: StudioNode) => n.path.length >= WAKE.length && WAKE.every((x, i) => n.path[i] === x)
  const snap = await ctx.snapshot([...ctx.disk().filter((n) => !underWake(n)), copy, copyShots])
  assert.ok(!files(snap, 'trashed').some((f) => f.includes('TrainerCutscene')), JSON.stringify(files(snap, 'trashed')))
  const removed = await ctx.engine.applyChanges(KEY, [{ kind: 'removed', id: 'copy', path: TRAINER }])
  assert.deepEqual(files(removed, 'trashed'), [])
  assert.ok(onDisk(ctx.root, `${DIR}/TrainerCutscene/Shots.luau`))
  // The original is writable again (no twin): an edit to its Shots is pulled.
  const later = await ctx.engine.applyChanges(KEY, [{ kind: 'source', node: { ...original, source: 'return { "far" }\n' } }])
  assert.deepEqual(files(later, 'pulled'), [`${DIR}/TrainerCutscene/Shots.luau`])
})

test('gate detail and status summary name the Studio-only scripts', () => {
  assert.equal(gateDetail('blocked', 0, 9), '9 Studio-only scripts not on disk: pull to disk or serve anyway')
  assert.equal(gateDetail('blocked', 2, 1), '2 conflicts, 1 Studio-only script not on disk: resolve, pull to disk or serve anyway')
  assert.equal(gateDetail('blocked', 1), '1 conflict: resolve or serve anyway')
  const status: SyncStatus = { engine: 'forge', recent: [], pendingStudioEdits: [], places: [{ placeKey: KEY, projectFile: 'default.project.json', gate: 'blocked', connected: true, counts: {}, conflicts: 0, studioOnly: { count: 9, pullable: 9, holds: true, items: [] } }] }
  assert.equal(syncSummary(status).detail, 'Forge Sync: 9 Studio-only scripts not on disk')
})

// The same flow through the Forge Bridge's /sync routes and the SyncService (what the plugin and the
// Sync view do): snapshot, "Disk wins", rojo stays held, "Pull to disk", rojo serves.
test('e2e: a Studio-only module tree holds rojo after "Disk wins" until Pull to disk', async () => {
  const root = gentree()
  execFileSync('git', ['init', '-q'], { cwd: root })
  const gates: [string, GateState, string | undefined][] = []
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: (args) => run('git', args, root),
    pluginsDir: () => null,
    onGate: (file, gate, detail) => gates.push([file, gate, detail]),
    emit: () => undefined
  })
  await service.start()
  const bridge = new StudioBridge({ port: 0, holdMs: 50 })
  await bridge.start()
  bridge.setSyncHandler(service.handler)
  const base = `http://127.0.0.1:${bridge.port}/forge-bridge/sync`
  const settle = () => new Promise((r) => setTimeout(r, 20))
  try {
    const cfg = (await (await fetch(`${base}/config?placeId=${PLACE.placeId}&gameId=9&place=GenTree`)).json()) as { enabled: boolean; sessionToken: string }
    assert.equal(cfg.enabled, true)
    const [map] = await loadPlaces(root)
    const short = (id: string) => createHash('sha1').update(id).digest('hex').slice(0, 12)
    const nodes = [...studioFromDisk(root, map), ...wakeUp()].map((n) => ({ ...n, id: short(n.id) }))
    for (let i = 0, seq = 0; i < nodes.length; i += 6, seq++) {
      const body = { session: cfg.sessionToken, place: { placeId: PLACE.placeId, gameId: 9 }, seq, final: i + 6 >= nodes.length, nodes: nodes.slice(i, i + 6) }
      const answer = (await (await fetch(`${base}/snapshot`, { method: 'POST', body: JSON.stringify(body) })).json()) as { ok: boolean }
      assert.equal(answer.ok, true)
    }
    await settle()
    assert.equal(gates.at(-1)?.[1], 'blocked')
    await service.resolveAll(KEY, 'disk', 'first-run')
    await settle()
    let status = await service.status()
    let place = status.places.find((p) => p.placeKey === KEY)!
    assert.equal(place.gate, 'blocked')
    assert.deepEqual({ count: place.studioOnly?.count, pullable: place.studioOnly?.pullable, holds: place.studioOnly?.holds }, { count: WAKE_FILES.length, pullable: WAKE_FILES.length, holds: true })
    assert.deepEqual(gates.at(-1), ['default.project.json', 'blocked', `${WAKE_FILES.length} Studio-only scripts not on disk: pull to disk or serve anyway`])
    status = await service.pullStudioOnly(KEY)
    await settle()
    place = status.places.find((p) => p.placeKey === KEY)!
    assert.equal(place.gate, 'clear')
    assert.equal(place.studioOnly, undefined)
    assert.equal(gates.at(-1)?.[1], 'clear')
    for (const f of WAKE_FILES) assert.ok(onDisk(root, f), f)
    // Forge wrote them from Studio: listed as Studio edits to commit.
    assert.deepEqual(status.pendingStudioEdits.filter((f) => f.startsWith(WAKE_DIR)).sort(), WAKE_FILES)
    assert.ok(status.recent.some((e) => e.file === `${WAKE_DIR}/init.luau` && e.action === 'created'))
  } finally {
    await bridge.stop()
    service.close()
  }
})
