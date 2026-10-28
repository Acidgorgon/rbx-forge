import test from 'node:test'
import assert from 'node:assert/strict'
import { sameProblems } from '../src/renderer/src/lib/sameProblems.ts'

const p = (over: Partial<Parameters<typeof sameProblems>[0][number]> = {}) => ({ path: 'a.luau', line: 1, col: 2, message: 'm', severity: 'error' as const, source: 'luau-lsp', ...over })

test('sameProblems: equal lists compare equal, any field change does not', () => {
  assert.equal(sameProblems([], []), true)
  assert.equal(sameProblems([p()], [p()]), true)
  assert.equal(sameProblems([p()], []), false)
  for (const over of [{ path: 'b' }, { line: 2 }, { col: 3 }, { message: 'x' }, { severity: 'warning' as const }, { source: 's' }, { code: 'c' }]) assert.equal(sameProblems([p()], [p(over)]), false)
  assert.equal(sameProblems([p(), p({ line: 5 })], [p({ line: 5 }), p()]), false)
})
