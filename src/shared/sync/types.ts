// Forge Sync: Studio -> disk sync built into RBX Forge (replaces a project's tools/studio-sync.py).
// Studio goes first: when a Studio session for a place connects, Forge pulls every mapped instance,
// reconciles it three ways (base / disk / Studio) per place, and only then lets Rojo serve that place,
// so Rojo's connect never pushes a stale disk copy over a teammate's Team Create edits.
// Plain data shared by main, preload, renderer and the Forge Bridge plugin protocol. No electron imports.

// ---- Values (non-script instances are written as Rojo .model.json) ----
// Mirrors Rojo's explicit property syntax ({ "Vector3": [x, y, z] }, { "Bool": true } ...), which
// works for every type. Strings/numbers/bools may also appear as plain JSON (implicit values).
export type SyncValue = string | number | boolean | { [rojoType: string]: unknown }

// ---- Studio side (sent by the plugin) ----
export interface StudioNode {
  // Stable for the life of the Studio session (the plugin keeps an Instance -> id table).
  id: string
  // Instance names from the DataModel down, e.g. ['ReplicatedStorage', 'Shared', 'Skills', 'Catalog'].
  path: string[]
  className: string
  // LuaSourceContainer only: committed Source (never an unsaved collaborative draft).
  source?: string
  // LuaSourceContainer whose Source is over the 2 MB sync limit: sent without `source`; leave its file alone.
  oversize?: true
  // Script.RunContext when not Legacy.
  runContext?: 'Server' | 'Client' | 'Plugin'
  // Non-script instances: properties that differ from defaults, plus attributes and tags.
  properties?: Record<string, SyncValue>
  attributes?: Record<string, SyncValue>
  tags?: string[]
  // Script whose Source is too large to send (plugin limit): content unknown, never written or trashed.
  oversize?: true
}

export interface SyncPlace {
  // Roblox PlaceId (0 when unpublished) and GameId.
  placeId: number
  gameId?: number
  name?: string
}

export type StudioChange =
  | { kind: 'source'; node: StudioNode }
  | { kind: 'added'; node: StudioNode; descendants?: StudioNode[] }
  | { kind: 'removed'; id: string; path: string[] }
  | { kind: 'renamed' | 'moved'; id: string; from: string[]; node: StudioNode }
  | { kind: 'props'; node: StudioNode }

// ---- Disk side ----
export type FileKind = 'script' | 'model' | 'folder' | 'meta' | 'other'

export interface MappedFile {
  // Repo-relative, forward slashes.
  file: string
  kind: FileKind
  // For 'script': the class Rojo builds from the file name.
  className?: string
  // The instance lives inside this .model.json (file) at these names below the model's root.
  modelPath?: string[]
  // Script RunContext that has to be set through an adjacent meta file (file conventions alone
  // cannot express it), and that meta file.
  metaFile?: string
  runContext?: 'Legacy' | 'Server' | 'Client'
}

// ---- Reconcile outcome per file ----
export type SyncAction =
  | 'same' // Studio == disk
  | 'pulled' // Studio changed, disk did not: Studio written to disk
  | 'merged' // both changed, clean 3-way merge written to disk
  | 'disk-ahead' // disk changed, Studio did not: Rojo will push it
  | 'created' // new in Studio: file/folder created
  | 'renamed' // renamed/moved in Studio: file moved
  | 'trashed' // deleted in Studio: file moved to .forge/sync/trash
  | 'conflict' // both changed and no clean merge: held, gate blocked
  | 'unmapped' // outside every mapped tree (ignored)

export interface SyncEntry {
  file: string
  action: SyncAction
  instancePath: string[]
  // For renamed: the old file.
  from?: string
  at: number
  // Why an instance was refused or left alone (unsafe name, duplicate sibling, oversize ...).
  note?: string
}

export interface SyncConflictInfo {
  placeKey: string
  file: string
  instancePath: string[]
  base: string | null
  disk: string
  studio: string
  // 'first-run': no base yet and Studio != disk.
  reason: 'both-changed' | 'first-run' | 'deleted-vs-edited'
}

// ---- Gate: whether Rojo may serve a place ----
export type GateState =
  | 'idle' // no Studio session for this place yet: Rojo serves normally (nothing to overwrite)
  | 'checking' // snapshot arriving / reconciling: Rojo held
  | 'clear' // reconciled: Rojo serves
  | 'blocked' // conflicts held: Rojo held until resolved or "serve anyway"

export interface PlaceSyncStatus {
  placeKey: string // `${placeId}` or `unpublished:<name>`
  projectFile: string // e.g. default.project.json
  place?: SyncPlace
  gate: GateState
  connected: boolean
  lastSnapshot?: number
  counts: Partial<Record<SyncAction, number>>
  conflicts: number
}

export interface SyncStatus {
  engine: 'forge' | 'project' | 'off'
  places: PlaceSyncStatus[]
  recent: SyncEntry[]
  // Files Forge wrote from Studio that git still shows as modified/untracked (uncommitted teammate edits).
  pendingStudioEdits: string[]
  legacyPluginInstalled?: boolean
  // Added by the integration worker: file names of the legacy plugin(s) found, and a warning shown
  // when a git pull / branch switch ran with uncommitted Studio edits.
  legacyPlugins?: string[]
  warning?: string
}

// Settings keys.
export const SYNC_ENGINE_SETTING = 'sync.engine' // 'forge' (default) | 'project' | 'off'
export const SYNC_GATE_SETTING = 'sync.gateRojo' // default true
