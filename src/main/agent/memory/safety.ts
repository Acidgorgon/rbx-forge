// Content checks before anything is saved as a memory or skill. Memories are injected into future
// system prompts and project memory is committed, so (like Hermes Agent's memory scanner) we refuse:
//   - secrets: API keys, tokens, private keys, cookies (.ROBLOSECURITY), passwords;
//   - prompt-injection phrasing aimed at future agents;
//   - invisible/bidi Unicode that could hide instructions.
// Returns the reason for the first problem found, or null when the text is fine.

const SECRET_PATTERNS: { re: RegExp; what: string }[] = [
  { re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'a private key' },
  { re: /\bsk-(?:ant-|proj-|or-)?[A-Za-z0-9_-]{20,}/, what: 'an API key (sk-…)' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}/, what: 'a GitHub token' },
  { re: /\bgithub_pat_[A-Za-z0-9_]{30,}/, what: 'a GitHub token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, what: 'an AWS access key' },
  { re: /\bAIza[0-9A-Za-z_-]{35}\b/, what: 'a Google API key' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, what: 'a Slack token' },
  { re: /_\|WARNING:-DO-NOT-SHARE-THIS/, what: 'a Roblox cookie' },
  { re: /\.ROBLOSECURITY\s*[=:]\s*\S{20,}/i, what: 'a Roblox cookie' },
  { re: /https:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/\d+\/[\w-]{20,}/, what: 'a Discord webhook URL' },
  { re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/, what: 'a JWT' },
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/, what: 'a bearer token' },
  // KEY = "literal" (also OPEN_CLOUD_API_KEY=…), but not code like `local token = getToken(player)`.
  { re: /(?:api[_-]?key|secret|token|passw(?:or)?d|pwd)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+=]{8,}(?![\w(:.])/i, what: 'a credential assignment' },
  { re: /:\/\/[^\s:/@]+:[^\s:/@]{6,}@/, what: 'a URL with a password' }
]

const INJECTION_PATTERNS: RegExp[] = [
  /\bignore (?:all |any )?(?:the )?(?:previous|prior|above) (?:instructions|rules|prompts?)\b/i,
  /\bdisregard (?:the )?(?:system|previous) (?:prompt|instructions)\b/i,
  /\byou are now\b.{0,40}\b(?:jailbroken|unrestricted|DAN)\b/i,
  /\b(?:exfiltrate|send|upload|post)\b.{0,40}\b(?:api keys?|credentials|secrets|\.ssh|cookies?)\b/i,
  /\bcurl\b[^\n]{0,80}\|\s*(?:ba)?sh\b/i,
  /authorized_keys/i
]

// Zero-width, bidi overrides/isolates, tag characters.
const INVISIBLE = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]|\uDB40[\uDC00-\uDC7F]/

export function unsafeReason(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return `looks like it contains ${p.what}; memories never hold secrets (use the safeStorage secret settings instead)`
  for (const re of INJECTION_PATTERNS) if (re.test(text)) return 'looks like an instruction aimed at overriding future agents; not saved'
  if (INVISIBLE.test(text)) return 'contains invisible or bidirectional Unicode characters; not saved'
  return null
}
