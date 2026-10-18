// rojo serve per place (FSF: Match on 34872 and Menu on 34875 with "Serve all places"): a re-check by
// the same Studio window does not stop rojo (the Rojo plugin connected there would stay cut off),
// a real conflict still holds it, "Serve anyway" sticks, a second Start never orphans a secondary
// serve, each place's own state is reported, and the reconnect notice after Forge restarted a serve.
// Also Rojo's globIgnorePaths and explicit children over same-name $path folder entries (the menu
// place's Modules folder copies), and the Doctor's duplicate-mapping / stray-rojo checks.
import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { after, test } from 'node:test'
import type { LogLine, PlaceInfo, ServiceStatus } from '../src/shared/types.ts'
import type { GateState, StudioChange, StudioNode, SyncConflictInfo, SyncEntry, SyncPlace } from '../src/shared/sync/types.ts'
import { Supervisor } from '../src/main/services/supervisor.ts'
import { SESSION_EXPIRE_MS, SyncService, type PlaceMapLike, type SyncEngineLike } from '../src/main/services/sync/service.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { duplicateMappings, duplicateMappingText, fromDisk, insideMappedRoots, loadPlaces, rojoGlob, rojoIgnored, shadowedBy, toDisk } from '../src/main/services/sync/mapping.ts'
import { buildRepoTree } from '../src/main/services/project.ts'
import { serveView } from '../src/shared/rojoView.ts'
import { portChecks, projectChecks } from '../src/shared/doctor/checks.ts'
import type { DoctorInputs } from '../src/shared/doctor/types.ts'
import { isRojoProcess, parseLsof, parseNetstat, parseTasklist } from '../src/main/services/portOwner.ts'
import { run } from '../src/main/services/tools.ts'
import { makeProject, write } from './fixture.ts'

// A fake `rojo` on PATH: logs "<pid> <args>" and stays up like `rojo serve` (exec keeps the pid), or
// fails to bind like rojo does when a file named after its port exists in $ROJO_BUSY.
const home = mkdtempSync(join(tmpdir(), 'serve-home-'))
const bin = mkdtempSync(join(tmpdir(), 'serve-bin-'))
const busy = mkdtempSync(join(tmpdir(), 'serve-busy-'))
const runs = join(bin, 'runs.log')
process.env.HOME = home
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
process.env.ROJO_RUNS = runs
process.env.ROJO_BUSY = busy
write(
  bin,
  'rojo',
  '#!/bin/sh\nfor a in "$@"; do last=$a; done\necho "$$ $@" >> "$ROJO_RUNS"\necho "Rojo server listening: Port: $last"\nif [ -f "$ROJO_BUSY/$last" ]; then\n  echo "thread \'main\' panicked at \'error binding to 127.0.0.1:$last: Address already in use (os error 98)\'" >&2\n  exit 101\nfi\nexec sleep 60\n'
)
chmodSync(join(bin, 'rojo'), 0o755)

const temps: string[] = [home, bin, busy]
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})
const shOnly = { skip: process.platform === 'win32' ? 'fake rojo is a sh script' : false }

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}
const tick = () => sleep(10)

// Serve runs per port: [pid, alive].
function servesOn(port: number): { pid: number; alive: boolean }[] {
  if (!existsSync(runs)) return []
  return readFileSync(runs, 'utf8')
    .split('\n')
    .filter((l) => l.endsWith(`--port ${port}`))
    .map((l) => Number(l.split(' ')[0]))
    .map((pid) => {
      let alive = true
      try {
        process.kill(pid, 0)
      } catch {
        alive = false
      }
      return { pid, alive }
    })
}

const PLACES: PlaceInfo[] = [
  { file: 'default.project.json', name: 'FSF', isDefault: true, servePort: 34872, sourcemap: 'sourcemap.json' } as PlaceInfo,
  { file: 'menu.project.json', name: 'Menu', isDefault: false, servePort: 34875, sourcemap: 'sourcemap.menu.json' } as PlaceInfo
]

function makeSupervisor(extra: { rojoRestart?: { backoffMs: number[]; maxQuickFailures: number } } = {}) {
  const root = makeProject()
  temps.push(root)
  let statuses: ServiceStatus[] = []
  const logs: Omit<LogLine, 'at'>[] = []
  const settings: Record<string, unknown> = { serveAllPlaces: true }
  const supervisor = new Supervisor({
    log: (line) => logs.push(line),
    onStatus: (s) => (statuses = s),
    getSetting: <T>(key: string, fallback: T) => (key in settings ? (settings[key] as T) : fallback),
    ...extra
  })
  const rojo = () => statuses.find((s) => s.id === 'rojo')!
  const menu = () => rojo().places?.find((p) => p.file === 'menu.project.json')
  return { root, supervisor, rojo, menu, logs }
}

// ---- supervisor ----

test('a second Start keeps a running Menu serve (no orphan on 34875); a given-up Menu is replaced, its old child stopped', shOnly, async () => {
  rmSync(runs, { force: true })
  writeFileSync(join(busy, '34875'), '')
  const { root, supervisor, rojo, menu, logs } = makeSupervisor({ rojoRestart: { backoffMs: [10], maxQuickFailures: 2 } })
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await supervisor.start('rojo')
    // Menu cannot bind: it gives up with a clear reason, while Match serves.
    await waitFor(() => menu()?.state === 'gave-up')
    assert.equal(menu()?.error, 'port 34875 is in use by another process (old rojo?)')
    assert.equal(rojo().state, 'running')
    assert.equal(serveView(rojo(), 34872).label, 'Serving FSF · Menu crashed')
    assert.equal(supervisor.rojoState('menu.project.json'), 'stopped', 'a given-up serve is not serving')
    assert.ok(logs.some((l) => /rojo:menu\.project\.json: port 34875 is in use by another process \(old rojo\?\)/.test(l.text)))
    const match = servesOn(34872)
    assert.equal(match.length, 1)

    // The port is free again: Start (Doctor "Start rojo", the titlebar) brings Menu back up and leaves
    // the running Match serve alone.
    rmSync(join(busy, '34875'))
    await supervisor.start('rojo')
    await waitFor(() => menu()?.state === 'serving')
    assert.deepEqual(servesOn(34872), match, 'Match was not restarted')
    // Another Start while both serve: nothing new is spawned, and never a second Menu rojo.
    await supervisor.start('rojo')
    await sleep(150)
    const menus = servesOn(34875)
    assert.equal(menus.filter((m) => m.alive).length, 1)
    assert.equal(menus.length, 4, 'first run + 2 restarts before giving up, then the one Start brought back')
    assert.equal(serveView(rojo(), 34872).label, 'Serving')
  } finally {
    await supervisor.stopAll()
  }
  assert.equal(servesOn(34875).filter((m) => m.alive).length, 0, 'stop leaves no rojo behind')
})

test('per-place serve status: a held Menu shows next to a serving Match; every stop says why', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, rojo, menu, logs } = makeSupervisor()
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => menu()?.state === 'serving' && rojo().state === 'running')
    assert.deepEqual(rojo().places?.map((p) => [p.name, p.state, p.primary, p.port]), [
      ['FSF', 'serving', true, 34872],
      ['Menu', 'serving', false, 34875]
    ])
    supervisor.setGate('menu.project.json', 'blocked', '2 conflicts: resolve or serve anyway')
    await waitFor(() => menu()?.state === 'held')
    assert.equal(rojo().state, 'running')
    assert.equal(rojo().hold, undefined, 'the primary serve is not held')
    const view = serveView(rojo(), 34872)
    assert.equal(view.label, 'Serving FSF · Menu held')
    assert.match(view.title, /○ Menu held \(:34875\)/)
    assert.equal(supervisor.rojoState('menu.project.json'), 'held')
    assert.ok(logs.some((l) => l.text === 'stopping rojo:menu.project.json because menu.project.json is held (2 conflicts: resolve or serve anyway); it starts again when Studio and disk agree'))
    // The Doctor's served ports come from this, not from the settings.
    assert.equal(supervisor.rojoPlaces().find((p) => p.file === 'menu.project.json')?.state, 'held')
    assert.equal(supervisor.servesPort(34875), false)
    assert.equal(supervisor.servesPort(34872), true)
  } finally {
    await supervisor.stopAll()
  }
  assert.ok(logs.some((l) => l.text === 'stopping rojo:default.project.json because the project closed'))
})

test('a hold that cut off a serving Menu: when it serves again, "click Connect in Rojo (port 34875) in Menu Studio"', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, rojo, menu, logs } = makeSupervisor()
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => menu()?.state === 'serving')
    assert.equal(supervisor.rojoReconnect('menu.project.json'), null)
    supervisor.setGate('menu.project.json', 'checking', 'Waiting for Studio sync check')
    await waitFor(() => menu()?.state === 'checking')
    supervisor.setGate('menu.project.json', 'clear')
    await waitFor(() => menu()?.state === 'serving' && !!menu()?.reconnect)
    assert.equal(supervisor.rojoReconnect('menu.project.json')?.port, 34875)
    assert.equal(supervisor.rojoReconnect('default.project.json'), null, 'Match was not touched')
    assert.ok(logs.some((l) => l.stream === 'stderr' && /rojo:menu\.project\.json serves again\. Studio's Rojo plugin was disconnected: click Connect in Rojo \(port 34875\) in Menu Studio/.test(l.text)))
    assert.equal(serveView(rojo(), 34872).label, 'Serving FSF · Menu reconnect Rojo')
    supervisor.clearRojoReconnect('menu.project.json')
    assert.equal(supervisor.rojoReconnect('menu.project.json'), null)
    await waitFor(() => !menu()?.reconnect)
    assert.equal(serveView(rojo(), 34872).label, 'Serving')
  } finally {
    await supervisor.stopAll()
  }
})

test('a file Forge Sync writes for Menu pauses only the Menu serve', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, menu, logs } = makeSupervisor()
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => menu()?.state === 'serving')
    const match = servesOn(34872)
    assert.equal(await supervisor.pausePlace('menu.project.json', 'new file from Studio'), true)
    assert.equal(supervisor.rojoState('menu.project.json'), 'stopped')
    assert.equal(supervisor.rojoState('default.project.json'), 'serving')
    await supervisor.resumePlace('menu.project.json')
    await waitFor(() => menu()?.state === 'serving')
    assert.deepEqual(servesOn(34872), match, 'Match kept serving (its Rojo plugin stays connected)')
    assert.equal(servesOn(34875).filter((m) => m.alive).length, 1)
    assert.ok(logs.some((l) => l.text === 'stopping rojo:menu.project.json because of a new file from Studio for menu.project.json'))
  } finally {
    await supervisor.stopAll()
  }
})

// ---- Forge Sync gate + supervisor (the Menu repro) ----

// A stand-in for the SyncEngine: snapshots reconcile to 'clear', or 'blocked' while `held` has conflicts.
class FakeEngine implements SyncEngineLike {
  gates = new Map<string, GateState>()
  held: SyncConflictInfo[] = []
  private listeners: (() => void)[] = []
  reload() {}
  beginSnapshot(placeKey: string, _place: SyncPlace) {
    this.gates.set(placeKey, 'checking')
  }
  addSnapshot() {}
  async finishSnapshot(placeKey: string): Promise<SyncEntry[]> {
    this.gates.set(placeKey, this.held.some((c) => c.placeKey === placeKey) ? 'blocked' : 'clear')
    return []
  }
  async applyChanges(_placeKey: string, _changes: StudioChange[]): Promise<SyncEntry[]> {
    return []
  }
  conflicts() {
    return this.held.slice()
  }
  async resolve() {}
  resolveAll() {}
  endSession(placeKey: string) {
    this.gates.set(placeKey, 'idle')
    for (const fn of this.listeners) fn()
  }
  gate(placeKey: string): GateState {
    return this.gates.get(placeKey) ?? 'idle'
  }
  on(_event: 'changed', fn: () => void) {
    this.listeners.push(fn)
  }
}

const MAPS: PlaceMapLike[] = [
  { projectFile: 'default.project.json', name: 'FSF', servePort: 34872, placeIds: [111], roots: [{ instance: ['ReplicatedStorage', 'Shared'], path: 'src/shared' }] },
  { projectFile: 'menu.project.json', name: 'Menu', servePort: 34875, placeIds: [222], roots: [{ instance: ['ReplicatedStorage', 'Shared', 'Modules'], path: 'src/menu/shared/Modules' }] }
]
const MENU = { placeId: 222, name: 'Menu' }

function makeSync(supervisor: Supervisor, root: string) {
  let now = 1_000_000
  const engine = new FakeEngine()
  const gates: [string, GateState][] = []
  const logs: string[] = []
  const service = new SyncService({
    root,
    engine,
    mapping: { loadPlaces: async () => MAPS, placeFor: (maps, id) => maps.find((m) => m.placeIds.includes(id)) ?? null },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: (args) => run('git', args, root),
    pluginsDir: () => null,
    rojo: (file) => supervisor.rojoState(file),
    rojoReconnect: (file) => supervisor.rojoReconnect(file),
    rojoConnected: (file) => supervisor.clearRojoReconnect(file),
    onGate: (file, gate, detail, reason) => {
      gates.push([file, gate])
      supervisor.setGate(file, gate, detail, reason)
    },
    emit: () => undefined,
    log: (text) => logs.push(text),
    now: () => now
  })
  const menuGates = () => gates.filter(([f]) => f === 'menu.project.json').map(([, g]) => g)
  return { service, engine, gates, menuGates, logs, advance: (ms: number) => (now += ms) }
}

// One full Studio check from a window (config + a one-chunk snapshot).
async function check(service: SyncService, probe: string, missing = false): Promise<string> {
  const { sessionToken } = await service.handler.config({ placeId: 222, place: 'Menu', probe, mode: 'edit' })
  const nodes: StudioNode[] = missing ? [] : [{ id: 'm', path: ['ReplicatedStorage', 'Shared', 'Modules'], className: 'Folder' }]
  const answer = await service.handler.snapshot({ mode: 'edit', session: sessionToken, place: MENU, seq: 0, final: true, nodes })
  assert.deepEqual(answer, { ok: true })
  await tick()
  return sessionToken
}

test('repro (Menu, 21:20:45): Rojo builds a missing root, the plugin re-sends its snapshot: rojo keeps serving; a re-check with real conflicts still holds it', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, menu } = makeSupervisor()
  const { service, engine, menuGates, logs } = makeSync(supervisor, root)
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await service.start()
    await supervisor.start('rojo')
    await sleep(100)
    assert.equal(menu()?.state, 'waiting', 'no Studio check yet')
    assert.equal(servesOn(34875).length, 0)

    // Studio opens Menu; ReplicatedStorage.Shared.Modules is not in Studio until Rojo connects.
    await check(service, 'run-1', true)
    await waitFor(() => menu()?.state === 'serving')
    const first = servesOn(34875)
    assert.equal(first.length, 1)
    const seen = menuGates().length

    // Rojo connects and builds the root; the plugin says "... is in Studio now; sending a fresh
    // snapshot": config + snapshot from the same window (same run id).
    const token = await check(service, 'run-1')
    // ... and a restarted snapshot inside the same session (seq 0 again).
    await service.handler.snapshot({ mode: 'edit', session: token, place: MENU, seq: 0, final: true, nodes: [] })
    await tick()
    await sleep(100)
    assert.ok(!menuGates().slice(seen).includes('checking'), `the gate never went to checking: ${menuGates().slice(seen).join(', ')}`)
    assert.deepEqual(servesOn(34875), first, 'the Menu rojo was not stopped or restarted')
    assert.equal(supervisor.rojoReconnect('menu.project.json'), null, 'nothing to reconnect')
    assert.ok(logs.some((l) => /same Studio window checking again, rojo keeps serving/.test(l)))

    // A re-check that finds a real conflict (both sides changed) still holds rojo.
    engine.held = [{ placeKey: '222', file: 'src/menu/shared/Modules/Card.luau', instancePath: ['ReplicatedStorage', 'Shared', 'Modules', 'Card'], base: 'a\n', disk: 'b\n', studio: 'c\n', reason: 'both-changed' }]
    await check(service, 'run-1')
    await waitFor(() => menu()?.state === 'held')
    assert.equal(servesOn(34875).filter((m) => m.alive).length, 0)
    assert.ok(logs.some((l) => /rojo serve stops: the re-check found something to hold/.test(l)))

    // Resolved: it serves again, and says the Rojo plugin needs Connect.
    engine.held = []
    await check(service, 'run-1')
    await waitFor(() => menu()?.state === 'serving' && !!supervisor.rojoReconnect('menu.project.json'))
    const status = await service.status()
    const drift = status.places.find((p) => p.projectFile === 'menu.project.json')?.drift
    assert.equal(drift?.cause, 'rojo-disconnected')
    assert.equal(drift?.text, "Studio's Rojo plugin was disconnected: click Connect in Rojo (port 34875) in Menu Studio")
    assert.equal(drift?.fix, 'reconnected')
    // The user clicks Connected (or Studio shows Rojo connected): the notice goes.
    await service.rojoReconnected('menu.project.json')
    assert.equal(supervisor.rojoReconnect('menu.project.json'), null)
  } finally {
    service.close()
    await supervisor.stopAll()
  }
})

test('a new Studio window (another run id) is a full check: rojo waits for it, as before', async () => {
  const supervisor = new Supervisor({ log: () => undefined, onStatus: () => undefined, getSetting: <T>(_k: string, fb: T) => fb })
  const root = makeProject()
  temps.push(root)
  const { service, menuGates, advance } = makeSync(supervisor, root)
  try {
    await service.start()
    await check(service, 'run-1')
    assert.equal(menuGates().at(-1), 'clear')
    // That window closed (no polls); Menu is opened again in a new Studio window before the session expired.
    advance(60_000)
    const { sessionToken } = await service.handler.config({ placeId: 222, place: 'Menu', probe: 'run-2', mode: 'edit' })
    await tick()
    assert.equal(menuGates().at(-1), 'checking')
    await service.handler.snapshot({ mode: 'edit', session: sessionToken, place: MENU, seq: 0, final: true, nodes: [] })
    await tick()
    assert.equal(menuGates().at(-1), 'clear')
  } finally {
    service.close()
  }
})

test('Serve anyway sticks: through a re-check with conflicts and the Forge Bridge going quiet (session expiry), until Hold again', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, menu } = makeSupervisor()
  const { service, engine, menuGates, advance } = makeSync(supervisor, root)
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces(PLACES, 'default.project.json')
    await service.start()
    await supervisor.start('rojo')
    engine.held = [{ placeKey: '222', file: 'src/menu/shared/Modules/Card.luau', instancePath: ['ReplicatedStorage', 'Shared', 'Modules', 'Card'], base: 'a\n', disk: 'b\n', studio: 'c\n', reason: 'both-changed' }]
    await check(service, 'run-1')
    await waitFor(() => menu()?.state === 'held')
    await service.serveAnyway('222')
    await waitFor(() => menu()?.state === 'serving')
    const served = servesOn(34875)
    const seen = menuGates().length
    // The plugin re-checks (still conflicts), then the user switches the Forge Bridge off in that
    // window: no polls, the session expires.
    await check(service, 'run-1')
    advance(SESSION_EXPIRE_MS + 1000)
    service.expireSessions()
    await tick()
    await sleep(100)
    assert.ok(!menuGates().slice(seen).some((g) => g === 'blocked' || g === 'waiting' || g === 'checking'), menuGates().join(', '))
    assert.deepEqual(servesOn(34875), served, 'the Menu rojo kept serving')
    // Hold again: the gate applies (no Studio session now: waiting) and rojo stops.
    await service.stopServingAnyway('menu.project.json')
    await waitFor(() => menu()?.state === 'waiting')
    await waitFor(() => servesOn(34875).every((m) => !m.alive), 2000)
  } finally {
    service.close()
    await supervisor.stopAll()
  }
})

// ---- globIgnorePaths and explicit children (menu.project.json) ----

test('rojoGlob follows globset: * and ? cross /, **/ prefix, /** suffix (not the folder itself), classes, alternatives', () => {
  const m = (glob: string, path: string) => rojoGlob(glob)!.test(path)
  assert.ok(m('src/menu/shared/Modules/MatchSfx.luau', 'src/menu/shared/Modules/MatchSfx.luau'))
  assert.ok(!m('src/menu/shared/Modules/MatchSfx.luau', 'src/menu/shared/Modules/MatchSfx.luau.bak'))
  assert.ok(m('src/menu/shared/Modules/GoalExplosions/**', 'src/menu/shared/Modules/GoalExplosions/Styles/Fire.luau'))
  assert.ok(!m('src/menu/shared/Modules/GoalExplosions/**', 'src/menu/shared/Modules/GoalExplosions'))
  assert.ok(m('**/*.spec.luau', 'src/a/b/x.spec.luau'))
  assert.ok(m('**/x.luau', 'x.luau'))
  assert.ok(m('src/*.luau', 'src/deep/er/x.luau'), 'globset: * matches / by default')
  assert.ok(m('src/a/**/x.luau', 'src/a/x.luau'))
  assert.ok(m('src/a/**/x.luau', 'src/a/b/c/x.luau'))
  assert.ok(m('src/menu/shared/Modules/{MatchSfx,PitchGeometry}.luau', 'src/menu/shared/Modules/PitchGeometry.luau'))
  assert.ok(m('src/menu/shared/Modules/GoalExplosion[CS]*.luau', 'src/menu/shared/Modules/GoalExplosionCard.luau'))
  assert.ok(!m('src/menu/shared/Modules/GoalExplosion[!C]*.luau', 'src/menu/shared/Modules/GoalExplosionCard.luau'))
  assert.ok(m('src/a?c.luau', 'src/abc.luau'))
  assert.ok(m('src/a.b(1).luau', 'src/a.b(1).luau'))
  assert.equal(rojoGlob('src/[abc'), null)
  assert.equal(rojoGlob('src/{a,b'), null)
})

function put(root: string, rel: string, text: string): void {
  mkdirSync(dirname(join(root, rel)), { recursive: true })
  writeFileSync(join(root, rel), text)
}

const SHARED = 'return "shared copy"\n'
const COPY = 'return "menu folder copy"\n'
const MODULES = ['ReplicatedStorage', 'Shared', 'Modules']

// FSF's menu place: the Modules $path folder holds copies of modules the project also maps as
// explicit children (to src/shared).
function menuProject(globIgnorePaths?: string[]): string {
  const root = mkdtempSync(join(tmpdir(), 'menu-dup-'))
  temps.push(root)
  const project = {
    name: 'Menu',
    servePort: 34875,
    servePlaceIds: [222],
    ...(globIgnorePaths ? { globIgnorePaths } : {}),
    tree: {
      $className: 'DataModel',
      ReplicatedStorage: {
        Shared: {
          $path: 'src/menu/shared',
          Modules: {
            $path: 'src/menu/shared/Modules',
            MatchSfx: { $path: 'src/shared/MatchSfx.luau' },
            GoalExplosions: { $path: 'src/shared/GoalExplosions' }
          }
        }
      }
    }
  }
  put(root, 'menu.project.json', JSON.stringify(project, null, 2))
  put(root, 'src/shared/MatchSfx.luau', SHARED)
  put(root, 'src/shared/GoalExplosions/Fire.luau', 'return "fire"\n')
  put(root, 'src/menu/shared/Modules/MatchSfx.luau', COPY)
  put(root, 'src/menu/shared/Modules/GoalExplosions/Fire.luau', 'return "old fire"\n')
  put(root, 'src/menu/shared/Modules/Card.luau', 'return "card"\n')
  put(root, 'src/menu/shared/Modules/Junk.luau', 'return "ignored"\n')
  return root
}

test('duplicate mapping: names the explicit child and the folder copies Rojo also builds; globIgnorePaths covers them', async () => {
  const root = menuProject()
  const [menu] = await loadPlaces(root)
  const dups = await duplicateMappings(menu)
  assert.deepEqual(
    dups.map((d) => [d.instance.join('.'), d.explicit, d.copies]),
    [
      ['ReplicatedStorage.Shared.Modules.MatchSfx', 'src/shared/MatchSfx.luau', ['src/menu/shared/Modules/MatchSfx.luau']],
      ['ReplicatedStorage.Shared.Modules.GoalExplosions', 'src/shared/GoalExplosions', ['src/menu/shared/Modules/GoalExplosions/']]
    ]
  )
  assert.equal(
    duplicateMappingText(dups[0]),
    'menu.project.json maps ReplicatedStorage.Shared.Modules.MatchSfx twice: src/shared/MatchSfx.luau and src/menu/shared/Modules/MatchSfx.luau (inside the $path folder src/menu/shared/Modules). Rojo builds both, so Studio gets two instances named MatchSfx; add the copy to "globIgnorePaths" in menu.project.json, or delete it'
  )
  // The modules folder's own "Modules" entry under src/menu/shared is the explicit Modules node.
  assert.ok(!dups.some((d) => d.instance.join('.') === 'ReplicatedStorage.Shared.Modules'))

  // GoalExplosions/** leaves the (then empty) folder itself: Rojo still builds an empty GoalExplosions.
  const partly = await loadPlaces(menuProject(['src/menu/shared/Modules/MatchSfx.luau', 'src/menu/shared/Modules/GoalExplosions/**']))
  assert.deepEqual((await duplicateMappings(partly[0])).map((d) => d.copies), [['src/menu/shared/Modules/GoalExplosions/']])
  const fixed = await loadPlaces(menuProject(['src/menu/shared/Modules/MatchSfx.luau', 'src/menu/shared/Modules/GoalExplosions']))
  assert.deepEqual(await duplicateMappings(fixed[0]), [])
})

test('mapping honours globIgnorePaths and prefers the explicit child over a same-name folder copy', async () => {
  const root = menuProject(['src/menu/shared/Modules/Junk.luau'])
  const [menu] = await loadPlaces(root)
  assert.deepEqual(menu.ignoreGlobs, ['src/menu/shared/Modules/Junk.luau'])
  assert.equal(rojoIgnored(menu, 'src/menu/shared/Modules/Junk.luau'), true)
  assert.equal(rojoIgnored(menu, 'src/menu/shared/Modules/Card.luau'), false)
  assert.equal(fromDisk(menu, 'src/menu/shared/Modules/Junk.luau'), null)
  assert.equal(insideMappedRoots(menu, 'src/menu/shared/Modules/Junk.luau'), false)
  assert.deepEqual(fromDisk(menu, 'src/menu/shared/Modules/Card.luau'), [...MODULES, 'Card'])
  // The folder copy builds nothing for Forge Sync; the explicit file is MatchSfx.
  assert.deepEqual(shadowedBy(menu, 'src/menu/shared/Modules/MatchSfx.luau'), [...MODULES, 'MatchSfx'])
  assert.deepEqual(shadowedBy(menu, 'src/menu/shared/Modules/GoalExplosions/Fire.luau'), [...MODULES, 'GoalExplosions'])
  assert.equal(fromDisk(menu, 'src/menu/shared/Modules/MatchSfx.luau'), null)
  assert.equal(fromDisk(menu, 'src/menu/shared/Modules/GoalExplosions/Fire.luau'), null)
  assert.deepEqual(fromDisk(menu, 'src/shared/MatchSfx.luau'), [...MODULES, 'MatchSfx'])
  assert.equal(toDisk(menu, { path: [...MODULES, 'MatchSfx'], className: 'ModuleScript' })?.file, 'src/shared/MatchSfx.luau')
  // An instance Rojo would read back from an ignored file is not on disk for this place.
  assert.equal(toDisk(menu, { path: [...MODULES, 'Junk'], className: 'ModuleScript' }), null)
})

test('engine: two Studio copies at an explicit child (Rojo built the folder copy too) are not a duplicate conflict; the explicit one syncs, the copy is left alone', async () => {
  const root = menuProject(['src/menu/shared/Modules/Junk.luau'])
  const engine = new SyncEngine({ root, now: () => Date.UTC(2026, 9, 18) })
  await engine.places()
  const place = { placeId: 222, name: 'Menu' }
  const folder = (path: string[]): StudioNode => ({ id: path.join('/'), path, className: 'Folder' })
  const mod = (id: string, name: string, source: string): StudioNode => ({ id, path: [...MODULES, name], className: 'ModuleScript', source })
  // What Rojo builds without the ignore rules for these: the folder copy first (so "the first node at
  // the path" would be the wrong one), then the explicit child; Junk is ignored, so Studio lacks it.
  const nodes: StudioNode[] = [
    folder(['ReplicatedStorage', 'Shared']),
    folder(MODULES),
    mod('copy', 'MatchSfx', COPY),
    mod('explicit', 'MatchSfx', SHARED),
    mod('card', 'Card', 'return "card"\n'),
    folder([...MODULES, 'GoalExplosions']),
    { id: 'fire', path: [...MODULES, 'GoalExplosions', 'Fire'], className: 'ModuleScript', source: 'return "fire"\n' }
  ]
  engine.beginSnapshot('222', place, 'menu.project.json')
  engine.addSnapshot('222', nodes)
  const entries = await engine.finishSnapshot('222')
  assert.deepEqual(entries.filter((e) => e.action === 'conflict' || e.action === 'pulled' || e.action === 'trashed').map((e) => `${e.action} ${e.file}`), [])
  assert.equal(engine.gate('222'), 'clear')
  assert.equal(readFileSync(join(root, 'src/shared/MatchSfx.luau'), 'utf8'), SHARED, 'the folder copy was not written over the explicit file')
  assert.equal(readFileSync(join(root, 'src/menu/shared/Modules/MatchSfx.luau'), 'utf8'), COPY)
  assert.ok(existsSync(join(root, 'src/menu/shared/Modules/Junk.luau')), 'an ignored file is not "deleted in Studio"')

  // A Studio edit of the explicit child goes to its file; the copy stays.
  const live = await engine.applyChanges('222', [{ kind: 'source', node: mod('explicit', 'MatchSfx', 'return "edited"\n') }])
  assert.deepEqual(live.filter((e) => e.action === 'pulled').map((e) => e.file), ['src/shared/MatchSfx.luau'])
  assert.equal(readFileSync(join(root, 'src/shared/MatchSfx.luau'), 'utf8'), 'return "edited"\n')
  assert.equal(readFileSync(join(root, 'src/menu/shared/Modules/MatchSfx.luau'), 'utf8'), COPY)
  // Neither the folder copy nor the ignored file counts as Studio being behind disk.
  put(root, 'src/menu/shared/Modules/MatchSfx.luau', 'return "copy edited"\n')
  put(root, 'src/menu/shared/Modules/Junk.luau', 'return "ignored, edited"\n')
  assert.deepEqual((await engine.drift('menu.project.json', '222'))?.files.map((f) => f.file), [])
})

test('Explorer tree: globIgnorePaths entries are left out, and the explicit child replaces the folder copy', async () => {
  const root = menuProject(['src/menu/shared/Modules/Junk.luau'])
  const project = JSON.parse(readFileSync(join(root, 'menu.project.json'), 'utf8'))
  const tree = await buildRepoTree(root, project)
  const rs = tree.find((n) => n.name === 'ReplicatedStorage')!
  const modules = rs.children.find((n) => n.name === 'Shared')!.children.find((n) => n.name === 'Modules')!
  assert.deepEqual(modules.children.map((n) => `${n.name}:${n.filePath ?? ''}`).sort(), ['Card:src/menu/shared/Modules/Card.luau', 'GoalExplosions:', 'MatchSfx:src/shared/MatchSfx.luau'])
  const ge = modules.children.find((n) => n.name === 'GoalExplosions')!
  assert.deepEqual(ge.children.map((n) => n.filePath), ['src/shared/GoalExplosions/Fire.luau'])
})

// ---- Doctor ----

function inputs(): DoctorInputs {
  return {
    ports: [],
    project: { root: '/p', projectFiles: [], wallyToml: false, packagesInstalled: false, rokitToml: false, projectToolsMissing: [], sourcemap: { exists: true, ageMs: 1 } }
  } as unknown as DoctorInputs
}

test('Doctor: a stray rojo on a serve port gets "Stop stray rojo"; another program only the instruction; duplicate mappings warn', () => {
  const i = inputs()
  i.ports = [
    { port: 34875, label: 'rojo serve (Menu)', state: 'other', expected: false, owner: { pid: 4242, name: 'rojo.exe', rojo: true } },
    { port: 34872, label: 'rojo serve (FSF)', state: 'other', expected: false, owner: { pid: 7, name: 'node', rojo: false } }
  ]
  const c = Object.fromEntries(portChecks(i).map((x) => [x.id, x]))
  assert.equal(c['port-34875'].status, 'fail')
  assert.match(c['port-34875'].detail, /Port 34875 is in use by another process: a rojo Forge does not run \(rojo\.exe, pid 4242/)
  assert.deepEqual(c['port-34875'].fix, { kind: 'action', action: 'stopStrayRojo', label: 'Stop stray rojo' })
  assert.equal(c['port-34872'].fix?.kind, 'instruction')
  i.project!.duplicateMappings = ['menu.project.json maps ReplicatedStorage.Shared.Modules.MatchSfx twice: x']
  const dup = projectChecks(i, 0).find((x) => x.id === 'dup-mapping-0')
  assert.equal(dup?.status, 'warn')
  assert.deepEqual(dup?.fix, { kind: 'open', target: 'file:menu.project.json', label: 'Open file' })
})

test('port owner parsers: netstat / tasklist on Windows, lsof elsewhere', () => {
  const netstat = '\r\nActive Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1000\r\n  TCP    127.0.0.1:34875        0.0.0.0:0              LISTENING       4242\r\n  TCP    127.0.0.1:34875        127.0.0.1:50000        ESTABLISHED     4242\r\n  TCP    [::1]:34875            [::]:0                 LISTENING       4242\r\n  TCP    127.0.0.1:348750       0.0.0.0:0              LISTENING       9\r\n'
  assert.deepEqual(parseNetstat(netstat, 34875), [4242])
  assert.equal(parseTasklist('"rojo.exe","4242","Console","1","25,000 K"\r\n'), 'rojo.exe')
  assert.equal(parseTasklist('INFO: No tasks are running which match the specified criteria.'), '')
  assert.deepEqual(parseLsof('p4242\ncrojo\np7\ncnode\n'), [{ pid: 4242, name: 'rojo' }, { pid: 7, name: 'node' }])
  assert.ok(isRojoProcess('rojo.exe') && isRojoProcess('rojo') && !isRojoProcess('rokit') && !isRojoProcess('rojo-helper'))
})
