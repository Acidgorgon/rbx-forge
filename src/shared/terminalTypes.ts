// Integrated terminal (bottom panel): node-pty in main, xterm.js in the renderer.
// HarnessApi / HarnessEvents extend these (shared/types.ts).

export interface ShellInfo {
  // Stable id ("login", "zsh", "pwsh", "powershell", "cmd", "gitbash"...).
  id: string
  label: string
  path: string
  args: string[]
  // The shell new terminals use when none is picked.
  default?: boolean
}

export type TerminalKind = 'shell' | 'task' | 'agent'

export interface TerminalInfo {
  id: string
  title: string
  kind: TerminalKind
  shellId: string
  shellLabel: string
  cwd: string
  pid: number | null
  createdAt: number
  // The process ended; the tab stays (with its output) until killed.
  exited: boolean
  exitCode?: number | null
  // Task or assistant command this terminal was started for.
  command?: string
}

export interface TerminalCreateOptions {
  shellId?: string
  title?: string
  cols?: number
  rows?: number
}

export interface TerminalTask {
  id: string
  label: string
  // What is typed into the shell (platform-specific: ./dev vs tools/dev.ps1).
  command: string
  detail?: string
}

// run_in_terminal waiting for the user's OK.
export interface TerminalRunRequest {
  id: string
  command: string
  cwd: string
  requestedAt: number
}

export interface TerminalApi {
  terminalShells(): Promise<ShellInfo[]>
  terminalSetDefaultShell(shellId: string): Promise<ShellInfo[]>
  terminalList(): Promise<TerminalInfo[]>
  terminalCreate(options?: TerminalCreateOptions): Promise<TerminalInfo>
  terminalWrite(id: string, data: string): Promise<void>
  terminalResize(id: string, cols: number, rows: number): Promise<void>
  terminalKill(id: string): Promise<void>
  terminalRename(id: string, title: string): Promise<TerminalInfo[]>
  // Recent output (for re-attaching after a reload).
  terminalBuffer(id: string): Promise<string>
  terminalTasks(): Promise<TerminalTask[]>
  terminalRunTask(taskId: string): Promise<TerminalInfo>
  terminalPendingRuns(): Promise<TerminalRunRequest[]>
  terminalConfirmRun(requestId: string, allow: boolean): Promise<void>
}

export interface TerminalEvents {
  'terminal:data': { id: string; data: string }
  'terminal:list': TerminalInfo[]
  // Pending run_in_terminal requests (the whole list, [] when none).
  'terminal:confirm': TerminalRunRequest[]
  // Main asks the renderer to show (and focus) a terminal.
  'terminal:focus': { id: string }
}
