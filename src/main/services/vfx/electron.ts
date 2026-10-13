// Electron pieces for the VFX Lab: offscreen rendering of the three.js preview (shared capture
// helper, services/capture/offscreen.ts) and the import picker. Only main/index.ts imports this.

import { BrowserWindow, dialog } from 'electron'
import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import type { VfxWireDeps } from './wire.ts'

export function vfxElectronDeps(preload: string): Pick<VfxWireDeps, 'capture' | 'chooseImport'> {
  return {
    // The renderer's ?vfx-capture=1 mode mounts only the preview (pages/vfx/VfxCapture.tsx) and
    // exposes window.__vfxCapture.load(effect, opts) / .at(t).
    capture: (req) =>
      captureFrames({
        url: rendererUrl('?vfx-capture=1'),
        width: req.width,
        height: req.height,
        frames: req.times.length,
        preload,
        setup: `window.__vfxCapture.load(${JSON.stringify(req.effect)}, ${JSON.stringify({ background: req.background ?? 'dark' })})`,
        setupTimeoutMs: 20_000,
        frameScript: (i) => `window.__vfxCapture.at(${Number(req.times[i]) || 0})`,
        timeoutMs: 90_000
      }),
    chooseImport: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      // Windows and Linux cannot pick files and folders in one dialog: files there (folders can be
      // dropped on the drop zone); macOS gets both.
      const options: Electron.OpenDialogOptions = {
        title: 'Import VFX references',
        properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        filters: [
          { name: 'Roblox models and references', extensions: ['rbxm', 'rbxmx', 'png', 'jpg', 'jpeg', 'webp', 'gif', 'mp4', 'webm', 'mov'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 200)
    }
  }
}
