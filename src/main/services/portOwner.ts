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

// Stops one process (not its tree: a stray rojo has no children worth keeping).
export function stopProcess(pid: number, platform: NodeJS.Platform = process.platform): Promise<void> {
  if (platform === 'win32') return exec(system32('taskkill.exe'), ['/pid', String(pid), '/F']).then(() => undefined)
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    // already gone
  }
  return Promise.resolve()
}
