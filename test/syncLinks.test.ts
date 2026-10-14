// Forge Sync place linking: only Studio places linked to the open project sync (PlaceId in
// servePlaceIds / tools/studio-sync.json placeIds, or linked in Source Control). Unlinked places (an
// unpublished VFX place, a local Place_<id>.rbxlx copy of another game) never write, trash, conflict
// or hold rojo; a newly linked place's first sync waits for "which side"; sync state from before the
// fix is dropped once; one project's state never shows up in another. Real SyncEngine + mapping.

import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { isLinkedKey, matchPlace, type PlaceLink } from '../src/main/services/sync/links.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { SESSION_EXPIRE_MS, SyncService } from '../src/main/services/sync/service.ts'
import { createSync } from '../src/main/services/sync/wire.ts'
import type { GateState, StudioNode } from '../src/shared/sync/types.ts'
import { linkPlaces } from './syncFixture.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

// A TestGame-like project: default.project.json, optionally with servePlaceIds.
function project(servePlaceIds?: number[]): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-links-'))
  dirs.push(root)
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  put(
    'default.project.json',
    JSON.stringify({
      name: 'TestGame',
      ...(servePlaceIds ? { servePlaceIds } : {}),
      tree: { $className: 'DataModel', ServerScriptService: { Server: { $path: 'src/server' } }, ReplicatedStorage: { Shared: { $path: 'src/shared' } } }
    })
  )
  put('src/server/Main.server.luau', 'print("disk")\n')
  put('src/shared/Util.luau', 'return 1\n')
  put('.gitignore', '.forge/sync/\n')
  return root
}

function diskState(root: string): Record<string, string> {
  const out: Record<string, string> = {}
  const walk = (rel: string) => {
    for (const e of readdirSync(join(root, rel), { withFileTypes: true })) {
      const child = rel ? `${rel}/${e.name}` : e.name
      if (child === '.forge') continue
      if (e.isDirectory()) walk(child)
      else out[child] = readFileSync(join(root, child), 'utf8')
    }
  }
  walk('')
  return out
}

let ids = 0
const node = (path: string[], className: string, source?: string): StudioNode => ({ id: String(++ids), path, className, ...(source !== undefined ? { source } : {}) })

// What another place's Studio has: 3 scripts the project does not, and a different Main.
const FOREIGN = [
  node(['ServerScriptService', 'Server'], 'Folder'),
  node(['ServerScriptService', 'Server', 'Main'], 'Script', 'print("other game")'),
  node(['ServerScriptService', 'Server', 'Combat'], 'Script', 'print("combat")'),
  node(['ReplicatedStorage', 'Shared'], 'Folder'),
  node(['ReplicatedStorage', 'Shared', 'Util'], 'ModuleScript', 'return 1\n'),
  node(['ReplicatedStorage', 'Shared', 'Slash'], 'ModuleScript', 'return "vfx"')
]

function make(root: string, opts: { now?: () => number; studios?: () => { placeId?: number; place?: string }[] } = {}) {
  const gates: [string, GateState][] = []
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(_k: string, fb: T) => fb },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined,
    onGate: (file, gate) => gates.push([file, gate]),
    ...(opts.now ? { now: opts.now } : {}),
    ...(opts.studios ? { studios: opts.studios } : {})
  })
  return { service, gates }
}

const settle = () => new Promise((r) => setTimeout(r, 20))

// ---- matching

test('matchPlace: published in config, published not in config, linked, unpublished, same name', () => {
  const maps = [
    { projectFile: 'default.project.json', placeIds: [111] },
    { projectFile: 'menu.project.json', placeIds: [222] }
  ]
  const links: Record<string, PlaceLink> = {
    'place:333': { projectFile: 'menu.project.json', at: 1 },
    'local:link-aaaa-0001': { projectFile: 'default.project.json', name: 'Place1', at: 1 },
    'local:link-gone-0001': { projectFile: 'deleted.project.json', at: 1 }
  }
  assert.deepEqual(matchPlace(maps, links, { placeId: 222 }), { projectFile: 'menu.project.json', placeKey: '222', via: 'config' })
  assert.equal(matchPlace(maps, links, { placeId: 72187156382444 }), null, 'a published place nobody listed or linked')
  assert.deepEqual(matchPlace(maps, links, { placeId: 333 }), { projectFile: 'menu.project.json', placeKey: '333', via: 'link' })
  assert.equal(matchPlace(maps, links, { placeId: 0 }), null, 'an unpublished place without a link id never matches (no "default place")')
  assert.deepEqual(matchPlace(maps, links, { placeId: 0, linkId: 'link-aaaa-0001' }), { projectFile: 'default.project.json', placeKey: 'local:link-aaaa-0001', via: 'link' })
  // Two open places named "Place1": only the one carrying the link id is linked; the name is never used.
  assert.equal(matchPlace(maps, links, { placeId: 0, linkId: 'link-bbbb-0002' }), null)
  assert.equal(matchPlace(maps, links, { placeId: 0, linkId: 'link-gone-0001' }), null, 'a link to a place file that no longer exists')
  // No servePlaceIds anywhere (a new project): nothing published matches either.
  assert.equal(matchPlace([{ projectFile: 'default.project.json', placeIds: [] }], {}, { placeId: 999 }), null)
  // Base-store keys from before linking existed are not linked.
  assert.equal(isLinkedKey(maps, links, 'unpublished:Place_72187156382444.rbxlx'), false)
  assert.equal(isLinkedKey(maps, links, '111'), true)
  assert.equal(isLinkedKey(maps, links, '999'), false)
  assert.equal(isLinkedKey(maps, links, 'local:link-aaaa-0001'), true)
})

// ---- the user's report: several Studio places open against a project with no servePlaceIds

test('unlinked places (unpublished, local Place_<id>.rbxlx, unlisted published): no session, no disk writes, no conflicts, no rojo hold', async () => {
  const root = project() // like TestGame: no servePlaceIds
  const before = diskState(root)
  const { service, gates } = make(root)
  await service.start()
  try {
    const answers = [
      await service.handler.config({ placeId: 0, place: 'Place2', probe: 'probe-place2-0001' }),
      await service.handler.config({ placeId: 0, place: 'DoubleFireSlashVFX', probe: 'probe-vfx-00000001' }),
      await service.handler.config({ placeId: 0, place: 'Place_72187156382444.rbxlx' }), // an older plugin: no probe
      await service.handler.config({ placeId: 72187156382444, place: 'FSF' })
    ]
    for (const a of answers) {
      assert.equal(a.enabled, false)
      assert.equal(a.sessionToken, '')
      assert.match(a.reason ?? '', /not linked to this project/)
    }
    // Whatever the plugin posts without a session is refused (older plugins included).
    const snap = await service.handler.snapshot({ session: 'guess', place: { placeId: 0, name: 'Place_72187156382444.rbxlx' }, seq: 0, final: true, nodes: FOREIGN })
    assert.equal(snap.ok, false)
    const ch = await service.handler.changes({ session: 'guess', place: { placeId: 0 }, changes: [{ kind: 'added', node: FOREIGN[2] }] })
    assert.equal(ch.ok, false)
    await settle()
    const status = await service.status()
    assert.deepEqual(status.places.map((p) => [p.projectFile, p.gate, p.connected, p.conflicts]), [['default.project.json', 'idle', false, 0]])
    assert.deepEqual(status.unlinked?.map((u) => [u.name, u.canLink]).sort(), [
      ['DoubleFireSlashVFX', true],
      ['FSF', true],
      ['Place2', true],
      ['Place_72187156382444.rbxlx', false]
    ])
    assert.match(status.unlinked!.find((u) => u.name === 'Place_72187156382444.rbxlx')!.why, /Restart Studio/)
    assert.deepEqual(service.conflicts(), [])
    assert.equal(service.gateFor('default.project.json').gate, 'idle')
    assert.ok(gates.every(([, g]) => g === 'idle'), JSON.stringify(gates))
    assert.deepEqual(diskState(root), before)
    assert.deepEqual(status.pendingStudioEdits, [])
  } finally {
    service.close()
  }
})

test('two unlinked places with the same name: linking one leaves the other unlinked', async () => {
  const root = project()
  const { service } = make(root)
  await service.start()
  try {
    await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-aaaa-0001' })
    await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-bbbb-0002' })
    const listed = (await service.status()).unlinked!
    assert.equal(listed.length, 2)
    await service.linkPlace(listed.find((u) => u.id === 'probe:probe-aaaa-0001')!.id)
    // The linked one is told to store its link id; the other, same name, is not.
    const a = await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-aaaa-0001' })
    const b = await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-bbbb-0002' })
    assert.equal(a.enabled, false)
    assert.ok(a.stampLink)
    assert.equal(b.stampLink, undefined)
    assert.equal(b.enabled, false)
    // With the stored link id the first place syncs; the second one (same name, no link) still does not.
    assert.equal((await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-aaaa-0001', link: a.stampLink })).enabled, true)
    assert.equal((await service.handler.config({ placeId: 0, place: 'Place1', probe: 'probe-bbbb-0002' })).enabled, false)
    const links = JSON.parse(readFileSync(join(root, '.forge', 'sync', 'links.json'), 'utf8'))
    assert.deepEqual(Object.keys(links.links), [`local:${a.stampLink}`])
    // A published place is linked by PlaceId.
    await service.handler.config({ placeId: 555, place: 'Lobby', probe: 'probe-cccc-0003' })
    await service.linkPlace('place:555')
    assert.equal((await service.handler.config({ placeId: 555, place: 'Lobby', probe: 'probe-cccc-0003' })).enabled, true)
  } finally {
    service.close()
  }
})

test('first sync of a linked place writes and trashes nothing (created files included) until a side is picked', async () => {
  const root = project([111])
  const before = diskState(root)
  const { service } = make(root)
  await service.start()
  try {
    const cfg = await service.handler.config({ placeId: 111, place: 'TestGame' })
    assert.equal(cfg.enabled, true)
    const place = { placeId: 111 }
    assert.equal((await service.handler.snapshot({ session: cfg.sessionToken, place, seq: 0, final: true, nodes: FOREIGN })).ok, true)
    await settle()
    let status = await service.status()
    const p = status.places.find((x) => x.placeKey === '111')!
    assert.equal(p.gate, 'blocked')
    assert.equal(p.counts.created ?? 0, 0)
    assert.equal(p.counts.trashed ?? 0, 0)
    const held = service.conflicts().map((c) => [c.file, c.reason]).sort()
    assert.deepEqual(held, [
      ['src/server/Combat.server.luau', 'first-run'],
      ['src/server/Main.server.luau', 'first-run'],
      ['src/shared/Slash.luau', 'first-run']
    ])
    assert.deepEqual(diskState(root), before)
    // A live change during the undecided first sync waits too.
    assert.equal((await service.handler.changes({ session: cfg.sessionToken, place, changes: [{ kind: 'added', node: node(['ServerScriptService', 'Server', 'Late'], 'Script', 'print(1)') }] })).ok, true)
    assert.deepEqual(diskState(root), before)
    assert.ok(service.conflicts().some((c) => c.file === 'src/server/Late.server.luau' && c.reason === 'first-run'))
    // Per file first: keep the disk Main; then Studio wins for the rest.
    await service.resolve('111', 'src/server/Main.server.luau', 'disk')
    assert.deepEqual(diskState(root), before)
    await service.resolveAll('111', 'studio', 'first-run')
    const after = diskState(root)
    assert.equal(after['src/server/Main.server.luau'], 'print("disk")\n')
    assert.equal(after['src/server/Combat.server.luau'], 'print("combat")\n')
    assert.equal(after['src/shared/Slash.luau'], 'return "vfx"\n')
    status = await service.status()
    assert.equal(status.places.find((x) => x.placeKey === '111')!.gate, 'clear')
    // Decided: later Studio edits sync as usual.
    await service.handler.changes({ session: cfg.sessionToken, place, changes: [{ kind: 'source', node: { ...FOREIGN[2], source: 'print("combat 2")' } }] })
    assert.equal(readFileSync(join(root, 'src/server/Combat.server.luau'), 'utf8'), 'print("combat 2")\n')
  } finally {
    service.close()
  }
})

test('a session from another place is refused (session tokens are per place)', async () => {
  const root = project([111, 222])
  const { service } = make(root)
  await service.start()
  try {
    const cfg = await service.handler.config({ placeId: 111 })
    const r = await service.handler.snapshot({ session: cfg.sessionToken, place: { placeId: 0, name: 'Other' }, seq: 0, final: true, nodes: FOREIGN })
    assert.equal(r.ok, false)
    assert.deepEqual(service.conflicts(), [])
  } finally {
    service.close()
  }
})

// ---- recovery for projects that already synced an unlinked place

test('startup after the update: sync state of never-linked places is dropped once, with a note', async () => {
  const root = project([111])
  mkdirSync(join(root, '.forge', 'sync'), { recursive: true })
  const hash = 'a'.repeat(40)
  writeFileSync(
    join(root, '.forge', 'sync', 'index.json'),
    JSON.stringify({ version: 1, legacyMigrated: true, places: { 'unpublished:Place_72187156382444.rbxlx': { 'src/server/Combat.server.luau': hash }, '111': { 'src/shared/Util.luau': hash }, '999': { 'src/shared/Util.luau': hash } } })
  )
  const before = diskState(root)
  const first = make(root).service
  await first.start()
  const status = await first.status()
  first.close()
  assert.ok(status.discarded, 'one-time note')
  assert.match(status.discarded!.text, /"Place_72187156382444\.rbxlx"/)
  assert.match(status.discarded!.text, /place 999/)
  assert.match(status.discarded!.text, /check Source Control to discard/)
  const index = JSON.parse(readFileSync(join(root, '.forge', 'sync', 'index.json'), 'utf8'))
  assert.deepEqual(Object.keys(index.places), ['111'])
  // Files are left for git to show.
  assert.deepEqual(diskState(root), before)
  // Only once.
  const second = make(root).service
  await second.start()
  assert.equal((await second.status()).discarded, undefined)
  second.close()
})

// ---- sessions belong to one project and to a live Studio

test('project A sync state never appears or applies in project B', async () => {
  const a = project([111])
  const b = project() // TestGame: no servePlaceIds
  const bBefore = diskState(b)
  const gates: [string, GateState][] = []
  const wiring = createSync({
    settings: { get: <T>(_k: string, fb: T) => fb, set: () => undefined },
    emit: () => undefined,
    supervisor: { setGate: (f, g) => gates.push([f, g]), applyGates: () => undefined, setSyncSummary: () => undefined },
    pluginsDir: () => null,
    engine: (r) => new SyncEngine({ root: r }),
    mapping: { loadPlaces, placeFor },
    git: async () => ({ code: 1, stdout: '', stderr: '' })
  })
  await wiring.onProjectOpen(a)
  const cfg = await wiring.handler.config({ placeId: 111, place: 'FSF' })
  await wiring.handler.snapshot({ session: cfg.sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: FOREIGN })
  await settle()
  assert.ok(wiring.service()!.conflicts().length > 0)
  // Switch to project B: A's place, session and conflicts are gone; its token is dead; its place is not B's.
  await wiring.onProjectOpen(b)
  gates.length = 0
  const status = (await wiring.handlers.syncStatus()) as Awaited<ReturnType<SyncService['status']>>
  assert.ok(status.places.every((p) => p.placeKey !== '111' && p.gate === 'idle' && !p.connected), JSON.stringify(status.places))
  assert.deepEqual(wiring.service()!.conflicts(), [])
  assert.equal((await wiring.handler.snapshot({ session: cfg.sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: FOREIGN })).ok, false)
  assert.equal((await wiring.handler.config({ placeId: 111, place: 'FSF' })).enabled, false)
  await settle()
  assert.ok(gates.every(([, g]) => g === 'idle'), JSON.stringify(gates))
  assert.deepEqual(diskState(b), bBefore)
  assert.equal(existsSync(join(b, '.forge', 'sync', 'links.json')) ? Object.keys(JSON.parse(readFileSync(join(b, '.forge', 'sync', 'links.json'), 'utf8')).links).length : 0, 0)
  wiring.onProjectClose()
})

test('a place whose Studio went away is not live and does not hold rojo (never-connected: see the unlinked test)', async () => {
  let t = 1_000_000
  let polling: { placeId?: number; place?: string }[] = [{ placeId: 111, place: 'TestGame' }]
  const root = project([111])
  const { service } = make(root, { now: () => t, studios: () => polling })
  await service.start()
  try {
    const cfg = await service.handler.config({ placeId: 111, place: 'TestGame' })
    await service.handler.snapshot({ session: cfg.sessionToken, place: { placeId: 111 }, seq: 0, final: true, nodes: FOREIGN })
    await settle()
    assert.equal(service.gateFor('default.project.json').gate, 'blocked')
    // Still polling: kept even with no sync request for a while.
    t += SESSION_EXPIRE_MS + 1
    service.expireSessions()
    await settle()
    assert.equal(service.gateFor('default.project.json').gate, 'blocked')
    // Studio closed: no poll, no sync request.
    polling = []
    service.expireSessions()
    await settle()
    const status = await service.status()
    const p = status.places.find((x) => x.placeKey === '111')!
    assert.equal(p.connected, false)
    assert.equal(p.gate, 'idle')
    assert.deepEqual(service.conflicts(), [])
    // Its old token is gone: the plugin (if it comes back) starts over.
    assert.equal((await service.handler.changes({ session: cfg.sessionToken, place: { placeId: 111 }, changes: [] })).ok, false)
  } finally {
    service.close()
  }
})
