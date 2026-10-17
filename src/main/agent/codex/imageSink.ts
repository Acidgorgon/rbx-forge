// Images Codex generates in a chat (host turns and group-chat guests): copied into Forge's chat image
// store (userData/chat-images, so the chat keeps them when Codex's folder is cleaned) and into the
// project's art/concepts with the request as their prompt (the Art page lists them), then shown as
// one assistant message where Codex made them. No electron imports.

import { randomUUID } from 'node:crypto'
import { lstat, readFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { ChatImage, ChatMessage, Speaker } from '@shared/types'
import { chatImageStore, hasChatImageStore, MAX_IMAGE_BYTES, sniffMime } from '../chatImages.ts'
import { IMAGE_FILE } from './generated.ts'

// Writes images into <project>/art/concepts (ArtService.saveGenerated); returns their
// project-relative paths, in order. Set by main/integrations.ts; unset in tests and without the Art
// service.
export type ConceptSaver = (input: { images: Buffer[]; prompt: string }) => Promise<string[]>

let saver: ConceptSaver | null = null

export function setCodexConceptSaver(fn: ConceptSaver | null): void {
  saver = fn
}

export interface ImportedImages {
  images: ChatImage[]
  // art/concepts/... paths (empty when no project is open or saving failed).
  concepts: string[]
  // Why some files were skipped or could not be saved.
  problems: string[]
}

// Reads Codex's image files (only PNG/JPEG/WebP files, no symlinks, at most 20 MB each).
export async function importGeneratedImages(paths: string[], o: { prompt: string; save?: ConceptSaver | null }): Promise<ImportedImages> {
  const problems: string[] = []
  const files: { path: string; bytes: Buffer }[] = []
  for (const p of paths) {
    if (!IMAGE_FILE.test(p)) continue
    const s = await lstat(p).catch(() => null)
    if (!s?.isFile()) continue
    if (s.size > MAX_IMAGE_BYTES) {
      problems.push(`${basename(p)} is larger than 20 MB`)
      continue
    }
    const bytes = await readFile(p).catch(() => null)
    const mime = bytes ? sniffMime(bytes) : null
    if (!bytes || !mime || mime === 'image/gif') continue
    files.push({ path: p, bytes })
  }
  if (!files.length) return { images: [], concepts: [], problems }
  let concepts: string[] = []
  const save = o.save === undefined ? saver : o.save
  if (save) {
    try {
      concepts = await save({ images: files.map((f) => f.bytes), prompt: o.prompt.trim() || 'Image made by Codex in a chat' })
    } catch (e) {
      problems.push(`not saved to art/concepts: ${(e as Error).message}`)
    }
  }
  const images: ChatImage[] = []
  if (hasChatImageStore()) {
    for (const [k, f] of files.entries()) {
      const name = concepts[k] ? basename(concepts[k]).replace(/\.[^.]+$/, '') : `codex-image-${k + 1}`
      try {
        images.push(await chatImageStore().add({ dataUrl: `data:${sniffMime(f.bytes)};base64,${f.bytes.toString('base64')}`, name }))
      } catch (e) {
        problems.push(`${basename(f.path)}: ${(e as Error).message}`)
      }
    }
  }
  return { images, concepts, problems }
}

// The chat message that shows them: the images, and where they were saved.
export function generatedImagesMessage(r: ImportedImages, speaker?: Speaker): ChatMessage | null {
  if (!r.images.length) return null
  const n = r.images.length
  const where = r.concepts.length ? `Saved to the Art page: ${r.concepts.map((c) => `\`${c}\``).join(', ')}` : ''
  return {
    id: randomUUID(),
    role: 'assistant',
    text: where || (n === 1 ? 'Generated image' : `${n} generated images`),
    at: Date.now(),
    agentId: 'main',
    images: r.images,
    ...(speaker ? { speaker } : {})
  }
}
