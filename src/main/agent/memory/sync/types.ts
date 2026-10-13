// Plain-data types of .forgepack export/import and device sync ("brain sync"). Re-exported to the
// renderer through src/shared/brainSyncTypes.ts (type-only).

export const PACK_FORMAT = 'forgepack'
export const PACK_VERSION = 1

// 'user' and 'project' are memory stores; anything else is an extra section id (e.g. 'vfx').
export type PackSectionId = 'user' | 'project' | (string & {})
export type PackItemKind = 'memory' | 'skill' | 'extra'

export interface PackItemInfo {
  // `${section}/${kind}/${name}`, unique in a pack.
  key: string
  section: PackSectionId
  kind: PackItemKind
  name: string
  description: string
  // Last content change (frontmatter `updated`, else file times).
  updated: number
  files: number
  bytes: number
}

export interface PackManifest {
  format: typeof PACK_FORMAT
  version: number
  created: number
  // Source device name (hostname).
  device: string
  app?: string
  counts: { userMemories: number; userSkills: number; projectMemories: number; projectSkills: number; extra: Record<string, number> }
  items: PackItemInfo[]
}

export interface ExportCandidate extends PackItemInfo {
  // Why this item cannot be exported (secret scanner), if so.
  blocked?: string
}

export interface ExportCandidates {
  items: ExportCandidate[]
  // Section labels (user, project and the registered extras).
  sections: { id: PackSectionId; label: string }[]
  projectOpen: boolean
  device: string
}

export interface ExportResult {
  path: string
  manifest: PackManifest
}

// How an incoming item relates to what is on this device.
//   new       nothing like it here
//   same      identical content already here
//   conflict  same name, different content
//   similar   a near-duplicate (memory dedupe) exists under another name
//   blocked   refused (secret scanner, unknown section, project not open)
export type ImportStatus = 'new' | 'same' | 'conflict' | 'similar' | 'blocked'
// mine = keep this device's version, theirs = take the pack's, both = keep both (pack copy renamed).
export type ImportChoice = 'mine' | 'theirs' | 'both' | 'skip'

export interface ImportPreviewItem extends PackItemInfo {
  status: ImportStatus
  // For conflict/similar: the local item it collides with, and its updated time.
  local?: { name: string; updated: number; description?: string }
  // Name used for "keep both".
  renameTo?: string
  reason?: string
}

export interface ImportPreview {
  // Handle for packImport (the pack stays in main memory until imported or another is opened).
  token: string
  file: string
  manifest: PackManifest
  items: ImportPreviewItem[]
  sections: { id: PackSectionId; label: string }[]
}

export interface ImportResult {
  added: number
  replaced: number
  renamed: number
  merged: number
  skipped: number
  errors: { key: string; error: string }[]
}

export type BrainSyncMode = 'off' | 'git' | 'folder'

export interface BrainSyncSettings {
  mode: BrainSyncMode
  // git mode: a private repo you own, e.g. https://github.com/you/forge-brain.git or git@github.com:you/forge-brain.git
  repoUrl: string
  // folder mode: a Dropbox / OneDrive / iCloud Drive folder.
  folder: string
  // Pull (and push pending changes) this often.
  intervalMinutes: number
}

export interface BrainSyncStatus {
  mode: BrainSyncMode
  state: 'off' | 'idle' | 'syncing' | 'error'
  // Repo URL or folder path.
  target?: string
  device: string
  lastSync?: number
  lastError?: string
  // The error is about git sign-in (credentials missing or rejected).
  authProblem?: boolean
  // Totals of the last successful sync.
  last?: { pulled: number; pushed: number; conflicts: number }
  // Local changes waiting for the debounced push.
  pending?: boolean
}
