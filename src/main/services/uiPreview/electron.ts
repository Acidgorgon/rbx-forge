// Electron side of the preview_ui tool: draws a tree snapshot with the app's own renderer in an
// offscreen window (?uipreview-capture=1, see renderer/src/pages/uipreview/CaptureView.tsx) and
// returns the PNG. Imported only from main/index.ts.

import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import type { PreviewToolDeps } from './tools.ts'

export const CAPTURE_QUERY = '?uipreview-capture=1'

export function uiPreviewCapture(preload: string): NonNullable<PreviewToolDeps['capture']> {
  return async (input) => {
    const payload = JSON.stringify({ tree: input.tree, width: input.width, height: input.height, device: input.device, images: input.images })
    const setup = `(async () => {
      for (let i = 0; i < 400 && !window.__uiPreviewCapture; i++) await new Promise((r) => setTimeout(r, 25))
      if (!window.__uiPreviewCapture) throw new Error('the capture view did not load')
      return window.__uiPreviewCapture(${payload})
    })()`
    const frames = await captureFrames({ url: rendererUrl(CAPTURE_QUERY), width: input.width, height: input.height, frames: 1, setup, setupTimeoutMs: 20_000, timeoutMs: 45_000, preload })
    return frames[0] ?? null
  }
}
