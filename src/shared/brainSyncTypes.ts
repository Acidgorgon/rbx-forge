// IPC types for .forgepack export/import and device sync of Forge's memory (main/agent/memory/sync).
// Type-only re-exports; HarnessApi / HarnessEvents extend the interfaces below.

export type {
  PackSectionId,
  PackItemKind,
  PackItemInfo,
  PackManifest,
  ExportCandidate,
  ExportCandidates,
  ExportResult,
  ImportStatus,
  ImportChoice,
  ImportPreviewItem,
  ImportPreview,
  ImportResult,
  BrainSyncMode,
  BrainSyncSettings,
  BrainSyncStatus
} from '../main/agent/memory/sync/types.ts'
import type { BrainSyncSettings, BrainSyncStatus, ExportCandidates, ExportResult, ImportChoice, ImportPreview, ImportResult } from '../main/agent/memory/sync/types.ts'

export interface BrainSyncApi {
  // Everything that can go in a pack, with secret-scanner blocks marked.
  packCandidates(): Promise<ExportCandidates>
  // keys: the chosen item keys, or 'all'. Asks where to save; null when cancelled.
  packExport(keys: string[] | 'all', includeProject?: boolean): Promise<ExportResult | null>
  // Opens a .forgepack (file dialog unless a path is given) and previews it against this device.
  packOpen(path?: string): Promise<ImportPreview | null>
  packImport(token: string, choices: Record<string, ImportChoice>): Promise<ImportResult>
  brainSyncStatus(): Promise<BrainSyncStatus>
  brainSyncGetSettings(): Promise<BrainSyncSettings>
  brainSyncSetSettings(patch: Partial<BrainSyncSettings>): Promise<BrainSyncSettings>
  brainSyncNow(): Promise<BrainSyncStatus>
  brainSyncChooseFolder(): Promise<string | null>
}

export interface BrainSyncEvents {
  'brainsync:status': BrainSyncStatus
}
