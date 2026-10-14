// Real meshes in the VFX Lab: the Roblox .mesh parser (per version), the MeshPart / SpecialMesh
// placement math, the Studio mesh-read job and its decoding, the cache (keys, sources, the Open
// Cloud key staying on apis.roblox.com), script tweens on parts, and the import keeping parts that
// scripts reveal.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { execFileSync } from 'node:child_process'
import { fromWire, meshAssetId, meshCacheKey, MeshError, toWire, type MeshData } from '../src/shared/vfx/mesh/data.ts'
import { meshVersion, parseRobloxMesh } from '../src/shared/vfx/mesh/parse.ts'
import { partMeshNormalize, partMeshScale, partMeshVertex, specialMeshVertex } from '../src/shared/vfx/mesh/fit.ts'
import { collectMeshes, decodeMeshText, meshJob, meshModuleSource, MESH_CHUNK, MESH_END_TAG, MESH_TAG } from '../src/shared/vfx/mesh/bridge.ts'
import { anglesXYZ, revealedByCues, tweenCuesFromScripts } from '../src/shared/vfx/scriptTweens.ts'
import { allNodes, effectFromNodes, importNotes, emitAttributes, pruneToVfx } from '../src/shared/vfx/analyze.ts'
import { meshFileOf, prepareEffect } from '../src/shared/vfx/simulate.ts'
import { parseEvent } from '../src/shared/studio/protocol.ts'
import { MeshService, ASSET_DELIVERY, type MeshFetch } from '../src/main/services/vfx/meshes.ts'
import { splitEffects, VfxService } from '../src/main/services/vfx/service.ts'
import { luneExtract } from '../src/main/services/vfx/lune.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

// ------------------------------------------------------------------ synthetic mesh files

// A unit quad (two triangles) in the XY plane, plus a far "LOD1" triangle that must be dropped.
const QUAD = {
  verts: [
    { p: [-1, -1, 0], n: [0, 0, 1], uv: [0, 1] },
    { p: [1, -1, 0], n: [0, 0, 1], uv: [1, 1] },
    { p: [1, 1, 0], n: [0, 0, 1], uv: [1, 0] },
    { p: [-1, 1, 0], n: [0, 0, 1], uv: [0, 0] }
  ],
  faces: [
    [0, 1, 2],
    [0, 2, 3]
  ],
  lod1: [[0, 1, 3]]
}

class W {
  bytes: number[] = []
  u8(v: number) {
    this.bytes.push(v & 255)
  }
  u16(v: number) {
    const b = Buffer.alloc(2)
    b.writeUInt16LE(v)
    this.bytes.push(...b)
  }
  u32(v: number) {
    const b = Buffer.alloc(4)
    b.writeUInt32LE(v)
    this.bytes.push(...b)
  }
  f32(v: number) {
    const b = Buffer.alloc(4)
    b.writeFloatLE(v)
    this.bytes.push(...b)
  }
  str(s: string) {
    this.bytes.push(...Buffer.from(s, 'latin1'))
  }
  vertex(v: (typeof QUAD.verts)[number], size: number) {
    v.p.forEach((x) => this.f32(x))
    v.n.forEach((x) => this.f32(x))
    this.f32(v.uv[0])
    this.f32(v.uv[1])
    this.u8(0), this.u8(0), this.u8(127), this.u8(127) // tangent
    if (size === 40) this.u8(255), this.u8(255), this.u8(255), this.u8(255)
  }
  buf(): Uint8Array {
    return Uint8Array.from(this.bytes)
  }
}

const allFaces = [...QUAD.faces, ...QUAD.lod1]

function v2(vertexSize: 36 | 40): Uint8Array {
  const w = new W()
  w.str('version 2.00\n')
  w.u16(12), w.u8(vertexSize), w.u8(12), w.u32(4), w.u32(2)
  QUAD.verts.forEach((v) => w.vertex(v, vertexSize))
  QUAD.faces.forEach((f) => f.forEach((i) => w.u32(i)))
  return w.buf()
}

function v3(): Uint8Array {
  const w = new W()
  w.str('version 3.01\n')
  w.u16(16), w.u8(40), w.u8(12), w.u16(4), w.u16(3), w.u32(4), w.u32(3)
  QUAD.verts.forEach((v) => w.vertex(v, 40))
  allFaces.forEach((f) => f.forEach((i) => w.u32(i)))
  ;[0, 2, 3].forEach((x) => w.u32(x))
  return w.buf()
}

function v4(version: '4.00' | '5.00', bones: number): Uint8Array {
  const w = new W()
  w.str(`version ${version}\n`)
  const header = version === '5.00' ? 32 : 24
  w.u16(header), w.u16(0), w.u32(4), w.u32(3), w.u16(3), w.u16(bones), w.u32(0), w.u16(0), w.u8(0), w.u8(0)
  if (version === '5.00') w.u32(0), w.u32(0)
  QUAD.verts.forEach((v) => w.vertex(v, 40))
  if (bones) for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) w.u8(k < 4 ? 0 : k === 4 ? 255 : 0)
  allFaces.forEach((f) => f.forEach((i) => w.u32(i)))
  ;[0, 2, 3].forEach((x) => w.u32(x))
  // bones (60 bytes each) and names would follow; the parser stops after the LODs.
  for (let b = 0; b < bones; b++) for (let k = 0; k < 60; k++) w.u8(0)
  return w.buf()
}

function chunked(version: '6.00' | '7.00', coreVersion: 1 | 2): Uint8Array {
  const w = new W()
  w.str(`version ${version}\n`)
  const core = new W()
  if (coreVersion === 1) {
    core.u32(4)
    QUAD.verts.forEach((v) => core.vertex(v, 40))
    core.u32(3)
    allFaces.forEach((f) => f.forEach((i) => core.u32(i)))
  } else core.str('DRACO\x02\x02junk')
  const lods = new W()
  lods.u16(0), lods.u8(0), lods.u32(3)
  ;[0, 2, 3].forEach((x) => lods.u32(x))
  for (const [type, ver, body] of [['COREMESH', coreVersion, core], ['LODS\0\0\0\0', 1, lods], ['HSRAVIS\0', 1, new W()]] as const) {
    w.str(type)
    w.u32(ver)
    w.u32(body.bytes.length)
    w.bytes.push(...body.bytes)
  }
  return w.buf()
}

function v1(version: '1.00' | '1.01'): Uint8Array {
  const vec = (a: number[]) => `[${a.join(',')}]`
  const body = QUAD.faces.map((f) => f.map((i) => vec(QUAD.verts[i].p) + vec(QUAD.verts[i].n) + vec([QUAD.verts[i].uv[0], 1 - QUAD.verts[i].uv[1], 0])).join('')).join('')
  return Buffer.from(`version ${version}\n2\n${body}`, 'latin1')
}

function checkQuad(m: MeshData, scale = 1) {
  assert.equal(m.indices.length, 6, 'LOD0 only: two triangles')
  assert.deepEqual(m.min, [-scale, -scale, 0])
  assert.deepEqual(m.max, [scale, scale, 0])
  assert.ok(m.normals && m.uvs)
}

test('.mesh parser: versions 1.00, 1.01, 2.00 (36 / 40 byte vertices), 3.01, 4.00, 5.00, 6.00, 7.00', () => {
  const a = parseRobloxMesh(v1('1.00'))
  checkQuad(a, 0.5) // 1.00 is double size
  assert.equal(a.format, 'version 1.00')
  checkQuad(parseRobloxMesh(v1('1.01')))
  for (const size of [36, 40] as const) {
    const m = parseRobloxMesh(v2(size))
    checkQuad(m)
    // Binary UVs are top-left origin: flipped to OpenGL. Vertex 0 has v=1 -> 0.
    assert.deepEqual([...m.uvs!.slice(0, 2)], [0, 0])
    assert.deepEqual([...m.normals!.slice(0, 3)], [0, 0, 1])
  }
  checkQuad(parseRobloxMesh(v3()))
  checkQuad(parseRobloxMesh(v4('4.00', 0)))
  checkQuad(parseRobloxMesh(v4('4.00', 1))) // skinning data skipped
  checkQuad(parseRobloxMesh(v4('5.00', 0)))
  checkQuad(parseRobloxMesh(chunked('6.00', 1)))
  checkQuad(parseRobloxMesh(chunked('7.00', 1)))
  // Version 1 text and binary UVs agree after conversion.
  assert.deepEqual([...parseRobloxMesh(v1('1.01')).uvs!.slice(0, 2)], [...parseRobloxMesh(v2(40)).uvs!.slice(0, 2)])
  assert.equal(meshVersion(v3()), '3.01')
})

test('.mesh parser: Draco (COREMESH v2), unknown versions and corrupt files are clear errors', () => {
  assert.throws(() => parseRobloxMesh(chunked('7.00', 2)), (e: unknown) => e instanceof MeshError && e.code === 'unsupported' && /Draco/.test(e.message))
  assert.throws(() => parseRobloxMesh(Buffer.from('version 9.00\nxx')), (e: unknown) => e instanceof MeshError && e.code === 'unsupported')
  assert.throws(() => parseRobloxMesh(Buffer.from('PNG...')), (e: unknown) => e instanceof MeshError && e.code === 'corrupt')
  assert.throws(() => parseRobloxMesh(v2(40).subarray(0, 60)), (e: unknown) => e instanceof MeshError && /truncated/.test(e.message))
  // Face indices past the vertex list are dropped, not drawn.
  const bad = v2(40)
  const view = new DataView(bad.buffer, bad.byteOffset)
  view.setUint32(bad.length - 4, 99, true)
  assert.equal(parseRobloxMesh(bad).indices.length, 3)
})

test('wire / cache form round-trips and cache keys are asset ids', () => {
  const m = parseRobloxMesh(v4('4.00', 0))
  const w = toWire('123', m, 'cloud', 5)
  const back = fromWire(JSON.parse(JSON.stringify(w)))
  assert.deepEqual([...back.positions], [...m.positions])
  assert.deepEqual([...back.indices], [...m.indices])
  assert.deepEqual([...back.uvs!], [...m.uvs!])
  assert.equal(w.verts, 4)
  assert.equal(w.tris, 2)
  for (const ref of ['rbxassetid://123', '123', 'http://www.roblox.com/asset/?id=123', 'https://www.roblox.com/asset?id=123', ' rbxassetid://123 ']) assert.equal(meshAssetId(ref), '123', ref)
  for (const ref of ['', 'rbxasset://fonts/sword.mesh', 'rbxassetid://abc', '../../etc', null]) assert.equal(meshAssetId(ref), null)
  assert.equal(meshCacheKey('rbxassetid://987'), '987.json')
  assert.equal(meshCacheKey('rbxasset://x.mesh'), null)
})

// ------------------------------------------------------------------ placement math

test('MeshPart Size scaling and SpecialMesh Scale / Offset', () => {
  // A mesh 2 x 4 x 0 (flat) centred at (1, 2, 0).
  const min: [number, number, number] = [0, 0, 0]
  const max: [number, number, number] = [2, 4, 0]
  assert.deepEqual(partMeshNormalize(min, max), { centre: [1, 2, 0], extent: [2, 4, 1] })
  assert.deepEqual(partMeshScale([4, 2, 0.2], [2, 4, 0]), [2, 0.5, 1])
  // The bounding box maps onto Size: corners land on +-Size/2; the flat axis stays flat.
  assert.deepEqual(partMeshVertex([2, 4, 0], [10, 1, 0.2], min, max), [5, 0.5, 0])
  assert.deepEqual(partMeshVertex([0, 0, 0], [10, 1, 0.2], min, max), [-5, -0.5, 0])
  // SpecialMesh FileMesh: own coordinates x Scale + Offset (not re-centred).
  assert.deepEqual(specialMeshVertex([2, 4, 0], [2, 0.5, 1], [0, 1, 0]), [4, 3, 0])
})

test('simulate: mesh files, SpecialMesh Scale / Offset tweens, decals and part highlights', () => {
  const mp: VfxNode = { id: 'mp', className: 'MeshPart', name: 'Slash', props: { MeshId: 'rbxassetid://55', TextureID: 'rbxassetid://66', Size: [6, 0.2, 6], Material: 'Neon' }, children: [] }
  const ring: VfxNode = {
    id: 'p',
    className: 'Part',
    name: 'Ring',
    props: { Size: [1, 1, 1] },
    children: [
      { id: 'sm', className: 'SpecialMesh', name: 'Mesh', props: { MeshType: 'FileMesh', MeshId: 'rbxassetid://77', TextureId: 'rbxassetid://88', Scale: [2, 2, 2], Offset: [0, 1, 0], VertexColor: [1, 0, 0] }, children: [] },
      { id: 'd', className: 'Decal', name: 'D', props: { Texture: 'rbxassetid://99', Face: 'Top', Transparency: 0.5 }, children: [] },
      { id: 'h', className: 'Highlight', name: 'H', props: {}, children: [] }
    ]
  }
  assert.deepEqual(meshFileOf(mp), { meshId: 'rbxassetid://55', textureId: 'rbxassetid://66', mode: 'part' })
  assert.equal(meshFileOf(ring)?.mode, 'special')
  // SurfaceAppearance.ColorMap wins over TextureID.
  assert.equal(meshFileOf({ ...mp, children: [{ id: 'sa', className: 'SurfaceAppearance', name: 'SA', props: { ColorMap: 'rbxassetid://1' }, children: [] }] })?.textureId, 'rbxassetid://1')
  const effect: VfxEffect = {
    name: 'x',
    roots: [{ id: 'm', className: 'Model', name: 'M', props: {}, children: [mp, ring] }],
    cues: [
      { at: 0, target: 'sm', action: 'tween' as const, props: { Scale: [6, 2, 6] }, duration: 1, style: 'Linear' as const, direction: 'In' as const },
      { at: 0, target: 'mp', action: 'tween' as const, props: { Size: [12, 0.2, 12] }, duration: 1, style: 'Linear' as const, direction: 'In' as const }
    ],
    duration: 1
  }
  const p = prepareEffect(effect)
  const r = p.meshes.find((m) => m.id === 'p')!
  assert.deepEqual(r.look(0.5).scale, [4, 2, 4])
  assert.deepEqual(r.look(0.5).size, [1, 1, 1], 'the proxy keeps the part Size')
  assert.deepEqual(r.file!.offset(0), [0, 1, 0])
  assert.deepEqual(r.file!.vertexColor(0), [1, 0, 0])
  assert.equal(r.decals.length, 1)
  assert.equal(r.decals[0].face, 'Top')
  assert.equal(r.decals[0].transparency(0), 0.5)
  assert.equal(r.highlight?.id, 'h')
  assert.equal(p.highlights.length, 0, 'a part Highlight does not tint the dummy')
  const s = p.meshes.find((m) => m.id === 'mp')!
  assert.deepEqual(s.look(0.5).size, [9, 0.2, 9])
  assert.equal(s.file?.mode, 'part')
})

// ------------------------------------------------------------------ Studio job

test('Studio mesh job: read-only module, chunked results decode, errors per mesh', () => {
  const src = meshModuleSource({ port: 7341, jobId: 'job-mesh-1', ids: ['111', '222', 'bad id', '333"; os.exit()'] })
  assert.match(src, /CreateEditableMeshAsync\(content/)
  assert.match(src, /CreateEditableMeshAsync\(uri\)/, 'falls back to the id-string form')
  assert.match(src, /Content :: any\)\.fromUri/)
  assert.match(src, /mesh:Destroy\(\)/)
  assert.match(src, /local IDS = \{ "111", "222" \}/, 'only digit ids reach the module')
  assert.doesNotMatch(src, /:Clone\(|\.Parent\s*=|Instance\.new/, 'reads only')
  assert.throws(() => meshModuleSource({ port: 1, jobId: 'x y', ids: [] }))
  const job = meshJob({ id: 'job-mesh-1', port: 7341, ids: ['111'] })
  assert.equal(job.kind, 'vfx')
  assert.equal(job.entry, job.modules[0].name)

  // What the module sends: a quad split in chunks, an error, and the end line.
  const text = 'M 111\nP -1,-1,0,1,-1,0,1,1,0,-1,1,0\nN 0,0,1,0,0,1,0,0,1,0,0,1\nU 0,1,1,1,1,0,0,0\nI 0,1,2,0,2,3\n'
  const cut = 25
  const parts = [text.slice(0, cut), text.slice(cut)]
  const messages = [
    ...parts.map((p, i) => `${MESH_TAG} 111 ${i + 1}/2 ${p}`),
    `${MESH_TAG} 222 1/1 M 222\nE Failed to load mesh: asset is not owned by you\n`,
    `${MESH_TAG} 333 1/2 M 333\nP 1,2`, // second chunk never arrived
    `${MESH_END_TAG} 3`,
    'unrelated log line'
  ]
  const { results, complete } = collectMeshes(messages)
  assert.equal(complete, true)
  const q = results.get('111')!
  assert.ok(q.ok)
  if (q.ok) {
    assert.equal(q.mesh.indices.length, 6)
    assert.deepEqual([...q.mesh.uvs!.slice(0, 2)], [0, 0], 'EditableMesh UVs are flipped like mesh files')
    assert.equal(q.mesh.format, 'editablemesh')
  }
  const e = results.get('222')!
  assert.ok(!e.ok && /not owned/.test(e.error))
  assert.equal(results.has('333'), false, 'incomplete meshes are left out')
  assert.ok(!decodeMeshText('P 1,2\nI 0').ok)
  // The bridge keeps whole chunks of a 'log' event (64 KB), but still caps other events.
  assert.equal((parseEvent({ type: 'log', message: 'x'.repeat(MESH_CHUNK + 100) }) as { message: string }).message.length, MESH_CHUNK + 100)
  assert.equal((parseEvent({ type: 'error', message: 'x'.repeat(5000) }) as { message: string }).message.length, 2000)
})

// ------------------------------------------------------------------ cache + sources

function fakeBridge(answer: (ids: string[]) => string[]) {
  const jobs: string[][] = []
  return {
    jobs,
    bridge: {
      port: 7341,
      listening: true,
      connected: () => true,
      async run(job: { modules: { source?: string }[] }, handler: (ev: { type: string; message?: string }, at: number) => unknown) {
        const ids = [...(job.modules[0].source ?? '').matchAll(/"(\d+)"/g)].map((m) => m[1])
        jobs.push(ids)
        for (const m of answer(ids)) handler({ type: 'log', message: m }, 0)
      }
    }
  }
}

const quadText = (id: string) => `${MESH_TAG} ${id} 1/1 M ${id}\nP -1,-1,0,1,-1,0,1,1,0\nN 0,0,1,0,0,1,0,0,1\nU 0,0,1,0,1,1\nI 0,1,2\n`

test('MeshService: Studio first, Open Cloud second, cache by id, the key only goes to apis.roblox.com', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-mesh-'))
  const calls: { url: string; headers?: Record<string, string> }[] = []
  const file = gzipSync(Buffer.from(v4('4.00', 0)))
  const fetch: MeshFetch = async (url, init) => {
    calls.push({ url, headers: init?.headers })
    const ok = (body: string | Uint8Array, status = 200) => ({ ok: status < 400, status, text: async () => String(body), arrayBuffer: async () => (typeof body === 'string' ? new TextEncoder().encode(body) : body).slice().buffer as ArrayBuffer })
    if (url === `${ASSET_DELIVERY}/222`) return ok(JSON.stringify({ location: 'https://c0.rbxcdn.com/abc' }))
    if (url === `${ASSET_DELIVERY}/444`) return ok('forbidden', 403)
    if (url === 'https://c0.rbxcdn.com/abc') return ok(new Uint8Array(file))
    return ok('nope', 404)
  }
  const fb = fakeBridge((ids) => [...ids.filter((id) => id === '111').map(quadText), ...ids.filter((id) => id !== '111').map((id) => `${MESH_TAG} ${id} 1/1 M ${id}\nE no permission\n`), `${MESH_END_TAG} ${ids.length}`])
  const events: string[][] = []
  const svc = new MeshService({ userDir: dir, robloxKey: async () => 'SECRET-KEY', fetch, bridge: fb.bridge as never, emit: (_e, p) => events.push(p.ids) })
  const r = await svc.load(['rbxassetid://111', '222', 'rbxassetid://444', 'rbxasset://builtin.mesh'])
  const by = Object.fromEntries(r.results.map((x) => [x.id, x]))
  assert.equal(by['111'].state, 'loaded')
  assert.equal(by['111'].source, 'studio')
  assert.equal(by['222'].state, 'loaded')
  assert.equal(by['222'].source, 'cloud')
  assert.equal(by['444'].state, 'failed')
  assert.match(by['444'].reason!, /Studio: no permission; Open Cloud: Roblox refused \(403\)/)
  assert.equal(r.results.length, 3, 'built-in rbxasset meshes are not asked for')
  assert.deepEqual(events, [['111', '222']])
  // The key is sent to the asset delivery API only, never to the CDN link.
  for (const c of calls) assert.equal(!!c.headers?.['x-api-key'], c.url.startsWith('https://apis.roblox.com/'))
  assert.ok(calls.every((c) => !c.url.includes('SECRET')))
  // Cached on disk by id; get() serves from it.
  const disk = JSON.parse(await readFile(join(dir, 'meshes', '222.json'), 'utf8'))
  assert.equal(disk.id, '222')
  assert.ok(!JSON.stringify(disk).includes('SECRET'))
  const fresh = new MeshService({ userDir: dir })
  const got = await fresh.get(['rbxassetid://222', '111', '444'])
  assert.deepEqual(Object.keys(got).sort(), ['111', '222'])
  // A second load does not ask again for cached ones, nor for a recent failure (unless retry).
  const before = fb.jobs.length
  const again = await svc.load(['111', '444'])
  assert.deepEqual(again.results.map((x) => x.state), ['cached', 'failed'])
  assert.equal(fb.jobs.length, before)
  await svc.load(['444'], { retry: true })
  assert.equal(fb.jobs.length, before + 1)
})

test('MeshService: no Studio and no key -> clear reasons, nothing cached', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-mesh-'))
  const svc = new MeshService({ userDir: dir, robloxKey: async () => null, bridge: { port: 1, listening: true, connected: () => false, run: async () => undefined } })
  const r = await svc.load(['5'])
  assert.equal(r.results[0].state, 'failed')
  assert.match(r.results[0].reason!, /no API key/)
  assert.ok(r.notes.some((n) => /not connected/.test(n)))
  assert.ok(r.notes.some((n) => /legacy-asset:manage/.test(n)))
  assert.deepEqual(await svc.status(), { studio: false, cloudKey: false })
  assert.equal(existsSync(join(dir, 'meshes', '5.json')), false)
})

// ------------------------------------------------------------------ script tweens

const node = (id: string, className: string, name: string, props: VfxNode['props'] = {}, children: VfxNode[] = [], source?: string): VfxNode => ({ id, className, name, props, children, ...(source ? { source } : {}) })

test('tween extraction: TweenService:Create(...):Play(), locals, sets, delays, loops', () => {
  const src = `local TweenService = game:GetService("TweenService")
local model = script.Parent
local slash = model:WaitForChild("Slash")
local ring = model.Ring
slash.Transparency = 0 -- reveal
TweenService:Create(slash, TweenInfo.new(0.4, Enum.EasingStyle.Quint, Enum.EasingDirection.Out), {
  Size = Vector3.new(10, 0.2, 10),
  Transparency = 1,
  CFrame = slash.CFrame * CFrame.Angles(0, math.rad(180), 0),
}):Play()
task.wait(0.2)
local info = TweenInfo.new(0.5, Enum.EasingStyle.Sine, Enum.EasingDirection.In, 0, false, 0.1)
local tw = TweenService:Create(ring.Mesh, info, { Scale = ring.Mesh.Scale * 4 })
tw:Play()
task.delay(0.3, function()
  TweenService:Create(ring, TweenInfo.new(0.2, Enum.EasingStyle.Linear), {Transparency = 1, Color = Color3.fromRGB(255, 0, 0)}):Play()
end)
task.wait(0.1)
for _, v in pairs(model:GetDescendants()) do
  if v:IsA("BasePart") then
    TweenService:Create(v, TweenInfo.new(1), {Transparency = 1}):Play()
  end
end
local unknown = TweenService:Create(slash, TweenInfo.new(1), {Size = slash.Size * math.random(2, 3)})
unknown:Play()`
  const roots = [
    node('m', 'Model', 'Fx', {}, [
      node('s', 'MeshPart', 'Slash', { Transparency: 1, Size: [4, 0.1, 4], CFrame: [1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1] }),
      node('r', 'Part', 'Ring', { Transparency: 0.5 }, [node('rm', 'SpecialMesh', 'Mesh', { Scale: [1, 0.2, 1], MeshType: 'FileMesh' })]),
      node('sc', 'Script', 'Driver', {}, [], src)
    ])
  ]
  const cues = tweenCuesFromScripts(roots)
  const find = (target: string, at: number) => cues.filter((c) => c.target === target && Math.abs(c.at - at) < 1e-9)
  assert.deepEqual(find('s', 0)[0], { at: 0, target: 's', action: 'set', props: { Transparency: 0 } })
  const grow = find('s', 0)[1]
  assert.equal(grow.action, 'tween')
  assert.deepEqual(grow.props!.Size, [10, 0.2, 10])
  assert.equal(grow.props!.Transparency, 1)
  assert.equal(grow.duration, 0.4)
  assert.equal(grow.style, 'Quint')
  const cfr = grow.props!.CFrame as number[]
  assert.deepEqual(cfr.slice(0, 3), [1, 2, 3])
  assert.ok(Math.abs(cfr[3] + 1) < 1e-9 && Math.abs(cfr[11] + 1) < 1e-9, 'rotated 180 degrees about Y')
  // The local tween plays at the clock of tw:Play() plus the TweenInfo delay.
  const scale = find('rm', 0.3)[0]
  assert.deepEqual(scale.props, { Scale: [4, 0.8, 4] })
  assert.equal(scale.style, 'Sine')
  assert.equal(scale.direction, 'In')
  // task.delay: its own clock (0.2 + 0.3), the outer clock goes on after the block.
  const late = find('r', 0.5)[0]
  assert.deepEqual(late.props, { Transparency: 1, Color: [1, 0, 0] })
  // The loop's goal applies to every BasePart (not the SpecialMesh) at 0.3.
  assert.deepEqual(find('s', 0.3).map((c) => c.props), [{ Transparency: 1 }])
  assert.equal(find('r', 0.3).length, 1)
  assert.equal(cues.filter((c) => c.target === 'rm').length, 1)
  // A goal it cannot evaluate (math.random) is skipped, not guessed.
  assert.equal(cues.filter((c) => c.target === 's' && c.props?.Size && (c.props.Size as number[])[0] !== 10).length, 0)
  assert.deepEqual([...revealedByCues(cues)], ['s'])
  // CFrame.Angles order is X * Y * Z.
  const m = anglesXYZ(Math.PI / 2, 0, 0)
  assert.ok(Math.abs(m[10] - 1) < 1e-9)
})

// ------------------------------------------------------------------ import keeps visible geometry

test('import: parts made visible by scripts are kept, always-invisible holders are not', () => {
  const src = `local TS = game:GetService("TweenService")
local p = script.Parent
p.Shock.Transparency = 0
TS:Create(p.Shock, TweenInfo.new(0.5), {Size = Vector3.new(20, 1, 20), Transparency = 1}):Play()
TS:Create(p.Flash, TweenInfo.new(0.3), {Transparency = 0.2}):Play()`
  const roots = [
    node('m', 'Model', 'Impact', {}, [
      node('holder', 'Part', 'Holder', { Transparency: 1 }, [node('att', 'Attachment', 'A', {}, [node('pe', 'ParticleEmitter', 'Sparks')])]),
      node('shock', 'MeshPart', 'Shock', { Transparency: 1, MeshId: 'rbxassetid://5' }),
      node('flash', 'Part', 'Flash', { Transparency: 1, Shape: 'Ball' }, [node('dec', 'Decal', 'Glow', { Texture: 'rbxassetid://9' })]),
      node('ghost', 'Part', 'Ghost', { Transparency: 1 }, [node('dec2', 'Decal', 'Unseen', { Texture: 'rbxassetid://9' })]),
      node('sc', 'Script', 'Play', {}, [], src)
    ])
  ]
  const e = effectFromNodes('Impact', roots)
  const ids = new Set(allNodes(e.roots).map((n) => n.id))
  assert.ok(ids.has('shock') && ids.has('flash') && ids.has('dec'))
  assert.ok(!ids.has('ghost') && !ids.has('dec2'), 'a part that stays invisible is dropped with its decals')
  assert.ok(ids.has('holder'), 'emitter holders stay (as containers)')
  assert.ok(e.duration >= 0.5)
  const p = prepareEffect(e)
  assert.deepEqual(p.meshes.map((m) => m.id).sort(), ['flash', 'shock'])
  assert.equal(p.meshes.find((m) => m.id === 'flash')!.decals.length, 1)
  const shock = p.meshes.find((m) => m.id === 'shock')!
  assert.equal(shock.look(0).transparency, 0, 'revealed at t=0')
  assert.ok(shock.look(0.25).transparency > 0 && shock.look(0.25).size[0] > 1)
  const notes = importNotes(roots, e, emitAttributes(e.roots)).join('\n')
  assert.match(notes, /tweens? \/ sets? read from scripts/)
  assert.match(notes, /1 mesh: the preview loads the mesh files/)
  // Without the script the same parts are dropped (fully transparent as authored).
  const plain = pruneToVfx(roots.map((r) => ({ ...r, children: r.children.filter((c) => c.className !== 'Script') })))
  assert.ok(!allNodes(plain).some((n) => n.id === 'flash'))
})

test('splitEffects: geometry-only models import, packs keep geometry-only children', () => {
  const part = (id: string, t = 0) => node(id, 'Part', id, { Transparency: t, Material: 'Neon' })
  // A model with only parts / meshes nested in folders (no emitters).
  const geo = node('m', 'Model', 'Shockwave', {}, [node('f', 'Folder', 'Geo', {}, [part('a'), node('w', 'WedgePart', 'W'), node('u', 'UnionOperation', 'U'), node('mp', 'MeshPart', 'Mesh', { MeshId: 'rbxassetid://1' })])])
  const groups = splitEffects([geo])
  assert.equal(groups.length, 1)
  const e = effectFromNodes(groups[0].name, groups[0].nodes)
  assert.deepEqual(prepareEffect(e).meshes.map((m) => m.node.className).sort(), ['MeshPart', 'Part', 'UnionOperation', 'WedgePart'])
  // Nothing visible at all: not an effect.
  assert.equal(splitEffects([node('x', 'Model', 'X', {}, [part('h', 1)])]).length, 0)
  // A pack: two emitter models and a geometry-only one.
  const fx = (id: string) => node(id, 'Model', id, {}, [node(`${id}p`, 'Part', 'P', { Transparency: 1 }, [node(`${id}e`, 'ParticleEmitter', 'E')])])
  const pack = splitEffects([fx('Fire'), fx('Ice'), node('slash', 'Model', 'Slash', {}, [part('s')])])
  assert.deepEqual(pack.map((g) => g.name), ['Fire', 'Ice', 'Slash'])
  // One effect plus loose visible parts selected with it: one entry with both.
  const one = splitEffects([fx('Burst'), part('loose')])
  assert.equal(one.length, 1)
  assert.equal(one[0].nodes.length, 2)
})

// ------------------------------------------------------------------ binary .rbxm end to end (Lune)

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
const runtime = join(import.meta.dirname, '..', 'resources', 'lune')

test('binary .rbxm and .rbxmx with visible parts import with their geometry (Lune)', { skip: !lune ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxparts-'))
  const make = join(dir, 'make.luau')
  await writeFile(
    make,
    `local roblox = require("@lune/roblox")
local fs = require("@lune/fs")
local Instance = roblox.Instance
local m = Instance.new("Model"); m.Name = "SlashFx"
local f = Instance.new("Folder"); f.Name = "Geo"; f.Parent = m
local p = Instance.new("Part"); p.Name = "NeonBall"; p.Size = roblox.Vector3.new(2,3,4); p.Color = roblox.Color3.new(1,0,0); p.Material = roblox.Enum.Material.Neon; p.Shape = roblox.Enum.PartType.Ball; p.Transparency = 0.2; p.CFrame = roblox.CFrame.new(1,2,3); p.Parent = f
local s = Instance.new("Part"); s.Name = "Smooth"; s.Material = roblox.Enum.Material.SmoothPlastic; s.Parent = f
local w = Instance.new("WedgePart"); w.Name = "W"; w.Size = roblox.Vector3.new(1,1,1); w.Parent = f
local mp = Instance.new("MeshPart"); mp.Name = "Slash"; mp.Size = roblox.Vector3.new(4,1,4); mp.Transparency = 1; mp.MeshId = "rbxassetid://12345"; mp.Parent = m
local u = Instance.new("UnionOperation"); u.Name = "U"; u.Size = roblox.Vector3.new(2,2,2); u.Parent = m
local holder = Instance.new("Part"); holder.Name = "Holder"; holder.Transparency = 1; holder.Parent = m
local sc = Instance.new("Script"); sc.Name = "Play"; sc.Source = "local TS = game:GetService('TweenService')\\nlocal s = script.Parent.Slash\\ns.Transparency = 0\\nTS:Create(s, TweenInfo.new(0.3), {Size = Vector3.new(12, 1, 12), Transparency = 1}):Play()"; sc.Parent = m
fs.writeFile("${dir.replace(/\\/g, '/')}/parts.rbxm", roblox.serializeModel({m}))
fs.writeFile("${dir.replace(/\\/g, '/')}/parts.rbxmx", roblox.serializeModel({m}, true))
`
  )
  execFileSync(lune!, ['run', make])
  const res = await luneExtract([join(dir, 'parts.rbxm'), join(dir, 'parts.rbxmx')], { lune: lune!, runtimeDir: runtime })
  for (const r of res) {
    assert.ok(r.roots, r.error)
    const neon = allNodes(r.roots!).find((n) => n.name === 'NeonBall')!
    assert.deepEqual(neon.props.Size, [2, 3, 4])
    assert.deepEqual(neon.props.Color, [1, 0, 0])
    assert.equal(neon.props.Material, 'Neon')
    assert.equal(neon.props.Shape, 'Ball')
    assert.deepEqual((neon.props.CFrame as number[]).slice(0, 3), [1, 2, 3])
    const groups = splitEffects(r.roots!)
    assert.equal(groups.length, 1, 'no emitters: still one effect')
    const e = effectFromNodes('SlashFx', groups[0].nodes)
    const drawn = prepareEffect(e).meshes.map((m) => m.name).sort()
    assert.deepEqual(drawn, ['NeonBall', 'Slash', 'Smooth', 'U', 'W'], `drawn: ${drawn.join(', ')}`)
  }
  // Through the library import (binary needs Lune).
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ path: lune! }), runtimeDir: () => runtime } as never)
  const r = await svc.import([join(dir, 'parts.rbxm')], 'user')
  assert.equal(r.added.length, 1, JSON.stringify(r.skipped))
  assert.equal(r.added[0].importVersion, 2)
  assert.equal(r.added[0].stats?.meshes, 1)
  // Re-import rebuilds from the stored file (an entry from an older importer).
  const old = await svc.update(r.added[0].id, {})
  const again = await svc.reimport(old.id)
  assert.equal(again.importVersion, 2)
  assert.deepEqual(again.thumbs, [])
  assert.equal(prepareEffect(again.effect!).meshes.length, 5)
})
