// Code checks for the measurable animation principles, on the clip itself (no model): arcs (path
// curvature of the hands, feet and head), slow in / slow out (speed at the key poses against the
// speed between them), follow-through (overshoot, settle and staggered stops), anticipation length
// against the action, timing variety (uneven key spacing, holds), squash and stretch through pose
// compression and extension, readability and exaggeration (silhouette spread), solid posing (the
// automatic checks), responsiveness (startup), weight and impact (a quick stop and a hold at the hit)
// and loopability. Reuses measure.ts / checks.ts; R6 clips are read through their R15 view.

import type { AnimCheckReport, AnimClip, R15Joint } from '../anim/model.ts'
import { R15_JOINTS } from '../anim/model.ts'
import { qangle, xpoint, type V3 } from '../anim/math.ts'
import { MEASURE_FPS, overshoot, phases, restSpreadValue, sampleFrames, speedCurve, spreadOf, type Frame } from '../anim/measure.ts'
import { keyTimes, sampleTrack } from '../anim/sample.ts'
import { r15View } from '../anim/convert.ts'
import type { R15Part } from '../anim/r15.ts'
import type { PrincipleCheck } from './types.ts'

const r1 = (x: number) => Math.round(x * 10) / 10
const s10 = (x: number) => r1(Math.max(0, Math.min(10, x)))
const f2 = (x: number) => x.toFixed(2)

const EFFECTORS: [R15Part, V3, string][] = [
  ['RightHand', [0, -0.2, 0], 'right hand'],
  ['LeftHand', [0, -0.2, 0], 'left hand'],
  ['RightFoot', [0, -0.1, -0.4], 'right foot'],
  ['LeftFoot', [0, -0.1, -0.4], 'left foot'],
  ['Head', [0, 0.4, 0], 'head']
]

export interface ArcStats {
  effector: string
  // Path length (studs) of the measured strokes.
  travel: number
  // Mean sagitta ratio: largest distance of the path from the straight chord / chord length
  // (0 = a straight line, 0.5 = a half circle).
  bow: number
  strokes: number
}

// Strokes: runs of frames where the effector moves (speed above 15% of its peak), split at the stops.
export function effectorArcs(clip: AnimClip, frames: Frame[] = sampleFrames(clip, MEASURE_FPS)): ArcStats[] {
  const out: ArcStats[] = []
  for (const [part, local, label] of EFFECTORS) {
    const pts = frames.map((f) => xpoint(f.parts[part], local))
    const speed = pts.map((p, i) => (i ? Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1], p[2] - pts[i - 1][2]) : 0))
    const peak = Math.max(...speed, 0)
    if (peak < 0.02) continue
    let travel = 0
    let bowSum = 0
    let bowW = 0
    let strokes = 0
    let start = -1
    const close = (end: number) => {
      if (start < 0 || end - start < 2) return
      const a = pts[start]
      const b = pts[end]
      let len = 0
      for (let i = start + 1; i <= end; i++) len += speed[i]
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1], b[2] - a[2])
      if (len < 0.6 || chord < 0.3 * len) return
      const d: V3 = [(b[0] - a[0]) / chord, (b[1] - a[1]) / chord, (b[2] - a[2]) / chord]
      let dev = 0
      for (let i = start; i <= end; i++) {
        const v: V3 = [pts[i][0] - a[0], pts[i][1] - a[1], pts[i][2] - a[2]]
        const along = v[0] * d[0] + v[1] * d[1] + v[2] * d[2]
        dev = Math.max(dev, Math.hypot(v[0] - d[0] * along, v[1] - d[1] * along, v[2] - d[2] * along))
      }
      travel += len
      bowSum += Math.min(0.5, dev / chord) * len
      bowW += len
      strokes++
    }
    for (let i = 1; i < pts.length; i++) {
      const moving = speed[i] > peak * 0.15
      if (moving && start < 0) start = i - 1
      if (!moving && start >= 0) {
        close(i - 1)
        start = -1
      }
    }
    close(pts.length - 1)
    if (strokes) out.push({ effector: label, travel: Math.round(travel * 100) / 100, bow: Math.round((bowSum / bowW) * 1000) / 1000, strokes })
  }
  return out.sort((a, b) => b.travel - a.travel)
}

export function arcsCheck(clip: AnimClip, frames?: Frame[]): PrincipleCheck | null {
  const arcs = effectorArcs(clip, frames).slice(0, 2)
  if (!arcs.length) return null
  const total = arcs.reduce((s, a) => s + a.travel, 0)
  const bow = arcs.reduce((s, a) => s + a.bow * a.travel, 0) / total
  const lead = arcs[0]
  const score = s10(3 + bow * 45)
  return {
    id: 'arcs',
    score,
    note: `${lead.effector} path bows ${Math.round(lead.bow * 100)}% off a straight line (arcs read from ~10%; weighted ${Math.round(bow * 100)}%)`,
    ...(score < 7 ? { fix: `swing the ${lead.effector} through a curve: rotate the shoulder / hip and turn the waist or Root a little instead of moving it straight between keys; add a key off the straight line mid-move` } : {})
  }
}

// Slow in / slow out: weighted joint speed in the frame before and after each interior key, against
// the peak speed in the segments around it. Eased keys come in and leave slowly (ratio near 0).
export function slowInOutCheck(clipIn: AnimClip): PrincipleCheck | null {
  const clip = r15View(clipIn)
  if (clip.source === 'bvh') return null
  const curve = speedCurve(clip)
  const keys = keyTimes(clip)
  const peakAll = Math.max(...curve.v, 0)
  if (peakAll < 1 || keys.length < 3) return null
  const dt = 1 / MEASURE_FPS
  const idx = (t: number) => Math.max(0, Math.min(curve.v.length - 1, Math.round(t / dt)))
  const ratios: number[] = []
  for (let k = 1; k < keys.length - 1; k++) {
    const i = idx(keys[k])
    const segPeak = Math.max(...curve.v.slice(idx(keys[k - 1]), idx(keys[k + 1]) + 1))
    if (segPeak < peakAll * 0.15) continue
    const atKey = Math.min(curve.v[Math.max(0, i - 1)], curve.v[i])
    ratios.push(Math.min(1, atKey / segPeak))
  }
  if (!ratios.length) return null
  const mean = ratios.reduce((s, x) => s + x, 0) / ratios.length
  const score = s10(10 - mean * 11)
  return {
    id: 'slow-in-out',
    score,
    note: `motion keeps ${Math.round(mean * 100)}% of its speed through the key poses (${ratios.length} keys; eased keys slow to near 0)`,
    ...(score < 7 ? { fix: 'ease into and out of the key poses (CubicV2 or Quad InOut) instead of Linear; keep Linear only for constant spins' } : {})
  }
}

// Per joint: the time it last moves faster than 10% of its own peak (when it settles).
function stopTimes(clip: AnimClip): { joint: R15Joint; stop: number; travel: number }[] {
  const out: { joint: R15Joint; stop: number; travel: number }[] = []
  const dt = 1 / MEASURE_FPS
  for (const j of R15_JOINTS) {
    const keys = clip.tracks[j]
    if (!keys || keys.length < 2) continue
    const v: number[] = []
    let travel = 0
    for (let t = 0; t + dt <= clip.duration + 1e-6; t += dt) {
      const a = sampleTrack(keys, t)!
      const b = sampleTrack(keys, Math.min(clip.duration, t + dt))!
      const w = qangle(a.q, b.q)
      v.push(w)
      travel += w
    }
    const peak = Math.max(...v, 0)
    if (peak < 1e-3) continue
    let last = 0
    v.forEach((x, i) => (x > peak * 0.1 ? (last = i) : null))
    out.push({ joint: j, stop: (last + 1) * dt, travel })
  }
  return out.sort((a, b) => b.travel - a.travel)
}

export function followThroughCheck(clipIn: AnimClip): PrincipleCheck | null {
  const clip = r15View(clipIn)
  const ph = phases(clip)
  if (ph.action <= 0) return null
  const os = overshoot(clip, ph)
  const stops = stopTimes(clip).slice(0, 4)
  const mean = stops.reduce((s, x) => s + x.stop, 0) / Math.max(1, stops.length)
  const spread = stops.length > 1 ? Math.sqrt(stops.reduce((s, x) => s + (x.stop - mean) ** 2, 0) / stops.length) : 0
  const score = s10(3.5 + Math.min(os, 0.2) * 25 + Math.min(1, spread / 0.04) * 1.5 + (ph.recovery > 0.1 ? 0.5 : 0))
  return {
    id: 'follow-through',
    score,
    note: `overshoot ${Math.round(os * 100)}% past the settle pose; the main joints stop ${spread < 0.02 ? 'together' : `${Math.round(spread * 1000)} ms apart`}; recovery ${f2(ph.recovery)} s`,
    ...(score < 7 ? { fix: 'let the leading limb overshoot its end pose 10-15 degrees and ease back; offset the elbow / wrist / neck stops by 2-4 frames (a:overlap)' } : {})
  }
}

// Anticipation against the action: a windup at least as long as the action (3-6x for a big move),
// but not so long it feels like lag.
export function anticipationCheck(clip: AnimClip): PrincipleCheck | null {
  const ph = phases(clip)
  if (ph.action <= 0 || clip.looped) return null
  const ant = ph.anticipation
  const ratio = ant / Math.max(0.02, ph.action)
  let score: number
  if (ant < 0.04) score = 2.5
  else if (ratio < 1) score = 4 + ratio * 3.5
  else if (ratio <= 6) score = 7.5 + Math.min(2.5, (ratio - 1) * 0.8)
  else score = 9 - Math.min(3, (ratio - 6) * 0.3)
  if (ant > 1.2) score -= Math.min(3, (ant - 1.2) * 3)
  score = s10(score)
  return {
    id: 'anticipation',
    score,
    note: `anticipation ${f2(ant)} s before a ${f2(ph.action)} s action (${ratio.toFixed(1)}x)`,
    ...(score < 7 ? { fix: ant < 0.1 ? 'add a windup in the opposite direction before the action (0.15-0.4 s): pull the arm back, turn the waist away, dip the Root' : ant > 1.2 ? 'shorten the windup; past ~1 s it reads as input lag' : 'make the windup longer than the strike (2-4x) so it telegraphs the move' } : {})
  }
}

// Timing variety: uneven key spacing and holds. Even spacing (every key 0.2 s apart) reads mechanical.
export function timingCheck(clipIn: AnimClip): PrincipleCheck | null {
  const clip = r15View(clipIn)
  const ph = phases(clip)
  const keys = keyTimes(clip)
  let cv: number
  let what: string
  if (clip.source === 'bvh' || keys.length > clip.duration * 20) {
    const v = speedCurve(clip).v.filter((x) => x > 1)
    if (v.length < 4) return null
    const m = v.reduce((s, x) => s + x, 0) / v.length
    cv = Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / v.length) / m
    what = 'speed varies'
  } else {
    if (keys.length < 4) return null
    const gaps = keys.slice(1).map((t, i) => t - keys[i])
    const m = gaps.reduce((s, x) => s + x, 0) / gaps.length
    cv = Math.sqrt(gaps.reduce((s, x) => s + (x - m) ** 2, 0) / gaps.length) / Math.max(1e-6, m)
    what = 'key spacing varies'
  }
  const score = s10(3 + Math.min(cv, 0.6) * 10 + (ph.holds > 0.04 ? 1 : 0))
  return {
    id: 'timing',
    score,
    note: `${what} ${Math.round(cv * 100)}% (even spacing = 0%); holds ${f2(ph.holds)} s`,
    ...(score < 7 ? { fix: 'vary the spacing: a fast strike (2-4 frames), a longer windup and recovery, and a 2-4 frame hold on the key pose' } : {})
  }
}

function spreads(frames: Frame[]): { min: number; max: number } {
  const rest = restSpreadValue()
  let min = Infinity
  let max = 0
  for (const f of frames) {
    const s = spreadOf(f.parts) / rest
    min = Math.min(min, s)
    max = Math.max(max, s)
  }
  return { min, max: Math.max(max, 1) }
}

// Squash and stretch on rigid parts: how far the body compresses (crouch, curl) and extends (reach)
// over the clip, plus the Root's height range.
export function squashStretchCheck(clipIn: AnimClip, frames: Frame[] = sampleFrames(clipIn, 15)): PrincipleCheck | null {
  const clip = r15View(clipIn)
  const sp = spreads(frames)
  const ys = frames.map((f) => f.parts.LowerTorso.p[1])
  const dip = Math.max(...ys) - Math.min(...ys)
  const range = sp.max / Math.max(0.3, Math.min(sp.min, 1))
  if (!Number.isFinite(range) || clip.duration <= 0) return null
  const score = s10(3 + (range - 1) * 9 + Math.min(dip, 1) * 3)
  return {
    id: 'squash-stretch',
    score,
    note: `body extent ranges ${range.toFixed(2)}x (compressed to extended); hips travel ${f2(dip)} studs vertically`,
    ...(score < 7 ? { fix: 'compress before the push (bend the knees, drop the Root 0.3-0.6 studs, curl the spine) and fully extend through the action' } : {})
  }
}

export function readabilityCheck(clip: AnimClip, checks?: AnimCheckReport | null, frames?: Frame[]): PrincipleCheck {
  const peak = checks?.spread ?? spreads(frames ?? sampleFrames(clip, 15)).max
  const score = s10(4 + (peak - 1) * 8)
  return {
    id: 'readability',
    score,
    note: `strongest pose spreads ${peak.toFixed(2)}x the standing silhouette`,
    ...(score < 7 ? { fix: 'push the key pose off the body: limbs away from the torso, a clear line of action visible from behind and above' } : {})
  }
}

// Exaggeration: silhouette spread plus the largest single joint swing.
export function exaggerationCheck(clipIn: AnimClip, checks?: AnimCheckReport | null, frames?: Frame[]): PrincipleCheck | null {
  const clip = r15View(clipIn)
  let swing = 0
  for (const j of R15_JOINTS) {
    const keys = clip.tracks[j]
    if (!keys || keys.length < 2 || j === 'Root') continue
    const a = sampleTrack(keys, 0)!
    for (let t = 0; t <= clip.duration + 1e-6; t += 1 / 15) swing = Math.max(swing, (qangle(a.q, sampleTrack(keys, t)!.q) * 180) / Math.PI)
  }
  const peak = checks?.spread ?? spreads(frames ?? sampleFrames(clip, 15)).max
  const score = s10(3 + (peak - 1) * 6 + (Math.min(swing, 150) / 150) * 3)
  return {
    id: 'exaggeration',
    score,
    note: `largest joint swing ${Math.round(swing)}°, peak spread ${peak.toFixed(2)}x`,
    ...(score < 7 ? { fix: 'push the extremes further than realistic: a deeper windup, a wider swing, a longer hold on the impact' } : {})
  }
}

export function solidPosingCheck(checks: AnimCheckReport): PrincipleCheck {
  const score = s10((checks.scores.sliding + checks.scores.limits + checks.scores.penetration) / 3)
  const bad = checks.issues.filter((i) => i.check === 'sliding' || i.check === 'limits' || i.check === 'penetration')
  return {
    id: 'solid-posing',
    score,
    note: bad.length ? bad.slice(0, 2).map((i) => i.message).join('; ') : 'no foot sliding, joints within limits, no limbs through the body',
    ...(bad.length ? { fix: 'apply the automatic fixes (limits, sliding, penetration) and keep the centre of mass over the feet' } : {})
  }
}

// Startup: time to the first motion and to the action (release).
export function responsivenessCheck(clip: AnimClip): PrincipleCheck | null {
  const ph = phases(clip)
  if (ph.action <= 0 || clip.looped) return null
  const score = s10(10 - Math.max(0, ph.motionStart - 0.07) * 20 - Math.max(0, ph.actionStart - 0.45) * 6)
  return {
    id: 'responsiveness',
    score,
    note: `first motion at ${f2(ph.motionStart)} s (${Math.round(ph.motionStart * 30)} frames), action at ${f2(ph.actionStart)} s`,
    ...(score < 7 ? { fix: 'start moving within 2 frames of the input and reach the release sooner; keep long windups for charged moves' } : {})
  }
}

// Weight and impact: after the fastest moment the motion stops quickly (the hit lands) and holds or
// recoils, rather than drifting through.
export function weightImpactCheck(clipIn: AnimClip): PrincipleCheck | null {
  const clip = r15View(clipIn)
  const curve = speedCurve(clip)
  const ph = phases(clip, curve)
  if (ph.action <= 0 || clip.looped) return null
  const peak = Math.max(...curve.v)
  const ip = curve.v.indexOf(peak)
  let i = ip
  while (i < curve.v.length - 1 && curve.v[i] > peak * 0.2) i++
  const stopIn = curve.t[i] - curve.t[ip]
  const os = overshoot(clip, ph)
  const quick = stopIn <= 0.12
  const score = s10(4 + (quick ? 2.5 : Math.max(0, 2.5 - (stopIn - 0.12) * 10)) + (Math.min(ph.holds, 0.15) / 0.15) * 2 + (os > 0.03 ? 1.5 : 0))
  return {
    id: 'weight-impact',
    score,
    note: `motion stops ${Math.round(stopIn * 1000)} ms after its peak; holds ${f2(ph.holds)} s; recoil ${Math.round(os * 100)}%`,
    ...(score < 7 ? { fix: 'land the hit: decelerate into the contact pose within 2-3 frames, hold it 2-4 frames (or a hit-stop), then recoil' } : {})
  }
}

// Looped clips: the end pose matches the start pose and the speed carries across the seam.
export function loopabilityCheck(clipIn: AnimClip): PrincipleCheck | null {
  if (!clipIn.looped) return null
  const clip = r15View(clipIn)
  let diff = 0
  for (const j of R15_JOINTS) {
    const keys = clip.tracks[j]
    if (!keys?.length) continue
    diff += (qangle(sampleTrack(keys, 0)!.q, sampleTrack(keys, clip.duration)!.q) * 180) / Math.PI
  }
  const v = speedCurve({ ...clip, looped: false }).v
  const peak = Math.max(...v, 1)
  const mismatch = v.length > 2 ? Math.abs(v[0] - v[v.length - 2]) / peak : 0
  const score = s10(10 - diff / 5 - mismatch * 6)
  return {
    id: 'loopability',
    score,
    note: `end pose is ${diff.toFixed(1)}° (summed) from the start; speed across the seam differs ${Math.round(mismatch * 100)}%`,
    ...(score < 7 ? { fix: 'make the last key equal the first and ease through the loop point (same easing on both sides of the seam)' } : {})
  }
}

// Every measurable animation principle, for a clip. `checks` (runChecks) is reused when given.
export function animPrincipleChecks(clip: AnimClip, checks?: AnimCheckReport | null): PrincipleCheck[] {
  const frames15 = sampleFrames(clip, 15)
  const out: (PrincipleCheck | null)[] = [
    arcsCheck(clip),
    slowInOutCheck(clip),
    followThroughCheck(clip),
    anticipationCheck(clip),
    timingCheck(clip),
    squashStretchCheck(clip, frames15),
    readabilityCheck(clip, checks, frames15),
    exaggerationCheck(clip, checks, frames15),
    checks ? solidPosingCheck(checks) : null,
    responsivenessCheck(clip),
    weightImpactCheck(clip),
    loopabilityCheck(clip)
  ]
  return out.filter((c): c is PrincipleCheck => !!c)
}
