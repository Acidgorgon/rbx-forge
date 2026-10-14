// add_blink_event: a repeated call for an event that already exists answers "already exists" and
// never reaches addEvent (the screenshot case: the model called FishingAction twice).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { blinkTools } from '../src/main/agent/serviceTools.ts'
import type { BlinkEvent } from '../src/shared/types.ts'

function tools(events: BlinkEvent[]) {
  const added: string[] = []
  const t = blinkTools({
    root: () => '/proj',
    listEvents: async () => events,
    describeEvent: (e) => `event ${[...e.scope, e.name].join('.')}`,
    check: async () => ({ ok: true, diagnostics: [] }),
    addEvent: async (_r, spec) => {
      added.push(spec.name)
      return { declaration: `event ${spec.name}`, check: { ok: true, diagnostics: [] } }
    }
  })
  return { add: t.write.find((x) => x.name === 'add_blink_event')!, added }
}

const fishing: BlinkEvent = { kind: 'event', name: 'FishingAction', scope: ['Fishing'], from: 'Client', file: 'events.blink', line: 3 }

test('add_blink_event refuses a duplicate name in the same scope', async () => {
  const { add, added } = tools([fishing])
  const r: any = await add.handler({ name: 'FishingAction', scope: 'Fishing' }, {} as any)
  assert.match(r.content[0].text, /already exists/)
  assert.equal(r.isError, undefined)
  assert.deepEqual(added, [])
})

test('add_blink_event adds the same name in another scope', async () => {
  const { add, added } = tools([fishing])
  const r: any = await add.handler({ name: 'FishingAction', scope: 'Other' }, {} as any)
  assert.match(r.content[0].text, /added to events\.blink/)
  assert.deepEqual(added, ['FishingAction'])
})

test('parallel add_blink_event calls run one after another', async () => {
  let inFlight = 0
  let max = 0
  const t = blinkTools({
    root: () => '/proj',
    listEvents: async () => [],
    describeEvent: () => '',
    check: async () => ({ ok: true, diagnostics: [] }),
    addEvent: async (_r, spec) => {
      max = Math.max(max, ++inFlight)
      await new Promise((r) => setTimeout(r, 10))
      inFlight--
      return { declaration: `event ${spec.name}`, check: { ok: true, diagnostics: [] } }
    }
  })
  const add = t.write.find((x) => x.name === 'add_blink_event')!
  await Promise.all([add.handler({ name: 'A' }, {} as any), add.handler({ name: 'B' }, {} as any)])
  assert.equal(max, 1)
})
