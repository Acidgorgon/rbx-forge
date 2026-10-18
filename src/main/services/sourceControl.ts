// Source control panel, main side (Source control & Sync view): changed files grouped as Staged /
// Changes / Merge conflicts (git status --porcelain=v2), stage / unstage / discard, commit with the
// user's own message, Pull / Push / Fetch (GitSync), and the two sides of a diff tab. Every step runs
// on GitSync's queue, so it never overlaps the auto-sync. Never force-pushes, resets --hard or rewrites
// history; a discard keeps a copy in .forge/sync/trash first. No electron imports: the caller passes
// the trash function (shell.trashItem in main/index.ts).

import { lstat, readFile, rm, unlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { GitStatus, ScmCommitOptions, ScmDiff, ScmFile, ScmHeld, ScmLetter, ScmResult, ScmStatus } from '@shared/types'
import { firstLine, heldWarning } from './gitSync.ts'
import { backupToProjectTrash } from './fileOps.ts'
import { resolveInside } from './project.ts'
import { outputLines, toRepoPath, type RunResult } from './tools.ts'

// The GitSync surface the panel uses (main/index.ts passes the Forge Sync guarded wrapper, so Pull
// checks for uncommitted Studio edits like Sync now does).
export interface ScmGit {
  readonly root: string
  exec(args: string[], loud?: boolean): Promise<RunResult>
  exclusive<T>(fn: () => Promise<T>): Promise<T>
  manualWork(): Promise<{ staged: boolean; draft: boolean }>
  heldDeletions(): Promise<{ path: string; why: string }[]>
  pull(): Promise<GitStatus>
  push(): Promise<GitStatus>
  fetch(): Promise<GitStatus>
  refresh(fetch?: boolean): Promise<GitStatus>
  clearNote(): void
}

export interface SourceControlOptions {
  git: ScmGit
  // Removes an untracked file after its copy is kept (OS trash in the app; rm by default).
  trash?: (full: string) => Promise<void>
  log?: (text: string, stream?: 'stdout' | 'stderr' | 'info') => void
}

// Diff sides larger than this are not sent to the renderer.
const DIFF_LIMIT = 2 * 1024 * 1024

const LABEL: Record<string, string> = { M: 'Modified', A: 'Added', D: 'Deleted', R: 'Renamed', C: 'Copied', T: 'Type changed', U: 'Untracked' }
const CONFLICT: Record<string, string> = { DD: 'both deleted', AU: 'added by us', UD: 'deleted by them', UA: 'added by them', DU: 'deleted by us', AA: 'both added', UU: 'both modified' }

export interface ParsedStatus {
  branch?: string
  head?: string
  upstream?: string
  ahead: number
  behind: number
  staged: ScmFile[]
  changes: ScmFile[]
  conflicts: ScmFile[]
}

function entry(path: string, code: string, from?: string): ScmFile {
  const letter = (code in LABEL ? code : 'M') as ScmLetter
  return { path: toRepoPath(path), letter, label: LABEL[letter], ...(from ? { from: toRepoPath(from) } : {}) }
}

// The record's first n space-separated fields, and the rest (the path, which may hold spaces).
function fields(record: string, n: number): { head: string[]; path: string } {
  const head: string[] = []
  let at = 0
  for (let i = 0; i < n; i++) {
    const next = record.indexOf(' ', at)
    if (next < 0) return { head, path: '' }
    head.push(record.slice(at, next))
    at = next + 1
  }
  return { head, path: record.slice(at) }
}

// `git status --porcelain=v2 -z --branch --untracked-files=all`. Ordinary (1), rename / copy (2,
// followed by the old name as its own NUL field), unmerged (u), untracked (?) and ignored (!) records;
// "." in XY means unchanged on that side.
export function parseStatusV2(out: string): ParsedStatus {
  const status: ParsedStatus = { ahead: 0, behind: 0, staged: [], changes: [], conflicts: [] }
  const records = out.split('\0')
  for (let i = 0; i < records.length; i++) {
    const record = records[i]
    if (!record) continue
    if (record.startsWith('# ')) {
      const { head, path: value } = fields(record.slice(2), 1)
      const key = head[0]
      if (key === 'branch.oid') status.head = value === '(initial)' ? undefined : value.slice(0, 7)
      else if (key === 'branch.head') status.branch = value === '(detached)' ? undefined : value
      else if (key === 'branch.upstream') status.upstream = value
      else if (key === 'branch.ab') {
        const m = /^\+(\d+) -(\d+)$/.exec(value)
        if (m) [status.ahead, status.behind] = [Number(m[1]), Number(m[2])]
      }
      continue
    }
    const kind = record[0]
    if (kind === '?') {
      status.changes.push(entry(record.slice(2), 'U'))
    } else if (kind === '1' || kind === '2') {
      const { head, path } = fields(record, kind === '1' ? 8 : 9)
      const [x, y] = head[1] ?? '..'
      const from = kind === '2' ? records[++i] : undefined
      if (x !== '.') status.staged.push(entry(path, x, from))
      if (y !== '.') status.changes.push(entry(path, y))
    } else if (kind === 'u') {
      const { head, path } = fields(record, 10)
      const xy = head[1] ?? 'UU'
      status.conflicts.push({ path: toRepoPath(path), letter: '!', label: `Conflict: ${CONFLICT[xy] ?? 'unmerged'}` })
    }
  }
  return status
}

// Paths from the renderer: repo-relative, inside the work tree, never .git.
export function cleanPaths(paths: unknown): string[] {
  if (!Array.isArray(paths) || paths.length > 20_000) throw new Error('Invalid paths')
  const out = new Set<string>()
  for (const p of paths) {
    if (typeof p !== 'string' || !p || p.length > 4096 || p.includes('\0')) throw new Error('Invalid path')
    const rel = toRepoPath(p)
    const parts = rel.split('/')
    if (rel.startsWith('/') || /^[a-zA-Z]:/.test(rel) || parts.includes('..') || parts[0] === '.git') throw new Error(`Invalid path: ${p}`)
    out.add(rel)
  }
  return [...out]
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`
}

export class SourceControl {
  private git: ScmGit
  private options: SourceControlOptions

  constructor(options: SourceControlOptions) {
    this.options = options
    this.git = options.git
  }

  get root(): string {
    return this.git.root
  }

  private async exists(name: string): Promise<boolean> {
    const result = await this.git.exec(['rev-parse', '--git-path', name], false)
    if (result.code !== 0) return false
    // Relative to the work tree, or absolute (a linked worktree's git dir).
    return lstat(resolve(this.root, result.stdout.trim())).then(() => true, () => false)
  }

  async status(): Promise<ScmStatus> {
    const inside = await this.git.exec(['rev-parse', '--is-inside-work-tree'], false)
    const empty: ScmStatus = { isRepo: false, hasRemote: false, ahead: 0, behind: 0, staged: [], changes: [], conflicts: [] }
    if (inside.code !== 0 || inside.stdout.trim() !== 'true') return empty
    // No optional locks: a status refresh never contends with a commit or the auto-sync.
    const result = await this.git.exec(['--no-optional-locks', 'status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], false)
    const parsed = parseStatusV2(result.stdout)
    const remotes = outputLines((await this.git.exec(['remote'], false)).stdout)
    const status: ScmStatus = { isRepo: true, hasRemote: remotes.length > 0, ...parsed }
    if (await this.exists('MERGE_HEAD')) status.merging = true
    if ((await this.exists('rebase-merge')) || (await this.exists('rebase-apply'))) status.rebasing = true
    const manual = await this.git.manualWork()
    if (manual.staged || manual.draft) {
      status.autoSync = manual.staged
        ? 'Sync skips its "harness: sync" commit and waits to pull while files are staged.'
        : 'Sync skips its "harness: sync" commit while a message is typed here.'
    }
    return status
  }

  private async result(extra: Partial<ScmResult> = {}): Promise<ScmResult> {
    // The Sync view's counts (dirty, ahead) follow.
    void this.git.refresh().catch(() => undefined)
    return { ...extra, status: await this.status() }
  }

  // `-- paths`, or a NUL-separated pathspec file for long lists (Windows refuses command lines over
  // ~32K characters). Paths are literal (--literal-pathspecs on the call): "Sword [Gold]" is no glob.
  private async withPaths<T>(paths: string[], fn: (spec: string[]) => Promise<T>): Promise<T> {
    if (paths.reduce((n, p) => n + p.length + 3, 0) <= 8000) return fn(['--', ...paths])
    const list = join(tmpdir(), `forge-scm-${process.pid}-${Date.now()}.txt`)
    await writeFile(list, paths.join('\0'))
    try {
      return await fn([`--pathspec-from-file=${list}`, '--pathspec-file-nul'])
    } finally {
      await unlink(list).catch(() => undefined)
    }
  }

  private async add(paths: string[]): Promise<string | undefined> {
    if (!paths.length) return undefined
    const added = await this.withPaths(paths, (spec) => this.git.exec(['--literal-pathspecs', 'add', '-A', ...spec]))
    return added.code === 0 ? undefined : firstLine(added) || 'git add failed'
  }

  // 'all' is the Changes group (merge conflicts are staged one by one, once fixed). Held deletes (a
  // guarded script removed outside Forge) are left out unless confirmHeld, with the auto-commit's
  // warning in the log. A conflicted file that still has conflict markers is refused.
  private async stageInner(paths: string[] | 'all', confirmHeld: boolean): Promise<{ error?: string; held: ScmHeld[] }> {
    const status = await this.status()
    const held = confirmHeld ? [] : await this.git.heldDeletions()
    const list = paths === 'all' ? status.changes.map((f) => f.path) : paths
    const holdBack = held.filter((h) => list.includes(h.path))
    for (const h of holdBack) this.options.log?.(`git: not staging the delete of ${heldWarning(h)}`, 'stderr')
    for (const c of status.conflicts) {
      if (!list.includes(c.path)) continue
      const text = await readFile(await resolveInside(this.root, c.path), 'utf8').catch(() => '')
      if (/^<{7}( |$)|^>{7}( |$)/m.test(text)) return { held: holdBack, error: `${c.path} still has conflict markers (<<<<<<<). Fix them, then stage it.` }
    }
    if (paths === 'all' && !holdBack.length && !status.conflicts.length) {
      const added = await this.git.exec(['add', '-A'])
      return { held: [], error: added.code === 0 ? undefined : firstLine(added) || 'git add failed' }
    }
    const skip = new Set(holdBack.map((h) => h.path))
    return { held: holdBack, error: await this.add(list.filter((p) => !skip.has(p))) }
  }

  stage(paths: unknown, confirmHeld = false): Promise<ScmResult> {
    const list = paths === 'all' ? 'all' : cleanPaths(paths)
    return this.git.exclusive(async () => {
      const { error, held } = await this.stageInner(list, !!confirmHeld)
      return this.result({ error, ...(held.length ? { held } : {}) })
    })
  }

  unstage(paths: unknown): Promise<ScmResult> {
    const list = paths === 'all' ? null : cleanPaths(paths)
    return this.git.exclusive(async () => {
      const hasHead = (await this.git.exec(['rev-parse', '--verify', '-q', 'HEAD'], false)).code === 0
      // A staged rename goes back as both names.
      const staged = (await this.status()).staged
      const names = list ? [...new Set(list.flatMap((p) => [p, ...staged.filter((f) => f.path === p && f.from).map((f) => f.from!)]))] : null
      if (!staged.length) return this.result()
      let result: RunResult
      if (!names) result = await this.git.exec(hasHead ? ['restore', '--staged', '--', '.'] : ['rm', '-r', '-q', '--cached', '--', '.'])
      else if (!names.length) return this.result()
      else result = await this.withPaths(names, (spec) => this.git.exec(['--literal-pathspecs', ...(hasHead ? ['restore', '--staged'] : ['rm', '-r', '-q', '--cached']), ...spec]))
      return this.result({ error: result.code === 0 ? undefined : firstLine(result) || 'git unstage failed' })
    })
  }

  // Working-tree changes only. Every file still on disk is copied to .forge/sync/trash before it is
  // touched; a failed copy stops the discard.
  discard(paths: unknown): Promise<ScmResult> {
    const list = cleanPaths(paths)
    return this.git.exclusive(async () => {
      const changes = new Map((await this.status()).changes.map((f) => [f.path, f]))
      // One trash folder for the batch.
      const at = Date.now()
      const backups: string[] = []
      const restore: string[] = []
      const remove: string[] = []
      for (const path of list) {
        const change = changes.get(path)
        if (!change) continue
        const full = await resolveInside(this.root, path)
        const onDisk = await lstat(full).then((s) => s.isFile() || s.isSymbolicLink(), () => false)
        if (onDisk) {
          try {
            backups.push(await backupToProjectTrash(this.root, path, () => at))
          } catch (error) {
            return this.result({ backups, error: `Could not keep a copy of ${path}, nothing discarded: ${error instanceof Error ? error.message : String(error)}` })
          }
        }
        if (change.letter === 'U') remove.push(full)
        else restore.push(path)
      }
      // The copy is kept: when the OS trash refuses (no trash on this system), remove the file.
      for (const full of remove) await (this.options.trash?.(full) ?? Promise.reject(new Error('no trash'))).catch(() => rm(full, { force: true }))
      let error: string | undefined
      if (restore.length) {
        const result = await this.withPaths(restore, (spec) => this.git.exec(['--literal-pathspecs', 'checkout', '-q', ...spec]))
        if (result.code !== 0) error = firstLine(result) || 'git checkout failed'
      }
      if (backups.length) this.options.log?.(`git: discarded ${plural(restore.length + remove.length, 'change')}; copies in ${backups.length === 1 ? backups[0] : `${backups[0].split('/').slice(0, 4).join('/')}/`}`, 'info')
      return this.result({ backups, error })
    })
  }

  // Commits the staged files with the user's message. all: nothing is staged, stage everything first
  // (held deletes ask first). push: Push after a successful commit.
  async commit(message: unknown, options: ScmCommitOptions = {}): Promise<ScmResult> {
    const text = typeof message === 'string' ? message.trim() : ''
    const done = await this.git.exclusive(async (): Promise<ScmResult> => {
      if (!text) return this.result({ error: 'Type a commit message first.' })
      const before = await this.status()
      if (before.conflicts.length) return this.result({ error: `Resolve the merge conflicts first: fix ${before.conflicts.length === 1 ? 'the file' : 'the files'} and stage ${before.conflicts.length === 1 ? 'it' : 'them'}.` })
      // A merge whose resolution matches HEAD has nothing staged and still commits.
      if (!before.staged.length && !before.merging) {
        if (!options.all) return this.result({ error: 'Nothing is staged.' })
        const held = options.confirmHeld ? [] : await this.git.heldDeletions()
        if (held.length) return this.result({ held })
        const staged = await this.stageInner('all', true)
        if (staged.error) return this.result({ error: staged.error })
        if ((await this.git.exec(['diff', '--cached', '--quiet'], false)).code === 0) return this.result({ error: 'No changes to commit.' })
      }
      const committed = await this.git.exec(['commit', '-m', text])
      if (committed.code !== 0) return this.result({ error: firstLine(committed) || 'git commit failed' })
      this.git.clearNote()
      const head = (await this.git.exec(['rev-parse', '--short', 'HEAD'], false)).stdout.trim()
      return this.result({ commit: head })
    })
    if (!done.commit || !options.push) return done
    const pushed = await this.git.push()
    return { ...(await this.result()), commit: done.commit, ...(pushed.error ? { error: `Committed ${done.commit}, but the push failed: ${pushed.error}` } : {}) }
  }

  async pull(): Promise<ScmResult> {
    return this.result({ error: (await this.git.pull()).error })
  }

  async push(): Promise<ScmResult> {
    return this.result({ error: (await this.git.push()).error })
  }

  async fetch(): Promise<ScmResult> {
    return this.result({ error: (await this.git.fetch()).error })
  }

  private async show(spec: string): Promise<string | null> {
    const result = await this.git.exec(['show', spec], false)
    return result.code === 0 ? result.stdout : null
  }

  // staged: HEAD -> index. Otherwise index -> working tree (a conflict: HEAD -> working tree, markers
  // and all).
  async diff(path: unknown, staged: boolean): Promise<ScmDiff> {
    const [rel] = cleanPaths([path])
    const status = await this.status()
    let original: string | null
    let modified: string | null
    let labels: [string, string]
    if (staged) {
      const f = status.staged.find((x) => x.path === rel)
      original = f?.letter === 'A' ? '' : await this.show(`HEAD:${f?.from ?? rel}`)
      modified = f?.letter === 'D' ? '' : await this.show(`:${rel}`)
      labels = [f?.from ? `HEAD (${f.from})` : 'HEAD', 'Staged']
    } else {
      const f = status.changes.find((x) => x.path === rel)
      const conflict = status.conflicts.some((x) => x.path === rel)
      original = f?.letter === 'U' ? '' : conflict ? await this.show(`HEAD:${rel}`) : await this.show(`:${rel}`)
      const full = await resolveInside(this.root, rel)
      modified = f?.letter === 'D' ? '' : await readFile(full, 'utf8').catch(() => '')
      labels = [conflict ? 'HEAD' : status.staged.some((x) => x.path === rel) ? 'Staged' : 'HEAD', 'Working tree']
    }
    const [a, b] = [original ?? '', modified ?? '']
    const out: ScmDiff = { path: rel, original: a, modified: b, originalLabel: labels[0], modifiedLabel: labels[1] }
    if (a.length > DIFF_LIMIT || b.length > DIFF_LIMIT) return { ...out, original: '', modified: '', tooLarge: true }
    if (a.includes('\0') || b.includes('\0')) return { ...out, original: '', modified: '', binary: true }
    return out
  }
}
