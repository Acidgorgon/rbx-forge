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
}

// An Instance-reference property set inside a mapped root (ObjectValue.Value, Weld.Part0,
// Beam.Attachment0, Model.PrimaryPart ...). Forge Sync does not carry references to disk: the plugin
// only reports where they are, so the UI can say they stay in Studio.
export interface SyncRef {
  path: string[]
  property: string
}

// One instance of the Game-tab outline (plugin version 5): the services/containers the project maps,
// outside the synced $path roots (e.g. ReplicatedStorage.Assets). Names and classes only, plus a
// few asset ids for display. Never written to disk.
export interface StudioOutlineNode {
  path: string[]
  className: string
  props?: Record<string, string>
}

export interface SyncPlace {
  // Roblox PlaceId (0 when unpublished) and GameId.
  placeId: number
  gameId?: number
  name?: string
  // Plugin v8, unpublished places only: the link id stored in the place (ServerStorage attribute
  // ForgeSyncLink) once the user linked it to a project in Forge. Absent: not linked (or older plugin).
  linkId?: string
}

// Plugin v11: a cheap fingerprint of a Studio place, sent with each config request, so places that
// share a name (every unpublished place is "Place1") can be told apart in Source Control.
export interface PlaceFingerprint {
  // Workspace's top-level children (not Camera / Terrain), sorted, up to FINGERPRINT_NAMES of them.
  workspace: string[]
  // How many top-level Workspace children there are in all.
  workspaceCount: number
  // Scripts (LuaSourceContainers) in the place's main services (the plugin stops counting at 100000).
  scripts: number
}

export const FINGERPRINT_NAMES = 6

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
  | 'idle' // no Studio session for this place (the engine's view), or Forge Sync is not gating: Rojo serves
  | 'waiting' // no checked Studio session for this place file (Studio not open, the open place is not
  //           linked, or its Forge Bridge plugin is too old): Rojo held until Studio's first sync check
  //           clears, or the user picks "Serve without Studio check"
  | 'checking' // config / snapshot arriving / reconciling: Rojo held
  | 'clear' // reconciled: Rojo serves
  | 'blocked' // conflicts (or Studio-only scripts not on disk) held: Rojo held until resolved or "serve anyway"

// Why a place file is 'waiting': no Studio check yet ('studio'), a Studio place is open that is not
// linked to this project ('unlinked'), or Studio runs a Forge Bridge plugin older than the gate trusts
// ('plugin': restart Studio to load the new one).
export type WaitReason = 'studio' | 'unlinked' | 'plugin'

export interface PlaceSyncStatus {
  placeKey: string // `${placeId}` (published) or `local:<linkId>` (unpublished, linked in Forge)
  projectFile: string // e.g. default.project.json
  place?: SyncPlace
  gate: GateState
  // gate 'waiting': why, and the one-line text the UI shows.
  waitReason?: WaitReason
  gateDetail?: string
  // The Forge Bridge plugin version this place's Studio runs (from its bridge poll), when known.
  pluginVersion?: number
  // Plugin v11: what the Studio place looked like when its check started (fingerprintText), one line.
  fingerprint?: string
  connected: boolean
  lastSnapshot?: number
  counts: Partial<Record<SyncAction, number>>
  conflicts: number
  // Studio-only instances Forge leaves in Studio (outside every Rojo $path, or Studio-only children of
  // an $ignoreUnknownInstances root): how many top-level ones, a few examples and why, in one line.
  leftInStudio?: { count: number; examples: string[]; note: string }
  // Mapped roots (instance paths joined with '.') the last Studio snapshot did not have: nothing
  // under them is synced until they exist in Studio (e.g. Rojo has not connected yet).
  missingRoots?: string[]
  // Scripts that exist only in Studio (no file on disk) and that Rojo would delete from Studio when
  // it connects. `holds`: rojo serve is held for them (found by a snapshot or a resolve) until they
  // are pulled to disk or the user serves anyway. Items capped at STUDIO_ONLY_MAX; count is not.
  studioOnly?: { count: number; pullable: number; holds: boolean; items: StudioOnlyScript[] }
}

export const STUDIO_ONLY_MAX = 50

// A script in Studio under a mapped root with no file on disk, which Rojo would delete from Studio
// when it (re)connects: its topmost Studio-only ancestor is not a direct child of an
// $ignoreUnknownInstances root (Rojo only leaves those alone).
export interface StudioOnlyScript {
  instancePath: string[]
  // The file "Pull to disk" writes; absent when Forge cannot write it (reason says why).
  file?: string
  reason: string
  canPull: boolean
}

// Why Studio edits are NOT reaching disk right now, when they are not (shown in the Sync view and the
// status bar). 'install-plugin': the Forge Bridge plugin is missing; 'restart-studio': Studio runs an
// older plugin than the one installed.
export interface SyncNotice {
  level: 'warn' | 'info'
  text: string
  action?: 'install-plugin' | 'restart-studio'
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
  // Added by sync-polish: Instance-reference properties under the mapped roots of connected Studio
  // sessions (not synced; they stay in Studio). Capped at UNSYNCED_REFS_MAX; the total is uncapped.
  unsyncedRefs?: SyncRef[]
  unsyncedRefsTotal?: number
  notice?: SyncNotice
  // Studio places the Forge Bridge plugin reported that are NOT linked to this project: nothing from
  // them is applied, written, trashed or held. The Source Control view lists them collapsed with Link.
  unlinked?: UnlinkedPlace[]
  // One-time: Forge dropped sync state of places that were never linked (shown once as a toast).
  discarded?: { id: string; text: string }
}

// A Studio place talking to Forge that this project does not sync (not in servePlaceIds /
// tools/studio-sync.json placeIds and not linked in Forge).
export interface UnlinkedPlace {
  // Opaque handle for syncLinkPlace (per Studio session for unpublished places).
  id: string
  name: string
  placeId: number
  lastSeen: number
  // false: cannot be linked from here (why says what to do, e.g. restart Studio for plugin v8).
  canLink: boolean
  why: string
  // The name, or "Place1 #2" when other unlinked places have the same name (numbered in the order
  // Forge first saw them). Identify shows this label in that Studio window.
  label?: string
  // Plugin v11: what is in the place (fingerprintText), one line.
  fingerprint?: string
  // Plugin v11 (sends a fingerprint): "Identify" makes that Studio window show its label.
  canIdentify?: boolean
}

export const UNSYNCED_REFS_MAX = 100

// Settings keys.
export const SYNC_ENGINE_SETTING = 'sync.engine' // 'forge' (default) | 'project' | 'off'
export const SYNC_GATE_SETTING = 'sync.gateRojo' // default true
