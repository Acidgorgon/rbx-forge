// Process-wide hook to the spending cap, so the agent layer and the image services can charge and
// check it without new constructor plumbing. Unset (tests, or before main wires it) = no cap.

import type { SpendSource } from '../../../shared/spend/types.ts'
import { estimateCost } from '../../agent/budget/usage.ts'
import type { SpendService } from './service.ts'

let current: SpendService | null = null

export function setSpendCap(s: SpendService | null): void {
  current = s
}

export function spendCap(): SpendService | null {
  return current
}

export function chargeSpend(c: { provider: string; source: SpendSource; costUsd: number | undefined; at?: number }): void {
  if (!current) return
  try {
    current.record({ provider: c.provider, source: c.source, costUsd: c.costUsd ?? 0, ...(c.at ? { at: c.at } : {}) })
  } catch {
    // accounting must never break a call
  }
}

// Throws SpendCapError when a cap is reached.
export function assertSpend(source: SpendSource): void {
  current?.assert(source)
}

// The refusal text, or null (for stop predicates that must not throw).
export function spendBlock(): string | null {
  return current?.blocked() ?? null
}

// Source for a usage-ledger record (chat / test agent / orchestrator / one-shot lab call).
export function sourceOfRecord(r: { chatId?: string; agentId?: string }): SpendSource {
  if (r.chatId) return 'chat'
  if (r.agentId) return r.agentId.startsWith('orch:') ? 'orchestrator' : r.agentId === 'summary' ? 'labs' : 'agents'
  return 'labs'
}

// Group-chat guests report only input/output tokens: priced from the table (cache reads at the
// input price, so a slight over-estimate, which is the safe side for a cap).
export function chargeTokens(provider: string, model: string, u: { input: number; output: number; cacheRead?: number; cacheWrite?: number }, source: SpendSource): void {
  const cost = estimateCost(model, { input: u.input, output: u.output, cacheRead: u.cacheRead ?? 0, cacheWrite: u.cacheWrite ?? 0 }, { provider }) ?? 0
  chargeSpend({ provider, source, costUsd: cost })
}
