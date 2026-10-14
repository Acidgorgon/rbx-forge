// Forge Sync IPC (renderer <-> main). Data types live in ./types.ts. No electron imports.

import type { SyncConflictInfo, SyncEntry, SyncStatus } from './types.ts'

export type SyncEngineChoice = SyncStatus['engine']

export interface ForgeSyncSettings {
  // 'forge' (recommended): Forge pulls Studio first and gates rojo serve. 'project': the project's own
  // tools/studio-sync.py (started by ./dev). 'off': no Studio -> disk sync.
  engine: SyncEngineChoice
  // Hold rojo serve for a place until its Studio snapshot is reconciled.
  gateRojo: boolean
}

export interface SyncCommitResult {
  committed: string[]
  message?: string
  // Set when nothing was committed (nothing pending, or git failed).
  error?: string
}

export interface SyncApi {
  syncStatus(): Promise<SyncStatus>
  // take 'merged' needs text (the hand-merged file).
  syncResolve(placeKey: string, file: string, take: 'studio' | 'disk' | 'merged', text?: string): Promise<SyncStatus>
  // Bulk decision, e.g. first run: "Studio wins" / "Disk wins" for every conflict of that place, or
  // only those held for `reason`.
  syncResolveAll(placeKey: string, take: 'studio' | 'disk', reason?: SyncConflictInfo['reason']): Promise<SyncStatus>
  // Lets rojo serve a blocked place now; the held conflicts stay listed.
  syncServeAnyway(placeKey: string): Promise<SyncStatus>
  // Commits only the files Forge wrote from Studio ("Studio edits: ...").
  syncCommitStudioEdits(message?: string): Promise<SyncCommitResult>
  // Renames the legacy StudioSyncPlugin file(s) in the Studio plugins folder to *.disabled.
  syncDisableLegacyPlugin(): Promise<SyncStatus>
  forgeSyncSettings(): Promise<ForgeSyncSettings>
  setForgeSyncSettings(patch: Partial<ForgeSyncSettings>): Promise<ForgeSyncSettings>
}

export interface SyncEvents {
  'sync:status': SyncStatus
  // New reconcile outcomes (never 'same' / 'unmapped'), oldest first.
  'sync:entry': SyncEntry[]
}
