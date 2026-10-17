// Forge Sync routes on the Forge Bridge server (/forge-bridge/sync/*), over real HTTP on an ephemeral
// port with a fake SyncHandler, plus a few checks on the Studio plugin source.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import type { ChangesBody, SnapshotBody, SyncConfigQuery, SyncHandler } from '../src/shared/sync/protocol.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'

async function bridge(): Promise<StudioBridge> {
  const b = new StudioBridge({ port: 0, holdMs: 100 })
  await b.start()
  return b
}

function client(b: StudioBridge) {
  const base = `http://127.0.0.1:${b.port}/forge-bridge/sync`
  return {
    config: async (qs: string, headers: Record<string, string> = {}) => {
      const r = await fetch(`${base}/config?${qs}`, { headers })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    },
    post: async (route: string, body: unknown) => {
      const r = await fetch(`${base}/${route}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body), headers: { 'Content-Type': 'application/json' } })
      return { status: r.status, body: (await r.json()) as Record<string, unknown> }
    }
  }
}

class FakeSync implements SyncHandler {
  configs: SyncConfigQuery[] = []
  snapshots: SnapshotBody[] = []
  changeSets: ChangesBody[] = []
  fail: string | null = null
  async config(q: SyncConfigQuery) {
    this.configs.push(q)
    if (this.fail) throw new Error(this.fail)
    return { enabled: true, sessionToken: 'tok', roots: [['ReplicatedStorage', 'Shared']], skip: [['ReplicatedStorage', 'Packages']] }
  }
  async snapshot(body: SnapshotBody) {
    if (this.fail) throw new Error(this.fail)
    if (body.session !== 'tok') return { ok: false as const, error: 'unknown session', resend: true as const }
    this.snapshots.push(body)
    return { ok: true as const }
  }
  async changes(body: ChangesBody) {
    this.changeSets.push(body)
    return { ok: true as const }
  }
}

const place = { placeId: 42, gameId: 7, name: 'FSF' }
const node = { id: '1', path: ['ReplicatedStorage', 'Shared', 'Catalog'], className: 'ModuleScript', source: 'return {}\n' }

test('sync bridge: without a handler, config is off and posts are refused', async () => {
  const b = await bridge()
  const c = client(b)
  try {
    assert.deepEqual(await c.config('placeId=42'), { status: 200, body: { enabled: false } })
    const r = await c.post('snapshot', { session: 's', place, seq: 0, final: true, nodes: [] })
    assert.equal(r.status, 200)
    assert.equal(r.body.ok, false)
  } finally {
    await b.stop()
  }
})

test('sync bridge: routes reach the handler with parsed bodies', async () => {
  const b = await bridge()
  const c = client(b)
  const fake = new FakeSync()
  b.setSyncHandler(fake)
  try {
    const cfg = await c.config('placeId=42&gameId=7&place=FSF')
    assert.deepEqual(cfg, { status: 200, body: { enabled: true, sessionToken: 'tok', roots: [['ReplicatedStorage', 'Shared']], skip: [['ReplicatedStorage', 'Packages']] } })
    assert.deepEqual(fake.configs, [{ placeId: 42, gameId: 7, place: 'FSF' }])

    assert.deepEqual(await c.post('snapshot', { session: 'tok', place, seq: 0, final: false, nodes: [node] }), { status: 200, body: { ok: true } })
    const refs = [{ path: ['Workspace', 'Door', 'Weld'], property: 'Part1' }]
    assert.deepEqual(await c.post('snapshot', { session: 'tok', place, seq: 1, final: true, nodes: [], refs, refsTotal: 1 }), { status: 200, body: { ok: true } })
    assert.equal(fake.snapshots.length, 2)
    assert.deepEqual(fake.snapshots[1].refs, refs)
    assert.equal(fake.snapshots[1].refsTotal, 1)
    assert.deepEqual(fake.snapshots[0].nodes, [node])
    assert.equal(fake.snapshots[1].final, true)
    // The handler's resend answer reaches the plugin as is.
    assert.deepEqual(await c.post('snapshot', { session: 'old', place, seq: 0, final: true, nodes: [] }), { status: 200, body: { ok: false, error: 'unknown session', resend: true } })

    const changes = [
      { kind: 'source', node },
      { kind: 'renamed', id: '1', from: ['ReplicatedStorage', 'Shared', 'Old'], node },
      { kind: 'removed', id: '2', path: ['ReplicatedStorage', 'Shared', 'Gone'] }
    ]
    assert.deepEqual(await c.post('changes', { session: 'tok', place, changes }), { status: 200, body: { ok: true } })
    assert.deepEqual(fake.changeSets[0].changes, changes)

    // A big script travels alone in a chunk larger than the job routes allow (256 KB).
    const big = { ...node, source: '-- x\n'.repeat(200_000) }
    assert.deepEqual(await c.post('snapshot', { session: 'tok', place, seq: 2, final: true, nodes: [big] }), { status: 200, body: { ok: true } })
    assert.equal(fake.snapshots.at(-1)?.nodes[0].source?.length, big.source.length)
  } finally {
    await b.stop()
  }
})

test('sync bridge: validation, errors and browser requests', async () => {
  const b = await bridge()
  const c = client(b)
  const fake = new FakeSync()
  b.setSyncHandler(fake)
  try {
    assert.equal((await c.config('placeId=42', { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/forge-bridge/sync/snapshot`, { method: 'POST', body: '{}', headers: { Origin: 'https://evil.example' } })).status, 403)
    const noPlace = await c.config('place=x')
    assert.equal(noPlace.status, 400)
    assert.equal(noPlace.body.enabled, false)
    assert.equal((await c.post('snapshot', 'not json')).status, 400)
    const bad = await c.post('snapshot', { session: 'tok', place, seq: 0, final: true, nodes: [{ ...node, path: ['..', ''] }] })
    assert.equal(bad.status, 400)
    assert.match(String(bad.body.error), /nodes\[0\]\.path\[1\]/)
    assert.equal((await c.post('changes', { session: 'tok', place, changes: [{ kind: 'nope' }] })).status, 400)
    assert.equal((await c.post('other', {})).status, 404)
    assert.equal((await fetch(`http://127.0.0.1:${b.port}/forge-bridge/sync/snapshot`)).status, 404)
    assert.equal(fake.snapshots.length, 0)

    // Handler failures become { ok:false } / { enabled:false } with the message.
    fake.fail = 'engine exploded'
    assert.deepEqual(await c.config('placeId=1'), { status: 200, body: { enabled: false, error: 'engine exploded' } })
    assert.deepEqual(await c.post('snapshot', { session: 'tok', place, seq: 0, final: true, nodes: [] }), { status: 200, body: { ok: false, error: 'engine exploded' } })

    // Disabled config strips everything else.
    b.setSyncHandler({ ...fake, config: async () => ({ enabled: false, sessionToken: 'x', roots: [['A']] }), snapshot: fake.snapshot.bind(fake), changes: fake.changes.bind(fake) })
    assert.deepEqual((await c.config('placeId=1')).body, { enabled: false })
    b.setSyncHandler(null)
    assert.deepEqual((await c.config('placeId=1')).body, { enabled: false })
  } finally {
    await b.stop()
  }
})

test('sync bridge: oversized sync bodies are refused', async () => {
  const b = await bridge()
  b.setSyncHandler(new FakeSync())
  try {
    const body = JSON.stringify({ session: 'tok', place, seq: 0, final: true, nodes: [{ ...node, source: 'x'.repeat(7 * 1024 * 1024) }] })
    const status = await fetch(`http://127.0.0.1:${b.port}/forge-bridge/sync/snapshot`, { method: 'POST', body })
      .then((r) => r.status)
      .catch(() => 'reset')
    // Either an explicit 413 or the connection is cut while the client is still sending.
    assert.ok(status === 413 || status === 'reset', String(status))
  } finally {
    await b.stop()
  }
})

test('sync plugin: the Studio plugin speaks the sync protocol', async () => {
  const src = await readFile(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  assert.ok(PLUGIN_VERSION >= 2, 'the plugin version was bumped for Forge Sync')
  for (const needle of ['/sync/config?placeId=', '"snapshot"', '"changes"', 'answer.resend', 'DescendantAdded', 'DescendantRemoving', 'AttributeChanged', 'oversize']) {
    assert.ok(src.includes(needle), needle)
  }
  // Unsynced Instance references are reported (not synced): version 3.
  assert.ok(PLUGIN_VERSION >= 3, 'the plugin version was bumped for the refs report')
  for (const needle of ['"ObjectValue", { "Value" }', '"JointInstance", { "Part0", "Part1" }', '"WeldConstraint"', '"Beam", { "Attachment0", "Attachment1" }', '"Trail"', '"Constraint"', '"Model", { "PrimaryPart" }', 'body.refs, body.refsTotal = refList()']) {
    assert.ok(src.includes(needle), needle)
  }
  // Edit mode only: the whole plugin returns before anything else when the game is running.
  assert.ok(src.indexOf('RunService:IsRunning()') < src.indexOf('local function syncLoop'))
  // Chunks stay under the job routes' 256 KB too.
  const chunk = /SYNC_CHUNK_BYTES = (\d+) \* 1024/.exec(src)
  assert.ok(chunk && Number(chunk[1]) * 1024 < 256 * 1024)
})

test('sync bridge: plugin v12 polls carry the sync session; a pollHint resync is answered at once', async () => {
  const b = await bridge()
  const seen: unknown[] = []
  const handler = new FakeSync() as FakeSync & SyncHandler
  handler.pollHint = (info) => {
    seen.push(info)
    return info.session ? null : { resync: true }
  }
  b.setSyncHandler(handler)
  const base = `http://127.0.0.1:${b.port}/forge-bridge/poll`
  const session = '6b1f2c3d-0000-4000-8000-000000000001'
  try {
    const idle = await (await fetch(`${base}?placeId=42&place=FSF&v=12&sync=&probe=probe-0001`)).json()
    assert.deepEqual(idle, { idle: true, resync: true })
    const live = await (await fetch(`${base}?placeId=42&place=FSF&v=12&sync=${session}&probe=probe-0001`)).json()
    assert.deepEqual(live, { idle: true }, 'a live session waits for jobs as before')
    assert.deepEqual(seen[0], { placeId: 42, session: '', place: 'FSF', probe: 'probe-0001', pluginVersion: 12 })
    assert.equal((seen[1] as { session: string }).session, session)
    const w = b.studios().find((s) => s.placeId === 42)
    assert.equal(w?.probe, 'probe-0001')
    assert.equal(w?.syncSession, session)
    // An older plugin (no sync parameter) is never asked.
    seen.length = 0
    await (await fetch(`${base}?placeId=42&place=FSF&v=11`)).json()
    assert.equal(seen.length, 0)
    // A throwing hint never breaks the poll.
    handler.pollHint = () => {
      throw new Error('boom')
    }
    assert.deepEqual(await (await fetch(`${base}?placeId=42&place=FSF&v=12&sync=`)).json(), { idle: true })
  } finally {
    await b.stop()
  }
})

test('sync plugin v12: polls with its sync session and restarts its check on resync', async () => {
  const src = await readFile(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  assert.ok(PLUGIN_VERSION >= 12)
  assert.ok(src.includes(`-- forge-bridge-template: ${PLUGIN_VERSION}`))
  for (const needle of ['&sync=', 'answer.resync == true']) assert.ok(src.includes(needle), needle)
})
