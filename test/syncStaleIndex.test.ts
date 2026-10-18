// Forge Sync index hygiene, shaped like Acid's FSF on 2026-10-18 (Forge quick.25): "FSF is 6 files
// behind disk: rojo serves it, but the edits are not reaching Studio", listing
// src/shared/events/server.luau (the Blink server output, since moved to src/server/events) and
// src/skills/Server/Moves/CounterStance/* (renamed to Countercoil). Neither file was on disk or in
// Studio; the place's .forge/sync/index.json still had a base for each (digest-only, no blob), plus
// bases for src/menu/... paths Match's project does not map at all, so drift counted them forever.
//
// Rules checked here:
//   1. a file gone from disk is never "behind disk"; one the live Studio still has is counted apart
//   2. a check drops bases of files gone from both sides (digest-only ones too) and of paths the place
//      file no longer maps (outside its roots, globIgnorePaths)
//   3. a file deleted on disk while Studio still has it keeps its base, so it is never written back
//   4. a rename on disk: the new path gets a fresh base, the old one goes once Studio has neither
// Real SyncEngine + SyncService + mapping.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, unlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor, type PlaceMap } from '../src/main/services/sync/mapping.ts'
import { RESYNC_QUIET_MS, SyncService, type StudioWindow } from '../src/main/services/sync/service.ts'
import { hashText, INDEX_FILE } from '../src/main/services/sync/store.ts'
import type { RojoServeState, StudioNode, SyncEntry } from '../src/shared/sync/types.ts'
import { get, makeFsfProject, MATCH_PLACE, MENU_PLACE, put, studioFromDisk } from './syncFixture.ts'

const roots: string[] = []
after(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true })
})

const MATCH = 'default.project.json'
const MK = String(MATCH_PLACE)
const NK = String(MENU_PLACE)
const PLACE = { placeId: MATCH_PLACE, name: 'Arena' }
const OLD_EVENTS = 'src/shared/events/server.luau'
const STANCE = 'src/skills/Server/Moves/CounterStance'
const COIL = 'src/skills/Server/Moves/Countercoil'
const STANCE_FILES = [`${STANCE}/Config.luau`, `${STANCE}/Server.luau`]
const COIL_FILES = [`${COIL}/Config.luau`, `${COIL}/Server.luau`]
const MOVES = ['ServerScriptService', 'Server', 'Features', 'Skills', 'Moves']

interface Ctx {
  root: string
  engine: SyncEngine
  match: PlaceMap
}

async function setup(root = makeFsfProject()): Promise<Ctx> {
  if (!roots.includes(root)) roots.push(root)
  let t = Date.UTC(2026, 9, 18, 1, 0, 0)
  const engine = new SyncEngine({ root, now: () => t++ })
  const maps = await engine.places()
  return { root, engine, match: maps.find((m) => m.projectFile === MATCH)! }
}

async function snapshot(engine: SyncEngine, nodes: StudioNode[]): Promise<SyncEntry[]> {
  engine.beginSnapshot(MK, PLACE)
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

type Index = { version: 1; places: Record<string, Record<string, string>> }

function readIndex(root: string): Index {
  return JSON.parse(readFileSync(join(root, INDEX_FILE), 'utf8')) as Index
}

// Adds bases to the index on disk (as an older Forge left them): a string is a text base (its blob is
// written), null a digest-only one (no blob, like the FSF entries).
function inject(root: string, placeKey: string, bases: Record<string, string | null>): void {
  const index = readIndex(root)
  const place = (index.places[placeKey] ??= {})
  for (const [file, text] of Object.entries(bases)) {
    const hash = hashText(text ?? `-- gone: ${file}\n`)
    place[file] = hash
    if (text !== null) {
      const blob = join(root, '.forge/sync/blobs', hash.slice(0, 2), `${hash}.txt`)
      mkdirSync(dirname(blob), { recursive: true })
      writeFileSync(blob, text)
    }
  }
  writeFileSync(join(root, INDEX_FILE), JSON.stringify(index, null, 1) + '\n')
}

const oldMtime = (root: string, file: string): void => {
  const old = new Date(Date.UTC(2026, 9, 17))
  utimesSync(join(root, file), old, old)
}

test('repro: stale bases (gone from disk and from Studio) are not "behind disk", and a check drops them', async () => {
  const first = await setup()
  await agreed(first)
  // What the FSF index held: the Blink output's old path (digest-only) and the renamed move (one
  // digest-only, one with its blob).
  inject(first.root, MK, { [OLD_EVENTS]: null, [STANCE_FILES[0]]: null, [STANCE_FILES[1]]: 'local Server = {}\nreturn Server\n' })
  // Forge restarts and loads that index.
  const ctx = await setup(first.root)
  const before = (await ctx.engine.drift(MATCH, MK))!
  assert.equal(before.behind, 0, before.files.map((f) => f.file).join(', '))
  assert.deepEqual(before.files, [])
  assert.equal(before.deleted, undefined, 'no live Studio has them either')
  // One real disk edit: the only file listed.
  put(ctx.root, 'src/server/Handlers/Combat.luau', 'return { hits = 3 }\n')
  const edited = (await ctx.engine.drift(MATCH, MK))!
  assert.equal(edited.behind, 1)
  assert.deepEqual(edited.files.map((f) => f.file), ['src/server/Handlers/Combat.luau'])

  // The place is checked; its Studio has none of them.
  put(ctx.root, 'src/server/Handlers/Combat.luau', 'return {}\n')
  const entries = await snapshot(ctx.engine, studioFromDisk(ctx.root, ctx.match))
  assert.equal(ctx.engine.gate(MK), 'clear')
  assert.deepEqual(entries.filter((e) => e.action === 'conflict' || e.action === 'created' || e.action === 'pulled' || e.action === 'trashed'), [])
  const left = readIndex(ctx.root).places[MK]
  for (const f of [OLD_EVENTS, ...STANCE_FILES]) assert.equal(left[f], undefined, `${f} dropped from the index`)
  for (const f of [OLD_EVENTS, ...STANCE_FILES]) assert.equal(existsSync(join(ctx.root, f)), false, `${f} not written back`)
  // The one with a synced copy left it in recovered/, as for any file lost from both sides.
  const recovered = readdirSync(join(ctx.root, '.forge/sync/recovered'))
  assert.equal(recovered.length, 1)
  assert.equal(readFileSync(join(ctx.root, '.forge/sync/recovered', recovered[0], STANCE_FILES[1]), 'utf8'), 'local Server = {}\nreturn Server\n')
  assert.ok(left['src/skills/Definitions/Dash.luau'], 'live bases kept')
  assert.deepEqual(await ctx.engine.drift(MATCH, MK), { behind: 0, files: [] })
})

test('a check drops bases of paths the place file does not map (another place file, globIgnorePaths)', async () => {
  const first = await setup()
  await agreed(first)
  const lobby = 'src/menu/server/Lobby.server.luau'
  // Match's index holds Menu paths (on disk and gone), as in FSF; Menu's own base for the lobby stays.
  inject(first.root, MK, { [lobby]: get(first.root, lobby), 'src/menu/server/Handlers/Intro.server.luau': null })
  inject(first.root, NK, { [lobby]: get(first.root, lobby) })
  const ctx = await setup(first.root)
  assert.equal((await ctx.engine.drift(MATCH, MK))!.behind, 0)
  await snapshot(ctx.engine, studioFromDisk(ctx.root, ctx.match))
  let index = readIndex(ctx.root)
  assert.equal(index.places[MK][lobby], undefined)
  assert.equal(index.places[MK]['src/menu/server/Handlers/Intro.server.luau'], undefined)
  assert.ok(index.places[NK][lobby], "another place's bases are not touched")
  assert.equal(get(ctx.root, lobby), 'print("lobby")\n', 'the file itself is left alone')

  // globIgnorePaths: Rojo stops building Util.luau for Match; its base goes, the file stays.
  const util = 'src/shared/Modules/Util.luau'
  assert.ok(index.places[MK][util])
  const nodes = studioFromDisk(ctx.root, ctx.match)
  const project = JSON.parse(get(ctx.root, MATCH))
  project.globIgnorePaths = [util]
  put(ctx.root, MATCH, JSON.stringify(project, null, 2))
  await ctx.engine.reload()
  const entries = await snapshot(ctx.engine, nodes)
  index = readIndex(ctx.root)
  assert.equal(index.places[MK][util], undefined)
  assert.equal(get(ctx.root, util), 'return {}\n')
  assert.equal(entries.some((e) => e.file === util && (e.action === 'trashed' || e.action === 'pulled')), false)
  assert.ok(index.places[MK]['src/skills/Definitions/Dash.luau'], 'mapped bases kept')
})

test('deleted on disk while Studio still has it: not behind, its base kept, never written back', async () => {
  const ctx = await setup()
  const nodes = await agreed(ctx)
  const guard = 'src/skills/Definitions/Guard.luau'
  unlinkSync(join(ctx.root, guard))
  const d = (await ctx.engine.drift(MATCH, MK))!
  assert.equal(d.behind, 0)
  assert.deepEqual(d.files, [])
  assert.deepEqual(d.deleted, [guard], 'counted apart: Rojo removes it from Studio when it connects')
  // Checks with the older Studio copy still there: Forge leaves the delete to Rojo.
  for (let i = 0; i < 2; i++) {
    const entries = await snapshot(ctx.engine, nodes)
    assert.equal(entries.find((e) => e.file === guard)?.action, 'disk-ahead')
    assert.equal(existsSync(join(ctx.root, guard)), false, 'not resurrected')
    assert.ok(readIndex(ctx.root).places[MK][guard], 'base kept while Studio has it')
  }
  // After a restart too.
  const again = await setup(ctx.root)
  await snapshot(again.engine, nodes)
  assert.equal(existsSync(join(ctx.root, guard)), false, 'not resurrected after a restart')
  assert.deepEqual((await again.engine.drift(MATCH, MK))!.deleted, [guard])
  // Rojo carried the delete: Studio has neither, the base goes.
  await snapshot(again.engine, studioFromDisk(ctx.root, again.match))
  assert.equal(readIndex(ctx.root).places[MK][guard], undefined)
  assert.deepEqual(await again.engine.drift(MATCH, MK), { behind: 0, files: [] })
})

test('a rename on disk (CounterStance -> Countercoil): the new files are behind, the old ones are not, then one fresh base each', async () => {
  const root = makeFsfProject()
  put(root, STANCE_FILES[0], 'return { window = 0.3 }\n')
  put(root, STANCE_FILES[1], 'local Server = {}\nfunction Server.run() end\nreturn Server\n')
  const ctx = await setup(root)
  const nodes = await agreed(ctx)
  for (const f of STANCE_FILES) assert.ok(readIndex(root).places[MK][f])
  renameSync(join(root, STANCE), join(root, COIL))

  // Studio still has CounterStance (Rojo not connected).
  const d = (await ctx.engine.drift(MATCH, MK))!
  assert.equal(d.behind, 2)
  assert.deepEqual(d.files.map((f) => f.file).sort(), COIL_FILES)
  assert.deepEqual(d.deleted, STANCE_FILES)
  const held = await snapshot(ctx.engine, nodes)
  // As for any disk delete at a check: rojo serve waits on the scripts it would delete from Studio.
  assert.deepEqual(ctx.engine.studioOnly(MK).items.map((i) => i.file).sort(), STANCE_FILES)
  assert.equal(existsSync(join(root, STANCE)), false, 'CounterStance not written back')
  assert.deepEqual(held.filter((e) => e.action === 'conflict' || e.action === 'created'), [])
  for (const f of STANCE_FILES) assert.ok(readIndex(root).places[MK][f], 'old bases kept while Studio has them')
  for (const f of COIL_FILES) assert.equal(readIndex(root).places[MK][f], undefined)

  // Rojo connects: Studio has Countercoil, no CounterStance.
  const now = studioFromDisk(root, ctx.match)
  assert.ok(now.some((n) => n.path.join('.') === [...MOVES, 'Countercoil', 'Config'].join('.')))
  await snapshot(ctx.engine, now)
  assert.equal(ctx.engine.gate(MK), 'clear')
  const index = readIndex(root).places[MK]
  for (const f of STANCE_FILES) assert.equal(index[f], undefined, `${f} dropped`)
  for (const f of COIL_FILES) assert.equal(index[f], hashText(get(root, f)), `${f} has a fresh base`)
  assert.deepEqual(await ctx.engine.drift(MATCH, MK), { behind: 0, files: [] })
})

// ---- the drift message ----

interface World {
  root: string
  clock: { t: number }
  windows: StudioWindow[]
  rojo: Record<string, RojoServeState>
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
    driftGraceMs: 1000
  })
}

async function check(w: World, s: SyncService, nodes: StudioNode[]): Promise<string> {
  const cfg = await s.handler.config({ placeId: MATCH_PLACE, place: 'Match', probe: 'probe-match' })
  assert.equal(cfg.enabled, true, cfg.reason)
  await s.handler.snapshot({ session: cfg.sessionToken, place: { placeId: MATCH_PLACE, name: 'Match' }, seq: 0, final: true, nodes })
  return cfg.sessionToken
}

test('the drift warning counts and lists only the files really behind disk', async () => {
  const root = makeFsfProject()
  roots.push(root)
  const w: World = { root, clock: { t: Date.UTC(2026, 9, 18, 1, 0, 0) }, windows: [], rojo: { [MATCH]: 'serving' } }
  const match = (await loadPlaces(root)).find((m) => m.projectFile === MATCH)!
  const first = service(w)
  await first.start()
  const old = await check(w, first, studioFromDisk(root, match))
  first.close()
  // What Match's Studio has: the copies before the edit and delete below.
  const studio = studioFromDisk(root, match)
  inject(root, MK, { [OLD_EVENTS]: null, [STANCE_FILES[0]]: null, [STANCE_FILES[1]]: null, 'src/menu/server/Handlers/Intro.server.luau': null })
  const edited = 'src/skills/Definitions/Dash.luau'
  put(root, edited, 'return { name = "Dash", cooldown = 1 }\n')
  oldMtime(root, edited)

  // Forge restarts; Match's window is open with no session yet: the stale bases are not counted.
  const s = service(w)
  await s.start()
  w.windows = [{ placeId: MATCH_PLACE, place: 'Match', pluginVersion: 12, syncSession: old, probe: 'probe-match' }]
  w.clock.t += RESYNC_QUIET_MS + 1
  const unsynced = (await s.status()).places.find((p) => p.projectFile === MATCH)!
  assert.equal(unsynced.drift?.cause, 'not-syncing')
  assert.equal(unsynced.drift?.behind, 1)
  assert.deepEqual(unsynced.drift?.files, [edited])
  assert.match(unsynced.drift?.text ?? '', /^Arena is 1 file behind disk: /)

  // It checks; rojo serves but Studio is not connected to it.
  w.clock.t += 1000
  w.windows[0].syncSession = await check(w, s, studio)
  // A file deleted on disk since, which Studio still has.
  const gone = 'src/server/Handlers/Combat.luau'
  unlinkSync(join(root, gone))
  w.clock.t += RESYNC_QUIET_MS + 1
  const live = (await s.status()).places.find((p) => p.projectFile === MATCH)!
  assert.equal(live.drift?.cause, 'rojo-not-connected')
  assert.equal(live.drift?.behind, 1)
  assert.deepEqual(live.drift?.files, [edited])
  assert.equal(live.drift?.deleted, 1, 'the delete Rojo has yet to carry is counted apart')
  assert.match(live.drift?.text ?? '', /^Arena is 1 file behind disk: rojo serves it, but the edits are not reaching Studio/)
  assert.equal(existsSync(join(root, gone)), false)
  const index = readIndex(root).places[MK]
  for (const f of [OLD_EVENTS, ...STANCE_FILES, 'src/menu/server/Handlers/Intro.server.luau']) assert.equal(index[f], undefined, `${f} pruned`)
  assert.ok(index[gone], 'the deleted-on-disk base stays while Studio has it')
  s.close()
})
