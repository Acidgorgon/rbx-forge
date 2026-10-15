// Forge Sync text helpers: newline normalisation and a line-based three-way merge (diff3).
// Pure functions, no fs. Used by the engine to merge a file that changed both on disk and in Studio.

// Comparison form: CRLF -> LF and no trailing newlines (Studio sources rarely end with one, files do).
// Same rule as the legacy tools/studio-sync.py `normalise`, so legacy digests stay comparable.
export function normalise(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\n+$/, '')
}

// Text as it should be written over `like` (the current file, if any): one trailing newline and
// the file's line endings kept (a CRLF file stays CRLF).
export function toFileText(text: string, like?: string | null): string {
  const body = normalise(text) + '\n'
  return like != null && like.includes('\r\n') ? body.replace(/\n/g, '\r\n') : body
}

// ---- Myers diff on lines -> matched index pairs ----

// For each index of `a`, the matching index in `b` or -1 (an LCS, monotone). Gives up matching
// the middle (returns only the common prefix/suffix) past `maxEdits`, which only makes a merge
// more conservative (more conflicts), never wrong.
export function matchLines(a: string[], b: string[], maxEdits = 4000): Int32Array {
  const map = new Int32Array(a.length).fill(-1)
  let start = 0
  while (start < a.length && start < b.length && a[start] === b[start]) {
    map[start] = start
    start++
  }
  let endA = a.length
  let endB = b.length
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--
    endB--
    map[endA] = endB
  }
  const n = endA - start
  const m = endB - start
  if (n === 0 || m === 0) return map
  // Intern lines so the inner loop compares numbers.
  const ids = new Map<string, number>()
  const id = (s: string): number => {
    let v = ids.get(s)
    if (v === undefined) ids.set(s, (v = ids.size))
    return v
  }
  const A = Int32Array.from({ length: n }, (_, i) => id(a[start + i]))
  const B = Int32Array.from({ length: m }, (_, i) => id(b[start + i]))
  const max = Math.min(n + m, maxEdits)
  const offset = max + 1
  const v = new Int32Array(2 * max + 3)
  const trace: Int32Array[] = []
  let found = -1
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2))
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1]) ? v[offset + k + 1] : v[offset + k - 1] + 1
      let y = x - k
      while (x < n && y < m && A[x] === B[y]) {
        x++
        y++
      }
      v[offset + k] = x
      if (x >= n && y >= m) {
        found = d
        break
      }
    }
    if (found >= 0) break
  }
  if (found < 0) return map
  // Backtrack through the saved V rows (row d holds k in [-d-1, d+1] before step d ran).
  let x = n
  let y = m
  for (let d = found; d > 0; d--) {
    const row = trace[d]
    const at = (k: number): number => row[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1
    const prevX = at(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) {
      x--
      y--
      map[start + x] = start + y
    }
    x = prevX
    y = prevY
  }
  while (x > 0 && y > 0) {
    x--
    y--
    map[start + x] = start + y
  }
  return map
}

// ---- diff3 ----

export interface MergeResult {
  clean: boolean
  // The merged text (LF). When not clean, conflicting hunks carry diff3-style markers.
  text: string
}

function eq(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((line, i) => line === b[i])
}

// Three-way line merge. `ours` is the disk side, `theirs` the Studio side.
export function diff3(base: string, ours: string, theirs: string): MergeResult {
  const o = normalise(base).split('\n')
  const a = normalise(ours).split('\n')
  const b = normalise(theirs).split('\n')
  const ma = matchLines(o, a)
  const mb = matchLines(o, b)
  const out: string[] = []
  let clean = true
  let i = 0
  let j = 0
  let k = 0
  const chunk = (oc: string[], ac: string[], bc: string[]): void => {
    if (eq(ac, oc)) out.push(...bc)
    else if (eq(bc, oc) || eq(ac, bc)) out.push(...ac)
    else {
      clean = false
      out.push('<<<<<<< disk', ...ac, '||||||| base', ...oc, '=======', ...bc, '>>>>>>> studio')
    }
  }
  for (;;) {
    let n = 0
    while (i + n < o.length && ma[i + n] === j + n && mb[i + n] === k + n) n++
    if (n > 0) {
      out.push(...o.slice(i, i + n))
      i += n
      j += n
      k += n
      continue
    }
    let t = i
    while (t < o.length && !(ma[t] >= j && mb[t] >= k)) t++
    if (t >= o.length) {
      if (i < o.length || j < a.length || k < b.length) chunk(o.slice(i), a.slice(j), b.slice(k))
      break
    }
    chunk(o.slice(i, t), a.slice(j, ma[t]), b.slice(k, mb[t]))
    i = t
    j = ma[t]
    k = mb[t]
  }
  return { clean, text: out.join('\n') }
}
