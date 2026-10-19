// Forge's side of the Forge Bridge: a small HTTP server on 127.0.0.1 that hands one job at a time to
// the Studio plugin (long-poll) and relays the plugin's events to whoever queued the job. The answer
// to an event is whatever the job's handler returns, so Forge can hold "beat" until the frame is
// grabbed. Protocol: shared/studio/protocol.ts. No electron imports (tested in test/studio.test.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CONNECTED_MS, parseEvent, POLL_HOLD_MS, type BridgeEvent, type BridgeJob } from '../../../shared/studio/protocol.ts'
import { isScriptInjectionError, SCRIPT_INJECTION_MESSAGE } from '../../../shared/studio/errors.ts'
import { matchesTarget, placeLabel, targetKey, type StudioTarget } from '../../../shared/studio/target.ts'
import { parseChangesBody, parseConfigQuery, parseOutlineBody, parsePollSync, parseSnapshotBody, sanitizeConfig, SYNC_LIMITS, SyncProtocolError, type SyncHandler } from '../../../shared/sync/protocol.ts'

export class BridgeError extends Error {
  // 'script-injection': Studio refused the plugin's ModuleScript.Source writes (its Script Injection
  // permission is off); the message says how to turn it on.
  readonly code: 'not-listening' | 'busy' | 'not-accepted' | 'timeout' | 'plugin-error' | 'script-injection' | 'cancelled'
  constructor(code: BridgeError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export interface StudioInfo {
  lastSeen: number
  // When this window started polling (its current connection).
  since: number
  place?: string
  placeId?: number
  pluginVersion?: number
  // Plugin v12: the window's Forge Sync session token ('' while it has none), its run id and, for an
  // unpublished place, its ForgeSyncLink. Absent for older plugins.
  syncSession?: string
  probe?: string
  link?: string
}

export type EventHandler = (ev: BridgeEvent, receivedAt: number) => unknown | Promise<unknown>

export interface RunOptions {
  // The plugin must pick the job up (and answer "accepted") within this.
  acceptTimeoutMs?: number
  // The whole job, from enqueue to "done".
  timeoutMs?: number
  // A background job (the VFX Lab's live Studio loop) that steps aside for any other job: a later
  // run() cancels it (code 'cancelled', reason PREEMPTED) instead of failing with 'busy', and busy()
  // does not report it.
  preemptible?: boolean
  // Only the Studio window of this place gets the job (several places open). undefined: the
  // bridge's default target (the Studio target picked in Forge); null: any window. A target that is
  // not connected falls back to any window.
  target?: StudioTarget | null
  // Chunked text the plugin fetches with GET /forge-bridge/blob/<jobId>/<name>/<i> while the job runs
  // (insert jobs: the model file as base64, too big for one poll answer).
  blobs?: Record<string, string[]>
}

export const PREEMPTED = 'paused for another Studio job'
// A background job running in another place than the new Studio target is stopped (it restarts there).
export const RETARGETED = 'the Studio target changed'

interface Active {
  job: BridgeJob
  target: StudioTarget | null
  // targetKey of the window that took the job.
  deliveredTo: string | null
  preemptible: boolean
  handler: EventHandler
  blobs: Record<string, string[]>
  delivered: boolean
  accepted: boolean
  aborted: string | null
  resolve: () => void
  reject: (e: Error) => void
  timers: ReturnType<typeof setTimeout>[]
}

const MAX_BODY = 256 * 1024

export class StudioBridge {
  readonly host = '127.0.0.1'
  private server: Server | null = null
  private wantPort: number
  private boundPort = 0
  private error: string | undefined
  private info: StudioInfo | null = null
  private pollers = new Map<string, StudioInfo>()
  private active: Active | null = null
  // Held polls, with the window each one came from.
  private waiters = new Map<(job: BridgeJob | null) => void, StudioInfo>()
  private now: () => number
  private onChange?: () => void
  private log?: (text: string, stream?: 'info' | 'stderr') => void
  private holdMs: number
  private sync: SyncHandler | null = null
  private defaultTarget?: () => StudioTarget | null

  constructor(opts: { port: number; now?: () => number; onChange?: () => void; log?: (text: string, stream?: 'info' | 'stderr') => void; holdMs?: number; target?: () => StudioTarget | null }) {
    this.wantPort = opts.port
    this.now = opts.now ?? Date.now
    this.onChange = opts.onChange
    this.log = opts.log
    this.holdMs = opts.holdMs ?? POLL_HOLD_MS
    this.defaultTarget = opts.target
  }

  get port(): number {
    return this.boundPort || this.wantPort
  }

  get listening(): boolean {
    return !!this.server && this.boundPort > 0
  }

  get lastError(): string | undefined {
    return this.error
  }

  studio(): StudioInfo | null {
    return this.info
  }

  // Every Studio window that polled within CONNECTED_MS (several places can be open at once; studio()
  // is only the last one).
  studios(): StudioInfo[] {
    const now = this.now()
    for (const [k, v] of this.pollers) if (now - v.lastSeen >= CONNECTED_MS) this.pollers.delete(k)
    return [...this.pollers.values()]
  }

  connected(): boolean {
    return !!this.info && this.now() - this.info.lastSeen < CONNECTED_MS
  }

  // Where jobs without their own target go (the Studio target picker), resolved by the wiring.
  setDefaultTarget(fn: (() => StudioTarget | null) | undefined): void {
    this.defaultTarget = fn
  }

  // The connected window jobs go to by default, or null (any window).
  targetStudio(): StudioInfo | null {
    const t = this.defaultTarget?.() ?? null
    return t ? (this.studios().find((p) => matchesTarget(t, p)) ?? null) : null
  }

  // The Studio target changed: a background (preemptible) job running in another place is stopped
  // so it starts again in the new one.
  retarget(): void {
    const a = this.active
    if (!a?.preemptible || !a.delivered || a.aborted) return
    const next = this.targetStudio()
    if (!next || a.deliveredTo === targetKey(next)) return
    a.aborted = RETARGETED
    a.reject(new BridgeError('cancelled', RETARGETED))
  }

  // A job's target: its own, else the default; one that is not connected falls back to any window.
  private targetFor(own: StudioTarget | null | undefined): StudioTarget | null {
    const want = own !== undefined ? own : (this.defaultTarget?.() ?? null)
    if (!want) return null
    const hit = this.studios().find((p) => matchesTarget(want, p))
    // (With the window's place name, for messages.)
    if (hit) return hit.place && !want.place ? { ...want, place: hit.place } : want
    this.log?.(`studio bridge: ${placeLabel(want)} is not connected; the job goes to any Studio window`)
    return null
  }

  // Forge Sync: the handler behind /forge-bridge/sync/*. Without one, config answers { enabled: false }.
  setSyncHandler(handler: SyncHandler | null): void {
    this.sync = handler
  }

  busy(): BridgeJob | null {
    return this.active && !this.active.preemptible ? this.active.job : null
  }

  // Any job at all, a preemptible one included.
  current(): BridgeJob | null {
    return this.active?.job ?? null
  }

  async start(): Promise<void> {
    if (this.server) return
    const server = createServer((req, res) => void this.handle(req, res))
    // Long polls are held open; keep Node from cutting them.
    server.requestTimeout = 0
    server.headersTimeout = 30_000
    await new Promise<void>((resolve) => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        this.error = e.code === 'EADDRINUSE' ? `port ${this.wantPort} is in use (another RBX Forge window?)` : e.message
        this.server = null
        this.log?.(`studio bridge: ${this.error}`, 'stderr')
        resolve()
      })
      server.listen(this.wantPort, this.host, () => {
        const addr = server.address()
        this.boundPort = typeof addr === 'object' && addr ? addr.port : this.wantPort
        this.server = server
        this.error = undefined
        resolve()
      })
    })
    this.onChange?.()
  }

  async stop(): Promise<void> {
    this.cancel('Forge is closing')
    for (const w of [...this.waiters.keys()]) w(null)
    this.waiters.clear()
    const s = this.server
    this.server = null
    this.boundPort = 0
    if (s) {
      s.closeAllConnections?.()
      await new Promise<void>((r) => s.close(() => r()))
    }
  }

  // Queues a job for the plugin and resolves when it reports "done".
  run(job: BridgeJob, handler: EventHandler, opts: RunOptions = {}): Promise<void> {
    if (!this.listening) return Promise.reject(new BridgeError('not-listening', `Forge is not listening on 127.0.0.1:${this.wantPort}${this.error ? ` (${this.error})` : ''}`))
    if (this.active?.preemptible) {
      const prev = this.active
      prev.aborted = PREEMPTED
      prev.reject(new BridgeError('cancelled', PREEMPTED))
    }
    if (this.active) return Promise.reject(new BridgeError('busy', 'a Studio check is already running'))
    const target = this.targetFor(opts.target)
    return new Promise<void>((resolve, reject) => {
      const a: Active = { job, target, deliveredTo: null, handler, blobs: opts.blobs ?? {}, preemptible: !!opts.preemptible, delivered: false, accepted: false, aborted: null, resolve, reject, timers: [] }
      this.active = a
      const finish = (err?: Error) => {
        if (this.active !== a) return
        for (const t of a.timers) clearTimeout(t)
        this.active = null
        this.onChange?.()
        if (err) reject(err)
        else resolve()
      }
      a.resolve = () => finish()
      a.reject = (e) => finish(e)
      a.timers.push(
        setTimeout(() => {
          if (!a.accepted) {
            a.aborted = 'not picked up'
            finish(
              new BridgeError(
                'not-accepted',
                a.delivered ? 'the Forge Bridge plugin took the job but did not start it' : target ? `${placeLabel(target)} did not pick up the job (is it still open in Studio with the Forge Bridge plugin on?)` : 'Studio did not pick up the job (is Studio open with the Forge Bridge plugin on?)'
              )
            )
          }
        }, opts.acceptTimeoutMs ?? 12_000)
      )
      a.timers.push(
        setTimeout(() => {
          a.aborted = 'timeout'
          finish(new BridgeError('timeout', `the Studio check timed out after ${Math.round((opts.timeoutMs ?? job.timeout * 1000) / 1000)} s`))
        }, opts.timeoutMs ?? job.timeout * 1000)
      )
      this.onChange?.()
      // Hand it to a poll that is already waiting (from the target's window when it has one).
      for (const [w, info] of this.waiters) {
        if (target && !matchesTarget(target, info)) continue
        this.waiters.delete(w)
        a.delivered = true
        a.deliveredTo = targetKey(info)
        w(job)
        break
      }
    })
  }

  // Stops the running job; the plugin is told to abort on its next event.
  cancel(reason = 'cancelled'): void {
    const a = this.active
    if (!a) return
    a.aborted = reason
    a.reject(new BridgeError('cancelled', reason))
  }

  // ------------------------------------------------------------ HTTP

  private seen(url: URL): void {
    const v = Number(url.searchParams.get('v'))
    const placeId = Number(url.searchParams.get('placeId'))
    const first = !this.connected()
    const now = this.now()
    const key = `${Number.isFinite(placeId) && placeId > 0 ? placeId : 0}|${url.searchParams.get('place')?.slice(0, 100) ?? ''}`
    const prev = this.pollers.get(key)
    this.info = {
      lastSeen: now,
      since: prev && now - prev.lastSeen < CONNECTED_MS ? prev.since : now,
      ...(url.searchParams.get('place') ? { place: url.searchParams.get('place')!.slice(0, 100) } : {}),
      ...(Number.isFinite(placeId) && placeId > 0 ? { placeId } : {}),
      ...(Number.isFinite(v) && v > 0 ? { pluginVersion: v } : {})
    }
    const sync = parsePollSync(url.searchParams)
    if (sync) {
      this.info.syncSession = sync.session
      if (sync.probe) this.info.probe = sync.probe
      if (sync.link) this.info.link = sync.link
    }
    this.pollers.delete(key)
    this.pollers.set(key, this.info)
    if (this.pollers.size > 32) this.pollers.delete(this.pollers.keys().next().value!)
    if (first) this.onChange?.()
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      if (res.writableEnded) return
      res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      res.end(JSON.stringify(body))
    }
    // Browsers send Origin on cross-site requests; Studio's HttpService does not. Refusing them keeps
    // web pages from driving the bridge.
    if (req.headers.origin) return send(403, { error: 'forbidden' })
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    const path = url.pathname
    try {
      if (req.method === 'GET' && path === '/forge-bridge/ping') return send(200, { now: this.now() })
      if (req.method === 'GET' && path === '/forge-bridge/poll') {
        this.seen(url)
        // Plugin v12: a linked place's window that Forge has no live sync session with starts its
        // check again now (answered at once; the next poll picks up any job).
        const sync = parsePollSync(url.searchParams)
        let hint = null
        try {
          hint = sync ? (this.sync?.pollHint?.(sync) ?? null) : null
        } catch (e) {
          this.log?.(`studio bridge: sync poll hint failed: ${(e as Error).message}`, 'stderr')
        }
        if (hint?.resync) return send(200, { idle: true, resync: true })
        const job = await this.nextJob(req, this.info!)
        if (job) {
          this.log?.(`studio bridge: job ${job.id} (${job.kind} ${job.name}) sent to Studio`)
          return send(200, { job })
        }
        return send(200, { idle: true })
      }
      if (path.startsWith('/forge-bridge/sync/')) return await this.handleSync(req, url, send)
      const blob = /^\/forge-bridge\/blob\/([\w-]{1,80})\/(\w{1,40})\/(\d{1,6})$/.exec(path)
      if (req.method === 'GET' && blob) {
        const a = this.active
        if (!a || a.job.id !== blob[1] || !a.delivered || a.aborted) return send(404, { error: 'no such job' })
        const chunks = Object.hasOwn(a.blobs, blob[2]) ? a.blobs[blob[2]] : undefined
        const i = Number(blob[3])
        if (!chunks || i >= chunks.length) return send(404, { error: 'no such chunk' })
        if (this.info) this.info.lastSeen = this.now()
        return send(200, { data: chunks[i], n: chunks.length })
      }
      const m = /^\/forge-bridge\/event\/([\w-]{1,80})$/.exec(path)
      if (req.method === 'POST' && m) {
        const raw = await readBody(req)
        let body: unknown
        try {
          body = JSON.parse(raw)
        } catch {
          return send(400, { error: 'bad JSON' })
        }
        const ev = parseEvent(body)
        if (!ev) return send(400, { error: 'bad event' })
        const a = this.active
        if (!a || a.job.id !== m[1]) return send(200, { abort: true, reason: 'no such job (Forge gave up on it)' })
        if (a.aborted) return send(200, { abort: true, reason: a.aborted })
        if (this.info) this.info.lastSeen = this.now()
        return send(200, await this.dispatch(a, ev))
      }
      send(404, { error: 'not found' })
    } catch (e) {
      send(500, { error: (e as Error).message })
    }
  }

  // ------------------------------------------------------------ Forge Sync

  private async handleSync(req: IncomingMessage, url: URL, send: (status: number, body: unknown) => void): Promise<void> {
    const route = url.pathname.slice('/forge-bridge/sync/'.length)
    if (this.info) this.info.lastSeen = this.now()
    if (req.method === 'GET' && route === 'config') {
      let q
      try {
        q = parseConfigQuery(url.searchParams)
      } catch (e) {
        return send(400, { enabled: false, error: (e as Error).message })
      }
      if (!this.sync) return send(200, { enabled: false })
      try {
        return send(200, sanitizeConfig(await this.sync.config(q)))
      } catch (e) {
        this.log?.(`studio bridge: sync config failed: ${(e as Error).message}`, 'stderr')
        return send(200, { enabled: false, error: (e as Error).message })
      }
    }
    if (req.method !== 'POST' || (route !== 'snapshot' && route !== 'changes' && route !== 'outline')) return send(404, { ok: false, error: 'not found' })
    let raw: string
    try {
      raw = await readBody(req, SYNC_LIMITS.maxBody)
    } catch (e) {
      return send(413, { ok: false, error: (e as Error).message })
    }
    let parsed
    try {
      const json: unknown = JSON.parse(raw)
      parsed = route === 'snapshot' ? { snapshot: parseSnapshotBody(json) } : route === 'outline' ? { outline: parseOutlineBody(json) } : { changes: parseChangesBody(json) }
    } catch (e) {
      const error = e instanceof SyncProtocolError ? e.message : 'bad JSON'
      this.log?.(`studio bridge: sync ${route} refused: ${error}`, 'stderr')
      return send(400, { ok: false, error })
    }
    if (!this.sync) return send(200, { ok: false, error: 'Forge Sync is off' })
    try {
      const reply = parsed.snapshot
        ? await this.sync.snapshot(parsed.snapshot)
        : parsed.outline
          ? this.sync.outline
            ? await this.sync.outline(parsed.outline)
            : { ok: false as const, error: 'outline not supported' }
          : await this.sync.changes(parsed.changes!)
      return send(200, reply)
    } catch (e) {
      this.log?.(`studio bridge: sync ${route} failed: ${(e as Error).message}`, 'stderr')
      return send(200, { ok: false, error: (e as Error).message })
    }
  }

  private nextJob(req: IncomingMessage, from: StudioInfo): Promise<BridgeJob | null> {
    const a = this.active
    if (a && !a.delivered && (!a.target || matchesTarget(a.target, from))) {
      a.delivered = true
      a.deliveredTo = targetKey(from)
      return Promise.resolve(a.job)
    }
    return new Promise((resolve) => {
      let done = false
      const w = (job: BridgeJob | null) => {
        if (done) return
        done = true
        clearTimeout(t)
        this.waiters.delete(w)
        resolve(job)
      }
      const t = setTimeout(() => w(null), this.holdMs)
      req.once('close', () => w(null))
      this.waiters.set(w, from)
    })
  }

  private async dispatch(a: Active, ev: BridgeEvent): Promise<Record<string, unknown>> {
    const at = this.now()
    if (ev.type === 'accepted') a.accepted = true
    if (ev.type === 'error') {
      a.reject(isScriptInjectionError(ev.message) ? new BridgeError('script-injection', SCRIPT_INJECTION_MESSAGE) : new BridgeError('plugin-error', `Studio: ${ev.message}`))
      return { ok: true }
    }
    let answer: unknown
    try {
      answer = await a.handler(ev, at)
    } catch (e) {
      a.aborted = (e as Error).message
      a.reject(e as Error)
      return { abort: true, reason: (e as Error).message }
    }
    if (ev.type === 'done') a.resolve()
    if (a.aborted) return { abort: true, reason: a.aborted }
    return { ok: true, ...(answer && typeof answer === 'object' ? (answer as Record<string, unknown>) : {}) }
  }
}

function readBody(req: IncomingMessage, max = MAX_BODY): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > max) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}
