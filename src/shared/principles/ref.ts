// Video references and the principles they exemplify: what the vision model is asked to describe per
// principle, parsing its answer, a measured fallback from the analysis (beats, flashes, holds, glow,
// palette, motion), and the line "make it like this" prompts and critics get, so the writer knows
// which principles the reference is a good example of.

import { beatSeconds, animPhases } from '../videoref/analyze.ts'
import type { RefLab, VideoRef } from '../videoref/types.ts'
import { principle, principlesFor } from './catalog.ts'

export interface RefPrincipleNote {
  id: string
  note: string
  // From the vision model or measured from the analysis.
  source?: 'vision' | 'measured'
}

const f2 = (x: number) => x.toFixed(2)

// Appended to the reference vision prompt (one line per lab, ids only, to stay short).
export function refPrincipleAsk(lab: RefLab): string {
  const ids = principlesFor(lab === 'anim' ? 'anim' : 'vfx').map((p) => p.id)
  return `Also add "principles":[{"id":"...","note":"one sentence: how this clip shows it (with times)"}] for the ${lab === 'anim' ? 'animation' : 'VFX'} principles it clearly exemplifies (3-6), from: ${ids.join(', ')}.`
}

export function parseRefPrinciples(v: unknown, lab: RefLab): RefPrincipleNote[] {
  if (!Array.isArray(v)) return []
  const domain = lab === 'anim' ? 'anim' : 'vfx'
  const out: RefPrincipleNote[] = []
  for (const x of v as Record<string, unknown>[]) {
    const id = String(x?.id ?? '').trim()
    if (principle(id)?.domain !== domain || out.some((o) => o.id === id) || typeof x.note !== 'string') continue
    out.push({ id, note: x.note.trim().slice(0, 240), source: 'vision' })
  }
  return out.slice(0, 8)
}

// Principles the measured analysis shows (no model).
export function measuredRefPrinciples(video: Pick<VideoRef, 'lab' | 'analysis'>): RefPrincipleNote[] {
  const a = video.analysis
  const s = beatSeconds(a)
  const out: RefPrincipleNote[] = []
  const add = (id: string, note: string) => out.push({ id, note, source: 'measured' })
  const rel = s.release + s.impact
  if (video.lab === 'anim') {
    const ph = animPhases(a)
    if (ph.anticipation > 0.05 && ph.action > 0) add('anticipation', `${f2(ph.anticipation)} s windup before a ${f2(ph.action)} s action (${(ph.anticipation / ph.action).toFixed(1)}x)`)
    const fast = a.timeline.filter((x) => x.kind === 'fast').length
    if (ph.holds > 0.05 || fast) add('timing', `${a.timeline.filter((x) => x.kind === 'hold').length} holds (${f2(ph.holds)} s) between ${fast} fast moves`)
    if (ph.recovery > 0.15) add('follow-through', `${f2(ph.recovery)} s of recovery after the action`)
    if (a.flashes.length || a.peaks.some((p) => p.strength > 0.8)) add('weight-impact', `sharp motion peak${a.flashes.length ? ` and a flash at ${f2(a.flashes[0])} s` : ''} on the hit`)
  } else {
    if (s.anticipation > 0.05 && rel > 0) add('fx-anticipation', `${f2(s.anticipation)} s gathering beat before a ${f2(rel)} s release (${(s.anticipation / rel).toFixed(1)}x)`)
    if (a.flashes.length || a.glow.level === 'strong') add('fx-contrast', `${a.glow.level === 'none' ? 'a bright core' : `${a.glow.level} bloom around a bright core`}${a.flashes.length ? `; flash frame${a.flashes.length === 1 ? '' : 's'} at ${a.flashes.slice(0, 3).map(f2).join(', ')} s` : ''}`)
    if (s.dissipate > 0.15) add('fx-dissipation', `${f2(s.dissipate)} s dissipate after the impact`)
    if (a.segments.length >= 3) add('fx-timing', `beats ${a.segments.map((x) => `${x.label} ${f2(x.end - x.start)} s`).join(', ')}`)
    const hues = a.segments.filter((x) => x.palette.length).map((x) => `${x.label} ${x.palette[0].hex}`)
    if (hues.length >= 2) add('fx-hue', `dominant colour per beat: ${hues.join(', ')}`)
    if (a.motion.direction !== 'still') add('fx-shape', `${a.motion.direction === 'outward' ? 'expands outward (burst / ring)' : a.motion.direction === 'inward' ? 'contracts inward' : `travels ${a.motion.direction}`}, ${Math.round(a.motion.peakCoverage * 100)}% of the frame at its peak`)
  }
  return out
}

// Vision notes first, then measured ones for principles the vision model did not describe.
export function refPrinciples(video: Pick<VideoRef, 'lab' | 'analysis' | 'vision'>): RefPrincipleNote[] {
  const vision = ((video.vision as { principles?: RefPrincipleNote[] } | undefined)?.principles ?? []).map((p) => ({ ...p, source: p.source ?? ('vision' as const) }))
  const measured = measuredRefPrinciples(video).filter((m) => !vision.some((v) => v.id === m.id))
  return [...vision, ...measured]
}

export function refPrinciplesText(video: Pick<VideoRef, 'lab' | 'analysis' | 'vision'>, max = 6): string {
  const list = refPrinciples(video).slice(0, max)
  if (!list.length) return ''
  return `Principles this reference exemplifies (match these first): ${list.map((p) => `${p.id}: ${p.note}`).join(' | ')}`
}
