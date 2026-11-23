import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { DirectPushEngine, sha256Text } from '../src/main/services/sync/push.ts'
import { SyncService } from '../src/main/services/sync/service.ts'
import { BaseStore } from '../src/main/services/sync/store.ts'
import { DIRECT_PUSH_PLUGIN_VERSION, PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import type { SyncPushOp } from '../src/shared/sync/protocol.ts'

const dirs: string[] = []
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true })
})

function put(root: string, rel: string, text: string): void {
  const full = join(root, rel)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, text, 'utf8')
}

test('DirectPushEngine: orders ops, deduplicates via sha256, suppresses Studio echoes, and respects gate/conflicts', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'PushTest',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: { $path: 'src/shared' },
          Packages: { $path: 'Packages' }
        }
      }
    })
  )
  put(root, 'src/shared/Existing.luau', 'return "same"\n')
  put(root, 'src/shared/Deep/Mod.luau', 'return "new"\n')
  put(root, 'Packages/Current.luau', 'return "pkg"\n')

  const maps = await loadPlaces(root)
  const map = maps[0]
  let canPush = true
  const conflicted = new Set<string>()
  const pushedEntries: string[] = []

  const engine = new DirectPushEngine({
    root,
    debounceMs: 50,
    canPushPlace: () => canPush,
    isFileConflicted: (_pk, f) => conflicted.has(f),
    onEntries: (_pk, entries) => pushedEntries.push(...entries.map((e) => e.file))
  })

  try {
    // Studio already has Existing.luau matching disk
    engine.recordStudioSnapshot('111', map, [
      { id: 's1', path: ['ReplicatedStorage', 'Shared', 'Existing'], className: 'ModuleScript', source: 'return "same"\n' }
    ])

    // Mark a Studio->disk pull on Another.luau: must be echo-suppressed
    put(root, 'src/shared/Pulled.luau', 'return "from-studio"\n')
    engine.markFromStudio('src/shared/Pulled.luau', 'return "from-studio"\n', '111')

    // Mark Deep/Mod.luau conflicted first: excluded from ops
    conflicted.add('src/shared/Deep/Mod.luau')
    let ops = await engine.syncPlace('111', map)
    assert.ok(!ops.some((o) => 'file' in o && o.file === 'src/shared/Existing.luau'), 'unchanged file skipped')
    assert.ok(!ops.some((o) => 'file' in o && o.file === 'src/shared/Pulled.luau'), 'echo suppressed')
    assert.ok(!ops.some((o) => 'file' in o && o.file === 'src/shared/Deep/Mod.luau'), 'conflicted file blocked')
    assert.ok(ops.some((o) => o.kind === 'upsert-script' && o.file === 'Packages/Current.luau'), 'Packages included')

    // Resolve conflict -> Deep/Mod.luau now queues with parent upsert-folder before upsert-script
    conflicted.delete('src/shared/Deep/Mod.luau')
    ops = await engine.syncPlace('111', map)
    const folderIdx = ops.findIndex((o) => o.kind === 'upsert-folder' && o.path.join('.') === 'ReplicatedStorage.Shared.Deep')
    const modIdx = ops.findIndex((o) => o.kind === 'upsert-script' && o.file === 'src/shared/Deep/Mod.luau')
    assert.ok(folderIdx >= 0 && modIdx > folderIdx, 'upsert-folder ordered before child upsert-script')

    // Gate blocked -> pullNextBatch returns undefined
    canPush = false
    assert.equal(engine.hasPending('111'), false)
    assert.equal(engine.pullNextBatch('111'), undefined)

    // Gate clears -> pull batch + ack
    canPush = true
    assert.equal(engine.hasPending('111'), true)
    const batch = engine.pullNextBatch('111')!
    assert.ok(batch)
    const filesInBatch = batch.ops.filter((o): o is Extract<typeof o, { file: string }> => 'file' in o).map((o) => o.file)
    assert.ok(filesInBatch.includes('src/shared/Deep/Mod.luau'))
    assert.ok(filesInBatch.includes('Packages/Current.luau'))

    const acked = engine.ackBatch('111', { session: 'tok', batchId: batch.batchId, applied: filesInBatch })
    assert.equal(acked.length, filesInBatch.length)
    assert.ok(acked.every((e) => e.action === 'pushed'))
    assert.ok(pushedEntries.includes('src/shared/Deep/Mod.luau'))

    // Rescan now finds zero pending changes until another edit or deletion
    assert.equal((await engine.syncPlace('111', map)).length, 0)
    assert.equal(engine.stats('111')?.pushed, filesInBatch.length)

    // Delete Deep/Mod.luau on disk -> delete op queued
    rmSync(join(root, 'src/shared/Deep/Mod.luau'))
    ops = await engine.syncPlace('111', map)
    assert.ok(ops.some((o) => o.kind === 'delete' && o.file === 'src/shared/Deep/Mod.luau'))
  } finally {
    engine.close()
  }
})

test('HTTP bridge roundtrip: forge-direct serves sourcemap + /sync/push + /sync/push-ack', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-direct-http-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'DirectGame',
      servePlaceIds: [555],
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared' } }
      }
    })
  )
  put(root, 'src/shared/Same.luau', 'return "v1"\n')
  put(root, 'src/shared/Ahead.luau', 'return "from-disk"\n')

  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(k: string, fb: T) => (k === 'sync.engine' ? 'forge-direct' : fb) as T },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined
  })
  const bridge = new StudioBridge({ port: 0, holdMs: 100 })
  bridge.setSyncHandler(service.handler)

  try {
    await service.start()
    await bridge.start()
    const base = `http://127.0.0.1:${bridge.port}/forge-bridge`

    const cfg = (await fetch(`${base}/sync/config?placeId=555&place=DirectGame&probe=probe-dir-1&mode=edit`).then((r) => r.json())) as {
      enabled: boolean
      sessionToken: string
    }
    assert.equal(cfg.enabled, true)

    // Studio connects with Same.luau matching disk, missing Ahead.luau
    const snapReply = await fetch(`${base}/sync/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        session: cfg.sessionToken,
        place: { placeId: 555, name: 'DirectGame' },
        seq: 0,
        final: true,
        nodes: [
          { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
          { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Same'], className: 'ModuleScript', source: 'return "v1"\n' }
        ]
      })
    }).then((r) => r.json())
    assert.deepEqual(snapReply, { ok: true })

    // Next poll advertises pushPending: true
    const pollRes = (await fetch(
      `${base}/poll?v=${PLUGIN_VERSION}&place=DirectGame&placeId=555&sync=${cfg.sessionToken}&probe=probe-dir-1`
    ).then((r) => r.json())) as { idle?: boolean; pushPending?: boolean }
    assert.equal(pollRes.pushPending, true)

    // GET /sync/push delivers Ahead.luau (not Same.luau)
    const pullRes = (await fetch(`${base}/sync/push?session=${cfg.sessionToken}`).then((r) => r.json())) as {
      batch?: { batchId: string; ops: Array<{ kind: string; file?: string; source?: string }> }
    }
    assert.ok(pullRes.batch)
    const scriptOp = pullRes.batch.ops.find((o) => o.kind === 'upsert-script')
    assert.equal(scriptOp?.file, 'src/shared/Ahead.luau')
    assert.equal(scriptOp?.source, 'return "from-disk"\n')

    // POST /sync/push-ack confirms application
    const ackRes = await fetch(`${base}/sync/push-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: cfg.sessionToken,
        batchId: pullRes.batch.batchId,
        applied: ['src/shared/Ahead.luau']
      })
    }).then((r) => r.json())
    assert.deepEqual(ackRes, { ok: true })

    const st = await service.status()
    assert.equal(st.engine, 'forge-direct')
    const place = st.places.find((p) => p.projectFile === 'default.project.json')!
    assert.equal(place.pushStats?.pushed, 1)
    assert.equal(place.sourcemap?.path, 'sourcemap.json')
    assert.ok((place.sourcemap?.nodes ?? 0) >= 4)
  } finally {
    service.close()
    await bridge.stop()
  }
})

test('DirectPushEngine: preserves parent scripts mapped to init.luau and file->folder transitions', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-init-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'InitTest',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: { $path: 'src/shared' }
        }
      }
    })
  )
  put(root, 'src/shared/Onboarding/init.luau', 'return {}\n')
  put(root, 'src/shared/Onboarding/Child.luau', 'return 1\n')
  put(root, 'src/shared/Foo/init.luau', 'return "foo"\n')
  put(root, 'src/shared/Foo/Sub.luau', 'return "sub"\n')

  const maps = await loadPlaces(root)
  const map = maps[0]
  const push = new DirectPushEngine({
    root,
    canPushPlace: () => true,
    isFileConflicted: () => false
  })
  try {
    push.recordStudioSnapshot('place:1', map, [
      { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
      { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Onboarding'], className: 'ModuleScript', source: 'return {}\n' },
      { id: 'r3', path: ['ReplicatedStorage', 'Shared', 'Onboarding', 'Child'], className: 'ModuleScript', source: 'return 1\n' }
    ])
    // Simulate a prior Studio record keyed under the single-file alias before Foo became Foo/init.luau.
    push.seedKnownHashes('place:1', {
      'src/shared/Foo.luau': sha256Text('return "foo"\n')
    })

    const ops = await push.syncPlace('place:1', map)
    assert.deepEqual(
      ops.filter((o) => o.kind === 'delete'),
      []
    )
    assert.equal(ops.some((o) => 'file' in o && o.file === 'src/shared/Onboarding/init.luau'), false)
    assert.equal(ops.some((o) => 'file' in o && o.file === 'src/shared/Foo/Sub.luau'), true)
  } finally {
    push.close()
  }
})

test('DirectPushEngine: pushes unconflicted creates while holding conflicted files and deletes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-partial-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'PartialTest',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: { $path: 'src/shared' }
        }
      }
    })
  )
  put(root, 'src/shared/Conflicted.luau', 'return "disk"\n')
  put(root, 'src/shared/Fresh.luau', 'return "new"\n')

  const maps = await loadPlaces(root)
  const map = maps[0]
  const push = new DirectPushEngine({
    root,
    canPushPlace: () => true,
    canDeletePlace: () => false,
    isFileConflicted: (_pk, rel) => rel === 'src/shared/Conflicted.luau'
  })
  try {
    push.recordStudioSnapshot('place:1', map, [
      { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
      { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Conflicted'], className: 'ModuleScript', source: 'return "studio"\n' },
      { id: 'r3', path: ['ReplicatedStorage', 'Shared', 'RemovedOnDisk'], className: 'ModuleScript', source: 'return "gone"\n' }
    ])

    const ops = await push.syncPlace('place:1', map)
    assert.equal(ops.some((o) => o.kind === 'delete'), false)
    assert.equal(ops.some((o) => 'file' in o && o.file === 'src/shared/Conflicted.luau'), false)
    assert.equal(ops.some((o) => 'file' in o && o.file === 'src/shared/Fresh.luau'), true)
    assert.equal(push.hasPending('place:1'), true)

    const batch = push.pullNextBatch('place:1')
    assert.ok(batch)
    assert.equal(batch.ops.some((o) => o.kind === 'delete'), false)
    assert.equal(batch.ops.some((o) => 'file' in o && o.file === 'src/shared/Conflicted.luau'), false)
    assert.equal(batch.ops.some((o) => 'file' in o && o.file === 'src/shared/Fresh.luau'), true)
  } finally {
    push.close()
  }
})

test('DirectPushEngine + StudioBridge: no /poll spin-loop while batch is inflight or within cooldown', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-nospin-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'NoSpinGame',
      servePlaceIds: [777],
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared' } }
      }
    })
  )
  put(root, 'src/shared/Pending.luau', 'return 1\n')

  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(k: string, fb: T) => (k === 'sync.engine' ? 'forge-direct' : fb) as T },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined
  })
  const bridge = new StudioBridge({ port: 0, holdMs: 120 })
  bridge.setSyncHandler(service.handler)

  try {
    await service.start()
    await bridge.start()
    const base = `http://127.0.0.1:${bridge.port}/forge-bridge`
    const cfg = (await fetch(`${base}/sync/config?placeId=777&place=NoSpinGame&probe=p-nospin&mode=edit`).then((r) => r.json())) as {
      enabled: boolean
      sessionToken: string
    }
    assert.equal(cfg.enabled, true)

    await fetch(`${base}/sync/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        session: cfg.sessionToken,
        place: { placeId: 777, name: 'NoSpinGame' },
        seq: 0,
        final: true,
        nodes: [{ id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' }]
      })
    })

    // First poll wakes immediately with pushPending: true
    const t0 = Date.now()
    const poll1 = (await fetch(`${base}/poll?v=${PLUGIN_VERSION}&place=NoSpinGame&placeId=777&sync=${cfg.sessionToken}&probe=p-nospin`).then((r) => r.json())) as {
      pushPending?: boolean
    }
    assert.equal(poll1.pushPending, true)
    assert.ok(Date.now() - t0 < 100)

    // Immediate second poll is cooldown-held (does NOT spin-return pushPending: true immediately)
    const t1 = Date.now()
    const poll2 = (await fetch(`${base}/poll?v=${PLUGIN_VERSION}&place=NoSpinGame&placeId=777&sync=${cfg.sessionToken}&probe=p-nospin`).then((r) => r.json())) as {
      idle?: boolean
      pushPending?: boolean
    }
    assert.equal(poll2.idle, true)
    assert.notEqual(poll2.pushPending, true)
    assert.ok(Date.now() - t1 >= 80, `expected held poll, got ${Date.now() - t1}ms`)

    // Pull batch (now inflight): pollHint must NOT return pushPending while batch is actively inflight
    const pull = (await fetch(`${base}/sync/push?session=${cfg.sessionToken}`).then((r) => r.json())) as { batch?: { batchId: string } }
    assert.ok(pull.batch)
    assert.equal(service.handler.pollHint!({ placeId: 777, place: 'NoSpinGame', session: cfg.sessionToken, probe: 'p-nospin', pluginVersion: PLUGIN_VERSION }), null)
  } finally {
    service.close()
    await bridge.stop()
  }
})

test('DirectPushEngine: clears stale inflight and preserves Packages hashes across snapshots', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-pkg-snap-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'PkgSnap',
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: {
          Shared: { $path: 'src/shared' },
          Packages: { $path: 'Packages' }
        }
      }
    })
  )
  put(root, 'Packages/Conch.lua', 'return {}\n')
  put(root, 'src/shared/Mod.luau', 'return 1\n')

  const maps = await loadPlaces(root)
  const map = maps[0]
  const push = new DirectPushEngine({
    root,
    canPushPlace: () => true,
    isFileConflicted: () => false
  })
  try {
    push.recordStudioSnapshot('place:1', map, [
      { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
      { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Mod'], className: 'ModuleScript', source: 'return 1\n' }
    ])
    await push.syncPlace('place:1', map)
    const b1 = push.pullNextBatch('place:1')!
    assert.ok(b1)
    assert.equal(b1.ops.some((o) => 'file' in o && o.file === 'Packages/Conch.lua'), true)
    push.ackBatch('place:1', { session: 's1', batchId: b1.batchId, applied: ['Packages/Conch.lua'] })

    // Queue another edit and leave it inflight
    put(root, 'src/shared/Mod2.luau', 'return 2\n')
    await push.syncPlace('place:1', map)
    const stale = push.pullNextBatch('place:1')
    assert.ok(stale)

    // New snapshot arrives: stale inflight is cleared AND acked Packages/Conch.lua hash is preserved
    push.recordStudioSnapshot('place:1', map, [
      { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
      { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Mod'], className: 'ModuleScript', source: 'return 1\n' }
    ])
    const ops2 = await push.syncPlace('place:1', map)
    assert.equal(ops2.some((o) => 'file' in o && o.file === 'Packages/Conch.lua'), false, 'Packages must not re-push after snapshot')
    const b2 = push.pullNextBatch('place:1')!
    assert.ok(b2)
    assert.notEqual(b2.batchId, stale.batchId)
    assert.equal(b2.ops.some((o) => 'file' in o && o.file === 'src/shared/Mod2.luau'), true)
  } finally {
    push.close()
  }
})

test('DirectPushEngine: honors Wally nested default.project.json, skipGlobs, and prioritizes src over Packages', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-wally-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'WallyGame',
      tree: {
        $className: 'DataModel',
        StarterPlayer: {
          StarterPlayerScripts: { Client: { $path: 'src/client' } }
        },
        ServerStorage: { $path: 'src/ServerStorage' },
        ReplicatedStorage: {
          Packages: { $path: 'Packages' }
        }
      }
    })
  )
  put(root, 'tools/studio-sync.json', JSON.stringify({ placeIds: [], skip: ['src/ServerStorage'] }))
  put(root, 'src/client/TET.client.luau', 'print("hi")\n')
  put(root, 'src/ServerStorage/Ignored.luau', 'return "skip"\n')
  put(root, 'Packages/_Index/author_conch@0.3.1/conch/default.project.json', JSON.stringify({ name: 'conch', tree: { $path: 'dist' } }))
  put(root, 'Packages/_Index/author_conch@0.3.1/conch/dist/init.luau', 'return { ok = true }\n')
  put(root, 'Packages/_Index/author_conch@0.3.1/conch/package.json', '{"name":"conch"}')
  put(root, 'Packages/_Index/author_conch@0.3.1/conch/tsconfig.json', '{}')

  const maps = await loadPlaces(root)
  const map = maps[0]
  const push = new DirectPushEngine({
    root,
    canPushPlace: () => true,
    isFileConflicted: () => false
  })
  try {
    push.recordStudioSnapshot('place:1', map, [{ id: 'c1', path: ['StarterPlayer', 'StarterPlayerScripts', 'Client'], className: 'Folder' }])
    const ops = await push.syncPlace('place:1', map)

    const conchOp = ops.find((o): o is Extract<typeof o, { kind: 'upsert-script' }> => o.kind === 'upsert-script' && o.file === 'Packages/_Index/author_conch@0.3.1/conch/dist/init.luau')
    assert.ok(conchOp, JSON.stringify(ops))
    assert.deepEqual(conchOp.path, ['ReplicatedStorage', 'Packages', '_Index', 'author_conch@0.3.1', 'conch'])
    assert.equal(conchOp.className, 'ModuleScript')

    // Metadata files and skipGlobs files excluded
    assert.equal(ops.some((o) => 'file' in o && !!o.file && (o.file.endsWith('package.json') || o.file.endsWith('tsconfig.json'))), false)
    assert.equal(ops.some((o) => 'file' in o && o.file === 'src/ServerStorage/Ignored.luau'), false)

    // User src/ ordered ahead of Packages/
    const tetIdx = ops.findIndex((o) => 'file' in o && o.file === 'src/client/TET.client.luau')
    const conchIdx = ops.findIndex((o) => 'file' in o && o.file === 'Packages/_Index/author_conch@0.3.1/conch/dist/init.luau')
    assert.ok(tetIdx >= 0 && conchIdx > tetIdx, `expected TET (${tetIdx}) before conch (${conchIdx})`)
  } finally {
    push.close()
  }
})

test('SyncService: push-ack updates BaseStore so subsequent Studio edit pulls cleanly without conflict', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-direct-2way-'))
  dirs.push(root)

  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'TwoWayGame',
      servePlaceIds: [888],
      tree: {
        $className: 'DataModel',
        ReplicatedStorage: { Shared: { $path: 'src/shared' } }
      }
    })
  )
  put(root, 'src/shared/Same.luau', 'return "v1"\n')
  put(root, 'src/shared/Ahead.luau', 'return "from-disk"\n')

  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(k: string, fb: T) => (k === 'sync.engine' ? 'forge-direct' : fb) as T },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined
  })
  const bridge = new StudioBridge({ port: 0, holdMs: 100 })
  bridge.setSyncHandler(service.handler)

  try {
    await service.start()
    await bridge.start()
    const base = `http://127.0.0.1:${bridge.port}/forge-bridge`

    const cfg = (await fetch(`${base}/sync/config?placeId=888&place=TwoWayGame&probe=p-2way&mode=edit`).then((r) => r.json())) as {
      enabled: boolean
      sessionToken: string
    }
    await fetch(`${base}/sync/snapshot`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        session: cfg.sessionToken,
        place: { placeId: 888, name: 'TwoWayGame' },
        seq: 0,
        final: true,
        nodes: [
          { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
          { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Same'], className: 'ModuleScript', source: 'return "v1"\n' }
        ]
      })
    })

    const pullRes = (await fetch(`${base}/sync/push?session=${cfg.sessionToken}`).then((r) => r.json())) as {
      batch?: { batchId: string }
    }
    assert.ok(pullRes.batch)

    await fetch(`${base}/sync/push-ack`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session: cfg.sessionToken,
        batchId: pullRes.batch.batchId,
        applied: ['src/shared/Ahead.luau']
      })
    })

    // Studio now edits Ahead.luau -> pulls to disk cleanly with zero conflicts
    const changesReply = (await fetch(`${base}/sync/changes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        mode: 'edit',
        session: cfg.sessionToken,
        place: { placeId: 888, name: 'TwoWayGame' },
        changes: [
          {
            kind: 'added',
            node: { id: 'r3', path: ['ReplicatedStorage', 'Shared', 'Ahead'], className: 'ModuleScript', source: 'return "edited-in-studio"\n' }
          }
        ]
      })
    }).then((r) => r.json())) as { ok: boolean }
    assert.equal(changesReply.ok, true)
    assert.deepEqual(service.conflicts(), [])
    assert.equal(readFileSync(join(root, 'src/shared/Ahead.luau'), 'utf8'), 'return "edited-in-studio"\n')
  } finally {
    service.close()
    await bridge.stop()
  }
})

test('DirectPushEngine: Studio writes match by file text (meta RunContext), emitLegacyScripts:false RunContext, skipped deletes settle', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-hash-'))
  dirs.push(root)
  put(
    root,
    'default.project.json',
    JSON.stringify({
      name: 'HashGame',
      emitLegacyScripts: false,
      tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' }, Packages: { $path: 'Packages' } } }
    })
  )
  put(root, 'src/shared/Boot.server.luau', 'print("boot")\n')
  put(root, 'src/shared/Hud.client.luau', 'print("hud")\n')
  put(root, 'src/shared/Ctx.luau', 'return 1\n')
  put(root, 'src/shared/Ctx.meta.json', JSON.stringify({ properties: { RunContext: 'Client' } }))
  put(root, 'Packages/Old.lua', 'return "old"\n')

  const map = (await loadPlaces(root))[0]
  const engine = new DirectPushEngine({ root, canPushPlace: () => true, isFileConflicted: () => false })
  const files = (ops: SyncPushOp[]) => ops.flatMap((o) => ('file' in o && o.file ? [o.file] : []))
  try {
    engine.recordStudioSnapshot('5', map, [])
    let ops = await engine.syncPlace('5', map)
    const scripts = new Map(ops.flatMap((o) => (o.kind === 'upsert-script' ? [[o.file, o] as const] : [])))
    assert.equal(scripts.get('src/shared/Boot.server.luau')?.runContext, 'Server')
    assert.equal(scripts.get('src/shared/Hud.client.luau')?.runContext, 'Client')
    assert.equal(scripts.get('src/shared/Hud.client.luau')?.className, 'Script')
    const batch = engine.pullNextBatch('5')!
    engine.ackBatch('5', { session: 's', batchId: batch.batchId, applied: files(batch.ops) })

    // A Studio edit Forge wrote to disk (meta RunContext script: the scan digest is source + RunContext,
    // not the file text) is not pushed back, even after the 10 s echo window.
    put(root, 'src/shared/Ctx.luau', 'return 2\n')
    engine.markFromStudio('src/shared/Ctx.luau', 'return 2\n', '5')
    ops = await engine.syncPlace('5', map)
    assert.ok(!files(ops).includes('src/shared/Ctx.luau'), 'Studio write not echoed back')
    // A later disk edit still pushes.
    put(root, 'src/shared/Ctx.luau', 'return 3\n')
    ops = await engine.syncPlace('5', map)
    assert.ok(files(ops).includes('src/shared/Ctx.luau'))
    const b2 = engine.pullNextBatch('5')!
    engine.ackBatch('5', { session: 's', batchId: b2.batchId, applied: files(b2.ops) })

    // A delete the plugin skipped is settled, not queued again on every scan.
    rmSync(join(root, 'Packages/Old.lua'))
    ops = await engine.syncPlace('5', map)
    const del = ops.find((o) => o.kind === 'delete' && o.file === 'Packages/Old.lua')
    assert.ok(del)
    const b3 = engine.pullNextBatch('5')!
    engine.ackBatch('5', { session: 's', batchId: b3.batchId, applied: [], skipped: [{ path: del.path, reason: 'outside synced root' }] })
    ops = await engine.syncPlace('5', map)
    assert.ok(!ops.some((o) => o.kind === 'delete' && o.file === 'Packages/Old.lua'))
  } finally {
    engine.close()
  }
})

type PulledBatch = { batchId: string; ops: { file?: string; kind: string }[] }

async function directSession(placeId: number, name: string, studios?: () => { placeId?: number; place?: string; pluginVersion?: number }[]) {
  const root = mkdtempSync(join(tmpdir(), 'forge-direct-keep-'))
  dirs.push(root)
  put(root, 'default.project.json', JSON.stringify({ name, servePlaceIds: [placeId], tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' } } } }))
  put(root, 'src/shared/Old.luau', 'return "old"\n')
  const service = new SyncService({
    root,
    engine: new SyncEngine({ root }),
    mapping: { loadPlaces, placeFor },
    settings: { get: <T>(k: string, fb: T) => (k === 'sync.engine' ? 'forge-direct' : fb) as T },
    git: async () => ({ code: 1, stdout: '', stderr: '' }),
    pluginsDir: () => null,
    emit: () => undefined,
    ...(studios ? { studios } : {})
  })
  const bridge = new StudioBridge({ port: 0, holdMs: 100 })
  bridge.setSyncHandler(service.handler)
  await service.start()
  await bridge.start()
  const base = `http://127.0.0.1:${bridge.port}/forge-bridge`
  const post = (route: string, body: unknown) =>
    fetch(`${base}/sync/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then((r) => r.json())
  const config = async () =>
    ((await fetch(`${base}/sync/config?placeId=${placeId}&place=${name}&probe=p-${name}&mode=edit`).then((r) => r.json())) as { sessionToken: string }).sessionToken
  const snapshot = (session: string, nodes: unknown[]) => post('snapshot', { mode: 'edit', session, place: { placeId, name }, seq: 0, final: true, nodes })
  const pull = async (session: string) => ((await fetch(`${base}/sync/push?session=${session}`).then((r) => r.json())) as { batch?: PulledBatch }).batch
  const rescan = () => (service as unknown as { syncDirectPush(pk: string): Promise<void> }).syncDirectPush(String(placeId))
  const close = async () => {
    service.close()
    await bridge.stop()
  }
  return { root, service, post, config, snapshot, pull, rescan, close }
}

const OLD_NODES = [
  { id: 'r1', path: ['ReplicatedStorage', 'Shared'], className: 'Folder' },
  { id: 'r2', path: ['ReplicatedStorage', 'Shared', 'Old'], className: 'ModuleScript', source: 'return "old"\n' }
]

test('SyncService: a pushed script Studio does not keep (undo, unsaved place) stays on disk and is pushed again', async () => {
  const s = await directSession(901, 'KeepGame')
  try {
    let session = await s.config()
    await s.snapshot(session, OLD_NODES)
    put(s.root, 'src/shared/TET.luau', 'return "new"\n')
    await s.rescan()
    const batch = await s.pull(session)
    assert.ok(batch?.ops.some((o) => o.file === 'src/shared/TET.luau'))
    await s.post('push-ack', { session, batchId: batch!.batchId, applied: ['src/shared/TET.luau'] })

    // Studio comes back without it (Ctrl+Z, or the place was closed unsaved): kept, not trashed.
    session = await s.config()
    await s.snapshot(session, OLD_NODES)
    assert.ok(existsSync(join(s.root, 'src/shared/TET.luau')), 'disk file kept')
    const again = await s.pull(session)
    assert.ok(again?.ops.some((o) => o.file === 'src/shared/TET.luau'), 'pushed again')

    // Studio confirming the same copy keeps it Forge's: removed in Studio later (Ctrl+Z, closed unsaved),
    // the disk copy still stays.
    await s.post('push-ack', { session, batchId: again!.batchId, applied: ['src/shared/TET.luau'] })
    session = await s.config()
    const tet = { id: 'r3', path: ['ReplicatedStorage', 'Shared', 'TET'], className: 'ModuleScript', source: 'return "new"\n' }
    await s.snapshot(session, [...OLD_NODES, tet])
    const change = (changes: unknown[]) => s.post('changes', { mode: 'edit', session, place: { placeId: 901, name: 'KeepGame' }, changes }) as Promise<{ ok: boolean }>
    assert.equal((await change([{ kind: 'removed', id: 'r3', path: tet.path }])).ok, true)
    assert.ok(existsSync(join(s.root, 'src/shared/TET.luau')), 'same copy confirmed, then removed in Studio: kept')

    // Edited in Studio (pulled to disk), it syncs both ways again: a Studio delete trashes it.
    assert.equal((await change([{ kind: 'added', node: { ...tet, id: 'r4', source: 'return "studio"\n' } }])).ok, true)
    assert.equal(readFileSync(join(s.root, 'src/shared/TET.luau'), 'utf8'), 'return "studio"\n')
    assert.equal((await change([{ kind: 'removed', id: 'r4', path: tet.path }])).ok, true)
    assert.ok(!existsSync(join(s.root, 'src/shared/TET.luau')), 'edited in Studio, then deleted there: trashed')
  } finally {
    await s.close()
  }
})

test('SyncService: no disk -> Studio push to a plugin older than DIRECT_PUSH_PLUGIN_VERSION', async () => {
  let version = DIRECT_PUSH_PLUGIN_VERSION - 1
  const s = await directSession(902, 'OldPlugin', () => [{ placeId: 902, place: 'OldPlugin', pluginVersion: version }])
  try {
    const session = await s.config()
    put(s.root, 'src/shared/New.luau', 'return 1\n')
    await s.snapshot(session, OLD_NODES)
    assert.equal(await s.pull(session), undefined)
    version = DIRECT_PUSH_PLUGIN_VERSION
    await s.rescan()
    const batch = await s.pull(session)
    assert.ok(batch?.ops.some((o) => o.file === 'src/shared/New.luau'))
  } finally {
    await s.close()
  }
})

test('SyncService: a held Studio-only script does not stop pushes of other files', async () => {
  const s = await directSession(903, 'HeldGame')
  try {
    const session = await s.config()
    // First snapshot settles the first sync (Old is the same on both sides).
    await s.snapshot(session, OLD_NODES)
    put(s.root, 'src/shared/Fresh.luau', 'return "fresh"\n')
    // A teammate's script Forge cannot write (unsafe name) is held as Studio-only.
    const session2 = await s.config()
    await s.snapshot(session2, [...OLD_NODES, { id: 'r9', path: ['ReplicatedStorage', 'Shared', 'Bad/Name'], className: 'ModuleScript', source: 'return 0\n' }])
    const batch = await s.pull(session2)
    assert.ok(batch?.ops.some((o) => o.file === 'src/shared/Fresh.luau'))
  } finally {
    await s.close()
  }
})

test('DirectPushEngine: a meta file Forge wrote from Studio never pushes a delete of its container; reverts push', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-push-meta-'))
  dirs.push(root)
  put(root, 'default.project.json', JSON.stringify({ name: 'MetaGame', tree: { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' } } } }))
  put(root, 'src/shared/MyModel/init.meta.json', JSON.stringify({ className: 'Model' }))
  put(root, 'src/shared/MyModel/Child.luau', 'return "v1"\n')
  const map = (await loadPlaces(root))[0]
  const engine = new DirectPushEngine({ root, canPushPlace: () => true, isFileConflicted: () => false })
  try {
    engine.recordStudioSnapshot('7', map, [
      { id: 'm', path: ['ReplicatedStorage', 'Shared', 'MyModel'], className: 'Model' },
      { id: 'c', path: ['ReplicatedStorage', 'Shared', 'MyModel', 'Child'], className: 'ModuleScript', source: 'return "v1"\n' }
    ])
    engine.markFromStudio('src/shared/MyModel/init.meta.json', JSON.stringify({ className: 'Model' }), '7')
    let ops = await engine.syncPlace('7', map)
    assert.ok(!ops.some((o) => o.kind === 'delete'), `no delete: ${JSON.stringify(ops)}`)

    // Studio edits Child to v2 (written to disk), then the disk goes back to v1 (git checkout): v1 is pushed.
    put(root, 'src/shared/MyModel/Child.luau', 'return "v2"\n')
    engine.markFromStudio('src/shared/MyModel/Child.luau', 'return "v2"\n', '7')
    put(root, 'src/shared/MyModel/Child.luau', 'return "v1"\n')
    ops = await engine.syncPlace('7', map)
    assert.ok(ops.some((o) => o.kind === 'upsert-script' && o.file === 'src/shared/MyModel/Child.luau' && o.source === 'return "v1"\n'))
  } finally {
    engine.close()
  }
})

test('BaseStore: the copy a pushed file had before its push stays superseded after a restart', async () => {
  const root = mkdtempSync(join(tmpdir(), 'forge-store-prev-'))
  dirs.push(root)
  const store = new BaseStore(root)
  await store.set('9', 'src/a.luau', 'v1\n')
  const prev = await store.hashOf('9', 'src/a.luau')
  await store.set('9', 'src/a.luau', 'v2\n', true)
  store.markPushed('9', 'src/a.luau', prev)
  await store.save()

  const again = new BaseStore(root)
  assert.equal(again.superseded('9', 'src/a.luau', prev!), false, 'not loaded yet')
  await again.load()
  assert.equal(again.isPushedUnconfirmed('9', 'src/a.luau'), true)
  assert.equal(again.superseded('9', 'src/a.luau', prev!), true)
  // Studio confirming the pushed copy keeps the mark; a Studio edit ends it.
  await again.set('9', 'src/a.luau', 'v2\n')
  assert.equal(again.isPushedUnconfirmed('9', 'src/a.luau'), true)
  await again.set('9', 'src/a.luau', 'v3 from studio\n')
  assert.equal(again.isPushedUnconfirmed('9', 'src/a.luau'), false)
  assert.equal(again.superseded('9', 'src/a.luau', prev!), false)
})
