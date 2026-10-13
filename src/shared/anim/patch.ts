// Changes on top of a clip (from the critic or the automatic checks): joint offsets at a time,
// retiming a span, easing changes, and fixes (clamp joint limits, plant sliding feet, open up
// interpenetrating arms). Stored on the clip as patches and re-applied when its script runs again.

import type { AnimChange, AnimClip, AnimKey, R15Joint } from './model.ts'
import { POSE_EASING_DIRECTIONS, POSE_EASING_STYLES, R15_JOINTS } from './model.ts'
import { cfToXf, eulerDegOf, qeulerDeg, qmul, xfToCf } from './math.ts'
import { clampToLimits, JOINT_LIMITS_R6, penetration, runChecks } from './checks.ts'
import { plantPass, trackRecord, tracksOf } from './passes.ts'
import { forwardKinematics } from './r15.ts'
import { clipRig, normalizeKeys, samplePose, sampleTrack } from './sample.ts'
import { jointAlias, r15View, r6TracksFromView } from './convert.ts'
import { R6_OF_R15 } from './r6.ts'

export class AnimPatchError extends Error {}

const isJoint = (j: unknown): j is R15Joint => typeof j === 'string' && (R15_JOINTS as readonly string[]).includes(j)

// Raw JSON from a model -> a valid change (throws AnimPatchError with the reason). Joint names may be
// R15 names or R6 Motor6D names ("Right Shoulder", "RootJoint"); they are stored as R15 names.
export function normalizeChange(raw: unknown): AnimChange {
  const c0 = (raw ?? {}) as Record<string, unknown>
  const alias = typeof c0.joint === 'string' && !isJoint(c0.joint) ? jointAlias(c0.joint) : null
  const c = alias ? { ...c0, joint: alias } : c0
  const why = c.why ? String(c.why).slice(0, 200) : undefined
  const n = (v: unknown, what: string) => {
    const x = Number(v)
    if (!Number.isFinite(x)) throw new AnimPatchError(`${what} must be a number`)
    return x
  }
  switch (c.kind) {
    case 'offset': {
      if (!isJoint(c.joint)) throw new AnimPatchError(`offset: unknown joint "${c.joint}"`)
      const rot = Array.isArray(c.rot) ? c.rot.map(Number) : []
      if (rot.length !== 3 || rot.some((x) => !Number.isFinite(x))) throw new AnimPatchError('offset: rot must be [x, y, z] degrees')
      const lim = 60
      return { kind: 'offset', joint: c.joint, at: n(c.at, 'offset.at'), rot: rot.map((x) => Math.max(-lim, Math.min(lim, x))) as [number, number, number], ...(why ? { why } : {}) }
    }
    case 'retime': {
      const from = n(c.from, 'retime.from')
      const to = n(c.to, 'retime.to')
      const scale = n(c.scale, 'retime.scale')
      if (to <= from) throw new AnimPatchError('retime: to must be after from')
      if (scale < 0.3 || scale > 3) throw new AnimPatchError('retime: scale must be between 0.3 and 3')
      return { kind: 'retime', from, to, scale, ...(why ? { why } : {}) }
    }
    case 'ease': {
      const style = POSE_EASING_STYLES.find((s) => s === c.style)
      if (!style) throw new AnimPatchError(`ease: style must be one of ${POSE_EASING_STYLES.join(', ')}`)
      const dir = c.dir === undefined ? undefined : POSE_EASING_DIRECTIONS.find((d) => d === c.dir)
      if (c.dir !== undefined && !dir) throw new AnimPatchError('ease: dir must be In, Out or InOut')
      if (c.joint !== undefined && !isJoint(c.joint)) throw new AnimPatchError(`ease: unknown joint "${c.joint}"`)
      return { kind: 'ease', at: n(c.at, 'ease.at'), style, ...(dir ? { dir } : {}), ...(c.joint ? { joint: c.joint as R15Joint } : {}), ...(why ? { why } : {}) }
    }
    case 'fix': {
      if (c.check !== 'limits' && c.check !== 'sliding' && c.check !== 'penetration') throw new AnimPatchError('fix: check must be limits, sliding or penetration')
      return { kind: 'fix', check: c.check, ...(why ? { why } : {}) }
    }
    default:
      throw new AnimPatchError(`unknown change kind "${c.kind}" (offset, retime, ease, fix)`)
  }
}

const near = (keys: AnimKey[], t: number, tol = 0.06) => {
  let best = -1
  let bd = tol
  keys.forEach((k, i) => {
    const d = Math.abs(k.t - t)
    if (d <= bd) {
      bd = d
      best = i
    }
  })
  return best
}

function applyOne(clip: AnimClip, ch: AnimChange, r6 = false): AnimClip {
  switch (ch.kind) {
    case 'offset': {
      const keys = [...(clip.tracks[ch.joint] ?? [])]
      let i = near(keys, ch.at)
      if (i < 0) {
        const x = sampleTrack(keys, ch.at) ?? { p: [0, 0, 0], q: [0, 0, 0, 1] }
        keys.push({ t: Math.round(ch.at * 1000) / 1000, cf: xfToCf(x), ease: 'CubicV2', dir: 'InOut' })
        keys.sort((a, b) => a.t - b.t)
        i = near(keys, ch.at)
      }
      const x = cfToXf(keys[i].cf)
      keys[i] = { ...keys[i], cf: xfToCf({ p: x.p, q: qmul(x.q, qeulerDeg(ch.rot)) }) }
      return { ...clip, tracks: { ...clip.tracks, [ch.joint]: keys } }
    }
    case 'retime': {
      const D = clip.duration
      const from = Math.max(0, ch.from)
      const to = Math.min(D, ch.to)
      if (to <= from) throw new AnimPatchError('retime span is outside the clip')
      const delta = (to - from) * (ch.scale - 1)
      const map = (t: number) => (t <= from ? t : t >= to ? t + delta : from + (t - from) * ch.scale)
      const r = (t: number) => Math.round(map(t) * 10000) / 10000
      const tracks: AnimClip['tracks'] = {}
      for (const [j, keys] of Object.entries(clip.tracks) as [R15Joint, AnimKey[]][]) tracks[j] = normalizeKeys(keys.map((k) => ({ ...k, t: r(k.t) })))
      return { ...clip, duration: Math.max(0.1, r(D)), tracks, markers: clip.markers.map((m) => ({ ...m, t: r(m.t) })), beats: clip.beats?.map((b) => ({ ...b, at: r(b.at) })) }
    }
    case 'ease': {
      const tracks: AnimClip['tracks'] = {}
      let hit = 0
      for (const [j, keys] of Object.entries(clip.tracks) as [R15Joint, AnimKey[]][]) {
        if (ch.joint && j !== ch.joint) {
          tracks[j] = keys
          continue
        }
        const i = near(keys, ch.at)
        tracks[j] = i < 0 ? keys : keys.map((k, n) => (n === i ? ((hit++, { ...k, ease: ch.style, dir: ch.dir ?? k.dir ?? 'InOut' })) : k))
      }
      if (!hit) throw new AnimPatchError(`ease: no key near ${ch.at.toFixed(2)} s`)
      return { ...clip, tracks }
    }
    case 'fix': {
      if (ch.check === 'limits') {
        const tracks: AnimClip['tracks'] = {}
        for (const [j, keys] of Object.entries(clip.tracks) as [R15Joint, AnimKey[]][]) {
          tracks[j] = keys.map((k) => {
            const x = cfToXf(k.cf)
            return { ...k, cf: xfToCf({ p: x.p, q: qeulerDeg(clampToLimits(j, eulerDegOf(x.q), r6 ? JOINT_LIMITS_R6 : undefined)) }) }
          })
        }
        return { ...clip, tracks }
      }
      if (ch.check === 'sliding') {
        const report = runChecks(clip)
        const slides = report.issues.filter((i) => i.check === 'sliding' && i.at !== undefined)
        if (!slides.length) return clip
        const tracks = tracksOf(clip.tracks)
        for (const s of slides) {
          const foot = s.joint === 'LeftFoot' ? 'Left' : 'Right'
          // Plant from where the slide starts until the foot leaves the floor (or 0.6 s later).
          const end = Math.min(clip.duration, (s.at ?? 0) + 0.6)
          plantPass(tracks, foot, s.at ?? 0, end)
        }
        return { ...clip, tracks: trackRecord(tracks) }
      }
      // Penetration: open the arms out at every key where they cut into the body.
      let out = clip
      for (let pass = 0; pass < 3; pass++) {
        let changed = false
        const tracks: AnimClip['tracks'] = { ...out.tracks }
        for (const side of ['Left', 'Right'] as const) {
          const j = `${side}Shoulder` as R15Joint
          const keys = tracks[j]
          if (!keys) continue
          tracks[j] = keys.map((k) => {
            const p = penetration(forwardKinematics(samplePose(out, k.t)))
            if (p.depth < 0.12 || !p.pair?.includes(side)) return k
            changed = true
            const x = cfToXf(k.cf)
            return { ...k, cf: xfToCf({ p: x.p, q: qmul(x.q, qeulerDeg([0, 0, side === 'Right' ? 10 : -10])) }) }
          })
        }
        out = { ...out, tracks }
        if (!changed) break
      }
      return out
    }
  }
}

// Applies changes in order; bad ones are rejected with a reason, the rest still apply. R6 clips are
// edited through their R15 view (R6 joint names map onto Root, Neck, shoulders and hips) and turned
// back into R6 tracks; changes to joints R6 does not have are rejected.
export function applyAnimChanges(clip: AnimClip, changes: unknown[]): { clip: AnimClip; applied: AnimChange[]; rejected: { change: unknown; reason: string }[] } {
  if (clipRig(clip) === 'R6') {
    const r = applyR15(r15View(clip), changes, true)
    return { ...r, clip: { ...r.clip, rig: 'R6', tracks: r6TracksFromView(r.clip.tracks) } }
  }
  return applyR15(clip, changes, false)
}

function applyR15(clip: AnimClip, changes: unknown[], r6: boolean): { clip: AnimClip; applied: AnimChange[]; rejected: { change: unknown; reason: string }[] } {
  let out = clip
  const applied: AnimChange[] = []
  const rejected: { change: unknown; reason: string }[] = []
  for (const raw of changes) {
    try {
      const ch = normalizeChange(raw)
      if (r6 && 'joint' in ch && ch.joint && !R6_OF_R15[ch.joint]) throw new AnimPatchError(`${ch.joint}: R6 has no such joint (use RootJoint, Neck, Left/Right Shoulder, Left/Right Hip)`)
      out = applyOne(out, ch, r6)
      applied.push(ch)
    } catch (e) {
      rejected.push({ change: raw, reason: (e as Error).message })
    }
  }
  return { clip: out, applied, rejected }
}
