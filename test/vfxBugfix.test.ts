// Fixes in the VFX export pipeline (effect modules, the ForgeFX runtime, the Effect.rbxmx template,
// the schema and Live): duplicate names, a stale Timeline.luau, imported scripts in the template,
// durations past 10 s, part classes that fell, SizeScale over later tweens, FileMesh scaling,
// scripted effects following their target, stop() and tweens, attributes, Trail linger.
// No Luau interpreter here: the generated Luau is checked as text (the Lune tests compile it).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allNodes, effectDuration, effectFromNodes, MAX_EFFECT_SECONDS } from '../src/shared/vfx/analyze.ts'
import { effectModules, luauModule, moduleDuration, shippedEffect, templateRoots } from '../src/shared/vfx/luau.ts'
import { FORGEFX_SOURCE, NODE_ID_ATTR } from '../src/shared/vfx/runtime.ts'
import { decodeAttributes, readRbxmx, writeRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { SCHEMA } from '../src/shared/vfx/schema.ts'
import { lingerOf, livePayload } from '../src/shared/vfx/live.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import type { CFrameArr, VfxCue, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const cf = (x: number, y: number, z: number): CFrameArr => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]

// An imported pack: three layers all named "1SP" (a Part and two emitters), one of them with the
// pack's own Script next to it, emit attributes, and a late cue.
function pack(): VfxEffect {
  return {
    name: 'Pack',
    duration: 2,
    roots: [
      {
        id: 'M',
        className: 'Model',
        name: 'Pack',
        props: {},
        children: [
          {
            id: 'P1',
            className: 'Part',
            name: '1SP',
            props: { Size: [1, 1, 1], Transparency: 1, Anchored: true, CFrame: cf(0, 0, 0) },
            children: [
              { id: 'E1', className: 'ParticleEmitter', name: '1SP', props: { Rate: 0, Enabled: false }, attrs: { EmitCount: 12, Note: 'hi', Flag: true }, children: [] },
              {
                id: 'S1',
                className: 'Script',
                name: 'Play',
                props: {},
                source: 'script.Parent["1SP"]:Emit(12)',
                children: [{ id: 'E3', className: 'ParticleEmitter', name: 'Inner', props: { Rate: 0 }, children: [] }]
              }
            ]
          },
          { id: 'E2', className: 'ParticleEmitter', name: '1SP', props: { Rate: 0, Enabled: false }, children: [] },
          { id: 'MS', className: 'ModuleScript', name: 'Config', props: {}, source: 'return {}', children: [] }
        ]
      }
    ],
    cues: [
      { at: 0, target: 'E1', action: 'emit', count: 12 },
      { at: 0.5, target: 'E2', action: 'emit', count: 4 },
      { at: 0.5, target: 'E3', action: 'emit', count: 2 }
    ]
  }
}

const rows = (src: string) => src.split('\n').filter((l) => /^\t\{"/.test(l))
const cueRows = (src: string) => src.split('\n').filter((l) => /^\t\{ /.test(l))

// ------------------------------------------------------------ 1. duplicate names

test('cues address their instance by a ForgeId attribute, not by a name the pack repeats', () => {
  const fx = pack()
  const shipped = shippedEffect(fx)
  const ids = new Map(allNodes(shipped.roots).map((n) => [n.id, n.attrs?.[NODE_ID_ATTR]]))
  // Only cue targets get one; they are distinct and match the NODES rows (post-order).
  assert.equal(ids.get('P1'), undefined)
  const e1 = ids.get('E1')
  const e2 = ids.get('E2')
  assert.ok(typeof e1 === 'number' && typeof e2 === 'number' && e1 !== e2)
  // The effect passed in is not changed.
  assert.equal(fx.roots[0].children[0].children[0].attrs?.[NODE_ID_ATTR], undefined)
  const src = luauModule(fx)
  const nodeRows = rows(src)
  assert.match(nodeRows[e1 - 1], new RegExp(`^\\t\\{"ParticleEmitter","1SP",.*"${NODE_ID_ATTR}",${e1}\\}\\},$`))
  assert.match(nodeRows[e2 - 1], new RegExp(`"${NODE_ID_ATTR}",${e2}\\}\\},$`))
  // Plain cues: { at, id, name, action, count }.
  assert.ok(cueRows(src).includes(`\t{ 0, ${e1}, "1SP", "emit", 12 },`), cueRows(src).join('\n'))
  assert.ok(cueRows(src).includes(`\t{ 0.5, ${e2}, "1SP", "emit", 4 },`))
  // Lookup by attribute, name only as a fallback; Emit only on emitters, Enabled only on toggles.
  assert.match(src, new RegExp(`local id = d:GetAttribute\\("${NODE_ID_ATTR}"\\)`))
  assert.match(src, /local targets = ids\[cue\[2\]\][\s\S]*model:FindFirstChild\(cue\[3\], true\)/)
  assert.match(src, /if fx:IsA\("ParticleEmitter"\) then\n\t\t\tfx:Emit\(cue\[5\]\)/)
  assert.match(src, /elseif TOGGLES\[fx\.ClassName\] then/)
  assert.doesNotMatch(src, /local fx = model:FindFirstChild\(cue\[2\], true\)/)
})

test('scripted cues, prelude rows and spawns carry the id; ForgeFX resolves by id first', () => {
  const fx = pack()
  fx.cues.push({ at: 0, target: 'P1', action: 'set', props: { Transparency: 0.5 }, prelude: true } as VfxCue)
  fx.cues.push({ at: 0.2, target: 'E2', action: 'tween', duration: 0.5, props: { SizeScale: 2 } } as VfxCue)
  fx.cues.push({ at: 0.3, target: 'E1', action: 'emit', count: 3, spawn: 'Burst1', spawnAt: 0.1 } as VfxCue)
  const ids = new Map(allNodes(shippedEffect(fx).roots).map((n) => [n.id, n.attrs?.[NODE_ID_ATTR]]))
  const src = luauModule(fx)
  assert.match(src, new RegExp(`\\{ id = ${ids.get('P1')}, name = "1SP", goals = \\{ Transparency = 0\\.5 \\} \\}`))
  assert.match(src, new RegExp(`\\{ at = 0\\.2, id = ${ids.get('E2')}, name = "1SP", action = "tween"`))
  assert.match(src, new RegExp(`\\{ dt = 0\\.2, id = ${ids.get('E1')}, name = "1SP", action = "emit", count = 3 \\}`))
  assert.match(FORGEFX_SOURCE, new RegExp(`local id = d:GetAttribute\\("${NODE_ID_ATTR}"\\)`))
  assert.match(FORGEFX_SOURCE, /function ForgeFX:_targets\(c\): \{ any \}\n\tlocal list = if c\.id ~= nil then self\.byId\[c\.id\] else nil\n\treturn list or \{ c\.name \}/)
  assert.match(FORGEFX_SOURCE, /function ForgeFX:cue\(c\)\n\tfor _, target in self:_targets\(c\) do/)
  assert.match(FORGEFX_SOURCE, /function ForgeFX:prelude\(list\)\n\tfor _, c in list do\n\t\tfor _, target in self:_targets\(c\) do/)
  // emit still only reaches ParticleEmitters (layers()).
  assert.match(FORGEFX_SOURCE, /for _, e in layers\(inst, \{ ParticleEmitter = true \}\) do/)
})

// ------------------------------------------------------------ 2. stale Timeline.luau

test('a Timeline module that returns no function (or fails) falls back to the compiled cues', async () => {
  const fx = pack()
  fx.cues.push({ at: 0, target: 'E2', action: 'tween', duration: 1, props: { SizeScale: 2 } } as VfxCue)
  const src = luauModule(fx)
  assert.match(src, /ok, fn = pcall\(require, timeline\)/)
  assert.match(src, /if ok and type\(fn\) == "function" then\n(\t\tfx:runCues\(BASE_CUES\)\n)?\t\tfx:run\(fn\)\n\telse\n\t\tfx:runCues\(CUES, Effect\.Stages\)/)
  assert.doesNotMatch(src, /require\(timeline\) :: any/)
  // The file left behind for an effect without a script is a valid module (a ModuleScript must
  // return exactly one value; nil is refused by Roblox).
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-fix-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const files = await svc.exportFiles({ id: 'x', scope: 'user', kind: 'model', name: 'Pack', description: '', tags: [], createdAt: 0, updatedAt: 0, effect: fx, thumbs: [] } as never, 'src/shared/VFX/Pack')
  const stale = files.find((f) => f.path.endsWith('Timeline.luau'))!
  assert.equal(stale.onlyIfExists, true)
  assert.match(stale.content, /^return false$/m)
  assert.doesNotMatch(stale.content, /return nil/)
})

// ------------------------------------------------------------ 3. imported scripts

test('the exported template and NODES leave out the pack\'s scripts; the library keeps them', async () => {
  const fx = pack()
  const shipped = shippedEffect(fx)
  const classes = allNodes(shipped.roots).map((n) => n.className)
  assert.ok(!classes.includes('Script') && !classes.includes('ModuleScript'))
  // A script's own children move up to its parent.
  const p1 = allNodes(shipped.roots).find((n) => n.id === 'P1')!
  assert.deepEqual(p1.children.map((c) => c.id), ['E1', 'E3'])
  assert.equal(allNodes(fx.roots).filter((n) => n.className === 'Script').length, 1)
  const src = luauModule(fx)
  assert.doesNotMatch(src, /"Script"|"ModuleScript"/)
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-fix-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const files = await svc.exportFiles({ id: 'x', scope: 'user', kind: 'model', name: 'Pack', description: '', tags: [], createdAt: 0, updatedAt: 0, effect: fx, thumbs: [] } as never, 'src/shared/VFX/Pack')
  const xml = files.find((f) => f.path.endsWith('Effect.rbxmx'))!.content
  assert.doesNotMatch(xml, /class="Script"|class="ModuleScript"|name="Source"/)
  // The template's ids are the module's ids.
  const template = readRbxmx(xml)
  const want = new Map(allNodes(shipped.roots).map((n) => [n.id, n.attrs?.[NODE_ID_ATTR]]))
  const got = allNodes(template).filter((n) => n.attrs?.[NODE_ID_ATTR] !== undefined)
  assert.equal(got.length, 3)
  for (const n of got) assert.ok([...want.values()].includes(n.attrs![NODE_ID_ATTR] as number))
  assert.deepEqual(allNodes(templateRoots(fx)).map((n) => n.attrs?.[NODE_ID_ATTR]), allNodes(shipped.roots).map((n) => n.attrs?.[NODE_ID_ATTR]))
})

// ------------------------------------------------------------ 4. durations

test('imported effects last up to 30 s, and modules run until the last cue', () => {
  const nodes: VfxNode[] = [
    {
      id: 'M',
      className: 'Model',
      name: 'Late',
      props: {},
      children: [
        { id: 'E', className: 'ParticleEmitter', name: 'Late', props: { Rate: 0, Lifetime: [1, 1] }, attrs: { EmitDelay: 20, EmitCount: 10 }, children: [] },
        { id: 'A0', className: 'Attachment', name: 'A0', props: {}, children: [] },
        { id: 'A1', className: 'Attachment', name: 'A1', props: {}, children: [] },
        { id: 'B', className: 'Beam', name: 'Beam', props: { Attachment0: 'A0', Attachment1: 'A1' }, attrs: { EmitDelay: 24 }, children: [] }
      ]
    }
  ]
  const fx = effectFromNodes('Late', nodes)
  assert.ok(fx.duration >= 24 && fx.duration > 10, `duration ${fx.duration}`)
  assert.equal(MAX_EFFECT_SECONDS, 30)
  assert.equal(effectDuration(nodes, [{ at: 45, target: 'E', action: 'emit', count: 1 }]), 30)
  // A module plays at least until its last cue (and tween end), even past the effect's duration.
  const short: VfxEffect = { ...fx, duration: 5 }
  assert.equal(moduleDuration(short), 24)
  assert.equal(moduleDuration({ ...short, cues: [...short.cues, { at: 26, target: 'B', action: 'tween', duration: 2, props: { Width0: 2 } }] }), 28)
  assert.match(luauModule(short), /Effect\.Duration = 24\n/)
  assert.equal(livePayload(short).duration, 24)
})

// ------------------------------------------------------------ 5. part classes and meshes

test('WedgePart and UnionOperation keep Anchored / CanCollide; every part class writes Color3uint8 and size', () => {
  for (const cls of ['WedgePart', 'UnionOperation', 'MeshPart', 'Part']) {
    assert.equal(SCHEMA[cls].Anchored?.kind, 'bool', cls)
    assert.equal(SCHEMA[cls].CanCollide?.kind, 'bool', cls)
  }
  const roots: VfxNode[] = [
    { id: 'W', className: 'WedgePart', name: 'Wedge', props: { Anchored: true, CanCollide: false, Size: [2, 3, 4], Color: [1, 0, 0], CFrame: cf(1, 2, 3) }, children: [] },
    { id: 'U', className: 'UnionOperation', name: 'Union', props: { Anchored: true, CanCollide: false, Size: [1, 1, 1], Color: [0, 1, 0] }, children: [] },
    { id: 'MP', className: 'MeshPart', name: 'Mesh', props: { MeshId: 'rbxassetid://123', InitialSize: [2, 2, 2], Size: [4, 4, 4], Anchored: true }, children: [] }
  ]
  const xml = writeRbxmx(roots)
  assert.match(xml, /<Item class="WedgePart"[\s\S]*?<bool name="Anchored">true<\/bool>[\s\S]*?<bool name="CanCollide">false<\/bool>/)
  assert.match(xml, /<Item class="UnionOperation"[\s\S]*?<bool name="Anchored">true<\/bool>/)
  assert.doesNotMatch(xml, /<Color3 name="Color">|<Vector3 name="Size">/)
  assert.match(xml, /<Content name="MeshId"><url>rbxassetid:\/\/123<\/url><\/Content>/)
  assert.match(xml, /<Vector3 name="InitialSize"><X>2<\/X><Y>2<\/Y><Z>2<\/Z><\/Vector3>/)
  const back = readRbxmx(xml)
  assert.deepEqual(back[0].props.Size, [2, 3, 4])
  assert.deepEqual(back[0].props.Color, [1, 0, 0])
  assert.equal(back[0].props.Anchored, true)
  assert.deepEqual(back[2].props.InitialSize, [2, 2, 2])
})

test('the rebuild path loads meshes with CreateMeshPartAsync, never sets InitialSize, and warns', () => {
  const fx: VfxEffect = {
    name: 'Meshy',
    duration: 1,
    cues: [],
    roots: [{ id: 'MP', className: 'MeshPart', name: 'Mesh', props: { MeshId: 'rbxassetid://9', InitialSize: [2, 2, 2], Size: [4, 4, 4], Anchored: true }, children: [] }]
  }
  const src = luauModule(fx)
  assert.doesNotMatch(src, /"InitialSize"/)
  assert.match(src, /pcall\(AssetService\.CreateMeshPartAsync, AssetService, props\[p \+ 1\]\)/)
  assert.match(src, /local inst: any = create\(n\)/)
  assert.match(src, /if key == "MeshId" and inst:IsA\("MeshPart"\) then[\s\S]*?pcall\(function\(\)\n\t\t\t\t\t\tinst\.MeshId = v/)
  assert.match(src, /warn\("Meshy: built without its Effect template/)
  // The template is still preferred.
  assert.match(src, /local template = script:FindFirstChild\("Effect"\)\n\tif template then\n\t\treturn \(template :: any\):Clone\(\)\n\tend\n\tif not warned then/)
  // Effects without meshes keep the plain builder.
  const plain = luauModule(pack())
  assert.doesNotMatch(plain, /AssetService|create\(n\)|warned/)
  assert.match(plain, /local inst: any = Instance\.new\(n\[1\]\)/)
})

// ------------------------------------------------------------ 6, 7. virtual scaling

test('ForgeFX scales the current tweened base (Size / Transparency tweens are not undone by SizeScale / Fade)', () => {
  // Base properties are tweened as base values the virtuals multiply.
  assert.match(FORGEFX_SOURCE, /elseif isBaseProp\(inst, prop\) then\n\t\t\tself:_tweenBase\(inst, prop, goal, info\)/)
  assert.match(FORGEFX_SOURCE, /if x:IsA\("BasePart"\) then\n\t\treturn prop == "Size" or prop == "Transparency"/)
  assert.match(FORGEFX_SOURCE, /b\[prop\] = from:Lerp\(goal, k\)[\s\S]*?self:_apply\(inst, true\)/)
  assert.match(FORGEFX_SOURCE, /if sc then a\.Size = b\.Size \* scale end\n\t\tif fd then a\.Transparency = 1 - \(1 - b\.Transparency\) \* keep end/)
  // A plain Size tween no longer goes to TweenService directly on the part.
  const native = FORGEFX_SOURCE.slice(FORGEFX_SOURCE.indexOf('function ForgeFX:tween('), FORGEFX_SOURCE.indexOf('function ForgeFX:set('))
  assert.ok(native.indexOf('isBaseProp(inst, prop)') < native.indexOf('native[prop] = goal'))
})

test('SizeScale scales a FileMesh SpecialMesh (its part Size does not resize the mesh)', () => {
  assert.match(FORGEFX_SOURCE, /elseif x:IsA\("SpecialMesh"\) then\n\t\tb\.Scale = a\.Scale/)
  assert.match(FORGEFX_SOURCE, /a\.Scale = if isFileMesh\(x\) then b\.Scale \* scale else b\.Scale/)
  assert.match(FORGEFX_SOURCE, /\(x :: any\)\.MeshType == Enum\.MeshType\.FileMesh/)
})

// ------------------------------------------------------------ 9. following

test('scripted modules follow a moving BasePart / Attachment; part tweens stay in the effect\'s space', () => {
  const fx = pack()
  fx.cues.push({ at: 0, target: 'E2', action: 'tween', duration: 1, props: { SizeScale: 2 } } as VfxCue)
  const src = luauModule(fx)
  assert.match(src, /local RunService = game:GetService\("RunService"\)/)
  assert.match(src, /follow\(model, fx, target\)/)
  assert.match(src, /RunService\.Heartbeat:Connect\(function\(\)/)
  assert.match(src, /model:PivotTo\(moved \* model:GetPivot\(\)\)\n\t\t\tfx\.pivot = moved \* fx\.pivot/)
  assert.match(src, /if not model\.Parent or not target\.Parent then\n\t\t\tconn:Disconnect\(\)/)
  // Part CFrame tweens re-read the frame every step.
  assert.match(FORGEFX_SOURCE, /part\.CFrame = self:_frame\(part\) \* fromRel:Lerp\(goalCf, k\)/)
})

// ------------------------------------------------------------ 10. stop

test('stop() cancels TweenService tweens too, and later timeline actions do nothing', () => {
  assert.match(FORGEFX_SOURCE, /local tween = TweenService:Create\(inst, info, native\)\n\t\t\tself\.tweens\[tween\] = true/)
  const stop = FORGEFX_SOURCE.slice(FORGEFX_SOURCE.indexOf('function ForgeFX:stop()'))
  assert.match(stop, /self\.stopped = true/)
  assert.match(stop, /for t in self\.tweens do\n\t\tt:Cancel\(\)\n\tend/)
  assert.match(FORGEFX_SOURCE, /function ForgeFX:emit\(target, count: number\?\)\n\tif self\.stopped then\n\t\treturn/)
  assert.match(FORGEFX_SOURCE, /local inst = if self\.stopped then nil else self:find\(target\)/)
})

// ------------------------------------------------------------ 11. attributes

test('NODES rows set the attributes; the template writes them as AttributesSerialize', () => {
  const src = luauModule(pack())
  const e1 = rows(src).find((r) => r.includes('"EmitCount"'))!
  assert.match(e1, /false,\{"EmitCount",12,"Note","hi","Flag",true,"ForgeId",\d+\}\},$/)
  assert.match(src, /local attrs = n\[6\]\n\t\tif attrs then\n\t\t\tfor a = 1, #attrs, 2 do\n\t\t\t\tpcall\(inst\.SetAttribute, inst, attrs\[a\], attrs\[a \+ 1\]\)/)
  // Rows without attributes keep their old shape.
  assert.ok(rows(src).some((r) => r === '\t{"Model","Pack",0,{}},'))
  const xml = writeRbxmx(templateRoots(pack()))
  const blob = /<BinaryString name="AttributesSerialize">([^<]+)<\/BinaryString>/.exec(xml)![1]
  const attrs = decodeAttributes(blob)
  assert.equal(attrs.EmitCount, 12)
  assert.equal(attrs.Note, 'hi')
  assert.equal(attrs.Flag, true)
  assert.equal(typeof attrs[NODE_ID_ATTR], 'number')
  // Refs and attributes together: refs stay at index 5.
  const beam: VfxEffect = {
    name: 'B',
    duration: 1,
    cues: [{ at: 0, target: 'Bm', action: 'enable' }],
    roots: [
      { id: 'A0', className: 'Attachment', name: 'A0', props: {}, children: [] },
      { id: 'A1', className: 'Attachment', name: 'A1', props: {}, children: [] },
      { id: 'Bm', className: 'Beam', name: 'Beam', props: { Attachment0: 'A0', Attachment1: 'A1' }, children: [] }
    ]
  }
  assert.ok(rows(luauModule(beam)).some((r) => /^\t\{"Beam","Beam",0,\{\},\{"Attachment0",1,"Attachment1",2\},\{"ForgeId",3\}\},$/.test(r)))
  assert.equal(effectModules(beam).data.length, 0)
})

// ------------------------------------------------------------ 12. Live linger

test('Live linger counts Trail lifetimes (a number) and default emitter lifetimes', () => {
  const trail = (life?: number): VfxEffect => ({ name: 'T', duration: 1, cues: [], roots: [{ id: 'T', className: 'Trail', name: 'T', props: life === undefined ? {} : { Lifetime: life }, children: [] }] })
  assert.equal(lingerOf(trail(1.5)), 1.5)
  assert.equal(lingerOf(trail()), 2)
  assert.equal(lingerOf(trail(9)), 4)
  assert.equal(lingerOf({ name: 'E', duration: 1, cues: [], roots: [{ id: 'E', className: 'ParticleEmitter', name: 'E', props: { Lifetime: [0.2, 0.5] }, children: [] }] }), 0.5)
})
