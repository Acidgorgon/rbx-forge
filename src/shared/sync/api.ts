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
  // Lets rojo serve place files no Studio check has cleared ('waiting': Studio not open, the open place
  // not linked, or an old plugin), the given one or all, until a Studio session for one starts its check.
  syncServeWithoutCheck(projectFile?: string): Promise<SyncStatus>
  // Writes the place's Studio-only scripts (PlaceSyncStatus.studioOnly, canPull) to disk, so Rojo
  // never offers to delete them from Studio.
  syncPullStudioOnly(placeKey: string): Promise<SyncStatus>
  // Commits only the files Forge wrote from Studio ("Studio edits: ...").
  syncCommitStudioEdits(message?: string): Promise<SyncCommitResult>
  // Renames the legacy StudioSyncPlugin file(s) in the Studio plugins folder to *.disabled.
  syncDisableLegacyPlugin(): Promise<SyncStatus>
  // Game tab "Save to repo" for a Studio-only, non-script instance of the active place: where it would
  // go (a .model.json inside a mapped $path), or why it cannot; then write it.
  syncSaveTarget(instancePath: string[]): Promise<{ file: string } | { reason: string }>
  syncSaveToRepo(instancePath: string[]): Promise<SyncEntry>
  // Game tab "Delete in Studio" for a Studio-only instance (Forge Bridge v7): whether it can run now
  // (Studio connected, plugin new enough, not something the project maps), then the delete itself,
  // which Ctrl+Z in Studio undoes.
  syncDeleteCheck(instancePath: string[]): Promise<{ ok: true } | { reason: string }>
  syncDeleteInStudio(instancePath: string[], className?: string): Promise<void>
  // Explorer multi-select "Delete N in Studio": one job per instance, in turn, behind one confirm. An
  // instance inside another listed one goes with it; failures are listed, not thrown.
  syncDeleteManyInStudio(items: { instancePath: string[]; className?: string }[]): Promise<{ deleted: string[][]; failed: { instancePath: string[]; error: string }[] }>
  // Links a Studio place (an UnlinkedPlace id from SyncStatus.unlinked) to one of the project's place
  // files, persisted in .forge/sync/links.json. Its first sync waits for a "which side" decision.
  syncLinkPlace(id: string, projectFile?: string): Promise<SyncStatus>
  forgeSyncSettings(): Promise<ForgeSyncSettings>
  setForgeSyncSettings(patch: Partial<ForgeSyncSettings>): Promise<ForgeSyncSettings>
}

export interface SyncEvents {
  'sync:status': SyncStatus
  // New reconcile outcomes (never 'same' / 'unmapped'), oldest first.
  'sync:entry': SyncEntry[]
}
