// Effects imported with the world positions of their place (a Part at (120, 40, -300)) play with
// their anchor at the root: in the preview (prepareEffect), in the critic's frames (same simulation),
// in the exported module and its Effect.rbxmx template, and in a timeline script built on such an
// effect. Effects authored at the origin are untouched; the parts keep their layout.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { centreEffect, effectAnchor, effectPlacement } from '../src/shared/vfx/placement.ts'
import { DEFAULT_ANCHOR, effectBounds, prepareEffect, simulate } from '../src/shared/vfx/simulate.ts'
import { compileTimeline, type RecordedOp } from '../src/shared/vfx/compile.ts'
import { effectFromSpec } from '../src/shared/vfx/spec.ts'
import { luauModule } from '../src/shared/vfx/luau.ts'
import { FORGEFX_SOURCE } from '../src/shared/vfx/runtime.ts'
import { readRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { allNodes } from '../src/shared/vfx/analyze.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { frameView } from '../src/renderer/src/pages/vfx/preview/framing.ts'
import { findLune } from '../src/main/services/tests/lune.ts'
import type { CFrameArr, Vec3, VfxCue, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const cf = (x: number, y: number, z: number): CFrameArr => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]
const near = (a: number[], b: number[], eps = 1e-6) => a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < eps)
const pos = (c: CFrameArr) => c.slice(0, 3)
const emitter = (id: string, props: VfxNode['props'] = {}): VfxNode => ({ id, className: 'ParticleEmitter', name: id, props: { Rate: 20, ...props }, children: [] })
const part = (id: string, at: Vec3, children: VfxNode[] = [], props: VfxNode['props'] = {}): VfxNode => ({ id, className: 'Part', name: id, props: { Size: [1, 1, 1], Transparency: 1, CFrame: cf(...at), ...props }, children })
const att = (id: string, at: Vec3, children: VfxNode[] = []): VfxNode => ({ id, className: 'Attachment', name: id, props: { CFrame: cf(...at) }, children })

// What a fire burst imported from a place looks like: a Model far from the origin, the burst on one
// part, sparks on another 6 studs to the side, a visible ember mesh 2 studs below them.
function farBurst(): VfxEffect {
  const model: VfxNode = {
    id: 'M',
    className: 'Model',
    name: 'FireBurst',
    props: {},
    children: [
      part('Core', [120, 40, -300], [att('CoreAtt', [0, 1, 0], [emitter('Fire')])]),
      part('Side', [126, 40, -300], [emitter('Sparks')]),
      part('Ember', [123, 38, -300], [], { Transparency: 0, Size: [2, 2, 2] })
    ]
  }
  return { name: 'FireBurst', roots: [model], cues: [{ at: 0, target: 'Fire', action: 'emit', count: 20 }], duration: 1.5 }
}

test('a far-off imported effect is centred on the stage, its parts keep their layout', () => {
  const effect = farBurst()
  // Anchor: the bounds centre of the parts carrying emitters (Core and Side); the ember is geometry.
  assert.deepEqual(effectAnchor(effect), [123, 40, -300])
  const p = prepareEffect(effect)
  const at = (id: string) => pos(p.emitters.find((e) => e.id === id)!.parentAt(0))
  const root = DEFAULT_ANCHOR
  assert.ok(near(at('Fire'), [root[0] - 3, root[1] + 1, root[2]]), `Fire at ${at('Fire')}`)
  assert.ok(near(at('Sparks'), [root[0] + 3, root[1], root[2]]), `Sparks at ${at('Sparks')}`)
  // Relative layout: Side is still 6 studs right of Core, the ember 2 below the anchor.
  const core = pos(p.emitters.find((e) => e.id === 'Fire')!.parentAt(0))
  assert.ok(near([at('Sparks')[0] - core[0], at('Sparks')[1] - (core[1] - 1)], [6, 0]))
  assert.ok(near(pos(p.meshes.find((m) => m.id === 'Ember')!.at(0)), [root[0], root[1] - 2, root[2]]))
  // Particles start on the stage, not 300 studs away.
  const f = simulate(p, 0.05)
  const ps = f.emitters.flatMap((e) => e.particles)
  assert.ok(ps.length > 0)
  assert.ok(ps.every((q) => Math.hypot(q.pos[0] - root[0], q.pos[1] - root[1], q.pos[2] - root[2]) < 12), 'every particle near the dummy')
  // The stored effect is not rewritten.
  assert.deepEqual(effect.roots[0].children[0].props.CFrame, cf(120, 40, -300))
  // The camera framing sees it next to the dummy.
  const b = effectBounds(effect)!
  assert.ok(b.max.every((v, i) => Math.abs(v - root[i]) < 6) && b.min.every((v, i) => Math.abs(v - root[i]) < 6), JSON.stringify(b))
})

test('anchor rules: a root part wins; one carrying part; geometry only; nothing placed', () => {
  // A single top-level part: its own position (children follow it).
  const single: VfxEffect = { name: 'S', roots: [part('P', [50, 10, 20], [att('A', [0, 0, -4], [emitter('E')])])], cues: [], duration: 1 }
  assert.deepEqual(effectAnchor(single), [50, 10, 20])
  assert.ok(near(pos(prepareEffect({ ...single, anchor: [0, 0, 0] }).emitters[0].parentAt(0)), [0, 0, -4]))
  // A Part named Root under the Model (the game module's PrimaryPart).
  const rooted: VfxEffect = { name: 'R', roots: [{ id: 'M', className: 'Model', name: 'M', props: {}, children: [part('Root', [7, 8, 9]), part('X', [17, 8, 9], [emitter('E')])] }], cues: [], duration: 1 }
  assert.deepEqual(effectAnchor(rooted), [7, 8, 9])
  // Geometry only (a slash mesh): the bounds centre of the parts.
  const geo: VfxEffect = { name: 'G', roots: [part('A', [10, 0, 0], [], { Transparency: 0 }), part('B', [20, 4, 0], [], { Transparency: 0 })], cues: [], duration: 1 }
  assert.deepEqual(effectAnchor(geo), [15, 2, 0])
  // Attachments only: already relative to the root.
  assert.deepEqual(effectAnchor({ name: 'A', roots: [att('A', [0, 2, 0], [emitter('E')])], cues: [], duration: 1 }), [0, 0, 0])
})

test('effects authored at the origin play exactly as before', () => {
  const spec = effectFromSpec({ name: 'Orb', layers: [{ class: 'ParticleEmitter', name: 'Core', props: { Rate: 30 } }, { class: 'ParticleEmitter', name: 'Ring', shape: { size: [4, 0.2, 4] } }, { class: 'Beam', name: 'Ray', from: [0, 0, 0], to: [0, 0, -8] }] })
  assert.deepEqual(effectAnchor(spec), [0, 0, 0])
  assert.equal(centreEffect(spec), spec, 'same object: nothing moved')
  const p = prepareEffect(spec)
  for (const e of p.emitters) assert.ok(near(pos(e.parentAt(0)), DEFAULT_ANCHOR), `${e.name} at the root`)
  assert.ok(near(pos(p.beams[0].a1!(0)), [DEFAULT_ANCHOR[0], DEFAULT_ANCHOR[1], DEFAULT_ANCHOR[2] - 8]))
  // A scripted effect on an empty base: the kit rigs are where the script put them.
  const ops: RecordedOp[] = [
    { op: 'spawn', at: 0, kind: 'orb', opts: { name: 'Ball', at: { __t: 'v3', x: 0, y: 0, z: -5 } } },
    { op: 'stage', at: 0, label: 'charge' }
  ]
  const { effect } = compileTimeline({ name: 'Seq', roots: [], cues: [], duration: 2 }, ops, '-- x')
  assert.equal(centreEffect(effect), effect)
  // Centring is idempotent.
  const once = centreEffect(farBurst())
  assert.equal(centreEffect(once), once)
})

test('a timeline script built on a far-off imported effect: the copy plays at the root with the rigs', () => {
  const base = farBurst()
  // An imported tween (world goal) on the Side part, carried with the copy.
  base.cues.push({ at: 0, target: 'Side', action: 'tween', duration: 1, props: { Position: [126, 50, -300] } })
  const ops: RecordedOp[] = [
    { op: 'stage', at: 0, label: 'charge' },
    { op: 'spawn', at: 0, kind: 'orb', opts: { name: 'Charge' } },
    // A slash rig placed on the copy's Core part.
    { op: 'spawn', at: 0.2, kind: 'slash', opts: { name: 'Cut', parent: 'Core' } },
    // The script's own goal is in the effect's space (studs from the root): it is not moved.
    { op: 'tween', at: 0.2, target: 'Charge', duration: 0.5, props: { Position: { __t: 'v3', x: 0, y: 0, z: -10 } } },
    { op: 'stage', at: 0.4, label: 'impact' }
  ]
  const { effect } = compileTimeline(base, ops, '-- x')
  assert.equal(effect.space, 'local')
  const placed = effectPlacement(effect)
  assert.deepEqual(placed.anchor, [123, 40, -300])
  const nodes = new Map(allNodes(effect.roots).map((n) => [n.name, n]))
  // The Root the script added and the kit rigs stay; the copy moves.
  assert.ok(!placed.moved.has(nodes.get('Root')!.id) && !placed.moved.has(nodes.get('Charge')!.id) && !placed.moved.has(nodes.get('Cut')!.id))
  assert.ok(placed.moved.has(nodes.get('Core')!.id) && placed.moved.has(nodes.get('Side')!.id))
  const anchor = effect.anchor!
  const p = prepareEffect(effect)
  const at = (id: string, t = 0) => pos(p.emitters.find((e) => e.id === id)!.parentAt(t))
  assert.ok(near(at('Fire'), [anchor[0] - 3, anchor[1] + 1, anchor[2]]), `Fire at ${at('Fire')}`)
  assert.ok(near(at('Sparks'), [anchor[0] + 3, anchor[1], anchor[2]]), `Sparks at ${at('Sparks')}`)
  // The imported tween moved with its part: Side rises 10 studs.
  assert.ok(near(at('Sparks', 2), [anchor[0] + 3, anchor[1] + 10, anchor[2]]), `Sparks at ${at('Sparks', 2)}`)
  // The orb rig is at the root and its tween goes 10 studs forward of the root.
  const orb = p.emitters.find((e) => allNodes([nodes.get('Charge')!]).some((n) => n.id === e.id))!
  assert.ok(near(pos(orb.parentAt(0)), anchor), `orb at ${pos(orb.parentAt(0))}`)
  assert.ok(near(pos(orb.parentAt(1)), [anchor[0], anchor[1], anchor[2] - 10]), `orb at ${pos(orb.parentAt(1))}`)
  // The slash rig sits on the copy's Core part (both centred together).
  const cut = p.trails.find((tr) => tr.name === 'CutTrail')!
  const tip = p.emitters.find((e) => e.name === 'CutSparks')!
  const corePos = [anchor[0] - 3, anchor[1], anchor[2]]
  assert.ok(cut.a0 && Math.hypot(...pos(tip.parentAt(0)).map((v, i) => v - corePos[i])) < 4.5, `slash tip ${pos(tip.parentAt(0))} near Core ${corePos}`)
  // The game module plays the same layout relative to the target.
  const lua = luauModule(effect)
  assert.doesNotMatch(lua, /CFrame\.new\(120, 40, -300/)
  assert.match(lua, /CFrame\.new\(-3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  assert.match(lua, /Position = Vector3\.new\(3, 10, 0\)/, 'the imported tween goal, centred')
  assert.match(lua, /model\.PrimaryPart = root/)
})

test('the game module plays an imported effect where it is asked, not at its old world position', async () => {
  const effect = farBurst()
  const lua = luauModule(effect)
  assert.doesNotMatch(lua, /\b120\b|-300/)
  // Core 3 studs left of the anchor, Side 3 right, the ember 2 below.
  assert.match(lua, /CFrame\.new\(-3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  assert.match(lua, /CFrame\.new\(3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  assert.match(lua, /CFrame\.new\(0, -2, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1\)/)
  // The model's pivot is its origin (the anchor), so PivotTo(target) puts the anchor on the target.
  assert.match(lua, /model\.WorldPivot = CFrame\.new\(\)[\s\S]*model:PivotTo\(target\)/)
  // With tweens (runtime module) and no Root part: same pivot, and goals are relative to it.
  const tweened: VfxEffect = { ...effect, cues: [...effect.cues, { at: 0, target: 'Side', action: 'tween', duration: 1, props: { Position: [126, 50, -300] } } as VfxCue] }
  const scripted = luauModule(tweened)
  assert.match(scripted, /model\.WorldPivot = CFrame\.new\(\)\n\tend\n\tmodel:PivotTo\(pivot\(target\)\)/)
  assert.match(scripted, /Position = Vector3\.new\(3, 10, 0\)/)
  assert.match(FORGEFX_SOURCE, /self\.pivot = model:GetPivot\(\)/)
  assert.match(FORGEFX_SOURCE, /local frame = if self\.root then self\.root\.CFrame else self\.pivot/)
  // The exported template (Effect.rbxmx) is centred the same way.
  const dir = await mkdtemp(join(tmpdir(), 'forge-vfx-place-'))
  const svc = new VfxService({ userDir: join(dir, 'user'), projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null } as never)
  const files = await svc.exportFiles({ id: 'x', scope: 'user', kind: 'model', name: 'FireBurst', description: '', tags: [], createdAt: 0, updatedAt: 0, origin: 'FireBurst.rbxm', effect, thumbs: [] } as never, 'src/shared/VFX/FireBurst')
  const template = readRbxmx(files.find((f) => f.path.endsWith('Effect.rbxmx'))!.content)
  const byName = new Map(allNodes(template).map((n) => [n.name, n]))
  assert.deepEqual(pos(byName.get('Core')!.props.CFrame as CFrameArr), [-3, 0, 0])
  assert.deepEqual(pos(byName.get('Side')!.props.CFrame as CFrameArr), [3, 0, 0])
  assert.deepEqual(pos(byName.get('Ember')!.props.CFrame as CFrameArr), [0, -2, 0])
  // Valid Luau (when Lune is installed).
  const lune = process.env.LUNE_PATH || findLune()
  if (!lune) return
  for (const [i, src] of [lua, scripted, FORGEFX_SOURCE].entries()) await writeFile(join(dir, `m${i}.luau`), src)
  await writeFile(join(dir, 'check.luau'), 'local luau = require("@lune/luau")\nlocal fs = require("@lune/fs")\nfor _, f in { "m0.luau", "m1.luau", "m2.luau" } do\n\tluau.compile(fs.readFile(f))\nend\nprint("ok")\n')
  const out = await new Promise<string>((res, rej) => execFile(lune, ['run', 'check.luau'], { cwd: dir }, (err, stdout, stderr) => (err ? rej(new Error(stderr || err.message)) : res(stdout))))
  assert.match(out, /ok/)
})

test('camera framing: presets stay for effects that fit; a large effect pulls the camera back', () => {
  const front = { pos: [5.5, 5.2, -9.5] as Vec3, target: [0, 3.2, -1] as Vec3 }
  // A small effect at the dummy's chest: the preset as it is (same object).
  assert.equal(frameView(front, { min: [-2, 1, -2], max: [2, 5, 2] }), front)
  assert.equal(frameView(front, null), front)
  // A 60-stud explosion: aimed at its centre, far enough to hold the whole sphere, same direction.
  const big = frameView(front, { min: [-30, 0, -30], max: [30, 30, 30] })
  assert.notEqual(big, front)
  assert.ok(near(big.target, [0, 15, 0]))
  const d = Math.hypot(...big.pos.map((v, i) => v - big.target[i]))
  const r = Math.hypot(60, 30, 60) / 2
  assert.ok(d >= r / Math.sin((35 * Math.PI) / 180), `distance ${d}`)
  const dir0 = front.pos.map((v, i) => v - front.target[i])
  const dir1 = big.pos.map((v, i) => v - big.target[i])
  const cos = dir0.reduce((s, v, i) => s + v * dir1[i], 0) / (Math.hypot(...dir0) * Math.hypot(...dir1))
  assert.ok(cos > 0.9999)
})
