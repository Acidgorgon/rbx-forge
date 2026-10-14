import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import type { LogLine, ServiceStatus } from '../src/shared/types.ts'
import { gateHolds, Supervisor, syncEngineOf } from '../src/main/services/supervisor.ts'
import { makeProject, write } from './fixture.ts'

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
  assert.equal(gateHolds('clear'), false)
  assert.equal(gateHolds('idle'), false)
  assert.equal(gateHolds(undefined), false)
  assert.equal(syncEngineOf((_k, fb) => fb), 'forge')
  assert.equal(syncEngineOf(<T>(_k: string, _fb: T) => 'project' as T), 'project')
  assert.equal(syncEngineOf(<T>(_k: string, _fb: T) => 'nonsense' as T), 'forge')
})

test('rojo serve waits while the place is checking or blocked, stops for a new Studio session, restarts when clear', async () => {
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

test('only the gated place waits when every place is served', async () => {
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

test('no gate with the project engine or with the gate setting off; turning it off releases a held serve', async () => {
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
