import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { encodeMessage, isWatched, LspBridge, LspFramer, lspArgs, normalizeWatchDirs, TypeCache } from '../src/main/services/lspBridge.ts'

const dirs: string[] = []
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lsp-test-'))
  dirs.push(dir)
  return dir
}
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})

test('framer parses a whole frame', () => {
  const framer = new LspFramer()
  assert.deepEqual(framer.push(encodeMessage({ id: 1, result: 'ok' })), [{ id: 1, result: 'ok' }])
})

test('framer handles frames split at every byte, including inside multi-byte characters', () => {
  const message = { jsonrpc: '2.0', method: 'x', params: { text: 'héllo → 🌲 wörld' } }
  const bytes = encodeMessage(message)
  const framer = new LspFramer()
  const out: unknown[] = []
  for (let i = 0; i < bytes.length; i++) out.push(...framer.push(bytes.subarray(i, i + 1)))
  assert.deepEqual(out, [message])
})

test('framer handles coalesced frames and a trailing partial frame', () => {
  const a = { id: 1, result: [1, 2, 3] }
  const b = { method: 'note', params: { s: 'ünïcode' } }
  const c = { id: 2, result: null }
  const all = Buffer.concat([encodeMessage(a), encodeMessage(b), encodeMessage(c)])
  const cut = all.length - 5
  const framer = new LspFramer()
  assert.deepEqual(framer.push(all.subarray(0, cut)), [a, b])
  assert.deepEqual(framer.push(all.subarray(cut)), [c])
})

test('framer accepts extra headers and any header case', () => {
  const body = JSON.stringify({ id: 3 })
  const raw = `content-type: application/vscode-jsonrpc; charset=utf-8\r\nCONTENT-LENGTH: ${Buffer.byteLength(body)}\r\n\r\n${body}`
  assert.deepEqual(new LspFramer().push(raw), [{ id: 3 }])
})

test('framer skips frames with bad JSON and keeps going', () => {
  const errors: string[] = []
  const framer = new LspFramer((e) => errors.push(e))
  const bad = 'Content-Length: 3\r\n\r\n{x}'
  const out = framer.push(Buffer.concat([Buffer.from(bad), encodeMessage({ id: 9 })]))
  assert.deepEqual(out, [{ id: 9 }])
  assert.equal(errors.length, 1)
})

test('lsp args: named definitions for 1.56+, plain path before, nothing when not cached', () => {
  const files = { definitions: '/c/globalTypes.PluginSecurity.d.luau', docs: '/c/api-docs.json' }
  assert.deepEqual(lspArgs(files, '1.70.1'), [
    '--definitions:@roblox=/c/globalTypes.PluginSecurity.d.luau',
    '--docs=/c/api-docs.json'
  ])
  assert.deepEqual(lspArgs(files, null)[0], '--definitions:@roblox=/c/globalTypes.PluginSecurity.d.luau')
  assert.deepEqual(lspArgs(files, '1.32.0')[0], '--definitions=/c/globalTypes.PluginSecurity.d.luau')
  assert.deepEqual(lspArgs({ definitions: null, docs: null }, '1.70.1'), [])
  assert.ok(!lspArgs(files, '1.70.1').some((a) => a.includes('sourcemap')))
})

test('watched files', () => {
  assert.ok(isWatched('src/shared/Foo.luau'))
  assert.ok(isWatched('sourcemap.json'))
  assert.ok(isWatched('.luaurc'))
  assert.ok(!isWatched('node_modules/x/y.lua'))
  assert.ok(!isWatched('harness/package.json'))
})

test('type cache downloads once, falls back to mirrors, refreshes when a week old', async () => {
  const dir = tempDir()
  const calls: string[] = []
  const fakeFetch = async (url: string) => {
    calls.push(url)
    if (url.includes('pages.dev')) return { ok: false, status: 404, text: async () => '' }
    return { ok: true, status: 200, text: async () => `content of ${url}` }
  }
  const cache = new TypeCache(dir, () => undefined, fakeFetch)
  const files = await cache.ensure()
  assert.ok(files.definitions && files.docs)
  assert.match(readFileSync(files.definitions, 'utf8'), /raw\.githubusercontent\.com\/JohnnyMorganz/)
  assert.match(readFileSync(files.docs, 'utf8'), /Roblox-Client-Tracker/)
  assert.equal(calls.length, 4)

  await cache.ensure()
  assert.equal(calls.length, 4, 'fresh cache is not downloaded again')

  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000)
  utimesSync(files.definitions, old, old)
  const refreshed = await cache.ensure()
  assert.ok(refreshed.definitions)
  // Stale file is used right away; the refresh runs in the background.
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.ok(statSync(files.definitions).mtimeMs > old.getTime())
})

test('type cache gives null paths when offline', async () => {
  const cache = new TypeCache(tempDir(), () => undefined, async () => {
    throw new Error('offline')
  })
  assert.deepEqual(await cache.ensure(), { definitions: null, docs: null })
})

// A tiny LSP server: answers initialize, echoes notifications back, exits on {method:"crash"}.
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
    if (m.method === 'crash') process.exit(3)
    if (m.method === 'exit') process.exit(0)
    if (m.method === 'initialize') send({ jsonrpc: '2.0', id: m.id, result: { capabilities: { hoverProvider: true }, args: process.argv.slice(2) } })
    else send({ jsonrpc: '2.0', method: 'echo', params: m })
  }
})
`

test('bridge relays messages both ways and restarts a crashed server', async () => {
  const root = tempDir()
  const script = join(root, 'server.cjs')
  writeFileSync(script, FAKE_SERVER)
  const received: any[] = []
  let spawned = 0
  const bridge = new LspBridge({
    spawn: (args) => {
      spawned++
      return spawn(process.execPath, [script, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] })
    },
    send: (m) => received.push(m),
    log: () => undefined,
    cacheDir: root,
    backoffMs: 20,
    version: async () => '1.70.1',
    types: { ensure: async () => ({ definitions: '/defs.d.luau', docs: null }) }
  })
  const waitFor = async (pred: (m: any) => boolean) => {
    for (let i = 0; i < 200; i++) {
      const found = received.find(pred)
      if (found) return found
      await new Promise((r) => setTimeout(r, 10))
    }
    throw new Error('timed out; got ' + JSON.stringify(received))
  }
  try {
    assert.equal(await bridge.start(), false, 'no project yet')
    await bridge.setRoot(root)
    // setRoot after start() spawns and announces the server.
    await waitFor((m) => m.method === 'harness/lspRestarted')
    assert.equal(await bridge.start(), true)
    assert.equal(spawned, 1, 'a fresh, uninitialized server is reused')

    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    const init = await waitFor((m) => m.id === 1)
    assert.deepEqual(init.result.args, ['--definitions:@roblox=/defs.d.luau'])

    bridge.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { text: 'local x = "ü"' } })
    const echo = await waitFor((m) => m.method === 'echo')
    assert.equal(echo.params.params.text, 'local x = "ü"')

    received.length = 0
    bridge.send({ jsonrpc: '2.0', method: 'crash' })
    await waitFor((m) => m.method === 'harness/lspStopped')
    const restarted = await waitFor((m) => m.method === 'harness/lspRestarted')
    assert.ok(String(restarted.params.rootUri).startsWith('file://'))
    assert.equal(spawned, 2)

    bridge.send({ jsonrpc: '2.0', id: 2, method: 'initialize', params: {} })
    await waitFor((m) => m.id === 2)

    // A second start() after initialize (window reload) gets a new process.
    assert.equal(await bridge.start(), true)
    assert.equal(spawned, 3)
  } finally {
    await bridge.dispose()
  }
})

test('watch dirs: top-most mapped folders only, normalized', () => {
  assert.deepEqual(normalizeWatchDirs(['src/shared', './src', 'src/server/', 'lib', 'lib2']), ['lib', 'lib2', 'src'])
  assert.deepEqual(normalizeWatchDirs(['src', '.', 'lib']), [''])
  assert.deepEqual(normalizeWatchDirs(['src\\client', 'src\\client\\ui']), ['src/client'])
  assert.deepEqual(normalizeWatchDirs([]), [])
})

test('file watcher covers mapped folders and root config, resolves renames with a stat', async () => {
  const root = tempDir()
  const script = join(root, 'server.cjs')
  writeFileSync(script, FAKE_SERVER)
  const vcs = '.' + 'git'
  for (const dir of ['src/shared', vcs, 'node_modules/pkg', 'art']) mkdirSync(join(root, dir), { recursive: true })
  const received: any[] = []
  const bridge = new LspBridge({
    spawn: (args) => spawn(process.execPath, [script, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }),
    send: (m) => received.push(m),
    log: () => undefined,
    cacheDir: root,
    backoffMs: 20,
    version: async () => '1.70.1',
    types: { ensure: async () => ({ definitions: null, docs: null }) }
  })
  const changes = () =>
    received
      .filter((m) => m.method === 'echo' && m.params.method === 'workspace/didChangeWatchedFiles')
      .flatMap((m) => m.params.params.changes as { uri: string; type: number }[])
      .map((c) => ({ path: decodeURIComponent(c.uri).slice(`file://${root}`.length + 1).replace(/^\//, ''), type: c.type }))
  const waitFor = async (pred: () => boolean) => {
    for (let i = 0; i < 300 && !pred(); i++) await new Promise((r) => setTimeout(r, 10))
    assert.ok(pred(), 'timed out; got ' + JSON.stringify(changes()))
  }
  try {
    bridge.setWatchDirs(['src/shared', 'src'])
    await bridge.start()
    await bridge.setRoot(root)
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await waitFor(() => received.some((m) => m.id === 1))
    bridge.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    await new Promise((r) => setTimeout(r, 100))
    writeFileSync(join(root, vcs, 'index'), 'x')
    writeFileSync(join(root, 'node_modules', 'pkg', 'x.lua'), 'x')
    writeFileSync(join(root, 'art', 'y.luau'), 'x')
    writeFileSync(join(root, 'src', 'shared', 'A.luau'), 'return 1')
    writeFileSync(join(root, '.luaurc'), '{}')
    await waitFor(() => changes().some((c) => c.path === 'src/shared/A.luau') && changes().some((c) => c.path === '.luaurc'))
    const first = changes()
    assert.equal(first.find((c) => c.path === 'src/shared/A.luau')?.type, 1)
    assert.ok(first.every((c) => !c.path.startsWith(vcs) && !c.path.startsWith('node_modules') && !c.path.startsWith('art')), JSON.stringify(first))
    received.length = 0
    rmSync(join(root, 'src', 'shared', 'A.luau'))
    await waitFor(() => changes().some((c) => c.path === 'src/shared/A.luau'))
    assert.equal(changes().find((c) => c.path === 'src/shared/A.luau')?.type, 3)
  } finally {
    await bridge.dispose()
  }
})
