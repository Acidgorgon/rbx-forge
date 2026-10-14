// Done notifications: turns harness events (and timed long IPC calls) into notification candidates,
// and decides whether one is shown (setting always / unfocused / off, per-category toggles). Pure:
// main feeds it every emitted event and shows what comes out with Electron's Notification.

import type { NotifyCategory, NotifySettings, QolTarget } from './types.ts'

export interface NotifyCandidate {
  category: NotifyCategory
  // Same key within the dedupe window = shown once (a lab's progress "done" and its IPC call ending).
  key: string
  title: string
  body: string
  target?: QolTarget
  // Waiting for the user (team change request) rather than finished.
  needsInput?: boolean
  // Only while Forge is not focused, even with mode "always" (long chat turns).
  unfocusedOnly?: boolean
  // Lab runs: kept by main for the "since you were away" digest.
  run?: { label: string; ok: boolean }
}

export const CHAT_THRESHOLD_MS = 30_000
export const LONG_TASK_MS = 20_000
export const DEDUPE_MS = 15_000

// Lab prefixes (event "vfx:progress", IPC "vfxRefine") -> name and Forge page. Pages the renderer does
// not know (another branch's lab) only focus the window.
const LABS: Record<string, { label: string; page: string }> = {
  vfx: { label: 'VFX Lab', page: 'vfx' },
  vfxtex: { label: 'VFX textures', page: 'vfx' },
  anim: { label: 'Animation Lab', page: 'anim' },
  ability: { label: 'Ability Composer', page: 'ability' },
  art: { label: 'Art', page: 'art' },
  thumb: { label: 'Thumbnail Lab', page: 'thumbs' },
  thumbs: { label: 'Thumbnail Lab', page: 'thumbs' },
  thumbnail: { label: 'Thumbnail Lab', page: 'thumbs' },
  uimotion: { label: 'UI Motion Lab', page: 'uimotion' },
  motion: { label: 'UI Motion Lab', page: 'uimotion' },
  ref: { label: 'Video references', page: 'vfx' },
  studio: { label: 'Studio check', page: 'vfx' }
}

export function labInfo(prefix: string): { label: string; page: string } {
  const key = prefix.toLowerCase()
  return LABS[key] ?? { label: key.charAt(0).toUpperCase() + key.slice(1), page: key }
}

// IPC calls worth a notification when they run long: <prefix><Verb>, e.g. vfxRefine, abilityCritique.
const LONG_VERBS = /^(Make|Refine|Compose|Critique|Generate|Render|Convert|Check|Export|Upload|Run)$/
const BUILD_PREFIXES = new Set(['tests', 'release', 'toolchain'])

export function shouldDeliver(settings: NotifySettings, c: NotifyCandidate, focused: boolean): boolean {
  if (settings.mode === 'off') return false
  if (settings.categories[c.category] === false) return false
  if (focused && (settings.mode === 'unfocused' || c.unfocusedOnly)) return false
  return true
}

type Payload = Record<string, unknown>
const isObj = (v: unknown): v is Payload => !!v && typeof v === 'object' && !Array.isArray(v)
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined)

function shorten(text: string, max = 120): string {
  const one = text.replace(/\s+/g, ' ').trim()
  return one.length > max ? one.slice(0, max - 1) + '…' : one
}

// Final state of a generic progress / changed payload: 'ok', 'error', or null while still running.
export function finalState(p: unknown): 'ok' | 'error' | null {
  if (!isObj(p)) return null
  const phase = str(p.phase) ?? str(p.state) ?? str(p.status)
  if (phase && /^(done|finished|complete|completed|passed|ok|success)$/i.test(phase)) return 'ok'
  if (phase && /^(error|failed|fail|cancelled|canceled)$/i.test(phase)) return 'error'
  if (p.kind === 'end' || p.done === true) return p.error || p.ok === false ? 'error' : 'ok'
  return null
}

export interface RouterOptions {
  now?: () => number
  chatThresholdMs?: number
  longTaskMs?: number
  dedupeMs?: number
}

export class NotifyRouter {
  private now: () => number
  private chatThreshold: number
  private longTask: number
  private dedupe: number
  private chatStart = new Map<string, number>()
  private recent = new Map<string, number>()
  private syncConflicts = 0
  private studioConflicts = new Set<string>()
  private agentStates = new Map<string, string>()

  constructor(options: RouterOptions = {}) {
    this.now = options.now ?? Date.now
    this.chatThreshold = options.chatThresholdMs ?? CHAT_THRESHOLD_MS
    this.longTask = options.longTaskMs ?? LONG_TASK_MS
    this.dedupe = options.dedupeMs ?? DEDUPE_MS
  }

  // One emitted harness event -> zero or more candidates (already deduplicated).
  observe(event: string, payload: unknown): NotifyCandidate[] {
    return this.fresh(this.route(event, payload))
  }

  // A timed IPC call finished (main wraps lab / build handlers). null when short or not interesting.
  task(name: string, ms: number, ok: boolean, error?: string): NotifyCandidate | null {
    const m = /^([a-z]+)([A-Z][a-z]+)/.exec(name)
    if (!m || !LONG_VERBS.test(m[2]) || ms < this.longTask) return null
    const prefix = m[1]
    const verb = m[2].toLowerCase()
    const seconds = Math.round(ms / 1000)
    if (BUILD_PREFIXES.has(prefix)) {
      if (prefix === 'tests') return null // tests:progress "end" says more
      const label = prefix === 'release' ? 'Release' : 'Toolchain setup'
      return this.fresh([{ category: 'builds', key: `task:${prefix}`, title: `${label} ${ok ? 'finished' : 'failed'}`, body: ok ? `Took ${seconds}s` : shorten(error ?? 'Failed'), target: prefix === 'release' ? { kind: 'page', page: 'release' } : { kind: 'page', page: 'settings' } }])[0] ?? null
    }
    const lab = labInfo(prefix)
    if (!(prefix.toLowerCase() in LABS) && !/thumb|motion/i.test(prefix)) return null
    return this.fresh([{ category: 'labs', key: `lab:${lab.page}`, title: `${lab.label}: ${verb} ${ok ? 'finished' : 'failed'}`, body: ok ? `Took ${seconds}s` : shorten(error ?? 'Failed'), target: { kind: 'page', page: lab.page }, run: { label: `${lab.label} ${verb}`, ok } }])[0] ?? null
  }

  private fresh(list: NotifyCandidate[]): NotifyCandidate[] {
    const now = this.now()
    for (const [k, at] of this.recent) if (now - at > this.dedupe) this.recent.delete(k)
    const out: NotifyCandidate[] = []
    for (const c of list) {
      if (this.recent.has(c.key)) continue
      this.recent.set(c.key, now)
      out.push(c)
    }
    return out
  }

  private route(event: string, p: unknown): NotifyCandidate[] {
    switch (event) {
      case 'chat:busy': {
        if (!isObj(p) || typeof p.sessionId !== 'string') return []
        if (p.busy) {
          this.chatStart.set(p.sessionId, this.now())
          return []
        }
        const start = this.chatStart.get(p.sessionId)
        this.chatStart.delete(p.sessionId)
        if (start === undefined || this.now() - start < this.chatThreshold) return []
        return [{ category: 'chat', key: `chat:${p.sessionId}:${start}`, title: 'Assistant finished', body: `Reply ready after ${Math.round((this.now() - start) / 1000)}s`, target: { kind: 'chat', sessionId: p.sessionId }, unfocusedOnly: true }]
      }
      case 'orchestrator:event': {
        if (!isObj(p)) return []
        const board = isObj(p.board) ? p.board : null
        const request = shorten(str(board?.request) ?? '', 90)
        if (p.type === 'finished' && board) {
          const state = str(board.state) ?? 'done'
          const ok = state === 'done'
          return [{ category: 'team', key: `team:${board.runId}:end`, title: ok ? 'Team run finished' : state === 'cancelled' ? 'Team run cancelled' : 'Team run failed', body: request || shorten(str(board.detail) ?? ''), target: { kind: 'side', view: 'team' } }]
        }
        if (p.type === 'change_request') {
          const req = isObj(p.request) ? p.request : {}
          return [{ category: 'team', key: `team:${p.runId}:cr:${str(req.id) ?? ''}`, title: 'Team run needs your input', body: shorten(str(req.change) ? `${str(req.file) ?? ''}: ${str(req.change)}` : 'A change request is waiting'), target: { kind: 'side', view: 'team' }, needsInput: true }]
        }
        if (p.type === 'budget' && p.level === 'stop') return [{ category: 'team', key: `team:${p.runId}:budget`, title: 'Team run stopped by budget', body: shorten(str(p.reason) ?? ''), target: { kind: 'side', view: 'team' }, needsInput: true }]
        return []
      }
      case 'tests:progress': {
        if (!isObj(p) || p.kind !== 'end' || !isObj(p.summary)) return []
        const s = p.summary
        const failed = Number(s.failed) || 0
        const total = Number(s.total) || 0
        const state = str(s.state)
        if (state === 'cancelled') return []
        const title = state === 'error' ? 'Tests could not run' : failed ? `${failed} test${failed === 1 ? '' : 's'} failed` : 'Tests passed'
        return [{ category: 'builds', key: `tests:${s.id}`, title, body: state === 'error' ? shorten(str(s.message) ?? '') : `${total - failed} of ${total} passed`, target: { kind: 'side', view: 'tests' } }]
      }
      case 'agents:changed': {
        if (!Array.isArray(p)) return []
        const out: NotifyCandidate[] = []
        for (const a of p) {
          if (!isObj(a) || typeof a.id !== 'string') continue
          const before = this.agentStates.get(a.id)
          const state = str(a.state) ?? ''
          this.agentStates.set(a.id, state)
          if ((before === 'running' || before === 'queued') && /^(passed|failed|error)$/.test(state)) {
            out.push({ category: 'builds', key: `agent:${a.id}`, title: `Test agent ${state === 'passed' ? 'passed' : 'failed'}`, body: shorten(str(a.scenario) ?? str(a.summary) ?? ''), target: { kind: 'side', view: 'tests' } })
          }
        }
        return out
      }
      case 'sync:status': {
        if (!isObj(p) || !Array.isArray(p.places)) return []
        const total = p.places.reduce((n: number, place) => n + (isObj(place) ? Number(place.conflicts) || 0 : 0), 0)
        const before = this.syncConflicts
        this.syncConflicts = total
        if (total <= before) return []
        return [{ category: 'sync', key: `sync:${total}`, title: 'Forge Sync needs a decision', body: `${total} Studio conflict${total === 1 ? '' : 's'}: rojo serve is held until you pick a version`, target: { kind: 'side', view: 'sync' }, needsInput: true }]
      }
      case 'studio:conflicts': {
        if (!Array.isArray(p)) return []
        const paths = p.filter(isObj).map((c) => str(c.path) ?? '').filter(Boolean)
        const added = paths.filter((x) => !this.studioConflicts.has(x))
        this.studioConflicts = new Set(paths)
        if (!added.length) return []
        return [{ category: 'sync', key: `studio:${added.join('|')}`, title: 'Studio conflict', body: added.length === 1 ? `${added[0]} differs between Studio and disk` : `${added.length} scripts differ between Studio and disk`, target: { kind: 'conflict', path: added[0] }, needsInput: true }]
      }
    }
    // Generic: "<lab>:progress" / "<lab>:changed" payloads that report a final phase.
    const m = /^([A-Za-z]+):(progress|changed|run|status)$/.exec(event)
    if (m && (m[2] === 'progress' || m[2] === 'run' || isObj(p))) {
      const final = finalState(p)
      if (!final || !isObj(p)) return []
      if (m[1] === 'sync' || m[1] === 'update' || m[1] === 'brainsync' || m[1] === 'memory') return []
      const lab = labInfo(m[1])
      const entryId = str(p.entryId) ?? str(p.id)
      const score = typeof p.score === 'number' ? ` · score ${p.score.toFixed(1)}` : ''
      const message = str(p.message)
      return [{
        category: 'labs',
        key: `lab:${lab.page}`,
        title: `${lab.label} run ${final === 'ok' ? 'finished' : 'failed'}`,
        body: shorten((message ?? (final === 'ok' ? 'Ready to review' : 'Stopped with an error')) + score),
        target: { kind: 'page', page: lab.page, ...(entryId ? { entryId } : {}) },
        run: { label: `${lab.label} run`, ok: final === 'ok' }
      }]
    }
    return []
  }
}
