// Small line diff for the "Add to game" confirm step: unified format with a few lines of context,
// capped so a huge rewrite still shows quickly. Pure.

export interface DiffOptions {
  context?: number
  // Lines of output before "… N more lines".
  maxLines?: number
  // Above this many lines per side the diff falls back to a summary (LCS is O(n*m)).
  maxInput?: number
}

type Op = { kind: ' ' | '-' | '+'; text: string; a: number; b: number }

function lcsOps(a: string[], b: string[]): Op[] {
  // Trim the common prefix / suffix first: most edits are local.
  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++
  const A = a.slice(pre, a.length - suf)
  const B = b.slice(pre, b.length - suf)
  const n = A.length
  const m = B.length
  const dp: Uint32Array[] = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])
  const ops: Op[] = []
  for (let k = 0; k < pre; k++) ops.push({ kind: ' ', text: a[k], a: k, b: k })
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && A[i] === B[j]) {
      ops.push({ kind: ' ', text: A[i], a: pre + i, b: pre + j })
      i++
      j++
    } else if (i < n && (j >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      ops.push({ kind: '-', text: A[i], a: pre + i, b: pre + j })
      i++
    } else {
      ops.push({ kind: '+', text: B[j], a: pre + i, b: pre + j })
      j++
    }
  }
  for (let k = 0; k < suf; k++) ops.push({ kind: ' ', text: a[a.length - suf + k], a: a.length - suf + k, b: b.length - suf + k })
  return ops
}

const split = (t: string) => (t === '' ? [] : t.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n'))

export function diffStat(before: string, after: string): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const o of lcsOps(split(before), split(after))) {
    if (o.kind === '+') added++
    else if (o.kind === '-') removed++
  }
  return { added, removed }
}

export function unifiedDiff(path: string, before: string, after: string, opts: DiffOptions = {}): string {
  const context = opts.context ?? 3
  const maxLines = opts.maxLines ?? 400
  const a = split(before)
  const b = split(after)
  if (a.length > (opts.maxInput ?? 4000) || b.length > (opts.maxInput ?? 4000)) return `--- ${path}\n+++ ${path}\n@@ file too large to diff: ${a.length} -> ${b.length} lines @@\n`
  const ops = lcsOps(a, b)
  const changed = ops.map((o, i) => (o.kind !== ' ' ? i : -1)).filter((i) => i >= 0)
  if (!changed.length) return ''
  // Hunks: changed ops plus context, merged when they touch.
  const hunks: [number, number][] = []
  for (const i of changed) {
    const s = Math.max(0, i - context)
    const e = Math.min(ops.length - 1, i + context)
    const last = hunks[hunks.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else hunks.push([s, e])
  }
  const lines = [`--- ${path}`, `+++ ${path}`]
  let shown = 0
  let cut = 0
  for (const [s, e] of hunks) {
    const seg = ops.slice(s, e + 1)
    const aLen = seg.filter((o) => o.kind !== '+').length
    const bLen = seg.filter((o) => o.kind !== '-').length
    const header = `@@ -${seg[0].a + 1},${aLen} +${seg[0].b + 1},${bLen} @@`
    if (shown >= maxLines) {
      cut += seg.length
      continue
    }
    lines.push(header)
    for (const o of seg) {
      if (shown >= maxLines) {
        cut++
        continue
      }
      lines.push(`${o.kind}${o.text}`)
      shown++
    }
  }
  if (cut) lines.push(`… ${cut} more lines`)
  return lines.join('\n') + '\n'
}
