// Patch proposals: a guest may include a unified diff (```diff block) in its reply. These helpers
// find and parse the diff and apply it to file text. The guest never writes; the host's write path
// (agent/group/patches.ts) applies it when the user clicks Apply. Pure.

import type { PatchFile } from './types.ts'

export interface Hunk {
  oldStart: number
  oldCount: number
  newStart: number
  newCount: number
  // Body lines with their prefix (' ', '-', '+').
  lines: string[]
}

export interface FileDiff {
  oldPath: string | null
  newPath: string | null
  hunks: Hunk[]
}

const FENCE = /```[ \t]*(diff|patch|udiff)?[^\n]*\n([\s\S]*?)```/g

function looksLikeDiff(body: string): boolean {
  return /^---\s+\S/m.test(body) && /^\+\+\+\s+\S/m.test(body) && /^@@\s+-\d/m.test(body)
}

// Unified diffs in a reply: fenced ```diff / ```patch blocks, or any fenced block that is a diff.
// Returns the joined diff text, or null when the reply has none.
export function extractDiff(text: string): string | null {
  const out: string[] = []
  for (const m of String(text ?? '').matchAll(FENCE)) {
    const body = m[2]
    if ((m[1] || looksLikeDiff(body)) && looksLikeDiff(body)) out.push(body.replace(/\s+$/, ''))
  }
  return out.length ? out.join('\n') + '\n' : null
}

function stripPath(p: string): string | null {
  const t = p.trim().split('\t')[0].trim()
  if (t === '/dev/null') return null
  return t.replace(/^"(.*)"$/, '$1').replace(/^[ab]\//, '')
}

function hunkFull(h: Hunk): boolean {
  const old = h.lines.filter((l) => l[0] !== '+').length
  const neu = h.lines.filter((l) => l[0] !== '-').length
  return old >= h.oldCount && neu >= h.newCount
}

export function parseDiff(diff: string): FileDiff[] {
  const lines = diff.replace(/\r\n/g, '\n').split('\n')
  const files: FileDiff[] = []
  let cur: FileDiff | null = null
  let hunk: Hunk | null = null
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) {
      cur = { oldPath: stripPath(l.slice(4)), newPath: stripPath(lines[i + 1].slice(4)), hunks: [] }
      files.push(cur)
      hunk = null
      i++
      continue
    }
    const h = /^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(l)
    if (h && cur) {
      hunk = { oldStart: Number(h[1]), oldCount: h[2] === undefined ? 1 : Number(h[2]), newStart: Number(h[3]), newCount: h[4] === undefined ? 1 : Number(h[4]), lines: [] }
      cur.hunks.push(hunk)
      continue
    }
    if (!hunk) continue
    if (l.startsWith('\\')) continue
    if (l.startsWith(' ') || l.startsWith('-') || l.startsWith('+')) hunk.lines.push(l)
    // Some models drop the leading space of blank context lines.
    else if (l === '' && i < lines.length - 1 && !hunkFull(hunk)) hunk.lines.push(' ')
  }
  return files.filter((f) => f.hunks.length || f.oldPath === null || f.newPath === null)
}

export function patchFiles(diff: string): PatchFile[] {
  return parseDiff(diff).map((f) => {
    let added = 0
    let removed = 0
    for (const h of f.hunks) {
      for (const l of h.lines) {
        if (l[0] === '+') added++
        else if (l[0] === '-') removed++
      }
    }
    const path = (f.newPath ?? f.oldPath) as string
    return { path, added, removed, ...(f.oldPath === null ? { created: true } : {}), ...(f.newPath === null ? { deleted: true } : {}) }
  })
}

// A proposal in a reply: the diff and its files, or null.
export function parsePatchProposal(text: string): { diff: string; files: PatchFile[] } | null {
  const diff = extractDiff(text)
  if (!diff) return null
  const files = patchFiles(diff).filter((f) => !!f.path)
  return files.length ? { diff, files } : null
}

// Repo-relative path a patch may touch: no absolute paths, no "..", nothing under Packages/ or .git/.
export function safePatchPath(p: string): boolean {
  if (!p || p.startsWith('/') || /^[a-z]:/i.test(p) || p.includes('\\')) return false
  const parts = p.split('/')
  if (parts.some((x) => x === '..' || x === '')) return false
  return parts[0] !== 'Packages' && parts[0] !== '.git' && parts[0] !== 'node_modules'
}

function findBlock(lines: string[], block: string[], near: number, norm: (s: string) => string): number {
  if (!block.length) return Math.max(0, Math.min(near, lines.length))
  const want = block.map(norm)
  const fits = (at: number) => {
    if (at < 0 || at + want.length > lines.length) return false
    for (let k = 0; k < want.length; k++) if (norm(lines[at + k]) !== want[k]) return false
    return true
  }
  for (let d = 0, end = Math.max(lines.length, near) + 1; d <= end; d++) {
    if (fits(near + d)) return near + d
    if (d && fits(near - d)) return near - d
  }
  return -1
}

// Applies one file's hunks to its text (null = file does not exist). Hunks are located by their
// context near the stated line (exact, then ignoring whitespace). Throws when a hunk does not fit.
export function applyFileDiff(original: string | null, f: FileDiff): string | null {
  if (f.newPath === null) return null
  const eol = original?.includes('\r\n') ? '\r\n' : '\n'
  const endsWithNewline = original === null ? true : original.endsWith('\n')
  let lines = original === null || original === '' ? [] : original.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n')
  let offset = 0
  f.hunks.forEach((h, n) => {
    const before = h.lines.filter((l) => l[0] !== '+').map((l) => l.slice(1))
    const after = h.lines.filter((l) => l[0] !== '-').map((l) => l.slice(1))
    const near = Math.max(0, h.oldStart - 1 + offset)
    let at = findBlock(lines, before, near, (s) => s)
    if (at < 0) at = findBlock(lines, before, near, (s) => s.replace(/\s+/g, ' ').trim())
    if (at < 0) throw new Error(`hunk ${n + 1} (line ${h.oldStart}) does not match ${f.newPath}`)
    lines = [...lines.slice(0, at), ...after, ...lines.slice(at + before.length)]
    offset += after.length - before.length
  })
  const text = lines.join(eol)
  return text + (endsWithNewline && lines.length ? eol : '')
}
