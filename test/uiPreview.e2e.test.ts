// UI Preview end to end with the real lune binary and the real Vide 0.4.0 (MIT, vendored in
// test/fixtures/ui-preview-project/Packages, see ATTRIBUTION.md): list storybooks, render the
// Counter story, click its button and see the text change (headless render and a live session),
// render the racing HUD and open its upgrades panel with BOOST. Uses $LUNE_PATH, else lune on the
// rokit/PATH lookup; skips with a message when neither exists.
import assert from 'node:assert/strict'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { findLune } from '../src/main/services/tests/index.ts'
import { UiPreviewService } from '../src/main/services/uiPreview/service.ts'
import { findNode } from '../src/main/services/uiPreview/service.ts'
import { layoutTree } from '../src/shared/uiPreview/layout.ts'
import { PreviewTree } from '../src/shared/uiPreview/protocol.ts'
import type { UiPreviewEvent } from '../src/shared/uiPreviewTypes.ts'

const ROOT = resolve(import.meta.dirname, 'fixtures', 'ui-preview-project')
const COUNTER = 'src/shared/Interface/Stories/Counter.story.luau'
const HUD = 'src/shared/Interface/Stories/RacingHud.story.luau'
const lune = findLune(process.env.LUNE_PATH || null)
const skip = lune ? false : 'lune not found (set LUNE_PATH or `rokit add --global lune-org/lune`); skipping UI Preview end-to-end tests'
if (!lune) console.log(`# ${skip}`)

function service(events: UiPreviewEvent[] = []): UiPreviewService {
  const s = new UiPreviewService({ lunePath: () => lune, projectFile: () => 'default.project.json', emit: (e) => events.push(e) })
  s.setRoot(ROOT)
  return s
}

const textOf = (tree: { nodes: { name: string; props: Record<string, unknown> }[] }, name: string) => tree.nodes.find((n) => n.name === name)?.props.Text

test('lists the fixture storybook with its stories', { skip }, async () => {
  const list = await service().listStories()
  assert.equal(list.luneAvailable, true)
  const book = list.storybooks.find((b) => b.name === 'Fixture UI')
  assert.ok(book, JSON.stringify(list))
  assert.deepEqual(book.stories.map((s) => s.name).sort(), ['Counter', 'RacingHud'])
})

test('counter story: a click changes the text (headless render)', { skip, timeout: 60_000 }, async () => {
  const s = service()
  const before = await s.render({ file: COUNTER, width: 800, height: 600 })
  assert.equal(before.error, undefined, before.error)
  assert.equal(before.kind, 'vide')
  assert.equal(textOf(before.tree, 'CounterButton'), 'Clicks: 0')
  const after = await s.render({ file: COUNTER, width: 800, height: 600, clicks: ['CounterButton', 'CounterButton'] })
  assert.deepEqual(after.clicked, ['CounterButton', 'CounterButton'])
  assert.equal(textOf(after.tree, 'CounterButton'), 'Clicks: 2')
  const relabeled = await s.render({ file: COUNTER, width: 800, height: 600, controls: { Label: 'Taps' } })
  assert.equal(textOf(relabeled.tree, 'CounterButton'), 'Taps: 0')
})

test('counter story: live session streams the change after an input click', { skip, timeout: 60_000 }, async () => {
  const events: UiPreviewEvent[] = []
  const s = service(events)
  try {
    await s.open({ file: COUNTER, width: 800, height: 600, device: 'desktop' })
    const tree = new PreviewTree()
    const wait = async (ok: () => boolean, what: string) => {
      for (let i = 0; i < 200; i++) {
        for (const e of events.splice(0)) if (e.type === 'ops') tree.apply(e.ops)
        if (ok()) return
        await new Promise((r) => setTimeout(r, 25))
      }
      assert.fail(`timed out waiting for ${what}`)
    }
    await wait(() => findNode(tree, 'CounterButton') != null, 'the button')
    const id = findNode(tree, 'CounterButton')!
    assert.equal(tree.get(id)!.props.Text, 'Clicks: 0')
    await s.input({ type: 'click', id })
    await wait(() => tree.get(id)!.props.Text === 'Clicks: 1', 'the text to change')
  } finally {
    await s.close()
  }
})

test('racing HUD renders without errors; BOOST opens the upgrades panel', { skip, timeout: 60_000 }, async () => {
  const s = service()
  const closed = await s.render({ file: HUD, width: 1469, height: 822 })
  assert.equal(closed.error, undefined, closed.error)
  assert.deepEqual(closed.console.filter((c) => c.level === 'error'), [])
  assert.ok(closed.tree.nodes.length > 140, `${closed.tree.nodes.length} instances`)
  assert.equal(textOf(closed.tree, 'Speed'), '180')
  const panel = (t: typeof closed.tree) => t.nodes.find((n) => n.name === 'UpgradePanel')!
  assert.equal(panel(closed.tree).props.Visible, false)
  const open = await s.render({ file: HUD, width: 1469, height: 822, clicks: ['BOOSTButton'], settleMs: 600 })
  assert.deepEqual(open.missing, [])
  assert.equal(panel(open.tree).props.Visible, true)
  // After the spring settles the panel sits inside the viewport, above the speedometer.
  const tree = PreviewTree.from(open.tree)
  const box = layoutTree(tree, { viewport: { w: 1469, h: 822 } }).boxes.get(panel(open.tree).id)!
  assert.ok(box.x > 1000 && box.x + box.w <= 1469 && box.y > 400, JSON.stringify(box))
})
