// "Since you were away": what changed while the user was not looking. Teammate Studio edits pulled by
// Forge Sync, git commits by others, lab runs that finished, open conflicts / blockers and failing
// tests from the last run. Each line links to the place in Forge. Pure: main gathers the inputs.

import type { StudioConflict } from '../types.ts'
import type { SyncEntry, SyncStatus } from '../sync/types.ts'
import type { Digest, DigestItem, LabRunRecord } from './types.ts'

// git log --format for parseGitLog: hash, author name, author email, unix time, subject.
export const GIT_LOG_FORMAT = '%H%x1f%an%x1f%ae%x1f%at%x1f%s%x1e'

export interface GitCommit {
  hash: string
  author: string
  email: string
  at: number
  subject: string
}

export function parseGitLog(stdout: string): GitCommit[] {
  const out: GitCommit[] = []
  for (const record of stdout.split('\x1e')) {
    const parts = record.replace(/^\s+/, '').split('\x1f')
    if (parts.length < 5 || !/^[0-9a-f]{7,}$/i.test(parts[0])) continue
    out.push({ hash: parts[0], author: parts[1], email: parts[2], at: Number(parts[3]) * 1000 || 0, subject: parts.slice(4).join('\x1f').trim() })
  }
  return out
}

export function commitsByOthers(commits: GitCommit[], me: { name?: string; email?: string }): GitCommit[] {
  const email = me.email?.trim().toLowerCase()
  const name = me.name?.trim().toLowerCase()
  if (!email && !name) return commits
  return commits.filter((c) => {
    if (email && c.email.trim().toLowerCase() === email) return false
    if (!email && name && c.author.trim().toLowerCase() === name) return false
    return true
  })
}

export interface FailingTest {
  file: string
  name: string
}

export interface DigestInputs {
  reason: 'open' | 'idle'
  since: number
  project: string
  // Forge Sync reconcile outcomes kept by main (any age; filtered here by `since`).
  syncEntries: SyncEntry[]
  // Already limited to commits since the last seen HEAD, by others.
  commits: GitCommit[]
  labRuns: LabRunRecord[]
  syncStatus: SyncStatus | null
  studioConflicts: StudioConflict[]
  gitConflicts: string[]
  tests: { failed: number; total: number; failing: FailingTest[]; at?: number } | null
}

const PULLED: ReadonlySet<SyncEntry['action']> = new Set(['pulled', 'merged', 'created', 'renamed', 'trashed'])
const VERB: Partial<Record<SyncEntry['action'], string>> = { pulled: 'edited in Studio', merged: 'merged with Studio edits', created: 'created in Studio', renamed: 'renamed in Studio', trashed: 'deleted in Studio' }
export const MAX_LINES_PER_KIND = 8

const base = (path: string) => path.split('/').pop() || path
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

export function buildDigest(input: DigestInputs): Digest {
  const items: DigestItem[] = []

  // Blockers first: they stop work.
  const conflictPaths = new Set<string>()
  for (const c of input.studioConflicts) {
    if (conflictPaths.has(c.path)) continue
    conflictPaths.add(c.path)
    items.push({ id: `conflict:${c.path}`, kind: 'conflict', text: `Studio conflict: ${base(c.path)}`, detail: c.reason === 'first-run' ? 'first sync: Studio and disk differ' : c.reason === 'deleted-vs-edited' ? 'deleted on one side, edited on the other' : 'changed in Studio and on disk', target: { kind: 'conflict', path: c.path } })
  }
  for (const place of input.syncStatus?.places ?? []) {
    if (place.gate !== 'blocked') continue
    items.push({ id: `blocked:${place.placeKey}`, kind: 'blocker', text: `rojo serve is held for ${place.place?.name ?? place.projectFile}`, detail: place.conflicts || !place.studioOnly?.holds ? `${plural(place.conflicts, 'conflict')} to decide` : `${plural(place.studioOnly.count, 'Studio-only script')} not on disk: pull to disk`, target: { kind: 'side', view: 'sync' } })
  }
  for (const file of input.gitConflicts) items.push({ id: `git-conflict:${file}`, kind: 'blocker', text: `Git merge conflict: ${base(file)}`, detail: file, target: { kind: 'side', view: 'sync' } })
  if (input.syncStatus?.pendingStudioEdits?.length) {
    const n = input.syncStatus.pendingStudioEdits.length
    items.push({ id: 'pending-studio', kind: 'blocker', text: `${plural(n, 'Studio edit')} not committed yet`, detail: 'commit them so teammates get them', target: { kind: 'side', view: 'sync' } })
  }

  // Teammate edits from Studio (newest per file).
  const pulls = new Map<string, SyncEntry>()
  for (const e of input.syncEntries) {
    if (!PULLED.has(e.action) || e.at < input.since) continue
    const prev = pulls.get(e.file)
    if (!prev || prev.at <= e.at) pulls.set(e.file, e)
  }
  const pullList = [...pulls.values()].sort((a, b) => b.at - a.at)
  for (const e of pullList.slice(0, MAX_LINES_PER_KIND)) {
    items.push({ id: `studio:${e.file}`, kind: 'studio', text: `${base(e.file)} ${VERB[e.action] ?? 'changed in Studio'}`, detail: e.action === 'renamed' && e.from ? `from ${e.from}` : e.file, at: e.at, target: e.action === 'trashed' ? { kind: 'side', view: 'sync' } : { kind: 'file', path: e.file } })
  }
  if (pullList.length > MAX_LINES_PER_KIND) items.push({ id: 'studio:more', kind: 'studio', text: `and ${plural(pullList.length - MAX_LINES_PER_KIND, 'more Studio change')}`, target: { kind: 'side', view: 'sync' } })

  // Commits by others.
  const commits = input.commits.slice().sort((a, b) => b.at - a.at)
  for (const c of commits.slice(0, MAX_LINES_PER_KIND)) {
    items.push({ id: `commit:${c.hash}`, kind: 'commit', text: `${c.author}: ${c.subject}`, detail: c.hash.slice(0, 7), at: c.at, target: { kind: 'side', view: 'sync' } })
  }
  if (commits.length > MAX_LINES_PER_KIND) items.push({ id: 'commit:more', kind: 'commit', text: `and ${plural(commits.length - MAX_LINES_PER_KIND, 'more commit')}`, target: { kind: 'side', view: 'sync' } })

  // Lab runs.
  const runs = input.labRuns.filter((r) => r.at >= input.since).sort((a, b) => b.at - a.at)
  for (const [i, r] of runs.slice(0, MAX_LINES_PER_KIND).entries()) {
    items.push({ id: `lab:${r.lab}:${r.at}:${i}`, kind: 'lab', text: `${r.label}${r.name ? `: ${r.name}` : ''} ${r.ok ? 'finished' : 'failed'}`, at: r.at, target: r.target })
  }

  // Failing tests from the last run.
  if (input.tests && input.tests.failed > 0) {
    items.push({ id: 'tests', kind: 'tests', text: `${plural(input.tests.failed, 'test')} failing in the last run`, detail: `${input.tests.total - input.tests.failed} of ${input.tests.total} passed`, at: input.tests.at, target: { kind: 'side', view: 'tests' } })
    for (const t of input.tests.failing.slice(0, 5)) items.push({ id: `test:${t.file}:${t.name}`, kind: 'tests', text: t.name, detail: t.file, target: { kind: 'file', path: t.file } })
  }

  return { reason: input.reason, since: input.since, project: input.project, items }
}

// Short header line: "3 Studio edits · 2 commits · 1 conflict".
export function digestSummary(d: Digest): string {
  const count = (kind: DigestItem['kind']) => d.items.filter((i) => i.kind === kind && !i.id.endsWith(':more') && !i.id.startsWith('test:')).length
  const parts: string[] = []
  const c = count('conflict') + count('blocker')
  if (c) parts.push(plural(c, 'blocker'))
  if (count('studio')) parts.push(plural(count('studio'), 'Studio edit'))
  if (count('commit')) parts.push(plural(count('commit'), 'commit'))
  if (count('lab')) parts.push(plural(count('lab'), 'lab run'))
  if (count('tests')) parts.push('failing tests')
  return parts.join(' · ') || 'Nothing new'
}
