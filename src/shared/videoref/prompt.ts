// Prompt assembly for video references: the vision summary request (critic tier, contact sheet +
// key frames), the reference block compose prompts get ("make it like this"), the match section of
// the critic (rendered beats next to the reference key frames), and the timing / palette hints that
// feed the learned style (marked as from a video). Also the sanitiser for analysis data coming from
// the renderer. Pure (tested in test/videoref.test.ts).

import { animPhases, beatSeconds, paletteText } from './analyze.ts'
import type { PaletteColor, RefBeatLabel, RefLab, RefSegment, RefVision, VideoRef, VideoRefAnalysis } from './types.ts'
import { REF_BEATS } from './types.ts'
import { parseRefPrinciples, refPrincipleAsk, refPrinciplesText } from '../principles/ref.ts'

const f2 = (x: number) => x.toFixed(2)

// ------------------------------------------------------------------ text summaries

export function segmentsText(a: Pick<VideoRefAnalysis, 'segments' | 'flashes'>): string {
  const segs = a.segments.map((s) => `${s.label} ${f2(s.start)}-${f2(s.end)} s (energy ${Math.round(s.energy * 100)}%${a.flashes.some((t) => t >= s.start && t < s.end) ? ', flash' : ''})`)
  return segs.join(', ') || 'no clear beats'
}

export function timelineText(a: Pick<VideoRefAnalysis, 'timeline'>): string {
  return a.timeline.map((s) => `${s.kind} ${f2(s.start)}-${f2(s.end)}`).join(', ')
}

export function motionText(a: Pick<VideoRefAnalysis, 'motion'>): string {
  const m = a.motion
  const dir = m.direction === 'still' ? 'stays in place' : m.direction === 'outward' ? 'expands outward' : m.direction === 'inward' ? 'contracts inward' : `travels ${m.direction}${m.angle != null ? ` (${m.angle} deg)` : ''}`
  return `${dir}; covers about ${Math.round(m.peakCoverage * 100)}% of the frame at its peak (${Math.round(m.meanCoverage * 100)}% on average)`
}

export function glowText(a: Pick<VideoRefAnalysis, 'glow'>): string {
  return a.glow.level === 'none' ? 'little or no bloom' : `${a.glow.level} bloom (halo ${Math.round(a.glow.bloom * 100)}% around the brightest parts)`
}

// One line for library cards and the entry description.
export function describeAnalysis(a: VideoRefAnalysis, lab: RefLab): string {
  const beats = a.segments.map((s) => s.label).join(' > ')
  const pal = a.palette.slice(0, 3).map((p) => p.hex).join(' ')
  return lab === 'anim'
    ? `Video reference, ${f2(a.duration)} s: ${beats || 'one beat'}; ${a.timeline.filter((s) => s.kind === 'hold').length} holds, ${a.timeline.filter((s) => s.kind === 'fast').length} fast moves; motion ${motionText(a)}.`
    : `Video reference, ${f2(a.duration)} s: ${beats || 'one beat'}${a.flashes.length ? `, ${a.flashes.length} flash frame${a.flashes.length === 1 ? '' : 's'}` : ''}; palette ${pal}; ${glowText(a)}.`
}

// ------------------------------------------------------------------ vision summary

export const REF_VISION_SYSTEM_VFX = `You are a senior Roblox VFX artist breaking down a reference clip (an anime scene, another game's effect, a screen recording) so it can be rebuilt with ParticleEmitters, Beams, Trails, lights and meshes.
You get a contact sheet (frames in time order, left to right, top to bottom, with times) and the key frames of each beat, plus measured numbers (beats, palette, bloom, motion).
Describe only what is visible. Answer with JSON only:
{"summary":"two sentences: what the effect is and how it plays","effect":"short name","layers":[{"name":"core|glow|sparks|smoke|ring|trail|beam|debris|...","shape":"...","color":"...","motion":"...","timing":"which beats"}],"shapes":["arc","ring",...],"motion":"how it moves on screen","colors":"palette and value structure","roblox":"how to build it in Roblox (which instances, textures, key properties)"}`

export const REF_VISION_SYSTEM_ANIM = `You are a senior game animator breaking down a reference clip (an anime scene, another game's move, a recording) so it can be animated on a blocky Roblox R15 / R6 character.
You get a contact sheet (frames in time order, with times) and the key frames of each beat, plus measured numbers (beats, holds versus fast motion).
Describe the body only (ignore effects and camera unless they matter for the timing). Answer with JSON only:
{"summary":"two sentences: the move and its feel","poses":[{"beat":"anticipation|release|impact|dissipate|flash","pose":"body, line of action, arms, legs, weight"}],"timing":"the timing feel (snappy, heavy, floaty...), where it holds and where it is fast","motion":"where the body travels"}`

export function refVisionSystem(lab: RefLab): string {
  return `${lab === 'anim' ? REF_VISION_SYSTEM_ANIM : REF_VISION_SYSTEM_VFX}\n${refPrincipleAsk(lab)}`
}

export function refVisionPrompt(ref: Pick<VideoRef, 'lab' | 'analysis' | 'source' | 'trim'>, name: string, keyLabels: string[]): string {
  const a = ref.analysis
  return [
    `Reference "${name}" (${ref.source.name}, ${f2(ref.trim.start)}-${f2(ref.trim.end)} s of ${f2(ref.source.duration)} s; analysed ${a.frames.length} frames at ${a.fps} fps).`,
    `Image 1 is the contact sheet; images 2+ are the key frames: ${keyLabels.map((l, i) => `${i + 2} = ${l}`).join(', ') || 'none'}.`,
    `Measured beats: ${segmentsText(a)}.`,
    ref.lab === 'anim' ? `Holds and fast motion: ${timelineText(a)}.` : `Palette: ${paletteText(a.palette)}. Glow: ${glowText(a)}.`,
    `Motion: ${motionText(a)}.`
  ].join('\n')
}

function extractJson(raw: string): Record<string, unknown> {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(raw)
  const text = fenced ? fenced[1] : raw
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the vision model did not answer with JSON')
  return JSON.parse(text.slice(start, end + 1)) as Record<string, unknown>
}

const str = (v: unknown, max = 600) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined)

// The vision model's JSON -> RefVision (tolerant: missing fields are left out; prose without JSON
// becomes the summary).
export function parseRefVision(raw: string, at = Date.now(), model?: string, lab?: RefLab): RefVision {
  let data: Record<string, unknown>
  try {
    data = extractJson(raw)
  } catch {
    const text = raw.trim()
    if (!text) throw new Error('empty answer from the vision model')
    return { summary: text.slice(0, 600), at, ...(model ? { model } : {}) }
  }
  const out: RefVision = { summary: str(data.summary) ?? '', at, ...(model ? { model } : {}) }
  for (const k of ['effect', 'motion', 'colors', 'roblox', 'timing'] as const) {
    const v = str(data[k], 800)
    if (v) out[k] = v
  }
  if (Array.isArray(data.layers))
    out.layers = (data.layers as Record<string, unknown>[])
      .filter((l) => l && typeof l === 'object' && typeof l.name === 'string')
      .slice(0, 10)
      .map((l) => ({ name: str(l.name, 60)!, ...(str(l.shape, 160) ? { shape: str(l.shape, 160) } : {}), ...(str(l.color, 160) ? { color: str(l.color, 160) } : {}), ...(str(l.motion, 160) ? { motion: str(l.motion, 160) } : {}), ...(str(l.timing, 160) ? { timing: str(l.timing, 160) } : {}) }))
  if (Array.isArray(data.shapes)) out.shapes = (data.shapes as unknown[]).map((s) => str(s, 40)).filter((s): s is string => !!s).slice(0, 8)
  if (Array.isArray(data.poses))
    out.poses = (data.poses as Record<string, unknown>[])
      .filter((p) => p && typeof p === 'object' && typeof p.pose === 'string')
      .slice(0, 8)
      .map((p) => ({ beat: str(p.beat, 40) ?? '', pose: str(p.pose, 300)! }))
  const principles = parseRefPrinciples(data.principles, lab ?? (out.poses?.length ? 'anim' : 'vfx'))
  if (principles.length) out.principles = principles
  if (!out.summary) out.summary = out.effect ?? out.timing ?? 'No summary.'
  return out
}

export function visionText(v: RefVision | undefined, lab: RefLab): string {
  if (!v) return ''
  const lines = [`Vision summary: ${v.summary}`]
  if (v.effect) lines.push(`What it is: ${v.effect}`)
  if (v.layers?.length) lines.push(`Layers: ${v.layers.map((l) => `${l.name}${l.shape ? ` (${l.shape})` : ''}${l.color ? `, ${l.color}` : ''}${l.motion ? `, ${l.motion}` : ''}${l.timing ? `, ${l.timing}` : ''}`).join('; ')}`)
  if (v.shapes?.length) lines.push(`Shapes: ${v.shapes.join(', ')}`)
  if (v.poses?.length) lines.push(`Poses per beat: ${v.poses.map((p) => `${p.beat}: ${p.pose}`).join(' | ')}`)
  if (v.timing) lines.push(`Timing feel: ${v.timing}`)
  if (v.motion) lines.push(`Motion: ${v.motion}`)
  if (v.colors && lab === 'vfx') lines.push(`Colours: ${v.colors}`)
  if (v.roblox && lab === 'vfx') lines.push(`Roblox build notes: ${v.roblox}`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ compose

// The reference block of a compose prompt ("make it like this"): the measured beats scaled to a
// suggested duration, palette per beat, glow, motion, the vision summary, and what the attached
// key frames are.
export function refComposeBlock(ref: VideoRef, name: string, opts: { keyLabels?: string[]; notes?: string } = {}): string {
  const a = ref.analysis
  const lab = ref.lab
  const lines = [
    `Make it like the pinned reference video "${name}" (${f2(a.duration)} s analysed). Match its beats, timing, shapes${lab === 'vfx' ? ', palette and glow' : ' and poses'}; do not copy anything it does not show.`,
    `Beats measured from motion energy and brightness spikes: ${segmentsText(a)}.`
  ]
  const s = beatSeconds(a)
  if (lab === 'vfx') {
    lines.push(`Stage the script with fx:stage at these times (scale them together if the effect needs to be longer or shorter): ${REF_BEATS.filter((k) => s[k] > 0).map((k) => `${k} ${f2(a.segments.find((x) => x.label === k)!.start)} s (${f2(s[k])} s long)`).join(', ')}.`)
    lines.push(`Palette overall: ${paletteText(a.palette)}.`)
    for (const seg of a.segments) if (seg.palette.length) lines.push(`- ${seg.label}: ${paletteText(seg.palette)}`)
    lines.push(`Glow: ${glowText(a)}${a.glow.level === 'strong' ? ' (bright additive core, LightEmission near 1, a wide soft glow layer)' : ''}.`)
    if (a.flashes.length) lines.push(`Flash frames at ${a.flashes.map(f2).join(', ')} s: a one- or two-frame bright pop (a big short-lived glow or a light Brightness spike).`)
  } else {
    const ph = animPhases(a)
    lines.push(`As animation timing: anticipation ${f2(ph.anticipation)} s, action ${f2(ph.action)} s, recovery ${f2(ph.recovery)} s, holds ${f2(ph.holds)} s in total (about ${Math.round(ph.anticipation * 30)} / ${Math.round(ph.action * 30)} / ${Math.round(ph.recovery * 30)} frames at 30 fps).`)
    lines.push(`Holds versus fast motion: ${timelineText(a)}.`)
  }
  lines.push(`Screen-space motion: ${motionText(a)}.`)
  const v = visionText(ref.vision, lab)
  if (v) lines.push(v)
  const pr = refPrinciplesText(ref)
  if (pr) lines.push(pr)
  if (opts.notes) lines.push(`User notes on the reference: ${opts.notes.slice(0, 400)}`)
  if (opts.keyLabels?.length) lines.push(`The attached images are the reference's key frames in order: ${opts.keyLabels.join(', ')}.`)
  return lines.join('\n')
}

// ------------------------------------------------------------------ critique

export const REF_MATCH_TEXT = `A reference video is pinned for this result ("make it like this"). The images after the rendered frames are the reference's key frames in beat order. Compare each rendered beat with the reference key frame of the same beat side by side: timing of the beats, the shapes and silhouette, the motion direction and size on screen, and (for effects) the palette and glow.
Add to your JSON: "match": 0-10 (how closely the result follows the reference; 7 = clearly the same idea and timing) and "matchNotes": "one sentence on the biggest difference". Prefer changes that move the result toward the reference.`

export function refCritiqueBlock(ref: VideoRef, name: string, keyLabels: string[]): string {
  const a = ref.analysis
  const lines = [
    `Pinned reference "${name}": ${segmentsText(a)}.`,
    ref.lab === 'vfx' ? `Reference palette ${paletteText(a.palette.slice(0, 4))}; ${glowText(a)}.` : `Reference holds / fast motion: ${timelineText(a)}.`,
    `Reference motion: ${motionText(a)}.`,
    ref.vision ? `Reference summary: ${ref.vision.summary}` : '',
    refPrinciplesText(ref, 4),
    `Reference key frames attached after the rendered frames: ${keyLabels.join(', ')}.`
  ]
  return lines.filter(Boolean).join('\n')
}

// The critic's "match" and "matchNotes" (null when it gave none).
export function parseMatch(raw: string): { match: number; notes?: string } | null {
  try {
    const data = extractJson(raw)
    const m = Number(data.match)
    if (!Number.isFinite(m)) return null
    const notes = str(data.matchNotes, 300)
    return { match: Math.max(0, Math.min(10, Math.round(m * 10) / 10)), ...(notes ? { notes } : {}) }
  } catch {
    return null
  }
}

// With a pinned reference the overall score is part rubric, part match.
export const MATCH_WEIGHT = 0.35
export function blendMatch(overall: number, match: number): number {
  return Math.round((overall * (1 - MATCH_WEIGHT) + match * MATCH_WEIGHT) * 10) / 10
}

// ------------------------------------------------------------------ learning (timing + palette only)

export interface VideoTimingHint {
  samples: number
  // Median seconds per beat.
  beats: Record<RefBeatLabel, number>
  palette: string[]
}

function med(xs: number[]): number {
  if (!xs.length) return 0
  const s = [...xs].sort((a, b) => a - b)
  const m = Math.floor(s.length / 2)
  return Math.round((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) * 1000) / 1000
}

type HasVideo = { tags: string[]; quality?: string; rating?: string; video?: VideoRef }

// Timing and palette from the usable video references tagged `tag` ('*' = all). Nothing else of a
// video feeds the learned style.
export function videoHints(tag: string, entries: HasVideo[]): VideoTimingHint | null {
  const vids = entries.filter((e) => e.video && (tag === '*' || e.tags.includes(tag)) && e.quality !== 'avoid' && e.rating !== 'down')
  if (!vids.length) return null
  const per = vids.map((e) => beatSeconds(e.video!.analysis))
  const beats = Object.fromEntries(REF_BEATS.map((k) => [k, med(per.map((p) => p[k]).filter((x) => x > 0))])) as Record<RefBeatLabel, number>
  const count = new Map<string, number>()
  for (const e of vids) for (const c of e.video!.analysis.palette.slice(0, 3)) count.set(c.hex, (count.get(c.hex) ?? 0) + c.share)
  const palette = [...count.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([h]) => h)
  return { samples: vids.length, beats, palette }
}

export function videoHintNote(h: VideoTimingHint, lab: RefLab): string {
  const n = `${h.samples} video reference${h.samples === 1 ? '' : 's'}`
  if (lab === 'anim') {
    const action = h.beats.release + h.beats.impact
    return `From ${n} (timing only, not poses): anticipation about ${Math.round(h.beats.anticipation * 30)} frames, action ${Math.round(action * 30)} frames, recovery ${Math.round(h.beats.dissipate * 30)} frames at 30 fps.`
  }
  return `From ${n} (timing and palette only): ${REF_BEATS.filter((k) => h.beats[k] > 0).map((k) => `${k} ~${f2(h.beats[k])} s`).join(', ')}${h.palette.length ? `; palette ${h.palette.join(', ')}` : ''}.`
}

// ------------------------------------------------------------------ sanitising renderer data

const num = (v: unknown, lo: number, hi: number, d = 0) => {
  const n = Number(v)
  return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d
}
const HEX = /^#[0-9a-f]{6}$/i
const pal = (v: unknown, max = 8): PaletteColor[] => (Array.isArray(v) ? v.filter((c) => c && HEX.test(String(c.hex))).slice(0, max).map((c) => ({ hex: String(c.hex).toLowerCase(), share: num(c.share, 0, 1) })) : [])

// Analysis data from the renderer -> a bounded, well-formed VideoRefAnalysis.
export function sanitizeAnalysis(raw: unknown): VideoRefAnalysis {
  const a = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>
  const duration = num(a.duration, 0, 600)
  if (!(duration > 0)) throw new Error('the analysis has no duration')
  const t = (v: unknown) => num(v, 0, duration)
  const frames = (Array.isArray(a.frames) ? a.frames : []).slice(0, 400).map((f: any) => ({ t: t(f?.t), motion: num(f?.motion, 0, 1), brightness: num(f?.brightness, 0, 1), bright: num(f?.bright, 0, 1), active: num(f?.active, 0, 1) }))
  const segments: RefSegment[] = (Array.isArray(a.segments) ? a.segments : [])
    .filter((s: any) => REF_BEATS.includes(s?.label))
    .slice(0, 8)
    .map((s: any) => ({ label: s.label, start: t(s.start), end: t(s.end), peak: t(s.peak), energy: num(s.energy, 0, 1), palette: pal(s.palette, 6) }))
  const motion = a.motion ?? {}
  const dirs = ['left', 'right', 'up', 'down', 'outward', 'inward', 'still']
  const box = motion.bbox && typeof motion.bbox === 'object' ? { x: num(motion.bbox.x, 0, 1), y: num(motion.bbox.y, 0, 1), w: num(motion.bbox.w, 0, 1), h: num(motion.bbox.h, 0, 1) } : null
  const glow = a.glow ?? {}
  return {
    version: 1,
    duration,
    fps: num(a.fps, 0, 120),
    width: Math.round(num(a.width, 0, 8192)),
    height: Math.round(num(a.height, 0, 8192)),
    frames,
    peaks: (Array.isArray(a.peaks) ? a.peaks : []).slice(0, 64).map((p: any) => ({ t: t(p?.t), strength: num(p?.strength, 0, 1) })),
    flashes: (Array.isArray(a.flashes) ? a.flashes : []).slice(0, 64).map(t),
    segments,
    palette: pal(a.palette),
    glow: { bloom: num(glow.bloom, 0, 1), peakBright: num(glow.peakBright, 0, 1), level: ['none', 'soft', 'strong'].includes(glow.level) ? glow.level : 'none' },
    motion: { direction: dirs.includes(motion.direction) ? motion.direction : 'still', angle: motion.angle == null ? null : num(motion.angle, -360, 360), peakCoverage: num(motion.peakCoverage, 0, 1), meanCoverage: num(motion.meanCoverage, 0, 1), bbox: box, travel: num(motion.travel, 0, 2) },
    timeline: (Array.isArray(a.timeline) ? a.timeline : []).filter((s: any) => ['hold', 'move', 'fast'].includes(s?.kind)).slice(0, 200).map((s: any) => ({ kind: s.kind, start: t(s.start), end: t(s.end) })),
    keyFrames: (Array.isArray(a.keyFrames) ? a.keyFrames : []).slice(0, 8).map((k: any) => ({ t: t(k?.t), label: String(k?.label ?? 'key').slice(0, 24), index: Math.round(num(k?.index, 0, 400)) }))
  }
}
