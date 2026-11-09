import { mkdirSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export interface CoalescedWriterOptions {
  // How long a burst of changes waits before one write (ms).
  delayMs?: number
  // Reports a write that failed; the data stays dirty and goes out with the next write or flushSync.
  onError?: (error: unknown) => void
}

let tempSeq = 0

// Writes `serialize()` to `file` at most once per `delayMs`, off the main thread's critical path:
// fs.promises writeFile to a unique temp file, then rename over the target (atomic on one volume).
// Writes are chained, so two never interleave, and each one serializes the newest data when it
// starts. flushSync() writes synchronously (app quit, process exit) and makes any write still in
// flight drop its older snapshot instead of renaming it over the newer file.
export class CoalescedJsonWriter {
  private readonly file: string
  private readonly serialize: () => string
  private readonly delayMs: number
  private readonly onError?: (error: unknown) => void
  private timer: ReturnType<typeof setTimeout> | null = null
  private dirty = false
  private chain: Promise<void> = Promise.resolve()
  // Bumped by flushSync: async writes started before it must not land after it.
  private generation = 0
  private inflight = new Set<string>()

  constructor(file: string, serialize: () => string, opts: CoalescedWriterOptions = {}) {
    this.file = file
    this.serialize = serialize
    this.delayMs = opts.delayMs ?? 250
    this.onError = opts.onError
  }

  // Marks the data changed; one write follows after the delay however many changes arrive.
  schedule(): void {
    this.dirty = true
    if (this.timer) return
    this.timer = setTimeout(() => {
      this.timer = null
      void this.writeNow()
    }, this.delayMs)
    ;(this.timer as { unref?: () => void }).unref?.()
  }

  // Writes now (asynchronously) if anything changed; resolves when every queued write has finished.
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    return this.writeNow()
  }

  // Synchronous write of the newest data (quit / exit), when anything is unsaved or still in flight.
  flushSync(): void {
    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }
    if (!this.dirty && this.inflight.size === 0) return
    this.generation++
    // A rename already handed to the thread pool would put an older snapshot over this write: take
    // its temp file away first (its rename then fails with ENOENT, which the async path ignores).
    for (const temp of this.inflight) {
      try {
        unlinkSync(temp)
      } catch {
        // Already renamed or never created.
      }
    }
    this.inflight.clear()
    this.dirty = false
    try {
      writeAtomicSync(this.file, this.serialize())
    } catch (error) {
      this.dirty = true
      this.onError?.(error)
    }
  }

  pending(): boolean {
    return this.dirty || this.timer !== null || this.inflight.size > 0
  }

  private writeNow(): Promise<void> {
    if (!this.dirty) return this.chain
    this.chain = this.chain.then(() => this.writeOnce())
    return this.chain
  }

  private async writeOnce(): Promise<void> {
    if (!this.dirty) return
    this.dirty = false
    const generation = this.generation
    const temp = `${this.file}.${process.pid}.${++tempSeq}.tmp`
    let text: string
    try {
      text = this.serialize()
    } catch (error) {
      this.onError?.(error)
      return
    }
    this.inflight.add(temp)
    try {
      await mkdir(dirname(this.file), { recursive: true })
      await writeFile(temp, text)
      if (generation !== this.generation) return
      try {
        await rename(temp, this.file)
      } catch (error) {
        if (generation !== this.generation || (error as NodeJS.ErrnoException)?.code === 'ENOENT') return
        // Windows can refuse to replace a file another process (antivirus, indexer) holds open.
        await writeFile(this.file, text)
      }
    } catch (error) {
      if (generation === this.generation) {
        this.dirty = true
        this.onError?.(error)
      }
    } finally {
      this.inflight.delete(temp)
      await rm(temp, { force: true }).catch(() => undefined)
    }
  }
}

// Temp file + rename, falling back to a direct write where the rename is refused (Windows).
export function writeAtomicSync(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.${++tempSeq}.tmp`
  writeFileSync(temp, text)
  try {
    renameSync(temp, file)
  } catch {
    writeFileSync(file, text)
    rmSync(temp, { force: true })
  }
}
