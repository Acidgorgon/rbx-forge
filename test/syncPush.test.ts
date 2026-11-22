import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, test } from 'node:test'
import { StudioBridge } from '../src/main/services/studio/bridge.ts'
import { SyncEngine } from '../src/main/services/sync/engine.ts'
import { loadPlaces, placeFor } from '../src/main/services/sync/mapping.ts'
import { DirectPushEngine, sha256Text } from '../src/main/services/sync/push.ts'
import { SyncService } from '../src/main/services/sync/service.ts'

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

test('HTTP bridge roundtrip: default forge-direct serves sourcemap + /sync/push + /sync/push-ack', async () => {
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
    settings: { get: <T>(_k: string, fb: T) => fb },
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
      `${base}/poll?v=15&place=DirectGame&placeId=555&sync=${cfg.sessionToken}&probe=probe-dir-1`
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
