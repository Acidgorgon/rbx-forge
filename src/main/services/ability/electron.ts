// Electron pieces for the Ability Composer: offscreen frames of the ability preview for the critic
// (shared capture helper) and the sound picker. Only main/index.ts imports this.

import { BrowserWindow, dialog } from 'electron'
import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import type { AbilityWireDeps } from './wire.ts'

export function abilityElectronDeps(preload: string): Pick<AbilityWireDeps, 'capture' | 'chooseSounds'> {
  return {
    // ?ability-capture=1 mounts only the preview (pages/ability/AbilityCapture.tsx), which exposes
    // window.__abilityCapture.load(ability, effects) / .at(t).
    capture: (req) =>
      captureFrames({
        url: rendererUrl('?ability-capture=1'),
        width: req.width,
        height: req.height,
        frames: req.times.length,
        preload,
        setup: `window.__abilityCapture.load(${JSON.stringify(req.ability)}, ${JSON.stringify(req.effects)})`,
        setupTimeoutMs: 30_000,
        frameScript: (i) => `window.__abilityCapture.at(${Number(req.times[i]) || 0})`,
        timeoutMs: 120_000
      }),
    chooseSounds: async () => {
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
      const options: Electron.OpenDialogOptions = {
        title: 'Import sounds',
        properties: ['openFile', 'multiSelections'],
        filters: [{ name: 'Audio', extensions: ['ogg', 'mp3', 'wav', 'flac', 'm4a'] }]
      }
      const picked = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options)
      return picked.canceled ? [] : picked.filePaths.slice(0, 20)
    }
  }
}
