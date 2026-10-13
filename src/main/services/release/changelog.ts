import { readSyncLog } from '../collab/activity.ts'
import { featureOfPath } from '../collab/classify.ts'
import { git, type CollabDeps } from '../collab/git.ts'
import { toRepoPath } from '../tools.ts'
import type { ChangeKind, Changelog, ChangelogCommit, StudioActivity } from './types.ts'

// Changelog from git commits since the last release tag, plus Studio sync activity in that window.
// Conventional-commit prefixes are used when present; plain subjects are classified by their verb.

const RS = '\x1e'
const US = '\x1f'
// Ends the free-form body, so file names from --name-only can be told apart from body lines.
const GS = '\x1d'

// Forge's own bookkeeping commits: folded into one line instead of listed.
const AUTO_SUBJECTS = [/^harness: sync$/i, /^forge: /i, /^Initial commit$/]

const CONVENTIONAL = /^(\w+)(?:\(([^)]*)\))?(!)?:\s*(.+)$/

const PREFIX_KIND: Record<string, ChangeKind> = {
  feat: 'feature',
  feature: 'feature',
  fix: 'fix',
  bugfix: 'fix',
  hotfix: 'fix',
  perf: 'perf',
  refactor: 'refactor',
  docs: 'docs',
  doc: 'docs',
  test: 'test',
  tests: 'test',
  chore: 'chore',
  build: 'chore',
  ci: 'chore',
  style: 'chore',
  revert: 'other'
}

export function classifySubject(subject: string, body = ''): { kind: ChangeKind; scope?: string; breaking: boolean; text: string } {
  const breakingBody = /^BREAKING[ -]CHANGE:/m.test(body)
  const match = CONVENTIONAL.exec(subject.trim())
  if (match && PREFIX_KIND[match[1].toLowerCase()]) {
    return { kind: PREFIX_KIND[match[1].toLowerCase()], scope: match[2] || undefined, breaking: Boolean(match[3]) || breakingBody, text: match[4].trim() }
  }
  const text = subject.trim()
  const verb = text.split(/\s+/)[0]?.toLowerCase() ?? ''
  let kind: ChangeKind = 'other'
  if (/^(add|adds|added|implement|implements|implemented|introduce|introduces|new|create|creates|created)$/.test(verb)) kind = 'feature'
  else if (/^(fix|fixes|fixed|repair|repairs|resolve|resolves|resolved|correct|corrects)$/.test(verb)) kind = 'fix'
  else if (/^(speed|optimi[sz]e|optimi[sz]es|faster)$/.test(verb)) kind = 'perf'
  else if (/^(refactor|refactors|rename|renames|renamed|move|moves|moved|clean|cleanup|tidy)$/.test(verb)) kind = 'refactor'
  return { kind, breaking: breakingBody, text }
}

export function parseCommitLog(stdout: string): (ChangelogCommit & { auto: boolean; files: string[] })[] {
  const out: (ChangelogCommit & { auto: boolean; files: string[] })[] = []
  for (const record of stdout.split(RS)) {
    if (!record.trim()) continue
    const end = record.indexOf(GS)
    const head = end >= 0 ? record.slice(0, end) : record
    const fileLines = end >= 0 ? record.slice(end + 1).split(/\r?\n/) : []
    const [hash, author, date, subject = '', body = ''] = head.replace(/^\r?\n/, '').split(US)
    const files = fileLines.map((l) => l.trim()).filter(Boolean).map(toRepoPath)
    const info = classifySubject(subject, body)
    const features = [...new Set(files.map(featureOfPath).filter((f): f is string => Boolean(f)))].sort()
    out.push({
      hash,
      author,
      at: Date.parse(date),
      subject: info.text,
      kind: info.kind,
      scope: info.scope,
      breaking: info.breaking,
      features,
      files,
      auto: AUTO_SUBJECTS.some((re) => re.test(subject.trim()))
    })
  }
  return out
}

const SECTIONS: [string, ChangeKind[]][] = [
  ['New', ['feature']],
  ['Fixes', ['fix']],
  ['Improvements', ['perf', 'refactor']],
  ['Other', ['other', 'docs', 'test', 'chore']]
]

export interface RenderInput {
  version?: string
  since: string | null
  commits: (ChangelogCommit & { auto?: boolean })[]
  studio: StudioActivity[]
}

export function renderChangelog(input: RenderInput): string {
  const lines: string[] = []
  const real = input.commits.filter((c) => !c.auto)
  const auto = input.commits.filter((c) => c.auto)
  const breaking = real.filter((c) => c.breaking)
  if (breaking.length) {
    lines.push('### Breaking changes')
    for (const c of breaking) lines.push(`- ${c.subject}`)
    lines.push('')
  }
  for (const [heading, kinds] of SECTIONS) {
    const items = real.filter((c) => kinds.includes(c.kind) && !c.breaking)
    if (!items.length) continue
    lines.push(`### ${heading}`)
    for (const c of items) {
      const where = c.scope || (c.features.length === 1 ? c.features[0] : '')
      lines.push(`- ${where ? `**${where}**: ` : ''}${c.subject}`)
    }
    lines.push('')
  }
  if (auto.length) {
    const features = [...new Set(auto.flatMap((c) => c.features))].sort()
    lines.push('### Synced work')
    lines.push(`- ${auto.length} auto-sync commit${auto.length === 1 ? '' : 's'}${features.length ? ` touching ${features.join(', ')}` : ''}`)
    lines.push('')
  }
  if (input.studio.length) {
    const pulled = [...new Set(input.studio.filter((s) => s.action === 'pull').map((s) => s.path))]
    const added = [...new Set(input.studio.filter((s) => s.action === 'new').map((s) => s.path))]
    const conflicts = [...new Set(input.studio.filter((s) => s.action === 'conflict').map((s) => s.path))]
    lines.push('### Studio')
    if (pulled.length) lines.push(`- ${pulled.length} script${pulled.length === 1 ? '' : 's'} edited in Studio: ${pulled.slice(0, 8).join(', ')}${pulled.length > 8 ? ', …' : ''}`)
    if (added.length) lines.push(`- ${added.length} new script${added.length === 1 ? '' : 's'} from Studio: ${added.slice(0, 8).join(', ')}${added.length > 8 ? ', …' : ''}`)
    if (conflicts.length) lines.push(`- ${conflicts.length} Studio conflict${conflicts.length === 1 ? '' : 's'} reviewed`)
    lines.push('- Maps, models and UI edited in Studio are not tracked by git and are not listed here.')
    lines.push('')
  }
  const authors = [...new Set(real.concat(auto).map((c) => c.author))].sort()
  if (authors.length) lines.push(`_Thanks: ${authors.join(', ')}_`)
  if (!lines.length) lines.push('_No code changes since the last release._')
  return lines.join('\n').trim() + '\n'
}

async function tagTime(root: string, tag: string, deps: CollabDeps): Promise<number | undefined> {
  const result = await git(root, ['log', '-1', '--format=%cI', tag], deps)
  const at = Date.parse(result.stdout.trim())
  return result.code === 0 && !Number.isNaN(at) ? at : undefined
}

export interface ChangelogOptions extends CollabDeps {
  // Start of the range (a tag); null = whole history.
  since: string | null
  syncLog?: string
  maxCommits?: number
}

export async function buildChangelog(root: string, options: ChangelogOptions): Promise<Changelog> {
  const range = options.since ? `${options.since}..HEAD` : 'HEAD'
  const args = ['log', '--no-merges', '--name-only', `--format=${RS}%H${US}%an${US}%aI${US}%s${US}%b${GS}`, `-n${options.maxCommits ?? 500}`, range, '--']
  const result = await git(root, args, options)
  const parsed = result.code === 0 ? parseCommitLog(result.stdout) : []
  const sinceAt = options.since ? await tagTime(root, options.since, options) : undefined
  const studio: StudioActivity[] = (await readSyncLog(root, options.syncLog))
    .filter((e) => e.kind === 'studio' && (sinceAt === undefined || e.at > sinceAt))
    .flatMap((e) => e.files.map((f) => ({ at: e.at, path: f.path, action: (e.studioAction ?? 'pull') as StudioActivity['action'] })))
  const commits = parsed.map(({ files: _files, ...c }) => c)
  const authors = [...new Set(parsed.map((c) => c.author))].sort()
  return {
    since: options.since,
    commits: commits.map(({ auto: _auto, ...c }) => c),
    studio,
    authors,
    markdown: renderChangelog({ since: options.since, commits, studio })
  }
}
