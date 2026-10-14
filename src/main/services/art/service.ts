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

export const ART_MODELS: ArtModel[] = ['gpt-image-2.5-flare', 'gpt-image-2.5-sunburst', 'gpt-image-2', 'gpt-image-1.5', 'gpt-image-1-mini']
export const DEFAULT_SETTINGS: ArtSettings = { model: 'gpt-image-2.5-flare', quality: 'high', gitPolicy: 'track-small', dailyCapUsd: 5, assetType: 'Image' }
const QUALITIES: ArtQuality[] = ['low', 'medium', 'high', 'xhigh', 'max', 'auto']
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
// Agent calls are capped harder than the page.
export const AGENT_MAX_VARIANTS = 4

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
}

export class ArtService {
  private deps: ArtServiceDeps
  private trash = new Map<string, { root: string; files: string[]; at: number }>()
  private running = 0
  private queue: (() => void)[] = []
  private lastRequest = 0

  constructor(deps: ArtServiceDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private root(): string {
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
    if (patch.gitPolicy && patch.gitPolicy !== cur.gitPolicy) await applyGitPolicy(r, next.gitPolicy)
    return this.status()
  }

  async status(): Promise<ArtStatus> {
    const r = this.deps.root()
    const roblox = await this.deps.robloxKey().catch(() => null)
    return {
      project: !!r,
      openaiKey: !!(await this.deps.openAiKey().catch(() => null)),
      robloxKey: !!roblox,
      ...(roblox ? { robloxKeySource: roblox.source } : {}),
      settings: this.settings(r),
      styles: STYLE_PRESETS,
      models: ART_MODELS
    }
  }

  // ------------------------------------------------------------ listing

  async list(): Promise<ArtItem[]> {
    const r = this.deps.root()
    return r ? listConcepts(r) : []
  }

  async spentToday(): Promise<number> {
    const today = dayOf(this.now())
    return round((await this.list()).filter((i) => i.date === today).reduce((s, i) => s + (i.costUsd || 0), 0))
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
    const result = await uploadImageAsset({
      apiKey: key.key,
      bytes,
      fileName: item.absPath.split(/[\\/]/).pop()!,
      displayName: name,
      description: item.prompt.slice(0, 900),
      assetType,
      creator: { userId: s.creatorUserId, groupId: s.creatorGroupId },
      fetch: this.deps.fetch,
      sleep: this.deps.sleep,
      now: this.deps.now,
      onProgress: (stage) => this.deps.onProgress?.({ id: job, stage, detail: name })
    })
    const next: ArtItem = { ...item, roblox: { assetId: result.assetId, uri: result.uri, assetType, name, uploadedAt: new Date(this.now()).toISOString(), ...(result.moderation ? { moderation: result.moderation } : {}) } }
    await writeSidecar(root, next)
    const registry = input.registry === false ? undefined : await this.writeRegistry(root, name, result.uri)
    this.deps.onProgress?.({ id: job, stage: 'done', detail: result.uri })
    this.deps.onChanged?.(root)
    return { item: next, assetId: result.assetId, uri: result.uri, ...(registry ? { registry } : {}) }
  }
}

function sanitize(s: ArtSettings): ArtSettings {
  const out: ArtSettings = {
    model: ART_MODELS.includes(s.model) ? s.model : DEFAULT_SETTINGS.model,
    quality: QUALITIES.includes(s.quality) ? s.quality : DEFAULT_SETTINGS.quality,
    gitPolicy: (['track-small', 'track', 'ignore'] as const).includes(s.gitPolicy) ? s.gitPolicy : DEFAULT_SETTINGS.gitPolicy,
    dailyCapUsd: typeof s.dailyCapUsd === 'number' && s.dailyCapUsd >= 0 && Number.isFinite(s.dailyCapUsd) ? s.dailyCapUsd : DEFAULT_SETTINGS.dailyCapUsd,
    assetType: s.assetType === 'Decal' ? 'Decal' : 'Image'
  }
  const id = (v: unknown) => (typeof v === 'number' && Number.isSafeInteger(v) && v > 0 ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined)
  const u = id(s.creatorUserId)
  const g = id(s.creatorGroupId)
  if (g) out.creatorGroupId = g
  else if (u) out.creatorUserId = u
  return out
}
