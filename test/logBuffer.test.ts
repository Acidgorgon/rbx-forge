import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { LogLine } from '../src/shared/types.ts'
import { LogBuffer } from '../src/main/services/logs.ts'

const line = (i: number, service: LogLine['service'] = 'dev') => ({ service, stream: 'stdout' as const, text: `l${i}` })

test('log buffer: keeps the newest cap lines in order, filters by service and limit', () => {
  const buf = new LogBuffer(() => undefined, { cap: 5, batchMs: 0 })
  for (let i = 0; i < 3; i++) buf.push(line(i))
  assert.deepEqual(buf.get().map((l) => l.text), ['l0', 'l1', 'l2'])
  for (let i = 3; i < 12; i++) buf.push(line(i, i % 2 ? 'rojo' : 'dev'))
  assert.deepEqual(buf.get().map((l) => l.text), ['l7', 'l8', 'l9', 'l10', 'l11'])
  assert.deepEqual(buf.get('rojo').map((l) => l.text), ['l7', 'l9', 'l11'])
  assert.deepEqual(buf.get(undefined, 2).map((l) => l.text), ['l10', 'l11'])
  assert.ok(buf.get().every((l) => typeof l.at === 'number'))
})

test('log buffer: lines reach the listener in one batch per window', async () => {
  const batches: LogLine[][] = []
  const buf = new LogBuffer((lines) => batches.push(lines), { cap: 100, batchMs: 20 })
  for (let i = 0; i < 50; i++) buf.push(line(i))
  assert.equal(batches.length, 0)
  // Readers see lines at once even before the batch goes out.
  assert.equal(buf.get().length, 50)
  await new Promise((r) => setTimeout(r, 60))
  assert.equal(batches.length, 1)
  assert.deepEqual(batches[0].map((l) => l.text), Array.from({ length: 50 }, (_, i) => `l${i}`))
  buf.push(line(99))
  buf.flush()
  assert.equal(batches.length, 2)
  assert.equal(batches[1][0].text, 'l99')
})
