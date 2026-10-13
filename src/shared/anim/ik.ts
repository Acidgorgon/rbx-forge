// Procedural helpers the animation script uses: two-bone IK for arms and legs (with a pole so elbows
// point back and knees forward), look-at for the head, and a damped spring for overlap and
// follow-through. All in character space (feet on y = 0, facing -Z), on the rig in r15.ts.

import type { R15Joint } from './model.ts'
import { clamp, qaxis, qconj, qfromAxes, qmul, qnorm, qrot, qslerp, qtoEuler, qeuler, vadd, vcross, vdot, vlen, vnorm, vscale, vsub, type Quat, type V3, type Xf } from './math.ts'
import { JOINTS, LIMB, LIMBS, jointWorld, type LimbName, type R15Part } from './r15.ts'

export interface IkResult {
  upper: Quat
  lower: Quat
  end?: Quat
  // Where the elbow / knee ended up and whether the target was out of reach.
  mid: V3
  reached: boolean
}

export function limbLengths(limb: LimbName): [number, number] {
  return limb.endsWith('Arm') ? [LIMB.upperArm, LIMB.lowerArm] : [LIMB.upperLeg, LIMB.lowerLeg]
}

// Default pole: elbows point back and slightly out, knees forward and slightly out, in the space of
// the torso part the limb hangs from.
export function defaultPole(parts: Record<R15Part, Xf>, limb: LimbName): V3 {
  const arm = limb.endsWith('Arm')
  const sideX = limb.startsWith('Left') ? -1 : 1
  const local: V3 = arm ? [sideX * 0.35, -0.45, 1] : [sideX * 0.15, 0, -1]
  const host = arm ? parts.UpperTorso : parts.LowerTorso
  return vnorm(qrot(host.q, local))
}

// Two-bone IK: rotations (joint-local, as Motor6D transforms) that put the limb's end joint (wrist or
// ankle) at `target`. `endWorld` keeps the hand / foot at a world rotation (foot plants).
export function solveTwoBone(parts: Record<R15Part, Xf>, limb: LimbName, target: V3, opts: { pole?: V3; endWorld?: Quat } = {}): IkResult {
  const L = LIMBS[limb]
  const arm = limb.endsWith('Arm')
  const [a, b] = limbLengths(limb)
  const S = jointWorld(parts, L.upper)
  const v = vsub(target, S)
  const dist = vlen(v)
  const dir = vnorm(v, [0, -1, 0])
  const d = clamp(dist, Math.abs(a - b) + 1e-3, a + b - 1e-4)
  const pole = opts.pole ? vnorm(opts.pole) : defaultPole(parts, limb)
  let po = vsub(pole, vscale(dir, vdot(pole, dir)))
  if (vlen(po) < 1e-5) po = vsub([0, 0, arm ? 1 : -1], vscale(dir, vdot([0, 0, arm ? 1 : -1], dir)))
  po = vnorm(po, [0, 0, 1])
  const cosA = clamp((a * a + d * d - b * b) / (2 * a * d), -1, 1)
  const sinA = Math.sqrt(1 - cosA * cosA)
  const E = vadd(S, vadd(vscale(dir, cosA * a), vscale(po, sinA * a)))
  const T = vadd(S, vscale(dir, d))
  const y1 = vnorm(vsub(S, E))
  let z1 = vsub(arm ? po : vscale(po, -1), vscale(y1, vdot(arm ? po : vscale(po, -1), y1)))
  z1 = vnorm(z1, [0, 0, 1])
  const x = vnorm(vcross(y1, z1), [1, 0, 0])
  z1 = vcross(x, y1)
  const y2 = vnorm(vsub(E, T), y1)
  const z2 = vcross(x, y2)
  const wUpper = qfromAxes(x, y1, z1)
  const wLower = qfromAxes(x, y2, z2)
  const parent = parts[JOINTS[L.upper].part0].q
  const out: IkResult = {
    upper: qnorm(qmul(qconj(parent), wUpper)),
    lower: qnorm(qmul(qconj(wUpper), wLower)),
    mid: E,
    reached: dist <= a + b - 1e-3 && dist >= Math.abs(a - b)
  }
  if (opts.endWorld) out.end = qnorm(qmul(qconj(wLower), opts.endWorld))
  return out
}

// Neck rotation (joint-local) that turns the head toward `target`, blended by weight and clamped to
// a comfortable range (yaw 75, pitch 50 degrees).
export function lookAtRotation(parts: Record<R15Part, Xf>, target: V3, current: Quat, weight = 1): Quat {
  const head = vadd(jointWorld(parts, 'Neck'), [0, 0.6, 0])
  const f = vnorm(vsub(target, head), [0, 0, -1])
  const z = vscale(f, -1)
  let x = vcross([0, 1, 0], z)
  if (vlen(x) < 1e-4) x = [1, 0, 0]
  x = vnorm(x)
  const y = vcross(z, x)
  const world = qfromAxes(x, y, z)
  let local = qmul(qconj(parts.UpperTorso.q), world)
  const e = qtoEuler(local)
  local = qeuler(clamp(e[0], -0.87, 0.87), clamp(e[1], -1.31, 1.31), clamp(e[2], -0.35, 0.35))
  return qslerp(current, local, clamp(weight, 0, 1))
}

// Log map of a unit quaternion (axis * angle).
function qlog(q: Quat): V3 {
  const n = qnorm(q[3] < 0 ? [-q[0], -q[1], -q[2], -q[3]] : q)
  const s = Math.hypot(n[0], n[1], n[2])
  if (s < 1e-9) return [0, 0, 0]
  const ang = 2 * Math.atan2(s, n[3])
  return [(n[0] / s) * ang, (n[1] / s) * ang, (n[2] / s) * ang]
}

function qexp(v: V3): Quat {
  const ang = Math.hypot(v[0], v[1], v[2])
  if (ang < 1e-9) return [0, 0, 0, 1]
  return qaxis(v, ang)
}

// A damped angular spring following `targets` (sampled every dt seconds): the lagging, overshooting
// copy that reads as overlap and follow-through. freq in Hz, damping ratio (< 1 overshoots).
export function springFollow(targets: Quat[], dt: number, freq = 4, damping = 0.45): Quat[] {
  if (!targets.length) return []
  const w0 = 2 * Math.PI * Math.max(0.1, freq)
  const k = w0 * w0
  const c = 2 * Math.max(0, damping) * w0
  let q = targets[0]
  let w: V3 = [0, 0, 0]
  const out: Quat[] = [q]
  const sub = 4
  const h = dt / sub
  for (let i = 1; i < targets.length; i++) {
    for (let s = 0; s < sub; s++) {
      const err = qlog(qmul(targets[i], qconj(q)))
      const acc: V3 = [k * err[0] - c * w[0], k * err[1] - c * w[1], k * err[2] - c * w[2]]
      w = vadd(w, vscale(acc, h))
      q = qnorm(qmul(qexp(vscale(w, h)), q))
    }
    out.push(q)
  }
  return out
}

export { LIMBS, type LimbName }
export type { R15Joint }
