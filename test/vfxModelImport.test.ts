// Imported multi-part VFX models play like they do in game: the EmitCount / EmitDelay /
// EmitDuration attribute convention (own or inherited from the parent Attachment / Part / Model)
// drives the cues, every emitter sits at its real position (Part CFrame x Attachment CFrame, nested
// Bones), visible parts are drawn (shapes and mesh proxies), loose parts stay one effect, and the
// import note lists what the preview cannot reproduce.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { decodeAttributes, encodeAttributes, readRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { allNodes, cuesFromAttributes, effectFromNodes, emitAttributes, importNotes } from '../src/shared/vfx/analyze.ts'
import { meshShape, prepareEffect } from '../src/shared/vfx/simulate.ts'
import { normalizeLuneNode } from '../src/main/services/vfx/lune.ts'
import { VfxService, splitEffects } from '../src/main/services/vfx/service.ts'
import type { VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const cf = (x: number, y: number, z: number, r = [1, 0, 0, 0, 1, 0, 0, 0, 1]) => `<CoordinateFrame name="CFrame">${['X', 'Y', 'Z', 'R00', 'R01', 'R02', 'R10', 'R11', 'R12', 'R20', 'R21', 'R22'].map((k, i) => `<${k}>${[x, y, z, ...r][i]}</${k}>`).join('')}</CoordinateFrame>`
const attrs = (a: Record<string, number | boolean | string>) => `<BinaryString name="AttributesSerialize">${encodeAttributes(a)}</BinaryString>`
const name = (n: string) => `<string name="Name">${n}</string>`
const item = (cls: string, ref: string, props: string, kids = '') => `<Item class="${cls}" referent="${ref}"><Properties>${props}</Properties>${kids}</Item>`
// Rotated 90 degrees about Y: local +X points along world -Z.
const ROT_Y90 = [0, 0, 1, 0, 1, 0, -1, 0, 0]

const FIXTURE = `<roblox version="4">${item(
  'Model',
  'M',
  name('Burst') + attrs({ EmitDelay: 0.3 }),
  item(
    'Part',
    'PA',
    name('Core') + cf(10, 5, 0, ROT_Y90) + '<Vector3 name="size"><X>2</X><Y>2</Y><Z>2</Z></Vector3><token name="shape">0</token><float name="Transparency">0</float><token name="Material">288</token>',
    item('Attachment', 'AA', name('Tip') + cf(1, 0, 0), item('ParticleEmitter', 'EA', name('Flash') + '<bool name="Enabled">false</bool><float name="Rate">30</float>' + attrs({ EmitCount: 20 })))
  ) +
    item(
      'Part',
      'PB',
      name('Ring') + cf(14, 5, 0) + '<Vector3 name="size"><X>1</X><Y>1</Y><Z>1</Z></Vector3><float name="Transparency">1</float>',
      item('Attachment', 'AB', name('Side') + cf(0, 0, 2), item('ParticleEmitter', 'EB', name('Sparks') + '<float name="Rate">0</float>' + attrs({ EmitCount: 12, EmitDuration: 0.5 }))) +
        item('Bone', 'B1', name('Root') + cf(0, 1, 0), item('Bone', 'B2', name('Tip') + cf(0, 1, 0), item('ParticleEmitter', 'EC', name('Smoke') + '<float name="Rate">10</float>' + attrs({ EmitDelay: 0.2, EmitDuration: 1 }))))
    ) +
    item('WedgePart', 'W', name('Ramp') + cf(12, 3, 0) + '<Vector3 name="size"><X>2</X><Y>1</Y><Z>2</Z></Vector3>') +
    item('Part', 'GH', name('Hidden') + cf(12, 0, 0) + '<float name="Transparency">1</float>') +
    item('Script', 'S', name('Driver') + '<ProtectedString name="Source"><![CDATA[local TweenService = game:GetService("TweenService")\nfor _, v in script.Parent:GetDescendants() do\n  if v:IsA("ParticleEmitter") then task.delay(v:GetAttribute("EmitDelay") or 0, function() v:Emit(v:GetAttribute("EmitCount")) end) end\nend]]></ProtectedString>')
)}</roblox>`

const near = (a: number[], b: number[], eps = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < eps)

test('attributes round-trip through AttributesSerialize', () => {
  const a = { EmitCount: 20, EmitDelay: 0.25, Loop: true, Tag: 'fx' }
  assert.deepEqual(decodeAttributes(encodeAttributes(a)), a)
  assert.deepEqual(decodeAttributes(''), {})
  assert.deepEqual(decodeAttributes('!!!'), {})
  const roots = readRbxmx(FIXTURE)
  assert.deepEqual(roots[0].attrs, { EmitDelay: 0.3 })
  // Lune's JSON carries them too.
  assert.deepEqual(normalizeLuneNode({ id: 'x', className: 'ParticleEmitter', name: 'P', props: {}, children: [], attrs: { EmitCount: 4, Bad: { x: 1 } } }).attrs, { EmitCount: 4 })
})

test('EmitCount / EmitDelay / EmitDuration drive the cues (inherited from the Model)', () => {
  const roots = readRbxmx(FIXTURE)
  const a = emitAttributes(roots)
  assert.deepEqual(a.get('EA'), { delay: 0.3, count: 20 })
  assert.deepEqual(a.get('EB'), { delay: 0.3, count: 12, duration: 0.5 })
  assert.deepEqual(a.get('EC'), { delay: 0.2, duration: 1 }, 'own EmitDelay wins over the Model')
  const effect = effectFromNodes('Burst', roots)
  const of = (id: string) => effect.cues.filter((c) => c.target === id)
  // Flash: one burst of 20 at the delay; it was disabled already.
  assert.deepEqual(of('EA'), [{ at: 0.3, target: 'EA', action: 'emit', count: 20 }])
  // Sparks: Rate 0 -> 12 particles spread over 0.5 s from 0.3, after switching it off.
  const eb = of('EB')
  assert.deepEqual(eb[0], { at: 0, target: 'EB', action: 'disable' })
  const emits = eb.filter((c) => c.action === 'emit')
  assert.equal(emits.reduce((s, c) => s + (c.count ?? 0), 0), 12)
  assert.equal(emits[0].at, 0.3)
  assert.ok(emits[emits.length - 1].at < 0.8 && emits[emits.length - 1].at > 0.7)
  // Smoke: Rate 10, on for [0.2, 1.2].
  assert.deepEqual(
    of('EC').map((c) => [c.action, c.at]),
    [
      ['disable', 0],
      ['enable', 0.2],
      ['disable', 1.2]
    ]
  )
  // The generic emit script did not add its own guesses for these emitters.
  assert.ok(!effect.cues.some((c) => c.action === 'emit' && c.count === 16))
  assert.ok(effect.duration >= 1.2)
  // Without attributes nothing changes.
  assert.deepEqual(cuesFromAttributes([{ id: 'p', className: 'ParticleEmitter', name: 'P', props: {}, children: [] }]), [])
  // Simulation: Flash shows 20 particles just after 0.3, none before.
  const p = prepareEffect({ ...effect, anchor: [0, 0, 0] })
  const flash = p.emitters.find((e) => e.id === 'EA')!
  assert.deepEqual(flash.bursts, [{ at: 0.3, count: 20 }])
  const smoke = p.emitters.find((e) => e.id === 'EC')!
  assert.deepEqual(smoke.windows, [[0.2, 1.2]])
})

test('emitters sit at their real positions: Part x Attachment, nested Bones, re-centred on the parts', () => {
  const effect: VfxEffect = { ...effectFromNodes('Burst', readRbxmx(FIXTURE)), anchor: [0, 0, 0] }
  const p = prepareEffect(effect)
  // Part centre: mean of Core (10,5,0), Ring (14,5,0), Ramp (12,3,0) and the hidden part (12,0,0)? No:
  // the hidden part is pruned (fully transparent, nothing inside) -> mean of the three = (12, 13/3, 0).
  const c = [12, 13 / 3, 0]
  const at = (id: string) => p.emitters.find((e) => e.id === id)!.parentAt(0).slice(0, 3)
  // Core is rotated 90 degrees about Y: its attachment at local +1 X lands at world -1 Z.
  assert.ok(near(at('EA'), [10 - c[0], 5 - c[1], -1]), `Flash at ${at('EA')}`)
  // Ring is not rotated: +2 Z.
  assert.ok(near(at('EB'), [14 - c[0], 5 - c[1], 2]), `Sparks at ${at('EB')}`)
  // Bone chain: two bones of +1 Y each.
  assert.ok(near(at('EC'), [14 - c[0], 7 - c[1], 0]), `Smoke at ${at('EC')}`)
  // Visible parts drawn: the Neon ball and the wedge; the invisible Ring part and the hidden one are not.
  assert.deepEqual(p.meshes.map((m) => [m.name, m.shape, m.material]).sort(), [
    ['Core', 'ball', 'Neon'],
    ['Ramp', 'wedge', 'Plastic']
  ])
  assert.ok(!allNodes(effect.roots).some((n) => n.name === 'Hidden'))
})

test('mesh proxies and SpecialMesh shapes', () => {
  const node = (className: string, props: Record<string, unknown> = {}, children: VfxNode[] = []): VfxNode => ({ id: className, className, name: className, props: props as VfxNode['props'], children })
  assert.equal(meshShape(node('MeshPart')).shape, 'ellipsoid')
  assert.equal(meshShape(node('UnionOperation')).shape, 'ellipsoid')
  assert.equal(meshShape(node('Part', { Shape: 'Cylinder' })).shape, 'cylinder')
  assert.deepEqual(meshShape(node('Part', {}, [node('SpecialMesh', { MeshType: 'Sphere', Scale: [2, 1, 1] })])), { shape: 'ball', scale: [2, 1, 1] })
  assert.deepEqual(meshShape(node('Part', {}, [node('SpecialMesh', { MeshType: 'FileMesh', Scale: [50, 50, 50] })])), { shape: 'ellipsoid', scale: [1, 1, 1] })
})

test('import notes, loose parts and the library import', async () => {
  const roots = readRbxmx(FIXTURE)
  const effect = effectFromNodes('Burst', roots)
  const notes = importNotes(roots, effect, emitAttributes(effect.roots))
  assert.match(notes.join('\n'), /3 emitters timed by EmitCount/)
  assert.match(notes.join('\n'), /Script logic the preview cannot run \(Driver\)/)
  // Loose parts selected together stay one effect; several Models are a pack.
  const part = (id: string): VfxNode => ({ id, className: 'Part', name: id, props: {}, children: [{ id: `${id}e`, className: 'ParticleEmitter', name: 'E', props: {}, children: [] }] })
  assert.equal(splitEffects([part('a'), part('b')]).length, 1)
  const model = (id: string): VfxNode => ({ id, className: 'Model', name: id, props: {}, children: [part(`${id}p`)] })
  assert.equal(splitEffects([model('m1'), model('m2')]).length, 2)
  // Through the library import (no Lune: .rbxmx fallback).
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfxmodel-'))
  const file = join(dir, 'Burst.rbxmx')
  await writeFile(file, FIXTURE)
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const r = await svc.import([file], 'user')
  assert.equal(r.added.length, 1)
  assert.ok(r.added[0].importNotes?.some((n) => /EmitCount/.test(n)))
  assert.equal(r.notes?.[0].file, file)
  // A binary .rbxm without Lune says how to fix it.
  const bin = join(dir, 'Thing.rbxm')
  await writeFile(bin, Buffer.from('<roblox!\x89\xff'))
  const r2 = await svc.import([bin], 'user')
  assert.match(r2.skipped[0].reason, /needs Lune[\s\S]*\.rbxmx/)
})
