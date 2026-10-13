// Contract shared by the main process, the preload bridge and the renderer.
// Every IPC channel the renderer can call is listed in HarnessApi.

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
  | 'Controllers'
  | 'Modules'
  | 'Events'
  | 'UI'
  | 'Entry points'
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
}

export interface ChatSession {
  id: string
  title: string
  createdAt: number
}

export type TestAgentState = 'queued' | 'running' | 'passed' | 'failed' | 'error' | 'cancelled'

export interface TestAgent {
  id: string
  // What the agent is asked to test, in plain words.
  scenario: string
  state: TestAgentState
  summary?: string
  startedAt?: number
  finishedAt?: number
}

export interface HarnessEvents {
  'services:status': ServiceStatus[]
  'log:line': LogLine
  'project:changed': ProjectInfo | null
  'tree:changed': TreeNode[]
  'scripts:changed': ScriptGroup[]
  'git:status': GitStatus
  'studio:conflicts': StudioConflict[]
  'chat:message': ChatMessage
  'chat:busy': { sessionId: string; busy: boolean }
  'agents:changed': TestAgent[]
  // JSON-RPC message from luau-lsp (or a harness/lsp* bridge notification), see lsp/index.ts.
  'lsp:message': unknown
}

export interface HarnessApi {
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
  newChat(): Promise<ChatSession>
  getChat(sessionId: string): Promise<ChatMessage[]>
  sendChat(sessionId: string, text: string): Promise<void>
  stopChat(sessionId: string): Promise<void>
  hasApiKey(): Promise<boolean>
  setApiKey(key: string): Promise<void>

  // Test agents
  getAgents(): Promise<TestAgent[]>
  runAgents(scenarios: string[]): Promise<TestAgent[]>
  cancelAgent(id: string): Promise<void>

  // Luau language server (main/services/lspBridge.ts). lspStart spawns luau-lsp for the open
  // project (true when running); lspSend passes one JSON-RPC message to it.
  lspStart(): Promise<boolean>
  lspSend(message: unknown): void

  on<K extends keyof HarnessEvents>(event: K, handler: (payload: HarnessEvents[K]) => void): () => void
}

// IPC channel names for invoke calls: "harness:<method>". Events use the HarnessEvents keys.
export const INVOKE_PREFIX = 'harness:'
