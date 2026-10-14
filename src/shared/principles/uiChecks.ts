// Code checks for the UI motion principles (uiCatalog.ts): measured on the effect spec itself and on
// its simulated timeline (shared/uimotion/engine.ts: the same springs the generated Luau runs), so
// they cost nothing and agree with what the player sees. Scores are 0..10.

import { defaultScript, overshootAfter, responseTime, simulate } from '../uimotion/engine.ts'
import { springOvershoot } from '../uimotion/spring.ts'
import { effectsOf, usedKinds, type MotionEffect, type MotionSpec } from '../uimotion/spec.ts'
import type { PrincipleCheck } from './types.ts'

const r1 = (x: number) => Math.round(x * 10) / 10
const clamp10 = (x: number) => Math.max(0, Math.min(10, x))
const ms = (s: number) => `${Math.round(s * 1000)} ms`
const find = <K extends MotionEffect['kind']>(fx: MotionEffect[], kind: K) => fx.find((e) => e.kind === kind) as Extract<MotionEffect, { kind: K }> | undefined

// Linear score: `good` or better is 10, `bad` or worse is 2.
function band(value: number, good: number, bad: number): number {
  if (good < bad) return value <= good ? 10 : value >= bad ? 2 : 10 - ((value - good) / (bad - good)) * 8
  return value >= good ? 10 : value <= bad ? 2 : 10 - ((good - value) / (good - bad)) * 8
}

export function uiPrincipleChecks(spec: MotionSpec, path = spec.targets[0]?.path ?? ''): PrincipleCheck[] {
  const fx = effectsOf(spec, path)
  const kinds = usedKinds(spec)
  const out: PrincipleCheck[] = []
  if (!fx.length) return out
  const tl = simulate(spec, path, defaultScript(kinds), { dt: 1 / 120 })
  const hover = find(fx, 'hover')
  const press = find(fx, 'press')
  const pop = find(fx, 'pop')
  const squash = find(fx, 'squash')

  // ui-responsiveness: time to half of the hover / press response.
  {
    const times: { what: string; t: number }[] = []
    const h = responseTime(tl, 'enter')
    const p = responseTime(tl, 'down')
    if (h != null) times.push({ what: 'hover', t: h })
    if (p != null) times.push({ what: 'press', t: p })
    if (!times.length) {
      out.push({ id: 'ui-responsiveness', score: kinds.has('ripple') || kinds.has('shine') || kinds.has('glow') ? 6 : 3, note: 'no scale response on hover or press; feedback relies on colour / overlay effects only', fix: 'add a press scale (0.92..0.96) with a fast spring (frequency 6+)' })
    } else {
      const worst = times.reduce((a, b) => (b.t > a.t ? b : a))
      const score = band(worst.t, 0.06, 0.2)
      out.push({ id: 'ui-responsiveness', score: r1(score), note: times.map((x) => `${x.what} half-response ${ms(x.t)}`).join(', '), ...(score < 8 ? { fix: `raise the ${worst.what} spring frequency (half-response should be under 100 ms)` } : {}) })
    }
  }

  // ui-anticipation: press-in depth while held, before the release pop.
  {
    const depth = Math.max(press ? 1 - press.scale : 0, squash ? squash.amount * 0.6 : 0)
    if (!press && !squash) out.push({ id: 'ui-anticipation', score: pop ? 3 : 5, note: pop ? 'pop on release with no press-in while held' : 'no press-in while held', fix: 'add a press scale of about 0.94 (or a small squash) so the release reads as a result' })
    else {
      const score = depth < 0.015 ? 4 : depth > 0.18 ? 5 : 9.5
      out.push({ id: 'ui-anticipation', score, note: `held: ${Math.round(depth * 100)}% press-in${pop ? `, then a ${Math.round(pop.amount * 100)}% pop` : ''}`, ...(score < 8 ? { fix: depth < 0.015 ? 'press in deeper (scale 0.92..0.96)' : 'press in less (no deeper than ~0.85 scale)' } : {}) })
    }
  }

  // ui-overshoot: measured overshoot after hover and release, and the damping ratios.
  {
    const parts: string[] = []
    let worst = 0
    const hov = overshootAfter(tl, 'enter')
    const rel = overshootAfter(tl, 'up')
    if (hover) (parts.push(`hover ${Math.round(hov * 100)}%`), (worst = Math.max(worst, hov)))
    if (press || pop) (parts.push(`release ${Math.round(rel * 100)}%`), (worst = Math.max(worst, pop ? rel * 0.6 : rel)))
    const springs = fx.filter((e): e is MotionEffect & { damping: number } => 'damping' in e)
    const lowest = springs.reduce((m, e) => Math.min(m, e.damping), 1)
    const ring = springOvershoot(lowest)
    const score = Math.min(band(worst, 0.15, 0.45), band(ring, 0.3, 0.7))
    out.push({ id: 'ui-overshoot', score: r1(score), note: `${parts.join(', ') || 'no scale springs'}; lowest damping ${lowest.toFixed(2)} (${Math.round(ring * 100)}% first overshoot)`, ...(score < 8 ? { fix: 'raise damping to 0.55..0.8 (or lower the pop amount) so it settles in one bounce' } : {}) })
  }

  // ui-consistency: frequency / damping spread across the interaction springs.
  {
    const springs = [hover, press, pop, squash].filter(Boolean) as (MotionEffect & { frequency: number; damping: number })[]
    if (springs.length < 2) out.push({ id: 'ui-consistency', score: 8, note: 'one interaction spring' })
    else {
      const fs = springs.map((s) => s.frequency)
      const ds = springs.map((s) => s.damping)
      const fRatio = Math.max(...fs) / Math.max(0.1, Math.min(...fs))
      const dSpread = Math.max(...ds) - Math.min(...ds)
      const score = Math.min(band(fRatio, 2.2, 4.5), band(dSpread, 0.35, 0.8))
      out.push({ id: 'ui-consistency', score: r1(score), note: `frequency ${Math.min(...fs)}..${Math.max(...fs)} Hz (x${fRatio.toFixed(1)}), damping ${Math.min(...ds)}..${Math.max(...ds)}`, ...(score < 8 ? { fix: 'bring the springs into one family (similar damping, frequencies within ~2x)' } : {}) })
    }
  }

  // ui-readability: scale range, tilt, float, shine and glow strength.
  {
    let lo = 1
    let hi = 1
    for (const s of tl.samples) {
      lo = Math.min(lo, s.values.scale * Math.min(s.values.sx, s.values.sy))
      hi = Math.max(hi, s.values.scale * Math.max(s.values.sx, s.values.sy))
    }
    const issues: string[] = []
    let score = Math.min(band(hi, 1.15, 1.35), band(lo, 0.85, 0.65))
    const tilt = find(fx, 'tilt')
    if (tilt && tilt.angle > 8) (issues.push(`tilt ${tilt.angle}°`), (score = Math.min(score, band(tilt.angle, 8, 18))))
    const float = find(fx, 'float')
    if (float && float.amplitude > 6) (issues.push(`float ${float.amplitude}px`), (score = Math.min(score, band(float.amplitude, 6, 16))))
    const shine = find(fx, 'shine')
    if (shine && shine.intensity > 0.7) (issues.push(`shine ${Math.round(shine.intensity * 100)}%`), (score = Math.min(score, band(shine.intensity, 0.7, 1))))
    const glow = find(fx, 'glow')
    if (glow && glow.thickness > 8) (issues.push(`glow ${glow.thickness}px`), (score = Math.min(score, band(glow.thickness, 8, 16))))
    out.push({ id: 'ui-readability', score: r1(score), note: `scale ${lo.toFixed(2)}..${hi.toFixed(2)}${issues.length ? `; ${issues.join(', ')}` : ''}`, ...(score < 8 ? { fix: 'keep scale within 0.85..1.15 and tone down tilt / float / shine so the label stays legible' } : {}) })
  }

  // ui-reduced-motion
  {
    const decorative = fx.filter((e) => e.kind === 'float' || e.kind === 'tilt' || (e.kind === 'shine' && e.trigger === 'idle') || (e.kind === 'glow' && e.period > 0))
    if (spec.reducedMotion === 'respect') out.push({ id: 'ui-reduced-motion', score: 10, note: `respects GuiService.ReducedMotionEnabled${decorative.length ? ` (drops ${decorative.map((e) => e.kind).join(', ')})` : ''}` })
    else out.push({ id: 'ui-reduced-motion', score: decorative.length ? 2 : 5, note: `ignores the reduced-motion setting${decorative.length ? ` with ${decorative.map((e) => e.kind).join(', ')} always running` : ''}`, fix: 'set reducedMotion to "respect"' })
  }
  return out.map((c) => ({ ...c, score: clamp10(c.score) }))
}

// Per-principle scores for a spec, as a { id: score } map (weight learning from ratings).
export function uiPrincipleScores(spec: MotionSpec): Record<string, number> {
  return Object.fromEntries(uiPrincipleChecks(spec).map((c) => [c.id, c.score]))
}
