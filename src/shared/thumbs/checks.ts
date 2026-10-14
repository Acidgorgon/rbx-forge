// Code checks for the thumbnail principles (shared/principles/thumbCatalog.ts) from the image stats
// and the small-size report. They go to the critic as measurements and are merged with its scores
// (principles/score.ts); with no vision model they are the whole critique. Pure.

import type { PrincipleCheck } from '../principles/types.ts'
import type { SmallSizeReport, ThumbImageStats } from './types.ts'

const r1 = (x: number) => Math.round(x * 10) / 10
const clamp10 = (x: number) => Math.max(0, Math.min(10, x))
// Linear ramp: lo -> 0, hi -> 10.
const ramp = (x: number, lo: number, hi: number) => clamp10(((x - lo) / (hi - lo)) * 10)

export function thumbChecks(stats: ThumbImageStats, report: SmallSizeReport): PrincipleCheck[] {
  const out: PrincipleCheck[] = []

  const read = r1(0.55 * report.legibility160 + 0.25 * report.legibility256 + 2 * report.detailKept)
  out.push({
    id: 'th-readable',
    score: clamp10(read),
    note: `legibility ${report.legibility160.toFixed(1)} at 160x90, ${report.legibility256.toFixed(1)} at 256x144; ${Math.round(report.detailKept * 100)}% of strong edges survive`,
    ...(read < 6 ? { fix: 'Bigger subject and text, thick dark outlines, fewer small details' } : {})
  })

  // Clutter: past ~22% strong-edge pixels at 256x144 the frame reads as noise.
  const clutter = stats.edgeDensity > 0.22 ? Math.min(3, (stats.edgeDensity - 0.22) * 20) : 0
  const focal = r1(clamp10(0.6 * report.focal160 + 0.4 * report.focal256 + (stats.centerFocus > 1.15 ? 0.8 : 0) - clutter))
  out.push({
    id: 'th-focal',
    score: focal,
    note: `focal contrast ${report.focal160.toFixed(1)} (160) / ${report.focal256.toFixed(1)} (256), centre focus x${stats.centerFocus.toFixed(2)}, edge density ${Math.round(stats.edgeDensity * 100)}%`,
    ...(focal < 6 ? { fix: clutter > 0 ? 'Simplify the backdrop (blur or darken it) so one subject owns the frame' : 'Make one subject larger and brighter than everything else' } : {})
  })

  const contrast = r1(ramp(stats.contrast, 0.08, 0.26))
  out.push({
    id: 'th-contrast',
    score: contrast,
    note: `RMS luma contrast ${stats.contrast.toFixed(3)}`,
    ...(contrast < 6 ? { fix: 'Push the value range: darker backdrop, rim light or outline on the subject' } : {})
  })

  const popMin = Math.min(report.popDark, report.popLight)
  const pop = r1(clamp10(ramp(popMin, 0.2, 0.55) * 0.7 + ramp(stats.vivid, 0.05, 0.35) * 0.3))
  out.push({
    id: 'th-pop',
    score: pop,
    note: `stands out ${Math.round(report.popDark * 100)}% on the dark page, ${Math.round(report.popLight * 100)}% on the light page; ${Math.round(stats.vivid * 100)}% vivid pixels`,
    ...(pop < 6 ? { fix: report.popDark < report.popLight ? 'Lift the darks and add saturated colour: it sinks into the dark theme' : 'Add saturated colour and darker edges: it washes out on the light theme' } : {})
  })

  const safe = r1(clamp10(10 - Math.max(0, report.bottomLoad - 0.45) * 25))
  out.push({
    id: 'th-safe-area',
    score: safe,
    note: `bottom 15% carries ${Math.round(report.bottomLoad * 200)}% of the average visual weight`,
    ...(safe < 7 ? { fix: 'Move text and the subject up; keep the bottom strip quiet' } : {})
  })
  return out
}

// A one-number code score (no critic): the plain mean of the checks.
export function codeOverall(checks: PrincipleCheck[]): number {
  return checks.length ? r1(checks.reduce((s, c) => s + c.score, 0) / checks.length) : 0
}
