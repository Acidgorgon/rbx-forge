// Richness: how much is going on in an effect (layers that actually show, the jobs they do, beams /
// trails / visible parts, and how many separate beats its bursts land on), measured against the
// user's own closest effects. A library of ten-layer, staggered-burst effects should not produce a
// two-layer draft; this is the check that says so, and the guard that keeps model edits from
// quietly hiding layers of a library copy ("emit [] / Enabled false / Transparency 1") unless the
// request asks for something simpler.
// Pure code (test/vfxRichness.test.ts, the offline eval in test/vfxEval).

import { allNodes, nodeRole, type LayerRole } from './analyze.ts'
import { prop } from './schema.ts'
import { sequenceMax } from './sequence.ts'
import type { NumberSequence, VfxChange, VfxEffect, VfxNode } from './types.ts'
import type { VfxMatch } from './retrieve.ts'

export interface Richness {
  // Visual layers that show during a play (emitters that emit, beams / trails that are on, visible
  // parts), and the count per class.
  layers: number
  emitters: number
  beams: number
  trails: number
  parts: number
  // Distinct layer roles among them (core, glow, sparks, smoke, ring, ...).
  roles: LayerRole[]
  // Distinct moments (50 ms buckets) where bursts / switch-ons land: one flat burst is 1 beat.
  beats: number
  flipbooks: number
  // Visual layers in the effect that never show (hidden by an edit, never emitted).
  dead: number
}

const VISUAL = new Set(['ParticleEmitter', 'Beam', 'Trail'])

function minSeq(v: unknown): number {
  if (typeof v === 'number') return v
  if (!Array.isArray(v) || !v.length) return 0
  return Math.min(...(v as NumberSequence).map((k) => k.v - (k.e ?? 0)))
}

// A visible part of a scripted rig (orb sphere, shockwave shell) or a mesh: Transparency < 1 or
// faded in by a cue.
function visiblePart(n: VfxNode, effect: VfxEffect): boolean {
  if (n.className !== 'Part' && n.className !== 'MeshPart') return false
  if (n.name === 'Root' && !n.kit) return false
  const t = Number(n.props.Transparency ?? 0)
  if (t < 0.98) return true
  return effect.cues.some((c) => c.target === n.id && (c.action === 'tween' || c.action === 'set') && c.props && ((typeof c.props.Transparency === 'number' && c.props.Transparency < 0.98) || (typeof c.props.Fade === 'number' && c.props.Fade < 0.98)))
}

// Whether a visual layer shows at all during a play.
export function layerShows(n: VfxNode, effect: VfxEffect): boolean {
  const cues = effect.cues.filter((c) => c.target === n.id)
  if (n.className === 'ParticleEmitter') {
    const emits = cues.some((c) => c.action === 'emit' && (c.count ?? 16) > 0)
    const on = (prop<boolean>(n, 'Enabled') !== false || cues.some((c) => c.action === 'enable')) && prop<number>(n, 'Rate') > 0
    if (!emits && !on) return false
    if (minSeq(n.props.Transparency) >= 0.97) return false
    if (sequenceMax(prop<NumberSequence>(n, 'Size')) <= 0.02) return false
    return true
  }
  if (n.className === 'Beam' || n.className === 'Trail') {
    const on = prop<boolean>(n, 'Enabled') !== false || cues.some((c) => c.action === 'enable')
    if (!on) return false
    if (minSeq(n.props.Transparency) >= 0.97) return false
    if (n.className === 'Beam' && Math.max(Number(n.props.Width0 ?? 1), Number(n.props.Width1 ?? 1)) <= 0.01) return false
    return true
  }
  return false
}

export function richness(effect: VfxEffect): Richness {
  const nodes = allNodes(effect.roots)
  const r: Richness = { layers: 0, emitters: 0, beams: 0, trails: 0, parts: 0, roles: [], beats: 0, flipbooks: 0, dead: 0 }
  const roles = new Set<LayerRole>()
  const live = new Set<string>()
  for (const n of nodes) {
    if (VISUAL.has(n.className)) {
      if (!layerShows(n, effect)) {
        r.dead++
        continue
      }
      live.add(n.id)
      r.layers++
      if (n.className === 'ParticleEmitter') r.emitters++
      else if (n.className === 'Beam') r.beams++
      else r.trails++
      roles.add(nodeRole(n))
      const fl = prop<string>(n, 'FlipbookLayout')
      if (n.className === 'ParticleEmitter' && fl && fl !== 'None') r.flipbooks++
    } else if (visiblePart(n, effect)) {
      live.add(n.id)
      r.layers++
      r.parts++
      roles.add('mesh')
    }
  }
  const beats = new Set<number>()
  for (const c of effect.cues) if (live.has(c.target) && (c.action === 'emit' || c.action === 'enable' || ((c.action === 'tween' || c.action === 'set') && c.spawn))) beats.add(Math.round(c.at / 0.05))
  // Layers that are on from the start count as a beat at 0.
  if (nodes.some((n) => live.has(n.id) && VISUAL.has(n.className) && prop<boolean>(n, 'Enabled') !== false && !effect.cues.some((c) => c.target === n.id))) beats.add(0)
  r.beats = Math.max(r.layers ? 1 : 0, beats.size)
  r.roles = [...roles].sort()
  return r
}

// What the user's closest effects look like (the yardstick for a request).
export interface RichTarget {
  layers: number
  roles: LayerRole[]
  beams: boolean
  trails: boolean
  beats: number
  // The effects it was read from.
  from: string[]
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b)
  return s.length ? s[Math.floor((s.length - 1) / 2)] : 0
}

// From the closest matches: same-kind ones when there are any (up to 3), else the top 3. Roles that
// at least half of them have; beams / trails when most have them.
export function richTarget(matches: VfxMatch[]): RichTarget | null {
  const same = matches.filter((m) => m.kindMatch && m.entry.effect)
  const pool = (same.length ? same : matches.filter((m) => m.entry.effect)).slice(0, 3)
  return richTargetOf(pool.map((m) => ({ name: m.entry.name, effect: m.entry.effect! })))
}

// The same from a list of reference effects (the critic's references).
export function richTargetOf(refs: { name: string; effect?: VfxEffect }[]): RichTarget | null {
  const pool = refs.filter((r): r is { name: string; effect: VfxEffect } => !!r.effect && !r.effect.script).slice(0, 3)
  if (!pool.length) return null
  const rs = pool.map((m) => richness(m.effect))
  const roleCount = new Map<LayerRole, number>()
  for (const r of rs) for (const role of r.roles) roleCount.set(role, (roleCount.get(role) ?? 0) + 1)
  return {
    layers: median(rs.map((r) => r.layers)),
    roles: [...roleCount.entries()].filter(([role, n]) => n >= rs.length / 2 && role !== 'other' && role !== 'light').map(([role]) => role).sort(),
    beams: rs.filter((r) => r.beams > 0).length > rs.length / 2,
    trails: rs.filter((r) => r.trails > 0).length > rs.length / 2,
    beats: median(rs.map((r) => r.beats)),
    from: pool.map((m) => m.name)
  }
}

// 0..1: layer count, role coverage, beams / trails where the library has them, and burst beats,
// each against the target (more than the target is not penalised here; the perf guard does that).
export function richnessScore(effect: VfxEffect | Richness, target: RichTarget | null): number {
  if (!target || target.layers <= 0) return 1
  const r = 'roots' in effect ? richness(effect) : effect
  const layers = Math.min(1, r.layers / target.layers)
  const roles = target.roles.length ? target.roles.filter((x) => r.roles.includes(x)).length / target.roles.length : 1
  const structure = (target.beams || target.trails ? ((target.beams ? (r.beams > 0 ? 1 : 0) : 1) + (target.trails ? (r.trails > 0 ? 1 : 0) : 1)) / 2 : 1)
  const beats = target.beats > 1 ? Math.min(1, r.beats / target.beats) : 1
  return Math.round((0.45 * layers + 0.25 * roles + 0.15 * structure + 0.15 * beats) * 1000) / 1000
}

// Words that ask for less (then a sparse result is what was wanted).
// (Size words like "small" are about scale, not layering.)
const SIMPLE = /\b(simple|simpler|minimal|minimalist|subtle|cheap|cheaper|lightweight|mobile|low[- ]?end|fewer|basic|plain|toned? down|stripped|one[- ]layer|single[- ]layer)\b/i
export function asksSimpler(text: string): boolean {
  return SIMPLE.test(text)
}

// Too simple for this library: well under the closest effects' richness.
export const RICH_MIN = 0.7
export function tooSimple(effect: VfxEffect | Richness, target: RichTarget | null, text = ''): boolean {
  if (!target || asksSimpler(text)) return false
  const r = 'roots' in effect ? richness(effect) : effect
  return richnessScore(r, target) < RICH_MIN || r.layers < Math.ceil(target.layers * 0.6)
}

export function richnessLine(effect: VfxEffect | Richness, target: RichTarget | null): string {
  const r = 'roots' in effect ? richness(effect) : effect
  const parts = [`${r.layers} layer${r.layers === 1 ? '' : 's'}`, r.beams ? `${r.beams} beam${r.beams === 1 ? '' : 's'}` : '', r.trails ? `${r.trails} trail${r.trails === 1 ? '' : 's'}` : '', `${r.beats} beat${r.beats === 1 ? '' : 's'}`].filter(Boolean)
  if (!target) return `richness: ${parts.join(', ')}`
  return `richness: ${parts.join(', ')} vs your closest (${target.from.slice(0, 2).join(', ')}): ${target.layers} layers, ${target.beats} beat${target.beats === 1 ? '' : 's'}${target.beams ? ', beams' : ''}${target.trails ? ', trails' : ''} (${Math.round(richnessScore(r, target) * 100)}%)`
}

// Whether a change hides / removes a layer (emit nothing, switched off, fully transparent, zero
// size or rate).
export function hidesLayer(effect: VfxEffect, ch: VfxChange): boolean {
  if (ch.node === '$effect') return false
  const n = allNodes(effect.roots).find((x) => x.id === ch.node) ?? allNodes(effect.roots).find((x) => x.name === ch.node) ?? allNodes(effect.roots).find((x) => x.name.toLowerCase() === ch.node.toLowerCase())
  if (!n || !(VISUAL.has(n.className) || n.className === 'Part')) return false
  const p = ch.prop.toLowerCase()
  const v = ch.value as unknown
  if (p === 'emit') {
    const arr = Array.isArray(v) ? v : [v]
    return n.className === 'ParticleEmitter' && !arr.some((e) => (typeof e === 'number' ? e : Number((e as { count?: unknown })?.count)) > 0)
  }
  if (p === 'enabled') return v === false || v === 'false'
  if (p === 'transparency') {
    if (typeof v === 'number') return v >= 0.97
    if (Array.isArray(v) && v.length) return v.every((k) => (Array.isArray(k) ? Number(k[1]) : typeof k === 'object' && k ? Number((k as { v?: unknown }).v) : Number(k)) >= 0.97)
    return false
  }
  // Rate 0 hides a continuous emitter (one with bursts still shows).
  if (p === 'rate') return Number(v) <= 0 && !effect.cues.some((c) => c.target === n.id && c.action === 'emit')
  if (p === 'size') {
    if (typeof v === 'number') return v <= 0.02
    if (Array.isArray(v) && v.length) return v.every((k) => (Array.isArray(k) ? Number(k[1]) : typeof k === 'object' && k ? Number((k as { v?: unknown }).v) : Number(k)) <= 0.02)
    return false
  }
  if (p === 'width0' || p === 'width1') return Number(v) <= 0.01
  return false
}

// Model / critic edits to an effect: the ones that would hide one of its layers are dropped unless
// the request asks for something simpler. Returns what is kept and what was dropped.
export function guardLayerEdits<T extends VfxChange>(effect: VfxEffect, changes: T[], text = ''): { kept: T[]; dropped: T[] } {
  if (asksSimpler(text)) return { kept: changes, dropped: [] }
  const kept: T[] = []
  const dropped: T[] = []
  for (const c of changes) (hidesLayer(effect, c) ? dropped : kept).push(c)
  return { kept, dropped }
}
