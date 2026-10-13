// Numbers-only match between a result and its pinned video reference: beat timing (stages of a
// scripted effect, or the anticipation / action / recovery of a clip) and, for effects, the palette.
// Used when no vision model is set up, and as the fallback when the critic gives no "match".
// Pure (tested in test/videoref.test.ts).

import type { AnimClip } from '../anim/model.ts'
import { measureClip } from '../anim/measure.ts'
import { allNodes } from '../vfx/analyze.ts'
import { prop } from '../vfx/schema.ts'
import { evalColorSequence } from '../vfx/sequence.ts'
import type { ColorSequence, VfxEffect } from '../vfx/types.ts'
import { animPhases, beatFractions, paletteMatch, stageFractions, timingMatch, toHex } from './analyze.ts'
import type { VideoRef } from './types.ts'

// The colours an effect shows (emitter / beam / trail colour at birth and mid-life), weighted.
export function effectHexColors(effect: VfxEffect, max = 6): string[] {
  const w = new Map<string, number>()
  for (const n of allNodes(effect.roots)) {
    if (n.className !== 'ParticleEmitter' && n.className !== 'Beam' && n.className !== 'Trail') continue
    const seq = prop<ColorSequence>(n, 'Color')
    for (const t of [0, 0.5]) {
      const c = evalColorSequence(seq, t)
      const hex = toHex(c[0], c[1], c[2])
      w.set(hex, (w.get(hex) ?? 0) + 1)
    }
  }
  return [...w.entries()].sort((a, b) => b[1] - a[1]).slice(0, max).map(([h]) => h)
}

export interface NumericMatch {
  match: number
  timing: number
  palette?: number
  notes: string
}

export function vfxNumericMatch(effect: VfxEffect, ref: VideoRef): NumericMatch {
  const st = stageFractions(effect.stages ?? [], effect.duration)
  const timing = st ? timingMatch(beatFractions(ref.analysis), st) : 5
  const colors = effectHexColors(effect)
  const palette = colors.length ? paletteMatch(ref.analysis.palette, colors) : 5
  const match = Math.round((timing * 0.55 + palette * 0.45) * 10) / 10
  return { match, timing, palette, notes: `Numbers-only match: beat timing ${timing}/10${st ? '' : ' (no stages)'}, palette ${palette}/10.` }
}

export function animNumericMatch(clip: AnimClip, ref: VideoRef): NumericMatch {
  const s = measureClip(clip)
  const ph = animPhases(ref.analysis)
  const frac = (a: number, b: number, c: number) => {
    const t = a + b + c || 1
    return { anticipation: a / t, action: b / t, recovery: c / t }
  }
  const timing = s.anticipation + s.action + s.recovery > 0 && ph.anticipation + ph.action + ph.recovery > 0 ? timingMatch(frac(ph.anticipation, ph.action, ph.recovery), frac(s.anticipation, s.action, s.recovery)) : 5
  return { match: timing, timing, notes: `Numbers-only match: anticipation / action / recovery timing ${timing}/10 against the reference.` }
}
