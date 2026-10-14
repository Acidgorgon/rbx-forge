// UI Motion Lab "From a story" source, pure parts: the buttons / frames a rendered story offers as
// targets (name paths, buttons first, lab helpers and unreachable duplicates left out), what a click
// in select mode picks, and the export for a story source (each target its own attach root, shared
// stacks, the lines to paste) plus the module's Effects.stacks.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { luauLocal, namePath, pickTarget, storyExportPlan, storySnippet, storyTargets, type TreeNodeLike } from '../src/shared/uimotion/story.ts'
import { compileMotionModule } from '../src/shared/uimotion/compile.ts'
import { normalizeSpec, presetSpec } from '../src/shared/uimotion/spec.ts'

// Slot1 > RacingHud > { BoostBar(Frame) > Fill(Frame), BOOSTButton(TextButton) > { Label(TextLabel), KeyCap(Frame) },
//   Controls(Frame) > Boost(ImageButton), UpgradePanel(Frame, hidden) > Close(TextButton), ForgeMotionScale(UIScale),
//   Row.1(Frame), Dup(Frame) x2 }
function tree(): TreeNodeLike[] {
  const nodes: TreeNodeLike[] = []
  const add = (id: number, cls: string, name: string, parent: number | null, props: Record<string, unknown> = {}) => {
    nodes.push({ id, cls, name, parent, children: [], props })
    if (parent != null) nodes.find((n) => n.id === parent)!.children.push(id)
  }
  add(1, 'Frame', 'Slot1', null)
  add(2, 'Frame', 'RacingHud', 1)
  add(3, 'Frame', 'BoostBar', 2)
  add(4, 'Frame', 'Fill', 3)
  add(5, 'TextButton', 'BOOSTButton', 2)
  add(6, 'TextLabel', 'Label', 5)
  add(7, 'Frame', 'KeyCap', 5)
  add(8, 'Frame', 'Controls', 2)
  add(9, 'ImageButton', 'Boost', 8)
  add(10, 'Frame', 'UpgradePanel', 2, { Visible: false })
  add(11, 'TextButton', 'Close', 10)
  add(12, 'UIScale', 'ForgeMotionScale', 5)
  add(13, 'Frame', 'Row.1', 2)
  add(14, 'Frame', 'Dup', 2)
  add(15, 'Frame', 'Dup', 2)
  add(16, 'TextButton', 'Outside', null)
  return nodes
}

test('story targets: buttons first by name path, then frames; helpers, dotted names and duplicates left out', () => {
  const t = storyTargets(tree(), 1)
  assert.deepEqual(
    t.map((x) => x.label),
    ['RacingHud > BOOSTButton', 'RacingHud > Controls > Boost', 'RacingHud > UpgradePanel > Close', 'RacingHud', 'RacingHud > BoostBar', 'RacingHud > BoostBar > Fill', 'RacingHud > BOOSTButton > KeyCap', 'RacingHud > Controls', 'RacingHud > UpgradePanel', 'RacingHud > Dup']
  )
  assert.equal(t[0].path, 'RacingHud.BOOSTButton')
  assert.equal(t[0].className, 'TextButton')
  assert.ok(t[0].button && !t[0].hidden)
  assert.equal(t.find((x) => x.path === 'RacingHud.UpgradePanel.Close')!.hidden, true)
  assert.equal(t.filter((x) => x.path === 'RacingHud.Dup').length, 1)
  assert.equal(t.find((x) => x.path === 'RacingHud.Dup')!.id, 14)
  assert.ok(!t.some((x) => /ForgeMotion|Row\.1|Label$/.test(x.path)))
  // Works on a Map (PreviewTree.nodes) too; no root -> nothing.
  assert.deepEqual(storyTargets(new Map(tree().map((n) => [n.id, n])), 1).map((x) => x.path), t.map((x) => x.path))
  assert.deepEqual(storyTargets(tree(), null), [])
  assert.deepEqual(storyTargets(tree(), 99), [])
})

test('select mode: a click picks the enclosing button, else the nearest frame; nothing outside the slot', () => {
  const nodes = tree()
  assert.equal(pickTarget(nodes, 6, 1), 'RacingHud.BOOSTButton') // the button's label
  assert.equal(pickTarget(nodes, 7, 1), 'RacingHud.BOOSTButton') // a frame inside the button
  assert.equal(pickTarget(nodes, 9, 1), 'RacingHud.Controls.Boost')
  assert.equal(pickTarget(nodes, 4, 1), 'RacingHud.BoostBar.Fill')
  assert.equal(pickTarget(nodes, 2, 1), 'RacingHud')
  assert.equal(pickTarget(nodes, 1, 1), null)
  assert.equal(pickTarget(nodes, 16, 1), null)
})

test('name paths and Luau locals for the snippet', () => {
  assert.equal(namePath('RacingHud.Controls.Boost'), 'RacingHud > Controls > Boost')
  assert.equal(namePath(''), '(root)')
  assert.equal(luauLocal('BOOSTButton'), 'boostButton')
  assert.equal(luauLocal('PlayButton'), 'playButton')
  assert.equal(luauLocal('UI'), 'ui')
  assert.equal(luauLocal('Close'), 'close')
  assert.equal(luauLocal('end'), 'endButton')
  assert.equal(luauLocal('play button 2'), 'playButton2')
})

test('story export: one shared stack -> Effects.attach(button) per target; the module default is rebased to the root', () => {
  const bouncy = presetSpec('bouncy', 'RacingHud.BOOSTButton', 'HudBouncy')
  const spec = normalizeSpec({ ...bouncy, targets: [...bouncy.targets, { path: 'RacingHud.DRIFTButton', effects: structuredClone(bouncy.targets[0].effects) }] }, 'HudBouncy')
  const plan = storyExportPlan(spec)
  assert.deepEqual(plan.spec.targets.map((t) => t.path), [''])
  assert.deepEqual(plan.spec.targets[0].effects, bouncy.targets[0].effects)
  assert.deepEqual(plan.stacks, {})
  assert.deepEqual(plan.attach, [
    { path: 'RacingHud.BOOSTButton', label: 'RacingHud > BOOSTButton', variable: 'boostButton' },
    { path: 'RacingHud.DRIFTButton', label: 'RacingHud > DRIFTButton', variable: 'driftButton' }
  ])
  const req = 'game:GetService("ReplicatedStorage").Shared.Interface.Motion.HudBouncyEffects'
  assert.equal(
    storySnippet({ requirePath: req, module: 'src/shared/Interface/Motion/HudBouncyEffects.luau', attach: plan.attach }),
    `local Effects = require(${req})\nEffects.attach(boostButton) -- RacingHud > BOOSTButton\nEffects.attach(driftButton) -- RacingHud > DRIFTButton`
  )
  // Module not mapped: a relative require with a note to adjust it.
  assert.match(storySnippet({ requirePath: null, module: 'src/shared/Interface/Motion/HudBouncyEffects.luau', attach: plan.attach }).split('\n')[0], /^local Effects = require\(script\.Parent\.Motion\.HudBouncyEffects\) -- adjust/)
  // Effect order does not make two stacks different.
  const swapped = normalizeSpec({ ...spec, targets: [spec.targets[0], { path: 'RacingHud.DRIFTButton', effects: [...spec.targets[0].effects].reverse() }] })
  assert.deepEqual(storyExportPlan(swapped).stacks, {})
})

test('story export: per-element stacks -> Effects.stacks.<Name>; the module carries every kind it needs', () => {
  const snappy = presetSpec('snappy', 'RacingHud.BOOSTButton').targets[0].effects
  const juicy = presetSpec('juicy', '').targets[0].effects
  const spec = normalizeSpec({ name: 'Hud', targets: [{ path: 'RacingHud.BOOSTButton', effects: snappy }, { path: 'RacingHud.Controls.Boost', effects: juicy }, { path: 'Other.Boost', effects: juicy }] })
  const plan = storyExportPlan(spec)
  assert.deepEqual(Object.keys(plan.stacks), ['Boost'])
  assert.deepEqual(plan.stacks.Boost.targets.map((t) => t.path), [''])
  assert.deepEqual(plan.attach.map((a) => [a.variable, a.stack ?? null]), [['boostButton', null], ['boost', 'Boost'], ['boost2', 'Boost']])
  const snippet = storySnippet({ requirePath: 'game:GetService("ReplicatedStorage").M', module: 'Motion/HudEffects.luau', attach: plan.attach })
  assert.match(snippet, /Effects\.attach\(boost, Effects\.stacks\.Boost\) -- RacingHud > Controls > Boost/)
  const src = compileMotionModule(plan.spec, { stacks: plan.stacks })
  assert.match(src, /Effects\.stacks = \{\n\tBoost = \{/)
  // shine is only in the juicy stack; its runtime block must still be compiled in.
  assert.ok(snappy.every((e) => e.kind !== 'shine') && juicy.some((e) => e.kind === 'shine'))
  assert.match(src, /ForgeMotionShine/)
  assert.ok(!/Effects\.stacks/.test(compileMotionModule(plan.spec)), 'no stacks -> no Effects.stacks')
  // Empty spec: a root stack with nothing in it, no attach lines (the snippet shows a placeholder).
  const empty = storyExportPlan(normalizeSpec({ name: 'E', targets: [] }))
  assert.deepEqual(empty.attach, [])
  assert.match(storySnippet({ requirePath: 'x', module: 'm.luau', attach: [] }), /Effects\.attach\(button\)/)
})
