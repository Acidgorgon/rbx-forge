// Locating the official Codex CLI (`codex`) on the user's machine. No electron imports.
//
// Install routes (github.com/openai/codex README): `npm i -g @openai/codex` (npm's global bin:
// %APPDATA%\npm\codex.cmd on Windows, <prefix>/bin elsewhere, often ~/.npm-global/bin), Homebrew
// (`brew install --cask codex`: /opt/homebrew/bin or /usr/local/bin), or a release binary somewhere on
// PATH. A GUI-launched app's PATH misses most of these, so the usual folders are checked as well.

import path from 'node:path'
import { defaultContext, envGet, findTool, pathExts, type ToolContext } from '../../services/tools.ts'

// Folders where `codex` usually lands that are not in tools.ts's extraToolDirs.
export function codexDirs(ctx: ToolContext): string[] {
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  const home = ctx.home
  if (ctx.platform === 'win32') {
    const appData = envGet(ctx.env, 'APPDATA', ctx.platform) || p.join(home, 'AppData', 'Roaming')
    const local = envGet(ctx.env, 'LOCALAPPDATA', ctx.platform) || p.join(home, 'AppData', 'Local')
    const dirs = [p.join(appData, 'npm'), p.join(local, 'pnpm'), p.join(home, '.bun', 'bin'), p.join(local, 'Volta', 'bin'), p.join(home, 'scoop', 'shims')]
    const prefix = envGet(ctx.env, 'npm_config_prefix', ctx.platform)
    if (prefix) dirs.unshift(prefix)
    return dirs
  }
  const dirs = [p.join(home, '.npm-global', 'bin'), p.join(home, '.volta', 'bin'), p.join(home, '.bun', 'bin'), p.join(home, '.local', 'share', 'pnpm'), p.join(home, 'Library', 'pnpm'), p.join(home, '.local', 'bin'), '/opt/homebrew/bin', '/usr/local/bin']
  const prefix = ctx.env.npm_config_prefix
  if (prefix) dirs.unshift(p.join(prefix, 'bin'))
  return dirs
}

// Full path of the codex binary, or null. `override` is the user's own path (Settings), used when
// it exists. On Windows the npm shim is codex.cmd (spawned through cmd.exe by tools.ts planSpawn);
// a bare `codex` (the sh shim npm also writes) or codex.ps1 cannot be spawned and is skipped.
export function findCodex(ctx: ToolContext = defaultContext(), override?: string | null): string | null {
  const o = override?.trim()
  if (o && ctx.isExecutable(o)) return o
  const onPath = findTool('codex', ctx)
  if (onPath) return onPath
  const p = ctx.platform === 'win32' ? path.win32 : path.posix
  const exts = ctx.platform === 'win32' ? pathExts(ctx).filter((e) => e === '.exe' || e === '.cmd' || e === '.bat') : ['']
  for (const dir of codexDirs(ctx)) {
    for (const ext of exts) {
      const candidate = p.join(dir, 'codex' + ext)
      if (ctx.isExecutable(candidate)) return candidate
    }
  }
  return null
}

// `codex --version` prints e.g. "codex-cli 0.140.0".
export function parseVersion(text: string): string | null {
  const m = /(\d+\.\d+\.\d+(?:[-+][\w.]+)?)/.exec(text)
  return m ? m[1] : null
}

export type CodexAuthMethod = 'chatgpt' | 'apikey' | 'other'

// `codex login status` (codex-rs/cli/src/login.rs): exit 0 and "Logged in using ChatGPT" /
// "Logged in using an API key - sk-...", exit 1 and "Not logged in". The text is on stderr.
export function parseLoginStatus(code: number, text: string): { loggedIn: boolean; method?: CodexAuthMethod; detail: string } {
  const line = text.split(/\r?\n/).map((l) => l.trim()).find((l) => /logged in|not logged|error/i.test(l)) ?? text.trim().split(/\r?\n/)[0] ?? ''
  if (code !== 0 || /not logged in/i.test(line)) return { loggedIn: false, detail: line || 'Not logged in' }
  // Never echo the masked key line back: it is enough to say how.
  if (/chatgpt/i.test(line)) return { loggedIn: true, method: 'chatgpt', detail: 'Signed in with ChatGPT' }
  if (/api key/i.test(line)) return { loggedIn: true, method: 'apikey', detail: 'Signed in with an API key (usage is billed to the API, not your ChatGPT plan)' }
  return { loggedIn: true, method: 'other', detail: line.replace(/\s+-\s+\S+$/, '') || 'Signed in' }
}

// The browser login prints the authorize URL (in case the browser did not open).
export function loginUrl(text: string): string | null {
  const m = /(https:\/\/[^\s"'<>]+)/.exec(text)
  return m ? m[1] : null
}
