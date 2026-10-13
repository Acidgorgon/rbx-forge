import { run } from '../tools.ts'
import { DEFAULT_BRANCH_PREFIX, readProjectConfig } from './config.ts'
import { collabEnv, currentBranch, firstError, git, hasRemote, locate, upstreamRef, type CollabDeps } from './git.ts'

// Feature branches and pull requests. Uses the GitHub CLI (gh) when it is installed and signed in;
// otherwise hands back a github.com compare URL that opens the "new pull request" page in a browser.

export function slugifyBranch(name: string): string {
  return name
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^A-Za-z0-9._/-]/g, '')
    .replace(/\.{2,}/g, '.')
    .replace(/\/{2,}/g, '/')
    .replace(/-{2,}/g, '-')
    .replace(/^[-./]+|[-./]+$/g, '')
    .replace(/\.lock$/i, '')
}

export interface StartBranchOptions extends CollabDeps {
  prefix?: string
  // Sync before branching (defaults to fetch + pull --rebase --autostash when there is an upstream).
  // Pass GitSync.syncNow to reuse the app's sync; return an error string to stop.
  sync?: () => Promise<{ error?: string } | void>
}

export interface StartBranchResult {
  branch: string
  from: string | null
  synced: boolean
  note?: string
}

async function defaultSync(root: string, deps: CollabDeps): Promise<{ error?: string; synced: boolean }> {
  if (!(await hasRemote(root, deps))) return { synced: false }
  const fetched = await git(root, ['fetch', '--quiet'], deps)
  if (fetched.code !== 0) return { error: firstError(fetched) || 'git fetch failed', synced: false }
  if (!(await upstreamRef(root, deps))) return { synced: true }
  const pulled = await git(root, ['pull', '--rebase', '--autostash'], deps)
  if (pulled.code !== 0) {
    await git(root, ['rebase', '--abort'], deps)
    return { error: `Could not update from the remote: ${firstError(pulled)}. Sync and resolve first.`, synced: false }
  }
  return { synced: true }
}

export async function startFeatureBranch(root: string, name: string, options: StartBranchOptions = {}): Promise<StartBranchResult> {
  const prefix = options.prefix ?? (await readProjectConfig(root)).config.branchPrefix ?? DEFAULT_BRANCH_PREFIX
  const slug = slugifyBranch(name)
  if (!slug) throw new Error('Give the branch a name.')
  const branch = slug.startsWith(prefix) ? slug : prefix + slug
  const valid = await git(root, ['check-ref-format', '--branch', branch], options)
  if (valid.code !== 0) throw new Error(`"${branch}" is not a valid branch name.`)
  const exists = await git(root, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], options)
  if (exists.code === 0) throw new Error(`Branch ${branch} already exists. Switch to it instead.`)
  const conflicts = await git(root, ['diff', '--name-only', '--diff-filter=U'], options)
  if (conflicts.stdout.trim()) throw new Error('Resolve the merge conflicts before starting a branch.')

  const from = await currentBranch(root, options)
  let synced = false
  if (options.sync) {
    const outcome = await options.sync()
    if (outcome && outcome.error) throw new Error(outcome.error)
    synced = true
  } else {
    const outcome = await defaultSync(root, options)
    if (outcome.error) throw new Error(outcome.error)
    synced = outcome.synced
  }
  const switched = await git(root, ['switch', '-c', branch], options)
  if (switched.code !== 0) throw new Error(firstError(switched) || 'git switch failed')
  const result: StartBranchResult = { branch, from, synced }
  if (!synced) result.note = 'No remote; the branch is local until you add one.'
  return result
}

export interface GitHubRepo {
  host: string
  owner: string
  repo: string
}

// https://github.com/o/r(.git), git@github.com:o/r.git, ssh://git@github.com/o/r.git
export function parseGitHubRemote(url: string): GitHubRepo | null {
  const trimmed = url.trim()
  const patterns = [
    /^https?:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^ssh:\/\/(?:[^@/]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/i,
    /^(?:[^@/]+@)?([^/:]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/i
  ]
  for (const pattern of patterns) {
    const match = pattern.exec(trimmed)
    if (match && /github/i.test(match[1])) return { host: match[1].toLowerCase(), owner: match[2], repo: match[3] }
  }
  return null
}

// Compare URL with the GitHub "quick pull" query parameters (title, body pre-filled).
export function compareUrl(repo: GitHubRepo, base: string, head: string, fields: { title?: string; body?: string } = {}): string {
  const params = new URLSearchParams({ quick_pull: '1' })
  if (fields.title) params.set('title', fields.title)
  // Long URLs fail with 414; keep the body short and let the person finish it in the browser.
  if (fields.body) params.set('body', fields.body.length > 3000 ? fields.body.slice(0, 3000) + '\n…' : fields.body)
  const enc = (s: string) => s.split('/').map(encodeURIComponent).join('/')
  return `https://${repo.host}/${repo.owner}/${repo.repo}/compare/${enc(base)}...${enc(head)}?${params.toString()}`
}

export async function defaultBranch(root: string, deps: CollabDeps = {}): Promise<string> {
  const head = await git(root, ['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'], deps)
  if (head.code === 0 && head.stdout.trim()) return head.stdout.trim().replace(/^origin\//, '')
  for (const name of ['main', 'master']) {
    const ref = await git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`], deps)
    if (ref.code === 0) return name
  }
  return 'main'
}

export interface GhStatus {
  available: boolean
  path?: string
  reason?: string
}

export async function ghStatus(root: string, deps: CollabDeps = {}): Promise<GhStatus> {
  const gh = locate('gh', deps)
  if (!gh) return { available: false, reason: 'GitHub CLI (gh) is not installed.' }
  const auth = await run(gh, ['auth', 'status'], root, collabEnv(deps))
  if (auth.code !== 0) return { available: false, path: gh, reason: 'GitHub CLI is not signed in (run gh auth login).' }
  return { available: true, path: gh }
}

export interface PullRequestInput {
  title: string
  body?: string
  base?: string
  draft?: boolean
}

export type PullRequestResult =
  | { kind: 'created'; url: string; branch: string; base: string }
  | { kind: 'browser'; url: string; branch: string; base: string; reason: string }

// Pushes the current branch, then opens a PR with gh, or returns the compare URL for the browser.
export async function openPullRequest(root: string, input: PullRequestInput, deps: CollabDeps = {}): Promise<PullRequestResult> {
  if (!input.title.trim()) throw new Error('A pull request needs a title.')
  const branch = await currentBranch(root, deps)
  if (!branch) throw new Error('Detached HEAD; switch to a branch first.')
  const base = input.base || (await defaultBranch(root, deps))
  if (branch === base) throw new Error(`You are on ${base}. Start a feature branch first.`)
  const remote = await git(root, ['remote', 'get-url', 'origin'], deps)
  if (remote.code !== 0) throw new Error('No origin remote to open a pull request on.')

  const pushed = await git(root, ['push', '-u', 'origin', 'HEAD'], deps)
  if (pushed.code !== 0) throw new Error(firstError(pushed) || 'git push failed')

  const gh = await ghStatus(root, deps)
  if (gh.available && gh.path) {
    const args = ['pr', 'create', '--title', input.title, '--body', input.body || '', '--base', base, '--head', branch]
    if (input.draft) args.push('--draft')
    const created = await run(gh.path, args, root, collabEnv(deps))
    const url = /https?:\/\/\S+\/pull\/\d+/.exec(created.stdout + '\n' + created.stderr)?.[0]
    if (created.code === 0 && url) return { kind: 'created', url, branch, base }
    // An existing PR for this branch: gh prints its URL in the error.
    if (url) return { kind: 'created', url, branch, base }
    const repo = parseGitHubRemote(remote.stdout)
    if (!repo) throw new Error(firstError(created) || 'gh pr create failed')
    return { kind: 'browser', url: compareUrl(repo, base, branch, input), branch, base, reason: firstError(created) || 'gh pr create failed' }
  }
  const repo = parseGitHubRemote(remote.stdout)
  if (!repo) throw new Error(`origin (${remote.stdout.trim()}) is not a GitHub remote; open the pull request on your host's website.`)
  return { kind: 'browser', url: compareUrl(repo, base, branch, input), branch, base, reason: gh.reason || 'GitHub CLI unavailable' }
}

export interface OpenPullRequest {
  number: number
  title: string
  url: string
  author: string
  branch: string
  draft: boolean
  updatedAt: string
}

export function parsePrList(json: string): OpenPullRequest[] {
  const raw = JSON.parse(json) as Array<Record<string, unknown>>
  return raw.map((pr) => ({
    number: Number(pr.number),
    title: String(pr.title ?? ''),
    url: String(pr.url ?? ''),
    author: String((pr.author as { login?: string } | undefined)?.login ?? ''),
    branch: String(pr.headRefName ?? ''),
    draft: Boolean(pr.isDraft),
    updatedAt: String(pr.updatedAt ?? '')
  }))
}

export async function listOpenPRs(root: string, deps: CollabDeps = {}): Promise<{ available: boolean; prs: OpenPullRequest[]; reason?: string }> {
  const gh = await ghStatus(root, deps)
  if (!gh.available || !gh.path) return { available: false, prs: [], reason: gh.reason }
  const result = await run(
    gh.path,
    ['pr', 'list', '--state', 'open', '--limit', '50', '--json', 'number,title,url,author,headRefName,isDraft,updatedAt'],
    root,
    collabEnv(deps)
  )
  if (result.code !== 0) return { available: false, prs: [], reason: firstError(result) || 'gh pr list failed' }
  try {
    return { available: true, prs: parsePrList(result.stdout) }
  } catch {
    return { available: false, prs: [], reason: 'Could not read gh output.' }
  }
}
