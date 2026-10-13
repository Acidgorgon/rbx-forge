import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import type { GitStatus, SyncSettings } from '@shared/types'
import { findTool, outputLines, run, toolEnv, toRepoPath, type RunResult } from './tools.ts'

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

  private async conflictedFiles(): Promise<string[]> {
    const result = await this.quiet(['diff', '--name-only', '--diff-filter=U'])
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
    const porcelain = await this.quiet(['status', '--porcelain'])
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
      this.busy = this.doSync().finally(() => {
        this.busy = null
      })
    }
    return this.busy
  }

  private async doSync(): Promise<GitStatus> {
    this.lastError = undefined
    const before = await this.status()
    if (!before.isRepo) return this.finish('Not a git repository. Set up sync first.')
    if (before.conflicts.length > 0) {
      return this.finish(`Resolve the conflicts in ${before.conflicts.length} file(s), then commit, before syncing again.`)
    }
    if (await this.rebaseInProgress()) return this.finish('A rebase is in progress. Finish or abort it first.')

    if (this.options.settings().autoCommit && before.dirty > 0) {
      await this.git(['add', '-A'])
      const commit = await this.git(['commit', '-m', 'harness: sync'])
      if (commit.code !== 0) return this.finish(firstLine(commit) || 'git commit failed')
    }
    if (!before.hasRemote) return this.finish(undefined, true)

    const fetched = await this.git(['fetch'])
    if (fetched.code !== 0) return this.finish(firstLine(fetched) || 'git fetch failed')

    if (!(await this.upstream())) {
      const branch = await this.branch()
      if (!branch) return this.finish('Detached HEAD; check out a branch to sync.')
      const remoteBranch = await this.quiet(['rev-parse', '--verify', `refs/remotes/origin/${branch}`])
      if (remoteBranch.code === 0) {
        await this.git(['branch', `--set-upstream-to=origin/${branch}`])
      } else {
        const pushed = await this.git(['push', '-u', 'origin', 'HEAD'])
        return this.finish(pushed.code === 0 ? undefined : firstLine(pushed) || 'git push failed', true)
      }
    }

    const rebased = await this.git(['pull', '--rebase', '--autostash'])
    if (rebased.code !== 0) {
      if (await this.rebaseInProgress()) await this.git(['rebase', '--abort'])
      const merged = await this.git(['pull', '--no-rebase', '--no-edit', '--autostash'])
      if (merged.code !== 0) {
        const conflicts = await this.conflictedFiles()
        if (conflicts.length > 0) {
          return this.finish(`Merge conflicts in ${conflicts.length} file(s). Resolve them and commit, then sync.`)
        }
        return this.finish(firstLine(merged) || 'git pull failed')
      }
    }

    const after = await this.status()
    if (after.ahead > 0) {
      const pushed = await this.git(['push'])
      if (pushed.code !== 0) return this.finish(firstLine(pushed) || 'git push failed')
    }
    return this.finish(undefined, true)
  }

  private async finish(error?: string, synced = false): Promise<GitStatus> {
    this.lastError = error
    if (synced) this.lastSync = Date.now()
    if (error) this.options.log?.(error, 'stderr')
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

function firstLine(result: RunResult): string {
  const text = (result.stderr || result.stdout).trim()
  const lines = outputLines(text)
  return lines.find((line) => /^(error|fatal|hint: Updates were rejected)/i.test(line)) || lines[0] || ''
}
