// Editor assist: StyLua format (on save / Format Document), autosave, AI inline completions.
// IPC types between the renderer and main (services/editorAssist). No electron imports.

export type AutoSaveMode = 'off' | 'afterDelay' | 'onFocusChange'

export interface EditorAssistSettings {
  // null = automatic: on when StyLua is found (VS Code's editor.formatOnSave, StyLua as formatter).
  formatOnSave: boolean | null
  // Also format when autosave saves. Off by default, like VS Code (it never formats on autosave
  // after a delay, and formatting under the cursor while typing moves the text).
  formatOnAutoSave: boolean
  // Default 'onFocusChange' (VS Code's files.autoSave = onFocusChange).
  autoSave: AutoSaveMode
  // 'afterDelay' wait after the last edit (ms).
  autoSaveDelayMs: number
  // null = automatic: on when a completion provider is ready.
  aiCompletions: boolean | null
}

export const DEFAULT_EDITOR_ASSIST: EditorAssistSettings = {
  formatOnSave: null,
  formatOnAutoSave: false,
  autoSave: 'onFocusChange',
  autoSaveDelayMs: 1000,
  aiCompletions: null
}

export interface CompletionProviderStatus {
  ready: boolean
  // 'openai' | 'anthropic' | a backend id added later (codex).
  provider?: string
  model?: string
  // Shown in the status bar tooltip and Settings ("OpenAI gpt-6-luna", "needs an API key ...").
  detail: string
  // Set when the daily cap / spending cap pauses completions.
  paused?: string
}

export interface EditorAssistStatus {
  settings: EditorAssistSettings
  stylua: { found: boolean; path?: string }
  completions: CompletionProviderStatus
  // Settings with the automatic (null) values resolved.
  effective: { formatOnSave: boolean; aiCompletions: boolean }
}

export type FormatResult = { ok: true; text: string } | { ok: false; error: string; missing?: boolean }

export interface InlineCompletionRequest {
  // Renderer-chosen id, for cancel.
  id: string
  // Repo-relative path.
  path: string
  languageId: string
  // Text before / after the cursor (the renderer trims; main trims again).
  prefix: string
  suffix: string
  // `local X = require(...)` lines of the file (context when they are outside the window).
  requires?: string[]
}

export interface InlineCompletionResult {
  text: string
  // Why there is no suggestion when that is worth showing (cap reached, provider error).
  note?: string
}

export interface EditorAssistApi {
  editorAssistStatus(): Promise<EditorAssistStatus>
  editorAssistSetSettings(patch: Partial<EditorAssistSettings>): Promise<EditorAssistStatus>
  // Formats Luau text with the project's StyLua (stdin; the file on disk is not touched).
  formatLuau(path: string, text: string): Promise<FormatResult>
  inlineComplete(req: InlineCompletionRequest): Promise<InlineCompletionResult>
  inlineCompleteCancel(id: string): Promise<void>
}

export interface EditorAssistEvents {
  'editorAssist:status': EditorAssistStatus
}
