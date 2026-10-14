// File checkpoints for /rewind. Before each turn that may edit, the project's working tree is
// snapshotted into a shadow git repository at .forge/checkpoints/shadow.git (its own git dir and
// index, with the project as work tree), like `git stash create` but outside the user's repository:
// the project's .git, its refs, index and history are never read or written. .gitignore rules of
// the project still apply, so ignored files (Packages/, build output) are left alone.
// Restoring first snapshots the current state (so a rewind can itself be undone), then makes the
// work tree match the checkpoint: changed files are restored and files added since are removed.
// No Electron imports (tested on a temp git repo).

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, writeFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

export const CHECKPOINT_DIR = '.forge/checkpoints'

// Never snapshotted (nor removed by a rewind), even when the project's .gitignore misses them:
// Wally packages (a rewind must not delete packages installed since), node_modules, and Roblox
// place files (large binaries Studio rewrites on every save; the agent never edits them).
export const SHADOW_EXCLUDES = [`/${CHECKPOINT_DIR}/`, '.git/', '/Packages/', '/DevPackages/', '/ServerPackages/', 'node_modules/', '*.rbxl', '*.rbxlx', '*.rbxl.lock', '*.rbxlx.lock']

// One git operation at a time per shadow repo (two chats on one project share its index).
const queues = new Map<string, Promise<unknown>>()

export interface GitRunner {
  (args: string[], opts: { cwd: string; env: Record<string, string> }): Promise<string>
}

export const execGit: GitRunner = (args, opts) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, maxBuffer: 64 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message).trim()))
      else resolve(String(stdout))
    })
  })

export class Checkpoints {
  private root: string
  private git: GitRunner
  private ready: Promise<void> | null = null

  constructor(root: string, git: GitRunner = execGit) {
    this.root = root
    this.git = git
  }

  get gitDir(): string {
    return join(this.root, ...CHECKPOINT_DIR.split('/'), 'shadow.git')
  }

  // Environment that points every git command at the shadow repo; nothing reads the user's config
  // for hooks or the user's .git directory.
  private env(): Record<string, string> {
    return {
      GIT_DIR: this.gitDir,
      GIT_WORK_TREE: this.root,
      GIT_INDEX_FILE: join(this.gitDir, 'index'),
      GIT_AUTHOR_NAME: 'Forge',
      GIT_AUTHOR_EMAIL: 'forge@localhost',
      GIT_COMMITTER_NAME: 'Forge',
      GIT_COMMITTER_EMAIL: 'forge@localhost',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_TERMINAL_PROMPT: '0'
    }
  }

  private run(args: string[]): Promise<string> {
    return this.git(['-c', 'core.autocrlf=false', '-c', 'core.quotepath=false', '-c', 'gc.auto=0', ...args], { cwd: this.root, env: this.env() })
  }

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const key = this.gitDir
    const next = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(fn)
    const tail = next.catch(() => undefined)
    queues.set(key, tail)
    void tail.then(() => {
      if (queues.get(key) === tail) queues.delete(key)
    })
    return next
  }

  private init(): Promise<void> {
    return (this.ready ??= (async () => {
      const dir = join(this.root, ...CHECKPOINT_DIR.split('/'))
      await mkdir(dir, { recursive: true })
      // Never committed to the project's own repo.
      await writeFile(join(dir, '.gitignore'), '*\n')
      const exists = await stat(join(this.gitDir, 'HEAD')).then(() => true, () => false)
      if (!exists) await this.git(['init', '--bare', '-q', this.gitDir], { cwd: this.root, env: {} })
      // The shadow repo must not snapshot itself or the user's .git.
      await mkdir(join(this.gitDir, 'info'), { recursive: true })
      await writeFile(join(this.gitDir, 'info', 'exclude'), SHADOW_EXCLUDES.join('\n') + '\n')
      // A shadow index from an older version may still track files excluded now: untrack them so
      // the next snapshots leave them out.
      if (exists) {
        const tracked = (await this.run(['ls-files', '-z', '-c', '-i', '--exclude-standard']).catch(() => '')).split('\0').filter(Boolean)
        for (let i = 0; i < tracked.length; i += 200) await this.run(['rm', '-q', '--cached', '--ignore-unmatch', '--', ...tracked.slice(i, i + 200)]).catch(() => undefined)
      }
    })().catch((e) => {
      this.ready = null
      throw e
    }))
  }

  // Snapshot of the work tree now: returns the commit id (in the shadow repo only).
  create(label: string): Promise<string> {
    return this.locked(() => this.createUnlocked(label))
  }

  private async createUnlocked(label: string): Promise<string> {
    await this.init()
    await this.run(['add', '-A', '--', '.'])
    const tree = (await this.run(['write-tree'])).trim()
    // A unique id in the message: two snapshots of the same tree never share a commit (and a ref
    // dropped for one chat never takes another chat's checkpoint with it).
    const commit = (await this.run(['commit-tree', tree, '-m', `${label.slice(0, 200) || 'checkpoint'}\n\n${randomUUID()}`])).trim()
    // Keep the snapshot reachable inside the shadow repo (never a ref in the user's repo).
    await this.run(['update-ref', `refs/checkpoints/${commit}`, commit])
    return commit
  }

  // Files that differ between a checkpoint and the work tree now.
  changedSince(commit: string): Promise<string[]> {
    return this.locked(() => this.changedUnlocked(commit))
  }

  private async changedUnlocked(commit: string): Promise<string[]> {
    await this.init()
    await this.run(['add', '-A', '--', '.'])
    const out = await this.run(['diff', '--name-only', '--cached', commit])
    return out.split('\n').map((s) => s.trim()).filter(Boolean)
  }

  // Makes the work tree match the checkpoint. Returns the safety snapshot taken first and the files
  // that changed.
  restore(commit: string): Promise<{ undo: string; files: string[] }> {
    return this.locked(() => this.restoreUnlocked(commit))
  }

  private async restoreUnlocked(commit: string): Promise<{ undo: string; files: string[] }> {
    await this.init()
    const files = await this.changedUnlocked(commit)
    const undo = await this.createUnlocked(`before rewind to ${commit.slice(0, 8)}`)
    // The index holds the current state (create ran add -A); read-tree -u --reset updates the files
    // and removes the ones the checkpoint does not have.
    await this.run(['read-tree', '-u', '--reset', commit])
    return { undo, files }
  }

  // Forgets checkpoints no chat lists any more (trimmed, or rewound past), so the shadow repo does
  // not grow without bound; git gc --auto then packs and prunes their objects over time.
  drop(commits: string[]): Promise<void> {
    if (!commits.length) return Promise.resolve()
    return this.locked(async () => {
      await this.init()
      for (const c of commits) if (/^[0-9a-f]{7,64}$/.test(c)) await this.run(['update-ref', '-d', `refs/checkpoints/${c}`]).catch(() => undefined)
      await this.git(['-c', 'core.autocrlf=false', 'gc', '--auto', '--quiet'], { cwd: this.root, env: this.env() }).catch(() => undefined)
    })
  }
}
