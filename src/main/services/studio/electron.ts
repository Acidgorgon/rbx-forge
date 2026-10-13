// Electron pieces for the Studio check: recording the Roblox Studio window (desktopCapturer source ->
// a hidden capture page that holds the live stream and picks frames, pages/studio/StudioCapture.ts),
// PNG crop / key-colour detection with nativeImage, and the plugins folder. Only main/index.ts
// imports this. Needs a real desktop: the window must be visible (not minimised); macOS also asks for
// Screen Recording permission (System Settings > Privacy & Security > Screen Recording).

import { BrowserWindow, desktopCapturer, nativeImage, session, shell, systemPreferences, type DesktopCapturerSource } from 'electron'
import { mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { rendererUrl } from '../capture/offscreen.ts'
import { findKeyRect, scaleRect } from '../../../shared/studio/crop.ts'
import { pluginsDir } from '../../../shared/studio/plugin.ts'
import type { CapturedFrame, ImageOps, StudioCaptureSession, StudioCapturer } from './service.ts'
import type { StudioWireDeps } from './wire.ts'

const PARTITION = 'forge-studio-capture'
const STUDIO_TITLE = /roblox studio/i

function screenHint(): string | null {
  if (process.platform !== 'darwin') return null
  const s = systemPreferences.getMediaAccessStatus('screen')
  return s === 'granted' ? null : 'Allow RBX Forge to record the screen (System Settings > Privacy & Security > Screen Recording), then restart Forge.'
}

async function studioSource(place?: string): Promise<DesktopCapturerSource> {
  const hint = screenHint()
  if (hint) throw new Error(hint)
  const sources = await desktopCapturer.getSources({ types: ['window'], thumbnailSize: { width: 0, height: 0 }, fetchWindowIcons: false })
  const studio = sources.filter((s) => STUDIO_TITLE.test(s.name))
  if (!studio.length) throw new Error('No Roblox Studio window to record: open Studio and keep its window visible (not minimised) during the check.')
  return (place && studio.find((s) => s.name.includes(place))) || studio[0]
}

function capturer(preload: string): StudioCapturer {
  return {
    find: async (hint) => {
      try {
        return { window: (await studioSource(hint.place)).name }
      } catch (e) {
        return { error: (e as Error).message }
      }
    },
    open: async (hint) => {
      const source = await studioSource(hint.place)
      const ses = session.fromPartition(PARTITION)
      ses.setDisplayMediaRequestHandler((_req, cb) => cb({ video: source }))
      ses.setPermissionRequestHandler((_wc, permission, cb) => cb(permission === 'media' || permission === 'display-capture'))
      const win = new BrowserWindow({ show: false, width: 320, height: 240, webPreferences: { preload, partition: PARTITION, backgroundThrottling: false, sandbox: false, contextIsolation: true, nodeIntegration: false } })
      const run = <T>(js: string): Promise<T> => win.webContents.executeJavaScript(js, true) as Promise<T>
      try {
        await win.loadURL(rendererUrl('?studio-capture=1'))
        for (let i = 0; i < 100 && !(await run<boolean>('!!window.__studioCapture')); i++) await new Promise((r) => setTimeout(r, 50))
        await run(`window.__studioCapture.start(${JSON.stringify(source.id)})`)
      } catch (e) {
        win.destroy()
        throw e
      }
      const toFrame = (f: { ts: number; png: string; offsetMs?: number } | null) => (f ? { ts: f.ts, png: Buffer.from(f.png.slice(f.png.indexOf(',') + 1), 'base64'), ...(f.offsetMs !== undefined ? { offsetMs: f.offsetMs } : {}) } : null)
      const s: StudioCaptureSession = {
        window: source.name,
        grabAfter: async (at, timeoutMs = 4000) => {
          const f = toFrame(await run<{ ts: number; png: string } | null>(`window.__studioCapture.grabAfter(${Number(at)}, ${Number(timeoutMs)})`))
          if (!f) throw new Error('the Studio window sent no frame (is it minimised or covered by another app in full screen?)')
          return f as CapturedFrame
        },
        pick: async (targets, timeoutMs) => (await run<({ ts: number; png: string; offsetMs: number } | null)[]>(`window.__studioCapture.pick(${JSON.stringify(targets)}, ${Number(timeoutMs)})`)).map((f) => toFrame(f) as (CapturedFrame & { offsetMs: number }) | null),
        close: async () => {
          await run('window.__studioCapture.stop()').catch(() => undefined)
          win.destroy()
        }
      }
      return s
    }
  }
}

const image: ImageOps = {
  keyRect: (png, key) => {
    const img = nativeImage.createFromBuffer(png)
    const size = img.getSize()
    if (!size.width || !size.height) return null
    const small = size.width > 480 ? img.resize({ width: 480, quality: 'good' }) : img
    const ss = small.getSize()
    // Magenta (the default key) reads the same in RGBA and BGRA; toBitmap is BGRA on Windows / macOS.
    const r = findKeyRect(small.toBitmap(), ss.width, ss.height, { key, order: 'bgra' })
    return r ? scaleRect(r, size.width / ss.width, size.height / ss.height, size) : null
  },
  crop: (png, rect, maxWidth) => {
    let img = nativeImage.createFromBuffer(png)
    if (rect && rect.width > 8 && rect.height > 8) img = img.crop(rect)
    if (img.getSize().width > maxWidth) img = img.resize({ width: maxWidth, quality: 'best' })
    return img.toPNG()
  }
}

export function studioElectronDeps(preload: string): Pick<StudioWireDeps, 'capturer' | 'image' | 'plugin'> {
  const dir = () => pluginsDir({ platform: process.platform, env: process.env, home: homedir() })
  return {
    capturer: capturer(preload),
    image,
    plugin: {
      dir,
      open: async (d) => {
        await mkdir(d, { recursive: true }).catch(() => undefined)
        await shell.openPath(d)
      }
    }
  }
}
