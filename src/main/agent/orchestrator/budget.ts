// Default budget checker for orchestrated runs: hard caps per task and per run, a warn fraction.
// Token counting matches budget/budget.ts ("effective": input + cache writes + output + 10% of
// cache reads). Integrators can instead pass a checker backed by the budget worker's BudgetGuard.

import type { BudgetChecker, BudgetLevel, BudgetScope, Usage } from './types.ts'

export interface OrchestratorCaps {
  taskMaxTokens?: number
  taskMaxCostUsd?: number
  runMaxTokens?: number
  runMaxCostUsd?: number
  // Fraction of a cap at which 'warn' starts. Default 0.8.
  warnAt?: number
  tokenMetric?: 'effective' | 'total'
}

export const DEFAULT_CAPS: Required<Omit<OrchestratorCaps, 'tokenMetric'>> & { tokenMetric: 'effective' } = {
  taskMaxTokens: 400_000,
  taskMaxCostUsd: 2,
  runMaxTokens: 2_000_000,
  runMaxCostUsd: 10,
  warnAt: 0.8,
  tokenMetric: 'effective'
}

export function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
}

export function addUsage(a: Usage, b: Usage): Usage {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const out: Usage = { input: a.input + n(b.input), output: a.output + n(b.output), cacheRead: a.cacheRead + n(b.cacheRead), cacheWrite: a.cacheWrite + n(b.cacheWrite) }
  if (a.costUsd !== undefined || b.costUsd !== undefined) out.costUsd = (a.costUsd ?? 0) + n(b.costUsd)
  return out
}

export function countTokens(u: Usage, metric: 'effective' | 'total' = 'effective'): number {
  if (metric === 'total') return u.input + u.output + u.cacheRead + u.cacheWrite
  return u.input + u.output + u.cacheWrite + Math.round(u.cacheRead * 0.1)
}

export function capsBudget(caps: OrchestratorCaps = {}): BudgetChecker {
  const c = { ...DEFAULT_CAPS, ...caps }
  return {
    check(usage: Usage, scope: BudgetScope) {
      const tokens = countTokens(usage, c.tokenMetric)
      const cost = usage.costUsd ?? 0
      const [maxTok, maxCost, what] = scope.kind === 'task' ? [c.taskMaxTokens, c.taskMaxCostUsd, `task ${scope.taskId}`] : [c.runMaxTokens, c.runMaxCostUsd, 'run']
      let level: BudgetLevel = 'ok'
      let reason: string | undefined
      const consider = (used: number, limit: number | undefined, label: string) => {
        if (!limit || limit <= 0) return
        const f = used / limit
        const l: BudgetLevel = f >= 1 ? 'stop' : f >= c.warnAt ? 'warn' : 'ok'
        if (l === 'stop' || (l === 'warn' && level === 'ok')) {
          level = l
          reason = label
        }
      }
      consider(tokens, maxTok, `${what} used ${tokens} of ${maxTok} tokens`)
      consider(cost, maxCost, `${what} spent $${cost.toFixed(2)} of $${(maxCost ?? 0).toFixed(2)}`)
      return reason ? { level, reason } : { level }
    }
  }
}
