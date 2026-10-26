// Who listens on a local TCP port, for "port 34875 is in use by another process (old rojo?)": Forge
// Doctor offers "Stop stray rojo" only when that process is a rojo and no rojo serve of Forge's own is
// up on the port. Parsers are pure (tested in test/rojoServe.test.ts); no electron imports.
import { execFile } from 'node:child_process'
import { join } from 'node:path'

export interface PortOwner {
  pid: number
  // Image / command name ("rojo.exe", "rojo"), '' when unknown.
  name: string
}

// `netstat -ano -p TCP` (Windows): the pids LISTENING on the port.
export function parseNetstat(out: string, port: number): number[] {
  const pids = new Set<number>()
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/)
    if (cols.length < 5 || !/^TCP/i.test(cols[0]) || !/^LISTEN/i.test(cols[3])) continue
    if (!new RegExp(`[:.]${port}$`).test(cols[1])) continue
    const pid = Number(cols[4])
    if (pid > 0) pids.add(pid)
  }
  return [...pids]
}

// `tasklist /FI "PID eq N" /FO CSV /NH` (Windows): the image name, or '' ("INFO: No tasks ...").
export function parseTasklist(out: string): string {
  const m = /^"([^"]+)","(\d+)"/m.exec(out.trim())
  return m ? m[1] : ''
}

// `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc` (macOS / Linux): "p<pid>" then "c<command>" per process.
export function parseLsof(out: string): PortOwner[] {
  const owners: PortOwner[] = []
  for (const line of out.split(/\r?\n/)) {
    if (line.startsWith('p')) owners.push({ pid: Number(line.slice(1)), name: '' })
    else if (line.startsWith('c') && owners.length) owners[owners.length - 1].name = line.slice(1)
  }
  return owners.filter((o) => o.pid > 0)
}

export function isRojoProcess(name: string): boolean {
  return /^rojo(\.exe)?$/i.test(name.trim())
}

function exec(file: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    execFile(file, args, { windowsHide: true, timeout: 5000 }, (_error, stdout) => resolve(String(stdout ?? '')))
  })
}

const system32 = (exe: string): string => join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', exe)

export async function portOwners(port: number, platform: NodeJS.Platform = process.platform): Promise<PortOwner[]> {
  if (platform === 'win32') {
    const pids = parseNetstat(await exec(system32('netstat.exe'), ['-ano', '-p', 'TCP']), port)
    const out: PortOwner[] = []
    for (const pid of pids) out.push({ pid, name: parseTasklist(await exec(system32('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'])) })
    return out
  }
  return parseLsof(await exec('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-Fpc']))
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, we just may not signal it.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

async function exited(pid: number, ms: number): Promise<boolean> {
  const end = Date.now() + ms
  while (isAlive(pid)) {
    if (Date.now() > end) return false
    await sleep(50)
  }
  return true
}

// The image / command name of a live process ("rojo.exe", "rojo"), '' when it is gone or unknown.
// mac / Linux: `ps -p <pid> -o comm=` (mac prints the full path, Linux the 15-char command name).
export async function processName(pid: number, platform: NodeJS.Platform = process.platform): Promise<string> {
  if (!(pid > 0)) return ''
  if (platform === 'win32') return parseTasklist(await exec(system32('tasklist.exe'), ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH']))
  const out = (await exec('ps', ['-p', String(pid), '-o', 'comm='])).trim().split(/\r?\n/)[0] ?? ''
  return out.replace(/^.*[\\/]/, '')
}

// Stops one process (not its tree: a stray rojo has no children worth keeping). Resolves once it
// is gone (SIGKILL after a grace period), so a serve started right after finds the port free.
export async function stopProcess(pid: number, platform: NodeJS.Platform = process.platform, graceMs = 3000): Promise<void> {
  if (platform === 'win32') {
    await exec(system32('taskkill.exe'), ['/pid', String(pid), '/F'])
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return // already gone
  }
  if (await exited(pid, graceMs)) return
  try {
    process.kill(pid, 'SIGKILL')
  } catch {
    // already gone
  }
  await exited(pid, 1000)
}

// Stops a process and everything it started, for a rojo a previous Forge run left behind: taskkill /T
// on Windows, the process group on mac / Linux (Forge starts its serves as group leaders; the pid
// alone when it is not one). Resolves once the process is gone.
export async function killProcessTree(pid: number, platform: NodeJS.Platform = process.platform, graceMs = 3000): Promise<void> {
  if (platform === 'win32') {
    await exec(system32('taskkill.exe'), ['/pid', String(pid), '/T', '/F'])
    return
  }
  const signal = (sig: NodeJS.Signals) => {
    try {
      process.kill(-pid, sig)
    } catch {
      try {
        process.kill(pid, sig)
      } catch {
        // already gone
      }
    }
  }
  signal('SIGTERM')
  if (await exited(pid, graceMs)) return
  signal('SIGKILL')
  await exited(pid, 1000)
}

// The process lookups the supervisor needs, replaceable in tests.
export interface ProcessTools {
  portOwners(port: number): Promise<PortOwner[]>
  processName(pid: number): Promise<string>
  isAlive(pid: number): boolean
  killTree(pid: number): Promise<void>
}

export const systemProcessTools: ProcessTools = {
  portOwners: (port) => portOwners(port),
  processName: (pid) => processName(pid),
  isAlive,
  killTree: (pid) => killProcessTree(pid)
}
