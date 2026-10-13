// Bridge between luau-lsp (stdio, LSP base protocol) and the renderer's Monaco LSP client.
//
// The renderer calls lspStart(), then speaks plain JSON-RPC objects through lspSend() and
// the 'lsp:message' event. This side only frames/unframes messages (Content-Length headers),
// keeps the server alive (restart with backoff), supplies the Roblox type definitions and API
// docs, and plays the client's file watcher (workspace/didChangeWatchedFiles), because the
// server only reloads sourcemap.json and files changed on disk through that notification.
//
// Invocation (verified against luau-lsp src/main.cpp and the VS Code extension):
//   luau-lsp lsp --definitions:@roblox=<cache>/globalTypes.PluginSecurity.d.luau --docs=<cache>/api-docs.json
// `lsp` has no --sourcemap flag (only `analyze` does); the sourcemap is a setting
// (luau-lsp.sourcemap.*, default sourcemap.json in the workspace root) that the renderer
// returns from workspace/configuration. luau-lsp < 1.56 takes the definitions path without
// the "@roblox=" name, so the name is only added for 1.56 and newer.
//
// Bridge-made notifications sent to the renderer (not part of LSP):
//   harness/lspRestarted { rootUri }  a new server process is up; initialize it again
//   harness/lspStopped   {}           the server is gone (no project, or luau-lsp missing)

import type { ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, renameSync, statSync, watch, writeFileSync, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { LogLine } from '@shared/types'

const HEALTHY_MS = 60_000
const MAX_BACKOFF_MS = 30_000
const WEEK_MS = 7 * 24 * 60 * 60 * 1000
const FIRST_DOWNLOAD_WAIT_MS = 20_000
const WATCH_DEBOUNCE_MS = 250

const SECURITY_LEVEL = 'PluginSecurity'
const DEFINITIONS_FILE = `globalTypes.${SECURITY_LEVEL}.d.luau`
const DOCS_FILE = 'api-docs.json'
// Same sources as the luau-lsp VS Code extension, with GitHub raw mirrors as fallback.
const DEFINITIONS_URLS = [
  `https://luau-lsp.pages.dev/type-definitions/globalTypes.${SECURITY_LEVEL}.d.luau`,
  `https://raw.githubusercontent.com/JohnnyMorganz/luau-lsp/main/scripts/globalTypes.${SECURITY_LEVEL}.d.luau`
]
const DOCS_URLS = [
  'https://luau-lsp.pages.dev/api-docs/en-us.json',
  'https://raw.githubusercontent.com/MaximumADHD/Roblox-Client-Tracker/roblox/api-docs/en-us.json'
]

// ---------------------------------------------------------------------------
// Base protocol framing

const HEADER_END = Buffer.from('\r\n\r\n', 'ascii')

export function encodeMessage(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, 'ascii'), body])
}

// Incremental parser for "Content-Length: N\r\n\r\n<N bytes of JSON>" frames. Lengths are
// in bytes, so the buffer stays binary until a whole body is in.
export class LspFramer {
  private buffer: Buffer = Buffer.alloc(0)
  private onError: (error: string) => void

  constructor(onError: (error: string) => void = () => undefined) {
    this.onError = onError
  }

  push(chunk: Buffer | string): unknown[] {
    const data = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk
    this.buffer = this.buffer.length ? Buffer.concat([this.buffer, data]) : data
    const out: unknown[] = []
    for (;;) {
      const headerEnd = this.buffer.indexOf(HEADER_END)
      if (headerEnd < 0) break
      const headers = this.buffer.subarray(0, headerEnd).toString('ascii')
      const match = /^content-length:\s*(\d+)\s*$/im.exec(headers)
      if (!match) {
        this.onError(`LSP frame without Content-Length: ${JSON.stringify(headers.slice(0, 200))}`)
        this.buffer = this.buffer.subarray(headerEnd + HEADER_END.length)
        continue
      }
      const length = Number(match[1])
      const start = headerEnd + HEADER_END.length
      if (this.buffer.length < start + length) break
      const body = this.buffer.subarray(start, start + length).toString('utf8')
      this.buffer = this.buffer.subarray(start + length)
      try {
        out.push(JSON.parse(body))
      } catch {
        this.onError(`LSP frame with invalid JSON: ${body.slice(0, 200)}`)
      }
    }
    return out
  }

  reset(): void {
    this.buffer = Buffer.alloc(0)
  }
}

// ---------------------------------------------------------------------------
// Definitions / docs cache

export interface CachedFiles {
  definitions: string | null
  docs: string | null
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>

async function download(urls: string[], target: string, fetchImpl: Fetch): Promise<boolean> {
  for (const url of urls) {
    try {
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(60_000) })
      if (!response.ok) continue
      const text = await response.text()
      if (!text.trim()) continue
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, text)
      renameSync(tmp, target)
      return true
    } catch {
      // try the next mirror
    }
  }
  return false
}

function ageMs(file: string): number {
  try {
    return Date.now() - statSync(file).mtimeMs
  } catch {
    return Infinity
  }
}

// Keeps the Roblox definitions and API docs in cacheDir, refreshing them weekly.
export class TypeCache {
  private dir: string
  private fetchImpl: Fetch
  private log: (text: string) => void
  private refreshing: Promise<void> | null = null

  constructor(dir: string, log: (text: string) => void, fetchImpl: Fetch = fetch as unknown as Fetch) {
    this.dir = dir
    this.log = log
    this.fetchImpl = fetchImpl
  }

  get paths(): { definitions: string; docs: string } {
    return { definitions: join(this.dir, DEFINITIONS_FILE), docs: join(this.dir, DOCS_FILE) }
  }

  private refresh(): Promise<void> {
    if (this.refreshing) return this.refreshing
    const { definitions, docs } = this.paths
    this.refreshing = (async () => {
      mkdirSync(this.dir, { recursive: true })
      const jobs: Promise<void>[] = []
      if (ageMs(definitions) > WEEK_MS) {
        jobs.push(download(DEFINITIONS_URLS, definitions, this.fetchImpl).then((ok) => {
          this.log(ok ? 'downloaded Roblox type definitions' : 'could not download Roblox type definitions')
        }))
      }
      if (ageMs(docs) > WEEK_MS) {
        jobs.push(download(DOCS_URLS, docs, this.fetchImpl).then((ok) => {
          this.log(ok ? 'downloaded Roblox API docs' : 'could not download Roblox API docs')
        }))
      }
      await Promise.all(jobs)
    })()
      .catch((error) => this.log(`type cache: ${error}`))
      .finally(() => {
        this.refreshing = null
      })
    return this.refreshing
  }

  // Returns what is on disk. With nothing cached yet, waits (bounded) for the first download;
  // stale files are used as is and refreshed in the background for the next start.
  async ensure(waitMs = FIRST_DOWNLOAD_WAIT_MS): Promise<CachedFiles> {
    const { definitions, docs } = this.paths
    const stale = ageMs(definitions) > WEEK_MS || ageMs(docs) > WEEK_MS
    const refresh = stale ? this.refresh() : Promise.resolve()
    if (!existsSync(definitions) || !existsSync(docs)) {
      await Promise.race([refresh, new Promise((resolve) => setTimeout(resolve, waitMs).unref?.())])
    }
    return { definitions: existsSync(definitions) ? definitions : null, docs: existsSync(docs) ? docs : null }
  }
}

// ---------------------------------------------------------------------------
// Arguments

function parseVersion(text: string | null): [number, number, number] | null {
  const match = text ? /(\d+)\.(\d+)\.(\d+)/.exec(text) : null
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null
}

// Arguments after `lsp`. Named definitions ("@roblox=path") need luau-lsp 1.56+; unknown
// versions get the current form.
export function lspArgs(files: CachedFiles, version: string | null): string[] {
  const args: string[] = []
  if (files.definitions) {
    const v = parseVersion(version)
    const named = !v || v[0] > 1 || (v[0] === 1 && v[1] >= 56)
    args.push(named ? `--definitions:@roblox=${files.definitions}` : `--definitions=${files.definitions}`)
  }
  if (files.docs) args.push(`--docs=${files.docs}`)
  return args
}

// ---------------------------------------------------------------------------
// Bridge

export interface LspBridgeOptions {
  // Spawns `luau-lsp lsp <args>` with cwd = project root (Supervisor.spawnLsp), or null when
  // luau-lsp or the project is missing.
  spawn: (args: string[]) => ChildProcess | null
  // Messages for the renderer ('lsp:message').
  send: (message: unknown) => void
  log: (line: Omit<LogLine, 'at'>) => void
  // Folder for the downloaded definitions/docs (app userData).
  cacheDir: string
  // `luau-lsp --version` output, or null.
  version?: () => Promise<string | null>
  fetch?: Fetch
  // Base restart delay; doubles per quick crash up to 30s.
  backoffMs?: number
  // Skip downloads (tests).
  types?: { ensure(): Promise<CachedFiles> }
}

export class LspBridge {
  private options: LspBridgeOptions
  private types: { ensure(): Promise<CachedFiles> }
  private root: string | null = null
  private child: ChildProcess | null = null
  private framer = new LspFramer((error) => this.logLine('stderr', error))
  private wanted = false
  private initializeSent = false
  private failures = 0
  private startedAt = 0
  private generation = 0
  private retry: ReturnType<typeof setTimeout> | null = null
  private watcher: FSWatcher | null = null
  private pendingChanges = new Map<string, number>()
  private flushTimer: ReturnType<typeof setTimeout> | null = null
  private versionText: string | null | undefined

  constructor(options: LspBridgeOptions) {
    this.options = options
    this.types =
      options.types ??
      new TypeCache(options.cacheDir, (text) => this.logLine('info', text), options.fetch)
  }

  private logLine(stream: LogLine['stream'], text: string): void {
    this.options.log({ service: 'lsp', stream, text })
  }

  get running(): boolean {
    return this.child !== null
  }

  // Switches project. Restarts the server for the new root if the renderer had started it.
  async setRoot(root: string | null): Promise<void> {
    if (root === this.root) return
    this.root = root
    this.stopProcess()
    if (!root) {
      if (this.wanted) this.options.send({ jsonrpc: '2.0', method: 'harness/lspStopped', params: {} })
      return
    }
    if (this.wanted) {
      const ok = await this.spawnServer()
      if (ok === null) return // superseded by a newer start/setRoot
      this.options.send(
        ok
          ? { jsonrpc: '2.0', method: 'harness/lspRestarted', params: { rootUri: this.rootUri() } }
          : { jsonrpc: '2.0', method: 'harness/lspStopped', params: {} }
      )
    }
  }

  rootUri(): string | null {
    return this.root ? pathToFileURL(this.root).href : null
  }

  // Called by the renderer before it sends `initialize`. Reuses a fresh process; otherwise
  // (e.g. the window reloaded) starts a new one so the new client can initialize it.
  async start(): Promise<boolean> {
    this.wanted = true
    this.failures = 0
    if (!this.root) return false
    if (this.child && !this.initializeSent) return true
    this.stopProcess()
    return (await this.spawnServer()) === true
  }

  send(message: unknown): void {
    const child = this.child
    if (!child || !child.stdin || child.stdin.destroyed) return
    const method = (message as { method?: unknown })?.method
    if (method === 'initialize') this.initializeSent = true
    if (method === 'initialized') this.startWatching()
    child.stdin.write(encodeMessage(message))
  }

  dispose(): void {
    this.wanted = false
    this.stopProcess()
  }

  private stopProcess(): void {
    this.generation++
    if (this.retry) clearTimeout(this.retry)
    this.retry = null
    this.stopWatching()
    const child = this.child
    this.child = null
    this.initializeSent = false
    this.framer.reset()
    if (child) {
      try {
        child.stdin?.end(encodeMessage({ jsonrpc: '2.0', method: 'exit' }))
      } catch {
        // pipe already closed
      }
      const killTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
      }, 1500)
      killTimer.unref?.()
      child.kill()
    }
  }

  private async version(): Promise<string | null> {
    if (this.versionText === undefined) this.versionText = this.options.version ? await this.options.version().catch(() => null) : null
    return this.versionText ?? null
  }

  // true: spawned; false: luau-lsp missing; null: superseded by a newer start/setRoot.
  private async spawnServer(): Promise<boolean | null> {
    const generation = ++this.generation
    const files = await this.types.ensure().catch(() => ({ definitions: null, docs: null }))
    const args = lspArgs(files, await this.version())
    if (generation !== this.generation) return null
    if (!this.root) return false
    if (!files.definitions) this.logLine('info', 'starting luau-lsp without Roblox type definitions')

    const child = this.options.spawn(args)
    if (!child) {
      this.logLine('info', 'luau-lsp not found; editor language features are off. Run rokit install (or add luau-lsp to rokit.toml).')
      return false
    }
    this.child = child
    this.initializeSent = false
    this.startedAt = Date.now()
    this.framer.reset()
    this.logLine('info', `$ luau-lsp lsp ${args.join(' ')}`)

    child.stdout?.on('data', (chunk: Buffer) => {
      if (this.child !== child) return
      for (const message of this.framer.push(chunk)) this.options.send(message)
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
      const lines = stderr.split(/\r?\n/)
      stderr = lines.pop() ?? ''
      for (const line of lines) if (line.trim()) this.logLine('stderr', line)
    })
    child.stdin?.on('error', () => undefined)
    let done = false
    const onExit = (reason: string) => {
      if (done) return
      done = true
      if (this.child !== child) return
      this.child = null
      this.initializeSent = false
      this.stopWatching()
      if (!this.wanted || !this.root) return
      if (Date.now() - this.startedAt >= HEALTHY_MS) this.failures = 0
      const delay = Math.min((this.options.backoffMs ?? 1000) * 2 ** this.failures, MAX_BACKOFF_MS)
      this.failures++
      this.logLine('info', `luau-lsp ${reason}; restarting in ${Math.round(delay / 100) / 10}s`)
      this.options.send({ jsonrpc: '2.0', method: 'harness/lspStopped', params: { reason } })
      const restartGeneration = this.generation
      this.retry = setTimeout(async () => {
        this.retry = null
        if (!this.wanted || !this.root || restartGeneration !== this.generation) return
        if (await this.spawnServer()) {
          this.options.send({ jsonrpc: '2.0', method: 'harness/lspRestarted', params: { rootUri: this.rootUri() } })
        }
      }, delay)
    }
    child.on('error', (error) => onExit(error.message))
    child.on('exit', (code, signal) => onExit(signal ? `killed by ${signal}` : `exited with code ${code}`))
    return true
  }

  // --- workspace/didChangeWatchedFiles on behalf of the client

  private startWatching(): void {
    if (this.watcher || !this.root) return
    const root = this.root
    try {
      this.watcher = watch(root, { recursive: true }, (event, filename) => {
        if (!filename) return
        const rel = filename.toString()
        if (!isWatched(rel)) return
        const full = join(root, rel)
        // 1 created, 2 changed, 3 deleted
        const type = event === 'change' ? 2 : existsSync(full) ? 1 : 3
        const uri = pathToFileURL(full).href
        const previous = this.pendingChanges.get(uri)
        this.pendingChanges.set(uri, previous === 1 && type === 2 ? 1 : type)
        if (!this.flushTimer) this.flushTimer = setTimeout(() => this.flushChanges(), WATCH_DEBOUNCE_MS)
      })
      this.watcher.on('error', (error) => {
        this.logLine('stderr', `file watcher: ${error.message}`)
        this.stopWatching()
      })
    } catch (error) {
      this.logLine('stderr', `file watcher: ${error}`)
    }
  }

  private flushChanges(): void {
    this.flushTimer = null
    if (!this.pendingChanges.size) return
    const changes = [...this.pendingChanges].map(([uri, type]) => ({ uri, type }))
    this.pendingChanges.clear()
    this.send({ jsonrpc: '2.0', method: 'workspace/didChangeWatchedFiles', params: { changes } })
  }

  private stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
    if (this.flushTimer) clearTimeout(this.flushTimer)
    this.flushTimer = null
    this.pendingChanges.clear()
  }
}

const SKIP_DIRS = new Set(['node_modules', '.git', 'out', 'dist'])

// Files the server cares about: sources, sourcemap.json and Luau config files.
export function isWatched(relPath: string): boolean {
  const parts = relPath.split(/[\\/]/)
  if (parts.some((part) => SKIP_DIRS.has(part))) return false
  const name = basename(relPath)
  return (
    name.endsWith('.luau') ||
    name.endsWith('.lua') ||
    name === 'sourcemap.json' ||
    name === '.luaurc' ||
    name === '.config.luau'
  )
}

