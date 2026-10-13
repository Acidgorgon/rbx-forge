// Image attachments for the chat composer: file -> (downscaled) data URL -> chat image store, a
// cache of image URLs by id, and attachImageToChat(), the entry point other views use (the Art
// page's "Send to chat") to put an image into the composer.

import type { ChatImage } from '@shared/types'
import { MAX_IMAGES_PER_MESSAGE } from '@shared/modelCaps'
import { acceptedImageType, encodeType, fitWithin } from './imageScale'

const urls = new Map<string, Promise<string>>()

// data: URL of a stored image, cached for the session.
export function chatImageUrl(id: string): Promise<string> {
  let p = urls.get(id)
  if (!p) {
    p = window.harness.getChatImage(id)
    p.catch(() => urls.delete(id))
    urls.set(id, p)
  }
  return p
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('could not read the image'))
    img.src = src
  })
}

function readAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error('could not read the file'))
    r.readAsDataURL(file)
  })
}

// Downscales a data URL so the long edge is at most IMAGE_MAX_EDGE (unchanged when it fits).
export async function downscaleDataUrl(dataUrl: string, type: string): Promise<{ dataUrl: string; width: number; height: number }> {
  const img = await loadImage(dataUrl)
  const fit = fitWithin(img.naturalWidth, img.naturalHeight)
  if (!fit.scaled) return { dataUrl, width: fit.width, height: fit.height }
  const canvas = document.createElement('canvas')
  canvas.width = fit.width
  canvas.height = fit.height
  const g = canvas.getContext('2d')
  if (!g) return { dataUrl, width: img.naturalWidth, height: img.naturalHeight }
  g.imageSmoothingQuality = 'high'
  g.drawImage(img, 0, 0, fit.width, fit.height)
  const out = encodeType(type)
  return { dataUrl: canvas.toDataURL(out, out === 'image/png' ? undefined : 0.9), width: fit.width, height: fit.height }
}

// A picked, pasted or dropped file, stored and ready to send.
export async function addImageFile(file: File): Promise<ChatImage> {
  if (!acceptedImageType(file.type)) throw new Error(`${file.name || 'file'}: only PNG, JPEG, WebP and GIF images`)
  const raw = await readAsDataUrl(file)
  const { dataUrl } = await downscaleDataUrl(raw, file.type)
  const name = file.name ? file.name.replace(/\.[^.]+$/, '') : 'pasted image'
  const ref = await window.harness.addChatImage({ dataUrl, name })
  urls.set(ref.id, Promise.resolve(dataUrl))
  return ref
}

export interface AttachInput {
  // Absolute file path (generated art) or a data: URL.
  path?: string
  dataUrl?: string
  name?: string
}

// Stores an image from a path or data URL, downscaling it when it is too large.
export async function addImage(input: AttachInput): Promise<ChatImage> {
  if (input.dataUrl) {
    const type = /^data:([\w/+.-]+)/.exec(input.dataUrl)?.[1] ?? 'image/png'
    const { dataUrl } = await downscaleDataUrl(input.dataUrl, type)
    const ref = await window.harness.addChatImage({ dataUrl, name: input.name })
    urls.set(ref.id, Promise.resolve(dataUrl))
    return ref
  }
  if (!input.path) throw new Error('an image needs a path or a data URL')
  let ref = await window.harness.addChatImage({ path: input.path, name: input.name })
  if (fitWithin(ref.width ?? 0, ref.height ?? 0).scaled) {
    const big = await window.harness.getChatImage(ref.id)
    const { dataUrl } = await downscaleDataUrl(big, ref.mime)
    ref = await window.harness.addChatImage({ dataUrl, name: ref.name })
    urls.set(ref.id, Promise.resolve(dataUrl))
  }
  return ref
}

// ---------------------------------------------------------------- composer hand-off

type Listener = (ref: ChatImage) => void
let listener: Listener | null = null
const queued: ChatImage[] = []

// The composer registers here; images attached before it mounts are delivered then.
export function onAttachRequest(fn: Listener): () => void {
  listener = fn
  for (const ref of queued.splice(0)) fn(ref)
  return () => {
    if (listener === fn) listener = null
  }
}

// Puts an image into the Assistant composer as an attachment (opening the panel). Used by other
// views, e.g. the Art page's "Send to chat". Resolves with the stored reference, or null on error.
export async function attachImageToChat(input: AttachInput): Promise<ChatImage | null> {
  try {
    const ref = await addImage(input)
    if (listener) listener(ref)
    else queued.push(ref)
    return ref
  } catch {
    return null
  }
}

export { MAX_IMAGES_PER_MESSAGE }
