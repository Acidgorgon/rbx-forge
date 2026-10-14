// Settings > Accounts: one card per provider (Claude, OpenAI, Gemini, OpenRouter, Ollama) with a
// clear status and the easiest way to set it up. Sign-in methods come from the registry
// (registry.ts: Claude here, Codex from its own service); keys stay in Credentials and only masked
// hints leave the main process.

import {
  ACCOUNT_IDS,
  ACCOUNT_PROVIDER,
  type AccountCheck,
  type AccountId,
  type AccountState,
  type AccountSummary,
  type SignInProgress,
  type SignInStatus
} from '../../shared/accountTypes.ts'
import type { ProviderInfo } from '../../shared/types.ts'
import type { Credentials } from '../agent/credentials.ts'
import { ENV_KEYS } from '../agent/credentials.ts'
import type { Providers } from '../agent/providers.ts'
import type { AccountProvider, AccountRegistry } from './registry.ts'

export const ACCOUNT_LABEL: Record<AccountId, string> = {
  claude: 'Claude',
  openai: 'OpenAI',
  gemini: 'Google Gemini',
  openrouter: 'OpenRouter',
  ollama: 'Ollama'
}

// Where each provider hands out API keys.
export const KEY_URL: Partial<Record<AccountId, string>> = {
  claude: 'https://platform.claude.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  openrouter: 'https://openrouter.ai/settings/keys',
  ollama: 'https://ollama.com/download'
}

const SUBSCRIPTION_TEXT: Record<string, string> = {
  claude: 'Signed in with Claude subscription',
  codex: 'Signed in with ChatGPT'
}

export interface SummaryInput {
  id: AccountId
  info: ProviderInfo
  signIn?: SignInStatus
  // Claude: how the anthropic provider authenticates now.
  authSource?: 'key' | 'claudeLogin' | 'cloud'
  authFailed?: boolean
  lastCheck?: AccountCheck
}

// The card headline. Pure, for tests.
export function summarize(i: SummaryInput): AccountSummary {
  const { id, info, signIn } = i
  let state: AccountState = 'none'
  let statusText = id === 'ollama' ? 'Not running' : 'Not set up'
  const keyText = info.keySource === 'env' ? `Using API key from ${ENV_KEYS[info.id] ?? 'the environment'}` : `Using API key ${info.keyHint ?? ''}`.trim()
  if (signIn?.state === 'expired') {
    state = 'expired'
    statusText = 'Sign-in expired'
  } else if (signIn?.state === 'signedIn' && !signIn.foundButOff) {
    state = 'subscription'
    statusText = SUBSCRIPTION_TEXT[signIn.method] ?? `Signed in (${signIn.label.replace(/^Sign in with /, '')})`
  } else if (id === 'claude' && i.authSource === 'cloud') {
    state = 'cloud'
    statusText = 'Using cloud credentials from the environment'
  } else if (info.keySource) {
    state = i.authFailed ? 'expired' : 'apiKey'
    statusText = i.authFailed ? 'API key was rejected' : keyText
  } else if (id === 'ollama' && info.ready) {
    state = 'local'
    statusText = `Running at ${info.baseUrl ?? 'localhost'}`
  } else if (id === 'claude' && i.authSource === 'claudeLogin') {
    // macOS before the CLI answered: the Keychain login may work.
    state = 'subscription'
    statusText = 'Using your Claude login (not checked yet)'
  }
  const envName = ENV_KEYS[info.id]
  return {
    id,
    provider: info.id,
    label: ACCOUNT_LABEL[id],
    state,
    statusText,
    ready: info.ready,
    ...(info.keySource ? { keySource: info.keySource } : {}),
    ...(info.keyHint ? { keyHint: info.keyHint } : {}),
    ...(envName && id !== 'ollama' ? { envName } : {}),
    ...(KEY_URL[id] ? { keyUrl: KEY_URL[id] } : {}),
    ...(signIn ? { signIn } : {}),
    ...(id === 'ollama' && info.baseUrl ? { baseUrl: info.baseUrl } : {}),
    ...(i.lastCheck ? { lastCheck: i.lastCheck } : {})
  }
}

// HTTP status of a key check -> card text.
export function keyCheckMessage(status: number): { ok: boolean; message: string } {
  if (status >= 200 && status < 300) return { ok: true, message: 'Connected' }
  if (status === 401 || status === 403) return { ok: false, message: `Key rejected (HTTP ${status})` }
  if (status === 400) return { ok: false, message: 'Key rejected (HTTP 400)' }
  if (status === 429) return { ok: true, message: 'Key works (rate limited right now)' }
  return { ok: false, message: `Provider answered HTTP ${status}` }
}

export interface AccountsDeps {
  credentials: Credentials
  providers: Providers
  registry: AccountRegistry
  emit: (event: 'accounts:changed' | 'accounts:signin', payload: unknown) => void
  // Re-emits provider status (providers:changed) after a change.
  providersChanged: () => Promise<void>
  fetchFn?: typeof fetch
  signInTimeoutMs?: number
  testTimeoutMs?: number
  log?: (text: string) => void
}

interface RunningSignIn {
  abort: AbortController
  done: Promise<SignInProgress>
  codeHandler: ((code: string) => void) | null
  last: SignInProgress
}

export class AccountsService {
  private deps: AccountsDeps
  private running = new Map<AccountId, RunningSignIn>()
  private tests = new Map<AccountId, { abort: AbortController; done: Promise<AccountCheck> }>()
  private checks = new Map<AccountId, AccountCheck>()

  constructor(deps: AccountsDeps) {
    this.deps = deps
  }

  private method(id: AccountId): AccountProvider | undefined {
    return this.deps.registry.forAccount(id)
  }

  private async signInStatus(id: AccountId, refresh: boolean): Promise<SignInStatus | undefined> {
    const m = this.method(id)
    if (!m) return undefined
    try {
      return await m.status({ refresh })
    } catch (e) {
      return { method: m.method, label: m.label, state: 'unknown', detail: `Could not check: ${(e as Error).message}` }
    }
  }

  async summary(id: AccountId, refresh = false): Promise<AccountSummary> {
    const provider = ACCOUNT_PROVIDER[id]
    const signIn = await this.signInStatus(id, refresh)
    const info = await this.deps.providers.info(provider)
    let authSource: SummaryInput['authSource']
    let authFailed = false
    if (provider === 'anthropic') {
      const auth = await this.deps.credentials.anthropicAuth()
      authSource = auth.ready ? auth.source : undefined
      authFailed = auth.source === 'key' && !!auth.failed
    }
    return summarize({ id, info, signIn, authSource, authFailed, lastCheck: this.checks.get(id) })
  }

  async list(opts: { refresh?: boolean } = {}): Promise<AccountSummary[]> {
    return Promise.all(ACCOUNT_IDS.map((id) => this.summary(id, !!opts.refresh)))
  }

  async changed(): Promise<AccountSummary[]> {
    await this.deps.providersChanged().catch(() => undefined)
    const list = await this.list()
    this.deps.emit('accounts:changed', list)
    return list
  }

  // Starts (or joins) the card's sign-in. Resolves with the final progress.
  signIn(id: AccountId): Promise<SignInProgress> {
    const existing = this.running.get(id)
    if (existing) return existing.done
    const m = this.method(id)
    if (!m) return Promise.resolve({ account: id, method: '', phase: 'failed', message: `${ACCOUNT_LABEL[id]} has no sign-in; use an API key.` })
    const abort = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      abort.abort()
    }, m.timeoutMs ?? this.deps.signInTimeoutMs ?? 10 * 60_000)
    const run: RunningSignIn = { abort, codeHandler: null, last: { account: id, method: m.method, phase: 'starting' }, done: null as never }
    const report = (p: Partial<SignInProgress>) => {
      // A new stage (install -> device code -> browser) does not keep the last stage's link or code.
      const base = p.stage && p.stage !== run.last.stage ? { ...run.last, url: undefined, userCode: undefined } : run.last
      run.last = { ...base, ...p, account: id, method: m.method }
      this.deps.emit('accounts:signin', run.last)
    }
    run.done = (async (): Promise<SignInProgress> => {
      report({ phase: 'starting' })
      try {
        const r = await m.signIn({
          signal: abort.signal,
          progress: (u) => report({ phase: 'waiting', ...u }),
          onCode: (h) => {
            run.codeHandler = h
          }
        })
        if (timedOut) report({ phase: 'timeout', message: 'Sign-in timed out. Try again.' })
        else if (abort.signal.aborted) report({ phase: 'cancelled', message: 'Sign-in cancelled.' })
        else if (r.ok) report({ phase: 'done', message: r.message ?? 'Signed in.', acceptsCode: false })
        else report({ phase: 'failed', message: r.message ?? 'Sign-in failed.', acceptsCode: false, ...(r.helpUrl ? { helpUrl: r.helpUrl } : {}) })
      } catch (e) {
        report({ phase: timedOut ? 'timeout' : abort.signal.aborted ? 'cancelled' : 'failed', message: (e as Error).message })
      } finally {
        clearTimeout(timer)
        this.running.delete(id)
      }
      if (run.last.phase === 'done') this.checks.set(id, { ok: true, message: 'Signed in', at: Date.now(), via: 'subscription' })
      await this.changed()
      return run.last
    })()
    this.running.set(id, run)
    return run.done
  }

  cancelSignIn(id: AccountId): void {
    this.running.get(id)?.abort.abort()
  }

  submitCode(id: AccountId, code: string): void {
    const run = this.running.get(id)
    if (!run?.codeHandler) throw new Error('No sign-in is waiting for a code.')
    if (!code.trim()) return
    run.codeHandler(code)
  }

  async signOut(id: AccountId, opts: { cliLogout?: boolean } = {}): Promise<AccountSummary[]> {
    this.cancelSignIn(id)
    const m = this.method(id)
    if (m) await m.signOut({ cliLogout: opts.cliLogout === true })
    if (id === 'claude') this.deps.credentials.health.clear()
    this.checks.delete(id)
    return this.changed()
  }

  async useExisting(id: AccountId): Promise<AccountSummary[]> {
    const m = this.method(id)
    if (!m?.useExisting) throw new Error(`${ACCOUNT_LABEL[id]} has no existing login to use.`)
    await m.useExisting()
    this.checks.delete(id)
    return this.changed()
  }

  cancelTest(id: AccountId): void {
    this.tests.get(id)?.abort.abort()
  }

  // A tiny request with what the card uses now. Joins a test already running for the card.
  test(id: AccountId): Promise<AccountCheck> {
    const existing = this.tests.get(id)
    if (existing) return existing.done
    const abort = new AbortController()
    const timer = setTimeout(() => abort.abort(), this.deps.testTimeoutMs ?? 90_000)
    const done = (async () => {
      let check: AccountCheck
      try {
        check = await this.runTest(id, abort.signal)
      } catch (e) {
        check = { ok: false, message: abort.signal.aborted ? 'Test cancelled' : `Test failed: ${(e as Error).message}`, at: Date.now() }
      } finally {
        clearTimeout(timer)
        this.tests.delete(id)
      }
      // A cancelled test says nothing about the account.
      if (!abort.signal.aborted) this.checks.set(id, check)
      await this.changed()
      return check
    })()
    this.tests.set(id, { abort, done })
    return done
  }

  private async runTest(id: AccountId, signal: AbortSignal): Promise<AccountCheck> {
    const provider = ACCOUNT_PROVIDER[id]
    const m = this.method(id)
    if (provider === 'anthropic') {
      const auth = await this.deps.credentials.anthropicAuth()
      if (!auth.ready) return { ok: false, message: 'Not set up', at: Date.now() }
      if (auth.source === 'cloud') return { ok: true, message: 'Uses cloud credentials from the environment (not tested here)', at: Date.now() }
      if (auth.source === 'claudeLogin') {
        if (!m?.test) return { ok: false, message: 'Cannot test the Claude login', at: Date.now() }
        return m.test(signal)
      }
      const key = await this.deps.credentials.getKey('anthropic')
      if (!key) return { ok: false, message: 'Not set up', at: Date.now() }
      const res = await this.fetch('https://api.anthropic.com/v1/models?limit=1', { headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' }, signal })
      const r = keyCheckMessage(res.status)
      if (r.ok || res.status === 401) this.deps.credentials.health.record('key', r.ok, r.ok ? undefined : r.message)
      return { ...r, at: Date.now(), via: 'apiKey' }
    }
    // A subscription sign-in in use (Codex) is tested by its own method.
    if (m?.test) {
      const s = await this.signInStatus(id, false)
      if (s?.state === 'signedIn' && !s.foundButOff) return m.test(signal)
    }
    if (provider === 'ollama') {
      const base = this.deps.providers.baseUrl('ollama')
      if (!base) return { ok: false, message: 'No server URL', at: Date.now() }
      try {
        const res = await this.fetch(`${base}/models`, { signal })
        return { ok: res.ok, message: res.ok ? 'Ollama is running' : `Ollama answered HTTP ${res.status}`, at: Date.now(), via: 'local' }
      } catch {
        if (signal.aborted) throw new Error('cancelled')
        return { ok: false, message: `Ollama is not running at ${base}`, at: Date.now(), via: 'local' }
      }
    }
    const ep = await this.deps.providers.endpoint(provider)
    if ('error' in ep) return { ok: false, message: 'Not set up', at: Date.now() }
    // OpenRouter lists models without a key; /key checks the key itself.
    const url = provider === 'openrouter' ? `${ep.baseUrl}/key` : `${ep.baseUrl}/models`
    const res = await this.fetch(url, { headers: ep.headers, signal })
    return { ...keyCheckMessage(res.status), at: Date.now(), via: 'apiKey' }
  }

  private async fetch(url: string, init: RequestInit): Promise<Response> {
    const f = this.deps.fetchFn ?? fetch
    const res = await f(url, init)
    // Drain the body; only the status matters (and it may contain account details).
    await res.arrayBuffer().catch(() => undefined)
    return res
  }

  // The most recent check for a card (renderer decides when to re-test).
  lastCheck(id: AccountId): AccountCheck | undefined {
    return this.checks.get(id)
  }

  dispose(): void {
    for (const r of this.running.values()) r.abort.abort()
    for (const t of this.tests.values()) t.abort.abort()
  }
}
