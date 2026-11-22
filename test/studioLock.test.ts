import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { StudioTurnLock } from '../src/main/agent/orchestrator/studioLock.ts'

const locks: StudioTurnLock[] = []
after(() => {
  for (const l of locks) l.dispose()
  locks.length = 0
})

test('StudioTurnLock grants turns in strict FIFO order across concurrent waiters', async () => {
  const lock = new StudioTurnLock()
  locks.push(lock)

  const order: string[] = []
  const release1 = await lock.acquire('worker-1', 'playtest')
  assert.equal(lock.status().holder?.owner, 'worker-1')
  assert.equal(lock.status().queue.length, 0)

  const p2 = lock.withLock('worker-2', 'insert-model', async () => {
    order.push('worker-2')
  })
  const p3 = lock.withLock('worker-3', 'screen-capture', async () => {
    order.push('worker-3')
  })
  const p4 = lock.withLock('worker-4', 'verify', async () => {
    order.push('worker-4')
  })

  const st = lock.status()
  assert.deepEqual(
    st.queue.map((q) => q.owner),
    ['worker-2', 'worker-3', 'worker-4']
  )

  release1()
  await Promise.all([p2, p3, p4])
  assert.deepEqual(order, ['worker-2', 'worker-3', 'worker-4'])
  assert.equal(lock.status().holder, null)
  assert.equal(lock.status().queue.length, 0)
})

test('StudioTurnLock auto-releases expired lease to next waiter and ignores late stale release', async () => {
  const expired: string[] = []
  const lock = new StudioTurnLock({
    defaultLeaseMs: 40,
    onTimeout: (h) => expired.push(h.owner)
  })
  locks.push(lock)

  const releaseSlow = await lock.acquire('crashed-worker', 'hung')
  let nextAcquired = false
  const pNext = lock.acquire('healthy-worker', 'continue').then((rel) => {
    nextAcquired = true
    return rel
  })

  const releaseHealthy = await pNext
  assert.equal(nextAcquired, true)
  assert.deepEqual(expired, ['crashed-worker'])
  assert.equal(lock.status().holder?.owner, 'healthy-worker')

  // Late release from the expired holder must NOT evict healthy-worker.
  releaseSlow()
  assert.equal(lock.status().holder?.owner, 'healthy-worker')

  releaseHealthy()
  assert.equal(lock.status().holder, null)
})

test('StudioTurnLock forceRelease wakes next FIFO waiter and AbortSignal cancels queued waiter cleanly', async () => {
  const lock = new StudioTurnLock()
  locks.push(lock)

  const r1 = await lock.acquire('holder-1', 'long op')
  const ac = new AbortController()

  const pAborted = lock.acquire('aborted-worker', 'wait', { signal: ac.signal })
  const pThird = lock.acquire('third-worker', 'after-aborted')

  ac.abort()
  await assert.rejects(pAborted, /aborted/i)
  assert.deepEqual(
    lock.status().queue.map((q) => q.owner),
    ['third-worker']
  )

  // forceRelease passes turn immediately to third-worker without needing r1().
  assert.equal(lock.forceRelease('manual override'), true)
  assert.equal(lock.forceRelease(), true) // releases third-worker too? Wait: pThird already got holder!
  assert.equal(lock.forceRelease(), false) // now idle
  const r3 = await pThird
  r3()
  r1()
  assert.equal(lock.status().holder, null)
})
