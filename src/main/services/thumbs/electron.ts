// Electron pieces for the Thumbnail Lab (image decoding to PNG, the image picker). Only main/index.ts
// imports this; tested code never does.
import { BrowserWindow, dialog, nativeImage } from 'electron'
import type { ThumbsWireDeps } from './wire.ts'

export function thumbsElectronDeps(): Pick<ThumbsWireDeps, 'toPng' | 'chooseImages'> {
  return {
    // nativeImage reads PNG and JPEG (and BMP / ICO on some platforms); anything else returns null.
    toPng: async (bytes) => {
      const img = nativeImage.createFromBuffer(bytes)
      return img.isEmpty() ? null : img.toPNG()
    },
    chooseImages: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: 'Choose images',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp', 'bmp'] }]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 24)
    }
  }
}
