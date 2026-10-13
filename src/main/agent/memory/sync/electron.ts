// Electron side of .forgepack export/import and device sync: file/folder dialogs and the wiring
// between MemoryService, BrainSync and IPC. main/index.ts registers the handlers.
import { BrowserWindow, dialog } from 'electron'
import { hostname } from 'node:os'
import { join } from 'node:path'
import type { MemoryService } from '../service.ts'
import { BrainSync } from './brainSync.ts'
import { brainSyncHandlers } from './ipc.ts'
import { PACK_EXT, type PackDeps } from './pack.ts'
import type { BrainSyncStatus } from './types.ts'

export interface BrainSyncWiringDeps {
  memory: MemoryService
  userData: string
  version: string
  settings: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emitStatus(status: BrainSyncStatus): void
  emitMemoryChanged(): void
  log(text: string, stream?: 'info' | 'stderr'): void
}

export interface BrainSyncWiring {
  handlers: Record<string, (...args: any[]) => unknown>
  // Call on every memory:changed (saves, edits, deletes): pushes after a debounce.
  onMemoryChanged(): void
  start(): void
  dispose(): void
}

function win(): BrowserWindow | undefined {
  return BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
}

export function wireBrainSync(d: BrainSyncWiringDeps): BrainSyncWiring {
  const device = hostname() || 'this device'
  const sync = new BrainSync({
    userDir: join(d.userData, 'memory'),
    dataDir: d.userData,
    device,
    getSetting: (k, f) => d.settings.get(k, f),
    setSetting: (k, v) => d.settings.set(k, v),
    emit: d.emitStatus,
    log: d.log,
    onPulled: async () => {
      d.memory.user.invalidate()
      await d.memory.user.writeIndex().catch(() => undefined)
      d.emitMemoryChanged()
    }
  })
  const pack = (): PackDeps => ({ user: d.memory.user, project: () => d.memory.project(), device, app: `RBX Forge ${d.version}` })
  const filters = [{ name: 'Forge pack', extensions: [PACK_EXT.slice(1)] }]
  const handlers = brainSyncHandlers({
    pack,
    sync,
    chooseSavePath: async (defaultName) => {
      const w = win()
      const opts: Electron.SaveDialogOptions = { title: 'Export Forge memory', defaultPath: defaultName, filters }
      const r = w ? await dialog.showSaveDialog(w, opts) : await dialog.showSaveDialog(opts)
      return r.canceled || !r.filePath ? null : r.filePath
    },
    chooseOpenPath: async () => {
      const w = win()
      const opts: Electron.OpenDialogOptions = { title: 'Import Forge memory', filters, properties: ['openFile'] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    chooseFolder: async (title) => {
      const w = win()
      const opts: Electron.OpenDialogOptions = { title, properties: ['openDirectory', 'createDirectory'] }
      const r = w ? await dialog.showOpenDialog(w, opts) : await dialog.showOpenDialog(opts)
      return r.canceled ? null : (r.filePaths[0] ?? null)
    },
    onImported: () => {
      d.memory.user.invalidate()
      d.memory.project()?.invalidate()
      d.emitMemoryChanged()
      sync.onLocalChange()
    }
  })
  return {
    handlers,
    onMemoryChanged: () => sync.onLocalChange(),
    start: () => sync.start(),
    dispose: () => sync.dispose()
  }
}
