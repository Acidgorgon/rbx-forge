// A small MCP client for one stdio server (newline-delimited JSON-RPC 2.0, the MCP stdio transport:
// modelcontextprotocol.io/specification/2025-06-18/basic/transports#stdio). Forge uses it for
// Settings > Studio tools > Test connection and to bridge Roblox Studio's MCP tools into the
// OpenAI-compatible chat loop. The Agent SDK path spawns the server itself (Options.mcpServers).
// No electron imports.

import { spawn, type ChildProcess } from 'node:child_process'
import { killTree } from '../services/supervisor.ts'

export const MCP_PROTOCOL_VERSION = '2025-06-18'

export interface McpServerCommand {
  command: string
  args: string[]
  env?: NodeJS.ProcessEnv
  cwd?: string
}

export interface McpToolInfo {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

export interface McpContent {
  type: string
  text?: string
  data?: string
  mimeType?: string
  [k: string]: unknown
}

export interface McpCallResult {
  content: McpContent[]
  isError?: boolean
}

interface Pending {
  resolve: (v: any) => void
  reject: (e: Error) => void
  timer?: ReturnType<typeof setTimeout>
}

const STDERR_KEEP = 4000

export class McpStdioClient {
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buf = ''
  private stderrText = ''
  private exited: string | null = null
  serverInfo: { name?: string; version?: string } = {}

  private child: ChildProcess

  private constructor(child: ChildProcess) {
    this.child = child
    child.stdout!.setEncoding('utf8')
    child.stdout!.on('data', (chunk: string) => this.onData(chunk))
    child.stderr!.setEncoding('utf8')
    child.stderr!.on('data', (chunk: string) => {
      this.stderrText = (this.stderrText + chunk).slice(-STDERR_KEEP)
    })
    child.stdin!.on('error', () => undefined)
    const gone = (why: string) => {
      if (this.exited) return
      this.exited = why
      for (const p of this.pending.values()) {
        clearTimeout(p.timer)
        p.reject(new Error(why))
      }
      this.pending.clear()
    }
    child.on('error', (e) => gone(`could not start: ${e.message}`))
    child.on('exit', (code, signal) => gone(`server exited${code !== null ? ` with code ${code}` : signal ? ` (${signal})` : ''}`))
  }

  // Spawns the server and runs the MCP handshake (initialize, then notifications/initialized).
  static async connect(cmd: McpServerCommand, opts: { timeoutMs?: number; signal?: AbortSignal; clientName?: string } = {}): Promise<McpStdioClient> {
    const child = spawn(cmd.command, cmd.args, {
      cwd: cmd.cwd,
      env: cmd.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      // Its own process group off Windows, so close() can end everything it started (killTree).
      detached: process.platform !== 'win32'
    })
    const client = new McpStdioClient(child)
    const onAbort = () => void client.close()
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    try {
      const init = await client.request(
        'initialize',
        { protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {}, clientInfo: { name: opts.clientName ?? 'rbx-forge', version: '1' } },
        opts.timeoutMs ?? 15_000
      )
      client.serverInfo = (init?.serverInfo as typeof client.serverInfo) ?? {}
      client.notify('notifications/initialized')
      return client
    } catch (e) {
      await client.close()
      // Keep what the server printed: it usually says why (not running, disabled, wrong path).
      ;(e as Error & { stderr?: string }).stderr = client.stderr
      throw e
    } finally {
      opts.signal?.removeEventListener('abort', onAbort)
    }
  }

  get stderr(): string {
    return this.stderrText
  }

  // Every tool, following nextCursor pages.
  async listTools(timeoutMs = 15_000): Promise<McpToolInfo[]> {
    const out: McpToolInfo[] = []
    let cursor: string | undefined
    for (let page = 0; page < 20; page++) {
      const r = await this.request('tools/list', cursor ? { cursor } : {}, timeoutMs)
      for (const t of Array.isArray(r?.tools) ? r.tools : []) {
        if (t && typeof t.name === 'string') out.push({ name: t.name, description: typeof t.description === 'string' ? t.description : undefined, inputSchema: t.inputSchema && typeof t.inputSchema === 'object' ? t.inputSchema : undefined })
      }
      cursor = typeof r?.nextCursor === 'string' && r.nextCursor ? r.nextCursor : undefined
      if (!cursor) break
    }
    return out
  }

  async callTool(name: string, args: Record<string, unknown>, opts: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<McpCallResult> {
    const r = await this.request('tools/call', { name, arguments: args }, opts.timeoutMs ?? 300_000, opts.signal)
    return { content: Array.isArray(r?.content) ? r.content : [], ...(r?.isError ? { isError: true } : {}) }
  }

  async close(): Promise<void> {
    try {
      this.child.stdin?.end()
    } catch {
      // already closed
    }
    await killTree(this.child, 1500).catch(() => undefined)
  }

  request(method: string, params: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
    if (this.exited) return Promise.reject(new Error(this.exited))
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const p: Pending = { resolve, reject }
      const done = () => {
        clearTimeout(p.timer)
        signal?.removeEventListener('abort', onAbort)
        this.pending.delete(id)
      }
      const onAbort = () => {
        done()
        this.notify('notifications/cancelled', { requestId: id, reason: 'cancelled' })
        reject(new Error('cancelled'))
      }
      p.resolve = (v) => (done(), resolve(v))
      p.reject = (e) => (done(), reject(e))
      p.timer = setTimeout(() => p.reject(new Error(`${method} timed out after ${Math.round(timeoutMs / 1000)}s`)), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, p)
      this.send({ jsonrpc: '2.0', id, method, params })
    })
  }

  notify(method: string, params?: unknown): void {
    this.send({ jsonrpc: '2.0', method, ...(params === undefined ? {} : { params }) })
  }

  private send(msg: unknown): void {
    if (this.exited) return
    try {
      this.child.stdin!.write(JSON.stringify(msg) + '\n')
    } catch {
      // the exit handler rejects what is pending
    }
  }

  private onData(chunk: string): void {
    this.buf += chunk
    let nl: number
    while ((nl = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, nl).trim()
      this.buf = this.buf.slice(nl + 1)
      if (line) this.onLine(line)
    }
  }

  private onLine(line: string): void {
    let msg: any
    try {
      msg = JSON.parse(line)
    } catch {
      // Not JSON-RPC (a launcher printing a banner): keep it with stderr for diagnostics.
      this.stderrText = (this.stderrText + line + '\n').slice(-STDERR_KEEP)
      return
    }
    if (!msg || typeof msg !== 'object') return
    // A response to one of ours.
    if ((msg.result !== undefined || msg.error !== undefined) && typeof msg.id === 'number' && msg.method === undefined) {
      const p = this.pending.get(msg.id)
      if (!p) return
      if (msg.error) p.reject(new Error(String(msg.error.message ?? 'MCP error') + (msg.error.code !== undefined ? ` (${msg.error.code})` : '')))
      else p.resolve(msg.result)
      return
    }
    // A request from the server: answer ping, refuse the rest (no sampling / roots / elicitation).
    if (typeof msg.method === 'string' && msg.id !== undefined && msg.id !== null) {
      if (msg.method === 'ping') this.send({ jsonrpc: '2.0', id: msg.id, result: {} })
      else this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `${msg.method} is not supported by this client` } })
    }
    // Notifications (progress, logging, list_changed) are ignored.
  }
}
