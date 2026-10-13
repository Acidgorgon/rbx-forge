// End to end with the real lune binary: TestService -> lune run resources/lune/runner.luau against the
// fixture project (test/fixtures/lune-project). Uses $LUNE_PATH, else lune on the rokit/PATH lookup;
// skips with a message when neither exists. Install: `rokit add --global lune-org/lune`.
import assert from 'node:assert/strict'
import { cpSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { after, test } from 'node:test'
import { findLune, TestService, type TestProgress } from '../src/main/services/tests/index.ts'
import { write } from './fixture.ts'

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'lune-project')
const lune = findLune(process.env.LUNE_PATH || null)
const skip = lune ? false : 'lune not found (set LUNE_PATH or `rokit add --global lune-org/lune`); skipping Lune end-to-end tests'
if (!lune) console.log(`# ${skip}`)

const roots: string[] = []
after(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'forge-lune-e2e-'))
  cpSync(FIXTURE, root, { recursive: true })
  roots.push(root)
  return root
}

function service(root: string, progress: TestProgress[] = []): TestService {
  const s = new TestService({ lunePath: () => lune, onProgress: (e) => progress.push(e) })
  s.setRoot(root)
  return s
}

test('runs every sample spec and streams progress', { skip }, async () => {
  const progress: TestProgress[] = []
  const tests = service(project(), progress)
  const status = await tests.status()
  assert.equal(status.available, true)
  const result = await tests.run()
  assert.equal(result.state, 'passed', JSON.stringify(result.results.filter((r) => r.status === 'fail'), null, 2))
  assert.equal(result.failed, 0)
  assert.equal(result.passed, 11)
  assert.equal(result.skipped, 1, 'the it.todo')
  assert.equal(result.files.length, 4)
  const kinds = new Set(progress.map((e) => e.kind))
  for (const kind of ['start', 'file', 'test', 'end']) assert.ok(kinds.has(kind as TestProgress['kind']), kind)
  const client = progress.find((e) => e.kind === 'file' && e.file.includes('HudController'))
  assert.equal(client && client.kind === 'file' ? client.realm : null, 'client')
})

test('runs one file (by its module path) and one test by name', { skip }, async () => {
  const tests = service(project())
  const file = await tests.run({ scope: { kind: 'file', file: 'src/shared/Modules/MathUtil.luau' } })
  assert.equal(file.state, 'passed')
  assert.deepEqual(file.files, ['src/shared/Modules/MathUtil.spec.luau'])
  assert.equal(file.passed, 4)
  const one = await tests.run({ scope: { kind: 'name', name: 'MathUtil > clamp > clamps below and above' } })
  assert.equal(one.state, 'passed')
  assert.deepEqual(one.results.map((r) => `${r.suite} > ${r.test}`), ['MathUtil > clamp > clamps below and above'])
})

test('reports failures with spec lines, load errors and per-test timeouts', { skip }, async () => {
  const root = project()
  write(root, 'src/shared/Modules/Broken.luau', 'local Broken = {}\nfunction Broken.explode()\n\tlocal t = nil\n\treturn t.field\nend\nreturn Broken\n')
  write(
    root,
    'src/shared/Modules/Broken.spec.luau',
    [
      'local Broken = require(script.Parent.Broken)',
      'describe("Broken", function()',
      '\tit("fails an expectation", function()',
      '\t\texpect({ a = 1 }):toEqual({ a = 2 })',
      '\tend)',
      '\tit("errors in the module", function()',
      '\t\tBroken.explode()',
      '\tend)',
      '\tit("hangs", function()',
      '\t\ttask.wait(5)',
      '\tend)',
      '\tit("logs", function()',
      '\t\tprint("hello", 42)',
      '\tend)',
      'end)',
      ''
    ].join('\n')
  )
  write(root, 'tests/Syntax.spec.luau', 'describe("x", function(\n')
  const tests = service(root)
  const result = await tests.run({ scope: { kind: 'all' }, testTimeoutMs: 300 })
  assert.equal(result.state, 'failed')
  const byName = new Map(result.results.map((r) => [r.test, r]))
  const expectation = byName.get('fails an expectation')
  assert.equal(expectation?.error?.line, 4)
  assert.match(expectation?.error?.message ?? '', /at \.a: got 1, wanted 2/)
  const moduleError = byName.get('errors in the module')
  assert.equal(moduleError?.error?.line, 7)
  assert.match(moduleError?.error?.message ?? '', /Broken\.luau:4: attempt to index nil/)
  assert.match(byName.get('hangs')?.error?.message ?? '', /timed out after 300 ms/)
  const load = result.results.find((r) => r.file === 'tests/Syntax.spec.luau')
  assert.equal(load?.test, '(load)')
  assert.match(load?.error?.message ?? '', /could not load spec: .*Syntax\.spec\.luau:2/)
  assert.ok(!/stack traceback/.test(load?.error?.message ?? ''))
  assert.deepEqual(
    result.logs.filter((l) => l.level === 'print').map((l) => [l.test, l.text]),
    [['Broken > logs', 'hello 42']]
  )
  assert.equal(result.passed, 11 + 1)
})

test('a scaffolded spec runs green', { skip }, async () => {
  const root = project()
  write(root, 'src/shared/Modules/Inventory.luau', [
    'local Players = game:GetService("Players")',
    'local Inventory = {}',
    'Inventory.Items = {}',
    'function Inventory:Init(janitor)',
    '\tjanitor:Add(Players.PlayerAdded:Connect(function(player)',
    '\t\tself.Items[player.UserId] = {}',
    '\tend))',
    'end',
    'function Inventory.count(list)',
    '\treturn #list',
    'end',
    'return Inventory',
    ''
  ].join('\n'))
  const tests = service(root)
  const created = await tests.createSpec('src/shared/Modules/Inventory.luau')
  assert.equal(created.created, true)
  const result = await tests.run({ scope: { kind: 'file', file: created.path } })
  assert.equal(result.state, 'passed', JSON.stringify(result.results, null, 2))
  assert.deepEqual(result.results.map((r) => [r.test, r.status]), [
    ['loads', 'pass'],
    ['initializes with a janitor', 'pass'],
    ['count', 'todo']
  ])
})

test('cancels a run and stops a run that never yields', { skip }, async () => {
  const root = project()
  write(root, 'tests/Spin.spec.luau', 'it("spins", function()\n\twhile true do end\nend)\n')
  const tests = service(root)
  const pending = tests.run({ scope: { kind: 'file', file: 'tests/Spin.spec.luau' } })
  await new Promise((r) => setTimeout(r, 300))
  assert.equal(tests.running(), true)
  assert.equal(tests.cancel(), true)
  assert.equal((await pending).state, 'cancelled')
  const stopped = await tests.run({ scope: { kind: 'file', file: 'tests/Spin.spec.luau' }, timeoutMs: 800 })
  assert.equal(stopped.state, 'timeout')
})

test('watch mode reruns the specs a save affects', { skip }, async () => {
  const root = project()
  const tests = service(root)
  const done = new Promise<string[]>((resolveRun) => tests.startWatch((summary) => resolveRun(summary.files)))
  await new Promise((r) => setTimeout(r, 200))
  writeFileSync(join(root, 'src/server/Features/Shop/ShopService.luau'), `${'-- touched\n'}${await import('node:fs').then((fs) => fs.readFileSync(join(FIXTURE, 'src/server/Features/Shop/ShopService.luau'), 'utf8'))}`)
  const files = await Promise.race([done, new Promise<string[]>((_, reject) => setTimeout(() => reject(new Error('watch did not rerun')), 10_000))])
  tests.stopWatch()
  assert.deepEqual(files, ['src/server/Features/Shop/ShopService.spec.luau'])
})
