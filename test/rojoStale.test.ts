// A rojo serve left behind by an earlier Forge run (force close, crash, Windows end-task) keeps the
// place's port and pushes stale syncs into Studio. Forge records every rojo it starts
// (userData/serve-pids.json); the next run stops the ones still alive and still named rojo, reports a
// rojo it did not start without touching it (Doctor "Stop stray rojo" frees the port), kills every
// child on quit and tells the user to click Connect in Rojo when a serve was cut off.
// The fake rojo is a sh script that execs a copy of sleep named "rojo" (so `ps` reports the name rojo);
// a "stray" is a real process named rojo that listens (a symlink to node).
import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import type { LogLine, PlaceInfo, ServiceStatus } from '../src/shared/types.ts'
import { Supervisor } from '../src/main/services/supervisor.ts'
import { isAlive, systemProcessTools, type PortOwner, type ProcessTools } from '../src/main/services/portOwner.ts'
import { ServeRecords, servePortOf, type ServeEntry } from '../src/main/services/serveRecord.ts'
import { createDoctorWiring } from '../src/main/services/doctor/wire.ts'
import { makeProject, write } from './fixture.ts'

const linux = process.platform === 'linux'
const only = { skip: linux ? false : 'fake rojo processes are named through Linux symlinks' }

const home = mkdtempSync(join(tmpdir(), 'stale-home-'))
const bin = mkdtempSync(join(tmpdir(), 'stale-bin-'))
const named = mkdtempSync(join(tmpdir(), 'stale-named-'))
const data = mkdtempSync(join(tmpdir(), 'stale-data-'))
const temps: string[] = [home, bin, named, data]
process.env.HOME = home
process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
process.env.ROJO_RUNS = join(bin, 'runs.log')
const runs = process.env.ROJO_RUNS

// Processes whose executable name is "rojo" (sleep, and node for the listening stray) or other.
if (linux) {
  mkdirSync(join(named, 'a'))
  symlinkSync('/usr/bin/sleep', join(named, 'a', 'rojo'))
  mkdirSync(join(named, 'b'))
  symlinkSync(process.execPath, join(named, 'b', 'rojo'))
  process.env.ROJO_SLEEP = join(named, 'a', 'rojo')
}
write(bin, 'rojo', '#!/bin/sh\nfor a in "$@"; do last=$a; done\necho "$$ $@" >> "$ROJO_RUNS"\necho "Rojo server listening: Port: $last"\nexec "$ROJO_SLEEP" 60\n')
chmodSync(join(bin, 'rojo'), 0o755)

const spawned: ChildProcess[] = []
after(() => {
  for (const c of spawned) {
    try {
      if (c.pid) process.kill(c.pid, 'SIGKILL')
    } catch {
      // gone
    }
  }
  for (const d of temps) rmSync(d, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, ms = 6000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer()
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as { port: number }).port
      server.close(() => resolve(port))
    })
  })
}

// A process that outlives this one's interest, like a rojo an earlier Forge left (own process group).
function leftover(file: string, args: string[]): ChildProcess {
  const child = spawn(file, args, { detached: true, stdio: 'ignore' })
  child.unref()
  spawned.push(child)
  return child
}
const strayRojo = (port: number) => leftover(join(named, 'b', 'rojo'), ['-e', `require('net').createServer().listen(${port}, '127.0.0.1'); setTimeout(() => {}, 60000)`])
const oldRojo = () => leftover(join(named, 'a', 'rojo'), ['60'])

async function listening(port: number): Promise<void> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if ((await systemProcessTools.portOwners(port)).length) return
    await sleep(50)
  }
  throw new Error('stray never listened')
}

function setup(options: { tools?: Partial<ProcessTools>; record?: boolean } = {}) {
  const root = makeProject()
  temps.push(root)
  const file = join(data, `serve-pids-${Math.random().toString(36).slice(2)}.json`)
  const logs: Omit<LogLine, 'at'>[] = []
  let statuses: ServiceStatus[] = []
  const supervisor = new Supervisor({
    log: (line) => logs.push(line),
    onStatus: (s) => (statuses = s),
    getSetting: <T>(key: string, fallback: T) => fallback,
    rojoRestart: { backoffMs: [20], maxQuickFailures: 2 },
    ...(options.record === false ? {} : { serveRecordFile: file }),
    processTools: { ...systemProcessTools, ...options.tools }
  })
  const rojo = () => statuses.find((s) => s.id === 'rojo')!
  const place = (port: number): PlaceInfo => ({ file: 'default.project.json', name: 'FSF', isDefault: true, servePort: port, sourcemap: 'sourcemap.json' }) as PlaceInfo
  const records = new ServeRecords(file)
  const entry = (pid: number, port: number, extra: Partial<ServeEntry> = {}): ServeEntry => ({ pid, kind: 'serve', key: 'rojo', place: 'default.project.json', root, port, session: 'previous-run', startedAt: 1, ...extra })
  return { root, supervisor, logs, rojo, place, records, entry, file }
}

const text = (logs: Omit<LogLine, 'at'>[]) => logs.map((l) => l.text)

test('servePortOf: --port, rojo default, not a serve', () => {
  assert.equal(servePortOf(['serve', 'a.project.json', '--port', '34875']), 34875)
  assert.equal(servePortOf(['serve', 'default.project.json']), 34872)
  assert.equal(servePortOf(['sourcemap', 'a.project.json', '--watch']), null)
})

test('a recorded rojo from a previous run is stopped at startup, says so, and the place gets the reconnect notice', only, async () => {
  rmSync(runs, { force: true })
  const port = await freePort()
  const { root, supervisor, logs, rojo, place, records, entry } = setup()
  const old = oldRojo()
  const pid = old.pid as number
  records.write([entry(pid, port)])
  assert.ok(isAlive(pid))
  try {
    await supervisor.setRoot(root)
    assert.ok(!isAlive(pid), 'the leftover rojo is gone')
    assert.ok(text(logs).includes(`stopped a leftover rojo (pid ${pid}) from a previous Forge run on port ${port}`), text(logs).join('\n'))
    assert.equal(records.read().length, 0, 'its record is dropped')

    await supervisor.setPlaces([place(port)], 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => rojo().state === 'running' && !!supervisor.rojoReconnect('default.project.json'))
    assert.equal(supervisor.rojoReconnect('default.project.json')?.port, port)
    assert.ok(logs.some((l) => l.stream === 'stderr' && l.text.includes(`Studio's Rojo plugin was disconnected: click Connect in Rojo (port ${port})`)), text(logs).join('\n'))
    // This run's own serve is recorded under its session.
    assert.deepEqual(records.read().map((e) => [e.kind, e.port, e.session === 'previous-run']), [['serve', port, false]])
  } finally {
    await supervisor.stopAll()
  }
})

test('a recorded pid that is not named rojo any more (pid reuse) is left alone', only, async () => {
  const port = await freePort()
  const { root, supervisor, logs, records, entry } = setup()
  const reused = leftover('/usr/bin/sleep', ['60'])
  const pid = reused.pid as number
  records.write([entry(pid, port)])
  try {
    await supervisor.setRoot(root)
    assert.ok(isAlive(pid), 'not killed: it is sleep now')
    assert.ok(!text(logs).some((t) => /leftover rojo/.test(t)))
    assert.equal(records.read().length, 0, 'the stale record is dropped anyway')
  } finally {
    await supervisor.stopAll()
  }
})

test('a recorded pid that is gone is just dropped', only, async () => {
  const { root, supervisor, logs, records, entry } = setup()
  records.write([entry(2 ** 22 + 12345, 34872)])
  await supervisor.setRoot(root)
  assert.equal(records.read().length, 0)
  assert.ok(!text(logs).some((t) => /leftover/.test(t)))
})

test('a leftover sourcemap watcher is stopped too', only, async () => {
  const { root, supervisor, logs, records, entry } = setup()
  const old = oldRojo()
  const pid = old.pid as number
  records.write([entry(pid, 0, { kind: 'sourcemap', key: 'sourcemap:menu.project.json', port: undefined })])
  await supervisor.setRoot(root)
  assert.ok(!isAlive(pid))
  assert.ok(text(logs).includes(`stopped a leftover rojo sourcemap watcher (pid ${pid}) from a previous Forge run`))
})

test('a rojo on the port that Forge did not start is reported and left running; Doctor "Stop stray rojo" frees the port and the reconnect notice follows', only, async () => {
  rmSync(runs, { force: true })
  const port = await freePort()
  const stray = strayRojo(port)
  const pid = stray.pid as number
  await listening(port)
  const { root, supervisor, logs, rojo, place } = setup()
  const strays: number[] = []
  const doctor = createDoctorWiring({
    platform: 'linux',
    places: () => [place(port)],
    servesPort: (p: number) => supervisor.servesPort(p),
    startRojo: () => supervisor.start('rojo'),
    strayStopped: (p: number) => {
      strays.push(p)
      supervisor.noteStrayStopped(p)
    },
    log: (t: string) => logs.push({ service: 'rojo', stream: 'info', text: t })
  } as never)
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces([place(port)], 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => rojo().gaveUp === true)
    assert.ok(isAlive(pid), 'a rojo Forge did not start is not killed')
    assert.equal(rojo().state, 'crashed')
    assert.match(rojo().detail ?? '', new RegExp(`port ${port} is served by another rojo \\(pid ${pid}\\)`))
    assert.ok(logs.some((l) => l.stream === 'stderr' && l.text.includes(`port ${port} is served by another rojo (pid ${pid})`)), text(logs).join('\n'))
    assert.ok(!existsSync(runs), 'no serve was spawned into the conflict')
    assert.equal(supervisor.rojoPlaces()[0]?.error, `port ${port} is served by another rojo (pid ${pid})`)

    const fixed = await (doctor.handlers.doctorFix as (a: string) => Promise<{ ok: boolean; message: string }>)('stopStrayRojo')
    assert.equal(fixed.ok, true, fixed.message)
    assert.ok(!isAlive(pid), 'the Doctor stopped it')
    assert.deepEqual(strays, [port])
    await waitFor(() => rojo().state === 'running' && !!supervisor.rojoReconnect('default.project.json'))
    assert.ok(existsSync(runs) && readFileSync(runs, 'utf8').includes(`--port ${port}`), 'Forge serves the port now')
  } finally {
    await supervisor.stopAll()
  }
})

test('a normal stop clears the record and leaves no rojo behind; quit (killAllSync) does too', only, async () => {
  rmSync(runs, { force: true })
  const port = await freePort()
  const { root, supervisor, rojo, place, records } = setup()
  await supervisor.setRoot(root)
  await supervisor.setPlaces([place(port)], 'default.project.json')
  await supervisor.start('rojo')
  await waitFor(() => rojo().state === 'running')
  const pid = rojo().pid as number
  assert.deepEqual(records.read().map((e) => e.pid), [pid])
  await supervisor.stopAll()
  assert.ok(!isAlive(pid))
  assert.deepEqual(records.read(), [])

  // Quit: will-quit / exit call killAllSync, which cannot wait for anything.
  await supervisor.setRoot(root)
  await supervisor.setPlaces([place(port)], 'default.project.json')
  await supervisor.start('rojo')
  await waitFor(() => rojo().state === 'running')
  const second = rojo().pid as number
  assert.deepEqual(records.read().map((e) => e.pid), [second])
  supervisor.killAllSync()
  assert.deepEqual(records.read(), [], 'the record is cleared at once')
  await waitFor(() => !isAlive(second))
  await supervisor.stopAll()
})

test('concurrent stopAll calls share one stop (quit stops rojo next to closeProject)', only, async () => {
  const port = await freePort()
  const { root, supervisor, rojo, place } = setup()
  await supervisor.setRoot(root)
  await supervisor.setPlaces([place(port)], 'default.project.json')
  await supervisor.start('rojo')
  await waitFor(() => rojo().state === 'running')
  const pid = rojo().pid as number
  await Promise.all([supervisor.stopAll(), supervisor.setRoot(null)])
  assert.ok(!isAlive(pid))
})

test('without a record file nothing is written and an unrecorded rojo still blocks, injected tools', only, async () => {
  const port = await freePort()
  const stray = oldRojo()
  const pid = stray.pid as number
  const { root, supervisor, logs, rojo, place } = setup({
    record: false,
    tools: { portOwners: async (p) => (p === port && isAlive(pid) ? [{ pid, name: 'rojo' }] : []) }
  })
  try {
    await supervisor.setRoot(root)
    await supervisor.setPlaces([place(port)], 'default.project.json')
    await supervisor.start('rojo')
    await waitFor(() => rojo().gaveUp === true)
    assert.ok(isAlive(pid))
    assert.ok(text(logs).some((t) => t.includes(`served by another rojo (pid ${pid})`)))
  } finally {
    await supervisor.stopAll()
  }
})

test('a listener behind a launcher (rokit shim) is recorded too, and a later run stops it with the launcher', only, async () => {
  rmSync(runs, { force: true })
  const port = await freePort()
  const behind = oldRojo()
  const behindPid = behind.pid as number
  const first = setup({ tools: { portOwners: async (p) => (p === port && existsSync(runs) && isAlive(behindPid) ? [{ pid: behindPid, name: 'rojo' }] : []) } })
  try {
    await first.supervisor.setRoot(first.root)
    await first.supervisor.setPlaces([first.place(port)], 'default.project.json')
    await first.supervisor.start('rojo')
    await waitFor(() => first.rojo().state === 'running')
    const pid = first.rojo().pid as number
    await waitFor(() => first.records.read().some((e) => e.pid === behindPid))
    assert.equal(first.records.read().find((e) => e.pid === behindPid)?.via, pid)

    // Forge dies without stopping anything; the next run (another Supervisor on the same record) cleans up.
    const next = new Supervisor({ log: (line) => first.logs.push(line), onStatus: () => undefined, getSetting: <T>(_k: string, f: T) => f, serveRecordFile: first.file })
    await next.setRoot(first.root)
    assert.ok(!isAlive(pid) && !isAlive(behindPid))
    assert.equal(first.records.read().length, 0)
    // (In a real shim the listener is in the launcher's tree and goes with it; here it is a separate process.)
    assert.ok(text(first.logs).some((t) => t.startsWith(`stopped a leftover rojo (pid ${behindPid})`)))
  } finally {
    await first.supervisor.stopAll()
  }
})
