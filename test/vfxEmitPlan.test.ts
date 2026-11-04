// The ForgeVFX plan (src/shared/vfx/emitPlan.ts, docs/vfx-emit.md): attribute inheritance with
// additive EmitDelay, particle bursts identical to the old cuesFromAttributes rules, FadeOut,
// mesh effects (Start -> End copies: spawn counts, lifetimes, easing like TweenService:GetValue,
// spread / init rotation / spin) and the Lab preview drawing the copies (not the templates).
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { applyEase, attrRange, attrVec, easeValue, emitPlan, EASING_DIRECTIONS, EASING_STYLES, fadeAt, makeMeshEffect, meshCopyAt, parseEase, planLength } from '../src/shared/vfx/emitPlan.ts'
import { allNodes, cuesFromAttributes, editAttr, effectFromNodes, emitAttributes, pruneToVfx } from '../src/shared/vfx/analyze.ts'
import { prepareEffect, simulate, simulateEmitter } from '../src/shared/vfx/simulate.ts'
import { decodeAttributes, encodeAttributes, readRbxmx } from '../src/shared/vfx/rbxmx.ts'
import { normalizeLuneNode } from '../src/main/services/vfx/lune.ts'
import { anglesXYZ, rotate } from '../src/shared/vfx/cframe.ts'
import type { PropValue, VfxAttrValue, VfxCue, VfxEffect, VfxNode } from '../src/shared/vfx/types.ts'

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps
const nearArr = (a: number[], b: number[], eps = 1e-6) => a.length === b.length && a.every((x, i) => near(x, b[i], eps))

let nextId = 0
function node(className: string, name: string, props: Record<string, PropValue> = {}, attrs?: Record<string, VfxAttrValue>, children: VfxNode[] = []): VfxNode {
  return { id: `${name}-${nextId++}`, className, name, props, children, ...(attrs ? { attrs } : {}) }
}
const at = (x: number, y: number, z: number) => [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]

// ------------------------------------------------------------------ easing

test('easing matches TweenService:GetValue', () => {
  const v = (s: Parameters<typeof easeValue>[0], d: Parameters<typeof easeValue>[1], t: number) => easeValue(s, d, t)
  assert.equal(v('Quad', 'Out', 0.5), 0.75)
  assert.equal(v('Quad', 'In', 0.5), 0.25)
  assert.equal(v('Quad', 'InOut', 0.25), 0.125)
  assert.equal(v('Linear', 'InOut', 0.3), 0.3)
  assert.ok(near(v('Sine', 'Out', 0.5), Math.SQRT1_2))
  assert.ok(near(v('Sine', 'InOut', 0.5), 0.5))
  assert.equal(v('Cubic', 'Out', 0.5), 0.875)
  assert.equal(v('Quart', 'Out', 0.5), 0.9375)
  assert.equal(v('Quint', 'Out', 0.5), 0.96875)
  assert.equal(v('Exponential', 'Out', 0.5), 0.96875)
  assert.ok(near(v('Circular', 'Out', 0.5), Math.sqrt(0.75)))
  // Back overshoots (s = 1.70158).
  assert.ok(near(v('Back', 'Out', 0.5), 1.0876975), `Back.Out ${v('Back', 'Out', 0.5)}`)
  assert.ok(near(v('Back', 'In', 0.5), -0.0876975))
  assert.ok(near(v('Back', 'InOut', 0.25), -0.0996818, 1e-6), `Back.InOut ${v('Back', 'InOut', 0.25)}`)
  // Elastic (period 0.3) and Bounce.
  assert.ok(near(v('Elastic', 'Out', 0.5), 1.015625), `Elastic.Out ${v('Elastic', 'Out', 0.5)}`)
  assert.ok(near(v('Elastic', 'In', 0.5), -0.015625))
  assert.equal(v('Bounce', 'Out', 0.5), 0.765625)
  assert.equal(v('Bounce', 'In', 0.5), 0.234375)
  assert.ok(near(v('Bounce', 'Out', 0.9), 0.988125))
  for (const s of EASING_STYLES)
    for (const d of EASING_DIRECTIONS) {
      assert.ok(near(v(s, d, 0), 0, 1e-9), `${s}.${d}(0)`)
      assert.ok(near(v(s, d, 1), 1, 1e-9), `${s}.${d}(1)`)
      if (d === 'InOut') assert.ok(near(v(s, d, 0.5), 0.5, 1e-9), `${s}.InOut(0.5)`)
    }
})

test('Ease strings and NumberSequence curves', () => {
  assert.deepEqual(parseEase('Quad.Out'), { style: 'Quad', direction: 'Out' })
  assert.deepEqual(parseEase('back.inout'), { style: 'Back', direction: 'InOut' })
  assert.deepEqual(parseEase('Sine'), { style: 'Sine', direction: 'Out' })
  assert.deepEqual(parseEase('Enum.EasingStyle.Elastic'), { style: 'Elastic', direction: 'Out' })
  assert.deepEqual(parseEase('Wobbly.Out'), { style: 'Quad', direction: 'Out' }, 'unknown -> Quad.Out')
  assert.deepEqual(parseEase(undefined), { style: 'Quad', direction: 'Out' })
  const curve = parseEase([
    { t: 0, v: 0 },
    { t: 0.5, v: 1.25 },
    { t: 1, v: 1 }
  ])
  assert.ok('curve' in curve)
  assert.equal(applyEase(curve, 0.5), 1.25, 'overshoot kept')
  assert.equal(applyEase(curve, 0.75), 1.125)
  assert.deepEqual(attrRange([0.4, 0.2]), [0.2, 0.4])
  assert.deepEqual(attrRange(0.7), [0.7, 0.7])
  assert.deepEqual(attrRange('0.3 0.5'), [0.3, 0.5])
  assert.deepEqual(attrVec('10, 20', 2), [10, 20])
  assert.deepEqual(attrVec([1, 2], 3), [1, 2, 0])
})

// ------------------------------------------------------------------ layers

test('inheritance: EmitDelay adds up the ancestors, the rest is the nearest value', () => {
  const em = node('ParticleEmitter', 'Sparks', { Enabled: false }, { EmitDelay: 0.1 })
  const att = node('Attachment', 'A', {}, { EmitDelay: '0.2', EmitCount: 7 }, [em])
  const model = node('Model', 'Fx', {}, { EmitDelay: 0.3, EmitCount: 3, EmitDuration: 2 }, [node('Part', 'P', {}, undefined, [att])])
  const plan = emitPlan([model])
  const l = plan.layers.find((x) => x.id === em.id)!
  assert.ok(near(l.attrs.delay, 0.6))
  assert.equal(l.attrs.count, 7, 'nearest EmitCount')
  assert.equal(l.attrs.duration, 2, 'inherited EmitDuration')
  assert.deepEqual(emitAttributes([model]).get(em.id), l.attrs)
})

// The rules cuesFromAttributes had before the plan (own value else nearest ancestor), for parity on
// trees where only one EmitDelay lies on each path (the additive rule then agrees).
function legacyCues(nodes: VfxNode[]): VfxCue[] {
  const r = (x: number) => Math.round(x * 1000) / 1000
  const cues: VfxCue[] = []
  const visit = (n: VfxNode, inh: Record<string, number>) => {
    const here = { ...inh }
    for (const k of ['EmitCount', 'EmitDelay', 'EmitDuration']) if (typeof n.attrs?.[k] === 'number') here[k] = n.attrs[k] as number
    if (['ParticleEmitter', 'Beam', 'Trail'].includes(n.className) && Object.keys(here).length) {
      const a = { delay: here.EmitDelay ?? 0, count: here.EmitCount, duration: here.EmitDuration && here.EmitDuration > 0 ? here.EmitDuration : undefined }
      const startsOn = n.props.Enabled !== false
      if (n.className !== 'ParticleEmitter') {
        if (startsOn && (a.delay > 0 || a.duration)) cues.push({ at: 0, target: n.id, action: 'disable' })
        cues.push({ at: r(a.delay), target: n.id, action: 'enable' })
        if (a.duration) cues.push({ at: r(a.delay + a.duration), target: n.id, action: 'disable' })
      } else {
        if (startsOn) cues.push({ at: 0, target: n.id, action: 'disable' })
        const rate = Number(n.props.Rate ?? 20)
        if (a.duration && rate <= 0 && a.count) {
          const steps = Math.max(1, Math.min(60, a.count, Math.round(a.duration * 30)))
          let sent = 0
          for (let i = 0; i < steps; i++) {
            const want = Math.round(((i + 1) * a.count) / steps)
            if (want > sent) cues.push({ at: r(a.delay + (i * a.duration) / steps), target: n.id, action: 'emit', count: want - sent })
            sent = want
          }
        } else {
          if (a.count) cues.push({ at: r(a.delay), target: n.id, action: 'emit', count: a.count })
          if (a.duration) {
            cues.push({ at: r(a.delay), target: n.id, action: 'enable' })
            cues.push({ at: r(a.delay + a.duration), target: n.id, action: 'disable' })
          } else if (a.count === undefined) cues.push({ at: r(a.delay), target: n.id, action: 'emit', count: Math.max(8, Math.round(rate * 0.25)) })
        }
      }
    }
    for (const c of n.children) visit(c, here)
  }
  nodes.forEach((n) => visit(n, {}))
  return cues
}

test('particle cues: the plan equals the old cuesFromAttributes rules', () => {
  const ems = [
    node('ParticleEmitter', 'Burst', { Enabled: false, Rate: 30 }, { EmitCount: 20, EmitDelay: 0.3 }),
    node('ParticleEmitter', 'Spread', { Rate: 0 }, { EmitCount: 12, EmitDuration: 0.5 }),
    node('ParticleEmitter', 'Spread2', { Rate: 0 }, { EmitCount: 90, EmitDuration: 3, EmitDelay: 0.25 }),
    node('ParticleEmitter', 'Window', { Rate: 10 }, { EmitDelay: 0.2, EmitDuration: 1 }),
    node('ParticleEmitter', 'OnlyDelay', { Rate: 80 }, { EmitDelay: 0.4 }),
    node('ParticleEmitter', 'Both', { Rate: 15 }, { EmitCount: 5, EmitDuration: 0.7 }),
    node('ParticleEmitter', 'Plain', { Rate: 5 })
  ]
  const inherited = node('Attachment', 'A', {}, { EmitCount: 4, EmitDelay: 0.15 }, [node('ParticleEmitter', 'Kid', { Enabled: false })])
  const roots = [node('Model', 'M', {}, undefined, [...ems, inherited])]
  const plan = cuesFromAttributes(roots)
  const sort = (c: VfxCue[]) => [...c].sort((a, b) => a.target.localeCompare(b.target) || a.at - b.at || a.action.localeCompare(b.action))
  assert.deepEqual(sort(plan), sort(legacyCues(roots)))
  assert.ok(!plan.some((c) => c.target === ems[6].id), 'emitters without attributes get no cues')
})

test('beams / trails / lights: windows, open windows close at Duration, FadeOut', () => {
  const beam = node('Beam', 'Beam', {}, { EmitDelay: 0.2, EmitDuration: 1, FadeOut: 0.4 })
  const light = node('PointLight', 'Glow', { Brightness: 4 }, { EmitDelay: 0.3, FadeOut: 0.5 })
  const plan = emitPlan([node('Model', 'M', {}, undefined, [node('Part', 'P', {}, undefined, [beam, light])])])
  const b = plan.layers.find((l) => l.id === beam.id)!
  assert.deepEqual(b.windows, [[0.2, 1.2]])
  assert.deepEqual(b.fade, [0.8, 1.2])
  assert.equal(fadeAt(b.fade, 0.5), 1)
  assert.ok(near(fadeAt(b.fade, 1.0), 0.5))
  assert.equal(fadeAt(b.fade, 1.2), 0)
  // The light's open window makes Duration >= 0.3 + 1 and closes there.
  assert.equal(plan.duration, 1.3)
  const l = plan.layers.find((x) => x.id === light.id)!
  assert.deepEqual(l.windows, [[0.3, 1.3]])
  assert.deepEqual(l.fade, [0.8, 1.3])
  assert.deepEqual(
    l.cues.map((c) => [c.action, c.at]),
    [
      ['disable', 0],
      ['enable', 0.3],
      ['disable', 1.3]
    ]
  )
})

test('Duration and linger', () => {
  const em = node('ParticleEmitter', 'E', { Enabled: false, Lifetime: [1, 2] }, { EmitDelay: 0.5, EmitCount: 10 })
  const trail = node('Trail', 'T', { Lifetime: 0.6 }, { EmitDuration: 0.4 })
  const plan = emitPlan([node('Model', 'M', {}, undefined, [em, trail])])
  assert.equal(plan.duration, 0.5)
  assert.equal(plan.linger, 2, 'particles of the last burst live up to Lifetime.Max')
  assert.equal(planLength(plan), 2.5)
  // Nothing timed but a running emitter: one second.
  assert.equal(emitPlan([node('Model', 'M', {}, { FadeOut: 1 }, [node('ParticleEmitter', 'Run', { Rate: 5 })])]).duration, 1)
  const meshOnly = emitPlan([meshFx({ Lifetime: 0 }), node('ParticleEmitter', 'Run', { Rate: 5 })])
  assert.equal(meshOnly.duration, 1)
})

// ------------------------------------------------------------------ mesh effects

function meshFx(attrs: Record<string, VfxAttrValue>, startKids: VfxNode[] = [], extra: { start?: Record<string, PropValue>; end?: Record<string, PropValue> } = {}): VfxNode {
  const start = node('Part', 'Start', { CFrame: at(0, 0, 0), Size: [1, 1, 1], Transparency: 0, Color: [1, 0, 0], ...extra.start }, undefined, startKids)
  const end = node('Part', 'End', { CFrame: at(0, 10, 0), Size: [5, 5, 5], Transparency: 1, Color: [0, 0, 1], ...extra.end })
  return node('Model', 'Wave', {}, attrs, [start, end])
}

test('mesh effect spawns: EmitCount, Rate x EmitDuration, spread over EmitDuration', () => {
  const one = emitPlan([meshFx({})]).meshEffects[0]
  assert.equal(one.copies.length, 1, 'default EmitCount 1')
  assert.equal(one.copies[0].spawn, 0)
  assert.equal(one.copies[0].life, 0.5, 'default Lifetime 0.5')
  const burst = emitPlan([meshFx({ EmitCount: 3, EmitDelay: 0.2 })]).meshEffects[0]
  assert.deepEqual(
    burst.copies.map((c) => c.spawn),
    [0.2, 0.2, 0.2]
  )
  const rate = emitPlan([meshFx({ EmitCount: 2, Rate: 10, EmitDuration: 1 })]).meshEffects[0]
  assert.equal(rate.copies.length, 20, '10 bursts of 2 in [0, 1)')
  assert.ok(near(rate.copies[19].spawn, 0.9))
  const spread = emitPlan([meshFx({ EmitCount: 4, EmitDuration: 1, EmitDelay: 0.5 })]).meshEffects[0]
  assert.deepEqual(
    spread.copies.map((c) => c.spawn),
    [0.5, 0.75, 1, 1.25]
  )
  // Container delay adds to the mesh effect's.
  const nested = emitPlan([node('Folder', 'F', {}, { EmitDelay: 1 }, [meshFx({ EmitDelay: 0.25 })])]).meshEffects[0]
  assert.equal(nested.copies[0].spawn, 1.25)
  // Lifetime range: seeded, in range, Duration covers the last death.
  const rangedFx = meshFx({ EmitCount: 8, Lifetime: [0.4, 0.8] })
  const ranged = emitPlan([rangedFx], { seed: 3 })
  const lives = ranged.meshEffects[0].copies.map((c) => c.life)
  assert.ok(lives.every((x) => x >= 0.4 && x <= 0.8))
  assert.ok(new Set(lives).size > 1)
  assert.deepEqual(emitPlan([rangedFx], { seed: 3 }).meshEffects[0].copies.map((c) => c.life), lives, 'deterministic per seed')
  assert.ok(near(ranged.duration, Math.round(Math.max(...lives) * 1000) / 1000))
})

test('mesh copy state: CFrame, Size, Transparency, Color eased; curves overshoot', () => {
  const lin = emitPlan([meshFx({ Lifetime: 1, Ease: 'Linear.InOut' })]).meshEffects[0]
  const mid = meshCopyAt(lin, lin.copies[0], 0.5)
  assert.ok(mid.alive)
  assert.ok(nearArr(mid.cframe.slice(0, 3), [0, 5, 0]))
  assert.ok(nearArr(mid.size, [3, 3, 3]))
  assert.equal(mid.transparency, 0.5)
  assert.ok(nearArr(mid.color, [0.5, 0, 0.5]))
  assert.equal(meshCopyAt(lin, lin.copies[0], 1).alive, false, 'dead at spawn + life')
  // Default Quad.Out: size at half life = 1 + 4 * 0.75.
  const quad = emitPlan([meshFx({ Lifetime: 1 })]).meshEffects[0]
  assert.ok(nearArr(meshCopyAt(quad, quad.copies[0], 0.5).size, [4, 4, 4]))
  // Per-property ease: a NumberSequence curve for Size with overshoot; Transparency stays Linear.
  const curve = emitPlan([
    meshFx({
      Lifetime: 1,
      Ease: 'Linear.In',
      EaseSize: [
        { t: 0, v: 0 },
        { t: 0.5, v: 1.2 },
        { t: 1, v: 1 }
      ]
    })
  ]).meshEffects[0]
  const c = meshCopyAt(curve, curve.copies[0], 0.5)
  assert.ok(nearArr(c.size, [5.8, 5.8, 5.8]))
  assert.equal(c.transparency, 0.5)
})

test('mesh copy: Spin about its centre, SpreadAngle / InitRot about the pivot', () => {
  const spin = emitPlan([meshFx({ Lifetime: 2, Ease: 'Linear', Spin: [0, 90, 0] })]).meshEffects[0]
  const s = meshCopyAt(spin, spin.copies[0], 1)
  // 90 degrees about Y after one second: local +X points along world -Z.
  assert.ok(nearArr(rotate(s.cframe, [1, 0, 0]), [0, 0, -1]))
  assert.ok(nearArr(s.cframe.slice(0, 3), [0, 5, 0]), 'position unaffected by spin')
  // Spread: each copy's path is tilted around the pivot (Start's position): distance kept.
  const sp = emitPlan([meshFx({ EmitCount: 6, Lifetime: 1, Ease: 'Linear', SpreadAngle: [40, 40] })]).meshEffects[0]
  for (const copy of sp.copies) {
    assert.ok(Math.abs(copy.spread[0]) <= 40 && Math.abs(copy.spread[1]) <= 40)
    const p = meshCopyAt(sp, copy, 0.999).cframe
    assert.ok(near(Math.hypot(p[0], p[1], p[2]), 9.99, 1e-6))
    const expect = rotate(anglesXYZ((copy.spread[0] * Math.PI) / 180, (copy.spread[1] * Math.PI) / 180, 0), [0, 9.99, 0])
    assert.ok(nearArr(p.slice(0, 3), expect, 1e-6))
  }
  assert.ok(sp.copies.some((c) => Math.abs(c.spread[0]) > 1), 'copies differ')
  // Init rotation: Min = Max -> exactly that rotation.
  const rot = emitPlan([meshFx({ Lifetime: 1, Ease: 'Linear', MinInitRot: [0, 0, 90], MaxInitRot: [0, 0, 90] })]).meshEffects[0]
  assert.ok(nearArr(meshCopyAt(rot, rot.copies[0], 0.5).cframe.slice(0, 3), [-5, 0, 0]))
})

test('decals and SpecialMesh animate by name; riding emitters are timed per copy', () => {
  const decal = (name: string, tr: number, col: [number, number, number]) => node('Decal', name, { Texture: 'rbxassetid://1', Transparency: tr, Color3: col })
  const em = node('ParticleEmitter', 'Sparks', { Enabled: false, Lifetime: [0.3, 0.3] }, { EmitDelay: 0.1, EmitCount: 5 })
  const fx = meshFx({ Lifetime: 1, Ease: 'Linear', EmitCount: 2, Rate: 2, EmitDuration: 1, EmitDelay: 0.5 }, [decal('Face', 0, [1, 1, 1]), node('SpecialMesh', 'Mesh', { MeshType: 'Sphere', Scale: [1, 1, 1] }), em])
  const end = fx.children[1]
  end.children.push(decal('Face', 1, [0, 0, 0]), node('SpecialMesh', 'Mesh', { MeshType: 'Sphere', Scale: [3, 3, 3] }))
  const plan = emitPlan([fx])
  const m = plan.meshEffects[0]
  assert.equal(m.copies.length, 4)
  const st = meshCopyAt(m, m.copies[0], 1)
  assert.deepEqual(st.decals.Face, { transparency: 0.5, color: [0.5, 0.5, 0.5] })
  assert.ok(nearArr(st.meshScale!, [2, 2, 2]))
  // Riding emitter: inheritance restarts at Start (the Model's EmitDelay 0.5 / EmitCount 2 do not
  // apply): a burst of 5 at spawn + 0.1 for every copy.
  for (const c of m.copies) assert.deepEqual(c.riding.map((l) => l.bursts), [[{ at: Math.round((c.spawn + 0.1) * 1000) / 1000, count: 5 }]])
  assert.ok(near(plan.duration, 2), 'last copy: spawn 1.0 + life 1')
})

// ------------------------------------------------------------------ import and preview

test('import keeps mesh effects and their attributes; the preview draws copies, not the templates', () => {
  const ride = node('ParticleEmitter', 'Ride', { Enabled: false, Rate: 0, Lifetime: [0.5, 0.5] }, { EmitCount: 6 })
  const fx = meshFx({ Lifetime: [1, 1], Ease: 'Linear', EmitCount: 1 }, [ride], { end: { Size: [5, 5, 5], Transparency: 1, CFrame: at(0, 0, 0) } })
  const effect: VfxEffect = { ...effectFromNodes('Wave', [fx]), anchor: [0, 0, 0], motion: 'static' }
  // End is fully transparent but kept (template), with its attributes.
  const names = allNodes(effect.roots).map((n) => n.name)
  assert.ok(names.includes('Start') && names.includes('End'))
  assert.deepEqual(effect.roots[0].attrs?.Lifetime, [1, 1])
  // No cues for the template's emitter (no default burst guess); the duration comes from the plan.
  assert.ok(!effect.cues.some((c) => c.target === ride.id))
  assert.ok(effect.duration >= 1)
  const p = prepareEffect(effect, 1)
  assert.ok(!p.meshes.some((m) => m.id === fx.children[0].id || m.id === fx.children[1].id), 'templates not drawn')
  const copy = p.meshes.find((m) => m.copy)!
  assert.ok(copy)
  const a = copy.look(0.1)
  const b = copy.look(0.8)
  assert.ok(b.size[0] > a.size[0] + 2, 'grows')
  assert.ok(b.transparency > a.transparency + 0.5, 'fades')
  assert.equal(copy.look(1.05).transparency, 1, 'hidden after its life')
  // The riding emitter bursts 6 at the copy's spawn.
  const em = p.emitters.find((e) => e.copyOf === ride.id)!
  assert.deepEqual(em.bursts, [{ at: 0, count: 6 }])
  assert.equal(simulateEmitter(em, 0.2, 1).length, 6)
  assert.ok(!p.emitters.some((e) => e.id === ride.id), 'the template emitter itself does not play')
  // Every frame of the copy matches the plan exactly.
  const m = p.plan.meshEffects[0]
  for (const t of [0, 0.25, 0.5, 0.75]) {
    const st = meshCopyAt(m, m.copies[0], t)
    assert.ok(nearArr(copy.look(t).size, st.size))
    assert.equal(copy.look(t).transparency, st.transparency)
  }
  // pruneToVfx keeps a mesh effect even when nothing in it is visible.
  const hidden = meshFx({}, [], { start: { Transparency: 1 } })
  assert.equal(pruneToVfx([hidden]).length, 1)
})

test('preview FadeOut: beam alpha ramps down over the last FadeOut seconds', () => {
  const a0 = node('Attachment', 'A0', { CFrame: at(0, 0, 0) })
  const a1 = node('Attachment', 'A1', { CFrame: at(0, 4, 0) })
  const beam = node('Beam', 'Beam', { Attachment0: a0.id, Attachment1: a1.id, Transparency: [{ t: 0, v: 0 }, { t: 1, v: 0 }] }, { EmitDuration: 1, FadeOut: 0.5 })
  const effect: VfxEffect = { ...effectFromNodes('B', [node('Part', 'P', { Transparency: 1 }, undefined, [a0, a1, beam])]), anchor: [0, 0, 0] }
  const p = prepareEffect(effect, 1)
  const alpha = (t: number) => simulate(p, t).beams[0]?.alphas[0] ?? 0
  assert.equal(alpha(0.25), 1)
  assert.ok(near(alpha(0.75), 0.5, 1e-9))
  assert.equal(alpha(1.1), 0)
})

test('attributes survive .rbxmx and Lune JSON (NumberRange, Vector2/3, NumberSequence)', () => {
  const attrs: Record<string, VfxAttrValue> = { Lifetime: [0.4, 0.6], SpreadAngle: [10, 20], Spin: [0, 180, 0], EaseSize: [{ t: 0, v: 0 }, { t: 0.5, v: 1.25 }, { t: 1, v: 1 }], Ease: 'Back.Out', EmitCount: 3, SyncPosition: true }
  assert.deepEqual(decodeAttributes(encodeAttributes(attrs)), attrs)
  const xml = `<roblox version="4"><Item class="Model" referent="M"><Properties><string name="Name">Wave</string><BinaryString name="AttributesSerialize">${encodeAttributes(attrs)}</BinaryString></Properties></Item></roblox>`
  assert.deepEqual(readRbxmx(xml)[0].attrs, attrs)
  const lune = normalizeLuneNode({ id: 'm', className: 'Model', name: 'Wave', props: {}, children: [], attrs: { Lifetime: [0.4, 0.6], EaseSize: [{ t: 0, v: 0, e: 0 }, { t: 1, v: 1, e: 0 }], Bad: { x: 1 } } })
  assert.deepEqual(lune.attrs, { Lifetime: [0.4, 0.6], EaseSize: [{ t: 0, v: 0 }, { t: 1, v: 1 }] })
})

test('editing attributes re-times the effect; Add mesh effect makes a growing, fading ring', () => {
  const em = node('ParticleEmitter', 'E', { Enabled: false, Rate: 0 })
  const base: VfxEffect = { ...effectFromNodes('X', [node('Part', 'P', {}, undefined, [em])]), anchor: [0, 0, 0] }
  const delayed = editAttr(editAttr(base, em.id, 'EmitCount', 12), em.id, 'EmitDelay', 0.4)
  assert.deepEqual(
    delayed.cues.filter((c) => c.target === em.id),
    [{ at: 0.4, target: em.id, action: 'emit', count: 12 }]
  )
  const cleared = editAttr(editAttr(delayed, em.id, 'EmitCount', undefined), em.id, 'EmitDelay', undefined)
  assert.equal(cleared.cues.filter((c) => c.target === em.id).length, 0)
  assert.equal(allNodes(cleared.roots).find((n) => n.id === em.id)!.attrs, undefined)

  let k = 0
  const ring = makeMeshEffect((p) => `${p}-${k++}`)
  const withRing: VfxEffect = { ...editAttr({ ...base, roots: [...base.roots, ring] }, ring.id, 'EmitCount', 2), anchor: [0, 0, 0] }
  const p = prepareEffect(withRing, 1)
  const copies = p.meshes.filter((m) => m.copy)
  assert.equal(copies.length, 2)
  const early = copies[0].look(0.05)
  const late = copies[0].look(0.4)
  assert.ok(late.size[1] > early.size[1] * 2, 'ring grows')
  assert.ok(late.transparency > early.transparency, 'ring fades')
  assert.ok(withRing.duration >= 1)
})
