import { readFile, stat } from 'node:fs/promises'

// Parsed JSON files keyed by path, reused while the file's mtime and size are unchanged. rojo's
// sourcemap.json runs to several MB in a project with Wally packages and the project refreshes on
// every watcher event, so re-parsing it each time is the main cost of an idle refresh.
// The returned value is shared: callers must not mutate it.
export class MtimeJsonCache {
  private entries = new Map<string, { mtimeMs: number; size: number; value: unknown }>()

  // The parsed file, or null when it is missing or not valid JSON (a half-written file is not cached).
  async read<T>(file: string): Promise<T | null> {
    let info
    try {
      info = await stat(file)
    } catch {
      this.entries.delete(file)
      return null
    }
    const hit = this.entries.get(file)
    if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.value as T
    try {
      const value = JSON.parse(await readFile(file, 'utf8')) as T
      this.entries.set(file, { mtimeMs: info.mtimeMs, size: info.size, value })
      return value
    } catch {
      this.entries.delete(file)
      return null
    }
  }

  clear(): void {
    this.entries.clear()
  }
}
