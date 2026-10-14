// Decoding a video reference in the renderer, without ffmpeg: an HTML video element seeked frame by
// frame and drawn into a small canvas (mp4 / webm / mov, whatever Chromium can play), or WebCodecs
// ImageDecoder for GIFs. Frames are cropped, scaled to at most maxSide pixels and sampled evenly
// (up to 24 fps, at most maxFrames). Then the shared analysis (shared/videoref/analyze.ts), the
// contact sheet and the key frame PNGs. Used by the import review and the offscreen decoder.

import { analyzeFrames, sheetIndices, sheetLayout } from '@shared/videoref/analyze'
import type { RefCrop, RefDecodeOptions, RgbaFrame, VideoRefAnalysis } from '@shared/videoref/types'

export const REF_ACCEPT = 'video/mp4,video/webm,video/quicktime,image/gif,.mp4,.m4v,.webm,.mov,.gif'
export const MAX_SPAN = 15
const DEFAULT_SIDE = 320
const DEFAULT_FRAMES = 90
const MAX_FPS = 24

export class DecodeError extends Error {}

export function isRefFile(f: { name: string; type: string }): boolean {
  return /^video\//.test(f.type) || f.type === 'image/gif' || /\.(mp4|m4v|webm|mov|gif)$/i.test(f.name)
}

export function mimeOf(f: { name: string; type: string }): string {
  if (f.type) return f.type
  const ext = /\.(\w+)$/.exec(f.name)?.[1]?.toLowerCase()
  return ext === 'gif' ? 'image/gif' : ext === 'webm' ? 'video/webm' : ext === 'mov' ? 'video/quicktime' : 'video/mp4'
}

export interface Probe {
  kind: 'video' | 'gif'
  duration: number
  width: number
  height: number
}

export interface Decoded {
  probe: Probe
  frames: RgbaFrame[]
  // Trimmed span in source seconds.
  start: number
  end: number
}

// The sampled times of a span: evenly spaced, at most MAX_FPS and maxFrames.
export function sampleTimes(start: number, end: number, maxFrames = DEFAULT_FRAMES): number[] {
  const span = Math.max(0.04, end - start)
  const n = Math.max(2, Math.min(maxFrames, Math.round(span * MAX_FPS) + 1))
  return Array.from({ length: n }, (_, i) => start + (span * i) / (n - 1))
}

function scaled(w: number, h: number, crop: RefCrop | undefined, maxSide: number) {
  const c = crop ?? { x: 0, y: 0, w: 1, h: 1 }
  const sx = Math.round(c.x * w)
  const sy = Math.round(c.y * h)
  const sw = Math.max(2, Math.round(c.w * w))
  const sh = Math.max(2, Math.round(c.h * h))
  const k = Math.min(1, maxSide / Math.max(sw, sh))
  return { sx, sy, sw, sh, dw: Math.max(2, Math.round(sw * k)), dh: Math.max(2, Math.round(sh * k)) }
}

function canvas2d(w: number, h: number): { c: HTMLCanvasElement; g: CanvasRenderingContext2D } {
  const c = document.createElement('canvas')
  c.width = w
  c.height = h
  const g = c.getContext('2d', { willReadFrequently: true })
  if (!g) throw new DecodeError('no 2D canvas')
  return { c, g }
}

// ------------------------------------------------------------------ video

function once(el: HTMLMediaElement, ev: string, ms = 8000): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => (cleanup(), reject(new DecodeError(`the video did not answer (${ev})`))), ms)
    const ok = () => (cleanup(), resolve())
    const bad = () => (cleanup(), reject(new DecodeError(el.error?.message || 'Chromium cannot decode this video (try mp4 / H.264 or webm)')))
    const cleanup = () => {
      clearTimeout(t)
      el.removeEventListener(ev, ok)
      el.removeEventListener('error', bad)
    }
    el.addEventListener(ev, ok)
    el.addEventListener('error', bad)
  })
}

export async function loadVideo(url: string): Promise<{ video: HTMLVideoElement; probe: Probe }> {
  const video = document.createElement('video')
  video.muted = true
  video.playsInline = true
  video.preload = 'auto'
  video.crossOrigin = 'anonymous'
  const meta = once(video, 'loadedmetadata')
  video.src = url
  await meta
  // MediaRecorder webm files report Infinity until seeked to the end.
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    const changed = once(video, 'durationchange', 6000).catch(() => undefined)
    video.currentTime = 1e7
    await changed
    video.currentTime = 0
    await once(video, 'seeked').catch(() => undefined)
  }
  const duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : 0
  if (!duration || !video.videoWidth) throw new DecodeError('could not read the video length or size')
  return { video, probe: { kind: 'video', duration, width: video.videoWidth, height: video.videoHeight } }
}

async function seek(video: HTMLVideoElement, t: number): Promise<void> {
  if (Math.abs(video.currentTime - t) < 1e-4 && video.readyState >= 2) return
  const done = once(video, 'seeked')
  video.currentTime = t
  await done
  // Make sure the frame for the new time is decoded before drawing it.
  const rvfc = (video as HTMLVideoElement & { requestVideoFrameCallback?: (cb: () => void) => number }).requestVideoFrameCallback
  if (rvfc && video.readyState < 2) await new Promise<void>((r) => rvfc.call(video, () => r()))
}

async function decodeVideo(url: string, opts: RefDecodeOptions, onProgress?: (done: number, total: number) => void): Promise<Decoded> {
  const { video, probe } = await loadVideo(url)
  try {
    const start = Math.max(0, Math.min(probe.duration - 0.05, opts.start ?? 0))
    const end = Math.max(start + 0.05, Math.min(probe.duration, opts.end ?? probe.duration, start + MAX_SPAN))
    // Stay a hair before the end: seeking to the exact duration shows a blank frame on some files.
    const times = sampleTimes(start, Math.min(end, probe.duration - 0.001), opts.maxFrames)
    const s = scaled(probe.width, probe.height, opts.crop, opts.maxSide ?? DEFAULT_SIDE)
    const { g } = canvas2d(s.dw, s.dh)
    const frames: RgbaFrame[] = []
    for (const [i, t] of times.entries()) {
      await seek(video, t)
      g.drawImage(video, s.sx, s.sy, s.sw, s.sh, 0, 0, s.dw, s.dh)
      frames.push({ t: Math.round((t - start) * 1000) / 1000, width: s.dw, height: s.dh, data: g.getImageData(0, 0, s.dw, s.dh).data })
      onProgress?.(i + 1, times.length)
    }
    return { probe, frames, start, end }
  } finally {
    video.removeAttribute('src')
    video.load()
  }
}

// ------------------------------------------------------------------ GIF (WebCodecs ImageDecoder)

interface GifFrame {
  image: CanvasImageSource & { close(): void; displayWidth: number; displayHeight: number }
  timestamp: number
  duration: number
}

async function gifFrames(data: ArrayBuffer): Promise<{ frames: GifFrame[]; probe: Probe }> {
  const ID = (globalThis as unknown as { ImageDecoder?: new (init: { data: ArrayBuffer; type: string }) => any }).ImageDecoder
  if (!ID) throw new DecodeError('This build of Chromium has no ImageDecoder (WebCodecs); convert the GIF to mp4 or webm.')
  const dec = new ID({ data, type: 'image/gif' })
  await dec.tracks.ready
  const count: number = dec.tracks.selectedTrack?.frameCount ?? 1
  const frames: GifFrame[] = []
  let at = 0
  for (let i = 0; i < Math.min(count, 600); i++) {
    const { image } = await dec.decode({ frameIndex: i })
    // VideoFrame duration / timestamp are microseconds; GIFs without delays play at 10 fps.
    const d = image.duration ? image.duration / 1e6 : 0.1
    frames.push({ image, timestamp: at, duration: d })
    at += d
  }
  dec.close?.()
  if (!frames.length) throw new DecodeError('the GIF has no frames')
  const w = frames[0].image.displayWidth
  const h = frames[0].image.displayHeight
  return { frames, probe: { kind: 'gif', duration: at, width: w, height: h } }
}

async function decodeGif(blob: Blob, opts: RefDecodeOptions, onProgress?: (done: number, total: number) => void): Promise<Decoded> {
  const { frames: all, probe } = await gifFrames(await blob.arrayBuffer())
  try {
    const start = Math.max(0, Math.min(probe.duration - 0.02, opts.start ?? 0))
    const end = Math.max(start + 0.02, Math.min(probe.duration, opts.end ?? probe.duration, start + MAX_SPAN))
    const times = sampleTimes(start, end - 1e-4, opts.maxFrames)
    const s = scaled(probe.width, probe.height, opts.crop, opts.maxSide ?? DEFAULT_SIDE)
    const { g } = canvas2d(s.dw, s.dh)
    const frames: RgbaFrame[] = []
    for (const [i, t] of times.entries()) {
      let f = all[0]
      for (const x of all) if (x.timestamp <= t + 1e-6) f = x
      g.clearRect(0, 0, s.dw, s.dh)
      g.drawImage(f.image, s.sx, s.sy, s.sw, s.sh, 0, 0, s.dw, s.dh)
      frames.push({ t: Math.round((t - start) * 1000) / 1000, width: s.dw, height: s.dh, data: g.getImageData(0, 0, s.dw, s.dh).data })
      onProgress?.(i + 1, times.length)
    }
    return { probe, frames, start, end }
  } finally {
    for (const f of all) f.image.close()
  }
}

// GIF length and size without keeping the frames (the review UI).
export async function probeGif(blob: Blob): Promise<Probe> {
  const { frames, probe } = await gifFrames(await blob.arrayBuffer())
  for (const f of frames) f.image.close()
  return probe
}

export async function decodeClip(blob: Blob, mime: string, opts: RefDecodeOptions = {}, onProgress?: (done: number, total: number) => void): Promise<Decoded> {
  if (mime === 'image/gif') return decodeGif(blob, opts, onProgress)
  const url = URL.createObjectURL(blob)
  try {
    return await decodeVideo(url, opts, onProgress)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ------------------------------------------------------------------ analysis + images

export const BEAT_COLORS: Record<string, string> = { anticipation: '#7aa2f7', release: '#e0af68', impact: '#f7768e', dissipate: '#9aa5b1', flash: '#ffffff' }

function frameCanvas(f: RgbaFrame): HTMLCanvasElement {
  const { c, g } = canvas2d(f.width, f.height)
  g.putImageData(new ImageData(new Uint8ClampedArray(f.data), f.width, f.height), 0, 0)
  return c
}

// The contact sheet: up to 12 frames in time order (key frames swapped in and outlined in their beat
// colour), each labelled with its time and beat.
export function contactSheet(frames: RgbaFrame[], a: VideoRefAnalysis): string {
  const keys = a.keyFrames.map((k) => k.index)
  const idx = sheetIndices(frames.length, keys, 12)
  const f0 = frames[0]
  // Small sources (a 120 px GIF) are drawn larger so the 11 px labels stay in proportion.
  const up = Math.max(1, 240 / f0.width)
  const L = sheetLayout(idx.length, Math.round(f0.width * up), Math.round(f0.height * up), 1152)
  const { c, g } = canvas2d(L.width, L.height)
  g.fillStyle = '#0c0c0e'
  g.fillRect(0, 0, L.width, L.height)
  g.font = '11px ui-monospace, Menlo, Consolas, monospace'
  g.textBaseline = 'middle'
  idx.forEach((fi, n) => {
    const col = n % L.cols
    const row = Math.floor(n / L.cols)
    const x = L.gap + col * (L.cellW + L.gap)
    const y = L.gap + row * (L.cellH + L.labelH + L.gap)
    const f = frames[fi]
    g.drawImage(frameCanvas(f), x, y, L.cellW, L.cellH)
    const seg = a.segments.find((s) => f.t >= s.start && f.t < s.end) ?? a.segments[a.segments.length - 1]
    const key = a.keyFrames.find((k) => k.index === fi)
    const color = BEAT_COLORS[key?.label ?? seg?.label ?? ''] ?? '#888888'
    g.fillStyle = color
    g.fillRect(x, y + L.cellH, L.cellW, 2)
    if (key) {
      g.strokeStyle = color
      g.lineWidth = 2
      g.strokeRect(x + 1, y + 1, L.cellW - 2, L.cellH - 2)
    }
    g.fillStyle = '#c8c8c8'
    g.fillText(`${f.t.toFixed(2)}s`, x + 2, y + L.cellH + 2 + (L.labelH - 2) / 2)
    g.fillStyle = color
    const label = key ? `● ${key.label}` : seg?.label ?? ''
    const w = g.measureText(label).width
    g.fillText(label, x + L.cellW - w - 2, y + L.cellH + 2 + (L.labelH - 2) / 2)
  })
  return c.toDataURL('image/png')
}

export interface BuiltRef {
  analysis: VideoRefAnalysis
  sheet: string
  keyFrames: { t: number; label: string; index: number; png: string }[]
}

export function buildReference(d: Decoded, crop?: RefCrop): BuiltRef {
  if (d.frames.length < 2) throw new DecodeError('the clip is too short to analyse')
  const s = scaled(d.probe.width, d.probe.height, crop, 1e9)
  const analysis = analyzeFrames(d.frames, { duration: d.end - d.start, width: s.sw, height: s.sh })
  const sheet = contactSheet(d.frames, analysis)
  const keyFrames = analysis.keyFrames.map((k) => ({ t: k.t, label: k.label, index: k.index, png: frameCanvas(d.frames[k.index]).toDataURL('image/png') }))
  return { analysis, sheet, keyFrames }
}
