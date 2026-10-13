// Shells for the integrated terminal, its environment, and the built-in tasks. Pure: everything
// platform-specific comes in through ToolContext so tests can check Windows and macOS rules on any OS.

import path from 'node:path'
import type { ShellInfo, TerminalTask } from '@shared/types'
import { envGet, findBash, findTool, type ToolContext } from '../tools.ts'

// The shell new terminals open on macOS/Linux: the user's login shell, started as a login shell
// so ~/.zprofile / ~/.bash_profile run like in Terminal.app.
function loginShell(ctx: ToolContext, passwdShell?: string): string {
  return envGet(ctx.env, 'SHELL', ctx.platform) || passwdShell || (ctx.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
}

export function detectShells(ctx: ToolContext, options: { passwdShell?: string; preferred?: string | null } = {}): ShellInfo[] {
  const shells: ShellInfo[] = []
  const add = (shell: ShellInfo) => {
    const key = ctx.platform === 'win32' ? shell.path.toLowerCase() : shell.path
    if (shells.some((s) => (ctx.platform === 'win32' ? s.path.toLowerCase() : s.path) === key)) return
    shells.push(shell)
  }
  if (ctx.platform === 'win32') {
    const p = path.win32
    const root = envGet(ctx.env, 'SystemRoot', ctx.platform) || 'C:\\Windows'
    // PowerShell 7 when installed, else Windows PowerShell (always present).
    const pwsh = findTool('pwsh', ctx)
    if (pwsh) add({ id: 'pwsh', label: 'PowerShell 7', path: pwsh, args: ['-NoLogo'] })
    add({ id: 'powershell', label: 'Windows PowerShell', path: p.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'), args: ['-NoLogo'] })
    add({ id: 'cmd', label: 'Command Prompt', path: envGet(ctx.env, 'ComSpec', ctx.platform) || p.join(root, 'System32', 'cmd.exe'), args: [] })
    const bash = findBash(ctx)
    if (bash) add({ id: 'gitbash', label: 'Git Bash', path: bash, args: ['--login', '-i'] })
  } else {
    const login = loginShell(ctx, options.passwdShell)
    add({ id: 'login', label: `${path.posix.basename(login)} (login)`, path: login, args: ['-l'] })
    for (const name of ['zsh', 'bash', 'fish', 'sh']) {
      const found = ['/bin', '/usr/bin', '/opt/homebrew/bin', '/usr/local/bin'].map((d) => `${d}/${name}`).find((f) => ctx.isExecutable(f)) ?? findTool(name, ctx)
      if (found) add({ id: name, label: name, path: found, args: name === 'sh' ? [] : ['-l'] })
    }
  }
  const pick = shells.find((s) => s.id === options.preferred) ?? shells[0]
  return shells.map((s) => (s === pick ? { ...s, default: true } : s))
}

// Arguments that make `shell` run one command and exit (run_in_terminal).
export function commandArgs(shell: ShellInfo, command: string, platform: NodeJS.Platform): string[] {
  const name = (platform === 'win32' ? path.win32 : path.posix).basename(shell.path).toLowerCase()
  if (platform === 'win32') {
    if (name.startsWith('cmd')) return ['/d', '/s', '/c', command]
    if (name.startsWith('pwsh') || name.startsWith('powershell')) return ['-NoLogo', '-NoProfile', '-Command', command]
    return ['--login', '-c', command]
  }
  if (name === 'fish') return ['-l', '-c', command]
  return ['-lc', command]
}

// Environment for terminal processes, from tools.ts toolEnv() (PATH with Rokit's bin first, then the
// inherited PATH, the macOS login shell's PATH and the usual install folders): colour back on,
// UTF-8 on macOS, no Electron switches.
export function terminalEnv(toolEnv: NodeJS.ProcessEnv, platform: NodeJS.Platform): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(toolEnv)) if (typeof v === 'string') env[k] = v
  for (const k of ['NO_COLOR', 'ELECTRON_RUN_AS_NODE', 'ELECTRON_NO_ATTACH_CONSOLE']) delete env[k]
  // Finder-launched apps have no LANG; without it zsh and most tools fall back to ASCII.
  if (platform === 'darwin' && !env.LANG) env.LANG = 'en_US.UTF-8'
  env.TERM = 'xterm-256color'
  env.COLORTERM = 'truecolor'
  env.TERM_PROGRAM = 'rbx-forge'
  return env
}

// Built-in tasks (palette "Run task"). On Windows ./dev and ./check have PowerShell twins in tools/;
// without them they run through Git Bash.
export function terminalTasks(platform: NodeJS.Platform, has: (rel: string) => boolean, shell?: ShellInfo): TerminalTask[] {
  const posixShell = !shell || platform !== 'win32' || shell.id === 'gitbash'
  const script = (name: string): string => {
    if (posixShell) return `./${name}`
    if (has(`tools/${name}.ps1`)) return shell?.id === 'cmd' ? `powershell -NoProfile -ExecutionPolicy Bypass -File tools\\${name}.ps1` : `& ./tools/${name}.ps1`
    return `bash ./${name}`
  }
  return [
    { id: 'dev', label: './dev', command: script('dev'), detail: 'watcher: Blink, features, wally' },
    { id: 'check', label: './check', command: script('check'), detail: 'lint, format and type checks' },
    { id: 'rojo', label: 'rojo serve', command: 'rojo serve', detail: 'live sync to Studio' },
    { id: 'wally', label: 'wally install', command: 'wally install', detail: 'install Packages/' },
    { id: 'lune', label: 'lune run tests', command: 'lune run tests', detail: 'Lune test runner' }
  ]
}
