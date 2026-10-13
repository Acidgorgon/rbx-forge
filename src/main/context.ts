// What the agent layer needs from the rest of the main process.
// services/ implements it; agent/ only depends on this interface.
import type { ZodRawShape } from 'zod'
import type {
  GitStatus,
  HarnessEvents,
  LogLine,
  ProjectInfo,
  ScriptGroup,
  ServiceId,
  ServiceStatus,
  StudioConflict,
  TreeNode
} from '@shared/types'

export interface HarnessContext {
  project(): ProjectInfo | null
  tree(): TreeNode[]
  scripts(): ScriptGroup[]
  // Paths are repo-relative; implementations refuse paths that leave the project root.
  readFile(path: string): Promise<string>
  writeFile(path: string, contents: string): Promise<void>
  listFiles(dir: string): Promise<string[]>

  services(): ServiceStatus[]
  restartService(id: ServiceId): Promise<void>
  logs(service?: LogLine['service'], limit?: number): LogLine[]

  gitStatus(): Promise<GitStatus>
  syncNow(): Promise<GitStatus>
  studioConflicts(): Promise<StudioConflict[]>
  resolveStudioConflict(path: string, take: 'studio' | 'repo'): Promise<void>

  // Persistent per-user settings (userData/settings.json).
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void

  emit<K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]): void
  log(line: Omit<LogLine, 'at'>): void

  // Optional: tools from the integrated services (project map/search, Blink, Wally, Lune tests,
  // analytics), appended to the gentree tool list by gentreeTools(). main/integrations.ts provides
  // it; tests usually leave it out.
  serviceTools?(): ServiceToolSets
  // Optional: fire-and-forget team notification (Discord) for a failed test agent.
  notifyTestFailure?(event: { scenario: string; summary: string; details?: string }): void
}

// Tool shape shared with agent/tools.ts GentreeTool (structural; kept here so context.ts does not
// import the agent layer).
export interface ServiceTool {
  name: string
  description: string
  inputSchema: ZodRawShape
  handler: (args: any, extra: unknown) => Promise<{ content: { type: 'text'; text: string }[]; isError?: boolean }>
}

export interface ServiceToolSets {
  // Read-only: every agent, including test agents, guests (filtered) and scouts.
  read: ServiceTool[]
  // Lune: run_tests (read-only, every agent) and create_spec (writes one new spec file: chat,
  // test agents and orchestrator testers/builders).
  tests: ServiceTool[]
  // Change the project (Blink events, Wally deps): only agents that may write.
  write: ServiceTool[]
  // Main chat only, never guests, test agents or the orchestrator team (run_in_terminal, which the
  // user confirms in the UI before it runs).
  chat?: ServiceTool[]
}
