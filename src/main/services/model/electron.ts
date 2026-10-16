// Electron pieces for the Model Lab: offscreen snapshots of the three.js preview for the critic
// (shared capture helper, services/capture/offscreen.ts). Only main/index.ts imports this.

import { captureFrames, rendererUrl } from '../capture/offscreen.ts'
import { captureSetup } from '../capture/ready.ts'
import type { ModelWireDeps } from './wire.ts'

export function modelElectronDeps(preload: string): Pick<ModelWireDeps, 'capture'> {
  return {
    // The renderer's ?model-capture=1 mode mounts only the preview (pages/model/ModelCapture.tsx)
    // and exposes window.__modelCapture.load(parts) / .view(name).
    capture: (req) =>
      captureFrames({
        url: rendererUrl('?model-capture=1'),
        width: req.width,
        height: req.height,
        frames: req.views.length,
        preload,
        setup: captureSetup('__modelCapture', `window.__modelCapture.load(${JSON.stringify(req.parts)})`),
        setupTimeoutMs: 20_000,
        frameScript: (i) => `window.__modelCapture.view(${JSON.stringify(req.views[i] ?? 'front')})`,
        timeoutMs: 90_000
      })
  }
}
