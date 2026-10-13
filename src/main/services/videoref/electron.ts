// Electron piece for video references: decoding a file from a path (ref_import) in a hidden
// renderer window. The renderer's ?ref-decode=1 mode (pages/videoref/RefDecode.tsx) exposes
// window.__refDecode.run(token, opts): it reads the bytes through refDecodeSource(token), decodes them
// with an HTML video element (WebCodecs ImageDecoder for GIFs), analyses the frames and returns the
// analysis, the contact sheet and the key frames. Only main/index.ts imports this.

import { BrowserWindow } from 'electron'
import { rendererUrl } from '../capture/offscreen.ts'
import type { RefDecodeOptions } from '../../../shared/videoref/types.ts'
import type { DecodedRef } from './service.ts'

let queue: Promise<unknown> = Promise.resolve()

export function refElectronDeps(preload: string): { decode: (token: string, opts: RefDecodeOptions) => Promise<DecodedRef> } {
  const decodeOnce = async (token: string, opts: RefDecodeOptions): Promise<DecodedRef> => {
    const win = new BrowserWindow({
      width: 480,
      height: 320,
      show: false,
      webPreferences: { offscreen: true, preload, sandbox: false, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const work = (async () => {
        await win.webContents.loadURL(rendererUrl('?ref-decode=1'))
        const script = `(async () => { for (let i = 0; i < 100 && !window.__refDecode; i++) await new Promise((r) => setTimeout(r, 50)); return window.__refDecode.run(${JSON.stringify(token)}, ${JSON.stringify(opts ?? {})}) })()`
        return (await win.webContents.executeJavaScript(script, true)) as DecodedRef
      })()
      const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error('decoding the video timed out (120 s)')), 120_000)))
      return await Promise.race([work, timeout])
    } finally {
      if (timer) clearTimeout(timer)
      if (!win.isDestroyed()) win.destroy()
    }
  }
  return {
    decode: (token, opts) => {
      const run = queue.then(() => decodeOnce(token, opts))
      queue = run.catch(() => undefined)
      return run
    }
  }
}
