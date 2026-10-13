import { execFile } from 'node:child_process'
import { accessSync, constants, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, join } from 'node:path'

const isWindows = process.platform === 'win32'

export function rokitBin(): string {
  const home = isWindows ? process.env.USERPROFILE || homedir() : homedir()
  return join(home, '.rokit', 'bin')
}

// Apps started from Finder or a desktop shortcut get a short PATH, so add the usual tool folders.
export function toolEnv(): NodeJS.ProcessEnv {
  const extra = [rokitBin()]
  if (!isWindows) extra.push('/opt/homebrew/bin', '/usr/local/bin')
  const current = (process.env.PATH || process.env.Path || '').split(delimiter).filter(Boolean)
  const path = [...extra.filter((dir) => !current.includes(dir)), ...current].join(delimiter)
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: path, NO_COLOR: '1' }
  if (isWindows) env.Path = path
  return env
}

function isExecutable(file: string): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (!isWindows) accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

// Finds a binary on PATH (plus the rokit bin folder). Returns null when missing.
export function findTool(name: string): string | null {
  const env = toolEnv()
  const dirs = (env.PATH || '').split(delimiter).filter(Boolean)
  const exts = isWindows ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';') : ['']
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, name + ext.toLowerCase())
      if (isExecutable(candidate)) return candidate
    }
  }
  return null
}

export function findPython(): string | null {
  return isWindows ? findTool('python') || findTool('py') : findTool('python3') || findTool('python')
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

// Runs a command to completion without a shell. Never rejects; check code.
export function run(file: string, args: string[], cwd: string, env?: NodeJS.ProcessEnv): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { cwd, env: env || toolEnv(), maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      (error, stdout, stderr) => {
        let code = 0
        if (error) code = typeof error.code === 'number' ? error.code : 1
        if (error && !stderr) stderr = error.message
        resolve({ code, stdout: String(stdout), stderr: String(stderr) })
      }
    )
  })
}
