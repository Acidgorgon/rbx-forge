// Cross-check: the diff of the files the host's turn edited, for the second-opinion reviewer.
// git diff when the project is a repo (new files shown in full), else the files' current text.

import type { GroupIo } from './readTools.ts'
import { safeRelPath } from './readTools.ts'

export const CROSS_CHECK_DIFF_CHARS = 16_000

export async function buildDiff(root: string, files: string[], io: GroupIo | undefined, read: (path: string) => Promise<string | null>): Promise<string> {
  const safe = files.filter(safeRelPath)
  const parts: string[] = []
  let covered = new Set<string>()
  if (io && safe.length) {
    const d = await io.git(root, ['diff', '--no-color', '--no-ext-diff', 'HEAD', '--', ...safe]).catch(() => null)
    if (d && d.code === 0) {
      if (d.stdout.trim()) parts.push(d.stdout.trim())
      covered = new Set(safe.filter((f) => d.stdout.includes(`b/${f}`)))
      const untracked = await io.git(root, ['ls-files', '--others', '--exclude-standard', '--', ...safe]).catch(() => null)
      for (const f of untracked?.code === 0 ? untracked.stdout.split('\n').map((x) => x.trim()).filter(Boolean) : []) {
        const text = await read(f)
        if (text === null) continue
        const lines = text.replace(/\n$/, '').split('\n')
        parts.push(`--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lines.length} @@\n${lines.map((l) => `+${l}`).join('\n')}`)
        covered.add(f)
      }
    }
  }
  // No git (or files git did not cover): the current text.
  for (const f of safe) {
    if (covered.has(f)) continue
    const text = await read(f)
    if (text === null) continue
    parts.push(`# ${f} (current contents; no git diff available)\n${text}`)
  }
  const out = parts.join('\n')
  return out.length > CROSS_CHECK_DIFF_CHARS ? out.slice(0, CROSS_CHECK_DIFF_CHARS) + '\n… (clipped)' : out
}
