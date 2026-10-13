import { resolveInside } from '../project.ts'
import { toRepoPath } from '../tools.ts'
import { git, headCommit, RS, US, type CollabDeps } from './git.ts'

// Who last touched each line (git blame at HEAD) and a file's history across renames.

export interface BlameLine {
  line: number
  author: string
  at: number
  commit: string
  summary: string
  content: string
}

export interface BlameResult {
  path: string
  head: string
  lines: BlameLine[]
}

const UNCOMMITTED = '0000000000000000000000000000000000000000'

export function parseBlamePorcelain(text: string): BlameLine[] {
  const out: BlameLine[] = []
  // Per-commit facts appear only once per commit in --porcelain, but on every line with
  // --line-porcelain; keep a table so both work.
  const known = new Map<string, { author: string; at: number; summary: string }>()
  let current: { commit: string; line: number; author?: string; time?: number; tz?: string; summary?: string } | null = null
  for (const raw of text.split('\n')) {
    if (current === null) {
      const header = /^([0-9a-f]{40}|[0-9a-f]{64}) \d+ (\d+)/.exec(raw)
      if (header) current = { commit: header[1], line: Number(header[2]) }
      continue
    }
    if (raw.startsWith('\t')) {
      const prior = known.get(current.commit)
      const author = current.author ?? prior?.author ?? ''
      const at = current.time !== undefined ? current.time * 1000 : prior?.at ?? 0
      const summary = current.summary ?? prior?.summary ?? ''
      known.set(current.commit, { author, at, summary })
      out.push({
        line: current.line,
        author: current.commit === UNCOMMITTED ? 'You (not committed)' : author,
        at,
        commit: current.commit,
        summary,
        content: raw.slice(1)
      })
      current = null
      continue
    }
    const space = raw.indexOf(' ')
    const key = space < 0 ? raw : raw.slice(0, space)
    const value = space < 0 ? '' : raw.slice(space + 1)
    if (key === 'author') current.author = value
    else if (key === 'author-time') current.time = Number(value)
    else if (key === 'summary') current.summary = value
  }
  return out
}

export class BlameCache {
  private cache = new Map<string, BlameResult>()
  private max: number
  constructor(max = 50) {
    this.max = max
  }

  // Blame at HEAD, cached by HEAD commit + path (a new commit or checkout invalidates it).
  async blame(root: string, path: string, deps: CollabDeps = {}): Promise<BlameResult> {
    await resolveInside(root, path)
    const rel = toRepoPath(path)
    const head = await headCommit(root, deps)
    if (!head) throw new Error('No commits yet.')
    const key = `${root}\0${head}\0${rel}`
    const hit = this.cache.get(key)
    if (hit) {
      this.cache.delete(key)
      this.cache.set(key, hit)
      return hit
    }
    const result = await git(root, ['blame', '--line-porcelain', head, '--', rel], deps)
    if (result.code !== 0) throw new Error((result.stderr || '').trim() || `git blame failed for ${rel}`)
    const value: BlameResult = { path: rel, head, lines: parseBlamePorcelain(result.stdout) }
    this.cache.set(key, value)
    while (this.cache.size > this.max) this.cache.delete(this.cache.keys().next().value!)
    return value
  }

  clear(): void {
    this.cache.clear()
  }
}

const shared = new BlameCache()

export function blame(root: string, path: string, deps: CollabDeps = {}): Promise<BlameResult> {
  return shared.blame(root, path, deps)
}

export interface FileHistoryEntry {
  commit: string
  author: string
  at: number
  subject: string
  // The file's path in that commit (differs before a rename).
  path: string
  change: string
}

export function parseFileHistory(text: string): FileHistoryEntry[] {
  const out: FileHistoryEntry[] = []
  for (const record of text.split(RS)) {
    if (!record.trim()) continue
    const [header, ...rest] = record.split(/\r?\n/)
    const [commit, author, date, subject] = header.split(US)
    const statusLine = rest.find((l) => l.includes('\t')) || ''
    const parts = statusLine.split('\t')
    out.push({
      commit,
      author,
      at: Date.parse(date),
      subject: subject ?? '',
      path: toRepoPath(parts[parts.length - 1] || ''),
      change: (parts[0] || 'M').charAt(0)
    })
  }
  return out
}

export async function fileHistory(root: string, path: string, options: CollabDeps & { limit?: number } = {}): Promise<FileHistoryEntry[]> {
  await resolveInside(root, path)
  const rel = toRepoPath(path)
  const result = await git(
    root,
    ['log', '--follow', '--name-status', `-n${options.limit ?? 50}`, `--format=${RS}%H${US}%an${US}%aI${US}%s`, '--', rel],
    options
  )
  if (result.code !== 0) throw new Error((result.stderr || '').trim() || `git log failed for ${rel}`)
  return parseFileHistory(result.stdout)
}
