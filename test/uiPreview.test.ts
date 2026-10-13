// UI Preview: Roblox layout math (golden values), the Lune JSON-lines protocol, rich text, image refs,
// UI Labs story grouping, Edit-mode literal rewrites, the Figma interchange (Forge JSON, SVG, diff,
// and a round trip through the compiled Figma plugin with a fake `figma` API) and the preview_ui tool.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { test } from 'node:test'
import vm from 'node:vm'
import { applyAspect, approxMeasure, fitTextSize, gridLayout, layoutTree, listLayout, placeBox, resolvePadding, resolveUDim2, type ListItem } from '../src/shared/uiPreview/layout.ts'
import { errorLocation, luauLiteral, parsePreviewLine, PreviewTree, type UiOp, type UiProps } from '../src/shared/uiPreview/protocol.ts'
import { parseRichText } from '../src/shared/uiPreview/richText.ts'
import { cssFont, parseImage, parseThumbnailResponse, thumbnailRequest } from '../src/shared/uiPreview/assets.ts'
import { cssGradient, gradientFromProps } from '../src/shared/uiPreview/paint.ts'
import { applyEdit, codeMask, isLiteralExpression, planPropertyEdit } from '../src/shared/uiPreview/edit.ts'
import { diffDocs, forgeDoc, forgeSvg, parseForgeDoc, type ForgeUiDoc } from '../src/shared/uiPreview/figma.ts'
import { outline } from '../src/shared/uiPreview/summary.ts'
import { findNode, groupStories, isStoryFile, SessionModel, storyName } from '../src/main/services/uiPreview/service.ts'
import { imageRefs, previewTools, resolveStory } from '../src/main/services/uiPreview/tools.ts'
import { exportName } from '../src/main/services/uiPreview/wire.ts'
import { ImageResolver } from '../src/main/services/uiPreview/images.ts'

const FIXTURE = resolve(import.meta.dirname, 'fixtures', 'ui-preview-project')
const HUD = 'src/shared/Interface/Stories/RacingHud.story.luau'

const U2 = (xs: number, xo: number, ys: number, yo: number) => ({ t: 'UDim2' as const, v: [xs, xo, ys, yo] as [number, number, number, number] })
const V2 = (x: number, y: number) => ({ t: 'Vector2' as const, v: [x, y] as [number, number] })
const UD = (s: number, o: number) => ({ t: 'UDim' as const, v: [s, o] as [number, number] })
const EN = (e: string, v: string) => ({ t: 'Enum' as const, e, v })
const C3 = (r: number, g: number, b: number) => ({ t: 'Color3' as const, v: [r, g, b] as [number, number, number] })

// ScreenGui (1) > StoryTarget (2, full size) > ...; returns the tree and a node builder.
function scene(): { tree: PreviewTree; add: (id: number, cls: string, name: string, parent: number, props?: UiProps) => void } {
  const tree = new PreviewTree()
  tree.apply([
    { op: 'create', id: 1, cls: 'ScreenGui', name: 'ForgePreview' },
    { op: 'create', id: 2, cls: 'Frame', name: 'StoryTarget', parent: 1, props: { Size: U2(1, 0, 1, 0), BackgroundTransparency: 1 } }
  ])
  return { tree, add: (id, cls, name, parent, props = {}) => tree.apply([{ op: 'create', id, cls, name, parent, props }]) }
}

// ---- layout goldens

test('UDim2 and AnchorPoint resolve like Roblox', () => {
  assert.deepEqual(resolveUDim2([0.5, 10, 0.25, -4], { w: 800, h: 600 }), [410, 146])
  // Centred 200x100 box at {0.5,0},{0.5,0} with AnchorPoint 0.5,0.5 in an 800x600 parent at 0,0.
  assert.deepEqual(placeBox([0.5, 0, 0.5, 0], [0.5, 0.5], [200, 100], { x: 0, y: 0, w: 800, h: 600 }), [300, 250])
  // Bottom-right anchored with a -10 offset.
  assert.deepEqual(placeBox([1, -10, 1, -10], [1, 1], [50, 20], { x: 100, y: 100, w: 400, h: 300 }), [440, 370])
  // UIScale multiplies offsets.
  assert.deepEqual(resolveUDim2([0, 10, 0, 20], { w: 0, h: 0 }, 2), [20, 40])
})

test('UIPadding and UIAspectRatioConstraint', () => {
  assert.deepEqual(resolvePadding({ PaddingLeft: UD(0, 8), PaddingRight: UD(0.1, 0), PaddingTop: UD(0, 4), PaddingBottom: UD(0, 4) }, { w: 200, h: 100 }), { left: 8, right: 20, top: 4, bottom: 4 })
  assert.deepEqual(applyAspect([400, 100], 2, 'FitWithinMaxSize', 'Width'), [200, 100])
  assert.deepEqual(applyAspect([100, 400], 2, 'FitWithinMaxSize', 'Width'), [100, 50])
  assert.deepEqual(applyAspect([400, 100], 2, 'ScaleWithParentSize', 'Width'), [400, 200])
})

test('UIListLayout: padding, alignment, sort order and flex fill', () => {
  const items: ListItem[] = [
    { id: 1, size: [50, 20], layoutOrder: 2, name: 'B', index: 0 },
    { id: 2, size: [30, 20], layoutOrder: 1, name: 'A', index: 1 }
  ]
  const r = listLayout(items, { w: 200, h: 40 }, { direction: 'Horizontal', padding: 10, horizontalAlignment: 'Center', verticalAlignment: 'Center', sortOrder: 'LayoutOrder', mainFlex: 'None', crossFlex: 'None', wraps: false })
  // A (order 1) first: total 30 + 10 + 50 = 90, centred in 200 -> starts at 55.
  assert.deepEqual(r.rects.get(2), { x: 55, y: 10, w: 30, h: 20 })
  assert.deepEqual(r.rects.get(1), { x: 95, y: 10, w: 50, h: 20 })
  assert.deepEqual(r.extent, [90, 20])
  const named = listLayout(items, { w: 200, h: 40 }, { direction: 'Vertical', padding: 0, horizontalAlignment: 'Left', verticalAlignment: 'Top', sortOrder: 'Name', mainFlex: 'None', crossFlex: 'None', wraps: false })
  assert.equal(named.rects.get(2)!.y, 0)
  assert.equal(named.rects.get(1)!.y, 20)
  const fill = listLayout(
    [
      { id: 1, size: [50, 20], layoutOrder: 1, name: 'A', index: 0 },
      { id: 2, size: [50, 20], layoutOrder: 2, name: 'B', index: 1, grow: 1 }
    ],
    { w: 200, h: 20 },
    { direction: 'Horizontal', padding: 0, horizontalAlignment: 'Left', verticalAlignment: 'Top', sortOrder: 'LayoutOrder', mainFlex: 'None', crossFlex: 'None', wraps: false }
  )
  assert.equal(fill.rects.get(2)!.w, 150)
})

test('UIGridLayout fills rows by whole cells (44px fits four 9px cells, not five)', () => {
  const items: ListItem[] = Array.from({ length: 10 }, (_, i) => ({ id: i + 1, size: [0, 0] as [number, number], layoutOrder: i + 1, name: '', index: i }))
  const r = gridLayout(items, { w: 44, h: 18 }, { cell: [9, 9], padding: [0, 0], direction: 'Horizontal', maxCells: 0, horizontalAlignment: 'Left', verticalAlignment: 'Top', sortOrder: 'LayoutOrder' })
  assert.deepEqual(r.rects.get(5), { x: 0, y: 9, w: 9, h: 9 })
  assert.deepEqual(r.rects.get(10), { x: 9, y: 18, w: 9, h: 9 })
  assert.deepEqual(r.extent, [36, 27])
})

test('AutomaticSize, list layout in a tree, TextScaled and draw order', () => {
  const { tree, add } = scene()
  add(10, 'Frame', 'List', 2, { Position: U2(0, 20, 0, 30), Size: U2(0, 100, 0, 0), AutomaticSize: EN('AutomaticSize', 'Y') })
  add(11, 'UIListLayout', 'UIListLayout', 10, { Padding: UD(0, 5), SortOrder: EN('SortOrder', 'LayoutOrder') })
  add(12, 'UIPadding', 'UIPadding', 10, { PaddingTop: UD(0, 4), PaddingBottom: UD(0, 4) })
  for (let i = 0; i < 3; i++) add(20 + i, 'Frame', `Row${i}`, 10, { Size: U2(1, 0, 0, 20), LayoutOrder: 3 - i, ZIndex: i === 0 ? 5 : 1 })
  add(30, 'TextLabel', 'Title', 2, { Size: U2(0, 200, 0, 50), Text: 'Hi', TextScaled: true })
  const { boxes } = layoutTree(tree, { viewport: { w: 800, h: 600 }, measure: approxMeasure })
  // 3 rows of 20 + 2 gaps of 5 + padding 8 = 78.
  assert.deepEqual([boxes.get(10)!.x, boxes.get(10)!.y, boxes.get(10)!.w, boxes.get(10)!.h], [20, 30, 100, 78])
  assert.equal(boxes.get(22)!.y, 34) // LayoutOrder 1 first, below the top padding
  assert.equal(boxes.get(20)!.y, 84)
  // Draw order: ZIndex then child order (Row0 has ZIndex 5, so last).
  assert.deepEqual(boxes.get(10)!.draw, [21, 22, 20])
  // TextScaled: 2 glyphs at 0.5em must fit 200x50 -> limited by height (50).
  assert.equal(boxes.get(30)!.textSize, 50)
  assert.equal(fitTextSize('Hello world', undefined, { w: 55, h: 100 }, false, approxMeasure), 10)
})

test('ClipsDescendants and rotation keep boxes unrotated; UIScale scales offsets', () => {
  const { tree, add } = scene()
  add(10, 'Frame', 'Scaled', 2, { Size: U2(0, 100, 0, 50) })
  add(11, 'UIScale', 'UIScale', 10, { Scale: 2 })
  add(12, 'Frame', 'Child', 10, { Position: U2(0, 10, 0, 10), Size: U2(0, 20, 0, 20), Rotation: 30 })
  const { boxes } = layoutTree(tree, { viewport: { w: 800, h: 600 } })
  assert.deepEqual([boxes.get(10)!.w, boxes.get(10)!.h], [200, 100])
  assert.deepEqual([boxes.get(12)!.x, boxes.get(12)!.y, boxes.get(12)!.w, boxes.get(12)!.rotation], [20, 20, 40, 30])
})

// ---- protocol

test('preview lines parse; ops build a tree with stable ids and relative paths', () => {
  assert.equal(parsePreviewLine('not json'), null)
  assert.equal(parsePreviewLine('{"type":"frame","n":3}'), null, 'lines without forge=1 are ignored')
  const line = parsePreviewLine(JSON.stringify({ forge: 1, type: 'ops', ops: [{ op: 'create', id: 1, cls: 'ScreenGui', name: 'ForgePreview' }] }))
  assert.equal(line?.type, 'ops')
  const { tree, add } = scene()
  add(3, 'Frame', 'Hud', 2)
  add(4, 'TextButton', 'Go', 3, { Text: 'Go' })
  assert.equal(tree.relativePath(4), 'Hud.Go')
  tree.apply([{ op: 'set', id: 4, k: 'Text', v: 'Went' }, { op: 'set', id: 4, k: 'Name', v: 'Gone' }])
  assert.equal(tree.get(4)!.props.Text, 'Went')
  assert.equal(tree.relativePath(4), 'Hud.Gone')
  tree.apply([{ op: 'destroy', id: 3 }])
  assert.equal(tree.get(4), undefined, 'destroy removes the subtree')
  const copy = PreviewTree.from(tree.snapshot())
  assert.deepEqual(copy.snapshot(), tree.snapshot())
})

test('error locations point at project files, not the runtime or Packages', () => {
  const text = 'resources/lune/forge/world.luau:12: boom\nPackages/_Index/centau_vide@0.4.0/vide/src/create.luau:40\nsrc/shared/Interface/Stories/Hud.story.luau:88 function story'
  assert.deepEqual(errorLocation(text), { file: 'src/shared/Interface/Stories/Hud.story.luau', line: 88 })
})

test('Luau literals for edits', () => {
  assert.equal(luauLiteral(U2(0, 10, 0, 20)), 'UDim2.fromOffset(10, 20)')
  assert.equal(luauLiteral(U2(1, 0, 0.5, 0)), 'UDim2.fromScale(1, 0.5)')
  assert.equal(luauLiteral(U2(1, -10, 0, 4)), 'UDim2.new(1, -10, 0, 4)')
  assert.equal(luauLiteral(C3(1, 0.5, 0)), 'Color3.fromRGB(255, 128, 0)')
  assert.equal(luauLiteral(EN('TextXAlignment', 'Left')), 'Enum.TextXAlignment.Left')
  assert.equal(luauLiteral('say "hi"'), '"say \\"hi\\""')
})

test('session model folds lines and keeps console locations', () => {
  const m = new SessionModel('/p')
  m.apply({ type: 'ops', ops: [{ op: 'create', id: 1, cls: 'ScreenGui', name: 'ForgePreview' }] })
  m.apply({ type: 'log', level: 'error', text: '/p/src/x.story.luau:3: bad' })
  assert.equal(m.tree.nodes.size, 1)
  assert.equal(m.console[0].level, 'error')
  assert.equal(m.console[0].line, 3)
})

// ---- text, fonts, images, paint

test('rich text runs', () => {
  const runs = parseRichText('a <b>bold</b> <font color="#FF0000" size="20">red</font>&lt;3<br/>x')
  assert.deepEqual(runs.map((r) => r.text), ['a ', 'bold', ' ', 'red', '<3\nx'])
  assert.equal(runs[1].style.bold, true)
  assert.equal(runs[3].style.color, '#FF0000')
  assert.equal(runs[3].style.size, 20)
})

test('fonts map to bundled substitutes; images to thumbnails', () => {
  const gotham = cssFont({ t: 'Font', family: 'rbxasset://fonts/families/GothamSSm.json', weight: 'Heavy', style: 'Italic' })
  assert.match(gotham.family, /^"Montserrat"/)
  assert.equal(gotham.weight, 900)
  assert.equal(gotham.style, 'italic')
  assert.deepEqual(parseImage('rbxassetid://123'), { kind: 'asset', id: '123' })
  const thumb = parseImage('rbxthumb://type=AvatarHeadShot&id=156&w=48&h=48')
  assert.equal(thumb.kind, 'thumb')
  assert.match(thumbnailRequest(thumb)!, /^https:\/\/thumbnails\.roblox\.com\/v1\/users\/avatar-headshot\?userIds=156&size=48x48/)
  assert.match(thumbnailRequest(parseImage('rbxassetid://123'))!, /^https:\/\/thumbnails\.roblox\.com\/v1\/assets\?assetIds=123/)
  assert.deepEqual(parseThumbnailResponse({ data: [{ targetId: 1, state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/x' }] }), { state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/x' })
})

test('image resolver: thumbnails API, placeholders without network', async () => {
  const calls: string[] = []
  const r = new ImageResolver({
    root: () => null,
    fetch: async (url: string) => {
      calls.push(url)
      return { ok: true, status: 200, json: async () => ({ data: [{ state: 'Completed', imageUrl: 'https://tr.rbxcdn.com/abc' }] }) } as never
    }
  })
  const out = await r.resolveAll(['rbxassetid://5', 'rbxassetid://5', 'rbxasset://textures/ui/x.png'])
  assert.equal(out['rbxassetid://5'].url, 'https://tr.rbxcdn.com/abc')
  assert.equal(out['rbxasset://textures/ui/x.png'].state, 'placeholder')
  assert.equal(calls.length, 1, 'deduped')
})

test('UIGradient: hard stops survive and colours multiply the base', () => {
  const g = gradientFromProps({ Color: { t: 'ColorSequence', v: [[0, 1, 1, 0], [0.5, 1, 1, 0], [0.5, 0, 0.5, 1], [1, 0, 0.5, 1]] }, Rotation: 90 })
  assert.equal(g.stops.length, 4)
  const css = cssGradient(g, [1, 1, 1], 1)
  assert.match(css, /^linear-gradient\(180deg, rgb\(255, 255, 0\) 0\.00%, rgb\(255, 255, 0\) 50\.00%, rgb\(0, 128, 255\) 50\.00%/)
  assert.match(cssGradient(g, [0.5, 0.5, 0.5], 0.5), /rgba\(128, 128, 0, 0\.5\)/)
})

// ---- story discovery and the tool

test('stories group under storybooks by instance path (names contain dots)', () => {
  assert.equal(isStoryFile('a/B.story.luau'), true)
  assert.equal(storyName('a/B.story.luau'), 'B')
  const books = groupStories(
    [
      { file: 'a/Hud.story.luau', path: ['ReplicatedStorage', 'UI', 'Stories', 'Hud.story'] },
      { file: 'a/Shop/Card.story.luau', path: ['ReplicatedStorage', 'UI', 'Stories', 'Shop', 'Card.story'] },
      { file: 'b/Loose.story.luau', path: ['ServerStorage', 'Loose.story'] }
    ],
    [{ file: 'a/UI.storybook.luau', path: [], name: 'Game UI', roots: ['ReplicatedStorage.UI.Stories'] }],
    'default.project.json'
  )
  assert.equal(books[0].name, 'Game UI')
  assert.deepEqual(books[0].stories.map((s) => [s.name, s.folder ?? '']), [['Hud', ''], ['Card', 'Shop']])
  assert.equal(books[1].name, 'Unknown stories')
})

test('preview_ui resolves stories, clicks by name and returns an outline with the PNG', async () => {
  const { tree, add } = scene()
  add(3, 'Frame', 'Hud', 2, { Size: U2(0, 300, 0, 100) })
  add(4, 'TextButton', 'BOOSTButton', 3, { Size: U2(0, 80, 0, 30), Text: 'BOOST' })
  assert.equal(findNode(tree, 'BOOSTButton'), 4)
  assert.equal(findNode(tree, 'Hud.BOOSTButton'), 4)
  const list = { luneAvailable: true, storybooks: [{ name: 'UI', stories: [{ file: HUD, name: 'RacingHud', path: [], projectFile: 'default.project.json' }] }] }
  assert.equal(await resolveStory('racinghud', list), HUD)
  assert.equal(await resolveStory('nope', list), null)
  assert.deepEqual(imageRefs({ root: 1, nodes: [{ id: 9, cls: 'ImageLabel', name: 'A', parent: 1, children: [], props: { Image: 'rbxassetid://1' } }] }), ['rbxassetid://1'])
  const [tool] = previewTools({
    stories: async () => list,
    render: async (r) => ({ file: r.file, tree: tree.snapshot(), console: [], kind: 'vide', clicked: r.clicks ?? [], missing: [] }),
    images: async () => ({}),
    capture: async () => Buffer.from('png'),
    chatImage: async () => '[image:1]'
  })
  const out = await tool.handler({ story: 'RacingHud', clicks: ['BOOSTButton'] })
  const text = out.content[0].type === 'text' ? out.content[0].text : ''
  assert.match(text, /clicked: BOOSTButton/)
  assert.match(text, /BOOSTButton TextButton "BOOST" @0,0 80x30/)
  assert.deepEqual(out.content[1], { type: 'image', data: Buffer.from('png').toString('base64'), mimeType: 'image/png' })
  assert.equal(exportName('../../x.svg'), 'x.svg')
  assert.throws(() => exportName('x.exe'))
})

// ---- Edit mode

const hudSource = readFileSync(resolve(FIXTURE, HUD), 'utf8')

test('edit: replaces a literal, inserts a missing prop, refuses computed values', () => {
  const size = planPropertyEdit(hudSource, { name: 'Unit', cls: 'TextLabel' }, 'TextSize', 16)
  assert.ok(size.ok)
  assert.equal(size.how, 'replace')
  assert.match(applyEdit(hudSource, size.edit), /Name = "Unit",.*TextSize = 16,/)
  const ins = planPropertyEdit(hudSource, { name: 'LapCard', cls: 'Frame' }, 'Rotation', 5)
  assert.ok(ins.ok)
  assert.equal(ins.how, 'insert')
  assert.match(applyEdit(hudSource, ins.edit), /Name = "LapCard",\n\t*Rotation = 5,\n/)
  const computed = planPropertyEdit(hudSource, { name: 'Speed', cls: 'TextLabel' }, 'Text', '99')
  assert.equal(computed.ok, false)
  assert.ok(!computed.ok && /computed in code/.test(computed.reason) && computed.expression?.startsWith('function()'))
  // Value match when the name is built in code: Text = "BOOST" is unique.
  const src = 'local label = "x"\nreturn create "TextLabel" { Name = label .. "!", Text = "BOOST" }\n-- Text = "BOOST" in a comment\n'
  const vm1 = planPropertyEdit(src, { name: 'x!', cls: 'TextLabel', current: 'BOOST' }, 'Text', 'NITRO')
  assert.ok(vm1.ok && vm1.how === 'value-match')
  assert.match(applyEdit(src, vm1.edit), /Text = "NITRO" }/)
  assert.match(applyEdit(src, vm1.edit), /-- Text = "BOOST" in a comment/)
})

test('edit scanner ignores strings and comments', () => {
  assert.equal(codeMask('a = "x{y}" -- }\nb').length, 'a = "x{y}" -- }\nb'.length)
  assert.doesNotMatch(codeMask('a = "x{y}" -- }\nb'), /[{}]/)
  assert.ok(isLiteralExpression('UDim2.new(1, -10, 0, 4)'))
  assert.ok(isLiteralExpression('Color3.fromHex("#ff00aa")'))
  assert.ok(!isLiteralExpression('Theme.Accent'))
  assert.ok(!isLiteralExpression('function() return 1 end'))
})

// ---- Figma interchange

function hudLikeTree() {
  const { tree, add } = scene()
  add(3, 'Frame', 'Card', 2, { Position: U2(0, 100, 0, 50), Size: U2(0, 200, 0, 120), BackgroundColor3: C3(0.1, 0.2, 0.3) })
  add(4, 'UICorner', 'UICorner', 3, { CornerRadius: UD(0, 6) })
  add(5, 'UIListLayout', 'UIListLayout', 3, { Padding: UD(0, 4), SortOrder: EN('SortOrder', 'LayoutOrder') })
  add(6, 'TextLabel', 'Title', 3, { Size: U2(1, 0, 0, 30), Text: 'LAP', TextSize: 18, TextColor3: C3(1, 1, 1), BackgroundTransparency: 1 })
  add(7, 'Frame', 'Bar', 3, { Size: U2(1, 0, 0, 10), BackgroundColor3: C3(1, 0.8, 0) })
  add(8, 'UIGradient', 'UIGradient', 7, { Color: { t: 'ColorSequence', v: [[0, 1, 1, 1], [1, 0.5, 0.5, 0.5]] } })
  add(9, 'Frame', 'Badge', 2, { Position: U2(1, -10, 0, 10), AnchorPoint: V2(1, 0), Size: U2(0, 40, 0, 40), Rotation: 15 })
  return tree
}

function hudDoc(): ForgeUiDoc {
  const tree = hudLikeTree()
  const layout = layoutTree(tree, { viewport: { w: 800, h: 600 }, measure: approxMeasure })
  return forgeDoc(tree, layout, { story: HUD, viewport: { w: 800, h: 600 } })
}

test('Forge JSON: geometry, list layout, corner, gradient, text; SVG export', () => {
  const doc = hudDoc()
  assert.equal(doc.format, 'forge-ui')
  const card = doc.root.children.find((c) => c.name === 'Card')!
  assert.deepEqual([card.x, card.y, card.w, card.h, card.corner], [100, 50, 200, 120, 6])
  assert.equal(card.layout?.kind, 'list')
  assert.equal(card.layout?.gap, 4)
  const title = card.children.find((c) => c.name === 'Title')!
  assert.equal(title.text?.content, 'LAP')
  assert.equal(title.path, 'Card.Title')
  assert.equal(card.children.find((c) => c.name === 'Bar')!.gradient?.stops.length, 2)
  const badge = doc.root.children.find((c) => c.name === 'Badge')!
  assert.deepEqual([badge.x, badge.y, badge.rotation], [750, 10, 15])
  const svg = forgeSvg(doc)
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="800" height="600"/)
  assert.match(svg, /<linearGradient id="g\d+"/)
  assert.match(svg, /rotate\(15 770 30\)/)
  assert.match(svg, />LAP<\/tspan>/)
  assert.throws(() => parseForgeDoc('{"format":"other"}'), /Not a Forge UI document/)
})

test('Figma diff: literal changes vs structural ones', () => {
  const before = hudDoc()
  const after: ForgeUiDoc = JSON.parse(JSON.stringify(before))
  const card = after.root.children.find((c) => c.name === 'Card')!
  card.x += 20 // moved: Position offset +20
  card.fill = { color: '#FF0000', opacity: 1 }
  card.children.find((c) => c.name === 'Title')!.text!.content = 'LAP 2'
  card.corner = 12
  card.children.push({ ...card.children[0], id: 0, path: '', name: 'NewLabel', children: [] })
  const d = diffDocs(before, after)
  const props = d.literal.map((c) => `${c.path}.${c.prop}`).sort()
  assert.deepEqual(props, ['Card.BackgroundColor3', 'Card.Position', 'Card.Title.Text'])
  assert.deepEqual(d.literal.find((c) => c.prop === 'Position')!.to, U2(0, 120, 0, 50))
  assert.ok(d.structural.some((s) => /corner radius 6 -> 12/.test(s)))
  assert.ok(d.structural.some((s) => /added Frame "NewLabel"/.test(s)) || d.structural.some((s) => /added TextLabel "NewLabel"/.test(s)))
})

// A small fake of the Figma plugin API: enough for code.js to import a Forge JSON frame and export it.
function fakeFigma() {
  let nextId = 1
  const page: any = { type: 'PAGE', children: [] as any[], selection: [] as any[], appendChild(n: any) { n.parent?.children?.splice(n.parent.children.indexOf(n), 1); n.parent = page; page.children.push(n) } }
  const node = (type: string) => {
    const data: Record<string, string> = {}
    const n: any = {
      id: `1:${nextId++}`, type, name: type, visible: true, x: 0, y: 0, width: 100, height: 100, children: [] as any[], fills: [], strokes: [], strokeWeight: 1, cornerRadius: 0,
      layoutMode: 'NONE', itemSpacing: 0, counterAxisSpacing: null, layoutWrap: 'NO_WRAP', primaryAxisAlignItems: 'MIN', counterAxisAlignItems: 'MIN', paddingTop: 0, paddingRight: 0, paddingBottom: 0, paddingLeft: 0, clipsContent: false,
      resize(w: number, h: number) { n.width = w; n.height = h },
      setPluginData(k: string, v: string) { data[k] = v },
      getPluginData(k: string) { return data[k] ?? '' },
      appendChild(c: any) { c.parent?.children?.splice(c.parent.children.indexOf(c), 1); c.parent = n; n.children.push(c) }
    }
    let rt: number[][] | null = null
    Object.defineProperty(n, 'relativeTransform', { get: () => rt ?? [[1, 0, n.x], [0, 1, n.y]], set: (v) => { rt = v; n.x = v[0][2]; n.y = v[1][2] } })
    return n
  }
  const posted: any[] = []
  const figma: any = {
    mixed: Symbol('mixed'),
    currentPage: page,
    viewport: { center: { x: 0, y: 0 }, scrollAndZoomIntoView() {} },
    showUI() {},
    notify() {},
    closePlugin() {},
    ui: { postMessage: (m: any) => posted.push(m), onmessage: null as any },
    createFrame: () => node('FRAME'),
    createRectangle: () => node('RECTANGLE'),
    createText: () => node('TEXT'),
    loadFontAsync: async () => {},
    createImage: () => ({ hash: 'h' }),
    base64Decode: () => new Uint8Array()
  }
  return { figma, posted, page }
}

test('Figma plugin (compiled code.js) imports Forge JSON and exports it back unchanged', async () => {
  const code = readFileSync(resolve(import.meta.dirname, '..', 'figma-plugin', 'code.js'), 'utf8')
  const { figma, posted, page } = fakeFigma()
  vm.runInNewContext(code, { figma, __html__: '', console, Symbol, JSON, Math, Object, Array, Map, Error, Date, Number, String, parseInt, Promise })
  const doc = hudDoc()
  await figma.ui.onmessage({ type: 'import', json: JSON.stringify(doc) })
  assert.equal(posted.at(-1).type, 'imported', JSON.stringify(posted.at(-1)))
  const root = page.children[0]
  const card = root.children.find((c: any) => c.name === 'Card')
  assert.equal(card.layoutMode, 'VERTICAL', 'UIListLayout -> auto layout')
  assert.equal(card.itemSpacing, 4)
  assert.equal(card.cornerRadius, 6)
  assert.equal(JSON.parse(card.getPluginData('forge')).path, 'Card')
  assert.equal(card.children.find((c: any) => c.name === 'Bar').fills[0].type, 'GRADIENT_LINEAR')
  // Export the untouched frame: the diff against Forge's own export is empty.
  page.selection = [root]
  await figma.ui.onmessage({ type: 'export' })
  const out = posted.at(-1)
  assert.equal(out.type, 'exported', JSON.stringify(out))
  const back = parseForgeDoc(out.json)
  const d = diffDocs(doc, back)
  assert.deepEqual(d.literal, [])
  assert.deepEqual(d.structural.filter((s) => !/padding|layout/.test(s)), [])
  // A text edit in Figma comes back as a literal Text change.
  const title = card.children.find((c: any) => c.name === 'Title')
  title.children.find((c: any) => c.name === '#text').characters = 'LAP 2'
  await figma.ui.onmessage({ type: 'export' })
  const d2 = diffDocs(doc, parseForgeDoc(posted.at(-1).json))
  assert.deepEqual(d2.literal.map((c) => [c.path, c.prop, c.to]), [['Card.Title', 'Text', 'LAP 2']])
})

test('outline lists visible elements with rects', () => {
  const tree = hudLikeTree()
  const lines = outline(tree.snapshot(), { w: 800, h: 600 })
  assert.equal(lines[0], 'Card Frame @100,50 200x120')
  assert.ok(lines.some((l) => l.trim() === 'Title TextLabel "LAP" @100,50 200x30'))
})

void ([] as UiOp[])
