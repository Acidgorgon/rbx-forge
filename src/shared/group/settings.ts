// Group chat settings (setting key "groupChat", shared with the older numeric knobs in
// agent/groupChat.ts DEFAULTS). Pure.

import { GROUP_SETTINGS_DEFAULTS, type GroupSettings } from '../groupTypes.ts'

const RANGES: Record<'consultTurns' | 'consultMaxTokens' | 'consultMaxUsd' | 'crossCheckMinFiles', [number, number]> = {
  consultTurns: [1, 6],
  consultMaxTokens: [5_000, 2_000_000],
  consultMaxUsd: [0, 50],
  crossCheckMinFiles: [1, 20]
}

export function normalizeGroupSettings(raw: unknown): GroupSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const out: GroupSettings = { ...GROUP_SETTINGS_DEFAULTS }
  for (const [k, [lo, hi]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    const v = r[k]
    if (typeof v === 'number' && Number.isFinite(v)) out[k] = Math.min(hi, Math.max(lo, k === 'consultMaxUsd' ? Math.round(v * 100) / 100 : Math.round(v)))
  }
  if (typeof r.crossCheck === 'boolean') out.crossCheck = r.crossCheck
  if (typeof r.crossCheckModel === 'string') out.crossCheckModel = r.crossCheckModel.trim().slice(0, 160)
  return out
}

// Merges a partial update into the stored object (other keys in "groupChat" are kept).
export function mergeGroupSettings(stored: unknown, next: Partial<GroupSettings>): Record<string, unknown> {
  const base = (stored && typeof stored === 'object' ? stored : {}) as Record<string, unknown>
  const merged = normalizeGroupSettings({ ...normalizeGroupSettings(base), ...next })
  return { ...base, ...merged }
}
