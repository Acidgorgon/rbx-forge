// Automatic checks on a clip (no model): feet sliding while planted, joints past sensible limits,
// limbs passing through the torso or each other (capsule approximation), pose readability
// (silhouette spread) and timing against the learned style profile. Each gives a 0..10 score and
// issues with times; fixes for limits live in patch.ts.

import type { AnimCheckIssue, AnimCheckReport, AnimClip, AnimStyleProfile, R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { DEG, eulerDegOf, qeulerDeg, vdot, vsub, xpoint, type V3, type Xf } from './math.ts'
import { measureClip, restSpreadValue, sampleFrames, spreadOf } from './measure.ts'
import { jointWorld, PARTS, type R15Part } from './r15.ts'
import { clipRig, sampleR6, sampleTrack } from './sample.ts'
import { r15View } from './convert.ts'
import { r6ForwardKinematics, r6LimbEnd, r6LowestFoot, r6Wording } from './r6.ts'
import { measureParts, partMustFix } from './bodyparts.ts'
import { motionIntent, type MotionIntent } from './intent.ts'
import { learnedLimits, priorChecks } from './priors.ts'
import { phases } from './measure.ts'

// ------------------------------------------------------------------ joint limits

type Range = [number, number]
export const JOINT_LIMITS: Record<R15Joint, [Range, Range, Range] | null> = {
  Root: [[-95, 95], [-180, 180], [-60, 60]],
  Waist: [[-55, 45], [-65, 65], [-35, 35]],
  Neck: [[-60, 60], [-80, 80], [-35, 35]],
  RightShoulder: [[-85, 190], [-110, 110], [-60, 185]],
  LeftShoulder: [[-85, 190], [-110, 110], [-185, 60]],
  RightElbow: [[-8, 160], [-95, 95], [-20, 20]],
  LeftElbow: [[-8, 160], [-95, 95], [-20, 20]],
  RightWrist: [[-90, 90], [-95, 95], [-50, 50]],
  LeftWrist: [[-90, 90], [-95, 95], [-50, 50]],
  RightHip: [[-50, 135], [-55, 55], [-35, 80]],
  LeftHip: [[-50, 135], [-55, 55], [-80, 35]],
  RightKnee: [[-165, 8], [-25, 25], [-12, 12]],
  LeftKnee: [[-165, 8], [-25, 25], [-12, 12]],
  RightAnkle: [[-55, 45], [-35, 35], [-30, 30]],
  LeftAnkle: [[-55, 45], [-35, 35], [-30, 30]]
}

// R6 (read through the R15 view): the Torso is one part, so RootJoint carries the waist's lean and
// turn too, and a hip measured from that Torso has the waist's range on top of its own.
export const JOINT_LIMITS_R6: Record<R15Joint, [Range, Range, Range] | null> = {
  ...JOINT_LIMITS,
  Root: [[-150, 140], [-180, 180], [-95, 95]],
  RightHip: [[-105, 180], [-90, 90], [-70, 115]],
  LeftHip: [[-105, 180], [-90, 90], [-115, 70]]
}

export type LimitTable = Record<R15Joint, [Range, Range, Range] | null>

// Degrees past the limit (0 = inside) for one joint rotation.
export function limitExcess(j: R15Joint, euler: V3, table: LimitTable = JOINT_LIMITS): { excess: number; axis: number } {
  const lim = table[j]
  if (!lim) return { excess: 0, axis: -1 }
  let worst = 0
  let axis = -1
  for (let a = 0; a < 3; a++) {
    const [lo, hi] = lim[a]
    const e = euler[a] < lo ? lo - euler[a] : euler[a] > hi ? euler[a] - hi : 0
    if (e > worst) {
      worst = e
      axis = a
    }
  }
  return { excess: worst, axis }
}

export function clampToLimits(j: R15Joint, euler: V3, table: LimitTable = JOINT_LIMITS): V3 {
  const lim = table[j]
  if (!lim) return euler
  return [0, 1, 2].map((a) => Math.max(lim[a][0], Math.min(lim[a][1], euler[a]))) as V3
}

export { qeulerDeg }

// ------------------------------------------------------------------ capsules

interface Capsule {
  part: R15Part
  a: V3
  b: V3
  r: number
}

function limbCapsule(parts: Record<R15Part, Xf>, part: R15Part, r: number): Capsule {
  const h = PARTS[part].size[1]
  const half = Math.max(0, h / 2 - r * 0.6)
  return { part, a: xpoint(parts[part], [0, -half, 0]), b: xpoint(parts[part], [0, half, 0]), r }
}

function capsules(parts: Record<R15Part, Xf>): Capsule[] {
  const out: Capsule[] = []
  for (const x of [-0.5, 0.5]) out.push({ part: 'UpperTorso', a: xpoint(parts.UpperTorso, [x, -0.3, 0]), b: xpoint(parts.UpperTorso, [x, 0.3, 0]), r: 0.46 })
  out.push({ part: 'LowerTorso', a: xpoint(parts.LowerTorso, [-0.5, 0, 0]), b: xpoint(parts.LowerTorso, [0.5, 0, 0]), r: 0.3 })
  out.push({ part: 'Head', a: xpoint(parts.Head, [0, -0.05, 0]), b: xpoint(parts.Head, [0, 0.05, 0]), r: 0.55 })
  for (const p of ['LeftLowerArm', 'RightLowerArm', 'LeftHand', 'RightHand', 'LeftUpperLeg', 'RightUpperLeg', 'LeftLowerLeg', 'RightLowerLeg', 'LeftFoot', 'RightFoot'] as R15Part[]) out.push(limbCapsule(parts, p, p.endsWith('Hand') ? 0.3 : 0.36))
  return out
}

function segDist(p1: V3, q1: V3, p2: V3, q2: V3): number {
  const d1 = vsub(q1, p1)
  const d2 = vsub(q2, p2)
  const r = vsub(p1, p2)
  const a = vdot(d1, d1)
  const e = vdot(d2, d2)
  const f = vdot(d2, r)
  let s: number
  let t: number
  if (a <= 1e-9 && e <= 1e-9) return Math.hypot(...r)
  if (a <= 1e-9) {
    s = 0
    t = Math.max(0, Math.min(1, f / e))
  } else {
    const c = vdot(d1, r)
    if (e <= 1e-9) {
      t = 0
      s = Math.max(0, Math.min(1, -c / a))
    } else {
      const b = vdot(d1, d2)
      const denom = a * e - b * b
      s = denom > 1e-9 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0
      t = (b * s + f) / e
      if (t < 0) {
        t = 0
        s = Math.max(0, Math.min(1, -c / a))
      } else if (t > 1) {
        t = 1
        s = Math.max(0, Math.min(1, (b - c) / a))
      }
    }
  }
  const c1: V3 = [p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s]
  const c2: V3 = [p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t]
  return Math.hypot(c1[0] - c2[0], c1[1] - c2[1], c1[2] - c2[2])
}

const PAIRS: [string, string][] = [
  ['LeftLowerArm', 'UpperTorso'],
  ['RightLowerArm', 'UpperTorso'],
  ['LeftHand', 'UpperTorso'],
  ['RightHand', 'UpperTorso'],
  ['LeftHand', 'Head'],
  ['RightHand', 'Head'],
  ['LeftLowerArm', 'Head'],
  ['RightLowerArm', 'Head'],
  ['LeftHand', 'LowerTorso'],
  ['RightHand', 'LowerTorso'],
  ['LeftLowerLeg', 'RightLowerLeg'],
  ['LeftFoot', 'RightFoot'],
  ['LeftUpperLeg', 'RightUpperLeg'],
  ['LeftFoot', 'RightLowerLeg'],
  ['RightFoot', 'LeftLowerLeg']
]

// Deepest overlap (studs) between non-adjacent body capsules in one pose, and which pair.
export function penetration(parts: Record<R15Part, Xf>): { depth: number; pair: string | null } {
  const caps = capsules(parts)
  let depth = 0
  let pair: string | null = null
  for (const [pa, pb] of PAIRS) {
    for (const ca of caps.filter((c) => c.part === pa)) {
      for (const cb of caps.filter((c) => c.part === pb)) {
        const d = ca.r + cb.r - segDist(ca.a, ca.b, cb.a, cb.b)
        if (d > depth) {
          depth = d
          pair = `${pa} / ${pb}`
        }
      }
    }
  }
  return { depth, pair }
}

// ------------------------------------------------------------------ run

const FOOT_PLANTED_Y = 0.12

function footSole(parts: Record<R15Part, Xf>, part: 'LeftFoot' | 'RightFoot'): { y: number; at: V3 } {
  const s = PARTS[part].size
  let y = Infinity
  for (const x of [-s[0] / 2, s[0] / 2]) for (const z of [-s[2] / 2, s[2] / 2]) y = Math.min(y, xpoint(parts[part], [x, -s[1] / 2, z])[1])
  return { y, at: xpoint(parts[part], [0, -s[1] / 2, 0]) }
}

const score = (v: number) => Math.round(Math.max(0, Math.min(10, v)) * 10) / 10

// R6 clips are checked on their R15 view (straight limbs on the R6 joints; no elbow / knee limits to
// break) and the issues are worded with R6 names (Right Shoulder, Left Leg, Torso...).
// opts.request / opts.tags: the request and move-type tags; the body parts they name must move
// (bodyparts.ts). A named part that barely moves is an error issue ("motion") and costs the overall
// score 2 points per part. opts.intent (intent.ts, with the lead limb from the references) replaces
// what the words alone give. With a lead leg, its foot may travel along the floor during the action
// (it works the ball: an elastico, a drag-back) without counting as sliding. The profile's learned
// priors (priors.ts) widen the joint limits to what the user's clips do and are measured into
// report.priors (violations are "prior" issues; they do not change the overall).
export function runChecks(clip: AnimClip, profile?: AnimStyleProfile | null, opts: { request?: string; tags?: string[]; intent?: MotionIntent | null } = {}): AnimCheckReport {
  const intent = opts.intent ?? (opts.request || opts.tags?.length ? motionIntent(opts.request ?? '', opts.tags ?? []) : null)
  const lead = intent?.lead
  const side = lead?.limb.startsWith('Left') ? 'left' : 'right'
  const priors = profile?.priors
  let exempt: SlideExempt | undefined
  const parts = intent?.parts ?? []
  const motion = parts.length ? measureParts(clip, parts, lead) : []
  // Only a lead leg that does the move may work the ball along the floor.
  if (lead && lead.limb.endsWith('Leg') && motion.find((m) => m.lead)?.rangeDeg! >= lead.minDeg) {
    const ph = phases(clip)
    if (ph.actionEnd > ph.actionStart) exempt = { foot: lead.limb === 'LeftLeg' ? 'LeftFoot' : 'RightFoot', from: Math.max(0, ph.actionStart - 0.15), to: ph.actionEnd + 0.15 }
  }
  const base = runChecksRig(clip, profile, { exempt, ...(priors ? { learned: (t: LimitTable) => learnedLimits(priors, t, side) } : {}) })
  const pc = profile ? priorChecks(clip, profile, intent) : []
  if (!parts.length && !pc.length) return base
  const issues = [...base.issues]
  for (const c of pc) if (!c.ok) issues.push({ check: 'prior', severity: c.id === 'lead-swing' ? 'warn' : 'info', message: `prior:${c.id}: ${c.message}`, ...(c.joint ? { joint: c.joint } : {}), ...(c.at !== undefined ? { at: c.at } : {}) })
  if (!parts.length) return { ...base, issues, priors: pc }
  let missing = 0
  for (const m of motion) {
    if (!m.ok) {
      missing++
      issues.unshift({ check: 'motion', severity: 'error', message: `Must fix: ${partMustFix(m)}`, ...(m.joint ? { joint: m.joint } : {}) })
    } else if (m.rangeDeg < m.warnDeg) issues.push({ check: 'motion', severity: 'warn', message: `the ${m.label} ("${m.source.replace(/^tag:/, '')}") moves only ${m.rangeDeg.toFixed(0)}°; push its key poses further`, ...(m.joint ? { joint: m.joint } : {}) })
    else if (m.outmovedBy) issues.push({ check: 'motion', severity: 'warn', message: `the ${m.outmovedBy.label} moves more than the ${m.label} (${m.outmovedBy.rangeDeg.toFixed(0)}° vs ${m.rangeDeg.toFixed(0)}°); the ${m.label} should lead`, ...(m.joint ? { joint: m.joint } : {}) })
  }
  return { ...base, issues, motion, ...(pc.length ? { priors: pc } : {}), overall: Math.max(0, Math.round((base.overall - missing * 2) * 10) / 10) }
}

// A foot that may travel along the floor in a time window (the lead foot working the ball).
interface SlideExempt {
  foot: 'LeftFoot' | 'RightFoot'
  from: number
  to: number
}

interface RigOpts {
  exempt?: SlideExempt
  // The limit table widened by the learned priors (given the rig's base table).
  learned?: (base: LimitTable) => LimitTable
}

function runChecksRig(clip: AnimClip, profile?: AnimStyleProfile | null, o: RigOpts = {}): AnimCheckReport {
  if (clipRig(clip) === 'R6') {
    const r = runChecksR15(r15View(clip), profile, o.learned ? o.learned(JOINT_LIMITS_R6) : JOINT_LIMITS_R6)
    // Sliding is measured on the real R6 legs (their hip pivots sit at the Torso's outer edge, unlike
    // R15's), the rest on the R15 view.
    const slide = r6Sliding(clip)
    const issues = [...r.issues.filter((i) => i.check !== 'sliding').map((i) => ({ ...i, message: r6Wording(i.message), ...(i.joint ? { joint: r6Wording(i.joint) } : {}) })), ...slide.issues]
    const scores = { ...r.scores, sliding: score(10 - slide.total * 14) }
    return { ...r, scores, overall: overallOf(scores), issues, slideStuds: Math.round(slide.total * 1000) / 1000 }
  }
  return runChecksR15(clip, profile, o.learned ? o.learned(JOINT_LIMITS) : JOINT_LIMITS, o.exempt)
}

const overallOf = (scores: AnimCheckReport['scores']) => Math.round(((scores.sliding + scores.limits + scores.penetration) * 0.2 + scores.readability * 0.22 + scores.timing * 0.18) * 10) / 10

const R6_SWING = 3

function r6Sliding(clip: AnimClip): { total: number; issues: AnimCheckIssue[] } {
  const issues: AnimCheckIssue[] = []
  const fps = 30
  const n = Math.max(1, Math.round(clip.duration * fps))
  const frames = Array.from({ length: n + 1 }, (_, i) => {
    const t = Math.min(clip.duration, i / fps)
    return { t, parts: r6ForwardKinematics(sampleR6({ ...clip, looped: false }, t)) }
  })
  let total = 0
  for (const leg of ['Left Leg', 'Right Leg'] as const) {
    let window: { from: number; dist: number } | null = null
    const close = (to?: number) => {
      if (window && window.dist > 0.08) issues.push({ check: 'sliding', severity: window.dist > 0.3 ? 'error' : 'warn', message: `${leg} slides ${window.dist.toFixed(2)} studs while planted (${window.from.toFixed(2)}${to !== undefined ? `-${to.toFixed(2)}` : '+'} s); keep the root still while both feet are down, or lift the leg`, joint: leg, at: window.from })
      window = null
    }
    for (let i = 1; i < frames.length; i++) {
      const a = frames[i - 1].parts
      const b = frames[i].parts
      const planted = r6LowestFoot(a, [leg]) < FOOT_PLANTED_Y && r6LowestFoot(b, [leg]) < FOOT_PLANTED_Y
      const pa = r6LimbEnd(a, leg)
      const pb = r6LimbEnd(b, leg)
      const d = Math.hypot(pb[0] - pa[0], pb[2] - pa[2])
      // A straight R6 leg brushes the floor as it swings through a step; a sole moving faster than
      // R6_SWING studs per second is swinging, not sliding.
      if (planted && d > 0.01 && d * fps < R6_SWING) {
        total += d
        window ??= { from: frames[i - 1].t, dist: 0 }
        window.dist += d
      } else close(frames[i].t)
    }
    close()
  }
  return { total, issues }
}

function runChecksR15(clip: AnimClip, profile?: AnimStyleProfile | null, limits: LimitTable = JOINT_LIMITS, exempt?: SlideExempt): AnimCheckReport {
  const frames = sampleFrames(clip, 30)
  const issues: AnimCheckIssue[] = []
  // Sliding: a foot on the floor in two frames in a row should not move sideways.
  let slide = 0
  let worked = 0
  for (const foot of ['LeftFoot', 'RightFoot'] as const) {
    let window: { from: number; dist: number } | null = null
    for (let i = 1; i < frames.length; i++) {
      const a = footSole(frames[i - 1].parts, foot)
      const b = footSole(frames[i].parts, foot)
      // A foot standing on the floor: its sole touches and its ankle is near standing height (a foot
      // tipping onto its toes to step off is lifting, not sliding).
      const ankle = foot === 'LeftFoot' ? 'LeftAnkle' : 'RightAnkle'
      const low = (parts: (typeof frames)[number]['parts']) => jointWorld(parts, ankle)[1] < 0.42
      const planted = a.y < FOOT_PLANTED_Y && b.y < FOOT_PLANTED_Y && low(frames[i - 1].parts) && low(frames[i].parts)
      const d = Math.hypot(b.at[0] - a.at[0], b.at[2] - a.at[2])
      if (planted && d > 0.01 && exempt?.foot === foot && frames[i].t >= exempt.from && frames[i - 1].t <= exempt.to) {
        worked += d
        if (window) {
          if (window.dist > 0.08) issues.push({ check: 'sliding', severity: window.dist > 0.3 ? 'error' : 'warn', message: `${foot} slides ${window.dist.toFixed(2)} studs while planted (${window.from.toFixed(2)}-${frames[i].t.toFixed(2)} s); plant it (a:plant) or lift it`, joint: foot, at: window.from, to: frames[i].t })
          window = null
        }
      } else if (planted && d > 0.01) {
        slide += d
        window ??= { from: frames[i - 1].t, dist: 0 }
        window.dist += d
      } else if (window) {
        if (window.dist > 0.08) issues.push({ check: 'sliding', severity: window.dist > 0.3 ? 'error' : 'warn', message: `${foot} slides ${window.dist.toFixed(2)} studs while planted (${window.from.toFixed(2)}-${frames[i].t.toFixed(2)} s); plant it (a:plant) or lift it`, joint: foot, at: window.from, to: frames[i].t })
        window = null
      }
    }
    if (window && window.dist > 0.08) issues.push({ check: 'sliding', severity: window.dist > 0.3 ? 'error' : 'warn', message: `${foot} slides ${window.dist.toFixed(2)} studs while planted (from ${window.from.toFixed(2)} s)`, joint: foot, at: window.from, to: clip.duration })
  }
  // Limits: every key and the frames between them.
  let worstLimit = 0
  const limitHits = new Map<R15Joint, { excess: number; at: number; axis: number }>()
  for (const j of R15_JOINTS) {
    const keys = clip.tracks[j]
    if (!keys?.length) continue
    for (let t = 0; t <= clip.duration + 1e-6; t += 1 / 30) {
      const x = sampleTrack(keys, t)!
      const ex = limitExcess(j, eulerDegOf(x.q), limits)
      if (ex.excess > (limitHits.get(j)?.excess ?? 0)) limitHits.set(j, { excess: ex.excess, at: t, axis: ex.axis })
    }
  }
  for (const [j, h] of limitHits) {
    worstLimit = Math.max(worstLimit, h.excess)
    if (h.excess > 4) issues.push({ check: 'limits', severity: h.excess > 25 ? 'error' : 'warn', message: `${j} goes ${h.excess.toFixed(0)}° past a natural ${'XYZ'[h.axis]} range at ${h.at.toFixed(2)} s`, joint: j, at: h.at })
  }
  // Interpenetration.
  let deepest = 0
  let deepestAt = 0
  let deepestPair: string | null = null
  for (const f of frames) {
    const p = penetration(f.parts)
    if (p.depth > deepest) {
      deepest = p.depth
      deepestAt = f.t
      deepestPair = p.pair
    }
  }
  if (worked > 0.08) issues.push({ check: 'sliding', severity: 'info', message: `${exempt!.foot} travels ${worked.toFixed(2)} studs along the floor during the action (the lead foot working the ball; not counted as sliding)`, joint: exempt!.foot, at: exempt!.from })
  if (deepest > 0.12) issues.push({ check: 'penetration', severity: deepest > 0.35 ? 'error' : 'warn', message: `${deepestPair} overlap by ${deepest.toFixed(2)} studs at ${deepestAt.toFixed(2)} s`, at: deepestAt })
  // Readability: the strongest pose should open the silhouette well past standing.
  const rest = restSpreadValue()
  let peak = 1
  let peakAt = 0
  for (const f of frames) {
    const s = spreadOf(f.parts) / rest
    if (s > peak) {
      peak = s
      peakAt = f.t
    }
  }
  if (peak < 1.3) issues.push({ check: 'readability', severity: 'warn', message: `the key poses stay close to standing (spread ${peak.toFixed(2)}x rest); push the extremes so the silhouette reads`, at: peakAt })
  // Timing against the profile.
  let timingScore = 7
  const stats = measureClip(clip)
  if (profile && profile.samples > 0) {
    let misses = 0
    let checks = 0
    const cmp = (label: string, v: number, p: { p10: number; p90: number; median: number }) => {
      if (!(p.p90 > 0)) return
      checks++
      const lo = p.p10 * 0.8
      const hi = p.p90 * 1.25
      if (v < lo || v > hi) {
        misses++
        issues.push({ check: 'timing', severity: 'info', message: `${label} ${v.toFixed(2)} s; the ${profile.tag} references use ${p.p10.toFixed(2)}-${p.p90.toFixed(2)} s (median ${p.median.toFixed(2)})` })
      }
    }
    cmp('anticipation', stats.anticipation, profile.timing.anticipation)
    cmp('action', stats.action, profile.timing.action)
    cmp('recovery', stats.recovery, profile.timing.recovery)
    cmp('duration', stats.duration, profile.timing.duration)
    timingScore = checks ? 10 - (misses / checks) * 6 : 7
  } else if (stats.anticipation < 0.04 && stats.action > 0) {
    timingScore = 6
    issues.push({ check: 'timing', severity: 'info', message: 'no anticipation before the main action; add a windup or a hold before it' })
  }
  const scores = {
    sliding: score(10 - slide * 14),
    limits: score(10 - worstLimit / 5),
    penetration: score(10 - Math.max(0, deepest - 0.05) * 18),
    readability: score(4 + (peak - 1) * 8),
    timing: score(timingScore)
  }
  const overall = Math.round(((scores.sliding + scores.limits + scores.penetration) * 0.2 + scores.readability * 0.22 + scores.timing * 0.18) * 10) / 10
  return { scores, overall, issues, slideStuds: Math.round(slide * 1000) / 1000, worstLimitDeg: Math.round(worstLimit * 10) / 10, penetrationStuds: Math.round(deepest * 1000) / 1000, spread: Math.round(peak * 1000) / 1000 }
}

export { DEG }
