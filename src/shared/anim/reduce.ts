// Key reduction for dense (mocap or baked) tracks: Douglas-Peucker over rotations. A key is dropped
// when linear interpolation between the kept neighbours reproduces it within `toleranceDeg` (and
// within a matching positional tolerance), so a 30 fps capture becomes a few readable keys.

import type { AnimKey } from './model.ts'
import { qangle, vdist, xlerp } from './math.ts'
import { keyXf } from './sample.ts'

export function reduceKeys(keys: AnimKey[], toleranceDeg = 0.6): AnimKey[] {
  if (keys.length <= 2) return keys
  const tolRad = (toleranceDeg * Math.PI) / 180
  const tolPos = Math.max(0.005, toleranceDeg * 0.01)
  const keep = new Array(keys.length).fill(false)
  keep[0] = true
  keep[keys.length - 1] = true
  const stack: [number, number][] = [[0, keys.length - 1]]
  while (stack.length) {
    const [a, b] = stack.pop()!
    if (b - a < 2) continue
    const xa = keyXf(keys[a])
    const xb = keyXf(keys[b])
    let worst = -1
    let worstErr = 0
    for (let i = a + 1; i < b; i++) {
      const u = (keys[i].t - keys[a].t) / Math.max(1e-6, keys[b].t - keys[a].t)
      const guess = xlerp(xa, xb, u)
      const xi = keyXf(keys[i])
      const err = Math.max(qangle(guess.q, xi.q) / tolRad, vdist(guess.p, xi.p) / tolPos)
      if (err > worstErr) {
        worstErr = err
        worst = i
      }
    }
    if (worstErr > 1 && worst > 0) {
      keep[worst] = true
      stack.push([a, worst], [worst, b])
    }
  }
  return keys.filter((_, i) => keep[i])
}
