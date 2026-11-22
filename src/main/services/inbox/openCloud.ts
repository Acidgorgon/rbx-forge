// Open Cloud key & creator lookup for the Inbox and Settings > Integrations.
// Preserves the existing encrypted secret keys (art.openCloudApiKey* / release.openCloudApiKey*)
// and settings keys (art.settings.<scope> / art.uploadCreator) so saved credentials keep working.

import type { InboxCloudStatus } from '../../../shared/inboxTypes.ts'
import { looksLikeApiKey } from '../release/openCloud.ts'
import { projectScope, readSecret } from '../release/secrets.ts'
import type { SecretStore } from '../release/types.ts'

export const CREATOR_KEY = 'art.uploadCreator'

export function artSecretKey(scope?: string): string {
  return scope ? `art.openCloudApiKey.${scope}` : 'art.openCloudApiKey'
}

export interface CreatorSettings {
  creatorUserId?: number
  creatorGroupId?: number
}

function cleanPositiveInt(v: unknown): number | undefined {
  const n = typeof v === 'number' ? v : Number(String(v ?? '').trim())
  return Number.isInteger(n) && n > 0 ? n : undefined
}

export function sanitizeCreator(raw: unknown): CreatorSettings {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>
  const creatorGroupId = cleanPositiveInt(r.creatorGroupId)
  const creatorUserId = creatorGroupId ? undefined : cleanPositiveInt(r.creatorUserId)
  return { ...(creatorUserId ? { creatorUserId } : {}), ...(creatorGroupId ? { creatorGroupId } : {}) }
}

export interface OpenCloudConfigDeps {
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  secrets: SecretStore
}

export class InboxCloudConfig {
  private deps: OpenCloudConfigDeps

  constructor(deps: OpenCloudConfigDeps) {
    this.deps = deps
  }

  async keyInfo(): Promise<{ key: string; source: 'inbox' | 'release' } | null> {
    const r = this.deps.root()
    const own = (r ? await this.deps.secrets.get(artSecretKey(projectScope(r))) : undefined) ?? (await this.deps.secrets.get(artSecretKey()))
    if (own) return { key: own, source: 'inbox' }
    const rel = r ? await readSecret(this.deps.secrets, 'openCloudApiKey', r) : await this.deps.secrets.get('release.openCloudApiKey')
    return rel ? { key: rel, source: 'release' } : null
  }

  async key(): Promise<string | null> {
    return (await this.keyInfo().catch(() => null))?.key ?? null
  }

  async setKey(rawKey: string, scope: 'project' | 'global'): Promise<InboxCloudStatus> {
    const k = String(rawKey ?? '').trim()
    if (!looksLikeApiKey(k)) throw new Error('That does not look like an Open Cloud API key.')
    const r = this.deps.root()
    if (scope === 'project' && !r) throw new Error('No project open')
    await this.deps.secrets.set(artSecretKey(scope === 'global' ? undefined : projectScope(r!)), k)
    return this.status()
  }

  async clearKey(scope: 'project' | 'global'): Promise<InboxCloudStatus> {
    const r = this.deps.root()
    if (scope === 'project' && !r) throw new Error('No project open')
    await this.deps.secrets.delete(artSecretKey(scope === 'global' ? undefined : projectScope(r!)))
    return this.status()
  }

  creator(root = this.deps.root()): { userId?: number; groupId?: number } {
    if (root) {
      const p = sanitizeCreator(this.deps.settings.get<CreatorSettings>(`art.settings.${projectScope(root)}`, {}))
      if (p.creatorUserId || p.creatorGroupId) {
        this.rememberCreator(p)
        return { ...(p.creatorUserId ? { userId: p.creatorUserId } : {}), ...(p.creatorGroupId ? { groupId: p.creatorGroupId } : {}) }
      }
    }
    const g = sanitizeCreator(this.deps.settings.get<CreatorSettings>(CREATOR_KEY, {}))
    return { ...(g.creatorUserId ? { userId: g.creatorUserId } : {}), ...(g.creatorGroupId ? { groupId: g.creatorGroupId } : {}) }
  }

  private rememberCreator(s: CreatorSettings): void {
    const next = s.creatorGroupId ? { creatorGroupId: s.creatorGroupId } : s.creatorUserId ? { creatorUserId: s.creatorUserId } : null
    if (!next) return
    const cur = this.deps.settings.get<CreatorSettings>(CREATOR_KEY, {})
    if (cur.creatorGroupId !== next.creatorGroupId || cur.creatorUserId !== next.creatorUserId) this.deps.settings.set(CREATOR_KEY, next)
  }

  async setCreator(patch: { userId?: number | null; groupId?: number | null }): Promise<InboxCloudStatus> {
    const r = this.deps.root()
    const next: CreatorSettings = patch.groupId
      ? sanitizeCreator({ creatorGroupId: patch.groupId })
      : patch.userId
        ? sanitizeCreator({ creatorUserId: patch.userId })
        : {}
    if (r) {
      const key = `art.settings.${projectScope(r)}`
      const cur = this.deps.settings.get<Record<string, unknown>>(key, {})
      const merged = { ...cur }
      delete merged.creatorUserId
      delete merged.creatorGroupId
      if (next.creatorUserId) merged.creatorUserId = next.creatorUserId
      if (next.creatorGroupId) merged.creatorGroupId = next.creatorGroupId
      this.deps.settings.set(key, merged)
    }
    if (next.creatorUserId || next.creatorGroupId) this.deps.settings.set(CREATOR_KEY, next)
    else if (!r) this.deps.settings.set(CREATOR_KEY, {})
    return this.status()
  }

  private statusSync(root = this.deps.root(), keyInfo?: { key: string; source: 'inbox' | 'release' } | null): InboxCloudStatus {
    const c = this.creator(root)
    return {
      robloxKey: !!keyInfo?.key,
      ...(keyInfo ? { robloxKeySource: keyInfo.source } : {}),
      ...(c.userId ? { creatorUserId: c.userId } : {}),
      ...(c.groupId ? { creatorGroupId: c.groupId } : {})
    }
  }

  async status(): Promise<InboxCloudStatus> {
    const keyInfo = await this.keyInfo().catch(() => null)
    return this.statusSync(this.deps.root(), keyInfo)
  }
}
