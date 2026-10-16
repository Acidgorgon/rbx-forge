// Headless Luau tests: the runner's JSON-line protocol, Rojo-mapped spec discovery, watch impact,
// spec scaffolding and the compact agent output. No lune binary needed (see lune.e2e.test.ts).
import assert from 'node:assert/strict'
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import {
  affectedSpecs,
  buildSourcemap,
  createSpec,
  discoverSpecs,
  EventStream,
  fileInstance,
  findLune,
  findRuntimeDir,
  formatCompact,
  INSTALL_HINT,
  instanceExpression,
  instancePathOf,
  moduleShape,
  parseEventLine,
  parseLuneVersion,
  ResultCollector,
  runTestsRequest,
  scriptFiles,
  specPathFor,
  TestService,
  type RunSummary
} from '../src/main/services/tests/index.ts'
import { write } from './fixture.ts'
import { luneHint } from '../src/main/services/tests/lune.ts'

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'lune-project')
const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function copyFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-lune-'))
  cpSync(FIXTURE, root, { recursive: true })
  roots.push(root)
  return root
}

test('parses runner events and ignores everything else', () => {
  const pass = parseEventLine('{"forge":1,"type":"test","file":"a.spec.luau","suite":"A","test":"t","status":"pass","ms":1.5}')
  assert.deepEqual(pass, { type: 'test', file: 'a.spec.luau', suite: 'A', test: 't', status: 'pass', ms: 1.5 })
  const failed = parseEventLine(
    '{"forge":1,"type":"test","file":"a.spec.luau","suite":"","test":"t","status":"fail","ms":0,"error":{"message":"boom","line":7,"stack":"a.spec.luau:7"}}'
  )
  assert.equal(failed?.type, 'test')
  assert.deepEqual(failed && 'error' in failed ? failed.error : null, { message: 'boom', line: 7, stack: 'a.spec.luau:7' })
  assert.equal(parseEventLine('hello {"forge":1}'), null)
  assert.equal(parseEventLine('{"forge":2,"type":"end"}'), null, 'other protocol versions are ignored')
  assert.equal(parseEventLine('{"type":"end"}'), null, 'JSON a module printed is not an event')
  assert.equal(parseEventLine('{"forge":1,"type":"test","file":"x","test":"t","status":"weird"}'), null)
  assert.equal(parseEventLine('{not json'), null)
  assert.deepEqual(parseEventLine('{"forge":1,"type":"end","passed":2,"failed":1,"skipped":0,"files":1,"ms":3}'), {
    type: 'end', passed: 2, failed: 1, skipped: 0, files: 1, ms: 3
  })
})

test('the event stream joins split chunks and CRLF lines', () => {
  const stream = new EventStream()
  const collector = new ResultCollector()
  const lines = [
    '{"forge":1,"type":"start","files":["a.spec.luau"]}',
    'stray print',
    '{"forge":1,"type":"test","file":"a.spec.luau","suite":"S","test":"ok","status":"pass","ms":1}',
    '{"forge":1,"type":"test","file":"a.spec.luau","suite":"S","test":"bad","status":"fail","ms":2,"error":{"message":"nope"}}',
    '{"forge":1,"type":"log","file":"a.spec.luau","test":"S > ok","level":"warn","text":"w"}',
    '{"forge":1,"type":"end","passed":1,"failed":1,"skipped":0,"files":1,"ms":4}'
  ].join('\r\n')
  for (let i = 0; i < lines.length; i += 7) for (const item of stream.push(lines.slice(i, i + 7))) collector.add(item)
  for (const item of stream.flush()) collector.add(item)
  assert.deepEqual(collector.files, ['a.spec.luau'])
  assert.deepEqual(collector.counts(), { passed: 1, failed: 1, skipped: 0, total: 2 })
  assert.deepEqual(collector.logs, [
    { level: 'output', text: 'stray print' },
    { file: 'a.spec.luau', test: 'S > ok', level: 'warn', text: 'w' }
  ])
  assert.equal(collector.ended?.ms, 4)
})

test('maps files the way Rojo names instances', () => {
  assert.deepEqual(fileInstance('Foo.server.luau'), { name: 'Foo', className: 'Script' })
  assert.deepEqual(fileInstance('Foo.client.lua'), { name: 'Foo', className: 'LocalScript' })
  assert.deepEqual(fileInstance('Foo.spec.luau'), { name: 'Foo.spec', className: 'ModuleScript' })
  assert.deepEqual(fileInstance('Data.json'), { name: 'Data', className: 'ModuleScript' })
  assert.equal(fileInstance('init.meta.json'), null)
  assert.equal(fileInstance('Thing.model.json'), null)
})

test('discovers specs through default.project.json, including tests/ and client realms', async () => {
  const root = copyFixture()
  const tree = await buildSourcemap(root)
  const specs = discoverSpecs(tree)
  assert.deepEqual(
    specs.map((s) => [s.file, s.instancePath.join('.'), s.realm]),
    [
      ['src/client/Client/Controllers/HudController.spec.luau', 'StarterPlayer.StarterPlayerScripts.Client.Client.Controllers.HudController.spec', 'client'],
      ['src/server/Features/Shop/ShopService.spec.luau', 'ServerScriptService.Server.Features.Shop.ShopService.spec', 'server'],
      ['src/shared/Modules/MathUtil.spec.luau', 'ReplicatedStorage.Shared.Modules.MathUtil.spec', 'server'],
      ['tests/World.spec.luau', 'ForgeTests.World.spec', 'server']
    ]
  )
  assert.deepEqual(instancePathOf(tree, 'src/shared/Modules/MathUtil.luau'), {
    path: ['ReplicatedStorage', 'Shared', 'Modules', 'MathUtil'],
    className: 'ModuleScript'
  })
})

test('maps init files, nested Wally projects and skips package specs', async () => {
  const root = copyFixture()
  write(root, 'src/shared/Features/Inventory/init.luau', 'return {}\n')
  write(root, 'src/shared/Features/Inventory/Inventory.spec.luau', 'return nil\n')
  write(root, 'Packages/Janitor.lua', 'return require(script.Parent._Index["howmanysmall_janitor@1.18.3"]["janitor"])\n')
  write(root, 'Packages/_Index/howmanysmall_janitor@1.18.3/janitor/default.project.json', JSON.stringify({ name: 'janitor', tree: { $path: 'src' } }))
  write(root, 'Packages/_Index/howmanysmall_janitor@1.18.3/janitor/src/init.lua', 'return {}\n')
  write(root, 'Packages/_Index/howmanysmall_janitor@1.18.3/janitor/src/Janitor.spec.lua', 'return nil\n')
  const tree = await buildSourcemap(root)
  assert.deepEqual(instancePathOf(tree, 'src/shared/Features/Inventory/init.luau')?.path, ['ReplicatedStorage', 'Shared', 'Features', 'Inventory'])
  assert.deepEqual(instancePathOf(tree, 'Packages/_Index/howmanysmall_janitor@1.18.3/janitor/src/init.lua'), {
    path: ['ReplicatedStorage', 'Packages', '_Index', 'howmanysmall_janitor@1.18.3', 'janitor'],
    className: 'ModuleScript'
  })
  const files = discoverSpecs(tree).map((s) => s.file)
  assert.ok(files.includes('src/shared/Features/Inventory/Inventory.spec.luau'))
  assert.ok(!files.some((f) => f.startsWith('Packages/')))
})

test('watch reruns the changed spec, the module spec and specs that mention the module', async () => {
  const root = copyFixture()
  const tree = await buildSourcemap(root)
  const specs = discoverSpecs(tree)
  const sources = new Map(specs.map((s) => [s.file, readFileSync(join(root, s.file), 'utf8')]))
  const names = scriptFiles(tree)
  assert.deepEqual(affectedSpecs(['src/server/Features/Shop/Prices.luau'], specs, names, sources), [])
  assert.deepEqual(affectedSpecs(['src/shared/Modules/MathUtil.luau'], specs, names, sources), [
    'src/shared/Modules/MathUtil.spec.luau',
    'tests/World.spec.luau'
  ])
  assert.deepEqual(affectedSpecs(['src/server/Features/Shop/ShopService.luau'], specs, names, sources), [
    'src/server/Features/Shop/ShopService.spec.luau'
  ])
  assert.deepEqual(affectedSpecs(['tests/World.spec.luau'], specs, names, sources), ['tests/World.spec.luau'])
  assert.equal(affectedSpecs(['Packages/Janitor.lua'], specs, names, sources).length, specs.length)
})

test('spec paths, require expressions and module shape', () => {
  assert.equal(specPathFor('src/shared/Modules/X.luau'), 'src/shared/Modules/X.spec.luau')
  assert.equal(specPathFor('src/shared/Features/Inventory/init.luau'), 'src/shared/Features/Inventory/Inventory.spec.luau')
  assert.equal(instanceExpression(['ReplicatedStorage', 'Shared', 'My Thing']), 'ReplicatedStorage.Shared["My Thing"]')
  assert.deepEqual(
    moduleShape('local M = {}\nfunction M:Init(j) end\nfunction M.add(a, b) end\nfunction M._private() end\nfunction M:Start() end\nreturn M\n'),
    { tableName: 'M', functions: ['add'], hasInit: true, hasStart: true }
  )
})

test('createSpec writes a new spec once and refuses scripts', async () => {
  const root = copyFixture()
  write(root, 'src/shared/Modules/Inventory.luau', 'local Inventory = {}\nfunction Inventory:Init(janitor) end\nfunction Inventory.add(item) end\nreturn Inventory\n')
  const first = await createSpec(root, 'src/shared/Modules/Inventory.luau')
  assert.equal(first.created, true)
  assert.equal(first.path, 'src/shared/Modules/Inventory.spec.luau')
  assert.equal(first.requirePath, 'ReplicatedStorage.Shared.Modules.Inventory')
  assert.match(first.content, /local ReplicatedStorage = game:GetService\("ReplicatedStorage"\)/)
  assert.match(first.content, /local Inventory = require\(ReplicatedStorage\.Shared\.Modules\.Inventory\)/)
  assert.match(first.content, /Inventory:Init\(janitor\)/)
  assert.match(first.content, /it\.todo\("add"\)/)
  assert.ok(existsSync(join(root, first.path)))
  const second = await createSpec(root, 'src/shared/Modules/Inventory.luau')
  assert.equal(second.created, false)
  const existing = await createSpec(root, 'src/shared/Modules/MathUtil.luau')
  assert.equal(existing.created, false, 'an existing spec is never overwritten')
  write(root, 'src/server/Boot.server.luau', 'print(1)\n')
  await assert.rejects(createSpec(root, 'src/server/Boot.server.luau'), /Script\/LocalScript/)
  await assert.rejects(createSpec(root, '../outside.luau'), /outside the project/)
  await assert.rejects(createSpec(root, 'src/shared/Modules/MathUtil.spec.luau'), /already a spec/)
})

function summary(partial: Partial<RunSummary>): RunSummary {
  return { id: 1, state: 'passed', passed: 0, failed: 0, skipped: 0, total: 0, ms: 12, files: ['a.spec.luau'], results: [], logs: [], ...partial }
}

test('compact output lists failures with their first error lines only', () => {
  const failing = summary({
    state: 'failed',
    passed: 3,
    failed: 2,
    skipped: 1,
    results: [
      { file: 'a.spec.luau', suite: 'A', test: 'ok', status: 'pass', ms: 1 },
      { file: 'a.spec.luau', suite: 'A', test: 'bad', status: 'fail', ms: 1, error: { message: 'expected 1 to be 2\nline two\nline three', line: 9, stack: 'a.spec.luau:9' } },
      { file: 'b.spec.luau', suite: '', test: '(load)', status: 'fail', ms: 0, error: { message: 'could not load spec' } }
    ]
  })
  assert.equal(
    formatCompact(failing),
    'FAIL 2 failed, 3 passed, 1 skipped (1 file, 12 ms)\nx a.spec.luau:9 A > bad: expected 1 to be 2\n  line two\nx b.spec.luau (load): could not load spec'
  )
  assert.equal(formatCompact(summary({ passed: 4 })), 'PASS 4 passed (1 file, 12 ms)')
  assert.equal(formatCompact(summary({ state: 'no-lune', message: INSTALL_HINT })), INSTALL_HINT)
  assert.match(INSTALL_HINT, /rokit add lune-org\/lune/)
  assert.deepEqual(runTestsRequest({}), { scope: { kind: 'all' }, testTimeoutMs: undefined })
  assert.deepEqual(runTestsRequest({ file: 'x.luau', name: 'A > b' }).scope, { kind: 'name', name: 'A > b', file: 'x.luau' })
})

test('finds lune in rokit bin and reports how to install it when missing', async () => {
  const home = '/home/me'
  const ctx = (files: string[]) => ({
    platform: 'linux' as const,
    env: { PATH: '/usr/bin' },
    home,
    isExecutable: (file: string) => files.includes(file),
    listDir: () => []
  })
  assert.equal(findLune(null, ctx(['/home/me/.rokit/bin/lune', '/usr/bin/lune'])), '/home/me/.rokit/bin/lune')
  assert.equal(findLune('/opt/lune', ctx(['/opt/lune'])), '/opt/lune')
  assert.equal(findLune(null, ctx([])), null)
  assert.equal(parseLuneVersion('lune 0.11.0\n'), '0.11.0')
  assert.ok(findRuntimeDir(), 'resources/lune/runner.luau is found from the source tree')

  const root = copyFixture()
  const events: string[] = []
  const service = new TestService({ lunePath: () => '/nonexistent/lune', onProgress: (e) => events.push(e.kind) })
  const savedPath = process.env.PATH
  const savedHome = process.env.HOME
  process.env.PATH = '/nonexistent'
  process.env.HOME = root
  try {
    service.setRoot(root)
    const result = await service.run()
    if (result.state === 'no-lune') {
      assert.match(result.message ?? '', /rokit add lune-org\/lune/)
      assert.deepEqual(events, ['end'])
    }
  } finally {
    process.env.PATH = savedPath
    process.env.HOME = savedHome
  }
})

test('the no-Lune hint says what to run for this project', () => {
  const pinned = mkdtempSync(join(tmpdir(), 'forge-lune-hint-'))
  const unpinned = mkdtempSync(join(tmpdir(), 'forge-lune-hint-'))
  try {
    write(pinned, 'rokit.toml', '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\nlune = "lune-org/lune@0.11.0"\n')
    write(unpinned, 'rokit.toml', '[tools]\nrojo = "rojo-rbx/rojo@7.7.0"\n')
    const a = luneHint(pinned)
    assert.match(a, /run `rokit install` in the project folder/)
    assert.doesNotMatch(a, /rokit add/)
    const b = luneHint(unpinned)
    assert.match(b, /`rokit add lune-org\/lune`.*then run `rokit install`/)
    for (const h of [a, b, luneHint(null), INSTALL_HINT]) assert.match(h, /Lune path in Settings > Toolchain/)
    assert.equal(luneHint(null), INSTALL_HINT)
  } finally {
    rmSync(pinned, { recursive: true, force: true })
    rmSync(unpinned, { recursive: true, force: true })
  }
})
