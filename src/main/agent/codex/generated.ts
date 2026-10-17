// Images Codex's built-in image_gen tool saves during a run. No electron imports.
//
// Where they go (codex-rs/ext/image-generation/src/artifact.rs and tool.rs, Oct 2026): the tool
// writes $CODEX_HOME/generated_images/<thread id>/<call id>.png itself, outside the command sandbox
// (so the read-only sandbox does not stop it). Without a save root (remote executors) it writes
// <cwd>/generated_images/<call id>.png instead. `codex exec --json` maps no image item
// (event_processor_with_jsonl_output.rs drops ImageGeneration), so a run's images are found by
// watching those folders: files that were not there when the run started.
//
// Only image files (.png/.jpg/.webp) in those folders are listed, never anything else in
// $CODEX_HOME, and symlinks are skipped.

import { lstat, open, readdir } from 'node:fs/promises'
import { join } from 'node:path'

export const IMAGE_FILE = /\.(png|jpe?g|webp)$/i
const THREAD_ID = /^[\w-]+$/

// Image files in a folder (one level), oldest first. Missing folder = [].
export async function imagesIn(dir: string, skip: (name: string) => boolean = () => false): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[])
  const files: { path: string; at: number }[] = []
  for (const name of names) {
    if (!IMAGE_FILE.test(name) || skip(name)) continue
    const p = join(dir, name)
    const s = await lstat(p).catch(() => null)
    if (s?.isFile()) files.push({ path: p, at: s.mtimeMs })
  }
  return files.sort((a, b) => a.at - b.at || a.path.localeCompare(b.path)).map((f) => f.path)
}

// The file ends the way a finished image does (PNG IEND chunk, JPEG EOI marker, RIFF size).
export async function complete(path: string, size: number): Promise<boolean> {
  if (size < 16) return false
  const f = await open(path, 'r').catch(() => null)
  if (!f) return false
  try {
    const head = Buffer.alloc(12)
    const tail = Buffer.alloc(12)
    await f.read(head, 0, 12, 0)
    await f.read(tail, 0, 12, size - 12)
    if (head[0] === 0x89 && head.subarray(1, 4).toString('latin1') === 'PNG') return tail.subarray(4, 8).toString('latin1') === 'IEND'
    if (head[0] === 0xff && head[1] === 0xd8) return tail[10] === 0xff && tail[11] === 0xd9
    if (head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return head.readUInt32LE(4) + 8 <= size
    return false
  } finally {
    await f.close().catch(() => undefined)
  }
}

// The folders a run's images can land in.
export function generatedDirs(home: string, threadId: string | null | undefined, cwd?: string): string[] {
  const dirs: string[] = []
  if (threadId && THREAD_ID.test(threadId)) dirs.push(join(home, 'generated_images', threadId))
  if (cwd) dirs.push(join(cwd, 'generated_images'))
  return dirs
}

// New images of one run, in the order they appear. prime() records what a resumed thread already
// had; scan() returns each new file once.
export class GeneratedImageWatch {
  private seen = new Set<string>()
  private home: string
  private cwd: string | undefined
  // Files older than this (minus a little clock slack) belong to an earlier run.
  private since: number

  constructor(o: { home: string; cwd?: string; since?: number }) {
    this.home = o.home
    this.cwd = o.cwd
    this.since = (o.since ?? Date.now()) - 2000
  }

  async prime(threadId?: string | null): Promise<void> {
    for (const dir of generatedDirs(this.home, threadId, this.cwd)) for (const p of await imagesIn(dir)) this.seen.add(p)
  }

  async scan(threadId: string | null | undefined): Promise<string[]> {
    const out: string[] = []
    for (const dir of generatedDirs(this.home, threadId, this.cwd)) {
      for (const p of await imagesIn(dir)) {
        if (this.seen.has(p)) continue
        const s = await lstat(p).catch(() => null)
        if (!s?.isFile() || s.mtimeMs < this.since) {
          this.seen.add(p)
          continue
        }
        // A file still being written is picked up on the next scan.
        if (!(await complete(p, s.size))) continue
        this.seen.add(p)
        out.push(p)
      }
    }
    return out
  }
}
