// Bringing existing textures into the VFX texture library: image files and whole folders (PNG / JPG,
// recursive), pasted Roblox asset ids, and the ids the open Studio place already uses. A scan
// analyses everything (kind, colour, edge, flipbook grid, duplicates; names from the vision model
// when one is configured) and keeps the prepared images in memory; the Lab shows the rows for review
// and commits the ones the user keeps. No electron imports: JPEG decoding, the vision model and the
// Studio sources come in as functions.

import { createHash, randomBytes } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { basename, extname, join, relative, dirname } from 'node:path'
import { analyzeTexture, autoTags, summary, workingCopy, type TextureAnalysis } from '../../../../shared/vfx/tex/analyze.ts'
import { premultipliedPreview, resample, type Rgba } from '../../../../shared/vfx/tex/image.ts'
import { importName, kindFromPath, markDuplicates, parseAssetIds, parseVisionTags, planFlipbook, prepareImport, IMPORT_IMAGE_EXT, MAX_IMPORT_FILES, VISION_TAG_SYSTEM, type FlipbookPlan } from '../../../../shared/vfx/tex/import.ts'
import { collectHarvest, harvestCandidates, harvestFromTree, harvestJob, type HarvestCandidate, type HarvestUse } from '../../../../shared/vfx/tex/harvest.ts'
import { kindFromText, TEXTURE_KINDS, type TextureKind, type TextureScope, type VfxTexture } from '../../../../shared/vfx/tex/textures.ts'
import type { TextureImportCommit, TextureImportRow, TextureImportScan } from '../../../../shared/vfxTextureTypes.ts'
import type { BridgeJob } from '../../../../shared/studio/protocol.ts'
import { decodePng, encodePng } from './png.ts'
import { TextureError, textureId, type TextureStore } from './store.ts'

const MAX_FILE_BYTES = 40 * 1024 * 1024
const MAX_IDS = 200
const SCAN_TTL_MS = 30 * 60_000
const VISION_BATCH = 8
const VISION_MAX = 48
const NET_TIMEOUT_MS = 8000

export type VisionFn = (system: string, prompt: string, images: { mime: string; base64: string }[]) => Promise<string>

export interface BytesResponse {
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
  arrayBuffer(): Promise<ArrayBuffer>
}
export type BytesFetch = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<BytesResponse>

export interface StudioHarvestDeps {
  // Forge Sync's live Studio tree for the open place (null when Forge Sync has none).
  liveTree?: () => { nodes: { path: string[]; className: string; props?: Record<string, unknown> }[] } | null
  bridge?: {
    port: number
    listening: boolean
    connected(): boolean
    run(job: BridgeJob, handler: (ev: { type: string; message?: string }, at: number) => unknown, opts?: { acceptTimeoutMs?: number; timeoutMs?: number }): Promise<void>
  }
}

export interface ImporterDeps {
  // The store a commit writes into, and every texture (for duplicates).
  storeFor(scope: TextureScope | undefined): TextureStore
  list(): Promise<VfxTexture[]>
  changed(): void
  // Decodes JPEG (and anything else that is not PNG) to RGBA; PNG is decoded here.
  decodeImage?: (bytes: Buffer, ext: string) => Rgba | null
  fetch?: BytesFetch
  vision?: () => VisionFn | null
  studio?: StudioHarvestDeps
  now?: () => number
  log?: (text: string, stream?: 'info' | 'stderr') => void
}

interface Pending {
  row: TextureImportRow
  image?: Rgba
  plan?: FlipbookPlan | null
  hash?: string
  analysis?: TextureAnalysis
  // Asset imports: the preview image (when it could be fetched) and the moderation guess.
  assetPreview?: Rgba
  moderation?: 'Approved' | 'Reviewing' | 'Rejected' | 'Unknown'
}

export function pixelHash(img: Rgba): string {
  const h = createHash('sha256')
  h.update(`${img.width}x${img.height}:`)
  h.update(Buffer.from(img.data.buffer, img.data.byteOffset, img.data.byteLength))
  return h.digest('hex').slice(0, 24)
}

function thumbUrl(img: Rgba, side = 96): string {
  const k = side / Math.max(img.width, img.height)
  const small = k < 1 ? resample(img, Math.max(1, Math.round(img.width * k)), Math.max(1, Math.round(img.height * k))) : img
  return `data:image/png;base64,${encodePng(premultipliedPreview(small)).toString('base64')}`
}

const pngB64 = (img: Rgba) => encodePng(premultipliedPreview(img)).toString('base64')

export class TextureImporter {
  private deps: ImporterDeps
  private scans = new Map<string, { at: number; rows: Map<string, Pending> }>()
  private now: () => number

  constructor(deps: ImporterDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  private remember(rows: Pending[], notes: string[]): TextureImportScan {
    for (const [k, v] of this.scans) if (this.now() - v.at > SCAN_TTL_MS) this.scans.delete(k)
    const scanId = `scan-${randomBytes(6).toString('hex')}`
    this.scans.set(scanId, { at: this.now(), rows: new Map(rows.map((p) => [p.row.key, p])) })
    return { scanId, rows: rows.map((p) => p.row), notes }
  }

  // ------------------------------------------------------------ files

  // Image files under the given paths (folders recursively), with the label relative to what was
  // picked. Hidden files and folders are skipped.
  async collectFiles(paths: string[]): Promise<{ abs: string; label: string }[]> {
    const out: { abs: string; label: string }[] = []
    const walk = async (abs: string, base: string, depth: number) => {
      if (out.length >= MAX_IMPORT_FILES || depth > 12) return
      const s = await stat(abs).catch(() => null)
      if (!s) return
      if (s.isDirectory()) {
        const names = (await readdir(abs).catch(() => [] as string[])).filter((n) => !n.startsWith('.')).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        for (const n of names) await walk(join(abs, n), base, depth + 1)
        return
      }
      if (!s.isFile() || !(IMPORT_IMAGE_EXT as readonly string[]).includes(extname(abs).toLowerCase())) return
      out.push({ abs, label: relative(base, abs) || basename(abs) })
    }
    for (const p of paths.map(String).filter(Boolean)) {
      const s = await stat(p).catch(() => null)
      await walk(p, s?.isDirectory() ? dirname(p) : dirname(p), 0)
    }
    return out
  }

  decode(bytes: Buffer, ext: string): Rgba {
    if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return decodePng(bytes)
    const img = this.deps.decodeImage?.(bytes, ext) ?? null
    if (!img) throw new TextureError(ext === '.png' ? 'not a readable PNG' : `cannot read ${ext || 'this'} files here`)
    return img
  }

  async scanFiles(paths: string[], opts: { vision?: boolean } = {}): Promise<TextureImportScan> {
    const files = await this.collectFiles(paths)
    const notes: string[] = []
    if (!files.length) notes.push('No PNG or JPG files found there.')
    if (files.length >= MAX_IMPORT_FILES) notes.push(`Only the first ${MAX_IMPORT_FILES} images are scanned; import the rest in another batch.`)
    const rows: Pending[] = []
    for (const [i, f] of files.entries()) {
      const key = `f${i}`
      const name = importName(f.label)
      const base: TextureImportRow = { key, from: 'file', label: f.label, name, kind: 'other', tags: [], description: '', flipbook: null, notes: [] }
      try {
        const s = await stat(f.abs)
        if (s.size > MAX_FILE_BYTES) throw new TextureError('larger than 40 MB')
        const img = this.decode(await readFile(f.abs), extname(f.abs).toLowerCase())
        if (img.width > 8192 || img.height > 8192) throw new TextureError('larger than 8192 px')
        rows.push(this.analyzeFile(base, img))
      } catch (e) {
        rows.push({ row: { ...base, error: (e as Error).message } })
      }
      // Big folders: let the event loop breathe between images.
      if (i % 8 === 7) await new Promise((r) => setImmediate(r))
    }
    const existing = new Map<string, string>()
    for (const t of await this.deps.list()) if (t.origin?.hash) existing.set(t.origin.hash, t.id)
    const marked = markDuplicates(
      rows.map((p) => ({ ...p.row, hash: p.hash })),
      existing
    )
    const labels = new Map(rows.map((p) => [p.row.key, p.row.label]))
    for (const [i, m] of marked.entries()) if (m.duplicateOf) rows[i].row.duplicateOf = m.duplicateOf.startsWith('batch:') ? `${labels.get(m.duplicateOf.slice(6))} (earlier in this import)` : m.duplicateOf
    if (opts.vision) await this.nameWithVision(rows.filter((p) => !p.row.error && !p.row.duplicateOf), notes)
    return this.remember(rows, notes)
  }

  // Analysis of one decoded image: flipbook plan, kind (file / folder names first, then pixels),
  // colour / edge tags, the prepared image and its hash.
  analyzeFile(base: TextureImportRow, img: Rgba): Pending {
    const plan = planFlipbook(img, base.label.split(/[\\/]/).pop() ?? base.label)
    const prepared = prepareImport(img, plan)
    const first = plan ? prepared.image : img
    const sample = plan && prepared.flipbook ? cellOf(prepared.image, plan) : first
    const analysis = analyzeTexture(sample)
    const named = kindFromPath(base.label)
    const kind = named ?? analysis.kind
    const row: TextureImportRow = {
      ...base,
      kind,
      tags: autoTags({ ...summary(analysis), kind }, { flipbook: !!plan, extra: ['imported'] }),
      description: describe(analysis, kind, plan),
      flipbook: plan ? { layout: plan.layout, frames: plan.frames, cols: plan.cols, rows: plan.rows, source: plan.source } : null,
      preview: thumbUrl(prepared.image),
      color: analysis.color,
      edge: analysis.edge,
      notes: prepared.notes
    }
    return { row, image: img, plan, hash: pixelHash(img), analysis }
  }

  // ------------------------------------------------------------ asset ids

  private fetcher(): BytesFetch | null {
    if (this.deps.fetch) return this.deps.fetch
    return typeof globalThis.fetch === 'function' ? (globalThis.fetch as unknown as BytesFetch) : null
  }

  private async get(url: string): Promise<BytesResponse | null> {
    const f = this.fetcher()
    if (!f) return null
    try {
      return await f(url, { signal: AbortSignal.timeout(NET_TIMEOUT_MS) })
    } catch {
      return null
    }
  }

  // Thumbnails API (public, no auth): GET thumbnails.roblox.com/v1/assets?assetIds=..&size=420x420
  // &format=Png -> data[{targetId, state: Completed|Pending|Blocked|Error, imageUrl}].
  async thumbnails(ids: string[]): Promise<Map<string, { state: string; url?: string }> | null> {
    const out = new Map<string, { state: string; url?: string }>()
    let any = false
    for (let i = 0; i < ids.length; i += 100) {
      const res = await this.get(`https://thumbnails.roblox.com/v1/assets?assetIds=${ids.slice(i, i + 100).join(',')}&returnPolicy=PlaceHolder&size=420x420&format=Png&isCircular=false`)
      if (!res?.ok) continue
      any = true
      const body = (await res.json().catch(() => null)) as { data?: { targetId?: number | string; state?: string; imageUrl?: string }[] } | null
      for (const d of body?.data ?? []) if (d.targetId !== undefined) out.set(String(d.targetId), { state: String(d.state ?? 'Error'), ...(d.imageUrl ? { url: d.imageUrl } : {}) })
    }
    return any ? out : null
  }

  async fetchImage(url: string): Promise<Rgba | null> {
    if (!/^https:\/\/[\w.-]+\.rbxcdn\.com\//.test(url)) return null
    const res = await this.get(url)
    if (!res?.ok) return null
    const bytes = Buffer.from(await res.arrayBuffer().catch(() => new ArrayBuffer(0)))
    if (!bytes.length || bytes.length > 8 * 1024 * 1024) return null
    try {
      return this.decode(bytes, '.png')
    } catch {
      return null
    }
  }

  // Asset rows (pasted ids or Studio). hints: Studio uses per id.
  async scanAssets(ids: string[], opts: { vision?: boolean; from: 'asset' | 'studio'; hints?: Map<string, HarvestCandidate>; notes?: string[] }): Promise<TextureImportScan> {
    const notes = [...(opts.notes ?? [])]
    const list = ids.slice(0, MAX_IDS)
    if (ids.length > MAX_IDS) notes.push(`Only the first ${MAX_IDS} ids are used.`)
    const lib = await this.deps.list()
    const have = new Map(lib.filter((t) => t.roblox?.assetId).map((t) => [t.roblox!.assetId, t.id]))
    const thumbs = list.length ? await this.thumbnails(list) : new Map()
    if (list.length && !thumbs) notes.push('Roblox could not be reached for previews: the ids import without a preview (they still work in game). Previews load later with "Check".')
    const rows: Pending[] = []
    for (const [i, id] of list.entries()) {
      const hint = opts.hints?.get(id)
      const names = hint?.names ?? []
      const label = hint?.paths[0] ? `${id} · ${hint.paths[0]}` : id
      const hintText = [...names, ...(hint?.classes ?? [])].join(' ')
      const textKind = hint ? kindFromText(names.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2')) : 'other'
      const base: TextureImportRow = { key: `a${i}`, from: opts.from, label, name: names[0] ? `${names[0]}` : `Asset ${id}`, kind: textKind, tags: [], description: '', flipbook: null, notes: [], assetId: id, ...(hint ? { paths: hint.paths } : {}) }
      const th = thumbs?.get(id)
      const moderation = th ? (th.state === 'Completed' ? 'Approved' : th.state === 'Blocked' ? 'Rejected' : th.state === 'Pending' ? 'Reviewing' : 'Unknown') : 'Unknown'
      if (th?.state === 'Blocked') base.notes.push('Roblox blocks this image (moderated): it will not show in game')
      if (th && th.state === 'Error') base.notes.push('Roblox has no image for this id (not an image asset, or deleted)')
      const img = th?.url ? await this.fetchImage(th.url) : null
      let p: Pending
      if (img) {
        const analysis = analyzeTexture(img)
        const kind = textKind !== 'other' ? textKind : hint?.classes.includes('Beam') && analysis.strip ? 'beam' : hint?.classes.includes('Trail') && analysis.strip ? 'trail' : analysis.kind
        p = {
          row: { ...base, kind, tags: autoTags({ ...summary(analysis), kind }, { extra: [opts.from === 'studio' ? 'studio' : 'asset', ...(hint?.classes ?? []).map((c) => c.toLowerCase())] }), description: describe(analysis, kind, null), preview: thumbUrl(img), color: analysis.color, edge: analysis.edge },
          assetPreview: img,
          analysis,
          moderation
        }
      } else {
        const kind = textKind !== 'other' ? textKind : hint?.classes.includes('Beam') ? 'beam' : hint?.classes.includes('Trail') ? 'trail' : 'other'
        p = { row: { ...base, kind, tags: [...new Set([kind, opts.from === 'studio' ? 'studio' : 'asset', ...(hint?.classes ?? []).map((c) => c.toLowerCase())])].filter((t) => t !== 'other'), description: hintText ? `Used by ${hintText}` : '' }, moderation }
        if (thumbs) p.row.notes.push('no preview')
      }
      if (have.has(id)) p.row.duplicateOf = have.get(id)
      rows.push(p)
    }
    if (opts.vision) await this.nameWithVision(rows.filter((p) => p.assetPreview && !p.row.duplicateOf), notes)
    return this.remember(rows, notes)
  }

  async scanIds(text: string, opts: { vision?: boolean } = {}): Promise<TextureImportScan> {
    const ids = parseAssetIds(text).map((p) => p.id)
    if (!ids.length) throw new TextureError('No asset ids found. Paste rbxassetid://123, numbers, or Creator Store links (one or many).')
    return this.scanAssets(ids, { vision: opts.vision, from: 'asset' })
  }

  // ------------------------------------------------------------ Studio

  async harvest(): Promise<{ candidates: HarvestCandidate[]; notes: string[] }> {
    const notes: string[] = []
    const sources: HarvestUse[][] = []
    const studio = this.deps.studio
    const tree = studio?.liveTree?.() ?? null
    if (tree) sources.push(harvestFromTree(tree.nodes))
    const b = studio?.bridge
    let viaJob = false
    if (b?.listening && b.connected()) {
      const id = `job-tex-${randomBytes(5).toString('hex')}`
      const messages: string[] = []
      try {
        await b.run(harvestJob({ id, port: b.port }), (ev) => {
          if (ev.type === 'log' && typeof ev.message === 'string') messages.push(ev.message)
          return {}
        }, { acceptTimeoutMs: 12_000, timeoutMs: 90_000 })
        const uses = collectHarvest(messages)
        if (uses) {
          sources.push(uses)
          viaJob = true
        } else notes.push('Studio ran the scan but its list did not arrive (the plugin may lack HTTP permission for its own module); only synced instances were read.')
      } catch (e) {
        notes.push(`Studio scan failed: ${(e as Error).message}`)
      }
    } else notes.push('Roblox Studio is not connected (Forge Bridge plugin): only what Forge Sync has seen is listed.')
    if (!tree && !viaJob) throw new TextureError(`Nothing to read from Studio. Open the place in Roblox Studio with the Forge Bridge plugin on (Studio tab), or turn on Forge Sync. ${notes.join(' ')}`)
    if (!viaJob && tree) notes.push('Only Forge Sync\'s synced folders were read; connect Studio to scan the whole place (Workspace included).')
    return { candidates: harvestCandidates(...sources), notes }
  }

  async scanStudio(opts: { vision?: boolean } = {}): Promise<TextureImportScan> {
    const { candidates, notes } = await this.harvest()
    if (!candidates.length) notes.push('No ParticleEmitter, Beam or Trail in the place uses an uploaded texture id (built-in rbxasset:// textures are skipped).')
    return this.scanAssets(
      candidates.map((c) => c.id),
      { vision: opts.vision, from: 'studio', hints: new Map(candidates.map((c) => [c.id, c])), notes }
    )
  }

  // ------------------------------------------------------------ vision

  private async nameWithVision(rows: Pending[], notes: string[]): Promise<void> {
    const vision = this.deps.vision?.()
    if (!vision || !rows.length) return
    const todo = rows.slice(0, VISION_MAX)
    if (rows.length > VISION_MAX) notes.push(`The vision model named the first ${VISION_MAX}; the rest keep names from their files.`)
    for (let i = 0; i < todo.length; i += VISION_BATCH) {
      const batch = todo.slice(i, i + VISION_BATCH)
      const images = batch.map((p) => ({ mime: 'image/png', base64: pngB64(workingCopy(p.plan && p.image ? cellOf(prepareImport(p.image, p.plan).image, p.plan) : (p.assetPreview ?? p.image!), 192)) }))
      try {
        const raw = await vision(VISION_TAG_SYSTEM, batch.map((p, k) => `Image ${k + 1}: file "${p.row.label}", analysis says ${p.row.kind}${p.row.flipbook ? ` (first frame of a ${p.row.flipbook.layout} flipbook)` : ''}`).join('\n'), images)
        const tags = parseVisionTags(raw, batch.length)
        for (const [k, t] of tags.entries()) {
          if (!t) continue
          const r = batch[k].row
          if (t.name) r.name = t.name
          if (t.kind && t.kind !== 'other' && !kindFromPath(r.from === 'file' ? r.label : '')) r.kind = t.kind
          if (t.description) r.description = t.description
          if (t.tags) r.tags = [...new Set([r.kind, ...r.tags.filter((x) => !(TEXTURE_KINDS as readonly string[]).includes(x)), ...t.tags])].slice(0, 12)
          r.vision = true
        }
      } catch (e) {
        notes.push(`Vision naming skipped: ${(e as Error).message}`)
        this.deps.log?.(`textures: vision naming: ${(e as Error).message}`, 'stderr')
        return
      }
    }
  }

  // ------------------------------------------------------------ commit

  async commit(input: TextureImportCommit, save: (store: TextureStore, item: Omit<VfxTexture, 'file' | 'preview' | 'scope' | 'size'>, img: Rgba) => Promise<VfxTexture>): Promise<VfxTexture[]> {
    const scan = this.scans.get(String(input?.scanId ?? ''))
    if (!scan) throw new TextureError('This import review expired; scan the files again.')
    const store = this.deps.storeFor(input.scope)
    const out: VfxTexture[] = []
    const now = this.now()
    for (const pick of input.rows ?? []) {
      const p = scan.rows.get(String(pick.key))
      if (!p || p.row.error) continue
      const r = p.row
      const kind: TextureKind = pick.kind && (TEXTURE_KINDS as readonly string[]).includes(pick.kind) ? pick.kind : r.kind
      const name = (pick.name?.trim() || r.name).slice(0, 60)
      const tags = [...new Set([kind, ...(Array.isArray(pick.tags) ? pick.tags : r.tags).map((t) => String(t).toLowerCase().trim()).filter(Boolean)])].filter((t) => t !== 'other').slice(0, 16)
      const description = (typeof pick.description === 'string' ? pick.description : r.description).slice(0, 1000)
      const analysis = p.analysis ? summary(p.analysis) : undefined
      if (r.from === 'file' && p.image) {
        const plan = pick.flipbook === false ? null : (p.plan ?? null)
        const prepared = prepareImport(p.image, plan)
        out.push(
          await save(
            store,
            {
              id: textureId(name),
              name,
              kind,
              description,
              tags: prepared.flipbook ? [...new Set([...tags, 'flipbook'])] : tags.filter((t) => t !== 'flipbook'),
              source: 'imported',
              origin: { from: 'file', file: r.label.split(/[\\/]/).pop(), ...(p.hash ? { hash: p.hash } : {}) },
              ...(analysis ? { analysis } : {}),
              tint: 'color',
              ...(prepared.flipbook ? { flipbook: prepared.flipbook } : {}),
              createdAt: now,
              updatedAt: now
            },
            prepared.image
          )
        )
      } else if (r.assetId) {
        const img = p.assetPreview ? resample(p.assetPreview, 512, 512) : placeholder()
        out.push(
          await save(
            store,
            {
              id: textureId(name),
              name,
              kind,
              description,
              tags,
              source: 'asset',
              origin: { from: r.from === 'studio' ? 'studio' : 'asset', ...(r.paths?.length ? { paths: r.paths } : {}), ...(p.assetPreview ? {} : { noPreview: true }) },
              ...(analysis ? { analysis } : {}),
              tint: 'color',
              roblox: { assetId: r.assetId, uri: `rbxassetid://${r.assetId}`, uploadedAt: now, moderation: p.moderation ?? 'Unknown', checkedAt: now },
              createdAt: now,
              updatedAt: now
            },
            img
          )
        )
      }
    }
    if (out.length) this.deps.changed()
    return out
  }
}

function cellOf(sheet: Rgba, plan: FlipbookPlan): Rgba {
  const cols = Number(plan.layout.slice(4, 5))
  const cell = Math.floor(sheet.width / cols)
  const out = { width: cell, height: cell, data: new Uint8ClampedArray(cell * cell * 4) }
  for (let y = 0; y < cell; y++) out.data.set(sheet.data.subarray((y * sheet.width) * 4, (y * sheet.width + cell) * 4), y * cell * 4)
  return out
}

// A dim ring with a dot: "image not loaded yet" in the library (the asset id still works in game).
export function placeholder(size = 64): Rgba {
  const img = { width: size, height: size, data: new Uint8ClampedArray(size * size * 4) }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const r = Math.hypot(x + 0.5 - size / 2, y + 0.5 - size / 2) / (size / 2)
      const a = Math.max(0, 1 - Math.abs(r - 0.6) * 12) * 0.5 + Math.max(0, 1 - r * 8) * 0.5
      const i = (y * size + x) * 4
      img.data[i] = img.data[i + 1] = img.data[i + 2] = 160
      img.data[i + 3] = Math.round(Math.min(1, a) * 255)
    }
  }
  return img
}

function describe(a: TextureAnalysis, kind: TextureKind, plan: FlipbookPlan | null): string {
  const parts = [`${a.colorName === 'white' ? 'White' : a.colorName[0].toUpperCase() + a.colorName.slice(1)} ${kind === 'other' ? 'texture' : kind}`, `${a.edge} edges`, `${Math.round(a.coverage * 100)}% visible`]
  if (plan) parts.push(`${plan.frames}-frame flipbook (${plan.layout})`)
  return `${parts.join(', ')}.`
}
