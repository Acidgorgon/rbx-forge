// Whether the Anthropic credential in use actually works, learned from real requests.
//
// A Claude Code login can exist on disk (or in the macOS Keychain) and still be dead: "OAuth
// session expired and could not be refreshed". Presence checks cannot see that, so every Agent SDK
// query is watched (watchAnthropicAuth wraps the query function once in createAgentLayer): an
// authentication error marks the credential failed, a successful turn or a passing Test connection
// clears it. The record is kept in settings so the card still says "Sign-in expired" after a restart.

import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk'
import type { QueryFn } from '../agent/sdk.ts'

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

// Text of an Anthropic authentication failure (CLI and API wording).
const AUTH_TEXT =
  /failed to authenticate|authentication[_ ]failed|oauth (session|token) (has )?expired|could not be refreshed|invalid (x-)?api[- _]key|invalid bearer token|not logged in|please run \/login|login expired|token (has been )?revoked|\b401\b.*(unauthori[sz]ed|authentication)|unauthori[sz]ed.*\b401\b/i

export function isAnthropicAuthError(text: unknown): boolean {
  return typeof text === 'string' && AUTH_TEXT.test(text)
}

// SDK assistant-message error codes that mean the credential itself is the problem.
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
export function authSignal(m: SDKMessage): { ok: boolean; message?: string } | null {
  const msg = m as any
  if (msg.type === 'assistant' && typeof msg.error === 'string' && AUTH_CODES.has(msg.error)) {
    return { ok: false, message: msg.error }
  }
  if (msg.type === 'result') {
    if (!msg.is_error && msg.subtype === 'success') return { ok: true }
    const text = typeof msg.result === 'string' ? msg.result : Array.isArray(msg.errors) ? msg.errors.join('; ') : ''
    if (msg.api_error_status === 401 || isAnthropicAuthError(text)) return { ok: false, message: text || 'HTTP 401' }
  }
  return null
}

// Wraps a query function so its outcomes feed AuthHealth. Messages pass through untouched.
export function watchAnthropicAuth(inner: QueryFn, health: AuthHealth): QueryFn {
  return (params) => {
    const via = viaOf(params.options)
    const source = inner(params)
    return (async function* () {
      try {
        for await (const m of source) {
          const s = authSignal(m)
          if (s) health.record(via, s.ok, s.message)
          yield m
        }
      } catch (e) {
        const text = (e as Error)?.message
        if (isAnthropicAuthError(text)) health.record(via, false, text)
        throw e
      }
    })()
  }
}
