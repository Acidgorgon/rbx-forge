// Geometry helpers for Model Lab builds: world bounds of the recorded parts, the display offset that
// stands a model on the preview floor, and the camera views (also the critic's snapshot angles).
// Roblox space: +Y up, the model faces -Z. No three.js here (tested in node).

import type { ModelPart } from './types.ts'

export type Vec3 = [number, number, number]

export interface Bounds {
  min: Vec3
  max: Vec3
}

// Parts drawn in the preview: invisible ones (Transparency 1, e.g. the root and bone parts) are not.
export const visibleParts = (parts: ModelPart[]): ModelPart[] => parts.filter((p) => (p.t ?? 0) < 0.99)

export function partBounds(parts: ModelPart[]): Bounds | null {
  if (!parts.length) return null
  const min: Vec3 = [Infinity, Infinity, Infinity]
  const max: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (const p of parts) {
    const [x, y, z, r00, r01, r02, r10, r11, r12, r20, r21, r22] = p.cf
    const hx = p.s[0] / 2
    const hy = p.s[1] / 2
    const hz = p.s[2] / 2
    // Extent of an oriented box along each world axis.
    const ex = Math.abs(r00) * hx + Math.abs(r01) * hy + Math.abs(r02) * hz
    const ey = Math.abs(r10) * hx + Math.abs(r11) * hy + Math.abs(r12) * hz
    const ez = Math.abs(r20) * hx + Math.abs(r21) * hy + Math.abs(r22) * hz
    min[0] = Math.min(min[0], x - ex)
    min[1] = Math.min(min[1], y - ey)
    min[2] = Math.min(min[2], z - ez)
    max[0] = Math.max(max[0], x + ex)
    max[1] = Math.max(max[1], y + ey)
    max[2] = Math.max(max[2], z + ez)
  }
  return { min, max }
}

export const boundsSize = (b: Bounds): Vec3 => [b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]
export const boundsCentre = (b: Bounds): Vec3 => [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2]

// Moves the model so it is centred over the origin and its lowest point rests on y = 0.
export function displayOffset(b: Bounds | null): Vec3 {
  if (!b) return [0, 0, 0]
  const c = boundsCentre(b)
  return [-c[0], -b.min[1], -c[2]]
}

export type ModelView = 'front' | 'side' | 'back' | 'top'
export const MODEL_VIEWS: ModelView[] = ['front', 'side', 'back', 'top']
// The critic sees these three.
export const CRITIC_VIEWS: ModelView[] = ['front', 'side', 'back']
export const VIEW_LABELS: Record<ModelView, string> = { front: 'front three-quarter', side: 'side', back: 'back three-quarter', top: 'top' }

// Direction from the target to the camera. The model faces -Z, so "front" looks at it from -Z.
const DIRS: Record<ModelView, Vec3> = {
  front: [0.62, 0.42, -1],
  side: [1, 0.22, 0],
  back: [-0.7, 0.5, 1],
  top: [0.25, 1.4, -0.45]
}

export interface CameraPose {
  pos: Vec3
  target: Vec3
  fov: number
  far: number
}

// A camera that fits the (displayed, offset) bounds for a view: the bounding sphere fills the frame.
export function viewCamera(b: Bounds | null, view: ModelView, fov = 40, aspect = 16 / 9): CameraPose {
  const size: Vec3 = b ? boundsSize(b) : [4, 4, 4]
  const radius = Math.max(1.5, Math.hypot(size[0], size[1], size[2]) / 2)
  const target: Vec3 = [0, size[1] / 2, 0]
  const vfov = (fov * Math.PI) / 180
  const hfov = 2 * Math.atan(Math.tan(vfov / 2) * Math.max(0.5, aspect))
  // The bounding sphere is loose for long, flat creatures: pull in a little.
  const dist = (radius / Math.sin(Math.min(vfov, hfov) / 2)) * 0.78
  const d = DIRS[view] ?? DIRS.front
  const len = Math.hypot(d[0], d[1], d[2])
  return { pos: [target[0] + (d[0] / len) * dist, target[1] + (d[1] / len) * dist, target[2] + (d[2] / len) * dist], target, fov, far: Math.max(500, dist * 6) }
}
