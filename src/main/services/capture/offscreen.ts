// Shared offscreen page capture (Electron only; imported from main/index.ts wiring, never from tested
// code). Used by the UI preview worker (one frame of a Vide tree snapshot) and the VFX Lab
// (vfx_render: N frames of the three.js particle preview).
//
// A hidden BrowserWindow with offscreen rendering loads the app's renderer (same preload, so
// window.api exists) at `url`, runs `setup` (JS; may return a Promise, awaited with a timeout), then
// for each frame runs `frameScript(i)` (JS; may return a Promise) and grabs the next painted frame as
// PNG. Offscreen windows deliver frames through the 'paint' event; capturePage() is the fallback.

import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

export interface CaptureOptions {
  // Page to load; usually rendererUrl('?some-mode=1').
  url: string
  width: number
  height: number
  frames?: number
  // JS evaluated once after load. May return a Promise; it must settle within setupTimeoutMs.
  setup?: string
  setupTimeoutMs?: number
  // JS evaluated before each frame (i = 0..frames-1). May return a Promise.
  frameScript?: (i: number) => string
  // Whole capture budget (load + setup + frames).
  timeoutMs?: number
  // Preload script path (default: none). Pass the app's preload so window.api exists.
  preload?: string
  // Device scale factor of the captured image (default 1).
  scale?: number
}

export class CaptureError extends Error {}

// The app's renderer page, with an optional query ("?mode=1" or "mode=1").
export function rendererUrl(query = '', opts: { devUrl?: string | undefined; rendererDir?: string } = {}): string {
  const q = query ? (query.startsWith('?') ? query : `?${query}`) : ''
  const dev = opts.devUrl ?? process.env.ELECTRON_RENDERER_URL
  if (dev) return dev.replace(/\/?$/, '/') + q
  const dir = opts.rendererDir ?? join(__dirname, '../renderer')
  return pathToFileURL(join(dir, 'index.html')).toString() + q
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new CaptureError(`${what} timed out after ${ms} ms`)), ms)
    p.then(
      (v) => {
        clearTimeout(t)
        resolve(v)
      },
      (e) => {
        clearTimeout(t)
        reject(e instanceof Error ? e : new CaptureError(String(e)))
      }
    )
  })
}

// Wraps a script so a returned Promise is awaited inside the page and errors come back as text.
function wrap(script: string): string {
  return `(async () => { const __r = await (async () => { return (${script}) })(); return __r === undefined ? null : __r })()`
}

let queue: Promise<unknown> = Promise.resolve()

// Captures run one at a time (each opens its own window; GPU memory is the limit, not CPU).
export function captureFrames(opts: CaptureOptions): Promise<Buffer[]> {
  const run = queue.then(() => captureOnce(opts))
  queue = run.catch(() => undefined)
  return run
}

async function captureOnce(opts: CaptureOptions): Promise<Buffer[]> {
  const frames = Math.max(1, Math.min(120, Math.floor(opts.frames ?? 1)))
  const width = Math.max(16, Math.min(2048, Math.round(opts.width)))
  const height = Math.max(16, Math.min(2048, Math.round(opts.height)))
  const win = new BrowserWindow({
    width,
    height,
    show: false,
    frame: false,
    useContentSize: true,
    backgroundColor: '#0c0e11',
    webPreferences: {
      offscreen: true,
      ...(opts.preload ? { preload: opts.preload } : {}),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      zoomFactor: opts.scale ?? 1
    }
  })
  const wc = win.webContents
  wc.setFrameRate(30)
  wc.setWindowOpenHandler(() => ({ action: 'deny' }))
  let latest: Electron.NativeImage | null = null
  let waiter: ((img: Electron.NativeImage) => void) | null = null
  wc.on('paint', (_e, _dirty, image) => {
    latest = image
    if (waiter) {
      const w = waiter
      waiter = null
      w(image)
    }
  })
  const nextPaint = async (): Promise<Electron.NativeImage> => {
    const p = new Promise<Electron.NativeImage>((resolve) => (waiter = resolve))
    wc.invalidate()
    try {
      return await withTimeout(p, 1500, 'paint')
    } catch {
      waiter = null
      return latest && !latest.isEmpty() ? latest : await wc.capturePage()
    }
  }
  const body = async (): Promise<Buffer[]> => {
    await wc.loadURL(opts.url)
    if (opts.setup) await withTimeout(wc.executeJavaScript(wrap(opts.setup), true), opts.setupTimeoutMs ?? 15_000, 'capture setup')
    const out: Buffer[] = []
    for (let i = 0; i < frames; i++) {
      if (opts.frameScript) await withTimeout(wc.executeJavaScript(wrap(opts.frameScript(i)), true), 10_000, `capture frame ${i}`)
      const img = await nextPaint()
      if (img.isEmpty()) throw new CaptureError(`frame ${i} came back empty`)
      out.push(img.toPNG())
    }
    return out
  }
  try {
    return await withTimeout(body(), opts.timeoutMs ?? 60_000, 'capture')
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
