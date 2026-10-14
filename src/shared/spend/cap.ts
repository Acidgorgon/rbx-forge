// Pure accounting for the spending cap (types.ts): recording, local day / month windows,
// enforcement and the per-day override. No IO; `now` is always passed in.

import {
  DEFAULT_SPEND_SETTINGS,
  SPEND_CAP_PREFIX,
  SPEND_SOURCES,
  type SpendBook,
  type SpendDay,
  type SpendLevel,
  type SpendSettings,
  type SpendSource,
  type SpendState,
  type SpendWindow
} from './types.ts'

const p2 = (n: number) => String(n).padStart(2, '0')

// Local calendar day, YYYY-MM-DD (same convention as the usage ledger).
export function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`
}

// Local calendar month, YYYY-MM.
export function localMonth(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${p2(d.getMonth() + 1)}`
}

const round = (n: number) => Math.round(n * 1e6) / 1e6
const money = (n: number) => `$${n < 10 ? n.toFixed(2) : n.toFixed(1)}`

export function emptyBook(): SpendBook {
  return { v: 1, days: {}, overrides: {}, alerted: [] }
}

export function normalizeBook(raw: unknown): SpendBook {
  const b = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpendBook>
  const out = emptyBook()
  for (const [k, d] of Object.entries(b.days ?? {})) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(k) || !d || typeof d !== 'object') continue
    const total = Number((d as SpendDay).total)
    if (!Number.isFinite(total) || total < 0) continue
    out.days[k] = { total, requests: Number((d as SpendDay).requests) || 0, byProvider: { ...((d as SpendDay).byProvider ?? {}) }, bySource: { ...((d as SpendDay).bySource ?? {}) } }
  }
  for (const [k, v] of Object.entries(b.overrides ?? {})) if (/^\d{4}-\d{2}-\d{2}$/.test(k) && typeof v === 'number' && v > 0 && Number.isFinite(v)) out.overrides[k] = v
  out.alerted = Array.isArray(b.alerted) ? b.alerted.filter((x): x is string => typeof x === 'string').slice(-200) : []
  return out
}

export function normalizeSettings(raw: unknown): SpendSettings {
  const s = (raw && typeof raw === 'object' ? raw : {}) as Partial<SpendSettings>
  const cap = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null)
  const warnAt = typeof s.warnAt === 'number' && s.warnAt >= 0.1 && s.warnAt < 1 ? s.warnAt : DEFAULT_SPEND_SETTINGS.warnAt
  return { dailyUsd: cap(s.dailyUsd), monthlyUsd: cap(s.monthlyUsd), warnAt }
}

export interface SpendCharge {
  at: number
  provider: string
  source: SpendSource
  costUsd: number
}

// Adds one charge (mutates and returns the book). Zero / unknown costs still count as a request.
export function recordSpend(book: SpendBook, c: SpendCharge, keepDays = 400): SpendBook {
  const cost = Number.isFinite(c.costUsd) && c.costUsd > 0 ? c.costUsd : 0
  const key = localDay(c.at)
  const d = (book.days[key] ??= { total: 0, requests: 0, byProvider: {}, bySource: {} })
  d.total = round(d.total + cost)
  d.requests += 1
  const prov = c.provider || 'unknown'
  d.byProvider[prov] = round((d.byProvider[prov] ?? 0) + cost)
  const src = SPEND_SOURCES.includes(c.source) ? c.source : 'other'
  d.bySource[src] = round((d.bySource[src] ?? 0) + cost)
  const keys = Object.keys(book.days)
  if (keys.length > keepDays) for (const k of keys.sort().slice(0, keys.length - keepDays)) delete book.days[k]
  return book
}

export function daySpent(book: SpendBook, now: number): number {
  return book.days[localDay(now)]?.total ?? 0
}

export function monthSpent(book: SpendBook, now: number): number {
  const m = localMonth(now)
  let t = 0
  for (const [k, d] of Object.entries(book.days)) if (k.startsWith(m + '-')) t += d.total
  return round(t)
}

function windowOf(kind: 'day' | 'month', key: string, spent: number, cap: number | null, extra: number, warnAt: number): SpendWindow {
  const effectiveCap = cap === null ? null : round(cap + extra)
  const fraction = effectiveCap ? spent / effectiveCap : 0
  const level: SpendLevel = effectiveCap === null ? 'ok' : fraction >= 1 ? 'stop' : fraction >= warnAt ? 'warn' : 'ok'
  return { kind, key, spent: round(spent), cap, effectiveCap, fraction: Math.round(fraction * 1000) / 1000, level }
}

const RANK: Record<SpendLevel, number> = { ok: 0, warn: 1, stop: 2 }

// Both windows. "Raise cap for today" (overrides[today]) lifts the daily AND the monthly cap for
// the rest of today only; tomorrow the plain caps apply again.
export function evaluateSpend(book: SpendBook, settings: SpendSettings, now: number): { day: SpendWindow; month: SpendWindow; level: SpendLevel; reason?: string } {
  const extra = book.overrides[localDay(now)] ?? 0
  const day = windowOf('day', localDay(now), daySpent(book, now), settings.dailyUsd, extra, settings.warnAt)
  const month = windowOf('month', localMonth(now), monthSpent(book, now), settings.monthlyUsd, extra, settings.warnAt)
  const worst = RANK[month.level] > RANK[day.level] || (RANK[month.level] === RANK[day.level] && month.fraction > day.fraction) ? month : day
  const level = worst.level
  const reason = worst.effectiveCap !== null && (level !== 'ok' || worst.fraction > 0) ? `${worst.kind === 'day' ? 'today' : 'this month'} ${money(worst.spent)} of ${money(worst.effectiveCap)}` : undefined
  return { day, month, level, ...(reason ? { reason } : {}) }
}

// The refusal for a new call, or null when it may run.
export function refusal(book: SpendBook, settings: SpendSettings, now: number): string | null {
  const e = evaluateSpend(book, settings, now)
  if (e.level !== 'stop') return null
  const w = e.day.level === 'stop' ? e.day : e.month
  const which = w.kind === 'day' ? `today's AI spend ${money(w.spent)} reached your ${money(w.effectiveCap ?? 0)} daily cap` : `this month's AI spend ${money(w.spent)} reached your ${money(w.effectiveCap ?? 0)} monthly cap`
  return `${SPEND_CAP_PREFIX}: ${which}. Use "Raise cap for today" (status bar or Settings > Usage) to continue.`
}

// What "Raise cap for today" adds: half the daily cap (or a tenth of the monthly), at least $1,
// plus whatever is needed to get back under each window that is over.
export function raiseStep(book: SpendBook, settings: SpendSettings, now: number): number {
  const base = settings.dailyUsd ? settings.dailyUsd * 0.5 : settings.monthlyUsd ? settings.monthlyUsd * 0.1 : 1
  const step = Math.max(1, base)
  const extra = book.overrides[localDay(now)] ?? 0
  let need = 0
  if (settings.dailyUsd !== null) need = Math.max(need, daySpent(book, now) - (settings.dailyUsd + extra))
  if (settings.monthlyUsd !== null) need = Math.max(need, monthSpent(book, now) - (settings.monthlyUsd + extra))
  return Math.ceil((step + Math.max(0, need)) * 100) / 100
}

export function raiseToday(book: SpendBook, amount: number, now: number): SpendBook {
  if (!Number.isFinite(amount) || amount <= 0) return book
  const k = localDay(now)
  book.overrides[k] = round((book.overrides[k] ?? 0) + amount)
  // Old overrides never matter again.
  for (const key of Object.keys(book.overrides)) if (key < k) delete book.overrides[key]
  return book
}

export function clearOverride(book: SpendBook, now: number): SpendBook {
  delete book.overrides[localDay(now)]
  return book
}

// Alerts not shown yet for the current windows (once per window + level). Marks them as shown.
export function newAlerts(book: SpendBook, settings: SpendSettings, now: number): { level: 'warn' | 'stop'; window: SpendWindow }[] {
  const e = evaluateSpend(book, settings, now)
  const out: { level: 'warn' | 'stop'; window: SpendWindow }[] = []
  for (const w of [e.day, e.month]) {
    if (w.level === 'ok') continue
    const key = `${w.kind}:${w.key}:${w.level}:${w.effectiveCap}`
    if (book.alerted.includes(key)) continue
    book.alerted.push(key)
    out.push({ level: w.level, window: w })
  }
  if (book.alerted.length > 200) book.alerted = book.alerted.slice(-200)
  return out
}

export function alertText(level: 'warn' | 'stop', w: SpendWindow): string {
  const span = w.kind === 'day' ? 'today' : 'this month'
  if (level === 'stop') return `${SPEND_CAP_PREFIX}: ${span} ${money(w.spent)} of ${money(w.effectiveCap ?? 0)}. New AI calls are paused.`
  return `AI spend ${span} is at ${Math.round(w.fraction * 100)}% of the cap (${money(w.spent)} of ${money(w.effectiveCap ?? 0)}).`
}

function addDays(now: number, delta: number): number {
  const d = new Date(now)
  d.setDate(d.getDate() + delta)
  return d.getTime()
}

export function spendState(book: SpendBook, settings: SpendSettings, now: number): SpendState {
  const e = evaluateSpend(book, settings, now)
  const today = localDay(now)
  const month = localMonth(now)
  const provDay: Record<string, number> = { ...(book.days[today]?.byProvider ?? {}) }
  const provMonth: Record<string, number> = {}
  const srcDay: Record<string, number> = { ...(book.days[today]?.bySource ?? {}) }
  const srcMonth: Record<string, number> = {}
  for (const [k, d] of Object.entries(book.days)) {
    if (!k.startsWith(month + '-')) continue
    for (const [p, v] of Object.entries(d.byProvider)) provMonth[p] = round((provMonth[p] ?? 0) + v)
    for (const [s, v] of Object.entries(d.bySource)) srcMonth[s] = round((srcMonth[s] ?? 0) + (v ?? 0))
  }
  const providers = [...new Set([...Object.keys(provDay), ...Object.keys(provMonth)])]
  const history: { day: string; total: number }[] = []
  for (let i = 13; i >= 0; i--) {
    const k = localDay(addDays(now, -i))
    history.push({ day: k, total: book.days[k]?.total ?? 0 })
  }
  return {
    settings,
    day: e.day,
    month: e.month,
    level: e.level,
    ...(e.reason ? { reason: e.reason } : {}),
    overrideToday: book.overrides[today] ?? 0,
    raiseStep: raiseStep(book, settings, now),
    byProvider: providers.map((p) => ({ provider: p, day: provDay[p] ?? 0, month: provMonth[p] ?? 0 })).sort((a, b) => b.month - a.month),
    bySource: SPEND_SOURCES.filter((s) => srcDay[s] || srcMonth[s]).map((s) => ({ source: s, day: srcDay[s] ?? 0, month: srcMonth[s] ?? 0 })),
    history
  }
}
