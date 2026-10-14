// Redactor for bug reports: replaces anything that looks like a key, token, password or cookie with
// [REDACTED]. Errs on the side of redacting: a report that hides a harmless string is fine, one that
// leaks a key is not. Pure; no electron imports.

export const REDACTED = '[REDACTED]'

interface Rule {
  name: string
  re: RegExp
  // Replacement; default keeps nothing of the match.
  replace?: (match: string, ...groups: string[]) => string
}

const KEY_NAMES =
  'api[_-]?key|apikey|x-api-key|access[_-]?key|secret[_-]?key|client[_-]?secret|secret|token|access[_-]?token|refresh[_-]?token|id[_-]?token|auth[_-]?token|bearer|password|passwd|pwd|passphrase|cookie|session[_-]?id|sessionid|session|private[_-]?key|webhook[_-]?url|webhook|authorization|credentials?|\\.?roblosecurity'

const RULES: Rule[] = [
  // PEM private keys (multi-line).
  { name: 'private-key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  // Roblox .ROBLOSECURITY cookie value (with or without the name).
  { name: 'roblox-cookie', re: /_\|WARNING:-DO-NOT-SHARE-THIS\.[^\s;"'`]*/g },
  // Cookie / Set-Cookie headers: the rest of the line.
  { name: 'cookie-header', re: /\b((?:set-)?cookie)(\s*[:=]\s*)[^\r\n]+/gi, replace: (_m, name, sep) => `${name}${sep}${REDACTED}` },
  // Authorization headers and bare bearer tokens.
  { name: 'auth-header', re: /\b(authorization)(\s*[:=]\s*)(?:(bearer|basic|token)\s+)?[^\s,;"'`]+/gi, replace: (_m, name, sep, scheme) => `${name}${sep}${scheme ? scheme + ' ' : ''}${REDACTED}` },
  { name: 'bearer', re: /\b(bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, replace: (_m, word) => `${word} ${REDACTED}` },
  // Discord / Slack webhooks.
  { name: 'discord-webhook', re: /(https?:\/\/(?:ptb\.|canary\.)?discord(?:app)?\.com\/api\/webhooks\/)[^\s"'`)>]+/gi, replace: (_m, base) => `${base}${REDACTED}` },
  { name: 'slack-webhook', re: /(https?:\/\/hooks\.slack\.com\/services\/)[^\s"'`)>]+/gi, replace: (_m, base) => `${base}${REDACTED}` },
  // user:password@ in URLs.
  { name: 'url-userinfo', re: /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:"'`]+:[^\s/@"'`]+@/gi, replace: (_m, scheme) => `${scheme}${REDACTED}@` },
  // Secret-looking query parameters.
  {
    name: 'url-param',
    re: /([?&#](?:key|api_key|apikey|token|access_token|refresh_token|id_token|auth|sig|signature|password|secret|client_secret|code)=)[^&#\s"'`]+/gi,
    replace: (_m, head) => `${head}${REDACTED}`
  },
  // Provider key formats.
  { name: 'anthropic', re: /\bsk-ant-[A-Za-z0-9_-]{8,}/g },
  { name: 'openai-like', re: /\bsk-(?:proj-|or-v1-|or-|live-|test-)?[A-Za-z0-9_-]{16,}/g },
  { name: 'google', re: /\bAIza[0-9A-Za-z_-]{30,}/g },
  { name: 'github', re: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/g },
  { name: 'slack', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'aws', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { name: 'stripe', re: /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{6,}/g },
  // name = value / name: value / "name": "value" for secret-ish names.
  {
    name: 'key-value',
    re: new RegExp(`(["']?)\\b((?:[A-Za-z0-9]+[_-])*(?:${KEY_NAMES}))\\1(\\s*[:=]\\s*)("[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&"'\`)}\\]]+)`, 'gi'),
    replace: (m, quote, name, sep, value) => {
      // "token: 12" counts, "session: started" does not need hiding but costs nothing; keep tiny
      // values that are clearly not secrets (booleans, numbers under 6 digits, null) readable.
      const bare = value.replace(/^["']|["']$/g, '')
      if (/^(true|false|null|undefined|none|bearer|basic|\d{1,5}|\*+|\[REDACTED\])$/i.test(bare) || bare === '') return m
      const q = /^["']/.test(value) ? value[0] : ''
      return `${quote}${name}${quote}${sep}${q}${REDACTED}${q}`
    }
  },
  // Email addresses (git config, commit authors, account names). git@host remotes stay readable.
  {
    name: 'email',
    re: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![A-Za-z0-9-])/g,
    replace: (m) => (/^git@/i.test(m) ? m : REDACTED)
  },
  // Long random-looking strings (base64 / base62 with upper, lower and digits). Pure hex (git hashes,
  // UUIDs) is left alone.
  {
    name: 'high-entropy',
    re: /(?<![A-Za-z0-9_/+-])[A-Za-z0-9_+/-]{32,}={0,2}(?![A-Za-z0-9_+/-])/g,
    replace: (m) => (looksRandom(m) ? REDACTED : m)
  }
]

function looksRandom(s: string): boolean {
  if (/^[0-9a-f-]+$/i.test(s)) return false
  if (s.includes('/') && s.split('/').every((part) => /^[A-Za-z][a-z]*$/.test(part) || part === '')) return false
  const upper = /[A-Z]/.test(s)
  const lower = /[a-z]/.test(s)
  const digit = /[0-9]/.test(s)
  if (!(upper && lower && digit)) return false
  // Identifiers like someVeryLongFunctionName2 have long lowercase runs; keys switch case often.
  let switches = 0
  for (let i = 1; i < s.length; i++) {
    const a = charClass(s[i - 1])
    const b = charClass(s[i])
    if (a !== b) switches++
  }
  return switches / s.length > 0.3
}

function charClass(c: string): number {
  if (c >= 'a' && c <= 'z') return 0
  if (c >= 'A' && c <= 'Z') return 1
  if (c >= '0' && c <= '9') return 2
  return 3
}

export interface RedactResult {
  text: string
  count: number
}

export interface RedactOptions {
  // Exact strings to replace (e.g. the project's full path -> "<project>", the home dir -> "~").
  replace?: { from: string; to: string }[]
}

// A path from `replace` as a pattern: either separator (also JSON-escaped "\\"), any case
// (Windows and macOS paths are case-insensitive; logs often show "c:\users\..."), a URI-encoded
// drive colon ("file:///c%3A/Users/..."), and not when the path continues into a longer name.
function pathPattern(from: string): RegExp | null {
  const trimmed = from.replace(/[\\/]+$/, '')
  if (trimmed.length < 2) return null
  const parts = trimmed.split(/[\\/]+/)
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const body = parts.map((part, i) => (i === 0 && /^[A-Za-z]:$/.test(part) ? `${escape(part[0])}(?::|%3A)` : escape(part))).join('(?:\\\\{1,2}|/)')
  return new RegExp(`${body}(?![A-Za-z0-9_-])`, 'gi')
}

// Home folders that were not passed in `replace` (another account, 8.3 short names, URIs):
// C:\Users\<name>, /Users/<name>, /home/<name> -> ~.
const HOME_PATHS = [
  /\b[A-Za-z](?::|%3A)(?:\\{1,2}|\/)Users(?:\\{1,2}|\/)(?!(?:Public|Default|All Users)(?![^\\/\s"'`<>|]))[^\\/\s"'`<>|:*?]+/gi,
  /(?<![A-Za-z0-9_.-])\/(?:Users|home)\/(?!(?:Shared)(?![^/\s]))[^/\s"'`<>|:*?]+/g
]

export function redact(input: string, options: RedactOptions = {}): RedactResult {
  let text = input
  let count = 0
  // Exact paths first (the project root before the home folder that holds it), so the key rules
  // below never see half a path.
  for (const { from, to } of options.replace ?? []) {
    const re = from ? pathPattern(from) : null
    if (re) text = text.replace(re, () => to)
  }
  for (const rule of RULES) {
    text = text.replace(rule.re, (...args) => {
      const match = args[0] as string
      const groups = args.slice(1, -2).map((g) => (g === undefined ? '' : String(g)))
      const next = rule.replace ? rule.replace(match, ...groups) : REDACTED
      if (next !== match) count++
      return next
    })
  }
  for (const re of HOME_PATHS) text = text.replace(re, '~')
  return { text, count }
}
