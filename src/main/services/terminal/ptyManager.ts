// Integrated terminal sessions over a pty backend (node-pty in the app, a fake in tests). No electron
// imports. Keeps every terminal's recent output so a reloaded renderer can redraw it, batches output
// for IPC, and runs one-shot commands for the assistant's run_in_terminal.

import type { ShellInfo, TerminalCreateOptions, TerminalInfo, TerminalKind } from '@shared/types'

export interface Disposable {
  dispose(): void
}

// The subset of node-pty's IPty the manager uses.
export interface PtyLike {
  readonly pid: number
  onData(listener: (data: string) => void): Disposable
  onExit(listener: (event: { exitCode: number; signal?: number }) => void): Disposable
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(signal?: string): void
}

export interface PtySpawnOptions {
  name: string
  cols: number
  rows: number
  cwd: string
  env: Record<string, string>
}

export type PtySpawn = (file: string, args: string[], options: PtySpawnOptions) => PtyLike

export interface PtyManagerDeps {
  spawn: PtySpawn
  cwd: () => string | null
  env: () => Record<string, string>
  shells: () => ShellInfo[]
  // Arguments that make a shell run one command and exit.
  commandArgs: (shell: ShellInfo, command: string) => string[]
  onData: (id: string, data: string) => void
  onList: (list: TerminalInfo[]) => void
  // Output batching delay in ms (0 = flush on the next tick).
  batchMs?: number
  now?: () => number
}

export interface RunResult {
  id: string
  exitCode: number | null
  output: string
  timedOut: boolean
}

interface Session {
  info: TerminalInfo
  pty: PtyLike | null
  buffer: string
  pending: string
  timer: ReturnType<typeof setTimeout> | null
  subs: Disposable[]
  exitWaiters: ((code: number | null) => void)[]
  // run(): raw output since the command started.
  capture: string | null
}

const BUFFER_CHARS = 256 * 1024
const MAX_COLS = 1000
const MAX_ROWS = 500

// Escape sequences and carriage-return overwrites removed, for text handed to the model.
export function plainText(raw: string): string {
  const noAnsi = raw
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC (titles, hyperlinks)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\x1b[@-Z\\-_]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
  return noAnsi
    .split('\n')
    .map((line) => {
      const parts = line.replace(/\r$/, '').split('\r')
      return parts[parts.length - 1]
    })
    .join('\n')
}

export class PtyManager {
  private deps: PtyManagerDeps
  private sessions = new Map<string, Session>()
  private seq = 0

  constructor(deps: PtyManagerDeps) {
    this.deps = deps
  }

  list(): TerminalInfo[] {
    return [...this.sessions.values()].map((s) => ({ ...s.info }))
  }

  get(id: string): TerminalInfo | null {
    const s = this.sessions.get(id)
    return s ? { ...s.info } : null
  }

  private shell(shellId?: string): ShellInfo {
    const shells = this.deps.shells()
    const shell = (shellId && shells.find((s) => s.id === shellId)) || shells.find((s) => s.default) || shells[0]
    if (!shell) throw new Error('No shell found')
    return shell
  }

  private title(base: string): string {
    const used = new Set(this.list().map((t) => t.title))
    if (!used.has(base)) return base
    for (let n = 2; ; n++) if (!used.has(`${base} ${n}`)) return `${base} ${n}`
  }

  create(options: TerminalCreateOptions & { kind?: TerminalKind; command?: string; args?: string[] } = {}): TerminalInfo {
    const cwd = this.deps.cwd()
    if (!cwd) throw new Error('Open a project first')
    const shell = this.shell(options.shellId)
    const id = `t${++this.seq}`
    const cols = clamp(options.cols ?? 80, 2, MAX_COLS)
    const rows = clamp(options.rows ?? 24, 1, MAX_ROWS)
    const kind = options.kind ?? 'shell'
    const info: TerminalInfo = {
      id,
      title: this.title(options.title?.trim() || shellName(shell)),
      kind,
      shellId: shell.id,
      shellLabel: shell.label,
      cwd,
      pid: null,
      createdAt: (this.deps.now ?? Date.now)(),
      exited: false,
      ...(options.command ? { command: options.command } : {})
    }
    const session: Session = { info, pty: null, buffer: '', pending: '', timer: null, subs: [], exitWaiters: [], capture: null }
    this.sessions.set(id, session)
    let pty: PtyLike
    try {
      pty = this.deps.spawn(shell.path, options.args ?? shell.args, { name: 'xterm-256color', cols, rows, cwd, env: this.deps.env() })
    } catch (error) {
      // Show why in the tab instead of failing silently.
      this.output(session, `\x1b[31mCould not start ${shell.path}: ${(error as Error).message}\x1b[0m\r\n`)
      this.exited(session, null)
      return { ...session.info }
    }
    session.pty = pty
    info.pid = pty.pid
    session.subs.push(
      pty.onData((data) => this.output(session, data)),
      pty.onExit(({ exitCode }) => this.exited(session, exitCode))
    )
    this.changed()
    return { ...info }
  }

  write(id: string, data: string): void {
    const s = this.sessions.get(id)
    if (s?.pty && !s.info.exited) s.pty.write(data)
  }

  resize(id: string, cols: number, rows: number): void {
    const s = this.sessions.get(id)
    if (!s?.pty || s.info.exited) return
    if (!Number.isFinite(cols) || !Number.isFinite(rows)) return
    try {
      s.pty.resize(clamp(Math.floor(cols), 2, MAX_COLS), clamp(Math.floor(rows), 1, MAX_ROWS))
    } catch {
      // The process may have just exited.
    }
  }

  rename(id: string, title: string): TerminalInfo[] {
    const s = this.sessions.get(id)
    const next = title.replace(/\s+/g, ' ').trim().slice(0, 60)
    if (s && next) {
      s.info.title = next
      this.changed()
    }
    return this.list()
  }

  buffer(id: string): string {
    const s = this.sessions.get(id)
    return s ? s.buffer + s.pending : ''
  }

  // Ends the process and removes the tab.
  kill(id: string): void {
    const s = this.sessions.get(id)
    if (!s) return
    this.sessions.delete(id)
    this.dispose(s)
    this.changed()
  }

  killAll(): void {
    if (!this.sessions.size) return
    for (const s of this.sessions.values()) this.dispose(s)
    this.sessions.clear()
    this.changed()
  }

  // Runs `command` in a new terminal tab through the shell's one-shot mode and resolves with its
  // exit code and plain-text output. On timeout the process keeps running in its tab.
  run(command: string, options: { shellId?: string; title?: string; timeoutMs?: number; signal?: AbortSignal; cols?: number; rows?: number } = {}): Promise<RunResult> {
    const shell = this.shell(options.shellId)
    const info = this.create({
      shellId: shell.id,
      title: options.title ?? command.slice(0, 40),
      kind: 'agent',
      command,
      args: this.deps.commandArgs(shell, command),
      cols: options.cols ?? 120,
      rows: options.rows ?? 30
    })
    const session = this.sessions.get(info.id)!
    // Echo the command, like a prompt would (not part of the captured output).
    this.output(session, `\x1b[2m$ ${command}\x1b[0m\r\n`)
    session.capture = ''
    const output = () => plainText((session.capture ?? '').replace(/\r\n\x1b\[2m\[process exited[^\]]*\]\x1b\[0m\r\n$/, '')).trimEnd()
    return new Promise((resolve) => {
      let done = false
      const finish = (exitCode: number | null, timedOut: boolean) => {
        if (done) return
        done = true
        if (timer) clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        resolve({ id: info.id, exitCode, output: output(), timedOut })
      }
      const onAbort = () => {
        this.write(info.id, '\x03')
        session.pty?.kill()
        finish(null, false)
      }
      const timer = options.timeoutMs ? setTimeout(() => finish(null, true), options.timeoutMs) : null
      options.signal?.addEventListener('abort', onAbort, { once: true })
      if (session.info.exited) finish(session.info.exitCode ?? null, false)
      else session.exitWaiters.push((code) => finish(code, false))
    })
  }

  private output(s: Session, data: string): void {
    s.pending += data
    if (s.capture !== null) {
      s.capture += data
      if (s.capture.length > BUFFER_CHARS) s.capture = s.capture.slice(s.capture.length - BUFFER_CHARS)
    }
    const delay = this.deps.batchMs ?? 4
    if (!s.timer) s.timer = setTimeout(() => this.flush(s), delay)
  }

  private flush(s: Session): void {
    s.timer = null
    if (!s.pending) return
    const data = s.pending
    s.pending = ''
    s.buffer += data
    if (s.buffer.length > BUFFER_CHARS) s.buffer = s.buffer.slice(s.buffer.length - BUFFER_CHARS)
    if (this.sessions.get(s.info.id) === s) this.deps.onData(s.info.id, data)
  }

  private exited(s: Session, exitCode: number | null): void {
    if (s.info.exited) return
    s.info.exited = true
    s.info.exitCode = exitCode
    const note = exitCode === 0 || exitCode === null ? '' : ` with code ${exitCode}`
    this.output(s, `\r\n\x1b[2m[process exited${note}]\x1b[0m\r\n`)
    // Waiters see the final output, including what is still batched.
    this.flush(s)
    for (const w of s.exitWaiters.splice(0)) w(exitCode)
    if (this.sessions.get(s.info.id) === s) this.changed()
  }

  private dispose(s: Session): void {
    if (s.timer) clearTimeout(s.timer)
    s.timer = null
    for (const d of s.subs.splice(0)) d.dispose()
    if (s.pty && !s.info.exited) {
      try {
        s.pty.kill()
      } catch {
        // already gone
      }
    }
    s.info.exited = true
    for (const w of s.exitWaiters.splice(0)) w(null)
  }

  private changed(): void {
    this.deps.onList(this.list())
  }
}

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(n)))
}

function shellName(shell: ShellInfo): string {
  const base = shell.path.split(/[\\/]/).pop() ?? shell.id
  return base.replace(/\.exe$/i, '')
}
