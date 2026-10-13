// Token estimator (budget/tokens.ts).

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  estimateJsonTokens,
  estimateMessagesTokens,
  estimateTokens,
  formatTokens,
  MESSAGE_OVERHEAD_TOKENS
} from '../src/main/agent/budget/tokens.ts'
import { FIXTURE_ROOT } from './tokensFixture.ts'

test('empty and tiny inputs', () => {
  assert.equal(estimateTokens(''), 0)
  assert.equal(estimateTokens(null), 0)
  assert.equal(estimateTokens(undefined), 0)
  assert.equal(estimateTokens('a'), 1)
})

test('prose is about chars/4', () => {
  const prose = 'The quick brown fox jumps over the lazy dog and keeps running across the field until sunset'
  const n = estimateTokens(prose)
  assert.ok(n >= prose.length / 5 && n <= prose.length / 3.5, `${n} for ${prose.length} chars`)
})

test('code counts denser than prose of the same length', () => {
  const code = 'local x = require(ReplicatedStorage.Packages.Janitor) :: any; if (a.b[c]) then f(x, y) end'
  const prose = 'a'.repeat(4) + ' ' + 'the cat sat on the mat while the dog slept by the warm fire tonight ok'
  const padded = prose.slice(0, code.length)
  assert.ok(estimateTokens(code) > estimateTokens(padded))
})

test('indentation and blank lines are nearly free', () => {
  const flat = 'local a = 1\nlocal b = 2\n'
  const indented = '\t\t\t\tlocal a = 1\n\n\n\n\t\t\t\tlocal b = 2\n'
  assert.ok(estimateTokens(indented) - estimateTokens(flat) <= 1)
})

test('real Luau file lands in a plausible range', () => {
  const src = readFileSync(join(FIXTURE_ROOT, 'src/shared/Modules/ModuleLoader.luau'), 'utf8')
  const n = estimateTokens(src)
  // ~1.9k chars of tab-indented Luau: real tokenizers give ~450-600.
  assert.ok(n > 350 && n < 750, String(n))
})

test('deterministic', () => {
  const s = 'function InventoryService:AddItem(player, item) end'
  assert.equal(estimateTokens(s), estimateTokens(s))
})

test('non-ASCII counts more per char', () => {
  assert.ok(estimateTokens('日本語のテキストです') >= 7)
})

test('message estimates include overhead and tool calls', () => {
  const msgs = [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: null, tool_calls: [{ function: { name: 'read_script', arguments: '{"path":"src/a.luau"}' } }] }
  ]
  const n = estimateMessagesTokens(msgs)
  assert.ok(n >= 3 * MESSAGE_OVERHEAD_TOKENS + 1 + estimateTokens('read_script'))
  assert.equal(estimateJsonTokens({ a: 1 }), estimateTokens('{"a":1}'))
})

test('formatTokens', () => {
  assert.equal(formatTokens(950), '950')
  assert.equal(formatTokens(1200), '1.2k')
  assert.equal(formatTokens(1000), '1k')
  assert.equal(formatTokens(34_400), '34k')
  assert.equal(formatTokens(1_500_000), '1.5M')
})
