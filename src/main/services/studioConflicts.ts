import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { StudioConflict } from '@shared/types'
import { findPythonCommand, run, toRepoPath, type Command } from './tools.ts'

// The folder is almost always empty; a slow poll keeps the idle cost down.
export const CONFLICTS_POLL_MS = 10_000

// Studio versions held back by tools/studio-sync.py live in .studio-sync/conflicts,
// named after the repo path with "/" replaced by "__".
export class StudioConflicts {
  readonly root: string
  private timer: ReturnType<typeof setInterval> | null = null
  private signature = ''
  private python: () => Command | null

  constructor(root: string, python: () => Command | null = () => findPythonCommand()) {
    this.root = root
    this.python = python
  }

  private dir(): string {
    return join(this.root, '.studio-sync', 'conflicts')
  }

  async list(): Promise<StudioConflict[]> {
    let names: string[]
    try {
      names = (await readdir(this.dir())).sort()
    } catch {
      return []
    }
    const out: StudioConflict[] = []
    for (const name of names) {
      const path = name.replace(/__/g, '/')
      const studioSource = await readFile(join(this.dir(), name), 'utf8').catch(() => null)
      if (studioSource === null) continue
      const repoSource = await readFile(join(this.root, path), 'utf8').catch(() => '')
      out.push({ path, repoSource, studioSource })
    }
    return out
  }

  // Goes through studio-sync.py so its state.json stays consistent.
  async resolve(path: string, take: 'studio' | 'repo'): Promise<void> {
    path = toRepoPath(path)
    const held = (await this.list()).map((conflict) => conflict.path)
    if (!held.includes(path)) throw new Error(`No held Studio version for ${path}`)
    const python = this.python()
    if (!python) throw new Error('Python 3 not found; it is needed to resolve Studio conflicts')
    const result = await run(
      python.file,
      [...python.args, 'tools/studio-sync.py', take === 'studio' ? 'take-studio' : 'take-disk', path],
      this.root
    )
    if (result.code !== 0) throw new Error(result.stderr.trim() || `studio-sync.py exited ${result.code}`)
  }

  // Polls the folder (it may not exist yet) and calls onChange when the held files change.
  watch(onChange: (conflicts: StudioConflict[]) => void, intervalMs = CONFLICTS_POLL_MS): void {
    const check = async () => {
      const signature = await this.currentSignature()
      if (signature === this.signature) return
      this.signature = signature
      onChange(await this.list())
    }
    this.timer = setInterval(() => void check(), intervalMs)
    void check()
  }

  private async currentSignature(): Promise<string> {
    try {
      const names = (await readdir(this.dir())).sort()
      const parts: string[] = []
      for (const name of names) {
        const info = await stat(join(this.dir(), name)).catch(() => null)
        parts.push(`${name}:${info?.mtimeMs ?? 0}:${info?.size ?? 0}`)
      }
      return parts.join('|')
    } catch {
      return ''
    }
  }

  close(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }
}
