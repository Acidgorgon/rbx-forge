// The rojo processes Forge started, kept on disk (userData/serve-pids.json) so a later Forge run can
// tell its own leftovers from a rojo the user started: a force close, a crash or a Windows end-task
// leaves the old `rojo serve` listening and orphaned, and nothing in memory remembers it. Entries are
// removed when their process exits, on a normal stop and on quit. No electron imports.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

export interface ServeEntry {
  pid: number
  kind: 'serve' | 'sourcemap'
  // Supervisor proc key ("rojo", "rojo:menu.project.json", "sourcemap:menu.project.json").
  key: string
  // The place file and project folder it was started for.
  place: string
  root: string
  // The port a serve was started on.
  port?: number
  // One Forge run (a Supervisor). Entries of another session are leftovers.
  session: string
  startedAt: number
  // The listening process behind a launcher (a rokit shim): the pid of the child Forge started.
  via?: number
}

export class ServeRecords {
  private file: string

  constructor(file: string) {
    this.file = file
  }

  read(): ServeEntry[] {
    try {
      const data = JSON.parse(readFileSync(this.file, 'utf8')) as { entries?: unknown }
      if (!Array.isArray(data.entries)) return []
      return data.entries.filter(
        (e): e is ServeEntry => !!e && typeof e === 'object' && Number.isInteger((e as ServeEntry).pid) && (e as ServeEntry).pid > 0 && typeof (e as ServeEntry).session === 'string'
      )
    } catch {
      return []
    }
  }

  // Never throws: a record that cannot be written costs the next-run cleanup, not the serve.
  write(entries: ServeEntry[]): void {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify({ version: 1, entries }, null, 2))
      renameSync(tmp, this.file)
    } catch {
      // read-only userData: nothing to clean up after a crash then
    }
  }

  update(change: (entries: ServeEntry[]) => ServeEntry[]): void {
    this.write(change(this.read()))
  }

  add(entry: ServeEntry): void {
    this.update((entries) => [...entries.filter((e) => e.pid !== entry.pid), entry])
  }

  remove(pids: Iterable<number>): void {
    const gone = new Set(pids)
    if (!gone.size) return
    this.update((entries) => entries.filter((e) => !gone.has(e.pid)))
  }
}

// `--port N` of a `rojo serve` command line; rojo's own default when absent; null for other commands.
export function servePortOf(args: string[]): number | null {
  if (args[0] !== 'serve') return null
  const at = args.indexOf('--port')
  const port = at >= 0 ? Number(args[at + 1]) : 34872
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}
