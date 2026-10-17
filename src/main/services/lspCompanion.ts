// HTTP server for the luau-lsp Studio Companion plugin ("Luau Language Server Companion",
// roblox.com/library/10913122509). In VS Code the luau-lsp extension runs it; RBX Forge runs
// luau-lsp itself, so it serves the same endpoints. Without it the plugin logs
// "[Luau LSP] WARN: Getting file paths on http://localhost:3667 failed. Is the server enabled?"
//
// Protocol, as of luau-lsp 1.70.1 (github.com/JohnnyMorganz/luau-lsp):
//   editors/code/src/roblox.ts startPluginServer (express, express.json({ limit: "3mb" })):
//     POST /full  JSON { tree }  -> 400 without body.tree, else
//                                  client.sendNotification("$/plugin/full", req.body.tree); 200
//     POST /clear                -> client.sendNotification("$/plugin/clear"); 200
//     GET  /get-file-paths       -> 200 { files: string[] }: absolute paths (uri.fsPath) of the
//                                  workspace's **/*.{lua,luau} files (**/*.luau when
//                                  luau-lsp.analyzeLuaFiles is off); 500 { error } on failure
//     no language client         -> 500; body over the limit -> 413
//     settings luau-lsp.studioPlugin.enabled (default false there) / .port (default 3667)
//   plugin/src/ServerEndpoints.luau: /full is sent with Content-Type: application/json and
//     Compress = Enum.HttpCompression.Gzip (Content-Encoding: gzip; express inflates it);
//     /clear is a bare POST; /get-file-paths a GET. Any non-2xx is an error to the plugin.
//   plugin/src/LSPManager.luau: every send first GETs /get-file-paths, maps each path to a
//     Studio instance with InstanceFileSyncService:GetSyncedInstance (Script Sync), then encodes
//     the tracked tree (EncodedInstance { Name, ClassName, FilePaths, Children }, types.luau)
//     and POSTs it to /full. A connection failure gives the "Is the server enabled?" warning.
//
// Differences from the extension: on by default; binds 127.0.0.1 only; refuses requests whose
// Host or Origin is not loopback (DNS rebinding, browser pages) and /full bodies that are not
// JSON; caps the body (compressed and inflated); answers 503 while no project / luau-lsp runs.
// When the port is taken (VS Code with the extension open, or a second Forge) it says so once in
// the luau-lsp log and the status bar tooltip, and tries the port again every 30 seconds.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { gunzip, inflate } from 'node:zlib'
import { promisify } from 'node:util'
import type { LspCompanionStatus } from '@shared/types'

export const DEFAULT_COMPANION_PORT = 3667
// The extension's default limit is 3mb; Forge has no setting for it, so the cap is roomier.
export const MAX_BODY_BYTES = 16 * 1024 * 1024
// /get-file-paths answer cap (a repo with more Luau files than this is unusual).
export const MAX_FILE_PATHS = 50_000
const RETRY_MS = 30_000
const HOST = '127.0.0.1'

const gunzipAsync = promisify(gunzip)
const inflateAsync = promisify(inflate)

// What the endpoints forward to: the running luau-lsp (LspBridge) in the app, a fake in tests.
export interface CompanionTarget {
  // A project is open and its luau-lsp runs (or is starting): /full and /clear can be forwarded.
  available(): boolean
  // $/plugin/full with the plugin's tree.
  full(tree: unknown): void
  // $/plugin/clear.
  clear(): void
  // Absolute paths of the project's .lua/.luau files; null when no project is open.
  filePaths(): Promise<string[] | null>
}

class HttpError extends Error {
  status: number
  // The request body was not read to the end: answer, then close the connection.
  close: boolean
  constructor(status: number, message: string, close = false) {
    super(message)
    this.status = status
    this.close = close
  }
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

// "localhost:3667" -> "localhost"; "[::1]:3667" -> "[::1]".
function hostName(value: string): string {
  const v = value.trim().toLowerCase()
  if (v.startsWith('[')) {
    const end = v.indexOf(']')
    return end < 0 ? v : v.slice(0, end + 1)
  }
  const colon = v.indexOf(':')
  return colon < 0 ? v : v.slice(0, colon)
}

export function isLoopbackHost(value: string | undefined): boolean {
  if (!value) return false
  const name = hostName(value)
  return LOOPBACK_HOSTS.has(name) || /^127(\.\d{1,3}){3}$/.test(name)
}

// Studio's HttpService sends no Origin; a browser page always does on these requests.
export function isAllowedOrigin(origin: string | undefined): boolean {
  if (origin === undefined) return true
  try {
    const url = new URL(origin)
    return (url.protocol === 'http:' || url.protocol === 'https:') && isLoopbackHost(url.host)
  } catch {
    return false
  }
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false
  return address === '::1' || /^(::ffff:)?127\./.test(address)
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length'])
    if (Number.isFinite(declared) && declared > maxBytes) {
      reject(new HttpError(413, tooLarge(maxBytes, declared), true))
      return
    }
    const chunks: Buffer[] = []
    let size = 0
    let failed = false
    req.on('data', (chunk: Buffer) => {
      if (failed) return
      size += chunk.length
      if (size > maxBytes) {
        failed = true
        chunks.length = 0
        reject(new HttpError(413, tooLarge(maxBytes, size), true))
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (!failed) resolve(Buffer.concat(chunks))
    })
    req.on('error', (error) => {
      if (!failed) reject(new HttpError(400, `request error: ${error.message}`))
      failed = true
    })
  })
}

function tooLarge(limit: number, received: number): string {
  const mb = (n: number) => `${Math.round((n / 1024 / 1024) * 10) / 10}mb`
  return `Result is too large. Limit: ${mb(limit)}, Received: ${received > limit ? 'over ' : ''}${mb(Math.max(received, limit))}.\nReduce the include list in the Studio Plugin settings.`
}

async function decodeBody(req: IncomingMessage, raw: Buffer, maxBytes: number): Promise<Buffer> {
  const encoding = String(req.headers['content-encoding'] ?? 'identity').trim().toLowerCase()
  if (encoding === 'identity' || encoding === '') return raw
  try {
    if (encoding === 'gzip' || encoding === 'x-gzip') return await gunzipAsync(raw, { maxOutputLength: maxBytes })
    if (encoding === 'deflate') return await inflateAsync(raw, { maxOutputLength: maxBytes })
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code === 'ERR_BUFFER_TOO_LARGE' || error instanceof RangeError) throw new HttpError(413, tooLarge(maxBytes, maxBytes + 1))
    throw new HttpError(400, `could not decompress the body (${encoding})`)
  }
  throw new HttpError(415, `unsupported Content-Encoding: ${encoding}`)
}

function send(res: ServerResponse, status: number, body: string | object, close = false): void {
  if (res.headersSent) return
  const text = typeof body === 'string' ? body : JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': typeof body === 'string' ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store',
    ...(close ? { Connection: 'close' } : {})
  })
  res.end(text)
}

const NOT_RUNNING = 'luau-lsp is not running in RBX Forge. Open the project in RBX Forge (luau-lsp starts with the editor).'

export interface CompanionHandlerOptions {
  maxBodyBytes?: number
  // A /full or /clear was forwarded (status bar: "connected").
  onActivity?: (kind: 'full' | 'clear') => void
}

// The request handler, separate from the server so tests can drive it.
export function companionHandler(target: CompanionTarget, options: CompanionHandlerOptions = {}): (req: IncomingMessage, res: ServerResponse) => void {
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES
  const handle = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
    if (!isLoopbackAddress(req.socket.remoteAddress)) throw new HttpError(403, 'forbidden')
    if (!isLoopbackHost(req.headers.host)) throw new HttpError(403, 'forbidden host')
    if (!isAllowedOrigin(req.headers.origin as string | undefined)) throw new HttpError(403, 'forbidden origin')
    const path = (req.url ?? '/').split('?')[0]
    const method = req.method ?? 'GET'

    if (path === '/get-file-paths') {
      if (method !== 'GET' && method !== 'HEAD') throw new HttpError(405, 'method not allowed')
      req.resume()
      let files: string[] | null
      try {
        files = await target.filePaths()
      } catch {
        return send(res, 500, { error: 'Failed to get file paths' })
      }
      if (files === null) throw new HttpError(503, NOT_RUNNING)
      return send(res, 200, { files })
    }

    if (path === '/full' || path === '/clear') {
      if (method !== 'POST') throw new HttpError(405, 'method not allowed')
      if (path === '/clear') {
        req.resume()
        if (!target.available()) throw new HttpError(503, NOT_RUNNING)
        target.clear()
        options.onActivity?.('clear')
        return send(res, 200, 'OK')
      }
      const type = String(req.headers['content-type'] ?? '').toLowerCase()
      if (!type.includes('application/json')) {
        req.resume()
        throw new HttpError(415, 'expected Content-Type: application/json')
      }
      const raw = await readBody(req, maxBytes)
      const body = await decodeBody(req, raw, maxBytes)
      let parsed: unknown
      try {
        parsed = JSON.parse(body.toString('utf8'))
      } catch {
        throw new HttpError(400, 'invalid JSON')
      }
      const tree = (parsed as { tree?: unknown } | null)?.tree
      // The server's PluginNode::fromJson needs Name and ClassName on every node; check the root.
      if (!tree || typeof tree !== 'object' || Array.isArray(tree) || typeof (tree as { Name?: unknown }).Name !== 'string' || typeof (tree as { ClassName?: unknown }).ClassName !== 'string') {
        throw new HttpError(400, 'expected { tree: { Name, ClassName, Children } }')
      }
      if (!target.available()) throw new HttpError(503, NOT_RUNNING)
      target.full(tree)
      options.onActivity?.('full')
      return send(res, 200, 'OK')
    }

    req.resume()
    throw new HttpError(404, 'not found')
  }
  return (req, res) => {
    handle(req, res).catch((error) => {
      const status = error instanceof HttpError ? error.status : 500
      const close = error instanceof HttpError && error.close
      send(res, status, error instanceof Error ? error.message : String(error), close)
      // A refused upload may still be streaming: close instead of reading it all.
      if (close) res.once('finish', () => req.destroy())
    })
  }
}

// Absolute paths of the .lua/.luau files under root (the extension's workspace.findFiles), skipping
// node_modules, .git, out and dist. Symlinks are not followed.
export async function luauFilePaths(root: string, skipDirs: ReadonlySet<string>, max = MAX_FILE_PATHS): Promise<string[]> {
  const out: string[] = []
  const stack = [root]
  while (stack.length && out.length < max) {
    const dir = stack.pop()!
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) stack.push(join(dir, entry.name))
      } else if (entry.isFile() && (entry.name.endsWith('.luau') || entry.name.endsWith('.lua'))) {
        out.push(join(dir, entry.name))
        if (out.length >= max) break
      }
    }
  }
  return out.sort()
}

export interface CompanionServerOptions {
  target: CompanionTarget
  log: (stream: 'info' | 'stderr', text: string) => void
  onStatus?: (status: LspCompanionStatus) => void
  maxBodyBytes?: number
  retryMs?: number
  host?: string
}

// Owns the listening socket: start / stop / port changes, port-in-use retries, status.
export class StudioCompanionServer {
  private options: CompanionServerOptions
  private server: Server | null = null
  private retry: ReturnType<typeof setTimeout> | null = null
  private config = { enabled: false, port: DEFAULT_COMPANION_PORT }
  private current: LspCompanionStatus = { state: 'off', port: DEFAULT_COMPANION_PORT, lastActivityAt: null }
  // Error code last logged, so a port held for hours is reported once.
  private loggedError: string | null = null
  private generation = 0

  constructor(options: CompanionServerOptions) {
    this.options = options
  }

  status(): LspCompanionStatus {
    return { ...this.current }
  }

  private setStatus(patch: Partial<LspCompanionStatus>): void {
    this.current = { ...this.current, ...patch }
    this.options.onStatus?.(this.status())
  }

  // Applies the settings: listens, stops, or moves to the new port. Resolves once settled.
  async configure(enabled: boolean, port: number): Promise<LspCompanionStatus> {
    const next = { enabled, port: validPort(port) ? port : DEFAULT_COMPANION_PORT }
    const unchanged = next.enabled === this.config.enabled && next.port === this.config.port
    this.config = next
    if (unchanged && (!enabled || this.server || this.retry)) return this.status()
    await this.stop()
    this.loggedError = null
    if (!enabled) {
      this.setStatus({ state: 'off', port: next.port, detail: undefined })
      return this.status()
    }
    await this.listen(++this.generation)
    return this.status()
  }

  private listen(generation: number): Promise<void> {
    const { port } = this.config
    return new Promise((resolve) => {
      const server = createServer(
        companionHandler(this.options.target, {
          maxBodyBytes: this.options.maxBodyBytes,
          onActivity: (kind) => this.setStatus({ lastActivityAt: kind === 'full' ? Date.now() : null })
        })
      )
      // The plugin sends one request at a time; slow or idle sockets are not kept around.
      server.requestTimeout = 30_000
      server.headersTimeout = 10_000
      server.keepAliveTimeout = 5_000
      server.maxHeadersCount = 50
      const onError = (error: NodeJS.ErrnoException) => {
        server.close()
        if (generation !== this.generation) return resolve()
        const inUse = error.code === 'EADDRINUSE'
        const detail = inUse
          ? `port ${port} is in use (VS Code with the luau-lsp extension, or another RBX Forge?). Close it or change the port in Settings > Editor; retrying every ${Math.round((this.options.retryMs ?? RETRY_MS) / 1000)}s`
          : `could not listen on ${HOST}:${port}: ${error.message}`
        if (this.loggedError !== (error.code ?? error.message)) {
          this.loggedError = error.code ?? error.message
          this.options.log('stderr', `Studio plugin server: ${detail}`)
        }
        this.setStatus({ state: inUse ? 'portInUse' : 'error', port, detail })
        this.retry = setTimeout(() => {
          this.retry = null
          if (generation === this.generation && this.config.enabled) void this.listen(generation)
        }, this.options.retryMs ?? RETRY_MS)
        this.retry.unref?.()
        resolve()
      }
      server.once('error', onError)
      server.listen(port, this.options.host ?? HOST, () => {
        server.off('error', onError)
        if (generation !== this.generation) {
          server.close()
          return resolve()
        }
        server.on('error', (error) => this.options.log('stderr', `Studio plugin server: ${error.message}`))
        this.server = server
        this.loggedError = null
        this.options.log('info', `Studio plugin server listening on http://localhost:${port} (luau-lsp Studio Companion plugin)`)
        this.setStatus({ state: 'listening', port, detail: undefined })
        resolve()
      })
    })
  }

  private async stop(): Promise<void> {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    const server = this.server
    this.server = null
    if (!server) return
    await new Promise<void>((resolve) => {
      server.close(() => resolve())
      server.closeAllConnections?.()
    })
  }

  async dispose(): Promise<void> {
    this.config = { ...this.config, enabled: false }
    await this.stop()
  }
}

export function validPort(port: unknown): port is number {
  return typeof port === 'number' && Number.isInteger(port) && port >= 1 && port <= 65535
}
