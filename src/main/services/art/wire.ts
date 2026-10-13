// IPC handlers (ArtApi) and agent tools for the art workflow, built from app pieces passed in by
// main/integrations.ts. No electron imports: the thumbnailer and file dialog come in as functions.
// No handler returns a key; status only says whether one is set.

import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { chatImageStore, hasChatImageStore, imageMarker } from '../../agent/chatImages.ts'
import type { ArtGenerateInput, ArtImportInput, ArtSettings, HarnessEvents } from '../../../shared/types.ts'
import { ArtService, type ArtServiceDeps } from './service.ts'
import { artTools, type ArtTool } from './tools.ts'
import { looksLikeApiKey } from '../release/openCloud.ts'
import { projectScope, readSecret } from '../release/secrets.ts'
import type { SecretStore } from '../release/types.ts'
import { artSecretKey } from './index.ts'

export interface ArtWireDeps {
  root: () => string | null
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  secrets: SecretStore
  userDataDir: string
  openAiKey: () => Promise<string | null>
  emit: <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
  thumbnail?: ArtServiceDeps['thumbnail']
  chooseImages?: () => Promise<string[]>
  chatImage?: (absPath: string, name: string) => Promise<string | null>
  resolveReference?: (ref: string) => Promise<string | null>
  fetch?: ArtServiceDeps['fetch']
  sleep?: ArtServiceDeps['sleep']
}

export interface ArtWiring {
  service: ArtService
  handlers: Record<string, (...args: any[]) => unknown>
  tools: () => ArtTool[]
  // The Open Cloud key (Art page, else the release key) for other uploads (Animation Lab).
  robloxKey: () => Promise<{ key: string; source: 'art' | 'release' } | null>
}

// Generated images go into the chat image store; the tool result carries its marker so the chat
// shows them inline (agent/chatImages.ts).
export async function defaultChatImage(absPath: string, name: string): Promise<string | null> {
  if (!hasChatImageStore()) return null
  return imageMarker(await chatImageStore().importFile(absPath, name))
}

// forge-image://<id> (a chat image) -> its file in the chat image store.
export async function defaultResolveReference(ref: string): Promise<string | null> {
  const m = /^forge-image:\/\/([a-f0-9-]{36})$/.exec(ref.trim())
  if (!m || !hasChatImageStore()) return null
  const dir = chatImageStore().dir
  for (const ext of ['png', 'jpg', 'webp', 'gif']) {
    const p = join(dir, `${m[1]}.${ext}`)
    if (await stat(p).then((s) => s.isFile(), () => false)) return p
  }
  return null
}

export function createArtWiring(deps: ArtWireDeps): ArtWiring {
  const robloxKey = async (): Promise<{ key: string; source: 'art' | 'release' } | null> => {
    const r = deps.root()
    const own = (r ? await deps.secrets.get(artSecretKey(projectScope(r))) : undefined) ?? (await deps.secrets.get(artSecretKey()))
    if (own) return { key: own, source: 'art' }
    const rel = r ? await readSecret(deps.secrets, 'openCloudApiKey', r) : await deps.secrets.get('release.openCloudApiKey')
    return rel ? { key: rel, source: 'release' } : null
  }
  const service = new ArtService({
    root: deps.root,
    scope: projectScope,
    settings: deps.settings,
    openAiKey: deps.openAiKey,
    robloxKey,
    trashDir: join(deps.userDataDir, 'art-trash'),
    thumbDir: join(deps.userDataDir, 'art-thumbs'),
    ...(deps.thumbnail ? { thumbnail: deps.thumbnail } : {}),
    resolveReference: deps.resolveReference ?? defaultResolveReference,
    ...(deps.fetch ? { fetch: deps.fetch } : {}),
    ...(deps.sleep ? { sleep: deps.sleep } : {}),
    onChanged: (root) => deps.emit('art:changed', { root }),
    onProgress: (p) => deps.emit('art:progress', p)
  })
  const root = () => {
    const r = deps.root()
    if (!r) throw new Error('No project open')
    return r
  }
  const handlers: Record<string, (...args: any[]) => unknown> = {
    artStatus: () => service.status(),
    artSetSettings: (patch: Partial<ArtSettings>) => service.setSettings(patch ?? {}),
    artSetRobloxKey: async (key: string, scope: 'project' | 'global') => {
      const k = String(key ?? '').trim()
      if (!looksLikeApiKey(k)) throw new Error('That does not look like an Open Cloud API key.')
      await deps.secrets.set(artSecretKey(scope === 'global' ? undefined : projectScope(root())), k)
      return service.status()
    },
    artClearRobloxKey: async (scope: 'project' | 'global') => {
      await deps.secrets.delete(artSecretKey(scope === 'global' ? undefined : projectScope(root())))
      return service.status()
    },
    artList: () => service.list(),
    artEstimate: (input: ArtGenerateInput) => service.estimate({ ...(input ?? { prompt: '' }), source: 'page' }),
    artGenerate: (input: ArtGenerateInput) => service.generate({ ...(input ?? { prompt: '' }), source: 'page' }),
    artThumbnail: (path: string, full?: boolean) => service.thumbnail(String(path ?? ''), full === true),
    artDelete: (path: string) => service.remove(String(path ?? '')),
    artUndoDelete: (id: string) => service.undoRemove(String(id ?? '')),
    artImportToRoblox: (input: ArtImportInput) => service.importToRoblox(input),
    artSaveToProject: (path: string, name?: string) => service.saveToProject(String(path ?? ''), name ? String(name) : undefined),
    artRegistry: () => service.registry(),
    artChooseReferences: async () => (deps.chooseImages ? deps.chooseImages() : [])
  }
  let tools: ArtTool[] | null = null
  return {
    service,
    handlers,
    robloxKey,
    tools: () => (tools ??= artTools({ service, chatImage: deps.chatImage ?? defaultChatImage }))
  }
}
