// Problem lists are rebuilt from every marker change; equal lists must not reach the store (each
// dispatch re-renders the whole workbench).
import type { ProblemItem } from '../store'

export function sameProblems(a: readonly ProblemItem[], b: readonly ProblemItem[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x.path !== y.path || x.line !== y.line || x.col !== y.col || x.severity !== y.severity || x.source !== y.source || x.code !== y.code || x.message !== y.message) return false
  }
  return true
}
