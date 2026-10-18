// Source control panel IPC (Source control & Sync view): changed files, stage / unstage / discard,
// commit with your own message, pull / push / fetch. Main side: main/services/sourceControl.ts.
// No electron imports.

// M modified, A added, D deleted, R renamed, C copied, T type changed, U untracked, ! merge conflict.
export type ScmLetter = 'M' | 'A' | 'D' | 'R' | 'C' | 'T' | 'U' | '!'

export interface ScmFile {
  // Repo-relative, forward slashes (the new name of a rename).
  path: string
  // A rename or copy: the old name.
  from?: string
  letter: ScmLetter
  // "Modified", "Renamed", "Untracked", "Conflict: both modified" ...
  label: string
}

export interface ScmStatus {
  isRepo: boolean
  // Undefined on a detached HEAD.
  branch?: string
  // Short commit id of HEAD (none before the first commit).
  head?: string
  // "origin/main", when the branch tracks one.
  upstream?: string
  hasRemote: boolean
  ahead: number
  behind: number
  staged: ScmFile[]
  changes: ScmFile[]
  conflicts: ScmFile[]
  // A merge (MERGE_HEAD) or rebase is in progress.
  merging?: boolean
  rebasing?: boolean
  // Why the git auto-sync held back (it skips its "harness: sync" commit while files are staged or a
  // commit message is typed, and skips the pull while files are staged).
  autoSync?: string
}

// A guarded script deleted outside Forge (gitSync.ts findHeldDeletions): the auto-commit leaves its
// delete out, so staging it asks first.
export interface ScmHeld {
  path: string
  why: string
}

export interface ScmResult {
  status: ScmStatus
  // First line of git's output when the step failed.
  error?: string
  // Not staged: held deletes that need confirmHeld (nothing else is left out).
  held?: ScmHeld[]
  // Discard: copies kept in .forge/sync/trash (repo-relative).
  backups?: string[]
  // Commit: the new commit's short id.
  commit?: string
}

export interface ScmDiff {
  path: string
  original: string
  modified: string
  originalLabel: string
  modifiedLabel: string
  // Not shown as text (binary or over the size limit).
  binary?: boolean
  tooLarge?: boolean
}

export interface ScmCommitOptions {
  // Nothing staged: stage every change first (the renderer asked "Commit all changes?").
  all?: boolean
  // Push after a successful commit (Commit & Push).
  push?: boolean
  // Stage held deletes too (the user confirmed the warning).
  confirmHeld?: boolean
}

export interface ScmApi {
  scmStatus(): Promise<ScmStatus>
  // 'all': every change (Stage all). Held deletes are left out and returned in `held` unless confirmHeld.
  scmStage(paths: string[] | 'all', confirmHeld?: boolean): Promise<ScmResult>
  scmUnstage(paths: string[] | 'all'): Promise<ScmResult>
  // Working-tree changes only (staged ones stay). Keeps a copy in .forge/sync/trash first; an untracked
  // file is then removed, a tracked one goes back to its staged (or last committed) version.
  scmDiscard(paths: string[]): Promise<ScmResult>
  scmCommit(message: string, options?: ScmCommitOptions): Promise<ScmResult>
  scmPull(): Promise<ScmResult>
  scmPush(): Promise<ScmResult>
  scmFetch(): Promise<ScmResult>
  // staged: HEAD -> index; otherwise index -> working tree.
  scmDiff(path: string, staged: boolean): Promise<ScmDiff>
  // The commit box has text: the auto-sync skips its commit while it does.
  scmSetDraft(draft: boolean): Promise<void>
}
