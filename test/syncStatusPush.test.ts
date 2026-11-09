import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { SyncService } from '../src/main/services/sync/service.ts'
import { createSync } from '../src/main/services/sync/wire.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// A project whose Forge-written list has one file, and a git that counts its status runs.
function project() {
  const root = mkdtempSync(join(tmpdir(), 'forge-sync-push-'))
  dirs.push(root)
  mkdirSync(join(root, '.forge', 'sync'), { recursive: true })
  writeFileSync(join(root, '.forge', 'sync', 'forge-written.json'), JSON.stringify({ files: ['src/a.luau'] }))
  const counter = { status: 0 }
  const git = async (args: string[]) => {
    if (args.includes('status')) counter.status++
    return { code: 0, stdout: ' M src/a.luau\0', stderr: '' }
  }
  return { root, git, counter }
}

test('sync status: refresh bursts become one push per delay; gates stay immediate', async () => {
  const { root, git, counter } = project()
  const events: string[] = []
  const service = new SyncService({ root, engine: null, mapping: null, settings: { get: (_k, fb) => fb }, git, pluginsDir: () => null, emit: (e) => events.push(e), statusDelayMs: 40 })
  try {
    for (let i = 0; i < 20; i++) service.refresh()
    await sleep(10)
    assert.equal(events.length, 0)
    await sleep(80)
    assert.deepEqual(events, ['sync:status'])
    assert.equal(counter.status, 1)
    // Within the cache window and with the written set unchanged, a background push reuses git's answer.
    service.refresh()
    await sleep(80)
    assert.equal(events.length, 2)
    assert.equal(counter.status, 1)
  } finally {
    service.close()
  }
})

test('sync status: status() answers fresh, background pushes use the cache', async () => {
  const { root, git, counter } = project()
  const service = new SyncService({ root, engine: null, mapping: null, settings: { get: (_k, fb) => fb }, git, pluginsDir: () => null, emit: () => undefined })
  try {
    assert.deepEqual((await service.status()).pendingStudioEdits, ['src/a.luau'])
    assert.equal(counter.status, 1)
    assert.deepEqual((await service.status({ cached: true })).pendingStudioEdits, ['src/a.luau'])
    assert.equal(counter.status, 1)
    await service.status()
    assert.equal(counter.status, 2)
    // Concurrent background pushes share one run.
    const before = counter.status
    await Promise.all([service.status({ cached: true }), service.status({ cached: true })])
    assert.ok(counter.status - before <= 1)
  } finally {
    service.close()
  }
})

test('sync status: no push after close', async () => {
  const { root, git } = project()
  const events: string[] = []
  const service = new SyncService({ root, engine: null, mapping: null, settings: { get: (_k, fb) => fb }, git, pluginsDir: () => null, emit: (e) => events.push(e), statusDelayMs: 20 })
  service.refresh()
  service.close()
  await sleep(60)
  assert.deepEqual(events, [])
})

test('createSync: an unchanged sync:status / studio:conflicts is not sent again', async () => {
  const { root, git } = project()
  const values: Record<string, unknown> = { 'sync.engine': 'forge' }
  const emitted: string[] = []
  const wiring = createSync({
    settings: { get: <T>(k: string, fb: T) => (k in values ? (values[k] as T) : fb), set: (k, v) => (values[k] = v) },
    emit: (e) => emitted.push(e),
    supervisor: { setGate: () => undefined, applyGates: () => undefined, setSyncSummary: () => undefined },
    pluginsDir: () => null,
    git: (_root, args) => git(args)
  })
  await wiring.onProjectOpen(root)
  try {
    for (let i = 0; i < 3; i++) {
      wiring.service()!.refresh()
      await sleep(30)
    }
    assert.equal(emitted.filter((e) => e === 'sync:status').length, 1, emitted.join(','))
    assert.ok(emitted.filter((e) => e === 'studio:conflicts').length <= 1, emitted.join(','))
  } finally {
    wiring.onProjectClose()
  }
})
