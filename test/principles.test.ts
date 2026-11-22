// Principle framework: the UI Motion principle catalogue, selection, compose plan and critic block
// token budgets, code checks, score aggregation with weights (focus, change ordering), weight
// learning from ratings and notes, and the PrincipleService store.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ALL_PRINCIPLES, UI_PRINCIPLES, measurable, principle } from '../src/shared/principles/catalog.ts'
import { CRITIC_TOKEN_BUDGET, estimateTokens, parsePlanObject, parseScriptPlan, PLAN_TOKEN_BUDGET, principleCriticBlock, principlePlan, selectPrinciples } from '../src/shared/principles/select.ts'
import { uiPrincipleChecks } from '../src/shared/principles/uiChecks.ts'
import { presetSpec } from '../src/shared/uimotion/spec.ts'
import { blendOverall, focusPrinciples, mergePrincipleScores, orderChanges, parsePrincipleScores, principleOverall, scorePrinciples } from '../src/shared/principles/score.ts'
import { applyFeedback, learnProfile, MAX_WEIGHT, MIN_WEIGHT, noteMentions, prioritiesText } from '../src/shared/principles/learn.ts'
import type { PrincipleFeedback } from '../src/shared/principles/types.ts'
import { PrincipleService } from '../src/main/services/principles/service.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-pr-${p}-`))

test('catalogues: UI Motion principles complete and measurable ids align with uiChecks', () => {
  const ids = ALL_PRINCIPLES.map((p) => p.id)
  assert.equal(new Set(ids).size, ids.length, 'ids are unique')
  assert.equal(UI_PRINCIPLES.length, 6)
  for (const id of ['ui-responsiveness', 'ui-anticipation', 'ui-overshoot', 'ui-consistency', 'ui-readability', 'ui-reduced-motion']) {
    assert.equal(principle(id)?.domain, 'ui', id)
  }
  for (const p of ALL_PRINCIPLES) {
    for (const k of ['name', 'rule', 'roblox', 'good', 'bad'] as const) assert.ok(p[k].length > (k === 'name' ? 3 : 10), `${p.id}.${k}`)
    assert.ok(p.base >= 0.5 && p.base <= 1.5)
  }
  const m = new Set(measurable())
  const produced = new Set<string>()
  for (const c of uiPrincipleChecks(presetSpec('bouncy', 'Button'))) produced.add(c.id)
  for (const id of produced) assert.ok(m.has(id), `${id} is produced by code but not marked measurable`)
  for (const id of m) assert.ok(produced.has(id), `${id} is marked measurable but no check produced it`)
})

test('selection and prompts: weights reorder principles and prompts stay within token budgets', () => {
  const base = selectPrinciples('uimotion', 'bouncy button', { max: 6 }).map((p) => p.id)
  const boosted = selectPrinciples('uimotion', 'bouncy button', { max: 6, weights: { 'ui-readability': 2.5 } }).map((p) => p.id)
  assert.ok(boosted.indexOf('ui-readability') < base.indexOf('ui-readability'), 'a higher user weight ranks a principle earlier')

  const plan = principlePlan('uimotion', 'shop card button with spring hover')
  assert.ok(plan.length > 0)
  assert.ok(estimateTokens(plan) <= PLAN_TOKEN_BUDGET)
  assert.match(plan, /"plan"/)
  assert.ok(!plan.includes(principle('ui-responsiveness')!.good), 'never includes full examples')

  const small = principlePlan('uimotion', 'shop card button', { budget: 40 })
  assert.ok(estimateTokens(small) <= 40)

  const ids = selectPrinciples('uimotion', 'shop card', { max: 6 }).map((p) => p.id)
  const measured = Object.fromEntries(ids.map((id) => [id, { score: 5.5, note: 'measured note '.repeat(2) }]))
  const block = principleCriticBlock(ids, { weights: { 'ui-overshoot': 1.6 }, measured, focus: ['ui-overshoot', 'ui-responsiveness'] })
  assert.ok(estimateTokens(block) <= CRITIC_TOKEN_BUDGET, `critic block ${estimateTokens(block)} tokens`)
  assert.match(block, /ui-overshoot/)
})

test('plan parsing reads script comments and JSON plan objects', () => {
  const script = '-- Name: Button\n-- Plan:\n-- ui-responsiveness: start in 40 ms\n-- not-a-principle: ignored\nreturn {}'
  assert.deepEqual(parseScriptPlan(script), { 'ui-responsiveness': 'start in 40 ms' })
  assert.deepEqual(parsePlanObject({ 'ui-overshoot': 'damping 0.7', nope: 'x', 'ui-readability': 3 }), { 'ui-overshoot': 'damping 0.7' })
})

test('score aggregation: critic and code merge, weights move the overall, focus and change order follow', () => {
  const merged = mergePrincipleScores(
    [{ id: 'ui-overshoot', score: 8, note: 'snappy' }, { id: 'ui-readability', score: 6, note: 'ok' }],
    [{ id: 'ui-overshoot', score: 4, note: 'rings' }, { id: 'ui-responsiveness', score: 7, note: 'fast' }]
  )
  const ov = merged.find((m) => m.id === 'ui-overshoot')!
  assert.equal(ov.source, 'both')
  assert.equal(ov.score, 6)
  assert.equal(ov.measured, 4)
  assert.equal(merged.find((m) => m.id === 'ui-responsiveness')!.source, 'code')

  const scores = [{ id: 'ui-overshoot', score: 4 }, { id: 'ui-responsiveness', score: 8 }]
  const neutral = principleOverall(scores)!
  const caresOv = principleOverall(scores, { 'ui-overshoot': 2.5 })!
  const caresResp = principleOverall(scores, { 'ui-responsiveness': 2.5 })!
  assert.ok(caresOv < neutral && neutral < caresResp, `${caresOv} < ${neutral} < ${caresResp}`)
  assert.equal(blendOverall(8, 6), 7)
  assert.equal(blendOverall(8, null), 8)

  assert.deepEqual(focusPrinciples([{ id: 'ui-readability', score: 5 }, { id: 'ui-overshoot', score: 6.5 }, { id: 'ui-responsiveness', score: 9 }], { 'ui-overshoot': 2.5 }), ['ui-overshoot', 'ui-readability'])
  const changes = [{ n: 1 }, { n: 2, principle: 'ui-readability' }, { n: 3, principle: 'ui-responsiveness' }, { n: 4, principle: 'ui-overshoot' }]
  assert.deepEqual(orderChanges(changes, ['ui-overshoot', 'ui-readability']).map((c) => c.n), [4, 2, 1, 3])

  const r = scorePrinciples(7, [{ id: 'ui-overshoot', score: 3, note: '' }], [], { 'ui-overshoot': 2 })
  assert.equal(r.principleScore, 3)
  assert.equal(r.overall, 5)
  assert.deepEqual(r.focus, ['ui-overshoot'])

  const raw = '```json\n{"principles":[{"id":"ui-overshoot","score":14,"note":"flat","fix":"raise damping"},{"id":"made-up","score":3}]}\n```'
  assert.deepEqual(parsePrincipleScores(raw, ['ui-overshoot', 'ui-responsiveness']), [{ id: 'ui-overshoot', score: 10, note: 'flat', fix: 'raise damping' }])
})

const fb = (rating: 'up' | 'down', scores: Record<string, number>, at: number, notes?: string): PrincipleFeedback => ({ at, lab: 'uimotion', entryId: `e${at}`, rating, scores, ...(notes ? { notes } : {}) })

test('weight learning: dislikes on weak overshoot raise it, notes boost mentioned principles', () => {
  const p = learnProfile([
    fb('down', { 'ui-overshoot': 3, 'ui-responsiveness': 7, 'ui-readability': 7 }, 1),
    fb('down', { 'ui-overshoot': 4, 'ui-responsiveness': 7.5, 'ui-readability': 6.5 }, 2),
    fb('up', { 'ui-overshoot': 8, 'ui-responsiveness': 7, 'ui-readability': 4 }, 3),
    fb('up', { 'ui-overshoot': 8.5, 'ui-responsiveness': 8, 'ui-readability': 5 }, 4)
  ])
  assert.ok(p.weights['ui-overshoot'] > 1.3, `overshoot ${p.weights['ui-overshoot']}`)
  assert.ok(p.weights['ui-readability'] < 0.85, `readability ${p.weights['ui-readability']}`)
  assert.equal(p.ratings, 4)
  assert.match(prioritiesText(p), /Overshoot restraint \(ui-overshoot, x1\.\d\d\)/)

  assert.ok(noteMentions('wobbly jelly bounce').includes('ui-overshoot'))
  const w: Record<string, number> = {}
  for (let i = 0; i < 50; i++) applyFeedback(w, { rating: 'down', scores: { 'ui-overshoot': 0, 'ui-responsiveness': 10 }, notes: 'wobbly jelly' })
  assert.equal(w['ui-overshoot'], MAX_WEIGHT)
  assert.equal(w['ui-responsiveness'], MIN_WEIGHT)
})

test('PrincipleService records ratings, learns weights, writes memory, forgets and resets', async () => {
  const dir = await tmp('store')
  const calls: { name: string; body: string }[] = []
  const memory = { remember: async (input: { name: string; body: string }) => (calls.push(input), { entry: { name: input.name } }) }
  let now = 1000
  const svc = new PrincipleService({ dir, memory, now: () => now++ })
  assert.deepEqual(await svc.weights(), {})
  await svc.record({ lab: 'uimotion', entryId: 'a', rating: 'down', scores: { 'ui-overshoot': 2, 'ui-readability': 8, 'ui-responsiveness': 8 }, notes: 'too wobbly' })
  await svc.record({ lab: 'uimotion', entryId: 'b', rating: 'down', scores: { 'ui-overshoot': 3, 'ui-readability': 7, 'ui-responsiveness': 7 } })
  await svc.record({ lab: 'uimotion', entryId: 'c', rating: 'up', scores: {} })
  const w = await svc.weights()
  assert.ok(w['ui-overshoot'] > 1.4, JSON.stringify(w))
  assert.equal((await svc.view()).profile.ratings, 2, 'a rating without scores is ignored')
  assert.ok(calls.some((c) => c.name === 'principle-priorities' && /Overshoot/.test(c.body)))
  await svc.record({ lab: 'uimotion', entryId: 'a', rating: 'up', scores: { 'ui-overshoot': 2, 'ui-readability': 8, 'ui-responsiveness': 8 } })
  assert.equal((await svc.feedback()).length, 2)
  await svc.forget('uimotion', 'b')
  assert.equal((await svc.feedback()).length, 1)
  assert.equal(JSON.parse(await readFile(join(dir, 'feedback.json'), 'utf8')).length, 1)
  const v = await svc.reset()
  assert.equal(v.profile.ratings, 0)
  assert.equal(v.catalogue.length, ALL_PRINCIPLES.length)
})
