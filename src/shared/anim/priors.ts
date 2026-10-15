// Learned motion priors per move type: what the user's real clips of a move have in common, measured
// (no model) and checked against every generated clip with a concrete fix where one exists. Kept on the
// style profile (style.ts) and refreshed by Learn / import / rating:
//   contact     where the action peaks, as a share of the clip
//   lead        which limb does the move, how far it swings and how much the other side moves
//   envelope    the range each joint's angles stay in (p5..p95 per axis); also widens the joint limits
//   smooth      how smooth the motion is (jitter of the speed curve)
// Clips are lead-normalized: one that does the move with its left side is mirrored first, so the
// priors describe a right-led move; a left-led request is mirrored before it is compared.
// The critic cites a violated prior by id ([prior:lead-swing]); the numbers-only critic applies the fix.

import type { AnimChange, AnimClip, AnimKey, AnimStyleProfile, Pct, R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { eulerDegOf, qangle, qconj, qmul, qnorm, xfToCf, type Quat, type Xf } from './math.ts'
import { phases, speedCurve } from './measure.ts'
import { keyXf, sampleTrack } from './sample.ts'
import { r15View } from './convert.ts'
import type { LimitTable } from './checks.ts'
import { dominantLimb, LIMB_LABEL, limbOf, limbRanges, otherSide, type Limb, type LimbKind, type MotionIntent } from './intent.ts'
import { PART_JOINTS } from './bodyparts.ts'

type Range = [number, number]

export interface MotionPriors {
  samples: number
  contact: Pct
  lead?: { kind: LimbKind; right: number; range: Pct; support: Pct }
  envelope: Partial<Record<R15Joint, [Range, Range, Range]>>
  smooth: Pct
}

// ------------------------------------------------------------------ measures

// Jitter of the motion: summed second difference of the weighted speed curve over the summed speed
// (60 fps). Eased keyframed motion is low; pops, stutters and noisy keys raise it.
export function jitter(clip: AnimClip): number {
  const { v } = speedCurve(clip, 60)
  let num = 0
  let den = 0
  for (let i = 1; i < v.length - 1; i++) {
    num += Math.abs(v[i + 1] - 2 * v[i] + v[i - 1])
    den += v[i]
  }
  return den > 1e-6 ? Math.round((num / den) * 1000) / 1000 : 0
}

// 0..10: 10 at or below the references' typical jitter (or 0.12 without references).
export function smoothScore(clip: AnimClip, prior?: Pct | null): number {
  const j = jitter(clip)
  const ok = Math.max(0.08, prior && prior.p90 > 0 ? prior.p90 * 1.2 : 0.12)
  return Math.round(Math.max(0, Math.min(10, 10 - Math.max(0, j - ok) * 15)) * 10) / 10
}

// ------------------------------------------------------------------ lead-normalizing (mirror)

const MIRROR_JOINT = (j: R15Joint): R15Joint => (j.startsWith('Left') ? (j.replace(/^Left/, 'Right') as R15Joint) : j.startsWith('Right') ? (j.replace(/^Right/, 'Left') as R15Joint) : j)
const mirrorXf = (x: Xf): Xf => ({ p: [-x.p[0], x.p[1], x.p[2]], q: [x.q[0], -x.q[1], -x.q[2], x.q[3]] })

// The clip with left and right swapped (R15 view; R6 clips come back as their R15 view).
export function mirrorClip(clip: AnimClip): AnimClip {
  const v = r15View(clip)
  const tracks: AnimClip['tracks'] = {}
  for (const [j, keys] of Object.entries(v.tracks) as [R15Joint, AnimKey[]][]) tracks[MIRROR_JOINT(j)] = keys.map((k) => ({ ...k, cf: xfToCf(mirrorXf(keyXf(k))) }))
  return { ...v, tracks }
}

// The limb kind a set of clips leads with (the kind whose dominant side is clearest in most clips).
function leadKind(ranges: ReturnType<typeof limbRanges>[]): LimbKind | null {
  const score = (k: LimbKind) => ranges.filter((r) => dominantLimb(r, k)).length + ranges.reduce((s, r) => s + Math.max(r[limbOf(k, 'right')], r[limbOf(k, 'left')]), 0) / 1000
  const leg = score('leg')
  const arm = score('arm')
  if (Math.max(leg, arm) < 1) return null
  return leg >= arm ? 'leg' : 'arm'
}

// ------------------------------------------------------------------ build

const pctOf = (values: number[]): Pct => {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b)
  if (!v.length) return { p10: 0, median: 0, p90: 0 }
  const at = (q: number) => {
    const i = (v.length - 1) * q
    const lo = Math.floor(i)
    const hi = Math.ceil(i)
    return Math.round((v[lo] + (v[hi] - v[lo]) * (i - lo)) * 1000) / 1000
  }
  return { p10: at(0.1), median: at(0.5), p90: at(0.9) }
}

const ENVELOPE_FPS = 15

export function buildPriors(clips: AnimClip[], kind?: LimbKind | null): MotionPriors | null {
  if (!clips.length) return null
  const ranges = clips.map(limbRanges)
  const k = kind ?? leadKind(ranges)
  // Lead-normalize: clips led by the left side are mirrored.
  let right = 0
  let led = 0
  const norm = clips.map((c, i) => {
    const d = k ? dominantLimb(ranges[i], k) : null
    if (d) led++
    if (d && d.startsWith('Right')) right++
    return d && d.startsWith('Left') ? mirrorClip(c) : r15View(c)
  })
  const nr = norm.map(limbRanges)
  const contact = pctOf(norm.map((c) => {
    const ph = phases(c)
    return c.duration > 0 ? ph.peakTime / c.duration : 0
  }))
  const env: MotionPriors['envelope'] = {}
  for (const j of R15_JOINTS) {
    const axes: number[][] = [[], [], []]
    for (const c of norm) {
      const keys = c.tracks[j]
      if (!keys?.length) continue
      const n = Math.max(1, Math.round(c.duration * ENVELOPE_FPS))
      for (let i = 0; i <= n; i++) {
        const x = sampleTrack(keys, (c.duration * i) / n)
        if (!x) continue
        const e = eulerDegOf(x.q)
        for (let a = 0; a < 3; a++) axes[a].push(e[a])
      }
    }
    if (!axes[0].length) continue
    const band = (vals: number[]): Range => {
      const s = [...vals].sort((a, b) => a - b)
      const q = (p: number) => s[Math.min(s.length - 1, Math.max(0, Math.round((s.length - 1) * p)))]
      return [Math.round(q(0.05)), Math.round(q(0.95))]
    }
    env[j] = [band(axes[0]), band(axes[1]), band(axes[2])]
  }
  return {
    samples: clips.length,
    contact,
    ...(k && led ? { lead: { kind: k, right: Math.round((right / led) * 100) / 100, range: pctOf(nr.map((r) => r[limbOf(k, 'right')])), support: pctOf(nr.map((r) => r[limbOf(k, 'left')])) } } : {}),
    envelope: env,
    smooth: pctOf(norm.map(jitter))
  }
}

// Joint limits widened to what the user's clips actually do (an elastico's hip rotation, a keeper's
// stretch): each axis grows to the references' envelope plus 10°.
export function learnedLimits(priors: MotionPriors | null | undefined, base: LimitTable, side: 'right' | 'left' = 'right'): LimitTable {
  if (!priors) return base
  const out = { ...base }
  for (const [j0, env] of Object.entries(priors.envelope) as [R15Joint, [Range, Range, Range]][]) {
    const j = side === 'left' ? MIRROR_JOINT(j0) : j0
    const lim = out[j]
    if (!lim) continue
    // Mirroring flips the sign of the Y and Z angles.
    const e = side === 'left' ? env.map((r, a) => (a === 0 ? r : ([-r[1], -r[0]] as Range))) : env
    out[j] = lim.map((r, a) => [Math.min(r[0], e[a][0] - 10), Math.max(r[1], e[a][1] + 10)]) as [Range, Range, Range]
  }
  return out
}

// ------------------------------------------------------------------ checks

export interface PriorCheck {
  id: 'anticipation' | 'recovery' | 'contact' | 'lead-swing' | 'support' | 'envelope' | 'smooth'
  ok: boolean
  measured: string
  expected: string
  message: string
  // A concrete edit that moves the clip toward the prior (the numbers-only critic applies it).
  fix?: AnimChange
  joint?: string
  at?: number
}

const f2 = (v: number) => v.toFixed(2)

// The rotation delta that scales a joint's offset from rest at time t by k (as a local offset change).
export function amplifyAt(clip: AnimClip, joint: R15Joint, at: number, k: number): [number, number, number] | null {
  const x = sampleTrack(clip.tracks[joint], at)
  if (!x) return null
  let q = qnorm(x.q)
  if (q[3] < 0) q = [-q[0], -q[1], -q[2], -q[3]]
  const angle = 2 * Math.acos(Math.min(1, q[3]))
  if (angle < 0.02) return null
  const sh = Math.sin(angle / 2)
  const axis: [number, number, number] = [q[0] / sh, q[1] / sh, q[2] / sh]
  const a2 = Math.min(Math.PI * 0.9, angle * k)
  const target: Quat = [axis[0] * Math.sin(a2 / 2), axis[1] * Math.sin(a2 / 2), axis[2] * Math.sin(a2 / 2), Math.cos(a2 / 2)]
  const d = eulerDegOf(qmul(qconj(q), target))
  return [Math.round(d[0]), Math.round(d[1]), Math.round(d[2])]
}

// Time when a joint is furthest from its rest pose.
export function peakOf(clip: AnimClip, joint: R15Joint): number {
  const keys = clip.tracks[joint]
  if (!keys?.length) return 0
  let best = 0
  let at = 0
  for (let i = 0; i <= 60; i++) {
    const t = (clip.duration * i) / 60
    const x = sampleTrack(keys, t)
    if (!x) continue
    const a = qangle(x.q, [0, 0, 0, 1])
    if (a > best) {
      best = a
      at = t
    }
  }
  return Math.round(at * 100) / 100
}

// The clip's lead side for the priors: the intent's lead, else its own dominant side.
function clipSide(clip: AnimClip, priors: MotionPriors, intent?: MotionIntent | null): 'right' | 'left' {
  if (intent?.lead) return intent.lead.limb.startsWith('Left') ? 'left' : 'right'
  if (!priors.lead) return 'right'
  const d = dominantLimb(limbRanges(clip), priors.lead.kind)
  return d?.startsWith('Left') ? 'left' : 'right'
}

const mirrorChange = (c: AnimChange): AnimChange => (c.kind === 'offset' ? { ...c, joint: MIRROR_JOINT(c.joint), rot: [c.rot[0], -c.rot[1], -c.rot[2]] } : c)

// Every prior the profile has, measured on the clip (ok or violated, with a fix where one exists).
export function priorChecks(clipIn: AnimClip, profile: AnimStyleProfile | null | undefined, intent?: MotionIntent | null): PriorCheck[] {
  const priors = profile?.priors
  if (!profile || profile.samples < 1) return []
  const out: PriorCheck[] = []
  const view = r15View(clipIn)
  const ph = phases(view)
  // Timing (seconds) from the profile.
  const timing = (id: 'anticipation' | 'recovery', v: number, p: Pct, from: number, to: number) => {
    if (!(p.p90 > 0.03)) return
    const lo = p.p10 * 0.8
    const hi = p.p90 * 1.25
    const ok = v >= lo && v <= hi
    const scale = v > 0.02 ? Math.max(0.5, Math.min(2.2, p.median / v)) : 1
    out.push({
      id,
      ok,
      measured: `${f2(v)} s`,
      expected: `${f2(p.p10)}-${f2(p.p90)} s`,
      message: ok ? `${id} ${f2(v)} s fits the references` : `${id} ${f2(v)} s; the ${profile.tag} references use ${f2(p.p10)}-${f2(p.p90)} s (median ${f2(p.median)})`,
      ...(!ok && to > from + 0.02 && Math.abs(scale - 1) > 0.08 ? { fix: { kind: 'retime', from: Math.round(from * 1000) / 1000, to: Math.round(to * 1000) / 1000, scale: Math.round(scale * 100) / 100, why: `[prior:${id}] toward the ${profile.tag} references (${f2(p.median)} s)` } as AnimChange } : {})
    })
  }
  timing('anticipation', ph.anticipation, profile.timing.anticipation, ph.motionStart, ph.actionStart)
  timing('recovery', ph.recovery, profile.timing.recovery, ph.actionEnd, ph.motionEnd)
  if (!priors) return out
  // Contact (peak) placement.
  if (priors.contact.p90 > 0 && view.duration > 0) {
    const share = ph.peakTime / view.duration
    const ok = share >= priors.contact.p10 - 0.08 && share <= priors.contact.p90 + 0.08
    out.push({ id: 'contact', ok, measured: `${Math.round(share * 100)}%`, expected: `${Math.round(priors.contact.p10 * 100)}-${Math.round(priors.contact.p90 * 100)}%`, message: ok ? 'the action peaks where the references do' : `the action peaks at ${Math.round(share * 100)}% of the clip; the references peak at ${Math.round(priors.contact.p10 * 100)}-${Math.round(priors.contact.p90 * 100)}%`, at: ph.peakTime })
  }
  const side = clipSide(view, priors, intent)
  const norm = side === 'left' ? mirrorClip(view) : view
  const fixSide = (c: AnimChange) => (side === 'left' ? mirrorChange(c) : c)
  if (priors.lead) {
    const k = priors.lead.kind
    const ranges = limbRanges(norm)
    const lead = limbOf(k, 'right')
    const v = ranges[lead]
    const p = priors.lead.range
    const lo = p.p10 * 0.6
    const hi = Math.max(p.p90 * 1.6, p.p90 + 25)
    const ok = v >= lo && v <= hi
    const label = LIMB_LABEL[side === 'left' ? otherSide(lead) : lead]
    let fix: AnimChange | undefined
    if (!ok) {
      // Scale the lead's widest joint at its peak toward the references' median swing.
      const joint = (PART_JOINTS[lead] as R15Joint[]).reduce((a, b) => (rangeOf(norm, b) > rangeOf(norm, a) ? b : a))
      const at = peakOf(norm, joint)
      const k2 = Math.max(0.5, Math.min(2.5, p.median / Math.max(1, v)))
      const rot = amplifyAt(norm, joint, at, k2)
      if (rot && Math.hypot(...rot) > 3) fix = fixSide({ kind: 'offset', joint, at, rot: rot.map((x) => Math.max(-45, Math.min(45, x))) as [number, number, number], why: `[prior:lead-swing] the ${label} swings ${Math.round(v)}°; the references swing it ${Math.round(p.median)}°` })
    }
    out.push({ id: 'lead-swing', ok, measured: `${Math.round(v)}°`, expected: `${Math.round(p.p10)}-${Math.round(p.p90)}°`, message: ok ? `the ${label} swings like the references` : `the ${label} swings ${Math.round(v)}°; the references swing it ${Math.round(p.p10)}-${Math.round(p.p90)}° (median ${Math.round(p.median)}°)`, ...(fix ? { fix } : {}), joint: (side === 'left' ? otherSide(lead) : lead) })
    const s = ranges[limbOf(k, 'left')]
    const sHi = Math.max(priors.lead.support.p90 * 1.6, priors.lead.support.p90 + 20)
    if (priors.lead.support.p90 > 0) {
      const sOk = s <= sHi || s <= v
      const sLabel = LIMB_LABEL[side === 'left' ? lead : otherSide(lead)]
      out.push({ id: 'support', ok: sOk, measured: `${Math.round(s)}°`, expected: `up to ${Math.round(priors.lead.support.p90)}°`, message: sOk ? `the ${sLabel} supports like the references` : `the ${sLabel} (support) swings ${Math.round(s)}°, more than the references (up to ${Math.round(priors.lead.support.p90)}°); keep it planted and let the ${label} work` })
    }
  }
  // Envelope: joints far outside what the references ever do.
  const worst: { joint: R15Joint; axis: number; by: number; v: number; env: Range; at: number }[] = []
  for (const [j, env] of Object.entries(priors.envelope) as [R15Joint, [Range, Range, Range]][]) {
    const keys = norm.tracks[j]
    if (!keys?.length) continue
    let w: (typeof worst)[number] | null = null
    for (let i = 0; i <= 30; i++) {
      const t = (norm.duration * i) / 30
      const x = sampleTrack(keys, t)
      if (!x) continue
      const e = eulerDegOf(x.q)
      for (let a = 0; a < 3; a++) {
        const [lo, hi] = env[a]
        const by = e[a] < lo ? lo - e[a] : e[a] > hi ? e[a] - hi : 0
        if (by > 25 && (!w || by > w.by)) w = { joint: j, axis: a, by, v: e[a], env: env[a], at: t }
      }
    }
    if (w) worst.push(w)
  }
  worst.sort((a, b) => b.by - a.by)
  const env = worst.slice(0, 2).map((w) => `${side === 'left' ? MIRROR_JOINT(w.joint) : w.joint} ${'XYZ'[w.axis]} ${Math.round(w.v)}° (references ${w.env[0]}..${w.env[1]}°) at ${f2(w.at)} s`)
  out.push({ id: 'envelope', ok: !worst.length, measured: worst.length ? `${worst.length} joint${worst.length === 1 ? '' : 's'} outside` : 'inside', expected: 'joint angles inside the references', message: worst.length ? `outside what the references do: ${env.join('; ')}` : 'every joint stays inside the references\' range', ...(worst[0] ? { joint: side === 'left' ? MIRROR_JOINT(worst[0].joint) : worst[0].joint, at: Math.round(worst[0].at * 100) / 100 } : {}) })
  // Smoothness.
  if (priors.smooth.p90 > 0) {
    const j = jitter(view)
    const hi = Math.max(0.1, priors.smooth.p90 * 1.5)
    out.push({ id: 'smooth', ok: j <= hi, measured: j.toFixed(2), expected: `<= ${hi.toFixed(2)}`, message: j <= hi ? 'as smooth as the references' : `the motion pops or stutters (jitter ${j.toFixed(2)}, references up to ${priors.smooth.p90.toFixed(2)}); ease into and out of the key poses` })
  }
  return out
}

const rangeCache = new WeakMap<AnimClip, Map<R15Joint, number>>()
function rangeOf(clip: AnimClip, j: R15Joint): number {
  let m = rangeCache.get(clip)
  if (!m) rangeCache.set(clip, (m = new Map()))
  let v = m.get(j)
  if (v === undefined) {
    const keys = clip.tracks[j]
    v = 0
    if (keys?.length) {
      const qs: Quat[] = []
      for (let i = 0; i <= 24; i++) {
        const x = sampleTrack(keys, (clip.duration * i) / 24)
        if (x) qs.push(x.q)
      }
      for (let a = 0; a < qs.length; a++) for (let b = a + 1; b < qs.length; b++) v = Math.max(v, qangle(qs[a], qs[b]))
    }
    m.set(j, v)
  }
  return v
}

// 0..10: the share of priors the clip satisfies (7 when the profile has none).
export function priorScore(checks: PriorCheck[]): number {
  if (!checks.length) return 7
  // The lead's swing counts double; the envelope and smoothness are soft (smoothness has its own score).
  const w = (c: PriorCheck) => (c.id === 'lead-swing' ? 2 : c.id === 'envelope' ? 0.5 : c.id === 'smooth' ? 0.25 : 1)
  const total = checks.reduce((s, c) => s + w(c), 0)
  const ok = checks.reduce((s, c) => s + (c.ok ? w(c) : 0), 0)
  return Math.round((ok / total) * 100) / 10
}

// The priors as prompt lines (compose and critic).
export function priorsText(checks: PriorCheck[], tag: string): string {
  if (!checks.length) return ''
  return [`Learned motion priors for "${tag}" (measured on this clip vs the user's references; cite a violated one in a change's why as [prior:<id>]):`, ...checks.map((c) => `- prior:${c.id} ${c.ok ? 'ok' : 'VIOLATED'}: ${c.message}${c.fix && !c.ok ? ` (suggested fix: ${JSON.stringify(c.fix)})` : ''}`)].join('\n')
}

// The priors of a profile as plain guidance (compose, before a clip exists).
export function priorsGuide(profile: AnimStyleProfile | null | undefined): string {
  const p = profile?.priors
  if (!p) return ''
  const lines = [`Motion priors from ${p.samples} of the user's "${profile!.tag}" clips:`]
  lines.push(`- the action peaks at ${Math.round(p.contact.p10 * 100)}-${Math.round(p.contact.p90 * 100)}% of the clip`)
  if (p.lead) {
    const side = p.lead.right >= 0.5 ? 'right' : 'left'
    lines.push(`- the ${p.lead.kind === 'leg' ? `${side} leg` : `${side} arm`} leads (${Math.round(Math.max(p.lead.right, 1 - p.lead.right) * 100)}% of the clips), swinging ${Math.round(p.lead.range.p10)}-${Math.round(p.lead.range.p90)}°; the other ${p.lead.kind} supports (up to ${Math.round(p.lead.support.p90)}°)`)
  }
  const env = Object.entries(p.envelope)
    .map(([j, e]) => ({ j, e: e!, span: Math.max(...e!.map((r) => r[1] - r[0])) }))
    .filter((x) => x.span >= 25)
    .sort((a, b) => b.span - a.span)
    .slice(0, 6)
  if (env.length) lines.push(`- main joint ranges (degrees, X/Y/Z for a:joint): ${env.map((x) => `${x.j} ${x.e.map((r) => `${r[0]}..${r[1]}`).join('/')}`).join('; ')}`)
  return lines.join('\n')
}

export { MIRROR_JOINT, mirrorChange }
export type { Limb }
