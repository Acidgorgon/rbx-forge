// Image generation on the ChatGPT plan through Codex's built-in image tool. No electron imports.
//
// What Codex supports (checked Oct 2026):
//  - The bundled `imagegen` skill (codex-rs/skills/src/assets/samples/imagegen/SKILL.md) uses the
//    built-in `image_gen` tool by default: "Does not require OPENAI_API_KEY"; it runs on gpt-image-2
//    and counts toward the ChatGPT plan's Codex limits (learn.chatgpt.com/codex/image-generation).
//    `$imagegen` in a prompt invokes the skill explicitly; it works from `codex exec`.
//  - Tool arguments (codex-rs/ext/image-generation): transparent_background, referenced_image_paths
//    (local files, up to 5 for edits). Size and quality are not arguments: the tool always asks
//    for size "auto" and quality "auto". One image per call; n variants = n calls.
//  - Output: saved as $CODEX_HOME/generated_images/<thread id>/<call id>.png (artifact.rs). The
//    thread id is the `thread.started` event's thread_id. `codex exec --json` has no image item,
//    so the files are collected from that folder after the run.
// Forge runs it in a fresh scratch folder (references copied there) with the read-only sandbox:
// nothing in the project can change, and image saving is done by Codex itself, not by a command.

import { mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CodexImages } from '../../services/art/imageBackend.ts'
import { codexHome, codexService, type CodexService } from './service.ts'

export const CODEX_MAX_IMAGES = 4
export const CODEX_MAX_REFS = 5
const IMAGE_TIMEOUT = 10 * 60_000

export interface CodexImageRequest {
  prompt: string
  n: number
  // Requested WIDTHxHEIGHT (or auto); Codex picks the size itself, so only the shape is passed on.
  size?: string
  transparent?: boolean
  // Reference images as data: URLs or raw bytes.
  references?: (string | Uint8Array)[]
  signal?: AbortSignal
}

export interface CodexImageResult {
  images: Buffer[]
  // What was changed from the request (fewer images, size chosen by Codex...).
  notes: string[]
}

export function shapeOf(size: string | undefined): 'square' | 'landscape' | 'portrait' | null {
  const m = /^(\d+)x(\d+)$/.exec(size ?? '')
  if (!m) return null
  const [w, h] = [Number(m[1]), Number(m[2])]
  return w === h ? 'square' : w > h ? 'landscape' : 'portrait'
}

export function imagePrompt(req: { prompt: string; n: number; size?: string; transparent?: boolean }, refNames: string[]): string {
  const n = Math.max(1, Math.min(CODEX_MAX_IMAGES, Math.floor(req.n)))
  const shape = shapeOf(req.size)
  const lines = [
    `$imagegen Use the built-in image_gen tool to generate ${n === 1 ? 'one image' : `${n} separate images (one image_gen call each, variations of the same brief)`}.`,
    'Stay on the built-in tool: do not use the CLI fallback, scripts, an API key or shell commands, and do not write or edit any files.',
    shape ? `Make it ${shape === 'square' ? 'square (1:1)' : shape === 'landscape' ? `landscape (${req.size})` : `portrait (${req.size})`}.` : '',
    req.transparent ? 'Set transparent_background to true: the subject on a genuinely transparent background.' : '',
    refNames.length ? `Pass these local files as referenced_image_paths and use them as the reference images described in the brief: ${refNames.join(', ')}.` : '',
    '',
    'Brief:',
    req.prompt.trim(),
    '',
    'When the image' + (n === 1 ? ' is' : 's are') + ' generated, reply with just: DONE'
  ]
  return lines.filter((l, i, a) => l !== '' || (i > 0 && a[i - 1] !== '')).join('\n')
}

function bytesOf(ref: string | Uint8Array): Buffer | null {
  if (typeof ref !== 'string') return Buffer.from(ref)
  const m = /^data:([^;,]+)?(;base64)?,(.*)$/s.exec(ref)
  if (!m || !m[2]) return null
  return Buffer.from(m[3], 'base64')
}

function extOf(buf: Buffer): string {
  if (buf[0] === 0xff && buf[1] === 0xd8) return 'jpg'
  if (buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  if (buf.subarray(0, 4).toString('latin1') === 'GIF8') return 'gif'
  return 'png'
}

const IMAGE_FILE = /\.(png|jpe?g|webp)$/i

// Image files in a folder (one level), oldest first. Missing folder = [].
export async function imagesIn(dir: string, skip: (name: string) => boolean = () => false): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files: { path: string; at: number }[] = []
  for (const name of names) {
    if (!IMAGE_FILE.test(name) || skip(name)) continue
    const p = join(dir, name)
    const s = await stat(p).catch(() => null)
    if (s?.isFile()) files.push({ path: p, at: s.mtimeMs })
  }
  return files.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path)).map((f) => f.path)
}

// Where this run's images are: the thread's folder under $CODEX_HOME/generated_images, any path the
// event stream reported, then (older CLIs / remote executors) the scratch folder itself.
export async function collectImages(o: { home: string; threadId: string | null; saved: string[]; scratch: string; refNames: string[] }): Promise<string[]> {
  const out: string[] = []
  if (o.threadId && /^[\w-]+$/.test(o.threadId)) out.push(...(await imagesIn(join(o.home, 'generated_images', o.threadId))))
  for (const p of o.saved) if (!out.includes(p) && IMAGE_FILE.test(p) && (await stat(p).catch(() => null))?.isFile()) out.push(p)
  if (!out.length) {
    out.push(...(await imagesIn(o.scratch, (name) => o.refNames.includes(name))))
    out.push(...(await imagesIn(join(o.scratch, 'generated_images'))))
  }
  return out
}

export async function generateWithCodex(service: CodexService, req: CodexImageRequest, opts: { tmpDir: string; env?: NodeJS.ProcessEnv }): Promise<CodexImageResult> {
  const why = await service.notReady()
  if (why) throw new Error(why)
  const notes: string[] = []
  const want = Math.max(1, Math.floor(req.n || 1))
  const n = Math.min(CODEX_MAX_IMAGES, want)
  if (want > n) notes.push(`Codex makes at most ${CODEX_MAX_IMAGES} images per run; asked for ${n}.`)
  if (req.size && req.size !== 'auto') notes.push('Codex picks the image size itself (auto); the result is fitted afterwards.')
  const dir = await mkdtemp(join(opts.tmpDir, 'forge-codex-img-'))
  try {
    const refNames: string[] = []
    const refs = req.references ?? []
    if (refs.length > CODEX_MAX_REFS) notes.push(`Codex takes at most ${CODEX_MAX_REFS} reference images; used the first ${CODEX_MAX_REFS}.`)
    for (const ref of refs.slice(0, CODEX_MAX_REFS)) {
      const bytes = bytesOf(ref)
      if (!bytes) continue
      const name = `reference-${refNames.length + 1}.${extOf(bytes)}`
      await writeFile(join(dir, name), bytes)
      refNames.push(name)
    }
    const r = await service.exec({ cwd: dir, prompt: imagePrompt({ ...req, n }, refNames), sandbox: 'read-only', ephemeral: false, signal: req.signal, timeoutMs: IMAGE_TIMEOUT })
    if (r.aborted) throw new Error('Image generation cancelled.')
    const files = await collectImages({ home: codexHome(opts.env ?? service.env()), threadId: r.threadId, saved: r.savedImages, scratch: dir, refNames })
    if (!files.length) {
      const said = r.error || r.lastMessage.trim()
      throw new Error(`Codex did not produce an image${said ? `: ${said.slice(0, 300)}` : ''}. Image generation needs a paid ChatGPT plan (Plus or higher) signed in to Codex.`)
    }
    const images: Buffer[] = []
    for (const f of files.slice(-n)) images.push(await readFile(f))
    if (images.length < n) notes.push(`Codex returned ${images.length} of ${n} images.`)
    return { images, notes }
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined)
  }
}

// The image backend Art, Thumbnail Lab and VFX textures use when 'codex' is picked.
export function codexImages(get: () => CodexService = codexService, tmp: () => string = tmpdir): CodexImages {
  return {
    async status() {
      const s = await get().status()
      if (!s.installed) return { ready: false, detail: s.detail }
      if (!s.loggedIn) return { ready: false, detail: 'Codex is not signed in: Settings > Providers > Codex > Sign in with ChatGPT.' }
      if (s.method === 'apikey') return { ready: true, detail: 'Codex is signed in with an API key, so images are billed to the API, not your ChatGPT plan.' }
      return { ready: true, detail: 'Signed in with ChatGPT' }
    },
    generate: (req) => generateWithCodex(get(), req, { tmpDir: tmp() })
  }
}
