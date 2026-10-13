// IPC handlers for .forgepack export/import and device sync (BrainSyncApi in
// shared/brainSyncTypes.ts). Dialogs are injected so this stays electron-free.

import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { basename } from 'node:path'
import type { BrainSync } from './brainSync.ts'
import { applyImport, buildPack, exportCandidates, PACK_EXT, parsePack, previewPack, type PackDeps, type ParsedPack } from './pack.ts'
import type { BrainSyncSettings, ExportResult, ImportChoice, ImportPreview, ImportResult } from './types.ts'

export interface BrainSyncIpcDeps {
  pack: () => PackDeps
  sync: BrainSync
  chooseSavePath(defaultName: string): Promise<string | null>
  chooseOpenPath(): Promise<string | null>
  chooseFolder(title: string): Promise<string | null>
  // Stores changed after an import.
  onImported(): void
}

export function brainSyncHandlers(d: BrainSyncIpcDeps): Record<string, (...args: any[]) => unknown> {
  // The last opened pack, kept until it is imported or another is opened.
  let opened: { token: string; parsed: ParsedPack } | null = null
  return {
    packCandidates: () => exportCandidates(d.pack()),
    packExport: async (keys: unknown, includeProject: unknown): Promise<ExportResult | null> => {
      const sel = Array.isArray(keys) ? keys.map(String) : 'all'
      const deps = d.pack()
      // Build (and scan) before asking where to save, so a refusal shows up immediately.
      const { zip, manifest } = await buildPack(deps, { keys: sel, includeProject: includeProject === true })
      const day = new Date(manifest.created).toISOString().slice(0, 10)
      const path = await d.chooseSavePath(`forge-${deps.device.replace(/[^\w.-]+/g, '-').toLowerCase()}-${day}${PACK_EXT}`)
      if (!path) return null
      await writeFile(path, zip)
      return { path, manifest }
    },
    packOpen: async (path?: unknown): Promise<ImportPreview | null> => {
      const file = typeof path === 'string' && path ? path : await d.chooseOpenPath()
      if (!file) return null
      const parsed = parsePack(await readFile(file))
      const token = randomUUID()
      opened = { token, parsed }
      return previewPack(d.pack(), parsed, token, basename(file))
    },
    packImport: async (token: unknown, choices: unknown): Promise<ImportResult> => {
      if (!opened || opened.token !== token) throw new Error('that pack is no longer open; open it again')
      const c: Record<string, ImportChoice> = {}
      if (choices && typeof choices === 'object') {
        for (const [k, v] of Object.entries(choices as Record<string, unknown>)) if (v === 'mine' || v === 'theirs' || v === 'both' || v === 'skip') c[k] = v
      }
      const r = await applyImport(d.pack(), opened.parsed, c)
      opened = null
      d.onImported()
      return r
    },
    brainSyncStatus: () => d.sync.status(),
    brainSyncGetSettings: () => d.sync.settings(),
    brainSyncSetSettings: (patch: unknown) => d.sync.setSettings(patch && typeof patch === 'object' ? (patch as Partial<BrainSyncSettings>) : {}),
    brainSyncNow: () => d.sync.syncNow(),
    brainSyncChooseFolder: () => d.chooseFolder('Choose a sync folder (Dropbox, OneDrive, iCloud Drive…)')
  }
}

export const BRAIN_SYNC_METHODS = [
  'packCandidates', 'packExport', 'packOpen', 'packImport',
  'brainSyncStatus', 'brainSyncGetSettings', 'brainSyncSetSettings', 'brainSyncNow', 'brainSyncChooseFolder'
] as const
