// AI inline completion: what is sent (a short window around the cursor), what never is (secret
// files, text that looks like a credential), and cleaning the model's answer into ghost text. Pure.

export const MAX_PREFIX_CHARS = 3000
export const MAX_SUFFIX_CHARS = 1000
export const MAX_REQUIRES = 12
export const MAX_COMPLETION_LINES = 8
export const MAX_COMPLETION_TOKENS = 160

// Files whose contents never leave the machine: dotenv files, keys and certificates, credential and
// secret stores, package-manager auth files.
const SECRET_NAME = [
  /^\.env(\..*)?$/i,
  /\.env$/i,
  /^\.?secrets?(\..*)?$/i,
  /^\.npmrc$/i,
  /^\.netrc$/i,
  /^\.pypirc$/i,
  /^id_(rsa|dsa|ecdsa|ed25519)(\.pub)?$/i,
  /\.(pem|key|p12|pfx|crt|cer|keystore|jks|asc|gpg)$/i,
  /^\.?htpasswd$/i
]
// Data/config files named like a secret store (tokens.json, credentials.toml, my-secret.txt).
// Scripts are left out: a TokenService.luau or SecretDoor.lua is ordinary game code.
const SECRET_WORD = /secret|credential|token|passw(or)?d|api[-_]?key/i
const CODE_FILE = /\.(luau|lua|blink|ts|tsx|js|jsx|py|rs|md)$/i

export function isSecretPath(path: string): boolean {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean)
  const name = parts[parts.length - 1] ?? ''
  if (SECRET_NAME.some((re) => re.test(name))) return true
  if (SECRET_WORD.test(name) && !CODE_FILE.test(name)) return true
  // Anything under a secrets/ or .ssh/ folder.
  return parts.slice(0, -1).some((d) => /^\.?(secrets?|\.?ssh|credentials?)$/i.test(d))
}

// Text that contains something shaped like a live credential (API keys, tokens, private keys,
// Roblox cookies). Such a window is not sent.
const SECRET_TEXT = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bsk-(proj-|ant-)?[A-Za-z0-9_-]{20,}/,
  /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{35}\b/,
  /_\|WARNING:-DO-NOT-SHARE-THIS/,
  /https:\/\/(discord(app)?\.com)\/api\/webhooks\/\d+\/[\w-]{20,}/i
]

export function looksSecret(text: string): boolean {
  return SECRET_TEXT.some((re) => re.test(text))
}

// Ghost text only where it reads well: at the end of the line, or before closing brackets / quotes.
export function cursorAllowsSuggestion(lineAfterCursor: string): boolean {
  return /^[\s)\]}"'`,;]*$/.test(lineAfterCursor)
}

// The last `max` characters of the prefix, starting at a line boundary when one is near.
export function trimPrefix(prefix: string, max = MAX_PREFIX_CHARS): string {
  if (prefix.length <= max) return prefix
  const cut = prefix.slice(prefix.length - max)
  const nl = cut.indexOf('\n')
  return nl >= 0 && nl < max / 4 ? cut.slice(nl + 1) : cut
}

// The first `max` characters of the suffix, ending at a line boundary when one is near.
export function trimSuffix(suffix: string, max = MAX_SUFFIX_CHARS): string {
  if (suffix.length <= max) return suffix
  const cut = suffix.slice(0, max)
  const nl = cut.lastIndexOf('\n')
  return nl >= max * 0.75 ? cut.slice(0, nl) : cut
}

// `local X = require(...)` / `require(...)` lines of a file (deduplicated, in order).
export function requireLines(text: string, max = MAX_REQUIRES): string[] {
  const out: string[] = []
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim()
    if (!/\brequire\s*\(/.test(t) || t.startsWith('--') || t.length > 200) continue
    if (!out.includes(t)) out.push(t)
    if (out.length >= max) break
  }
  return out
}

export interface CompletionPromptInput {
  path: string
  languageId: string
  prefix: string
  suffix: string
  requires?: string[]
}

export const COMPLETION_SYSTEM = `You are a code completion engine inside a Roblox (Luau) editor. You get the code before and after the cursor and reply with ONLY the text to insert at the cursor: no explanation, no markdown fences, no repetition of code that is already before or after the cursor. Complete the current statement or the next few lines (at most ${MAX_COMPLETION_LINES} lines), matching the file's indentation and style. Use Roblox APIs and the modules the file already requires. If nothing sensible fits, reply with an empty message.`

export const CURSOR = '<CURSOR>'

export function buildCompletionPrompt(i: CompletionPromptInput): { system: string; user: string } {
  const prefix = trimPrefix(i.prefix)
  const suffix = trimSuffix(i.suffix)
  // Require lines already inside the window add nothing.
  const requires = (i.requires ?? []).filter((r) => !prefix.includes(r) && !suffix.includes(r)).slice(0, MAX_REQUIRES)
  const parts = [`File: ${i.path.replace(/\\/g, '/')} (${i.languageId})`]
  if (requires.length) parts.push(`Requires at the top of the file:\n${requires.join('\n')}`)
  parts.push(`Code (${CURSOR} marks the cursor):\n${prefix}${CURSOR}${suffix}`)
  parts.push(`Reply with only the text to insert at ${CURSOR}.`)
  return { system: COMPLETION_SYSTEM, user: parts.join('\n\n') }
}

// Turns the model's reply into ghost text: strips fences and a stray cursor marker, drops a
// repeated copy of the current line's start, cuts what duplicates the text after the cursor, and
// keeps at most `maxLines` lines. '' = no suggestion.
export function cleanCompletion(raw: string, ctx: { prefix: string; suffix: string }, maxLines = MAX_COMPLETION_LINES): string {
  let t = raw.replace(/\r\n/g, '\n')
  const fence = /^\s*```[\w-]*\n([\s\S]*?)\n?```\s*$/.exec(t)
  if (fence) t = fence[1]
  t = t.split(CURSOR).join('')
  // The model sometimes repeats the start of the current line before continuing it.
  const lineStart = ctx.prefix.slice(ctx.prefix.lastIndexOf('\n') + 1)
  if (lineStart.trim() && t.startsWith(lineStart)) t = t.slice(lineStart.length)
  else if (lineStart.trim() && t.startsWith(lineStart.trimStart()) && !/^\s/.test(t)) t = t.slice(lineStart.trimStart().length)
  // At the start of an indented empty line, the model's own indentation would double it.
  if (lineStart.length && !lineStart.trim() && t.startsWith(lineStart)) t = t.slice(lineStart.length)
  let lines = t.split('\n')
  if (lines.length > maxLines) lines = lines.slice(0, maxLines)
  t = lines.join('\n')
  // Cut an echo of the code after the cursor: the first suffix line (if long enough to be
  // meaningful) appearing in the suggestion ends it.
  const after = ctx.suffix.replace(/\r\n/g, '\n')
  const restOfLine = after.split('\n')[0]
  if (restOfLine.trim().length >= 1 && t.endsWith(restOfLine) && t.length > restOfLine.length) t = t.slice(0, t.length - restOfLine.length)
  const nextLine = after.split('\n').find((l, i) => i > 0 && l.trim().length >= 4)
  if (nextLine) {
    const at = t.indexOf('\n' + nextLine)
    if (at >= 0) t = t.slice(0, at)
  }
  t = t.replace(/\s+$/, '')
  return t.trim() ? t : ''
}
