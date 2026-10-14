// Small formatting helpers shared by panels.

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
// Modifier glyphs for shortcut hints: ⌘ on macOS, Ctrl elsewhere.
export const MOD = isMac ? '⌘' : 'Ctrl+'
export const SHIFT = isMac ? '⇧' : 'Shift+'
export const ALT = isMac ? '⌥' : 'Alt+'

// "⌘⇧N" style hint from a spec like "mod+shift+n".
export function keyHint(spec: string): string {
  const parts = spec.split('+')
  const key = parts.pop() ?? ''
  const mods = parts.map((p) => (p === 'mod' ? MOD : p === 'shift' ? SHIFT : p === 'alt' ? ALT : p === 'ctrl' ? (isMac ? '⌃' : 'Ctrl+') : p)).join('')
  const k = key.length === 1 ? key.toUpperCase() : key === 'enter' ? '↵' : key === 'backslash' ? '\\' : key === 'comma' ? ',' : key
  return mods + k
}

export function ago(t?: number | string | null): string {
  if (t === undefined || t === null || t === '') return 'never'
  const ms = typeof t === 'string' ? Date.parse(t) : t
  if (!Number.isFinite(ms)) return '—'
  const s = Math.round((Date.now() - ms) / 1000)
  if (s < 45) return 'just now'
  const m = Math.round(s / 60)
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  if (h < 24) return `${h} h ago`
  const d = Math.round(h / 24)
  if (d < 14) return `${d} d ago`
  return new Date(ms).toLocaleDateString()
}

// Compact age for narrow rows: "now", "5m", "3h", "2d", "1w".
export function ageShort(t?: number | string | null): string {
  if (t === undefined || t === null) return ''
  const ms = typeof t === 'string' ? Date.parse(t) : t
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000))
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.round(s / 60)}m`
  if (s < 86400) return `${Math.round(s / 3600)}h`
  if (s < 604800) return `${Math.round(s / 86400)}d`
  return `${Math.round(s / 604800)}w`
}

export function fmtTokens(n: number | undefined | null): string {
  if (!n) return '0'
  if (n < 1000) return String(n)
  if (n < 100_000) return `${(n / 1000).toFixed(1)}k`
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`
  return `${(n / 1_000_000).toFixed(2)}M`
}

export function fmtUsd(n: number | undefined | null): string {
  if (n === undefined || n === null) return '$0.00'
  return n < 0.01 && n > 0 ? '<$0.01' : `$${n.toFixed(2)}`
}

export function fmtNum(n: number | null | undefined, digits = 0): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  const abs = Math.abs(n)
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(abs >= 10_000_000 ? 1 : 2)}M`
  if (abs >= 10_000) return `${(n / 1000).toFixed(abs >= 100_000 ? 0 : 1)}k`
  return n.toLocaleString(undefined, { maximumFractionDigits: digits })
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—'
  return `${(n * 100).toFixed(digits)}%`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

export function fmtTime(t: number): string {
  return new Date(t).toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`
}

// An error's message for a toast or a line of UI. Errors thrown in main reach the renderer as
// "Error invoking remote method 'harness:x': VfxError: msg"; only "msg" is useful to the user.
export function errorText(e: unknown): string {
  const text = e instanceof Error ? e.message : String(e)
  return text.replace(/^Error invoking remote method '[^']+':\s*/, '').replace(/^(\w*Error):\s*/, '')
}
