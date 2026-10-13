// The pinned-reference pieces the VFX and Animation Lab services use for "make it like this": the
// compose prompt block with the key frames as images, and the critic's match section. Works on any
// library entry with a `video` (VfxEntry / AnimEntry of kind 'media'). No electron imports.

import { refComposeBlock, refCritiqueBlock } from '../../../shared/videoref/prompt.ts'
import type { VideoRef } from '../../../shared/videoref/types.ts'

export interface RefImage {
  mime: string
  base64: string
}

export interface PinnedRef {
  id: string
  name: string
  video: VideoRef
  // Key frames in beat order (PNG), at most four.
  images: RefImage[]
  keyLabels: string[]
  // Compose prompt block and critic block.
  compose: string
  critique: string
}

export class RefNotFoundError extends Error {}

const MAX_KEY_IMAGES = 4

// The entry's key frames (and, when asked, the contact sheet first) as images.
export async function refImages(video: VideoRef, readFile: (file: string) => Promise<Buffer>, opts: { sheet?: boolean; max?: number } = {}): Promise<{ images: RefImage[]; keyLabels: string[] }> {
  const images: RefImage[] = []
  const keyLabels: string[] = []
  if (opts.sheet && video.sheet) {
    const b = await readFile(video.sheet).catch(() => null)
    if (b && b.length < 8 * 1024 * 1024) images.push({ mime: 'image/png', base64: b.toString('base64') })
  }
  for (const k of video.analysis.keyFrames.filter((x) => x.file).slice(0, opts.max ?? MAX_KEY_IMAGES)) {
    const b = await readFile(k.file!).catch(() => null)
    if (!b || b.length > 4 * 1024 * 1024) continue
    images.push({ mime: 'image/png', base64: b.toString('base64') })
    keyLabels.push(`${k.label} @ ${k.t.toFixed(2)} s`)
  }
  return { images, keyLabels }
}

export async function loadPinnedRef(entry: { id: string; name: string; notes?: string; video?: VideoRef } | null | undefined, readFile: (file: string) => Promise<Buffer>): Promise<PinnedRef> {
  if (!entry?.video) throw new RefNotFoundError(entry ? `"${entry.name}" is not a video reference` : 'no such video reference')
  const { images, keyLabels } = await refImages(entry.video, readFile)
  return {
    id: entry.id,
    name: entry.name,
    video: entry.video,
    images,
    keyLabels,
    compose: refComposeBlock(entry.video, entry.name, { keyLabels, notes: entry.notes }),
    critique: refCritiqueBlock(entry.video, entry.name, keyLabels)
  }
}
