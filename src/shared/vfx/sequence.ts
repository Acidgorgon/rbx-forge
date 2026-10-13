// NumberSequence / ColorSequence evaluation and a seeded RNG.
//
// Roblox semantics (Creator Hub, ParticleEmitter.Size / Transparency / Color and
// NumberSequenceKeypoint.new): a particle's present value is found "by linearly interpolating on
// this sequence using the particle's age and its total lifetime"; "for any NumberSequenceKeypoint
// with a non-zero envelope value, a random value in the envelope range is chosen for each keypoint
// for each particle when it emits", i.e. within [value - envelope, value + envelope].
// Sequences hold 2..20 keypoints, times from 0 to 1 (NumberSequence / ColorSequence docs).

import type { ColorSequence, NumberSequence, Rgb } from './types.ts'

export const MAX_KEYPOINTS = 20

// mulberry32: small, fast, good enough for particle jitter; deterministic per seed.
export function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// FNV-1a over strings and numbers: stable seeds from (effect seed, emitter id, particle index).
export function hashSeed(...parts: (string | number)[]): number {
  let h = 0x811c9dc5
  for (const p of parts) {
    const s = typeof p === 'number' ? String(p) : p
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i)
      h = Math.imul(h, 0x01000193)
    }
    h ^= 0x7c
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const clamp01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x)

// Sorted, clamped copy with the first key at t=0 and the last at t=1 (what Roblox requires).
export function normalizeSequence<T extends { t: number }>(keys: T[]): T[] {
  const sorted = [...keys].map((k) => ({ ...k, t: clamp01(Number(k.t) || 0) })).sort((a, b) => a.t - b.t)
  if (!sorted.length) return sorted
  if (sorted[0].t !== 0) sorted.unshift({ ...sorted[0], t: 0 })
  if (sorted[sorted.length - 1].t !== 1) sorted.push({ ...sorted[sorted.length - 1], t: 1 })
  return sorted.slice(0, MAX_KEYPOINTS)
}

// Per-particle envelope offsets: one uniform draw in [-e, e] per keypoint.
export function envelopeOffsets(seq: NumberSequence, rand: () => number): number[] {
  return seq.map((k) => (k.e ? (rand() * 2 - 1) * k.e : 0))
}

// Value at time t (0..1); offsets from envelopeOffsets (omit for the mean curve).
export function evalNumberSequence(seq: NumberSequence, t: number, offsets?: number[]): number {
  if (!seq.length) return 0
  const x = clamp01(t)
  const val = (i: number) => seq[i].v + (offsets?.[i] ?? 0)
  if (x <= seq[0].t) return val(0)
  for (let i = 1; i < seq.length; i++) {
    if (x <= seq[i].t) {
      const span = seq[i].t - seq[i - 1].t
      const f = span > 0 ? (x - seq[i - 1].t) / span : 1
      return val(i - 1) + (val(i) - val(i - 1)) * f
    }
  }
  return val(seq.length - 1)
}

export function evalColorSequence(seq: ColorSequence, t: number): Rgb {
  if (!seq.length) return [1, 1, 1]
  const x = clamp01(t)
  if (x <= seq[0].t) return [...seq[0].c] as Rgb
  for (let i = 1; i < seq.length; i++) {
    if (x <= seq[i].t) {
      const a = seq[i - 1]
      const b = seq[i]
      const span = b.t - a.t
      const f = span > 0 ? (x - a.t) / span : 1
      return [a.c[0] + (b.c[0] - a.c[0]) * f, a.c[1] + (b.c[1] - a.c[1]) * f, a.c[2] + (b.c[2] - a.c[2]) * f]
    }
  }
  return [...seq[seq.length - 1].c] as Rgb
}

// Largest value of a sequence including envelopes (for budgets and bounds).
export function sequenceMax(seq: NumberSequence): number {
  return seq.reduce((m, k) => Math.max(m, k.v + (k.e ?? 0)), -Infinity)
}

// Mean over the lifetime (trapezoid rule on the keypoints).
export function sequenceMean(seq: NumberSequence): number {
  if (!seq.length) return 0
  if (seq.length === 1) return seq[0].v
  let area = 0
  for (let i = 1; i < seq.length; i++) area += ((seq[i].v + seq[i - 1].v) / 2) * (seq[i].t - seq[i - 1].t)
  return area
}

export type CurveShape = 'constant' | 'grow' | 'shrink' | 'swell-decay' | 'pulse' | 'other'

// Coarse shape of a size / transparency curve, for recipes ("quick swell then decay").
export function curveShape(seq: NumberSequence): CurveShape {
  if (seq.length < 2) return 'constant'
  const vs = seq.map((k) => k.v)
  const max = Math.max(...vs)
  const min = Math.min(...vs)
  if (max - min < 1e-3 * Math.max(1, Math.abs(max))) return 'constant'
  const first = vs[0]
  const last = vs[vs.length - 1]
  const peakIdx = vs.indexOf(max)
  const peakT = seq[peakIdx].t
  let up = true
  let down = true
  for (let i = 1; i < vs.length; i++) {
    if (vs[i] < vs[i - 1] - 1e-6) up = false
    if (vs[i] > vs[i - 1] + 1e-6) down = false
  }
  if (up) return 'grow'
  if (down) return 'shrink'
  const range = max - min
  if (peakT > 0 && peakT < 1 && first <= max - 0.4 * range && last <= max - 0.4 * range) return peakT <= 0.45 ? 'swell-decay' : 'pulse'
  return 'other'
}

// Roblox NumberSequence / ColorSequence Luau constructor text.
export function luauNumberSequence(seq: NumberSequence): string {
  const n = (x: number) => fmt(x)
  if (seq.length === 2 && seq[0].v === seq[1].v && !seq[0].e && !seq[1].e) return `NumberSequence.new(${n(seq[0].v)})`
  return `NumberSequence.new({ ${seq.map((k) => `NumberSequenceKeypoint.new(${n(k.t)}, ${n(k.v)}${k.e ? `, ${n(k.e)}` : ''})`).join(', ')} })`
}

export function luauColorSequence(seq: ColorSequence): string {
  const c = (rgb: Rgb) => `Color3.fromRGB(${rgb.map((x) => Math.round(clamp01(x) * 255)).join(', ')})`
  if (seq.length === 2 && seq[0].c.every((x, i) => x === seq[1].c[i])) return `ColorSequence.new(${c(seq[0].c)})`
  return `ColorSequence.new({ ${seq.map((k) => `ColorSequenceKeypoint.new(${fmt(k.t)}, ${c(k.c)})`).join(', ')} })`
}

export function fmt(x: number): string {
  if (!Number.isFinite(x)) return '0'
  const r = Math.round(x * 1000) / 1000
  return Object.is(r, -0) ? '0' : String(r)
}

export function hex(rgb: Rgb): string {
  return '#' + rgb.map((x) => Math.round(clamp01(x) * 255).toString(16).padStart(2, '0')).join('')
}

export function fromHex(h: string): Rgb {
  const m = /^#?([0-9a-f]{6})$/i.exec(h.trim())
  if (!m) return [1, 1, 1]
  const n = parseInt(m[1], 16)
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255]
}
