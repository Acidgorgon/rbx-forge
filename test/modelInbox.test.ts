import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { z } from 'zod'
import type { ArtFetch } from '../src/main/services/art/openaiImages.ts'
import { AssetUploadError, looksLikeFbx, MODEL_CONTENT_TYPE, uploadModelAsset } from '../src/main/services/art/robloxAssets.ts'
import { createModelUploader, inboxDirs, ModelInbox, modelUploadTools, NO_KEY_ERROR, parseRequest, resolveModelFile, type ModelInboxDeps, type UploadModel } from '../src/main/services/art/modelInbox.ts'
import { SERVICE_WRITE_TOOLS } from '../src/main/agent/serviceTools.ts'
import { createIntegrations } from '../src/main/integrations.ts'
import { fakeContext } from './agentFake.ts'
import type { ModelInboxEntry, ModelInboxStatus } from '../src/shared/artTypes.ts'

const FBX = Buffer.concat([Buffer.from('Kaydara FBX Binary  \0\x1a\0', 'latin1'), Buffer.alloc(64, 1)])
const KEY = 'roblox-open-cloud-key-secret-xxxxxxxx'

type Reply = { status: number; body?: string; headers?: Record<string, string> }
interface Call {
  url: string
  method?: string
  headers?: Record<string, string>
  body?: string | Uint8Array
}

function fakeFetch(replies: Reply[] | ((call: Call, i: number) => Reply)): { fetch: ArtFetch; calls: Call[] } {
  const calls: Call[] = []
  let i = 0
  const fetch: ArtFetch = async (url, init = {}) => {
    const call = { url, method: init.method, headers: init.headers, body: init.body }
    calls.push(call)
    const n = i++
    const reply = typeof replies === 'function' ? replies(call, n) : replies[Math.min(n, replies.length - 1)]
    const headers = Object.fromEntries(Object.entries(reply.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return { status: reply.status, ok: reply.status >= 200 && reply.status < 300, headers: { get: (k: string) => headers[k.toLowerCase()] ?? null }, text: async () => reply.body ?? '' }
  }
  return { fetch, calls }
}

const op = (body: object): Reply => ({ status: 200, body: JSON.stringify({ path: 'operations/op-9', ...body }) })

async function tempDocs() {
  const docs = await mkdtemp(join(tmpdir(), 'forge-inbox-'))
  const { modelsDir, inboxDir } = inboxDirs(docs)
  await mkdir(inboxDir, { recursive: true })
  return { docs, modelsDir, inboxDir, cleanup: () => rm(docs, { recursive: true, force: true }) }
}

// ---------------------------------------------------------------- request validation

test('parseRequest: fields, assetType, name limits, bad JSON', () => {
  const ok = parseRequest(JSON.stringify({ file: 'EmberstagHead.fbx', name: ' EmberstagHead ', description: 'head', assetType: 'Model' }))
  assert.deepEqual(ok, { ok: true, value: { file: 'EmberstagHead.fbx', name: 'EmberstagHead', description: 'head', assetType: 'Model' } })
  assert.equal(parseRequest(JSON.stringify({ file: 'a.fbx', name: 'A' })).ok, true)
  assert.match((parseRequest('{"file": "a.fbx", "name": ') as { error: string }).error, /not valid JSON/)
  assert.match((parseRequest(JSON.stringify({ file: 'a.fbx', name: 'A', assetType: 'Decal' })) as { error: string }).error, /Only assetType "Model"/)
  assert.match((parseRequest(JSON.stringify({ file: 'a.fbx', name: '   ' })) as { error: string }).error, /name is empty/)
  assert.match((parseRequest(JSON.stringify({ file: 'a.fbx', name: 'x'.repeat(51) })) as { error: string }).error, /50 characters/)
  assert.match((parseRequest(JSON.stringify({ name: 'A' })) as { error: string }).error, /file/)
  assert.match((parseRequest(JSON.stringify({ file: 'a.fbx', name: 'A\nB' })) as { error: string }).error, /control characters/)
})

test('resolveModelFile: inside the inbox or ForgeModels only; traversal, symlinks, type and size refused', async () => {
  const t = await tempDocs()
  const outside = await mkdtemp(join(tmpdir(), 'forge-outside-'))
  try {
    await writeFile(join(t.inboxDir, 'Head.fbx'), FBX)
    await mkdir(join(t.modelsDir, 'Emberstag'), { recursive: true })
    await writeFile(join(t.modelsDir, 'Emberstag', 'Body.fbx'), FBX)
    await writeFile(join(t.inboxDir, 'Empty.fbx'), '')
    await writeFile(join(t.inboxDir, 'notes.txt'), 'x')
    await writeFile(join(outside, 'Evil.fbx'), FBX)
    await symlink(join(outside, 'Evil.fbx'), join(t.inboxDir, 'Link.fbx'))
    const opts = { baseDir: t.inboxDir, roots: [t.inboxDir, t.modelsDir] }

    const rel = await resolveModelFile('Head.fbx', opts)
    assert.equal(rel.ok && rel.value.abs, join(t.inboxDir, 'Head.fbx'))
    const abs = await resolveModelFile(join(t.modelsDir, 'Emberstag', 'Body.fbx'), opts)
    assert.equal(abs.ok && abs.value.size, FBX.length)

    const refused = async (file: string, re: RegExp, extra: Partial<typeof opts & { maxBytes: number }> = {}) => {
      const r = await resolveModelFile(file, { ...opts, ...extra })
      assert.equal(r.ok, false, file)
      assert.match((r as { error: string }).error, re, file)
    }
    await refused('../Emberstag/Body.fbx', /"\.\."/)
    await refused('sub\\..\\..\\Body.fbx', /"\.\."/)
    await refused(join(outside, 'Evil.fbx'), /must be inside/)
    await refused('Link.fbx', /links outside/)
    await refused('notes.txt', /only \.fbx/)
    await refused('Missing.fbx', /not found/)
    await refused('Empty.fbx', /empty/)
    await refused('Head.fbx', /up to 0 MB|MB; Roblox accepts/, { maxBytes: 10 })
  } finally {
    await t.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- uploadModelAsset (fake fetch)

test('model upload: Model + model/fbx multipart request, operation polling, asset id', async () => {
  const sleeps: number[] = []
  const { fetch, calls } = fakeFetch((_call, i) => {
    if (i === 0) return op({ done: false })
    if (i === 1) return op({ done: false })
    return op({ done: true, response: { path: 'assets/123456', assetId: '123456', moderationResult: { moderationState: 'Reviewing' } } })
  })
  const r = await uploadModelAsset({ apiKey: KEY, bytes: FBX, fileName: 'EmberstagHead.fbx', displayName: 'EmberstagHead', description: 'head', creator: { groupId: 77 }, fetch, sleep: async (ms) => void sleeps.push(ms) })
  assert.equal(r.assetId, '123456')
  assert.equal(r.moderation, 'Reviewing')
  assert.equal(calls[0].url, 'https://apis.roblox.com/assets/v1/assets')
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers?.['x-api-key'], KEY)
  const text = Buffer.from(calls[0].body as Uint8Array).toString('latin1')
  assert.match(text, /name="request"\r\n\r\n\{"assetType":"Model","displayName":"EmberstagHead","description":"head","creationContext":\{"creator":\{"groupId":"77"\}\}\}/)
  assert.match(text, new RegExp(`name="fileContent"; filename="EmberstagHead.fbx"\\r\\nContent-Type: ${MODEL_CONTENT_TYPE.replace('/', '\\/')}`))
  assert.match(text, /Kaydara FBX Binary/)
  assert.equal(calls[1].url, 'https://apis.roblox.com/assets/v1/operations/op-9')
  assert.equal(calls.length, 3)
  assert.equal(sleeps.length, 2)
})

test('model upload: moderation, permission and size errors read clearly; bad files never reach Roblox', async () => {
  const up = (fetch: ArtFetch, extra: Partial<Parameters<typeof uploadModelAsset>[0]> = {}) =>
    uploadModelAsset({ apiKey: KEY, bytes: FBX, fileName: 'A.fbx', displayName: 'A', creator: { userId: 1 }, fetch, sleep: async () => {}, ...extra })
  await assert.rejects(up(fakeFetch([op({ done: true, response: { assetId: '5', moderationResult: { moderationState: 'MODERATION_STATE_REJECTED' } } })]).fetch), /moderation rejected the model \(asset 5\)/)
  await assert.rejects(up(fakeFetch([op({ done: true, error: { code: 400, message: 'Asset name is moderated' } })]).fetch), /moderation rejected the model.*Asset name is moderated/)
  await assert.rejects(up(fakeFetch([op({ done: true, error: { code: 403, message: 'User does not have permission' } })]).fetch), /cannot create Model assets.*group creator/)
  await assert.rejects(up(fakeFetch([op({ done: true, error: { code: 400, message: 'File size exceeds the limit' } })]).fetch), /limited to 20 MB/)
  await assert.rejects(up(fakeFetch([{ status: 403, body: '{"message":"Insufficient scope"}' }]).fetch), /asset:read \+ asset:write/)
  await assert.rejects(up(fakeFetch([{ status: 413, body: '' }]).fetch), /too large.*20 MB/)
  const none = fakeFetch([op({ done: true })])
  await assert.rejects(up(none.fetch, { fileName: 'A.obj' }), /\.fbx/)
  await assert.rejects(up(none.fetch, { bytes: Buffer.from('not a mesh at all') }), /not an FBX/)
  await assert.rejects(up(none.fetch, { bytes: Buffer.alloc(20 * 1024 * 1024 + 1) }), /up to 20 MB/)
  await assert.rejects(up(none.fetch, { bytes: new Uint8Array() }), /empty/)
  assert.equal(none.calls.length, 0)
  assert.equal(looksLikeFbx(Buffer.from('; FBX 7.4.0 project file\n')), true)
})

test('uploadModel(path, { name, description }): reads the file; no key or creator explains, without a request', async () => {
  const t = await tempDocs()
  try {
    const path = join(t.inboxDir, 'Head.fbx')
    await writeFile(path, FBX)
    const { fetch, calls } = fakeFetch([op({ done: true, response: { assetId: '42' } })])
    const upload = createModelUploader({ key: async () => KEY, creator: () => ({ userId: 9 }), fetch, sleep: async () => {} })
    assert.deepEqual(await upload(path, { name: 'Head', description: 'd' }), { assetId: '42' })
    assert.equal(calls.length, 1)
    await assert.rejects(createModelUploader({ key: async () => null, creator: () => ({ userId: 9 }), fetch })(path, { name: 'Head' }), (e: Error) => e instanceof AssetUploadError && e.message === NO_KEY_ERROR)
    await assert.rejects(createModelUploader({ key: async () => KEY, creator: () => ({}), fetch })(path, { name: 'Head' }), /creator/)
    assert.equal(calls.length, 1)
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- the inbox state machine

function inbox(t: Awaited<ReturnType<typeof tempDocs>>, upload: UploadModel, extra: Partial<ModelInboxDeps> = {}) {
  const logs: string[] = []
  const results: ModelInboxEntry[] = []
  const sleeps: number[] = []
  const box = new ModelInbox({
    dir: () => t.inboxDir,
    modelsDir: () => t.modelsDir,
    enabled: () => true,
    upload,
    log: (text) => void logs.push(text),
    onResult: (e) => void results.push(e),
    watch: null,
    pollMs: 0,
    settleMs: 0,
    sleep: async (ms) => void sleeps.push(ms),
    ...extra
  })
  return { box, logs, results, sleeps }
}

const readJson = async (path: string) => JSON.parse(await readFile(path, 'utf8'))

test('inbox: request -> uploading -> done -> request renamed; idempotent on rescan and on a reused id', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'EmberstagHead.fbx'), FBX)
    await writeFile(join(t.inboxDir, 'job-1.request.json'), JSON.stringify({ file: 'EmberstagHead.fbx', name: 'EmberstagHead', description: 'Emberstag head', assetType: 'Model' }))
    const seen: unknown[] = []
    const uploads: { path: string; name: string; description?: string }[] = []
    const { box, logs, results } = inbox(t, async (path, o) => {
      // While the upload runs, the result file already says so.
      seen.push(await readJson(join(t.inboxDir, 'job-1.result.json')))
      uploads.push({ path, ...o })
      return { assetId: '123' }
    })
    await box.scan()
    assert.deepEqual(seen, [{ status: 'uploading' }])
    assert.deepEqual(uploads, [{ path: join(t.inboxDir, 'EmberstagHead.fbx'), name: 'EmberstagHead', description: 'Emberstag head' }])
    const done = await readJson(join(t.inboxDir, 'job-1.result.json'))
    assert.equal(done.status, 'done')
    assert.equal(done.assetId, 123)
    assert.equal(done.name, 'EmberstagHead')
    assert.ok(!Number.isNaN(Date.parse(done.uploadedAt)))
    const files = (await readdir(t.inboxDir)).sort()
    assert.deepEqual(files, ['EmberstagHead.fbx', 'job-1.request.done.json', 'job-1.result.json'])
    assert.equal(results.length, 1)
    assert.equal(results[0].assetId, 123)
    assert.ok(logs.some((l) => l.includes('EmberstagHead -> rbxassetid://123')))

    await box.scan()
    assert.equal(uploads.length, 1)
    // The same id again: the result exists, so no upload; the request is still retired.
    await writeFile(join(t.inboxDir, 'job-1.request.json'), JSON.stringify({ file: 'EmberstagHead.fbx', name: 'Again' }))
    await box.scan()
    assert.equal(uploads.length, 1)
    assert.ok(!(await readdir(t.inboxDir)).includes('job-1.request.json'))
    assert.equal((await readJson(join(t.inboxDir, 'job-1.result.json'))).name, 'EmberstagHead')
  } finally {
    await t.cleanup()
  }
})

test('inbox: failures write an error result and retire the request (validation, upload error, no key)', async () => {
  const t = await tempDocs()
  const outside = await mkdtemp(join(tmpdir(), 'forge-outside-'))
  try {
    await writeFile(join(outside, 'Evil.fbx'), FBX)
    await writeFile(join(t.inboxDir, 'A.fbx'), FBX)
    await writeFile(join(t.inboxDir, 'bad-json.request.json'), '{"file": ')
    await writeFile(join(t.inboxDir, 'escape.request.json'), JSON.stringify({ file: '../../outside/Evil.fbx', name: 'Evil' }))
    await writeFile(join(t.inboxDir, 'abs.request.json'), JSON.stringify({ file: join(outside, 'Evil.fbx'), name: 'Evil' }))
    await writeFile(join(t.inboxDir, 'rejected.request.json'), JSON.stringify({ file: 'A.fbx', name: 'A' }))
    let calls = 0
    const { box, results } = inbox(t, async () => {
      calls++
      throw new AssetUploadError('Roblox moderation rejected the model. Rename it or change the mesh, then upload again.')
    })
    await box.scan()
    assert.equal(calls, 1)
    assert.match((await readJson(join(t.inboxDir, 'bad-json.result.json'))).error, /not valid JSON/)
    assert.match((await readJson(join(t.inboxDir, 'escape.result.json'))).error, /"\.\."/)
    assert.match((await readJson(join(t.inboxDir, 'abs.result.json'))).error, /must be inside/)
    assert.deepEqual(await readJson(join(t.inboxDir, 'rejected.result.json')), { status: 'error', error: 'Roblox moderation rejected the model. Rename it or change the mesh, then upload again.' })
    const files = await readdir(t.inboxDir)
    for (const id of ['bad-json', 'escape', 'abs', 'rejected']) {
      assert.ok(files.includes(`${id}.request.done.json`), id)
      assert.ok(!files.includes(`${id}.request.json`), id)
    }
    assert.equal(results.filter((r) => r.status === 'error').length, 4)

    // No key: the result says so and nothing is uploaded.
    await writeFile(join(t.inboxDir, 'nokey.request.json'), JSON.stringify({ file: 'A.fbx', name: 'A' }))
    const nokey = inbox(t, async () => (calls++, { assetId: '1' }), { blocked: async () => NO_KEY_ERROR })
    await nokey.box.scan()
    assert.equal(calls, 1)
    assert.deepEqual(await readJson(join(t.inboxDir, 'nokey.result.json')), { status: 'error', error: NO_KEY_ERROR })
  } finally {
    await t.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

test('inbox: off does nothing; files still being written wait; a stale "uploading" is closed without re-uploading', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'A.fbx'), FBX)
    await writeFile(join(t.inboxDir, 'a.request.json'), JSON.stringify({ file: 'A.fbx', name: 'A' }))
    let calls = 0
    const upload: UploadModel = async () => (calls++, { assetId: '7' })
    let enabled = false
    const off = inbox(t, upload, { enabled: () => enabled })
    await off.box.scan()
    assert.deepEqual((await readdir(t.inboxDir)).sort(), ['A.fbx', 'a.request.json'])

    // Just written: deferred until it settles.
    enabled = true
    const fresh = inbox(t, upload, { settleMs: 60_000 })
    assert.equal(await fresh.box.process(t.inboxDir, 'a'), 'deferred')
    assert.equal(calls, 0)

    // A Forge that quit mid-upload left "uploading": close it as an error, never upload twice.
    await writeFile(join(t.inboxDir, 'a.result.json'), JSON.stringify({ status: 'uploading' }))
    const later = inbox(t, upload)
    await later.box.scan()
    assert.equal(calls, 0)
    const r = await readJson(join(t.inboxDir, 'a.result.json'))
    assert.equal(r.status, 'error')
    assert.match(r.error, /Forge stopped during this upload/)
    assert.ok((await readdir(t.inboxDir)).includes('a.request.done.json'))
  } finally {
    await t.cleanup()
  }
})

test('inbox: one upload at a time, spaced by minIntervalMs, capped per hour', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'A.fbx'), FBX)
    for (const id of ['r1', 'r2', 'r3']) await writeFile(join(t.inboxDir, `${id}.request.json`), JSON.stringify({ file: 'A.fbx', name: id }))
    let running = 0
    let peak = 0
    let n = 0
    let clock = Date.now() + 60_000
    const { box, sleeps, logs } = inbox(
      t,
      async () => {
        peak = Math.max(peak, ++running)
        await new Promise((r) => setTimeout(r, 5))
        running--
        return { assetId: String(++n) }
      },
      { now: () => clock, minIntervalMs: 10_000, maxPerHour: 2 }
    )
    // Overlapping scans fold into one serial pass.
    await Promise.all([box.scan(), box.scan()])
    assert.equal(peak, 1)
    assert.equal(n, 2)
    assert.deepEqual(sleeps, [10_000])
    assert.ok((await readdir(t.inboxDir)).includes('r3.request.json'), 'third request waits for the hourly cap')
    assert.ok(logs.some((l) => /2 uploads in the last hour/.test(l)))
    clock += 3_600_001
    await box.scan()
    assert.equal(n, 3)
    assert.equal((await readJson(join(t.inboxDir, 'r3.result.json'))).assetId, 3)
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- agent tool and wiring

test('roblox_upload_model tool: registered as a write tool, validates the path, returns the asset id', async () => {
  const t = await tempDocs()
  try {
    const project = join(t.docs, 'Game')
    await mkdir(join(project, 'models'), { recursive: true })
    await writeFile(join(project, 'models', 'Head.fbx'), FBX)
    const uploads: string[] = []
    const [tool] = modelUploadTools({ upload: async (p) => (uploads.push(p), { assetId: '55' }), roots: () => [t.inboxDir, t.modelsDir], projectRoot: () => project })
    assert.equal(tool.name, 'roblox_upload_model')
    assert.ok((SERVICE_WRITE_TOOLS as readonly string[]).includes(tool.name))
    const schema = z.object(tool.inputSchema)
    assert.equal(schema.safeParse({ path: 'a.fbx' }).success, false)
    assert.equal(schema.safeParse({ path: 'a.fbx', name: 'Head' }).success, true)
    const ok = await tool.handler({ path: 'models/Head.fbx', name: 'Head' })
    assert.equal(ok.isError, undefined)
    assert.match(ok.content[0].text, /Model asset 55 \(rbxassetid:\/\/55\)/)
    assert.deepEqual(uploads, [join(project, 'models', 'Head.fbx')])
    const bad = await tool.handler({ path: '../../etc/passwd.fbx', name: 'X' })
    assert.equal(bad.isError, true)
    assert.equal(uploads.length, 1)
  } finally {
    await t.cleanup()
  }
})

test('wiring: inbox is off by default, needs a key to turn on, keeps the key out of status', async () => {
  const t = await tempDocs()
  const user = await mkdtemp(join(tmpdir(), 'forge-inbox-user-'))
  const fake = fakeContext()
  const store = new Map<string, unknown>()
  const integrations = createIntegrations({
    ctx: fake.ctx,
    settings: { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => void store.set(k, v) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from('enc:' + s), decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '') },
    userDataDir: user,
    emit: fake.ctx.emit,
    log: () => {},
    root: () => null,
    projectFile: () => null,
    projectName: () => 'Fake',
    packages: { search: async () => [], metadata: async () => ({ scope: 'a', name: 'b', latest: '1.0.0', versions: ['1.0.0'] }), addDep: async () => [] },
    git: () => null,
    studioConflicts: async () => [],
    pauseProjectWatch: () => {},
    resumeProjectWatch: () => {},
    services: () => [],
    startService: async () => {},
    stopService: async () => {},
    openExternal: () => {},
    choosePlaceFile: async () => null,
    modelInbox: { documentsDir: t.docs, chooseFolder: async () => join(t.docs, 'Picked') }
  })
  try {
    const h = integrations.handlers
    let s = (await h.fbxInboxStatus()) as ModelInboxStatus
    assert.equal(s.enabled, false)
    assert.equal(s.watching, false)
    assert.equal(s.dir, t.inboxDir)
    assert.equal(s.modelsDir, t.modelsDir)
    await assert.rejects(Promise.resolve().then(() => h.fbxInboxSetSettings({ enabled: true })), /Open Cloud API key/)
    await h.artSetRobloxKey(KEY, 'global')
    s = (await h.fbxInboxSetSettings({ enabled: true })) as ModelInboxStatus
    assert.equal(s.enabled, true)
    assert.equal(s.watching, true)
    assert.equal(s.robloxKey, true)
    assert.equal(s.creator, false)
    assert.ok(!JSON.stringify(s).includes(KEY))
    s = (await h.fbxInboxChooseFolder()) as ModelInboxStatus
    assert.equal(s.dir, join(t.docs, 'Picked'))
    assert.ok((await readdir(t.docs)).includes('Picked'))
    s = (await h.fbxInboxSetSettings({ dir: null })) as ModelInboxStatus
    assert.equal(s.dir, t.inboxDir)
    await assert.rejects(Promise.resolve().then(() => h.fbxInboxSetSettings({ dir: 'relative/folder' })), /absolute/)
    s = (await h.fbxInboxSetSettings({ enabled: false })) as ModelInboxStatus
    assert.equal(s.watching, false)
    assert.ok(integrations.serviceTools().write.some((tool) => tool.name === 'roblox_upload_model'))
  } finally {
    integrations.dispose()
    await t.cleanup()
    await rm(user, { recursive: true, force: true })
  }
})
