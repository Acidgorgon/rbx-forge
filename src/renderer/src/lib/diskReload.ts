// Open editor tabs vs. the file on disk: when another writer changes an open file (Forge Sync pulling
// a Studio edit, the agent, git), a clean tab takes the disk text; a tab with unsaved edits keeps them
// and the user is told. Pure, no DOM (tested in test/diskReload.test.ts).

export interface OpenBuffer {
  path: string
  saved: string
  current: string
  loading?: boolean
}

export type DiskReload = 'reload' | 'keep-edits' | 'none'

export function diskReloadAction(buf: OpenBuffer | undefined, disk: string): DiskReload {
  if (!buf || buf.loading || disk === buf.saved) return 'none'
  return buf.current === buf.saved ? 'reload' : 'keep-edits'
}

// Open buffers named in a change list (watcher paths may use backslashes on Windows).
export function openPathsIn(buffers: OpenBuffer[], changed: string[]): string[] {
  const set = new Set(changed.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '')))
  return buffers.filter((b) => !b.loading && set.has(b.path.replace(/\\/g, '/'))).map((b) => b.path)
}
