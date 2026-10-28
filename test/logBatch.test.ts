import assert from 'node:assert/strict'
import { test } from 'node:test'
import { appendCapped, createBatcher } from '../src/renderer/src/lib/logBatch.ts'

test('log batch: appends and keeps only the newest max lines', () => {
  assert.deepEqual(appendCapped([1, 2], [3, 4], 10), [1, 2, 3, 4])
  assert.deepEqual(appendCapped([1, 2, 3], [4, 5], 4), [2, 3, 4, 5])
  assert.deepEqual(appendCapped([1, 2, 3], [4, 5, 6, 7, 8], 4), [5, 6, 7, 8])
  const same = [1]
  assert.equal(appendCapped(same, [], 4), same)
})

test('log batch: many pushes become one flush after the delay', async () => {
  const batches: number[][] = []
  const b = createBatcher<number>((items) => batches.push(items), 20)
  for (let i = 0; i < 100; i++) b.push(i)
  assert.equal(batches.length, 0)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(batches.length, 1)
  assert.equal(batches[0].length, 100)
  assert.equal(batches[0][99], 99)
  b.push(1)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(batches.length, 2)
})

test('log batch: flush delivers early, cancel drops', async () => {
  const batches: string[][] = []
  const b = createBatcher<string>((items) => batches.push(items), 1000)
  b.push('a')
  b.push('b')
  b.flush()
  assert.deepEqual(batches, [['a', 'b']])
  b.flush()
  assert.equal(batches.length, 1)
  b.push('c')
  b.cancel()
  b.flush()
  assert.equal(batches.length, 1)
})
