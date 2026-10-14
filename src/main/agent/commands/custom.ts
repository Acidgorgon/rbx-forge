// Custom slash commands from markdown files: .forge/commands/**/*.md in the project and
// <userData>/commands/**/*.md for the person (Claude Code's .claude/commands, mapped onto Forge).
// Subfolders namespace a command (frontend/test.md -> /frontend:test).

import { readdir, readFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { mergeCommands, parseCustomCommand, type CustomCommand } from '../../../shared/chatCommands.ts'

export const PROJECT_COMMANDS_DIR = '.forge/commands'
const MAX_FILES = 200
const MAX_BYTES = 64 * 1024

async function walk(dir: string, depth = 0, out: string[] = []): Promise<string[]> {
  if (depth > 3 || out.length >= MAX_FILES) return out
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const p = join(dir, e.name)
    if (e.isDirectory()) await walk(p, depth + 1, out)
    else if (e.isFile() && /\.md$/i.test(e.name)) out.push(p)
  }
  return out
}

export async function loadCommandsFrom(dir: string, source: 'project' | 'user'): Promise<CustomCommand[]> {
  const out: CustomCommand[] = []
  for (const file of await walk(dir)) {
    const text = await readFile(file, 'utf8').catch(() => '')
    if (!text || text.length > MAX_BYTES) continue
    const rel = relative(dir, file).split(sep).join('/')
    const c = parseCustomCommand(rel, text, source, file)
    if (c) out.push(c)
  }
  return out
}

export async function loadCustomCommands(projectRoot: string | null, userDir: string | undefined): Promise<CustomCommand[]> {
  const [project, user] = await Promise.all([
    projectRoot ? loadCommandsFrom(join(projectRoot, ...PROJECT_COMMANDS_DIR.split('/')), 'project') : Promise.resolve([]),
    userDir ? loadCommandsFrom(userDir, 'user') : Promise.resolve([])
  ])
  return mergeCommands(project, user)
}
