// Contract shared by the main process, the preload bridge and the renderer.
// Every IPC channel the renderer can call is listed in HarnessApi.

import type { IntegrationApi, IntegrationEvents, OrchestrateMode, UsageSummary } from './integrationTypes.ts'
import type { TerminalApi, TerminalEvents } from './terminalTypes.ts'
import type { ArtApi, ArtEvents } from './artTypes.ts'
import type { UiPreviewApi, UiPreviewEvents } from './uiPreviewTypes.ts'
export type * from './uiPreviewTypes.ts'
export type * from './artTypes.ts'
import type { SetupApi, SetupEvents } from './setupTypes.ts'
import type { ChatExtrasApi, ChatImage, EffortChoice, ModelMeta, NewChatOptions } from './chatTypes.ts'
// Collab, release, tests, analytics, usage, orchestrator and feature-rename IPC types.
export type * from './integrationTypes.ts'
import type { MemoryApi, MemoryEvents } from './memoryTypes.ts'
export type * from './memoryTypes.ts'
export type * from './terminalTypes.ts'
export type * from './setupTypes.ts'
export type * from './chatTypes.ts'
import type { UpdateApi, UpdateEvents } from './updateTypes.ts'
export type * from './updateTypes.ts'
import type { BrainSyncApi, BrainSyncEvents } from './brainSyncTypes.ts'
export type * from './brainSyncTypes.ts'
import type { VfxApi, VfxEvents } from './vfxTypes.ts'
export type * from './vfxTypes.ts'
import type { VfxTextureApi, VfxTextureEvents } from './vfxTextureTypes.ts'
export type * from './vfxTextureTypes.ts'
import type { AnimApi, AnimEvents } from './animTypes.ts'
export type * from './animTypes.ts'
import type { AbilityApi, AbilityEvents } from './abilityTypes.ts'
export type * from './abilityTypes.ts'
import type { StudioApi, StudioEvents } from './studio/types.ts'
export type * from './studio/types.ts'
import type { RefApi, RefEvents } from './refTypes.ts'
export type * from './refTypes.ts'

export type ServiceId = 'dev' | 'rojo' | 'lsp' | 'studioSync'

export type ServiceState = 'stopped' | 'starting' | 'running' | 'crashed' | 'missing'

export interface ServiceStatus {
  id: ServiceId
  label: string
  state: ServiceState
  pid?: number
  restarts: number
  // Short detail for the status bar, e.g. "rojo serve on :34872" or "rojo not found".
  detail?: string
}

export interface LogLine {
  service: ServiceId | 'git' | 'agent' | 'harness'
  stream: 'stdout' | 'stderr' | 'info'
  text: string
  at: number
}

// Roblox explorer tree: built from default.project.json, refined with sourcemap.json when present.
export interface TreeNode {
  name: string
  className: string
  // Repo-relative file path for scripts, if the node maps to a file.
  filePath?: string
  // Where the node is known from: the repo (Rojo files), the live Studio snapshot, or both.
  origin?: 'repo' | 'studio' | 'both'
  // A few asset properties from Studio (MeshId, SoundId, Size...), when known.
  props?: Record<string, string | number>
  children: TreeNode[]
}

// Roblox paths for a tree node, for the "Copy path" actions.
export interface RobloxPaths {
  // game.ReplicatedStorage.Assets["Sword Model"]
  dot: string
  // game:GetService("ReplicatedStorage").Assets:WaitForChild("Sword Model")
  service: string
  // ReplicatedStorage/Assets/Sword Model
  slash: string
}

export type ScriptCategory =
  | 'Configs'
  | 'Data'
  | 'Services'
  | 'Handlers'
  | 'Controllers'
  | 'Skills'
  | 'Modules'
  | 'Protocols'
  | 'Events'
  | 'UI'
  | 'Stories'
  | 'Entry points'
  | 'Tests'
  | 'Other'

export type ScriptKind = 'ModuleScript' | 'Script' | 'LocalScript'

export interface ScriptEntry {
  // Repo-relative path, forward slashes.
  path: string
  // Instance path in the DataModel, e.g. ["ReplicatedStorage", "Shared", "Features", "Inventory"].
  instancePath: string[]
  name: string
  kind: ScriptKind
  category: ScriptCategory
  // Feature folder the script belongs to, when under a Features/ or Controllers/ folder.
  feature?: string
  realm: 'shared' | 'server' | 'client'
  // Multi-place projects: project files (e.g. "default.project.json") whose mappings include this file.
  places?: string[]
}

export interface ScriptGroup {
  category: ScriptCategory
  scripts: ScriptEntry[]
}

export interface GitStatus {
  isRepo: boolean
  hasRemote: boolean
  branch?: string
  ahead: number
  behind: number
  dirty: number
  lastSync?: number
  // Set when the last sync stopped on a merge conflict; files that need a decision.
  conflicts: string[]
  error?: string
}

export interface StudioConflict {
  // Repo-relative path of the script that conflicts.
  path: string
  repoSource: string
  studioSource: string
}

export interface SyncSettings {
  // Minutes between automatic git syncs; 0 turns auto sync off.
  autoSyncMinutes: number
  // Commit local work before pulling (message "harness: sync").
  autoCommit: boolean
}

export interface ProjectInfo {
  root: string
  name: string
  placeIds: number[]
  // Every *.project.json at the root (default.project.json first) and the active one's file.
  places?: PlaceInfo[]
  activePlace?: string
}

// One Rojo place: a *.project.json at the project root (main/services/project.ts).
export interface PlaceInfo {
  // File name at the root, e.g. "menu.project.json". Used as the place id.
  file: string
  // Display name: the file's "name" field, or the file stem when that is missing or not unique.
  name: string
  isDefault: boolean
  // servePort from the project file (rojo's default 34872 when absent).
  servePort: number
  servePlaceIds: number[]
  // Repo-relative sourcemap for this place: sourcemap.json for the default place (the dev loop
  // writes it), .studio-sync/sourcemap.<stem>.json for the others (Forge runs rojo sourcemap).
  sourcemap: string
}

// App-wide switches the Settings tab changes (stored in the main process settings file).
export interface AppSettings {
  // rojo serves every place of a multi-place project, not only the active one.
  serveAllPlaces: boolean
  // Route simple chat turns to a cheaper model tier (agent/budget routeModel); off = always the chosen model.
  autoRoute: boolean
}

export interface PlacesChanged {
  places: PlaceInfo[]
  active: string
}

export type ChatRole = 'user' | 'assistant' | 'tool' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  // For tool messages: the tool's name and a short summary of its input.
  tool?: { name: string; input: string }
  at: number
  // Which agent wrote it: "main" for the chat, or a test agent id.
  agentId: string
  // Chat session the message belongs to (unset for test-agent messages).
  sessionId?: string
  // Group chats: the model that wrote it (host or guest). Unset on single-model chats.
  speaker?: Speaker
  // Group chats: 'plan' = the host's roundtable synthesis, 'checklist' = a plan turned into a task list.
  card?: 'plan' | 'checklist'
  // Attached (user) or produced (assistant/tool) images, as store references.
  images?: ChatImage[]
}

// A model taking part in a group chat. label is for display ("GPT-6.1 Sol"), alias is the
// @mention handle ("sol").
export interface Speaker {
  provider: ProviderId
  model: string
  label: string
}

export interface GroupParticipant extends Speaker {
  alias: string
  role: 'host' | 'guest'
}

// Tokens one model used in a group chat (as reported by its provider).
export interface GroupUsage {
  provider: ProviderId
  model: string
  label: string
  input: number
  output: number
  calls: number
}

// AI providers. 'anthropic' runs through the Claude Agent SDK; the others through Forge's own
// OpenAI-compatible agent loop (POST {baseUrl}/chat/completions, streamed, with function calling).
export type ProviderId = 'anthropic' | 'openai' | 'openrouter' | 'gemini' | 'ollama' | 'custom'

export const PROVIDER_IDS: ProviderId[] = ['anthropic', 'openai', 'openrouter', 'gemini', 'ollama', 'custom']

export interface ProviderInfo {
  id: ProviderId
  label: string
  // Usable now: has a key (anthropic: or the Claude login opt-in; ollama: server reachable;
  // custom: base URL set).
  ready: boolean
  // Whether the provider needs an API key at all (ollama does not; custom's key is optional).
  needsKey: boolean
  // Endpoint used for OpenAI-compatible providers (editable for custom and ollama).
  baseUrl?: string
  // Defaults plus any list fetched from GET /models (cached).
  models: string[]
  // Masked hint of the key in use, e.g. "…3f9a", and where it came from.
  keyHint?: string
  keySource?: 'stored' | 'env'
  // Short reason when not ready, e.g. "No API key" or "Ollama is not running at http://localhost:11434/v1".
  detail?: string
  // Runtime model metadata (vision, effort levels) by model id, when the provider reports it.
  meta?: Record<string, ModelMeta>
}

export interface ModelChoice {
  provider: ProviderId
  model: string
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
  provider: ProviderId
  model: string
  // Group chat: guest models (read-only advisers). The host is provider/model above.
  guests?: GroupParticipant[]
  // Group chat: whether guests may use the read-only project tools (default true).
  guestTools?: boolean
  // Group chat: per-model token usage.
  usage?: GroupUsage[]
  // Token/cost meter for the whole chat (all models), from the usage ledger.
  meter?: UsageSummary
  // Model routing of the last turn (budget/budget.ts routeModel): which model ran and why.
  route?: { model: string; tier: 'cheap' | 'big' | 'chosen'; reason: string; effort?: string }
  // Reasoning effort picked for this chat; unset = 'auto'.
  effort?: EffortChoice
  // Time of the last message (for lists sorted by activity).
  lastAt?: number
  // Team (orchestrator) mode for this chat; default 'auto'.
  orchestrate?: OrchestrateMode
  // Orchestrator runs started from this chat, oldest first (see getOrchestration).
  orchestrations?: string[]
}

export type TestAgentState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled'

export interface TestAgent {
  id: string
  // What the agent is asked to test, in plain words.
  scenario: string
  state: TestAgentState
  summary?: string
  provider?: ProviderId
  model?: string
  startedAt?: number
  finishedAt?: number
  // Tokens/cost of this agent run (usage ledger).
  usage?: UsageSummary
}

// Packages: Wally dependencies (wally.toml) and Rokit tools (rokit.toml). See main/services/packages.ts.
// Which wally.toml section a dependency lives in: [dependencies], [server-dependencies], [dev-dependencies].
export type WallyRealm = 'shared' | 'server' | 'dev'

// A package on the public Wally registry (api.wally.run).
export interface WallyPackage {
  scope: string
  name: string
  description?: string
  // Highest stable version (or highest prerelease when there is no stable one).
  latest: string
  // Newest first.
  versions: string[]
  // Realm the package declares in its own wally.toml; unknown until its metadata is fetched.
  realm?: 'shared' | 'server'
  authors?: string[]
  license?: string
  repository?: string
}

// One line of the project's wally.toml.
export interface WallyDependency {
  alias: string
  scope: string
  name: string
  // Version requirement as written, e.g. "2.0.3" (caret) or "=1.4.0".
  version: string
  realm: WallyRealm
  // Resolved version from wally.lock, when installed.
  installedVersion?: string
  // Packages/<Alias>.lua (ServerPackages/, DevPackages/) exists.
  installed: boolean
  latest?: string
  updateAvailable: boolean
}

export interface WallyAddSpec {
  scope: string
  name: string
  version: string
  realm: WallyRealm
  // Defaults to the package name in the file's alias style (e.g. Janitor, Videcharm).
  alias?: string
}

// A tool in rokit.toml, or a curated tool that is not added yet (inManifest false).
export interface RokitTool {
  // Alias in rokit.toml ([tools] name = "owner/repo@version").
  name: string
  // owner/repo on GitHub.
  repo: string
  // Version in rokit.toml (empty when not in the manifest).
  version: string
  inManifest: boolean
  // That exact version is in Rokit's tool storage.
  installed: boolean
  // Some binary by this name is on PATH (rokit shim or a global install).
  onPath: boolean
  description?: string
  // Latest GitHub release, when known (unauthenticated API, cached; may be missing when rate limited).
  latest?: string
  updateAvailable: boolean
}

export interface PackagesChanged {
  wally?: WallyDependency[]
  tools?: RokitTool[]
  // Install running after a change: 'wally' (dev loop or direct wally install) or 'rokit'.
  installing?: 'wally' | 'rokit' | null
  // Last install failure, shown inline in the Packages drawer.
  error?: string
}

// Blink networking (events.blink, github.com/1Axen/blink), parsed by main/services/blink.ts.
export interface BlinkEvent {
  kind: 'event' | 'function'
  name: string
  // Enclosing scopes, outermost first. Imported files add a scope named by `as` or the file name.
  scope: string[]
  // Events only. Functions are always invoked by the client and answered by the server.
  from?: 'Server' | 'Client'
  type?: 'Reliable' | 'Unreliable'
  call?: 'SingleSync' | 'SingleAsync' | 'ManySync' | 'ManyAsync' | 'Polling'
  poll?: boolean
  // Functions only.
  yield?: 'Coroutine' | 'Future' | 'Promise'
  // Data / Return as Blink source text, e.g. "(Instance(Player), u8)". Absent when omitted.
  data?: string
  return?: string
  // Repo-relative file and 1-based position of the declaration.
  file: string
  line: number
  column?: number
  // Line of the closing brace.
  endLine?: number
}

export interface BlinkTypeDecl {
  kind: 'type' | 'struct' | 'enum' | 'map' | 'set'
  name: string
  scope: string[]
  file: string
  line: number
  exported?: boolean
  generics?: string[]
  // Struct fields, enum variants or set flags (top level only).
  members?: string[]
  // Tagged enums: the tag field name.
  tag?: string
  // Source text after the name (or after `=`).
  definition?: string
}

export interface BlinkDiagnostic {
  file: string
  line: number
  column: number
  endLine?: number
  endColumn?: number
  // Blink's error message, e.g. 'Unknown option "Reliabl"'; detail is the label under the code.
  message: string
  detail?: string
  // Blink error code, e.g. "E2003".
  code?: string
  severity: 'error' | 'warning'
  related?: { file: string; line: number; column: number; message: string }[]
}

export interface BlinkModel {
  // Repo-relative entry file ("events.blink"), or null when the project has none.
  file: string | null
  events: BlinkEvent[]
  types: BlinkTypeDecl[]
  // `option` values of the entry file (ClientOutput, ServerOutput, Casing...).
  options: Record<string, string | boolean | number>
  // Errors from the last compile of a temp copy (empty when it compiled).
  diagnostics: BlinkDiagnostic[]
  optionLines?: Record<string, number>
  imports?: { path: string; scope: string[]; file?: string; from: string; line: number }[]
  // Repo-relative generated files (Blink appends .luau).
  outputs?: { client?: string; server?: string; types?: string }
  // Require expressions for the outputs from default.project.json, e.g. "ReplicatedStorage.Shared.events.client".
  // (Other *.project.json files are tried when default.project.json does not map an output.)
  requirePaths?: { client?: string; server?: string }
  // Every root *.blink file, each its own model (entry first, events.blink before the rest).
  // The top-level fields above stay the primary entry's model for older callers.
  files?: BlinkModel[]
  // A compile check is running.
  checking?: boolean
  checkedAt?: number
  // 'missing' when the blink binary was not found (no diagnostics then).
  checker?: 'blink' | 'missing'
  checkerDetail?: string
  blinkVersion?: string
}

export interface HarnessEvents extends IntegrationEvents, TerminalEvents, SetupEvents, MemoryEvents, ArtEvents, UpdateEvents, BrainSyncEvents, UiPreviewEvents, VfxEvents, VfxTextureEvents, AnimEvents, AbilityEvents, StudioEvents, RefEvents {
  'services:status': ServiceStatus[]
  'log:line': LogLine
  'project:changed': ProjectInfo | null
  'tree:changed': TreeNode[]
  'scripts:changed': ScriptGroup[]
  'git:status': GitStatus
  'studio:conflicts': StudioConflict[]
  'chat:message': ChatMessage
  'chat:busy': { sessionId: string; busy: boolean }
  // A chat's participants, options or usage changed (group chat).
  'chat:updated': ChatSession
  'agents:changed': TestAgent[]
  // Provider readiness/keys/models changed (a key was saved, a base URL edited...).
  'providers:changed': ProviderInfo[]
  // JSON-RPC message from luau-lsp (or a harness/lsp* bridge notification), see lsp/index.ts.
  'lsp:message': unknown
  // events.blink (or an import) was re-parsed or re-checked.
  'blink:changed': BlinkModel
  // Wally deps or Rokit tools changed, or an install started/finished.
  'packages:changed': PackagesChanged
  // Places were added/removed or the active place changed.
  'places:changed': PlacesChanged
}

export interface HarnessApi extends IntegrationApi, TerminalApi, SetupApi, ChatExtrasApi, MemoryApi, ArtApi, UpdateApi, BrainSyncApi, UiPreviewApi, VfxApi, VfxTextureApi, AnimApi, AbilityApi, StudioApi, RefApi {
  // Project
  openProject(root?: string): Promise<ProjectInfo | null>
  getProject(): Promise<ProjectInfo | null>
  getTree(): Promise<TreeNode[]>
  getScripts(): Promise<ScriptGroup[]>
  readFile(path: string): Promise<string>
  writeFile(path: string, contents: string): Promise<void>

  // Services
  getServices(): Promise<ServiceStatus[]>
  startService(id: ServiceId): Promise<void>
  stopService(id: ServiceId): Promise<void>
  restartService(id: ServiceId): Promise<void>
  getLogs(service?: LogLine['service']): Promise<LogLine[]>

  // Collaborator sync
  getGitStatus(): Promise<GitStatus>
  syncNow(): Promise<GitStatus>
  initGit(remoteUrl?: string): Promise<GitStatus>
  getSyncSettings(): Promise<SyncSettings>
  setSyncSettings(settings: SyncSettings): Promise<void>
  getStudioConflicts(): Promise<StudioConflict[]>
  resolveStudioConflict(path: string, take: 'studio' | 'repo'): Promise<void>

  // Chat
  listChats(): Promise<ChatSession[]>
  // Uses the default model unless a choice is given.
  newChat(choice?: ModelChoice, options?: NewChatOptions): Promise<ChatSession>
  getChat(sessionId: string): Promise<ChatMessage[]>
  // images: ids from addChatImage.
  sendChat(sessionId: string, text: string, images?: string[]): Promise<void>
  stopChat(sessionId: string): Promise<void>
  // Group chat (main/agent/groupChat.ts). Guests are read-only advisers; only the host edits.
  // Message text can also @mention a guest ("@sol what do you think?") to have it answer directly.
  addGuest(sessionId: string, choice: ModelChoice): Promise<ChatSession>
  // alias or "provider/model".
  removeGuest(sessionId: string, guest: string): Promise<ChatSession>
  setGuestTools(sessionId: string, on: boolean): Promise<ChatSession>
  // Models take turns on a topic for `rounds` rounds (default 2), then the host writes a plan card.
  startRoundtable(sessionId: string, topic: string, rounds?: number): Promise<void>
  // Posts the plan's steps as a checklist message.
  planToChecklist(sessionId: string, messageId: string): Promise<void>
  // Kept for older callers: both act on the anthropic provider.
  hasApiKey(): Promise<boolean>
  setApiKey(key: string): Promise<void>

  // Providers and models
  listProviders(): Promise<ProviderInfo[]>
  // Empty key clears the stored key. Keys are stored with Electron safeStorage, never returned.
  setProviderKey(provider: ProviderId, key: string): Promise<void>
  setProviderConfig(provider: ProviderId, config: { baseUrl?: string }): Promise<void>
  // Defaults plus GET /models when a key is present (cached).
  listModels(provider: ProviderId): Promise<string[]>
  setChatModel(sessionId: string, provider: ProviderId, model: string): Promise<void>
  getDefaultModel(): Promise<ModelChoice>
  setDefaultModel(provider: ProviderId, model: string): Promise<void>
  // Opt-in: let the anthropic provider fall back to an existing Claude Code login
  // (or CLAUDE_CODE_OAUTH_TOKEN) when no API key is set. Personal use only.
  getAnthropicUseClaudeLogin(): Promise<boolean>
  setAnthropicUseClaudeLogin(on: boolean): Promise<void>

  // Test agents
  getAgents(): Promise<TestAgent[]>
  // Runs on the given model, or the default model. Studio MCP tools need the anthropic provider.
  runAgents(scenarios: string[], choice?: ModelChoice): Promise<TestAgent[]>
  cancelAgent(id: string): Promise<void>

  // Luau language server (main/services/lspBridge.ts). lspStart spawns luau-lsp for the open
  // project (true when running); lspSend passes one JSON-RPC message to it.
  lspStart(): Promise<boolean>
  lspSend(message: unknown): void

  // Packages (main/services/packages.ts). Wally search hits api.wally.run; wally.toml and rokit.toml
  // edits keep comments and order. Changes return the new list and install in the background
  // (the dev loop's wally install, or wally/rokit directly), reported by 'packages:changed'.
  searchWally(query: string): Promise<WallyPackage[]>
  // "scope/name"
  wallyPackage(id: string): Promise<WallyPackage>
  listWallyDeps(): Promise<WallyDependency[]>
  // Adds, or updates the version when the alias already names the same package in that realm.
  addWallyDep(spec: WallyAddSpec): Promise<WallyDependency[]>
  removeWallyDep(alias: string, realm: WallyRealm): Promise<WallyDependency[]>
  // Rewrites the version (default: latest).
  updateWallyDep(alias: string, realm: WallyRealm, version?: string): Promise<WallyDependency[]>
  listRokitTools(): Promise<RokitTool[]>
  // repo is owner/repo; version defaults to the latest GitHub release.
  addRokitTool(repo: string, version?: string): Promise<RokitTool[]>
  // Rewrites the tool's version to the latest release and runs rokit install.
  updateRokitTool(name: string): Promise<RokitTool[]>
  // Common Roblox tools (luau-lsp, StyLua, selene, Lune...) with manifest/install state.
  curatedTools(): Promise<RokitTool[]>

  // Blink: events.blink parsed (with imports) plus diagnostics from the last compile check.
  getBlink(): Promise<BlinkModel>

  // Places (*.project.json at the root). The explorer, scripts, sourcemap, luau-lsp and rojo serve
  // follow the active place; it is remembered per project.
  listPlaces(): Promise<PlaceInfo[]>
  getActivePlace(): Promise<PlaceInfo | null>
  setActivePlace(file: string): Promise<PlaceInfo>

  // App-wide switches (serveAllPlaces restarts a running rojo so it serves the new set of places).
  getAppSettings(): Promise<AppSettings>
  setAppSettings(patch: Partial<AppSettings>): Promise<AppSettings>

  on<K extends keyof HarnessEvents>(event: K, handler: (payload: HarnessEvents[K]) => void): () => void
}

// IPC channel names for invoke calls: "harness:<method>". Events use the HarnessEvents keys.
export const INVOKE_PREFIX = 'harness:'
