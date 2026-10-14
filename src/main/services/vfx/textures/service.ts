// VFX texture service: the texture library (user + project), procedural generation (free), AI
// generation through the Art page's OpenAI client and budget, post-processing into clean particle
// sprites and flipbook sheets, Open Cloud upload as Image assets with moderation tracking, ratings
// that feed memory, and the hooks the VFX service uses (preview data URLs, gen-ref materialisation,
// the forgetex:// -> rbxassetid:// swap on export). No electron imports.

import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { generateImages, type ArtFetch, type Sleep } from '../../art/openaiImages.ts'
import { estimateImageUsd, formatUsd, round } from '../../art/pricing.ts'
import { uploadImageAsset, ASSETS_BASE, AssetUploadError } from '../../art/robloxAssets.ts'
import { dayOf } from '../../art/store.ts'
import { assembleFlipbook, layoutForFrames, premultipliedPreview, prepareSprite, isPow2, resample, type Rgba, type TintMode } from '../../../../shared/vfx/tex/image.ts'
import { evolveFrames, generateProcedural, PROCEDURAL_INFO, PROCEDURAL_TYPES, resolveParams, type ProceduralType } from '../../../../shared/vfx/tex/procedural.ts'
import {
  applyFlipbookLayouts,
  exportEffect,
  genRef,
  kindFromText,
  parseTexRef,
  swapTextureRefs,
  texRef,
  texRefsIn,
  texturePreset,
  texturePrompt,
  textureLine,
  TEXTURE_KINDS,
  type ExportPlan,
  type ModerationState,
  type TextureKind,
  type TextureScope,
  type VfxTexture
} from '../../../../shared/vfx/tex/textures.ts'
import type { VfxEffect } from '../../../../shared/vfx/types.ts'
import type { TextureGenerateInput, TextureStatus } from '../../../../shared/vfxTextureTypes.ts'
import { decodePng, encodePng } from './png.ts'
import { PROJECT_TEXTURE_DIR, TextureError, TextureStore, textureId } from './store.ts'
import { assertSpend, chargeSpend } from '../../spend/gate.ts'
import { codexBackend, type CodexImages } from '../../art/imageBackend.ts'
import { applyTexturePolicy, libraryPromptLines, normalizePolicy, roleTextures, DEFAULT_TEXTURE_POLICY, type TexturePolicy } from '../../../../shared/vfx/tex/reuse.ts'
import { analyzeTexture, summary } from '../../../../shared/vfx/tex/analyze.ts'
import { TextureImporter, type BytesFetch, type StudioHarvestDeps, type VisionFn } from './importer.ts'
import { CODEX_IMAGE_MODEL, type ImageBackend } from '../../../../shared/artTypes.ts'

export interface TextureMemory {
  remember(input: { scope: 'user' | 'project'; kind?: 'memory' | 'skill'; type?: 'user' | 'project' | 'feedback' | 'reference'; name: string; description: string; body: string }, source?: 'agent' | 'reflection' | 'style' | 'user'): Promise<{ entry: { name: string } }>
}

export interface TextureServiceDeps {
  // userData/vfx (the user library is <userDir>/textures).
  userDir: string
  projectRoot: () => string | null
  // The Art page's OpenAI key, model / quality / daily cap and today's Art spend.
  openAiKey?: () => Promise<string | null>
  imageSettings?: () => { model: string; quality: string; dailyCapUsd: number; backend?: ImageBackend }
  // The ChatGPT plan through Codex (Art page image backend 'codex').
  codexImages?: CodexImages
  artSpentToday?: () => Promise<number>
  // The Art page's Open Cloud key and creator.
  robloxKey?: () => Promise<string | null>
  creator?: () => { userId?: number; groupId?: number }
  fetch?: ArtFetch
  sleep?: Sleep
  now?: () => number
  memory?: TextureMemory
  emit?: (event: 'vfx:textures', payload: { at: number }) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  // VFX Lab setting "Textures" (shared/vfx/tex/reuse.ts): read and written through the app settings.
  policy?: { get(): TexturePolicy; set(p: TexturePolicy): void }
  // Import: JPEG decoding (electron nativeImage), downloads with bytes, the cheap vision model and
  // the Studio sources for "From Studio".
  decodeImage?: (bytes: Buffer, ext: string) => Rgba | null
  bytesFetch?: BytesFetch
  vision?: () => VisionFn | null
  studio?: StudioHarvestDeps
}

// AI textures are made at 1024 (the cheapest square size) and downscaled.
const AI_SIZE = '1024x1024'
const AI_QUALITY_DEFAULT = 'medium'
export const AGENT_MAX_AI_VARIANTS = 4

const resample512 = (img: Rgba) => resample(img, 512, 512)

export function normalizeModeration(state: string | undefined): ModerationState {
  const s = String(state ?? '').toLowerCase()
  if (s.includes('approved')) return 'Approved'
  if (s.includes('reject')) return 'Rejected'
  if (s.includes('review') || s.includes('pending')) return 'Reviewing'
  return 'Unknown'
}

const clampSize = (n: number | undefined, fallback: number) => {
  const v = Math.floor(Number(n))
  return isPow2(v) && v >= 64 && v <= 1024 ? v : fallback
}

export class TextureService {
  readonly user: TextureStore
  private deps: TextureServiceDeps
  private projectStore: { root: string; store: TextureStore } | null = null
  private genCache = new Map<string, string>()
  private now: () => number
  private localPolicy: TexturePolicy = DEFAULT_TEXTURE_POLICY
  readonly importer: TextureImporter

  constructor(deps: TextureServiceDeps) {
    this.deps = deps
    this.user = new TextureStore('user', join(deps.userDir, 'textures'))
    this.now = deps.now ?? Date.now
    this.importer = new TextureImporter({
      storeFor: (scope) => this.storeFor(scope),
      list: () => this.list(),
      changed: () => this.changed(),
      decodeImage: deps.decodeImage,
      fetch: deps.bytesFetch,
      vision: deps.vision,
      studio: deps.studio,
      now: deps.now,
      log: deps.log
    })
  }

  // ------------------------------------------------------------ texture policy (reuse first)

  policy(): TexturePolicy {
    return normalizePolicy(this.deps.policy ? this.deps.policy.get() : this.localPolicy)
  }

  setPolicy(p: unknown): TexturePolicy {
    const v = normalizePolicy(p)
    if (this.deps.policy) this.deps.policy.set(v)
    else this.localPolicy = v
    this.changed()
    return v
  }

  // ------------------------------------------------------------ import

  importFiles(paths: string[], opts: { vision?: boolean } = {}) {
    return this.importer.scanFiles(paths, opts)
  }

  importIds(text: string, opts: { vision?: boolean } = {}) {
    return this.importer.scanIds(text, opts)
  }

  importStudio(opts: { vision?: boolean } = {}) {
    return this.importer.scanStudio(opts)
  }

  importCommit(input: Parameters<TextureImporter['commit']>[0]): Promise<VfxTexture[]> {
    return this.importer.commit(input, (store, base, img) => this.saveImage(store, base, img))
  }

  get userLibraryDir(): string {
    return this.user.dir
  }

  project(): TextureStore | null {
    const root = this.deps.projectRoot()
    if (!root) return null
    if (this.projectStore?.root !== root) this.projectStore = { root, store: new TextureStore('project', join(root, ...PROJECT_TEXTURE_DIR.split('/'))) }
    return this.projectStore.store
  }

  private storeFor(scope: TextureScope | undefined): TextureStore {
    if (scope === 'user') return this.user
    return this.project() ?? this.user
  }

  private changed(): void {
    this.deps.emit?.('vfx:textures', { at: this.now() })
  }

  async list(): Promise<VfxTexture[]> {
    const p = this.project()
    return [...(p ? await p.list() : []), ...(await this.user.list())]
  }

  async find(id: string): Promise<{ tex: VfxTexture; store: TextureStore } | null> {
    for (const s of [this.project(), this.user]) {
      if (!s) continue
      const t = await s.read(id).catch(() => null)
      if (t) return { tex: t, store: s }
    }
    return null
  }

  async get(id: string): Promise<VfxTexture> {
    const hit = await this.find(String(id))
    if (!hit) throw new TextureError(`no texture "${id}"`)
    return hit.tex
  }

  async search(query: string, limit = 20): Promise<VfxTexture[]> {
    const all = await this.list()
    const words = query.toLowerCase().split(/[^a-z0-9-]+/).filter((w) => w.length > 1)
    if (!words.length) return all.filter((t) => t.rating !== 'down').slice(0, limit)
    return all
      .map((t) => {
        const hay = `${t.name} ${t.kind} ${t.description} ${t.tags.join(' ')} ${t.prompt ?? ''}`.toLowerCase()
        let s = words.reduce((n, w) => n + (t.tags.includes(w) || t.kind === w ? 3 : hay.includes(w) ? 1 : 0), 0)
        if (t.rating === 'up') s *= 1.5
        if (t.rating === 'down') s *= 0.3
        return { t, s }
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s || b.t.updatedAt - a.t.updatedAt)
      .slice(0, limit)
      .map((x) => x.t)
  }

  // ------------------------------------------------------------ status / budget

  private async spentToday(): Promise<number> {
    const today = dayOf(this.now())
    const tex = (await this.list()).filter((t) => t.costUsd && dayOf(t.createdAt) === today).reduce((s, t) => s + (t.costUsd ?? 0), 0)
    const art = (await this.deps.artSpentToday?.().catch(() => 0)) ?? 0
    return round(tex + art)
  }

  private codex(): CodexImages | null {
    return codexBackend(this.deps.imageSettings?.().backend, this.deps.codexImages)
  }

  private settings(): { model: string; quality: string; dailyCapUsd: number } {
    const s = this.deps.imageSettings?.() ?? { model: 'gpt-image-2.5-flare', quality: AI_QUALITY_DEFAULT, dailyCapUsd: 5 }
    // Sprites do not need high quality; medium keeps them cheap.
    return { ...s, quality: ['low', 'medium'].includes(s.quality) ? s.quality : AI_QUALITY_DEFAULT }
  }

  async status(): Promise<TextureStatus> {
    const s = this.settings()
    const creator = this.deps.creator?.() ?? {}
    const p = this.project()
    const codex = this.codex()
    return {
      ...(codex ? { codex: await codex.status().catch((e) => ({ ready: false, detail: (e as Error).message })) } : {}),
      project: !!this.deps.projectRoot(),
      openaiKey: !!(await this.deps.openAiKey?.().catch(() => null)),
      robloxKey: !!(await this.deps.robloxKey?.().catch(() => null)),
      creator: !!(creator.userId || creator.groupId),
      model: s.model,
      perImageUsd: estimateImageUsd(s.model, s.quality, AI_SIZE),
      spentTodayUsd: await this.spentToday(),
      dailyCapUsd: s.dailyCapUsd,
      counts: { user: (await this.user.list()).length, project: p ? (await p.list()).length : 0 },
      policy: this.policy(),
      vision: !!this.deps.vision?.(),
      studio: { connected: !!(this.deps.studio?.bridge?.listening && this.deps.studio.bridge.connected()), liveTree: !!this.deps.studio?.liveTree?.() }
    }
  }

  // ------------------------------------------------------------ generation

  private async saveImage(store: TextureStore, base: Omit<VfxTexture, 'file' | 'preview' | 'scope' | 'size'>, img: Rgba): Promise<VfxTexture> {
    const item: VfxTexture = { ...base, scope: store.scope, size: img.width, file: 'texture.png', preview: 'preview.png' }
    await store.writeFile(item.id, 'texture.png', encodePng(img))
    await store.writeFile(item.id, 'preview.png', encodePng(premultipliedPreview(img)))
    return store.save(item)
  }

  // Procedural (free) or AI. Returns the new library items.
  async generate(input: TextureGenerateInput): Promise<VfxTexture[]> {
    const description = String(input.description ?? '').trim().slice(0, 1000)
    const kind: TextureKind = input.kind && (TEXTURE_KINDS as readonly string[]).includes(input.kind) ? input.kind : input.procedural?.type ? (input.procedural.type as TextureKind) : kindFromText(description)
    const preset = texturePreset(kind)
    const tint: TintMode = input.tint ?? preset.tint
    const frames = [4, 16, 64].includes(Number(input.frames)) ? Number(input.frames) : 1
    const store = this.storeFor(input.scope)
    const tags = [...new Set([kind, ...(input.tags ?? []).map((t) => String(t).toLowerCase().trim()).filter(Boolean), ...(frames > 1 ? ['flipbook'] : [])])].slice(0, 12)
    const now = this.now()
    if (!input.ai) {
      const type = (input.procedural?.type ?? preset.procedural) as ProceduralType | undefined
      if (!type || !PROCEDURAL_TYPES.includes(type)) throw new TextureError(`No procedural generator for "${kind}" (procedural: ${PROCEDURAL_TYPES.join(', ')}). Generate it with AI instead.`)
      const seed = Math.max(0, Math.floor(input.procedural?.seed ?? 1))
      const size = clampSize(input.size, frames > 1 ? (frames === 4 ? 512 : 1024) : 256)
      const r = generateProcedural({ type, params: input.procedural?.params, seed, size, tint, frames })
      const name = input.name?.trim() || `${PROCEDURAL_INFO[type].label}${frames > 1 ? ` ${r.layout}` : ''}${seed !== 1 ? ` #${seed}` : ''}`
      const item = await this.saveImage(
        store,
        {
          id: textureId(name),
          name: name.slice(0, 60),
          kind,
          description: description || `Procedural ${PROCEDURAL_INFO[type].label.toLowerCase()} (${PROCEDURAL_INFO[type].use}).`,
          tags: [...new Set([...tags, type, 'procedural'])],
          source: 'procedural',
          procedural: { type, params: r.params, seed },
          tint,
          ...(r.layout ? { flipbook: { layout: r.layout, frames: r.frames } } : {}),
          createdAt: now,
          updatedAt: now
        },
        r.image
      )
      this.changed()
      return [item]
    }
    return this.generateAi(input, { kind, description, tint, frames, store, tags })
  }

  private async generateAi(input: TextureGenerateInput, o: { kind: TextureKind; description: string; tint: TintMode; frames: number; store: TextureStore; tags: string[] }): Promise<VfxTexture[]> {
    if (!o.description && o.kind === 'other') throw new TextureError('Describe the texture, e.g. "purple energy wisp".')
    const codex = this.codex()
    const key = codex ? null : await this.deps.openAiKey?.()
    if (!codex && !key) throw new TextureError('No OpenAI API key. Add one in Settings > Providers > OpenAI (procedural textures are free and need none).')
    const s = this.settings()
    const max = input.source === 'agent' ? AGENT_MAX_AI_VARIANTS : 8
    // A 2x2 flipbook is four variants on one sheet; 4x4 / 8x8 evolve one image.
    const n = o.frames === 4 ? 4 : o.frames > 4 ? 1 : Math.max(1, Math.min(max, Math.floor(input.n ?? 1)))
    const per = codex ? 0 : estimateImageUsd(s.model, s.quality, AI_SIZE)
    const total = round(per * n)
    const prompt = texturePrompt(o.kind, o.description, o.tint)
    let res: { images: Buffer[] }
    if (codex) {
      // ChatGPT plan: no budget, no spending cap. Codex picks the size; prepareSprite fits it.
      const r = await codex.generate({ prompt, n, size: AI_SIZE, transparent: true })
      if (r.notes.length) this.deps.log?.(`textures: ${r.notes.join(' ')}`)
      res = r
    } else {
      const spent = await this.spentToday()
      if (s.dailyCapUsd > 0 && spent + total > s.dailyCapUsd) throw new TextureError(`This would pass today's image budget (${formatUsd(spent)} spent + ${formatUsd(total)} > ${formatUsd(s.dailyCapUsd)}). Raise it on the Art page, or use a procedural texture (free).`)
      // App-wide spending cap (Settings > Usage).
      assertSpend('images')
      res = await generateImages({ model: s.model, prompt, n, size: AI_SIZE, quality: s.quality, background: 'transparent', outputFormat: 'png' }, { apiKey: key ?? '', fetch: this.deps.fetch, sleep: this.deps.sleep })
      chargeSpend({ provider: 'openai', source: 'images', costUsd: total })
    }
    const sprites = res.images.map((bytes) => prepareSprite(decodePng(bytes), { tint: o.tint, size: o.frames > 1 ? 256 : clampSize(input.size, 512) }))
    const now = this.now()
    const name = (input.name?.trim() || o.description || texturePreset(o.kind).label).slice(0, 48)
    const base = { kind: o.kind, description: o.description || texturePreset(o.kind).label, source: 'ai' as const, prompt, model: codex ? CODEX_IMAGE_MODEL : s.model, tint: o.tint, createdAt: now, updatedAt: now }
    const out: VfxTexture[] = []
    if (o.frames > 1) {
      const layout = layoutForFrames(o.frames)
      // Codex may return fewer than the 4 variants a 2x2 sheet needs: repeat what came back.
      const four = sprites.length >= 4 ? sprites : Array.from({ length: 4 }, (_, i) => sprites[i % sprites.length])
      const frames = o.frames === 4 ? four : evolveFrames(sprites[0], o.frames, now % 997)
      const sheet = assembleFlipbook(frames, layout, clampSize(input.size, o.frames === 4 ? 512 : 1024))
      out.push(await this.saveImage(o.store, { ...base, id: textureId(name), name: `${name} ${layout}`, tags: [...o.tags, 'ai'], costUsd: total, flipbook: { layout, frames: o.frames } }, sheet))
    } else {
      for (const [i, img] of sprites.entries()) {
        out.push(await this.saveImage(o.store, { ...base, id: textureId(name), name: sprites.length > 1 ? `${name} ${i + 1}` : name, tags: [...o.tags, 'ai'], costUsd: round(total / sprites.length) }, img))
      }
    }
    this.changed()
    return out
  }

  // Live preview for the generator's sliders (not saved).
  previewProcedural(input: { type: ProceduralType; params?: Record<string, number>; seed?: number; tint?: TintMode; frames?: number }): string {
    const frames = [4, 16, 64].includes(Number(input.frames)) ? Number(input.frames) : 1
    const r = generateProcedural({ type: input.type, params: input.params, seed: input.seed, tint: input.tint, frames, size: frames > 1 ? 512 : 192 })
    return `data:image/png;base64,${encodePng(premultipliedPreview(r.image)).toString('base64')}`
  }

  // ------------------------------------------------------------ edits / ratings

  async update(id: string, patch: { name?: string; description?: string; tags?: string[] }): Promise<VfxTexture> {
    const hit = await this.find(id)
    if (!hit) throw new TextureError(`no texture "${id}"`)
    const t: VfxTexture = { ...hit.tex, updatedAt: this.now() }
    if (typeof patch.name === 'string' && patch.name.trim()) t.name = patch.name.trim().slice(0, 60)
    if (typeof patch.description === 'string') t.description = patch.description.slice(0, 1000)
    if (Array.isArray(patch.tags)) t.tags = [...new Set(patch.tags.map((x) => String(x).toLowerCase().trim()).filter(Boolean))].slice(0, 16)
    const saved = await hit.store.save(t)
    this.changed()
    return saved
  }

  async remove(id: string): Promise<boolean> {
    const hit = await this.find(id)
    if (!hit) return false
    const ok = await hit.store.remove(id)
    this.changed()
    return ok
  }

  // Thumbs up / down: like other library items, ratings feed memory (a skill listing the liked
  // textures and how they were made; a feedback note of what to avoid), and the composer prefers
  // liked textures.
  async rate(id: string, rating: 'up' | 'down' | null): Promise<VfxTexture> {
    const hit = await this.find(id)
    if (!hit) throw new TextureError(`no texture "${id}"`)
    const t: VfxTexture = { ...hit.tex, updatedAt: this.now() }
    if (rating) t.rating = rating
    else delete t.rating
    const saved = await hit.store.save(t)
    if (this.deps.memory) await this.learn().catch((e) => this.deps.log?.(`textures: memory: ${(e as Error).message}`, 'stderr'))
    this.changed()
    return saved
  }

  private async learn(): Promise<void> {
    const all = await this.list()
    const liked = all.filter((t) => t.rating === 'up')
    const disliked = all.filter((t) => t.rating === 'down')
    const recipe = (t: VfxTexture) => (t.procedural ? `procedural ${t.procedural.type} ${JSON.stringify(t.procedural.params)} seed ${t.procedural.seed} (${genRef(t.procedural.type, t.procedural.params, { seed: t.procedural.seed, frames: t.flipbook?.frames, tint: t.tint === 'grey' ? 'grey' : undefined })})` : `AI: "${(t.description || t.prompt || '').slice(0, 140)}"`)
    if (liked.length) {
      const body = [
        'VFX textures the user liked (thumbs up in the VFX Lab). Prefer these for their kind: set Texture (or the kit texture option) to the forgetex:// reference; it becomes rbxassetid:// when the texture is uploaded.',
        ...liked.slice(0, 30).map((t) => `- ${textureLine(t)}\n  made with ${recipe(t)}`)
      ].join('\n')
      await this.deps.memory!.remember({ scope: 'user', kind: 'skill', name: 'vfx-textures-liked', description: 'Custom VFX textures the user liked, with how to reuse or remake them', body: body.slice(0, 7900) }, 'user')
    }
    if (disliked.length) {
      const body = ['VFX textures the user disliked (thumbs down). Do not reuse them or make similar ones:', ...disliked.slice(0, 30).map((t) => `- ${t.kind}: ${t.name} (${recipe(t)})`)].join('\n')
      await this.deps.memory!.remember({ scope: 'user', kind: 'memory', type: 'feedback', name: 'vfx-textures-avoid', description: 'Custom VFX textures the user disliked: what to avoid', body: body.slice(0, 2900) }, 'user')
    }
  }

  // ------------------------------------------------------------ upload

  async upload(id: string): Promise<VfxTexture> {
    const hit = await this.find(id)
    if (!hit) throw new TextureError(`no texture "${id}"`)
    const key = await this.deps.robloxKey?.()
    if (!key) throw new TextureError('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    const creator = this.deps.creator?.() ?? {}
    const bytes = await hit.store.readFile(id, hit.tex.file)
    // Always an Image asset: its id works in ParticleEmitter.Texture from scripts and .rbxmx files
    // (a Decal id would only be converted when pasted in Studio; see shared/vfx/tex/textures.ts).
    const r = await uploadImageAsset({
      apiKey: key,
      bytes,
      fileName: `${id}.png`,
      displayName: `VFX ${hit.tex.name}`.slice(0, 50),
      description: `${hit.tex.kind} texture from RBX Forge${hit.tex.flipbook ? ` (flipbook ${hit.tex.flipbook.layout})` : ''}`,
      assetType: 'Image',
      contentType: 'image/png',
      creator,
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      now: this.deps.now
    })
    const t: VfxTexture = { ...hit.tex, updatedAt: this.now(), roblox: { assetId: r.assetId, uri: r.uri, uploadedAt: this.now(), moderation: normalizeModeration(r.moderation), operationId: r.operationId } }
    const saved = await hit.store.save(t)
    this.changed()
    return saved
  }

  // GET /assets/v1/assets/{assetId}?readMask=moderationResult (Get Asset, scope asset:read; the
  // Asset resource has moderationResult.moderationState: Reviewing / Rejected / Approved).
  async checkModeration(id: string): Promise<VfxTexture> {
    const hit = await this.find(id)
    if (!hit) throw new TextureError(`no texture "${id}"`)
    if (!hit.tex.roblox) throw new TextureError('This texture is not uploaded yet.')
    if (hit.tex.source === 'asset') return this.refreshAsset(hit.tex, hit.store)
    const key = await this.deps.robloxKey?.()
    if (!key) throw new TextureError('No Open Cloud API key. Add one on the Art page.')
    const fetch = this.deps.fetch ?? (globalThis.fetch as unknown as ArtFetch)
    const res = await fetch(`${ASSETS_BASE}/assets/${encodeURIComponent(hit.tex.roblox.assetId)}?readMask=moderationResult`, { method: 'GET', headers: { 'x-api-key': key, accept: 'application/json' } })
    const body = await res.text()
    if (!res.ok) throw new AssetUploadError(`Roblox answered ${res.status} for asset ${hit.tex.roblox.assetId}: ${body.slice(0, 200)}`, res.status)
    let state: string | undefined
    try {
      state = (JSON.parse(body) as { moderationResult?: { moderationState?: string } }).moderationResult?.moderationState
    } catch {
      state = undefined
    }
    const t: VfxTexture = { ...hit.tex, updatedAt: this.now(), roblox: { ...hit.tex.roblox, moderation: normalizeModeration(state), checkedAt: this.now() } }
    const saved = await hit.store.save(t)
    this.changed()
    return saved
  }

  // An asset-id texture (not ours to query through Open Cloud): the public thumbnail's state, and
  // its preview image when the library has none yet.
  private async refreshAsset(tex: VfxTexture, store: TextureStore): Promise<VfxTexture> {
    const id = tex.roblox!.assetId
    const thumbs = await this.importer.thumbnails([id])
    if (!thumbs) throw new TextureError('Roblox could not be reached; try again when online.')
    const th = thumbs.get(id)
    const moderation: ModerationState = th?.state === 'Completed' ? 'Approved' : th?.state === 'Blocked' ? 'Rejected' : th?.state === 'Pending' ? 'Reviewing' : 'Unknown'
    let t: VfxTexture = { ...tex, updatedAt: this.now(), roblox: { ...tex.roblox!, moderation, checkedAt: this.now() } }
    if (tex.origin?.noPreview && th?.url) {
      const img = await this.importer.fetchImage(th.url)
      if (img) {
        const saved = await this.saveImage(store, { ...t, origin: { ...tex.origin, noPreview: false }, analysis: summary(analyzeTexture(img)) }, resample512(img))
        this.changed()
        return saved
      }
    }
    const saved = await store.save(t)
    this.changed()
    return saved
  }

  // ------------------------------------------------------------ files and refs

  async file(id: string, which: 'texture' | 'preview'): Promise<string | null> {
    const hit = await this.find(id)
    if (!hit) return null
    const bytes = await hit.store.readFile(id, which === 'preview' ? hit.tex.preview : hit.tex.file).catch(() => null)
    return bytes ? `data:image/png;base64,${bytes.toString('base64')}` : null
  }

  // forgetex:// -> PNG data URL for the preview (library file, or a gen request drawn on the fly).
  async resolve(ref: string): Promise<string | null> {
    const p = parseTexRef(ref)
    if (!p) return null
    if (p.kind === 'id') return this.file(p.id, 'texture')
    const hit = this.genCache.get(ref)
    if (hit) return hit
    const r = generateProcedural({ type: p.type, params: p.params, seed: p.seed, frames: p.frames, tint: p.tint, size: p.frames > 1 ? 1024 : 256 })
    const url = `data:image/png;base64,${encodePng(r.image).toString('base64')}`
    if (this.genCache.size > 64) this.genCache.clear()
    this.genCache.set(ref, url)
    return url
  }

  // Turns forgetex://gen/... requests into library items (one per distinct request; an existing item
  // with the same recipe is reused) and rewrites the effect to forgetex://<id>; then flipbook textures
  // set their layout on the emitters that use them.
  // reuse: the effect came from the composer / drafter / critic: the texture policy applies first
  // (library textures instead of new ones, disliked ones swapped, built-in defaults replaced by the
  // user's imported / liked textures of the same kind). Manual edits pass reuse false.
  async prepareEffect(effect: VfxEffect, scope?: TextureScope, opts: { reuse?: boolean } = {}): Promise<VfxEffect> {
    if (opts.reuse) {
      const r = applyTexturePolicy(effect, await this.list(), this.policy(), { replaceBuiltins: true })
      for (const p of r.picks) this.deps.log?.(`textures: ${p.node}: ${p.why}`)
      effect = r.effect
    }
    const refs = texRefsIn(effect)
    if (!refs.length) return effect
    const map: Record<string, string> = {}
    const all = await this.list()
    for (const ref of refs) {
      const p = parseTexRef(ref)
      if (p?.kind !== 'gen') continue
      const same = all.find((t) => t.procedural && t.procedural.type === p.type && t.procedural.seed === p.seed && (t.flipbook?.frames ?? 1) === p.frames && (t.tint === 'grey') === (p.tint === 'grey') && JSON.stringify(resolveParams(p.type, t.procedural.params)) === JSON.stringify(p.params))
      if (same) {
        map[ref] = texRef(same.id)
        continue
      }
      const [made] = await this.generate({ procedural: { type: p.type, params: p.params, seed: p.seed }, kind: p.type as TextureKind, tint: p.tint, frames: p.frames, scope, tags: ['auto'] })
      all.push(made)
      map[ref] = texRef(made.id)
    }
    let next = swapTextureRefs(effect, map)
    const byId = new Map(all.map((t) => [texRef(t.id), t]))
    next = applyFlipbookLayouts(next, (r) => byId.get(r)?.flipbook)
    return next
  }

  // The effect as written to the project: forgetex:// -> rbxassetid:// (or a built-in fallback).
  async exportEffect(effect: VfxEffect): Promise<ExportPlan> {
    if (!texRefsIn(effect).length) return { effect, swapped: {}, fallbacks: [] }
    const byRef = new Map((await this.list()).map((t) => [texRef(t.id), t]))
    return exportEffect(effect, (ref) => {
      const t = byRef.get(ref)
      return t ? { uri: t.roblox?.uri, moderation: t.roblox?.moderation, kind: t.kind } : null
    })
  }

  // For the composer and the drafter: the policy instruction and the library by kind (imported and
  // liked first, never disliked).
  async promptList(limit = 40): Promise<string[]> {
    return libraryPromptLines(await this.list(), this.policy(), { max: limit })
  }

  // Draft layer roles -> library textures (empty under "generate freely").
  async roleTextures(): Promise<Record<string, string>> {
    return roleTextures(await this.list(), this.policy())
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.user.dir, { recursive: true })
  }
}
