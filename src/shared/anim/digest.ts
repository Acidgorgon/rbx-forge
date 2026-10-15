// Compact keyframe digests of real clips for the compose prompt: the beats, where the action peaks,
// which limb leads and how far, and the key poses (joint-local degrees in a:joint order, the root
// offset in studs) of the joints that move most. The writer starts from the nearest real clip's timing
// and poses instead of drafting from nothing. Pure code.

import type { AnimClip, R15Joint } from './model.ts'
import { R15_JOINTS } from './model.ts'
import { eulerDegOf } from './math.ts'
import { phases, speedCurve } from './measure.ts'
import { sampleTrack } from './sample.ts'
import { r15View } from './convert.ts'
import { jointRange } from './bodyparts.ts'
import { dominantLimb, LIMB_LABEL, limbRanges } from './intent.ts'

const f2 = (v: number) => v.toFixed(2)
const deg = (v: number) => Math.round(v)

// Times worth a pose line: start, the quiet moments (where a pose is hit), the action's start and
// peak, and the end; at most `max`, at least 0.06 s apart.
export function digestTimes(clip: AnimClip, max = 6): number[] {
  const { t, v } = speedCurve(clip, 30)
  const peak = Math.max(...v, 1)
  const ph = phases(clip)
  const want = new Set<number>([0, ph.actionStart, ph.peakTime, ph.actionEnd, clip.duration])
  for (let i = 1; i < v.length - 1; i++) if (v[i] <= v[i - 1] && v[i] <= v[i + 1] && v[i] < peak * 0.35) want.add(t[i])
  const sorted = [...want].map((x) => Math.round(x * 100) / 100).sort((a, b) => a - b)
  const out: number[] = []
  for (const x of sorted) if (!out.length || x - out[out.length - 1] >= 0.06) out.push(x)
  if (out.length <= max) return out
  // Keep the start, the peak and the end; fill with the rest evenly.
  const keep = new Set([out[0], Math.round(ph.peakTime * 100) / 100, out[out.length - 1]])
  const rest = out.filter((x) => !keep.has(x))
  const step = rest.length / Math.max(1, max - keep.size)
  for (let i = 0; keep.size < max && i < rest.length; i += Math.max(1, step)) keep.add(rest[Math.floor(i)])
  return [...keep].sort((a, b) => a - b)
}

// The joints that move most (by rotation range), Root always included when it moves.
function activeJoints(clip: AnimClip, n = 6): R15Joint[] {
  return R15_JOINTS.filter((j) => j !== 'Root')
    .map((j) => ({ j, r: jointRange(clip, j, 24) }))
    .filter((x) => x.r >= 8)
    .sort((a, b) => b.r - a.r)
    .slice(0, n)
    .map((x) => x.j)
}

export function keyframeDigest(clipIn: AnimClip, opts: { name?: string; tags?: string[]; maxTimes?: number; joints?: number } = {}): string {
  const clip = r15View(clipIn)
  const ph = phases(clip)
  const ranges = limbRanges(clip)
  const leadLeg = dominantLimb(ranges, 'leg')
  const leadArm = dominantLimb(ranges, 'arm')
  const lead = leadLeg && (!leadArm || ranges[leadLeg] >= ranges[leadArm]) ? leadLeg : leadArm
  const joints = activeJoints(clip, opts.joints ?? 6)
  const head = `"${opts.name ?? clipIn.name}" (${clipIn.rig ?? 'R15'}, ${f2(clip.duration)} s${clip.looped ? ', looped' : ''}${opts.tags?.length ? `; ${opts.tags.join(', ')}` : ''}${lead ? `; the ${LIMB_LABEL[lead]} leads, ${deg(ranges[lead])}° of swing` : ''}): anticipation ${f2(ph.motionStart)}-${f2(ph.actionStart)} s, action ${f2(ph.actionStart)}-${f2(ph.actionEnd)} s (peak ${f2(ph.peakTime)} s), recovery to ${f2(ph.motionEnd)} s${clip.markers.length ? `; markers ${clip.markers.map((m) => `${m.name} @ ${f2(m.t)}`).join(', ')}` : ''}.`
  const lines = [head]
  for (const t of digestTimes(clip, opts.maxTimes ?? 6)) {
    const parts: string[] = []
    for (const j of joints) {
      const x = sampleTrack(clip.tracks[j], t)
      if (!x) continue
      const e = eulerDegOf(x.q)
      if (Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) < 4) continue
      parts.push(`${j}(${deg(e[0])},${deg(e[1])},${deg(e[2])})`)
    }
    const root = sampleTrack(clip.tracks.Root, t)
    if (root) {
      const e = eulerDegOf(root.q)
      const moved = Math.hypot(...root.p) > 0.05 || Math.abs(e[0]) + Math.abs(e[1]) + Math.abs(e[2]) > 4
      if (moved) parts.push(`root(${root.p.map((v) => v.toFixed(2)).join(',')} / ${e.map(deg).join(',')})`)
    }
    lines.push(`  t=${f2(t)} ${parts.length ? parts.join(' ') : 'rest'}`)
  }
  return lines.join('\n')
}

export const DIGEST_NOTE = 'Key poses are joint-local degrees for a:joint(joint, Vector3.new(x, y, z)) (CFrame.Angles order); root is a:root(offset studs, degrees). Use them as the starting timing and poses, then adapt them to the request.'
