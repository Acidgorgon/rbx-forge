// Integrated terminal service: IPC handlers (TerminalApi), the main chat's run_in_terminal tool
// (which waits for the user's OK in the UI), and the project/quit lifecycle. No electron imports:
// main/index.ts passes emit/settings in, tests pass a fake pty.

import { existsSync } from 'node:fs'
import { userInfo } from 'node:os'
import { join } from 'node:path'
import { z } from 'zod'
import type { HarnessEvents, ShellInfo, TerminalRunRequest } from '@shared/types'
import type { ServiceTool } from '../../context.ts'
import { defaultContext, toolEnv, type ToolContext } from '../tools.ts'
import { PtyManager, type PtySpawn } from './ptyManager.ts'
import { commandArgs, detectShells, terminalEnv, terminalTasks } from './shells.ts'

export { PtyManager, plainText } from './ptyManager.ts'
export type { PtyLike, PtySpawn } from './ptyManager.ts'

export interface TerminalDeps {
  // node-pty, loaded lazily (backend.ts); tests pass a fake.
  backend: () => Promise<{ spawn?: PtySpawn; error?: string }>
  root: () => string | null
  emit: <K extends keyof HarnessEvents>(event: K, payload: HarnessEvents[K]) => void
  getSetting: <T>(key: string, fallback: T) => T
  setSetting: (key: string, value: unknown) => void
  log?: (text: string) => void
  toolContext?: () => ToolContext
  env?: () => NodeJS.ProcessEnv
  // How long a run_in_terminal request waits for the user (default 5 min).
  confirmTimeoutMs?: number
}

const DEFAULT_SHELL = 'terminal.defaultShell'
const MAX_TOOL_OUTPUT = 12_000

interface Pending {
  request: TerminalRunRequest
  resolve: (allow: boolean) => void
  timer: ReturnType<typeof setTimeout>
}

export class TerminalService {
  private deps: TerminalDeps
  private spawn: PtySpawn | null = null
  private loadError: string | null = null
  private shellCache: ShellInfo[] | null = null
  private pending = new Map<string, Pending>()
  private seq = 0
  readonly manager: PtyManager

  constructor(deps: TerminalDeps) {
    this.deps = deps
    this.manager = new PtyManager({
      spawn: (file, args, options) => {
        if (!this.spawn) throw new Error(this.loadError ?? 'terminal backend not loaded')
        return this.spawn(file, args, options)
      },
      cwd: () => deps.root(),
      env: () => terminalEnv(deps.env?.() ?? toolEnv(), this.ctx().platform),
      shells: () => this.shells(),
      commandArgs: (shell, command) => commandArgs(shell, command, this.ctx().platform),
      onData: (id, data) => deps.emit('terminal:data', { id, data }),
      onList: (list) => deps.emit('terminal:list', list)
    })
  }

  private ctx(): ToolContext {
    return this.deps.toolContext?.() ?? defaultContext()
  }

  private async ready(): Promise<void> {
    if (this.spawn) return
    const b = await this.deps.backend()
    if (b.spawn) this.spawn = b.spawn
    else {
      this.loadError = b.error ?? 'node-pty is not available'
      throw new Error(`The terminal is unavailable: ${this.loadError}`)
    }
  }

  shells(): ShellInfo[] {
    if (!this.shellCache) {
      let passwdShell: string | undefined
      try {
        passwdShell = userInfo().shell ?? undefined
      } catch {
        passwdShell = undefined
      }
      this.shellCache = detectShells(this.ctx(), { passwdShell })
    }
    const preferred = this.deps.getSetting<string | null>(DEFAULT_SHELL, null)
    const pick = this.shellCache.find((s) => s.id === preferred) ?? this.shellCache[0]
    return this.shellCache.map((s) => ({ ...s, default: s === pick }))
  }

  tasks(shellId?: string) {
    const root = this.deps.root()
    const shell = this.shells().find((s) => (shellId ? s.id === shellId : s.default))
    return terminalTasks(this.ctx().platform, (rel) => !!root && existsSync(join(root, ...rel.split('/'))), shell)
  }

  async runTask(taskId: string) {
    const task = this.tasks().find((t) => t.id === taskId)
    if (!task) throw new Error(`unknown task ${taskId}`)
    await this.ready()
    const info = this.manager.create({ title: task.label, kind: 'task', command: task.command, cols: 120, rows: 24 })
    // The shell reads input once its prompt is up; typed-ahead input is buffered by the pty.
    this.manager.write(info.id, task.command + '\r')
    this.deps.emit('terminal:focus', { id: info.id })
    return info
  }

  pendingRuns(): TerminalRunRequest[] {
    return [...this.pending.values()].map((p) => p.request)
  }

  confirm(requestId: string, allow: boolean): void {
    const p = this.pending.get(requestId)
    if (!p) return
    this.pending.delete(requestId)
    clearTimeout(p.timer)
    p.resolve(allow)
    this.deps.emit('terminal:confirm', this.pendingRuns())
  }

  // Asks the UI; resolves false on deny, timeout, abort or project close.
  requestRun(command: string, signal?: AbortSignal): Promise<boolean> {
    const root = this.deps.root()
    if (!root) return Promise.resolve(false)
    const request: TerminalRunRequest = { id: `run${++this.seq}`, command, cwd: root, requestedAt: Date.now() }
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.confirm(request.id, false), this.deps.confirmTimeoutMs ?? 5 * 60_000)
      this.pending.set(request.id, { request, resolve, timer })
      signal?.addEventListener('abort', () => this.confirm(request.id, false), { once: true })
      this.deps.emit('terminal:confirm', this.pendingRuns())
    })
  }

  // run_in_terminal: main chat only (ServiceToolSets.chat).
  private tools: ServiceTool[] | null = null
  chatTools(): ServiceTool[] {
    return (this.tools ??= [
      {
        name: 'run_in_terminal',
        description:
          'Run a shell command in a new tab of the integrated terminal, in the project root, after the user approves it in the UI. Returns the exit code and output (ANSI stripped, tail-truncated). Use for installs and CLIs (rokit, wally, rojo, lune, git, npm); prefer the dedicated tools for files, tests and services. Long-running commands (rojo serve, ./dev) keep running in their tab after timeout_seconds.',
        inputSchema: {
          command: z.string().min(1).max(4000),
          timeout_seconds: z.number().int().min(1).max(600).optional()
        },
        handler: async (args: { command: string; timeout_seconds?: number }, extra: unknown) => {
          const signal = (extra as { signal?: AbortSignal } | undefined)?.signal
          const text = (t: string, isError = false) => ({ content: [{ type: 'text' as const, text: t }], ...(isError ? { isError } : {}) })
          if (!this.deps.root()) return text('no project open', true)
          try {
            await this.ready()
          } catch (error) {
            return text((error as Error).message, true)
          }
          const allowed = await this.requestRun(args.command, signal)
          if (!allowed) return text('The user declined to run this command (or did not answer).', true)
          this.deps.log?.(`terminal: ${args.command}`)
          const result = await this.manager.run(args.command, { timeoutMs: (args.timeout_seconds ?? 120) * 1000, signal })
          this.deps.emit('terminal:focus', { id: result.id })
          let out = result.output
          if (out.length > MAX_TOOL_OUTPUT) out = `…(${out.length - MAX_TOOL_OUTPUT} chars cut)\n` + out.slice(-MAX_TOOL_OUTPUT)
          const head = result.timedOut
            ? `still running after ${args.timeout_seconds ?? 120}s in terminal "${this.manager.get(result.id)?.title ?? result.id}"; output so far:`
            : result.exitCode === null
              ? 'stopped'
              : `exit code ${result.exitCode}`
          return text(`${head}\n${out || '(no output)'}`, !result.timedOut && result.exitCode !== 0)
        }
      }
    ])
  }

  handlers(): Record<string, (...args: any[]) => unknown> {
    return {
      terminalShells: () => this.shells(),
      terminalSetDefaultShell: (shellId: string) => {
        if (this.shells().some((s) => s.id === shellId)) this.deps.setSetting(DEFAULT_SHELL, shellId)
        return this.shells()
      },
      terminalList: () => this.manager.list(),
      terminalCreate: async (options?: { shellId?: string; title?: string; cols?: number; rows?: number }) => {
        await this.ready()
        return this.manager.create({ ...(options ?? {}), kind: 'shell' })
      },
      terminalWrite: (id: string, data: string) => {
        if (typeof data === 'string') this.manager.write(id, data)
      },
      terminalResize: (id: string, cols: number, rows: number) => this.manager.resize(id, cols, rows),
      terminalKill: (id: string) => this.manager.kill(id),
      terminalRename: (id: string, title: string) => this.manager.rename(id, String(title ?? '')),
      terminalBuffer: (id: string) => this.manager.buffer(id),
      terminalTasks: () => this.tasks(),
      terminalRunTask: (taskId: string) => this.runTask(taskId),
      terminalPendingRuns: () => this.pendingRuns(),
      terminalConfirmRun: (requestId: string, allow: boolean) => this.confirm(requestId, allow === true)
    }
  }

  // Project closed (or switched): terminals belong to the old root.
  onProjectClose(): void {
    for (const id of [...this.pending.keys()]) this.confirm(id, false)
    this.manager.killAll()
  }

  dispose(): void {
    this.onProjectClose()
  }
}
