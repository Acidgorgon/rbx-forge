// Upload inbox: an agent (Claude building meshes in Blender, or anything else that can write onto
// this computer) drops a file plus <id>.request.json into a folder; Forge uploads it to Roblox with
// the user's Open Cloud key and writes <id>.result.json back, then renames the request to
// <id>.request.done.json so it is never uploaded twice. No electron imports: the folder, key,
// creator, watcher and clock come in as deps (main/integrations.ts).
//
//   <id>.request.json  { "file": "relative/or/absolute.fbx", "name": "EmberstagHead", "description": "...", "assetType": "Model" }
//   <id>.result.json   { "status": "uploading" }
//                      { "status": "done", "assetId": 123, "assetType": "Model", "name": "EmberstagHead", "uploadedAt": "<ISO time>", "moderation": "Reviewing" }
//                      { "status": "error", "error": "..." }
//
// assetType: "Model" (.fbx), "Audio" (.mp3 .ogg .wav .flac), "Image" or "Decal" (.png .jpg .jpeg .bmp
// .tga). Left out, it follows the file extension (images become "Image"). Relative files resolve
// against the inbox. The file must be inside the inbox or <Documents>/ForgeModels (after resolving
// symlinks), at most 20 MB. Requests run one at a time, spaced by minIntervalMs; Forge sets no
// hourly cap. When Open Cloud itself rate limits the create request (429 after the uploader's own
// retries), nothing was uploaded: the request stays queued and the inbox pauses with a growing
// backoff (rateLimitBackoffMs, doubling up to 15 minutes) before trying again. A result that already exists means the id is handled: no second upload. The key
// is only passed to the uploader; it never reaches a log line, result file or event.

import { watch as fsWatch } from 'node:fs'
import { mkdir, readdir, readFile, realpath, rename, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import type { ModelInboxEntry } from '../../../shared/artTypes.ts'
import { AssetUploadError, AUDIO_CONTENT_TYPES, isRateLimitedBeforeCreate, IMAGE_CONTENT_TYPES, MAX_UPLOAD_BYTES, uploadAudioAsset, uploadMediaImageAsset, uploadModelAsset, type Creator } from './robloxAssets.ts'
import { defaultSleep, type ArtFetch, type Sleep } from './openaiImages.ts'

export const REQUEST_SUFFIX = '.request.json'
export const RESULT_SUFFIX = '.result.json'
export const DONE_SUFFIX = '.request.done.json'
export const MODELS_DIR_NAME = 'ForgeModels'
export const INBOX_DIR_NAME = '_upload_inbox'
const MAX_REQUEST_BYTES = 64 * 1024

export const NO_KEY_ERROR = 'No Open Cloud API key is set in Forge (Art page > Roblox import, Assets API with asset:read + asset:write), so Forge cannot upload assets.'
export const NO_CREATOR_ERROR = 'No Roblox creator is set in Forge (Art page > Roblox import: your user ID or a group ID), so Forge does not know who should own the asset.'

export function inboxDirs(documentsDir: string): { modelsDir: string; inboxDir: string } {
  const modelsDir = join(documentsDir, MODELS_DIR_NAME)
  return { modelsDir, inboxDir: join(modelsDir, INBOX_DIR_NAME) }
}

// ---------------------------------------------------------------- request validation

export type InboxAssetType = 'Model' | 'Audio' | 'Image' | 'Decal'
export const INBOX_ASSET_TYPES: readonly InboxAssetType[] = ['Model', 'Audio', 'Image', 'Decal']

export interface InboxRequest {
  file: string
  name: string
  description?: string
  assetType: InboxAssetType
}

// The file kind each asset type takes (resolveModelFile's kind).
export const KIND_OF: Record<InboxAssetType, 'fbx' | 'audio' | 'image'> = { Model: 'fbx', Audio: 'audio', Image: 'image', Decal: 'image' }

const extOf = (file: string) => /\.([a-z0-9]+)$/i.exec(file.trim())?.[1]?.toLowerCase() ?? ''

export function assetTypeForFile(file: string): InboxAssetType | null {
  const ext = extOf(file)
  if (ext === 'fbx') return 'Model'
  if (AUDIO_CONTENT_TYPES[ext]) return 'Audio'
  if (IMAGE_CONTENT_TYPES[ext]) return 'Image'
  return null
}

type Check<T> = { ok: true; value: T } | { ok: false; error: string }

const RequestSchema = z.object({
  file: z.string().min(1).max(1024),
  name: z.string().max(200),
  description: z.string().max(1000).optional(),
  assetType: z.string().optional()
})

export function parseRequest(text: string): Check<InboxRequest> {
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    return { ok: false, error: 'The request is not valid JSON' }
  }
  const parsed = RequestSchema.safeParse(json)
  if (!parsed.success) return { ok: false, error: `Bad request: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'request'}: ${i.message}`).join('; ')}` }
  const r = parsed.data
  // Case-insensitive ("audio", "decal"), canonicalised to Roblox's spelling.
  const named = r.assetType === undefined ? undefined : INBOX_ASSET_TYPES.find((t) => t.toLowerCase() === r.assetType!.trim().toLowerCase())
  if (r.assetType !== undefined && !named) return { ok: false, error: `assetType "${r.assetType}" is not supported here; use ${INBOX_ASSET_TYPES.map((t) => `"${t}"`).join(', ')}` }
  const byFile = assetTypeForFile(r.file)
  const assetType = named ?? byFile
  if (!assetType) return { ok: false, error: `Bad request: cannot tell the asset type of ${r.file}; upload .fbx (Model), .mp3/.ogg/.wav/.flac (Audio) or .png/.jpg/.bmp/.tga (Image or Decal)` }
  if (byFile && KIND_OF[byFile] !== KIND_OF[assetType]) return { ok: false, error: `Bad request: assetType "${assetType}" does not match the file ${r.file}` }
  const name = r.name.trim()
  if (!name) return { ok: false, error: 'Bad request: name is empty' }
  // Roblox display names are capped at 50 characters.
  if (name.length > 50) return { ok: false, error: 'Bad request: name is longer than 50 characters' }
  if (/[\u0000-\u001f]/.test(name) || r.file.includes('\0')) return { ok: false, error: 'Bad request: control characters in name or file' }
  return { ok: true, value: { file: r.file, name, ...(r.description?.trim() ? { description: r.description.trim() } : {}), assetType } }
}

function inside(child: string, root: string): boolean {
  const rel = relative(root, child)
  return rel === '' ? false : !rel.startsWith('..') && !isAbsolute(rel)
}

// Resolves a request's file (relative to baseDir) and refuses anything outside the allowed roots,
// any ".." segment, symlinks that lead out, other file types (kind 'fbx': .fbx for Model uploads;
// 'audio' / 'image': Audio and Image/Decal uploads; 'model': .rbxm / .rbxmx for Studio inserts),
// missing, empty and oversized files.
const FILE_KINDS = {
  fbx: { label: 'FBX', test: (raw: string) => /\.fbx$/i.test(raw), only: 'only .fbx files are uploaded as models' },
  model: { label: 'model file', test: (raw: string) => /\.rbxmx?$/i.test(raw), only: 'only .rbxm and .rbxmx files are inserted' },
  audio: { label: 'audio file', test: (raw: string) => !!AUDIO_CONTENT_TYPES[extOf(raw)], only: 'only .mp3, .ogg, .wav and .flac files are uploaded as audio' },
  image: { label: 'image', test: (raw: string) => !!IMAGE_CONTENT_TYPES[extOf(raw)], only: 'only .png, .jpg, .jpeg, .bmp and .tga files are uploaded as images' }
} as const

export async function resolveModelFile(file: string, opts: { baseDir: string; roots: string[]; maxBytes?: number; kind?: keyof typeof FILE_KINDS }): Promise<Check<{ abs: string; size: number; mtimeMs: number }>> {
  const raw = file.trim()
  const model = opts.kind === 'model'
  const kind = FILE_KINDS[opts.kind ?? 'fbx']
  const label = kind.label
  if (!raw) return { ok: false, error: 'No file given' }
  if (raw.split(/[\\/]+/).includes('..')) return { ok: false, error: `Refused ${raw}: ".." is not allowed in the path` }
  if (!kind.test(raw)) return { ok: false, error: `Refused ${raw}: ${kind.only}` }
  const abs = isAbsolute(raw) ? resolve(raw) : resolve(opts.baseDir, raw)
  const roots = opts.roots.map((r) => resolve(r))
  if (!roots.some((r) => inside(abs, r))) return { ok: false, error: `Refused ${raw}: the ${label} must be inside ${roots.join(' or ')}` }
  const s = await stat(abs).catch(() => null)
  if (!s) return { ok: false, error: `File not found: ${raw}` }
  if (!s.isFile()) return { ok: false, error: `Not a file: ${raw}` }
  // A symlink or junction inside a root must not lead out of it.
  const real = await realpath(abs).catch(() => abs)
  const realRoots = await Promise.all(roots.map((r) => realpath(r).catch(() => r)))
  if (!realRoots.some((r) => inside(real, r))) return { ok: false, error: `Refused ${raw}: it links outside ${roots.join(' or ')}` }
  const max = opts.maxBytes ?? MAX_UPLOAD_BYTES
  if (s.size === 0) return { ok: false, error: `The ${label} is empty: ${raw}` }
  if (s.size > max) return { ok: false, error: `The ${label} is ${(s.size / 1024 / 1024).toFixed(1)} MB; ${model ? 'Forge sends' : 'Roblox accepts'} ${model || opts.kind === undefined || opts.kind === 'fbx' ? 'model files' : 'uploads'} up to ${Math.round(max / 1024 / 1024)} MB` }
  return { ok: true, value: { abs, size: s.size, mtimeMs: s.mtimeMs } }
}

// ---------------------------------------------------------------- uploadModel(path, { name, description })

export interface ModelUploaderDeps {
  key: () => Promise<string | null>
  creator: () => Creator
  fetch?: ArtFetch
  sleep?: Sleep
  now?: () => number
}

// assetType defaults to "Model" (roblox_upload_model and older callers).
export type UploadModel = (path: string, options: { name: string; description?: string; assetType?: InboxAssetType }) => Promise<{ assetId: string; moderation?: string }>

export function createModelUploader(deps: ModelUploaderDeps): UploadModel {
  return async (path, options) => {
    const apiKey = await deps.key().catch(() => null)
    if (!apiKey) throw new AssetUploadError(NO_KEY_ERROR)
    const creator = deps.creator()
    if (!creator.userId && !creator.groupId) throw new AssetUploadError(NO_CREATOR_ERROR)
    const s = await stat(path).catch(() => null)
    if (!s?.isFile()) throw new AssetUploadError(`File not found: ${path}`)
    if (s.size > MAX_UPLOAD_BYTES) throw new AssetUploadError(`Roblox accepts uploads up to 20 MB; this one is ${(s.size / 1024 / 1024).toFixed(1)} MB`)
    const input = {
      apiKey,
      bytes: await readFile(path),
      fileName: basename(path),
      displayName: options.name,
      description: options.description ?? '',
      creator,
      fetch: deps.fetch,
      sleep: deps.sleep,
      now: deps.now
    }
    const type = options.assetType ?? 'Model'
    const r = type === 'Audio' ? await uploadAudioAsset(input) : type === 'Image' || type === 'Decal' ? await uploadMediaImageAsset({ ...input, assetType: type }) : await uploadModelAsset(input)
    return { assetId: r.assetId, ...(r.moderation ? { moderation: r.moderation } : {}) }
  }
}

// ---------------------------------------------------------------- the inbox watcher

export type InboxResult =
  | { status: 'uploading' }
  | { status: 'done'; assetId: number | string; assetType: InboxAssetType; name: string; uploadedAt: string; moderation?: string }
  | { status: 'error'; error: string }

export interface ModelInboxDeps {
  dir: () => string
  // <Documents>/ForgeModels: FBX files there are allowed too.
  modelsDir: () => string
  enabled: () => boolean
  upload: UploadModel
  // Why uploads cannot run now (no key, no creator), or null when they can.
  blocked?: () => Promise<string | null>
  log: (text: string, stream?: 'info' | 'stderr') => void
  onResult?: (entry: ModelInboxEntry) => void
  now?: () => number
  sleep?: Sleep
  // fs.watch on the folder; tests pass null and call scan() themselves.
  watch?: ((dir: string, onChange: () => void) => () => void) | null
  pollMs?: number
  // A request or FBX modified more recently than this is treated as still being written.
  settleMs?: number
  // Gap between upload starts, and the first pause after Open Cloud answers 429 (doubles each time).
  minIntervalMs?: number
  rateLimitBackoffMs?: number
}

export const defaultWatch = (dir: string, onChange: () => void): (() => void) => {
  const w = fsWatch(dir, { persistent: false }, () => onChange())
  w.on('error', () => undefined)
  return () => w.close()
}

// Writes via a temp file and rename so a reader never sees half a JSON file.
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value, null, 2) + '\n'
  const tmp = `${path}.${process.pid}.tmp`
  try {
    await writeFile(tmp, text)
    await rename(tmp, path)
  } catch {
    // Windows refuses the rename while a reader holds the target open: write it in place.
    await writeFile(path, text)
  }
}

export class ModelInbox {
  private deps: ModelInboxDeps
  private timer: ReturnType<typeof setInterval> | null = null
  private unwatch: (() => void) | null = null
  private debounce: ReturnType<typeof setTimeout> | null = null
  private scanning: Promise<void> | null = null
  private again = false
  private active = new Set<string>()
  private lastUpload = 0
  private pausedUntil = 0
  private backoff = 0
  private entries: ModelInboxEntry[] = []
  private watchingDir: string | null = null

  constructor(deps: ModelInboxDeps) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  recent(): ModelInboxEntry[] {
    return this.entries.slice()
  }

  watching(): boolean {
    return this.watchingDir !== null
  }

  // Starts (or restarts after a settings change) when enabled; stops otherwise.
  async start(): Promise<void> {
    this.stop()
    if (!this.deps.enabled()) return
    const dir = this.deps.dir()
    try {
      await mkdir(dir, { recursive: true })
    } catch (error) {
      this.deps.log(`[model inbox] cannot create ${dir}: ${(error as Error).message}`, 'stderr')
      return
    }
    this.watchingDir = dir
    const watch = this.deps.watch === undefined ? defaultWatch : this.deps.watch
    if (watch) {
      try {
        this.unwatch = watch(dir, () => this.kick())
      } catch {
        // polling alone still works
      }
    }
    const poll = this.deps.pollMs ?? 4000
    if (poll > 0) {
      this.timer = setInterval(() => this.kick(0), poll)
      this.timer.unref?.()
    }
    this.deps.log(`[model inbox] watching ${dir}`)
    this.kick(0)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.debounce) clearTimeout(this.debounce)
    this.unwatch?.()
    this.timer = null
    this.debounce = null
    this.unwatch = null
    this.watchingDir = null
  }

  private kick(ms = 400): void {
    if (this.debounce) return
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.scan().catch((error) => this.deps.log(`[model inbox] ${(error as Error).message}`, 'stderr'))
    }, ms)
    this.debounce.unref?.()
  }

  // One pass over the folder; overlapping calls fold into one more pass after the current one.
  scan(): Promise<void> {
    if (this.scanning) {
      this.again = true
      return this.scanning
    }
    this.scanning = (async () => {
      try {
        do {
          this.again = false
          await this.pass()
        } while (this.again && this.deps.enabled())
      } finally {
        this.scanning = null
      }
    })()
    return this.scanning
  }

  private async pass(): Promise<void> {
    if (!this.deps.enabled()) return
    const dir = this.deps.dir()
    const names = await readdir(dir).catch(() => [] as string[])
    const ids = names.filter((n) => n.endsWith(REQUEST_SUFFIX) && n.length > REQUEST_SUFFIX.length).map((n) => n.slice(0, -REQUEST_SUFFIX.length))
    // Oldest request first.
    const dated = await Promise.all(ids.map(async (id) => ({ id, at: (await stat(join(dir, id + REQUEST_SUFFIX)).catch(() => null))?.mtimeMs ?? 0 })))
    dated.sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))
    for (const { id } of dated) {
      if (!this.deps.enabled()) return
      await this.process(dir, id)
    }
  }

  // Request -> uploading -> done | error -> request renamed. Returns what happened, for tests.
  async process(dir: string, id: string): Promise<'skipped' | 'deferred' | 'done' | 'error'> {
    if (this.active.has(id)) return 'skipped'
    const requestPath = join(dir, id + REQUEST_SUFFIX)
    const resultPath = join(dir, id + RESULT_SUFFIX)
    const finish = () => rename(requestPath, join(dir, id + DONE_SUFFIX)).catch((error) => this.deps.log(`[model inbox] could not rename ${id}${REQUEST_SUFFIX}: ${(error as Error).message}`, 'stderr'))

    // Idempotent: a result means this id was handled. Only an "uploading" left by a Forge that quit
    // mid-upload is closed out, as an error (it may have finished on Roblox, so no second upload).
    const existing = await readFile(resultPath, 'utf8').then((t) => t, () => null)
    if (existing !== null) {
      let status: unknown
      try {
        status = (JSON.parse(existing) as { status?: unknown }).status
      } catch {
        status = undefined
      }
      if (status === 'uploading') {
        await this.fail(dir, id, undefined, 'Forge stopped during this upload. It may still have finished on Roblox (Creator Hub > Creations > Packages); drop a new request with a new id to try again.')
      }
      await finish()
      return 'skipped'
    }

    const settle = this.deps.settleMs ?? 2000
    const fresh = (mtimeMs: number) => settle > 0 && this.now() - mtimeMs < settle
    const reqStat = await stat(requestPath).catch(() => null)
    if (!reqStat?.isFile()) return 'skipped'
    if (fresh(reqStat.mtimeMs)) return 'deferred'
    if (reqStat.size > MAX_REQUEST_BYTES) return this.fail(dir, id, undefined, 'The request file is larger than 64 KB', finish)
    const parsed = parseRequest(await readFile(requestPath, 'utf8').catch(() => ''))
    if (!parsed.ok) return this.fail(dir, id, undefined, parsed.error, finish)
    const request = parsed.value
    const file = await resolveModelFile(request.file, { baseDir: dir, roots: [dir, this.deps.modelsDir()], kind: KIND_OF[request.assetType] })
    if (!file.ok) return this.fail(dir, id, request.name, file.error, finish)
    if (fresh(file.value.mtimeMs)) return 'deferred'
    const blocked = await this.deps.blocked?.().catch((error) => (error as Error).message)
    if (blocked) return this.fail(dir, id, request.name, blocked, finish)

    // One upload at a time (scan is serial), spaced; paused while Open Cloud is rate limiting.
    if (this.now() < this.pausedUntil) return 'deferred'
    const gap = (this.deps.minIntervalMs ?? 2_000) - (this.now() - this.lastUpload)
    if (this.lastUpload && gap > 0) await (this.deps.sleep ?? defaultSleep)(gap)

    this.active.add(id)
    try {
      await writeJsonAtomic(resultPath, { status: 'uploading' } satisfies InboxResult)
      this.lastUpload = this.now()
      this.deps.log(`[model inbox] uploading ${request.name} as ${request.assetType} (${basename(file.value.abs)}, ${(file.value.size / 1024 / 1024).toFixed(1)} MB)`)
      let uploaded: { assetId: string; moderation?: string }
      try {
        uploaded = await this.deps.upload(file.value.abs, { name: request.name, assetType: request.assetType, ...(request.description ? { description: request.description } : {}) })
      } catch (error) {
        if (isRateLimitedBeforeCreate(error)) {
          // Nothing reached Roblox: leave the request queued and pause the inbox.
          await unlink(resultPath).catch(() => undefined)
          this.backoff = Math.min(15 * 60_000, this.backoff ? this.backoff * 2 : (this.deps.rateLimitBackoffMs ?? 60_000))
          this.pausedUntil = this.now() + this.backoff
          this.deps.log(`[model inbox] Roblox Open Cloud is rate limiting uploads (429); ${request.name} stays queued, retrying in ${Math.round(this.backoff / 1000)} s`)
          return 'deferred'
        }
        return await this.fail(dir, id, request.name, (error as Error).message, finish)
      }
      this.backoff = 0
      const assetId = Number.isSafeInteger(Number(uploaded.assetId)) ? Number(uploaded.assetId) : uploaded.assetId
      const uploadedAt = new Date(this.now()).toISOString()
      await writeJsonAtomic(resultPath, { status: 'done', assetId, assetType: request.assetType, name: request.name, uploadedAt, ...(uploaded.moderation ? { moderation: uploaded.moderation } : {}) } satisfies InboxResult)
      await finish()
      this.deps.log(`[model inbox] ${request.name} -> rbxassetid://${assetId}${uploaded.moderation ? ` (moderation: ${uploaded.moderation})` : ''}`)
      this.record({ id, name: request.name, status: 'done', assetId, at: uploadedAt })
      return 'done'
    } finally {
      this.active.delete(id)
    }
  }

  private async fail(dir: string, id: string, name: string | undefined, error: string, finish?: () => Promise<unknown>): Promise<'error'> {
    await writeJsonAtomic(join(dir, id + RESULT_SUFFIX), { status: 'error', error } satisfies InboxResult)
    await finish?.()
    this.deps.log(`[model inbox] ${name ?? id} failed: ${error}`, 'stderr')
    this.record({ id, ...(name ? { name } : {}), status: 'error', error, at: new Date(this.now()).toISOString() })
    return 'error'
  }

  private record(entry: ModelInboxEntry): void {
    this.entries = [entry, ...this.entries].slice(0, 10)
    this.deps.onResult?.(entry)
  }
}

// ---------------------------------------------------------------- agent tool

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

export const MODEL_TOOL_NAMES = ['roblox_upload_model'] as const

// roblox_upload_model for Forge's own assistant: the FBX may sit in the open project, the inbox or
// <Documents>/ForgeModels (same validation as the inbox).
export function modelUploadTools(deps: { upload: UploadModel; roots: () => string[]; projectRoot: () => string | null }) {
  return [
    {
      name: 'roblox_upload_model',
      description:
        'Upload an .fbx file to Roblox as a Model asset (Open Cloud Assets API) with the user\'s Open Cloud key, owned by the creator set on the Art page, and return its asset id. Roblox stores it as a package of MeshParts (Toolbox > Inventory > My Packages) after moderation. path: project-relative, or absolute inside Documents/ForgeModels; up to 20 MB. name: up to 50 characters. Insert it in Studio by asset id.',
      inputSchema: { path: z.string().min(1), name: z.string().min(1).max(50), description: z.string().max(1000).optional() },
      handler: async (args: { path: string; name: string; description?: string }): Promise<ToolResult> => {
        try {
          const project = deps.projectRoot()
          const file = await resolveModelFile(args.path, { baseDir: project ?? deps.roots()[0] ?? '.', roots: [...(project ? [project] : []), ...deps.roots()] })
          if (!file.ok) throw new Error(file.error)
          const r = await deps.upload(file.value.abs, { name: args.name.trim(), ...(args.description ? { description: args.description } : {}) })
          const mod = r.moderation ? ` (moderation: ${r.moderation})` : ''
          return { content: [{ type: 'text', text: `uploaded ${args.path} as Model asset ${r.assetId} (rbxassetid://${r.assetId})${mod}` }] }
        } catch (error) {
          return { content: [{ type: 'text', text: `roblox_upload_model failed: ${(error as Error).message}` }], isError: true }
        }
      }
    }
  ]
}
