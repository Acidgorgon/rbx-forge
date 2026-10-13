import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, test } from 'node:test'
import { LspBridge } from '../src/main/services/lspBridge.ts'
import { DataModelSync, hasStudioNodes, toPluginDataModel } from '../src/main/services/lspDataModel.ts'

const dirs: string[] = []
after(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true })
})
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

// Forge's merged tree (project.ts mergeStudioTree): top level = services.
type Node = { name: string; className: string; origin?: 'repo' | 'studio' | 'both'; filePath?: string; props?: Record<string, number>; children: Node[] }
const TREE: Node[] = [
  {
    name: 'ReplicatedStorage',
    className: 'ReplicatedStorage',
    origin: 'both',
    children: [
      { name: 'Shared', className: 'Folder', origin: 'repo', filePath: undefined, children: [{ name: 'Util', className: 'ModuleScript', origin: 'repo', filePath: 'src/shared/Util.luau', children: [] }] },
      { name: 'Assets', className: 'Folder', origin: 'studio', props: { Size: 3 }, children: [{ name: 'Sword Model', className: 'Model', origin: 'studio', children: [] }] }
    ]
  },
  {
    name: 'Workspace',
    className: 'Workspace',
    origin: 'studio',
    children: [{ name: 'Map', className: 'Model', origin: 'studio', children: [{ name: 'Spawn', className: 'SpawnLocation', origin: 'studio', children: [] }] }]
  }
]

test('merged tree -> luau-lsp plugin DataModel payload', () => {
  const { root, count, truncated } = toPluginDataModel(TREE)
  // Shape of the Studio plugin's EncodedInstance (plugin/src/types.luau), rooted at game.
  assert.deepEqual(root, {
    Name: 'game',
    ClassName: 'DataModel',
    Children: [
      {
        Name: 'ReplicatedStorage',
        ClassName: 'ReplicatedStorage',
        Children: [
          { Name: 'Shared', ClassName: 'Folder', Children: [{ Name: 'Util', ClassName: 'ModuleScript', Children: [] }] },
          { Name: 'Assets', ClassName: 'Folder', Children: [{ Name: 'Sword Model', ClassName: 'Model', Children: [] }] }
        ]
      },
      {
        Name: 'Workspace',
        ClassName: 'Workspace',
        Children: [{ Name: 'Map', ClassName: 'Model', Children: [{ Name: 'Spawn', ClassName: 'SpawnLocation', Children: [] }] }]
      }
    ]
  })
  assert.equal(count, 8)
  assert.equal(truncated, false)
  // No FilePaths: sourcemap.json owns the file mapping (a plugin node's FilePaths would replace it).
  assert.ok(!JSON.stringify(root).includes('FilePaths'))

  // Breadth-first cap keeps both services before going deep.
  const capped = toPluginDataModel(TREE, 3)
  assert.equal(capped.truncated, true)
  assert.deepEqual(capped.root.Children.map((c) => c.Name), ['ReplicatedStorage', 'Workspace'])
  assert.equal(capped.count, 3)

  // Bad nodes are skipped.
  const odd = toPluginDataModel([{ name: 'X', className: '', children: [] }, null as any, { name: 7 as any, className: 'Folder', children: [] }])
  assert.deepEqual(odd.root.Children, [])
  assert.deepEqual(toPluginDataModel(null).root, { Name: 'game', ClassName: 'DataModel', Children: [] })

  assert.equal(hasStudioNodes(TREE), true)
  assert.equal(hasStudioNodes([{ name: 'A', className: 'Folder', origin: 'repo', children: [] }]), false)
  assert.equal(hasStudioNodes(null), false)
})

test('DataModelSync: waits for the server, debounces, dedupes, clears, retries when dropped', async () => {
  const sent: { method: string; params?: any }[] = []
  const sync = new DataModelSync({ notify: (method, params) => sent.push({ method, params }), debounceMs: 5, retryMs: 5 })
  sync.setTree(TREE)
  await sleep(20)
  assert.equal(sent.length, 0, 'nothing before ready()')

  sync.ready()
  await sleep(20)
  assert.deepEqual(sent.map((m) => m.method), ['$/plugin/full'])
  assert.equal(sent[0].params.ClassName, 'DataModel')

  sync.setTree(structuredClone(TREE))
  sync.setTree(structuredClone(TREE))
  await sleep(20)
  assert.equal(sent.length, 1, 'same tree is not sent again')

  const changed = structuredClone(TREE)
  changed[1].children[0].children.push({ name: 'Spawn2', className: 'SpawnLocation', origin: 'studio', children: [] })
  sync.setTree(changed)
  sync.setTree(changed)
  await sleep(20)
  assert.equal(sent.length, 2, 'debounced to one update')

  // The server dropped it (workspace not set up yet): send again.
  sync.observe({ jsonrpc: '2.0', method: 'window/logMessage', params: { type: 2, message: 'unknown notification method: $/plugin/full' } })
  await sleep(20)
  assert.equal(sent.length, 3)
  assert.equal(sent[2].method, '$/plugin/full')

  // Snapshot gone (no Studio nodes left): clear once.
  sync.setTree([{ name: 'ReplicatedStorage', className: 'ReplicatedStorage', origin: 'repo', children: [] }])
  await sleep(20)
  sync.setTree(null)
  await sleep(20)
  assert.deepEqual(sent.slice(3).map((m) => m.method), ['$/plugin/clear'])

  // New server process: nothing sent until ready again; a repo-only tree sends nothing.
  sync.reset()
  sync.setTree(TREE)
  await sleep(20)
  assert.equal(sent.length, 4)
  sync.ready()
  await sleep(20)
  assert.equal(sent.length, 5)
  sync.dispose()
})

// Fake luau-lsp: asks for configuration after `initialized` (like LanguageServer::onInitialized)
// and echoes every notification back.
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
    if (m.method === 'initialize') { send({ jsonrpc: '2.0', id: m.id, result: { capabilities: {} } }); continue }
    if (m.method === 'initialized') send({ jsonrpc: '2.0', id: 'cfg-' + process.pid, method: 'workspace/configuration', params: { items: [{ section: 'luau-lsp' }] } })
    if (m.method) send({ jsonrpc: '2.0', method: 'echo', params: m })
  }
})
`

test('bridge sends the Studio DataModel after initialize + configuration + didOpen, and to restarted servers', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lsp-dm-'))
  dirs.push(root)
  const script = join(root, 'server.cjs')
  writeFileSync(script, FAKE_SERVER)
  const received: any[] = []
  const bridge = new LspBridge({
    spawn: (args) => spawn(process.execPath, [script, ...args], { cwd: root, stdio: ['pipe', 'pipe', 'pipe'] }),
    send: (m) => received.push(m),
    log: () => undefined,
    cacheDir: root,
    backoffMs: 20,
    version: async () => '1.70.1',
    types: { ensure: async () => ({ definitions: null, docs: null }) },
    dataModelDebounceMs: 5
  })
  const waitFor = async (pred: (m: any) => boolean, label: string) => {
    for (let i = 0; i < 300; i++) {
      const found = received.find(pred)
      if (found) return found
      await sleep(10)
    }
    throw new Error('timed out waiting for ' + label + '; got ' + JSON.stringify(received.map((m) => m.method ?? m.id)))
  }
  const plugin = (m: any) => m.method === 'echo' && m.params.method === '$/plugin/full'
  // What the renderer client does.
  const handshake = async () => {
    bridge.send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} })
    await waitFor((m) => m.id === 1, 'initialize result')
    bridge.send({ jsonrpc: '2.0', method: 'initialized', params: {} })
    const cfg = await waitFor((m) => m.method === 'workspace/configuration', 'configuration request')
    await sleep(30)
    assert.ok(!received.some(plugin), 'not before the configuration is answered and a file is open')
    bridge.send({ jsonrpc: '2.0', id: cfg.id, result: [{}] })
    bridge.send({ jsonrpc: '2.0', method: 'textDocument/didOpen', params: { textDocument: { uri: 'file:///x.luau', languageId: 'luau', version: 1, text: '' } } })
  }
  try {
    bridge.setDataModel(TREE as any)
    await bridge.setRoot(root)
    assert.equal(await bridge.start(), true)
    await handshake()
    const full = await waitFor(plugin, '$/plugin/full')
    assert.equal(full.params.params.ClassName, 'DataModel')
    assert.deepEqual(
      full.params.params.Children.find((c: any) => c.Name === 'Workspace').Children[0].Children.map((c: any) => c.Name),
      ['Spawn']
    )

    // Tree change -> update.
    received.length = 0
    const changed = structuredClone(TREE)
    changed[0].children[1].children.push({ name: 'Shield', className: 'Model', origin: 'studio', children: [] })
    bridge.setDataModel(changed as any)
    const update = await waitFor(plugin, 'update')
    assert.ok(JSON.stringify(update.params.params).includes('Shield'))

    // Crash -> restarted process gets the DataModel again after its handshake.
    received.length = 0
    bridge.send({ jsonrpc: '2.0', method: 'crash' })
    await waitFor((m) => m.method === 'harness/lspRestarted', 'restart')
    received.length = 0
    await handshake()
    const again = await waitFor(plugin, 'resend after restart')
    assert.ok(JSON.stringify(again.params.params).includes('Shield'))

    // Studio snapshot gone -> $/plugin/clear.
    received.length = 0
    bridge.setDataModel([{ name: 'ReplicatedStorage', className: 'ReplicatedStorage', origin: 'repo', children: [] }] as any)
    await waitFor((m) => m.method === 'echo' && m.params.method === '$/plugin/clear', '$/plugin/clear')
  } finally {
    await bridge.dispose()
  }
})

test('bridge without a server ignores DataModel updates', async () => {
  const bridge = new LspBridge({
    spawn: () => null,
    send: () => undefined,
    log: () => undefined,
    cacheDir: tmpdir(),
    types: { ensure: async () => ({ definitions: null, docs: null }) }
  })
  bridge.setDataModel(TREE as any)
  bridge.send({ jsonrpc: '2.0', method: 'initialized' })
  assert.equal(await bridge.start(), false)
  await bridge.dispose()
})
