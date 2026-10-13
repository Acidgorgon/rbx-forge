// Problems from every source in one list: Monaco markers (luau-lsp, Blink), selene/StyLua lint,
// and Blink compile diagnostics for files that are not open.
import { useMemo } from 'react'
import { useStore, type ProblemItem } from '../store'

const RANK = { error: 0, warning: 1, info: 2 } as const

export function useProblems(): ProblemItem[] {
  const { state } = useStore()
  const { editorProblems, lint, blink } = state
  return useMemo(() => {
    const seen = new Set<string>()
    const out: ProblemItem[] = []
    const push = (p: ProblemItem) => {
      const key = `${p.path}:${p.line}:${p.col}:${p.source}:${p.message}`
      if (seen.has(key)) return
      seen.add(key)
      out.push(p)
    }
    editorProblems.forEach(push)
    // Blink markers already come through Monaco for open files; add the rest.
    const markedBlink = new Set(editorProblems.filter((p) => p.source === 'blink').map((p) => p.path))
    for (const d of blink?.diagnostics ?? []) {
      if (markedBlink.has(d.file)) continue
      push({ path: d.file, line: d.line, col: d.column, message: d.message, severity: d.severity, source: 'blink', code: d.code })
    }
    lint.forEach(push)
    return out.sort((a, b) => a.path.localeCompare(b.path) || RANK[a.severity] - RANK[b.severity] || a.line - b.line)
  }, [editorProblems, lint, blink])
}
