// IPC types for self-update (main/services/updater). electron-updater checks the GitHub Releases
// feed named in electron-builder.yml `publish`; HarnessApi / HarnessEvents extend UpdateApi /
// UpdateEvents.

export type UpdateChannel = 'stable' | 'beta'

// idle: not checked yet; disabled: this build cannot update (development, Linux); none: up to date.
export type UpdatePhase = 'idle' | 'disabled' | 'checking' | 'none' | 'available' | 'downloading' | 'ready' | 'error'

// install: download in the background and restart into the new version (Windows NSIS, or a
// Developer ID signed Mac). manual: only say there is one and open its release page (unsigned or
// ad-hoc signed Macs, which Squirrel.Mac refuses to update).
export type UpdateMode = 'install' | 'manual'

// private: the feed answered 404 (a private or renamed repo; Forge ships no token).
// noReleases: the repo has no published release yet. noMetadata: the release lacks latest*.yml.
export type UpdateErrorKind = 'private' | 'noReleases' | 'noMetadata' | 'offline' | 'rateLimited' | 'other'

export interface UpdateError {
  kind: UpdateErrorKind
  // One sentence for Settings.
  message: string
  // The underlying error text, for the log and a tooltip.
  detail?: string
}

export interface UpdateOffer {
  version: string
  releaseName?: string
  // Release notes as plain text (GitHub returns HTML; tags are stripped in main).
  notes?: string
  releaseDate?: string
  // The GitHub release page for this version.
  url: string
}

export interface UpdateState {
  phase: UpdatePhase
  mode: UpdateMode
  currentVersion: string
  channel: UpdateChannel
  autoCheck: boolean
  // owner/repo of the feed (electron-builder.yml publish), null when unknown (development).
  feed: string | null
  // Why phase is 'disabled', or why mode is 'manual'.
  note?: string
  offer?: UpdateOffer
  // 0..100 while downloading.
  percent?: number
  error?: UpdateError
  lastCheck?: number
  // Quick updates (main/services/quick): new app code without a new installer.
  quick?: QuickUpdateState
}

export interface UpdateSettings {
  autoCheck: boolean
  channel: UpdateChannel
  // Quick updates on (default). Off: no quick downloads, and the next launch runs the installed code.
  quick: boolean
}

// Which code this launch runs: the installed app's own ("bundled") or a quick update from
// userData/code/<version>.
export interface RunningCode {
  source: 'bundled' | 'quick'
  // The code's version: the app version, or <version>-quick.<n>.
  version: string
  // The installed app's version (what full updates compare against).
  appVersion: string
}

// unavailable: this build cannot use quick updates (note says why). none: nothing newer.
// ready: downloaded and verified, applies on restart. needsFull: a newer quick build exists but needs
// a newer installed app (different Electron or packages; message lists them).
export type QuickPhase = 'unavailable' | 'off' | 'idle' | 'checking' | 'none' | 'downloading' | 'ready' | 'needsFull' | 'error'

export interface QuickUpdateState {
  phase: QuickPhase
  enabled: boolean
  running: RunningCode
  // The quick version that is ready (or downloading, or needs a full update).
  version?: string
  // Commit and build time of that version.
  commit?: string
  createdAt?: string
  note?: string
  message?: string
  lastCheck?: number
}

export interface UpdateApi {
  updateGetState(): Promise<UpdateState>
  updateCheck(): Promise<UpdateState>
  updateSetSettings(patch: Partial<UpdateSettings>): Promise<UpdateState>
  // Restarts into the downloaded update (mode install, phase ready). The renderer asks first when
  // an agent is running or an editor has unsaved changes; this never checks.
  updateInstall(): Promise<void>
  // Opens the offered (or latest) release page in the browser.
  updateOpenRelease(): Promise<void>
  // Restarts Forge into the downloaded quick update (quick phase ready). The renderer asks first,
  // like updateInstall.
  updateQuickRestart(): Promise<void>
}

export interface UpdateEvents {
  'update:state': UpdateState
}
