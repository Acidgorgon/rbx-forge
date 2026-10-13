// Poses for the Ability Composer preview. Placeholder pose tracks are computed directly; Animation Lab
// clips are sampled once through its getAnimPose IPC (about 30 samples a second) and interpolated, so
// scrubbing never waits on IPC. The Animation Lab API is optional (calls are guarded): without it, or
// for an unknown clip, the dummy stays in its rest pose.

import { isPlaceholder, placeholderPose } from '@shared/ability/placeholder'
import type { Pose } from '@shared/ability/rig'
import type { AbilityAnimation } from '@shared/ability/types'
import type { AnimClipRef } from '@shared/anim/types'

type AnimIpc = {
  listAnimClips?: () => Promise<AnimClipRef[]>
  getAnimPose?: (id: string, t: number) => Promise<Record<string, number[]> | null>
}

const anim = (): AnimIpc => ((globalThis as { harness?: unknown }).harness ?? {}) as AnimIpc

export async function listAnimClips(): Promise<AnimClipRef[]> {
  try {
    return (await anim().listAnimClips?.()) ?? []
  } catch {
    return []
  }
}

const RATE = 30
const MAX_SAMPLES = 900

export class PoseTrack {
  private samples: Pose[] = []
  private animation: AbilityAnimation | null = null
  missing = false

  private key = ''

  async load(animation: AbilityAnimation | null, force = false): Promise<void> {
    this.animation = animation
    const key = animation ? `${animation.clip}|${animation.duration}` : ''
    if (!force && key === this.key && (this.samples.length || this.missing)) return
    this.key = key
    this.samples = []
    this.missing = false
    if (!animation || isPlaceholder(animation.clip)) return
    const get = anim().getAnimPose
    if (!get) {
      this.missing = true
      return
    }
    const n = Math.min(MAX_SAMPLES, Math.max(2, Math.ceil(animation.duration * RATE) + 1))
    const poses = await Promise.all(Array.from({ length: n }, (_, i) => get(animation.clip, (i / (n - 1)) * animation.duration).catch(() => null)))
    if (poses.every((p) => !p)) this.missing = true
    this.samples = poses.map((p) => p ?? {})
  }

  // Clip time for ability time t, or null while the clip is not playing (rest pose).
  clipTime(t: number): number | null {
    const a = this.animation
    if (!a) return null
    const u = (t - a.start) * a.speed
    if (u < 0) return null
    if (a.looped) return a.duration > 0 ? u % a.duration : 0
    return u > a.duration + 1e-6 ? null : u
  }

  at(t: number): Pose {
    const a = this.animation
    const ct = this.clipTime(t)
    if (!a || ct === null) return {}
    if (isPlaceholder(a.clip)) return placeholderPose(a.clip, ct) ?? {}
    const n = this.samples.length
    if (!n) return {}
    const x = (ct / Math.max(1e-6, a.duration)) * (n - 1)
    const i = Math.max(0, Math.min(n - 1, Math.floor(x)))
    const j = Math.min(n - 1, i + 1)
    const k = x - i
    if (k < 1e-4 || i === j) return this.samples[i]
    return lerpPose(this.samples[i], this.samples[j], k)
  }
}

const IDENTITY = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]

// Componentwise blend with the rotation re-orthonormalised (fine between 30 fps samples).
function lerpPose(a: Pose, b: Pose, k: number): Pose {
  const out: Pose = {}
  for (const name of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const p = a[name] ?? IDENTITY
    const q = b[name] ?? IDENTITY
    const m = p.map((v, i) => v + (q[i] - v) * k)
    out[name] = orthonormal(m)
  }
  return out
}

function orthonormal(m: number[]): number[] {
  // Columns: X = (m3, m6, m9), Y = (m4, m7, m10).
  let x = [m[3], m[6], m[9]]
  const lx = Math.hypot(x[0], x[1], x[2]) || 1
  x = x.map((v) => v / lx)
  let y = [m[4], m[7], m[10]]
  const d = x[0] * y[0] + x[1] * y[1] + x[2] * y[2]
  y = y.map((v, i) => v - d * x[i])
  const ly = Math.hypot(y[0], y[1], y[2]) || 1
  y = y.map((v) => v / ly)
  const z = [x[1] * y[2] - x[2] * y[1], x[2] * y[0] - x[0] * y[2], x[0] * y[1] - x[1] * y[0]]
  return [m[0], m[1], m[2], x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]]
}
