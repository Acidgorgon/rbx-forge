// Principle framework: the catalogues, request kinds and selection, the compose plan and the critic
// block staying inside their token budgets, the animation code checks on synthetic clips (arcs, slow
// in / out, overshoot and settle, anticipation, timing variety, loopability), the VFX code checks on
// synthetic effects (contrast, layers, dissipation, break-up, timing, budget), the ability checks,
// score aggregation with weights (focus, change ordering), weight learning from ratings and notes,
// video reference principles, the PrincipleService store and the labs feeding it on ratings.
import assert from 'node:assert/strict'
import { thumbChecks } from '../src/shared/thumbs/checks.ts'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClip, AnimKey, R15Joint } from '../src/shared/anim/model.ts'
import { qeulerDeg, xfToCf, type V3 } from '../src/shared/anim/math.ts'
import { runChecks } from '../src/shared/anim/checks.ts'
import { ALL_PRINCIPLES, ANIM_PRINCIPLES, VFX_PRINCIPLES, measurable, principle } from '../src/shared/principles/catalog.ts'
import { animKind, CRITIC_TOKEN_BUDGET, estimateTokens, parsePlanObject, parseScriptPlan, PLAN_TOKEN_BUDGET, principleCriticBlock, principlePlan, selectPrinciples, vfxKind } from '../src/shared/principles/select.ts'
import { anticipationCheck, arcsCheck, animPrincipleChecks, followThroughCheck, loopabilityCheck, slowInOutCheck, timingCheck } from '../src/shared/principles/animChecks.ts'
import { breakupCheck, budgetCheck, contrastCheck, dissipationCheck, layersCheck, vfxAnticipationCheck, vfxPrincipleChecks, vfxTimingCheck } from '../src/shared/principles/vfxChecks.ts'
import { abilityPrincipleChecks } from '../src/shared/principles/abilityChecks.ts'
import { uiPrincipleChecks } from '../src/shared/principles/uiChecks.ts'
import { presetSpec } from '../src/shared/uimotion/spec.ts'
import { blendOverall, focusPrinciples, mergePrincipleScores, orderChanges, parsePrincipleScores, principleOverall, scorePrinciples } from '../src/shared/principles/score.ts'
import { applyFeedback, learnProfile, MAX_WEIGHT, MIN_WEIGHT, noteMentions, prioritiesText } from '../src/shared/principles/learn.ts'
import { withAnimPrinciples, withVfxPrinciples } from '../src/shared/principles/attach.ts'
import { measuredRefPrinciples, parseRefPrinciples, refPrinciplesText } from '../src/shared/principles/ref.ts'
import type { PrincipleFeedback } from '../src/shared/principles/types.ts'
import { effectFromSpec, type VfxSpec } from '../src/shared/vfx/spec.ts'
import type { VfxEffect } from '../src/shared/vfx/types.ts'
import { heuristicCritique, parseCritique } from '../src/shared/vfx/critique.ts'
import { heuristicAnimCritique } from '../src/shared/anim/critique.ts'
import { normalizeAbility } from '../src/shared/ability/model.ts'
import { refComposeBlock, parseRefVision } from '../src/shared/videoref/prompt.ts'
import type { VideoRef } from '../src/shared/videoref/types.ts'
import { PrincipleService } from '../src/main/services/principles/service.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-pr-${p}-`))

// ------------------------------------------------------------------ synthetic clips

type K = [t: number, rot: V3, opts?: { p?: V3; ease?: AnimKey['ease']; dir?: AnimKey['dir'] }]
const keys = (ks: K[]): AnimKey[] => ks.map(([t, rot, o]) => ({ t, cf: xfToCf({ p: o?.p ?? [0, 0, 0], q: qeulerDeg(rot) }), ease: o?.ease ?? 'Linear', dir: o?.dir ?? 'In' }))
const clip = (duration: number, tracks: Partial<Record<R15Joint, K[]>>, extra: Partial<AnimClip> = {}): AnimClip => ({
  name: 'Test',
  duration,
  looped: false,
  priority: 'Action',
  tracks: Object.fromEntries(Object.entries(tracks).map(([j, k]) => [j, keys(k!)])),
  markers: [],
  ...extra
})

// ------------------------------------------------------------------ catalogues

test('catalogues: the 12 animation principles plus 4 game ones, the VFX set, complete entries', () => {
  const ids = ALL_PRINCIPLES.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.equal(ANIM_PRINCIPLES.length, 16)
  for (const id of ['squash-stretch', 'anticipation', 'staging', 'pose-to-pose', 'follow-through', 'slow-in-out', 'arcs', 'secondary-action', 'timing', 'exaggeration', 'solid-posing', 'appeal', 'responsiveness', 'readability', 'weight-impact', 'loopability']) assert.ok(principle(id)?.domain === 'anim', id)
  for (const id of ['fx-shape', 'fx-timing', 'fx-contrast', 'fx-hue', 'fx-layers', 'fx-readability', 'fx-anticipation', 'fx-breakup', 'fx-dissipation', 'fx-cohesion', 'fx-budget']) assert.ok(principle(id)?.domain === 'vfx', id)
  assert.equal(VFX_PRINCIPLES.length, 11)
  for (const p of ALL_PRINCIPLES) {
    for (const k of ['name', 'rule', 'roblox', 'good', 'bad'] as const) assert.ok(p[k].length > (k === 'name' ? 3 : 10), `${p.id}.${k}`)
    assert.ok(p.base >= 0.5 && p.base <= 1.5)
    assert.ok(p.words.test(p.id.replace(/^fx-/, '').split('-')[0]) || p.words.source.length > 5, `${p.id} has note words`)
  }
  // Rigid parts: squash and stretch is expressed through poses, not scaling.
  assert.match(principle('squash-stretch')!.roblox, /rigid|pose compression/i)
  // Every principle a code check produces is marked measurable, and vice versa they are covered.
  const m = new Set(measurable())
  const produced = new Set<string>()
  const punch = clip(1, { RightShoulder: [[0, [0, 0, 0]], [0.3, [-70, 0, 0]], [0.4, [110, 0, 0]], [1, [100, 0, 0]]], Root: [[0, [0, 0, 0]], [0.4, [0, 0, 0], { p: [0, -0.5, 0] }], [1, [0, 0, 0]]] })
  for (const c of animPrincipleChecks(punch, runChecks(punch))) produced.add(c.id)
  for (const c of animPrincipleChecks({ ...punch, looped: true })) produced.add(c.id)
  for (const c of vfxPrincipleChecks(effectFromSpec(LAYERED))) produced.add(c.id)
  for (const c of vfxPrincipleChecks(seqEffect())) produced.add(c.id)
  for (const c of abilityPrincipleChecks(punchAbility())) produced.add(c.id)
  for (const c of thumbChecks({ width: 1920, height: 1080, palette: [], saturation: 0.4, vivid: 0.2, luma: 0.4, contrast: 0.2, colorfulness: 0.4, edgeDensity: 0.1, centerFocus: 1.2 }, { legibility256: 6, legibility160: 5, focal256: 6, focal160: 5, detailKept: 0.8, bottomLoad: 0.3, popDark: 0.4, popLight: 0.4 })) produced.add(c.id)
  for (const c of uiPrincipleChecks(presetSpec('bouncy', 'Button'))) produced.add(c.id)
  for (const id of produced) assert.ok(m.has(id), `${id} is produced by code but not marked measurable`)
  for (const id of m) assert.ok(produced.has(id), `${id} is marked measurable but no check produced it`)
})

test('request kinds and selection: loops only for loops, cohesion in the composer, weights reorder', () => {
  assert.equal(animKind('a heavy overhead punch'), 'attack')
  assert.equal(animKind('breathing idle loop'), 'idle')
  assert.equal(animKind('sprint cycle'), 'locomotion')
  assert.equal(animKind('wave emote'), 'emote')
  assert.equal(vfxKind('purple sword slash'), 'slash')
  assert.equal(vfxKind('fire aura'), 'aura')
  assert.equal(vfxKind('lightning impact'), 'burst')
  const idle = selectPrinciples('anim', 'breathing idle loop').map((p) => p.id)
  assert.ok(idle.includes('loopability'))
  const punch = selectPrinciples('anim', 'heavy punch').map((p) => p.id)
  assert.ok(!punch.includes('loopability') && punch.includes('anticipation'))
  assert.ok(selectPrinciples('ability', 'palm blast').some((p) => p.id === 'fx-cohesion'))
  const base = selectPrinciples('vfx', 'fire burst', { max: 11 }).map((p) => p.id)
  const boosted = selectPrinciples('vfx', 'fire burst', { max: 11, weights: { 'fx-breakup': 2.5 } }).map((p) => p.id)
  assert.ok(boosted.indexOf('fx-breakup') < base.indexOf('fx-breakup'), 'a higher user weight ranks a principle earlier')
})

test('prompt assembly: the compose plan and the critic block stay within their token budgets', () => {
  const requests = ['heavy overhead punch', 'idle loop', 'sprint', 'wave emote', 'hit reaction', 'fireball that charges and explodes', 'purple sword slash with sparks', 'fire aura', 'charged palm blast that knocks me back', 'x'.repeat(400)]
  for (const lab of ['vfx', 'anim', 'ability'] as const) {
    for (const r of requests) {
      const plan = principlePlan(lab, r)
      assert.ok(plan.length > 0, `${lab} plan for ${r.slice(0, 20)}`)
      assert.ok(estimateTokens(plan) <= PLAN_TOKEN_BUDGET, `${lab} plan ${estimateTokens(plan)} tokens`)
      assert.ok(!plan.includes(principle('arcs')!.good), 'never the whole catalogue')
    }
  }
  assert.match(principlePlan('vfx', 'fireball'), /-- Plan:/)
  assert.match(principlePlan('ability', 'palm blast'), /"plan"/)
  // A small budget trims items instead of overflowing.
  const small = principlePlan('anim', 'punch', { budget: 60 })
  assert.ok(estimateTokens(small) <= 60)
  const ids = selectPrinciples('anim', 'punch', { max: 8 }).map((p) => p.id)
  const measured = Object.fromEntries(ids.map((id) => [id, { score: 5.5, note: 'measured something fairly long to stress the budget '.repeat(2) }]))
  const block = principleCriticBlock(ids, { weights: { arcs: 1.6 }, measured, focus: ['arcs', 'timing'] })
  assert.ok(estimateTokens(block) <= CRITIC_TOKEN_BUDGET, `critic block ${estimateTokens(block)} tokens`)
  assert.match(block, /arcs \[user weight x1\.6\]/)
  assert.match(block, /Focus this round on: arcs, timing/)
  assert.match(block, /"principles":\[/)
})

test('the writer\'s plan is read back from a script comment or a JSON object', () => {
  const script = '-- Name: Fireball\n-- Plan:\n-- anticipation: streaks pull in for 0.5 s\n-- fx-shape: a round core then a burst ring\n-- not-a-principle: ignored\nreturn function(fx) end'
  assert.deepEqual(parseScriptPlan(script), { anticipation: 'streaks pull in for 0.5 s', 'fx-shape': 'a round core then a burst ring' })
  assert.deepEqual(parsePlanObject({ 'weight-impact': 'hit-stop 80 ms', nope: 'x', arcs: 3 }), { 'weight-impact': 'hit-stop 80 ms' })
})

// ------------------------------------------------------------------ animation checks

test('arcs: a rotating arm traces an arc, a sliding root a straight line', () => {
  const arc = arcsCheck(clip(0.6, { RightShoulder: [[0, [0, 0, 0]], [0.6, [150, 0, 0]]] }))!
  const line = arcsCheck(clip(0.6, { Root: [[0, [0, 0, 0]], [0.6, [0, 0, 0], { p: [0, 0, -4] }]] }))!
  assert.ok(arc.score >= 8, `arc ${arc.score} (${arc.note})`)
  assert.ok(line.score <= 4, `line ${line.score} (${line.note})`)
  assert.ok(line.fix && !arc.fix)
})

test('slow in / slow out: eased keys slow down at the poses, linear keys keep their speed', () => {
  const ks = (ease: AnimKey['ease'], dir: AnimKey['dir']): K[] => [0, 60, 0, 60, 0].map((a, i) => [i * 0.3, [a, 0, 0], { ease, dir }] as K)
  const eased = slowInOutCheck(clip(1.2, { RightShoulder: ks('CubicV2', 'InOut') }))!
  const linear = slowInOutCheck(clip(1.2, { RightShoulder: ks('Linear', 'In') }))!
  assert.ok(eased.score >= 8, `eased ${eased.score} (${eased.note})`)
  assert.ok(linear.score <= 4, `linear ${linear.score} (${linear.note})`)
})

test('follow-through: overshoot and settle score above a dead stop', () => {
  const settle = followThroughCheck(clip(1, { RightShoulder: [[0, [0, 0, 0]], [0.1, [0, 0, 0]], [0.2, [120, 0, 0]], [0.3, [138, 0, 0], { ease: 'CubicV2', dir: 'InOut' }], [0.5, [120, 0, 0]], [1, [120, 0, 0]]], RightElbow: [[0, [0, 0, 0]], [0.12, [0, 0, 0]], [0.25, [40, 0, 0]], [0.42, [20, 0, 0]], [1, [20, 0, 0]]] }))!
  const dead = followThroughCheck(clip(1, { RightShoulder: [[0, [0, 0, 0]], [0.1, [0, 0, 0]], [0.2, [120, 0, 0]], [1, [120, 0, 0]]], RightElbow: [[0, [0, 0, 0]], [0.1, [0, 0, 0]], [0.2, [40, 0, 0]], [1, [40, 0, 0]]] }))!
  assert.ok(settle.score > dead.score + 1.5, `settle ${settle.score} vs dead ${dead.score}`)
  assert.match(dead.note, /together|0 ms|overshoot 0%/)
})

test('anticipation: a windup longer than the strike scores high, none scores low', () => {
  const windup = anticipationCheck(clip(1, { RightShoulder: [[0, [0, 0, 0]], [0.3, [-70, 0, 0]], [0.4, [110, 0, 0]], [1, [110, 0, 0]]] }))!
  const none = anticipationCheck(clip(1, { RightShoulder: [[0, [0, 0, 0]], [0.1, [120, 0, 0]], [1, [120, 0, 0]]] }))!
  assert.ok(windup.score >= 8, `windup ${windup.score} (${windup.note})`)
  assert.ok(none.score <= 4, `none ${none.score} (${none.note})`)
  assert.match(none.fix ?? '', /windup/)
  // Loops have no anticipation to check.
  assert.equal(anticipationCheck(clip(1, { RightShoulder: [[0, [0, 0, 0]], [1, [0, 0, 0]]] }, { looped: true })), null)
})

test('timing variety: even key spacing scores below varied spacing with a hold', () => {
  const even = timingCheck(clip(1.2, { RightShoulder: [0, 40, 0, 40, 0, 40, 0].map((a, i) => [i * 0.2, [a, 0, 0]] as K) }))!
  const varied = timingCheck(clip(1.2, { RightShoulder: [[0, [0, 0, 0]], [0.35, [-50, 0, 0]], [0.42, [110, 0, 0]], [0.52, [110, 0, 0]], [0.6, [100, 0, 0]], [1.2, [0, 0, 0]]] }))!
  assert.ok(even.score <= 4, `even ${even.score} (${even.note})`)
  assert.ok(varied.score >= 7, `varied ${varied.score} (${varied.note})`)
})

test('loopability: a loop that ends on its first pose scores high, a popping one low', () => {
  const good = loopabilityCheck(clip(2, { Waist: [[0, [0, 0, 0], { ease: 'CubicV2', dir: 'InOut' }], [1, [-8, 0, 0], { ease: 'CubicV2', dir: 'InOut' }], [2, [0, 0, 0]]] }, { looped: true }))!
  const pop = loopabilityCheck(clip(2, { Waist: [[0, [0, 0, 0]], [2, [-30, 20, 0]]] }, { looped: true }))!
  assert.ok(good.score >= 9, `good ${good.score}`)
  assert.ok(pop.score <= 3, `pop ${pop.score}`)
  assert.equal(loopabilityCheck(clip(2, { Waist: [[0, [0, 0, 0]], [2, [-30, 0, 0]]] })), null)
})

// ------------------------------------------------------------------ VFX checks

const LAYERED: VfxSpec = {
  name: 'Layered',
  duration: 1,
  layers: [
    { name: 'Core', class: 'ParticleEmitter', props: { Color: ['#ffffff', '#ffb347'], Size: [[0, 0.6], [0.12, 2.2, 0.4], [1, 0]], Transparency: [[0, 0], [0.6, 0.3], [1, 1]], Lifetime: [0.4, 0.6], Speed: [0, 0.5], LightEmission: 1, Rotation: [0, 360], RotSpeed: [-90, 90], Rate: 0 }, emit: [{ at: 0.05, count: 18 }] },
    { name: 'Edge', class: 'ParticleEmitter', props: { Color: ['#a02010', '#300808'], Size: [[0, 0.4], [0.15, 1, 0.3], [1, 0]], Transparency: [[0, 0.1], [1, 1]], Lifetime: [0.5, 0.8], Speed: [9, 13], SpreadAngle: [180, 180], Drag: 3, LightEmission: 0, Rotation: [0, 360], Rate: 0 }, emit: [{ at: 0.05, count: 30 }] },
    { name: 'Sparks', class: 'ParticleEmitter', props: { Color: '#ffe0a0', Size: [[0, 0.2], [1, 0]], Transparency: [[0, 0], [1, 1]], Lifetime: [0.2, 0.4], Speed: [20, 30], SpreadAngle: [180, 180], LightEmission: 1, Orientation: 'VelocityParallel', Rate: 0 }, emit: [{ at: 0.06, count: 14 }] },
    { name: 'Glow', class: 'PointLight', props: { Color: '#ffb347', Brightness: 3, Range: 10 } }
  ]
}

const FLAT: VfxSpec = {
  name: 'Flat',
  duration: 1,
  layers: [{ name: 'Blob', class: 'ParticleEmitter', props: { Color: '#808080', Size: [[0, 0.5], [1, 2]], Transparency: 0, Lifetime: [0.8, 0.8], Speed: [6, 6], SpreadAngle: [180, 180], LightEmission: 0.5, Rate: 0 }, emit: [{ at: 0.05, count: 40 }] }]
}

const SEQ: VfxSpec = { ...LAYERED, name: 'Seq', duration: 1.4 }
// A sequenced effect: a 0.6 s charge before a 0.1 s release, then the dissipate.
function seqEffect(stages = [{ at: 0, label: 'anticipation' }, { at: 0.6, label: 'release' }, { at: 0.7, label: 'dissipate' }]): VfxEffect {
  return { ...effectFromSpec(SEQ), stages }
}

test('VFX anticipation: a charge beat several times longer than the release beats no build-up', () => {
  const good = vfxAnticipationCheck(seqEffect())!
  const none = vfxAnticipationCheck(seqEffect([{ at: 0, label: 'release' }, { at: 0.1, label: 'dissipate' }]))!
  assert.ok(good.score >= 8, `charge ${good.score} (${good.note})`)
  assert.ok(none.score <= 4, `none ${none.score}`)
  assert.equal(vfxAnticipationCheck(effectFromSpec(LAYERED)), null)
})

test('VFX value contrast: a white core against dark edges beats a flat grey blob', () => {
  const hi = contrastCheck(effectFromSpec(LAYERED))!
  const lo = contrastCheck(effectFromSpec(FLAT))!
  assert.ok(hi.score >= 6, `layered ${hi.score} (${hi.note})`)
  assert.ok(lo.score <= 5, `flat ${lo.score} (${lo.note})`)
  assert.ok(hi.score > lo.score)
})

test('VFX layering, dissipation, break-up, timing and budget checks', () => {
  const good = effectFromSpec(LAYERED)
  const flat = effectFromSpec(FLAT)
  assert.ok(layersCheck(good)!.score >= 8 && layersCheck(flat)!.score <= 6, `layers ${layersCheck(good)!.score} / ${layersCheck(flat)!.score}`)
  assert.match(layersCheck(flat)!.note, /missing/)
  assert.ok(dissipationCheck(good)!.score >= 9, dissipationCheck(good)!.note)
  const pop = dissipationCheck(flat)!
  assert.ok(pop.score <= 4 && /Blob/.test(pop.fix ?? ''), pop.note)
  assert.ok(breakupCheck(good)!.score > breakupCheck(flat)!.score + 2, `breakup ${breakupCheck(good)!.score} / ${breakupCheck(flat)!.score}`)
  assert.ok(vfxTimingCheck(good)!.score > vfxTimingCheck(flat)!.score, 'fast in, slow out beats a linear grow')
  const heavy = effectFromSpec({ name: 'Heavy', layers: [{ name: 'Lots', class: 'ParticleEmitter', props: { Rate: 400, Lifetime: [5, 5], Size: 8 } }] })
  assert.ok(budgetCheck(heavy).score < 6 && budgetCheck(good).score >= 9)
})

test('ability checks: timing rules grouped by principle, startup as responsiveness', () => {
  const ok = abilityPrincipleChecks(punchAbility())
  const by = Object.fromEntries(ok.map((c) => [c.id, c]))
  assert.ok(by['weight-impact'].score >= 9, by['weight-impact'].note)
  assert.ok(by['responsiveness'].score >= 9)
  const bad = abilityPrincipleChecks(punchAbility({ events: [] }))
  assert.ok(bad.find((c) => c.id === 'weight-impact')!.score <= 4, 'no flash, shake or hit-stop')
})

function punchAbility(extra: Record<string, unknown> = {}) {
  return normalizeAbility({
    name: 'punch',
    duration: 1.2,
    animation: { clip: 'c', name: 'Punch', duration: 1, markers: [{ name: 'anticipation', t: 0.1 }, { name: 'release', t: 0.4 }], speed: 1, start: 0 },
    events: [
      { id: 'flash', kind: 'screen', effect: 'flash', at: { marker: 'release', at: 0 }, attack: 0.02, hold: 0.03, release: 0.2 },
      { id: 'shake', kind: 'shake', at: { marker: 'release', at: 0 }, duration: 0.3, amplitude: 0.5, frequency: 20 },
      { id: 'stop', kind: 'hitstop', at: { marker: 'release', at: 0 }, duration: 0.08, timeScale: 0.05 }
    ],
    ...extra
  })
}

// ------------------------------------------------------------------ aggregation

test('score aggregation: critic and code merge, weights move the overall, focus and change order follow', () => {
  const merged = mergePrincipleScores([{ id: 'arcs', score: 8, note: 'hand curves' }, { id: 'appeal', score: 6, note: 'generic' }], [{ id: 'arcs', score: 4, note: 'bow 3%' }, { id: 'timing', score: 7, note: 'varied' }])
  const arcs = merged.find((m) => m.id === 'arcs')!
  assert.equal(arcs.source, 'both')
  assert.equal(arcs.score, 6)
  assert.equal(arcs.measured, 4)
  assert.equal(merged.find((m) => m.id === 'timing')!.source, 'code')
  const scores = [{ id: 'arcs', score: 4 }, { id: 'timing', score: 8 }]
  const neutral = principleOverall(scores)!
  const caresArcs = principleOverall(scores, { arcs: 2.5 })!
  const caresTiming = principleOverall(scores, { timing: 2.5 })!
  assert.ok(caresArcs < neutral && neutral < caresTiming, `${caresArcs} < ${neutral} < ${caresTiming}`)
  assert.equal(blendOverall(8, 6), 7)
  assert.equal(blendOverall(8, null), 8)
  // Focus: weighted shortfall; a heavily weighted 6.5 beats an unweighted 5.
  assert.deepEqual(focusPrinciples([{ id: 'appeal', score: 5 }, { id: 'arcs', score: 6.5 }, { id: 'timing', score: 9 }], { arcs: 2.5 }), ['arcs', 'appeal'])
  const changes = [{ n: 1 }, { n: 2, principle: 'appeal' }, { n: 3, principle: 'timing' }, { n: 4, principle: 'arcs' }]
  assert.deepEqual(orderChanges(changes, ['arcs', 'appeal']).map((c) => c.n), [4, 2, 1, 3])
  const r = scorePrinciples(7, [{ id: 'arcs', score: 3, note: '' }], [], { arcs: 2 })
  assert.equal(r.principleScore, 3)
  assert.equal(r.overall, 5)
  assert.deepEqual(r.focus, ['arcs'])
})

test('parsing the critic: principles are clamped, unknown and off-list ids dropped, changes keep their principle', () => {
  const raw = '```json\n{"scores":{"readability":7,"layering":6,"timing":5,"color":7,"silhouette":6,"performance":9},"summary":"ok","principles":[{"id":"fx-contrast","score":14,"note":"flat","fix":"white core"},{"id":"made-up","score":3},{"id":"arcs","score":2},{"id":"fx-dissipation","score":"x"}],"changes":[{"node":"Core","prop":"LightEmission","value":1,"principle":"fx-contrast"},{"node":"Core","prop":"Size","value":2,"principle":"nope"}]}\n```'
  const ps = parsePrincipleScores(raw, ['fx-contrast', 'fx-dissipation'])
  assert.deepEqual(ps, [{ id: 'fx-contrast', score: 10, note: 'flat', fix: 'white core' }])
  const effect = effectFromSpec(FLAT)
  const c = parseCritique(raw, effect)
  assert.equal(c.changes[0].principle, 'fx-contrast')
  assert.equal(c.changes[1].principle, undefined)
  const withP = withVfxPrinciples(c, effect, { request: 'grey burst', raw, weights: { 'fx-dissipation': 2 } })
  assert.ok(withP.principles!.some((p) => p.id === 'fx-contrast' && p.source === 'both'))
  assert.ok(withP.principles!.some((p) => p.id === 'fx-dissipation' && p.source === 'code'))
  assert.equal(withP.focus![0], 'fx-dissipation', 'the popping, double-weighted principle is fixed first')
  assert.notEqual(withP.overall, c.overall)
})

test('numbers-only critiques carry principle-tagged changes, ordered by the focus', () => {
  const effect = effectFromSpec(FLAT)
  const h = withVfxPrinciples(heuristicCritique(effect, null), effect, { request: 'grey burst' })
  assert.ok(h.changes.every((c) => c.principle), 'heuristic changes are tagged')
  const firstFocusChange = h.changes.findIndex((c) => c.principle === h.focus![0])
  if (firstFocusChange >= 0) assert.ok(h.changes.slice(0, firstFocusChange).every((c) => c.principle === h.focus![0]))
  const linear = clip(1.2, { RightShoulder: [0, 60, 0, 60, 0].map((a, i) => [i * 0.3, [a, 0, 0]] as K) })
  const checks = runChecks(linear)
  const a = withAnimPrinciples(heuristicAnimCritique(linear, checks), linear, { request: 'arm swing attack', checks })
  assert.ok(a.principles!.some((p) => p.id === 'slow-in-out' && p.score <= 4))
  assert.ok(a.focus!.length > 0)
})

// ------------------------------------------------------------------ learning

const fb = (rating: 'up' | 'down', scores: Record<string, number>, at: number, notes?: string): PrincipleFeedback => ({ at, lab: 'anim', entryId: `e${at}`, rating, scores, ...(notes ? { notes } : {}) })

test('weight learning: dislikes on weak arcs raise arcs, likes despite weak readability lower it', () => {
  const p = learnProfile([
    fb('down', { arcs: 3, timing: 7, readability: 7 }, 1),
    fb('down', { arcs: 4, timing: 7.5, readability: 6.5 }, 2),
    fb('up', { arcs: 8, timing: 7, readability: 4 }, 3),
    fb('up', { arcs: 8.5, timing: 8, readability: 5 }, 4)
  ])
  assert.ok(p.weights.arcs > 1.3, `arcs ${p.weights.arcs}`)
  assert.ok(p.weights.readability < 0.85, `readability ${p.weights.readability}`)
  assert.equal(p.ratings, 4)
  assert.equal(p.evidence.arcs.down, 2)
  assert.equal(p.evidence.arcs.upMean, 8.25)
  assert.match(prioritiesText(p), /Arcs \(arcs, x1\.\d\d\)/)
  // Deterministic regardless of input order.
  assert.deepEqual(learnProfile([...[fb('up', { arcs: 8, timing: 7, readability: 4 }, 3), fb('down', { arcs: 3, timing: 7, readability: 7 }, 1)]]).weights, learnProfile([fb('down', { arcs: 3, timing: 7, readability: 7 }, 1), fb('up', { arcs: 8, timing: 7, readability: 4 }, 3)]).weights)
})

test('weight learning: notes push the principles they name, weights stay clamped', () => {
  assert.deepEqual(noteMentions('the hit feels floaty and weightless').sort(), ['slow-in-out', 'weight-impact'].sort())
  assert.ok(noteMentions('sparks pop off at the end').includes('fx-dissipation'))
  const p = learnProfile([fb('down', { timing: 6, arcs: 6 }, 1, 'no weight at all, feels floaty')])
  assert.ok(p.weights['weight-impact'] > 1.2)
  assert.equal(p.evidence['weight-impact'].mentions, 1)
  const w: Record<string, number> = {}
  for (let i = 0; i < 50; i++) applyFeedback(w, { rating: 'down', scores: { arcs: 0, timing: 10 }, notes: 'arcs arcs' })
  assert.equal(w.arcs, MAX_WEIGHT)
  assert.equal(w.timing, MIN_WEIGHT)
  // One principle alone carries no relative evidence.
  const single: Record<string, number> = {}
  applyFeedback(single, { rating: 'down', scores: { arcs: 2 } })
  assert.deepEqual(single, {})
})

// ------------------------------------------------------------------ video references

const video = (lab: 'vfx' | 'anim'): VideoRef => ({
  lab,
  source: { name: 'clip.mp4', mime: 'video/mp4', bytes: 1, width: 640, height: 360, duration: 2 },
  trim: { start: 0, end: 2 },
  sheet: 'ref/sheet.png',
  analysis: {
    version: 1,
    duration: 2,
    fps: 12,
    width: 640,
    height: 360,
    frames: [],
    peaks: [{ t: 0.9, strength: 0.95 }],
    flashes: [0.9],
    segments: [
      { label: 'anticipation', start: 0, end: 0.7, peak: 0.6, energy: 0.3, palette: [{ hex: '#6040ff', share: 0.5 }] },
      { label: 'release', start: 0.7, end: 0.85, peak: 0.8, energy: 0.9, palette: [{ hex: '#ffffff', share: 0.5 }] },
      { label: 'impact', start: 0.85, end: 1.1, peak: 0.9, energy: 1, palette: [{ hex: '#ff40c0', share: 0.5 }] },
      { label: 'dissipate', start: 1.1, end: 2, peak: 1.2, energy: 0.2, palette: [] }
    ],
    palette: [{ hex: '#6040ff', share: 0.5 }],
    glow: { bloom: 0.6, peakBright: 0.3, level: 'strong' },
    motion: { direction: 'outward', angle: null, peakCoverage: 0.6, meanCoverage: 0.3, bbox: null, travel: 0.1 },
    timeline: [{ kind: 'hold', start: 0, end: 0.3 }, { kind: 'fast', start: 0.7, end: 0.9 }],
    keyFrames: []
  }
})

test('video references describe the principles they exemplify (measured and from the vision model)', () => {
  const m = measuredRefPrinciples(video('vfx')).map((p) => p.id)
  for (const id of ['fx-anticipation', 'fx-contrast', 'fx-dissipation', 'fx-timing', 'fx-hue', 'fx-shape']) assert.ok(m.includes(id), id)
  const a = measuredRefPrinciples(video('anim')).map((p) => p.id)
  for (const id of ['anticipation', 'timing', 'follow-through', 'weight-impact']) assert.ok(a.includes(id), id)
  assert.deepEqual(parseRefPrinciples([{ id: 'arcs', note: 'the fist sweeps a wide arc' }, { id: 'fx-shape', note: 'wrong lab' }, { id: 'nope', note: 'x' }], 'anim').map((p) => p.id), ['arcs'])
  const v = video('vfx')
  v.vision = parseRefVision('{"summary":"A purple orb charges and bursts.","principles":[{"id":"fx-anticipation","note":"streaks pull inward for 0.7 s"}]}', 1, undefined, 'vfx')
  assert.equal(v.vision.principles![0].note, 'streaks pull inward for 0.7 s')
  const text = refPrinciplesText(v)
  assert.match(text, /fx-anticipation: streaks pull inward for 0\.7 s/)
  assert.ok(!/fx-anticipation: 0\.70 s gathering/.test(text), 'the vision note replaces the measured one')
  assert.match(refComposeBlock(v, 'Purple'), /Principles this reference exemplifies/)
})

// ------------------------------------------------------------------ store + labs

function fakeMemory() {
  const calls: { name: string; body: string }[] = []
  return { calls, memory: { remember: async (input: { name: string; body: string }) => (calls.push(input), { entry: { name: input.name } }) } }
}

test('PrincipleService records ratings, learns weights, writes memory, forgets and resets', async () => {
  const dir = await tmp('store')
  const { memory, calls } = fakeMemory()
  let now = 1000
  const svc = new PrincipleService({ dir, memory, now: () => now++ })
  assert.deepEqual(await svc.weights(), {})
  await svc.record({ lab: 'vfx', entryId: 'a', rating: 'down', scores: { 'fx-dissipation': 2, 'fx-contrast': 8, 'fx-layers': 8 }, notes: 'pops at the end' })
  await svc.record({ lab: 'vfx', entryId: 'b', rating: 'down', scores: { 'fx-dissipation': 3, 'fx-contrast': 7, 'fx-layers': 7 } })
  await svc.record({ lab: 'vfx', entryId: 'c', rating: 'up', scores: {} })
  const w = await svc.weights()
  assert.ok(w['fx-dissipation'] > 1.4, JSON.stringify(w))
  assert.equal((await svc.view()).profile.ratings, 2, 'a rating without scores is ignored')
  assert.ok(calls.some((c) => c.name === 'principle-priorities' && /Dissipation/.test(c.body)))
  // Re-rating an entry replaces its line.
  await svc.record({ lab: 'vfx', entryId: 'a', rating: 'up', scores: { 'fx-dissipation': 2, 'fx-contrast': 8, 'fx-layers': 8 } })
  assert.equal((await svc.feedback()).length, 2)
  await svc.forget('vfx', 'b')
  assert.equal((await svc.feedback()).length, 1)
  // Files are plain JSON (they travel in .forgepack / sync); a profile out of step with the feedback
  // (another device synced in) is recomputed.
  assert.equal(JSON.parse(await readFile(join(dir, 'feedback.json'), 'utf8')).length, 1)
  const v = await svc.reset()
  assert.equal(v.profile.ratings, 0)
  assert.ok(v.catalogue.length === ALL_PRINCIPLES.length)
})

test('VFX Lab: rating an effect feeds its per-principle scores and notes to the priorities', async () => {
  const userDir = await tmp('vfx')
  const root = await tmp('proj')
  const recorded: Omit<PrincipleFeedback, 'at'>[] = []
  const principles = { weights: async () => ({ 'fx-dissipation': 2 }), record: async (f: Omit<PrincipleFeedback, 'at'>) => void recorded.push(f), forget: async () => undefined }
  const svc = new VfxService({ userDir, projectRoot: () => root, lune: async () => ({ error: 'no' }), runtimeDir: () => null, principles })
  const { entry } = await svc.create(FLAT, { prompt: 'grey burst' })
  await svc.update(entry.id, { notes: 'it pops off at the end' })
  await svc.rate(entry.id, 'down')
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].rating, 'down')
  assert.ok(recorded[0].scores['fx-dissipation'] <= 4, JSON.stringify(recorded[0].scores))
  assert.equal(recorded[0].notes, 'it pops off at the end')
  // The numbers-only critique is principled and weighted.
  const c = await svc.critique((await svc.get(entry.id)), effectFromSpec(FLAT), [], [], 1, null)
  assert.ok(c.principles?.length && c.focus?.[0] === 'fx-dissipation')
})
