// Art service: generate concepts with OpenAI, keep them in <project>/art, import them to Roblox and
// into src/shared/Assets/Images.luau. No electron imports; main/integrations.ts wires the keys,
// settings, thumbnailer and events. Keys are only read here and never returned.

import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type {
  ArtCostEstimate,
  ArtGenerateInput,
  ArtImportInput,
  ArtImportResult,
  ArtItem,
  ArtModel,
  ArtQuality,
  ArtRegistryEntry,
  ArtSettings,
  ArtStatus
} from '../../../shared/artTypes.ts'
import { editImages, generateImages, mimeOf, pngSize, toDataUrl, validSize, type ArtFetch, type ImageResponse, type Sleep } from './openaiImages.ts'
import { estimateImageUsd, estimateUsd, formatUsd, round } from './pricing.ts'
import { forbidsComments, parseRegistry, registryName, REGISTRY_PATH, upsertRegistry } from './registry.ts'
import { uploadImageAsset } from './robloxAssets.ts'
import { STYLE_PRESETS, fullPrompt, slugify, stylePreset } from './styles.ts'
import { applyGitPolicy, CONCEPTS_DIR, dayOf, insideRoot, listConcepts, nextIndex, readItem, restoreConcept, trashConcept, UI_DIR, writeConcept, writeSidecar } from './store.ts'
import { assertSpend, chargeSpend } from '../spend/gate.ts'
import { backendOf, codexBackend, type CodexImages } from './imageBackend.ts'
import { CODEX_IMAGE_MODEL, CODEX_IMAGE_NOTE } from '../../../shared/artTypes.ts'
import { ArtLayerService, layersSpent } from './layers.ts'

export const ART_MODELS: ArtModel[] = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']
export const DEFAULT_SETTINGS: ArtSettings = { model: 'gpt-image-2.5-flare', quality: 'high', gitPolicy: 'track-small', dailyCapUsd: 5, assetType: 'Image' }
const QUALITIES: ArtQuality[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
// Agent calls are capped harder than the page.
export const AGENT_MAX_VARIANTS = 4
// Last Roblox creator set on any project (fallback for uploads when the open project has none).
const CREATOR_KEY = 'art.uploadCreator'

export interface ArtServiceDeps {
  root: () => string | null
  // Per-project scope id for settings (release.projectScope).
  scope: (root: string) => string
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  openAiKey: () => Promise<string | null>
  robloxKey: () => Promise<{ key: string; source: 'art' | 'release' } | null>
  fetch?: ArtFetch
  sleep?: Sleep
  now?: () => number
  // Where deleted concepts wait for undo, and thumbnails are cached (userData).
  trashDir: string
  thumbDir?: string
  // Electron nativeImage resize; absent in tests (the full image is returned).
  thumbnail?: (bytes: Buffer, width: number) => Promise<Buffer | null>
  onChanged?: (root: string) => void
  onProgress?: (p: { id: string; stage: string; detail?: string }) => void
  // Resolves a non-file reference (e.g. a chat image "forge-image://<id>") to an absolute path.
  resolveReference?: (ref: string) => Promise<string | null>
  // Minimum gap between OpenAI requests (ms) and concurrent generations.
  minIntervalMs?: number
  maxConcurrent?: number
  // The ChatGPT plan through Codex (settings.backend 'codex').
  codex?: CodexImages
  // A vision model (the Labs critic tier through the agent layer) for "Split into layers"; without
  // it the split starts from a default layer list.
  vision?: ArtVision
}

export type ArtVision = (system: string, prompt: string, images: { mime: string; base64: string }[]) => Promise<string>

export class ArtService {
  private deps: ArtServiceDeps
  private trash = new Map<string, { root: string; files: string[]; at: number }>()
  private running = 0
  private queue: (() => void)[] = []
  private lastRequest = 0
  // "Split into layers" (layers.ts).
  readonly layers: ArtLayerService

  constructor(deps: ArtServiceDeps) {
    this.deps = deps
    this.layers = new ArtLayerService(this, {
      vision: deps.vision,
      thumbnail: deps.thumbnail,
      now: () => this.now(),
      onProgress: deps.onProgress,
      onChanged: deps.onChanged
    })
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  root(): string {
    const r = this.deps.root()
    if (!r) throw new Error('No project open')
    return r
  }

  // ------------------------------------------------------------ settings and status

  settings(root = this.deps.root()): ArtSettings {
    const global = this.deps.settings.get<Partial<ArtSettings>>('art.settings', {})
    const project = root ? this.deps.settings.get<Partial<ArtSettings>>(`art.settings.${this.deps.scope(root)}`, {}) : {}
    return sanitize({ ...DEFAULT_SETTINGS, ...global, ...project })
  }

  async setSettings(patch: Partial<ArtSettings>): Promise<ArtStatus> {
    const r = this.root()
    const key = `art.settings.${this.deps.scope(r)}`
    const cur = this.deps.settings.get<Partial<ArtSettings>>(key, {})
    const next = sanitize({ ...this.settings(r), ...cur, ...patch })
    // userId and groupId are exclusive.
    if (patch.creatorGroupId) delete next.creatorUserId
    if (patch.creatorUserId) delete next.creatorGroupId
    this.deps.settings.set(key, next)
    if (patch.creatorGroupId || patch.creatorUserId) this.rememberCreator(next)
    if (patch.gitPolicy && patch.gitPolicy !== cur.gitPolicy) await applyGitPolicy(r, next.gitPolicy)
    return this.status()
  }

  // Who owns Open Cloud uploads made outside the Art page (upload inbox, Animation Lab, layers).
  // The creator is saved per project; the inbox runs whatever project is open (or none), so the last
  // creator set anywhere is kept globally as the fallback.
  uploadCreator(root = this.deps.root()): { userId?: number; groupId?: number } {
    const s = this.settings(root)
    if (s.creatorUserId || s.creatorGroupId) {
      this.rememberCreator(s)
      return { ...(s.creatorUserId ? { userId: s.creatorUserId } : {}), ...(s.creatorGroupId ? { groupId: s.creatorGroupId } : {}) }
    }
    const g = sanitize({ ...DEFAULT_SETTINGS, ...this.deps.settings.get<Partial<ArtSettings>>(CREATOR_KEY, {}) })
    return { ...(g.creatorUserId ? { userId: g.creatorUserId } : {}), ...(g.creatorGroupId ? { groupId: g.creatorGroupId } : {}) }
  }

  private rememberCreator(s: Partial<ArtSettings>): void {
    const next = s.creatorGroupId ? { creatorGroupId: s.creatorGroupId } : s.creatorUserId ? { creatorUserId: s.creatorUserId } : null
    if (!next) return
    const cur = this.deps.settings.get<Partial<ArtSettings>>(CREATOR_KEY, {})
    if (cur.creatorGroupId !== next.creatorGroupId || cur.creatorUserId !== next.creatorUserId) this.deps.settings.set(CREATOR_KEY, next)
  }

  async status(): Promise<ArtStatus> {
    const r = this.deps.root()
    const roblox = await this.deps.robloxKey().catch(() => null)
    const settings = this.settings(r)
    const codex = codexBackend(settings.backend, this.deps.codex)
    return {
      project: !!r,
      openaiKey: !!(await this.deps.openAiKey().catch(() => null)),
      robloxKey: !!roblox,
      ...(roblox ? { robloxKeySource: roblox.source } : {}),
      settings,
      styles: STYLE_PRESETS,
      models: ART_MODELS,
      ...(codex ? { codex: await codex.status().catch((e) => ({ ready: false, detail: (e as Error).message })) } : {})
    }
  }

  // ------------------------------------------------------------ listing

  async list(): Promise<ArtItem[]> {
    const r = this.deps.root()
    return r ? listConcepts(r) : []
  }

  // Concepts made today plus layers generated today (art/ui/*/layers/layers.json).
  async spentToday(): Promise<number> {
    const today = dayOf(this.now())
    const r = this.deps.root()
    const layers = r ? await layersSpent(r, today).catch(() => 0) : 0
    return round((await this.list()).filter((i) => i.date === today).reduce((s, i) => s + (i.costUsd || 0), 0) + layers)
  }

  // Whether images come from Codex (the ChatGPT plan) rather than the billed Images API.
  usesCodex(): boolean {
    return !!codexBackend(this.settings().backend, this.deps.codex)
  }

  // One image for "Split into layers": an edit with the references on the chosen backend, the prompt
  // sent as is. The caller checks the daily budget for the whole batch first; the app-wide spending
  // cap is checked and charged here, per image.
  async renderImage(req: { prompt: string; size: string; quality?: ArtQuality; transparent: boolean; referencePaths: string[] }): Promise<{ bytes: Buffer; model: string; size: string; quality: string; costUsd: number }> {
    const root = this.root()
    const refs = await Promise.all(req.referencePaths.map((r) => this.readReference(root, r)))
    const codex = codexBackend(this.settings().backend, this.deps.codex)
    if (codex) {
      const res = await this.slot(() => codex.generate({ prompt: req.prompt, n: 1, size: req.size, transparent: req.transparent, references: refs.map((r) => r.dataUrl) }))
      if (!res.images[0]) throw new Error(`Codex returned no image${res.notes.length ? `: ${res.notes.join(' ')}` : ''}`)
      return { bytes: res.images[0], model: CODEX_IMAGE_MODEL, size: 'auto', quality: 'auto', costUsd: 0 }
    }
    const apiKey = await this.deps.openAiKey()
    if (!apiKey) throw new Error('No OpenAI API key. Add one in Settings > Providers > OpenAI.')
    const q = this.resolveRequest({ prompt: req.prompt, size: req.size, quality: req.quality, transparent: req.transparent, n: 1, referencePaths: req.referencePaths })
    const costUsd = estimateUsd(q.model, q.quality, q.size, 1, refs.length)
    assertSpend('images')
    const image = { model: q.model, prompt: req.prompt, n: 1, size: q.size, quality: q.quality, background: req.transparent ? ('transparent' as const) : ('auto' as const), outputFormat: 'png' as const }
    const client = { apiKey, fetch: this.deps.fetch, sleep: this.deps.sleep }
    const res = await this.slot(() => (refs.length ? editImages({ ...image, images: refs.map((r) => r.dataUrl) }, client) : generateImages(image, client)))
    chargeSpend({ provider: 'openai', source: 'images', costUsd })
    if (!res.images[0]) throw new Error('OpenAI returned no image')
    return { bytes: res.images[0], model: q.model, size: res.size ?? q.size, quality: res.quality ?? q.quality, costUsd }
  }

  // Per-image estimate for one layer on the API backend (0 on Codex).
  estimateOne(req: { size: string; quality?: ArtQuality; references: number }): { usd: number; model: string; size: string; quality: string } {
    if (this.usesCodex()) return { usd: 0, model: CODEX_IMAGE_MODEL, size: 'auto', quality: 'auto' }
    const q = this.resolveRequest({ prompt: 'x', size: req.size, quality: req.quality, n: 1 })
    return { usd: estimateUsd(q.model, q.quality, q.size, 1, req.references), model: q.model, size: q.size, quality: q.quality }
  }

  // ------------------------------------------------------------ generation

  resolveRequest(input: ArtGenerateInput) {
    const s = this.settings()
    const preset = stylePreset(input.style)
    const model = input.model && ART_MODELS.includes(input.model) ? input.model : s.model
    const transparent = input.transparent ?? preset.transparent ?? false
    let size = (input.size || preset.size || '1024x1024').trim()
    // Custom sizes only work on the gpt-image-2 family; fall back to the nearest standard one.
    if (validSize(model, size)) {
      const m = /^(\d+)x(\d+)$/.exec(size)
      size = m && Number(m[1]) > Number(m[2]) ? '1536x1024' : m && Number(m[1]) < Number(m[2]) ? '1024x1536' : '1024x1024'
    }
    const quality = input.quality && QUALITIES.includes(input.quality) ? input.quality : s.quality
    const max = input.source === 'agent' ? AGENT_MAX_VARIANTS : 10
    const n = Math.max(1, Math.min(max, Math.floor(input.n ?? 1)))
    const refs = (input.referencePaths ?? []).filter((p) => typeof p === 'string' && p.trim())
    return { model, transparent, size, quality, n, refs, style: preset.id }
  }

  async estimate(input: ArtGenerateInput): Promise<ArtCostEstimate> {
    const q = this.resolveRequest(input)
    if (codexBackend(this.settings().backend, this.deps.codex)) {
      return { model: CODEX_IMAGE_MODEL, quality: 'auto', size: 'auto', n: Math.min(q.n, 4), perImageUsd: 0, totalUsd: 0, spentTodayUsd: await this.spentToday(), dailyCapUsd: 0, note: CODEX_IMAGE_NOTE }
    }
    const per = estimateImageUsd(q.model, q.quality, q.size)
    return {
      model: q.model,
      quality: q.quality,
      size: q.size,
      n: q.n,
      perImageUsd: per,
      totalUsd: estimateUsd(q.model, q.quality, q.size, q.n, q.refs.length),
      spentTodayUsd: await this.spentToday(),
      dailyCapUsd: this.settings().dailyCapUsd,
      note: 'Estimate from OpenAI per-image token prices; actual billing can differ.'
    }
  }

  private async readReference(root: string, ref: string): Promise<{ path: string; dataUrl: string }> {
    let abs: string | null = null
    if (/^[a-z][\w+.-]*:\/\//i.test(ref)) abs = (await this.deps.resolveReference?.(ref)) ?? null
    else abs = isAbsolute(ref) ? resolve(ref) : join(root, ...ref.replace(/\\/g, '/').split('/'))
    if (!abs) throw new Error(`cannot resolve reference ${ref}`)
    const s = await stat(abs).catch(() => null)
    if (!s?.isFile()) throw new Error(`reference not found: ${ref}`)
    if (s.size > MAX_REFERENCE_BYTES) throw new Error(`reference too large (max 20 MB): ${ref}`)
    const bytes = await readFile(abs)
    if (!mimeOf(bytes) || mimeOf(bytes) === 'image/bmp') throw new Error(`reference is not a PNG, JPEG, WEBP or GIF image: ${ref}`)
    return { path: insideRoot(root, abs) ?? abs, dataUrl: toDataUrl(bytes) }
  }

  // Simple limiter: at most maxConcurrent generations, spaced by minIntervalMs.
  private async slot<T>(fn: () => Promise<T>): Promise<T> {
    const max = this.deps.maxConcurrent ?? 2
    if (this.running >= max) await new Promise<void>((r) => this.queue.push(r))
    this.running++
    try {
      const gap = (this.deps.minIntervalMs ?? 1000) - (this.now() - this.lastRequest)
      if (gap > 0 && this.lastRequest) await (this.deps.sleep ?? ((ms: number) => new Promise((r) => setTimeout(r, ms))))(gap)
      this.lastRequest = this.now()
      return await fn()
    } finally {
      this.running--
      this.queue.shift()?.()
    }
  }

  async generate(input: ArtGenerateInput): Promise<ArtItem[]> {
    const root = this.root()
    const prompt = String(input.prompt ?? '').trim()
    if (!prompt) throw new Error('Write a prompt first')
    if (prompt.length > 30_000) throw new Error('Prompt is too long (OpenAI allows 32,000 characters)')
    const codex = codexBackend(this.settings().backend, this.deps.codex)
    if (codex) return this.generateCodex(root, prompt, input, codex)
    const apiKey = await this.deps.openAiKey()
    if (!apiKey) throw new Error('No OpenAI API key. Add one in Settings > Providers > OpenAI.')
    const q = this.resolveRequest(input)
    const est = await this.estimate(input)
    if (est.dailyCapUsd > 0 && est.spentTodayUsd + est.totalUsd > est.dailyCapUsd) {
      throw new Error(`This would pass today's art budget (${formatUsd(est.spentTodayUsd)} spent + ${formatUsd(est.totalUsd)} > ${formatUsd(est.dailyCapUsd)}). Raise it on the Art page.`)
    }
    // App-wide spending cap (Settings > Usage).
    assertSpend('images')
    const refs = await Promise.all(q.refs.map((r) => this.readReference(root, r)))
    const mask = input.maskPath ? await this.readReference(root, input.maskPath) : null
    const full = fullPrompt(prompt, q.style, q.transparent)
    const outputFormat = 'png' as const
    const job = randomUUID().slice(0, 8)
    const req = { model: q.model, prompt: full, n: q.n, size: q.size, quality: q.quality, background: q.transparent ? ('transparent' as const) : ('auto' as const), outputFormat }
    const client = { apiKey, fetch: this.deps.fetch, sleep: this.deps.sleep }
    this.deps.onProgress?.({ id: job, stage: 'generating', detail: `${q.n} × ${q.size} ${q.quality}` })
    let res: ImageResponse
    try {
      res = await this.slot(() => (refs.length ? editImages({ ...req, images: refs.map((r) => r.dataUrl), ...(mask ? { mask: mask.dataUrl } : {}) }, client) : generateImages(req, client)))
    } catch (error) {
      this.deps.onProgress?.({ id: job, stage: 'failed', detail: (error as Error).message })
      throw error
    }
    chargeSpend({ provider: 'openai', source: 'images', costUsd: est.totalUsd })
    const date = dayOf(this.now())
    const slug = slugify(input.slug || prompt)
    const dir = join(root, ...CONCEPTS_DIR.split('/'), date)
    let index = await nextIndex(dir, slug)
    const perImage = round(est.totalUsd / res.images.length)
    const items: ArtItem[] = []
    for (const bytes of res.images) {
      const size = pngSize(bytes)
      const item = await writeConcept(
        root,
        {
          path: `${CONCEPTS_DIR}/${date}/${slug}-${index}.png`,
          date,
          slug,
          index,
          prompt,
          fullPrompt: full,
          style: q.style,
          model: q.model,
          size: res.size ?? q.size,
          quality: res.quality ?? q.quality,
          background: (res.background as ArtItem['background']) ?? req.background,
          outputFormat,
          mode: refs.length ? 'edit' : 'generate',
          ...(refs.length ? { referencePaths: refs.map((r) => r.path) } : {}),
          seed: null,
          costUsd: perImage,
          createdAt: new Date(this.now()).toISOString(),
          bytes: bytes.byteLength,
          ...(size ? { width: size.width, height: size.height } : {}),
          source: input.source ?? 'page'
        },
        bytes
      )
      items.push(item)
      index++
    }
    const policy = this.settings(root).gitPolicy
    if (policy !== 'track' || items.some((i) => i.bytes > 5 * 1024 * 1024)) await applyGitPolicy(root, policy).catch(() => undefined)
    this.deps.onProgress?.({ id: job, stage: 'done', detail: `${items.length} image${items.length === 1 ? '' : 's'}` })
    this.deps.onChanged?.(root)
    return items
  }

  // The ChatGPT plan through Codex: no key, no budget or spending cap, no cost. Masks are an
  // Images API feature; references go to Codex as reference images.
  private async generateCodex(root: string, prompt: string, input: ArtGenerateInput, codex: CodexImages): Promise<ArtItem[]> {
    if (input.maskPath) throw new Error('Masks need the OpenAI API image backend (Art page settings). Codex edits from a description and reference images only.')
    const q = this.resolveRequest(input)
    const refs = await Promise.all(q.refs.map((r) => this.readReference(root, r)))
    const full = fullPrompt(prompt, q.style, q.transparent)
    const job = randomUUID().slice(0, 8)
    this.deps.onProgress?.({ id: job, stage: 'generating', detail: `Codex · ${Math.min(q.n, 4)} image${q.n === 1 ? '' : 's'}` })
    let res: { images: Buffer[]; notes: string[] }
    try {
      res = await this.slot(() => codex.generate({ prompt: full, n: q.n, size: q.size, transparent: q.transparent, references: refs.map((r) => r.dataUrl) }))
    } catch (error) {
      this.deps.onProgress?.({ id: job, stage: 'failed', detail: (error as Error).message })
      throw error
    }
    const items = await this.writeCodexItems(root, res.images, { prompt, full, style: q.style, transparent: q.transparent, refs: refs.map((r) => r.path), slug: input.slug, source: input.source ?? 'page' })
    const notes = res.notes.length ? ` · ${res.notes.join(' ')}` : ''
    this.deps.onProgress?.({ id: job, stage: 'done', detail: `${items.length} image${items.length === 1 ? '' : 's'} (Codex)${notes}` })
    this.deps.onChanged?.(root)
    return items
  }

  // Codex images as concepts: art/concepts/<day>/<slug>-<n>.<ext> plus the sidecar, then the git policy.
  private async writeCodexItems(
    root: string,
    images: Buffer[],
    o: { prompt: string; full: string; style: ArtItem['style']; transparent: boolean; refs: string[]; slug?: string; source: ArtItem['source'] }
  ): Promise<ArtItem[]> {
    const date = dayOf(this.now())
    const slug = slugify(o.slug || o.prompt)
    const dir = join(root, ...CONCEPTS_DIR.split('/'), date)
    let index = await nextIndex(dir, slug)
    const items: ArtItem[] = []
    for (const bytes of images) {
      const size = pngSize(bytes)
      const mime = mimeOf(bytes)
      const outputFormat = mime === 'image/jpeg' ? ('jpeg' as const) : mime === 'image/webp' ? ('webp' as const) : ('png' as const)
      const item = await writeConcept(
        root,
        {
          path: `${CONCEPTS_DIR}/${date}/${slug}-${index}.${outputFormat === 'jpeg' ? 'jpg' : outputFormat}`,
          date,
          slug,
          index,
          prompt: o.prompt,
          fullPrompt: o.full,
          style: o.style,
          model: CODEX_IMAGE_MODEL,
          size: size ? `${size.width}x${size.height}` : 'auto',
          quality: 'auto',
          background: o.transparent ? 'transparent' : 'auto',
          outputFormat,
          mode: o.refs.length ? 'edit' : 'generate',
          ...(o.refs.length ? { referencePaths: o.refs } : {}),
          seed: null,
          costUsd: 0,
          createdAt: new Date(this.now()).toISOString(),
          bytes: bytes.byteLength,
          ...(size ? { width: size.width, height: size.height } : {}),
          source: o.source
        },
        bytes
      )
      items.push(item)
      index++
    }
    const policy = this.settings(root).gitPolicy
    if (policy !== 'track' || items.some((i) => i.bytes > 5 * 1024 * 1024)) await applyGitPolicy(root, policy).catch(() => undefined)
    return items
  }

  // Images Codex made in a chat (agent/codex/imageSink.ts): saved like the Art page's Codex images,
  // with the chat request as the prompt, so the Art page lists them. Needs an open project.
  async saveGenerated(input: { images: Buffer[]; prompt: string }): Promise<ArtItem[]> {
    const root = this.root()
    const prompt = input.prompt.trim().slice(0, 4000) || 'Image made by Codex in a chat'
    if (!input.images.length) return []
    const items = await this.writeCodexItems(root, input.images, { prompt, full: prompt, style: 'none', transparent: false, refs: [], source: 'agent' })
    this.deps.onChanged?.(root)
    return items
  }

  // ------------------------------------------------------------ thumbnails

  async thumbnail(rel: string, full = false): Promise<string> {
    const root = this.root()
    const item = await readItem(root, rel)
    if (!item) throw new Error(`${rel} does not exist`)
    const bytes = await readFile(item.absPath)
    if (full || !this.deps.thumbnail || !this.deps.thumbDir) return toDataUrl(bytes)
    const s = await stat(item.absPath)
    const key = `${this.deps.scope(root)}-${item.path.replace(/[^\w.-]+/g, '_')}-${Math.round(s.mtimeMs)}.png`
    const cached = join(this.deps.thumbDir, key)
    const hit = await readFile(cached).catch(() => null)
    if (hit) return toDataUrl(hit)
    const small = await this.deps.thumbnail(bytes, 320).catch(() => null)
    if (!small) return toDataUrl(bytes)
    await mkdir(this.deps.thumbDir, { recursive: true }).catch(() => undefined)
    await writeFile(cached, small).catch(() => undefined)
    return toDataUrl(small)
  }

  // ------------------------------------------------------------ delete / undo

  async remove(rel: string): Promise<{ undoId: string }> {
    const root = this.root()
    const id = randomUUID()
    const { files } = await trashConcept(root, rel, this.deps.trashDir, id)
    this.trash.set(id, { root, files, at: this.now() })
    this.deps.onChanged?.(root)
    return { undoId: id }
  }

  async undoRemove(id: string): Promise<ArtItem | null> {
    const t = this.trash.get(id)
    if (!t) return null
    await restoreConcept(this.deps.trashDir, id, t.files)
    this.trash.delete(id)
    this.deps.onChanged?.(t.root)
    const img = t.files.find((f) => /\.(png|webp|jpe?g)$/i.test(f))
    return img ? readItem(t.root, insideRoot(t.root, img)!) : null
  }

  // ------------------------------------------------------------ save / import

  async saveToProject(rel: string, name?: string): Promise<ArtItem> {
    const root = this.root()
    const item = await readItem(root, rel)
    if (!item) throw new Error(`${rel} does not exist`)
    const base = registryName(name || item.slug)
    const target = `${UI_DIR}/${base}.${item.outputFormat === 'jpeg' ? 'jpg' : item.outputFormat}`
    const abs = join(root, ...target.split('/'))
    await mkdir(dirname(abs), { recursive: true })
    await copyFile(item.absPath, abs)
    const next = { ...item, savedAs: target }
    await writeSidecar(root, next)
    this.deps.onChanged?.(root)
    return next
  }

  async registry(): Promise<ArtRegistryEntry[]> {
    const root = this.deps.root()
    if (!root) return []
    const text = await readFile(join(root, ...REGISTRY_PATH.split('/')), 'utf8').catch(() => '')
    return parseRegistry(text)
  }

  async writeRegistry(root: string, name: string, uri: string): Promise<{ path: string; name: string; changed: boolean }> {
    const abs = join(root, ...REGISTRY_PATH.split('/'))
    const existing = await readFile(abs, 'utf8').catch(() => null)
    const agents = await readFile(join(root, 'AGENTS.md'), 'utf8').catch(() => null)
    const { text, changed } = upsertRegistry(existing, { name, uri }, { comments: !forbidsComments(agents) })
    if (changed) {
      await mkdir(dirname(abs), { recursive: true })
      await writeFile(abs, text)
    }
    return { path: REGISTRY_PATH, name, changed }
  }

  async importToRoblox(input: ArtImportInput): Promise<ArtImportResult> {
    const root = this.root()
    const item = await readItem(root, input.path)
    if (!item) throw new Error(`${input.path} does not exist`)
    const key = await this.deps.robloxKey()
    if (!key) throw new Error('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    const s = this.settings(root)
    const name = registryName(input.name || item.slug)
    const assetType = input.assetType ?? s.assetType
    const job = randomUUID().slice(0, 8)
    const bytes = await readFile(item.absPath)
    const result = await this.uploadBytes({ key: key.key, bytes, fileName: item.absPath.split(/[\\/]/).pop()!, name, description: item.prompt, assetType, job })
    const next: ArtItem = { ...item, roblox: { assetId: result.assetId, uri: result.uri, assetType, name, uploadedAt: new Date(this.now()).toISOString(), ...(result.moderation ? { moderation: result.moderation } : {}) } }
    await writeSidecar(root, next)
    const registry = input.registry === false ? undefined : await this.writeRegistry(root, name, result.uri)
    this.deps.onProgress?.({ id: job, stage: 'done', detail: result.uri })
    this.deps.onChanged?.(root)
    return { item: next, assetId: result.assetId, uri: result.uri, ...(registry ? { registry } : {}) }
  }

  // The Open Cloud key (Art, else Release); throws the page's message when there is none.
  async requireRobloxKey(): Promise<string> {
    const key = await this.deps.robloxKey()
    if (!key) throw new Error('No Open Cloud API key with asset:read + asset:write. Add one on the Art page.')
    return key.key
  }

  // One Open Cloud Image (or Decal) upload with the Art page's creator; the key is never logged.
  async uploadBytes(o: { key: string; bytes: Buffer; fileName: string; name: string; description: string; assetType?: 'Image' | 'Decal'; job?: string }) {
    const s = this.settings(this.root())
    const job = o.job ?? randomUUID().slice(0, 8)
    return uploadImageAsset({
      apiKey: o.key,
      bytes: o.bytes,
      fileName: o.fileName,
      displayName: o.name,
      description: o.description.slice(0, 900),
      assetType: o.assetType ?? s.assetType,
      creator: { userId: s.creatorUserId, groupId: s.creatorGroupId },
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      now: this.deps.now,
      onProgress: (stage) => this.deps.onProgress?.({ id: job, stage, detail: o.name })
    })
  }
}

function sanitize(s: ArtSettings): ArtSettings {
  const out: ArtSettings = {
    model: ART_MODELS.includes(s.model) ? s.model : DEFAULT_SETTINGS.model,
    quality: QUALITIES.includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    gitPolicy: (['track-small', 'track', 'ignore'] as const).includes(s.gitPolicy) ? s.gitPolicy : DEFAULT_SETTINGS.gitPolicy,
    dailyCapUsd: typeof s.dailyCapUsd === 'number' && s.dailyCapUsd >= 0 && Number.isFinite(s.dailyCapUsd) ? s.dailyCapUsd : DEFAULT_SETTINGS.dailyCapUsd,
    assetType: s.assetType === 'Decal' ? 'Decal' : 'Image',
    ...(backendOf(s.backend) === 'codex' ? { backend: 'codex' as const } : {})
  }
  const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined)
  const u = id(s.creatorUserId)
  const g = id(s.creatorGroupId)
  if (g) out.creatorGroupId = g
  else if (u) out.creatorUserId = u
  return out
}
