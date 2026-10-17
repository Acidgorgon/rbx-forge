// Forge Sync drift and resync, shaped like the FSF case (Acid's PC, 2026-10-17): Menu and Match are
// both linked (servePlaceIds), both synced once; Forge restarted; Menu's Studio checked again, Match's
// stayed open without a sync session (plugin v11 never asked again), rojo served Menu only, and disk got
// 5 edits Match never received, with nothing in the UI saying so. Real SyncEngine + mapping.

import assert from 'node:assert/strict'
import { rmSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { RESYNC_EVERY_MS, RESYNC_QUIET_MS, SyncService, type StudioWindow } from '../src/main/services/sync/service.ts'
import { syncSummary } from '../src/main/services/sync/wire.ts'
import type { RojoServeState, StudioNode } from '../src/shared/sync/types.ts'
import { get, makeFsfProject, MATCH_PLACE, MENU_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const MATCH = 'default.project.json'
const MENU = 'menu.project.json'
const EDITS = ['src/skills/Definitions/Dash.luau', 'src/server/Config/Admins.luau', 'src/server/Handlers/Combat.luau', 'src/shared/Modules/Util.luau', 'src/skills/Server/Catalog.luau']

interface World {
  root: string
  clock: { t: number }
  windows: StudioWindow[]
  rojo: Record<string, RojoServeState>
  logs: string[]
}

function world(): World {
  const root = makeFsfProject()
  roots.push(root)
  return { root, clock: { t: Date.UTC(2026, 9, 17, 1, 0, 0) }, windows: [], rojo: { [MATCH]: 'stopped', [MENU]: 'serving' }, logs: [] }
}

function service(w: World): SyncService {
  return new SyncService({
    root: w.root,
    engine: new SyncEngine({ root: w.root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined,
    onGate: () => undefined,
    now: () => w.clock.t,
    studios: () => w.windows,
    rojo: (file) => w.rojo[file] ?? 'stopped',
    driftGraceMs: 1000,
    log: (text) => w.logs.push(text)
  })
}

async function check(w: World, s: SyncService, placeId: number, name: string, probe: string, nodes?: StudioNode[]): Promise<string> {
  const cfg = await s.handler.config({ placeId, place: name, probe })
  assert.equal(cfg.enabled, true, cfg.reason)
  const maps: PlaceMap[] = await loadPlaces(w.root)
  const map = maps.find((m) => m.placeIds.includes(placeId))!
  await s.handler.snapshot({ session: cfg.sessionToken, place: { placeId, name }, seq: 0, final: true, nodes: nodes ?? studioFromDisk(w.root, map) })
  return cfg.sessionToken
}

function editDisk(w: World): void {
  for (const f of EDITS) put(w.root, f, `-- edited on disk after Match last synced\nreturn { file = "${f}" }\n`)
  // Older than the grace period, like the 11-hour-old FSF edits.
  const old = new Date(w.clock.t - 11 * 3_600_000)
  for (const f of EDITS) utimesSync(join(w.root, f), old, old)
}

test('repro: a linked Match window with no sync session after a Forge restart shows "Match is 5 files behind disk" and is asked to check again', async () => {
  const w = world()
  const before = service(w)
  await before.start()
  const oldMatch = await check(w, before, MATCH_PLACE, 'Match', 'probe-match')
  await check(w, before, MENU_PLACE, 'Menu', 'probe-menu')
  before.close()

  // Forge restarts. Menu's Studio checks again; Match's window is still open but has no session.
  w.clock.t += 60_000
  const s = service(w)
  await s.start()
  // What Match's Studio still has (it never got the edits below).
  const matchMap = (await loadPlaces(w.root)).find((m) => m.projectFile === MATCH)!
  const matchStudio = studioFromDisk(w.root, matchMap)
  // The disk edits; Menu's rojo carried them into its Studio (its check sees them in Studio).
  editDisk(w)
  const menu = await check(w, s, MENU_PLACE, 'Menu', 'probe-menu')
  w.windows = [
    { placeId: MENU_PLACE, place: 'Menu', pluginVersion: 12, syncSession: menu, probe: 'probe-menu' },
    { placeId: MATCH_PLACE, place: 'Match', pluginVersion: 12, syncSession: oldMatch, probe: 'probe-match' }
  ]
  w.clock.t += RESYNC_QUIET_MS + 1

  const status = await s.status()
  const match = status.places.find((p) => p.projectFile === MATCH)
  assert.ok(match, 'Match has a row (its Studio is open), not missing from the panel')
  assert.equal(match.studioOpen, true)
  assert.equal(match.rojo, 'stopped')
  assert.ok(match.drift, 'drift shown')
  assert.equal(match.drift.behind, 5)
  assert.equal(match.drift.cause, 'not-syncing')
  assert.equal(match.drift.fix, 'recheck')
  assert.match(match.drift.text, /^Arena is 5 files behind disk: /)
  assert.deepEqual([...match.drift.files].sort(), [...EDITS].sort())
  assert.equal(status.places.find((p) => p.projectFile === MENU)?.drift, undefined, 'Menu is live and served: no drift')

  // The v12 plugin's poll: a session Forge does not know gets "resync", rate limited.
  const poll = { placeId: MATCH_PLACE, place: 'Match', session: oldMatch, probe: 'probe-match', pluginVersion: 12 }
  assert.deepEqual(s.handler.pollHint!(poll), { resync: true })
  assert.equal(s.handler.pollHint!(poll), null, 'not again within RESYNC_EVERY_MS')
  assert.ok(w.logs.some((l) => /Studio has "Match" open for default\.project\.json, but Forge has no sync session with it/.test(l)))
  w.clock.t += RESYNC_EVERY_MS + 1
  assert.deepEqual(s.handler.pollHint!({ ...poll, session: '' }), { resync: true }, 'an idle plugin (no session) is asked too')
  assert.equal(s.handler.pollHint!({ placeId: MENU_PLACE, place: 'Menu', session: menu, probe: 'probe-menu' }), null, 'a live session is left alone')
  assert.equal(s.handler.pollHint!({ placeId: 72187156382444, place: 'Other', session: '', probe: 'probe-x' }), null, 'an unlinked place is never asked')

  // It checks again: synced, but its rojo is not running, so the 5 edits still don't reach Studio.
  w.clock.t += 1000
  const fresh = await check(w, s, MATCH_PLACE, 'Match', 'probe-match', matchStudio)
  w.windows[1].syncSession = fresh
  w.clock.t += RESYNC_QUIET_MS + 1
  const after1 = (await s.status()).places.find((p) => p.projectFile === MATCH)!
  assert.equal(after1.drift?.cause, 'rojo-stopped')
  assert.equal(after1.drift?.fix, 'start-rojo')
  assert.equal(after1.drift?.behind, 5)

  // Rojo serves it but the window is not connected to it: still behind after the grace period.
  w.rojo[MATCH] = 'serving'
  const after2 = (await s.status()).places.find((p) => p.projectFile === MATCH)!
  assert.equal(after2.drift?.cause, 'rojo-not-connected')
  assert.match(after2.drift?.text ?? '', /connect Rojo in that Studio window/)

  // A fresh disk edit inside the grace period is not drift yet (Rojo is carrying it into Studio).
  const now = new Date(w.clock.t)
  for (const f of EDITS) utimesSync(join(w.root, f), now, now)
  put(w.root, EDITS[0], 'return "newest"\n')
  utimesSync(join(w.root, EDITS[0]), now, now)
  assert.equal((await s.status()).places.find((p) => p.projectFile === MATCH)?.drift, undefined)
  s.close()
})

test('Check now: the window re-checks on its next poll; older plugins are told to restart Studio', async () => {
  const w = world()
  const s = service(w)
  await s.start()
  await assert.rejects(() => s.recheckPlace(MATCH), /No Studio window has/)
  w.windows = [{ placeId: MATCH_PLACE, place: 'Match', pluginVersion: 11 }]
  await assert.rejects(() => s.recheckPlace(MATCH), /Restart Studio to load Forge Bridge v12/)
  w.windows = [{ placeId: MATCH_PLACE, place: 'Match', pluginVersion: 12, syncSession: '', probe: 'p1' }]
  const token = await s.handler.config({ placeId: MATCH_PLACE, place: 'Match', probe: 'p1' })
  // Right after a config request the window is not nagged...
  assert.equal(s.handler.pollHint!({ placeId: MATCH_PLACE, place: 'Match', session: '', probe: 'p1' }), null)
  // ...but "Check now" asks at once, once.
  await s.recheckPlace(MATCH)
  assert.deepEqual(s.handler.pollHint!({ placeId: MATCH_PLACE, place: 'Match', session: token.sessionToken, probe: 'p1' }), { resync: true })
  assert.equal(s.handler.pollHint!({ placeId: MATCH_PLACE, place: 'Match', session: token.sessionToken, probe: 'p1' }), null)
  s.close()
})

test('an older plugin with no session: drift says restart Studio', async () => {
  const w = world()
  const before = service(w)
  await before.start()
  await check(w, before, MATCH_PLACE, 'Match', 'probe-match')
  before.close()
  const s = service(w)
  await s.start()
  w.windows = [{ placeId: MATCH_PLACE, place: 'Match', pluginVersion: 11 }]
  editDisk(w)
  w.clock.t += RESYNC_QUIET_MS + 1
  const match = (await s.status()).places.find((p) => p.projectFile === MATCH)!
  assert.equal(match.drift?.cause, 'not-syncing')
  assert.equal(match.drift?.fix, 'restart-studio')
  assert.match(match.drift?.text ?? '', /restart Studio to load Forge Bridge v12/)
  s.close()
})

test('an unlinked Studio place that synced before gets a one-click Link suggestion and its drift', async () => {
  const w = world()
  // Match synced once under PlaceId 1001, then the place file lost its servePlaceIds (unlinked).
  const before = service(w)
  await before.start()
  await check(w, before, MATCH_PLACE, 'Match', 'probe-match')
  before.close()
  const proj = JSON.parse(get(w.root, MATCH))
  delete proj.servePlaceIds
  put(w.root, MATCH, JSON.stringify(proj, null, 2))
  put(w.root, 'tools/studio-sync.json', JSON.stringify({ port: 34873, placeIds: [], skip: ['Packages', 'src/ServerStorage'], projects: [{ file: MENU, placeIds: [MENU_PLACE] }] }))
  const s = service(w)
  await s.start()
  // Menu is open and syncing; Match's window asks and is refused (not linked).
  const menu = await check(w, s, MENU_PLACE, 'Menu', 'probe-menu')
  w.windows = [{ placeId: MENU_PLACE, place: 'Menu', pluginVersion: 12, syncSession: menu, probe: 'probe-menu' }, { placeId: MATCH_PLACE, place: 'Match', pluginVersion: 12, syncSession: '', probe: 'probe-match' }]
  const cfg = await s.handler.config({ placeId: MATCH_PLACE, place: 'Match', probe: 'probe-match' })
  assert.equal(cfg.enabled, false)
  editDisk(w)
  const status = await s.status()
  const u = status.unlinked?.find((x) => x.placeId === MATCH_PLACE)
  assert.ok(u, 'shown as not linked')
  assert.equal(u.suggest, MATCH, 'the only place file no other window syncs')
  assert.equal(u.canLink, true)
  assert.equal(u.drift?.cause, 'not-linked')
  assert.equal(u.drift?.fix, 'link')
  assert.equal(u.drift?.linkTo, MATCH)
  assert.equal(u.drift?.behind, 5)
  s.close()
})

test('syncSummary puts drift in the status bar', async () => {
  const w = world()
  const before = service(w)
  await before.start()
  const oldMatch = await check(w, before, MATCH_PLACE, 'Match', 'probe-match')
  before.close()
  editDisk(w)
  w.windows = [{ placeId: MATCH_PLACE, place: 'Match', pluginVersion: 12, syncSession: oldMatch, probe: 'probe-match' }]
  const s = service(w)
  await s.start()
  w.clock.t += RESYNC_QUIET_MS + 1
  const summary = syncSummary(await s.status())
  assert.equal(summary.state, 'starting', 'not green')
  assert.match(summary.detail, /^Forge Sync: Arena is 5 files behind disk: /)
  s.close()
})
