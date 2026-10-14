// API key storage per provider, and Anthropic credential selection.
//
// Keys the user enters are encrypted with Electron safeStorage when available and stored in
// settings ('anthropicApiKey' for anthropic, kept from earlier versions; '<provider>ApiKey' for the
// rest). A key in the environment (ANTHROPIC_API_KEY, OPENAI_API_KEY, ...) is used when nothing is
// stored. Keys never leave the main process.
//
// Anthropic: the Agent SDK runs the Claude Code CLI as a subprocess. Forge passes it an explicit
// environment per query (Options.env) so the documented API-key path is used:
//   - with a key: ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is removed;
//   - with the 'anthropicUseClaudeLogin' setting on (Settings > Accounts "Sign in with Claude")
//     and a login found: the environment is passed through without ANTHROPIC_API_KEY, so the CLI
//     uses the Claude Code login or CLAUDE_CODE_OAUTH_TOKEN. Signing in is an explicit choice, so
//     it comes before a stored key ("Use an API key instead" turns the setting off);
//   - otherwise with a key: ANTHROPIC_API_KEY is set and CLAUDE_CODE_OAUTH_TOKEN is removed;
//   - without either, the query is not started.
// Cloud providers configured through the environment (CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY) or a
// gateway token (ANTHROPIC_AUTH_TOKEN) are explicit configuration and always count as ready.
// "Login found": CLAUDE_CODE_OAUTH_TOKEN, else the last `claude auth status` answer (accounts/
// claude.ts, set through setLoginProbe), else the credentials file's presence. On macOS the login
// lives in the Keychain, which only the CLI can see; before it has answered, Forge lets the query
// run and the CLI reports any auth error. Whether the login actually works is learned from requests
// (accounts/authHealth.ts): a failed one marks it expired until a request or a test succeeds.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderId } from '@shared/types'
import type { HarnessContext } from '../context.ts'
import { AuthHealth } from '../accounts/authHealth.ts'

export const USE_CLAUDE_LOGIN_SETTING = 'anthropicUseClaudeLogin'

interface StoredKey {
  // 'safe' = safeStorage ciphertext; 'plain' = base64 only (safeStorage unavailable).
  enc: 'safe' | 'plain'
  data: string
}

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(text: string): Buffer
  decryptString(data: Buffer): string
}

// Electron is imported lazily so node tests never load it.
export type SafeStorageLoader = () => Promise<SafeStorageLike | null>

export const electronSafeStorage: SafeStorageLoader = async () => {
  try {
    const electron: any = await import('electron')
    const safe = electron.safeStorage ?? electron.default?.safeStorage
    return safe && safe.isEncryptionAvailable() ? safe : null
  } catch {
    return null
  }
}

// Environment variable each provider's key can come from.
export const ENV_KEYS: Partial<Record<ProviderId, string>> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  openrouter: 'OPENROUTER_API_KEY',
  gemini: 'GEMINI_API_KEY',
  ollama: 'OLLAMA_API_KEY'
}

export function keySetting(provider: ProviderId): string {
  return provider === 'anthropic' ? 'anthropicApiKey' : `${provider}ApiKey`
}

export interface AnthropicAuth {
  ready: boolean
  // Environment for the SDK subprocess (undefined = inherit process.env).
  env?: Record<string, string | undefined>
  // Why it is not ready.
  error?: string
  source?: 'key' | 'claudeLogin' | 'cloud'
  // The last request on this credential failed to authenticate (it may still be retried).
  failed?: boolean
}

export class Credentials {
  private ctx: HarnessContext
  private loadSafe: SafeStorageLoader
  private env: NodeJS.ProcessEnv
  // Env values present at startup (not ones we injected), so clearing a stored key keeps them.
  private originalEnv: Partial<Record<ProviderId, string>> = {}
  // Last `claude auth status` answer (true/false), undefined when unknown.
  private loginProbe: () => boolean | undefined = () => undefined
  readonly health: AuthHealth

  constructor(ctx: HarnessContext, loadSafe: SafeStorageLoader = electronSafeStorage, env: NodeJS.ProcessEnv = process.env) {
    this.ctx = ctx
    this.loadSafe = loadSafe
    this.env = env
    this.health = new AuthHealth(ctx)
    for (const [p, name] of Object.entries(ENV_KEYS)) {
      const v = env[name!]
      if (v) this.originalEnv[p as ProviderId] = v
    }
  }

  async storedKey(provider: ProviderId = 'anthropic'): Promise<string | null> {
    const stored = this.ctx.getSetting<StoredKey | null>(keySetting(provider), null)
    if (!stored?.data) return null
    const buf = Buffer.from(stored.data, 'base64')
    if (stored.enc === 'plain') return buf.toString('utf8')
    const safe = await this.loadSafe()
    if (!safe) return null
    try {
      return safe.decryptString(buf)
    } catch {
      return null
    }
  }

  // The key to use: stored first, then the environment at startup.
  async getKey(provider: ProviderId): Promise<string | null> {
    return (await this.storedKey(provider)) ?? this.originalEnv[provider] ?? null
  }

  async keySource(provider: ProviderId): Promise<'stored' | 'env' | null> {
    if (await this.storedKey(provider)) return 'stored'
    return this.originalEnv[provider] ? 'env' : null
  }

  async setKey(provider: ProviderId, key: string): Promise<void> {
    const trimmed = key.trim()
    const setting = keySetting(provider)
    if (!trimmed) {
      this.ctx.setSetting(setting, null)
      return
    }
    const safe = await this.loadSafe()
    const value: StoredKey = safe
      ? { enc: 'safe', data: safe.encryptString(trimmed).toString('base64') }
      : { enc: 'plain', data: Buffer.from(trimmed, 'utf8').toString('base64') }
    if (!safe) this.ctx.log({ service: 'agent', stream: 'info', text: `safeStorage unavailable; ${provider} key stored unencrypted in settings` })
    this.ctx.setSetting(setting, value)
  }

  // Older API: the anthropic key.
  setApiKey(key: string): Promise<void> {
    return this.setKey('anthropic', key)
  }

  useClaudeLogin(): boolean {
    return this.ctx.getSetting<boolean>(USE_CLAUDE_LOGIN_SETTING, false) === true
  }

  setUseClaudeLogin(on: boolean): void {
    this.ctx.setSetting(USE_CLAUDE_LOGIN_SETTING, !!on)
  }

  setLoginProbe(fn: () => boolean | undefined): void {
    this.loginProbe = fn
  }

  // Whether a Claude Code login can be used: true, false, or undefined (macOS Keychain, not checked).
  claudeLoginFound(): boolean | undefined {
    const e = this.env
    if (e.CLAUDE_CODE_OAUTH_TOKEN) return true
    const probe = this.loginProbe()
    if (probe !== undefined) return probe
    if (claudeCodeLoginExists(e)) return true
    return process.platform === 'darwin' ? undefined : false
  }

  // How the anthropic provider would authenticate right now, and the env for the SDK subprocess.
  async anthropicAuth(): Promise<AnthropicAuth> {
    const e = this.env
    const cloud = !!(e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY || e.ANTHROPIC_AUTH_TOKEN)
    const login = this.useClaudeLogin() && !cloud ? this.claudeLoginFound() : false
    if (login === true) {
      // Never pass a stale key we injected earlier, nor one from the environment.
      const env: Record<string, string | undefined> = { ...e }
      delete env.ANTHROPIC_API_KEY
      return { ready: true, env, source: 'claudeLogin', ...(this.health.failed('claudeLogin') ? { failed: true } : {}) }
    }
    const key = await this.getKey('anthropic')
    if (key) {
      const env: Record<string, string | undefined> = { ...e, ANTHROPIC_API_KEY: key }
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      return { ready: true, env, source: 'key', ...(this.health.failed('key') ? { failed: true } : {}) }
    }
    if (cloud) return { ready: true, env: { ...e }, source: 'cloud' }
    if (this.useClaudeLogin()) {
      if (login === undefined) {
        // macOS before the CLI has answered: let the CLI try the Keychain login.
        const env: Record<string, string | undefined> = { ...e }
        delete env.ANTHROPIC_API_KEY
        return { ready: true, env, source: 'claudeLogin', ...(this.health.failed('claudeLogin') ? { failed: true } : {}) }
      }
      return { ready: false, error: 'No Claude login found. Use "Sign in with Claude" in Settings > Accounts, or add an Anthropic API key.' }
    }
    return { ready: false, error: 'Sign in with Claude or add an Anthropic API key in Settings > Accounts.' }
  }

  // Kept for older callers: puts the stored anthropic key into process.env.
  async apply(): Promise<void> {
    const key = await this.storedKey('anthropic')
    if (key) this.env.ANTHROPIC_API_KEY = key
  }

  // Older API: whether the anthropic provider can run.
  async hasApiKey(): Promise<boolean> {
    return (await this.anthropicAuth()).ready
  }
}

// Claude Code keeps its login in <config dir>/.credentials.json on Linux and Windows.
export function claudeCodeLoginExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return existsSync(join(dir, '.credentials.json'))
}

export function maskKey(key: string): string {
  return key.length <= 8 ? '…' : `…${key.slice(-4)}`
}
