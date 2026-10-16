// Deleting chats: the list and the saved 'chats' setting, a running turn stopped first (and nothing
// it still produces lands anywhere), the images only that chat used, and its /rewind checkpoints.

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fakeContext } from './agentFake.ts'
import { ChatManager } from '../src/main/agent/chat.ts'
import { Credentials } from '../src/main/agent/credentials.ts'
import { ChatImageStore, setChatImageStore } from '../src/main/agent/chatImages.ts'
import { encodePng } from '../src/main/services/vfx/textures/png.ts'
import type { QueryFn } from '../src/main/agent/sdk.ts'

const plainSafe = async () => null

async function idle(chats: ChatManager, id: string) {
  while (chats.busy(id)) await new Promise((r) => setTimeout(r, 5))
}

async function until(fn: () => boolean, ms = 5000) {
  const end = Date.now() + ms
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out')
    await new Promise((r) => setTimeout(r, 5))
  }
}

// Answers at once, or (hold) waits until the turn is aborted.
function sdk(opts: { hold?: boolean } = {}) {
  const signals: AbortSignal[] = []
  const queryFn: QueryFn = ({ options }) => {
    const signal = (options as any).abortController.signal as AbortSignal
    signals.push(signal)
    return (async function* () {
      if (opts.hold) {
        yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'working on it' }] } } as any
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }))
        // A turn that ignores the abort a little longer and still emits.
        yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'late text' }] } } as any
        throw new Error('aborted')
      }
      yield { type: 'assistant', parent_tool_use_id: null, session_id: 's', message: { content: [{ type: 'text', text: 'done' }] } } as any
      yield { type: 'result', subtype: 'success', is_error: false, result: '', session_id: 's', usage: { input_tokens: 10, output_tokens: 5 } } as any
    })()
  }
  return { queryFn, signals }
}

async function setup(queryFn: QueryFn, extra: Record<string, unknown> = {}) {
  const fake = fakeContext()
  const creds = new Credentials(fake.ctx, plainSafe, {})
  await creds.setKey('anthropic', 'key-anthropic')
  const chats = new ChatManager(fake.ctx, { credentials: creds, toolFs: fake.fs, queryFn, checkpoints: null, ...extra } as any)
  return { fake, chats }
}

const saved = (fake: ReturnType<typeof fakeContext>) => ((fake.settings.get('chats') as { sessions: { id: string }[] }) ?? { sessions: [] }).sessions.map((s) => s.id)

test('delete removes the chats from the list and the saved setting; unknown ids are ignored', async () => {
  const { queryFn } = sdk()
  const { fake, chats } = await setup(queryFn)
  const a = chats.create()
  const b = chats.create()
  const c = chats.create()
  await chats.send(a.id, 'hello')
  await idle(chats, a.id)
  await chats.delete([a.id, 'nope'])
  assert.deepEqual(chats.list().map((x) => x.id), [c.id, b.id])
  assert.equal(chats.messages(a.id), null)
  assert.deepEqual(saved(fake), [c.id, b.id], 'written straight away (not on the debounce)')
  await chats.delete([b.id, c.id])
  assert.deepEqual(chats.list(), [])
  await chats.delete([a.id])
  // A reloaded manager does not bring them back.
  const again = new ChatManager(fake.ctx, { credentials: new Credentials(fake.ctx, plainSafe, {}), checkpoints: null } as any)
  assert.deepEqual(again.list(), [])
})

test('deleting a chat mid-turn stops the turn first; what it still emits goes nowhere', async () => {
  const { queryFn, signals } = sdk({ hold: true })
  const { fake, chats } = await setup(queryFn)
  const keep = chats.create()
  const c = chats.create()
  await chats.send(c.id, 'a long job')
  await until(() => signals.length === 1 && chats.messages(c.id)!.some((m) => m.text === 'working on it'))
  assert.equal(chats.busy(c.id), true)
  const mark = fake.events.length
  await chats.delete([c.id])
  assert.equal(signals[0].aborted, true, 'the running turn was aborted')
  await idle(chats, c.id)
  const after = fake.events.slice(mark)
  assert.ok(!after.some((e) => e.event === 'chat:message' && e.payload.sessionId === c.id), 'no messages for the deleted chat')
  assert.ok(!after.some((e) => e.event === 'chat:updated' && e.payload.id === c.id), 'no updates for the deleted chat')
  assert.deepEqual(chats.list().map((x) => x.id), [keep.id])
  chats.flush()
  assert.deepEqual(saved(fake), [keep.id], 'the ended turn did not save it back')
  // Sending to it now fails cleanly.
  await assert.rejects(chats.send(c.id, 'hi'), /unknown chat/)
})

test('deleting a chat removes the images only it used and drops its checkpoints', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-chatdel-'))
  try {
    const store = new ChatImageStore(dir)
    setChatImageStore(store)
    const png = `data:image/png;base64,${encodePng({ width: 2, height: 2, data: new Uint8Array(16).fill(9) } as any).toString('base64')}`
    const shared = await store.add({ dataUrl: png, name: 'shared' })
    const own = await store.add({ dataUrl: png, name: 'own' })
    const dropped: string[] = []
    let n = 0
    const checkpoints = () => ({ create: async () => `abc${++n}def0`, drop: async (c: string[]) => void dropped.push(...c) })
    const { queryFn } = sdk()
    const { chats } = await setup(queryFn, { checkpoints })
    const a = chats.create()
    const b = chats.create()
    await chats.send(a.id, 'look', [shared.id, own.id])
    await idle(chats, a.id)
    await chats.send(b.id, 'look too', [shared.id])
    await idle(chats, b.id)
    assert.ok(await store.pathOf(own.id))
    assert.equal(chats.checkpointsOf(a.id).length, 1)
    await chats.delete([a.id])
    assert.equal(await store.pathOf(own.id), null, "the chat's own image is gone")
    assert.ok(await store.pathOf(shared.id), 'an image another chat shows stays')
    assert.deepEqual(dropped, ['abc1def0'], "only the deleted chat's checkpoint is dropped")
    await chats.delete([b.id])
    assert.equal(await store.pathOf(shared.id), null)
    assert.ok(existsSync(dir))
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
