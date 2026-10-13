// Relevance ranking for recall: BM25 over name (x3), description (x2) and body (x1), then nudged by
// use count, recency and pins. No embeddings: memories are few and short.

import type { MemoryEntry } from './types.ts'

const STOP = new Set('a an and are as at be by for from has have how i in is it its of on or that the this to was were what when where which with you your we our use using'.split(' '))

// Lowercase words; splits camelCase/PascalCase and snake/kebab so "GenTree" matches "gen tree" and
// "BlinkEvent" matches "blink". Keeps the joined form too.
export function tokenize(text: string): string[] {
  const out: string[] = []
  for (const raw of text.match(/[A-Za-z0-9_]+/g) ?? []) {
    const parts = raw
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
      .split(/[\s_]+/)
      .map((p) => p.toLowerCase())
      .filter(Boolean)
    const joined = raw.toLowerCase().replace(/_/g, '')
    for (const p of parts) if (p.length > 1 && !STOP.has(p)) out.push(stem(p))
    if (parts.length > 1 && !STOP.has(joined)) out.push(joined)
  }
  return out
}

// Very small stemmer: plural/ing/ed endings, so "events" ~ "event", "naming" ~ "name".
function stem(w: string): string {
  if (w.length > 4 && w.endsWith('ies')) return w.slice(0, -3) + 'y'
  if (w.length > 4 && w.endsWith('ing')) return w.slice(0, -3)
  if (w.length > 3 && w.endsWith('ed')) return w.slice(0, -2)
  if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) return w.slice(0, -1)
  return w
}

const FIELDS: { get: (e: MemoryEntry) => string; weight: number }[] = [
  { get: (e) => e.name.replace(/-/g, ' '), weight: 3 },
  { get: (e) => e.description, weight: 2 },
  { get: (e) => e.body, weight: 1 }
]

export interface Ranked {
  entry: MemoryEntry
  score: number
}

const DAY = 86_400_000

// Usage/recency multiplier: up to ~1.6x for heavily used, recently used memories; pinned 1.5x.
export function boost(e: MemoryEntry, now = Date.now()): number {
  const uses = 1 + 0.08 * Math.log2(1 + Math.max(0, e.uses))
  const age = Math.max(0, now - (e.lastUsed || e.created)) / DAY
  const recency = 1 + 0.25 * Math.exp(-age / 30)
  return uses * recency * (e.pinned ? 1.5 : 1)
}

export function bm25Rank(query: string, entries: MemoryEntry[], opts: { k1?: number; b?: number; now?: number; limit?: number } = {}): Ranked[] {
  const k1 = opts.k1 ?? 1.2
  const b = opts.b ?? 0.75
  const q = [...new Set(tokenize(query))]
  if (!q.length || !entries.length) return []
  // Weighted term frequencies per document.
  const docs = entries.map((e) => {
    const tf = new Map<string, number>()
    let len = 0
    for (const f of FIELDS) {
      for (const t of tokenize(f.get(e))) {
        tf.set(t, (tf.get(t) ?? 0) + f.weight)
        len += f.weight
      }
    }
    return { e, tf, len }
  })
  const avg = docs.reduce((s, d) => s + d.len, 0) / docs.length || 1
  const N = docs.length
  const df = new Map<string, number>()
  for (const t of q) df.set(t, docs.filter((d) => d.tf.has(t)).length)
  const out: Ranked[] = []
  for (const d of docs) {
    let s = 0
    for (const t of q) {
      const f = d.tf.get(t)
      if (!f) continue
      const n = df.get(t) ?? 0
      const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
      s += idf * ((f * (k1 + 1)) / (f + k1 * (1 - b + (b * d.len) / avg)))
    }
    if (s > 0) out.push({ entry: d.e, score: s * boost(d.e, opts.now) })
  }
  out.sort((a, b2) => b2.score - a.score || a.entry.name.localeCompare(b2.entry.name))
  return opts.limit ? out.slice(0, opts.limit) : out
}

// Token-set similarity (Jaccard) of two memories' name + description, used for dedupe.
export function similarity(a: { name: string; description: string; body?: string }, b: { name: string; description: string; body?: string }): number {
  const sa = new Set(tokenize(`${a.name.replace(/-/g, ' ')} ${a.description}`))
  const sb = new Set(tokenize(`${b.name.replace(/-/g, ' ')} ${b.description}`))
  if (!sa.size || !sb.size) return 0
  let inter = 0
  for (const t of sa) if (sb.has(t)) inter++
  return inter / (sa.size + sb.size - inter)
}
