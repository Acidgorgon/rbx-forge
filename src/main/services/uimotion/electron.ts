// Electron pieces for the UI Motion Lab: snapshots of the live preview (a rectangle of the focused
// Forge window) for the critic, and whether safeStorage can encrypt the Figma token. Only
// main/index.ts imports this.

import { BrowserWindow, safeStorage } from 'electron'
import type { UiMotionWireDeps } from './wire.ts'

export function uiMotionElectronDeps(): Pick<UiMotionWireDeps, 'snap' | 'canStoreSecrets' | 'fetch'> {
  return {
    snap: async (rect) => {
      const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      if (!win) return null
      const image = await win.webContents.capturePage(rect)
      return image.isEmpty() ? null : image.toDataURL()
    },
    canStoreSecrets: () => safeStorage.isEncryptionAvailable(),
    // Node's fetch (main process): the Figma REST API and its image URLs.
    fetch: (url, init) => fetch(url, init) as ReturnType<NonNullable<UiMotionWireDeps['fetch']>>
  }
}
