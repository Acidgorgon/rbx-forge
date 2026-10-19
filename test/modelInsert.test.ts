// Studio inserts from the model inbox (<id>.insert.json -> Forge Bridge plugin v14 insert job): request
// validation, the parent path and Studio window rules, file location rules, the .rbxmx reading the
// plugin falls back to, the job and its blob channel on the bridge, the watcher (idempotence, waiting
// for Studio, errors), the opt-in toggle, and (with Lune) the plugin's own decoding and tree building.
import assert from 'node:assert/strict'
import { execFile, execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { inboxDirs, resolveModelFile } from '../src/main/services/art/modelInbox.ts'
import { INSERT_DONE_SUFFIX, INSERT_RESULT_SUFFIX, InsertInbox, parseInsertRequest, type InsertBridge, type InsertBridgeWindow, type InsertInboxDeps } from '../src/main/services/art/modelInsert.ts'
import { BridgeError, StudioBridge, type EventHandler, type RunOptions } from '../src/main/services/studio/bridge.ts'
import { createIntegrations } from '../src/main/integrations.ts'
import {
  chunkBase64,
  chunkText,
  INSERT_PLUGIN_VERSION,
  insertJob,
  modelFormat,
  parseInsertReport,
  parseParentPath,
  parsePlace,
  pickWindow,
  type InsertProjectPlace,
  readRbxmxTree
} from '../src/shared/studio/insert.ts'
import { PLUGIN_VERSION } from '../src/shared/studio/plugin.ts'
import { parseEvent, type BridgeEvent, type BridgeJob, type InstanceJson } from '../src/shared/studio/protocol.ts'
import type { ModelInboxEntry, ModelInboxStatus } from '../src/shared/artTypes.ts'
import { fakeContext } from './agentFake.ts'

// A small animation save, as Studio writes it: KeyframeSequence > Keyframe > Pose (HumanoidRootPart > LowerTorso).
const ANIM_XML = `<roblox xmlns:xmime="http://www.w3.org/2005/05/xmlmime" version="4">
  <External>null</External>
  <Item class="KeyframeSequence" referent="RBX0">
    <Properties>
      <string name="Name">Run</string>
      <bool name="Loop">true</bool>
      <token name="Priority">2</token>
      <int64 name="SourceAssetId">-1</int64>
    </Properties>
    <Item class="Keyframe" referent="RBX1">
      <Properties>
        <string name="Name">Keyframe</string>
        <float name="Time">0.25</float>
      </Properties>
      <Item class="Pose" referent="RBX2">
        <Properties>
          <string name="Name">HumanoidRootPart</string>
          <CoordinateFrame name="CFrame"><X>0</X><Y>0</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
          <float name="Weight">0</float>
        </Properties>
        <Item class="Pose" referent="RBX3">
          <Properties>
            <string name="Name">LowerTorso</string>
            <CoordinateFrame name="CFrame"><X>0</X><Y>0.5</Y><Z>0</Z><R00>1</R00><R01>0</R01><R02>0</R02><R10>0</R10><R11>1</R11><R12>0</R12><R20>0</R20><R21>0</R21><R22>1</R22></CoordinateFrame>
            <token name="EasingStyle">1</token>
            <token name="EasingDirection">0</token>
            <float name="Weight">1</float>
          </Properties>
        </Item>
      </Item>
      <Item class="KeyframeMarker" referent="RBX4">
        <Properties>
          <string name="Name">Hit</string>
          <string name="Value">left</string>
        </Properties>
      </Item>
    </Item>
  </Item>
</roblox>
`

// A model with the property types the tree path carries, refs inside and outside the file,
// attributes (Number 2.5, String "fire") and a tag ("Hazard").
const PROPS_XML = `<roblox version="4">
  <Item class="Model" referent="M">
    <Properties>
      <string name="Name">Crate</string>
      <Ref name="PrimaryPart">P</Ref>
      <BinaryString name="AttributesSerialize">${attrs()}</BinaryString>
      <BinaryString name="Tags">${Buffer.from('Hazard').toString('base64')}</BinaryString>
    </Properties>
    <Item class="Part" referent="P">
      <Properties>
        <string name="Name">Body</string>
        <Vector3 name="size"><X>4</X><Y>2</Y><Z>4</Z></Vector3>
        <Color3uint8 name="Color3uint8">4278255360</Color3uint8>
        <int name="BrickColor">194</int>
        <bool name="Anchored">true</bool>
        <PhysicalProperties name="CustomPhysicalProperties"><CustomPhysics>false</CustomPhysics></PhysicalProperties>
      </Properties>
      <Item class="Weld" referent="W">
        <Properties>
          <string name="Name">Weld</string>
          <Ref name="Part0">P</Ref>
          <Ref name="Part1">OUTSIDE</Ref>
        </Properties>
      </Item>
      <Item class="ParticleEmitter" referent="E">
        <Properties>
          <string name="Name">Sparks</string>
          <NumberRange name="Lifetime">1 2 </NumberRange>
          <NumberSequence name="Size">0 1 0 1 0.5 0 </NumberSequence>
          <ColorSequence name="Color">0 1 0 0 0 1 0 0 1 0 </ColorSequence>
          <Content name="Texture"><url>rbxassetid://123</url></Content>
        </Properties>
      </Item>
    </Item>
    <Item class="ScreenGui" referent="G">
      <Properties><string name="Name">Gui</string></Properties>
      <Item class="Frame" referent="F">
        <Properties>
          <string name="Name">Bar</string>
          <UDim2 name="Size"><XS>0.5</XS><XO>10</XO><YS>0</YS><YO>20</YO></UDim2>
          <Vector2 name="AnchorPoint"><X>0.5</X><Y>0.5</Y></Vector2>
        </Properties>
      </Item>
    </Item>
  </Item>
</roblox>
`

// AttributesSerialize: count, then (name, type, value): Power = Float64 2.5, Kind = String "fire".
function attrs(): string {
  const parts: Buffer[] = []
  const u32 = (n: number) => {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(n)
    return b
  }
  const str = (s: string) => Buffer.concat([u32(Buffer.byteLength(s)), Buffer.from(s)])
  parts.push(u32(2), str('Power'), Buffer.from([0x06]))
  const f = Buffer.alloc(8)
  f.writeDoubleLE(2.5)
  parts.push(f, str('Kind'), Buffer.from([0x02]), str('fire'))
  return Buffer.concat(parts).toString('base64')
}

const RBXM = Buffer.concat([Buffer.from('<roblox!\x89\xff\x0d\x0a\x1a\x0a\0\0', 'latin1'), Buffer.alloc(200, 7)])

async function tempDocs() {
  const docs = await mkdtemp(join(tmpdir(), 'forge-insert-'))
  const { modelsDir, inboxDir } = inboxDirs(docs)
  await mkdir(inboxDir, { recursive: true })
  return { docs, modelsDir, inboxDir, cleanup: () => rm(docs, { recursive: true, force: true }) }
}
const readJson = async (p: string) => JSON.parse(await readFile(p, 'utf8'))

// ---------------------------------------------------------------- validation

test('insert request: defaults, parent dot path, place, replace; bad requests explain', () => {
  assert.deepEqual(parseInsertRequest(JSON.stringify({ file: 'Run.rbxmx' })), { ok: true, value: { file: 'Run.rbxmx', parent: ['ServerStorage'], place: null, replace: false } })
  assert.deepEqual(parseInsertRequest(JSON.stringify({ file: 'Run.rbxmx', parent: 'ServerStorage.RBX_ANIMSAVES', place: 'MyGame', replace: true })), {
    ok: true,
    value: { file: 'Run.rbxmx', parent: ['ServerStorage', 'RBX_ANIMSAVES'], place: { place: 'MyGame' }, replace: true }
  })
  assert.deepEqual((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', place: 1234 })) as { value: { place: unknown } }).value.place, { placeId: 1234 })
  assert.deepEqual((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', place: '1234' })) as { value: { place: unknown } }).value.place, { placeId: 1234 })
  assert.match((parseInsertRequest('{"file": ') as { error: string }).error, /not valid JSON/)
  assert.match((parseInsertRequest(JSON.stringify({ parent: 'Workspace' })) as { error: string }).error, /file/)
  assert.match((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', parent: 'CoreGui.Thing' })) as { error: string }).error, /must start with one of/)
  assert.match((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', parent: 'ServerStorage..X' })) as { error: string }).error, /empty name/)
  assert.match((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', place: -3 })) as { error: string }).error, /positive whole number/)
  assert.match((parseInsertRequest(JSON.stringify({ file: 'a.rbxm', replace: 'yes' })) as { error: string }).error, /replace/)
  assert.match((parseInsertRequest(JSON.stringify({ file: 'a\n.rbxm' })) as { error: string }).error, /control characters/)
  // Luau spellings of the service.
  assert.deepEqual(parseParentPath('game.Workspace.Props'), { ok: true, value: ['Workspace', 'Props'] })
  assert.deepEqual(parseParentPath('workspace'), { ok: true, value: ['Workspace'] })
  assert.deepEqual(parseParentPath('  '), { ok: true, value: ['ServerStorage'] })
  assert.deepEqual(parsePlace(''), { ok: true, value: null })
})

const PROJECT: InsertProjectPlace[] = [
  { name: 'MyGame', file: 'default.project.json', placeIds: [42] },
  { name: 'menu', file: 'menu.project.json', placeIds: [77], linkIds: [] },
  { name: 'Sandbox', file: 'sandbox.project.json', placeIds: [], linkIds: ['link-abc12345'] }
]

test('insert window: without "place" only windows of the open project\'s places; a named place (project or exact window match) connected once', () => {
  const a: InsertBridgeWindow = { place: 'MyGame', placeId: 42, pluginVersion: PLUGIN_VERSION }
  const b: InsertBridgeWindow = { place: 'Place1', pluginVersion: PLUGIN_VERSION }
  const c: InsertBridgeWindow = { place: 'Place1', pluginVersion: PLUGIN_VERSION }
  const menu: InsertBridgeWindow = { place: 'Main Menu', placeId: 77, pluginVersion: PLUGIN_VERSION }
  const sandbox: InsertBridgeWindow = { place: 'Place2', link: 'link-abc12345', pluginVersion: PLUGIN_VERSION }
  // The bug: a downloaded game file open just to study it.
  const study: InsertBridgeWindow = { place: 'Place_131716211654599.rbxlx', placeId: 131716211654599, pluginVersion: 13 }
  const err = (r: unknown) => (r as { error: string; wait?: true })
  const win = (r: unknown) => (r as { window: InsertBridgeWindow }).window

  assert.match(err(pickWindow([], null, PROJECT)).error, /not connected/)
  assert.equal(err(pickWindow([], null, PROJECT)).wait, true)
  assert.equal(win(pickWindow([a], null, PROJECT)), a)
  assert.equal((pickWindow([a], null, PROJECT) as { projectPlace: InsertProjectPlace }).projectPlace.name, 'MyGame')

  // Only window connected, but not a project place: never used. Waits (the place may still open), names the project places.
  for (const only of [study, b]) {
    const r = err(pickWindow([only], null, PROJECT))
    assert.equal(r.wait, true)
    assert.match(r.error, /No Studio window of this project is connected/)
    assert.match(r.error, /\[not in this project\]/)
    assert.match(r.error, /"MyGame" \(PlaceId 42\), "menu" \(PlaceId 77\), "Sandbox" \(linked unpublished place\)/)
    assert.match(r.error, /"place"/)
  }
  // A project window next to other windows: the project one, whatever connected last.
  assert.equal(win(pickWindow([study, a, b], null, PROJECT)), a)
  // An unpublished place counts only through its Source Control link (never by name).
  assert.equal(win(pickWindow([b, sandbox], null, PROJECT)), sandbox)
  // Several project windows: say which.
  const several = err(pickWindow([a, menu, study], null, PROJECT))
  assert.equal(several.wait, undefined)
  assert.match(several.error, /2 Studio windows of this project are connected \(MyGame \(42\) = MyGame, Main Menu \(77\) = menu\); say which one with "place"/)

  // Explicit place: PlaceId, project place name / file, or the window's Studio name.
  assert.equal(win(pickWindow([a, menu], { placeId: 77 }, PROJECT)), menu)
  assert.equal(win(pickWindow([a, menu], { place: 'menu' }, PROJECT)), menu)
  assert.equal(win(pickWindow([a, menu], { place: 'menu.project.json' }, PROJECT)), menu)
  assert.equal(win(pickWindow([a, menu], { place: 'Main Menu' }, PROJECT)), menu)
  assert.equal(win(pickWindow([a, menu], { place: 'MyGame' }, PROJECT)), a)
  assert.equal(win(pickWindow([b, sandbox], { place: 'Sandbox' }, PROJECT)), sandbox)
  // A window outside the project only when named exactly (PlaceId or Studio name): clear intent.
  const scratch: InsertBridgeWindow = { place: 'RBX FORGE', pluginVersion: PLUGIN_VERSION }
  assert.deepEqual(pickWindow([a, study], { placeId: 131716211654599 }, PROJECT), { window: study, projectPlace: null })
  assert.deepEqual(pickWindow([a, study], { place: 'Place_131716211654599.rbxlx' }, PROJECT), { window: study, projectPlace: null })
  assert.deepEqual(pickWindow([a, scratch], { place: 'RBX FORGE' }, PROJECT), { window: scratch, projectPlace: null })
  assert.equal(win(pickWindow([scratch], { place: 'RBX FORGE' }, null)), scratch, 'no project open')
  assert.equal(win(pickWindow([scratch], { place: 'RBX FORGE' }, [])), scratch, 'project without places')
  assert.match(err(pickWindow([a, b, c], { place: 'Place1' }, PROJECT)).error, /2 Studio windows have "Place1" open/)
  // A project place name wins over a window's Studio name; a Studio name equal to a closed project place's name still matches.
  assert.equal(win(pickWindow([a, { place: 'menu', pluginVersion: PLUGIN_VERSION }, menu], { place: 'menu' }, PROJECT)), menu)
  const namedMenu: InsertBridgeWindow = { place: 'menu', pluginVersion: PLUGIN_VERSION }
  assert.equal(win(pickWindow([a, namedMenu], { place: 'menu' }, PROJECT)), namedMenu)
  // A project place that is not open, or a name nothing has: wait.
  const closed = err(pickWindow([a], { place: 'menu' }, PROJECT))
  assert.equal(closed.wait, true)
  assert.match(closed.error, /No Studio window with project place "menu" \(PlaceId 77\) is connected/)
  const unknown = err(pickWindow([a], { place: 'Other' }, PROJECT))
  assert.equal(unknown.wait, true)
  assert.match(unknown.error, /No Studio window with "Other" is connected \(connected: MyGame \(42\)\); this project's places: "MyGame"/)
  assert.equal(err(pickWindow([a], { placeId: 77 }, PROJECT)).wait, true)
  // Two windows of the same place: ambiguous.
  assert.match(err(pickWindow([a, { ...a }], { placeId: 42 }, PROJECT)).error, /2 Studio windows have PlaceId 42 open/)
  // Without "place", no project open / a project without places: nothing is eligible.
  assert.match(err(pickWindow([a], null, null)).error, /No Forge project is open/)
  assert.equal(err(pickWindow([a], null, null)).wait, true)
  assert.match(err(pickWindow([a], null, [])).error, /no \*\.project\.json place/)
  // An explicit name nothing has, with no project open: waits.
  assert.equal(err(pickWindow([a], { place: 'Other' }, null)).wait, true)
})

test('insert file rules: .rbxm/.rbxmx inside the inbox or ForgeModels; traversal, symlinks, type and size refused', async () => {
  const t = await tempDocs()
  const outside = await mkdtemp(join(tmpdir(), 'forge-outside-'))
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    await mkdir(join(t.modelsDir, 'Anims'), { recursive: true })
    await writeFile(join(t.modelsDir, 'Anims', 'Crate.rbxm'), RBXM)
    await writeFile(join(t.inboxDir, 'Head.fbx'), 'fbx')
    await writeFile(join(t.inboxDir, 'Empty.rbxm'), '')
    await writeFile(join(outside, 'Evil.rbxm'), RBXM)
    await symlink(join(outside, 'Evil.rbxm'), join(t.inboxDir, 'Link.rbxm'))
    const opts = { baseDir: t.inboxDir, roots: [t.inboxDir, t.modelsDir], kind: 'model' as const }
    assert.equal((await resolveModelFile('Run.rbxmx', opts)).ok, true)
    assert.equal((await resolveModelFile(join(t.modelsDir, 'Anims', 'Crate.rbxm'), opts)).ok, true)
    assert.match((await resolveModelFile('Head.fbx', opts) as { error: string }).error, /only \.rbxm and \.rbxmx files are inserted/)
    assert.match((await resolveModelFile('../ForgeModels/Anims/Crate.rbxm', opts) as { error: string }).error, /"\.\." is not allowed/)
    assert.match((await resolveModelFile(join(outside, 'Evil.rbxm'), opts) as { error: string }).error, /model file must be inside/)
    assert.match((await resolveModelFile('Link.rbxm', opts) as { error: string }).error, /links outside/)
    assert.match((await resolveModelFile('Empty.rbxm', opts) as { error: string }).error, /model file is empty/)
    assert.match((await resolveModelFile('Run.rbxmx', { ...opts, maxBytes: 100 }) as { error: string }).error, /Forge sends model files up to/)
    // Uploads still take only FBX.
    assert.match((await resolveModelFile('Run.rbxmx', { baseDir: t.inboxDir, roots: [t.inboxDir] }) as { error: string }).error, /only \.fbx files are uploaded/)
    // The format must match the bytes.
    assert.deepEqual(modelFormat('Crate.rbxm', RBXM), { ok: true, value: 'rbxm' })
    assert.deepEqual(modelFormat('Run.rbxmx', Buffer.from(ANIM_XML)), { ok: true, value: 'rbxmx' })
    assert.match((modelFormat('Crate.rbxm', Buffer.from(ANIM_XML)) as { error: string }).error, /not a binary Roblox model/)
    assert.match((modelFormat('Run.rbxmx', RBXM) as { error: string }).error, /name it \.rbxm/)
    assert.match((modelFormat('Run.rbxmx', Buffer.from('hello')) as { error: string }).error, /not a Roblox XML model/)
  } finally {
    await t.cleanup()
    await rm(outside, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- .rbxmx reading

test('rbxmx tree: animation saves read whole (KeyframeSequence > Keyframe > Pose, markers)', () => {
  const tree = readRbxmxTree(ANIM_XML)
  assert.equal(tree.count, 5)
  assert.deepEqual(tree.unsupported, [])
  const [seq] = tree.roots
  assert.equal(seq.className, 'KeyframeSequence')
  assert.equal(seq.name, 'Run')
  // Studio's bookkeeping (SourceAssetId) is left out.
  assert.deepEqual(seq.props, { Loop: { t: 'bool', v: true }, Priority: { t: 'token', v: 2 } })
  const kf = seq.children[0]
  assert.deepEqual(kf.props.Time, { t: 'number', v: 0.25 })
  const root = kf.children[0]
  assert.equal(root.name, 'HumanoidRootPart')
  assert.deepEqual(root.props.Weight, { t: 'number', v: 0 })
  const lower = root.children[0]
  assert.deepEqual(lower.props.CFrame, { t: 'cframe', v: [0, 0.5, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] })
  assert.deepEqual(lower.props.EasingStyle, { t: 'token', v: 1 })
  assert.deepEqual(kf.children[1], { className: 'KeyframeMarker', name: 'Hit', ref: 'RBX4', props: { Value: { t: 'string', v: 'left' } }, children: [] })
})

test('rbxmx tree: value types, refs inside the file, attributes and tags; the rest is listed', () => {
  const tree = readRbxmxTree(PROPS_XML)
  const [model] = tree.roots
  const find = (n: InstanceJson, name: string): InstanceJson | undefined => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean))
  assert.deepEqual(model.props.PrimaryPart, { t: 'ref', v: 'P' })
  assert.deepEqual(model.attributes, { Power: 2.5, Kind: 'fire' })
  assert.deepEqual(model.tags, ['Hazard'])
  const body = find(model, 'Body')!
  assert.deepEqual(body.props.Size, { t: 'vector3', v: [4, 2, 4] })
  // Color3uint8 0xFF00FF00 is green, and wins over the BrickColor written next to it.
  assert.deepEqual(body.props.Color, { t: 'color3', v: [0, 1, 0] })
  assert.equal(body.props.BrickColor, undefined)
  const weld = find(model, 'Weld')!
  assert.deepEqual(weld.props.Part0, { t: 'ref', v: 'P' })
  assert.equal(weld.props.Part1, undefined, 'a ref to something outside the file is dropped')
  const sparks = find(model, 'Sparks')!
  assert.deepEqual(sparks.props.Lifetime, { t: 'range', v: [1, 2] })
  assert.deepEqual(sparks.props.Size, { t: 'nseq', v: [[0, 1, 0], [1, 0.5, 0]] })
  assert.deepEqual(sparks.props.Color, { t: 'cseq', v: [[0, 1, 0, 0], [1, 0, 0, 1]] })
  assert.deepEqual(sparks.props.Texture, { t: 'string', v: 'rbxassetid://123' })
  const bar = find(model, 'Bar')!
  assert.deepEqual(bar.props.Size, { t: 'udim2', v: [0.5, 10, 0, 20] })
  assert.deepEqual(bar.props.AnchorPoint, { t: 'vector2', v: [0.5, 0.5] })
  assert.deepEqual(tree.unsupported, ['Part.CustomPhysicalProperties (PhysicalProperties)'])
  assert.throws(() => readRbxmxTree('<roblox><Item class="Part"'), /not valid XML|no instances|<roblox>/)
  assert.throws(() => readRbxmxTree('<html></html>'), /no <roblox> element/)
  assert.throws(() => readRbxmxTree('<roblox version="4"></roblox>'), /holds no instances/)
  assert.throws(() => readRbxmxTree('<roblox><Item class="Bad Class"></Item></roblox>'), /bad class/)
})

// ---------------------------------------------------------------- job, chunks, report, protocol

test('insert job: kind, parent, blobs; chunks decode back; the plugin report is read defensively', () => {
  const job = insertJob({ id: 'job-1', file: 'Run.rbxmx', parent: ['ServerStorage', 'RBX_ANIMSAVES'], replace: true, format: 'rbxmx', size: 900, blobs: { bytes: 1, tree: 1 } })
  assert.equal(job.kind, 'insert')
  assert.equal(job.name, 'Run.rbxmx')
  assert.deepEqual(job.insert, { parent: ['ServerStorage', 'RBX_ANIMSAVES'], replace: true, format: 'rbxmx', file: 'Run.rbxmx', size: 900, blobs: { bytes: 1, tree: 1 } })
  assert.deepEqual(job.modules, [])
  assert.equal(job.calibrate, false)
  assert.equal(INSERT_PLUGIN_VERSION, PLUGIN_VERSION, 'insert jobs ship with this plugin version')

  const bytes = Buffer.from(Array.from({ length: 1001 }, (_, i) => (i * 37) % 256))
  const chunks = chunkBase64(bytes, 300)
  assert.equal(chunks.length, 4)
  assert.ok(chunks.slice(0, -1).every((c) => !c.includes('=')), 'only the last chunk pads')
  assert.deepEqual(Buffer.concat(chunks.map((c) => Buffer.from(c, 'base64'))), bytes)
  const text = 'ab😀cd'.repeat(5)
  const parts = chunkText(text, 3)
  assert.equal(parts.join(''), text)
  assert.ok(parts.every((p) => !/[\ud800-\udbff]$/.test(p)), 'no chunk ends in half a surrogate pair')

  assert.deepEqual(parseInsertReport(JSON.stringify({ inserted: ['ServerStorage.RBX_ANIMSAVES.Run'], replaced: 1, via: 'tree', created: ['ServerStorage.RBX_ANIMSAVES'], skipped: [] })), {
    paths: ['ServerStorage.RBX_ANIMSAVES.Run'],
    replaced: 1,
    via: 'tree',
    created: ['ServerStorage.RBX_ANIMSAVES'],
    skipped: []
  })
  // Studio's JSONEncode writes an empty table as [].
  assert.deepEqual(parseInsertReport('{"inserted":[],"replaced":0,"via":"serialization","created":[],"skipped":[]}')?.via, 'serialization')
  assert.equal(parseInsertReport('{"built":"x"}'), null)
  assert.equal(parseInsertReport('not json'), null)
  // The report travels as a 'log' event (up to 64 KB).
  assert.deepEqual(parseEvent({ type: 'log', message: '{"inserted":[]}' }), { type: 'log', message: '{"inserted":[]}' })
})

test('bridge blobs: served only for the running job once delivered; unknown job, name or chunk is 404', async () => {
  const b = new StudioBridge({ port: 0, holdMs: 200 })
  await b.start()
  const base = `http://127.0.0.1:${b.port}/forge-bridge`
  try {
    const job = insertJob({ id: 'job-blob', file: 'Run.rbxmx', parent: ['ServerStorage'], replace: false, format: 'rbxmx', size: 3, blobs: { bytes: 2 } })
    const events: BridgeEvent[] = []
    const done = b.run(job, (ev) => void events.push(ev), { blobs: { bytes: ['QUJD', 'REVG'] }, acceptTimeoutMs: 2000, timeoutMs: 5000 })
    // Not delivered yet: nothing is served.
    assert.equal((await fetch(`${base}/blob/job-blob/bytes/0`)).status, 404)
    const polled = (await (await fetch(`${base}/poll?v=${PLUGIN_VERSION}&place=MyGame&placeId=42`)).json()) as { job?: BridgeJob }
    assert.equal(polled.job?.kind, 'insert')
    assert.deepEqual(polled.job?.insert?.blobs, { bytes: 2 })
    assert.deepEqual(await (await fetch(`${base}/blob/job-blob/bytes/1`)).json(), { data: 'REVG', n: 2 })
    assert.equal((await fetch(`${base}/blob/job-blob/bytes/2`)).status, 404)
    assert.equal((await fetch(`${base}/blob/job-blob/tree/0`)).status, 404)
    assert.equal((await fetch(`${base}/blob/job-blob/constructor/0`)).status, 404)
    assert.equal((await fetch(`${base}/blob/job-other/bytes/0`)).status, 404)
    assert.equal((await fetch(`${base}/blob/job-blob/bytes/0`, { headers: { Origin: 'https://evil.example' } })).status, 403)
    const post = (ev: unknown) => fetch(`${base}/event/job-blob`, { method: 'POST', body: JSON.stringify(ev) })
    await post({ type: 'accepted' })
    await post({ type: 'log', message: '{"inserted":["ServerStorage.Run"]}' })
    await post({ type: 'done', marks: [] })
    await done
    assert.deepEqual(events.map((e) => e.type), ['accepted', 'log', 'done'])
    // Finished: gone.
    assert.equal((await fetch(`${base}/blob/job-blob/bytes/0`)).status, 404)
  } finally {
    await b.stop()
  }
})

// ---------------------------------------------------------------- the watcher

type Run = { job: BridgeJob; opts: RunOptions }

function fakeBridge(over: Partial<InsertBridge> & { windows?: InsertBridgeWindow[]; respond?: (job: BridgeJob, handler: EventHandler, opts: RunOptions) => Promise<void> } = {}) {
  const runs: Run[] = []
  const windows = over.windows ?? [{ place: 'MyGame', placeId: 42, pluginVersion: PLUGIN_VERSION }]
  const bridge: InsertBridge = {
    listening: over.listening ?? true,
    studios: over.studios ?? (() => windows),
    busy: over.busy ?? (() => null),
    run:
      over.run ??
      (async (job, handler, opts = {}) => {
        runs.push({ job, opts })
        if (over.respond) return over.respond(job, handler, opts)
        await handler({ type: 'accepted' }, 0)
        await handler({ type: 'log', message: JSON.stringify({ inserted: [`${job.insert!.parent.join('.')}.Run`], replaced: job.insert!.replace ? 1 : 0, via: 'serialization', created: [], skipped: [] }) }, 0)
        await handler({ type: 'done', marks: [] }, 0)
      })
  }
  return { bridge, runs }
}

function inbox(t: { inboxDir: string; modelsDir: string }, bridge: InsertBridge | null, over: Partial<InsertInboxDeps> = {}) {
  const logs: string[] = []
  const results: ModelInboxEntry[] = []
  let enabled = true
  let n = 0
  const box = new InsertInbox({
    dir: () => t.inboxDir,
    modelsDir: () => t.modelsDir,
    enabled: () => enabled,
    bridge: () => bridge,
    projectPlaces: () => PROJECT,
    log: (text) => void logs.push(text),
    onResult: (e) => void results.push(e),
    newId: () => `job-${++n}`,
    watch: null,
    settleMs: 0,
    ...over
  })
  return { box, logs, results, setEnabled: (v: boolean) => (enabled = v) }
}

test('insert inbox: request -> inserting -> done -> request renamed; the job carries the file; idempotent', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    await writeFile(join(t.inboxDir, 'a1.insert.json'), JSON.stringify({ file: 'Run.rbxmx', parent: 'ServerStorage.RBX_ANIMSAVES', replace: true }))
    const seen: unknown[] = []
    const { bridge, runs } = fakeBridge({
      respond: async (job, handler) => {
        seen.push(await readJson(join(t.inboxDir, 'a1' + INSERT_RESULT_SUFFIX)))
        await handler({ type: 'accepted' }, 0)
        await handler({ type: 'log', message: JSON.stringify({ inserted: ['ServerStorage.RBX_ANIMSAVES.Run'], replaced: 1, via: 'tree', created: ['ServerStorage.RBX_ANIMSAVES'], skipped: [] }) }, 0)
        await handler({ type: 'done', marks: [] }, 0)
      }
    })
    const { box, logs, results } = inbox(t, bridge)
    await box.scan()
    assert.deepEqual(seen, [{ status: 'inserting' }])
    assert.equal(runs.length, 1)
    const { job, opts } = runs[0]
    assert.equal(job.kind, 'insert')
    assert.deepEqual(job.insert, { parent: ['ServerStorage', 'RBX_ANIMSAVES'], replace: true, format: 'rbxmx', file: 'Run.rbxmx', size: Buffer.byteLength(ANIM_XML), blobs: { bytes: 1, tree: 1 } })
    assert.deepEqual(opts.target, { placeId: 42 })
    assert.equal(Buffer.from(opts.blobs!.bytes.join(''), 'base64').toString('utf8'), ANIM_XML)
    assert.equal((JSON.parse(opts.blobs!.tree!.join('')) as InstanceJson[])[0].className, 'KeyframeSequence')
    const done = await readJson(join(t.inboxDir, 'a1' + INSERT_RESULT_SUFFIX))
    assert.equal(done.status, 'done')
    assert.deepEqual(done.paths, ['ServerStorage.RBX_ANIMSAVES.Run'])
    assert.equal(done.place, 'MyGame (42)')
    assert.equal(done.replaced, 1)
    assert.equal(done.via, 'tree')
    assert.deepEqual(done.created, ['ServerStorage.RBX_ANIMSAVES'])
    assert.equal(done.skipped, undefined)
    assert.ok(!Number.isNaN(Date.parse(done.insertedAt)))
    assert.deepEqual((await readdir(t.inboxDir)).sort(), ['Run.rbxmx', 'a1' + INSERT_DONE_SUFFIX, 'a1' + INSERT_RESULT_SUFFIX].sort())
    assert.deepEqual(results.map((r) => [r.kind, r.status, r.paths]), [['insert', 'done', ['ServerStorage.RBX_ANIMSAVES.Run']]])
    assert.ok(logs.some((l) => l.includes('Run.rbxmx -> ServerStorage.RBX_ANIMSAVES.Run in MyGame (42) (replaced 1)')))

    // Rescans and a reused id never insert twice.
    await box.scan()
    await writeFile(join(t.inboxDir, 'a1.insert.json'), JSON.stringify({ file: 'Run.rbxmx' }))
    await box.scan()
    assert.equal(runs.length, 1)
    assert.ok(!(await readdir(t.inboxDir)).includes('a1.insert.json'))
    assert.deepEqual((await readJson(join(t.inboxDir, 'a1' + INSERT_RESULT_SUFFIX))).paths, ['ServerStorage.RBX_ANIMSAVES.Run'])

    // A binary .rbxm in ForgeModels goes as bytes only; upload requests in the same folder are not touched.
    await mkdir(join(t.modelsDir, 'Props'), { recursive: true })
    await writeFile(join(t.modelsDir, 'Props', 'Crate.rbxm'), RBXM)
    await writeFile(join(t.inboxDir, 'b2.insert.json'), JSON.stringify({ file: join(t.modelsDir, 'Props', 'Crate.rbxm'), parent: 'Workspace' }))
    await writeFile(join(t.inboxDir, 'up.request.json'), JSON.stringify({ file: 'x.fbx', name: 'X' }))
    await box.scan()
    assert.equal(runs.length, 2)
    assert.deepEqual(runs[1].job.insert?.blobs, { bytes: 1 })
    assert.equal(runs[1].opts.blobs!.tree, undefined)
    assert.ok((await readdir(t.inboxDir)).includes('up.request.json'))
  } finally {
    await t.cleanup()
  }
})

test('insert inbox: bad requests, bad files and plugin errors write an error result and retire the request', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    await writeFile(join(t.inboxDir, 'Fake.rbxm'), ANIM_XML)
    await writeFile(join(t.inboxDir, 'Broken.rbxmx'), '<roblox version="4"></roblox>')
    const cases: [string, unknown, RegExp][] = [
      ['bad-json', '{"file":', /not valid JSON/],
      ['bad-parent', { file: 'Run.rbxmx', parent: 'CoreGui' }, /must start with one of/],
      ['missing', { file: 'Nope.rbxmx' }, /File not found/],
      ['fbx', { file: 'Head.fbx' }, /only \.rbxm and \.rbxmx/],
      ['fake', { file: 'Fake.rbxm' }, /not a binary Roblox model/],
      ['empty', { file: 'Broken.rbxmx' }, /holds no instances/]
    ]
    for (const [id, body] of cases) await writeFile(join(t.inboxDir, `${id}.insert.json`), typeof body === 'string' ? body : JSON.stringify(body))
    const { bridge, runs } = fakeBridge()
    const { box, results } = inbox(t, bridge)
    await box.scan()
    assert.equal(runs.length, 0)
    for (const [id, , pattern] of cases) {
      const r = await readJson(join(t.inboxDir, id + INSERT_RESULT_SUFFIX))
      assert.equal(r.status, 'error', id)
      assert.match(r.error, pattern, id)
      assert.ok((await readdir(t.inboxDir)).includes(id + INSERT_DONE_SUFFIX), id)
    }
    assert.equal(results.length, cases.length)

    // The plugin refused (e.g. two same-name parents): its message, without the "Studio: " prefix.
    await writeFile(join(t.inboxDir, 'p1.insert.json'), JSON.stringify({ file: 'Run.rbxmx' }))
    const failing = fakeBridge({
      respond: async () => {
        throw new BridgeError('plugin-error', 'Studio: Studio has 2 instances named ServerStorage.Anims; rename one or pick another parent')
      }
    })
    await inbox(t, failing.bridge).box.scan()
    const r = await readJson(join(t.inboxDir, 'p1' + INSERT_RESULT_SUFFIX))
    assert.deepEqual(r, { status: 'error', error: 'Studio has 2 instances named ServerStorage.Anims; rename one or pick another parent' })
  } finally {
    await t.cleanup()
  }
})

test('insert inbox: waits for Studio (not connected, place not open, busy), then fails; old plugin and ambiguity fail at once', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    const req = (id: string, body: object) => writeFile(join(t.inboxDir, `${id}.insert.json`), JSON.stringify(body))
    let now = Date.now()
    let windows: InsertBridgeWindow[] = []
    let busy: BridgeJob | null = null
    const { bridge, runs } = fakeBridge({ studios: () => windows, busy: () => busy })
    const { box, logs } = inbox(t, bridge, { now: () => now, waitMs: 60_000 })

    await req('w1', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 'w1'), 'deferred')
    assert.equal(await box.process(t.inboxDir, 'w1'), 'deferred')
    assert.equal(logs.filter((l) => l.includes('w1: waiting for Studio')).length, 1, 'logged once')
    assert.deepEqual(await readdir(t.inboxDir).then((f) => f.filter((n) => n.startsWith('w1'))), ['w1.insert.json'], 'nothing written while waiting')
    // Studio connects but is busy with a check: still waiting.
    windows = [{ place: 'MyGame', placeId: 42, pluginVersion: PLUGIN_VERSION }]
    busy = insertJob({ id: 'x', file: 'Other.rbxm', parent: ['Workspace'], replace: false, format: 'rbxm', size: 1, blobs: { bytes: 1 } })
    assert.equal(await box.process(t.inboxDir, 'w1'), 'deferred')
    busy = null
    assert.equal(await box.process(t.inboxDir, 'w1'), 'done')
    assert.equal(runs.length, 1)

    // A named place that is not open waits, then fails after waitMs.
    await req('w2', { file: 'Run.rbxmx', place: 'Lobby' })
    assert.equal(await box.process(t.inboxDir, 'w2'), 'deferred')
    now += 61_000
    assert.equal(await box.process(t.inboxDir, 'w2'), 'error')
    assert.match((await readJson(join(t.inboxDir, 'w2' + INSERT_RESULT_SUFFIX))).error, /No Studio window with "Lobby" is connected/)

    // Two project places open and no "place": refused at once (waiting would not help).
    windows = [{ place: 'MyGame', placeId: 42, pluginVersion: PLUGIN_VERSION }, { place: 'Main Menu', placeId: 77, pluginVersion: PLUGIN_VERSION }, { place: 'Place1', pluginVersion: PLUGIN_VERSION }]
    now = Date.now()
    await req('w3', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 'w3'), 'error')
    assert.match((await readJson(join(t.inboxDir, 'w3' + INSERT_RESULT_SUFFIX))).error, /2 Studio windows of this project are connected/)
    // Naming the project place sends it there; an unlinked unpublished place is refused at once.
    await req('w4', { file: 'Run.rbxmx', place: 'menu' })
    assert.equal(await box.process(t.inboxDir, 'w4'), 'done')
    assert.deepEqual(runs.at(-1)!.opts.target, { placeId: 77 })
    // An unlinked unpublished place is used only when named exactly.
    await req('w4b', { file: 'Run.rbxmx', place: 'Place1' })
    assert.equal(await box.process(t.inboxDir, 'w4b'), 'done')
    assert.deepEqual(runs.at(-1)!.opts.target, { place: 'Place1' })

    // A plugin older than v14: restart Studio.
    windows = [{ place: 'MyGame', placeId: 42, pluginVersion: INSERT_PLUGIN_VERSION - 1 }]
    await req('w5', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 'w5'), 'error')
    assert.match((await readJson(join(t.inboxDir, 'w5' + INSERT_RESULT_SUFFIX))).error, new RegExp(`runs Forge Bridge v${INSERT_PLUGIN_VERSION - 1}; restart Studio to load v${INSERT_PLUGIN_VERSION}`))
    assert.equal(runs.length, 3)
  } finally {
    await t.cleanup()
  }
})

test('insert inbox: without "place", never into a Studio window outside the project, even the only one connected; named exactly, yes', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    const req = (id: string, body: object) => writeFile(join(t.inboxDir, `${id}.insert.json`), JSON.stringify(body))
    const result = async (id: string) => readJson(join(t.inboxDir, id + INSERT_RESULT_SUFFIX))
    let now = Date.now()
    // A downloaded game file, open in Studio only to study it (the reported case: plugin v13 there).
    const study: InsertBridgeWindow = { place: 'Place_131716211654599.rbxlx', placeId: 131716211654599, pluginVersion: 13 }
    // A scratch test place outside the project, picked only by name.
    const scratch: InsertBridgeWindow = { place: 'RBX FORGE', pluginVersion: PLUGIN_VERSION }
    let windows: InsertBridgeWindow[] = [study, scratch]
    let places: InsertProjectPlace[] | null = PROJECT
    const { bridge, runs } = fakeBridge({ studios: () => windows })
    const { box } = inbox(t, bridge, { now: () => now, waitMs: 60_000, projectPlaces: () => places })

    // No "place": waits for a project window, then fails naming the project's places. Never sent.
    await req('s1', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 's1'), 'deferred')
    now += 61_000
    assert.equal(await box.process(t.inboxDir, 's1'), 'error')
    const r1 = await result('s1')
    assert.match(r1.error, /No Studio window of this project is connected \(connected: Place_131716211654599\.rbxlx \(131716211654599\) \[not in this project\], RBX FORGE \[not in this project\]\)/)
    assert.match(r1.error, /say which with "place": "MyGame" \(PlaceId 42\)/)
    assert.doesNotMatch(r1.error, /runs Forge Bridge v13/)

    assert.equal(runs.length, 0)

    // Naming a window outside the project exactly: honoured (clear intent).
    now = Date.now()
    await req('s2', { file: 'Run.rbxmx', place: 'RBX FORGE' })
    assert.equal(await box.process(t.inboxDir, 's2'), 'done')
    assert.deepEqual(runs.at(-1)!.opts.target, { place: 'RBX FORGE' })
    assert.equal((await result('s2')).place, 'RBX FORGE')
    // ...by PlaceId too (that window then fails on its own old plugin, not on the project rule).
    await req('s3', { file: 'Run.rbxmx', place: 131716211654599 })
    assert.equal(await box.process(t.inboxDir, 's3'), 'error')
    assert.match((await result('s3')).error, /Place_131716211654599\.rbxlx \(131716211654599\) runs Forge Bridge v13/)

    // The project place opens next to them: a request without "place" goes there.
    windows = [study, scratch, { place: 'MyGame', placeId: 42, pluginVersion: PLUGIN_VERSION }]
    await req('s4', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 's4'), 'done')
    assert.deepEqual(runs.map((r) => r.opts.target), [{ place: 'RBX FORGE' }, { placeId: 42 }])

    // No project open in Forge: without "place" nothing is eligible; an explicit one still works.
    places = null
    await req('s5', { file: 'Run.rbxmx' })
    assert.equal(await box.process(t.inboxDir, 's5'), 'deferred')
    now += 61_000
    assert.equal(await box.process(t.inboxDir, 's5'), 'error')
    assert.match((await result('s5')).error, /No Forge project is open/)
    await req('s6', { file: 'Run.rbxmx', place: 'RBX FORGE' })
    assert.equal(await box.process(t.inboxDir, 's6'), 'done')
    assert.equal(runs.length, 3)
  } finally {
    await t.cleanup()
  }
})

test('insert inbox: off does nothing; files still being written wait; a stale "inserting" is closed, not sent again; a busy race retries', async () => {
  const t = await tempDocs()
  try {
    await writeFile(join(t.inboxDir, 'Run.rbxmx'), ANIM_XML)
    await writeFile(join(t.inboxDir, 'o1.insert.json'), JSON.stringify({ file: 'Run.rbxmx' }))
    const { bridge, runs } = fakeBridge()
    const off = inbox(t, bridge)
    off.setEnabled(false)
    await off.box.scan()
    assert.deepEqual((await readdir(t.inboxDir)).sort(), ['Run.rbxmx', 'o1.insert.json'])

    // Just written (settleMs): wait for the next pass.
    const settling = inbox(t, bridge, { settleMs: 60_000 })
    assert.equal(await settling.box.process(t.inboxDir, 'o1'), 'deferred')
    const old = new Date(Date.now() - 120_000)
    await utimes(join(t.inboxDir, 'o1.insert.json'), old, old)
    await utimes(join(t.inboxDir, 'Run.rbxmx'), old, old)

    // Forge quit mid-insert last time.
    await writeFile(join(t.inboxDir, 'o1' + INSERT_RESULT_SUFFIX), JSON.stringify({ status: 'inserting' }))
    assert.equal(await settling.box.process(t.inboxDir, 'o1'), 'skipped')
    assert.equal(runs.length, 0)
    const closed = await readJson(join(t.inboxDir, 'o1' + INSERT_RESULT_SUFFIX))
    assert.equal(closed.status, 'error')
    assert.match(closed.error, /Forge stopped during this insert/)
    assert.ok((await readdir(t.inboxDir)).includes('o1' + INSERT_DONE_SUFFIX))

    // Another Studio job grabbed the bridge between the check and the run: nothing written, retried later.
    await writeFile(join(t.inboxDir, 'o2.insert.json'), JSON.stringify({ file: 'Run.rbxmx' }))
    let first = true
    const racy = fakeBridge({
      respond: async (job, handler) => {
        if (first) {
          first = false
          throw new BridgeError('busy', 'a Studio check is already running')
        }
        await handler({ type: 'log', message: JSON.stringify({ inserted: ['ServerStorage.Run'] }) }, 0)
      }
    })
    const r = inbox(t, racy.bridge)
    assert.equal(await r.box.process(t.inboxDir, 'o2'), 'deferred')
    assert.ok(!(await readdir(t.inboxDir)).includes('o2' + INSERT_RESULT_SUFFIX))
    assert.equal(await r.box.process(t.inboxDir, 'o2'), 'done')
    assert.deepEqual((await readJson(join(t.inboxDir, 'o2' + INSERT_RESULT_SUFFIX))).paths, ['ServerStorage.Run'])
  } finally {
    await t.cleanup()
  }
})

// ---------------------------------------------------------------- the opt-in

test('wiring: Studio inserts are off by default, turn on without an Open Cloud key, and watch the inbox', async () => {
  const t = await tempDocs()
  const user = await mkdtemp(join(tmpdir(), 'forge-insert-user-'))
  const fake = fakeContext()
  const store = new Map<string, unknown>()
  const { bridge } = fakeBridge()
  const integrations = createIntegrations({
    ctx: fake.ctx,
    settings: { get: <T,>(k: string, f: T) => (store.has(k) ? (store.get(k) as T) : f), set: (k, v) => void store.set(k, v) },
    safeStorage: { isEncryptionAvailable: () => true, encryptString: (s: string) => Buffer.from('enc:' + s), decryptString: (b: Buffer) => b.toString().replace(/^enc:/, '') },
    userDataDir: user,
    emit: fake.ctx.emit,
    log: () => {},
    root: () => null,
    projectFile: () => null,
    projectName: () => 'Fake',
    packages: { search: async () => [], metadata: async () => ({ scope: 'a', name: 'b', latest: '1.0.0', versions: ['1.0.0'] }), addDep: async () => [] },
    git: () => null,
    studioConflicts: async () => [],
    pauseProjectWatch: () => {},
    resumeProjectWatch: () => {},
    services: () => [],
    startService: async () => {},
    stopService: async () => {},
    openExternal: () => {},
    choosePlaceFile: async () => null,
    modelInbox: { documentsDir: t.docs },
    studioBridge: () => bridge
  })
  try {
    const h = integrations.handlers
    let s = (await h.fbxInboxStatus()) as ModelInboxStatus
    assert.equal(s.insertEnabled, false)
    assert.equal(s.watching, false)
    s = (await h.fbxInboxSetSettings({ insert: true })) as ModelInboxStatus
    assert.equal(s.insertEnabled, true)
    assert.equal(s.enabled, false, 'uploads stay off')
    assert.equal(s.watching, true)
    assert.equal(store.get('modelInbox.insertEnabled'), true)
    s = (await h.fbxInboxSetSettings({ insert: false })) as ModelInboxStatus
    assert.equal(s.insertEnabled, false)
    assert.equal(s.watching, false)
  } finally {
    integrations.dispose()
    await t.cleanup()
    await rm(user, { recursive: true, force: true })
  }
})

// ---------------------------------------------------------------- the plugin's side (Lune)

function findLune(): string | null {
  for (const c of [process.env.LUNE_PATH, 'lune']) {
    if (!c) continue
    try {
      execFileSync(c, ['--version'], { stdio: 'ignore' })
      return c
    } catch {
      /* next */
    }
  }
  return null
}

const lune = findLune()
test('plugin (Lune): decodes the base64 chunks and builds Forge\'s .rbxmx reading with refs, attributes and value types', { skip: lune ? false : 'Lune not installed (set LUNE_PATH)' }, async () => {
  const template = await readFile(resolve(import.meta.dirname, '..', 'resources', 'studio', 'ForgeBridge.luau'), 'utf8')
  const slice = (from: string, to: string) => {
    const a = template.indexOf(from)
    const b = template.indexOf(to, a)
    assert.ok(a >= 0 && b > a, `${from} ... ${to} in the plugin`)
    return template.slice(a, b)
  }
  const code = [
    'local roblox = require("@lune/roblox")',
    'local serde = require("@lune/serde")',
    'local Instance, CFrame, Vector3, Vector2, Color3, UDim, UDim2 = roblox.Instance, roblox.CFrame, roblox.Vector3, roblox.Vector2, roblox.Color3, roblox.UDim, roblox.UDim2',
    'local NumberRange, NumberSequence, NumberSequenceKeypoint = roblox.NumberRange, roblox.NumberSequence, roblox.NumberSequenceKeypoint',
    'local ColorSequence, ColorSequenceKeypoint = roblox.ColorSequence, roblox.ColorSequenceKeypoint',
    'local CollectionService = { AddTag = function(_, inst, tag) inst:AddTag(tag) end }',
    slice('local function propValue(', 'local function buildInstance('),
    slice('local B64: { [number]: number } = {}', 'local function fetchChunk('),
    slice('local function insertValue(', '-- The parent to insert into'),
    'local input = serde.decode("json", require("@lune/fs").readFile("input.json"))',
    'local buf = buffer.create(input.size)',
    'local off = 0',
    'for _, chunk in input.chunks do off = base64Into(chunk, buf, off) end',
    'local skipped = {}',
    'local roots = buildTree(serde.decode("json", buffer.tostring(buf)), skipped)',
    'local crate = roots[1]',
    'local body = crate:FindFirstChild("Body")',
    'local weld = body:FindFirstChild("Weld")',
    'local sparks = body:FindFirstChild("Sparks")',
    'local bar = crate:FindFirstChild("Gui"):FindFirstChild("Bar")',
    'local seq = roots[2]',
    'local pose = seq:FindFirstChild("Keyframe"):FindFirstChild("HumanoidRootPart"):FindFirstChild("LowerTorso")',
    'local skippedList = {} for k in skipped do table.insert(skippedList, k) end table.sort(skippedList)',
    'print(serde.encode("json", {',
    '  size = off, primary = crate.PrimaryPart == body, weld0 = weld.Part0 == body, power = crate:GetAttribute("Power"), kind = crate:GetAttribute("Kind"),',
    '  tagged = crate:HasTag("Hazard"), anchored = body.Anchored, green = body.Color.G, sizeX = body.Size.X, lifetimeMax = sparks.Lifetime.Max,',
    '  sizeKeys = #sparks.Size.Keypoints, barScale = bar.Size.X.Scale, barOffset = bar.Size.Y.Offset, anchor = bar.AnchorPoint.X,',
    '  seqName = seq.Name, loop = seq.Loop, poseY = pose.CFrame.Position.Y, weight = pose.Weight, skipped = #skippedList, skippedNames = table.concat(skippedList, ","),',
    '  priority = seq.Priority.Name, easing = pose.EasingStyle.Name,',
    '}))'
  ].join('\n')
  const dir = await mkdtemp(join(tmpdir(), 'forge-insert-lune-'))
  try {
    const tree = JSON.stringify([...readRbxmxTree(PROPS_XML).roots, ...readRbxmxTree(ANIM_XML).roots])
    const bytes = Buffer.from(tree)
    await writeFile(join(dir, 'input.json'), JSON.stringify({ size: bytes.length, chunks: chunkBase64(bytes, 3 * 50) }))
    await writeFile(join(dir, 'check.luau'), code)
    const out = await new Promise<string>((res, rej) => execFile(lune!, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
    const r = JSON.parse(out.trim().split('\n').at(-1)!)
    assert.equal(r.size, bytes.length)
    assert.equal(r.primary, true)
    assert.equal(r.weld0, true)
    assert.equal(r.power, 2.5)
    assert.equal(r.kind, 'fire')
    assert.equal(r.tagged, true)
    assert.equal(r.anchored, true)
    assert.equal(r.green, 1)
    assert.equal(r.sizeX, 4)
    assert.equal(r.lifetimeMax, 2)
    assert.equal(r.sizeKeys, 2)
    assert.equal(r.barScale, 0.5)
    assert.equal(r.barOffset, 20)
    assert.equal(r.anchor, 0.5)
    assert.equal(r.seqName, 'Run')
    assert.equal(r.loop, true)
    assert.equal(r.poseY, 0.5)
    assert.equal(r.weight, 1)
    // Tokens become the property's EnumItem (Studio also takes the number; Lune does not).
    assert.equal(r.priority, 'Action')
    assert.equal(r.easing, 'Constant')
    assert.equal(r.skipped, 0, r.skippedNames)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
