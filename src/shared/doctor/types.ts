// Forge Doctor: one run checks the whole setup (toolchain, git, Studio + Forge Bridge, ports, Forge
// Sync, keys, disk, the project itself, updates, macOS permissions) and shows a green / amber / red
// list, each line with a one-click fix or the exact thing to do. Probes (main/services/doctor)
// gather a DoctorInputs snapshot; checks.ts turns it into DoctorChecks (pure, tested).

export type DoctorStatus = 'ok' | 'warn' | 'fail' | 'skip'

export type DoctorGroup = 'Toolchain' | 'Git' | 'Studio' | 'Ports' | 'Sync' | 'Keys' | 'Disk' | 'Project' | 'App'

// Fixes main runs itself (doctorFix).
export type DoctorAction =
  | 'installTools' // rokit + pinned global tools (toolchainSetup repair)
  | 'installProjectTools' // rokit install in the project
  | 'installPlugin' // Forge Bridge plugin into the Studio plugins folder
  | 'disableLegacyPlugins' // move the legacy StudioSync plugin(s) aside
  | 'wallyInstall'
  | 'sourcemap' // rojo sourcemap for luau-lsp
  | 'startRojo'
  | 'stopStrayRojo' // a rojo Forge does not run that holds a serve port
  | 'checkUpdates'
  | 'openScreenRecording' // macOS System Settings > Privacy > Screen Recording

export type DoctorFix =
  | { kind: 'action'; action: DoctorAction; label: string }
  // Renderer navigation: 'settings:<section id>', 'page:<page>', 'side:<view>'.
  | { kind: 'open'; target: string; label: string }
  | { kind: 'instruction'; text: string; command?: string; url?: string }

export interface DoctorCheck {
  id: string
  group: DoctorGroup
  title: string
  status: DoctorStatus
  detail: string
  fix?: DoctorFix
}

export interface DoctorReport {
  at: number
  checks: DoctorCheck[]
  counts: Record<DoctorStatus, number>
  // Worst status (skip counts as ok).
  overall: Exclude<DoctorStatus, 'skip'>
  ms: number
  appVersion: string
  platform: string
}

// ---- probe snapshot ----

export interface ToolProbe {
  alias: string
  pinned: string
  version: string | null
  // Same states as the toolchain setup (services/setup/toolchain.ts ToolState).
  state: 'ok' | 'other' | 'broken' | 'external' | 'missing'
}

export interface PortProbe {
  port: number
  label: string
  // free: nothing listens; ours: the expected Forge process (bridge / rojo we run) holds it;
  // other: something else holds it; unknown: could not test.
  state: 'free' | 'ours' | 'other' | 'unknown'
  // Whether Forge expects something to be listening right now.
  expected: boolean
  // state 'other': the process listening there, when Forge could tell (rojo: a stray rojo serve).
  owner?: { pid: number; name: string; rojo: boolean }
}

export interface DiskProbe {
  label: string
  path: string
  freeBytes: number | null
}

export interface ProjectFileProbe {
  file: string
  ok: boolean
  error?: string
  servePort?: number
}

export interface DoctorInputs {
  platform: string
  appVersion: string
  isPackaged: boolean
  toolchain: { rokit: { installed: boolean; version: string | null }; tools: ToolProbe[] } | null
  git: { available: boolean; version: string | null; hint?: string; downloadUrl?: string }
  gh: { available: boolean; version: string | null; authed: boolean | null }
  // Only probed when the Forge Sync engine is 'project' (the project's Python studio-sync).
  python: { available: boolean; version: string | null } | null
  // null: Studio does not run on this OS.
  studioInstall: { installed: boolean; path?: string } | null
  bridge: {
    port: number
    listening: boolean
    error?: string
    plugin: { installed: boolean; version?: number; bundled: number; outdated?: boolean; dir: string | null }
    studio: { connected: boolean; lastSeen?: number; place?: string; pluginVersion?: number }
  } | null
  legacyPlugins: string[]
  ports: PortProbe[]
  rojo: 'running' | 'starting' | 'stopped' | 'crashed' | 'missing' | null
  sync: {
    engine: 'forge' | 'project' | 'off'
    places: { projectFile: string; gate: string; conflicts: number; connected: boolean; studioOnly?: number }[]
    pendingStudioEdits: number
  } | null
  keys: { provider: string; label: string; set: boolean; isDefault: boolean; local?: boolean }[]
  openCloud: { set: boolean; introspect?: { enabled: boolean; expired: boolean; scopes: string[] } | { error: string } }
  openAiKey: boolean
  disk: DiskProbe[]
  project: {
    root: string
    projectFiles: ProjectFileProbe[]
    wallyToml: boolean
    packagesInstalled: boolean
    rokitToml: boolean
    projectToolsMissing: string[]
    sourcemap: { exists: boolean; ageMs?: number }
    // Project nodes Rojo builds twice (an explicit child and a same-name entry of its parent's $path
    // folder), one line each (mapping.ts duplicateMappingText).
    duplicateMappings?: string[]
  } | null
  updater: { state: string; version?: string; error?: string } | null
  // The Intel (x64) build is running under Rosetta on an Apple Silicon Mac.
  rosetta?: boolean
  // macOS only; null elsewhere.
  screenRecording: 'granted' | 'denied' | 'not-determined' | 'restricted' | 'unknown' | null
}

export interface DoctorApi {
  doctorRun(): Promise<DoctorReport>
  // The last report this session (null before the first run).
  doctorLast(): Promise<DoctorReport | null>
  doctorFix(action: DoctorAction): Promise<{ ok: boolean; message: string }>
}

export interface DoctorEvents {
  'doctor:report': DoctorReport
}
