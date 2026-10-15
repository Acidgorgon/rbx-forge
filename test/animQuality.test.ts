// Animation Lab quality: motion intent (which limb leads), learned motion priors, the guarded edits,
// the keep-best refine loop (judging, backtracking, the regressed stop), the critic-weight calibration
// in the service, and the offline eval (test/animEval.ts) holding its before -> after gains.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AnimChange, AnimClip, AnimCritique, AnimIterationScore, R15Joint } from '../src/shared/anim/model.ts'
import { cfToXf, eulerDegOf, qeulerDeg, xfToCf } from '../src/shared/anim/math.ts'
import { JOINT_LIMITS, runChecks } from '../src/shared/anim/checks.ts'
import { animRefineLoop, MAX_BACKTRACK } from '../src/shared/anim/critique.ts'
import { buildProfile } from '../src/shared/anim/style.ts'
import { dominantLimb, intentText, limbRanges, motionIntent } from '../src/shared/anim/intent.ts'
import { buildPriors, learnedLimits, mirrorClip, peakOf, priorChecks, priorScore, type MotionPriors } from '../src/shared/anim/priors.ts'
import { bestIteration, dampChanges, guardedApply, iterationScore, judgeRound, objectiveScore, type QualityContext } from '../src/shared/anim/quality.ts'
import { keyframeDigest } from '../src/shared/anim/digest.ts'
import { sampleTrack } from '../src/shared/anim/sample.ts'
import { AnimService } from '../src/main/services/anim/service.ts'
import { caseLibrary, EVAL_CASES, runAnimEval, summarize } from './animEval.ts'

const LEG: R15Joint[] = ['RightHip', 'RightKnee', 'RightAnkle']

// The clip with the listed joints' rotations scaled by k (a timid / exaggerated version).
function scaleJoints(clip: AnimClip, joints: R15Joint[], k: number): AnimClip {
  const tracks = { ...clip.tracks }
  for (const j of joints) {
    const ks = tracks[j]
    if (!ks) continue
    tracks[j] = ks.map((key) => {
      const x = cfToXf(key.cf)
      return { ...key, cf: xfToCf({ p: x.p, q: qeulerDeg(eulerDegOf(x.q).map((v) => v * k) as [number, number, number]) }) }
    })
  }
  return { ...clip, tracks }
}

const elastico = () => {
  const c = EVAL_CASES.find((x) => x.id === 'elastico')!
  const lib = caseLibrary(c)
  const refs = lib.refs.map((r) => r.clip)
  const profile = buildProfile(lib.tags[0], lib.refs)
  const intent = motionIntent(c.prompt, lib.tags, refs)
  return { c, ...lib, clips: refs, profile, intent, ctx: { intent, profile } as QualityContext }
}

const score = (quality: number, objective: number, extra: Partial<AnimIterationScore> = {}): AnimIterationScore => ({ quality, critic: quality, objective, parts: { checks: objective, intent: 10, priors: 10, smooth: 10 }, failures: 0, criticWeight: 0.5, accepted: true, ...extra })

// ------------------------------------------------------------------ intent

test('intent: skill words imply the limb, the references pick the side, a sided word wins', () => {
  const { clips, tags } = elastico()
  // No references: "elastico" means a leg, side unknown.
  assert.deepEqual(motionIntent('elastico', [], []), { parts: [{ part: 'leg', source: 'elastico' }] })
  // The first skill word decides between a leg and an arm.
  assert.equal(motionIntent('jab cross combo').parts[0].part, 'arm')
  assert.equal(motionIntent('cross into the box').parts[0].part, 'leg')

  // Right-footed references: the right leg leads, with thresholds from their swing.
  const right = motionIntent('elastico', tags, clips)
  assert.equal(right.lead?.limb, 'RightLeg')
  assert.equal(right.lead?.source, 'references')
  assert.ok(right.lead!.refDeg! > 40, JSON.stringify(right.lead))
  assert.equal(right.lead!.minDeg, Math.round(right.lead!.refDeg! * 0.5))
  assert.ok(right.lead!.warnDeg > right.lead!.minDeg)
  assert.deepEqual(right.parts.map((p) => p.part), ['RightLeg'], 'the lead replaces the unsided "leg"')
  assert.match(intentText(right), /right leg leads this move.*Never shrink/s)

  // Mirrored (left-footed) references flip the side; a sided word beats the references.
  assert.equal(motionIntent('elastico', tags, clips.map(mirrorClip)).lead?.limb, 'LeftLeg')
  const sided = motionIntent('elastico with the left foot', tags, clips)
  assert.equal(sided.lead?.limb, 'LeftLeg')
  assert.equal(sided.lead?.source, 'left foot')

  // Split references (no 60% majority) decide nothing.
  const split = motionIntent('elastico', tags, [clips[0], mirrorClip(clips[1])])
  assert.equal(split.lead, undefined)

  // Both legs moving about the same: no dominant side.
  assert.equal(dominantLimb({ ...limbRanges(clips[0]), RightLeg: 40, LeftLeg: 38 }, 'leg'), null)
  assert.equal(dominantLimb({ ...limbRanges(clips[0]), RightLeg: 40, LeftLeg: 20 }, 'leg'), 'RightLeg')
})

test('intent: the checks fail a clip whose lead limb is timid or out-moved by the other side', () => {
  const { clips, intent, profile } = elastico()
  const good = runChecks(clips[0], profile, { intent })
  const lead = good.motion!.find((m) => m.lead)!
  assert.equal(lead.ok, true, JSON.stringify(lead))
  const timid = runChecks(scaleJoints(clips[0], LEG, 0.25), profile, { intent })
  const weak = timid.motion!.find((m) => m.lead)!
  assert.equal(weak.ok, false, JSON.stringify(weak))
  // The wrong leg does the move: the right leg is out-moved by the left.
  const wrong = runChecks(mirrorClip(clips[0]), profile, { intent })
  const out = wrong.motion!.find((m) => m.lead)!
  assert.equal(out.ok, false)
  assert.ok(out.outmovedBy?.hard, JSON.stringify(out))
})

// ------------------------------------------------------------------ priors

test('priors: learned per move type, lead-normalised, satisfied by the references, flag a timid lead', () => {
  const { clips, profile, intent } = elastico()
  const p = profile!.priors!
  assert.ok(p, 'buildProfile learns priors')
  assert.equal(p.samples, 3)
  assert.equal(p.lead?.kind, 'leg')
  assert.equal(p.lead?.right, 1)
  assert.ok(p.lead!.range.median > 40)
  assert.ok(p.envelope.RightHip, 'the lead leg has an envelope')
  // Left-led clips are mirrored before learning, so the priors match.
  const mixed = buildPriors([clips[0], mirrorClip(clips[1]), clips[2]], 'leg')!
  assert.ok(Math.abs(mixed.lead!.range.median - p.lead!.range.median) < 3, `${mixed.lead!.range.median} vs ${p.lead!.range.median}`)

  const ref = priorChecks(clips[0], profile, intent)
  assert.ok(ref.length >= 5)
  assert.ok(ref.every((c) => c.ok), ref.filter((c) => !c.ok).map((c) => c.message).join('; '))
  assert.equal(priorScore(ref), 10)

  const timid = scaleJoints(clips[0], LEG, 0.35)
  const pc = priorChecks(timid, profile, intent)
  const swing = pc.find((c) => c.id === 'lead-swing')!
  assert.equal(swing.ok, false)
  assert.equal(swing.fix?.kind, 'offset')
  assert.match(swing.fix!.why ?? '', /\[prior:lead-swing\]/)
  assert.ok(priorScore(pc) < 9)
  // The fix moves the leg back toward the references.
  const fixed = guardedApply(timid, [swing.fix!], { intent, profile })
  assert.equal(fixed.applied.length, 1)
  assert.ok(limbRanges(fixed.clip).RightLeg > limbRanges(timid).RightLeg + 5)
  // No priors (generic profile): neutral score, no checks.
  assert.equal(priorScore([]), 7)
  assert.deepEqual(priorChecks(clips[0], null, intent), [])
})

test('priors: learned limits widen the joint limits to what the references do (mirrored for the left side)', () => {
  const priors: MotionPriors = { samples: 3, contact: { p10: 0, median: 0, p90: 0 }, envelope: { RightHip: [[-80, 150], [-10, 10], [-60, 90]] }, smooth: { p10: 0, median: 0, p90: 0 } }
  const base = JOINT_LIMITS
  const right = learnedLimits(priors, base, 'right')
  assert.deepEqual(right.RightHip![0], [Math.min(base.RightHip![0][0], -90), Math.max(base.RightHip![0][1], 160)])
  assert.ok(right.RightHip![2][1] >= 100)
  assert.deepEqual(right.LeftHip, base.LeftHip, 'the other leg keeps its limits')
  const left = learnedLimits(priors, base, 'left')
  assert.deepEqual(left.RightHip, base.RightHip)
  assert.ok(left.LeftHip![2][0] <= -100, JSON.stringify(left.LeftHip))
  assert.equal(learnedLimits(null, base), base)
})

// ------------------------------------------------------------------ guarded edits

test('guard: refuses edits that shrink the lead limb, caps untargeted offsets, one retime per round', () => {
  const { clips, ctx } = elastico()
  const clip = clips[0]
  const j = 'RightHip'
  const at = peakOf(clip, j)
  const e = eulerDegOf(sampleTrack(clip.tracks[j], at)!.q)
  const tuck: AnimChange = { kind: 'offset', joint: j, at, rot: e.map((v) => -0.6 * v) as [number, number, number], why: '[must-fix] tuck the leg in' }
  const r = guardedApply(clip, [tuck], ctx)
  assert.equal(r.applied.length, 0)
  assert.match(r.rejected[0].reason, /right leg/, r.rejected[0].reason)
  // An untargeted offset on a joint nobody flagged is capped to 15 degrees.
  const lean: AnimChange = { kind: 'offset', joint: 'Waist', at: 0.3, rot: [-40, 0, 0], why: 'lean more' }
  const capped = guardedApply(clip, [lean], ctx)
  assert.equal(capped.applied.length, 1)
  const applied = capped.applied[0] as AnimChange & { kind: 'offset' }
  assert.ok(Math.hypot(...applied.rot) <= 15.01, JSON.stringify(applied.rot))
  // Retimes: clamped and only one per round.
  const two = guardedApply(clip, [
    { kind: 'retime', from: 0, to: 0.3, scale: 2.5 },
    { kind: 'retime', from: 0.3, to: 0.6, scale: 1.1 }
  ], ctx)
  assert.equal(two.applied.length, 1)
  assert.equal((two.applied[0] as AnimChange & { kind: 'retime' }).scale, 1.7)
  assert.match(two.rejected[0].reason, /one retime/)
  // Damping shrinks offsets and retimes toward no change.
  assert.deepEqual(dampChanges([{ kind: 'offset', joint: j, at: 0.2, rot: [20, 0, -10] }, { kind: 'retime', from: 0, to: 1, scale: 1.4 }], 0.5), [{ kind: 'offset', joint: j, at: 0.2, rot: [10, 0, -5] }, { kind: 'retime', from: 0, to: 1, scale: 1.2 }])
})

// ------------------------------------------------------------------ ranking

test('ranking: judgeRound keeps rounds close to the best, rejects regressions, promotes real gains', () => {
  const best = score(7, 8, { lead: 60 })
  assert.deepEqual(judgeRound(best, score(7.5, 8.1, { lead: 60 })), { accepted: true, promote: true })
  // Close behind: kept as a step, not the best.
  assert.deepEqual(judgeRound(best, score(6.8, 7.9, { lead: 60 })), { accepted: true, promote: false })
  // The critic loves it but the code metrics dropped: not kept.
  const fooled = judgeRound(best, score(9, 6.5, { lead: 60 }))
  assert.equal(fooled.accepted, false)
  assert.match(fooled.reason!, /code metrics dropped/)
  // The lead limb lost a big part of its swing.
  const eroded = judgeRound(best, score(8, 8.2, { lead: 40 }))
  assert.equal(eroded.accepted, false)
  assert.match(eroded.reason!, /lead limb/)
  // More failed requirements always lose; fewer always win.
  assert.equal(judgeRound(best, score(9.5, 9.5, { failures: 1 })).accepted, false)
  assert.deepEqual(judgeRound(score(8, 8, { failures: 1 }), score(5, 5)), { accepted: true, promote: true })
  // Against the anchors (the best code score and the widest lead swing so far) instead of the best's own.
  assert.equal(judgeRound(best, score(7.2, 8.2), 9).accepted, false)
  assert.equal(judgeRound(best, score(7.2, 8.2, { lead: 55 }), 8, 70).accepted, false)
  // A lead that overshoots the references may be trimmed toward them.
  assert.equal(judgeRound(score(7, 8, { lead: 120 }), score(7.2, 8.1, { lead: 75, leadRef: 70 })).accepted, true)
  // Pulling the lead in on the critic's word alone does not take over as the best.
  assert.deepEqual(judgeRound(best, score(7.6, 8.05, { lead: 54 })), { accepted: true, promote: false })
  assert.deepEqual(judgeRound(best, score(7.6, 8.5, { lead: 54 })), { accepted: true, promote: true })

  // bestIteration skips rounds that were not kept and ranks old rounds by the critic.
  const its = [{ n: 1, score: score(7, 8) }, { n: 2, score: score(9, 5, { accepted: false }) }, { n: 3, score: score(7.4, 8) }]
  assert.equal(bestIteration(its)!.n, 3)
  const old = [{ n: 1, critique: { overall: 6 } as AnimCritique }, { n: 2, critique: { overall: 8 } as AnimCritique }]
  assert.equal(bestIteration(old)!.n, 2)

  // The objective score rewards the lead limb doing the move.
  const { clips, ctx } = elastico()
  const good = objectiveScore(clips[0], ctx)
  const timid = objectiveScore(scaleJoints(clips[0], LEG, 0.3), ctx)
  assert.ok(good.objective > timid.objective + 1, `${good.objective} vs ${timid.objective}`)
  assert.ok(good.lead! > timid.lead!)
})

// ------------------------------------------------------------------ the loop

const critique = (clip: AnimClip, overall: number, changes: AnimChange[], ctx: QualityContext): AnimCritique => ({ scores: { silhouette: overall, timing: overall, weight: overall, arcs: overall, appeal: overall, cleanliness: overall }, overall, summary: '', changes, checks: runChecks(clip, ctx.profile ?? null, { intent: ctx.intent ?? null }), references: [] })

test('loop: a critic that keeps raising its score while the leg shrinks cannot replace round 1', async () => {
  const { clips, ctx } = elastico()
  const start = clips[0]
  const seen: number[] = []
  const r = await animRefineLoop(
    start,
    {
      render: async () => ({ frames: [], times: [] }),
      critique: async (clip, _f, _t, n) => {
        seen.push(Math.round(limbRanges(clip).RightLeg))
        // Each round "tucks" the leg 40% further in and the critic scores it higher.
        const j = 'RightHip'
        const at = peakOf(clip, j)
        const e = eulerDegOf(sampleTrack(clip.tracks[j], at)!.q)
        return critique(clip, Math.min(9.8, 6 + n), [{ kind: 'offset', joint: j, at, rot: e.map((v) => -0.4 * v) as [number, number, number] }, { kind: 'offset', joint: 'RightKnee', at, rot: [30, 0, 0] }], ctx)
      },
      score: (clip, c) => iterationScore(c, clip, ctx),
      // Unguarded edits: the ranking alone has to hold the line.
      apply: undefined
    },
    { maxIterations: 6, threshold: 9.9 }
  )
  assert.equal(r.best.n, 1, `best #${r.best.n}; leg swing per round ${seen.join(', ')}`)
  assert.ok(r.iterations.slice(1).some((it) => !it.score.accepted), 'later rounds are marked not kept')
  assert.ok(r.iterations.find((it) => !it.score.accepted)!.score.regressed)
  // The swing can never erode round by round: every kept round keeps most of round 1's swing.
  for (const it of r.iterations.filter((x) => x.score.accepted)) assert.ok(it.score.lead! >= r.iterations[0].score.lead! * 0.85, `#${it.n}: ${it.score.lead}`)
  assert.ok(['regressed', 'no-changes', 'max-iterations'].includes(r.stop), r.stop)
})

test('loop: after a regressed round the next one restarts from the best; repeated regressions stop it', async () => {
  const { clips, ctx } = elastico()
  const starts: AnimClip[] = []
  // Scores: round 1 fine, every later round worse on the code side (the critic still claims more).
  let n0 = 0
  const r = await animRefineLoop(
    clips[0],
    {
      render: async () => ({ frames: [], times: [] }),
      critique: async (clip, _f, _t, n) => {
        starts.push(clip)
        n0 = n
        return critique(clip, 7 + n * 0.1, [{ kind: 'offset', joint: 'Waist', at: 0.2 + n * 0.05, rot: [5, 0, 0] }], ctx)
      },
      score: (_clip, c) => (n0 === 1 ? score(7, 8.5) : score(c.overall, 6))
    },
    { maxIterations: 8, threshold: 9.9 }
  )
  assert.equal(r.best.n, 1)
  assert.equal(r.stop, 'regressed')
  assert.equal(r.iterations.length, 1 + MAX_BACKTRACK)
  // Every retry builds on round 1's clip (damped round-1 changes), never on a rejected one.
  for (const c of starts.slice(1)) assert.deepEqual(c.tracks.RightHip, clips[0].tracks.RightHip)
  assert.notDeepEqual(starts[1].tracks.Waist, starts[2].tracks.Waist, 'each backtrack tries a different (smaller) edit')
})

test('loop: rounds that improve are continued from and the best is the last good one', async () => {
  const { clips, ctx } = elastico()
  const timid = scaleJoints(clips[0], LEG, 0.5)
  const r = await animRefineLoop(
    timid,
    {
      render: async () => ({ frames: [], times: [] }),
      critique: async (clip) => {
        const pc = priorChecks(clip, ctx.profile, ctx.intent)
        const obj = objectiveScore(clip, ctx).objective
        return critique(clip, Math.min(9.5, obj), pc.filter((p) => !p.ok && p.fix).map((p) => p.fix!), ctx)
      },
      score: (clip, c) => iterationScore(c, clip, ctx),
      apply: (clip, changes) => guardedApply(clip, changes, ctx)
    },
    { maxIterations: 4, threshold: 9.9 }
  )
  assert.ok(r.best.n > 1, `best #${r.best.n}`)
  assert.ok(limbRanges(r.best.clip).RightLeg > limbRanges(timid).RightLeg + 5)
  assert.ok(r.best.score.objective >= r.iterations[0].score.objective)
})

// ------------------------------------------------------------------ digest

test('digest: compact key poses of a real clip with its beats and the lead limb', () => {
  const { clips } = elastico()
  const d = keyframeDigest(clips[0], { name: 'Elastico', tags: ['dribble'] })
  const lines = d.split('\n')
  assert.match(lines[0], /^"Elastico" \(R15, [\d.]+ s; dribble; the right leg leads, \d+° of swing\): anticipation/)
  assert.ok(lines.length >= 3 && lines.length <= 7, d)
  assert.ok(lines.slice(1).every((l) => /^ {2}t=\d+\.\d\d /.test(l)), d)
  assert.ok(lines.some((l) => /RightHip\(-?\d+,-?\d+,-?\d+\)/.test(l)), d)
})

// ------------------------------------------------------------------ service

test('service: "Use #n" takes a round and teaches the critic weight; ratings calibrate it too', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'anim-quality-'))
  try {
    let t = 1000
    const svc = new AnimService({ userDir: dir, projectRoot: () => null, lune: async () => ({ error: 'no lune' }), runtimeDir: () => null, now: () => ++t })
    assert.equal(await svc.criticWeight(), 0.5)
    const { clips } = elastico()
    const e = await svc.saveClip({ ...clips[0], name: 'Elastico' }, { prompt: 'elastico', tags: ['dribble'] })
    assert.equal(e.kind, 'generated')
    const hit = (await svc.find(e.id))!
    const timid = scaleJoints(clips[0], LEG, 0.4)
    // Round 2 is the ranking's pick (critic and code agree on it); round 3 the critic liked most.
    const iterations = [
      { n: 1, at: 1, clip: timid, frames: [], times: [], score: score(6, 6) },
      { n: 2, at: 2, clip: clips[0], frames: [], times: [], score: score(8, 8.5) },
      { n: 3, at: 3, clip: clips[1], frames: [], times: [], score: score(7.95, 7, { critic: 9 }) }
    ]
    await hit.store.save({ ...hit.entry, iterations })
    await assert.rejects(() => svc.useIteration(e.id, 9), /no iteration #9/)

    // Choosing the critic's favourite over the ranked best: the critic gains weight.
    const used = await svc.useIteration(e.id, 3)
    assert.deepEqual(used.clip.tracks, clips[1].tracks)
    assert.equal(await svc.criticWeight(), 0.55)
    // Choosing a round that is worse on both counts teaches nothing.
    await svc.useIteration(e.id, 1)
    assert.equal(await svc.criticWeight(), 0.55)
    const file = JSON.parse(await readFile(join(dir, 'calibration.json'), 'utf8'))
    assert.equal(file.events.length, 1)
    assert.equal(file.events[0].kind, 'keep')

    // A down rating of a clip the critic passed but the code failed: the code side gains weight.
    const h2 = (await svc.find(e.id))!
    await h2.store.save({ ...h2.entry, clip: clips[2], iterations: [...iterations, { n: 4, at: 4, clip: clips[2], frames: [], times: [], score: score(7, 5, { critic: 8.5 }) }] })
    await svc.rate(e.id, 'down')
    assert.equal(await svc.criticWeight(), 0.51)

    // The context the service judges by: the intent comes from the library's real clips.
    for (const [i, c] of clips.entries()) {
      const s = await svc.saveClip({ ...c, name: `Ref${i}` }, { prompt: `Elastico ${i}`, tags: ['dribble'] })
      await (await svc.find(s.id))!.store.save({ ...s, kind: 'imported' })
    }
    await svc.setMoveSet('football')
    const qc = await svc.qualityContext({ request: 'elastico', tags: ['dribble'], rig: 'R15' })
    assert.equal(qc.intent?.lead?.limb, 'RightLeg')
    assert.equal(qc.refs.length, 3)
    assert.equal(qc.criticWeight, 0.51)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ------------------------------------------------------------------ offline eval

test('eval: the current pipeline beats the old one against a score-inflating critic and holds with an honest one', async () => {
  const report = await runAnimEval()
  const biased = report.rows.filter((r) => r.critic === 'biased')
  const helpful = report.rows.filter((r) => r.critic === 'helpful')
  const bb = summarize(biased, 'before')
  const ba = summarize(biased, 'after')
  assert.equal(ba.lead, ba.total, 'the lead limb does the move in every final clip')
  assert.ok(ba.lead >= bb.lead)
  assert.equal(ba.kept, ba.total, 'no final clip is worse than round 1')
  assert.ok(ba.objective > bb.objective, `objective ${bb.objective} -> ${ba.objective}`)
  assert.ok(ba.priors > bb.priors, `priors ${bb.priors} -> ${ba.priors}`)
  assert.ok(ba.swing >= bb.swing)
  const hb = summarize(helpful, 'before')
  const ha = summarize(helpful, 'after')
  assert.equal(ha.kept, ha.total)
  assert.equal(ha.lead, ha.total)
  assert.ok(ha.objective >= hb.objective - 0.15, `objective ${hb.objective} -> ${ha.objective}`)
  // The lead limb is inferred from the prompt and the library for every case.
  for (const i of report.intent) assert.equal(i.after, i.expected, `${i.id}: ${i.after}`)
})
