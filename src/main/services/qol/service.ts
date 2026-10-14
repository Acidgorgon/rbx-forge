// Quality of life (main side, no electron imports): bug reports, done notifications, session state
// file and the "since you were away" digest. Electron specifics (capturePage, Notification, clipboard,
// shell) come in as deps from electron.ts.

import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { GitStatus, LogLine, StudioConflict } from '../../../shared/types.ts'
import type { SyncEntry, SyncStatus } from '../../../shared/sync/types.ts'
import type { RunSummary } from '../tests/types.ts'
import { assembleBugReport, reportStamp } from '../../../shared/qol/bugReport.ts'
import { buildDigest, commitsByOthers, GIT_LOG_FORMAT, parseGitLog, type GitCommit } from '../../../shared/qol/digest.ts'
import { NotifyRouter, shouldDeliver, type NotifyCandidate, type RouterOptions } from '../../../shared/qol/notify.ts'
import { parseSession, serializeSession, SESSION_FILE, type SessionState } from '../../../shared/qol/session.ts'
import {
  DEFAULT_QOL_SETTINGS,
  NOTIFY_CATEGORIES,
  type BugReportInput,
  type BugReportResult,
  type Digest,
  type ErrorRecord,
  type LabRunRecord,
  type NotifyMode,
  type QolSettings,
  type QolSettingsPatch
} from '../../../shared/qol/types.ts'

export const QOL_SETTING = 'qol'
const SEEN_FILE = 'qol-seen.json'
const MAX_ERRORS = 50
const MAX_JOURNAL = 1000

export interface QolDeps {
  userDataDir: string
  getSetting: <T>(key: string, fallback: T) => T
  setSetting: (key: string, value: unknown) => void
  logs: () => LogLine[]
  root: () => string | null
  projectName: () => string | undefined
  emit: (event: string, payload: unknown) => void
  log: (text: string, stream?: LogLine['stream']) => void
  isFocused: () => boolean
  // Shows one OS notification; onClick focuses Forge and opens the target. false: the OS has none.
  showNotification: (n: { title: string; body: string; sound: boolean }, onClick: () => void) => boolean | void
  focusWindow: () => void
  capture: () => Promise<Uint8Array | null>
  copy: (text: string) => void
  reveal: (path: string) => void
  app: { version: string; electron?: string; chrome?: string; node?: string; packaged?: boolean }
  os: { platform: string; release: string; arch: string }
  homeDir?: string
  git: (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>
  syncStatus: () => Promise<SyncStatus | null>
  studioConflicts: () => Promise<StudioConflict[]>
  gitStatus: () => Promise<GitStatus | null>
  testsLast: () => Promise<RunSummary | null>
  now?: () => number
  router?: RouterOptions
}

interface Seen {
  at: number
  head?: string
}

export function normalizeQolSettings(raw: unknown): QolSettings {
  const d = DEFAULT_QOL_SETTINGS
  const r = (raw && typeof raw === 'object' ? raw : {}) as Partial<QolSettings>
  const n = (r.notify && typeof r.notify === 'object' ? r.notify : {}) as Partial<QolSettings['notify']>
  const modes: NotifyMode[] = ['always', 'unfocused', 'off']
  const categories = { ...d.notify.categories }
  for (const c of NOTIFY_CATEGORIES) if (typeof n.categories?.[c] === 'boolean') categories[c] = n.categories[c]
  return {
    notify: { mode: modes.includes(n.mode as NotifyMode) ? (n.mode as NotifyMode) : d.notify.mode, sound: typeof n.sound === 'boolean' ? n.sound : d.notify.sound, categories },
    digest: typeof r.digest === 'boolean' ? r.digest : d.digest,
    restore: typeof r.restore === 'boolean' ? r.restore : d.restore
  }
}

function writeAtomic(file: string, text: string): void {
  const tmp = file + '.tmp'
  writeFileSync(tmp, text)
  try {
    renameSync(tmp, file)
  } catch {
    writeFileSync(file, text)
    rmSync(tmp, { force: true })
  }
}

export class QolService {
  private deps: QolDeps
  private now: () => number
  readonly router: NotifyRouter
  private errors: ErrorRecord[] = []
  private syncJournal: SyncEntry[] = []
  private labRuns: LabRunRecord[] = []
  private pendingShot: { at: number; png: Uint8Array } | null = null
  private previousSeen: Seen | null = null
  private openedAt = 0
  // The automatic 'open' digest was already asked for since this project opened (renderer reloads).
  private openDigestAsked = false
  private headSamples: { at: number; head: string }[] = []
  private extra: (() => Promise<string | null>) | null = null

  constructor(deps: QolDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.router = new NotifyRouter({ now: this.now, ...deps.router })
  }

  // ---- settings
  settings(): QolSettings {
    return normalizeQolSettings(this.deps.getSetting(QOL_SETTING, {}))
  }

  setSettings(patch: QolSettingsPatch): QolSettings {
    const cur = this.settings()
    const next = normalizeQolSettings({
      ...cur,
      ...patch,
      notify: { ...cur.notify, ...(patch.notify ?? {}), categories: { ...cur.notify.categories, ...(patch.notify?.categories ?? {}) } }
    })
    this.deps.setSetting(QOL_SETTING, next)
    return next
  }

  // ---- notifications
  // Every emitted harness event passes through here.
  observe(event: string, payload: unknown): void {
    try {
      if (event === 'sync:entry' && Array.isArray(payload)) {
        this.syncJournal.push(...(payload as SyncEntry[]))
        if (this.syncJournal.length > MAX_JOURNAL) this.syncJournal.splice(0, this.syncJournal.length - MAX_JOURNAL)
      }
      for (const c of this.router.observe(event, payload)) this.deliver(c)
    } catch (error) {
      this.deps.log(`[qol] notify ${event}: ${error}`, 'stderr')
    }
  }

  // Wraps an IPC handler: long lab / build calls notify when they end.
  timed<A extends unknown[], R>(name: string, handler: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      const start = this.now()
      const result = handler(...args)
      if (result && typeof (result as { then?: unknown }).then === 'function') {
        ;(result as unknown as Promise<unknown>).then(
          () => this.taskDone(name, start, true),
          (error) => this.taskDone(name, start, false, error instanceof Error ? error.message : String(error))
        )
      }
      return result
    }
  }

  private taskDone(name: string, start: number, ok: boolean, error?: string): void {
    try {
      const c = this.router.task(name, this.now() - start, ok, error)
      if (c) this.deliver(c)
    } catch (e) {
      // Runs in a promise callback: a throw here would be an unhandled rejection in main.
      this.deps.log(`[qol] notify ${name}: ${e}`, 'stderr')
    }
  }

  deliver(c: NotifyCandidate): boolean {
    if (c.run) {
      this.labRuns.push({ lab: c.target?.kind === 'page' ? c.target.page : 'lab', label: c.run.label, ok: c.run.ok, at: this.now(), target: c.target })
      if (this.labRuns.length > 200) this.labRuns.shift()
    }
    const s = this.settings().notify
    if (!shouldDeliver(s, c, this.deps.isFocused())) return false
    this.deps.showNotification({ title: c.title, body: c.body, sound: s.sound }, () => {
      this.deps.focusWindow()
      if (c.target) this.deps.emit('qol:navigate', c.target)
    })
    return true
  }

  testNotify(): void {
    const s = this.settings().notify
    const shown = this.deps.showNotification({ title: 'RBX Forge notifications work', body: 'Click to come back to Forge.', sound: s.sound }, () => this.deps.focusWindow())
    if (shown === false) throw new Error('This system does not support desktop notifications.')
  }

  // ---- errors
  recordError(origin: ErrorRecord['origin'], message: string, stack?: string): void {
    this.errors.push({ origin, message: String(message).slice(0, 2000), stack: stack?.slice(0, 6000), at: this.now() })
    if (this.errors.length > MAX_ERRORS) this.errors.shift()
  }

  recentErrors(): ErrorRecord[] {
    return this.errors.slice()
  }

  // ---- bug reports
  setBugReportExtra(fn: (() => Promise<string | null>) | null): void {
    this.extra = fn
  }

  async startBugReport(): Promise<{ screenshot: boolean }> {
    const png = await this.deps.capture().catch(() => null)
    this.pendingShot = png ? { at: this.now(), png } : null
    return { screenshot: !!png }
  }

  private async facts(input: BugReportInput, screenshot: string | null) {
    const root = this.deps.root()
    let extra: { title: string; body: string }[] = []
    if (this.extra) {
      const body = await this.extra().catch(() => null)
      if (body) extra = [{ title: 'Forge Doctor', body }]
    }
    return {
      what: input.what ?? '',
      expected: input.expected ?? '',
      at: this.now(),
      app: this.deps.app,
      os: this.deps.os,
      page: input.page,
      tab: input.tab,
      project: root ? { name: this.deps.projectName() ?? root.split(/[\\/]/).pop() ?? 'project', root } : null,
      includePath: !!input.includePath,
      homeDir: this.deps.homeDir,
      logs: this.deps.logs(),
      errors: this.errors,
      screenshot,
      extra
    }
  }

  async previewBugReport(input: BugReportInput): Promise<string> {
    return assembleBugReport(await this.facts(input, input.includeScreenshot && this.pendingShot ? 'screenshot.png' : null)).markdown
  }

  async bugReport(input: BugReportInput): Promise<BugReportResult> {
    const at = this.now()
    const parent = join(this.deps.userDataDir, 'bug-reports')
    let dir = join(parent, reportStamp(at))
    for (let i = 2; existsSync(dir); i++) dir = join(parent, `${reportStamp(at)}-${i}`)
    mkdirSync(dir, { recursive: true })
    let shot = input.includeScreenshot ? this.pendingShot?.png ?? null : null
    if (input.includeScreenshot && !shot) shot = await this.deps.capture().catch(() => null)
    let screenshotPath: string | null = null
    if (shot) {
      screenshotPath = join(dir, 'screenshot.png')
      writeFileSync(screenshotPath, shot)
    }
    const { markdown, redactions } = assembleBugReport(await this.facts(input, screenshotPath ? 'screenshot.png' : null))
    const reportPath = join(dir, 'report.md')
    writeFileSync(reportPath, markdown)
    this.pendingShot = null
    try {
      this.deps.copy(markdown)
    } catch {
      // Clipboard not available; the file is still there.
    }
    this.deps.log(`[qol] bug report saved to ${dir}${redactions ? ` (${redactions} values redacted)` : ''}`)
    return { dir, reportPath, screenshotPath, markdown, redactions }
  }

  // ---- session state
  private sessionFile(): string {
    return join(this.deps.userDataDir, SESSION_FILE)
  }

  loadSession(): SessionState {
    try {
      return parseSession(readFileSync(this.sessionFile(), 'utf8'))
    } catch {
      return parseSession(null)
    }
  }

  saveSession(state: SessionState): void {
    mkdirSync(this.deps.userDataDir, { recursive: true })
    writeAtomic(this.sessionFile(), serializeSession({ ...state, savedAt: this.now() }))
  }

  // ---- digest
  private seenAll(): Record<string, Seen> {
    try {
      const raw = JSON.parse(readFileSync(join(this.deps.userDataDir, SEEN_FILE), 'utf8'))
      return raw && typeof raw === 'object' ? raw : {}
    } catch {
      return {}
    }
  }

  private async head(root: string): Promise<string | undefined> {
    const r = await this.deps.git(['rev-parse', 'HEAD'], root).catch(() => null)
    const h = r && r.code === 0 ? r.stdout.trim() : ''
    return /^[0-9a-f]{7,}$/i.test(h) ? h : undefined
  }

  // Called when a project opens: remembers what "last seen" was before this session.
  async onProjectOpen(root: string): Promise<void> {
    this.previousSeen = this.seenAll()[root] ?? null
    this.openedAt = this.now()
    this.openDigestAsked = false
    this.headSamples = []
    const head = await this.head(root)
    if (head) this.headSamples.push({ at: this.now(), head })
  }

  async onProjectClose(): Promise<void> {
    await this.seen().catch(() => undefined)
    this.previousSeen = null
  }

  // The user is here (active, or dismissed the digest).
  async seen(): Promise<void> {
    const root = this.deps.root()
    if (!root) return
    const head = await this.head(root)
    const at = this.now()
    if (head) {
      this.headSamples.push({ at, head })
      if (this.headSamples.length > 50) this.headSamples.shift()
    }
    const all = this.seenAll()
    all[root] = { at, ...(head ? { head } : {}) }
    mkdirSync(this.deps.userDataDir, { recursive: true })
    writeAtomic(join(this.deps.userDataDir, SEEN_FILE), JSON.stringify(all, null, 1))
  }

  private async commitsSince(root: string, head: string | undefined, since: number): Promise<GitCommit[]> {
    const args = ['log', '--no-merges', `--format=${GIT_LOG_FORMAT}`, '-n', '50']
    const current = await this.head(root)
    if (head && current === head) return []
    if (head) args.push(`${head}..HEAD`)
    else if (since > 0) args.push(`--since=@${Math.floor(since / 1000)}`)
    else return []
    const r = await this.deps.git(args, root).catch(() => null)
    if (!r || r.code !== 0) return []
    const [email, name] = await Promise.all([this.deps.git(['config', 'user.email'], root).catch(() => null), this.deps.git(['config', 'user.name'], root).catch(() => null)])
    return commitsByOthers(parseGitLog(r.stdout), { email: email?.code === 0 ? email.stdout : undefined, name: name?.code === 0 ? name.stdout : undefined })
  }

  async digest(request: { reason: 'open' | 'idle'; since?: number; again?: boolean }): Promise<Digest | null> {
    if (!this.settings().digest) return null
    const root = this.deps.root()
    if (!root) return null
    if (request.reason === 'open' && !request.again) {
      if (this.openDigestAsked) return null
      this.openDigestAsked = true
    }
    let since: number
    let head: string | undefined
    if (request.reason === 'open') {
      // First time this project is opened: nothing to compare with, only current blockers.
      since = this.previousSeen?.at ?? this.openedAt ?? this.now()
      head = this.previousSeen?.head
    } else {
      since = request.since ?? this.now() - 60 * 60 * 1000
      head = [...this.headSamples].reverse().find((s) => s.at <= since)?.head ?? this.previousSeen?.head
    }
    const [syncStatus, studioConflicts, gitStatus, tests, commits] = await Promise.all([
      this.deps.syncStatus().catch(() => null),
      this.deps.studioConflicts().catch(() => []),
      this.deps.gitStatus().catch(() => null),
      this.deps.testsLast().catch(() => null),
      this.previousSeen || request.reason === 'idle' ? this.commitsSince(root, head, since) : Promise.resolve([])
    ])
    const digest = buildDigest({
      reason: request.reason,
      since,
      project: this.deps.projectName() ?? root.split(/[\\/]/).pop() ?? 'project',
      syncEntries: this.syncJournal,
      commits,
      labRuns: this.labRuns,
      syncStatus,
      studioConflicts,
      gitConflicts: gitStatus?.conflicts ?? [],
      tests: tests && tests.failed > 0 ? { failed: tests.failed, total: tests.total, failing: tests.results.filter((t) => t.status === 'fail').map((t) => ({ file: t.file, name: [t.suite, t.test].filter(Boolean).join(' > ') })) } : null
    })
    return digest.items.length ? digest : null
  }
}
