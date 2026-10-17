// Explorer rename / move-to-trash (SPEC §7.3). Paths are repo-relative, resolved inside the project
// root only; project-file mount points and their parents are refused (shared/fileOps.ts). No electron
// here: the caller passes the trash function (shell.trashItem in main/index.ts).
import { cp, lstat, readdir } from 'node:fs/promises'
import { basename, dirname, join, relative, sep } from 'node:path'
import { entryTarget, protectedReason, renamedPath, renameProblem, type PathChange, type TrashBatchResult } from '../../shared/fileOps.ts'
import { collapseEntries } from '../../shared/explorerSelection.ts'
import { resolveInside } from './project.ts'
import { ensureTrashIgnored } from './sync/store.ts'
import { renameRetry } from './fs/renameRetry.ts'

function toPosix(path: string): string {
  return path.split(sep).join('/')
}

async function existing(root: string, mounts: string[], path: string, isDir: boolean) {
  const target = entryTarget(String(path ?? ''), !!isDir)
  const reason = protectedReason(target.path, mounts)
  if (reason) throw new Error(reason)
  const full = await resolveInside(root, target.path)
  // Stay inside the root and refuse the root itself, whatever the input spelled.
  const rel = toPosix(relative(root, full))
  if (!rel || protectedReason(rel, mounts)) throw new Error(protectedReason(rel, mounts) ?? 'That is the project folder.')
  const info = await lstat(full).catch(() => null)
  if (!info) throw new Error(`${target.path} no longer exists.`)
  return { target: { ...target, path: rel, isDir: info.isDirectory() }, full }
}

// Renames a script (keeping .server/.client/.luau) or a folder (an init script's folder).
// `name` is the new stem: the instance name for scripts and folders, the file name otherwise.
export async function renameEntry(root: string, mounts: string[], path: string, name: string, isDir = false): Promise<PathChange> {
  const { target, full } = await existing(root, mounts, path, isDir)
  const stem = String(name ?? '')
  const dir = dirname(full)
  const entries = await readdir(dir, { withFileTypes: true })
  const problem = renameProblem(target, stem, entries.map((e) => ({ name: e.name, isDir: e.isDirectory() })))
  if (problem) throw new Error(problem)
  const to = renamedPath(target, stem)
  const dest = await resolveInside(root, to)
  if (dirname(dest) !== dir || basename(dest) !== basename(to)) throw new Error('Invalid name.')
  await renameRetry(full, dest)
  return { from: target.path, to, isDir: target.isDir }
}

// Forge's project trash (gitignored with .forge/sync/): every Forge delete keeps a copy here.
export const PROJECT_TRASH_DIR = '.forge/sync/trash'

// Copies a file or folder into .forge/sync/trash/<stamp>/<rel> before it leaves the project; returns
// the copy's repo-relative path. The git auto-sync commits a guarded script's delete only when a copy
// is there (services/gitSync.ts).
export async function backupToProjectTrash(root: string, rel: string, now: () => number = Date.now): Promise<string> {
  const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-')
  const dest = `${PROJECT_TRASH_DIR}/${stamp}/${rel}`
  await cp(join(root, ...rel.split('/')), join(root, ...dest.split('/')), { recursive: true, errorOnExist: false, force: true })
  // Never committed: .forge/sync/ is per-machine state.
  await ensureTrashIgnored(root).catch(() => undefined)
  return dest
}

// Moves a file or folder to the OS trash (recoverable) after keeping a copy in the project trash. An
// init script's folder goes as a whole.
export async function trashEntry(root: string, mounts: string[], path: string, trash: (full: string) => Promise<void>, isDir = false, now: () => number = Date.now): Promise<PathChange> {
  const { target, full } = await existing(root, mounts, path, isDir)
  const backup = target.path.startsWith(PROJECT_TRASH_DIR + '/') ? undefined : await backupToProjectTrash(root, target.path, now)
  await trash(full)
  return { from: target.path, to: null, isDir: target.isDir, ...(backup ? { backup } : {}) }
}

// Explorer multi-select delete: each entry to the trash, one at a time, in order. An entry inside
// another listed folder goes with that folder (not tried on its own); one that fails is reported and
// the rest still go.
export async function trashEntries(root: string, mounts: string[], entries: { path: string; isDir?: boolean }[], trash: (full: string) => Promise<void>, now: () => number = Date.now): Promise<TrashBatchResult> {
  // One batch, one trash folder.
  const at = now()
  const result: TrashBatchResult = { changes: [], failed: [] }
  const targets = entries.map((e) => entryTarget(String(e?.path ?? ''), !!e?.isDir))
  // A refused entry (a mount, the project file) never covers the entries inside it.
  const allowed = targets.filter((t) => {
    const reason = protectedReason(t.path, mounts)
    if (reason) result.failed.push({ path: t.path, error: reason })
    return !reason
  })
  for (const e of collapseEntries(allowed)) {
    try {
      result.changes.push(await trashEntry(root, mounts, e.path, trash, e.isDir, () => at))
    } catch (error) {
      result.failed.push({ path: e.path, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return result
}
