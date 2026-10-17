// Queued prompts (renderer/assistant/queue.ts): what waits while a turn runs, order, pause on an
// error / Stop / a question, "Send now", and the text a queued prompt is sent as.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ChatMessage } from '../src/shared/types.ts'
import { afterTurn, editQueued, enqueue, moveToFront, outgoingText, queueWhenBusy, removeQueued, turnOutcome, type QueuedPrompt } from '../src/renderer/src/assistant/queue.ts'

const item = (id: string, text = id, extra: Partial<QueuedPrompt> = {}): QueuedPrompt => ({ id, text, images: [], at: 0, ...extra })
const msg = (role: ChatMessage['role'], text: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({ id: Math.random().toString(36), role, text, at: 0, agentId: 'main', ...extra })

test('order: prompts go out first in, first out; edit and remove keep the others in place', () => {
  let q: QueuedPrompt[] = []
  q = enqueue(q, item('a'))
  q = enqueue(q, item('b'))
  q = enqueue(q, item('c'))
  assert.deepEqual(q.map((x) => x.id), ['a', 'b', 'c'])
  q = editQueued(q, 'b', 'b edited')
  assert.deepEqual(q.map((x) => x.text), ['a', 'b edited', 'c'])
  q = removeQueued(q, 'a')
  assert.deepEqual(q.map((x) => x.id), ['b', 'c'])
})

test('send now: the chosen prompt goes first, the rest keep their order', () => {
  const q = [item('a'), item('b'), item('c'), item('d')]
  assert.deepEqual(moveToFront(q, 'c').map((x) => x.id), ['c', 'a', 'b', 'd'])
  assert.deepEqual(moveToFront(q, 'zz').map((x) => x.id), ['a', 'b', 'c', 'd'], 'unknown id: unchanged')
  // The turn stopped by "Send now" does not pause the queue.
  assert.deepEqual(afterTurn({ queued: 4, outcome: 'stopped', stopRequested: true, sendNow: true }), { send: true })
  // ...even when the queue was paused before.
  assert.deepEqual(afterTurn({ queued: 4, outcome: 'error', sendNow: true, paused: 'error' }), { send: true })
})

test('after a turn: done sends the next; an error, Stop or a question pauses; paused stays paused', () => {
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'done' }), { send: true })
  assert.deepEqual(afterTurn({ queued: 0, outcome: 'done' }), { send: false })
  assert.deepEqual(afterTurn({ queued: 0, outcome: 'error' }), { send: false }, 'an empty queue never pauses')
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'error' }), { send: false, pause: 'error' })
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'stopped' }), { send: false, pause: 'stopped' })
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'done', stopRequested: true }), { send: false, pause: 'stopped' }, 'Stop pressed, even if the turn had just finished')
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'waiting' }), { send: false, pause: 'waiting' })
  assert.deepEqual(afterTurn({ queued: 2, outcome: 'done', paused: 'error' }), { send: false, pause: 'error' }, 'a turn sent directly while paused does not resume the queue')
})

test('turn outcome: read from the messages after the newest user message', () => {
  const ok = [msg('user', 'hi'), msg('assistant', 'hello')]
  assert.equal(turnOutcome(ok), 'done')
  assert.equal(turnOutcome([...ok, msg('user', 'again'), msg('system', 'Stopped.')]), 'stopped')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Error: 500 upstream')]), 'error')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Could not send: no provider')]), 'error')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Spending cap reached: $1.00 today. Raise it in Settings.')]), 'error')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Budget: chat cost $5.00. Raise the limit in settings or start a new chat.')]), 'error')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Provider not set up', { settingsLink: 'openai' })]), 'error')
  // An earlier turn's error does not count.
  assert.equal(turnOutcome([msg('user', 'a'), msg('system', 'Error: x'), msg('user', 'b'), msg('assistant', 'fine')]), 'done')
  // Notes that are not failures.
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Budget: chat is at 210k tokens (soft cap 200k); consider a new chat or /compact.'), msg('assistant', 'ok')]), 'done')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Compacted · 142k → 48k tokens', { compact: { trigger: 'auto', before: 142_000, after: 48_000 } }), msg('assistant', 'ok')]), 'done')
  assert.equal(turnOutcome([msg('user', 'x'), msg('system', 'Error: in a command box', { command: '/cost' })]), 'done')
  // The assistant asks before it goes on: the next prompt must not answer for the person.
  assert.equal(turnOutcome([msg('user', 'x'), msg('assistant', 'reading', { card: 'restate', restate: { state: 'pending' } as any })]), 'waiting')
  assert.equal(turnOutcome([msg('user', 'x'), msg('assistant', 'plan', { planMode: { state: 'pending' } as any })]), 'waiting')
})

test('while busy: messages and turn-starting commands queue; read-only and UI commands run now', () => {
  for (const t of ['fix the shop button', '/compact keep the UI decisions', '/clear', '/ask how?', '/plan a thing', '/review', '/init', '/restate add rewards', '/team build it', '/roundtable x', '/my-custom arg', '/frontend:test', '/ not a command']) {
    assert.equal(queueWhenBusy(t), true, t)
  }
  for (const t of ['/help', '/cost', '/context', '/todos', '/model', '/effort high', '/memory a note', '/resume', '/rewind', '/export', '/new', '/tests', '/lint', '/sync', '/agents', '/permissions']) {
    assert.equal(queueWhenBusy(t), false, t)
  }
})

test('outgoing text: a message keeps its context chips and images; a command goes as typed', () => {
  const ctx = 'Current file: `src/shared/Shop.luau`'
  assert.equal(outgoingText(item('a', ' fix it ', { context: ctx })), `fix it\n\n${ctx}`)
  assert.equal(outgoingText(item('b', '/compact keep UI', { context: ctx })), '/compact keep UI')
  assert.equal(outgoingText(item('c', '/restate add rewards', { context: ctx })), `/restate add rewards\n\n${ctx}`)
  const withImages = item('d', '', { images: [{ id: 'img1', mime: 'image/png' }] })
  assert.equal(outgoingText(withImages), '')
  assert.equal(withImages.images.length, 1)
})
