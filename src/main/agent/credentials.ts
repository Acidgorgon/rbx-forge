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
//   - without a key, only when the 'anthropicUseClaudeLogin' setting is on: the environment is
//     passed through, so the CLI uses an existing Claude Code login or CLAUDE_CODE_OAUTH_TOKEN;
//   - without either, the query is not started.
// Cloud providers configured through the environment (CLAUDE_CODE_USE_BEDROCK/VERTEX/FOUNDRY) or a
// gateway token (ANTHROPIC_AUTH_TOKEN) are explicit configuration and always count as ready.
// On macOS a Claude Code login lives in the Keychain, which we cannot see; with the opt-in on and
// no credentials file, Forge still lets the query run and the CLI reports any auth error.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProviderId } from '@shared/types'
import type { HarnessContext } from '../context.ts'

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
}

export class Credentials {
  private ctx: HarnessContext
  private loadSafe: SafeStorageLoader
  private env: NodeJS.ProcessEnv
  // Env values present at startup (not ones we injected), so clearing a stored key keeps them.
  private originalEnv: Partial<Record<ProviderId, string>> = {}

  constructor(ctx: HarnessContext, loadSafe: SafeStorageLoader = electronSafeStorage, env: NodeJS.ProcessEnv = process.env) {
    this.ctx = ctx
    this.loadSafe = loadSafe
    this.env = env
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

  // How the anthropic provider would authenticate right now, and the env for the SDK subprocess.
  async anthropicAuth(): Promise<AnthropicAuth> {
    const e = this.env
    const key = await this.getKey('anthropic')
    if (key) {
      const env: Record<string, string | undefined> = { ...e, ANTHROPIC_API_KEY: key }
      delete env.CLAUDE_CODE_OAUTH_TOKEN
      return { ready: true, env, source: 'key' }
    }
    if (e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY || e.ANTHROPIC_AUTH_TOKEN) {
      return { ready: true, env: { ...e }, source: 'cloud' }
    }
    if (this.useClaudeLogin()) {
      // Never pass a stale key we injected earlier.
      const env: Record<string, string | undefined> = { ...e }
      delete env.ANTHROPIC_API_KEY
      const found = !!e.CLAUDE_CODE_OAUTH_TOKEN || claudeCodeLoginExists(e) || process.platform === 'darwin'
      return found
        ? { ready: true, env, source: 'claudeLogin' }
        : { ready: false, error: 'No Claude Code login found. Run `claude /login`, or add an Anthropic API key in Settings.' }
    }
    return { ready: false, error: 'Add an Anthropic API key in Settings (or turn on "Use my Claude Code login").' }
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
