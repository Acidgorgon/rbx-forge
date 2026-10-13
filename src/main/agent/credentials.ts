// API key storage and credential detection.
//
// The Agent SDK runs the Claude Code CLI as a subprocess, which inherits process.env. Per the SDK
// types (ApiKeySource), the CLI authenticates with, in order of what we can see from here:
//   - ANTHROPIC_API_KEY in the environment,
//   - an apiKeyHelper or "/login managed key" from Claude Code's own config,
//   - a claude.ai OAuth login made with `claude /login` (apiKeySource 'none'), or
//     CLAUDE_CODE_OAUTH_TOKEN / ANTHROPIC_AUTH_TOKEN, or a cloud provider (Bedrock/Vertex/Foundry).
// We store a key the user enters (encrypted with Electron safeStorage when available) and put it in
// process.env.ANTHROPIC_API_KEY before each query. A Claude Code login is detected best-effort from
// its credentials file; on macOS the login lives in the Keychain, which we cannot see, so the UI
// may report "no key" even though queries would work.

import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { HarnessContext } from '../context.ts'

const SETTING = 'anthropicApiKey'

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

export class Credentials {
  private ctx: HarnessContext
  private loadSafe: SafeStorageLoader
  private env: NodeJS.ProcessEnv
  // Env key present at startup (not one we injected), so clearing our stored key keeps it.
  private originalEnvKey: string | undefined

  constructor(ctx: HarnessContext, loadSafe: SafeStorageLoader = electronSafeStorage, env: NodeJS.ProcessEnv = process.env) {
    this.ctx = ctx
    this.loadSafe = loadSafe
    this.env = env
    this.originalEnvKey = env.ANTHROPIC_API_KEY
  }

  async storedKey(): Promise<string | null> {
    const stored = this.ctx.getSetting<StoredKey | null>(SETTING, null)
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

  async setApiKey(key: string): Promise<void> {
    const trimmed = key.trim()
    if (!trimmed) {
      this.ctx.setSetting(SETTING, null)
      if (this.originalEnvKey) this.env.ANTHROPIC_API_KEY = this.originalEnvKey
      else delete this.env.ANTHROPIC_API_KEY
      return
    }
    const safe = await this.loadSafe()
    const value: StoredKey = safe
      ? { enc: 'safe', data: safe.encryptString(trimmed).toString('base64') }
      : { enc: 'plain', data: Buffer.from(trimmed, 'utf8').toString('base64') }
    if (!safe) this.ctx.log({ service: 'agent', stream: 'info', text: 'safeStorage unavailable; API key stored unencrypted in settings' })
    this.ctx.setSetting(SETTING, value)
    this.env.ANTHROPIC_API_KEY = trimmed
  }

  // Puts the stored key into the environment the SDK subprocess inherits.
  async apply(): Promise<void> {
    const key = await this.storedKey()
    if (key) this.env.ANTHROPIC_API_KEY = key
  }

  async hasApiKey(): Promise<boolean> {
    if (await this.storedKey()) return true
    const e = this.env
    if (e.ANTHROPIC_API_KEY || e.CLAUDE_CODE_OAUTH_TOKEN || e.ANTHROPIC_AUTH_TOKEN) return true
    if (e.CLAUDE_CODE_USE_BEDROCK || e.CLAUDE_CODE_USE_VERTEX || e.CLAUDE_CODE_USE_FOUNDRY) return true
    return claudeCodeLoginExists(e)
  }
}

// Claude Code keeps its login in <config dir>/.credentials.json on Linux and Windows.
export function claudeCodeLoginExists(env: NodeJS.ProcessEnv = process.env): boolean {
  const dir = env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return existsSync(join(dir, '.credentials.json'))
}
