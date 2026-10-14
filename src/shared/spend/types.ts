// Spending cap: a daily + monthly USD budget across every AI call Forge makes (chat, group chats,
// test agents, the orchestrator, the Labs' model calls, OpenAI image generation). Local only: the
// book lives in userData/spend.json and never leaves the machine. Windows use LOCAL time (a day
// starts at local midnight, a month on the 1st).

export type SpendSource = 'chat' | 'group' | 'labs' | 'agents' | 'orchestrator' | 'images' | 'other'

export const SPEND_SOURCES: SpendSource[] = ['chat', 'group', 'labs', 'agents', 'orchestrator', 'images', 'other']

export const SPEND_SOURCE_LABEL: Record<SpendSource, string> = {
  chat: 'Chat',
  group: 'Group chats',
  labs: 'Labs',
  agents: 'Test agents',
  orchestrator: 'Team runs',
  images: 'Images',
  other: 'Other'
}

export interface SpendSettings {
  // USD; null = no cap for that window.
  dailyUsd: number | null
  monthlyUsd: number | null
  // Fraction of a cap where the warning toast + status pill start (default 0.8).
  warnAt: number
}

export const DEFAULT_SPEND_SETTINGS: SpendSettings = { dailyUsd: null, monthlyUsd: null, warnAt: 0.8 }

export interface SpendDay {
  total: number
  requests: number
  byProvider: Record<string, number>
  bySource: Partial<Record<SpendSource, number>>
}

export interface SpendBook {
  v: 1
  // Local day key YYYY-MM-DD -> totals.
  days: Record<string, SpendDay>
  // "Raise cap for today": local day key -> extra USD allowed on top of the caps that day.
  overrides: Record<string, number>
  // Warnings already shown (key "day:2026-10-14:warn"), so a toast fires once per window and level.
  alerted: string[]
}

export type SpendLevel = 'ok' | 'warn' | 'stop'

export interface SpendWindow {
  kind: 'day' | 'month'
  // YYYY-MM-DD or YYYY-MM (local).
  key: string
  spent: number
  // The configured cap (null = none) and the cap after today's override.
  cap: number | null
  effectiveCap: number | null
  fraction: number
  level: SpendLevel
}

export interface SpendProviderRow {
  provider: string
  day: number
  month: number
}

export interface SpendState {
  settings: SpendSettings
  day: SpendWindow
  month: SpendWindow
  // Worst of the two windows.
  level: SpendLevel
  // One line for the pill / refusal ("today $4.12 of $5.00").
  reason?: string
  overrideToday: number
  // What "Raise cap for today" adds when pressed now.
  raiseStep: number
  byProvider: SpendProviderRow[]
  bySource: { source: SpendSource; day: number; month: number }[]
  // Last 14 days, oldest first.
  history: { day: string; total: number }[]
}

export interface SpendAlert {
  level: Exclude<SpendLevel, 'ok'>
  window: 'day' | 'month'
  text: string
  // True when a call was refused just now (not only a threshold crossing).
  refused?: boolean
}

export interface SpendApi {
  spendState(): Promise<SpendState>
  spendSetSettings(patch: Partial<SpendSettings>): Promise<SpendState>
  // Adds `amountUsd` (default: state.raiseStep) on top of today's caps.
  spendRaiseToday(amountUsd?: number): Promise<SpendState>
  spendClearOverride(): Promise<SpendState>
}

export interface SpendEvents {
  'spend:changed': SpendState
  'spend:alert': SpendAlert
}

// Every refusal message starts with this, so the renderer can offer "Raise cap for today".
export const SPEND_CAP_PREFIX = 'Spending cap reached'

export function isSpendCapMessage(text: string | null | undefined): boolean {
  return !!text && text.includes(SPEND_CAP_PREFIX)
}
