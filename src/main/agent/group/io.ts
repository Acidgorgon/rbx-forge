// Production I/O for group chats: git (collab runner: no prompts, no pager) and selene lint.

import { git } from '../../services/collab/git.ts'
import { changedLuaFiles, runSelene } from '../../services/collab/quality.ts'
import type { GroupIo } from './readTools.ts'

export function defaultGroupIo(): GroupIo {
  return {
    git: (root, args) => git(root, args),
    async diagnostics(root, paths) {
      const files = paths?.length ? paths : await changedLuaFiles(root).catch(() => [])
      if (!files.length) return { ran: true, problems: [], note: 'no changed Luau files' }
      const r = await runSelene(root, files)
      return {
        ran: r.ran,
        problems: r.problems.map((p) => ({ path: p.path, line: p.line, col: p.col, severity: p.severity, message: p.message, ...(p.code ? { code: p.code } : {}) })),
        ...(r.note ? { note: r.note } : {})
      }
    }
  }
}
