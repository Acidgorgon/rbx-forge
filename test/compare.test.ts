// Compare any two versions: parameter flattening (keyed arrays, inline vectors, long strings,
// float noise), the param diff (changed / added / removed, deltas, natural order), score and
// principle deltas, the default pair, the shared clock (seconds vs stretch, loop / stop), the diff
// filter, and the VFX / animation / ability item builders.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clockLength, compareItems, defaultPair, diffParams, filterChanges, flattenParams, paneTime, principleDeltas, scoreDeltas, stepClock } from '../src/shared/compare/diff.ts'
import { abilityCompareItems, abilityParams, animClipParams, animCompareItems, vfxCompareItems, vfxEffectParams, vfxPropValue } from '../src/shared/compare/labs.ts'
import type { CompareItem } from '../src/shared/compare/types.ts'
import type { VfxEffect, VfxEntry } from '../src/shared/vfx/types.ts'
import type { AnimClip, AnimEntry } from '../src/shared/anim/model.ts'
import type { Ability, AbilityEntry } from '../src/shared/ability/types.ts'

test('flattenParams keys object arrays by name, inlines short number arrays, summarises long strings', () => {
  const p = flattenParams({
    layers: [
      { name: 'core', rate: 10, color: [1, 0.5, 0] },
      { name: 'sparks', rate: 4.000000001 }
    ],
    list: [{ x: 1 }, { x: 2 }],
    script: 'x'.repeat(200),
    empty: [],
    nothing: undefined,
    n: null
  })
  assert.equal(p['layers.core.rate'], 10)
  assert.equal(p['layers.core.color'], '[1, 0.5, 0]')
  assert.equal(p['layers.sparks.rate'], 4)
  assert.equal(p['list[0].x'], 1)
  assert.equal(p['list[1].x'], 2)
  assert.match(String(p['script']), /^<200 chars #[0-9a-f]{6}>$/)
  assert.equal(p['empty'], '[]')
  assert.equal(p['n'], null)
  assert.ok(!('nothing' in p))
})

test('flattenParams: duplicate names fall back to indexes; skip and depth limits', () => {
  const p = flattenParams({ a: [{ name: 'x', v: 1 }, { name: 'x', v: 2 }], secret: 1, deep: { b: { c: { d: 1 } } } }, { skip: ['secret'], maxDepth: 3 })
  assert.equal(p['a[0].v'], 1)
  assert.equal(p['a[1].v'], 2)
  assert.ok(!('secret' in p))
  assert.equal(p['deep.b.c'], '<…>')
})

test('diffParams: changed, added, removed with numeric deltas; float noise is not a change', () => {
  const a = flattenParams({ rate: 10, size: 1.00000001, gone: 'x', item: [{ name: 'p2' }, { name: 'p10' }] })
  const b = flattenParams({ rate: 14.5, size: 1, added: true, item: [{ name: 'p10' }, { name: 'p2' }] })
  const { changes, unchanged } = diffParams(a, b)
  const by = Object.fromEntries(changes.map((c) => [c.path, c]))
  assert.equal(by.rate.kind, 'changed')
  assert.equal(by.rate.delta, 4.5)
  assert.equal(by.gone.kind, 'removed')
  assert.equal(by.gone.b, undefined)
  assert.equal(by.added.kind, 'added')
  assert.ok(!by.size, 'rounded equal')
  assert.equal(unchanged, 3, 'size + the two keyed names')
  // Reordering keyed array elements produces no change.
  assert.ok(!changes.some((c) => c.path.startsWith('item')))
})

test('diffParams orders paths naturally', () => {
  const { changes } = diffParams({}, { 'cue[10].at': 1, 'cue[2].at': 1, 'cue[1].at': 1 })
  assert.deepEqual(changes.map((c) => c.path), ['cue[1].at', 'cue[2].at', 'cue[10].at'])
})

test('score and principle deltas', () => {
  const s = scoreDeltas({ timing: 5, color: 7 }, { timing: 6.5, layering: 4 })
  assert.deepEqual(s.map((x) => x.key), ['timing', 'color', 'layering'])
  assert.equal(s[0].delta, 1.5)
  assert.equal(s[1].b, undefined)
  assert.equal(s[1].delta, undefined)
  const p = principleDeltas(
    [{ id: 'arcs', score: 4, note: '', source: 'critic' }, { id: 'timing', score: 6, note: '', source: 'code' }, { id: 'only-a', score: 5, note: '', source: 'code' }],
    [{ id: 'arcs', score: 8, note: '', source: 'critic' }, { id: 'timing', score: 5, note: '', source: 'code' }]
  )
  assert.deepEqual(p.map((x) => x.key), ['arcs', 'timing', 'only-a'])
  assert.equal(p[0].delta, 4)
  assert.equal(p[1].delta, -1)
})

function item(id: string, over: Partial<CompareItem> = {}): CompareItem {
  return { id, entryId: id.split('#')[0], label: id, group: 'g', duration: 1, params: {}, payload: null, ...over }
}

test('compareItems summarises overall, rubric, principles and params', () => {
  const s = compareItems(item('e#1', { overall: 6, scores: { timing: 5 }, params: { rate: 1 } }), item('e', { overall: 7.25, scores: { timing: 8 }, params: { rate: 2, extra: 'y' } }))
  assert.equal(s.overall.delta, 1.25)
  assert.equal(s.scores[0].delta, 3)
  assert.equal(s.params.length, 2)
  assert.equal(s.unchanged, 0)
  assert.equal(s.principleScore.delta, undefined)
})

test('defaultPair: best iteration vs current, else latest sibling, else another entry', () => {
  const items = [item('e', { current: true }), item('e#1', { overall: 5, at: 1 }), item('e#2', { overall: 8, at: 2 }), item('e#3', { overall: 7, at: 3 }), item('other')]
  assert.deepEqual(defaultPair(items, 'e'), ['e#2', 'e'])
  assert.deepEqual(defaultPair([item('e', { current: true }), item('e#1', { at: 1 }), item('e#2', { at: 2 })]), ['e#2', 'e'])
  assert.deepEqual(defaultPair([item('a', { current: true }), item('b')]), ['b', 'a'])
  assert.equal(defaultPair([item('a')]), null)
  // The best iteration is identical to the current version: the best of the ones that differ.
  const same = [item('e', { current: true, params: { x: 2 } }), item('e#1', { overall: 6, params: { x: 1 } }), item('e#2', { overall: 9, params: { x: 2 } })]
  assert.deepEqual(defaultPair(same, 'e'), ['e#1', 'e'])
})

test('shared clock: seconds holds the shorter version, stretch scales both; loop and stop', () => {
  assert.equal(clockLength('seconds', 1, 2), 2)
  assert.equal(clockLength('stretch', 1, 2), 1)
  assert.equal(paneTime('seconds', 1.5, 1), 1)
  assert.equal(paneTime('seconds', 0.4, 1), 0.4)
  assert.equal(paneTime('stretch', 0.5, 1), 0.5)
  assert.equal(paneTime('stretch', 0.5, 2), 1)
  assert.equal(paneTime('stretch', 0.5, 0), 0)
  let c = stepClock('seconds', 1.9, 0.2, 1, 1, 2, true)
  assert.ok(Math.abs(c.clock - 0.1) < 1e-9 && !c.ended)
  c = stepClock('seconds', 1.9, 0.2, 1, 1, 2, false)
  assert.deepEqual(c, { clock: 2, ended: true })
  // stretch: one phase lasts as long as the longer version (2 s); half speed halves the step.
  c = stepClock('stretch', 0, 0.5, 0.5, 1, 2, true)
  assert.ok(Math.abs(c.clock - 0.125) < 1e-9)
})

test('filterChanges matches path, kind and values', () => {
  const { changes } = diffParams({ 'Core.Rate': 10, 'Core.Size': '0:1' }, { 'Core.Rate': 20, 'Glow.Brightness': 2 })
  assert.deepEqual(filterChanges(changes, 'rate').map((c) => c.path), ['Core.Rate'])
  assert.deepEqual(filterChanges(changes, 'removed').map((c) => c.path), ['Core.Size'])
  assert.deepEqual(filterChanges(changes, 'glow 2').map((c) => c.path), ['Glow.Brightness'])
  assert.equal(filterChanges(changes, '').length, 3)
})

const effect = (rate: number, color: [number, number, number]): VfxEffect => ({
  name: 'Fireball',
  duration: 1.2,
  roots: [
    {
      id: 'root',
      className: 'Attachment',
      name: 'Fireball',
      props: {},
      children: [
        { id: 'n1', className: 'ParticleEmitter', name: 'Core', props: { Rate: rate, Size: [{ t: 0, v: 1 }, { t: 1, v: 0, e: 0.2 }], Color: [{ t: 0, c: color }, { t: 1, c: [0, 0, 0] }], LightEmission: 1 }, children: [] },
        { id: 'n2', className: 'ParticleEmitter', name: 'Core', props: { Rate: 3 }, children: [] }
      ]
    }
  ],
  cues: [{ at: 0.1, target: 'n1', action: 'emit', count: 20 }],
  stages: [{ at: 0, label: 'charge' }]
})

test('VFX params: nodes by name path, sequences as one value, cues by target name', () => {
  const p = vfxEffectParams(effect(40, [1, 0.5, 0]))
  assert.equal(p['Fireball/Core.Rate'], 40)
  assert.equal(p['Fireball/Core#2.Rate'], 3)
  assert.equal(p['Fireball/Core.Size'], '0:1 → 1:0±0.2')
  assert.equal(p['Fireball/Core.Color'], '0:#ff8000 → 1:#000000')
  assert.equal(p['cue[0]'], 'emit Fireball/Core')
  assert.equal(p['stage.charge'], 0)
  assert.equal(vfxPropValue([1, 2, 3]), '[1, 2, 3]')
  assert.match(String(vfxPropValue([1, 2, 3, 1, 0, 0, 0, 1, 0, 0, 0, 1])), /^pos \[1, 2, 3\] rot [0-9a-f]{6}$/)
})

test('VFX items: current, each iteration (best marked), library entries; critique deltas', () => {
  const crit = (overall: number) => ({ scores: { readability: overall, layering: 5, timing: 5, color: 5, silhouette: 5, performance: 5 }, overall, summary: '', changes: [], references: [] })
  const entry: VfxEntry = {
    id: 'fx1', scope: 'user', kind: 'generated', name: 'Fireball', description: '', tags: [], createdAt: 1, updatedAt: 2, origin: 'p', thumbs: [],
    effect: effect(60, [1, 0.5, 0]),
    iterations: [
      { n: 1, at: 1, effect: effect(40, [1, 0.5, 0]), frames: [], critique: crit(5) },
      { n: 2, at: 2, effect: effect(60, [1, 0.5, 0]), frames: [], critique: crit(7) }
    ]
  }
  const other: VfxEntry = { ...entry, id: 'fx2', name: 'Spark', iterations: [], effect: effect(10, [0, 0, 1]) }
  const items = vfxCompareItems(entry, [entry, other])
  assert.deepEqual(items.map((i) => i.id), ['fx1', 'fx1#1', 'fx1#2', 'fx2'])
  assert.equal(items[0].overall, 7, 'current = last iteration carries its critique')
  assert.ok(items[2].best)
  assert.equal(items[3].group, 'Library')
  // #2 is the current version (identical), so the default pair is the one that differs.
  assert.deepEqual(defaultPair(items, 'fx1'), ['fx1#1', 'fx1'])
  const s = compareItems(items[1], items[2])
  assert.equal(s.overall.delta, 2)
  assert.deepEqual(s.params.map((c) => [c.path, c.delta]), [['Fireball/Core.Rate', 20]])
  const lib = compareItems(items[0], items[3])
  assert.ok(lib.params.some((c) => c.path === 'Fireball/Core.Color'))
})

const clip = (t: number, ease?: 'Cubic'): AnimClip => ({
  name: 'Punch',
  duration: 0.8,
  looped: false,
  priority: 'Action',
  tracks: { RightShoulder: [{ t: 0, cf: [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1] }, { t, cf: [0, 0, 0, 0, -1, 0, 1, 0, 0, 0, 0, 1], ease }] },
  markers: [{ name: 'hit', t: 0.3 }],
  beats: [{ at: 0.1, label: 'anticipation' }]
})

test('animation params and items: key times, easing, pose hash, markers', () => {
  const a = animClipParams(clip(0.3))
  assert.equal(a['RightShoulder.keys'], 2)
  assert.equal(a['RightShoulder.times'], '0 0.3')
  assert.equal(a['marker.hit'], 0.3)
  assert.equal(a['beat.anticipation'], 0.1)
  const b = animClipParams(clip(0.25, 'Cubic'))
  const { changes } = diffParams(a, b)
  assert.deepEqual(changes.map((c) => c.path).sort(), ['RightShoulder.easing', 'RightShoulder.times'])
  const entry = { id: 'a1', scope: 'user', kind: 'generated', name: 'Punch', description: '', tags: [], notes: '', createdAt: 1, updatedAt: 2, origin: '', clip: clip(0.25), thumbs: [], iterations: [{ n: 1, at: 1, clip: clip(0.3), frames: [], times: [] }] } as AnimEntry
  const media = { ...entry, id: 'm', kind: 'media' } as AnimEntry
  const items = animCompareItems(entry, [entry, media])
  assert.deepEqual(items.map((i) => i.id), ['a1', 'a1#1'])
  assert.deepEqual(defaultPair(items, 'a1'), ['a1#1', 'a1'])
})

test('ability params and items: events by kind + label, marker-relative times, vision + timing scores', () => {
  const ability: Ability = {
    version: 1,
    name: 'Slash',
    duration: 1,
    animation: { clip: 'c', name: 'Swing', duration: 0.8, looped: false, markers: [], speed: 1, start: 0, fadeIn: 0.1 },
    events: [
      { id: 'e1', kind: 'shake', label: 'impact', at: { marker: 'hit', at: 0.02 }, duration: 0.2, amplitude: 0.4, frequency: 18, falloff: 'linear' },
      { id: 'e2', kind: 'hitstop', at: { at: 0.3 }, duration: 0.05, timeScale: 0.1 }
    ]
  }
  const p = abilityParams(ability)
  assert.equal(p['shake:impact.at'], 'hit+0.02')
  assert.equal(p['shake:impact.amplitude'], 0.4)
  assert.equal(p['hitstop:e2.at'], 0.3)
  assert.equal(p['animation.clip'], 'Swing')
  const base = { scope: 'user' as const, description: '', tags: [] as string[], createdAt: 1, updatedAt: 2, origin: 'manual', thumbs: [] as string[] }
  const a: AbilityEntry = { ...base, id: 'm1', name: 'Slash', ability, critique: { at: 1, timingScore: 6, checks: [], beats: [], frames: [], overall: 6.5, summary: '', vision: { scores: { anticipation: 5, impact: 7, sync: 6, readability: 6, followThrough: 5 }, overall: 6, summary: '', changes: [] } } }
  const harder = { ...ability, events: [{ ...ability.events[0], amplitude: 0.8 } as Ability['events'][number], ability.events[1]] }
  const b: AbilityEntry = { ...base, id: 'm2', name: 'Slash heavy', ability: harder }
  const items = abilityCompareItems(a, [a, b])
  assert.deepEqual(items.map((i) => i.id), ['m1', 'm2'])
  assert.equal(items[0].scores?.timing, 6)
  assert.equal(items[0].scores?.impact, 7)
  const s = compareItems(items[0], items[1])
  assert.deepEqual(s.params.map((c) => [c.path, c.delta]), [['shake:impact.amplitude', 0.4]])
})
