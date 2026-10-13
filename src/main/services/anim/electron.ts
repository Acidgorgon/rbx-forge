// Electron pieces for the Animation Lab: offscreen rendering of the three.js preview (shared capture
// helper, services/capture/offscreen.ts) and the import picker. Only main/index.ts imports this.

import { BrowserWindow, dialog } from 'electron'
import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import type { AnimWireDeps } from './wire.ts'

export function animElectronDeps(preload: string): Pick<AnimWireDeps, 'capture' | 'chooseImport'> {
  return {
    // The renderer's ?anim-capture=1 mode mounts only the preview (pages/anim/AnimCapture.tsx) and
    // exposes window.__animCapture.load(clip, opts) / .at(t).
    capture: (req) =>
      captureFrames({
        url: rendererUrl('?anim-capture=1'),
        width: req.width,
        height: req.height,
        frames: req.times.length,
        preload,
        setup: `window.__animCapture.load(${JSON.stringify(req.clip)}, ${JSON.stringify({ reference: req.reference ?? null })})`,
        setupTimeoutMs: 20_000,
        frameScript: (i) => `window.__animCapture.at(${Number(req.times[i]) || 0})`,
        timeoutMs: 90_000
      }),
    chooseImport: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: 'Import animations',
        properties: process.platform === 'darwin' ? ['openFile', 'openDirectory', 'multiSelections'] : ['openFile', 'multiSelections'],
        filters: [
          { name: 'Animations (KeyframeSequence, BVH)', extensions: ['rbxm', 'rbxmx', 'bvh'] },
          { name: 'All files', extensions: ['*'] }
        ]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 200)
    }
  }
}
