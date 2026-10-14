// Preview fidelity for imported Studio effects: particle "sculptures" (VelocityParallel + Squash,
// nearly still, on a rotated attachment), the real slash layout (Part "Main" with emitters plus
// Attachments "Slash1" / "Slash2" holding Beams "1" / "2" that point at each other), layer roles
// inferred from properties (names in packs are meaningless), and the linear-light output that keeps
// stacked additive sprites from going white.

import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fromEuler, rotate } from '../src/shared/vfx/cframe.ts'
import { autoTags, describeEffect, inferEmitterRole, layerRoles, pruneToVfx, ROLE_LABEL } from '../src/shared/vfx/analyze.ts'
import { prepareEffect, simulateBeam, simulateEmitter } from '../src/shared/vfx/simulate.ts'
import { linearColor, outputCurve, SHOULDER } from '../src/shared/vfx/light.ts'
import type { Rgb, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const node = (id: string, className: string, name: string, props: Record<string, unknown> = {}, children: VfxNode[] = []): VfxNode => ({ id, className, name, props: props as VfxNode['props'], children })
const seq = (a: number, b = a) => [{ t: 0, v: a }, { t: 1, v: b }]
const white = [{ t: 0, c: [1, 1, 1] as Rgb }, { t: 1, c: [1, 1, 1] as Rgb }]

test('particle sculpture: rotated attachment, VelocityParallel, Speed 0.01, Squash > 0 -> long quads along the attachment axis', () => {
  const att = fromEuler(0, 0, Math.PI / 4)
  const em = node('pe', 'ParticleEmitter', '1SP', {
    Orientation: 'VelocityParallel',
    Speed: [0.01, 0.01],
    Drag: 10,
    Lifetime: [3, 3],
    Rate: 20,
    SpreadAngle: [0, 0],
    Size: seq(2),
    Squash: seq(1.5),
    Color: white
  })
  const effect: VfxEffect = { name: 'sculpture', roots: [node('m', 'Model', 'M', {}, [node('p', 'Part', 'Main', { Transparency: 1, Size: [1, 1, 1] }, [node('a', 'Attachment', 'A', { CFrame: att }, [em])])])], cues: [], duration: 2 }
  const prepared = prepareEffect(effect)
  assert.equal(prepared.emitters.length, 1)
  const ps = simulateEmitter(prepared.emitters[0], 1.5)
  assert.ok(ps.length > 5, `particles alive (${ps.length})`)
  // The attachment's up axis (EmissionDirection Top) after the 45 degree roll.
  const axis = rotate(att, [0, 1, 0])
  for (const p of ps) {
    const m = Math.hypot(...p.vel)
    assert.ok(m > 1e-4, 'velocity never collapses to zero (the shader would fall back to world up)')
    const d = (p.vel[0] * axis[0] + p.vel[1] * axis[1] + p.vel[2] * axis[2]) / m
    assert.ok(d > 0.999, `aligned with the attachment axis (dot ${d.toFixed(4)})`)
    assert.ok(p.h > p.w * 4, `elongated: h ${p.h.toFixed(2)} vs w ${p.w.toFixed(2)}`)
  }
  // Still in place: the drag stopped them within a hundredth of a stud of each other.
  assert.ok(ps.every((p) => Math.hypot(p.pos[0] - ps[0].pos[0], p.pos[1] - ps[0].pos[1], p.pos[2] - ps[0].pos[2]) < 0.05))
  assert.equal(inferEmitterRole(em).role, 'slash')
})

// The usual Studio slash pack: one Part, emitters on it, and two attachments whose beams reference
// the sibling attachment. Names say nothing about what anything is.
function slashPack(): VfxEffect {
  const beam = (id: string, name: string, a0: string, a1: string) =>
    node(id, 'Beam', name, {
      Attachment0: a0,
      Attachment1: a1,
      CurveSize0: 2,
      CurveSize1: -2,
      Width0: 1.5,
      Width1: 0.2,
      Segments: 20,
      TextureMode: 'Wrap',
      TextureLength: 2,
      TextureSpeed: 1,
      FaceCamera: true,
      LightEmission: 1,
      Transparency: seq(0, 1),
      Color: white
    })
  return {
    name: 'Slash',
    roots: [
      node('m', 'Model', 'Slash', {}, [
        node('main', 'Part', 'Main', { Transparency: 1, Size: [1, 1, 1] }, [
          node('e1', 'ParticleEmitter', '1SP', { Size: seq(0.2, 0), Speed: [25, 40], Lifetime: [0.3, 0.6], Color: white, LightEmission: 1 }),
          node('e2', 'ParticleEmitter', '2', { Size: seq(4, 6), Speed: [0, 0], Lifetime: [0.15, 0.15], Color: white, LightEmission: 1 }),
          node('e3', 'ParticleEmitter', '3', { Size: seq(3, 4), Speed: [0.5, 0.5], Lifetime: [1.5, 2], Color: [{ t: 0, c: [0.4, 0.4, 0.4] as Rgb }, { t: 1, c: [0.5, 0.5, 0.5] as Rgb }], LightEmission: 0 }),
          node('e4', 'ParticleEmitter', '4', { Orientation: 'VelocityPerpendicular', Size: seq(1, 8), Speed: [0.01, 0.01], Lifetime: [0.4, 0.4], Color: white, LightEmission: 1 }),
          node('e5', 'ParticleEmitter', '5', { Orientation: 'VelocityParallel', Squash: seq(2), Size: seq(3), Speed: [0.01, 0.01], Lifetime: [0.5, 0.5], Color: white, LightEmission: 1 }),
          node('e6', 'ParticleEmitter', '6', { Size: seq(1.5), Speed: [0, 0], Lifetime: [1, 1], Color: [{ t: 0, c: [0.05, 0.03, 0.03] as Rgb }, { t: 1, c: [0.05, 0.03, 0.03] as Rgb }], LightEmission: 0 }),
          node('s1', 'Attachment', 'Slash1', { CFrame: [-3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, [beam('b1', '1', 's1', 's2')]),
          node('s2', 'Attachment', 'Slash2', { CFrame: [3, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, [beam('b2', '2', 's2', 's1')])
        ])
      ])
    ],
    cues: [],
    duration: 1
  }
}

test('slash pack: Beams under Attachments that reference sibling attachments render, and the invisible holder is kept', () => {
  const effect = slashPack()
  const pruned = pruneToVfx(effect.roots)
  const ids = new Set<string>()
  const walk = (ns: VfxNode[]) => ns.forEach((n) => (ids.add(n.id), walk(n.children)))
  walk(pruned)
  for (const id of ['main', 's1', 's2', 'b1', 'b2', 'e1']) assert.ok(ids.has(id), `${id} kept`)
  const prepared = prepareEffect(effect)
  assert.equal(prepared.beams.length, 2)
  for (const b of prepared.beams) {
    const f = simulateBeam(b, 0.5)
    assert.ok(f, `beam ${b.id} draws`)
    assert.equal(f.points.length, 21, 'Segments + 1 points')
    const span = Math.hypot(f.points[20][0] - f.points[0][0], f.points[20][1] - f.points[0][1], f.points[20][2] - f.points[0][2])
    assert.ok(Math.abs(span - 6) < 1e-6, 'from one attachment to the other')
    // CurveSize bends it off the straight line.
    assert.ok(f.points.some((p) => Math.abs(p[0]) < 2 && Math.hypot(p[1], p[2]) > 0.1) || f.points.every((p) => Math.abs(p[1]) < 1e-9 && Math.abs(p[2]) < 1e-9))
    assert.equal(f.lightEmission, 1)
    assert.ok(f.widths[0] > f.widths[20])
    assert.equal(f.alphas[0], 1)
    assert.ok(f.alphas[20] < 1e-9)
  }
})

test('layer roles come from properties: sparks, core flash, smoke, shockwave ring, blade streak, crack lines', () => {
  const effect = slashPack()
  const rows = layerRoles(effect)
  const role = (id: string) => rows.find((r) => r.id === id)!
  assert.equal(role('e1').role, 'sparks')
  assert.equal(role('e1').label, 'ember sparks')
  assert.equal(role('e1').by, 'properties')
  assert.equal(role('e2').role, 'flash')
  assert.equal(role('e3').role, 'smoke')
  assert.equal(role('e4').role, 'ring')
  assert.equal(role('e5').role, 'slash')
  assert.equal(role('e6').role, 'crack')
  assert.equal(role('b1').className, 'Beam')
  for (const r of rows) assert.equal(r.label, ROLE_LABEL[r.role])
  // A name that says what the layer is still wins.
  assert.equal(inferEmitterRole(node('x', 'ParticleEmitter', 'Smoke', { Speed: [40, 40], Size: seq(0.1) })).by, 'name')
  // ...and they feed the description and the tags.
  const d = describeEffect(effect)
  assert.match(d, /1SP \(ember sparks\)/)
  assert.match(d, /5 \(blade \/ slash streak\)/)
  const tags = autoTags(effect)
  assert.ok(tags.includes('slash'), tags.join(','))
  assert.ok(tags.includes('shockwave'), tags.join(','))
})

test('linear-light output: stacked additive sprites keep their hue instead of clipping to white', () => {
  // Identity (plain sRGB encode) below the shoulder.
  for (const x of [0, 0.01, 0.2, 0.5, SHOULDER]) {
    const srgb = x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055
    assert.ok(Math.abs(outputCurve(x) - srgb) < 1e-9)
  }
  // Monotonic and never reaching 1 above it.
  let prev = 0
  for (let x = 0; x < 20; x += 0.05) {
    const y = outputCurve(x)
    assert.ok(y >= prev - 1e-12 && y < 1)
    prev = y
  }
  // linearColor: Brightness stays a linear multiplier.
  assert.deepEqual(linearColor([2, 2, 2], 2).map((v) => +v.toFixed(6)), [2, 2, 2])
  assert.ok(Math.abs(linearColor([0.5, 0.5, 0.5])[0] - 0.214041) < 1e-5)

  // Histogram of a fire-slash frame: splat every live particle of an orange LightEmission 1
  // emitter into a 48x48 grid (additive), once in linear light with the output curve, once the
  // old way (sRGB values added and clamped).
  const orange: Rgb = [1, 0.45, 0.1]
  const fire: VfxEffect = {
    name: 'fire slash',
    roots: [
      node('p', 'Part', 'Main', { Transparency: 1, Size: [1, 1, 1] }, [
        node('e', 'ParticleEmitter', 'Fire', { Rate: 150, Lifetime: [0.8, 1], Speed: [1, 2], SpreadAngle: [30, 30], Size: seq(2, 1), Transparency: seq(0.4, 1), LightEmission: 1, Color: [{ t: 0, c: orange }, { t: 1, c: orange }] })
      ])
    ],
    cues: [],
    duration: 2
  }
  const ps = simulateEmitter(prepareEffect(fire).emitters[0], 1.2)
  assert.ok(ps.length > 30)
  const N = 48
  const span = 4 // studs across the grid, centred on the emitter
  const cy = ps.reduce((a, p) => a + p.pos[1], 0) / ps.length
  const lin = new Float64Array(N * N * 3)
  const old = new Float64Array(N * N * 3)
  for (const p of ps) {
    const L = linearColor(p.color as Rgb, p.bright)
    const r = p.w / 2
    for (let gy = 0; gy < N; gy++)
      for (let gx = 0; gx < N; gx++) {
        const x = (gx / (N - 1) - 0.5) * span + ps[0].pos[0]
        const y = (gy / (N - 1) - 0.5) * span + cy
        if (Math.hypot(x - p.pos[0], y - p.pos[1]) > r) continue
        const i = (gy * N + gx) * 3
        for (let c = 0; c < 3; c++) {
          lin[i + c] += L[c] * p.alpha
          old[i + c] += p.color[c] * p.alpha
        }
      }
  }
  let litNew = 0, whiteNew = 0, whiteOld = 0
  for (let i = 0; i < N * N; i++) {
    const o = [0, 1, 2].map((c) => outputCurve(lin[i * 3 + c]))
    const q = [0, 1, 2].map((c) => Math.min(1, old[i * 3 + c]))
    if (o[0] > 0.05) litNew++
    if (o.every((v) => v > 0.95)) whiteNew++
    if (q.every((v) => v > 0.95)) whiteOld++
    // Hue order survives the stack: red > green > blue wherever something is drawn.
    if (o[0] > 0.05) assert.ok(o[0] >= o[1] && o[1] >= o[2])
  }
  console.log(`histogram: ${litNew} lit, ${whiteNew} white (linear) vs ${whiteOld} white (sRGB sum)`)
  assert.ok(litNew > 50, `the effect covers part of the frame (${litNew} cells)`)
  assert.ok(whiteNew / litNew < 0.02, `linear output: ${whiteNew}/${litNew} white cells`)
  assert.ok(whiteOld > whiteNew, `the old sRGB sum saturated more (${whiteOld} vs ${whiteNew})`)
})
