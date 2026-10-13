// Git backend for device sync: a private repo the user owns (e.g. github.com/<you>/forge-brain),
// cloned into userData/brain-sync/forge-brain. One sync round:
//   clone (first time) -> fetch -> reset the working tree to origin/<branch> -> mirror() with the
//   local stores (newest-`updated` merge, .conflict copies) -> commit -> push; a rejected push
//   (someone else pushed meanwhile) retries the round. Never force-pushes.
//
// Auth is whatever the user's git already uses (Git Credential Manager on Windows, the osxkeychain
// helper on macOS, SSH keys). Forge never asks for, stores or embeds a token: URLs that carry
// credentials are refused, prompts are disabled (GIT_TERMINAL_PROMPT=0), and sign-in failures
// become a clear message. The git runner is injected so tests use a fake (no network). No electron.

import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { MirrorResult } from './mirror.ts'

export interface GitRunResult {
  code: number
  stdout: string
  stderr: string
}
export type GitRunner = (args: string[], cwd: string) => Promise<GitRunResult>

export class BrainSyncError extends Error {
  readonly auth: boolean
  constructor(message: string, auth = false) {
    super(message)
    this.auth = auth
  }
}

const AUTH_RE = /authentication failed|could not read (username|password)|terminal prompts disabled|permission denied \(publickey|host key verification failed|repository not found|access denied|invalid username or password|returned error: 40[13]|the requested url returned error: 403|logon failed|no credential/i
const REJECTED_RE = /\[rejected\]|non-fast-forward|fetch first|failed to push some refs|updates were rejected/i

// Accepts https://host/owner/repo(.git), ssh://git@host/..., git@host:owner/repo(.git) and local
// paths/file:// (handy for a bare repo on a NAS). Refuses anything with embedded credentials.
export function checkRepoUrl(url: string): string {
  const u = url.trim()
  if (!u) throw new BrainSyncError('Enter the URL of your private sync repo, e.g. https://github.com/you/forge-brain.git')
  if (/^https?:\/\//i.test(u)) {
    const authority = u.replace(/^https?:\/\//i, '').split('/')[0]
    if (authority.includes('@')) throw new BrainSyncError('Remove the user name or token from the URL. Forge uses your own git sign-in (Git Credential Manager or Keychain) and never stores a token.')
    if (!/^[^/]+\/[^/]+\/[^/]+/.test(u.replace(/^https?:\/\//i, ''))) throw new BrainSyncError('That does not look like a repo URL (expected https://host/owner/repo.git)')
    return u
  }
  if (/^ssh:\/\//i.test(u)) {
    if (/^ssh:\/\/[^/@]*:[^/@]*@/i.test(u)) throw new BrainSyncError('Remove the password from the URL; use an SSH key.')
    return u
  }
  if (/^[\w.-]+@[\w.-]+:[^\s]+$/.test(u)) return u
  if (/^file:\/\//i.test(u) || /^([A-Za-z]:[\\/]|\/|\\\\)/.test(u)) return u
  throw new BrainSyncError('Unrecognized repo URL. Use https://github.com/you/forge-brain.git or git@github.com:you/forge-brain.git')
}

function hostOf(url: string): string {
  const m = /^[a-z]+:\/\/(?:[^@/]*@)?([^/:]+)/i.exec(url) ?? /^[^@]+@([^:]+):/.exec(url)
  return m?.[1] ?? 'the remote'
}

export function authMessage(url: string): string {
  return (
    `Git could not sign in to ${hostOf(url)}. Forge uses your own git credentials and never stores a token. ` +
    `Sign in once by running "git clone ${url}" in a terminal (Git Credential Manager on Windows, the Keychain on macOS, or an SSH key), ` +
    `make sure the repo exists and your account can push to it, then press Sync now.`
  )
}

export interface GitBrainOptions {
  run: GitRunner
  url: string
  // Clone location, e.g. userData/brain-sync/forge-brain.
  dir: string
  device: string
  exists?: (path: string) => boolean
  log?: (text: string) => void
  // Rounds before giving up on rejected pushes.
  attempts?: number
}

export interface GitBrainResult extends MirrorResult {
  committed: boolean
  pushedCommit: boolean
}

export class GitBrain {
  private o: GitBrainOptions
  private exists: (p: string) => boolean

  constructor(o: GitBrainOptions) {
    this.o = o
    this.exists = o.exists ?? existsSync
  }

  private async git(args: string[], cwd = this.o.dir): Promise<GitRunResult> {
    let r: GitRunResult
    try {
      r = await this.o.run(args, cwd)
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code
      if (code === 'ENOENT') throw new BrainSyncError('git is not installed (or not on PATH). Install Git, then press Sync now.')
      throw e
    }
    this.o.log?.(`brain sync: git ${args.join(' ')}${r.code ? ` (exit ${r.code})` : ''}`)
    return r
  }

  private fail(what: string, r: GitRunResult): never {
    const out = `${r.stderr}\n${r.stdout}`.trim()
    if (/\bENOENT\b/.test(out)) throw new BrainSyncError('git is not installed (or not on PATH). Install Git, then press Sync now.')
    if (AUTH_RE.test(out)) throw new BrainSyncError(authMessage(this.o.url), true)
    throw new BrainSyncError(`${what} failed: ${out.split('\n').filter(Boolean).slice(-2).join(' ') || `exit ${r.code}`}`)
  }

  // Clone on first use; keep origin pointing at the configured URL.
  async ensureClone(): Promise<void> {
    const url = checkRepoUrl(this.o.url)
    if (!this.exists(join(this.o.dir, '.git'))) {
      await mkdir(dirname(this.o.dir), { recursive: true })
      const r = await this.git(['clone', '--quiet', url, this.o.dir], dirname(this.o.dir))
      if (r.code !== 0) this.fail('git clone', r)
      return
    }
    const cur = await this.git(['remote', 'get-url', 'origin'])
    if (cur.code !== 0 || cur.stdout.trim() !== url) {
      const r = await this.git(cur.code === 0 ? ['remote', 'set-url', 'origin', url] : ['remote', 'add', 'origin', url])
      if (r.code !== 0) this.fail('git remote', r)
    }
  }

  // The remote's default branch, and whether it exists yet (a brand-new empty repo has none).
  private async branch(): Promise<{ name: string; exists: boolean }> {
    const head = await this.git(['symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])
    if (head.code === 0 && head.stdout.trim().startsWith('origin/')) return { name: head.stdout.trim().slice('origin/'.length), exists: true }
    for (const name of ['main', 'master']) {
      if ((await this.git(['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}`])).code === 0) return { name, exists: true }
    }
    return { name: 'main', exists: false }
  }

  private async identity(): Promise<string[]> {
    const email = await this.git(['config', 'user.email'])
    if (email.code === 0 && email.stdout.trim()) return []
    return ['-c', 'user.name=RBX Forge', '-c', `user.email=forge@${this.o.device.replace(/[^\w.-]/g, '-') || 'device'}.local`]
  }

  async sync(merge: (worktree: string) => Promise<MirrorResult>): Promise<GitBrainResult> {
    await this.ensureClone()
    const attempts = this.o.attempts ?? 3
    let last: GitRunResult | null = null
    for (let round = 0; round < attempts; round++) {
      const fetch = await this.git(['fetch', '--quiet', '--prune', 'origin'])
      if (fetch.code !== 0) this.fail('git fetch', fetch)
      const br = await this.branch()
      if (br.exists) {
        const co = await this.git(['checkout', '--quiet', '-B', br.name, `origin/${br.name}`])
        if (co.code !== 0) this.fail('git checkout', co)
        const reset = await this.git(['reset', '--quiet', '--hard', `origin/${br.name}`])
        if (reset.code !== 0) this.fail('git reset', reset)
      } else {
        await this.git(['symbolic-ref', 'HEAD', `refs/heads/${br.name}`])
      }
      await this.git(['clean', '-fdq'])
      const merged = await merge(this.o.dir)
      await this.git(['add', '-A'])
      const status = await this.git(['status', '--porcelain'])
      const dirty = status.code === 0 && status.stdout.trim().length > 0
      if (!dirty) return { ...merged, committed: false, pushedCommit: false }
      const commit = await this.git([...(await this.identity()), 'commit', '--quiet', '-m', `Forge sync from ${this.o.device}`])
      if (commit.code !== 0) this.fail('git commit', commit)
      const push = await this.git(['push', '--quiet', 'origin', `HEAD:refs/heads/${br.name}`])
      if (push.code === 0) return { ...merged, committed: true, pushedCommit: true }
      last = push
      const out = `${push.stderr}\n${push.stdout}`
      if (!REJECTED_RE.test(out) || AUTH_RE.test(out)) this.fail('git push', push)
      // Rejected: someone pushed first. Fetch and merge again.
    }
    this.fail('git push (the remote kept changing)', last ?? { code: 1, stdout: '', stderr: '' })
  }
}
