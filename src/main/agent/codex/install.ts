// Installing the official Codex CLI privately for Forge, so "Sign in with ChatGPT" works on a machine
// that has never seen Codex. No electron imports.
//
//   npm install --prefix <userData>/tools/codex @openai/codex@<CODEX_NPM_VERSION>
//
// A local (non-global) install: nothing lands on the user's PATH or in npm's global folder, and the
// version is pinned. npm writes the launcher to <prefix>/node_modules/.bin/codex (codex.cmd on
// Windows); binary.ts looks there after the user's own installs. npm itself is found on the tool
// PATH (npm.cmd on Windows, spawned through cmd.exe by tools.ts planSpawn).

import path from 'node:path'
import { defaultContext, findTool, planSpawn, type Platform, type SpawnPlan, type ToolContext } from '../../services/tools.ts'

// @openai/codex on npm, Oct 2026 (0.162.1 published 2026-10-09). Has `codex login --device-auth`.
export const CODEX_NPM_VERSION = '0.162.1'
export const CODEX_NPM_PACKAGE = '@openai/codex'
export const CODEX_INSTALL_DOCS = 'https://developers.openai.com/codex/cli'
export const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download'

// <userData>/tools/codex
export function privateCodexPrefix(userDataDir: string, platform: Platform = process.platform): string {
  const p = platform === 'win32' ? path.win32 : path.posix
  return p.join(userDataDir, 'tools', 'codex')
}

// Where npm puts the launcher for a `--prefix` install, in lookup order.
export function privateCodexCandidates(prefix: string, platform: Platform = process.platform): string[] {
  if (platform === 'win32') {
    const bin = path.win32.join(prefix, 'node_modules', '.bin')
    return [path.win32.join(bin, 'codex.cmd'), path.win32.join(bin, 'codex.exe')]
  }
  return [path.posix.join(prefix, 'node_modules', '.bin', 'codex')]
}

export function findPrivateCodex(prefix: string | null | undefined, ctx: ToolContext = defaultContext()): string | null {
  if (!prefix) return null
  for (const c of privateCodexCandidates(prefix, ctx.platform)) if (ctx.isExecutable(c)) return c
  return null
}

export function findNpm(ctx: ToolContext = defaultContext()): string | null {
  return findTool('npm', ctx)
}

export function installArgs(prefix: string, version: string = CODEX_NPM_VERSION): string[] {
  return ['install', '--prefix', prefix, '--no-audit', '--no-fund', '--no-update-notifier', '--loglevel', 'http', `${CODEX_NPM_PACKAGE}@${version}`]
}

// The exact process to spawn (npm.cmd goes through cmd.exe on Windows). For tests and logs.
export function installPlan(npm: string, prefix: string, platform: Platform = process.platform, env: NodeJS.ProcessEnv = process.env, version?: string): SpawnPlan {
  return planSpawn(npm, installArgs(prefix, version), platform, env)
}

// npm settings from the environment that would turn this into a global install (Forge started from
// an npm script, or a user-level npm_config_global) are dropped; --prefix decides where it goes.
export function installEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base, NO_COLOR: '1', npm_config_progress: 'false' }
  for (const key of Object.keys(env)) {
    if (/^npm_config_(global|location|prefix|dry_run|only)$/i.test(key)) delete env[key]
  }
  return env
}

// One short line of npm output for the progress panel, or null for noise.
export function installProgressLine(line: string): string | null {
  // eslint-disable-next-line no-control-regex
  const l = line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').trim()
  if (!l) return null
  // `--loglevel http`: "npm http fetch GET 200 <url> 80ms" or "npm http cache <url> 0ms (cache hit)".
  if (/^npm http (fetch|cache)\b.*codex-[\w.]+-(darwin|linux|win32)/i.test(l)) return 'Downloading the Codex CLI...'
  if (/^npm http (fetch|cache)\b/i.test(l)) return 'Looking up the Codex CLI on npm...'
  if (/^added \d+ packages?/i.test(l)) return 'Installed. Checking it runs...'
  if (/^npm (ERR!|error)/i.test(l)) return l.replace(/^npm (ERR!|error)\s*/i, '')
  return null
}

// Why npm failed, from its output, in one line.
export function installError(code: number | null, output: string): string {
  const lines = output
    // eslint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => /^npm (ERR!|error)/i.test(l))
    .map((l) => l.replace(/^npm (ERR!|error)\s*/i, ''))
    .filter((l) => l && !/^A complete log of this run|^\s*$/i.test(l))
  if (lines.some((l) => /EACCES|EPERM/i.test(l))) return `npm could not write to Forge's tools folder (${lines.find((l) => /EACCES|EPERM/i.test(l))}).`
  if (lines.some((l) => /ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|network/i.test(l))) return 'npm could not reach the npm registry. Check your internet connection and try again.'
  return lines.slice(0, 3).join(' ').slice(0, 300) || `npm install exited with code ${code ?? '?'}`
}
