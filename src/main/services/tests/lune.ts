// Finding the lune binary and the bundled Luau runtime (resources/lune).

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findTool, run, type ToolContext, defaultContext } from '../tools.ts'
import type { LuneStatus } from './types.ts'

export const INSTALL_HINT =
  'Lune is not installed. Add it to the project with `rokit add lune-org/lune` (then `rokit install`), or globally with `rokit add --global lune-org/lune`.'

export const RUNNER_FILE = 'runner.luau'

// lune on the tool PATH (rokit's bin first, like rojo and luau-lsp), or an explicit override.
export function findLune(override?: string | null, ctx: ToolContext = defaultContext()): string | null {
  if (override && ctx.isExecutable(override)) return override
  return findTool('lune', ctx)
}

// "lune 0.11.0" -> "0.11.0"
export function parseLuneVersion(output: string): string | null {
  const match = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(output)
  return match ? match[1] : null
}

export async function luneStatus(override?: string | null, cwd: string = process.cwd()): Promise<LuneStatus> {
  const path = findLune(override)
  if (!path) return { available: false, hint: INSTALL_HINT }
  const result = await run(path, ['--version'], cwd)
  const version = parseLuneVersion(result.stdout || result.stderr)
  if (result.code !== 0 || !version) {
    return { available: false, hint: `Found ${path} but \`lune --version\` failed (${(result.stderr || result.stdout).trim().slice(0, 200)}). ${INSTALL_HINT}` }
  }
  return { available: true, path, version }
}

// Where resources/lune lives: packaged apps get it via electron-builder extraResources
// (process.resourcesPath/lune); dev runs and tests use the repo copy.
export function runtimeDirCandidates(): string[] {
  const out: string[] = []
  const resourcesPath = (process as { resourcesPath?: string }).resourcesPath
  if (resourcesPath) out.push(join(resourcesPath, 'lune'))
  const here = import.meta.dirname ?? dirname(new URL(import.meta.url).pathname)
  // src/main/services/tests -> repo root; out/main (bundled) -> repo root.
  out.push(resolve(here, '..', '..', '..', '..', 'resources', 'lune'))
  out.push(resolve(here, '..', '..', 'resources', 'lune'))
  out.push(resolve(process.cwd(), 'resources', 'lune'))
  return out
}

export function findRuntimeDir(candidates: string[] = runtimeDirCandidates()): string | null {
  return candidates.find((dir) => existsSync(join(dir, RUNNER_FILE))) ?? null
}
