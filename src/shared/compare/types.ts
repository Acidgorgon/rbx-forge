// Compare any two versions (VFX iterations, animation iterations, ability moves, and any lab that
// adopts it): the plain-data side. A lab turns its entries / iterations into CompareItems; the
// renderer's CompareView plays two of them side by side on one clock and shows the deltas computed
// in ./diff.ts. Pure types (no electron, no React).

import type { PrincipleScore } from '../principles/types.ts'

export type ParamValue = string | number | boolean | null

// Flat parameter map: "Core.Rate" -> 40. Built with flattenParams (./diff.ts) or by hand.
export type ParamMap = Record<string, ParamValue>

export interface CompareItem<P = unknown> {
  // Unique within one compare list ("<entryId>" for the current version, "<entryId>#<n>" for an iteration).
  id: string
  entryId: string
  // "#3", "current", or an entry name.
  label: string
  // Picker group ("This effect", "Library").
  group: string
  // Extra line under the label (date, origin...).
  sub?: string
  at?: number
  // Seconds of one play (0 for stills).
  duration: number
  // 0..10.
  overall?: number
  // Rubric scores 0..10 by key.
  scores?: Record<string, number>
  principles?: PrincipleScore[]
  principleScore?: number
  params: ParamMap
  // Whatever the lab's renderer needs (effect, clip, ability...).
  payload: P
  best?: boolean
  current?: boolean
}

export type ParamChangeKind = 'changed' | 'added' | 'removed'

export interface ParamChange {
  path: string
  kind: ParamChangeKind
  a: ParamValue | undefined
  b: ParamValue | undefined
  // b - a for numbers.
  delta?: number
}

export interface ScoreDelta {
  key: string
  a: number | undefined
  b: number | undefined
  // b - a when both exist.
  delta: number | undefined
}

export interface CompareSummary {
  overall: ScoreDelta
  principleScore: ScoreDelta
  scores: ScoreDelta[]
  principles: ScoreDelta[]
  params: ParamChange[]
  unchanged: number
}

// How the two panes share the clock: same seconds (a shorter version holds its last frame), or
// stretched so both start and end together.
export type SyncMode = 'seconds' | 'stretch'
