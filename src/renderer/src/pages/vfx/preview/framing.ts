// Camera framing for the VFX preview: a camera preset (position + target) is kept as it is when the
// effect and the dummy fit in its view, and pulled back (aimed at their centre) when they do not, so
// a large effect (or one placed away from the dummy) is never cut off. Pure; no three.js.

import type { Vec3 } from '../../../../../shared/vfx/types.ts'

export interface ViewPose {
  pos: Vec3
  target: Vec3
}

// The R15 dummy (feet at the origin, about 5.2 studs tall): always in the shot, for scale.
const DUMMY: { min: Vec3; max: Vec3 } = { min: [-2, 0, -0.6], max: [2, 5.2, 0.6] }
// Share of the half field of view the content may use before the camera moves.
const MARGIN = 0.85
const MAX_DISTANCE = 400

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

// fovDeg: the camera's vertical field of view (the narrower one for a landscape view).
export function frameView(view: ViewPose, bounds: { min: Vec3; max: Vec3 } | null, fovDeg = 70): ViewPose {
  if (!bounds) return view
  const min: Vec3 = [0, 1, 2].map((i) => Math.min(bounds.min[i], DUMMY.min[i])) as Vec3
  const max: Vec3 = [0, 1, 2].map((i) => Math.max(bounds.max[i], DUMMY.max[i])) as Vec3
  if (![...min, ...max].every(Number.isFinite)) return view
  const centre: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const radius = len(sub(max, min)) / 2
  const half = ((fovDeg / 2) * Math.PI) / 180 * MARGIN
  const look = sub(view.target, view.pos)
  const toC = sub(centre, view.pos)
  const dC = len(toC)
  if (dC > radius && len(look) > 0) {
    const cos = (look[0] * toC[0] + look[1] * toC[1] + look[2] * toC[2]) / (len(look) * dC)
    const off = Math.acos(Math.max(-1, Math.min(1, cos)))
    if (off + Math.asin(radius / dC) <= half) return view
  }
  // Same direction as the preset, aimed at the centre, far enough for the whole sphere.
  const back = sub(view.pos, view.target)
  const bl = len(back) || 1
  const dist = Math.min(MAX_DISTANCE, Math.max(bl, radius / Math.sin(half)))
  return { pos: [centre[0] + (back[0] / bl) * dist, centre[1] + (back[1] / bl) * dist, centre[2] + (back[2] / bl) * dist], target: centre }
}
