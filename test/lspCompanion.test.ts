import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, request, type Server } from 'node:http'
import { createServer as createNetServer, type AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { after, test } from 'node:test'
import { LspBridge, SKIP_DIRS } from '../src/main/services/lspBridge.ts'
import { companionHandler, isAllowedOrigin, isLoopbackHost, luauFilePaths, StudioCompanionServer, type CompanionTarget } from '../src/main/services/lspCompanion.ts'
import { DataModelSync } from '../src/main/services/lspDataModel.ts'
import type { LspCompanionStatus } from '../src/shared/types.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// What the Studio plugin posts (plugin/src/types.luau EncodedInstance, rooted at game).
const PLUGIN_TREE = {
  Name: 'game',
  ClassName: 'DataModel',
  FilePaths: [],
  Children: [
    {
      Name: 'Workspace',
      ClassName: 'Workspace',
      FilePaths: [],
      Children: [{ Name: 'Map', ClassName: 'Model', FilePaths: [], Children: [{ Name: 'Door', ClassName: 'Script', FilePaths: ['/p/src/server/Door.server.luau'], Children: [] }] }]
    }
  ]
}

// Fake LSP connection: records what the endpoints forward.
function fakeTarget(overrides: Partial<CompanionTarget> = {}) {
  const calls: { method: string; params?: unknown }[] = []
  const target: CompanionTarget = {
    available: () => true,
    full: (tree) => calls.push({ method: '$/plugin/full', params: tree }),
    clear: () => calls.push({ method: '$/plugin/clear' }),
    filePaths: async () => ['/p/src/server/Door.server.luau', '/p/src/shared/Util.luau'],
    ...overrides
  }
  return { target, calls }
}

async function serve(target: CompanionTarget, maxBodyBytes?: number): Promise<{ server: Server; port: number }> {
  const server = createServer(companionHandler(target, { maxBodyBytes }))
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  return { server, port: (server.address() as AddressInfo).port }
}

type Reply = { status: number; body: string; type: string | undefined }
function call(port: number, method: string, path: string, options: { body?: Buffer | string; headers?: Record<string, string> } = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method, path, agent: false, headers: { Host: `localhost:${port}`, ...options.headers } }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c: Buffer) => chunks.push(c))
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8'), type: res.headers['content-type'] }))
    })
    req.on('error', (error: NodeJS.ErrnoException) => {
      // The server may close a refused upload before it is all sent.
      if (error.code === 'ECONNRESET' || error.code === 'EPIPE') resolve({ status: -1, body: error.code, type: undefined })
      else reject(error)
    })
    if (options.body !== undefined) req.end(options.body)
    else req.end()
  })
}

// As plugin/src/ServerEndpoints.luau sends it: JSON { tree }, gzip compressed.
const pluginFull = (port: number, tree: unknown = PLUGIN_TREE, headers: Record<string, string> = {}) =>
  call(port, 'POST', '/full', { body: gzipSync(JSON.stringify({ tree })), headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip', ...headers } })

test('companion endpoints: /get-file-paths, /full (gzip and plain), /clear, as the VS Code extension answers', async () => {
  const { target, calls } = fakeTarget()
  const { server, port } = await serve(target)
  try {
    const paths = await call(port, 'GET', '/get-file-paths', { headers: { 'Content-Type': 'application/json' } })
    assert.equal(paths.status, 200)
    assert.match(paths.type ?? '', /application\/json/)
    assert.deepEqual(JSON.parse(paths.body), { files: ['/p/src/server/Door.server.luau', '/p/src/shared/Util.luau'] })

    const full = await pluginFull(port)
    assert.equal(full.status, 200)
    assert.equal(full.body, 'OK')
    assert.deepEqual(calls, [{ method: '$/plugin/full', params: PLUGIN_TREE }], 'body.tree is forwarded unchanged, FilePaths included')

    const plain = await call(port, 'POST', '/full', { body: JSON.stringify({ tree: PLUGIN_TREE }), headers: { 'Content-Type': 'application/json; charset=utf-8' } })
    assert.equal(plain.status, 200)
    assert.equal(calls.length, 2)

    const clear = await call(port, 'POST', '/clear')
    assert.equal(clear.status, 200)
    assert.deepEqual(calls[2], { method: '$/plugin/clear' })
  } finally {
    server.close()
  }
})

test('companion endpoints: bad requests are refused and not forwarded', async () => {
  const { target, calls } = fakeTarget()
  const { server, port } = await serve(target)
  try {
    const noTree = gzipSync(JSON.stringify({ nodes: [] }))
    assert.equal((await call(port, 'POST', '/full', { body: noTree, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })).status, 400, 'no tree (the extension answers 400)')
    assert.equal((await call(port, 'POST', '/full', { body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } })).status, 400)
    assert.equal((await call(port, 'POST', '/full', { body: '{nope', headers: { 'Content-Type': 'application/json' } })).status, 400)
    assert.equal((await pluginFull(port, { Name: 'game' })).status, 400, 'root without ClassName')
    assert.equal((await pluginFull(port, [PLUGIN_TREE])).status, 400)
    assert.equal((await call(port, 'POST', '/full', { body: Buffer.from('not gzip'), headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })).status, 400)
    assert.equal((await call(port, 'POST', '/full', { body: 'x', headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'br' } })).status, 415)
    // A browser's no-preflight "simple" POST would be text/plain.
    assert.equal((await call(port, 'POST', '/full', { body: JSON.stringify({ tree: PLUGIN_TREE }), headers: { 'Content-Type': 'text/plain' } })).status, 415)
    assert.equal((await call(port, 'GET', '/full')).status, 405)
    assert.equal((await call(port, 'POST', '/get-file-paths')).status, 405)
    assert.equal((await call(port, 'GET', '/')).status, 404)
    assert.deepEqual(calls, [])
  } finally {
    server.close()
  }
})

test('companion endpoints: only localhost Host and Origin', async () => {
  const { target, calls } = fakeTarget()
  const { server, port } = await serve(target)
  try {
    // DNS rebinding: a page on evil.example resolving to 127.0.0.1.
    assert.equal((await call(port, 'GET', '/get-file-paths', { headers: { Host: `evil.example:${port}` } })).status, 403)
    assert.equal((await pluginFull(port, PLUGIN_TREE, { Host: 'evil.example' })).status, 403)
    // A browser page posting cross-origin.
    assert.equal((await pluginFull(port, PLUGIN_TREE, { Origin: 'https://evil.example' })).status, 403)
    assert.equal((await call(port, 'POST', '/clear', { headers: { Origin: 'null' } })).status, 403)
    assert.deepEqual(calls, [])
    // The plugin's host setting can be localhost or 127.0.0.1; local origins are fine.
    assert.equal((await pluginFull(port, PLUGIN_TREE, { Host: `127.0.0.1:${port}` })).status, 200)
    assert.equal((await pluginFull(port, PLUGIN_TREE, { Origin: `http://localhost:${port}` })).status, 200)
    assert.equal(calls.length, 2)
  } finally {
    server.close()
  }
  assert.equal(isLoopbackHost('localhost:3667'), true)
  assert.equal(isLoopbackHost('[::1]:3667'), true)
  assert.equal(isLoopbackHost('127.0.0.1'), true)
  assert.equal(isLoopbackHost('localhost.evil.example'), false)
  assert.equal(isLoopbackHost(undefined), false)
  assert.equal(isAllowedOrigin(undefined), true)
  assert.equal(isAllowedOrigin('http://127.0.0.1:3667'), true)
  assert.equal(isAllowedOrigin('file://'), false)
})

test('companion endpoints: body size cap, compressed and inflated', async () => {
  const { target, calls } = fakeTarget()
  const { server, port } = await serve(target, 4096)
  try {
    const big = JSON.stringify({ tree: { ...PLUGIN_TREE, Name: 'x'.repeat(8000) } })
    const raw = await call(port, 'POST', '/full', { body: big, headers: { 'Content-Type': 'application/json' } })
    assert.ok(raw.status === 413 || raw.status === -1, `raw over the cap: ${raw.status}`)
    if (raw.status === 413) assert.match(raw.body, /too large/i)
    // Small on the wire, over the cap once inflated (a gzip bomb).
    const bomb = gzipSync(JSON.stringify({ tree: { ...PLUGIN_TREE, Name: 'a'.repeat(200_000) } }))
    assert.ok(bomb.length < 4096)
    const inflated = await call(port, 'POST', '/full', { body: bomb, headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } })
    assert.equal(inflated.status, 413)
    assert.deepEqual(calls, [])
    // Under the cap still works on the same server.
    assert.equal((await pluginFull(port)).status, 200)
  } finally {
    server.close()
  }
})

test('companion endpoints: 503 while no project / luau-lsp, 500 when listing files fails', async () => {
  const { target, calls } = fakeTarget({ available: () => false, filePaths: async () => null })
  const { server, port } = await serve(target)
  try {
    const paths = await call(port, 'GET', '/get-file-paths')
    assert.equal(paths.status, 503)
    assert.match(paths.body, /not running in RBX Forge/)
    assert.equal((await pluginFull(port)).status, 503)
    assert.equal((await call(port, 'POST', '/clear')).status, 503)
    assert.deepEqual(calls, [])
  } finally {
    server.close()
  }
  const failing = await serve(fakeTarget({ filePaths: async () => Promise.reject(new Error('EACCES')) }).target)
  try {
    const res = await call(failing.port, 'GET', '/get-file-paths')
    assert.equal(res.status, 500)
    assert.deepEqual(JSON.parse(res.body), { error: 'Failed to get file paths' })
  } finally {
    failing.server.close()
  }
})

test('luauFilePaths: absolute .lua/.luau paths, skipping node_modules, .git, out, dist', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-companion-files-'))
  dirs.push(root)
  for (const dir of ['src/server', 'src/shared', 'node_modules/x', '.git', 'Packages/_Index/a']) mkdirSync(join(root, dir), { recursive: true })
  for (const file of ['src/server/Door.server.luau', 'src/shared/Util.lua', 'src/shared/readme.md', 'node_modules/x/y.luau', '.git/z.luau', 'Packages/_Index/a/init.luau', 'default.project.json']) {
    writeFileSync(join(root, file), '')
  }
  const files = await luauFilePaths(root, SKIP_DIRS)
  assert.deepEqual(files, [join(root, 'Packages/_Index/a/init.luau'), join(root, 'src/server/Door.server.luau'), join(root, 'src/shared/Util.lua')].sort())
  assert.equal((await luauFilePaths(root, SKIP_DIRS, 1)).length, 1, 'capped')
  assert.deepEqual(await luauFilePaths(join(root, 'missing'), SKIP_DIRS), [])
})

test('companion server: port in use is logged once, shown in the status, retried, and taken once free', async () => {
  // Something else (VS Code's extension) holds the port.
  const blocker = createNetServer()
  await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve))
  const port = (blocker.address() as AddressInfo).port
  const logs: { stream: string; text: string }[] = []
  const statuses: LspCompanionStatus[] = []
  const companion = new StudioCompanionServer({ target: fakeTarget().target, log: (stream, text) => logs.push({ stream, text }), onStatus: (s) => statuses.push(s), retryMs: 15 })
  try {
    const status = await companion.configure(true, port)
    assert.equal(status.state, 'portInUse')
    assert.equal(status.port, port)
    assert.match(status.detail ?? '', /in use/)
    await sleep(80) // several retries
    assert.equal(companion.status().state, 'portInUse')
    assert.equal(logs.filter((l) => /in use/.test(l.text)).length, 1, 'logged once, not per retry')
    assert.equal(logs[0].stream, 'stderr')

    // VS Code closed: the next retry takes the port.
    await new Promise<void>((resolve) => blocker.close(() => resolve()))
    for (let i = 0; i < 100 && companion.status().state !== 'listening'; i++) await sleep(10)
    assert.equal(companion.status().state, 'listening')
    assert.ok(logs.some((l) => l.stream === 'info' && l.text.includes(`localhost:${port}`)))
    const res = await call(port, 'GET', '/get-file-paths')
    assert.equal(res.status, 200)

    // Status reports a connected plugin after a /full, and clears with /clear.
    assert.equal((await pluginFull(port)).status, 200)
    assert.equal(typeof companion.status().lastActivityAt, 'number')
    assert.equal((await call(port, 'POST', '/clear')).status, 200)
    assert.equal(companion.status().lastActivityAt, null)

    // Same settings again: no restart. Turned off: the port is released.
    const before = logs.length
    await companion.configure(true, port)
    assert.equal(logs.length, before)
    assert.equal((await companion.configure(false, port)).state, 'off')
    const probe = createNetServer()
    await new Promise<void>((resolve, reject) => probe.once('error', reject).listen(port, '127.0.0.1', resolve))
    probe.close()
    assert.deepEqual([...new Set(statuses.map((s) => s.state))], ['portInUse', 'listening', 'off'])
  } finally {
    blocker.close()
    await companion.dispose()
  }
})

test('companion server: an invalid port falls back to 3667 and a port change moves the server', async () => {
  const free = async () => {
    const s = createNetServer()
    await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve))
    const p = (s.address() as AddressInfo).port
    await new Promise<void>((resolve) => s.close(() => resolve()))
    return p
  }
  const a = await free()
  const b = await free()
  const companion = new StudioCompanionServer({ target: fakeTarget().target, log: () => undefined, retryMs: 15 })
  try {
    assert.equal((await companion.configure(true, a)).state, 'listening')
    assert.equal((await call(a, 'GET', '/get-file-paths')).status, 200)
    assert.equal((await companion.configure(true, b)).port, b)
    assert.equal((await call(b, 'GET', '/get-file-paths')).status, 200)
    await assert.rejects(call(a, 'GET', '/get-file-paths'), /ECONNREFUSED/)
    assert.equal((await companion.configure(false, 70_000)).port, 3667)
  } finally {
    await companion.dispose()
  }
})

test('DataModelSync: the plugin tree wins while connected, /clear goes back to Forge, restarts get it again', async () => {
  const sent: { method: string; params?: any }[] = []
  const sync = new DataModelSync({ notify: (method, params) => sent.push({ method, params }), debounceMs: 5, retryMs: 5 })
  const forgeTree = [{ name: 'Workspace', className: 'Workspace', origin: 'studio' as const, children: [{ name: 'Snapshot', className: 'Model', origin: 'studio' as const, children: [] }] }]
  sync.setTree(forgeTree)
  sync.setPluginTree(PLUGIN_TREE)
  assert.equal(sent.length, 0, 'nothing before ready()')
  assert.equal(sync.hasPluginTree, true)
  sync.ready()
  await sleep(20)
  assert.deepEqual(sent, [{ method: '$/plugin/full', params: PLUGIN_TREE }], "the plugin's tree, not Forge's snapshot")

  // Forge's snapshot changing does not replace the plugin's tree; the same plugin tree is not resent.
  sync.setTree(structuredClone(forgeTree))
  sync.setPluginTree(structuredClone(PLUGIN_TREE))
  await sleep(20)
  assert.equal(sent.length, 1)
  const updated = structuredClone(PLUGIN_TREE)
  updated.Children[0].Children.push({ Name: 'Lamp', ClassName: 'Part', FilePaths: [], Children: [] })
  sync.setPluginTree(updated)
  assert.equal(sent.length, 2, 'sent at once (the plugin debounces)')

  // Dropped by the server: sent again.
  sync.observe({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 2, message: 'unknown notification method: $/plugin/full' } })
  await sleep(20)
  assert.equal(sent.length, 3)
  assert.deepEqual(sent[2].params, updated)

  // New server process: the plugin tree is sent to it once it is ready.
  sync.reset()
  sync.ready()
  await sleep(20)
  assert.equal(sent.length, 4)
  assert.deepEqual(sent[3].params, updated)

  // /clear: $/plugin/clear, then Forge's own snapshot again.
  sync.clearPluginTree()
  await sleep(20)
  assert.deepEqual(sent.slice(4).map((m) => m.method), ['$/plugin/clear', '$/plugin/full'])
  assert.equal(sent[5].params.Children[0].Children[0].Name, 'Snapshot')
  assert.equal(sync.hasPluginTree, false)
  sync.dispose()
})

// Fake luau-lsp: answers initialize, asks for configuration and echoes every notification.
const FAKE_SERVER = `
let buf = Buffer.alloc(0)
const send = (m) => { const b = Buffer.from(JSON.stringify(m)); process.stdout.write('Content-Length: ' + b.length + '\\r\\n\\r\\n'); process.stdout.write(b) }
process.stdin.on('data', (c) => {
  buf = Buffer.concat([buf, c])
  for (;;) {
    const i = buf.indexOf('\\r\\n\\r\\n'); if (i < 0) return
    const n = Number(/Content-Length: (\\d+)/i.exec(buf.subarray(0, i).toString())[1])
    if (buf.length < i + 4 + n) return
    const m = JSON.parse(buf.subarray(i + 4, i + 4 + n).toString()); buf = buf.subarray(i + 4 + n)
    if (m.method === 'exit') process.exit(0)
    if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } }); continue }
    if (m.method === 'initialized') send({ jsonrpc: '2.0', id: 'cfg', method: 'workspace/configuration', params: { items: [{ section: 'luau-lsp' }] } })
    if (m.method) send({ jsonrpc: '2.0', method: 'echo', params: m })
  }
})
`

test('Studio plugin -> HTTP -> bridge -> luau-lsp: $/plugin/full and $/plugin/clear reach the server', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-companion-'))
  dirs.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'Door.server.luau'), '')
  const script = join(root, 'server.cjs')
  writeFileSync(script, FAKE_SERVER)
  const received: any[] = []
  const bridge = new LspBridge({
    spawn: (args) => spawn(process.execPath, [script, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }),
    send: (m) => received.push(m),
    log: () => undefined,
    cacheDir: root,
    version: async () => '1.70.1',
    types: { ensure: async () => ({ definitions: null, docs: null }) },
    dataModelDebounceMs: 5
  })
  // As src/main/index.ts wires it.
  const target: CompanionTarget = {
    available: () => bridge.acceptsPlugin,
    full: (tree) => bridge.pluginFull(tree),
    clear: () => bridge.pluginClear(),
    filePaths: async () => (bridge.projectRoot ? luauFilePaths(bridge.projectRoot, SKIP_DIRS) : null)
  }
  const { server, port } = await serve(target)
  const waitFor = async (pred: (m: any) => boolean, label: string) => {
    for (let i = 0; i < 300; i++) {
      const found = received.find(pred)
      if (found) return found
      await sleep(10)
    }
    throw new Error('timed out waiting for ' + label)
  }
  try {
    // No project yet: refused, like the extension without a language client.
    assert.equal((await call(port, 'GET', '/get-file-paths')).status, 503)
    assert.equal((await pluginFull(port)).status, 503)

    await bridge.setRoot(root)
    const paths = JSON.parse((await call(port, 'GET', '/get-file-paths')).body)
    assert.deepEqual(paths.files, [join(root, 'src', 'Door.server.luau')])
    // Posted before the editor started luau-lsp: kept, then sent after the handshake.
    assert.equal((await pluginFull(port)).status, 200)
    assert.equal(await bridge.start(), true)
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await waitFor((m) => m.id === 1, 'initialize result')
    bridge.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const cfg = await waitFor((m) => m.method === 'workspace/configuration', 'configuration request')
    bridge.send({ jsonrpc: '2.0', id: cfg.id, result: [{}] })
    bridge.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///x.luau', languageId: 'luau', version: 1, text: '' } } })
    const full = await waitFor((m) => m.method === 'echo' && m.params.method === '$/plugin/full', '$/plugin/full')
    assert.deepEqual(full.params.params, PLUGIN_TREE)

    assert.equal((await call(port, 'POST', '/clear')).status, 200)
    await waitFor((m) => m.method === 'echo' && m.params.method === '$/plugin/clear', '$/plugin/clear')
  } finally {
    server.close()
    await bridge.dispose()
  }
})
