// Spending cap service: holds the local spend book (userData/spend.json), records every AI charge,
// refuses new calls at 100% of a cap and emits the state + threshold alerts. No electron imports.

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { alertText, clearOverride, emptyBook, newAlerts, normalizeBook, normalizeSettings, raiseToday, recordSpend, refusal, spendState, type SpendCharge } from '../../../shared/spend/cap.ts'
import type { SpendAlert, SpendBook, SpendSettings, SpendSource, SpendState } from '../../../shared/spend/types.ts'
import { renameRetry } from '../fs/renameRetry.ts'

export class SpendCapError extends Error {
  readonly code = 'spend-cap'
}

export interface SpendStore {
  load(): Promise<unknown>
  save(data: unknown): Promise<void>
}

// JSON file store (atomic write through a temp file).
export function fileStore(file: string): SpendStore {
  return {
    load: async () => {
      try {
        return JSON.parse(await readFile(file, 'utf8'))
      } catch {
        return null
      }
    },
    save: async (data) => {
      await mkdir(dirname(file), { recursive: true })
      const tmp = `${file}.tmp`
      const text = JSON.stringify(data)
      await writeFile(tmp, text, 'utf8')
      try {
        await renameRetry(tmp, file)
      } catch {
        // Windows can refuse to replace a file another process (antivirus, indexer) holds open.
        await writeFile(file, text, 'utf8')
        await rm(tmp, { force: true })
      }
    }
  }
}

export interface SpendServiceDeps {
  store: SpendStore
  now?: () => number
  emit?: (event: 'spend:changed' | 'spend:alert', payload: SpendState | SpendAlert) => void
  log?: (text: string) => void
  // Debounce for writes (ms); 0 writes on every change. Default 800.
  saveDelayMs?: number
}

interface FileShape {
  v: 1
  settings: SpendSettings
  book: SpendBook
}

export class SpendService {
  private deps: SpendServiceDeps
  private book: SpendBook = emptyBook()
  private settingsValue: SpendSettings = normalizeSettings({})
  private loaded: Promise<void>
  private timer: ReturnType<typeof setTimeout> | null = null
  private now: () => number
  // Saves run one after another: two overlapping writes of the same temp file could interleave
  // into a broken spend.json, which loads as an empty book (history and caps' spend gone).
  private saving: Promise<void> = Promise.resolve()

  constructor(deps: SpendServiceDeps) {
    this.deps = deps
    this.now = deps.now ?? Date.now
    this.loaded = deps.store
      .load()
      .then((raw) => {
        const r = (raw ?? {}) as Partial<FileShape>
        // Charges recorded before the file finished loading are kept (merged on top).
        const pending = this.book
        this.book = normalizeBook(r.book)
        this.settingsValue = normalizeSettings(r.settings)
        for (const [k, d] of Object.entries(pending.days)) {
          const cur = this.book.days[k]
          if (!cur) this.book.days[k] = d
          else {
            cur.total += d.total
            cur.requests += d.requests
            for (const [p, v] of Object.entries(d.byProvider)) cur.byProvider[p] = (cur.byProvider[p] ?? 0) + v
            for (const [s, v] of Object.entries(d.bySource)) cur.bySource[s as SpendSource] = (cur.bySource[s as SpendSource] ?? 0) + (v ?? 0)
          }
        }
      })
      .catch(() => undefined)
  }

  ready(): Promise<void> {
    return this.loaded
  }

  settings(): SpendSettings {
    return { ...this.settingsValue }
  }

  state(): SpendState {
    return spendState(this.book, this.settingsValue, this.now())
  }

  // The refusal message for a new call right now, or null.
  blocked(): string | null {
    return refusal(this.book, this.settingsValue, this.now())
  }

  // Throws SpendCapError (and emits a refused alert) when a cap is reached.
  assert(source: SpendSource = 'other'): void {
    const msg = this.blocked()
    if (!msg) return
    this.deps.log?.(`refused a ${source} call: ${msg}`)
    this.deps.emit?.('spend:alert', { level: 'stop', window: this.state().day.level === 'stop' ? 'day' : 'month', text: msg, refused: true })
    throw new SpendCapError(msg)
  }

  record(c: Omit<SpendCharge, 'at'> & { at?: number }): void {
    recordSpend(this.book, { ...c, at: c.at ?? this.now() })
    for (const a of newAlerts(this.book, this.settingsValue, this.now())) this.deps.emit?.('spend:alert', { level: a.level, window: a.window.kind, text: alertText(a.level, a.window) })
    this.changed()
  }

  async setSettings(patch: Partial<SpendSettings>): Promise<SpendState> {
    await this.loaded
    const next: Record<string, unknown> = { ...this.settingsValue }
    for (const k of ['dailyUsd', 'monthlyUsd', 'warnAt'] as const) if (k in (patch ?? {})) next[k] = (patch as Record<string, unknown>)[k]
    this.settingsValue = normalizeSettings(next)
    this.changed(true)
    return this.state()
  }

  async raiseToday(amountUsd?: number): Promise<SpendState> {
    await this.loaded
    const amount = typeof amountUsd === 'number' && Number.isFinite(amountUsd) && amountUsd > 0 ? amountUsd : this.state().raiseStep
    raiseToday(this.book, amount, this.now())
    this.deps.log?.(`raised today's cap by $${amount.toFixed(2)}`)
    this.changed(true)
    return this.state()
  }

  async clearOverride(): Promise<SpendState> {
    await this.loaded
    clearOverride(this.book, this.now())
    this.changed(true)
    return this.state()
  }

  private changed(now = false): void {
    this.deps.emit?.('spend:changed', this.state())
    const delay = this.deps.saveDelayMs ?? 800
    if (now || delay <= 0) {
      void this.flush()
      return
    }
    if (this.timer) return
    this.timer = setTimeout(() => void this.flush(), delay)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  async flush(): Promise<void> {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    await this.loaded
    const next = this.saving.then(() => {
      // Serialized when this save actually runs, so the newest state is written last.
      const data = JSON.parse(JSON.stringify({ v: 1, settings: this.settingsValue, book: this.book })) as FileShape
      return this.deps.store.save(data).catch((e) => this.deps.log?.(`save failed: ${(e as Error).message}`))
    })
    this.saving = next
    await next
  }
}
