import { execFile, spawn, type ChildProcess, type SpawnOptions } from 'node:child_process'
import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

// Locating and running the command-line tools Forge drives (rojo, wally, luau-lsp, git, python, bash/
// PowerShell) on macOS, Windows and Linux. The pure helpers take platform/env/filesystem arguments
// so tests can exercise Windows and macOS rules from any OS.

export type Platform = NodeJS.Platform

export interface ToolContext {
  platform: Platform
  env: NodeJS.ProcessEnv
  home: string
  // true when `file` is an existing, runnable regular file.
  isExecutable: (file: string) => boolean
  // Lists a directory's entries (used for nvm and Windows Python folders); [] when missing.
  listDir: (dir: string) => string[]
}

function pathFor(platform: Platform): path.PlatformPath {
  return platform === 'win32' ? path.win32 : path.posix
}

function delimiterFor(platform: Platform): string {
  return platform === 'win32' ? ';' : ':'
}

// Windows env names are case-insensitive (PATH is often "Path"); read them that way.
export function envGet(env: NodeJS.ProcessEnv, name: string, platform: Platform = process.platform): string | undefined {
  if (platform !== 'win32') return env[name]
  const key = Object.keys(env).find((k) => k.toUpperCase() === name.toUpperCase())
  return key ? env[key] : undefined
}

function defaultIsExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (process.platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function defaultListDir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

export function defaultContext(): ToolContext {
  return {
    platform: process.platform,
    env: process.env,
    home: (process.platform === 'win32' && process.env.USERPROFILE) || homedir(),
    isExecutable: defaultIsExecutable,
    listDir: defaultListDir
  }
}

export function rokitBin(ctx: ToolContext = defaultContext()): string {
  const home = (ctx.platform === 'win32' && envGet(ctx.env, 'USERPROFILE', ctx.platform)) || ctx.home
  return pathFor(ctx.platform).join(home, '.rokit', 'bin')
}

// Compares "v20.11.1"-style folder names, newest first.
function compareVersionsDesc(a: string, b: string): number {
  const parse = (v: string) => v.replace(/^v/, '').split('.').map((n) => parseInt(n, 10) || 0)
  const [x, y] = [parse(a), parse(b)]
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const diff = (y[i] ?? 0) - (x[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

// Folders where Roblox/dev tools usually live but which a GUI-launched app's PATH lacks. Apps
// started from Finder get only /usr/bin:/bin:/usr/sbin:/sbin; a Windows shortcut gets the saved
// user+system PATH, which can miss a rokit install made after login.
export function extraToolDirs(ctx: ToolContext): string[] {
  const p = pathFor(ctx.platform)
  const home = ctx.home
  const dirs = [rokitBin(ctx), p.join(home, '.aftman', 'bin'), p.join(home, '.foreman', 'bin'), p.join(home, '.cargo', 'bin')]
  if (ctx.platform === 'win32') {
    const local = envGet(ctx.env, 'LOCALAPPDATA', ctx.platform) || p.join(home, 'AppData', 'Local')
    const programFiles = envGet(ctx.env, 'ProgramFiles', ctx.platform) || 'C:\\Program Files'
    dirs.push(p.join(programFiles, 'Git', 'cmd'))
    // python.org installs per user under Programs\Python\Python3xx (newest first).
    const pythonRoot = p.join(local, 'Programs', 'Python')
    for (const name of ctx.listDir(pythonRoot).filter((n) => /^Python3\d*/i.test(n)).sort().reverse()) {
      dirs.push(p.join(pythonRoot, name))
    }
    return dirs
  }
  dirs.push(p.join(home, '.local', 'bin'))
  if (ctx.platform === 'darwin') dirs.push('/opt/homebrew/bin', '/opt/homebrew/sbin')
  dirs.push('/usr/local/bin')
  // nvm: the active version when the shell exported it, else the newest installed one.
  const nvmBin = ctx.env.NVM_BIN
  if (nvmBin) dirs.push(nvmBin)
  else {
    const versions = p.join(ctx.env.NVM_DIR || p.join(home, '.nvm'), 'versions', 'node')
    const newest = ctx.listDir(versions).filter((n) => /^v\d/.test(n)).sort(compareVersionsDesc)[0]
    if (newest) dirs.push(p.join(versions, newest, 'bin'))
  }
  dirs.push('/usr/bin', '/bin', '/usr/sbin', '/sbin')
  return dirs
}

// PATH for tools: rokit first (the project's pinned versions win), then the current PATH, then the
// login shell's PATH (macOS, see loadLoginShellPath), then the usual install folders. No duplicates.
export function buildToolPath(ctx: ToolContext, loginPath: string | null = null): string {
  const delimiter = delimiterFor(ctx.platform)
  const split = (value: string | null | undefined) => (value || '').split(delimiter).map((d) => d.trim()).filter(Boolean)
  const [rokit, ...rest] = extraToolDirs(ctx)
  const ordered = [rokit, ...split(envGet(ctx.env, 'PATH', ctx.platform)), ...split(loginPath), ...rest]
  const seen = new Set<string>()
  const out: string[] = []
  for (const dir of ordered) {
    const key = ctx.platform === 'win32' ? dir.toLowerCase().replace(/[\\/]+$/, '') : dir.replace(/\/+$/, '')
    if (seen.has(key)) continue
    seen.add(key)
    out.push(dir)
  }
  return out.join(delimiter)
}

let loginShellPath: string | null = null

// GUI apps on macOS do not inherit the login shell's PATH (~/.zprofile, Homebrew's shellenv, nvm).
// Reads it once with `$SHELL -ilc` (3 s timeout) so tools installed there are found. No-op elsewhere
// and when started from a terminal (PATH already has more than the launchd default).
export async function loadLoginShellPath(timeoutMs = 3000): Promise<string | null> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') return null
  const shell = process.env.SHELL || (process.platform === 'darwin' ? '/bin/zsh' : '/bin/bash')
  const marker = '__RBX_FORGE_PATH__'
  const result = await new Promise<string | null>((resolve) => {
    execFile(
      shell,
      ['-ilc', `printf '%s' "${marker}$PATH${marker}"`],
      { timeout: timeoutMs, env: { ...process.env, TERM: 'dumb' }, encoding: 'utf8' },
      (_error, stdout) => {
        const match = new RegExp(`${marker}(.*?)${marker}`, 's').exec(String(stdout || ''))
        resolve(match ? match[1].trim() : null)
      }
    )
  })
  if (result) loginShellPath = result
  return result
}

export function setLoginShellPath(value: string | null): void {
  loginShellPath = value
}

// Environment for spawned tools: the extended PATH, no colour codes.
export function toolEnv(ctx: ToolContext = defaultContext()): NodeJS.ProcessEnv {
  const value = buildToolPath(ctx, loginShellPath)
  const env: NodeJS.ProcessEnv = { ...ctx.env, NO_COLOR: '1' }
  if (ctx.platform === 'win32') {
    // Keep a single PATH key; a second differently-cased copy confuses child processes.
    for (const key of Object.keys(env)) if (key.toUpperCase() === 'PATH') delete env[key]
    env.Path = value
  } else {
    env.PATH = value
  }
  return env
}

// Windows executable extensions in PATHEXT order (.COM;.EXE;.BAT;.CMD by default), lower-cased.
export function pathExts(ctx: ToolContext): string[] {
  if (ctx.platform !== 'win32') return ['']
  const raw = envGet(ctx.env, 'PATHEXT', ctx.platform) || '.COM;.EXE;.BAT;.CMD'
  return raw.split(';').map((e) => e.trim().toLowerCase()).filter(Boolean)
}

export interface FindOptions {
  // Skip directories matching this (e.g. the Microsoft Store python.exe stubs).
  skipDir?: (dir: string) => boolean
}

// Finds a binary on the tool PATH. Returns its full path, or null when missing.
export function findTool(name: string, ctx: ToolContext = defaultContext(), options: FindOptions = {}): string | null {
  const p = pathFor(ctx.platform)
  const delimiter = delimiterFor(ctx.platform)
  const dirs = buildToolPath(ctx, loginShellPath).split(delimiter).filter(Boolean)
  const exts = pathExts(ctx)
  // A name that already has an executable extension is looked up as is.
  const hasExt = ctx.platform === 'win32' && exts.includes(p.extname(name).toLowerCase())
  for (const dir of dirs) {
    if (options.skipDir?.(dir)) continue
    for (const ext of hasExt ? [''] : exts) {
      const candidate = p.join(dir, name + ext)
      if (ctx.isExecutable(candidate)) return candidate
    }
  }
  return null
}

export interface Command {
  file: string
  args: string[]
}

// Windows' "App execution alias" python.exe in WindowsApps opens the Microsoft Store instead of Python.
function isWindowsAppsDir(dir: string): boolean {
  return /[\\/]Microsoft[\\/]WindowsApps[\\/]?$/i.test(dir)
}

// Python 3: the `py -3` launcher on Windows (python.org installs it; it is never the Store stub),
// then python / python3; python3 then python elsewhere.
export function findPythonCommand(ctx: ToolContext = defaultContext()): Command | null {
  if (ctx.platform === 'win32') {
    const skip = { skipDir: isWindowsAppsDir }
    const py = findTool('py', ctx, skip)
    if (py) return { file: py, args: ['-3'] }
    const python = findTool('python', ctx, skip) || findTool('python3', ctx, skip)
    return python ? { file: python, args: [] } : null
  }
  const python = findTool('python3', ctx) || findTool('python', ctx)
  return python ? { file: python, args: [] } : null
}

// The PowerShell to run tools/dev.ps1 with: PowerShell 7 (pwsh) if installed, else Windows PowerShell.
export function findPowerShell(ctx: ToolContext = defaultContext()): string {
  const found = findTool('pwsh', ctx) || findTool('powershell', ctx)
  if (found) return found
  const root = envGet(ctx.env, 'SystemRoot', ctx.platform) || 'C:\\Windows'
  return path.win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')
}

// bash for the template's ./dev. On Windows only Git for Windows' bash qualifies: System32\bash.exe
// is the WSL launcher, which would run the script inside Linux against a different filesystem.
export function findBash(ctx: ToolContext = defaultContext()): string | null {
  if (ctx.platform !== 'win32') return findTool('bash', ctx) || (ctx.isExecutable('/bin/bash') ? '/bin/bash' : null)
  const p = path.win32
  const programFiles = envGet(ctx.env, 'ProgramFiles', ctx.platform) || 'C:\\Program Files'
  const local = envGet(ctx.env, 'LOCALAPPDATA', ctx.platform) || p.join(ctx.home, 'AppData', 'Local')
  for (const candidate of [p.join(programFiles, 'Git', 'bin', 'bash.exe'), p.join(local, 'Programs', 'Git', 'bin', 'bash.exe')]) {
    if (ctx.isExecutable(candidate)) return candidate
  }
  const git = findTool('git', ctx)
  if (git) {
    // <Git>\cmd\git.exe -> <Git>\bin\bash.exe
    const candidate = p.join(p.dirname(p.dirname(git)), 'bin', 'bash.exe')
    if (ctx.isExecutable(candidate)) return candidate
  }
  return null
}

// cmd.exe quoting (the approach cross-spawn uses): quote each argument, escape quotes and
// backslashes before them, then caret-escape cmd metacharacters so nothing is interpreted.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g

export function quoteCmdArg(arg: string): string {
  let out = arg.replace(/(\\*)"/g, '$1$1\\"')
  out = out.replace(/(\\*)$/, '$1$1')
  return `"${out}"`.replace(CMD_META, '^$1')
}

export interface SpawnPlan {
  file: string
  args: string[]
  windowsVerbatimArguments?: boolean
}

// How to spawn `file args` without a shell. Windows refuses to spawn .cmd/.bat directly (Node's
// CVE-2024-27980 fix), so those go through cmd.exe /d /s /c with every argument escaped.
export function planSpawn(file: string, args: string[], platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env): SpawnPlan {
  if (platform !== 'win32' || !/\.(cmd|bat)$/i.test(file)) return { file, args }
  const comspec = envGet(env, 'ComSpec', platform) || 'cmd.exe'
  const line = [file, ...args].map(quoteCmdArg).join(' ')
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`], windowsVerbatimArguments: true }
}

// spawn() with planSpawn applied and windows hidden.
export function spawnTool(file: string, args: string[], options: SpawnOptions): ChildProcess {
  const plan = planSpawn(file, args, process.platform, options.env || process.env)
  return spawn(plan.file, plan.args, {
    windowsHide: true,
    ...options,
    ...(plan.windowsVerbatimArguments ? { windowsVerbatimArguments: true } : {})
  })
}

// Splits command output into lines, accepting CRLF from Windows tools.
export function outputLines(text: string): string[] {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
}

// Repo-relative path with forward slashes, as Rojo, git and the UI use on every OS.
export function toRepoPath(value: string): string {
  return value.replace(/\\/g, '/').replace(/^\.\//, '')
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// Runs a command to completion without a shell. Never rejects; check code.
export function run(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  const plan = planSpawn(file, args)
  return new Promise((resolve) => {
    execFile(
      plan.file,
      plan.args,
      {
        cwd,
        env: env || toolEnv(),
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        windowsVerbatimArguments: plan.windowsVerbatimArguments
      },
      (error, stdout, stderr) => {
        let code = 0
        if (error) code = typeof error.code === 'number' ? error.code : 1
        if (error && !stderr) stderr = error.message
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}
