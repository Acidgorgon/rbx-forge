// Shared fixture for the token-budget tests: a small GenTree project (copied from the template,
// plus an Inventory feature and a Shop controller) with a real script list from project.ts.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, resolve } from 'node:path'
import type { ScriptGroup } from '../src/shared/types.ts'
import { buildRepoTree, buildScriptGroups } from '../src/main/services/project.ts'
import type { SearchFs } from '../src/main/agent/budget/searchCode.ts'

export const FIXTURE_ROOT = resolve(import.meta.dirname, 'fixtures', 'gentree-tokens')

const IGNORED = new Set(['node_modules', '.git', 'Packages', 'ServerPackages', '.studio-sync'])

// Same contract as Project.listFiles: recursive, repo-relative, ignored dirs skipped below `dir`.
export function fixtureFs(root = FIXTURE_ROOT, overrides: Record<string, string> = {}): SearchFs & { reads: string[] } {
  const reads: string[] = []
  return {
    reads,
    async readFile(p: string) {
      reads.push(p)
      if (p in overrides) return overrides[p]
      return readFile(join(root, p), 'utf8')
    },
    async listFiles(dir: string) {
      const out: string[] = []
      const walk = async (abs: string) => {
        let entries
        try {
          entries = await readdir(abs, { withFileTypes: true })
        } catch {
          return
        }
        for (const e of entries) {
          const child = join(abs, e.name)
          if (e.isDirectory()) {
            if (!IGNORED.has(e.name)) await walk(child)
          } else out.push(relative(root, child).split('\\').join('/'))
        }
      }
      await walk(join(root, dir || '.'))
      return out.sort()
    }
  }
}

export async function fixtureScripts(root = FIXTURE_ROOT): Promise<ScriptGroup[]> {
  const project = JSON.parse(await readFile(join(root, 'default.project.json'), 'utf8'))
  return buildScriptGroups(await buildRepoTree(root, project))
}

export async function fixtureStat(p: string): Promise<{ mtimeMs: number; size: number }> {
  const s = await stat(join(FIXTURE_ROOT, p))
  return { mtimeMs: s.mtimeMs, size: s.size }
}
