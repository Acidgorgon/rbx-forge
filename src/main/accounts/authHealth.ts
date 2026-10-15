// Whether the Anthropic credential in use actually works, learned from real requests.
//
// A Claude Code login can exist on disk (or in the macOS Keychain) and still be dead: "OAuth
// session expired and could not be refreshed". Presence checks cannot see that, so every Agent SDK
// query is watched (watchAnthropicAuth wraps the query function once in createAgentLayer): an
// authentication error marks the credential failed, a successful turn or a passing Test connection
// clears it. The record is kept in settings so the card still says "Sign-in expired" after a restart.
//
// A 403 is not always about the credential: the CLI words every 401 / 403 as "Failed to
// authenticate. API Error: 403 ..." (and flags it authentication_failed), including a request for a
// model the account cannot use. A 403 only counts as an auth failure when its text says the
// credential is the problem (expired / revoked token, invalid key, not logged in, org not allowed),
// or when a probe on another model fails too (probeAfterRejection); otherwise it is a per-model
// rejection and the login stays as it was.

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../agent/sdk.ts'
import { classifyAuthError } from './authErrors.ts'

export const AUTH_HEALTH_SETTING = 'anthropicAuthHealth'

// Which credential a query ran on: a key (ANTHROPIC_API_KEY in its env) or the Claude login.
export type AuthVia = 'key' | 'claudeLogin'

export interface AuthHealthRecord {
  via: AuthVia
  ok: boolean
  at: number
  // Short reason for a failure (no secrets: SDK error codes and CLI error text).
  message?: string
}

export interface SettingsLike {
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
}

export { classifyAuthError, errorStatus, isAnthropicAuthError } from './authErrors.ts'

// SDK assistant-message error codes that mean the credential itself is the problem (the CLI also
// uses authentication_failed for a 403, see classifyAuthError).
const AUTH_CODES = new Set(['authentication_failed', 'oauth_org_not_allowed'])

export class AuthHealth {
  private store: SettingsLike
  private listeners = new Set<() => void>()

  constructor(store: SettingsLike) {
    this.store = store
  }

  get(via?: AuthVia): AuthHealthRecord | null {
    const r = this.store.getSetting<AuthHealthRecord | null>(AUTH_HEALTH_SETTING, null)
    if (!r || typeof r !== 'object' || (r.via !== 'key' && r.via !== 'claudeLogin')) return null
    return via && r.via !== via ? null : r
  }

  // True while the last request on `via` failed to authenticate.
  failed(via: AuthVia): boolean {
    const r = this.get(via)
    return !!r && !r.ok
  }

  record(via: AuthVia, ok: boolean, message?: string): void {
    const prev = this.get()
    const next: AuthHealthRecord = { via, ok, at: Date.now(), ...(message ? { message: message.slice(0, 300) } : {}) }
    this.store.setSetting(AUTH_HEALTH_SETTING, next)
    // Only a change of state is news (every successful turn would otherwise notify).
    if (!prev || prev.ok !== ok || prev.via !== via) for (const fn of this.listeners) fn()
  }

  clear(): void {
    if (!this.get()) return
    this.store.setSetting(AUTH_HEALTH_SETTING, null)
    for (const fn of this.listeners) fn()
  }

  onChange(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }
}

export function viaOf(options: Pick<Options, 'env'> | undefined): AuthVia {
  return options?.env?.ANTHROPIC_API_KEY ? 'key' : 'claudeLogin'
}

// What one SDK message says about authentication: 'failed' (with a reason), 'ok' or nothing.
// rejected: a 403 that does not blame the credential (see classifyAuthError); it is not recorded,
// watchAnthropicAuth probes another model instead.
export function authSignal(m: SDKMessage): { ok: boolean; message?: string; rejected?: boolean } | null {
  const msg = m as any
  if (msg.type === 'assistant' && typeof msg.error === 'string' && AUTH_CODES.has(msg.error)) {
    if (msg.error === 'oauth_org_not_allowed') return { ok: false, message: msg.error }
    const text = Array.isArray(msg.message?.content) ? msg.message.content.map((c: any) => (c?.type === 'text' ? String(c.text ?? '') : '')).join(' ').trim() : ''
    return classifyAuthError(text) === 'rejected' ? { ok: false, message: text, rejected: true } : { ok: false, message: msg.error }
  }
  if (msg.type === 'result') {
    if (!msg.is_error && msg.subtype === 'success') return { ok: true }
    const text = typeof msg.result === 'string' ? msg.result : Array.isArray(msg.errors) ? msg.errors.join('; ') : ''
    const kind = classifyAuthError(text, msg.api_error_status)
    if (kind === 'auth') return { ok: false, message: text || 'HTTP 401' }
    if (kind === 'rejected') return { ok: false, message: text || 'HTTP 403', rejected: true }
  }
  return null
}

// The prompt of the probe that tells a per-model 403 from a dead credential.
export const AUTH_PROBE_SYSTEM = 'Forge sign-in check. Reply with the single word OK.'
const PROBE_TTL = 5 * 60_000

// The model a probe uses instead of the rejected one (the cheap tier; Sonnet when Haiku was rejected).
export function probeModelFor(rejected: string | undefined): string {
  return /haiku/i.test(rejected ?? '') ? 'claude-sonnet-5-5' : 'claude-haiku-5-5'
}

export interface WatchOptions {
  // Run a probe on another model after a per-model 403 (default true).
  probe?: boolean
  probeModel?: (rejected: string | undefined) => string
  // Each probe's completion (tests wait on it).
  onProbe?: (done: Promise<void>) => void
}

// After a 403 that does not blame the credential: one tiny request on another model. If that one
// fails to authenticate too (401, credential wording, or another 403), the login really is the
// problem and is marked failed; if it answers, the login works (recorded ok). Other outcomes
// (overloaded, offline) record nothing. One probe per credential and model every few minutes.
function probeAfterRejection(inner: QueryFn, health: AuthHealth, via: AuthVia, options: Options, message: string, opts: WatchOptions, recent: Map<string, number>): void {
  if (opts.probe === false) return
  const rejected = typeof options.model === 'string' ? options.model : undefined
  const key = `${via}:${rejected ?? ''}`
  const last = recent.get(key)
  if (last !== undefined && Date.now() - last < PROBE_TTL) return
  recent.set(key, Date.now())
  const model = (opts.probeModel ?? probeModelFor)(rejected)
  const done = (async () => {
    let outcome: { ok: boolean; message?: string } | null = null
    try {
      for await (const m of inner({
        prompt: 'OK?',
        options: {
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.env ? { env: options.env } : {}),
          ...(options.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: options.pathToClaudeCodeExecutable } : {}),
          model,
          systemPrompt: AUTH_PROBE_SYSTEM,
          mcpServers: {},
          strictMcpConfig: true,
          tools: [],
          permissionMode: 'dontAsk',
          settingSources: [],
          persistSession: false,
          maxTurns: 1
        }
      })) {
        const s = authSignal(m)
        if (s) outcome = s
      }
    } catch (e) {
      const text = (e as Error)?.message
      if (!outcome && classifyAuthError(text)) outcome = { ok: false, message: text }
    }
    if (!outcome) return
    if (outcome.ok) health.record(via, true)
    else health.record(via, false, `${message} (a check on ${model} failed too: ${outcome.message ?? 'auth error'})`)
  })()
  opts.onProbe?.(done)
}

// Wraps a query function so its outcomes feed AuthHealth. Messages pass through untouched.
export function watchAnthropicAuth(inner: QueryFn, health: AuthHealth, opts: WatchOptions = {}): QueryFn {
  const recent = new Map<string, number>()
  return (params) => {
    const via = viaOf(params.options)
    const source = inner(params)
    return (async function* () {
      // A per-model 403 seen in this query (probed once, after the query ends).
      let rejected: string | null = null
      let failed = false
      try {
        for await (const m of source) {
          const s = authSignal(m)
          if (s?.rejected) rejected ??= s.message ?? 'HTTP 403'
          else if (s) {
            if (!s.ok) failed = true
            health.record(via, s.ok, s.message)
          }
          yield m
        }
      } catch (e) {
        const text = (e as Error)?.message
        const kind = classifyAuthError(text)
        if (kind === 'auth') {
          failed = true
          health.record(via, false, text)
        } else if (kind === 'rejected') rejected ??= text
        throw e
      } finally {
        if (rejected && !failed) probeAfterRejection(inner, health, via, params.options ?? {}, rejected, opts, recent)
      }
    })()
  }
}
