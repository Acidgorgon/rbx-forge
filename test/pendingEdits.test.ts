import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPendingEdits, type EditBuffer } from '../src/renderer/src/lib/pendingEdits.ts'

// A tiny store: one buffer per path, fileEdit sets current.
function setup(files: Record<string, EditBuffer>, preview = new Set<string>(), ms = 20) {
  const applied: [string, string][] = []
  const edits = createPendingEdits(
    {
      buffer: (p) => files[p],
      isPreview: (p) => preview.has(p),
      apply: (p, contents) => {
        applied.push([p, contents])
        if (files[p]) files[p] = { ...files[p], current: contents }
        preview.delete(p)
      }
    },
    ms
  )
  return { files, applied, edits }
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

test('pending edits: the keystroke that makes a clean file dirty reaches the store at once', () => {
  const s = setup({ a: { saved: 'x', current: 'x' } })
  s.edits.edit('a', 'x1')
  assert.deepEqual(s.applied, [['a', 'x1']])
  assert.equal(s.edits.size, 0)
})

test('pending edits: typing in a dirty file waits for a pause, then hands over the latest text once', async () => {
  const s = setup({ a: { saved: 'x', current: 'x' } })
  s.edits.edit('a', 'x1')
  s.edits.edit('a', 'x12')
  s.edits.edit('a', 'x123')
  assert.deepEqual(s.applied, [['a', 'x1']])
  assert.equal(s.files.a.current, 'x1')
  await wait(10)
  s.edits.edit('a', 'x1234')
  await wait(12)
  // The timer restarted with the last keystroke.
  assert.equal(s.applied.length, 1)
  await wait(30)
  assert.deepEqual(s.applied, [['a', 'x1'], ['a', 'x1234']])
  assert.equal(s.edits.size, 0)
})

test('pending edits: typing back to the saved text flips the dirty flag at once', () => {
  const s = setup({ a: { saved: 'x', current: 'x' } })
  s.edits.edit('a', 'x1')
  s.edits.edit('a', 'x12')
  s.edits.edit('a', 'x')
  assert.deepEqual(s.applied, [['a', 'x1'], ['a', 'x']])
  assert.equal(s.edits.size, 0, 'the older pending text is dropped')
  assert.equal(s.files.a.current, s.files.a.saved)
})

test('pending edits: flush hands over pending text now (save, close, rename)', () => {
  const s = setup({ a: { saved: 'x', current: 'x' }, b: { saved: 'y', current: 'y' } })
  s.edits.edit('a', 'x1')
  s.edits.edit('b', 'y1')
  s.edits.edit('a', 'x12')
  s.edits.edit('b', 'y12')
  assert.equal(s.edits.size, 2)
  s.edits.flush()
  assert.equal(s.files.a.current, 'x12')
  assert.equal(s.files.b.current, 'y12')
  assert.equal(s.edits.size, 0)
  s.edits.flush()
  assert.equal(s.applied.length, 4)
})

test('pending edits: the first edit of a preview tab goes through at once (it pins the tab)', () => {
  const s = setup({ a: { saved: 'x', current: 'x1' } }, new Set(['a']))
  s.edits.edit('a', 'x12')
  assert.deepEqual(s.applied, [['a', 'x12']])
})

test('pending edits: a clean edit that keeps the saved text is not dispatched; no buffer dispatches as before', () => {
  const s = setup({ a: { saved: 'x', current: 'x' } })
  s.edits.edit('a', 'x')
  assert.equal(s.applied.length, 0)
  assert.equal(s.edits.size, 0)
  s.edits.edit('gone', 'z')
  assert.deepEqual(s.applied, [['gone', 'z']])
})

test('pending edits: dirty flags stay exact after a save lands while text is pending', () => {
  const s = setup({ a: { saved: 'x', current: 'x' } })
  s.edits.edit('a', 'x1')
  s.edits.edit('a', 'x12')
  // The store flushes before recording a save, then the save marks its text as saved.
  s.edits.flush()
  s.files.a = { ...s.files.a, saved: 'x12' }
  assert.equal(s.files.a.current, s.files.a.saved)
  s.edits.edit('a', 'x123')
  assert.deepEqual(s.applied.at(-1), ['a', 'x123'], 'dirty again at once')
})
