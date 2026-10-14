// Damped spring solver for the UI Motion Lab. Pure; mirrored line for line by the Luau runtime that
// compile.ts writes (SPRING_LUAU), and test/uimotion.test.ts checks the two agree through Lune.
//
// Model: a damped harmonic oscillator pulled toward a goal g,
//   x'' = -w^2 (x - g) - 2 z w x'      w = 2 pi f (f: natural frequency in Hz), z: damping ratio
// stepped with the closed-form solution for a constant goal over dt, so the result does not depend
// on the frame rate (60 fps in Studio, 240 fps on a fast monitor, or one big step after a hitch):
//   z < 1  under-damped: overshoots and rings, overshoot from rest = exp(-z pi / sqrt(1 - z^2))
//   z = 1  critically damped: the fastest approach with no overshoot
//   z > 1  over-damped: slower, no overshoot
// This is the parameterisation of the common Roblox spring modules: Quenty's Spring (Nevermore) uses
// Speed = w (rad/s) and Damper = z with the same analytic step; frequency/damping-ratio springs
// (e.g. Fraktality's spring, used by many UI libraries) use f and z directly. Forge's sliders are f
// (Hz) and z; Speed = 2 pi f if you port a stack to Quenty's Spring.

export interface SpringState {
  x: number
  v: number
}

export interface SpringParams {
  // Natural frequency in Hz (oscillations per second when undamped).
  frequency: number
  // Damping ratio: 1 = critical, < 1 bouncy, > 1 sluggish.
  damping: number
}

const TAU = Math.PI * 2

// Advances (x, v) toward goal by dt seconds. Returns the new state (does not mutate).
export function stepSpring(s: SpringState, goal: number, p: SpringParams, dt: number): SpringState {
  if (dt <= 0) return { x: s.x, v: s.v }
  const w = TAU * Math.max(0.01, p.frequency)
  const z = Math.max(0, p.damping)
  const o = s.x - goal
  const v = s.v
  if (z < 0.9999) {
    const wd = w * Math.sqrt(1 - z * z)
    const e = Math.exp(-z * w * dt)
    const c = Math.cos(wd * dt)
    const sn = Math.sin(wd * dt)
    const o1 = e * (o * c + ((v + z * w * o) / wd) * sn)
    const v1 = e * (v * c - ((z * w * v + w * w * o) / wd) * sn)
    return { x: goal + o1, v: v1 }
  }
  if (z <= 1.0001) {
    const e = Math.exp(-w * dt)
    const b = v + w * o
    return { x: goal + e * (o + b * dt), v: e * (v - w * b * dt) }
  }
  const r = Math.sqrt(z * z - 1)
  const r1 = -w * (z - r)
  const r2 = -w * (z + r)
  const c1 = (v - r2 * o) / (r1 - r2)
  const c2 = o - c1
  const e1 = Math.exp(r1 * dt)
  const e2 = Math.exp(r2 * dt)
  return { x: goal + c1 * e1 + c2 * e2, v: c1 * r1 * e1 + c2 * r2 * e2 }
}

// Overshoot past the goal for a step from rest, as a fraction of the distance (0 when z >= 1).
export function springOvershoot(damping: number): number {
  if (damping >= 1) return 0
  return Math.exp((-damping * Math.PI) / Math.sqrt(1 - damping * damping))
}

// Samples a step response from rest at 0 toward 1 (every dt for duration seconds).
export function stepResponse(p: SpringParams, duration = 1.5, dt = 1 / 120): number[] {
  const out: number[] = []
  let s: SpringState = { x: 0, v: 0 }
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    out.push(s.x)
    s = stepSpring(s, 1, p, dt)
  }
  return out
}

// Seconds until a step from rest first reaches `fraction` of the way to the goal.
export function riseTime(p: SpringParams, fraction = 0.5, dt = 1 / 600): number {
  let s: SpringState = { x: 0, v: 0 }
  for (let t = 0; t < 10; t += dt) {
    if (s.x >= fraction) return t
    s = stepSpring(s, 1, p, dt)
  }
  return Infinity
}

// Seconds until a step from rest stays within `tolerance` of the goal.
export function settleTime(p: SpringParams, tolerance = 0.02, dt = 1 / 240): number {
  let s: SpringState = { x: 0, v: 0 }
  let last = 0
  for (let t = 0; t < 10; t += dt) {
    if (Math.abs(s.x - 1) > tolerance || Math.abs(s.v) > tolerance * 10) last = t + dt
    s = stepSpring(s, 1, p, dt)
  }
  return last
}

// The Luau version (compile.ts inlines it into every generated module).
export const SPRING_LUAU = `local TAU = math.pi * 2

-- Damped spring, closed-form step for a constant goal (frame-rate independent).
-- x'' = -w^2 (x - goal) - 2 z w x', w = 2 pi frequency, z = damping ratio.
local function stepSpring(x: number, v: number, goal: number, frequency: number, damping: number, dt: number): (number, number)
	if dt <= 0 then
		return x, v
	end
	local w = TAU * math.max(0.01, frequency)
	local z = math.max(0, damping)
	local o = x - goal
	if z < 0.9999 then
		local wd = w * math.sqrt(1 - z * z)
		local e = math.exp(-z * w * dt)
		local c, s = math.cos(wd * dt), math.sin(wd * dt)
		local o1 = e * (o * c + (v + z * w * o) / wd * s)
		local v1 = e * (v * c - (z * w * v + w * w * o) / wd * s)
		return goal + o1, v1
	elseif z <= 1.0001 then
		local e = math.exp(-w * dt)
		local b = v + w * o
		return goal + e * (o + b * dt), e * (v - w * b * dt)
	end
	local r = math.sqrt(z * z - 1)
	local r1, r2 = -w * (z - r), -w * (z + r)
	local c1 = (v - r2 * o) / (r1 - r2)
	local c2 = o - c1
	local e1, e2 = math.exp(r1 * dt), math.exp(r2 * dt)
	return goal + c1 * e1 + c2 * e2, c1 * r1 * e1 + c2 * r2 * e2
end`
