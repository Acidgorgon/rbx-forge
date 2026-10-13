// IPC types for the toolchain setup (bundled rokit + global tools), per-project `rokit install` and
// the New project flow. Type-only re-exports of the services' own data types, like
// integrationTypes.ts. HarnessApi / HarnessEvents extend SetupApi / SetupEvents.

export type {
  GitInfo,
  RokitStatus,
  SetupMode,
  SetupProgress,
  SetupRecord,
  SetupResult,
  SetupStepResult,
  ToolState,
  ToolStatus,
  ToolchainStatus
} from '../main/services/setup/toolchain.ts'
export type {
  NewProjectInput,
  NewProjectProgress,
  NewProjectResult,
  NewProjectStepId,
  TemplateId
} from '../main/services/setup/newProject.ts'
export type { ProjectToolsEvent } from '../main/setup.ts'
import type { SetupMode, SetupProgress, SetupResult, ToolchainStatus } from '../main/services/setup/toolchain.ts'
import type { NewProjectInput, NewProjectProgress, NewProjectResult } from '../main/services/setup/newProject.ts'
import type { ProjectToolsEvent } from '../main/setup.ts'

export interface NewProjectDefaults {
  parentDir: string
  gitAvailable: boolean
}

export interface SetupApi {
  // Toolchain: rokit + pinned global tools + git.
  toolchainStatus(): Promise<ToolchainStatus>
  // install (missing only), repair (reinstall pinned) or update (latest releases); all tools or some.
  toolchainSetup(options?: { mode?: SetupMode; tools?: string[] }): Promise<SetupResult>
  toolchainCancel(): Promise<void>
  // "Skip for now" on the first-run screen (cancels a running setup).
  toolchainSkip(): Promise<void>
  // New project
  newProjectDefaults(): Promise<NewProjectDefaults>
  chooseFolder(title?: string, defaultPath?: string): Promise<string | null>
  createProject(input: NewProjectInput): Promise<NewProjectResult>
}

export interface SetupEvents {
  'toolchain:progress': SetupProgress
  'toolchain:projectTools': ProjectToolsEvent
  'newProject:progress': NewProjectProgress
}
