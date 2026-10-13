// Code search and symbol lookup (budget/searchCode.ts, budget/tools.ts) on the GenTree fixture.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blinkOutputs, buildMatcher, findSymbol, realmFromPath, searchCode } from '../src/main/agent/budget/searchCode.ts'
import { ProjectMap } from '../src/main/agent/budget/projectMap.ts'
import { budgetTools } from '../src/main/agent/budget/tools.ts'
import { fixtureFs, fixtureScripts } from './tokensFixture.ts'

const SVC = 'src/server/Features/Inventory/InventoryService.luau'

test('literal, case-insensitive by default, with one line of context', async () => {
  const r = await searchCode(fixtureFs(), { query: 'additem' })
  assert.equal(r.matches, 1)
  assert.equal(r.truncated, false)
  assert.equal(
    r.text,
    [`${SVC}-23- `, `${SVC}:24: function InventoryService.AddItem(player: Player, item: string, count: number)`, `${SVC}-25-   local slots = slotsFor(player)`].join('\n')
  )
})

test('Packages/ and Blink outputs are skipped unless asked', async () => {
  const fs = fixtureFs()
  const plain = await searchCode(fs, { query: 'BASE_EVENT_NAME', context: 0 })
  assert.equal(plain.text, '(no matches)')
  const all = await searchCode(fs, { query: 'BASE_EVENT_NAME', context: 0, includeIgnored: true })
  assert.equal(all.matches, 2)
  const pkgs = await searchCode(fs, { query: 'AddItem', path: 'Packages/Janitor', includeIgnored: true, context: 0 })
  assert.match(pkgs.text, /^Packages\/Janitor\/init\.luau:\d+: /m)
  assert.ok(!(await searchCode(fs, { query: 'Janitor:AddItem', context: 0 })).text.includes('Packages/'))
})

test('blinkOutputs reads events.blink options', async () => {
  const out = await blinkOutputs(fixtureFs())
  assert.deepEqual([...out].sort(), ['src/server/events/server.luau', 'src/shared/events/client.luau'])
})

test('maxResults stops early and says so', async () => {
  const r = await searchCode(fixtureFs(), { query: 'local', context: 0, maxResults: 3 })
  assert.equal(r.matches, 3)
  assert.equal(r.truncated, true)
  assert.match(r.text, /stopped at 3 matches/)
  assert.equal(r.text.split('\n').length, 4)
})

test('stops reading files once the limit is reached', async () => {
  const fs = fixtureFs()
  await searchCode(fs, { query: 'local', context: 0, maxResults: 1 })
  const reads = fs.reads.filter((p) => p !== 'events.blink')
  assert.ok(reads.length <= 2, `read ${reads.length} files`)
})

test('maxTokens caps the output', async () => {
  const r = await searchCode(fixtureFs(), { query: 'e', context: 2, maxResults: 500, maxTokens: 150 })
  assert.equal(r.truncated, true)
  assert.ok(r.text.length < 150 * 6)
})

test('realm and path filters', async () => {
  const fs = fixtureFs()
  const client = await searchCode(fs, { query: 'require', realm: 'client', context: 0 })
  assert.ok(client.matches >= 2)
  assert.ok(client.text.split('\n').every((l) => l.startsWith('src/client/')))
  const one = await searchCode(fs, { query: 'require', path: SVC, context: 0 })
  assert.ok(one.text.split('\n').every((l) => l.startsWith(SVC)))
  assert.equal(realmFromPath('src/ServerStorage/Assets/Loot.luau'), 'server')
  await assert.rejects(searchCode(fs, { query: 'x', path: '../etc' }), /repo-relative/)
})

test('regex mode, anchors, invalid regex and context separators', async () => {
  const fs = fixtureFs()
  const r = await searchCode(fs, { query: '^function \\w+:(Init|Start)\\(', regex: true, context: 0 })
  // Includes the commented-out ShopController:Start (search is textual, unlike the map).
  assert.equal(r.matches, 6)
  assert.throws(() => buildMatcher({ query: '(', regex: true }), /invalid regex/)
  const ctx = await searchCode(fs, { query: 'function InventoryService', path: SVC, context: 1 })
  assert.equal(ctx.matches, 4)
  assert.ok(ctx.text.includes('\n--\n'))
  // Adjacent context is not duplicated.
  const lines = ctx.text.split('\n').filter((l) => l !== '--')
  assert.equal(new Set(lines).size, lines.length)
})

test('findSymbol uses the map, then falls back to a definition search', async () => {
  const fs = fixtureFs()
  const groups = await fixtureScripts()
  const map = new ProjectMap({ scripts: () => groups, readFile: fs.readFile })
  await map.refresh()
  const viaMap = await findSymbol(map, fs, 'GetItems')
  assert.equal(viaMap.fromSearch, false)
  assert.equal(viaMap.text, `${SVC}:34 method InventoryService:GetItems`)
  const local = await findSymbol(map, fs, 'slotsFor')
  assert.equal(local.fromSearch, true)
  assert.equal(local.text, `${SVC}:11: local function slotsFor(player: Player)`)
})

test('tool definitions: project_map, search_code, find_symbol', async () => {
  const fs = fixtureFs()
  const groups = await fixtureScripts()
  const map = new ProjectMap({ scripts: () => groups, readFile: fs.readFile })
  const tools = budgetTools({ map, fs })
  assert.deepEqual(tools.map((t) => t.name), ['project_map', 'search_code', 'find_symbol'])
  const byName = Object.fromEntries(tools.map((t) => [t.name, t]))
  const pm = await byName.project_map.handler({ realm: 'client' }, {})
  assert.match(pm.content[0].text, /3 scripts/)
  const sc = await byName.search_code.handler({ query: '(', regex: true }, {})
  assert.equal(sc.isError, true)
  const fsym = await byName.find_symbol.handler({ name: 'InventoryService:AddItem' }, {})
  assert.match(fsym.content[0].text, /InventoryService\.luau:24 function InventoryService\.AddItem/)
})
