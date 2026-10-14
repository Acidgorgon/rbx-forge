// Video references for the VFX Lab and the Animation Lab. The renderer decodes the clip (HTML video
// + canvas, WebCodecs ImageDecoder for GIFs; no ffmpeg) and analyses it with shared/videoref; this
// service stores the result as a library entry of kind 'media' in the lab's own store (user or
// project scope, so it rides along in .forgepack export / sync), writes the contact sheet, key
// frames and (small enough) source file, and asks the vision model (critic tier) for a structured
// description. ref_import decodes a path through an offscreen renderer window (deps.decode).
// No electron imports.

import { randomBytes } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import type { AnimClip, AnimEntry } from '../../../shared/anim/model.ts'
import type { VfxEntry } from '../../../shared/vfx/types.ts'
import type { LabTier } from '../../../shared/labModels.ts'
import { promptTags as vfxPromptTags } from '../../../shared/vfx/draft.ts'
import { promptTags as animPromptTags } from '../../../shared/anim/style.ts'
import { describeAnalysis, parseRefVision, refVisionPrompt, refVisionSystem, sanitizeAnalysis } from '../../../shared/videoref/prompt.ts'
import type { RefDecodeOptions, RefEntry, RefLab, RefProgress, RefSaveInput, VideoRef, VideoRefAnalysis } from '../../../shared/videoref/types.ts'
import type { AnimService } from '../anim/service.ts'
import { animEntryId, type AnimStore } from '../anim/library.ts'
import type { VfxService } from '../vfx/service.ts'
import { entryId, safeFileName, type VfxStore } from '../vfx/library.ts'
import { refImages } from './refs.ts'

export type ModelFn = (system: string, prompt: string, images: { mime: string; base64: string }[]) => Promise<string>

// What the offscreen decoder returns for a path (the renderer's decode + analysis, PNG data URLs).
export interface DecodedRef {
  source: { name: string; mime: string; bytes: number; width: number; height: number; duration: number }
  trim: { start: number; end: number }
  crop?: RefSaveInput['crop']
  analysis: VideoRefAnalysis
  sheet: string
  keyFrames: RefSaveInput['keyFrames']
}

export interface RefServiceDeps {
  vfx: VfxService
  anim: AnimService
  model?: (tier: LabTier) => ModelFn | null
  // Offscreen decode of a file (electron.ts); absent in tests and the browser.
  decode?: (token: string, opts: RefDecodeOptions) => Promise<DecodedRef>
  emit?: (event: 'ref:progress' | 'vfx:changed' | 'anim:changed', payload: unknown) => void
  log?: (text: string, stream?: 'info' | 'stderr') => void
  now?: () => number
}

export class RefError extends Error {}

export const REF_EXT: Record<string, string> = { '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.gif': 'image/gif' }
const MAX_SOURCE_KEEP = 25 * 1024 * 1024
const MAX_SOURCE_DECODE = 300 * 1024 * 1024
const MAX_PNG = 6 * 1024 * 1024
const PNG_URL = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/

type Hit = { lab: 'vfx'; entry: VfxEntry; store: VfxStore } | { lab: 'anim'; entry: AnimEntry; store: AnimStore }

function png(dataUrl: unknown, what: string): Buffer {
  const m = PNG_URL.exec(String(dataUrl ?? ''))
  if (!m) throw new RefError(`${what}: expected a PNG data URL`)
  const b = Buffer.from(m[1], 'base64')
  if (b.length > MAX_PNG) throw new RefError(`${what} is too large`)
  if (b[0] !== 0x89 || b[1] !== 0x50) throw new RefError(`${what} is not a PNG`)
  return b
}

const cleanTags = (tags: unknown[]) => [...new Set(tags.map((t) => String(t).toLowerCase().trim().replace(/[^a-z0-9 -]/g, '').slice(0, 24)).filter(Boolean))].slice(0, 16)

// The placeholder clip of an Animation Lab video reference: no keys, its beats from the analysis.
export function placeholderClip(name: string, a: VideoRefAnalysis): AnimClip {
  return { name: name.replace(/[^\w]/g, '').slice(0, 40) || 'VideoRef', duration: Math.max(0.05, a.duration), looped: false, priority: 'Action', tracks: {}, markers: [], beats: a.segments.map((s) => ({ at: s.start, label: s.label })) }
}

export class RefService {
  private deps: RefServiceDeps
  private now: () => number
  private tokens = new Map<string, { path: string; at: number }>()
  private describing = new Set<string>()

  constructor(deps: RefServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
  }

  private changed(lab: RefLab): void {
    this.deps.emit?.(lab === 'anim' ? 'anim:changed' : 'vfx:changed', { at: this.now() })
  }

  private progress(p: RefProgress): void {
    this.deps.emit?.('ref:progress', p)
  }

  async find(id: string): Promise<Hit | null> {
    const v = await this.deps.vfx.find(String(id ?? '')).catch(() => null)
    if (v?.entry.video) return { lab: 'vfx', entry: v.entry, store: v.store }
    const a = await this.deps.anim.find(String(id ?? '')).catch(() => null)
    if (a?.entry.video) return { lab: 'anim', entry: a.entry, store: a.store }
    return null
  }

  private async hit(id: string): Promise<Hit> {
    const h = await this.find(id)
    if (!h) throw new RefError(`no video reference "${id}"`)
    return h
  }

  toRef(h: Pick<Hit, 'lab' | 'entry'>): RefEntry {
    const e = h.entry
    return { id: e.id, lab: h.lab, scope: e.scope, name: e.name, description: e.description, tags: e.tags, notes: e.notes ?? '', ...(e.rating ? { rating: e.rating } : {}), ...(e.quality ? { quality: e.quality } : {}), createdAt: e.createdAt, updatedAt: e.updatedAt, thumbs: e.thumbs, video: e.video! }
  }

  async list(lab?: RefLab): Promise<RefEntry[]> {
    const out: RefEntry[] = []
    if (lab !== 'anim') for (const e of await this.deps.vfx.list()) if (e.video) out.push(this.toRef({ lab: 'vfx', entry: e }))
    if (lab !== 'vfx') for (const e of await this.deps.anim.list()) if (e.video) out.push(this.toRef({ lab: 'anim', entry: e }))
    return out.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async get(id: string): Promise<RefEntry> {
    return this.toRef(await this.hit(id))
  }

  async file(id: string, file: string): Promise<string | null> {
    const h = await this.find(id)
    if (!h) return null
    try {
      const bytes = await h.store.readFile(h.entry.id, String(file))
      const ext = extname(String(file)).toLowerCase()
      const mime = ext === '.png' ? 'image/png' : REF_EXT[ext] ?? 'application/octet-stream'
      return `data:${mime};base64,${bytes.toString('base64')}`
    } catch {
      return null
    }
  }

  // ------------------------------------------------------------ save

  async save(input: RefSaveInput): Promise<RefEntry> {
    const lab: RefLab = input?.lab === 'anim' ? 'anim' : 'vfx'
    const analysis = sanitizeAnalysis(input?.analysis)
    const scope: 'user' | 'project' = input.scope === 'project' ? 'project' : 'user'
    const src = input.source ?? ({} as RefSaveInput['source'])
    const name = String(input.name ?? '').trim().slice(0, 80) || basename(String(src.name ?? 'Reference'), extname(String(src.name ?? ''))) || 'Reference'
    const sheet = png(input.sheet, 'contact sheet')
    const keys = (Array.isArray(input.keyFrames) ? input.keyFrames : []).slice(0, 8).map((k, i) => ({ t: Number(k.t) || 0, label: String(k.label ?? 'key').replace(/[^a-z0-9-]/gi, '').slice(0, 20) || 'key', index: Number(k.index) || 0, bytes: png(k.png, `key frame ${i + 1}`) }))
    const store: VfxStore | AnimStore = lab === 'vfx' ? this.deps.vfx.store(scope) : this.deps.anim.store(scope)
    const id = lab === 'vfx' ? entryId(name) : animEntryId(name)
    await store.writeFile(id, 'ref/sheet.png', sheet)
    const keyFrames = []
    for (const [i, k] of keys.entries()) {
      const file = `ref/key-${i + 1}-${k.label}.png`
      await store.writeFile(id, file, k.bytes)
      keyFrames.push({ t: k.t, label: k.label, index: k.index, file })
    }
    const mime = String(src.mime ?? '').slice(0, 60) || 'video/mp4'
    let sourceFile: string | undefined
    const data = input.sourceData
    if (data && data.byteLength > 0 && data.byteLength <= MAX_SOURCE_KEEP) {
      sourceFile = `media/${safeFileName(String(src.name || `source${Object.entries(REF_EXT).find(([, m]) => m === mime)?.[0] ?? '.mp4'}`))}`
      await store.writeFile(id, sourceFile, Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    }
    const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0)
    const trimStart = Math.max(0, num(input.trim?.start))
    const video: VideoRef = {
      lab,
      source: { name: String(src.name ?? name).slice(0, 120), mime, bytes: Math.max(0, num(src.bytes)), width: Math.round(num(src.width)), height: Math.round(num(src.height)), duration: Math.max(0, num(src.duration)), ...(sourceFile ? { file: sourceFile } : {}) },
      trim: { start: trimStart, end: Math.max(trimStart, num(input.trim?.end) || trimStart + analysis.duration) },
      ...(input.crop ? { crop: { x: num(input.crop.x), y: num(input.crop.y), w: num(input.crop.w) || 1, h: num(input.crop.h) || 1 } } : {}),
      analysis: { ...analysis, keyFrames },
      sheet: 'ref/sheet.png'
    }
    const now = this.now()
    const tags = cleanTags([...(input.tags ?? []), ...(lab === 'vfx' ? vfxPromptTags(name) : animPromptTags(name)), 'video'])
    const thumb = keyFrames.find((k) => k.label === 'impact')?.file ?? keyFrames[Math.floor(keyFrames.length / 2)]?.file ?? 'ref/sheet.png'
    const common = { id, scope, kind: 'media' as const, name, description: describeAnalysis(video.analysis, lab), tags, notes: String(input.notes ?? '').slice(0, 2000), createdAt: now, updatedAt: now, origin: video.source.name, thumbs: [thumb, 'ref/sheet.png'], quality: 'reference' as const, video }
    let saved: VfxEntry | AnimEntry
    if (lab === 'vfx') saved = await (store as VfxStore).save({ ...common, ...(sourceFile ? { media: [{ file: sourceFile, mime }] } : {}) })
    else saved = await (store as AnimStore).save({ ...common, clip: placeholderClip(name, video.analysis) })
    this.changed(lab)
    const out = this.toRef({ lab, entry: saved } as Hit)
    if (input.describe !== false && this.deps.model?.('critic')) {
      void this.describe(id).catch((e) => this.deps.log?.(`ref: vision summary failed: ${(e as Error).message}`, 'stderr'))
    }
    return out
  }

  // ------------------------------------------------------------ vision summary

  canDescribe(): boolean {
    return !!this.deps.model?.('critic')
  }

  async describe(id: string): Promise<RefEntry> {
    const h = await this.hit(id)
    const model = this.deps.model?.('critic')
    if (!model) throw new RefError('No vision model is set up (Settings → Labs, critic tier).')
    if (this.describing.has(h.entry.id)) throw new RefError('already describing this reference')
    this.describing.add(h.entry.id)
    this.progress({ id: h.entry.id, phase: 'describe' })
    try {
      const video = h.entry.video!
      const { images, keyLabels } = await refImages(video, (f) => h.store.readFile(h.entry.id, f), { sheet: true })
      const raw = await model(refVisionSystem(h.lab), refVisionPrompt(video, h.entry.name, keyLabels), images)
      const vision = parseRefVision(raw, this.now(), undefined, h.lab)
      const cur = (await this.find(id)) ?? h
      const next = { ...cur.entry, video: { ...cur.entry.video!, vision }, description: `${vision.summary} ${describeAnalysis(video.analysis, h.lab)}`.slice(0, 1200), updatedAt: this.now() }
      const saved = h.lab === 'vfx' ? await (cur.store as VfxStore).save(next as VfxEntry) : await (cur.store as AnimStore).save(next as AnimEntry)
      this.changed(h.lab)
      this.progress({ id: h.entry.id, phase: 'done', message: vision.summary })
      return this.toRef({ lab: h.lab, entry: saved } as Hit)
    } catch (e) {
      this.progress({ id: h.entry.id, phase: 'error', message: (e as Error).message })
      throw e
    } finally {
      this.describing.delete(h.entry.id)
    }
  }

  // ------------------------------------------------------------ import from a path (ref_import)

  // A short-lived token the offscreen decoder uses to read exactly this file (refDecodeSource).
  registerSource(path: string): string {
    const token = randomBytes(12).toString('hex')
    const now = this.now()
    for (const [k, v] of this.tokens) if (now - v.at > 10 * 60_000) this.tokens.delete(k)
    this.tokens.set(token, { path, at: now })
    return token
  }

  releaseSource(token: string): void {
    this.tokens.delete(token)
  }

  async sourceForToken(token: string): Promise<{ name: string; mime: string; bytes: Uint8Array } | null> {
    const t = this.tokens.get(String(token ?? ''))
    if (!t) return null
    const mime = REF_EXT[extname(t.path).toLowerCase()]
    if (!mime) return null
    const bytes = await readFile(t.path)
    return { name: basename(t.path), mime, bytes: new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength) }
  }

  async importPath(path: string, opts: { lab?: RefLab; scope?: 'user' | 'project'; name?: string; tags?: string[]; notes?: string; start?: number; end?: number; describe?: boolean } = {}): Promise<RefEntry> {
    const p = String(path ?? '').trim()
    const mime = REF_EXT[extname(p).toLowerCase()]
    if (!mime) throw new RefError(`unsupported file type "${extname(p) || p}" (mp4, webm, mov or gif)`)
    const s = await stat(p).catch(() => null)
    if (!s?.isFile()) throw new RefError(`no such file: ${p}`)
    if (s.size > MAX_SOURCE_DECODE) throw new RefError('the file is too large (300 MB max)')
    if (!this.deps.decode) throw new RefError('Decoding a video from a path needs the desktop app (an offscreen renderer window).')
    const token = this.registerSource(p)
    let decoded: DecodedRef
    try {
      decoded = await this.deps.decode(token, { start: opts.start, end: opts.end })
    } finally {
      this.releaseSource(token)
    }
    const data = s.size <= MAX_SOURCE_KEEP ? await readFile(p) : undefined
    const saved = await this.save({
      lab: opts.lab ?? 'vfx',
      scope: opts.scope,
      name: opts.name || basename(p, extname(p)),
      tags: opts.tags,
      notes: opts.notes,
      source: { ...decoded.source, name: basename(p), mime, bytes: s.size },
      ...(data ? { sourceData: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) } : {}),
      trim: decoded.trim,
      crop: decoded.crop,
      analysis: decoded.analysis,
      sheet: decoded.sheet,
      keyFrames: decoded.keyFrames,
      describe: false
    })
    if (opts.describe !== false && this.canDescribe()) return this.describe(saved.id).catch((e) => (this.deps.log?.(`ref: vision summary failed: ${(e as Error).message}`, 'stderr'), saved))
    return saved
  }
}
