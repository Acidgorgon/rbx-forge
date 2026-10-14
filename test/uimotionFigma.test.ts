// Figma -> Roblox mapping (fixtures in test/fixtures/figma: REST "file nodes" responses) and the
// Figma REST client against a fake fetch: link parsing, the X-Figma-Token header, node / render /
// image-fill endpoints, 403 / 404 / 429 handling and the response cache.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { mapFigmaNode, walkInst, gradientProps, type UiInst } from '../src/shared/uimotion/figma/map.ts'
import { mapFont, robloxWeight } from '../src/shared/uimotion/figma/fonts.ts'
import { FigmaRest, FigmaRestError, normalizeNodeId, parseFigmaUrl, type FetchLike } from '../src/shared/uimotion/figma/rest.ts'
import { handlesFromTransform, parseForgeFigmaDoc, type FigmaNode } from '../src/shared/uimotion/figma/types.ts'
import { sendSelection, serialize } from '../figma-plugin/send.ts'

const FIX = resolve(import.meta.dirname, 'fixtures', 'figma')
const load = (f: string) => JSON.parse(readFileSync(join(FIX, f), 'utf8'))
const play = load('play-button.nodes.json').nodes['12:34'].document as FigmaNode
const card = load('settings-card.nodes.json').nodes['40:1'].document as FigmaNode

function byPath(root: UiInst): Record<string, UiInst> {
  const out: Record<string, UiInst> = {}
  walkInst(root, (i, p) => (out[p || '(root)'] = i))
  return out
}
const v = (x: unknown) => (x as { v: unknown }).v

test('auto layout: UIListLayout + UIPadding, alignment, space-between, fill / hug sizing', () => {
  const { root } = mapFigmaNode(card)
  const m = byPath(root)
  const list = m['UIListLayout']
  assert.equal((list.props.FillDirection as { v: string }).v, 'Vertical')
  assert.equal((list.props.VerticalFlex as { v: string }).v, 'SpaceBetween')
  assert.deepEqual(v(m['UIPadding'].props.PaddingLeft), [0, 16])
  // FILL on the cross axis = full width; HUG text = AutomaticSize.
  assert.deepEqual(v(m['Title'].props.Size), [1, 0, 0, 28])
  assert.equal((m['Title'].props.AutomaticSize as { v: string }).v, 'Y')
  assert.deepEqual(v(m['Save Button'].props.Size), [1, 0, 0, 48])
  assert.equal(m['Save Button'].props.LayoutOrder, 3)
  // The hidden layer is skipped.
  assert.ok(!m['Hidden'])
  // Horizontal auto layout with an absolute child: flow children move into a Flow frame.
  const p = byPath(mapFigmaNode(play, { name: 'PlayButton' }).root)
  assert.equal((p['Body.Flow.UIListLayout'].props.FillDirection as { v: string }).v, 'Horizontal')
  assert.deepEqual(v(p['Body.Flow.UIListLayout'].props.Padding), [0, 12])
  assert.deepEqual(v(p['Body.Flow.UIPadding'].props.PaddingRight), [0, 28])
  assert.ok(p['Body.Badge'], 'absolute child stays outside the flow')
})

test('gradients: linear handles -> UIGradient rotation, colour and transparency keypoints', () => {
  const m = byPath(mapFigmaNode(card).root)
  const g = m['UIGradient'].props
  assert.equal(g.Rotation, 51)
  assert.deepEqual(v(g.Color), [[0, 0.1, 0.1, 0.2], [0.5, 0.2, 0.1, 0.4], [1, 0.05, 0.05, 0.1]])
  assert.deepEqual(v(g.Transparency), [[0, 0], [0.5, 0.2], [1, 0]])
  // Top-to-bottom gradient in the play button = Rotation 90.
  const p = byPath(mapFigmaNode(play, { name: 'PlayButton' }).root)
  assert.equal(p['Body.UIGradient'].props.Rotation, 90)
  // A left-to-right gradient needs no rotation.
  const lr = gradientProps({ type: 'GRADIENT_LINEAR', gradientHandlePositions: [{ x: 0, y: 0.5 }, { x: 1, y: 0.5 }, { x: 0, y: 1 }], gradientStops: [{ position: 0, color: { r: 1, g: 0, b: 0, a: 1 } }, { position: 1, color: { r: 0, g: 0, b: 1, a: 1 } }] }, 100, 40)!
  assert.equal(lr.rotation, 0)
  // Plugin gradientTransform -> handles (identity maps to left-to-right).
  const h = handlesFromTransform([[1, 0, 0], [0, 1, 0]])
  assert.ok(Math.abs(h[0].x) < 1e-9 && Math.abs(h[0].y - 0.5) < 1e-9 && Math.abs(h[1].x - 1) < 1e-9)
})

test('text: font families with the fallback table, weights, case, alignment, auto size', () => {
  const p = byPath(mapFigmaNode(play, { name: 'PlayButton' }).root)
  const label = p['Body.Flow.Label'].props
  assert.equal(label.Text, 'PLAY NOW')
  assert.deepEqual(label.FontFace, { t: 'Font', family: 'rbxasset://fonts/families/BuilderSans.json', weight: 'ExtraBold', style: 'Normal' })
  assert.equal((label.AutomaticSize as { v: string }).v, 'XY')
  assert.equal((p['Body.Flow.Label.UIStroke'].props.ApplyStrokeMode as { v: string }).v, 'Contextual')
  const c = byPath(mapFigmaNode(card).root)
  assert.equal(c['Save Button.Label'].props.Text, 'Save Changes')
  assert.equal((c['Title'].props.FontFace as { family: string }).family, 'rbxasset://fonts/families/RobotoMono.json')
  // Fallbacks.
  assert.equal(mapFont('Inter', 400).family, 'BuilderSans')
  assert.equal(mapFont('Helvetica Neue', 700).family, 'Arimo')
  assert.equal(mapFont('Gotham', 400).exact, true)
  assert.equal(mapFont('JetBrains Mono').family, 'RobotoMono')
  assert.equal(mapFont('Totally Custom Display').family, 'BuilderSans')
  assert.equal(mapFont('Inter', 400, true).style, 'Italic')
  assert.equal(robloxWeight(650), 'SemiBold')
  assert.equal(robloxWeight(900), 'Heavy')
})

test('effects, strokes, corners and images, with the mapping report', () => {
  const r = mapFigmaNode(play, { name: 'PlayButton' })
  const p = byPath(r.root)
  assert.equal(r.root.className, 'TextButton')
  assert.ok(p['Shadow1'] && p['Shadow2'] && p['Shadow3'], 'drop shadow approximated by stacked frames')
  assert.deepEqual(v(p['Body.UICorner'].props.CornerRadius), [0, 18])
  assert.equal(p['Body.UIStroke'].props.Thickness, 3)
  assert.deepEqual(v(p['Body.Badge.UICorner'].props.CornerRadius), [0.5, 0])
  assert.equal(p['Body.Flow.Icon'].className, 'ImageLabel')
  assert.deepEqual(r.report.images.map((i) => [i.kind, i.ref]), [['render', '12:35']])
  assert.match(r.report.summary, /approximated: .*drop shadow/)
  assert.match(r.report.summary, /dropped: .*background blur/)
  const c = mapFigmaNode(card)
  const m = byPath(c.root)
  assert.equal(m['Avatar'].className, 'ImageLabel')
  assert.equal((m['Avatar'].props.ScaleType as { v: string }).v, 'Crop')
  assert.deepEqual(c.report.images.map((i) => [i.key, i.file]), [['fill:abc123ref', 'art/ui/settings-card/avatar.png']])
  assert.equal(m['Save Button'].className, 'TextButton', 'named like a button')
  const what = c.report.notes.map((n) => `${n.level}:${n.what}`)
  for (const x of ['dropped:inner shadow', 'approx:per-corner radius', 'approx:inside stroke', 'dropped:underline']) assert.ok(what.includes(x), `${x} in ${what.join(', ')}`)
})

test('constraints: anchor point and size per constraint, scale vs offset', () => {
  const frame = (h: string, vv: string, x: number, y: number, w: number, hh: number): FigmaNode =>
    ({ id: `9:${h}${vv}`, name: `${h}-${vv}`, type: 'FRAME', absoluteBoundingBox: { x, y, width: w, height: hh }, constraints: { horizontal: h, vertical: vv }, fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1, a: 1 } }] }) as FigmaNode
  const parent: FigmaNode = {
    id: '9:1',
    name: 'Panel',
    type: 'FRAME',
    absoluteBoundingBox: { x: 0, y: 0, width: 400, height: 200 },
    children: [frame('LEFT', 'TOP', 10, 20, 50, 30), frame('RIGHT', 'BOTTOM', 340, 160, 50, 30), frame('CENTER', 'CENTER', 175, 85, 50, 30), frame('SCALE', 'SCALE', 40, 20, 200, 100), frame('LEFT_RIGHT', 'TOP_BOTTOM', 10, 10, 380, 180)]
  }
  const m = byPath(mapFigmaNode(parent, { interactive: 'none' }).root)
  assert.deepEqual(v(m['LEFT-TOP'].props.Position), [0, 10, 0, 20])
  assert.deepEqual(v(m['LEFT-TOP'].props.Size), [0, 50, 0, 30])
  assert.deepEqual(v(m['RIGHT-BOTTOM'].props.AnchorPoint), [1, 1])
  assert.deepEqual(v(m['RIGHT-BOTTOM'].props.Position), [1, -10, 1, -10])
  assert.deepEqual(v(m['CENTER-CENTER'].props.AnchorPoint), [0.5, 0.5])
  assert.deepEqual(v(m['CENTER-CENTER'].props.Position), [0.5, 0, 0.5, 0])
  assert.deepEqual(v(m['SCALE-SCALE'].props.Size), [0.5, 0, 0.5, 0])
  assert.deepEqual(v(m['SCALE-SCALE'].props.Position), [0.1, 0, 0.1, 0])
  assert.deepEqual(v(m['LEFT_RIGHT-TOP_BOTTOM'].props.Size), [1, -20, 1, -20])
})

test('plugin documents: format check and the embedded images map', () => {
  const doc = parseForgeFigmaDoc(JSON.stringify({ format: 'forge-figma', version: 1, source: { kind: 'plugin', nodeId: '12:34', nodeName: 'Play Button' }, root: play, images: { 'node:12:35': 'iVBORw0KGgo=' } }))
  assert.equal(doc.root.name, 'Play Button')
  assert.equal(doc.images['node:12:35'], 'iVBORw0KGgo=')
  assert.throws(() => parseForgeFigmaDoc('{"format":"forge-ui"}'), /forge-figma/)
  assert.throws(() => parseForgeFigmaDoc('nope'), /Not JSON/)
  assert.throws(() => parseForgeFigmaDoc(JSON.stringify({ format: 'forge-figma', version: 9, root: play })), /newer/)
})

// ---------------------------------------------------------------- REST client

test('links: file / design / proto / branch URLs, dash and %3A node ids', () => {
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Shop-UI?node-id=12-34&t=x'), { fileKey: 'AbCdEf1234567890', nodeId: '12:34', name: 'Shop UI' })
  assert.equal(parseFigmaUrl('https://www.figma.com/file/AbCdEf1234567890/Shop?node-id=12%3A34')!.nodeId, '12:34')
  assert.equal(parseFigmaUrl('figma.com/proto/AbCdEf1234567890/Shop?node-id=1-2&starting-point-node-id=1%3A2')!.nodeId, '1:2')
  assert.deepEqual(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/branch/BrAnCh12345678/Shop?node-id=3-4'), { fileKey: 'AbCdEf1234567890', branchKey: 'BrAnCh12345678', nodeId: '3:4', name: 'Shop' })
  assert.equal(parseFigmaUrl('https://www.figma.com/design/AbCdEf1234567890/Shop')!.nodeId, null)
  assert.equal(parseFigmaUrl('https://example.com/design/AbCdEf1234567890/x'), null)
  assert.equal(parseFigmaUrl('not a link'), null)
  assert.equal(normalizeNodeId('I5:6;7:8'), 'I5:6;7:8')
  assert.equal(normalizeNodeId('5-6'), '5:6')
})

interface Call {
  url: string
  headers?: Record<string, string>
}
function fakeFetch(routes: (url: string, n: number) => { status: number; body?: unknown; headers?: Record<string, string>; bytes?: Uint8Array }): { fetch: FetchLike; calls: Call[] } {
  const calls: Call[] = []
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    const r = routes(url, calls.length)
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      headers: { get: (k: string) => r.headers?.[k.toLowerCase()] ?? null },
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
      arrayBuffer: async () => (r.bytes ?? new Uint8Array()).buffer as ArrayBuffer
    }
  }
  return { fetch, calls }
}

test('rest: GET /v1/files/:key/nodes with X-Figma-Token, cached', async () => {
  const nodes = load('play-button.nodes.json')
  const { fetch, calls } = fakeFetch(() => ({ status: 200, body: nodes }))
  const api = new FigmaRest({ token: ' figd_secret_token_value ', fetch })
  const r = await api.getNode('AbCdEf1234567890', '12-34')
  assert.equal(r.document.name, 'Play Button')
  assert.equal(calls[0].url, 'https://api.figma.com/v1/files/AbCdEf1234567890/nodes?ids=12:34')
  assert.equal(calls[0].headers?.['X-Figma-Token'], 'figd_secret_token_value')
  await api.getNode('AbCdEf1234567890', '12:34')
  assert.equal(calls.length, 1, 'second read comes from the cache')
  await assert.rejects(api.getNode('AbCdEf1234567890', '99:99'), (e: unknown) => e instanceof FigmaRestError && e.status === 404)
  assert.throws(() => new FigmaRest({ token: '', fetch }), /No Figma token/)
})

test('rest: renders (GET /v1/images/:key), image fills (images or meta.images) and downloads', async () => {
  const { fetch, calls } = fakeFetch((url) => {
    if (url.includes('/v1/images/')) return { status: 200, body: { err: null, images: { '12:35': 'https://s3.example/render.png', '12:36': null } } }
    if (url.endsWith('/images')) return { status: 200, body: { error: false, status: 200, meta: { images: { abc123ref: 'https://s3.example/fill.png' } } } }
    if (url.startsWith('https://s3.example/')) return { status: 200, bytes: new Uint8Array([137, 80, 78, 71]) }
    return { status: 404, body: { err: 'Not found' } }
  })
  const api = new FigmaRest({ token: 'FAKE-test-token-value', fetch })
  const renders = await api.renderImages('KEY1234567890', ['12:35', '12-36'], { scale: 9 })
  assert.deepEqual(renders, { '12:35': 'https://s3.example/render.png', '12:36': null })
  assert.match(calls[0].url, /\/v1\/images\/KEY1234567890\?ids=12:35,12:36&format=png&scale=4$/)
  assert.deepEqual(await api.imageFills('KEY1234567890'), { abc123ref: 'https://s3.example/fill.png' })
  const bytes = await api.download('https://s3.example/render.png')
  assert.deepEqual([...bytes], [137, 80, 78, 71])
  assert.equal(calls[calls.length - 1].headers, undefined, 'image downloads carry no token')
  // The documented top-level shape works too.
  const docShape = fakeFetch(() => ({ status: 200, body: { images: { r1: 'https://s3.example/a.png' } } }))
  assert.deepEqual(await new FigmaRest({ token: 'FAKE-test-token-value', fetch: docShape.fetch }).imageFills('K1234567890'), { r1: 'https://s3.example/a.png' })
})

test('rest: 403 / 404 messages, 429 waits Retry-After once then explains the limit', async () => {
  const waits: number[] = []
  const sleep = async (ms: number) => void waits.push(ms)
  const forbidden = fakeFetch(() => ({ status: 403, body: { status: 403, err: 'Invalid token' } }))
  await assert.rejects(new FigmaRest({ token: 'FAKE-bad-test-token', fetch: forbidden.fetch }).getNode('KEY1234567890', '1:2'), /file_content:read.*\(Invalid token\)|Invalid token/)
  let n = 0
  const limited = fakeFetch(() => (++n === 1 ? { status: 429, headers: { 'retry-after': '2' } } : { status: 200, body: { nodes: { '1:2': { document: { id: '1:2', name: 'X', type: 'FRAME' } } } } }))
  const ok = await new FigmaRest({ token: 'FAKE-test-token-value', fetch: limited.fetch, sleep }).getNode('KEY1234567890', '1:2')
  assert.equal(ok.document.name, 'X')
  assert.deepEqual(waits, [2000])
  const always = fakeFetch(() => ({ status: 429, headers: { 'retry-after': '345600' } }))
  await assert.rejects(new FigmaRest({ token: 'FAKE-test-token-value', fetch: always.fetch, sleep }).getNode('KEY1234567890', '1:2'), (e: unknown) => e instanceof FigmaRestError && e.status === 429 && /rate limit.*5760 min/.test(e.message))
})

test('plugin send: any selected node becomes a forge-figma doc with image fills and rendered vectors', async () => {
  const icon = { id: '1:4', name: 'Icon', type: 'VECTOR', width: 16, height: 16, absoluteTransform: [[1, 0, 4], [0, 1, 4]], fills: [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }], strokes: [], effects: [], constraints: { horizontal: 'MIN', vertical: 'STRETCH' }, exportAsync: async () => new Uint8Array([137, 80, 78, 71]) }
  const label = { id: '1:3', name: 'Label', type: 'TEXT', width: 80, height: 20, absoluteTransform: [[1, 0, 20], [0, 1, 14]], fills: Symbol('mixed'), getRangeFills: () => [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 }, opacity: 1 }], strokes: [], effects: [], constraints: { horizontal: 'CENTER', vertical: 'SCALE' }, characters: 'PLAY', fontName: { family: 'Inter', style: 'Semi Bold Italic' }, fontSize: 20, fontWeight: Symbol('mixed'), getRangeFontWeight: () => 600, letterSpacing: { unit: 'PERCENT', value: 10 }, lineHeight: { unit: 'PIXELS', value: 24 }, textCase: 'UPPER', textDecoration: 'UNDERLINE', textAlignHorizontal: 'CENTER', textAlignVertical: 'CENTER', textAutoResize: 'WIDTH_AND_HEIGHT' }
  const frame = { id: '1:2', name: 'Play Button', type: 'INSTANCE', width: 160, height: 48, absoluteTransform: [[1, 0, 0], [0, 1, 0]], opacity: 0.9, clipsContent: true, cornerRadius: Symbol('mixed'), topLeftRadius: 12, topRightRadius: 12, bottomRightRadius: 4, bottomLeftRadius: 4, fills: [{ type: 'GRADIENT_LINEAR', gradientTransform: [[1, 0, 0], [0, 1, 0]], gradientStops: [{ position: 0, color: { r: 0.2, g: 0.6, b: 1, a: 1 } }, { position: 1, color: { r: 0.1, g: 0.4, b: 0.8, a: 1 } }], opacity: 1 }, { type: 'IMAGE', imageHash: 'abc', scaleMode: 'FILL', opacity: 1 }], strokes: [{ type: 'SOLID', color: { r: 0, g: 0, b: 0 }, opacity: 0.3 }], strokeWeight: 2, strokeAlign: 'INSIDE', effects: [{ type: 'DROP_SHADOW', radius: 4, color: { r: 0, g: 0, b: 0, a: 0.4 }, offset: { x: 0, y: 3 }, spread: 0 }], layoutMode: 'HORIZONTAL', itemSpacing: 8, paddingLeft: 16, paddingRight: 16, paddingTop: 12, paddingBottom: 12, primaryAxisAlignItems: 'CENTER', counterAxisAlignItems: 'CENTER', children: [icon, label] }
  const s = serialize(frame)
  assert.deepEqual(s.rectangleCornerRadii, [12, 12, 4, 4])
  assert.equal(s.opacity, 0.9)
  assert.deepEqual(s.children![0].constraints, { horizontal: 'LEFT', vertical: 'TOP_BOTTOM' })
  const t = s.children![1]
  assert.equal(t.style!.fontWeight, 600)
  assert.equal(t.style!.italic, true)
  assert.equal(t.style!.letterSpacing, 2)
  assert.equal(t.style!.lineHeightPx, 24)
  assert.equal(t.fills![0].type, 'SOLID')
  assert.equal(s.fills![0].gradientHandlePositions!.length, 3)
  const api = { currentPage: { name: 'Page 1', selection: [frame] }, root: { name: 'Buttons' }, getImageByHash: () => ({ getBytesAsync: async () => new Uint8Array([1, 2, 3]) }), getNodeByIdAsync: async (id: string) => (id === '1:4' ? icon : null), base64Encode: (b: Uint8Array) => Buffer.from(b).toString('base64') }
  const sent = await sendSelection(api)
  assert.equal(sent.name, 'Play Button')
  assert.deepEqual(sent.missing, [])
  const doc = parseForgeFigmaDoc(sent.json)
  assert.equal(doc.images['fill:abc'], 'AQID')
  assert.ok(doc.images['node:1:4'])
  const { root } = mapFigmaNode(doc.root, { name: 'PlayButton' })
  const classes: string[] = []
  walkInst(root, (i) => classes.push(i.className))
  for (const c of ['UIListLayout', 'UIGradient', 'UIStroke', 'TextLabel', 'ImageLabel']) assert.ok(classes.includes(c), c)
  await assert.rejects(sendSelection({ ...api, currentPage: { selection: [] } }), /Select a frame/)
})
