// Thumbnail Lab service: reference thumbnails -> style cards (vision, Labs tiers) and code stats,
// named style profiles, base images from the real game (project screenshots or a Studio capture
// through the Forge Bridge), generation of N 1920x1080 variations through the Art page's OpenAI
// client, key and budget, the critic (thumbnail principles + code checks at 256x144 / 160x90 + the
// no-copy guard), pick-best-of-N, the refine loop, ratings / "would ship" / manual CTR that teach
// taste, and the Open Cloud upload. No electron imports: decoding, dialogs, Studio and the models
// come in as functions (test/thumbs.test.ts drives it with fakes).

import { join } from 'node:path'
import { readFile, stat } from 'node:fs/promises'
import { editImages, generateImages, mimeOf, toDataUrl, type ArtFetch, type Sleep } from '../art/openaiImages.ts'
import { estimateImageUsd, formatUsd, REFERENCE_IMAGE_USD, round } from '../art/pricing.ts'
import { uploadImageAsset } from '../art/robloxAssets.ts'
import { dayOf } from '../art/store.ts'
import { decodePng, encodePng } from '../vfx/textures/png.ts'
import { resample, type Rgba } from '../../../shared/vfx/tex/image.ts'
import { parsePrincipleScores, scorePrinciples } from '../../../shared/principles/score.ts'
import { selectPrinciples } from '../../../shared/principles/select.ts'
import type { PrincipleCheck, PrincipleHooks } from '../../../shared/principles/types.ts'
import { codeOverall, thumbChecks } from '../../../shared/thumbs/checks.ts'
import { ctrLabels, normalizeCtr } from '../../../shared/thumbs/ctr.ts'
import { copyGuardFlags, criticPrompt, CRITIC_SYSTEM, forbiddenTerms, generationPrompt, parseCritique, refinePrompt, scrubBrief, textCheck } from '../../../shared/thumbs/prompt.ts'
import { analyzeAsk, buildSections, EXPAND_SYSTEM, expandPrompt, isUiKind, lintSections, mergeExpansion, normalizeSections, uiPrompt } from '../../../shared/thumbs/builder.ts'
import { batchOf, genSizeFor, thumbId } from '../../../shared/thumbs/size.ts'
import { fitWithin, imageStats, smallSizeReport, toThumbnail } from '../../../shared/thumbs/stats.ts'
import { aggregateProfile, cardFromStats, parseStyleCard, profileSummary, STYLE_PROMPT, STYLE_SYSTEM } from '../../../shared/thumbs/style.ts'
import { learnTaste, pickBest, tasteLines, tasteSamples, tasteView, type TasteProfile } from '../../../shared/thumbs/taste.ts'
import {
  DEFAULT_THUMB_SETTINGS,
  THUMB_MODELS,
  type ThumbStyleProfile,
  type TasteView,
  type Thumb,
  type ThumbBase,
  type ThumbCritique,
  type ThumbEstimate,
  type ThumbGenerateInput,
  type ThumbRef,
  type ThumbScope,
  type ThumbSettings,
  type ThumbStatus,
  type BuildPromptInput,
  type BuiltPrompt,
  type PromptSection,
  type UiAsset
} from '../../../shared/thumbs/types.ts'
import { UiArtService } from './uiart.ts'
import { uploadExperienceThumbnail } from './experience.ts'
import { codexBackend, type CodexImages } from '../art/imageBackend.ts'
import { CODEX_IMAGE_MODEL, type ImageBackend } from '../../../shared/artTypes.ts'
import { newBatchId, newId, PROJECT_THUMB_DIR, ThumbError, ThumbStore, type ThumbKind } from './store.ts'

export interface ImagePayload {
  mime: string
  base64: string
}
export type VisionFn = (system: string, prompt: string, images: ImagePayload[]) => Promise<string>
export type ThumbTier = 'cheap' | 'default' | 'critic'

export interface ThumbMemory {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<unknown>
}

export interface ThumbServiceDeps {
  // userData/thumbs
  userDir: string
  projectRoot: () => string | null
  // The project's game name (allowed in prompts; it is the game being advertised).
  gameName?: () => string | undefined
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  // The Art page's OpenAI key, daily cap and today's Art spend.
  openAiKey?: () => Promise<string | null>
  imageSettings?: () => { model: string; quality: string; dailyCapUsd: number; backend?: ImageBackend }
  // The ChatGPT plan through Codex (Art page image backend 'codex').
  codexImages?: CodexImages
  artSpentToday?: () => Promise<number>
  // The Art page's Open Cloud key and creator.
  robloxKey?: () => Promise<string | null>
  creator?: () => { userId?: number; groupId?: number }
  // Vision models per Labs tier (null when the provider has no vision).
  vision?: (tier: ThumbTier) => VisionFn | null
  // Any image file (PNG / JPEG / ...) -> PNG bytes (electron nativeImage). Without it only PNG works.
  toPng?: (bytes: Buffer) => Promise<Buffer | null>
  // The user's current Studio view (StudioService.snapshot).
  studioSnapshot?: () => Promise<{ png: Buffer; via: 'bridge' | 'window'; window: string }>
  studioStatus?: () => Promise<{ connected: boolean; message: string }>
  principles?: PrincipleHooks
  // Image spend into the Labs cost-per-kept table (gating).
  chargeImage?: (usd: number) => void
  memory?: ThumbMemory
  fetch?: ArtFetch
  sleep?: Sleep
  now?: () => number
  emit?: (event: 'thumbs:changed' | 'thumbs:progress', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
}

const SETTINGS_KEY = 'thumbs.settings'
const UNIVERSE_KEY = 'thumbs.universe'
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_BASES = 6
const DOWNLOAD_TIMEOUT_MS = 30_000
const QUALITIES = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
export const AGENT_MAX_VARIATIONS = 4

export class ThumbService {
  readonly user: ThumbStore
  private deps: ThumbServiceDeps
  private projectStore: { root: string; store: ThumbStore } | null = null
  private now: () => number
  // UI art (buttons, panels, icons, icon sets, HUD mockups) on the same backend, budget and stores.
  readonly ui: UiArtService

  constructor(deps: ThumbServiceDeps) {
    this.deps = deps
    this.user = new ThumbStore('user', deps.userDir)
    this.now = deps.now ?? Date.now
    this.ui = new UiArtService({
      stores: () => this.stores(),
      storeFor: (scope) => this.storeFor(scope, 'ui'),
      decode: (bytes) => this.decode(bytes),
      settings: () => this.settings(),
      codex: () => this.codex(),
      openAiKey: async () => (await this.deps.openAiKey?.().catch(() => null)) ?? null,
      cap: () => this.cap(),
      spentToday: () => this.spentToday(),
      vision: (tier) => this.deps.vision?.(tier) ?? null,
      gameName: () => this.deps.gameName?.(),
      projectRoot: () => this.deps.projectRoot(),
      robloxKey: async () => (await this.deps.robloxKey?.().catch(() => null)) ?? null,
      creator: () => this.deps.creator?.() ?? {},
      chargeImage: deps.chargeImage,
      memory: deps.memory,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: () => this.now(),
      changed: () => this.changed(),
      progress: (b, stage, detail, extra) => this.progress(b, stage, detail, extra),
      log: (text, stream) => this.deps.log?.(text, stream)
    })
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): ThumbStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new ThumbStore('project', join(root, ...PROJECT_THUMB_DIR.split('/'))) }
    return this.projectStore.store
  }

  // References and profiles default to the user library (style follows the person); bases and
  // thumbnails to the project (they are the game's).
  private storeFor(scope: ThumbScope | undefined, kind: ThumbKind): ThumbStore {
    const fallback: ThumbScope = kind === 'refs' || kind === 'profiles' ? 'user' : 'project'
    const s = scope ?? fallback
    if (s === 'user') return this.user
    return this.project() ?? this.user
  }

  private stores(): ThumbStore[] {
    const p = this.project()
    return p ? [p, this.user] : [this.user]
  }

  private async all<T>(kind: ThumbKind): Promise<T[]> {
    const out: T[] = []
    for (const s of this.stores()) out.push(...(await s.list<T>(kind)))
    return out
  }

  private async find<T>(kind: ThumbKind, id: string): Promise<{ item: T; store: ThumbStore } | null> {
    for (const s of this.stores()) {
      const item = await s.read<T>(kind, id).catch(() => null)
      if (item) return { item, store: s }
    }
    return null
  }

  private async must<T>(kind: ThumbKind, id: string): Promise<{ item: T; store: ThumbStore }> {
    const hit = await this.find<T>(kind, String(id ?? ''))
    if (!hit) throw new ThumbError(`no ${kind.replace(/s$/, '')} "${id}"`)
    return hit
  }

  private changed(): void {
    this.deps.emit?.('thumbs:changed', { at: this.now() })
  }

  private progress(batchId: string, stage: string, detail?: string, extra: { done?: boolean; error?: boolean } = {}): void {
    this.deps.emit?.('thumbs:progress', { batchId, stage, ...(detail ? { detail } : {}), ...extra })
  }

  // ------------------------------------------------------------ settings / status

  settings(): ThumbSettings {
    const raw = this.deps.settings.get<Partial<ThumbSettings>>(SETTINGS_KEY, {})
    const s = { ...DEFAULT_THUMB_SETTINGS, ...raw }
    return {
      model: (THUMB_MODELS as readonly string[]).includes(s.model) ? s.model : DEFAULT_THUMB_SETTINGS.model,
      quality: QUALITIES.includes(s.quality) && !(['xhigh', 'max'].includes(s.quality) && !s.model.startsWith('gpt-image-2.5')) ? s.quality : DEFAULT_THUMB_SETTINGS.quality,
      n: Math.max(1, Math.min(10, Math.floor(Number(s.n) || DEFAULT_THUMB_SETTINGS.n))),
      sendRefs: s.sendRefs !== false,
      languageCode: /^[a-z]{2,3}(?:[-_][A-Za-z]{2,4})?$/.test(String(s.languageCode)) ? String(s.languageCode) : 'en'
    }
  }

  private universeKey(): string | null {
    const root = this.deps.projectRoot()
    return root ? `${UNIVERSE_KEY}.${root.replace(/[^\w]+/g, '_').slice(-80)}` : null
  }

  universeId(): number | undefined {
    const k = this.universeKey()
    const v = k ? this.deps.settings.get<number | null>(k, null) : null
    return typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : undefined
  }

  async setSettings(patch: Partial<ThumbSettings> & { universeId?: number | null }): Promise<ThumbStatus> {
    const { universeId, ...rest } = patch ?? {}
    this.deps.settings.set(SETTINGS_KEY, { ...this.settings(), ...rest })
    if (universeId !== undefined) {
      const k = this.universeKey()
      if (k) this.deps.settings.set(k, universeId && Number.isSafeInteger(Number(universeId)) && Number(universeId) > 0 ? Number(universeId) : null)
    }
    return this.status()
  }

  async spentToday(): Promise<number> {
    const today = dayOf(this.now())
    const mine = [...(await this.all<Thumb>('thumbs')), ...(await this.all<UiAsset>('ui'))].filter((t) => dayOf(t.createdAt) === today).reduce((s, t) => s + (t.costUsd || 0), 0)
    const art = (await this.deps.artSpentToday?.().catch(() => 0)) ?? 0
    return round(mine + art)
  }

  // The Codex backend when the Art page picked it (no key, no cost, no cap).
  private codex(): CodexImages | null {
    return codexBackend(this.deps.imageSettings?.().backend, this.deps.codexImages)
  }

  private cap(): number {
    return this.deps.imageSettings?.().dailyCapUsd ?? 5
  }

  async status(): Promise<ThumbStatus> {
    const s = this.settings()
    const creator = this.deps.creator?.() ?? {}
    const genSize = genSizeFor(s.model)
    const codex = this.codex()
    return {
      ...(codex ? { codex: await codex.status().catch((e) => ({ ready: false, detail: (e as Error).message })) } : {}),
      project: !!this.deps.projectRoot(),
      openaiKey: !!(await this.deps.openAiKey?.().catch(() => null)),
      robloxKey: !!(await this.deps.robloxKey?.().catch(() => null)),
      creator: !!(creator.userId || creator.groupId),
      vision: !!this.deps.vision?.('critic'),
      studio: (await this.deps.studioStatus?.().catch(() => null)) ?? { connected: false, message: 'Studio capture needs the desktop app.' },
      model: s.model,
      quality: s.quality,
      genSize,
      perImageUsd: estimateImageUsd(s.model, s.quality, genSize),
      spentTodayUsd: await this.spentToday(),
      dailyCapUsd: this.cap(),
      counts: { refs: (await this.all('refs')).length, profiles: (await this.all('profiles')).length, bases: (await this.all('bases')).length, thumbs: (await this.all('thumbs')).length, ui: (await this.all('ui')).length },
      settings: s,
      models: [...THUMB_MODELS],
      ...(this.universeId() ? { universeId: this.universeId() } : {})
    }
  }

  // ------------------------------------------------------------ images in

  private async decode(bytes: Buffer): Promise<Rgba> {
    const mime = mimeOf(bytes)
    if (!mime) throw new ThumbError('not an image (PNG, JPEG, WEBP, GIF or BMP)')
    let png: Buffer | null = mime === 'image/png' ? bytes : null
    if (!png && this.deps.toPng) png = await this.deps.toPng(bytes).catch(() => null)
    if (!png) throw new ThumbError(mime === 'image/webp' || mime === 'image/gif' ? `${mime.slice(6).toUpperCase()} could not be read here; save it as PNG or JPEG` : `could not decode ${mime}`)
    try {
      return decodePng(png)
    } catch (e) {
      // 16-bit / interlaced PNGs: let the platform decoder re-encode them.
      const again = mime === 'image/png' && this.deps.toPng ? await this.deps.toPng(bytes).catch(() => null) : null
      if (again && again !== bytes) return decodePng(again)
      throw new ThumbError((e as Error).message)
    }
  }

  private async download(url: string): Promise<Buffer> {
    let u: URL
    try {
      u = new URL(url)
    } catch {
      throw new ThumbError('not a URL')
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new ThumbError('only http(s) links')
    const fetch = this.deps.fetch ?? (globalThis.fetch as unknown as ArtFetch)
    // A link that never answers must not leave "Adding references" spinning for minutes.
    const res = await fetch(u.toString(), { method: 'GET', headers: { accept: 'image/png,image/jpeg;q=0.9,image/*;q=0.5' }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) }).catch((e: Error) => {
      throw new ThumbError(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? `the link did not answer within ${DOWNLOAD_TIMEOUT_MS / 1000} s` : `could not fetch the link: ${e?.message}`)
    })
    if (!res.ok) throw new ThumbError(`the link answered ${res.status}`)
    const len = Number(res.headers.get('content-length') ?? 0)
    if (len > MAX_IMAGE_BYTES) throw new ThumbError('image over 20 MB')
    const r = res as unknown as { arrayBuffer?: () => Promise<ArrayBuffer>; text(): Promise<string> }
    const bytes = r.arrayBuffer ? Buffer.from(await r.arrayBuffer()) : Buffer.from(await r.text(), 'binary')
    if (bytes.length > MAX_IMAGE_BYTES) throw new ThumbError('image over 20 MB')
    if (!mimeOf(bytes)) throw new ThumbError(`the link is not an image (${res.headers.get('content-type') ?? 'unknown type'})`)
    return bytes
  }

  private fromDataUrl(url: string): Buffer {
    const m = /^data:image\/[a-z+.-]+;base64,(.+)$/i.exec(url)
    if (!m) throw new ThumbError('not an image data URL')
    const b = Buffer.from(m[1], 'base64')
    if (b.length > MAX_IMAGE_BYTES) throw new ThumbError('image over 20 MB')
    return b
  }

  private async readLocal(path: string): Promise<Buffer> {
    const s = await stat(path).catch(() => null)
    if (!s?.isFile()) throw new ThumbError('file not found')
    if (s.size > MAX_IMAGE_BYTES) throw new ThumbError('image over 20 MB')
    return readFile(path)
  }

  // ------------------------------------------------------------ references

  async refs(): Promise<ThumbRef[]> {
    return (await this.all<ThumbRef>('refs')).sort((a, b) => b.createdAt - a.createdAt)
  }

  async addRefs(input: { paths?: string[]; urls?: string[]; dataUrls?: string[]; game?: string }, scope?: ThumbScope): Promise<{ added: ThumbRef[]; skipped: { item: string; reason: string }[] }> {
    const store = this.storeFor(scope, 'refs')
    const added: ThumbRef[] = []
    const skipped: { item: string; reason: string }[] = []
    const jobs: { item: string; name: string; source: ThumbRef['source']; url?: string; load: () => Promise<Buffer> }[] = [
      ...(input.paths ?? []).slice(0, 24).map((p) => ({ item: p, name: p.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, ''), source: 'file' as const, load: () => this.readLocal(p) })),
      ...(input.urls ?? []).slice(0, 24).map((u) => ({ item: u, name: (() => { try { return decodeURIComponent(new URL(u).pathname.split('/').filter(Boolean).pop() ?? 'link').replace(/\.[a-z0-9]+$/i, '') } catch { return 'link' } })(), source: 'url' as const, url: u, load: () => this.download(u) })),
      ...(input.dataUrls ?? []).slice(0, 24).map((d, i) => ({ item: `pasted image ${i + 1}`, name: 'pasted', source: 'paste' as const, load: async () => this.fromDataUrl(d) }))
    ]
    const game = String(input.game ?? '').trim().slice(0, 80)
    for (const j of jobs) {
      try {
        const img = fitWithin(await this.decode(await j.load()), 1920, 1080)
        const now = this.now()
        const name = (j.name || 'reference').slice(0, 60)
        const ref: ThumbRef = {
          id: newId('ref', name),
          scope: store.scope,
          name,
          ...(game ? { game } : {}),
          source: j.source,
          ...(j.url ? { url: j.url } : {}),
          file: 'image.png',
          width: img.width,
          height: img.height,
          stats: imageStats(img),
          tags: [],
          createdAt: now,
          updatedAt: now
        }
        await store.writeFile('refs', ref.id, 'image.png', encodePng(img))
        added.push(await store.save('refs', ref))
      } catch (e) {
        skipped.push({ item: j.item.slice(0, 120), reason: (e as Error).message })
      }
    }
    if (added.length) this.changed()
    // Style cards in the background (one vision call each).
    for (const r of added) void this.analyzeRef(r.id).catch((e) => this.deps.log?.(`thumbs: analyse ${r.id}: ${(e as Error).message}`, 'stderr'))
    return { added, skipped }
  }

  private async forbidden(): Promise<string[]> {
    return forbiddenTerms(await this.refs())
  }

  // Vision style card on the default Labs tier; the stats-only card when there is no vision model.
  async analyzeRef(id: string): Promise<ThumbRef> {
    const { item, store } = await this.must<ThumbRef>('refs', id)
    const vision = this.deps.vision?.('default') ?? null
    let next: ThumbRef
    if (!vision) next = { ...item, card: cardFromStats(item.stats), analyzedAt: this.now(), updatedAt: this.now() }
    else {
      const bytes = await store.readFile('refs', id, item.file)
      const small = encodePng(fitWithin(decodePng(bytes), 1024, 576))
      try {
        const raw = await vision(STYLE_SYSTEM, STYLE_PROMPT, [{ mime: 'image/png', base64: small.toString('base64') }])
        const card = parseStyleCard(raw, [item.game ?? '', item.name].filter(Boolean))
        if (!card) throw new Error('the model did not answer with a style card')
        // Code stats win for the palette when the model gave none.
        if (!card.palette.length) card.palette = item.stats.palette.map((p) => p.hex)
        next = { ...item, card, analyzedAt: this.now(), updatedAt: this.now() }
        delete next.analyzeError
      } catch (e) {
        next = { ...item, card: item.card ?? cardFromStats(item.stats), analyzeError: (e as Error).message.slice(0, 200), updatedAt: this.now() }
      }
    }
    const saved = await store.save('refs', next)
    await this.refreshProfiles(id)
    this.changed()
    return saved
  }

  async updateRef(id: string, patch: { name?: string; game?: string; tags?: string[] }): Promise<ThumbRef> {
    const { item, store } = await this.must<ThumbRef>('refs', id)
    const next: ThumbRef = { ...item, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) next.name = patch.name.trim().slice(0, 60)
    if (typeof patch.game === 'string') next.game = patch.game.trim().slice(0, 80) || undefined
    if (Array.isArray(patch.tags)) next.tags = [...new Set(patch.tags.map((t) => String(t).toLowerCase().trim()).filter(Boolean))].slice(0, 12)
    const saved = await store.save('refs', next)
    this.changed()
    return saved
  }

  async removeRef(id: string): Promise<boolean> {
    const hit = await this.find<ThumbRef>('refs', id)
    if (!hit) return false
    const ok = await hit.store.remove('refs', id)
    this.changed()
    return ok
  }

  // ------------------------------------------------------------ profiles

  async profiles(): Promise<ThumbStyleProfile[]> {
    return (await this.all<ThumbStyleProfile>('profiles')).sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async saveProfile(input: { id?: string; name: string; refIds: string[]; scope?: ThumbScope; notes?: string }): Promise<ThumbStyleProfile> {
    const name = String(input.name ?? '').trim().slice(0, 60)
    if (!name) throw new ThumbError('Name the style profile')
    const all = await this.refs()
    const refs = (input.refIds ?? []).map((id) => all.find((r) => r.id === id)).filter((r): r is ThumbRef => !!r)
    if (!refs.length) throw new ThumbError('Pick at least one reference for the profile')
    const prev = input.id ? await this.find<ThumbStyleProfile>('profiles', input.id) : null
    const store = prev?.store ?? this.storeFor(input.scope, 'profiles')
    const { card, stats } = aggregateProfile(refs)
    const now = this.now()
    const profile: ThumbStyleProfile = {
      id: prev?.item.id ?? newId('style', name),
      scope: store.scope,
      name,
      refIds: refs.map((r) => r.id),
      card,
      stats,
      summary: profileSummary(card, stats),
      ...(input.notes?.trim() ? { notes: input.notes.trim().slice(0, 400) } : prev?.item.notes ? { notes: prev.item.notes } : {}),
      createdAt: prev?.item.createdAt ?? now,
      updatedAt: now
    }
    const saved = await store.save('profiles', profile)
    this.changed()
    return saved
  }

  // A reference's card changed: re-aggregate the profiles that use it.
  private async refreshProfiles(refId: string): Promise<void> {
    for (const p of await this.profiles()) {
      if (!p.refIds.includes(refId)) continue
      await this.saveProfile({ id: p.id, name: p.name, refIds: p.refIds }).catch(() => undefined)
    }
  }

  async removeProfile(id: string): Promise<boolean> {
    const hit = await this.find<ThumbStyleProfile>('profiles', id)
    if (!hit) return false
    const ok = await hit.store.remove('profiles', id)
    this.changed()
    return ok
  }

  // ------------------------------------------------------------ bases

  async bases(): Promise<ThumbBase[]> {
    return (await this.all<ThumbBase>('bases')).sort((a, b) => b.createdAt - a.createdAt)
  }

  private async saveBase(img: Rgba, name: string, source: ThumbBase['source'], scope?: ThumbScope): Promise<ThumbBase> {
    const store = this.storeFor(scope, 'bases')
    const fitted = fitWithin(img, 1920, 1920)
    const base: ThumbBase = { id: newId('base', name), scope: store.scope, name: name.slice(0, 60) || 'screenshot', source, file: 'image.png', width: fitted.width, height: fitted.height, createdAt: this.now() }
    await store.writeFile('bases', base.id, 'image.png', encodePng(fitted))
    return store.save('bases', base)
  }

  async addBases(paths: string[], scope?: ThumbScope): Promise<ThumbBase[]> {
    const out: ThumbBase[] = []
    for (const p of (paths ?? []).slice(0, 12)) {
      try {
        out.push(await this.saveBase(await this.decode(await this.readLocal(p)), p.split(/[\\/]/).pop()!.replace(/\.[a-z0-9]+$/i, ''), 'file', scope))
      } catch (e) {
        this.deps.log?.(`thumbs: base ${p}: ${(e as Error).message}`, 'stderr')
        if (paths.length === 1) throw e
      }
    }
    if (out.length) this.changed()
    return out
  }

  async captureStudio(name?: string): Promise<ThumbBase> {
    if (!this.deps.studioSnapshot) throw new ThumbError('Capturing Studio needs the desktop app.')
    const shot = await this.deps.studioSnapshot()
    const base = await this.saveBase(decodePng(shot.png), name?.trim() || `Studio ${new Date(this.now()).toISOString().slice(11, 19).replace(/:/g, '')}`, 'studio')
    this.changed()
    this.deps.log?.(`thumbs: captured Studio (${shot.via}, ${shot.window})`)
    return base
  }

  async removeBase(id: string): Promise<boolean> {
    const hit = await this.find<ThumbBase>('bases', id)
    if (!hit) return false
    const ok = await hit.store.remove('bases', id)
    this.changed()
    return ok
  }

  // ------------------------------------------------------------ generation

  private request(input: ThumbGenerateInput) {
    const s = this.settings()
    const quality = input.quality && QUALITIES.includes(input.quality) ? input.quality : s.quality
    const max = input.source === 'agent' ? AGENT_MAX_VARIATIONS : 10
    const n = Math.max(1, Math.min(max, Math.floor(input.n ?? s.n)))
    return { model: s.model, quality, n, genSize: genSizeFor(s.model), sendRefs: s.sendRefs }
  }

  async estimate(input: ThumbGenerateInput): Promise<ThumbEstimate> {
    const q = this.request(input)
    if (this.codex()) return { n: Math.min(q.n, 4), model: CODEX_IMAGE_MODEL, quality: 'auto', genSize: 'auto', perImageUsd: 0, totalUsd: 0, spentTodayUsd: await this.spentToday(), dailyCapUsd: 0, overCap: false }
    const per = estimateImageUsd(q.model, q.quality, q.genSize)
    const profile = input.profileId ? (await this.find<ThumbStyleProfile>('profiles', input.profileId))?.item : undefined
    const images = Math.min(16, (input.baseIds ?? []).length + (q.sendRefs && profile ? Math.min(2, profile.refIds.length) : 0))
    const totalUsd = round(per * q.n + images * REFERENCE_IMAGE_USD)
    const spent = await this.spentToday()
    const cap = this.cap()
    return { n: q.n, model: q.model, quality: q.quality, genSize: q.genSize, perImageUsd: per, totalUsd, spentTodayUsd: spent, dailyCapUsd: cap, overCap: cap > 0 && spent + totalUsd > cap }
  }

  private async taste(): Promise<TasteProfile> {
    return learnTaste(tasteSamples(await this.all<Thumb>('thumbs')))
  }

  async tasteView(): Promise<TasteView> {
    return tasteView(await this.taste())
  }

  private async imageData(store: ThumbStore, kind: ThumbKind, id: string, file: string, maxW: number, maxH: number): Promise<string> {
    const bytes = await store.readFile(kind, id, file)
    const img = decodePng(bytes)
    return toDataUrl(img.width > maxW || img.height > maxH ? encodePng(fitWithin(img, maxW, maxH)) : bytes)
  }

  // A generated image -> a saved variation (1920x1080, small renders, stats, code checks).
  private async saveVariation(store: ThumbStore, bytes: Buffer, base: Omit<Thumb, 'id' | 'file' | 'small' | 'stats' | 'report' | 'scope' | 'ctr' | 'createdAt' | 'updatedAt'> & { k: number }): Promise<Thumb> {
    const img = toThumbnail(await this.decode(bytes))
    const stats = imageStats(img)
    const small = smallSizeReport(img, stats)
    const now = this.now()
    const { k, ...rest } = base
    const t: Thumb = { ...rest, id: thumbId(base.batchId, k), scope: store.scope, file: 'image.png', small: { s256: 's256.png', s160: 's160.png' }, stats, report: small.report, ctr: [], createdAt: now, updatedAt: now }
    await store.writeFile('thumbs', t.id, 'image.png', encodePng(img))
    await store.writeFile('thumbs', t.id, 's256.png', encodePng(small.s256))
    await store.writeFile('thumbs', t.id, 's160.png', encodePng(small.s160))
    // Code-only critique until the critic runs (pick-best still has something to rank).
    const code = thumbChecks(stats, small.report)
    t.critique = { at: now, overall: codeOverall(code), summary: 'Measured in code (no vision critique yet).', principles: code.map((c) => ({ ...c, source: 'code' as const })), focus: [], changes: code.filter((c) => c.fix).map((c) => c.fix!), copyFlags: [], by: 'code' }
    return store.save('thumbs', t)
  }

  async generate(input: ThumbGenerateInput): Promise<{ id: string; thumbs: Thumb[]; bestId?: string }> {
    const brief = String(input.brief ?? '').trim().slice(0, 2000)
    if (!brief) throw new ThumbError('Describe the thumbnail, e.g. "player escaping a giant shark, shocked face".')
    const codex = this.codex()
    const key = codex ? null : await this.deps.openAiKey?.()
    if (!codex && !key) throw new ThumbError('No OpenAI API key. Add one in Settings > Providers > OpenAI.')
    const q = this.request(input)
    const est = await this.estimate(input)
    if (est.overCap) throw new ThumbError(`This would pass today's image budget (${formatUsd(est.spentTodayUsd)} spent + ${formatUsd(est.totalUsd)} > ${formatUsd(est.dailyCapUsd)}). Raise it on the Art page.`)
    const profile = input.profileId ? (await this.find<ThumbStyleProfile>('profiles', input.profileId))?.item : undefined
    const baseHits = (await Promise.all((input.baseIds ?? []).slice(0, MAX_BASES).map((id) => this.find<ThumbBase>('bases', id)))).filter((b): b is { item: ThumbBase; store: ThumbStore } => !!b)
    const refHits = q.sendRefs && profile ? (await Promise.all(profile.refIds.slice(0, 2).map((id) => this.find<ThumbRef>('refs', id)))).filter((r): r is { item: ThumbRef; store: ThumbStore } => !!r) : []
    const forbidden = await this.forbidden()
    const taste = await this.taste()
    const gameName = this.deps.gameName?.()
    // The user's reviewed sections, else the rule-based builder (brief + profile + taste).
    const sections = normalizeSections(input.sections) ?? buildSections({ ask: scrubBrief(brief, forbidden, gameName ? [gameName] : []).text, mode: 'thumbnail', gameName, profile, taste: tasteLines(taste), bases: baseHits.length })
    const { prompt, removed } = generationPrompt({ brief, style: profile?.summary, bases: baseHits.length, styleRefs: refHits.length, gameName, restatement: input.restatement, taste: tasteLines(taste), sections }, forbidden)
    if (removed.length) this.deps.log?.(`thumbs: kept reference names out of the prompt: ${removed.join(', ')}`)
    const batchId = newBatchId(this.now())
    const store = this.storeFor(input.scope, 'thumbs')
    const images = [
      ...(await Promise.all(baseHits.map((b) => this.imageData(b.store, 'bases', b.item.id, b.item.file, 1536, 1536)))),
      ...(await Promise.all(refHits.map((r) => this.imageData(r.store, 'refs', r.item.id, r.item.file, 1024, 1024))))
    ]
    this.progress(batchId, 'generating', `${q.n} × ${q.genSize} ${q.quality}`)
    const req = { model: q.model, prompt, n: q.n, size: q.genSize, quality: q.quality, background: 'auto' as const, outputFormat: 'png' as const }
    const client = { apiKey: key ?? '', fetch: this.deps.fetch, sleep: this.deps.sleep }
    let res
    try {
      if (codex) {
        res = await codex.generate({ prompt, n: q.n, size: q.genSize, references: images })
        if (res.notes.length) this.deps.log?.(`thumbs: ${res.notes.join(' ')}`)
      } else res = images.length ? await editImages({ ...req, images }, client) : await generateImages(req, client)
    } catch (e) {
      this.progress(batchId, 'failed', (e as Error).message, { done: true, error: true })
      throw e
    }
    if (!codex) this.deps.chargeImage?.(est.totalUsd)
    const per = round(est.totalUsd / res.images.length)
    const thumbs: Thumb[] = []
    const failed: string[] = []
    for (const [i, bytes] of res.images.entries()) {
      // One unreadable image must not throw away the rest of a paid batch.
      try {
        thumbs.push(
          await this.saveVariation(store, bytes, {
            k: i + 1,
            batchId,
            name: `${brief.slice(0, 40)} ${i + 1}`,
            brief,
            ...(input.restatement ? { restatement: input.restatement } : {}),
            ...(profile ? { profileId: profile.id } : {}),
            baseIds: baseHits.map((b) => b.item.id),
            round: 0,
            prompt,
            sections,
            model: codex ? CODEX_IMAGE_MODEL : q.model,
            genSize: codex ? 'auto' : q.genSize,
            quality: codex ? 'auto' : q.quality,
            costUsd: per
          })
        )
      } catch (e) {
        failed.push(`#${i + 1}: ${(e as Error).message}`)
        this.deps.log?.(`thumbs: variation ${i + 1} of ${batchId}: ${(e as Error).message}`, 'stderr')
      }
    }
    if (!thumbs.length) {
      const msg = `${codex ? 'Codex' : 'OpenAI'} answered, but no image could be read (${failed.join('; ').slice(0, 300)})`
      this.progress(batchId, 'failed', msg, { done: true, error: true })
      throw new ThumbError(msg)
    }
    this.changed()
    let out = thumbs
    if (input.critique !== false) {
      this.progress(batchId, 'critique', `${thumbs.length} variation${thumbs.length === 1 ? '' : 's'}`)
      out = []
      for (const t of thumbs) out.push(await this.critique(t.id).then((r) => r.thumb).catch(() => t))
    }
    const bestId = pickBest(out, taste)
    this.progress(batchId, 'done', bestId ? `best: #${bestId.split('-').pop()}` : undefined, { done: true })
    return { id: batchId, thumbs: out, ...(bestId ? { bestId } : {}) }
  }

  // ------------------------------------------------------------ critique / refine

  async critique(id: string): Promise<{ id: string; thumb: Thumb }> {
    const { item, store } = await this.must<Thumb>('thumbs', id)
    const code = thumbChecks(item.stats, item.report)
    const vision = this.deps.vision?.('critic') ?? null
    const weights = this.deps.principles ? await this.deps.principles.weights().catch(() => ({})) : {}
    const ids = selectPrinciples('thumbs', item.brief, { weights, max: 8 }).map((p) => p.id)
    let critique: ThumbCritique
    if (!vision) {
      const r = scorePrinciples(codeOverall(code), [], code, weights)
      critique = { at: this.now(), overall: r.overall, summary: 'Measured in code (no vision model for the critic tier).', principles: r.principles, focus: r.focus, changes: code.filter((c) => c.fix).map((c) => c.fix!), copyFlags: [], by: 'code' }
    } else {
      const profile = item.profileId ? (await this.find<ThumbStyleProfile>('profiles', item.profileId))?.item : undefined
      const bases = (await Promise.all(item.baseIds.slice(0, 3).map((b) => this.find<ThumbBase>('bases', b)))).filter((b): b is { item: ThumbBase; store: ThumbStore } => !!b)
      const imgs: ImagePayload[] = [{ mime: 'image/png', base64: encodePng(resample(decodePng(await store.readFile('thumbs', id, item.file)), 960, 540)).toString('base64') }]
      for (const b of bases) imgs.push({ mime: 'image/png', base64: (await this.imageData(b.store, 'bases', b.item.id, b.item.file, 640, 640)).split(',')[1] })
      const prompt = criticPrompt({ brief: item.brief, restatement: item.restatement, style: profile?.summary, bases: bases.length, ids, measured: code, weights, focus: item.critique?.focus })
      const raw = await vision(CRITIC_SYSTEM, prompt, imgs)
      const parsed = parseCritique(raw)
      if (!parsed) throw new ThumbError('The critic did not answer with JSON')
      const critic = parsePrincipleScores(raw, ids)
      const text = textCheck(parsed.textWords)
      const flags = copyGuardFlags(parsed, await this.forbidden(), this.deps.gameName?.() ? [this.deps.gameName()!] : [])
      const measured: PrincipleCheck[] = [...code, ...(text ? [text] : [])]
      const r = scorePrinciples(parsed.overall, critic, measured, weights)
      // The no-copy guard: anything flagged caps honesty, so pick-best never prefers it.
      const principles = flags.length ? r.principles.map((p) => (p.id === 'th-honest' ? { ...p, score: Math.min(p.score, 3), note: `${p.note} · copy guard: ${flags[0]}` } : p)) : r.principles
      if (flags.length && !principles.some((p) => p.id === 'th-honest')) principles.push({ id: 'th-honest', score: 3, note: `copy guard: ${flags[0]}`, fix: 'Remove anything taken from other games; stay with the game screenshots', source: 'critic' })
      critique = { at: this.now(), overall: flags.length ? Math.min(r.overall, 5) : r.overall, summary: parsed.summary, principles, focus: r.focus, changes: [...(flags.length ? ['Remove anything that looks taken from another game (characters, logos, title text)'] : []), ...parsed.changes].slice(0, 5), copyFlags: flags, by: 'critic' }
    }
    const saved = await store.save('thumbs', { ...item, critique, updatedAt: this.now() })
    this.changed()
    return { id: item.batchId, thumb: saved }
  }

  async refine(id: string, opts: { note?: string; rounds?: number; threshold?: number } = {}): Promise<{ id: string; thumbs: Thumb[] }> {
    const codex = this.codex()
    const key = codex ? null : await this.deps.openAiKey?.()
    if (!codex && !key) throw new ThumbError('No OpenAI API key. Add one in Settings > Providers > OpenAI.')
    const rounds = Math.max(1, Math.min(4, Math.floor(opts.rounds ?? 1)))
    const threshold = Math.max(1, Math.min(10, Number(opts.threshold) || 8.5))
    let cur = (await this.must<Thumb>('thumbs', id)).item
    const s = this.settings()
    const genSize = genSizeFor(s.model)
    const made: Thumb[] = []
    const forbidden = await this.forbidden()
    const profile = cur.profileId ? (await this.find<ThumbStyleProfile>('profiles', cur.profileId))?.item : undefined
    for (let r = 0; r < rounds; r++) {
      const est = codex ? 0 : round(estimateImageUsd(s.model, s.quality, genSize) + (1 + cur.baseIds.length) * REFERENCE_IMAGE_USD)
      const spent = await this.spentToday()
      if (!codex && this.cap() > 0 && spent + est > this.cap()) throw new ThumbError(`This would pass today's image budget (${formatUsd(spent)} spent + ${formatUsd(est)} > ${formatUsd(this.cap())}).`)
      const hit = await this.must<Thumb>('thumbs', cur.id)
      const bases = (await Promise.all(cur.baseIds.slice(0, MAX_BASES).map((b) => this.find<ThumbBase>('bases', b)))).filter((b): b is { item: ThumbBase; store: ThumbStore } => !!b)
      const changes = cur.critique?.changes.length ? cur.critique.changes : cur.critique?.principles.filter((p) => p.fix && p.score < 8).map((p) => p.fix!) ?? []
      const { prompt } = refinePrompt({ brief: cur.brief, style: profile?.summary, bases: bases.length, gameName: this.deps.gameName?.(), restatement: cur.restatement, changes, ...(cur.sections?.length ? { sections: cur.sections } : {}), ...(r === 0 && opts.note ? { note: opts.note } : {}) }, forbidden)
      const images = [await this.imageData(hit.store, 'thumbs', cur.id, cur.file, 1920, 1088), ...(await Promise.all(bases.map((b) => this.imageData(b.store, 'bases', b.item.id, b.item.file, 1536, 1536))))]
      this.progress(cur.batchId, 'refining', `round ${r + 1}/${rounds}`)
      let res
      try {
        res = codex
          ? await codex.generate({ prompt, n: 1, size: genSize, references: images })
          : await editImages({ model: s.model, prompt, n: 1, size: genSize, quality: s.quality, background: 'auto', outputFormat: 'png', images }, { apiKey: key ?? '', fetch: this.deps.fetch, sleep: this.deps.sleep })
      } catch (e) {
        this.progress(cur.batchId, 'failed', (e as Error).message, { done: true, error: true })
        throw e
      }
      if (!codex) this.deps.chargeImage?.(est)
      const siblings = (await this.all<Thumb>('thumbs')).filter((t) => t.batchId === cur.batchId)
      const k = Math.max(0, ...siblings.map((t) => Number(t.id.split('-').pop()) || 0)) + 1
      const next = await this.saveVariation(hit.store, res.images[0], { k, batchId: cur.batchId, name: `${cur.brief.slice(0, 40)} ${k}`, brief: cur.brief, ...(cur.restatement ? { restatement: cur.restatement } : {}), ...(cur.profileId ? { profileId: cur.profileId } : {}), baseIds: cur.baseIds, parentId: cur.id, round: cur.round + 1, prompt, ...(cur.sections ? { sections: cur.sections } : {}), model: codex ? CODEX_IMAGE_MODEL : s.model, genSize: codex ? 'auto' : genSize, quality: codex ? 'auto' : s.quality, costUsd: est })
      const critiqued = await this.critique(next.id).then((x) => x.thumb).catch(() => next)
      made.push(critiqued)
      cur = critiqued
      this.changed()
      if ((critiqued.critique?.overall ?? 0) >= threshold) break
    }
    this.progress(cur.batchId, 'done', `${made.length} refined`, { done: true })
    return { id: cur.batchId, thumbs: made }
  }

  // ------------------------------------------------------------ library, ratings, CTR

  async list(): Promise<Thumb[]> {
    return (await this.all<Thumb>('thumbs')).sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id))
  }

  private async update(id: string, fn: (t: Thumb) => Thumb): Promise<Thumb> {
    const { item, store } = await this.must<Thumb>('thumbs', id)
    const saved = await store.save('thumbs', { ...fn(item), updatedAt: this.now() })
    this.changed()
    return saved
  }

  private scores(t: Thumb): Record<string, number> {
    return Object.fromEntries((t.critique?.principles ?? []).map((p) => [p.id, p.score]))
  }

  // The principle feedback line for a thumbnail: CTR (real players) beats ship, which beats thumbs.
  private async feedback(t: Thumb): Promise<void> {
    const p = this.deps.principles
    if (!p) return
    const ctr = ctrLabels(await this.all<Thumb>('thumbs')).find((c) => c.id === t.id)
    const rating: 'up' | 'down' | null = ctr ? (ctr.label > 0 ? 'up' : 'down') : t.ship ? 'up' : (t.rating ?? null)
    const scores = this.scores(t)
    if (!rating || !Object.keys(scores).length) {
      await p.forget?.('thumbs', t.id).catch(() => undefined)
      return
    }
    await p.record({ lab: 'thumbs', entryId: t.id, name: t.name, rating, scores, ...(t.notes ? { notes: t.notes } : {}) }).catch((e) => this.deps.log?.(`thumbs: principles: ${(e as Error).message}`, 'stderr'))
  }

  async rate(id: string, rating: 'up' | 'down' | null): Promise<Thumb> {
    const t = await this.update(id, (x) => {
      const n = { ...x }
      if (rating) n.rating = rating
      else delete n.rating
      return n
    })
    await this.feedback(t)
    await this.learn().catch((e) => this.deps.log?.(`thumbs: memory: ${(e as Error).message}`, 'stderr'))
    return t
  }

  async ship(id: string, ship: boolean): Promise<Thumb> {
    const t = await this.update(id, (x) => ({ ...x, ship: !!ship }))
    await this.feedback(t)
    await this.learn().catch(() => undefined)
    return t
  }

  async notes(id: string, notes: string): Promise<Thumb> {
    return this.update(id, (x) => ({ ...x, notes: String(notes ?? '').slice(0, 1000) }))
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find<Thumb>('thumbs', id)
    if (!hit) return false
    const ok = await hit.store.remove('thumbs', id)
    await this.deps.principles?.forget?.('thumbs', id).catch(() => undefined)
    this.changed()
    return ok
  }

  async addCtr(id: string, rec: { impressions: number; clicks: number; period?: string; note?: string }): Promise<Thumb> {
    const r = normalizeCtr(rec, this.now())
    const t = await this.update(id, (x) => ({ ...x, ctr: [...(x.ctr ?? []), r].slice(-50) }))
    // Every CTR-labelled thumbnail's feedback can change when one more has data (median moves).
    for (const x of await this.all<Thumb>('thumbs')) if (x.ctr?.length) await this.feedback(x)
    await this.learn().catch(() => undefined)
    return t
  }

  async removeCtr(id: string, index: number): Promise<Thumb> {
    const t = await this.update(id, (x) => ({ ...x, ctr: (x.ctr ?? []).filter((_, i) => i !== Math.floor(index)) }))
    await this.feedback(t)
    return t
  }

  // Memory: what the user's liked / shipped / high-CTR thumbnails have in common.
  private async learn(): Promise<void> {
    if (!this.deps.memory) return
    const all = await this.all<Thumb>('thumbs')
    const taste = learnTaste(tasteSamples(all))
    const liked = all.filter((t) => t.ship || t.rating === 'up')
    if (!taste.samples) return
    const profiles = new Map((await this.profiles()).map((p) => [p.id, p.name]))
    const body = [
      `Roblox thumbnail taste learned in the Thumbnail Lab from ${taste.samples} rating${taste.samples === 1 ? '' : 's'}${taste.ctrSamples ? ` (${taste.ctrSamples} from real CTR)` : ''}.`,
      ...tasteLines(taste, 6).map((l) => `- ${l}`),
      liked.length ? 'Liked or shipped thumbnails:' : '',
      ...liked.slice(0, 12).map((t) => `- "${t.brief.slice(0, 100)}"${t.profileId && profiles.get(t.profileId) ? ` in style "${profiles.get(t.profileId)}"` : ''}${t.critique ? ` (score ${t.critique.overall.toFixed(1)})` : ''}`)
    ]
      .filter(Boolean)
      .join('\n')
    await this.deps.memory.remember({ scope: 'user', kind: 'skill', name: 'thumbnail-taste', description: 'What the user likes in Roblox thumbnails (Thumbnail Lab ratings and CTR)', body: body.slice(0, 7900) }, 'user')
  }

  // ------------------------------------------------------------ Roblox

  async upload(id: string): Promise<Thumb> {
    const { item, store } = await this.must<Thumb>('thumbs', id)
    const key = await this.deps.robloxKey?.()
    if (!key) throw new ThumbError('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    const r = await uploadImageAsset({
      apiKey: key,
      bytes: await store.readFile('thumbs', id, item.file),
      fileName: `${id}.png`,
      displayName: `Thumbnail ${item.name}`.slice(0, 50),
      description: `Experience thumbnail from RBX Forge: ${item.brief}`.slice(0, 900),
      assetType: 'Image',
      contentType: 'image/png',
      creator: this.deps.creator?.() ?? {},
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      now: this.deps.now
    })
    return this.update(id, (x) => ({ ...x, roblox: { assetId: r.assetId, uri: r.uri, uploadedAt: this.now(), ...(r.moderation ? { moderation: r.moderation } : {}) } }))
  }

  async setExperience(id: string, opts: { universeId: number; languageCode?: string }): Promise<Thumb> {
    const { item, store } = await this.must<Thumb>('thumbs', id)
    const key = await this.deps.robloxKey?.()
    if (!key) throw new ThumbError('No Open Cloud API key. Add one on the Art page (it needs legacy-universe:manage for this).')
    const universeId = Number(opts.universeId)
    const languageCode = String(opts.languageCode ?? this.settings().languageCode)
    const r = await uploadExperienceThumbnail({ apiKey: key, universeId, languageCode, bytes: await store.readFile('thumbs', id, item.file), fileName: `${id}.png`, fetch: this.deps.fetch ?? (globalThis.fetch as unknown as ArtFetch) })
    await this.setSettings({ universeId })
    return this.update(id, (x) => ({ ...x, experience: { universeId, mediaAssetId: r.mediaAssetId, at: this.now(), languageCode } }))
  }

  // ------------------------------------------------------------ prompt builder

  // A short ask -> editable sections + the prompt as it would be sent. Rules always; with
  // `model: true` the cheap Labs tier expands the draft (the rules stand when it is missing or fails).
  async buildPrompt(input: BuildPromptInput): Promise<BuiltPrompt> {
    const mode = isUiKind(input?.mode) ? input.mode : 'thumbnail'
    const forbidden = await this.forbidden()
    const gameName = this.deps.gameName?.()
    const allow = gameName ? [gameName] : []
    const { text: ask, removed } = scrubBrief(String(input?.ask ?? '').trim().slice(0, 2000), forbidden, allow)
    const notes: string[] = removed.length ? [`Kept reference names out of the prompt: ${removed.join(', ')}.`] : []
    let sections: PromptSection[]
    let names: string[] | undefined
    let profile: ThumbStyleProfile | undefined
    let bases = 0
    let kitRefs = 0
    if (mode === 'thumbnail') {
      profile = input.profileId ? (await this.find<ThumbStyleProfile>('profiles', input.profileId))?.item : undefined
      bases = (await Promise.all((input.baseIds ?? []).slice(0, MAX_BASES).map((id) => this.find<ThumbBase>('bases', id)))).filter(Boolean).length
      sections = buildSections({ ask, mode, gameName, profile, taste: tasteLines(await this.taste()), bases })
      if (profile) notes.push(`Style profile "${profile.name}" is in the composition, camera, palette and text sections.`)
    } else {
      const kit = await this.ui.kit(mode)
      const usable = kit.samples + kit.refIds.length > 0 ? kit : null
      const built = this.ui.sections({ ask, kind: mode, names: input.names, kit: usable })
      sections = built.sections
      names = mode === 'icon-set' ? built.names : undefined
      kitRefs = Math.min(2, usable?.refIds.length ?? 0)
      const info = analyzeAsk(ask)
      if (!info.quoted.length && info.caps.length && mode !== 'hud') notes.push(`No text is drawn by default (a Roblox TextLabel localises it). To bake the word into the art, quote it: "${info.caps[0]}".`)
      if (usable) notes.push(`Your UI kit (${kit.samples} kept) is attached: ${kit.lines.slice(0, 3).join(', ')}${kitRefs ? `, plus ${kitRefs} reference image${kitRefs === 1 ? '' : 's'}` : ''}.`)
    }
    let by: BuiltPrompt['by'] = 'rules'
    if (input.model) {
      const vision = this.deps.vision?.('cheap') ?? this.deps.vision?.('default') ?? null
      if (!vision) notes.push('No Labs model is set up: the rules built this prompt.')
      else {
        try {
          const raw = await vision(EXPAND_SYSTEM, expandPrompt(ask, mode, sections), [])
          const merged = mergeExpansion(sections, raw, { scrub: (s) => scrubBrief(s, forbidden, allow).text, allowText: analyzeAsk(ask).quoted.length > 0 })
          if (merged) (sections = merged), (by = 'model')
          else notes.push('The model did not improve the draft; showing the rules.')
        } catch (e) {
          notes.push(`The model could not expand it (${(e as Error).message.slice(0, 120)}); showing the rules.`)
        }
      }
    }
    const refsN = mode === 'thumbnail' && profile && this.settings().sendRefs ? Math.min(2, profile.refIds.length) : 0
    const prompt = mode === 'thumbnail' ? generationPrompt({ brief: ask, bases, styleRefs: refsN, gameName, sections }, forbidden).prompt : uiPrompt(sections, { kind: mode, gameName, icon: names?.[0], kitRefs })
    return { mode, sections, prompt, notes, warnings: lintSections(sections, mode, names), by, ...(names ? { names } : {}) }
  }

  // A variation the user likes becomes a style reference for later profiles (it is the user's own
  // game, so it carries no game name to forbid).
  async useAsRef(id: string): Promise<ThumbRef> {
    const { item, store } = await this.must<Thumb>('thumbs', id)
    const img = decodePng(await store.readFile('thumbs', id, item.file))
    const now = this.now()
    const refStore = this.storeFor(undefined, 'refs')
    const name = `kept ${item.brief.slice(0, 40)}`.trim()
    const ref: ThumbRef = { id: newId('ref', name), scope: refStore.scope, name, source: 'file', file: 'image.png', width: img.width, height: img.height, stats: item.stats, tags: ['own'], createdAt: now, updatedAt: now }
    await refStore.writeFile('refs', ref.id, 'image.png', await store.readFile('thumbs', id, item.file))
    const saved = await refStore.save('refs', ref)
    this.changed()
    void this.analyzeRef(saved.id).catch((e) => this.deps.log?.(`thumbs: analyse ${saved.id}: ${(e as Error).message}`, 'stderr'))
    return saved
  }

  // ------------------------------------------------------------ files

  async file(kind: 'ref' | 'base' | 'thumb' | 'ui', id: string, which: 'image' | 's256' | 's160' = 'image'): Promise<string | null> {
    if (kind === 'ui') return this.ui.file(id)
    const k: ThumbKind = kind === 'ref' ? 'refs' : kind === 'base' ? 'bases' : 'thumbs'
    const hit = await this.find<{ file: string; small?: { s256: string; s160: string } }>(k, id).catch(() => null)
    if (!hit) return null
    const file = which !== 'image' && hit.item.small ? hit.item.small[which] : hit.item.file
    const bytes = await hit.store.readFile(k, id, file).catch(() => null)
    return bytes ? toDataUrl(bytes) : null
  }

  async batches(): Promise<{ id: string; thumbs: Thumb[] }[]> {
    const map = new Map<string, Thumb[]>()
    for (const t of await this.list()) map.set(batchOf(t.id), [...(map.get(batchOf(t.id)) ?? []), t])
    return [...map.entries()].map(([id, thumbs]) => ({ id, thumbs }))
  }
}

