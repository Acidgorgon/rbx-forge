// UI Preview (UI Labs-style story preview in Forge) IPC types. HarnessApi extends UiPreviewApi and
// HarnessEvents extends UiPreviewEvents (types.ts).

import type { UiControl, UiInput, UiOp, UiStoryKind, UiTreeSnapshot } from './uiPreview/protocol.ts'

export type { UiControl, UiInput, UiOp, UiStoryKind, UiTreeSnapshot, UiNode, UiValue, UiProps } from './uiPreview/protocol.ts'

export type UiDevice = 'phone' | 'tablet' | 'desktop' | 'console'

export interface UiStoryEntry {
  // Repo-relative story file, e.g. src/shared/Interface/Stories/Hud.story.luau
  file: string
  // Display name: the module name without ".story".
  name: string
  // Instance path from the DataModel.
  path: string[]
  // Sub-folder inside the storybook (groupRoots / folders under a story root).
  folder?: string
  // Rojo project file that maps it (multi-place projects).
  projectFile: string
}

export interface UiStorybook {
  name: string
  file?: string
  error?: string
  stories: UiStoryEntry[]
}

export interface UiStoryList {
  storybooks: UiStorybook[]
  luneAvailable: boolean
  hint?: string
}

export interface UiOpenRequest {
  file: string
  width: number
  height: number
  device: UiDevice
  // Control values by key ("group/key" inside a ControlGroup).
  controls?: Record<string, unknown>
}

export interface UiConsoleEntry {
  at: number
  level: 'print' | 'warn' | 'error'
  text: string
  file?: string
  line?: number
}

export type UiSessionStatus = 'starting' | 'running' | 'reloading' | 'exited' | 'error'

export interface UiSessionState {
  session: number
  file: string
  status: UiSessionStatus
  kind?: UiStoryKind
  controls: UiControl[]
  values: Record<string, unknown>
  tree: UiTreeSnapshot
  console: UiConsoleEntry[]
  modules: string[]
  message?: string
}

export type UiPreviewEvent =
  | { session: number; type: 'reset'; file: string; status: UiSessionStatus; reason?: 'open' | 'reload' }
  | { session: number; type: 'story'; kind: UiStoryKind; controls: UiControl[] }
  | { session: number; type: 'ops'; ops: UiOp[] }
  | { session: number; type: 'console'; entry: UiConsoleEntry }
  | { session: number; type: 'status'; status: UiSessionStatus; message?: string }
  | { session: number; type: 'modules'; files: string[] }

export interface UiImageInfo {
  // http(s) or data: URL to draw, when available.
  url?: string
  state: 'ok' | 'placeholder' | 'error'
  // Why there is no image (shown on the placeholder).
  reason?: string
}

export interface UiPreviewApi {
  uiPreviewStories(): Promise<UiStoryList>
  uiPreviewOpen(request: UiOpenRequest): Promise<UiSessionState>
  uiPreviewClose(): Promise<void>
  uiPreviewInput(message: UiInput): Promise<void>
  uiPreviewState(): Promise<UiSessionState | null>
  // Image content strings (rbxassetid://..., rbxthumb://..., local paths) -> drawable URLs.
  uiPreviewImages(refs: string[]): Promise<Record<string, UiImageInfo>>
  // Saves an exported file (SVG, Forge JSON) under <project>/art/ui-exports/; returns its repo path.
  uiPreviewSaveExport(name: string, contents: string): Promise<string>
}

export interface UiPreviewEvents {
  'uiPreview:event': UiPreviewEvent
}
