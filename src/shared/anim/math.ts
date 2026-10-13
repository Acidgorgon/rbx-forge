// CFrame and quaternion math for the Animation Lab. CFrames are Roblox component order arrays
// [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] (rows of the rotation matrix; its columns are
// the right, up and back vectors), the same layout as shared/vfx/cframe.ts and Pose.CFrame in a
// KeyframeSequence. Quaternions are [x, y, z, w]. Angles in the public helpers are degrees.

export type V3 = [number, number, number]
export type Quat = [number, number, number, number]
export type CF = number[]

export const DEG = Math.PI / 180

export const IDENTITY_CF: CF = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]
export const IDENTITY_Q: Quat = [0, 0, 0, 1]

// ------------------------------------------------------------------ vectors

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z]
export const vadd = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
export const vsub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
export const vscale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s]
export const vdot = (a: V3, b: V3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
export const vcross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
export const vlen = (a: V3): number => Math.hypot(a[0], a[1], a[2])
export const vlerp = (a: V3, b: V3, t: number): V3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
export function vnorm(a: V3, fallback: V3 = [0, 1, 0]): V3 {
  const l = vlen(a)
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [...fallback] as V3
}
export const vdist = (a: V3, b: V3): number => vlen(vsub(a, b))

// ------------------------------------------------------------------ quaternions

export function qmul(a: Quat, b: Quat): Quat {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2]
  ]
}

export const qconj = (q: Quat): Quat => [-q[0], -q[1], -q[2], q[3]]

export function qnorm(q: Quat): Quat {
  const l = Math.hypot(q[0], q[1], q[2], q[3])
  return l > 1e-12 ? [q[0] / l, q[1] / l, q[2] / l, q[3] / l] : [0, 0, 0, 1]
}

export function qaxis(axis: V3, angle: number): Quat {
  const [x, y, z] = vnorm(axis)
  const s = Math.sin(angle / 2)
  return [x * s, y * s, z * s, Math.cos(angle / 2)]
}

export function qrot(q: Quat, v: V3): V3 {
  // v + 2 w (u x v) + 2 u x (u x v)
  const u: V3 = [q[0], q[1], q[2]]
  const t = vscale(vcross(u, v), 2)
  return vadd(vadd(v, vscale(t, q[3])), vcross(u, t))
}

export function qdot(a: Quat, b: Quat): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3]
}

// Angle between two rotations (radians, 0..pi).
export function qangle(a: Quat, b: Quat): number {
  return 2 * Math.acos(Math.min(1, Math.abs(qdot(qnorm(a), qnorm(b)))))
}

export function qslerp(a: Quat, b: Quat, t: number): Quat {
  let d = qdot(a, b)
  let bb = b
  if (d < 0) {
    d = -d
    bb = [-b[0], -b[1], -b[2], -b[3]]
  }
  if (d > 0.9995) return qnorm([a[0] + (bb[0] - a[0]) * t, a[1] + (bb[1] - a[1]) * t, a[2] + (bb[2] - a[2]) * t, a[3] + (bb[3] - a[3]) * t])
  const th = Math.acos(d)
  const s = Math.sin(th)
  const wa = Math.sin((1 - t) * th) / s
  const wb = Math.sin(t * th) / s
  return [a[0] * wa + bb[0] * wb, a[1] * wa + bb[1] * wb, a[2] * wa + bb[2] * wb, a[3] * wa + bb[3] * wb]
}

// Shortest rotation taking unit vector a onto unit vector b.
export function qfromTo(a: V3, b: V3): Quat {
  const u = vnorm(a)
  const v = vnorm(b)
  const d = vdot(u, v)
  if (d > 0.999999) return [0, 0, 0, 1]
  if (d < -0.999999) {
    let axis = vcross([1, 0, 0], u)
    if (vlen(axis) < 1e-6) axis = vcross([0, 1, 0], u)
    return qaxis(axis, Math.PI)
  }
  const c = vcross(u, v)
  return qnorm([c[0], c[1], c[2], 1 + d])
}

// CFrame.Angles(rx, ry, rz) = Rx * Ry * Rz (radians), as Roblox's CFrame.fromEulerAnglesXYZ.
export function qeuler(rx: number, ry: number, rz: number): Quat {
  return qmul(qmul(qaxis([1, 0, 0], rx), qaxis([0, 1, 0], ry)), qaxis([0, 0, 1], rz))
}

export function qeulerDeg(d: V3): Quat {
  return qeuler(d[0] * DEG, d[1] * DEG, d[2] * DEG)
}

// Inverse of qeuler (CFrame:ToEulerAnglesXYZ), radians.
export function qtoEuler(q: Quat): V3 {
  const m = qtoMat(q)
  // m rows: [r00 r01 r02; r10 r11 r12; r20 r21 r22], R = Rx Ry Rz
  const r02 = Math.max(-1, Math.min(1, m[2]))
  const ry = Math.asin(r02)
  let rx: number
  let rz: number
  if (Math.abs(r02) < 0.99999) {
    rx = Math.atan2(-m[5], m[8])
    rz = Math.atan2(-m[1], m[0])
  } else {
    rx = Math.atan2(m[7], m[4])
    rz = 0
  }
  return [rx, ry, rz]
}

// Rotation matrix rows (9 numbers) from a quaternion.
export function qtoMat(q: Quat): number[] {
  const [x, y, z, w] = qnorm(q)
  return [
    1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
    2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
    2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)
  ]
}

export function matToQ(m: number[]): Quat {
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = m
  const tr = m00 + m11 + m22
  let q: Quat
  if (tr > 0) {
    const s = Math.sqrt(tr + 1) * 2
    q = [(m21 - m12) / s, (m02 - m20) / s, (m10 - m01) / s, 0.25 * s]
  } else if (m00 > m11 && m00 > m22) {
    const s = Math.sqrt(1 + m00 - m11 - m22) * 2
    q = [0.25 * s, (m01 + m10) / s, (m02 + m20) / s, (m21 - m12) / s]
  } else if (m11 > m22) {
    const s = Math.sqrt(1 + m11 - m00 - m22) * 2
    q = [(m01 + m10) / s, 0.25 * s, (m12 + m21) / s, (m02 - m20) / s]
  } else {
    const s = Math.sqrt(1 + m22 - m00 - m11) * 2
    q = [(m02 + m20) / s, (m12 + m21) / s, 0.25 * s, (m10 - m01) / s]
  }
  return qnorm(q)
}

// Rotation whose columns are the given right (x), up (y) and back (z) axes.
export function qfromAxes(x: V3, y: V3, z: V3): Quat {
  return matToQ([x[0], y[0], z[0], x[1], y[1], z[1], x[2], y[2], z[2]])
}

// ------------------------------------------------------------------ CFrames

export interface Xf {
  p: V3
  q: Quat
}

export const XF_IDENTITY: Xf = { p: [0, 0, 0], q: [0, 0, 0, 1] }

export function xf(p: V3 = [0, 0, 0], q: Quat = [0, 0, 0, 1]): Xf {
  return { p, q }
}

export function xmul(a: Xf, b: Xf): Xf {
  return { p: vadd(a.p, qrot(a.q, b.p)), q: qnorm(qmul(a.q, b.q)) }
}

export function xinv(a: Xf): Xf {
  const qi = qconj(a.q)
  return { p: vscale(qrot(qi, a.p), -1), q: qi }
}

export function xpoint(a: Xf, v: V3): V3 {
  return vadd(a.p, qrot(a.q, v))
}

export function xlerp(a: Xf, b: Xf, t: number): Xf {
  return { p: vlerp(a.p, b.p, t), q: qslerp(a.q, b.q, t) }
}

export function cfToXf(c: CF): Xf {
  if (!Array.isArray(c) || c.length < 12) return { p: [0, 0, 0], q: [0, 0, 0, 1] }
  return { p: [c[0], c[1], c[2]], q: matToQ(c.slice(3, 12)) }
}

export function xfToCf(a: Xf, digits = 6): CF {
  const r = (v: number) => {
    const k = 10 ** digits
    const out = Math.round(v * k) / k
    return Object.is(out, -0) ? 0 : out
  }
  return [...a.p, ...qtoMat(a.q)].map(r)
}

export function isCf(v: unknown): v is CF {
  return Array.isArray(v) && v.length === 12 && v.every((x) => typeof x === 'number' && Number.isFinite(x))
}

// Degrees helpers for kit poses and summaries.
export function eulerDegOf(q: Quat): V3 {
  const e = qtoEuler(q)
  return [e[0] / DEG, e[1] / DEG, e[2] / DEG]
}

export const round = (v: number, d = 3) => Math.round(v * 10 ** d) / 10 ** d
export const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
