// Compare data: flatten a version's parameters into "path -> value", diff two of them, score and
// principle deltas, the default pair to open with, and the shared-clock time math. Pure code.

import type { PrincipleScore } from '../principles/types.ts'
import type { CompareItem, CompareSummary, ParamChange, ParamMap, ParamValue, ScoreDelta, SyncMode } from './types.ts'

export interface FlattenOptions {
  // Keys skipped at any depth.
  skip?: string[]
  // Strings longer than this are summarised ("<412 chars #a1b2c3>") so a script edit shows as one change.
  maxString?: number
  // Number arrays up to this length become one value ("[1, 0.5, 0]": vectors, colors).
  inlineArray?: number
  // Decimal places numbers are rounded to (float noise is not a change).
  digits?: number
  maxDepth?: number
}

const KEY_FIELDS = ['name', 'label', 'id'] as const

// Small stable string hash (FNV-1a), for summarised long strings.
export function hashString(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6)
}

export function roundTo(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n
  const f = 10 ** digits
  const r = Math.round(n * f) / f
  return Object.is(r, -0) ? 0 : r
}

// Arrays of objects are keyed by name / label / id when every element has a distinct one, so a
// reorder or an insert does not show every later element as changed.
function arrayKeys(arr: unknown[]): string[] | null {
  if (!arr.length || !arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return null
  for (const f of KEY_FIELDS) {
    const keys = arr.map((x) => (x as Record<string, unknown>)[f])
    if (keys.every((k) => typeof k === 'string' && k) && new Set(keys).size === keys.length) return keys as string[]
  }
  return null
}

function join(prefix: string, key: string): string {
  return prefix ? `${prefix}.${key}` : key
}

export function flattenParams(value: unknown, opts: FlattenOptions = {}, prefix = '', out: ParamMap = {}, depth = 0): ParamMap {
  const maxString = opts.maxString ?? 80
  const inline = opts.inlineArray ?? 4
  const digits = opts.digits ?? 4
  const maxDepth = opts.maxDepth ?? 12
  const leaf = (v: ParamValue) => {
    out[prefix || '(value)'] = v
  }
  if (value === undefined) return out
  if (value === null) return (leaf(null), out)
  if (typeof value === 'number') return (leaf(roundTo(value, digits)), out)
  if (typeof value === 'boolean') return (leaf(value), out)
  if (typeof value === 'string') return (leaf(value.length > maxString ? `<${value.length} chars #${hashString(value)}>` : value), out)
  if (typeof value !== 'object') return (leaf(String(value)), out)
  if (depth >= maxDepth) return (leaf('<…>'), out)
  if (Array.isArray(value)) {
    if (!value.length) return (leaf('[]'), out)
    if (value.length <= inline && value.every((x) => typeof x === 'number')) return (leaf(`[${value.map((x) => roundTo(x as number, digits)).join(', ')}]`), out)
    const keys = arrayKeys(value)
    value.forEach((x, i) => flattenParams(x, opts, keys ? join(prefix, keys[i]) : `${prefix}[${i}]`, out, depth + 1))
    return out
  }
  const skip = opts.skip ?? []
  const entries = Object.entries(value as Record<string, unknown>).filter(([k, v]) => v !== undefined && !skip.includes(k))
  if (!entries.length) return (leaf('{}'), out)
  for (const [k, v] of entries) flattenParams(v, opts, join(prefix, k), out, depth + 1)
  return out
}

function sameValue(a: ParamValue | undefined, b: ParamValue | undefined): boolean {
  return a === b || (typeof a === 'number' && typeof b === 'number' && Number.isNaN(a) && Number.isNaN(b))
}

// Every path whose value differs, in path order (numbers carry delta = b - a).
export function diffParams(a: ParamMap, b: ParamMap): { changes: ParamChange[]; unchanged: number } {
  const paths = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort(comparePaths)
  const changes: ParamChange[] = []
  let unchanged = 0
  for (const path of paths) {
    const inA = Object.prototype.hasOwnProperty.call(a, path)
    const inB = Object.prototype.hasOwnProperty.call(b, path)
    const va = inA ? a[path] : undefined
    const vb = inB ? b[path] : undefined
    if (inA && inB && sameValue(va, vb)) {
      unchanged++
      continue
    }
    const kind = !inA ? 'added' : !inB ? 'removed' : 'changed'
    const change: ParamChange = { path, kind, a: va, b: vb }
    if (typeof va === 'number' && typeof vb === 'number') change.delta = roundTo(vb - va, 4)
    changes.push(change)
  }
  return { changes, unchanged }
}

// Natural order so "[2]" sorts before "[10]".
export function comparePaths(x: string, y: string): number {
  return x.localeCompare(y, 'en', { numeric: true })
}

export function scoreDelta(key: string, a: number | undefined, b: number | undefined): ScoreDelta {
  const fin = (n: number | undefined) => (typeof n === 'number' && Number.isFinite(n) ? n : undefined)
  const va = fin(a)
  const vb = fin(b)
  return { key, a: va, b: vb, delta: va != null && vb != null ? roundTo(vb - va, 2) : undefined }
}

// Union of both rubrics, in the order keys first appear (a's keys, then b's).
export function scoreDeltas(a: Record<string, number> | undefined, b: Record<string, number> | undefined): ScoreDelta[] {
  const keys = [...new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})])]
  return keys.map((k) => scoreDelta(k, a?.[k], b?.[k]))
}

// Per principle id, biggest movement first (missing on one side sorts last).
export function principleDeltas(a: PrincipleScore[] | undefined, b: PrincipleScore[] | undefined): ScoreDelta[] {
  const ma = new Map((a ?? []).map((p) => [p.id, p.score]))
  const mb = new Map((b ?? []).map((p) => [p.id, p.score]))
  const ids = [...new Set([...ma.keys(), ...mb.keys()])]
  return ids
    .map((id) => scoreDelta(id, ma.get(id), mb.get(id)))
    .sort((x, y) => (y.delta == null ? -1 : 0) - (x.delta == null ? -1 : 0) || Math.abs(y.delta ?? 0) - Math.abs(x.delta ?? 0) || x.key.localeCompare(y.key))
}

export function compareItems(a: CompareItem, b: CompareItem): CompareSummary {
  const { changes, unchanged } = diffParams(a.params, b.params)
  return {
    overall: scoreDelta('overall', a.overall, b.overall),
    principleScore: scoreDelta('principles', a.principleScore, b.principleScore),
    scores: scoreDeltas(a.scores, b.scores),
    principles: principleDeltas(a.principles, b.principles),
    params: changes,
    unchanged
  }
}

// What the compare opens on. focus: the version the user is looking at (usually the current one).
// With iterations: the best scored one vs the current version (or the latest when the best is
// current); otherwise the previous item vs the focus; otherwise the first two.
export function defaultPair(items: CompareItem[], focus?: string): [string, string] | null {
  if (items.length < 2) return null
  const cur = items.find((i) => i.id === focus) ?? items.find((i) => i.current) ?? items[0]
  const all = items.filter((i) => i.entryId === cur.entryId && i.id !== cur.id)
  // A version identical to the focus (the iteration the current one was kept from) is a dull pair.
  const differs = all.filter((i) => diffParams(i.params, cur.params).changes.length > 0)
  const siblings = differs.length ? differs : all
  const scored = siblings.filter((i) => i.overall != null)
  if (scored.length) {
    const best = scored.reduce((x, y) => ((y.overall ?? 0) > (x.overall ?? 0) ? y : x))
    return [best.id, cur.id]
  }
  if (siblings.length) {
    const sorted = [...siblings].sort((x, y) => (y.at ?? 0) - (x.at ?? 0))
    return [sorted[0].id, cur.id]
  }
  const other = items.find((i) => i.id !== cur.id)!
  return [other.id, cur.id]
}

// Clock length: the longer version (seconds) or 1 (stretch: the clock is a 0..1 phase).
export function clockLength(mode: SyncMode, durA: number, durB: number): number {
  if (mode === 'stretch') return 1
  return Math.max(durA, durB, 0)
}

// Each pane's own time for a clock value. seconds: same time, clamped to the pane's length (a
// shorter version holds its end); stretch: the clock is a phase, scaled to each length.
export function paneTime(mode: SyncMode, clock: number, duration: number): number {
  if (duration <= 0) return 0
  if (mode === 'stretch') return Math.min(duration, Math.max(0, clock) * duration)
  return Math.min(duration, Math.max(0, clock))
}

// Advance the shared clock by dt seconds of real time at a playback speed; loops or stops at the end.
export function stepClock(mode: SyncMode, clock: number, dt: number, speed: number, durA: number, durB: number, loop: boolean): { clock: number; ended: boolean } {
  const len = clockLength(mode, durA, durB)
  if (len <= 0) return { clock: 0, ended: true }
  // stretch: one phase lasts as long as the longer version, so both play at no more than real time.
  const rate = mode === 'stretch' ? 1 / Math.max(durA, durB, 1e-6) : 1
  let next = clock + dt * speed * rate
  if (next >= len) {
    if (loop) return { clock: next % len, ended: false }
    return { clock: len, ended: true }
  }
  if (next < 0) next = 0
  return { clock: next, ended: false }
}

export function formatValue(v: ParamValue | undefined): string {
  if (v === undefined) return '—'
  if (v === null) return 'null'
  if (typeof v === 'number') return String(roundTo(v, 3))
  return String(v)
}

// Filter for the param diff list ("rate", "core.size", "removed").
export function filterChanges(changes: ParamChange[], query: string): ParamChange[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (!words.length) return changes
  return changes.filter((c) => {
    const hay = `${c.path} ${c.kind} ${formatValue(c.a)} ${formatValue(c.b)}`.toLowerCase()
    return words.every((w) => hay.includes(w))
  })
}
