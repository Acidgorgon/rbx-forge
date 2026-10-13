import { toRepoPath } from '../tools.ts'
import { classifyPath, groupByFeature, type ChangeCategory, type Grouped } from './classify.ts'
import { git, hasRemote, isRepo, RS, upstreamRef, US, type CollabDeps } from './git.ts'

// "What changed upstream since I last pulled?" — commits on @{u} that HEAD lacks, the files they
// touched with stats and capped diffs, grouped by GenTree feature/category, plus local work.

export interface IncomingCommit {
  hash: string
  author: string
  email: string
  at: number
  subject: string
}

export type FileChangeStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'typechange' | 'untracked' | 'conflicted' | 'unknown'

export interface ChangedFile {
  path: string
  status: FileChangeStatus
  added: number
  deleted: number
  binary: boolean
  feature?: string
  category: ChangeCategory
  // Unified diff for this file, cut to maxDiffBytes. Absent for local changes unless requested.
  diff?: string
  diffTruncated?: boolean
}

export interface IncomingSummaryInput {
  branch: string
  upstream: string
  commits: IncomingCommit[]
  files: ChangedFile[]
}

export interface IncomingOptions extends CollabDeps {
  fetch?: boolean
  maxDiffBytes?: number
  maxFiles?: number
  // Optional AI summary (e.g. a one-shot Claude call). Errors are reported, never thrown.
  summarize?: (input: IncomingSummaryInput) => Promise<string>
}

export interface IncomingChanges {
  isRepo: boolean
  upstream: string | null
  fetched: boolean
  fetchError?: string
  commits: IncomingCommit[]
  files: ChangedFile[]
  groups: Grouped<ChangedFile>[]
  // Uncommitted local changes in the working tree.
  local: ChangedFile[]
  // Files changed upstream that are also changed locally (uncommitted or unpushed): a merge may conflict.
  overlap: string[]
  // Present when files were cut at maxFiles.
  truncatedFiles?: number
  summary?: string
  summaryError?: string
  note?: string
}

const STATUS: Record<string, FileChangeStatus> = {
  A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'typechange', U: 'conflicted'
}

export function parseNumstat(text: string): Map<string, { added: number; deleted: number; binary: boolean }> {
  const out = new Map<string, { added: number; deleted: number; binary: boolean }>()
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const [a, d, ...rest] = line.split('\t')
    const path = toRepoPath(rest.join('\t'))
    const binary = a === '-' && d === '-'
    out.set(path, { added: binary ? 0 : Number(a) || 0, deleted: binary ? 0 : Number(d) || 0, binary })
  }
  return out
}

export function parseNameStatus(text: string): { path: string; status: FileChangeStatus }[] {
  const out: { path: string; status: FileChangeStatus }[] = []
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    const code = parts[0].charAt(0)
    out.push({ path: toRepoPath(parts[parts.length - 1]), status: STATUS[code] || 'unknown' })
  }
  return out
}

// Splits `git diff` output into one chunk per file (requires --no-renames so a/ and b/ paths match).
export function splitDiff(text: string): Map<string, string> {
  const out = new Map<string, string>()
  const chunks = text.split(/^(?=diff --git )/m)
  for (const chunk of chunks) {
    if (!chunk.startsWith('diff --git ')) continue
    const header = chunk.slice(0, chunk.indexOf('\n') >= 0 ? chunk.indexOf('\n') : chunk.length)
    const rest = header.slice('diff --git a/'.length)
    // rest is "<p> b/<p>"; both halves have the same length.
    const half = (rest.length - 3) / 2
    const path = Number.isInteger(half) ? rest.slice(0, half) : rest.split(' b/')[0]
    out.set(toRepoPath(path), chunk)
  }
  return out
}

export function capText(text: string, max: number): { text: string; truncated: boolean } {
  if (Buffer.byteLength(text) <= max) return { text, truncated: false }
  let cut = text.slice(0, max)
  const lastNewline = cut.lastIndexOf('\n')
  if (lastNewline > max / 2) cut = cut.slice(0, lastNewline + 1)
  return { text: cut + '\n… diff truncated …\n', truncated: true }
}

export function parseCommits(text: string): IncomingCommit[] {
  return text
    .split(RS)
    .map((record) => record.trim())
    .filter(Boolean)
    .map((record) => {
      const [hash, author, email, date, subject] = record.split(US)
      return { hash, author, email, at: Date.parse(date), subject: subject ?? '' }
    })
}

// Porcelain v1 -z: "XY path\0" (renames add "\0orig").
export function parsePorcelainZ(text: string): { path: string; status: FileChangeStatus }[] {
  const out: { path: string; status: FileChangeStatus }[] = []
  const parts = text.split('\0')
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i]
    if (entry.length < 4) continue
    const x = entry[0]
    const y = entry[1]
    const path = toRepoPath(entry.slice(3))
    let status: FileChangeStatus
    if (x === '?' && y === '?') status = 'untracked'
    else if (x === 'U' || y === 'U' || (x === 'A' && y === 'A') || (x === 'D' && y === 'D')) status = 'conflicted'
    else status = STATUS[x !== ' ' ? x : y] || 'modified'
    if (x === 'R' || x === 'C') i++ // skip the original path
    out.push({ path, status })
  }
  return out
}

async function localChanges(root: string, deps: CollabDeps): Promise<ChangedFile[]> {
  const porcelain = await git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], deps)
  const entries = parsePorcelainZ(porcelain.stdout)
  const stats = parseNumstat((await git(root, ['diff', 'HEAD', '--numstat', '--no-renames'], deps)).stdout)
  return entries.map(({ path, status }) => {
    const stat = stats.get(path) || { added: 0, deleted: 0, binary: false }
    return { path, status, ...stat, ...classifyPath(path) }
  })
}

export async function incomingChanges(root: string, options: IncomingOptions = {}): Promise<IncomingChanges> {
  const maxDiffBytes = options.maxDiffBytes ?? 20_000
  const maxFiles = options.maxFiles ?? 200
  const empty: IncomingChanges = { isRepo: false, upstream: null, fetched: false, commits: [], files: [], groups: [], local: [], overlap: [] }
  if (!(await isRepo(root, options))) return { ...empty, note: 'Not a git repository.' }

  const result: IncomingChanges = { ...empty, isRepo: true }
  if (options.fetch !== false && (await hasRemote(root, options))) {
    const fetched = await git(root, ['fetch', '--quiet'], options)
    result.fetched = fetched.code === 0
    if (fetched.code !== 0) result.fetchError = (fetched.stderr || fetched.stdout).trim() || 'git fetch failed'
  }
  result.local = await localChanges(root, options)
  const upstream = await upstreamRef(root, options)
  result.upstream = upstream
  if (!upstream) {
    result.note = 'This branch has no upstream yet, so there is nothing incoming. Sync once to publish it.'
    return result
  }

  const log = await git(root, ['log', '--no-merges', `--format=%H${US}%an${US}%ae${US}%aI${US}%s${RS}`, 'HEAD..@{u}'], options)
  result.commits = parseCommits(log.stdout)
  if (result.commits.length === 0) return result

  // Three dots: what upstream changed since the merge base, not the reverse of my own work.
  const range = 'HEAD...@{u}'
  const statuses = parseNameStatus((await git(root, ['diff', '--name-status', '--no-renames', range], options)).stdout)
  const stats = parseNumstat((await git(root, ['diff', '--numstat', '--no-renames', range], options)).stdout)
  const diffs = splitDiff((await git(root, ['diff', '--no-renames', '--no-ext-diff', range], options)).stdout)

  const kept = statuses.slice(0, maxFiles)
  if (statuses.length > kept.length) result.truncatedFiles = statuses.length - kept.length
  result.files = kept.map(({ path, status }) => {
    const stat = stats.get(path) || { added: 0, deleted: 0, binary: false }
    const file: ChangedFile = { path, status, ...stat, ...classifyPath(path) }
    const raw = diffs.get(path)
    if (raw !== undefined) {
      const capped = capText(raw, maxDiffBytes)
      file.diff = capped.text
      if (capped.truncated) file.diffTruncated = true
    }
    return file
  })
  result.groups = groupByFeature(result.files)

  const mine = new Set(result.local.map((f) => f.path))
  const unpushed = await git(root, ['diff', '--name-only', '--no-renames', '@{u}...HEAD'], options)
  for (const line of unpushed.stdout.split(/\r?\n/)) if (line.trim()) mine.add(toRepoPath(line.trim()))
  result.overlap = statuses.map((s) => s.path).filter((p) => mine.has(p))

  if (options.summarize) {
    try {
      const branch = (await git(root, ['symbolic-ref', '--short', 'HEAD'], options)).stdout.trim()
      result.summary = await options.summarize({ branch, upstream, commits: result.commits, files: result.files })
    } catch (error) {
      result.summaryError = error instanceof Error ? error.message : String(error)
    }
  }
  return result
}

// Plain-text digest of incoming changes, sized for a model prompt (used by a summarize hook).
export function incomingPrompt(input: IncomingSummaryInput, maxBytes = 40_000): string {
  const lines = [`Incoming changes on ${input.upstream} (${input.commits.length} commit(s)):`]
  for (const c of input.commits) lines.push(`- ${c.author}, ${new Date(c.at).toISOString().slice(0, 16)}: ${c.subject}`)
  lines.push('', 'Files:')
  for (const f of input.files) lines.push(`- ${f.status} ${f.path} (+${f.added} -${f.deleted})${f.feature ? ` [feature ${f.feature}]` : ''}`)
  lines.push('', 'Diffs:')
  let text = lines.join('\n')
  for (const f of input.files) {
    if (!f.diff) continue
    if (Buffer.byteLength(text) + Buffer.byteLength(f.diff) > maxBytes) {
      text += '\n(remaining diffs omitted)'
      break
    }
    text += '\n' + f.diff
  }
  return text
}
