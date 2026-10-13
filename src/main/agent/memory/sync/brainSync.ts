// Device sync of Forge's learned memory ("brain sync"): off by default. Two modes:
//   git     a private repo the user owns, cloned into userData/brain-sync/forge-brain (gitBrain.ts)
//   folder  a Dropbox / OneDrive / iCloud Drive folder; Forge mirrors into <folder>/forge-brain
// Both share the layout memory/... (user memories + skills, as in userData/memory) and
// extra/<id>/... (registered sections, e.g. the VFX library), and the mirror.ts merge rule.
// Project memory is not synced: it lives in the game repo (.forge/memory) and travels with it.
//
// Pulls on start and every intervalMinutes; local changes push after a debounce. One sync at a
// time. No electron (main/index.ts wires it).

import { basename, join } from 'node:path'
import { existsSync } from 'node:fs'
import { findTool, run, toolEnv } from '../../../services/tools.ts'
import { INDEX_FILE } from '../store.ts'
import { BrainSyncError, GitBrain, type GitRunner } from './gitBrain.ts'
import { mirror, type MirrorBase, type MirrorResult, type MirrorRoot } from './mirror.ts'
import { packSections, type PackSection } from './sections.ts'
import type { BrainSyncSettings, BrainSyncStatus } from './types.ts'

export const DEFAULT_BRAIN_SYNC: BrainSyncSettings = { mode: 'off', repoUrl: '', folder: '', intervalMinutes: 10 }
export const PUSH_DEBOUNCE_MS = 15_000
export const SHARED_FOLDER = 'forge-brain'

export interface BrainSyncDeps {
  // userData/memory
  userDir: string
  // userData (the clone goes in userData/brain-sync/forge-brain)
  dataDir: string
  device: string
  getSetting<T>(key: string, fallback: T): T
  setSetting(key: string, value: unknown): void
  emit?(status: BrainSyncStatus): void
  log?(text: string, stream?: 'info' | 'stderr'): void
  // Local stores changed because of a pull (re-read, rebuild the index, tell the UI).
  onPulled?(): void | Promise<void>
  run?: GitRunner
  sections?: () => PackSection[]
  now?: () => number
  exists?: (path: string) => boolean
  debounceMs?: number
}

interface StoredBase {
  target: string
  files: MirrorBase
}

export class BrainSync {
  private d: BrainSyncDeps
  private now: () => number
  private busy: Promise<BrainSyncStatus> | null = null
  private again = false
  private interval: NodeJS.Timeout | null = null
  private debounce: NodeJS.Timeout | null = null
  private applying = false
  private st: BrainSyncStatus

  constructor(deps: BrainSyncDeps) {
    this.d = deps
    this.now = deps.now ?? Date.now
    const s = this.settings()
    const saved = deps.getSetting<Partial<BrainSyncStatus>>('brainSync.status', {})
    this.st = {
      mode: s.mode,
      state: s.mode === 'off' ? 'off' : 'idle',
      device: deps.device,
      ...(this.target(s) ? { target: this.target(s) } : {}),
      ...(saved.lastSync ? { lastSync: saved.lastSync } : {}),
      ...(saved.last ? { last: saved.last } : {})
    }
  }

  settings(): BrainSyncSettings {
    const s = this.d.getSetting<Partial<BrainSyncSettings>>('brainSync.settings', {})
    return {
      mode: s.mode === 'git' || s.mode === 'folder' ? s.mode : 'off',
      repoUrl: typeof s.repoUrl === 'string' ? s.repoUrl.trim() : '',
      folder: typeof s.folder === 'string' ? s.folder : '',
      intervalMinutes: Math.min(24 * 60, Math.max(1, Number(s.intervalMinutes) || DEFAULT_BRAIN_SYNC.intervalMinutes))
    }
  }

  async setSettings(patch: Partial<BrainSyncSettings>): Promise<BrainSyncSettings> {
    const prev = this.settings()
    const next: BrainSyncSettings = { ...prev, ...patch }
    if (!['off', 'git', 'folder'].includes(next.mode)) next.mode = 'off'
    next.repoUrl = String(next.repoUrl ?? '').trim()
    next.folder = String(next.folder ?? '')
    this.d.setSetting('brainSync.settings', next)
    const s = this.settings()
    this.set({ mode: s.mode, state: s.mode === 'off' ? 'off' : 'idle', target: this.target(s), lastError: undefined, authProblem: undefined })
    this.schedule()
    if (s.mode !== 'off' && (s.mode !== prev.mode || this.target(s) !== this.target(prev))) void this.syncNow().catch(() => undefined)
    return s
  }

  status(): BrainSyncStatus {
    return { ...this.st }
  }

  private target(s: BrainSyncSettings): string | undefined {
    return s.mode === 'git' ? s.repoUrl || undefined : s.mode === 'folder' ? s.folder || undefined : undefined
  }

  private set(patch: Partial<BrainSyncStatus>): void {
    const next = { ...this.st, ...patch } as BrainSyncStatus
    for (const k of Object.keys(next) as (keyof BrainSyncStatus)[]) if (next[k] === undefined) delete next[k]
    this.st = next
    this.d.emit?.(this.status())
  }

  // Pull on start, then on the interval.
  start(delayMs = 3000): void {
    this.schedule()
    if (this.settings().mode === 'off') return
    const t = setTimeout(() => void this.syncNow().catch(() => undefined), delayMs)
    t.unref?.()
  }

  private schedule(): void {
    if (this.interval) clearInterval(this.interval)
    this.interval = null
    const s = this.settings()
    if (s.mode === 'off') return
    this.interval = setInterval(() => void this.syncNow().catch(() => undefined), s.intervalMinutes * 60_000)
    this.interval.unref?.()
  }

  // A memory/skill was saved, edited or removed here: push it soon (debounced).
  onLocalChange(): void {
    if (this.applying || this.settings().mode === 'off') return
    if (this.debounce) clearTimeout(this.debounce)
    this.set({ pending: true })
    this.debounce = setTimeout(() => {
      this.debounce = null
      void this.syncNow().catch(() => undefined)
    }, this.d.debounceMs ?? PUSH_DEBOUNCE_MS)
    this.debounce.unref?.()
  }

  roots(): MirrorRoot[] {
    const roots: MirrorRoot[] = [{ prefix: 'memory', dir: this.d.userDir, exclude: (rel) => rel === INDEX_FILE }]
    for (const s of (this.d.sections ?? packSections)()) {
      const dir = s.dir()
      if (dir) roots.push({ prefix: `extra/${s.id}`, dir })
    }
    return roots
  }

  cloneDir(): string {
    return join(this.d.dataDir, 'brain-sync', SHARED_FOLDER)
  }

  // Concurrent calls share the running sync; a call during a sync queues one more round.
  syncNow(): Promise<BrainSyncStatus> {
    if (this.busy) {
      this.again = true
      return this.busy
    }
    this.busy = this.round().finally(() => {
      this.busy = null
      if (this.again) {
        this.again = false
        void this.syncNow().catch(() => undefined)
      }
    })
    return this.busy
  }

  private async round(): Promise<BrainSyncStatus> {
    const s = this.settings()
    if (s.mode === 'off') {
      this.set({ mode: 'off', state: 'off' })
      return this.status()
    }
    const target = this.target(s)
    this.set({ mode: s.mode, state: 'syncing', target, pending: undefined })
    try {
      const key = `${s.mode}:${target ?? ''}`
      const stored = this.d.getSetting<StoredBase | null>('brainSync.base', null)
      const base = stored && stored.target === key ? stored.files : {}
      const roots = this.roots()
      let result: MirrorResult
      if (s.mode === 'folder') {
        if (!s.folder) throw new BrainSyncError('Choose a sync folder (e.g. in Dropbox, OneDrive or iCloud Drive).')
        if (!(this.d.exists ?? existsSync)(s.folder)) throw new BrainSyncError(`The sync folder ${s.folder} is not available. Is the drive or cloud folder connected?`)
        const shared = basename(s.folder) === SHARED_FOLDER ? s.folder : join(s.folder, SHARED_FOLDER)
        result = await mirror(roots, shared, base)
      } else {
        const git = new GitBrain({ run: this.d.run ?? defaultRunner(), url: s.repoUrl, dir: this.cloneDir(), device: this.d.device, exists: this.d.exists, log: (t) => this.d.log?.(t) })
        result = await git.sync((worktree) => mirror(roots, worktree, base))
      }
      this.d.setSetting('brainSync.base', { target: key, files: result.base } satisfies StoredBase)
      if (result.localChanged) {
        this.applying = true
        try {
          await this.d.onPulled?.()
        } finally {
          this.applying = false
        }
      }
      if (result.held.length) this.d.log?.(`brain sync: not uploaded (secret scanner): ${result.held.join(', ')}`, 'stderr')
      const last = { pulled: result.pulled, pushed: result.pushed, conflicts: result.conflicts }
      const at = this.now()
      this.d.setSetting('brainSync.status', { lastSync: at, last })
      this.set({ state: 'idle', lastSync: at, last, lastError: result.held.length ? `${result.held.length} file(s) were not uploaded because they look like they contain secrets: ${result.held.join(', ')}` : undefined, authProblem: undefined })
    } catch (e) {
      const auth = e instanceof BrainSyncError && e.auth
      this.d.log?.(`brain sync: ${(e as Error).message}`, 'stderr')
      this.set({ state: 'error', lastError: (e as Error).message, authProblem: auth || undefined })
    }
    return this.status()
  }

  dispose(): void {
    if (this.interval) clearInterval(this.interval)
    if (this.debounce) clearTimeout(this.debounce)
    this.interval = null
    this.debounce = null
  }
}

// The real git CLI (services/tools.ts run), prompts off so a background sync never hangs.
function defaultRunner(): GitRunner {
  const git = findTool('git') || 'git'
  const env = { ...toolEnv(), GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true' }
  return (args, cwd) => run(git, ['-c', 'core.quotepath=false', ...args], cwd, env)
}
