// VFX Make quality: request parsing, retrieval of the closest library effects (ratings and remix
// feedback), remix (recolour, rescale), the real-texture bank (flipbooks carried, never invented
// ids), learned priors as checks with fixes, the weighted recipes, the code metrics, and the service
// (Make remixes and picks between variations, the model's edits and the critic's pick, ratings feed
// back, compose prompts carry the grounding). Library: test/vfxEval/library.ts.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { allNodes, effectColors, findNode } from '../src/shared/vfx/analyze.ts'
import { SMOKE, SPARKLES } from '../src/shared/vfx/kit.ts'
import { bankPick, bankTextureChanges, effectTextureBank, feedbackBoost, nearestEffects, normalizeFeedback, readRequest, recordFeedback, remixable, emptyFeedback } from '../src/shared/vfx/retrieve.ts'
import { mainHue, recolor, remixEffect, rescale } from '../src/shared/vfx/remix.ts'
import { band, chooseRecipe, fitToPriors, priorFit } from '../src/shared/vfx/priors.ts'
import { extractRecipe, extractRecipes, learnWeight } from '../src/shared/vfx/recipes.ts'
import { scoreEffect } from '../src/shared/vfx/quality.ts'
import { finishEffect, ground, pickByCode, singleCandidates } from '../src/shared/vfx/ground.ts'
import { heuristicCritique } from '../src/shared/vfx/critique.ts'
import { requestTagGroups } from '../src/shared/vfx/tags.ts'
import { applyChanges, compactEffect, effectFromSpec } from '../src/shared/vfx/spec.ts'
import type { NumberRange, VfxEffect, VfxEntry } from '../src/shared/vfx/types.ts'
import { VfxService } from '../src/main/services/vfx/service.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'
import { fixtureLibrary, TEX } from './vfxEval/library.ts'

const tmp = (p: string) => mkdtemp(join(tmpdir(), `forge-vfxq-${p}-`))
const lib = fixtureLibrary()
const byName = (n: string) => lib.find((e) => e.name === n)!
const BANK_IDS = new Set(Object.values(TEX))

test('requests read as kind / element / colours / size', () => {
  assert.deepEqual(requestTagGroups('purple sword slash with sparks').kind, ['slash'])
  const fb = readRequest('a huge fireball')
  assert.deepEqual(fb.groups.kind, ['projectile'])
  assert.deepEqual(fb.groups.element, ['fire'])
  assert.equal(fb.scale, 1.5)
  const r = readRequest('blue lightning impact')
  assert.deepEqual(r.hues, ['blue'])
  assert.deepEqual(r.groups.element, ['electric'])
  assert.equal(readRequest('tiny spark').scale, 0.7)
})

test('nearest effects: kind and element first, liked ahead, disliked never, feedback reorders', () => {
  const m = nearestEffects('rock impact with debris', lib)
  assert.match(m[0].entry.name, /^EarthImpact/)
  assert.ok(m[0].kindMatch && m[0].elementMatch)
  assert.ok(m.slice(0, 5).every((x) => x.entry.tagGroups!.kind.includes('impact')))
  // Another kind counts far less than the asked one.
  const slash = nearestEffects('fire slash', lib)
  assert.match(slash[0].entry.name, /^FireSlash/)
  assert.equal(slash[0].entry.rating, 'up', 'the liked fire slash comes first')
  // Disliked and avoid entries are never offered.
  const disliked = lib.map((e) => (e.name === 'FireSlash1' ? { ...e, rating: 'down' as const } : e))
  assert.ok(!nearestEffects('fire slash', disliked).some((x) => x.entry.name === 'FireSlash1'))
  // Remixes of FireSlash2 were liked: it moves ahead.
  const fb = recordFeedback(recordFeedback(emptyFeedback(), ['fx-fireslash2'], 'up'), ['fx-fireslash2'], 'up')
  assert.equal(nearestEffects('fire slash', lib, { feedback: fb })[0].entry.name, 'FireSlash2')
  // Media and nothing-in-common are not matches.
  assert.equal(nearestEffects('laser beam', lib).length, 0)
  assert.ok(remixable(slash[0], readRequest('fire slash')))
  assert.ok(!remixable(nearestEffects('slash', lib).find((x) => !x.kindMatch), readRequest('fire impact')))
})

test('feedback: votes move, normalise and turn into a bounded boost', () => {
  let fb = recordFeedback(emptyFeedback(), ['a', 'b'], 'up')
  assert.deepEqual(fb.bases.a, { up: 1, down: 0 })
  fb = recordFeedback(fb, ['a', 'b'], 'down', 'up')
  assert.deepEqual(fb.bases.a, { up: 0, down: 1 })
  fb = recordFeedback(fb, ['a'], null, 'down')
  assert.equal(fb.bases.a, undefined)
  assert.ok(feedbackBoost(fb, 'b') < 1)
  assert.equal(feedbackBoost(fb, 'zzz'), 1)
  assert.ok(feedbackBoost({ bases: { x: { up: 40, down: 0 } } }, 'x') <= 2.5)
  assert.deepEqual(normalizeFeedback({ bases: { q: { up: '2', down: -1 }, r: {} }, junk: 1 }), { bases: { q: { up: 2, down: 0 } } })
})

test('remix recolours saturated colours toward the request, keeps whites, rescales, never edits the library', () => {
  const base = byName('FireSlash1')
  const before = JSON.stringify(base.effect)
  const r = remixEffect(base, readRequest('huge blue slash'), 'BlueSlash')
  assert.equal(JSON.stringify(base.effect), before, 'the library entry is untouched')
  assert.equal(r.effect.name, 'BlueSlash')
  const h = mainHue(r.effect)!
  assert.ok(Math.abs(h - 222) < 25, `main hue ${h}`)
  assert.ok(effectColors(r.effect).includes('blue') || effectColors(r.effect).includes('cyan'))
  // Same structure, textures and timing as the base.
  assert.equal(allNodes(r.effect.roots).length, allNodes(base.effect!.roots).length)
  assert.deepEqual(r.effect.cues.map((c) => c.at), base.effect!.cues.map((c) => c.at))
  assert.deepEqual(allNodes(r.effect.roots).map((n) => n.props.Texture), allNodes(base.effect!.roots).map((n) => n.props.Texture))
  // White keys stay white (the electric slash starts its sparks at pure white).
  const elec = recolor(byName('ElectricSlash').effect!, 30)
  assert.ok(elec.delta !== 0)
  const sparks = allNodes(elec.effect.roots).find((n) => n.name === '1SP')!
  const first = (sparks.props.Color as { c: number[] }[])[0].c
  assert.ok(first.every((v) => v > 0.99), 'the hot white start stays white')
  const mid = (sparks.props.Color as { c: number[] }[]).at(-1)!.c
  assert.ok(mid[0] > mid[2], 'the cyan end turned warm')
  // "huge": sizes x1.5.
  const slash0 = allNodes(base.effect!.roots).find((n) => n.name === 'Slash')!
  const slash1 = allNodes(r.effect.roots).find((n) => n.name === 'Slash')!
  assert.ok(Math.abs((slash1.props.Size as { v: number }[])[1].v - (slash0.props.Size as { v: number }[])[1].v * 1.5) < 0.01)
  assert.ok(r.notes.some((n) => /recoloured toward blue/.test(n)) && r.notes.some((n) => /scaled up/.test(n)))
  // Within 18 degrees: nothing to do.
  assert.equal(recolor(base.effect!, mainHue(base.effect!)! + 5).delta, 0)
  assert.equal(rescale(base.effect!, 1), base.effect)
})

test('texture bank: real textures per role with their flipbook, placeholders replaced, nothing invented', () => {
  const bank = effectTextureBank(lib)
  const smoke = bankPick(bank, 'ParticleEmitter', 'smoke')!
  assert.equal(smoke.texture, TEX.smokeSheet)
  assert.equal(smoke.props.FlipbookLayout, 'Grid4x4')
  // A kit-like effect on Roblox's placeholders.
  const fx = effectFromSpec({
    name: 'Kitty',
    layers: [
      { name: 'HitSparks', class: 'ParticleEmitter', props: { Texture: SPARKLES, Orientation: 'VelocityParallel', Speed: 30, Size: 0.3 }, emit: [{ at: 0, count: 10 }] },
      { name: 'HitSmoke', class: 'ParticleEmitter', props: { Texture: SMOKE, LightEmission: 0, Lifetime: [1, 1.5], Color: '#555555' }, emit: [{ at: 0, count: 6 }] },
      { name: 'Ray', class: 'Beam', from: [0, 0, 0], to: [0, 0, -8], props: { Width0: 1 } },
      { name: 'Mine', class: 'ParticleEmitter', props: { Texture: 'rbxassetid://424242' }, emit: [{ at: 0, count: 2 }] }
    ]
  })
  const ch = bankTextureChanges(fx, bank)
  const next = applyChanges(fx, ch as never)
  const tex = (n: string) => findNode(next.roots, n)!.props.Texture
  assert.equal(tex('HitSparks'), TEX.spark)
  assert.equal(tex('HitSmoke'), TEX.smokeSheet)
  assert.equal(findNode(next.roots, 'HitSmoke')!.props.FlipbookLayout, 'Grid4x4', 'the flipbook layout travels with the sheet')
  assert.equal(tex('Ray'), TEX.trail, 'a beam borrows a trail texture when no beam has one')
  assert.equal(tex('Mine'), 'rbxassetid://424242', 'textures that are already set stay')
  for (const n of allNodes(next.roots)) if (typeof n.props.Texture === 'string' && n.props.Texture.startsWith('rbxassetid://') && n.name !== 'Mine') assert.ok(BANK_IDS.has(n.props.Texture), `${n.props.Texture} is from the library`)
  // Roles the texture library covers keep their placeholder for the texture policy.
  assert.ok(!bankTextureChanges(fx, bank, { skipRoles: ['sparks'] }).some((c) => c.node === 'HitSparks'))
  // Scripted effects are keyed by name (patches survive a re-run).
  const scripted = applyChanges({ ...fx, script: 'return function(fx) end' }, bankTextureChanges({ ...fx, script: 'x' }, bank) as never)
  assert.ok(scripted.patches?.some((p) => p.node === 'HitSparks' && p.prop === 'Texture'))
})

test('learned recipes weight liked effects, drop disliked ones and learn duration / fades / burst times', () => {
  assert.equal(learnWeight({ rating: 'up', kind: 'model' }), 2)
  assert.equal(learnWeight({ quality: 'avoid', kind: 'generated' }), 0)
  assert.equal(learnWeight({ rating: 'down', kind: 'model' }), 0)
  assert.equal(learnWeight({ kind: 'generated' }), 0.5)
  const r = extractRecipe('slash', lib)!
  assert.ok(r.ranges['effect.duration'] && r.ranges['sparks.TransparencyEnd'] && r.ranges['sparks.BurstAt'])
  assert.equal(r.ranges['sparks.TransparencyEnd'].p10, 1)
  // A liked outlier moves the median toward it; disliked does not count at all.
  const odd = { ...byName('WindSlash'), id: 'odd', name: 'OddSlash', effect: rescaleLife(byName('WindSlash').effect!, 4) }
  const liked = extractRecipe('slash', [...lib, { ...odd, rating: 'up' as const }])!
  const plain = extractRecipe('slash', [...lib, odd])!
  const disliked = extractRecipe('slash', [...lib, { ...odd, rating: 'down' as const }])!
  assert.ok(liked.ranges['sparks.Lifetime'].median >= plain.ranges['sparks.Lifetime'].median)
  assert.deepEqual(disliked.ranges['sparks.Lifetime'], r.ranges['sparks.Lifetime'])
  assert.ok(disliked.avoid.some((a) => a.startsWith('OddSlash')))
  // A boost (remix feedback) counts like a weight.
  const boosted = extractRecipe('slash', [...lib, odd], { boost: (e) => (e.id === 'odd' ? 3 : 1) })!
  assert.ok(boosted.ranges['sparks.Lifetime'].p90 >= plain.ranges['sparks.Lifetime'].p90)
  assert.equal(chooseRecipe(extractRecipes(lib), ['slash', 'fire'])!.tag, 'slash+fire')
  assert.equal(chooseRecipe(extractRecipes(lib), ['slash', 'ice'])!.tag, 'slash')
})

function rescaleLife(e: VfxEffect, k: number): VfxEffect {
  const next: VfxEffect = JSON.parse(JSON.stringify(e))
  for (const n of allNodes(next.roots)) if (n.className === 'ParticleEmitter') n.props.Lifetime = (n.props.Lifetime as number[]).map((x) => x * k)
  return next
}

test('priors: values outside the learned ranges are flagged with fixes; fit pulls in only the far ones', () => {
  const recipe = extractRecipe('slash', lib)!
  // A real slash from the library fits.
  assert.equal(priorFit(byName('DarkSlash1').effect!, recipe).issues.length, 0)
  const bad = rescaleLife(byName('DarkSlash1').effect!, 6)
  const fit = priorFit(bad, recipe)
  assert.ok(fit.checks > 10)
  const life = fit.issues.filter((i) => i.prop === 'Lifetime')
  assert.ok(life.length >= 3 && life.every((i) => i.far))
  assert.match(life[0].message, /lifetime .* is higher than your slash effects/)
  const fixed = fitToPriors(bad, recipe)
  assert.ok(fixed.applied.length >= 3)
  assert.equal(priorFit(fixed.effect, recipe).issues.filter((i) => i.prop === 'Lifetime').length, 0)
  // Fewer samples, a wider band.
  const [lo2, hi2] = band({ p10: 1, p90: 2 }, 2)
  const [lo30, hi30] = band({ p10: 1, p90: 2 }, 30)
  assert.ok(lo2 < lo30 && hi2 > hi30 && lo30 < 1 && hi30 > 2)
  // Thin recipes are not used as checks (one effect is not a range).
  assert.equal(priorFit(bad, { ...recipe, samples: 1 }).checks, 0)
  // The numbers-only critique proposes the fixes (farthest first).
  const c = heuristicCritique(bad, recipe)
  assert.ok(c.changes.some((ch) => ch.prop === 'Lifetime'))
  assert.match(c.summary, /outside the learned ranges/)
})

test('quality metrics: placeholders, pops and constant sizes cost points', () => {
  const g = ground('fire slash', { entries: lib })
  const good = scoreEffect(byName('FireSlash1').effect!, { recipe: g.recipe, known: g.known })
  assert.equal(good.textureReuse, 1)
  assert.equal(good.timing, 1)
  const plain = effectFromSpec({ name: 'Plain', duration: 1, layers: [{ name: 'Blob', class: 'ParticleEmitter', props: { Size: 2, Transparency: 0, Lifetime: [3, 3] }, emit: [{ at: 0, count: 10 }] }] })
  const q = scoreEffect(plain, { recipe: g.recipe, known: g.known })
  assert.equal(q.textureReuse, 0)
  assert.ok(q.timing < 0.7 && q.overall < good.overall - 3)
  assert.ok(q.notes.some((n) => /pop/.test(n)) && q.notes.some((n) => /placeholder/.test(n)))
})

test('grounding: remix candidates from different bases, the draft when nothing is close, the code pick', () => {
  const g = ground('ice slash', { entries: lib, recipes: extractRecipes(lib) })
  assert.equal(g.recipe!.tag, 'slash')
  const cands = singleCandidates('ice slash', g, 3)
  assert.equal(cands.length, 3)
  assert.equal(new Set(cands.map((c) => c.basedOn[0])).size, 3)
  assert.ok(cands.every((c) => c.how === 'remix'))
  const beam = ground('laser beam', { entries: lib })
  const d = singleCandidates('laser beam', beam, 3)
  assert.equal(d.length, 1)
  assert.equal(d[0].how, 'draft')
  assert.ok(d[0].spec)
  // The pick keeps the candidate the checks like best.
  const broken = { ...cands[0], effect: rescaleLife(cands[0].effect, 8) }
  const pick = pickByCode([broken, cands[1]], g)
  assert.equal(pick.index, 1)
  assert.ok(pick.scores[1].total > pick.scores[0].total)
  // Finishing pulls the broken one back in and says so.
  const f = finishEffect(broken.effect, g)
  assert.ok(f.notes.some((n) => /pulled into your slash ranges/.test(n)))
  // The keyed listing names duplicate layers by id.
  const dup = compactEffect(byName('EarthShockwave').effect!, { keys: true }) as { layers: { name: string; label?: string }[] }
  assert.ok(dup.layers.some((l) => l.label === 'Ring' && l.name !== 'Ring'))
})

// ---------------------------------------------------------------- service

async function serviceWith(extra: Partial<ConstructorParameters<typeof VfxService>[0]> = {}, entries: VfxEntry[] = lib) {
  const userDir = await tmp('user')
  const root = await tmp('proj')
  const svc = new VfxService({ userDir, projectRoot: () => root, lune: async () => ({ error: 'not in this test' }), runtimeDir: () => null, ...extra })
  for (const e of entries) await svc.user.save(e)
  return { svc, userDir, root }
}

test('Make without a model remixes the closest effect, tags it as asked and keeps the best of 3', async () => {
  const { svc } = await serviceWith()
  const { entry } = await svc.make('ice slash', { variations: 3 })
  assert.equal(entry.kind, 'generated')
  assert.ok(entry.basedOn?.length === 1 && lib.some((e) => e.id === entry.basedOn![0]))
  assert.ok(entry.makeNotes?.some((n) => /started from your effect/.test(n)))
  assert.equal(entry.pick?.of, 3)
  assert.equal(entry.pick?.by, 'code')
  assert.equal(entry.pick?.scores?.length, 3)
  assert.deepEqual(entry.tagGroups!.element, ['ice'], 'the request names the element')
  assert.ok(entry.tagGroups!.kind.includes('slash'))
  assert.match(entry.description, /remixed from your/)
  assert.ok(!entry.modelNote)
  // Textures are the library's.
  for (const n of allNodes(entry.effect!.roots)) if (typeof n.props.Texture === 'string' && n.props.Texture.startsWith('rbxassetid://')) assert.ok(BANK_IDS.has(n.props.Texture))
  // Nothing close: the grounded draft.
  const { entry: beam } = await svc.make('laser beam')
  assert.ok(!beam.pick)
  assert.match(beam.description, /Draft for/)
})

test('Make with a model: grounded prompt, the edits apply to the remix, failures fall back with the error', async () => {
  const prompts: { system: string; prompt: string }[] = []
  const vision = async (system: string, prompt: string) => {
    prompts.push({ system, prompt })
    if (/Variation B/.test(prompt)) throw new Error('rate limited')
    return '```json\n' + JSON.stringify({ name: 'Frost Cutter', description: 'an ice slash', changes: [{ node: 'Slash', prop: 'LightEmission', value: 0.6, why: 'ice reads cooler' }, { node: 'NoSuchLayer', prop: 'Rate', value: 3 }] }) + '\n```'
  }
  const { svc } = await serviceWith({ vision: () => vision })
  const { entry } = await svc.make('ice slash', { variations: 2 })
  assert.equal(prompts.length, 2)
  const p = prompts[0]
  assert.match(p.system, /adapt a real Roblox VFX from the user's own library/)
  assert.match(p.prompt, /Starting effect: a copy of the user's "/)
  assert.match(p.prompt, /Closest effects in the user's own library/)
  assert.match(p.prompt, /Learned ranges for "slash"/)
  assert.match(p.prompt, /Real textures from the user's effects by layer role/)
  assert.match(p.prompt, /rbxassetid:\/\/3002/)
  assert.equal(entry.name, 'FrostCutter')
  assert.equal(findNode(entry.effect!.roots, 'Slash')!.props.LightEmission, 0.6)
  assert.ok(entry.makeNotes!.some((n) => /1 model edit \(1 did not apply\)/.test(n)))
  assert.ok(!entry.pick, 'one variation failed: nothing to pick between')
  // Every model answer unusable: the code candidate, with the actual error noted.
  const { svc: svc2 } = await serviceWith({ vision: () => async () => 'no json here' })
  const { entry: e2 } = await svc2.make('ice slash')
  assert.match(e2.modelNote ?? '', /Drafted without a model because: no JSON/)
  assert.ok(e2.basedOn?.length)
})

test('Make with frames and a critic: the critic picks the variation; liked remixes boost their base', async () => {
  const png = Buffer.from('89504e470d0a1a0a0000', 'hex')
  const seen: number[] = []
  const vision = (tier?: string) => async (_s: string, prompt: string, images: unknown[]) => {
    if (tier === 'default') return JSON.stringify({ changes: [] })
    if (/variations of the effect/.test(prompt)) {
      seen.push(images.length)
      return '{"pick":"B","why":"cleaner silhouette"}'
    }
    return JSON.stringify({ scores: { readability: 9, layering: 9, timing: 9, color: 9, silhouette: 9, performance: 9 }, summary: 'good', changes: [] })
  }
  const { svc, userDir } = await serviceWith({ vision, capture: async (req) => req.times.map(() => png) })
  const { entry } = await svc.make('fire slash', { variations: 2, wait: true, maxIterations: 1 })
  assert.deepEqual(seen, [4], 'two frames of each variation in one call')
  const saved = await svc.get(entry.id)
  assert.equal(saved.pick!.by, 'critic')
  assert.equal(saved.pick!.chosen, 1)
  assert.equal(saved.pick!.why, 'cleaner silhouette')
  // Thumbs up: the base it came from gets the credit (feedback.json), and moves up for the next Make.
  await svc.rate(entry.id, 'up')
  const fb = JSON.parse(await readFile(join(userDir, 'feedback.json'), 'utf8'))
  assert.deepEqual(fb.bases[saved.basedOn![0]], { up: 1, down: 0 })
  await svc.rate(entry.id, 'down')
  const fb2 = JSON.parse(await readFile(join(userDir, 'feedback.json'), 'utf8'))
  assert.deepEqual(fb2.bases[saved.basedOn![0]], { up: 0, down: 1 })
  assert.ok((await svc.feedback()).bases[saved.basedOn![0]].down === 1)
})

test('the critic gets the closest library effects as references', async () => {
  const { svc } = await serviceWith()
  const refs = await svc.references(['impact', 'earth'], 'rock impact')
  assert.match(refs[0].name, /^EarthImpact/)
})

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
test('compose: grounded prompt, variations, real textures on the kit rigs', { skip: !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false }, async () => {
  const prompts: string[] = []
  const script = (speed: number) => `-- Name: FireCut\nreturn function(fx)\n\tfx:stage("release")\n\tfx:spawn("sparks", { name = "Hit", count = 20, speed = ${speed} })\n\tfx:spawn("smoke", { name = "Puff", count = 6 })\n\tfx:wait(0.6)\nend\n`
  let n = 0
  const vision = async (_s: string, prompt: string) => {
    prompts.push(prompt)
    return '```lua\n' + script(n++ === 0 ? 30 : 400) + '```'
  }
  const { svc } = await serviceWith({ vision: () => vision, lune: async () => ({ path: lune! }), runtimeDir: () => runtime })
  const r = await svc.compose('fire slash', { variations: 2, refine: false })
  assert.ok(r.ok, r.error?.message)
  assert.equal(prompts.length, 2)
  assert.match(prompts[0], /Closest effects in the user's own library/)
  assert.match(prompts[0], /texture = "rbxassetid:\/\/\.\.\."/)
  assert.match(prompts[1], /Variation B/)
  const e = r.entry!
  assert.equal(e.pick?.of, 2)
  assert.equal(e.pick?.by, 'code')
  const sparks = allNodes(e.effect!.roots).find((x) => x.name === 'HitSparks')!
  assert.equal(sparks.props.Texture, TEX.spark)
  const smoke = allNodes(e.effect!.roots).find((x) => x.name === 'PuffSmoke')!
  assert.equal(smoke.props.FlipbookLayout, 'Grid4x4')
  assert.ok(e.effect!.patches?.some((p) => p.node === 'HitSparks' && p.prop === 'Texture'), 'kept as patches across re-runs')
  assert.ok(e.basedOn?.length && e.makeNotes?.some((x) => /textures from your effects/.test(x)))
  // The pulled-in speed: far outside the user's sparks.
  const speed = sparks.props.Speed as NumberRange
  assert.ok(speed[1] < 200, `speed ${speed}`)
})
