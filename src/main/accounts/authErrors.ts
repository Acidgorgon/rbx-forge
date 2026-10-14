// Classifying Anthropic errors (no imports, so agent/sdk.ts and accounts/authHealth.ts can share it).
//
// The Claude CLI words every 401 / 403 as "Failed to authenticate. API Error: <status> ..." and flags
// the assistant message authentication_failed, including a request for a model the account cannot
// use. A 403 only blames the credential when its text says so (expired / revoked token, invalid key,
// not logged in, org not allowed); any other 403 is a per-model rejection.

// The chat's matcher: the CLI's wording of an auth error (any 401 / 403).
export function isAuthError(text: string): boolean {
  return /Failed to authenticate|OAuth session|authentication_failed|invalid x-api-key/i.test(text)
}

// Text of an Anthropic authentication failure (CLI and API wording).
const AUTH_TEXT =
  /failed to authenticate|authentication[_ ]failed|oauth (session|token) (has )?expired|could not be refreshed|invalid (x-)?api[- _]key|invalid bearer token|not logged in|please run \/login|login expired|token (has been )?revoked|\b401\b.*(unauthori[sz]ed|authentication)|unauthori[sz]ed.*\b401\b/i

// isAuthError plus CLI wording it does not cover.
export function isAnthropicAuthError(text: unknown): boolean {
  return typeof text === 'string' && (isAuthError(text) || AUTH_TEXT.test(text))
}

// Wording that blames the credential itself, also on a 403.
const CREDENTIAL_TEXT =
  /oauth (session|token) (has )?expired|could not be refreshed|invalid (x-)?api[- _]key|invalid bearer token|invalid (oauth |access )?token|not logged in|please run \/login|login expired|token (has been )?revoked|oauth_org_not_allowed|organization (has been )?(disabled|not allowed)|no credentials|missing credentials|credentials? (were |was )?not found/i

// The HTTP status of an API error: the result's api_error_status, else "API Error: 403" in the text.
export function errorStatus(text: unknown, status?: unknown): number | undefined {
  if (typeof status === 'number' && status > 0) return status
  const m = typeof text === 'string' ? /API Error:?\s*(\d{3})\b/i.exec(text) : null
  return m ? Number(m[1]) : undefined
}

// What an error says about the credential:
//   'auth'     the credential failed (401, or credential wording): mark the login / key failed;
//   'rejected' a 403 that does not blame the credential (a model the account cannot use, a
//              permission on one request): not an auth failure by itself;
//   null       not about authentication at all (overloaded, rate limit, ...).
export function classifyAuthError(text: unknown, status?: unknown): 'auth' | 'rejected' | null {
  const t = typeof text === 'string' ? text : ''
  const code = errorStatus(t, status)
  if (code === 401) return 'auth'
  if (code === 403) return CREDENTIAL_TEXT.test(t) ? 'auth' : 'rejected'
  return isAnthropicAuthError(t) ? 'auth' : null
}
