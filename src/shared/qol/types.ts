// Quality of life: bug reports, done notifications, session restore and the "since you were away"
// digest. Plain data shared by main, preload and renderer. No electron imports.

import type { SessionState } from './session.ts'

// A place in Forge that a notification or a digest line opens.
export type QolTarget =
  | { kind: 'page'; page: string; entryId?: string }
  | { kind: 'file'; path: string; line?: number }
  | { kind: 'side'; view: 'explorer' | 'scripts' | 'events' | 'sync' | 'tests' | 'team' }
  | { kind: 'conflict'; path: string }
  | { kind: 'chat'; sessionId: string }
  | { kind: 'bottom'; tab: 'output' | 'problems' }

// ---- Done notifications ----
export type NotifyCategory = 'labs' | 'team' | 'chat' | 'builds' | 'sync'
export const NOTIFY_CATEGORIES: NotifyCategory[] = ['labs', 'team', 'chat', 'builds', 'sync']
// always: also while Forge is focused; unfocused: only while another app is in front; off: never.
export type NotifyMode = 'always' | 'unfocused' | 'off'

export interface NotifySettings {
  mode: NotifyMode
  // Play the OS notification sound.
  sound: boolean
  categories: Record<NotifyCategory, boolean>
}

export interface QolSettings {
  notify: NotifySettings
  // "Since you were away" card on project open and after an hour idle.
  digest: boolean
  // Reopen tabs, pages, panel layout, drafts and lab selections on start.
  restore: boolean
}

export interface QolSettingsPatch {
  notify?: Partial<Omit<NotifySettings, 'categories'>> & { categories?: Partial<Record<NotifyCategory, boolean>> }
  digest?: boolean
  restore?: boolean
}

export const DEFAULT_QOL_SETTINGS: QolSettings = {
  notify: { mode: 'unfocused', sound: true, categories: { labs: true, team: true, chat: true, builds: true, sync: true } },
  digest: true,
  restore: true
}

// ---- Bug reports ----
export interface BugReportInput {
  what: string
  expected: string
  // Full project path instead of the project name only.
  includePath: boolean
  includeScreenshot: boolean
  // Open page / tab as the renderer sees it ("VFX Lab", "src/server/Foo.luau").
  page?: string
  tab?: string
}

export interface BugReportResult {
  // userData/bug-reports/<ts>/
  dir: string
  reportPath: string
  screenshotPath: string | null
  markdown: string
  // How many secrets the redactor replaced.
  redactions: number
}

export interface ErrorRecord {
  origin: 'renderer' | 'main'
  message: string
  stack?: string
  at: number
}

// ---- "Since you were away" ----
export type DigestKind = 'studio' | 'commit' | 'lab' | 'conflict' | 'blocker' | 'tests'

export interface DigestItem {
  id: string
  kind: DigestKind
  text: string
  detail?: string
  at?: number
  target?: QolTarget
}

export interface Digest {
  reason: 'open' | 'idle'
  since: number
  project: string
  items: DigestItem[]
}

// A lab / long task that finished while the user was away (kept by main for the digest).
export interface LabRunRecord {
  lab: string
  label: string
  ok: boolean
  at: number
  name?: string
  target?: QolTarget
}

export interface QolApi {
  qolGetSettings(): Promise<QolSettings>
  qolSetSettings(patch: QolSettingsPatch): Promise<QolSettings>
  // Writes userData/bug-reports/<ts>/report.md (+ screenshot.png) and copies the markdown. Never uploads.
  // Takes the window screenshot now (before the dialog covers the page); qolBugReport uses it.
  qolBugReportStart(): Promise<{ screenshot: boolean }>
  qolBugReport(input: BugReportInput): Promise<BugReportResult>
  // The markdown that would be written (no screenshot taken), for the dialog's preview.
  qolBugReportPreview(input: BugReportInput): Promise<string>
  qolRevealPath(path: string): Promise<void>
  qolReportError(error: { message: string; stack?: string }): Promise<void>
  qolLoadSession(): Promise<SessionState>
  qolSaveSession(state: SessionState): Promise<void>
  // null when the setting is off, no project is open or nothing happened. An automatic 'open' digest
  // is answered once per project open in this app session (a renderer reload gets null); `again`
  // (the Show digest command, a refresh of the open card) always answers.
  qolDigest(request: { reason: 'open' | 'idle'; since?: number; again?: boolean }): Promise<Digest | null>
  // The user saw / dismissed the digest, or is active: moves "last seen" to now.
  qolSeen(): Promise<void>
  qolTestNotify(): Promise<void>
}

export interface QolEvents {
  // A notification was clicked: Forge is focused, the renderer opens the target.
  'qol:navigate': QolTarget
  // Main asks the renderer to open the bug report dialog (e.g. from a menu).
  'qol:bugReport': { at: number }
}
