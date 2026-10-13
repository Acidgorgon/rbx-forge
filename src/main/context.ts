// What the agent layer needs from the rest of the main process.
// services/ implements it; agent/ only depends on this interface.
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
}
