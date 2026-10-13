// Forge's side of the Forge Bridge: a small HTTP server on 127.0.0.1 that hands one job at a time to
// the Studio plugin (long-poll) and relays the plugin's events to whoever queued the job. The answer
// to an event is whatever the job's handler returns, so Forge can hold "beat" until the frame is
// grabbed. Protocol: shared/studio/protocol.ts. No electron imports (tested in test/studio.test.ts).

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { CONNECTED_MS, parseEvent, POLL_HOLD_MS, type BridgeEvent, type BridgeJob } from '../../../shared/studio/protocol.ts'

export class BridgeError extends Error {
  readonly code: 'not-listening' | 'busy' | 'not-accepted' | 'timeout' | 'plugin-error' | 'cancelled'
  constructor(code: BridgeError['code'], message: string) {
    super(message)
    this.code = code
  }
}

export interface StudioInfo {
  lastSeen: number
  place?: string
  placeId?: number
  pluginVersion?: number
}

export type EventHandler = (ev: BridgeEvent, receivedAt: number) => unknown | Promise<unknown>

export interface RunOptions {
  // The plugin must pick the job up (and answer "accepted") within this.
  acceptTimeoutMs?: number
  // The whole job, from enqueue to "done".
  timeoutMs?: number
}

interface Active {
  job: BridgeJob
  handler: EventHandler
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
  private active: Active | null = null
  private waiters = new Set<(job: BridgeJob | null) => void>()
  private now: () => number
  private onChange?: () => void
  private log?: (text: string, stream?: 'info' | 'stderr') => void
  private holdMs: number

  constructor(opts: { port: number; now?: () => number; onChange?: () => void; log?: (text: string, stream?: 'info' | 'stderr') => void; holdMs?: number }) {
    this.wantPort = opts.port
    this.now = opts.now ?? Date.now
    this.onChange = opts.onChange
    this.log = opts.log
    this.holdMs = opts.holdMs ?? POLL_HOLD_MS
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

  connected(): boolean {
    return !!this.info && this.now() - this.info.lastSeen < CONNECTED_MS
  }

  busy(): BridgeJob | null {
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
    for (const w of this.waiters) w(null)
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
    if (this.active) return Promise.reject(new BridgeError('busy', 'a Studio check is already running'))
    return new Promise<void>((resolve, reject) => {
      const a: Active = { job, handler, delivered: false, accepted: false, aborted: null, resolve, reject, timers: [] }
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
            finish(new BridgeError('not-accepted', a.delivered ? 'the Forge Bridge plugin took the job but did not start it' : 'Studio did not pick up the job (is Studio open with the Forge Bridge plugin on?)'))
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
      // Hand it to a poll that is already waiting.
      for (const w of this.waiters) {
        this.waiters.delete(w)
        a.delivered = true
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
    this.info = {
      lastSeen: this.now(),
      ...(url.searchParams.get('place') ? { place: url.searchParams.get('place')!.slice(0, 100) } : {}),
      ...(Number.isFinite(placeId) && placeId > 0 ? { placeId } : {}),
      ...(Number.isFinite(v) && v > 0 ? { pluginVersion: v } : {})
    }
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
        const job = await this.nextJob(req)
        if (job) {
          this.log?.(`studio bridge: job ${job.id} (${job.kind} ${job.name}) sent to Studio`)
          return send(200, { job })
        }
        return send(200, { idle: true })
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

  private nextJob(req: IncomingMessage): Promise<BridgeJob | null> {
    const a = this.active
    if (a && !a.delivered) {
      a.delivered = true
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
      this.waiters.add(w)
    })
  }

  private async dispatch(a: Active, ev: BridgeEvent): Promise<Record<string, unknown>> {
    const at = this.now()
    if (ev.type === 'accepted') a.accepted = true
    if (ev.type === 'error') {
      a.reject(new BridgeError('plugin-error', `Studio: ${ev.message}`))
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

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY) {
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
