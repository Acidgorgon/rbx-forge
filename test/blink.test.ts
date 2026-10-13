// Blink support: parser (all declaration kinds from the Blink 0.18.1 docs), generated-API usage,
// error-output parsing against real `blink` 0.18.1 output, and the temp-copy check.
// Set BLINK_BIN=/path/to/blink to also run the check against the real compiler.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  appendDeclaration,
  blinkUsage,
  BlinkWatcher,
  checkBlink,
  dataValues,
  formatDeclaration,
  instancePathFor,
  loadBlinkModel,
  parseBlink,
  parseBlinkErrors,
  tokenize
} from '../src/main/services/blink.ts'
import type { BlinkModel } from '../src/shared/types.ts'

const here = dirname(fileURLToPath(import.meta.url))
const fixtures = join(here, 'fixtures', 'blink')
const valid = join(fixtures, 'valid')
const errorFixture = (name: string) => readFile(join(fixtures, 'errors', name), 'utf8')

test('tokenizer skips line and block comments and splits ranges', () => {
  const toks = tokenize('--[[ a\nb ]] type X = u8(0..100) -- tail\n--[=[ x ]=]')
  const code = toks.filter((t) => t.kind !== 'comment').map((t) => t.text)
  assert.deepEqual(code, ['type', 'X', '=', 'u8', '(', '0', '..', '100', ')'])
  assert.equal(toks.find((t) => t.text === 'type')?.line, 2)
})

test('parses every declaration kind in the fixture', async () => {
  const { model, files, importLabels } = await loadBlinkModel(valid)
  assert.equal(model.file, 'events.blink')
  assert.equal(files.length, 3)
  assert.deepEqual(importLabels, { './shared/economy': 'shared/economy.blink', './shared/common': 'shared/common.blink' })

  // options
  assert.equal(model.options.ClientOutput, 'src/shared/events/client.luau')
  assert.equal(model.options.ServerOutput, 'src/server/events/server.luau')
  assert.equal(model.options.Casing, 'Pascal')
  assert.equal(model.options.WriteValidations, true)
  assert.deepEqual(model.outputs, { client: 'src/shared/events/client.luau', server: 'src/server/events/server.luau' })
  assert.deepEqual(model.requirePaths, {
    client: 'ReplicatedStorage.Shared.events.client',
    server: 'ServerScriptService.Server.events.server'
  })

  const byName = Object.fromEntries(model.events.map((e) => [[...e.scope, e.name].join('.'), e]))
  assert.deepEqual(Object.keys(byName).sort(), [
    'Combat.Hit', 'Combat.Inner.Deep', 'Combat.Parry', 'Common.Ping', 'GetInventory', 'Heartbeat', 'MouseInput', 'PlayerDamaged'
  ])
  assert.deepEqual(
    { ...byName.PlayerDamaged },
    { kind: 'event', name: 'PlayerDamaged', scope: [], file: 'events.blink', line: 55, column: 1, endLine: 60, from: 'Server', type: 'Reliable', call: 'ManyAsync', data: '(Instance(Player), Health)' }
  )
  assert.equal(byName.MouseInput.poll, true)
  assert.equal(byName.MouseInput.from, 'Client')
  assert.equal(byName.Heartbeat.call, 'Polling')
  assert.equal(byName.Heartbeat.data, undefined)
  assert.equal(byName.GetInventory.kind, 'function')
  assert.equal(byName.GetInventory.yield, 'Coroutine')
  assert.equal(byName.GetInventory.data, 'Common.PlayerId')
  assert.equal(byName.GetInventory.return, 'Inventory')
  assert.equal(byName['Combat.Hit'].data, 'struct { Target: Instance, Damage: Damage }')
  assert.equal(byName['Combat.Inner.Deep'].line, 91)
  assert.equal(byName['Combat.Inner.Deep'].column, 9)
  assert.equal(byName['Combat.Parry'].yield, 'Future')
  assert.equal(byName['Combat.Parry'].data, undefined)
  assert.equal(byName['Common.Ping'].file, 'shared/common.blink')

  const types = Object.fromEntries(model.types.map((t) => [[...t.scope, t.name].join('.'), t]))
  assert.equal(types.Health.kind, 'type')
  assert.equal(types.Health.definition, 'u8(0..100)')
  assert.equal(types.Username.definition, 'string(3..20)?')
  assert.equal(types.Inventory.kind, 'map')
  assert.deepEqual(types.Map.generics, ['K', 'V'])
  assert.equal(types.Scores.definition, 'Map<string, f64>')
  assert.equal(types.Flags.kind, 'set')
  assert.deepEqual(types.Flags.members, ['FeatureA', 'FeatureB'])
  assert.deepEqual(types.CharacterStatus.members, ['Idling', 'Walking', 'Running'])
  assert.equal(types.MouseEvent.tag, 'Type')
  assert.deepEqual(types.MouseEvent.members, ['Move', 'Click'])
  assert.deepEqual(types.Entity.members, ['Health', 'Position', 'Location', 'Owner', 'Nested'])
  assert.deepEqual(types.Fragment.generics, ['T'])
  assert.deepEqual(types.Merged.members, ['..Entity', 'Extra'])
  assert.equal(types.Snapshot.exported, true)
  assert.equal(types['Combat.Damage'].definition, 'u16')
  assert.equal(types['economy.Coins'].file, 'shared/economy.blink')
  assert.equal(types['Common.Vec2'].kind, 'struct')
})

test('parser tolerates broken and unknown syntax', () => {
  const parsed = parseBlink(`
option ClientOutput = "a"
mystery thing { x }
event Broken {
    From: Server,
    Type: Reliabl
event After {
    From: Client, Type: Unreliable, Call: SingleSync, Data: u8
}
`)
  assert.equal(parsed.options.ClientOutput, 'a')
  assert.ok(parsed.events.some((e) => e.name === 'Broken'))
  assert.ok(parsed.skipped.some((s) => s.text === 'mystery'))
  // Unknown values are not reported as known enums.
  const broken = parsed.events.find((e) => e.name === 'Broken')!
  assert.equal(broken.from, 'Server')
})

test('template events.blink (options only) parses', () => {
  const parsed = parseBlink('option ClientOutput = "src/shared/events/client.luau"\noption ServerOutput = "src/server/events/server.luau"')
  assert.equal(parsed.events.length, 0)
  assert.equal(parsed.options.ServerOutput, 'src/server/events/server.luau')
})

test('instance paths come from default.project.json', () => {
  const tree = { $className: 'DataModel', ReplicatedStorage: { Shared: { $path: 'src/shared' } }, ServerScriptService: { Server: { $path: 'src/server' } } }
  assert.deepEqual(instancePathFor(tree, 'src/shared/events/client.luau'), ['ReplicatedStorage', 'Shared', 'events', 'client'])
  assert.deepEqual(instancePathFor(tree, 'src/server/events/init.luau'), ['ServerScriptService', 'Server', 'events'])
  assert.equal(instancePathFor(tree, 'other/x.luau'), null)
})

test('type packs split at the top level only', () => {
  assert.deepEqual(dataValues('(Instance(Player), u8, struct { a: u8, b: u8 })'), ['Instance(Player)', 'u8', 'struct { a: u8, b: u8 }'])
  assert.deepEqual(dataValues('u8'), ['u8'])
  assert.deepEqual(dataValues(undefined), [])
})

test('usage follows the generated API (Fire/FireAll/On/Iter/Invoke) and Casing', async () => {
  const { model } = await loadBlinkModel(valid)
  const ev = (name: string) => model.events.find((e) => e.name === name)!
  const damaged = blinkUsage(ev('PlayerDamaged'), model)
  assert.match(damaged.server, /local ServerScriptService = game:GetService\("ServerScriptService"\)\nlocal Events = require\(ServerScriptService\.Server\.events\.server\)/)
  assert.match(damaged.server, /Events\.PlayerDamaged\.Fire\(player, otherPlayer, health\)/)
  assert.match(damaged.server, /Events\.PlayerDamaged\.FireAll\(otherPlayer, health\)/)
  assert.match(damaged.client, /require\(ReplicatedStorage\.Shared\.events\.client\)/)
  assert.match(damaged.client, /Events\.PlayerDamaged\.On\(function\(player, health\)/)

  const hit = blinkUsage(ev('Hit'), model)
  assert.match(hit.client, /Events\.Combat\.Hit\.Fire\(data\)/)
  assert.match(hit.server, /Events\.Combat\.Hit\.On\(function\(player, data\)/)

  assert.match(blinkUsage(ev('MouseInput'), model).server, /for index, player, mouseEvent in Events\.MouseInput\.Iter\(\) do/)
  assert.match(blinkUsage(ev('Heartbeat'), model).client, /for index in Events\.Heartbeat\.Iter\(\) do/)

  const inv = blinkUsage(ev('GetInventory'), model)
  assert.match(inv.client, /local inventory = Events\.GetInventory\.Invoke\(playerId\)/)
  assert.match(inv.server, /Events\.GetInventory\.On\(function\(player, playerId\)\n\treturn nil\nend\)/)
  assert.match(blinkUsage(ev('Parry'), model).client, /local future = Events\.Combat\.Parry\.Invoke\(\)\nlocal result = future:Await\(\)/)

  const snake = blinkUsage(ev('PlayerDamaged'), { ...model, options: { ...model.options, Casing: 'Snake' } })
  assert.match(snake.server, /\.fire_all\(/)
  const camel = blinkUsage(ev('GetInventory'), { options: { Casing: 'Camel' } })
  assert.match(camel.client, /require\(PATH_TO_BLINK_CLIENT\)/)
  assert.match(camel.client, /\.invoke\(/)
})

test('formats and appends declarations', () => {
  assert.equal(
    formatDeclaration({ name: 'CoinsChanged', from: 'Server', type: 'Reliable', call: 'ManyAsync', data: 'u32' }),
    'event CoinsChanged {\n    From: Server,\n    Type: Reliable,\n    Call: ManyAsync,\n    Data: u32\n}\n'
  )
  assert.equal(
    formatDeclaration({ kind: 'function', name: 'GetCoins', return: 'u32' }),
    'function GetCoins {\n    Yield: Coroutine,\n    Return: u32\n}\n'
  )
  assert.throws(() => formatDeclaration({ name: 'Bad Name' }))
  assert.throws(() => formatDeclaration({ name: 'X', call: 'Sometimes' as never }))

  const base = 'option ClientOutput = "c"\noption ServerOutput = "s"\n'
  const added = appendDeclaration(base, { name: 'Ping', from: 'Client', type: 'Unreliable', call: 'SingleSync' })
  assert.equal(added, base + '\nevent Ping {\n    From: Client,\n    Type: Unreliable,\n    Call: SingleSync\n}\n')
  assert.throws(() => appendDeclaration(added, { name: 'Ping' }), /already declared/)

  const scoped = appendDeclaration('scope Combat {\n    type Damage = u16\n}\n', { name: 'Hit', scope: 'Combat', data: 'Damage' })
  assert.equal(scoped, 'scope Combat {\n    type Damage = u16\n\n    event Hit {\n        From: Server,\n        Type: Reliable,\n        Call: ManyAsync,\n        Data: Damage\n    }\n}\n')
  assert.deepEqual(parseBlink(scoped).events.map((e) => [...e.scope, e.name].join('.')), ['Combat.Hit'])
  const newScope = appendDeclaration(base, { name: 'Deep', scope: 'Combat' })
  assert.match(newScope, /scope Combat \{\n    event Deep \{\n        From: Server,/)
})

// ---------------------------------------------------------------- errors (real blink 0.18.1 output)

const ctx = { entry: 'events.blink' }

test('parses a full Blink error report (single line span)', async () => {
  const out = await errorFixture('unknown-option.stderr.txt')
  const [d, ...rest] = parseBlinkErrors(out, { entry: 'bad.blink' })
  assert.equal(rest.length, 0)
  assert.deepEqual(d, {
    file: 'bad.blink',
    line: 5,
    column: 11,
    endColumn: 18,
    message: 'Unknown option "Reliabl"',
    detail: 'Expected one of "Reliable" or "Unreliable"',
    code: 'E2003',
    severity: 'error'
  })
})

test('maps the entry label to the repo path and keeps column', async () => {
  const [d] = parseBlinkErrors(await errorFixture('unknown-reference.stderr.txt'), { entry: 'game/bad2.blink' })
  assert.equal(d.file, 'game/bad2.blink')
  assert.equal(d.line, 4)
  assert.equal(d.column, 8)
  assert.equal(d.code, 'E3007')
  assert.equal(d.message, 'Unknown reference')
  assert.equal(d.detail, undefined)
})

test('maps errors inside imports to the imported file', async () => {
  const [d] = parseBlinkErrors(await errorFixture('import-duplicate-field.stderr.txt'), {
    entry: 'bad4.blink',
    importLabels: { './sub/inner': 'sub/inner.blink' }
  })
  assert.equal(d.file, 'sub/inner.blink')
  assert.equal(d.line, 3)
  assert.equal(d.column, 3)
  assert.equal(d.message, 'Duplicate field "a"')
})

test('multi-line spans report the first line and an end line', async () => {
  const [d] = parseBlinkErrors(await errorFixture('missing-field.stderr.txt'), { entry: 'missing.blink' })
  assert.equal(d.line, 3)
  assert.equal(d.endLine, 5)
  assert.equal(d.message, 'Field "Call" is missing')
  assert.equal(d.detail, 'Add missing field "Call"')
})

test('primary (red) label wins over secondary labels', async () => {
  const [d] = parseBlinkErrors(await errorFixture('duplicate-declaration.stderr.txt'), { entry: 'dup.blink' })
  assert.equal(d.line, 4)
  assert.equal(d.detail, 'Duplicate declared here')
  assert.deepEqual(d.related, [{ file: 'dup.blink', line: 3, column: 6, message: 'Previously declared here' }])
})

test('lexer errors labelled input.blink go to the entry file', async () => {
  const [d] = parseBlinkErrors(await errorFixture('lexer.stderr.txt'), ctx)
  assert.equal(d.file, 'events.blink')
  assert.equal(d.line, 3)
  assert.equal(d.column, 13)
  assert.equal(d.code, 'E1001')
})

test('compact error form', async () => {
  const [d] = parseBlinkErrors(await errorFixture('unknown-option.compact.txt'), { entry: 'bad.blink' })
  assert.equal(d.line, 5)
  assert.equal(d.code, 'E2003')
  assert.equal(d.message, 'Unknown option "Reliabl"')
})

test('uncaught generator errors attach to line 1', async () => {
  const [d] = parseBlinkErrors(await errorFixture('generator-error.stderr.txt'), ctx)
  assert.deepEqual(d, { file: 'events.blink', line: 1, column: 1, message: 'Cannot use yield type: "Future", without providing a path to the future library.', severity: 'error' })
  const [e] = parseBlinkErrors(await errorFixture('no-client-output.stderr.txt'), ctx)
  assert.equal(e.message, 'A client output path must be defined.')
})

// ---------------------------------------------------------------- check

async function tempProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'forge-blink-test-'))
  await cp(valid, dir, { recursive: true })
  return dir
}

test('check compiles a temp copy with rewritten outputs and leaves the project untouched', async () => {
  const root = await tempProject()
  try {
    let seen: { args: string[]; cwd: string; copy: string } | null = null
    const runner = async (_file: string, args: string[], cwd: string) => {
      seen = { args, cwd, copy: await readFile(args[0], 'utf8') }
      // The import must be mirrored next to the copy.
      assert.ok(existsSync(join(dirname(args[0]), 'shared', 'common.blink')))
      return { code: 1, stdout: '\x1b[32mBlink\x1b[0m 0.18.1\n', stderr: (await errorFixture('unknown-option.stderr.txt')).replace('[bad.blink:', '[events.blink:') }
    }
    const result = await checkBlink(root, { binary: '/fake/blink', runner })
    assert.ok(seen)
    const s = seen as { args: string[]; cwd: string; copy: string }
    assert.equal(s.cwd, root)
    assert.ok(s.args.includes('--yes'))
    assert.doesNotMatch(s.copy, /src\/shared\/events\/client\.luau/)
    assert.match(s.copy, /^option ClientOutput = ".*forge-blink-.*\/out\/ClientOutput"$/m)
    // Same number of lines: positions still match the real file.
    assert.equal(s.copy.split('\n').length, (await readFile(join(root, 'events.blink'), 'utf8')).split('\n').length)
    assert.equal(result.ok, false)
    assert.equal(result.version, '0.18.1')
    assert.equal(result.diagnostics[0].file, 'events.blink')
    assert.equal(result.diagnostics[0].line, 5)
    assert.deepEqual(await readdir(join(root)), (await readdir(valid)))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('check is skipped without a blink binary or an events.blink', async () => {
  assert.equal((await checkBlink(valid, { binary: null })).skipped, 'blink not found. Run rokit install.')
  const empty = await mkdtemp(join(tmpdir(), 'forge-blink-empty-'))
  try {
    assert.equal((await checkBlink(empty, { binary: '/fake/blink' })).skipped, 'No events.blink')
    assert.equal((await loadBlinkModel(empty)).model.file, null)
  } finally {
    await rm(empty, { recursive: true, force: true })
  }
})

test('watcher publishes the parse, then diagnostics, and logs them once', async () => {
  const root = await tempProject()
  const models: BlinkModel[] = []
  const lines: string[] = []
  const watcher = new BlinkWatcher({
    root,
    debounceMs: 20,
    log: (l) => lines.push(l.text),
    onChange: (m) => models.push(m),
    check: async () => ({ ok: false, diagnostics: [{ file: 'events.blink', line: 5, column: 11, message: 'Unknown option "Reliabl"', code: 'E2003', severity: 'error' }] })
  })
  try {
    await watcher.start()
    assert.equal(models[0].checking, true)
    assert.equal(models.at(-1)!.checking, false)
    assert.equal(models.at(-1)!.diagnostics.length, 1)
    assert.equal(models.at(-1)!.events.length, 8)
    await watcher.refresh()
    assert.deepEqual(lines, ['[blink] events.blink:5:11: E2003 Unknown option "Reliabl"'])
    // A change on disk triggers a debounced refresh.
    const before = models.length
    await writeFile(join(root, 'events.blink'), (await readFile(join(root, 'events.blink'), 'utf8')) + '\nevent Extra {\n    From: Server,\n    Type: Reliable,\n    Call: ManyAsync\n}\n')
    for (let k = 0; k < 100 && !(models.length > before && models.at(-1)!.events.length === 9 && !models.at(-1)!.checking); k++) {
      await new Promise((r) => setTimeout(r, 20))
    }
    assert.equal(models.at(-1)!.events.length, 9)
  } finally {
    watcher.close()
    await rm(root, { recursive: true, force: true })
  }
})

const realBlink = process.env.BLINK_BIN
test('real blink: fixture compiles, broken copy reports a positioned error', { skip: !realBlink && 'set BLINK_BIN to run' }, async () => {
  const root = await tempProject()
  try {
    const ok = await checkBlink(root, { binary: realBlink! })
    assert.deepEqual(ok.diagnostics, [])
    assert.equal(ok.ok, true)
    assert.ok(!existsSync(join(root, 'src')), 'no output written into the project')
    const source = await readFile(join(root, 'events.blink'), 'utf8')
    await writeFile(join(root, 'events.blink'), source.replace('Type: Reliable,\n    Call: ManyAsync', 'Type: Reliabl,\n    Call: ManyAsync'))
    const bad = await checkBlink(root, { binary: realBlink! })
    assert.equal(bad.ok, false)
    assert.equal(bad.diagnostics[0].file, 'events.blink')
    assert.equal(bad.diagnostics[0].line, 57)
    assert.equal(bad.diagnostics[0].column, 11)
    assert.equal(bad.diagnostics[0].code, 'E2003')
    // Error inside an import
    await writeFile(join(root, 'events.blink'), source)
    await writeFile(join(root, 'shared', 'common.blink'), 'struct Vec2 {\n    X: f32,\n    X: f32\n}\n')
    const imp = await checkBlink(root, { binary: realBlink! })
    assert.equal(imp.diagnostics[0].file, 'shared/common.blink')
    assert.equal(imp.diagnostics[0].line, 3)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
