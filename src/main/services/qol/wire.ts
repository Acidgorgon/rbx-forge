// Quality of life wiring: the electron deps (window screenshot, OS notifications, clipboard, reveal in
// folder), main-process error capture and the IPC handlers. Real logic lives in service.ts.

import { app, BrowserWindow, clipboard, Notification, shell } from 'electron'
import { arch, homedir, release } from 'node:os'
import { join, resolve, sep } from 'node:path'
import type { QolDeps } from './service.ts'
import { QolService } from './service.ts'
import type { BugReportInput, QolSettingsPatch } from '../../../shared/qol/types.ts'
import type { SessionState } from '../../../shared/qol/session.ts'

type Wiring = Omit<QolDeps, 'isFocused' | 'showNotification' | 'focusWindow' | 'capture' | 'copy' | 'reveal' | 'app' | 'os' | 'homeDir'>

function mainWindow(): BrowserWindow | null {
  return BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
}

export function createQol(wiring: Wiring) {
  // Keep shown notifications referenced until clicked/closed, or their click handlers get collected.
  const live = new Set<Notification>()
  const service = new QolService({
    ...wiring,
    isFocused: () => BrowserWindow.getFocusedWindow() !== null,
    showNotification: (n, onClick) => {
      if (!Notification.isSupported()) return
      const note = new Notification({ title: n.title, body: n.body, silent: !n.sound })
      live.add(note)
      note.on('click', () => {
        live.delete(note)
        onClick()
      })
      note.on('close', () => live.delete(note))
      note.show()
    },
    focusWindow: () => {
      const w = mainWindow()
      if (!w) return
      if (w.isMinimized()) w.restore()
      w.show()
      w.focus()
      if (process.platform === 'darwin') app.focus({ steal: true })
    },
    capture: async () => {
      const w = mainWindow()
      if (!w) return null
      const image = await w.webContents.capturePage()
      return image.isEmpty() ? null : image.toPNG()
    },
    copy: (text) => clipboard.writeText(text),
    reveal: (path) => shell.showItemInFolder(path),
    app: { version: app.getVersion(), electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node, packaged: app.isPackaged },
    os: { platform: process.platform, release: release(), arch: arch() },
    homeDir: homedir()
  })

  // Main-process errors for bug reports. uncaughtExceptionMonitor observes without changing Electron's
  // default crash handling; unhandled rejections are also written to the harness log.
  process.on('uncaughtExceptionMonitor', (error) => service.recordError('main', error?.message ?? String(error), error?.stack))
  process.on('unhandledRejection', (reason) => {
    const error = reason instanceof Error ? reason : new Error(String(reason))
    service.recordError('main', `Unhandled rejection: ${error.message}`, error.stack)
    wiring.log(`[main] unhandled rejection: ${error.message}`, 'stderr')
  })

  const handlers: Record<string, (...args: any[]) => unknown> = {
    qolGetSettings: () => service.settings(),
    qolSetSettings: (patch: QolSettingsPatch) => service.setSettings(patch ?? {}),
    qolBugReportStart: () => service.startBugReport(),
    qolBugReport: (input: BugReportInput) => service.bugReport(input),
    qolBugReportPreview: (input: BugReportInput) => service.previewBugReport(input),
    qolRevealPath: (path: string) => {
      // Only bug report folders: the renderer cannot reveal arbitrary paths through this.
      const reports = join(wiring.userDataDir, 'bug-reports') + sep
      if (typeof path === 'string' && resolve(path).startsWith(reports)) shell.showItemInFolder(resolve(path))
    },
    qolReportError: (error: { message: string; stack?: string }) => service.recordError('renderer', String(error?.message ?? 'Unknown error'), typeof error?.stack === 'string' ? error.stack : undefined),
    qolLoadSession: () => service.loadSession(),
    qolSaveSession: (state: SessionState) => service.saveSession(state),
    qolDigest: (request: { reason: 'open' | 'idle'; since?: number; again?: boolean }) => service.digest(request ?? { reason: 'open' }),
    qolSeen: () => service.seen(),
    qolTestNotify: () => service.testNotify()
  }

  return { service, handlers }
}
