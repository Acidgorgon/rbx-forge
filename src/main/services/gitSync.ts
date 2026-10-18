import { existsSync, readdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import type { GitStatus, SyncSettings } from '@shared/types'
import { findTool, outputLines, run, toolEnv, toRepoPath, type RunResult } from './tools.ts'
import { guardReason, moduleName } from './sync/deleteGuard.ts'

// Forge's own removals leave a copy here (Forge Sync, Explorer delete, rewind): such a delete was meant.
const FORGE_TRASH = ['.forge', 'sync', 'trash']

export const DEFAULT_SYNC: SyncSettings = { autoSyncMinutes: 5, autoCommit: true }

export interface GitSyncOptions {
  root: string
  settings: () => SyncSettings
  onStatus?: (status: GitStatus) => void
  log?: (text: string, stream?: 'stdout' | 'stderr' | 'info') => void
  git?: string
}

export function emptyStatus(error?: string): GitStatus {
  return { isRepo: false, hasRemote: false, ahead: 0, behind: 0, dirty: 0, conflicts: [], error }
}

// Collaborator sync over the plain git CLI. Never force-pushes or resets.
export class GitSync {
  readonly root: string
  private options: GitSyncOptions
  private env: NodeJS.ProcessEnv
  private gitPath: string
  private busy: Promise<GitStatus> | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private lastSync?: number
  private lastError?: string
  // Deletes the auto-commit holds back, already reported (logged once each).
  private heldReported = new Set<string>()
  // Every git step (auto-sync, Sync now, the Source control panel) runs one at a time on this chain.
  private chain: Promise<unknown> = Promise.resolve()
  // The Source control commit box has text (scmSetDraft).
  private draft = false
  // What the last sync skipped because of manual work (GitStatus.note), and the last one logged.
  private note?: string
  private noteLogged?: string

  constructor(options: GitSyncOptions) {
    this.options = options
    this.root = options.root
    // No credential prompts or editors: they would hang a background sync.
    this.env = { ...toolEnv(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_MERGE_AUTOEDIT: 'no' }
    // Full path: a GUI app's PATH may not have git, and Windows lookups by bare name skip toolEnv's PATH.
    this.gitPath = options.git || findTool('git') || 'git'
  }

  private async git(args: string[]): Promise<RunResult> {
    const result = await run(this.gitPath, ['-c', 'core.quotepath=false', ...args], this.root, this.env)
    this.options.log?.(`git ${args.join(' ')}${result.code !== 0 ? ` (exit ${result.code})` : ''}`, 'info')
    const output = (result.stdout + result.stderr).trim()
    if (output && args[0] !== 'status' && args[0] !== 'rev-parse' && args[0] !== 'rev-list' && args[0] !== 'diff') {
      this.options.log?.(output, result.code === 0 ? 'stdout' : 'stderr')
    }
    return result
  }

  private async quiet(args: string[]): Promise<RunResult> {
    return run(this.gitPath, ['-c', 'core.quotepath=false', ...args], this.root, this.env)
  }

  // git with the sync's environment, for the Source control panel; loud steps go to the git log.
  exec(args: string[], loud = true): Promise<RunResult> {
    return loud ? this.git(args) : this.quiet(args)
  }

  // Runs fn after every queued git step (and before the next): no two steps overlap.
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn)
    this.chain = next.catch(() => undefined)
    return next
  }

  setDraft(draft: boolean): void {
    this.draft = draft
  }

  // Manual work in Source control the auto-sync must leave alone: staged files, a typed message.
  async manualWork(): Promise<{ staged: boolean; draft: boolean }> {
    // Exit 1: the index differs from HEAD (also before the first commit, against the empty tree).
    const staged = (await this.quiet(['--no-optional-locks', 'diff', '--cached', '--quiet'])).code === 1
    return { staged, draft: this.draft }
  }

  clearNote(): void {
    this.note = undefined
  }

  private async conflictedFiles(): Promise<string[]> {
    const result = await this.quiet(['--no-optional-locks', 'diff', '--name-only', '--diff-filter=U'])
    return result.code === 0 ? outputLines(result.stdout).map(toRepoPath) : []
  }

  private async upstream(): Promise<string | null> {
    const result = await this.quiet(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    return result.code === 0 ? result.stdout.trim() : null
  }

  private async branch(): Promise<string | undefined> {
    const result = await this.quiet(['symbolic-ref', '--short', 'HEAD'])
    return result.code === 0 ? result.stdout.trim() : undefined
  }

  private async hasCommits(): Promise<boolean> {
    return (await this.quiet(['rev-parse', '--verify', 'HEAD'])).code === 0
  }

  private async rebaseInProgress(): Promise<boolean> {
    for (const name of ['rebase-merge', 'rebase-apply']) {
      const result = await this.quiet(['rev-parse', '--git-path', name])
      if (result.code === 0 && existsSync(resolve(this.root, result.stdout.trim()))) return true
    }
    return false
  }

  // Local status. With fetch, refreshes the remote first so behind is current.
  async status(fetch = false): Promise<GitStatus> {
    const inside = await this.quiet(['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return emptyStatus()
    const remotes = outputLines((await this.quiet(['remote'])).stdout)
    if (fetch && remotes.length > 0) {
      const fetched = await this.quiet(['fetch', '--quiet'])
      if (fetched.code !== 0) this.lastError = fetched.stderr.trim() || 'git fetch failed'
    }
    let ahead = 0
    let behind = 0
    if (await this.upstream()) {
      const counts = await this.quiet(['rev-list', '--left-right', '--count', 'HEAD...@{u}'])
      const [left, right] = counts.stdout.trim().split(/\s+/).map(Number)
      ahead = left || 0
      behind = right || 0
    }
    // No optional locks: a refresh never holds index.lock while a commit or stage runs.
    const porcelain = await this.quiet(['--no-optional-locks', 'status', '--porcelain'])
    const dirty = outputLines(porcelain.stdout).length
    const status: GitStatus = {
      isRepo: true,
      hasRemote: remotes.length > 0,
      branch: await this.branch(),
      ahead,
      behind,
      dirty,
      conflicts: await this.conflictedFiles()
    }
    if (this.lastSync) status.lastSync = this.lastSync
    if (this.lastError) status.error = this.lastError
    if (this.note) status.note = this.note
    return status
  }

  async refresh(fetch = false): Promise<GitStatus> {
    const status = await this.status(fetch)
    this.options.onStatus?.(status)
    return status
  }

  // Commit (optional), fetch, pull --rebase; on conflict fall back to a merge that leaves the conflicts in place.
  syncNow(): Promise<GitStatus> {
    if (!this.busy) {
      this.busy = this.exclusive(() => this.doSync()).finally(() => {
        this.busy = null
      })
    }
    return this.busy
  }

  // Manual work in Source control wins over the auto-sync: while files are staged or a commit message
  // is typed, the "harness: sync" commit is skipped (it would sweep the staged selection into it); while
  // files are staged the pull is skipped too (--autostash puts them back unstaged) and the push only
  // runs when nothing is waiting to come in.
  private async doSync(): Promise<GitStatus> {
    this.lastError = undefined
    this.note = undefined
    const before = await this.status()
    if (!before.isRepo) return this.finish('Not a git repository. Set up sync first.')
    if (before.conflicts.length > 0) {
      return this.finish(`Resolve the conflicts in ${before.conflicts.length} file(s), then commit, before syncing again.`)
    }
    if (await this.rebaseInProgress()) return this.finish('A rebase is in progress. Finish or abort it first.')

    const manual = await this.manualWork()
    const skipped: string[] = []
    if (this.options.settings().autoCommit && before.dirty > 0) {
      if (manual.staged || manual.draft) {
        skipped.push(`did not commit your changes (${manual.staged ? 'files are staged' : 'a commit message is typed'} in Source control)`)
      } else {
        const held = await this.heldDeletions()
        await this.git(['add', '-A'])
        if (held.length) await this.quiet(['reset', '-q', '--', ...held.map((h) => h.path)])
        this.reportHeld(held)
        // Only held deletes changed: nothing to commit.
        const staged = await this.quiet(['diff', '--cached', '--quiet'])
        if (staged.code !== 0) {
          const commit = await this.git(['commit', '-m', 'harness: sync'])
          if (commit.code !== 0) return this.finish(firstLine(commit) || 'git commit failed')
        }
      }
    }
    if (!before.hasRemote) return this.finish(undefined, true, skipped)

    const fetched = await this.git(['fetch'])
    if (fetched.code !== 0) return this.finish(firstLine(fetched) || 'git fetch failed', false, skipped)

    if (!(await this.upstream())) {
      const branch = await this.branch()
      if (!branch) return this.finish('Detached HEAD; check out a branch to sync.')
      const remoteBranch = await this.quiet(['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
      if (remoteBranch.code === 0) {
        await this.git(['branch', `--set-upstream-to=origin/${branch}`])
      } else {
        const pushed = await this.git(['push', '-u', 'origin', 'HEAD'])
        return this.finish(pushed.code === 0 ? undefined : firstLine(pushed) || 'git push failed', true, skipped)
      }
    }

    if (manual.staged) {
      const now = await this.status()
      if (now.behind > 0) {
        skipped.push(`did not pull ${now.behind} incoming commit${now.behind === 1 ? '' : 's'} (pulling now would unstage your staged files; commit or unstage them, then sync)`)
        return this.finish(undefined, false, skipped)
      }
    } else {
      const pullError = await this.pullStep()
      if (pullError) return this.finish(pullError, false, skipped)
    }

    const after = await this.status()
    if (after.ahead > 0) {
      const pushed = await this.git(['push'])
      if (pushed.code !== 0) return this.finish(pushError(pushed), false, skipped)
    }
    return this.finish(undefined, true, skipped)
  }

  // pull --rebase --autostash; when that stops, abort the rebase and merge instead, leaving any
  // conflicts in place. The error to show, or undefined.
  private async pullStep(): Promise<string | undefined> {
    const rebased = await this.git(['pull', '--rebase', '--autostash'])
    if (rebased.code === 0) return undefined
    if (await this.rebaseInProgress()) await this.git(['rebase', '--abort'])
    const merged = await this.git(['pull', '--no-rebase', '--no-edit', '--autostash'])
    if (merged.code === 0) return undefined
    const conflicts = await this.conflictedFiles()
    if (conflicts.length > 0) return `Merge conflicts in ${conflicts.length} file(s). Resolve them and commit, then sync.`
    return firstLine(merged) || 'git pull failed'
  }

  // Source control's Pull: never commits. With staged files only a fast-forward (no --autostash,
  // which would unstage them); otherwise the same pull as the sync.
  pull(): Promise<GitStatus> {
    return this.exclusive(async () => {
      this.lastError = undefined
      const before = await this.status()
      if (!before.isRepo) return this.finish('Not a git repository.')
      if (before.conflicts.length > 0) return this.finish(`Resolve the conflicts in ${before.conflicts.length} file(s) and commit first.`)
      if (await this.rebaseInProgress()) return this.finish('A rebase is in progress. Finish or abort it first.')
      if (!before.hasRemote) return this.finish('No remote to pull from.')
      if (!(await this.upstream())) {
        const branch = await this.branch()
        if (!branch) return this.finish('Detached HEAD; check out a branch to pull.')
        const fetched = await this.git(['fetch'])
        if (fetched.code !== 0) return this.finish(firstLine(fetched) || 'git fetch failed')
        const remoteBranch = await this.quiet(['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
        if (remoteBranch.code !== 0) return this.finish(`origin has no ${branch} branch yet. Push to publish it.`)
        await this.git(['branch', `--set-upstream-to=origin/${branch}`])
      }
      if ((await this.manualWork()).staged) {
        const pulled = await this.git(['pull', '--ff-only'])
        if (pulled.code === 0) return this.finish()
        return this.finish(`${firstLine(pulled) || 'git pull failed'} (with files staged Forge only fast-forwards: commit or unstage them, then pull)`)
      }
      return this.finish(await this.pullStep())
    })
  }

  // Source control's Push (no force): publishes the branch (push -u) when it has no upstream yet.
  push(): Promise<GitStatus> {
    return this.exclusive(async () => {
      this.lastError = undefined
      const before = await this.status()
      if (!before.isRepo) return this.finish('Not a git repository.')
      if (!before.hasRemote) return this.finish('No remote to push to.')
      if (!(await this.upstream())) {
        const branch = await this.branch()
        if (!branch) return this.finish('Detached HEAD; check out a branch to push.')
        const remoteBranch = await this.quiet(['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
        if (remoteBranch.code === 0) {
          await this.git(['branch', `--set-upstream-to=origin/${branch}`])
        } else {
          const pushed = await this.git(['push', '-u', 'origin', 'HEAD'])
          return this.finish(pushed.code === 0 ? undefined : pushError(pushed))
        }
      }
      const pushed = await this.git(['push'])
      return this.finish(pushed.code === 0 ? undefined : pushError(pushed))
    })
  }

  fetch(): Promise<GitStatus> {
    return this.exclusive(async () => {
      this.lastError = undefined
      const before = await this.status()
      if (!before.isRepo) return this.finish('Not a git repository.')
      if (!before.hasRemote) return this.finish('No remote to fetch from.')
      const fetched = await this.git(['fetch'])
      return this.finish(fetched.code === 0 ? undefined : firstLine(fetched) || 'git fetch failed')
    })
  }

  // See findHeldDeletions.
  heldDeletions(): Promise<{ path: string; why: string }[]> {
    return findHeldDeletions(this.root, (args) => this.quiet(args))
  }

  private reportHeld(held: { path: string; why: string }[]): void {
    const now = new Set(held.map((h) => h.path))
    for (const p of [...this.heldReported]) if (!now.has(p)) this.heldReported.delete(p)
    for (const h of held) {
      if (this.heldReported.has(h.path)) continue
      this.heldReported.add(h.path)
      this.options.log?.(`git: not committing the delete of ${heldWarning(h)}`, 'stderr')
    }
  }

  // skipped: what the sync left out for manual work (GitStatus.note; logged once per change).
  private async finish(error?: string, synced = false, skipped?: string[]): Promise<GitStatus> {
    this.lastError = error
    if (synced) this.lastSync = Date.now()
    if (error) this.options.log?.(error, 'stderr')
    if (skipped) {
      this.note = skipped.length ? `Auto-sync ${skipped.join(' and ')}.` : undefined
      if (this.note && this.note !== this.noteLogged) this.options.log?.(`git: ${this.note}`, 'info')
      this.noteLogged = this.note
    }
    return this.refresh()
  }

  // Turns the folder into a repo (if needed), commits, and connects remoteUrl as origin.
  async initGit(remoteUrl?: string): Promise<GitStatus> {
    this.lastError = undefined
    const inside = await this.quiet(['rev-parse', '--is-inside-work-tree'])
    if (inside.code !== 0) {
      const init = await this.git(['init', '-b', 'main'])
      if (init.code !== 0) return this.finish(firstLine(init) || 'git init failed')
    }
    if (!(await this.hasCommits()) || (await this.status()).dirty > 0) {
      await this.git(['add', '-A'])
      const message = (await this.hasCommits()) ? 'harness: sync' : 'Initial commit'
      const commit = await this.git(['commit', '--allow-empty', '-m', message])
      if (commit.code !== 0) return this.finish(firstLine(commit) || 'git commit failed')
    }
    if (remoteUrl) {
      const current = await this.quiet(['remote', 'get-url', 'origin'])
      if (current.code === 0 && current.stdout.trim() !== remoteUrl) {
        return this.finish(`origin is already ${current.stdout.trim()}. Change it with git remote set-url origin <url>.`)
      }
      if (current.code !== 0) {
        const added = await this.git(['remote', 'add', 'origin', remoteUrl])
        if (added.code !== 0) return this.finish(firstLine(added) || 'git remote add failed')
      }
      const pushed = await this.git(['push', '-u', 'origin', 'HEAD'])
      if (pushed.code !== 0) return this.finish(firstLine(pushed) || 'git push failed')
      return this.finish(undefined, true)
    }
    return this.finish()
  }

  // Restarts the auto-sync timer from the current settings. 0 minutes turns it off.
  schedule(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    const minutes = this.options.settings().autoSyncMinutes
    if (minutes > 0) {
      this.timer = setInterval(() => void this.syncNow(), minutes * 60 * 1000)
    }
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}

// Tracked scripts missing from disk that Forge did not remove (no copy in .forge/sync/trash) and that
// the delete guard protects (large, or required by another script): the auto-commit leaves them out,
// so the delete never reaches the remote and git still has the file. `git rm` (a staged delete)
// confirms a delete; so does deleting it in Forge (which keeps a copy in the trash).
export async function findHeldDeletions(root: string, git: (args: string[]) => Promise<RunResult>): Promise<{ path: string; why: string }[]> {
  if ((await git(['rev-parse', '--verify', 'HEAD'])).code !== 0) return []
  const listed = await git(['-c', 'core.quotepath=false', 'ls-files', '--deleted', '-z'])
  if (listed.code !== 0) return []
  const deleted = listed.stdout.split('\0').filter(Boolean).map(toRepoPath)
  if (!deleted.length) return []
  const trash = join(root, ...FORGE_TRASH)
  let stamps: string[] = []
  try {
    stamps = readdirSync(trash)
  } catch {
    stamps = []
  }
  const tracked = (await git(['-c', 'core.quotepath=false', 'ls-files', '-z'])).stdout.split('\0').filter(Boolean).map(toRepoPath)
  const gone = new Set(deleted)
  const others = tracked.filter((f) => !gone.has(f) && moduleName(f) !== null)
  const read = (rel: string) => readFile(join(root, ...rel.split('/')), 'utf8').catch(() => null)
  const out: { path: string; why: string }[] = []
  for (const path of deleted) {
    if (moduleName(path) === null) continue
    if (stamps.some((s) => existsSync(join(trash, s, ...path.split('/'))))) continue
    const head = await git(['show', `HEAD:${path}`])
    if (head.code !== 0) continue
    const why = await guardReason({ file: path, text: head.stdout, others, read })
    if (why) out.push({ path, why })
  }
  return out
}

// The held-delete warning (the auto-commit's log line, and Source control's stage warning).
export function heldWarning(h: { path: string; why: string }): string {
  return `${h.path} (${h.why}): it left the disk outside Forge (no copy in .forge/sync/trash). Restore it with "git checkout -- ${h.path}", or confirm with "git rm ${h.path}".`
}

// A rejected push names the reason ("Pull first") before git's own first line.
function pushError(result: RunResult): string {
  const line = firstLine(result) || 'git push failed'
  return /\[rejected\]|non-fast-forward|fetch first/.test(result.stderr + result.stdout) ? `Pull first: the remote has commits you do not have (${line})` : line
}

export function firstLine(result: RunResult): string {
  const text = (result.stderr || result.stdout).trim()
  const lines = outputLines(text)
  return lines.find((line) => /^(error|fatal|hint: Updates were rejected)/i.test(line)) || lines[0] || ''
}
