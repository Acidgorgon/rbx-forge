import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { toRepoPath } from '../tools.ts'
import { featureOfPath } from './classify.ts'
import { git, isRepo, RS, US, type CollabDeps } from './git.ts'

// One timeline of who did what: git commits (any branch reachable from HEAD) merged with the
// Studio sync log (.studio-sync/sync.log, written by tools/studio-sync.py).

export type ActivityKind = 'commit' | 'studio'
export type StudioAction = 'pull' | 'new' | 'conflict'

export interface ActivityFile {
  path: string
  // A/M/D/R… for commits; the sync action for Studio entries.
  change: string
}

export interface ActivityEntry {
  at: number
  who: string
  kind: ActivityKind
  files: ActivityFile[]
  message: string
  commit?: string
  studioAction?: StudioAction
}

export interface ActivityOptions extends CollabDeps {
  since?: number | Date
  until?: number | Date
  // Case-insensitive substring of the author name; 'Studio' selects Studio entries only.
  author?: string
  // Keep entries touching this GenTree feature (case-insensitive).
  feature?: string
  limit?: number
  // Path of the sync log, relative to root (default .studio-sync/sync.log).
  syncLog?: string
}

export const STUDIO_AUTHOR = 'Studio'

function ms(value: number | Date | undefined): number | undefined {
  return value === undefined ? undefined : value instanceof Date ? value.getTime() : value
}

// studio-sync.py writes "HH:MM:SS message" (local time, no date). Dates are reconstructed backwards
// from anchorMs (the log file's mtime = time of the last line): whenever a line's clock time is later
// than the line after it, a midnight passed between them.
export function parseSyncLog(text: string, anchorMs: number): ActivityEntry[] {
  const lines = text.split(/\r?\n/).filter((l) => /^\d{2}:\d{2}:\d{2} /.test(l))
  const out: ActivityEntry[] = []
  const day = new Date(anchorMs)
  day.setHours(0, 0, 0, 0)
  let dayStart = day.getTime()
  let nextSeconds = Infinity
  const anchorSeconds = (anchorMs - dayStart) / 1000
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    const [h, m, s] = line.slice(0, 8).split(':').map(Number)
    const seconds = h * 3600 + m * 60 + s
    const limit = i === lines.length - 1 ? anchorSeconds + 1 : nextSeconds
    if (seconds > limit) {
      const prev = new Date(dayStart)
      prev.setDate(prev.getDate() - 1)
      dayStart = prev.getTime()
    }
    nextSeconds = seconds
    const rest = line.slice(9)
    const match = /^(pull|new|conflict|differs at start)\s+(.+?)\s*$/.exec(rest)
    if (!match) continue
    const action: StudioAction = match[1] === 'pull' ? 'pull' : match[1] === 'new' ? 'new' : 'conflict'
    const path = toRepoPath(match[2])
    const at = new Date(dayStart)
    at.setHours(h, m, s, 0)
    const message =
      action === 'pull'
        ? `Studio edit pulled into ${path}`
        : action === 'new'
          ? `New script from Studio: ${path}`
          : `Studio and repo both changed ${path}; Studio version held for review`
    out.push({ at: at.getTime(), who: STUDIO_AUTHOR, kind: 'studio', studioAction: action, files: [{ path, change: action }], message })
  }
  return out.reverse()
}

// git log --name-status with RS-prefixed records: RS hash US author US date US subject \n\n A\tpath …
export function parseLogNameStatus(text: string): ActivityEntry[] {
  const out: ActivityEntry[] = []
  for (const record of text.split(RS)) {
    if (!record.trim()) continue
    const [headerLine, ...rest] = record.split(/\r?\n/)
    const [commit, who, date, message] = headerLine.split(US)
    const files: ActivityFile[] = []
    for (const line of rest) {
      if (!line.trim()) continue
      const parts = line.split('\t')
      files.push({ path: toRepoPath(parts[parts.length - 1]), change: parts[0].charAt(0) })
    }
    out.push({ at: Date.parse(date), who, kind: 'commit', commit, files, message: message ?? '' })
  }
  return out
}

export async function readSyncLog(root: string, relPath = '.studio-sync/sync.log'): Promise<ActivityEntry[]> {
  const file = join(root, relPath)
  try {
    const [text, info] = await Promise.all([readFile(file, 'utf8'), stat(file)])
    return parseSyncLog(text, info.mtimeMs)
  } catch {
    return []
  }
}

function matchesFeature(entry: ActivityEntry, feature: string): boolean {
  const want = feature.toLowerCase()
  return entry.files.some((f) => featureOfPath(f.path)?.toLowerCase() === want)
}

export async function activityFeed(root: string, options: ActivityOptions = {}): Promise<ActivityEntry[]> {
  const since = ms(options.since)
  const until = ms(options.until)
  const limit = options.limit ?? 300
  const studioOnly = options.author?.toLowerCase() === STUDIO_AUTHOR.toLowerCase()
  let commits: ActivityEntry[] = []
  if (!studioOnly && (await isRepo(root, options))) {
    const args = ['log', '--no-merges', '--name-status', `--format=${RS}%H${US}%an${US}%aI${US}%s`, `-n${Math.max(limit * 2, 100)}`]
    if (since !== undefined) args.push(`--since=@${Math.floor(since / 1000)}`)
    if (until !== undefined) args.push(`--until=@${Math.ceil(until / 1000)}`)
    const result = await git(root, args, options)
    if (result.code === 0) commits = parseLogNameStatus(result.stdout)
  }
  const studio = options.author && !studioOnly ? [] : await readSyncLog(root, options.syncLog)
  let entries = [...commits, ...studio]
  if (since !== undefined) entries = entries.filter((e) => e.at >= since)
  if (until !== undefined) entries = entries.filter((e) => e.at <= until)
  if (options.author && !studioOnly) {
    const who = options.author.toLowerCase()
    entries = entries.filter((e) => e.who.toLowerCase().includes(who))
  }
  if (options.feature) entries = entries.filter((e) => matchesFeature(e, options.feature!))
  entries.sort((a, b) => b.at - a.at)
  return entries.slice(0, limit)
}
