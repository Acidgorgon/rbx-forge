// Animation Lab move sets (Combat / Football / Movement & emotes + custom move types): tagging,
// heuristic re-tag, coverage per set, drafts per football move type (recorded through Lune when it is
// installed), the service's per-project settings; and the named-body-part motion check that keeps
// refinement from losing the leg in "right foot pushes the ball outward".
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimClip, AnimCritique, AnimEntry, R15Joint } from '../src/shared/anim/model.ts'
import { allKnownTags, coverageOptions, heuristicRetag, mergeRetag, moveSetDef, MOVE_SETS, normalizeMoveSetSettings, resolveMoveSet, setArchetype, setAutoTags, setPromptTags, thinLabels } from '../src/shared/anim/movesets.ts'
import { buildStyle, coverage, promptTags } from '../src/shared/anim/style.ts'
import { archetypeFor, draftAnimScript } from '../src/shared/anim/draft.ts'
import { findKitPose } from '../src/shared/anim/kit.ts'
import { compileAnim, finishAnimRun } from '../src/shared/anim/compile.ts'
import { ANIM_EXAMPLES } from '../src/shared/anim/examples.ts'
import { ANIM_RECORDED } from '../src/shared/anim/examples.recorded.ts'
import { qeulerDeg, xfToCf, type V3 } from '../src/shared/anim/math.ts'
import { measureParts, requestedParts } from '../src/shared/anim/bodyparts.ts'
import { runChecks } from '../src/shared/anim/checks.ts'
import { animRefineLoop, betterIteration, heuristicAnimCritique, MUST_FIX_CAP, withMustFix } from '../src/shared/anim/critique.ts'
import { writeKeyframeSequenceXml } from '../src/shared/anim/rbxmx.ts'
import { AnimService } from '../src/main/services/anim/service.ts'
import { luneAnimTimeline } from '../src/main/services/anim/lune.ts'
import { findLune, findRuntimeDir } from '../src/main/services/tests/lune.ts'

const football = moveSetDef('football')
const combat = moveSetDef('combat')

const example = (key: string): AnimClip => {
  const ex = ANIM_EXAMPLES.find((e) => e.key === key)!
  return compileAnim(ANIM_RECORDED[key], ex.script).clip
}

const entry = (id: string, name: string, tags: string[], extra: Partial<AnimEntry> = {}): AnimEntry =>
  ({ id, name, scope: 'user', kind: 'imported', clip: example('dash-punch'), tags, createdAt: 1, updatedAt: 1, description: '', notes: '', origin: `${name}.rbxmx`, ...extra }) as AnimEntry

// A clip from joint euler keys: { joint: [[t, [x, y, z]], ...] }.
function jointClip(name: string, keys: Partial<Record<R15Joint, [number, V3][]>>, duration = 1): AnimClip {
  const tracks: AnimClip['tracks'] = {}
  for (const [j, ks] of Object.entries(keys) as [R15Joint, [number, V3][]][]) tracks[j] = ks.map(([t, e]) => ({ t, cf: xfToCf({ p: [0, 0, 0], q: qeulerDeg(e) }), ease: 'CubicV2', dir: 'InOut' }))
  return { name, duration, looped: false, priority: 'Action', tracks, markers: [] }
}

// ------------------------------------------------------------------ sets and tagging

test('movesets: Combat is the original tag list; Football tags the football moves', () => {
  assert.deepEqual(MOVE_SETS.map((s) => s.id), ['combat', 'football', 'movement'])
  for (const text of ['heavy overhead punch', 'dodge roll back', 'fireball cast', 'GojoHandSign', 'combat idle', 'stagger from a hit', 'header goal celebration']) assert.deepEqual(setPromptTags(text, combat), promptTags(text), text)
  assert.deepEqual(combat.core, ['attack', 'cast', 'dash', 'idle', 'hit', 'sign'])

  const t = (s: string) => setPromptTags(s, football)
  assert.deepEqual(t('PowerShot_Volley'), ['shot'])
  assert.deepEqual(t('DivingHeader'), ['header'], 'a diving header is not a keeper save')
  assert.deepEqual(t('KneeSlideCelebration'), ['celebration'], 'a knee slide is not a tackle')
  assert.deepEqual(t('slide_tackle'), ['tackle'])
  assert.deepEqual(t('keeper dive save'), ['save'])
  assert.deepEqual(t('Elastico skill'), ['dribble'])
  assert.deepEqual(t('chest trap first touch'), ['trap'])
  assert.deepEqual(t('long pass'), ['pass'])
  assert.ok(t('free kick').includes('shot'))
  assert.deepEqual(t('overhead kick'), ['shot'], '"overhead" is not a header')
  assert.deepEqual(t('SIUUU'), ['celebration'])
})

test('movesets: settings, custom move types and the known tags', () => {
  assert.deepEqual(normalizeMoveSetSettings(null), { set: 'combat', custom: {} })
  assert.deepEqual(normalizeMoveSetSettings({ set: 'nope', custom: { nope: [{ tag: 'x' }], football: 'bad' } }), { set: 'combat', custom: {} })
  const s = normalizeMoveSetSettings({ set: 'football', custom: { football: [{ tag: 'Throw-In Long!', description: 'long throw', words: ['long throw'] }, 'rabona', { tag: 'rabona' }, { tag: 'example' }, { tag: 'bike', like: 'shot' }] } })
  assert.deepEqual(s.custom.football.map((c) => c.tag), ['throw-in long', 'rabona', 'bike'])
  const set = resolveMoveSet(s)
  assert.equal(set.id, 'football')
  assert.ok(set.core.includes('rabona') && set.core.includes('shot'))
  assert.deepEqual(setPromptTags('a long throw from the line', set).filter((x) => x !== 'throw'), ['throw-in long'])
  assert.ok(setPromptTags('bike', set).includes('bike'))
  assert.equal(set.tags.find((x) => x.tag === 'bike')!.archetype, 'kick', 'like: the archetype of the named tag')
  const known = allKnownTags(s)
  for (const k of ['attack', 'shot', 'header', 'emote', 'climb', 'rabona']) assert.ok(known.includes(k), k)
})

test('movesets: football auto tags on import, heuristic re-tag keeps what it cannot place', () => {
  const clip = example('dash-punch')
  // Combat guessed "dash, attack" from the motion; Football reads the name only.
  assert.deepEqual(setAutoTags({ ...clip, name: 'Celebration2' }, 'Celebration2.rbxmx', combat).includes('celebration'), false)
  assert.deepEqual(setAutoTags({ ...clip, name: 'Celebration2' }, 'Celebration2.rbxmx', football), ['celebration'])
  assert.deepEqual(setAutoTags({ ...clip, name: 'Anim7' }, 'Anim7.rbxmx', football), [], 'no football words, no guess')

  const entries = [
    entry('a', 'Celebration2', ['dash', 'attack', 'emote']),
    entry('b', 'Anim7', ['dash', 'attack']),
    entry('c', 'Thing', ['attack', 'example', 'my-move'], { notes: 'diving header at the near post' }),
    entry('d', 'PowerShot', ['shot'])
  ]
  const changes = heuristicRetag(entries, football)
  assert.deepEqual(changes.map((c) => c.id), ['a', 'c'], 'unmatched and unchanged clips are left alone')
  assert.deepEqual(changes[0].after, ['celebration'], 'combat-only guesses go when a football tag is found')
  assert.deepEqual(changes[1].after, ['example', 'my-move', 'header'], 'example and unknown tags stay')
  assert.deepEqual(mergeRetag(['idle', 'dash'], ['idle'], football), ['idle'])
  assert.deepEqual(mergeRetag(['dash'], [], football), ['dash'])
})

test('movesets: coverage, thin labels and profiles per set', () => {
  const entries = [entry('a', 'Shot1', ['shot'], { rating: 'up' }), entry('b', 'Shot2', ['shot']), entry('c', 'Shot3', ['shot']), entry('d', 'H', ['header'])]
  const cov = coverage(entries, coverageOptions(football))
  assert.equal(cov.tags[0].tag, 'shot')
  assert.ok(!cov.thin.includes('shot'))
  assert.ok(cov.thin.includes('celebration') && cov.thin.includes('header'))
  assert.ok(!cov.thin.includes('attack'), 'combat tags are not expected under Football')
  assert.deepEqual(thinLabels(['header', 'save', 'mystery'], football), ['headers', 'keeper saves', 'mystery clips'])
  // Default (combat) unchanged.
  assert.ok(coverage(entries).thin.includes('attack'))
  // Profiles: the default style ignores football tags; the known list keeps them.
  assert.ok(!buildStyle(entries, 1).profiles.some((p) => p.tag === 'shot'))
  assert.ok(buildStyle(entries, 1, allKnownTags()).profiles.some((p) => p.tag === 'shot' && p.samples === 3))
})

// ------------------------------------------------------------------ drafts

const FOOTBALL_REQUESTS: [string, string, string][] = [
  ['power shot with a big backswing', 'kick', 'Shot'],
  ['long pass to the wing', 'kick', 'Pass'],
  ['diving header', 'header', 'Header'],
  ['knee slide celebration', 'celebrate', 'Celebration'],
  ['slide tackle', 'slide', 'Tackle'],
  ['keeper diving save', 'save', 'Save'],
  ['chest trap', 'trap', 'Trap'],
  ['step-over skill', 'dash', 'Dribble']
]

test('drafts: football requests map to the closest archetypes and only use kit poses', () => {
  assert.equal(archetypeFor('header goal celebration', football), 'celebrate')
  assert.equal(setArchetype('nothing football here', football), null)
  assert.equal(archetypeFor('quick jab', football), 'punch', 'falls back to the combat rules')
  assert.equal(archetypeFor('roundhouse kick'), archetypeFor('roundhouse kick', combat), 'combat unchanged')
  const custom = resolveMoveSet({ set: 'combat', custom: { combat: [{ tag: 'ledge grab', like: 'jump' }] } })
  assert.equal(archetypeFor('ledge grab', custom), 'jump')
  assert.equal(archetypeFor('ledge grab'), 'punch')
  for (const [req, arch, name] of FOOTBALL_REQUESTS) {
    assert.equal(archetypeFor(req, football), arch, req)
    for (const rig of ['R15', 'R6'] as const) {
      const script = draftAnimScript(req, null, rig, football)
      assert.match(script, new RegExp(`-- Name: ${name}\\b`), `${req}: ${script.split('\n')[0]}`)
      for (const m of script.matchAll(/a:pose\("([^"]+)"/g)) assert.ok(findKitPose(m[1]), `${req}: no kit pose ${m[1]}`)
      if (rig === 'R6') {
        assert.match(script, /a:rig\("R6"\)/)
        assert.doesNotMatch(script, /a:plant\(/)
      }
    }
  }
  assert.match(draftAnimScript('long pass', null, 'R15', football), /kick_extend", \{ amount = 0.75/)
  assert.equal(draftAnimScript('quick jab'), draftAnimScript('quick jab', null, 'R15', combat), 'combat drafts unchanged')
})

const lune = process.env.LUNE_PATH || findLune()
const runtime = findRuntimeDir()
const noLune = !lune || !runtime ? 'Lune not installed (set LUNE_PATH)' : false

test('drafts: every football draft records and compiles on R15 and R6', { skip: noLune }, async () => {
  for (const [req, , name] of FOOTBALL_REQUESTS) {
    for (const rig of ['R15', 'R6'] as const) {
      const script = draftAnimScript(req, null, rig, football)
      const rec = await luneAnimTimeline(script, { lune: lune!, runtimeDir: runtime! })
      assert.equal(rec.ok, true, `${req} ${rig}: ${rec.error?.message} (line ${rec.error?.line})`)
      const run = finishAnimRun(rec, script, { name, learned: [], rig })
      assert.equal(run.ok, true, `${req} ${rig}: ${run.error?.message}`)
      assert.ok(run.clip!.duration > 0.5, `${req} ${rig}: ${run.clip!.duration}`)
      if (rig === 'R15' && ['shot', 'pass', 'trap'].some((t) => setPromptTags(req, football).includes(t))) {
        const checks = runChecks(run.clip!, null, { request: req, tags: setPromptTags(req, football) })
        assert.ok(!checks.issues.some((i) => i.check === 'motion' && i.severity === 'error'), `${req}: ${checks.issues.map((i) => i.message).join(' | ')}`)
      }
      if (rig === 'R15' && req === 'diving header') {
        const m = measureParts(run.clip!, requestedParts(req, ['header']))
        assert.ok(m.every((x) => x.ok), JSON.stringify(m))
      }
    }
  }
})

// ------------------------------------------------------------------ named body parts

test('body parts: the request and the football tags name the parts that must move', () => {
  const parts = (r: string, tags: string[] = []) => requestedParts(r, tags).map((p) => p.part).sort()
  assert.deepEqual(parts('elastico: right foot pushes the ball outward, then snaps back inside in one quick flick, upper body leans to sell it'), ['RightLeg', 'torso'])
  assert.deepEqual(parts('feet stay planted, right hand punches forward'), ['RightArm'])
  assert.deepEqual(parts('left knee strike'), ['LeftLeg'])
  assert.deepEqual(parts('diving header'), ['head'])
  assert.deepEqual(parts('power shot', ['shot']), ['leg'])
  assert.deepEqual(parts('rabona', ['dribble']), ['leg'])
  assert.deepEqual(parts('a cheeky finish with the right foot', ['shot']), ['RightLeg'], 'the sided part replaces the tag one')
  assert.deepEqual(parts('header', ['header']), ['head'])
  assert.deepEqual(parts('keeper save', ['save']), ['arm'])
  assert.deepEqual(parts('celebration', ['celebration']), [])
  assert.deepEqual(parts('heavy overhead punch', ['attack']), ['arm'])
})

const ELASTICO = 'elastico: right foot pushes the ball outward, then snaps back inside in one quick flick, upper body leans to sell it'

// Iteration 1 uses the leg; the "refined" ones only lean the body.
const withLeg = jointClip('Elastico', { RightHip: [[0, [0, 0, 0]], [0.3, [10, 0, 35]], [0.5, [10, 0, -25]], [1, [0, 0, 0]]], RightKnee: [[0, [0, 0, 0]], [0.3, [-30, 0, 0]], [1, [0, 0, 0]]], Waist: [[0, [0, 0, 0]], [0.4, [-6, 14, 0]], [1, [0, 0, 0]]] })
const noLeg = jointClip('Elastico', { RightHip: [[0, [0, 0, 0]], [0.4, [3, 0, 4]], [1, [0, 0, 0]]], Waist: [[0, [0, 0, 0]], [0.4, [-10, 25, 0]], [1, [0, 0, 0]]], RightShoulder: [[0, [0, 0, 0]], [0.5, [60, 0, 40]], [1, [0, 0, 0]]] })

test('checks: a named part that barely moves is a must-fix and costs the score', () => {
  const good = runChecks(withLeg, null, { request: ELASTICO })
  const bad = runChecks(noLeg, null, { request: ELASTICO })
  assert.ok(good.motion!.every((m) => m.ok), JSON.stringify(good.motion))
  assert.equal(good.motion!.find((m) => m.part === 'RightLeg')!.joint, 'RightHip')
  const leg = bad.motion!.find((m) => m.part === 'RightLeg')!
  assert.equal(leg.ok, false)
  assert.ok(leg.rangeDeg < leg.minDeg)
  assert.equal(bad.issues[0].check, 'motion')
  assert.equal(bad.issues[0].severity, 'error')
  assert.match(bad.issues[0].message, /^Must fix: .*right leg.*right foot/)
  const plain = runChecks(noLeg)
  assert.equal(plain.motion, undefined, 'no request, no motion check')
  assert.equal(bad.overall, Math.max(0, Math.round((plain.overall - 2) * 10) / 10))
  // A tag alone asks for its part: an imported "shot" that never moves a leg.
  assert.ok(runChecks(noLeg, null, { tags: ['shot'] }).issues.some((i) => i.check === 'motion' && i.severity === 'error'))
  assert.ok(!runChecks(noLeg, null, { tags: ['celebration'] }).issues.some((i) => i.check === 'motion'))
})

test('critique: must-fix caps the score; the loop never prefers an iteration that lost the named motion', async () => {
  const badChecks = runChecks(noLeg, null, { request: ELASTICO })
  const c = heuristicAnimCritique(noLeg, badChecks)
  assert.ok(c.overall <= MUST_FIX_CAP)
  assert.equal(c.mustFix?.length, 1)
  assert.match(c.summary, /^Must fix: /)
  const high: AnimCritique = { ...c, overall: 9.1, summary: 'great' }
  const capped = withMustFix(high)
  assert.equal(capped.overall, MUST_FIX_CAP)
  assert.deepEqual(withMustFix(capped), capped, 'idempotent')
  const fine = withMustFix({ ...c, checks: runChecks(withLeg, null, { request: ELASTICO }), mustFix: ['stale'] })
  assert.equal(fine.mustFix, undefined)

  // The user's case: #1 used the leg (6.5), later rounds lost it but the critic liked them more.
  const clips = [withLeg, noLeg, noLeg, noLeg]
  const r = await animRefineLoop(
    withLeg,
    {
      render: async (_clip, n) => ({ frames: [`f${n}`], times: [0.3] }),
      critique: async (_clip, _f, _t, n) => {
        const clip = clips[n - 1]
        const checks = runChecks(clip, null, { request: ELASTICO })
        const raw: AnimCritique = { scores: { silhouette: 7, timing: 7, weight: 7, arcs: 7, appeal: 7, cleanliness: 7 }, overall: n === 1 ? 6.5 : 8.8, summary: `round ${n}`, changes: [{ kind: 'retime', from: 0, to: 0.5, scale: 1.05 }], checks, references: [] }
        // Even without the cap, the ranking keeps #1 (the cap is tested above).
        return n === 1 ? raw : { ...raw, overall: 8.8 }
      }
    },
    { maxIterations: 4, threshold: 9.5 }
  )
  assert.equal(r.iterations.length, 4)
  assert.equal(r.best.n, 1, `best #${r.best.n}`)
  const a = { critique: { ...c, overall: 5, checks: runChecks(withLeg, null, { request: ELASTICO }) } }
  const b = { critique: { ...c, overall: 9, checks: badChecks } }
  assert.equal(betterIteration(a, b), a)
  assert.equal(betterIteration(b, a), a)
})

test('critique: a passing score with an open must-fix does not stop the loop at the threshold', async () => {
  const r = await animRefineLoop(
    noLeg,
    {
      render: async () => ({ frames: [], times: [0.3] }),
      critique: async () => ({ scores: { silhouette: 9, timing: 9, weight: 9, arcs: 9, appeal: 9, cleanliness: 9 }, overall: 9, summary: 'x', changes: [{ kind: 'retime', from: 0, to: 0.5, scale: 1.05 }], checks: runChecks(noLeg, null, { request: ELASTICO }), references: [], mustFix: ['leg'] })
    },
    { maxIterations: 2, threshold: 7.5 }
  )
  assert.equal(r.stop, 'max-iterations')
})

// ------------------------------------------------------------------ service

test('service: move set per project (next to the rig), custom types, re-tag without a model, coverage', async () => {
  const root = await mkdtemp(join(tmpdir(), 'anim-sets-'))
  try {
    const project = join(root, 'proj')
    await mkdir(project, { recursive: true })
    const files = join(root, 'files')
    await mkdir(files)
    await writeFile(join(files, 'GoalCelebration.rbxmx'), writeKeyframeSequenceXml({ ...example('dash-punch'), name: 'GoalCelebration' }))
    await writeFile(join(files, 'DivingHeader.rbxmx'), writeKeyframeSequenceXml({ ...example('dash-punch'), name: 'DivingHeader' }))
    let openProject: string | null = project
    const svc = new AnimService({ userDir: join(root, 'user'), projectRoot: () => openProject, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, now: () => 1000 })
    // Imported under Combat: the motion guess makes them dash / attack.
    const imp = await svc.import([join(files, 'GoalCelebration.rbxmx'), join(files, 'DivingHeader.rbxmx')], 'project')
    assert.equal(imp.added.length, 2)
    assert.ok(imp.added.every((e) => !e.tags.includes('celebration') && !e.tags.includes('header')))
    assert.equal((await svc.moveSets()).active.id, 'combat')
    assert.ok((await svc.coverage()).thin.includes('attack'))

    await svc.setRig('R6')
    const set = await svc.setMoveSet('football')
    assert.equal(set.id, 'football')
    const settings = JSON.parse(await readFile(join(project, '.forge', 'anim', 'settings.json'), 'utf8'))
    assert.equal(settings.rig, 'R6', 'the rig stays')
    assert.equal(settings.moveSet.set, 'football')
    assert.ok((await svc.list()).every((e) => e.tags.some((t) => t === 'dash' || t === 'attack')), 'switching keeps the tags')

    const r = await svc.retag()
    assert.equal(r.source, 'heuristic')
    assert.equal(r.changed, 2)
    const byName = Object.fromEntries((await svc.list()).map((e) => [e.name, e.tags]))
    assert.deepEqual(byName.GoalCelebration, ['celebration'])
    assert.deepEqual(byName.DivingHeader, ['header'])
    const cov = await svc.coverage()
    assert.ok(cov.tags.some((t) => t.tag === 'celebration' && t.clips === 1))
    assert.ok(cov.thin.includes('shot') && !cov.thin.includes('attack'))
    assert.ok((await svc.style())?.r6?.profiles.some((p) => p.tag === 'header') || (await svc.style())?.profiles.some((p) => p.tag === 'header'), 'football tags get profiles')

    const withType = await svc.addMoveTag({ tag: 'rabona', description: 'kick with the leg wrapped behind the standing leg', like: 'shot' })
    assert.ok(withType.tags.some((t) => t.tag === 'rabona' && t.custom))
    assert.ok((await svc.coverage()).thin.includes('rabona'))
    await assert.rejects(svc.addMoveTag({ tag: 'shot' }), /already has/)
    assert.deepEqual(await svc.tagsFor('rabona finish'), ['shot', 'rabona'])
    assert.ok(!(await svc.removeMoveTag('rabona')).tags.some((t) => t.tag === 'rabona'))

    // The model path: the cheap tier's tags (filtered to the set) plus the words.
    const svc2 = new AnimService({ userDir: join(root, 'user'), projectRoot: () => openProject, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, now: () => 1000, model: (tier) => (tier === 'cheap' ? async () => JSON.stringify([{ i: 1, tags: ['celebration', 'dance', 'attack'] }, { i: 2, tags: [] }]) : null) })
    const r2 = await svc2.retag()
    assert.equal(r2.source, 'model')
    // Without a project the set lives in the user settings.
    openProject = null
    assert.equal((await svc.moveSets()).active.id, 'combat')
    await svc.setMoveSet('movement')
    assert.equal(JSON.parse(await readFile(join(root, 'user', 'settings.json'), 'utf8')).moveSet.set, 'movement')
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
