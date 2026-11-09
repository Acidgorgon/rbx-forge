// Editor text on its way to the store. Dispatching the whole file text per keystroke re-rendered
// everything that reads `state.files`, so the store takes an editor's text at once only when it
// changes the file's dirty state (or pins its preview tab), else `ms` after typing pauses, or when
// flushed (before anything that reads or replaces the text). Dirty flags (`current !== saved`) are
// therefore always right while `current` may trail the editor by up to `ms`. Pending text exists
// only while a file is dirty. Pure, no DOM (tested in test/pendingEdits.test.ts).

export interface EditBuffer {
  current: string
  saved: string
}

export interface PendingEditsHost {
  // The open buffer of a path (undefined when none).
  buffer(path: string): EditBuffer | undefined
  // The file's tab is a preview tab (the first edit pins it).
  isPreview(path: string): boolean
  // Puts the text into the store (one fileEdit).
  apply(path: string, contents: string): void
}

export function createPendingEdits(host: PendingEditsHost, ms: number) {
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const flush = () => {
    clearTimeout(timer)
    timer = undefined
    if (!pending.size) return
    const edits = [...pending]
    pending.clear()
    for (const [path, contents] of edits) host.apply(path, contents)
  }
  return {
    edit(path: string, contents: string): void {
      const f = host.buffer(path)
      const wasDirty = !!f && f.current !== f.saved
      const dirty = !f || contents !== f.saved
      if (!f || wasDirty !== dirty || host.isPreview(path)) {
        pending.delete(path)
        host.apply(path, contents)
        return
      }
      // Clean before and after: the store already holds this text.
      if (!dirty) {
        pending.delete(path)
        return
      }
      pending.set(path, contents)
      clearTimeout(timer)
      timer = setTimeout(flush, ms)
    },
    flush,
    get size(): number {
      return pending.size
    }
  }
}
