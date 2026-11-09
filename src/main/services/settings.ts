import { existsSync, readFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'
import { CoalescedJsonWriter, writeAtomicSync } from './jsonWriter.ts'

// Chat history (up to 100 chats x 500 messages) lives in its own file so a settings change does not
// rewrite it, and it is written without pretty-print indentation.
export const CHATS_SETTING = 'chats'
export const CHATS_FILE = 'chats.json'

export interface SettingsOptions {
  // Delay that coalesces a burst of set() calls into one write (ms).
  saveDelayMs?: number
  onError?: (error: unknown) => void
}

// Per-user settings kept as one JSON file (userData/settings.json in the app), except the 'chats'
// key, which reads and writes userData/chats.json. set() updates memory at once (every get sees it)
// and writes coalesce: one asynchronous atomic write per burst. Call flushSync() on quit/exit.
export class Settings {
  private file: string
  private chatsFile: string
  private data: Record<string, unknown> = {}
  // undefined: no chats stored.
  private chats: unknown = undefined
  private writer: CoalescedJsonWriter
  private chatsWriter: CoalescedJsonWriter
  private onError?: (error: unknown) => void

  constructor(dir: string, opts: SettingsOptions = {}) {
    this.onError = opts.onError
    this.file = join(dir, 'settings.json')
    this.chatsFile = join(dir, CHATS_FILE)
    try {
      const parsed = JSON.parse(readFileSync(this.file, 'utf8'))
      if (parsed && typeof parsed === 'object') this.data = parsed
    } catch {
      this.data = {}
    }
    const writerOpts = { delayMs: opts.saveDelayMs ?? 250, onError: opts.onError }
    this.writer = new CoalescedJsonWriter(this.file, () => JSON.stringify(this.data, null, 2), writerOpts)
    this.chatsWriter = new CoalescedJsonWriter(this.chatsFile, () => JSON.stringify(this.chats ?? null), writerOpts)
    this.loadChats()
  }

  get<T>(key: string, fallback: T): T {
    if (key === CHATS_SETTING) return this.chats === undefined ? fallback : (this.chats as T)
    return key in this.data ? (this.data[key] as T) : fallback
  }

  set(key: string, value: unknown): void {
    if (key === CHATS_SETTING) {
      this.chats = value === undefined ? undefined : value
      this.chatsWriter.schedule()
      return
    }
    if (value === undefined) delete this.data[key]
    else this.data[key] = value
    this.writer.schedule()
  }

  lastProject(): string | undefined {
    const value = this.data.lastProject
    return typeof value === 'string' ? value : undefined
  }

  setLastProject(root: string | undefined): void {
    this.set('lastProject', root)
  }

  // Writes pending changes now; resolves when they are on disk.
  async flush(): Promise<void> {
    await Promise.all([this.writer.flush(), this.chatsWriter.flush()])
  }

  // Writes pending changes synchronously: app quit and process exit, so nothing set is lost.
  flushSync(): void {
    this.writer.flushSync()
    this.chatsWriter.flushSync()
  }

  // chats.json, or the 'chats' key of an older settings.json moved into it (written first, then the
  // key removed from settings.json, so a crash in between leaves both copies rather than neither).
  private loadChats(): void {
    const legacy = CHATS_SETTING in this.data
    if (existsSync(this.chatsFile)) {
      try {
        const parsed = JSON.parse(readFileSync(this.chatsFile, 'utf8'))
        this.chats = parsed === null ? undefined : parsed
      } catch {
        // Unreadable: keep it aside rather than overwrite it with the next save.
        try {
          renameSync(this.chatsFile, `${this.chatsFile}.corrupt-${Date.now()}`)
        } catch {
          // Leave it; the next save replaces it.
        }
        if (legacy) return this.migrate()
      }
      if (legacy) {
        // Both exist (a crash mid-migration, or an older Forge ran since): chats.json wins and the
        // settings copy is kept aside, not dropped.
        try {
          writeAtomicSync(`${this.chatsFile.replace(/\.json$/, '')}.legacy-${Date.now()}.json`, JSON.stringify(this.data[CHATS_SETTING] ?? null))
          delete this.data[CHATS_SETTING]
          writeAtomicSync(this.file, JSON.stringify(this.data, null, 2))
        } catch (error) {
          this.onError?.(error)
        }
      }
      return
    }
    if (legacy) this.migrate()
  }

  private migrate(): void {
    const value = this.data[CHATS_SETTING]
    this.chats = value === null ? undefined : value
    try {
      writeAtomicSync(this.chatsFile, JSON.stringify(value ?? null))
    } catch (error) {
      // settings.json keeps its copy; the next chats write tries chats.json again.
      this.onError?.(error)
      return
    }
    delete this.data[CHATS_SETTING]
    try {
      writeAtomicSync(this.file, JSON.stringify(this.data, null, 2))
    } catch (error) {
      this.onError?.(error)
      this.writer.schedule()
    }
  }
}
