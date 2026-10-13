// Fake HarnessContext for agent-layer tests (no Electron, no real project).
import type { HarnessContext } from '../src/main/context.ts'
import type { TreeNode } from '../src/shared/types.ts'
import type { ToolFs } from '../src/main/agent/tools.ts'

export interface Fake {
  ctx: HarnessContext
  files: Map<string, string>
  dirs: Set<string>
  settings: Map<string, unknown>
  events: { event: string; payload: any }[]
  fs: ToolFs
}

export function fakeContext(opts: { tree?: TreeNode[]; files?: Record<string, string>; dirs?: string[] } = {}): Fake {
  const files = new Map(Object.entries(opts.files ?? {}))
  const dirs = new Set(opts.dirs ?? ['src', 'src/shared', 'src/server', 'src/client', 'src/shared/Features'])
  const settings = new Map<string, unknown>()
  const events: { event: string; payload: any }[] = []

  const ctx: HarnessContext = {
    project: () => ({ root: '/fake/project', name: 'Fake', placeIds: [1] }),
    tree: () => opts.tree ?? [],
    scripts: () => [],
    async readFile(path) {
      if (path === 'default.project.json' && !files.has(path)) throw new Error('missing')
      const v = files.get(path)
      if (v === undefined) throw new Error(`ENOENT ${path}`)
      return v
    },
    async writeFile(path, contents) {
      files.set(path, contents)
    },
    async listFiles() {
      return []
    },
    services: () => [{ id: 'dev', label: 'dev', state: 'running', restarts: 0 }],
    async restartService() {},
    logs: () => [],
    async gitStatus() {
      return { isRepo: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0, conflicts: [] }
    },
    async syncNow() {
      return { isRepo: true, hasRemote: false, ahead: 0, behind: 0, dirty: 0, conflicts: [] }
    },
    async studioConflicts() {
      return []
    },
    async resolveStudioConflict() {},
    getSetting: <T,>(key: string, fallback: T) => (settings.has(key) ? (settings.get(key) as T) : fallback),
    setSetting: (key, value) => void settings.set(key, value),
    emit: (event, payload) => void events.push({ event, payload }),
    log: () => {}
  }

  const fs: ToolFs = {
    async exists(rel) {
      return dirs.has(rel) || files.has(rel)
    },
    async mkdir(rel) {
      const parts = rel.split('/')
      for (let i = 1; i <= parts.length; i++) dirs.add(parts.slice(0, i).join('/'))
    }
  }

  return { ctx, files, dirs, settings, events, fs }
}
