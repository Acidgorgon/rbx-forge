// IPC handlers (ThumbsApi) for the Thumbnail Lab, built from app pieces passed in by main/index.ts.
// No electron imports: decoding, the image picker, Studio and the models come in as functions.

import { join } from 'node:path'
import type { PrincipleHooks } from '../../../shared/principles/types.ts'
import type { ThumbGenerateInput, ThumbScope, ThumbSettings } from '../../../shared/thumbs/types.ts'
import type { ArtFetch } from '../art/openaiImages.ts'
import type { CodexImages } from '../art/imageBackend.ts'
import type { ImageBackend } from '../../../shared/artTypes.ts'
import { ThumbService, type ThumbMemory, type ThumbTier, type VisionFn } from './service.ts'

export interface ThumbsWireDeps {
  userDataDir: string
  root: () => string | null
  gameName?: () => string | undefined
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit: (event: 'thumbs:changed' | 'thumbs:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  memory?: ThumbMemory
  principles?: PrincipleHooks
  vision?: (tier: ThumbTier) => VisionFn | null
  images?: { openAiKey(): Promise<string | null>; settings(): { model: string; quality: string; dailyCapUsd: number; backend?: ImageBackend }; spentToday(): Promise<number>; codex?: CodexImages }
  openCloud?: { key(): Promise<string | null>; creator(): { userId?: number; groupId?: number } }
  toPng?: (bytes: Buffer) => Promise<Buffer | null>
  chooseImages?: () => Promise<string[]>
  studio?: { snapshot(): Promise<{ png: Buffer; via: 'bridge' | 'window'; window: string }>; status(): Promise<{ connected: boolean; message: string }> }
  chargeImage?: (usd: number) => void
  fetch?: ArtFetch
}

export interface ThumbsWiring {
  service: ThumbService
  handlers: Record<string, (...args: any[]) => unknown>
}

export function createThumbsWiring(deps: ThumbsWireDeps): ThumbsWiring {
  const service = new ThumbService({
    userDir: join(deps.userDataDir, 'thumbs'),
    projectRoot: deps.root,
    gameName: deps.gameName,
    settings: deps.settings,
    openAiKey: deps.images?.openAiKey,
    imageSettings: deps.images?.settings,
    codexImages: deps.images?.codex,
    artSpentToday: deps.images?.spentToday,
    robloxKey: deps.openCloud?.key,
    creator: deps.openCloud?.creator,
    vision: deps.vision,
    toPng: deps.toPng,
    studioSnapshot: deps.studio ? () => deps.studio!.snapshot() : undefined,
    studioStatus: deps.studio ? () => deps.studio!.status() : undefined,
    principles: deps.principles,
    chargeImage: deps.chargeImage,
    memory: deps.memory,
    fetch: deps.fetch,
    emit: deps.emit,
    log: deps.log
  })
  const scope = (s: unknown): ThumbScope | undefined => (s === 'project' || s === 'user' ? s : undefined)
  const strs = (v: unknown) => (Array.isArray(v) ? v.map(String) : [])
  const handlers: Record<string, (...args: any[]) => unknown> = {
    thumbStatus: () => service.status(),
    thumbSetSettings: (patch: Partial<ThumbSettings> & { universeId?: number | null }) => service.setSettings(patch ?? {}),
    thumbRefs: () => service.refs(),
    thumbAddRefs: (input: { paths?: unknown; urls?: unknown; dataUrls?: unknown; game?: unknown }, s: unknown) =>
      service.addRefs({ paths: strs(input?.paths), urls: strs(input?.urls), dataUrls: strs(input?.dataUrls), game: typeof input?.game === 'string' ? input.game : undefined }, scope(s)),
    thumbChooseImages: async () => (deps.chooseImages ? deps.chooseImages() : []),
    thumbAnalyzeRef: (id: unknown) => service.analyzeRef(String(id ?? '')),
    thumbUpdateRef: (id: unknown, patch: { name?: string; game?: string; tags?: string[] }) => service.updateRef(String(id ?? ''), patch ?? {}),
    thumbDeleteRef: (id: unknown) => service.removeRef(String(id ?? '')),
    thumbProfiles: () => service.profiles(),
    thumbSaveProfile: (input: { id?: string; name: string; refIds: string[]; scope?: ThumbScope; notes?: string }) => service.saveProfile({ ...(input ?? { name: '', refIds: [] }), refIds: strs(input?.refIds), scope: scope(input?.scope) }),
    thumbDeleteProfile: (id: unknown) => service.removeProfile(String(id ?? '')),
    thumbBases: () => service.bases(),
    thumbAddBases: (paths: unknown, s: unknown) => service.addBases(strs(paths), scope(s)),
    thumbCaptureStudio: (name?: unknown) => service.captureStudio(typeof name === 'string' ? name : undefined),
    thumbDeleteBase: (id: unknown) => service.removeBase(String(id ?? '')),
    thumbEstimate: (input: ThumbGenerateInput) => service.estimate(input ?? { brief: '' }),
    thumbGenerate: (input: ThumbGenerateInput) => service.generate({ ...(input ?? { brief: '' }), source: 'page' }),
    thumbCritique: (id: unknown) => service.critique(String(id ?? '')),
    thumbRefine: (id: unknown, opts?: { note?: string; rounds?: number; threshold?: number }) => service.refine(String(id ?? ''), opts ?? {}),
    thumbList: () => service.list(),
    thumbRate: (id: unknown, r: unknown) => service.rate(String(id ?? ''), r === 'up' || r === 'down' ? r : null),
    thumbShip: (id: unknown, ship: unknown) => service.ship(String(id ?? ''), ship === true),
    thumbNotes: (id: unknown, notes: unknown) => service.notes(String(id ?? ''), String(notes ?? '')),
    thumbDelete: (id: unknown) => service.remove(String(id ?? '')),
    thumbAddCtr: (id: unknown, rec: { impressions: number; clicks: number; period?: string; note?: string }) => service.addCtr(String(id ?? ''), rec ?? { impressions: 0, clicks: 0 }),
    thumbRemoveCtr: (id: unknown, index: unknown) => service.removeCtr(String(id ?? ''), Number(index)),
    thumbUpload: (id: unknown) => service.upload(String(id ?? '')),
    thumbSetExperience: (id: unknown, opts: { universeId: number; languageCode?: string }) => service.setExperience(String(id ?? ''), opts ?? { universeId: 0 }),
    thumbTaste: () => service.tasteView(),
    thumbFile: (kind: unknown, id: unknown, which: unknown) => service.file(kind === 'ref' || kind === 'base' ? kind : 'thumb', String(id ?? ''), which === 's256' || which === 's160' ? which : 'image')
  }
  return { service, handlers }
}
