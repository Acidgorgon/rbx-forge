import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import * as fsp from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { after, test } from 'node:test'
import type { ServiceStatus } from '../src/shared/types.ts'
import { gateAction, isRojoPanic, pausingFs, RestartPolicy, ROJO_BACKOFF_MS, RojoPause, secondsText } from '../src/main/services/rojoRestart.ts'
import { gateHolds, Supervisor } from '../src/main/services/supervisor.ts'
import { serveNotice, serveView } from '../src/shared/rojoView.ts'
import { makeProject, write } from './fixture.ts'

const temps: string[] = []
after(() => {
  for (const dir of temps) rmSync(dir, { recursive: true, force: true })
})

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out')
    await sleep(20)
  }
}

// ---- RestartPolicy ----

test('backoff grows 0.5s, 1s, 2s, 5s and stays capped', () => {
  const policy = new RestartPolicy({ maxQuickFailures: 10 })
  let now = 1000
  const delays: number[] = []
  for (let i = 0; i < 6; i++) {
    policy.started(now)
    now += 100
    const d = policy.failed(now)
    assert.equal(d.action, 'restart')
    if (d.action === 'restart') delays.push(d.delayMs)
  }
  assert.deepEqual(delays, [500, 1000, 2000, 5000, 5000, 5000])
  assert.deepEqual(ROJO_BACKOFF_MS, [500, 1000, 2000, 5000])
})

test('gives up after N quick failures, and a manual reset starts over', () => {
  const policy = new RestartPolicy({ maxQuickFailures: 3 })
  let now = 0
  const actions: string[] = []
  for (let i = 0; i < 4; i++) {
    policy.started(++now)
    actions.push(policy.failed(++now).action)
  }
  assert.deepEqual(actions, ['restart', 'restart', 'restart', 'give-up'])
  const last = policy.failed(++now)
  assert.equal(last.action, 'give-up')
  policy.reset()
  policy.started(++now)
  const again = policy.failed(++now)
  assert.deepEqual(again, { action: 'restart', delayMs: 500, attempt: 1 })
})

test('a stable run resets the backoff (by elapsed time or the stable timer)', () => {
  const policy = new RestartPolicy({ stableMs: 30_000, maxQuickFailures: 3 })
  policy.started(0)
  policy.failed(10)
  policy.started(600)
  assert.deepEqual(policy.failed(700), { action: 'restart', delayMs: 1000, attempt: 2 })
  // Ran 30s before crashing: counts as a fresh first failure.
  policy.started(2000)
  assert.deepEqual(policy.failed(32_000), { action: 'restart', delayMs: 500, attempt: 1 })
  policy.started(33_000)
  policy.failed(33_100)
  policy.stable()
  assert.equal(policy.failures, 0)
})

test('recognises rojo panics, not ordinary output', () => {
  assert.ok(isRojoPanic("thread '<unnamed>' panicked at 'called `Result::unwrap()` on an `Err` value: Custom { kind: NotFound }', src\\change_processor.rs:179:58"))
  assert.ok(isRojoPanic('[ERROR rojo] Details: called `Result::unwrap()` on an `Err` value: Custom { kind: NotFound, error: Error { kind: Canonicalize } }'))
  assert.ok(isRojoPanic('[ERROR rojo] Rojo crashed!'))
  assert.ok(isRojoPanic('panicked at src/change_processor.rs:179:58:'))
  assert.ok(!isRojoPanic('Rojo server listening: Port: 34872'))
  assert.ok(!isRojoPanic('Visit http://localhost:34872/ in your browser for more information.'))
  assert.equal(secondsText(500), '0.5s')
  assert.equal(secondsText(5000), '5s')
})

// ---- Gate decision ----

test('gate action: stop a running held serve, start a released one', () => {
  assert.equal(gateAction({ holds: true, running: true, held: false }), 'stop')
  assert.equal(gateAction({ holds: true, running: false, held: true }), 'wait')
  assert.equal(gateAction({ holds: false, running: false, held: true }), 'start')
  assert.equal(gateAction({ holds: false, running: true, held: false }), 'none')
  assert.equal(gateAction({ holds: false, running: false, held: false }), 'none')
  assert.equal(gateHolds('blocked'), true)
  assert.equal(gateHolds('clear'), false)
})

// ---- UI view of rojo ----

const status = (patch: Partial<ServiceStatus>): ServiceStatus => ({ id: 'rojo', label: 'Rojo', state: 'running', restarts: 0, ...patch })

test('serve button: a held serve shows Held with resolve / serve anyway, not Starting', () => {
  const held = status({ state: 'starting', detail: '1 conflict: resolve or serve anyway (default.project.json)', hold: { gate: 'blocked', file: 'default.project.json' } })
  const view = serveView(held, 34872)
  assert.equal(view.kind, 'held')
  assert.equal(view.label, 'Held')
  assert.match(view.title, /default\.project\.json: 1 conflict: resolve or serve anyway\. Click to resolve or serve anyway/)
  assert.equal(serveView(status({ state: 'starting', hold: { gate: 'checking', file: 'default.project.json' } }), 1).kind, 'checking')
  assert.equal(serveView(status({ state: 'running' }), 34872).label, 'Serving')
  assert.equal(serveView(status({ state: 'crashed', restarts: 1 }), 1).kind, 'crashed')
  assert.equal(serveView(status({ state: 'crashed', gaveUp: true }), 1).kind, 'failed')
  assert.equal(serveView(status({ state: 'stopped' }), 1).kind, 'stopped')
  assert.equal(serveView(undefined, 1).kind, 'stopped')
})

test('serve notices: restarted once per crash, gave up, held', () => {
  let announced = 0
  const step = (prev: ServiceStatus | undefined, next: ServiceStatus) => {
    const r = serveNotice(prev, next, announced)
    announced = r.announced
    return r.notice?.kind ?? null
  }
  const running = status({})
  const crashed = status({ state: 'crashed', restarts: 1 })
  const starting = status({ state: 'starting', restarts: 1 })
  const back = status({ state: 'running', restarts: 1 })
  assert.equal(step(undefined, running), null)
  assert.equal(step(running, crashed), null)
  assert.equal(step(crashed, starting), null)
  assert.equal(step(starting, back), 'restarted')
  // Held then served again with the same restart count: no second "restarted".
  const held = status({ state: 'starting', restarts: 1, hold: { gate: 'blocked', file: 'default.project.json' }, detail: '2 conflicts: resolve or serve anyway (default.project.json)' })
  assert.equal(step(back, held), 'held')
  assert.equal(step(held, held), null)
  assert.equal(step(held, back), null)
  // User restart resets the count; a later crash is announced again.
  assert.equal(step(back, status({})), null)
  assert.equal(step(status({}), status({ state: 'running', restarts: 1 })), 'restarted')
  assert.equal(step(status({ state: 'crashed', restarts: 5 }), status({ state: 'crashed', restarts: 5, gaveUp: true })), 'gave-up')
})

// ---- RojoPause ----

test('RojoPause stops rojo once for overlapping folder ops and resumes after they settle', async () => {
  const calls: string[] = []
  const pause = new RojoPause({
    pause: async (reason) => {
      calls.push(`pause:${reason}`)
      await sleep(10)
      return true
    },
    resume: async () => {
      calls.push('resume')
    },
    settleMs: 30
  })
  const a = pause.run(async () => {
    calls.push('a')
    await sleep(20)
  }, 'folder delete')
  const b = pause.run(async () => {
    calls.push('b')
  }, 'folder delete')
  await Promise.all([a, b])
  assert.deepEqual(calls, ['pause:folder delete', 'a', 'b'], 'both ops run after the one pause')
  assert.equal(calls.filter((c) => c.startsWith('pause')).length, 1)
  assert.ok(!calls.includes('resume'), 'not resumed before the settle time')
  // Another op inside the settle window keeps rojo stopped (no second pause).
  await pause.run(async () => {
    calls.push('c')
  })
  await waitFor(() => calls.includes('resume'))
  assert.equal(calls.filter((c) => c.startsWith('pause')).length, 1)
  assert.equal(calls.filter((c) => c === 'resume').length, 1)
  assert.equal(calls.at(-1), 'resume')
})

test('RojoPause leaves a stopped rojo alone, skips non-folders, and resumes even when the op throws', async () => {
  const calls: string[] = []
  let running = false
  const pause = new RojoPause({ pause: async () => (calls.push('pause'), running), resume: async () => void calls.push('resume'), settleMs: 5 })
  await pause.run(async () => void calls.push('op'))
  await sleep(30)
  assert.deepEqual(calls, ['pause', 'op'])

  const dir = mkdtempSync(join(tmpdir(), 'rojo-pause-'))
  temps.push(dir)
  writeFileSync(join(dir, 'file.luau'), 'return 1')
  mkdirSync(join(dir, 'Folder'))
  calls.length = 0
  running = true
  await pause.aroundPath(join(dir, 'file.luau'), async () => void calls.push('file'))
  assert.deepEqual(calls, ['file'], 'a file op does not stop rojo')
  await assert.rejects(pause.aroundPath(join(dir, 'Folder'), async () => {
    calls.push('folder')
    throw new Error('boom')
  }), /boom/)
  await waitFor(() => calls.includes('resume'))
  assert.deepEqual(calls, ['file', 'pause', 'folder', 'resume'])
})

test('pausingFs pauses for directory renames and removals only', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rojo-fs-'))
  temps.push(dir)
  const reasons: string[] = []
  const pause = new RojoPause({ pause: async (reason) => (reasons.push(reason), false), resume: async () => undefined, settleMs: 1 })
  const fs = pausingFs(fsp, pause)
  writeFileSync(join(dir, 'a.luau'), 'x')
  await fs.rename(join(dir, 'a.luau'), join(dir, 'b.luau'))
  assert.deepEqual(reasons, [])
  mkdirSync(join(dir, 'Old'))
  await fs.rename(join(dir, 'Old'), join(dir, 'New'))
  await sleep(20) // past the settle time: the next op pauses again
  await fs.rmdir(join(dir, 'New'))
  assert.deepEqual(reasons, ['folder rename', 'folder delete'])
  assert.ok(existsSync(join(dir, 'b.luau')))
  assert.ok(!existsSync(join(dir, 'New')))
})

// ---- Supervisor: a rojo that panics is restarted ----

const shOnly = { skip: process.platform === 'win32' ? 'fake rojo is a sh script' : false }

test('supervisor kills a panicked rojo and restarts it, reporting the restart', shOnly, async () => {
  const home = mkdtempSync(join(tmpdir(), 'panic-home-'))
  const bin = mkdtempSync(join(tmpdir(), 'panic-bin-'))
  temps.push(home, bin)
  const runs = join(bin, 'runs.log')
  // First run: prints rojo's panic and stays up (a panicked change-processor thread does not end
  // the process). Later runs: serve normally.
  write(
    bin,
    'rojo',
    `#!/bin/sh\necho run >> "${runs}"\necho "Rojo server listening: Port: 34872"\nif [ "$(wc -l < "${runs}")" -le 1 ]; then\n  echo "[ERROR rojo] Rojo crashed!" >&2\n  echo "[ERROR rojo] Details: called \\\`Result::unwrap()\\\` on an \\\`Err\\\` value: Custom { kind: NotFound }" >&2\nfi\nexec sleep 60\n`
  )
  chmodSync(join(bin, 'rojo'), 0o755)
  const env = { HOME: process.env.HOME, PATH: process.env.PATH }
  process.env.HOME = home
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  const root = makeProject()
  temps.push(root)
  let statuses: ServiceStatus[] = []
  const seen: ServiceStatus[] = []
  const supervisor = new Supervisor({
    log: () => undefined,
    onStatus: (s) => {
      statuses = s
      seen.push(s.find((x) => x.id === 'rojo')!)
    },
    getSetting: <T>(_key: string, fallback: T) => fallback
  })
  try {
    await supervisor.setRoot(root)
    await supervisor.start('rojo')
    const rojo = () => statuses.find((s) => s.id === 'rojo')!
    await waitFor(() => existsSync(runs) && readFileSync(runs, 'utf8').split('\n').filter(Boolean).length >= 2 && rojo().state === 'running', 8000)
    assert.equal(rojo().restarts, 1)
    assert.ok(seen.some((s) => s.state === 'crashed' && /crashed \(panic\).*Restarting in 0\.5s/.test(s.detail ?? '')), JSON.stringify(seen.map((s) => s.detail)))
    assert.equal(serveView(rojo(), 34872).kind, 'running')
  } finally {
    await supervisor.stopAll()
    process.env.HOME = env.HOME
    process.env.PATH = env.PATH
  }
})

test('supervisor gives up on a rojo that keeps crashing, and Restart starts it again', shOnly, async () => {
  const home = mkdtempSync(join(tmpdir(), 'giveup-home-'))
  const bin = mkdtempSync(join(tmpdir(), 'giveup-bin-'))
  temps.push(home, bin)
  const runs = join(bin, 'runs.log')
  write(bin, 'rojo', `#!/bin/sh\necho run >> "${runs}"\necho "error: something broke" >&2\nexit 1\n`)
  chmodSync(join(bin, 'rojo'), 0o755)
  const env = { HOME: process.env.HOME, PATH: process.env.PATH }
  process.env.HOME = home
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  const root = makeProject()
  temps.push(root)
  let statuses: ServiceStatus[] = []
  const supervisor = new Supervisor({
    log: () => undefined,
    onStatus: (s) => (statuses = s),
    getSetting: <T>(_key: string, fallback: T) => fallback,
    rojoRestart: { backoffMs: [10, 20], maxQuickFailures: 2 }
  })
  const count = () => (existsSync(runs) ? readFileSync(runs, 'utf8').split('\n').filter(Boolean).length : 0)
  const rojo = () => statuses.find((s) => s.id === 'rojo')!
  try {
    await supervisor.setRoot(root)
    await supervisor.start('rojo')
    await waitFor(() => !!rojo().gaveUp)
    await sleep(100)
    assert.equal(count(), 3, 'first run + 2 restarts, then no more')
    assert.equal(rojo().state, 'crashed')
    assert.match(rojo().detail ?? '', /keeps crashing.*Restart to try again/)
    assert.equal(serveView(rojo(), 1).kind, 'failed')
    // The Restart button: start() runs it again with a fresh budget.
    await supervisor.start('rojo')
    assert.equal(rojo().gaveUp, undefined)
    await waitFor(() => !!rojo().gaveUp)
    assert.equal(count(), 6)
  } finally {
    await supervisor.stopAll()
    process.env.HOME = env.HOME
    process.env.PATH = env.PATH
  }
})

test('supervisor marks a serve held on conflicts and clears it on serve anyway', shOnly, async () => {
  const home = mkdtempSync(join(tmpdir(), 'hold-home-'))
  const bin = mkdtempSync(join(tmpdir(), 'hold-bin-'))
  temps.push(home, bin)
  write(bin, 'rojo', '#!/bin/sh\necho "Rojo server listening: Port: 34872"\nexec sleep 60\n')
  chmodSync(join(bin, 'rojo'), 0o755)
  const env = { HOME: process.env.HOME, PATH: process.env.PATH }
  process.env.HOME = home
  process.env.PATH = `${bin}${delimiter}${process.env.PATH}`
  const root = makeProject()
  temps.push(root)
  let statuses: ServiceStatus[] = []
  const supervisor = new Supervisor({ log: () => undefined, onStatus: (s) => (statuses = s), getSetting: <T>(_key: string, fallback: T) => fallback })
  const rojo = () => statuses.find((s) => s.id === 'rojo')!
  try {
    await supervisor.setRoot(root)
    await supervisor.start('rojo')
    await waitFor(() => rojo().state === 'running')
    supervisor.setGate('default.project.json', 'blocked', '1 conflict: resolve or serve anyway')
    assert.deepEqual(rojo().hold, { gate: 'blocked', file: 'default.project.json' })
    assert.equal(serveView(rojo(), 34872).kind, 'held')
    // "Serve anyway" in Forge Sync turns the gate clear for this place.
    supervisor.setGate('default.project.json', 'clear')
    assert.equal(rojo().hold, undefined)
    await waitFor(() => rojo().state === 'running')
    // The held process's late exit is not mistaken for a crash.
    await sleep(200)
    assert.equal(rojo().state, 'running')
    assert.equal(rojo().restarts, 0)
  } finally {
    await supervisor.stopAll()
    process.env.HOME = env.HOME
    process.env.PATH = env.PATH
  }
})
