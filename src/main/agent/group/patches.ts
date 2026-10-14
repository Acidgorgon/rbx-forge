// Applying a guest's patch proposal through the host's write path. All hunks are applied in memory
// first; nothing is written unless every file applies (no half-applied patches). Writes go through
// the host's own write_script tool, so the same rules hold (src/ and events.blink only, never
// Packages/). Deletions are left to the host ("Ask host to merge").

import { applyFileDiff, parseDiff, safePatchPath } from '../../../shared/group/patch.ts'

export interface PatchIo {
  read(path: string): Promise<string | null>
  // The host's write_script: returns an error text when the path is not writable.
  write(path: string, contents: string): Promise<string | null>
}

export async function applyPatch(diff: string, io: PatchIo): Promise<{ written: string[] }> {
  const files = parseDiff(diff)
  if (!files.length) throw new Error('the proposal has no file changes')
  const planned: { path: string; contents: string }[] = []
  for (const f of files) {
    const path = f.newPath ?? f.oldPath
    if (!path || !safePatchPath(path)) throw new Error(`refusing to write ${path ?? '(no path)'}`)
    if (f.newPath === null) throw new Error(`the patch deletes ${path}; ask the host to merge it instead`)
    if (f.oldPath && f.oldPath !== f.newPath) throw new Error(`the patch renames ${f.oldPath}; ask the host to merge it instead`)
    const original = f.oldPath === null ? null : await io.read(path)
    if (f.oldPath !== null && original === null) throw new Error(`${path} does not exist`)
    const next = applyFileDiff(original, f)
    if (next === null) throw new Error(`cannot apply ${path}`)
    planned.push({ path, contents: next })
  }
  const written: string[] = []
  for (const p of planned) {
    const err = await io.write(p.path, p.contents)
    if (err) throw new Error(written.length ? `${err} (already written: ${written.join(', ')})` : err)
    written.push(p.path)
  }
  return { written }
}
