import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import type { LogLine, ServiceStatus } from '../src/shared/types.ts'
import { gateHolds, Supervisor, syncEngineOf } from '../src/main/services/supervisor.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { SESSION_EXPIRE_MS, SyncService } from '../src/main/services/sync/service.ts'
import { serveView } from '../src/shared/rojoView.ts'
import { PLUGIN_VERSION, SYNC_GATE_PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import type { StudioNode } from '../src/shared/sync/types.ts'
import { makeProject, write } from './fixture.ts'
import { studioFromDisk } from './syncFixture.ts'

// A fake `rojo` on PATH that records its arguments and stays up like `rojo serve`. HOME points at a
// temp dir so a real ~/.rokit/bin/rojo is not picked first.
const home = mkdtempSync(join(tmpdir(), 'gate-home-'))
const bin = mkdtempSync(join(tmpdir(), 'gate-bin-'))
const runs = join(bin, 'runs.log')
process.env.HOME = home
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
process.env.GATE_RUNS = runs
write(bin, 'rojo', '#!/bin/sh\necho "$@" >> "$GATE_RUNS"\necho "Rojo server listening: Port: 34872"\nexec sleep 60\n')
chmodSync(join(bin, 'rojo'), 0o755)

const roots: string[] = [home, bin]
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

// The fake rojo is a sh script, so the tests that start it run on macOS and Linux only; the gate
// logic itself has no platform-specific code.
const shOnly = { skip: process.platform === 'win32' ? 'fake rojo is a sh script' : false }

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}
const serves = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter((l) => l.startsWith('serve')) : [])

function make(settings: Record<string, unknown> = {}) {
  const root = makeProject()
  roots.push(root)
  let statuses: ServiceStatus[] = []
  const logs: Omit<LogLine, 'at'>[] = []
  const values = { ...settings }
  const supervisor = new Supervisor({
    log: (line) => logs.push(line),
    onStatus: (s) => (statuses = s),
    getSetting: <T>(key: string, fallback: T) => (key in values ? (values[key] as T) : fallback)
  })
  const rojo = () => statuses.find((s) => s.id === 'rojo')
  const sync = () => statuses.find((s) => s.id === 'studioSync')
  return { root, supervisor, rojo, sync, logs, values }
}

test('gate states that hold rojo serve, and the engine setting', () => {
  assert.equal(gateHolds('checking'), true)
  assert.equal(gateHolds('blocked'), true)
  assert.equal(gateHolds('waiting'), true)
  assert.equal(gateHolds('clear'), false)
  assert.equal(gateHolds('idle'), false)
  assert.equal(gateHolds(undefined), false)
  assert.equal(syncEngineOf((_k, fb) => fb), 'forge')
  assert.equal(syncEngineOf(<T>(_k: string, _fb: T) => 'project' as T), 'project')
  assert.equal(syncEngineOf(<T>(_k: string, _fb: T) => 'nonsense' as T), 'forge')
})

test('rojo serve waits while the place is checking or blocked, stops for a new Studio session, restarts when clear', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, rojo, logs } = make()
  await supervisor.setRoot(root)
  await supervisor.setPlaces([{ file: 'default.project.json', name: 'default', isDefault: true, servePort: 34872, sourcemap: 'sourcemap.json' } as never], 'default.project.json')
  supervisor.setGate('default.project.json', 'checking', 'Waiting for Studio sync check')
  await supervisor.start('rojo')
  assert.equal(rojo()?.state, 'starting')
  assert.equal(rojo()?.detail, 'Waiting for Studio sync check (default.project.json)')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(serves().length, 0)

  supervisor.setGate('default.project.json', 'clear')
  await waitFor(() => serves().length === 1 && rojo()?.state === 'running')
  assert.equal(serves()[0], 'serve default.project.json --port 34872')

  // A new Studio session for the served place: stop, reconcile, restart.
  supervisor.setGate('default.project.json', 'checking', 'Waiting for Studio sync check')
  await waitFor(() => rojo()?.state === 'starting' && !rojo()?.pid)
  supervisor.setGate('default.project.json', 'blocked', '2 conflicts: resolve or serve anyway')
  assert.equal(rojo()?.detail, '2 conflicts: resolve or serve anyway (default.project.json)')
  await new Promise((r) => setTimeout(r, 200))
  assert.equal(serves().length, 1)
  assert.notEqual(rojo()?.state, 'crashed')
  assert.equal(rojo()?.restarts, 0)

  supervisor.setGate('default.project.json', 'idle')
  await waitFor(() => serves().length === 2 && rojo()?.state === 'running')
  assert.ok(logs.some((l) => /stopping rojo serve until Studio and disk agree/.test(l.text)))
  await supervisor.stopAll()
})

test('only the gated place waits when every place is served', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor } = make({ serveAllPlaces: true })
  await supervisor.setRoot(root)
  await supervisor.setPlaces(
    [
      { file: 'default.project.json', name: 'match', isDefault: true, servePort: 34872, sourcemap: 'sourcemap.json' } as never,
      { file: 'menu.project.json', name: 'menu', isDefault: false, servePort: 34875, sourcemap: '.studio-sync/sourcemap.menu.json' } as never
    ],
    'default.project.json'
  )
  supervisor.setGate('menu.project.json', 'checking', 'Waiting for Studio sync check')
  await supervisor.start('rojo')
  await waitFor(() => serves().length === 1)
  await new Promise((r) => setTimeout(r, 150))
  assert.deepEqual(serves(), ['serve default.project.json --port 34872'])
  supervisor.setGate('menu.project.json', 'clear')
  await waitFor(() => serves().length === 2)
  assert.equal(serves()[1], 'serve menu.project.json --port 34875')
  await supervisor.stopAll()
})

test('no gate with the project engine or with the gate setting off; turning it off releases a held serve', shOnly, async () => {
  rmSync(runs, { force: true })
  const project = make({ 'sync.engine': 'project' })
  await project.supervisor.setRoot(project.root)
  project.supervisor.setGate('default.project.json', 'blocked', 'x')
  await project.supervisor.start('rojo')
  await waitFor(() => serves().length === 1)
  await project.supervisor.stopAll()

  rmSync(runs, { force: true })
  const off = make()
  await off.supervisor.setRoot(off.root)
  off.supervisor.setGate('default.project.json', 'blocked', 'x')
  await off.supervisor.start('rojo')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(serves().length, 0)
  off.values['sync.gateRojo'] = false
  off.supervisor.applyGates()
  await waitFor(() => serves().length === 1)
  await off.supervisor.stopAll()
})

test('dev loop gets FORGE_SYNC=1 with Forge Sync; the old studioSync service is not needed', async () => {
  for (const [engine, expected] of [['forge', '1'], ['project', '']] as const) {
    const { root, supervisor, sync } = make({ 'sync.engine': engine })
    write(root, 'dev', '#!/usr/bin/env bash\necho "FORGE_SYNC=${FORGE_SYNC:-}" > forge-sync.env\nexec sleep 60\n')
    write(root, 'Packages/Janitor.lua', '')
    await supervisor.setRoot(root)
    await supervisor.start('dev')
    await waitFor(() => existsSync(join(root, 'forge-sync.env')))
    assert.equal(readFileSync(join(root, 'forge-sync.env'), 'utf8').trim(), `FORGE_SYNC=${expected}`)
    if (engine === 'forge') {
      await supervisor.start('studioSync')
      supervisor.setSyncSummary('running', 'Forge Sync: 1 Studio session')
      assert.deepEqual([sync()?.state, sync()?.detail], ['running', 'Forge Sync: 1 Studio session'])
    } else {
      supervisor.setSyncSummary('running', 'ignored')
      assert.notEqual(sync()?.detail, 'ignored')
    }
    await supervisor.stopAll()
  }
})

test('a waiting place file holds rojo serve with its reason; Serve without Studio check (idle) lets it serve', shOnly, async () => {
  rmSync(runs, { force: true })
  const { root, supervisor, rojo, logs } = make()
  await supervisor.setRoot(root)
  await supervisor.setPlaces([{ file: 'default.project.json', name: 'default', isDefault: true, servePort: 34872, sourcemap: 'sourcemap.json' } as never], 'default.project.json')
  supervisor.setGate('default.project.json', 'waiting', 'Studio has "GenTree" open, but it isn\'t linked to this project', 'unlinked')
  await supervisor.start('rojo')
  await new Promise((r) => setTimeout(r, 150))
  assert.equal(serves().length, 0)
  assert.deepEqual(rojo()?.hold, { gate: 'waiting', file: 'default.project.json', reason: 'unlinked' })
  assert.equal(serveView(rojo(), 34872).kind, 'waiting')
  assert.match(serveView(rojo(), 34872).title, /isn't linked to this project/)
  supervisor.setGate('default.project.json', 'idle', 'Serving without a Studio check (your choice)')
  await waitFor(() => serves().length === 1 && rojo()?.state === 'running')
  assert.equal(rojo()?.hold, undefined)
  assert.ok(logs.some((l) => /serving without a Studio check; starting rojo serve/.test(l.text)), JSON.stringify(logs.map((l) => l.text)))
  await supervisor.stopAll()
})

// ---- Forge Sync + supervisor, in main's order (supervisor.setRoot, setPlaces, sync start, then rojo),
// with a fake Forge Bridge (the Studio windows polling it) and the real engine.

const PLACE_ID = 123 // tools/studio-sync.json placeIds of makeProject()
const CUTSCENE = ['StarterPlayer', 'StarterPlayerScripts', 'Client', 'Client', 'Controllers', 'InventoryController', 'Cutscene']
const CUTSCENE_DIR = 'src/client/Client/Controllers/InventoryController/Cutscene'
const CUTSCENE_NODES: StudioNode[] = [
  { id: 'cut', path: CUTSCENE, className: 'ModuleScript', source: 'return "cutscene"\n' },
  { id: 'cut-body', path: [...CUTSCENE, 'Body'], className: 'ModuleScript', source: 'return "body"\n' },
  { id: 'cut-props', path: [...CUTSCENE, 'Props'], className: 'ModuleScript', source: 'return "props"\n' },
  { id: 'cut-toon', path: [...CUTSCENE, 'Props', 'Toon'], className: 'ModuleScript', source: 'return "toon"\n' }
]

async function forgeSync(opts: { now?: () => number } = {}) {
  const ctx = make()
  let polling: { placeId?: number; place?: string; pluginVersion?: number }[] = []
  const service = new SyncService({
    root: ctx.root,
    engine: new SyncEngine({ root: ctx.root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(key: string, fallback: T) => (key in ctx.values ? (ctx.values[key] as T) : fallback) },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    studios: () => polling,
    emit: () => undefined,
    onGate: (file, gate, detail, reason) => ctx.supervisor.setGate(file, gate, detail, reason),
    ...(opts.now ? { now: opts.now } : {})
  })
  await ctx.supervisor.setRoot(ctx.root)
  await ctx.supervisor.setPlaces([{ file: 'default.project.json', name: 'default', isDefault: true, servePort: 34872, sourcemap: 'sourcemap.json' } as never], 'default.project.json')
  await service.start()
  // Like main: the services start after Forge Sync has pushed its gates.
  await ctx.supervisor.start('rojo')
  const map = placeFor(await loadPlaces(ctx.root), PLACE_ID)!
  const studioNodes = (extra: StudioNode[] = []) => [...studioFromDisk(ctx.root, map), ...extra]
  // A Studio window: it polls the bridge (its plugin version), asks for config and sends its snapshot.
  const studio = async (pluginVersion: number, nodes: StudioNode[]) => {
    polling = [{ placeId: PLACE_ID, place: 'GenTree', pluginVersion }]
    const cfg = await service.handler.config({ placeId: PLACE_ID, place: 'GenTree' })
    assert.equal(cfg.enabled, true)
    await settle()
    // From the config on, the place is being checked: rojo serve is not up.
    assert.equal(ctx.rojo()?.hold?.gate, 'checking')
    assert.equal(ctx.rojo()?.pid, undefined)
    for (let i = 0, seq = 0; i < nodes.length; i += 20, seq++) {
      const r = await service.handler.snapshot({ session: cfg.sessionToken, place: { placeId: PLACE_ID }, seq, final: i + 20 >= nodes.length, nodes: nodes.slice(i, i + 20) })
      assert.equal(r.ok, true, JSON.stringify(r))
    }
    await settle()
  }
  return { ...ctx, service, studio, studioNodes, setPolling: (p: typeof polling) => (polling = p) }
}
const settle = () => new Promise((r) => setTimeout(r, 30))

test('Forge Sync: no rojo serve before Studio\'s first check; an old plugin waits; Studio-only scripts hold; Pull to disk serves', shOnly, async () => {
  rmSync(runs, { force: true })
  let t = 1_000_000
  const ctx = await forgeSync({ now: () => t })
  const { root, service, rojo, studio, studioNodes } = ctx
  try {
    // Project open, no Studio yet: rojo serve waits for Studio's first sync check.
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(serves().length, 0)
    assert.deepEqual(rojo()?.hold, { gate: 'waiting', file: 'default.project.json', reason: 'studio' })
    assert.match(rojo()?.detail ?? '', /Waiting for Studio's first sync check/)

    // Studio was not restarted after the update: its plugin is older than the gate trusts. The check
    // runs and Studio agrees with the disk, but rojo still waits.
    assert.ok(SYNC_GATE_PLUGIN_VERSION > 8)
    await studio(8, studioNodes())
    assert.equal(service.gate(String(PLACE_ID)), 'waiting')
    assert.deepEqual(rojo()?.hold, { gate: 'waiting', file: 'default.project.json', reason: 'plugin' })
    assert.match(rojo()?.detail ?? '', new RegExp(`Restart Studio to update the Forge Bridge plugin \\(v8 → v${PLUGIN_VERSION}\\)`))
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(serves().length, 0)

    // Studio restarted with the current plugin: its check clears the place and rojo starts.
    await studio(PLUGIN_VERSION, studioNodes())
    await waitFor(() => serves().length === 1 && rojo()?.state === 'running')
    assert.equal(rojo()?.hold, undefined)
    // A cutscene module with child modules made in Studio reaches disk live.
    const session = (await service.handler.config({ placeId: PLACE_ID, place: 'GenTree' })).sessionToken
    await settle()
    await service.handler.snapshot({ session, place: { placeId: PLACE_ID }, seq: 0, final: true, nodes: studioNodes() })
    await waitFor(() => serves().length === 2 && rojo()?.state === 'running')
    const [cut, ...kids] = CUTSCENE_NODES
    assert.equal((await service.handler.changes({ session, place: { placeId: PLACE_ID }, changes: [{ kind: 'added', node: cut, descendants: kids }] })).ok, true)
    assert.ok(existsSync(join(root, CUTSCENE_DIR, 'Props', 'Toon.luau')))

    // Studio closes. Its session ends: rojo stops and waits for the next Studio check.
    ctx.setPolling([])
    t += SESSION_EXPIRE_MS + 1
    service.expireSessions()
    await settle()
    await waitFor(() => rojo()?.hold?.gate === 'waiting' && rojo()?.pid === undefined)

    // The disk loses the cutscene while Studio is closed (a branch switch). Studio reopens with it:
    // checking, then held for 4 Studio-only scripts. rojo never serves in between.
    rmSync(join(root, CUTSCENE_DIR), { recursive: true })
    await studio(PLUGIN_VERSION, studioNodes(CUTSCENE_NODES))
    assert.equal(rojo()?.hold?.gate, 'blocked')
    assert.match(rojo()?.detail ?? '', /4 Studio-only scripts not on disk: pull to disk or serve anyway/)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(serves().length, 2)

    // Pull to disk: the place is clear and rojo serves again.
    await service.pullStudioOnly(String(PLACE_ID))
    await settle()
    await waitFor(() => serves().length === 3 && rojo()?.state === 'running')
    assert.ok(['init.luau', 'Body.luau', 'Props/init.luau', 'Props/Toon.luau'].every((f) => existsSync(join(root, CUTSCENE_DIR, f))))
  } finally {
    service.close()
    await ctx.supervisor.stopAll()
  }
})

test('Forge Sync: an open Studio place that is not linked keeps rojo serve waiting until the user serves without a check; a linked check takes over', shOnly, async () => {
  rmSync(runs, { force: true })
  const ctx = await forgeSync()
  const { service, rojo, studio, studioNodes } = ctx
  try {
    ctx.setPolling([{ placeId: 999, place: 'Other Game', pluginVersion: PLUGIN_VERSION }])
    const other = await service.handler.config({ placeId: 999, place: 'Other Game' })
    assert.equal(other.enabled, false)
    await settle()
    assert.deepEqual(rojo()?.hold, { gate: 'waiting', file: 'default.project.json', reason: 'unlinked' })
    assert.match(rojo()?.detail ?? '', /Studio has "Other Game" open, but it isn't linked to this project/)
    await new Promise((r) => setTimeout(r, 150))
    assert.equal(serves().length, 0)

    // The user's call: serve without a Studio check.
    await service.serveWithoutCheck()
    await waitFor(() => serves().length === 1 && rojo()?.state === 'running')

    // The linked place opens: its check takes over (rojo stops at once), then clears.
    await studio(PLUGIN_VERSION, studioNodes())
    await waitFor(() => serves().length === 2 && rojo()?.state === 'running')
    assert.equal(service.gateFor('default.project.json').gate, 'clear')
  } finally {
    service.close()
    await ctx.supervisor.stopAll()
  }
})

test('Forge Sync: with the gate setting off or the project engine, rojo serves without a Studio check (unchanged)', shOnly, async () => {
  for (const settings of [{ 'sync.gateRojo': false }, { 'sync.engine': 'project' }]) {
    rmSync(runs, { force: true })
    const ctx = make(settings)
    const service = new SyncService({
      root: ctx.root,
      engine: new SyncEngine({ root: ctx.root }),
      mapping: { loadPlaces, placeFor },
      settings: { get: <T>(key: string, fallback: T) => (key in ctx.values ? (ctx.values[key] as T) : fallback) },
      git: async () => ({ code: 1, stdout: '', stderr: '' }),
      pluginsDir: () => null,
      emit: () => undefined,
      onGate: (file, gate, detail, reason) => ctx.supervisor.setGate(file, gate, detail, reason)
    })
    await ctx.supervisor.setRoot(ctx.root)
    await service.start()
    assert.equal(service.gateFor('default.project.json').gate, 'idle')
    await ctx.supervisor.start('rojo')
    await waitFor(() => serves().length === 1)
    service.close()
    await ctx.supervisor.stopAll()
  }
})
