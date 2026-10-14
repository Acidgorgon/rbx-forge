// Token/cost meter for the app: one UsageLedger (persisted in the 'usage' setting) and one
// BudgetGuard (limits from the 'budget' setting) shared by chats, test agents and orchestrated
// tasks. Emits 'usage:changed' snapshots for the UI meter. No electron imports.

import type { UsageSnapshot, UsageSummary } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { BudgetGuard, readLimits, BUDGET_SETTING, DEFAULT_LIMITS, type BudgetCheck, type BudgetLimits } from './budget/budget.ts'
import { spendBlock } from '../services/spend/gate.ts'
import { addUsage, dayKey, UsageLedger, type Usage, type UsageTotals } from './budget/usage.ts'

export function toSummary(t: UsageTotals | Usage): UsageSummary {
  const totals = t as Partial<UsageTotals>
  return {
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheWrite,
    costUsd: t.costUsd ?? 0,
    unpricedRequests: totals.unpricedRequests ?? 0,
    requests: totals.requests ?? 0
  }
}

export class Meter {
  readonly ledger: UsageLedger
  readonly guard: BudgetGuard
  private ctx: Pick<HarnessContext, 'getSetting' | 'setSetting' | 'emit'>
  // In-flight usage per chat/agent id, for the live part of the meter and budget checks.
  private live = new Map<string, Usage>()

  constructor(ctx: Pick<HarnessContext, 'getSetting' | 'setSetting' | 'emit'>, opts: { saveDelayMs?: number } = {}) {
    this.ctx = ctx
    this.ledger = new UsageLedger(ctx, { saveDelayMs: opts.saveDelayMs })
    this.guard = new BudgetGuard(this.ledger, () => this.limits())
    this.ledger.onRecord((r) => {
      if (r.chatId) this.changed('chat', r.chatId, { model: r.model })
      if (r.agentId) this.changed('agent', r.agentId, { model: r.model })
    })
  }

  limits(): BudgetLimits {
    return readLimits((key, fallback) => this.ctx.getSetting(key, fallback))
  }

  setLimits(next: Partial<BudgetLimits>): BudgetLimits {
    const current = this.ctx.getSetting<Partial<BudgetLimits> | null>(BUDGET_SETTING, null) ?? {}
    const merged: Record<string, unknown> = { ...current }
    for (const [k, v] of Object.entries(next ?? {})) {
      if (k === 'tokenMetric') {
        if (v === 'effective' || v === 'total') merged[k] = v
      } else if (k in DEFAULT_LIMITS || ['chatMaxCostUsd', 'dailyMaxCostUsd'].includes(k)) {
        if (v === null || (typeof v === 'number' && Number.isFinite(v))) merged[k] = v
      }
    }
    this.ctx.setSetting(BUDGET_SETTING, merged)
    return this.limits()
  }

  setLive(id: string, usage: Usage | null): void {
    if (usage) this.live.set(id, usage)
    else this.live.delete(id)
  }

  addLive(id: string, usage: Usage): Usage {
    const next = addUsage(this.live.get(id) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, usage)
    this.live.set(id, next)
    return next
  }

  checkChat(chatId: string): BudgetCheck {
    return withSpendCap(this.guard.check({ chatId }, this.live.get(chatId)))
  }

  checkAgent(agentId: string): BudgetCheck {
    return withSpendCap(this.guard.check({ agentId }, this.live.get(agentId)))
  }

  snapshot(scope: UsageSnapshot['scope'], id?: string, extra: Partial<UsageSnapshot> = {}): UsageSnapshot {
    if (scope === 'day') {
      const key = id || dayKey(Date.now())
      return { scope, id: key, totals: toSummary(this.ledger.day(key)), ...extra }
    }
    const key = id ?? ''
    const totals = scope === 'chat' ? this.ledger.chat(key) : this.ledger.agent(key)
    const live = this.live.get(key)
    const check = scope === 'chat' ? this.checkChat(key) : this.checkAgent(key)
    return {
      scope,
      id: key,
      totals: toSummary(totals),
      ...(live ? { live: toSummary(live) } : {}),
      budget: { level: check.level, fraction: Math.round(check.fraction * 1000) / 1000, ...(check.reason ? { reason: check.reason } : {}) },
      ...extra
    }
  }

  changed(scope: 'chat' | 'agent', id: string, extra: Partial<UsageSnapshot> = {}): void {
    this.ctx.emit('usage:changed', this.snapshot(scope, id, extra))
  }

  flush(): void {
    this.ledger.flush()
  }
}

// The app-wide spending cap (Settings > Usage) stops chats and agents like a hard budget cap.
function withSpendCap(check: BudgetCheck): BudgetCheck {
  const block = spendBlock()
  return block ? { ...check, level: 'stop', fraction: Math.max(1, check.fraction), reason: block } : check
}
