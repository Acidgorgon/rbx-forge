// Forge Sync must never write a stale Studio copy over a newer disk file. Shaped like Acid's FSF Menu
// place on 2026-10-17 (Forge quick.23, plugin v12): an agent edited Menu scripts on disk; Menu's Studio
// held older copies; within 10-60 s of each disk write the older Studio copy was back on disk
// (SitTieLoop.luau during a playtest, StrikeScene.luau, HomeScreen.luau; StrikeWeather.luau was not).
// Forge's base store showed the base of HomeScreen had moved to the newer disk copy (Studio confirmed
// it, Rojo delivered it), and the older Studio copy then came back as if it were a Studio edit.
//
// Rules checked here (each test fails on main before this fix, except the controls):
//   1. a Studio -> disk pull only when Studio differs from the base AND the disk equals the base;
//      both changed -> a conflict, never an overwrite
//   2. the base only moves to a copy Studio reported holding
//   3. nothing syncs from a Play / Run DataModel, or from a second window of a place another window syncs
//   4. every overwrite of a disk file keeps the old copy in .forge/sync/trash and logs it
// Real SyncEngine + SyncService + mapping.

import assert from 'node:assert/strict'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { PLAYTEST_REFUSED, SyncService, WINDOW_ALIVE_MS, type StudioWindow } from '../src/main/services/sync/service.ts'
import { hashText } from '../src/main/services/sync/store.ts'
import { parseChangesBody, parseConfigQuery, parseSnapshotBody } from '../src/shared/sync/protocol.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import type { StudioNode, SyncEntry } from '../src/shared/sync/types.ts'
import { find, get, makeFsfProject, MENU_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const MENU = 'menu.project.json'
const NK = String(MENU_PLACE)
const PLACE = { placeId: MENU_PLACE, name: 'Menu' }
const MODULES = ['ReplicatedStorage', 'Shared', 'Modules']
const SIT = 'src/menu/shared/Modules/Client/SitTieLoop.luau'
const STRIKE = 'src/menu/shared/Modules/Client/StrikeScene.luau'
const HOME = 'src/menu/shared/Modules/Interface/HomeScreen.luau'
const WEATHER = 'src/menu/shared/Modules/Client/StrikeWeather.luau'
const SIT_PATH = [...MODULES, 'Client', 'SitTieLoop']
const STRIKE_PATH = [...MODULES, 'Client', 'StrikeScene']
const HOME_PATH = [...MODULES, 'Interface', 'HomeScreen']
const WEATHER_PATH = [...MODULES, 'Client', 'StrikeWeather']

// Placeholder sources standing in for the byte sizes in the report (older Studio copy, newer disk copy).
const OLD: Record<string, string> = {
  [SIT]: 'local SitTieLoop = {}\n-- 6979 bytes: the copy Studio held\nreturn SitTieLoop\n',
  [STRIKE]: 'local StrikeScene = {}\n-- 23747 bytes: the copy Studio held\nreturn StrikeScene\n',
  [HOME]: 'local HomeScreen = {}\n-- 2460 bytes: the copy Studio held\nreturn HomeScreen\n',
  [WEATHER]: 'local StrikeWeather = {}\n-- the copy Studio held\nreturn StrikeWeather\n'
}
const NEW: Record<string, string> = {
  [SIT]: 'local SitTieLoop = {}\n-- 7062 bytes: the agent edit on disk\nSitTieLoop.tie = true\nreturn SitTieLoop\n',
  [STRIKE]: 'local StrikeScene = {}\n-- 24365 bytes: the agent edit on disk\nStrikeScene.weather = true\nreturn StrikeScene\n',
  [HOME]: 'local HomeScreen = {}\n-- 2477 bytes: the agent edit on disk\nHomeScreen.play = true\nreturn HomeScreen\n',
  [WEATHER]: 'local StrikeWeather = {}\n-- the agent edit on disk\nStrikeWeather.rain = true\nreturn StrikeWeather\n'
}

interface World {
  root: string
  clock: { t: number }
  windows: StudioWindow[]
  logs: string[]
  map: PlaceMap
}

async function world(): Promise<World> {
  const root = makeFsfProject()
  roots.push(root)
  for (const [f, text] of Object.entries(OLD)) put(root, f, text)
  const map = (await loadPlaces(root)).find((m) => m.projectFile === MENU)!
  return { root, clock: { t: Date.UTC(2026, 9, 17, 14, 0, 0) }, windows: [], logs: [], map }
}

function service(w: World): SyncService {
  return new SyncService({
    root: w.root,
    engine: new SyncEngine({ root: w.root, now: () => w.clock.t, log: (text) => w.logs.push(text) }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined,
    onGate: () => undefined,
    now: () => w.clock.t,
    studios: () => w.windows,
    rojo: () => 'serving',
    log: (text) => w.logs.push(text)
  })
}

// A Studio window: config + one-chunk snapshot. Returns its session token.
async function check(s: SyncService, probe: string | undefined, nodes: StudioNode[], mode?: 'edit' | 'play'): Promise<string> {
  const cfg = await s.handler.config({ placeId: MENU_PLACE, place: 'Menu', ...(probe ? { probe } : {}), ...(mode ? { mode } : {}) })
  assert.equal(cfg.enabled, true, cfg.reason)
  const answer = await s.handler.snapshot({ session: cfg.sessionToken, place: PLACE, seq: 0, final: true, nodes, ...(mode ? { mode } : {}) })
  assert.deepEqual(answer, { ok: true })
  return cfg.sessionToken
}

// The window polls the bridge (plugin v12): what Forge answers.
function poll(s: SyncService, probe: string, session: string): ReturnType<NonNullable<SyncService['handler']['pollHint']>> {
  return s.handler.pollHint!({ placeId: MENU_PLACE, place: 'Menu', session, probe, pluginVersion: PLUGIN_VERSION })
}

const sourceChange = (nodes: StudioNode[], path: string[], source: string) => ({ kind: 'source' as const, node: { ...find(nodes, path), source } })
const actions = (entries: SyncEntry[], action: string): string[] => entries.filter((e) => e.action === action).map((e) => e.file).sort()

// Menu's edit window has synced; the agent writes the newer copies to disk.
async function synced(w: World, s: SyncService, probe = 'probe-edit'): Promise<{ token: string; stale: StudioNode[] }> {
  const stale = studioFromDisk(w.root, w.map)
  const token = await check(s, probe, stale)
  w.windows = [{ placeId: MENU_PLACE, place: 'Menu', pluginVersion: PLUGIN_VERSION, syncSession: token, probe }]
  for (const [f, text] of Object.entries(NEW)) put(w.root, f, text)
  return { token, stale }
}

test('SitTieLoop: a playtest DataModel of the place never syncs (its stale copy is not written over the disk edit)', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  const { token, stale } = await synced(w, s)
  // Rojo delivers SitTieLoop's disk edit into the Edit DataModel: Studio confirms it, the base moves on.
  const fresh = studioFromDisk(w.root, w.map)
  assert.deepEqual(await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(fresh, SIT_PATH, NEW[SIT])] }), { ok: true })
  assert.equal(get(w.root, SIT), NEW[SIT])

  // The playtest copy (the place as it was when Play started) asks for config and sends its snapshot.
  // Before: accepted, and SitTieLoop's old copy (S != base, disk == base) was pulled over the disk edit.
  w.clock.t += 2_000
  const play = await s.handler.config({ placeId: MENU_PLACE, place: 'Menu', probe: 'probe-play', mode: 'play' })
  if (play.enabled) await s.handler.snapshot({ session: play.sessionToken, place: PLACE, seq: 0, final: true, nodes: stale, mode: 'play' })
  assert.equal(get(w.root, SIT), NEW[SIT], 'disk keeps the agent edit (plugin v13 in a playtest copy)')
  assert.equal(play.enabled, false)
  assert.equal(play.reason, PLAYTEST_REFUSED)
  // A snapshot or change batch that says it comes from a playtest is refused too, even with a live token.
  const playSnap = await s.handler.snapshot({ session: token, place: PLACE, seq: 0, final: true, nodes: stale, mode: 'play' })
  assert.equal(playSnap.ok, false)
  const playChange = await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(stale, SIT_PATH, OLD[SIT])], mode: 'run' })
  assert.equal(playChange.ok, false)
  assert.equal(get(w.root, SIT), NEW[SIT])
  // An older plugin running in the playtest copy (no mode): another window holds the place: refused.
  const old = await s.handler.config({ placeId: MENU_PLACE, place: 'Menu', probe: 'probe-play' })
  if (old.enabled) await s.handler.snapshot({ session: old.sessionToken, place: PLACE, seq: 0, final: true, nodes: stale })
  assert.equal(get(w.root, SIT), NEW[SIT], 'disk keeps the agent edit (older plugin in a playtest copy)')
  assert.equal(old.enabled, false)
  assert.match(old.reason ?? '', /another Studio window/)
  assert.equal(poll(s, 'probe-play', ''), null, 'never asked to check again while the edit window syncs')
  assert.ok(w.logs.some((l) => /another Studio window/.test(l)))
  s.close()
})

test('StrikeScene: a second Studio window with the stale copy does not take the session and pull it over disk (v12 resync ping-pong)', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  // Window B (stale, Rojo not connected to it) held the place first; window A then checked and took it.
  const stale = studioFromDisk(w.root, w.map)
  const b = await check(s, 'probe-b', stale)
  w.clock.t += WINDOW_ALIVE_MS + 1
  const { token: a } = await synced(w, s, 'probe-a')
  assert.notEqual(a, b)
  // Rojo delivers into window A: A confirms the disk copy (base -> the agent edit).
  const fresh = studioFromDisk(w.root, w.map)
  await s.handler.changes({ session: a, place: PLACE, changes: [sourceChange(fresh, STRIKE_PATH, NEW[STRIKE])] })
  w.windows.push({ placeId: MENU_PLACE, place: 'Menu', pluginVersion: PLUGIN_VERSION, syncSession: b, probe: 'probe-b' })
  // Both windows keep polling. Before: B's poll got "resync", B's config took the session from A, and
  // B's snapshot (StrikeScene still the old copy) was pulled over the disk edit.
  for (let i = 0; i < 4; i++) {
    w.clock.t += 16_000
    const hintA = poll(s, 'probe-a', a)
    const hintB = poll(s, 'probe-b', b)
    // What the v12 plugin does on resync (or on its next try): config, then a full snapshot.
    const cfg = await s.handler.config({ placeId: MENU_PLACE, place: 'Menu', probe: 'probe-b' })
    if (cfg.enabled) await s.handler.snapshot({ session: cfg.sessionToken, place: PLACE, seq: 0, final: true, nodes: stale })
    assert.equal(get(w.root, STRIKE), NEW[STRIKE], `disk keeps the agent edit (round ${i + 1})`)
    assert.equal(hintA, null)
    assert.equal(hintB, null, 'B is not asked to take the place over')
    assert.equal(cfg.enabled, false, 'B is refused while A syncs the place')
    // B's own (old) token is gone: what it sends is refused and asks it to start over (refused again).
    const sent = await s.handler.snapshot({ session: b, place: PLACE, seq: 0, final: true, nodes: stale })
    assert.equal(sent.ok, false)
  }
  assert.equal(get(w.root, STRIKE), NEW[STRIKE])
  // A keeps syncing (a real Studio edit in A is pulled as usual).
  const edited = NEW[HOME] + '-- edited in Studio\n'
  await s.handler.changes({ session: a, place: PLACE, changes: [sourceChange(fresh, HOME_PATH, NEW[HOME])] })
  await s.handler.changes({ session: a, place: PLACE, changes: [sourceChange(fresh, HOME_PATH, edited)] })
  assert.equal(get(w.root, HOME), edited)
  // A closes: B may take the place after it stopped polling.
  w.windows = w.windows.filter((x) => x.probe !== 'probe-a')
  w.clock.t += WINDOW_ALIVE_MS + 1
  poll(s, 'probe-b', '')
  const later = await s.handler.config({ placeId: MENU_PLACE, place: 'Menu', probe: 'probe-b' })
  assert.equal(later.enabled, true, later.reason)
  s.close()
})

test('StrikeScene (engine): a stale Studio snapshot after Studio confirmed the disk copy is a conflict, never a pull', async () => {
  const w = await world()
  const engine = new SyncEngine({ root: w.root, now: () => w.clock.t, log: (t) => w.logs.push(t) })
  const stale = studioFromDisk(w.root, w.map)
  engine.beginSnapshot(NK, PLACE, MENU)
  engine.addSnapshot(NK, stale)
  await engine.finishSnapshot(NK)
  put(w.root, STRIKE, NEW[STRIKE])
  // The up-to-date DataModel confirms the disk copy.
  const same = await engine.applyChanges(NK, [sourceChange(stale, STRIKE_PATH, NEW[STRIKE])])
  assert.deepEqual(actions(same, 'same'), [STRIKE])
  // A snapshot from a DataModel that still has the old copy (another window, an older plugin's
  // playtest copy): before, S != base and disk == base made this a pull of the old copy over disk.
  w.clock.t += 20_000
  engine.beginSnapshot(NK, PLACE, MENU)
  engine.addSnapshot(NK, stale)
  const entries = await engine.finishSnapshot(NK)
  assert.deepEqual(actions(entries, 'pulled'), [])
  assert.deepEqual(actions(entries, 'conflict'), [STRIKE])
  assert.match(entries.find((e) => e.file === STRIKE)!.note!, /older copy than the disk copy it already confirmed/)
  assert.equal(get(w.root, STRIKE), NEW[STRIKE])
  assert.equal(engine.gate(NK), 'blocked')
  // Take disk: the disk copy stays, the base is Studio's (old) copy, so Rojo pushes the disk copy.
  await engine.resolve(NK, STRIKE, 'disk')
  assert.equal(get(w.root, STRIKE), NEW[STRIKE])
  assert.equal(engine.gate(NK), 'clear')
  const again = await engine.applyChanges(NK, [sourceChange(stale, STRIKE_PATH, OLD[STRIKE])])
  assert.deepEqual(actions(again, 'disk-ahead'), [STRIKE])
  assert.equal(get(w.root, STRIKE), NEW[STRIKE])
})

test('HomeScreen: Studio going back to the copy it had before it confirmed the disk edit (script tab written back after a playtest) is held, not pulled', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  const { token } = await synced(w, s)
  const fresh = studioFromDisk(w.root, w.map)
  // 13:55: Rojo delivered the 2477-byte edit; Studio confirmed it.
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(fresh, HOME_PATH, NEW[HOME])] })
  // Later the same Studio reports its 2460-byte copy again (the playtest's script document).
  w.clock.t += 30_000
  assert.deepEqual(await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(fresh, HOME_PATH, OLD[HOME])] }), { ok: true })
  assert.equal(get(w.root, HOME), NEW[HOME], 'disk keeps 2477')
  const held = s.conflicts().find((c) => c.file === HOME)
  assert.ok(held, 'held as a conflict')
  assert.equal(held.reason, 'both-changed')
  assert.equal(held.disk, NEW[HOME])
  assert.equal(held.studio, OLD[HOME])
  // A Studio edit on top of the newer copy (not a step back) is a normal pull.
  const edited = NEW[SIT] + '-- typed in Studio\n'
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(fresh, SIT_PATH, NEW[SIT])] })
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(fresh, SIT_PATH, edited)] })
  assert.equal(get(w.root, SIT), edited)
  s.close()
})

test('StrikeWeather (control): Studio never got the disk edit (Rojo stalled): disk-ahead, the disk file is left alone', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  const { token, stale } = await synced(w, s)
  // Studio still has the old copy and touches it (a property change re-sends the same source).
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(stale, WEATHER_PATH, OLD[WEATHER])] })
  // And a fresh check from the same window (v12 resync) with everything still old.
  w.clock.t += 31_000
  await check(s, 'probe-edit', stale)
  for (const f of Object.keys(NEW)) assert.equal(get(w.root, f), NEW[f], f)
  assert.deepEqual(s.conflicts(), [])
  s.close()
})

test('rule 2 (control): the base never moves to the disk copy before Studio confirms it holds it', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  const { token, stale } = await synced(w, s)
  const base = async (f: string): Promise<string | null> => {
    const index = JSON.parse(readFileSync(join(w.root, '.forge/sync/index.json'), 'utf8'))
    return index.places[NK]?.[f] ?? null
  }
  const oldHash = hashText(OLD[WEATHER])
  assert.equal(await base(WEATHER), oldHash)
  // Rojo serves, a drift check and a status refresh run, other files change in Studio: the base stays.
  await s.status()
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(stale, SIT_PATH, OLD[SIT])] })
  assert.equal(await base(WEATHER), oldHash)
  // Studio confirms it: now the base moves.
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(stale, WEATHER_PATH, NEW[WEATHER])] })
  assert.equal(await base(WEATHER), hashText(NEW[WEATHER]))
  s.close()
})

test('rule 4: a Studio edit pulled over a disk file keeps the old disk copy in .forge/sync/trash and logs it', async () => {
  const w = await world()
  const s = service(w)
  await s.start()
  const stale = studioFromDisk(w.root, w.map)
  const token = await check(s, 'probe-edit', stale)
  const typed = OLD[SIT] + '-- typed in Studio\n'
  await s.handler.changes({ session: token, place: PLACE, changes: [sourceChange(stale, SIT_PATH, typed)] })
  assert.equal(get(w.root, SIT), typed)
  const line = w.logs.find((l) => l.includes(SIT) && /saved in \.forge\/sync\/trash\//.test(l))
  assert.ok(line, `logged: ${w.logs.join(' | ')}`)
  assert.match(line, /saved in \.forge\/sync\/trash\/overwritten\//)
  const kept = /saved in (\S+)$/.exec(line)![1]
  assert.ok(existsSync(join(w.root, kept)))
  assert.equal(get(w.root, kept), OLD[SIT])
  s.close()
})

test('protocol and plugin v13: the DataModel mode travels with config, snapshot and changes; the plugin syncs only in Edit mode', async () => {
  assert.equal(parseConfigQuery(new URLSearchParams('placeId=1&mode=edit')).mode, 'edit')
  assert.equal(parseConfigQuery(new URLSearchParams('placeId=1&mode=run')).mode, 'run')
  assert.equal(parseConfigQuery(new URLSearchParams('placeId=1&mode=server')).mode, 'play', 'an unknown mode counts as a playtest')
  assert.equal(parseConfigQuery(new URLSearchParams('placeId=1')).mode, undefined, 'older plugins send none')
  assert.equal(parseSnapshotBody({ session: 's', place: { placeId: 1 }, seq: 0, final: true, nodes: [], mode: 'play' }).mode, 'play')
  assert.equal(parseChangesBody({ session: 's', place: { placeId: 1 }, changes: [], mode: 'edit' }).mode, 'edit')
  const src = readFileSync(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  assert.ok(PLUGIN_VERSION >= 13)
  assert.ok(src.includes(`-- forge-bridge-template: ${PLUGIN_VERSION}`))
  // Returns before anything else outside Edit mode, and checks again in the sync loop (Run mode).
  assert.ok(src.indexOf('RunService:IsEdit()') < src.indexOf('if not isEditMode() then\n\treturn\nend'))
  assert.ok(src.indexOf('if not isEditMode() then\n\treturn\nend') < src.indexOf('local toolbar'))
  const loop = src.slice(src.indexOf('local function syncLoop'))
  assert.ok(loop.indexOf('if not isEditMode() then') >= 0 && loop.indexOf('if not isEditMode() then') < loop.indexOf('pcall(startSync)'))
  for (const needle of ['"&mode="', 'mode = syncMode(), session = sync.session, place = place, seq = seq', 'mode = syncMode(), session = sync.session, place = place, changes = batch']) assert.ok(src.includes(needle), needle)
})
