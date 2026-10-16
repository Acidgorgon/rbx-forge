// Finding the lune binary and the bundled Luau runtime (resources/lune).

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { findTool, run, type ToolContext, defaultContext } from '../tools.ts'
import type { LuneStatus } from './types.ts'

export const INSTALL_HINT =
  'Lune is not installed. Add it to the project with `rokit add lune-org/lune` (then `rokit install`), or set the Lune path in Settings > Toolchain.'

// What to do when lune is missing, for the project at `root`: its rokit.toml already pins lune ->
// `rokit install` there; else add the pin first. Either way the Lune path in Settings works too.
export function luneHint(root?: string | null): string {
  let toml = ''
  try {
    toml = root ? readFileSync(join(root, 'rokit.toml'), 'utf8') : ''
  } catch {
    toml = ''
  }
  if (/^\s*[\w.-]+\s*=\s*["']lune-org\/lune@/im.test(toml)) return 'Lune is not installed. This project pins it in rokit.toml: run `rokit install` in the project folder, or set the Lune path in Settings > Toolchain.'
  if (root && toml) return 'Lune is not installed. Add it to this project with `rokit add lune-org/lune` (it pins it in rokit.toml), then run `rokit install` in the project folder; or set the Lune path in Settings > Toolchain.'
  return INSTALL_HINT
}

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
  if (!path) return { available: false, hint: luneHint(cwd) }
  const result = await run(path, ['--version'], cwd)
  const version = parseLuneVersion(result.stdout || result.stderr)
  if (result.code !== 0 || !version) {
    return { available: false, hint: `Found ${path} but \`lune --version\` failed (${(result.stderr || result.stdout).trim().slice(0, 200)}). ${luneHint(cwd)}` }
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
