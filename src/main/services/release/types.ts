// Types for the Release service (main process). Plain data only, so the integrator can mirror them
// into src/shared/types.ts (see CONTRACT.md) and return service results over IPC as is.

// ---------------------------------------------------------------- injection points

// The subset of the WHATWG fetch the service uses. Node 22 / Electron's global fetch fits.
export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string | Uint8Array }
) => Promise<{
  status: number
  ok: boolean
  headers: { get(name: string): string | null }
  text(): Promise<string>
}>

export type Sleep = (ms: number) => Promise<void>

// Per-user secret storage. The app backs it with Electron safeStorage (see secrets.ts
// createEncryptedSecretStore); tests use MemorySecretStore. Never the repo, never .forge/.
export interface SecretStore {
  get(key: string): Promise<string | undefined>
  set(key: string, value: string): Promise<void>
  delete(key: string): Promise<void>
}

// Same shape as main/services/settings.ts Settings, so a Settings instance can be passed directly.
export interface KeyValueStore {
  get<T>(key: string, fallback: T): T
  set(key: string, value: unknown): void
}

// ---------------------------------------------------------------- modes and config

// rojo: build the place with `rojo build` and publish it (only for fully Rojo-managed projects).
// studio: Forge does checks/changelog/tag/notify; the person publishes from Studio (default).
// file: publish a place file the person exported from Studio (File > Save to File As…).
export type ReleaseMode = 'rojo' | 'studio' | 'file'

export type VersionType = 'Saved' | 'Published'

// Team settings read from the `publish` key of .forge/project.json (committed, no secrets).
export interface PublishConfig {
  mode?: ReleaseMode
  placeId?: number
  universeId?: number
  // Mode "file": path of the exported place, relative to the repo root or absolute.
  placeFile?: string
  versionType?: VersionType
  // Rojo project used for mode "rojo" (default default.project.json).
  rojoProject?: string
  // Tag prefix (default "v").
  tagPrefix?: string
}

// Per-user (not committed) release settings, kept in the app's Settings under release.<root>.
export interface ReleaseUserSettings {
  // Overrides PublishConfig.placeFile for this person (exports usually live outside the repo).
  placeFile?: string
  notifications: NotificationToggles
}

// ---------------------------------------------------------------- mode detection

export interface ModeDetection {
  // What Forge will use: project opt-in, else "rojo" only when detected fully managed, else "studio".
  mode: ReleaseMode
  source: 'project' | 'detected' | 'default'
  fullyManaged: boolean
  // Why the project is (not) considered fully managed, in plain words.
  reasons: string[]
}

export interface RojoBuildSummary {
  project: string
  // One line per mapped instance path -> source, e.g. "ReplicatedStorage.Shared <- src/shared".
  contains: string[]
  // Top-level services the build will contain; everything else in the live place is replaced/emptied.
  services: string[]
  warnings: string[]
}

// ---------------------------------------------------------------- preflight

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'skip'

export interface CheckOutcome {
  status: CheckStatus
  summary: string
  details?: string[]
}

export interface ReleaseCheck {
  id: string
  label: string
  // A blocking check that fails stops the release; non-blocking failures show as warnings.
  blocking: boolean
  run(): Promise<CheckOutcome>
}

export interface CheckResult extends CheckOutcome {
  id: string
  label: string
  blocking: boolean
  durationMs: number
}

export interface PreflightReport {
  ok: boolean
  checks: CheckResult[]
  blockers: string[]
}

// ---------------------------------------------------------------- changelog

export type ChangeKind = 'feature' | 'fix' | 'perf' | 'refactor' | 'docs' | 'test' | 'chore' | 'other'

export interface ChangelogCommit {
  hash: string
  author: string
  at: number
  subject: string
  kind: ChangeKind
  scope?: string
  breaking: boolean
  features: string[]
}

export interface StudioActivity {
  at: number
  path: string
  action: 'pull' | 'new' | 'conflict'
}

export interface Changelog {
  // Previous release tag, or null for the first release.
  since: string | null
  commits: ChangelogCommit[]
  studio: StudioActivity[]
  authors: string[]
  // Rendered Markdown; the UI lets the person edit it before releasing.
  markdown: string
}

// ---------------------------------------------------------------- version

export type BumpKind = 'major' | 'minor' | 'patch'

export interface VersionInfo {
  // Highest of the latest vX.Y.Z tag and .forge/project.json `version`; null when neither exists.
  current: string | null
  latestTag: string | null
  projectVersion: string | null
  // Where the version is recorded: "project" also updates .forge/project.json in a release commit.
  storage: 'tag' | 'project'
  suggestedBump: BumpKind
  next: Record<BumpKind, string>
}

// ---------------------------------------------------------------- plan and run

export interface ReleasePlan {
  root: string
  detection: ModeDetection
  mode: ReleaseMode
  placeId?: number
  universeId?: number
  placeIdChoices: number[]
  versionType: VersionType
  version: VersionInfo
  changelog: Changelog
  preflight: PreflightReport
  hasOpenCloudKey: boolean
  hasDiscordWebhook: boolean
  // Mode rojo: what the build contains, plus a token the run must echo back (blocking confirm).
  rojo?: RojoBuildSummary & { confirmToken: string }
  // Mode file: checks on the exported place file.
  placeFile?: PlaceFileInfo
  // Things the person should read before releasing (never secrets).
  warnings: string[]
}

export interface PlaceFileInfo {
  path: string
  exists: boolean
  format?: 'rbxl' | 'rbxlx'
  sizeBytes?: number
  modifiedAt?: number
  // Exported before the latest commit: probably missing recent work.
  stale?: boolean
  // .rbxlx only: instance classes Open Cloud does not update (from the place publishing guide).
  unsupportedClasses?: string[]
}

export interface ReleaseRunInput {
  mode: ReleaseMode
  bump?: BumpKind
  // Exact version instead of bump.
  version?: string
  // Edited changelog Markdown (defaults to the plan's).
  changelog?: string
  versionType?: VersionType
  placeId?: number
  universeId?: number
  // Mode rojo: must equal plan.rojo.confirmToken.
  confirmToken?: string
  // Push the release commit/tag to the remote (default true).
  push?: boolean
  // Post the release to Discord when a webhook is set and the toggle is on (default true).
  notify?: boolean
}

export type ReleaseStepId = 'preflight' | 'build' | 'publish' | 'version' | 'tag' | 'push' | 'notify'

export interface ReleaseStep {
  id: ReleaseStepId
  state: 'running' | 'done' | 'skipped' | 'failed'
  message?: string
}

export interface ReleaseRecord {
  version: string
  tag: string
  mode: ReleaseMode
  at: number
  by: string
  // Open Cloud version number (modes rojo/file).
  placeVersion?: number
  versionType?: VersionType
  placeId?: number
  // Mode studio: the person still has to publish from Studio.
  studioPublishPending?: boolean
  changelog: string
  notified: boolean
}

export interface ReleaseResult {
  ok: boolean
  record?: ReleaseRecord
  steps: ReleaseStep[]
  error?: string
  // Mode studio: "Publish from Studio now (File > Publish to Roblox)".
  nextAction?: string
}

// ---------------------------------------------------------------- notifications

export type NotifyEventKind = 'release' | 'publish' | 'sync' | 'push' | 'test-failure'

export type NotifyEvent =
  | { kind: 'release'; record: ReleaseRecord; game?: string }
  | { kind: 'publish'; version: string; placeId?: number; placeVersion?: number; by: string; game?: string; studio?: boolean }
  | { kind: 'sync'; by: string; pulled: number; pushed: number; branch?: string; game?: string; subjects?: string[] }
  | { kind: 'push'; by: string; branch: string; commits: number; subjects?: string[]; game?: string }
  | { kind: 'test-failure'; scenario: string; summary: string; by: string; details?: string; game?: string }

export interface NotificationToggles {
  release: boolean
  publish: boolean
  sync: boolean
  push: boolean
  'test-failure': boolean
}

export interface NotifyResult {
  sent: boolean
  // Why nothing was sent: toggle off, no webhook, throttled, nothing to report.
  skipped?: string
  error?: string
}
