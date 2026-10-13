import { createHash } from 'node:crypto'
import { resolve } from 'node:path'
import type { KeyValueStore, SecretStore } from './types.ts'

// Per-user secrets for releases: the Open Cloud API key and the Discord webhook URL. They live only
// in the app's userData (encrypted with Electron safeStorage), never in the repo or .forge/.

export type SecretKind = 'openCloudApiKey' | 'discordWebhook'

// Secrets are scoped to one project (a key is usually limited to one experience, a webhook to one
// team channel). The scope is a hash of the absolute root so paths do not leak into key names.
export function projectScope(root: string): string {
  return createHash('sha256').update(resolve(root)).digest('hex').slice(0, 16)
}

export function secretKey(kind: SecretKind, root?: string): string {
  return root ? `release.${kind}.${projectScope(root)}` : `release.${kind}`
}

// Project-scoped value first, then the person's global default.
export async function readSecret(store: SecretStore, kind: SecretKind, root: string): Promise<string | undefined> {
  return (await store.get(secretKey(kind, root))) ?? (await store.get(secretKey(kind)))
}

export class MemorySecretStore implements SecretStore {
  readonly data = new Map<string, string>()
  async get(key: string): Promise<string | undefined> {
    return this.data.get(key)
  }
  async set(key: string, value: string): Promise<void> {
    this.data.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.data.delete(key)
  }
}

// The parts of Electron's safeStorage this needs; passed in so this file never imports electron.
export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plainText: string): Buffer
  decryptString(encrypted: Buffer): string
}

// Encrypted values stored as base64 in a KeyValueStore (the app's Settings works) under "secrets".
// Refuses to store anything when OS encryption is unavailable rather than writing plain text.
export function createEncryptedSecretStore(safeStorage: SafeStorageLike, kv: KeyValueStore, bucket = 'secrets'): SecretStore {
  const all = (): Record<string, string> => ({ ...kv.get<Record<string, string>>(bucket, {}) })
  return {
    async get(key) {
      const value = all()[key]
      if (!value || !safeStorage.isEncryptionAvailable()) return undefined
      try {
        return safeStorage.decryptString(Buffer.from(value, 'base64'))
      } catch {
        return undefined
      }
    },
    async set(key, value) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('This computer cannot encrypt secrets (no OS keychain), so Forge will not store them.')
      const data = all()
      data[key] = safeStorage.encryptString(value).toString('base64')
      kv.set(bucket, data)
    },
    async delete(key) {
      const data = all()
      delete data[key]
      kv.set(bucket, data)
    }
  }
}
