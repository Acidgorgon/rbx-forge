// Code checks for the measurable VFX principles (no model): value contrast (core against edge
// luminance in the simulated peak frame), layering (layer count and primary / secondary / tertiary
// role coverage), dissipation (fade curves reach full transparency smoothly), break-up (size, rotation,
// lifetime and speed variance), timing (size curves peak early; varied beat lengths), hue shifting
// (colour over life, number of hues), anticipation (a gathering beat before the release) and the
// performance budget (analyze.ts perf guard). Reuses the VFX Lab's simulation and analysis code.

import { allNodes, emitterRole, luminance, nodeRole, perfScore, perfWarnings, type LayerRole } from '../vfx/analyze.ts'
import { prop } from '../vfx/schema.ts'
import { curveShape, evalColorSequence, evalNumberSequence } from '../vfx/sequence.ts'
import { flipbookFrames, prepareEffect, simulate } from '../vfx/simulate.ts'
import type { ColorSequence, NumberRange, NumberSequence, Rgb, VfxEffect } from '../vfx/types.ts'
import type { PrincipleCheck } from './types.ts'

const r1 = (x: number) => Math.round(x * 10) / 10
const s10 = (x: number) => r1(Math.max(0, Math.min(10, x)))
const pct = (x: number) => `${Math.round(x * 100)}%`

const emitters = (e: VfxEffect) => allNodes(e.roots).filter((n) => n.className === 'ParticleEmitter')

// Times to sample for the peak frame: inside each stage for sequences, else spread over the play.
function sampleTimes(e: VfxEffect): number[] {
  const D = Math.max(0.1, e.duration || 2)
  const n = 12
  return Array.from({ length: n }, (_, i) => Math.round(D * ((i + 0.5) / n) * 1000) / 1000)
}

export interface ContrastStats {
  t: number
  particles: number
  core: number
  edge: number
  ratio: number
}

// Core versus edge luminance at the brightest simulated frame: particles sorted by distance from the
// light-weighted centre; the nearest 30% are the core, the farthest 40% the edge. Light per particle
// = luminance x opacity, with additive (LightEmission) layers counting more.
export function valueContrast(effect: VfxEffect): ContrastStats | null {
  let prepared
  try {
    prepared = prepareEffect(effect, 7)
  } catch {
    return null
  }
  let best: { t: number; pts: { pos: number[]; light: number }[]; total: number } | null = null
  for (const t of sampleTimes(effect)) {
    const f = simulate(prepared, t)
    const pts: { pos: number[]; light: number }[] = []
    for (const em of f.emitters) for (const p of em.particles) if (p.alpha > 0.02) pts.push({ pos: p.pos, light: luminance(p.color.map((c) => Math.min(1, c)) as Rgb) * p.alpha * (0.55 + 0.45 * Math.max(0, Math.min(1, em.lightEmission))) })
    const total = pts.reduce((s, p) => s + p.light, 0)
    if (pts.length >= 6 && (!best || total > best.total)) best = { t, pts, total }
  }
  if (!best || best.total <= 1e-6) return null
  const w = best.total
  const c = [0, 1, 2].map((k) => best!.pts.reduce((s, p) => s + p.pos[k] * p.light, 0) / w)
  const sorted = best.pts.map((p) => ({ ...p, d: Math.hypot(p.pos[0] - c[0], p.pos[1] - c[1], p.pos[2] - c[2]) })).sort((a, b) => a.d - b.d)
  const nCore = Math.max(2, Math.floor(sorted.length * 0.3))
  const nEdge = Math.max(2, Math.floor(sorted.length * 0.4))
  const mean = (xs: { light: number }[]) => xs.reduce((s, p) => s + p.light, 0) / xs.length
  const core = mean(sorted.slice(0, nCore))
  const edge = mean(sorted.slice(-nEdge))
  return { t: best.t, particles: sorted.length, core: r1(core * 100) / 100, edge: r1(edge * 100) / 100, ratio: Math.round((core / Math.max(0.02, edge)) * 100) / 100 }
}

export function contrastCheck(effect: VfxEffect): PrincipleCheck | null {
  const c = valueContrast(effect)
  if (!c) return null
  let score = 3 + (Math.min(c.ratio, 3.2) - 1) * 3.4
  const blown = c.edge > 0.7
  if (blown) score -= 2
  score = s10(score)
  return {
    id: 'fx-contrast',
    score,
    note: `core ${pct(c.core)} vs edge ${pct(c.edge)} luminance at ${c.t.toFixed(2)} s (${c.ratio.toFixed(1)}x${blown ? ', edges blown out' : ''})`,
    ...(score < 7 ? { fix: blown ? 'darken the outer layers: lower LightEmission and saturate their Color; keep only the core additive and near-white' : 'make the core white-hot (Color starting near #ffffff, LightEmission 1) and the outer layers darker and more saturated, fading to a dark rim or smoke' } : {})
  }
}

const PRIMARY = new Set<LayerRole>(['core', 'beam', 'mesh'])
const SECONDARY = new Set<LayerRole>(['glow', 'ring', 'trail', 'light'])
const TERTIARY = new Set<LayerRole>(['sparks', 'smoke', 'debris'])

export function layersCheck(effect: VfxEffect): PrincipleCheck | null {
  const nodes = allNodes(effect.roots).filter((n) => ['ParticleEmitter', 'Beam', 'Trail', 'MeshPart', 'SpecialMesh', 'PointLight', 'SpotLight', 'SurfaceLight'].includes(n.className))
  if (!nodes.length) return null
  const roles = nodes.map((n) => nodeRole(n))
  const visual = nodes.filter((n) => !/Light$/.test(n.className)).length
  const has = { primary: roles.some((r) => PRIMARY.has(r)), secondary: roles.some((r) => SECONDARY.has(r)), tertiary: roles.some((r) => TERTIARY.has(r)) }
  const covered = Object.values(has).filter(Boolean).length
  const seq = (effect.stages?.length ?? 0) > 1
  const crowded = !seq && visual > 10
  const score = s10(2.5 + covered * 2 + (visual >= 3 ? 1.5 : visual === 2 ? 0.5 : 0) - (crowded ? 1.5 : 0))
  const missing = Object.entries(has).filter(([, v]) => !v).map(([k]) => k)
  return {
    id: 'fx-layers',
    score,
    note: `${visual} visual layer${visual === 1 ? '' : 's'} (${[...new Set(roles)].join(', ')}); ${missing.length ? `missing ${missing.join(' and ')}` : 'primary, secondary and tertiary covered'}${crowded ? '; crowded' : ''}`,
    ...(score < 7 ? { fix: missing.length ? `add ${missing.map((m) => (m === 'primary' ? 'a primary core or shape' : m === 'secondary' ? 'a secondary glow or ring' : 'tertiary sparks, embers or smoke')).join(', ')}` : 'merge layers that do the same job; 3-6 per beat' } : {})
  }
}

// Whether a fade curve ends smoothly at full transparency: the value at the end, and the largest jump
// over the last 15% of life.
function fadeEnd(seq: NumberSequence): { end: number; jump: number } {
  const end = evalNumberSequence(seq, 1)
  const before = evalNumberSequence(seq, 0.85)
  return { end, jump: end - before }
}

export function dissipationCheck(effect: VfxEffect): PrincipleCheck | null {
  const ems = emitters(effect)
  const links = allNodes(effect.roots).filter((n) => n.className === 'Trail')
  if (!ems.length && !links.length) return null
  const bad: string[] = []
  let ok = 0
  for (const n of [...ems, ...links]) {
    const tr = prop<NumberSequence>(n, 'Transparency')
    const size = n.className === 'ParticleEmitter' ? prop<NumberSequence>(n, 'Size') : null
    const { end, jump } = fadeEnd(tr)
    const shrinks = size ? evalNumberSequence(size, 1) <= Math.max(...size.map((k) => k.v)) * 0.25 : false
    const good = (end >= 0.95 && jump <= 0.6) || (shrinks && end >= 0.5)
    if (good) ok++
    else bad.push(n.name)
  }
  const frac = ok / (ems.length + links.length)
  const score = s10(3 + frac * 7)
  return {
    id: 'fx-dissipation',
    score,
    note: bad.length ? `${bad.length} of ${ems.length + links.length} layers pop off instead of fading (${bad.slice(0, 3).join(', ')})` : 'every layer fades or shrinks out smoothly',
    ...(bad.length ? { fix: `fade ${bad.slice(0, 3).join(', ')} out: Transparency rising smoothly to 1 at the end of life (e.g. [[0,0],[0.6,0.3],[1,1]]) and Size decaying` } : {})
  }
}

// Break-up: per emitter, how many variance sources it has (size envelope, rotation, lifetime and
// speed ranges, a flipbook).
export function breakupCheck(effect: VfxEffect): PrincipleCheck | null {
  const ems = emitters(effect)
  if (!ems.length) return null
  const span = (r: NumberRange | undefined) => (r ? Math.abs(r[1] - r[0]) : 0)
  const per = ems.map((n) => {
    const size = prop<NumberSequence>(n, 'Size')
    const rot = span(prop<NumberRange>(n, 'Rotation')) >= 30 || span(prop<NumberRange>(n, 'RotSpeed')) >= 30
    const life = prop<NumberRange>(n, 'Lifetime') ?? [1, 1]
    const speed = prop<NumberRange>(n, 'Speed') ?? [0, 0]
    const sources = [size.some((k) => (k.e ?? 0) > 0), rot, life[1] > life[0] * 1.15, Math.abs(speed[1]) > Math.abs(speed[0]) * 1.15 + 0.01, flipbookFrames(n) > 1]
    return { name: n.name, n: sources.filter(Boolean).length }
  })
  const avg = per.reduce((s, x) => s + x.n, 0) / per.length
  const uniform = per.filter((x) => x.n <= 1)
  const score = s10(2 + avg * 2.2)
  return {
    id: 'fx-breakup',
    score,
    note: `${avg.toFixed(1)} variance sources per emitter on average${uniform.length ? `; ${uniform.slice(0, 3).map((x) => x.name).join(', ')} nearly uniform` : ''}`,
    ...(score < 7 ? { fix: `break up ${uniform.length ? uniform.slice(0, 3).map((x) => x.name).join(', ') : 'the emitters'}: a Size envelope, Rotation [0, 360] with some RotSpeed, Lifetime and Speed ranges, or a flipbook texture` } : {})
  }
}

const RELEASE = /fire|release|impact|slash|strike|launch|hit|drop|explode|burst|vanish/i
const GATHER = /anticipation|charge|gather|build|windup|wind-up|channel/i

function stageSpans(e: VfxEffect): { label: string; len: number }[] {
  const st = [...(e.stages ?? [])].sort((a, b) => a.at - b.at)
  return st.map((s, i) => ({ label: s.label, len: Math.max(0, (st[i + 1]?.at ?? e.duration) - s.at) }))
}

// Fast in, slow out: size curves that peak early (swell-decay or shrink), and for sequences beats of
// varied length with a release much shorter than the anticipation.
export function vfxTimingCheck(effect: VfxEffect): PrincipleCheck | null {
  const ems = emitters(effect).filter((n) => emitterRole(n) !== 'glow')
  if (!ems.length) return null
  const late: string[] = []
  let good = 0
  for (const n of ems) {
    const size = prop<NumberSequence>(n, 'Size')
    const shape = curveShape(size)
    const peakAt = size.reduce((b, k) => (k.v > b.v ? k : b), size[0] ?? { t: 0, v: 0 }).t
    if ((shape === 'swell-decay' || shape === 'shrink') && peakAt <= 0.35) good++
    else late.push(n.name)
  }
  const frac = good / ems.length
  const spans = stageSpans(effect).filter((s) => s.len > 0.01)
  let variety = 0.5
  let beat = ''
  if (spans.length >= 3) {
    const m = spans.reduce((s, x) => s + x.len, 0) / spans.length
    const cv = Math.sqrt(spans.reduce((s, x) => s + (x.len - m) ** 2, 0) / spans.length) / m
    variety = Math.min(1, cv / 0.5)
    beat = `; beat lengths vary ${pct(cv)}`
  }
  const score = s10(3 + frac * 5 + variety * 2)
  return {
    id: 'fx-timing',
    score,
    note: `${good} of ${ems.length} emitters swell fast then decay${beat}`,
    ...(score < 7 ? { fix: late.length ? `give ${late.slice(0, 3).join(', ')} a fast-in slow-out Size curve, e.g. [[0,0.3],[0.12,1],[1,0]] (peak in the first 15% of life)` : 'vary the beats: a long anticipation, a very short release, a brief hold on the impact, a long dissipate' } : {})
  }
}

function hueOf(c: Rgb): { h: number; s: number } {
  const mx = Math.max(...c)
  const mn = Math.min(...c)
  const d = mx - mn
  if (mx <= 0 || d < 1e-6) return { h: 0, s: 0 }
  let h = mx === c[0] ? ((c[1] - c[2]) / d) % 6 : mx === c[1] ? (c[2] - c[0]) / d + 2 : (c[0] - c[1]) / d + 4
  h *= 60
  if (h < 0) h += 360
  return { h, s: d / mx }
}

export function hueCheck(effect: VfxEffect): PrincipleCheck | null {
  const ems = emitters(effect)
  if (!ems.length) return null
  let shifting = 0
  const bins = new Set<number>()
  for (const n of ems) {
    const cs = prop<ColorSequence>(n, 'Color')
    const a = evalColorSequence(cs, 0)
    const b = evalColorSequence(cs, 1)
    const ha = hueOf(a)
    const hb = hueOf(b)
    const dh = Math.min(Math.abs(ha.h - hb.h), 360 - Math.abs(ha.h - hb.h))
    if ((ha.s > 0.15 || hb.s > 0.15) && dh >= 12) shifting++
    else if (Math.abs(luminance(a) - luminance(b)) >= 0.2) shifting++
    const mid = hueOf(evalColorSequence(cs, 0.5))
    if (mid.s > 0.3) bins.add(Math.round(mid.h / 40) % 9)
  }
  const frac = shifting / ems.length
  const nb = bins.size
  const score = s10(4 + frac * 4 + (nb <= 2 ? 2 : nb === 3 ? 1 : -1))
  return {
    id: 'fx-hue',
    score,
    note: `${shifting} of ${ems.length} emitters shift hue or value over life; ${nb} distinct hue${nb === 1 ? '' : 's'}`,
    ...(score < 7 ? { fix: nb > 3 ? 'pick one dominant hue (plus one accent) and move the other layers onto it' : 'shift colour over life: hot to cool or light to dark, e.g. ["#ffffff", "#ffb347", "#a02010"]' } : {})
  }
}

// Anticipation for sequences: a gathering beat before the first release-like beat, 2x+ its length.
export function vfxAnticipationCheck(effect: VfxEffect): PrincipleCheck | null {
  const spans = stageSpans(effect)
  if (spans.length < 2) return null
  const ri = spans.findIndex((s) => RELEASE.test(s.label))
  const gather = spans.slice(0, ri < 0 ? spans.length : ri).filter((s) => GATHER.test(s.label))
  const ant = gather.reduce((s, x) => s + x.len, 0)
  const rel = ri >= 0 ? spans[ri].len : 0
  if (!gather.length) return { id: 'fx-anticipation', score: 3, note: 'no anticipation or charge beat before the release', fix: 'add an anticipation beat (fx:stage("anticipation")): inward charge streaks and a swelling glow for 0.3-0.8 s before the release' }
  const ratio = rel > 0 ? ant / rel : 4
  const score = s10(6 + Math.min(1, ratio / 3) * 4 - (ant > 1.5 ? 1.5 : 0))
  return {
    id: 'fx-anticipation',
    score,
    note: `${gather.map((g) => g.label).join(' + ')} ${ant.toFixed(2)} s before a ${rel.toFixed(2)} s release (${ratio.toFixed(1)}x)`,
    ...(score < 7 ? { fix: 'make the anticipation 3-6x longer than the release and the release itself very short (0.05-0.2 s)' } : {})
  }
}

export function budgetCheck(effect: VfxEffect): PrincipleCheck {
  const score = perfScore(effect)
  const w = perfWarnings(effect).filter((x) => x.level !== 'info')
  return {
    id: 'fx-budget',
    score,
    note: w.length ? w.slice(0, 2).map((x) => `${x.node ? `${x.node}: ` : ''}${x.message}`).join(' ') : 'within the mobile budget (particles, overdraw, emitters)',
    ...(w.length ? { fix: 'lower Rate x Lifetime on the heaviest layers, shrink large opaque particles, reuse rigs by tweening' } : {})
  }
}

// Every measurable VFX principle for an effect.
export function vfxPrincipleChecks(effect: VfxEffect): PrincipleCheck[] {
  const out = [contrastCheck(effect), layersCheck(effect), dissipationCheck(effect), breakupCheck(effect), vfxTimingCheck(effect), hueCheck(effect), vfxAnticipationCheck(effect), budgetCheck(effect)]
  return out.filter((c): c is PrincipleCheck => !!c)
}

