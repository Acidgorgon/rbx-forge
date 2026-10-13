// Minimal CFrame math for the preview: [px,py,pz, r00,r01,r02, r10,r11,r12, r20,r21,r22], Roblox
// component order (rows of the rotation matrix; columns are the right / up / back vectors).

import type { CFrameArr, Vec3 } from './types.ts'

export const IDENTITY: CFrameArr = [0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]

export function cf(x = 0, y = 0, z = 0): CFrameArr {
  return [x, y, z, 1, 0, 0, 0, 1, 0, 0, 0, 1]
}

export function isCFrame(v: unknown): v is CFrameArr {
  return Array.isArray(v) && v.length === 12 && v.every((x) => typeof x === 'number')
}

export function mul(a: CFrameArr, b: CFrameArr): CFrameArr {
  const r = (m: CFrameArr, i: number, j: number) => m[3 + i * 3 + j]
  const out: CFrameArr = new Array(12).fill(0)
  for (let i = 0; i < 3; i++) {
    out[i] = a[i] + r(a, i, 0) * b[0] + r(a, i, 1) * b[1] + r(a, i, 2) * b[2]
    for (let j = 0; j < 3; j++) out[3 + i * 3 + j] = r(a, i, 0) * r(b, 0, j) + r(a, i, 1) * r(b, 1, j) + r(a, i, 2) * r(b, 2, j)
  }
  return out
}

// Rotates a direction (no translation).
export function rotate(c: CFrameArr, v: Vec3): Vec3 {
  return [c[3] * v[0] + c[4] * v[1] + c[5] * v[2], c[6] * v[0] + c[7] * v[1] + c[8] * v[2], c[9] * v[0] + c[10] * v[1] + c[11] * v[2]]
}

export function point(c: CFrameArr, v: Vec3): Vec3 {
  const r = rotate(c, v)
  return [r[0] + c[0], r[1] + c[1], r[2] + c[2]]
}

export function pos(c: CFrameArr): Vec3 {
  return [c[0], c[1], c[2]]
}

// Rotation about Y then X then Z (like CFrame.fromOrientation for small use), radians.
export function fromEuler(rx: number, ry: number, rz: number, at: Vec3 = [0, 0, 0]): CFrameArr {
  const cx = Math.cos(rx), sx = Math.sin(rx), cy = Math.cos(ry), sy = Math.sin(ry), cz = Math.cos(rz), sz = Math.sin(rz)
  const X: CFrameArr = [0, 0, 0, 1, 0, 0, 0, cx, -sx, 0, sx, cx]
  const Y: CFrameArr = [0, 0, 0, cy, 0, sy, 0, 1, 0, -sy, 0, cy]
  const Z: CFrameArr = [0, 0, 0, cz, -sz, 0, sz, cz, 0, 0, 0, 1]
  const m = mul(mul(Y, X), Z)
  m[0] = at[0]
  m[1] = at[1]
  m[2] = at[2]
  return m
}

// Rotation that takes +Y to the unit vector d (Rodrigues).
export function alignY(d: Vec3): CFrameArr {
  const [x, y, z] = norm(d)
  if (y > 0.99999) return [...IDENTITY]
  if (y < -0.99999) return [0, 0, 0, 1, 0, 0, 0, -1, 0, 0, 0, -1]
  // axis = Y x d, angle = acos(y)
  const ax = z, az = -x
  const s = Math.hypot(ax, az)
  const kx = ax / s, kz = az / s
  const c = y, sn = s, t = 1 - c
  return [0, 0, 0, t * kx * kx + c, -sn * kz, t * kx * kz, sn * kz, c, -sn * kx, t * kx * kz, sn * kx, t * kz * kz + c]
}

export function norm(v: Vec3): Vec3 {
  const l = Math.hypot(v[0], v[1], v[2]) || 1
  return [v[0] / l, v[1] / l, v[2] / l]
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

export function scale(a: Vec3, s: number): Vec3 {
  return [a[0] * s, a[1] * s, a[2] * s]
}

export function lerp3(a: Vec3, b: Vec3, t: number): Vec3 {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
}

// Local axes of a NormalId face.
export const NORMALS: Record<string, Vec3> = {
  Right: [1, 0, 0],
  Top: [0, 1, 0],
  Back: [0, 0, 1],
  Left: [-1, 0, 0],
  Bottom: [0, -1, 0],
  Front: [0, 0, -1]
}
