// fzf-style fuzzy scoring for the palette (SPEC §8.5): consecutive runs, word starts (camelCase,
// path separators, dots) and acronyms ("ics" → InventoryControllerS…) score higher.

export interface Match {
  score: number
  // Matched character indices in the candidate.
  hits: number[]
}

const isUpper = (c: string) => c >= 'A' && c <= 'Z'
const isSep = (c: string) => c === '/' || c === '.' || c === '_' || c === '-' || c === ' ' || c === ':'

function boundary(text: string, i: number): boolean {
  if (i === 0) return true
  const prev = text[i - 1]
  const c = text[i]
  return isSep(prev) || (isUpper(c) && !isUpper(prev))
}

export function fuzzy(query: string, text: string): Match | null {
  if (!query) return { score: 0, hits: [] }
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  // Greedy left-to-right: continue a run when possible, else prefer the next word start.
  const hits: number[] = []
  let ti = 0
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]
    if (ch === ' ') continue
    let found = -1
    if (hits.length && t[ti] === ch) found = ti
    else {
      let first = -1
      for (let j = ti; j < t.length; j++) {
        if (t[j] !== ch) continue
        if (first < 0) first = j
        if (boundary(text, j)) {
          found = j
          break
        }
      }
      if (found < 0) found = first
    }
    if (found < 0) return null
    hits.push(found)
    ti = found + 1
  }
  let score = 0
  for (let k = 0; k < hits.length; k++) {
    const i = hits[k]
    score += 1
    if (boundary(text, i)) score += 6
    if (k > 0 && hits[k - 1] === i - 1) score += 4
    if (text[i] === query[k]) score += 0.5
  }
  score -= hits.length ? hits[0] * 0.15 : 0
  score -= (text.length - hits.length) * 0.02
  if (t === q) score += 20
  else if (t.startsWith(q)) score += 8
  return { score, hits }
}

// Best match across weighted fields (name ×3, instance path ×2, file path ×1).
export function fuzzyFields(query: string, fields: { text: string; weight: number }[]): { score: number; field: number; hits: number[] } | null {
  let best: { score: number; field: number; hits: number[] } | null = null
  fields.forEach((f, i) => {
    if (!f.text) return
    const m = fuzzy(query, f.text)
    if (!m) return
    const s = m.score * f.weight
    if (!best || s > best.score) best = { score: s, field: i, hits: m.hits }
  })
  return best
}
