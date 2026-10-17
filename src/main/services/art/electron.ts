// Electron pieces for the art workflow (thumbnails, image picker, open / show in folder). Only
// main/index.ts imports this; tested code never does.
import { BrowserWindow, dialog, nativeImage, shell } from 'electron'
import type { ArtWireDeps } from './wire.ts'

export function artElectronDeps(): Pick<ArtWireDeps, 'thumbnail' | 'chooseImages' | 'reveal'> {
  return {
    thumbnail: async (bytes, width) => {
      const img = nativeImage.createFromBuffer(bytes)
      if (img.isEmpty()) return null
      const size = img.getSize()
      if (size.width <= width) return bytes
      return img.resize({ width, quality: 'good' }).toPNG()
    },
    chooseImages: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: 'Choose reference images',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'webp'] }]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 8)
    },
    reveal: async (absPath, how) => {
      if (how === 'folder') return shell.showItemInFolder(absPath)
      // openPath resolves to an error message ('' on success).
      const err = await shell.openPath(absPath)
      if (err) throw new Error(err)
    }
  }
}
