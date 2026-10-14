// Electron pieces for the VFX Lab: offscreen rendering of the three.js preview (shared capture
// helper, services/capture/offscreen.ts) and the import picker. Only main/index.ts imports this.

import { BrowserWindow, dialog, nativeImage } from 'electron'
import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import { captureSetup } from '../capture/ready.ts'
import type { VfxWireDeps } from './wire.ts'

export function vfxElectronDeps(preload: string): Pick<VfxWireDeps, 'capture' | 'chooseImport' | 'chooseTextures' | 'decodeImage'> {
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
        setup: captureSetup('__vfxCapture', `window.__vfxCapture.load(${JSON.stringify(req.effect)}, ${JSON.stringify({ background: req.background ?? 'dark' })})`),
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
    },
    // Texture import: image files, or folders (scanned recursively by the importer).
    chooseTextures: async (what) => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions =
        what === 'folder'
          ? { title: 'Import a folder of textures', properties: ['openDirectory', 'multiSelections'] }
          : { title: 'Import textures', properties: ['openFile', 'multiSelections'], filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }] }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 500)
    },
    // JPEG (and other formats Chromium reads) -> RGBA. nativeImage gives BGRA bitmaps.
    decodeImage: (bytes) => {
      const img = nativeImage.createFromBuffer(bytes)
      if (img.isEmpty()) return null
      const { width, height } = img.getSize()
      const bgra = img.toBitmap()
      if (!width || !height || bgra.length < width * height * 4) return null
      const data = new Uint8ClampedArray(width * height * 4)
      for (let i = 0; i < width * height * 4; i += 4) {
        data[i] = bgra[i + 2]
        data[i + 1] = bgra[i + 1]
        data[i + 2] = bgra[i]
        data[i + 3] = bgra[i + 3]
      }
      return { width, height, data }
    }
  }
}
