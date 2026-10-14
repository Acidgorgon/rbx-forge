// "Sign in with Claude": the Claude Code CLI's own browser login, used by Forge's Agent SDK queries.
//
// Commands (Claude Code CLI reference, https://code.claude.com/docs/en/cli-reference, and
// `claude auth --help` of the CLI bundled with @anthropic-ai/claude-agent-sdk 0.3.296 / Claude Code 2.1.296):
//   claude auth login --claudeai   sign in with a Claude subscription; opens the browser and prints
//                                  "If the browser didn't open, visit: <url>" and
//                                  "Paste code here if prompted >" (the code shown when the browser
//                                  cannot reach the CLI's local callback); prints "Login successful".
//   claude auth status --json      { loggedIn, authMethod: none|claude.ai|oauth_token|api_key|
//                                  api_key_helper|third_party, email?, subscriptionType? ...};
//                                  exit code 0 when logged in, 1 when not.
//   claude auth logout             removes the stored login.
// `claude setup-token` is not used: it prints a long-lived token, and Forge never handles tokens.
// Where the login is kept (https://code.claude.com/docs/en/authentication#credential-management):
// macOS Keychain; ~/.claude/.credentials.json on Linux and Windows (CLAUDE_CONFIG_DIR moves it).
// Forge only checks that file's presence, never its contents; on macOS `claude auth status` is
// the only way to see the Keychain login.
//
// The CLI used is the one the Agent SDK runs (bundled in packaged builds, the SDK's platform
// package in development), else a `claude` on PATH.

import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { homedir, tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AccountCheck, SignInStatus } from '../../shared/accountTypes.ts'
import { bundledClaudeExecutable } from '../services/sdkBinary.ts'
import { findTool } from '../services/tools.ts'
import { extractUrl, runCli, type CliRunOptions, type CliRunResult } from './cli.ts'
import type { AccountProvider, SignInControl } from './registry.ts'

export interface ClaudeCli {
  path: string
  source: 'bundled' | 'sdk' | 'path'
}

export interface ClaudeCliLocator {
  bundled?: () => string | undefined
  sdkPackage?: () => string | undefined
  onPath?: () => string | null
}

// Development: the SDK's platform package in node_modules (its binary is runnable outside asar).
export function sdkPackageClaude(platform: NodeJS.Platform = process.platform, arch: string = process.arch, exists: (p: string) => boolean = existsSync): string | undefined {
  let req: NodeRequire
  try {
    req = createRequire(import.meta.url)
  } catch {
    return undefined
  }
  const names = platform === 'linux' ? [`linux-${arch}`, `linux-${arch}-musl`] : [`${platform}-${arch}`]
  const file = platform === 'win32' ? 'claude.exe' : 'claude'
  for (const name of names) {
    try {
      const pkg = req.resolve(`@anthropic-ai/claude-agent-sdk-${name}/package.json`)
      const candidate = join(dirname(pkg), file)
      // Inside app.asar a binary cannot run; the bundled path covers packaged builds.
      if (!/app\.asar[\\/]/.test(candidate) && exists(candidate)) return candidate
    } catch {
      // not installed for this platform
    }
  }
  return undefined
}

export function findClaudeCli(locate: ClaudeCliLocator = {}): ClaudeCli | null {
  const bundled = (locate.bundled ?? (() => bundledClaudeExecutable()))()
  if (bundled) return { path: bundled, source: 'bundled' }
  const sdk = (locate.sdkPackage ?? (() => sdkPackageClaude()))()
  if (sdk) return { path: sdk, source: 'sdk' }
  const onPath = (locate.onPath ?? (() => findTool('claude')))()
  return onPath ? { path: onPath, source: 'path' } : null
}

// Environment for the CLI's auth commands: an API key from the environment would make
// `auth status` report the key instead of the subscription login, and CLAUDECODE marks a nested
// session. Everything else (CLAUDE_CONFIG_DIR, proxies, HOME) passes through.
export function claudeCliEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...env, NO_COLOR: '1' }
  delete out.ANTHROPIC_API_KEY
  delete out.CLAUDECODE
  return out
}

export const CLAUDE_LOGIN_ARGS = ['auth', 'login', '--claudeai']
export const CLAUDE_STATUS_ARGS = ['auth', 'status', '--json']
export const CLAUDE_LOGOUT_ARGS = ['auth', 'logout']
// Test connection: one tiny print-mode turn with no tools, no session file, no user settings.
export const CLAUDE_TEST_ARGS = ['-p', 'Reply with the single word OK.', '--output-format', 'json', '--max-turns', '1', '--model', 'haiku', '--tools', '', '--no-session-persistence', '--setting-sources', '']

export interface ClaudeAuthStatus {
  loggedIn: boolean
  authMethod: string
  email?: string
  subscriptionType?: string
}

// Parses `claude auth status --json`. Only the fields Forge shows are kept (no tokens exist in it).
export function parseAuthStatus(stdout: string, code: number | null): ClaudeAuthStatus | null {
  const start = stdout.indexOf('{')
  const end = stdout.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  let j: any
  try {
    j = JSON.parse(stdout.slice(start, end + 1))
  } catch {
    return null
  }
  if (!j || typeof j !== 'object' || typeof j.loggedIn !== 'boolean') return null
  return {
    loggedIn: j.loggedIn && code !== 1,
    authMethod: typeof j.authMethod === 'string' ? j.authMethod : 'none',
    ...(typeof j.email === 'string' && j.email ? { email: j.email } : {}),
    ...(typeof j.subscriptionType === 'string' && j.subscriptionType ? { subscriptionType: j.subscriptionType } : {})
  }
}

// A subscription login (not a Console key the CLI stored, not a cloud provider).
export function isSubscriptionLogin(s: ClaudeAuthStatus | null | undefined): boolean {
  return !!s && s.loggedIn && (s.authMethod === 'claude.ai' || s.authMethod === 'oauth_token')
}

export function credentialsFile(env: NodeJS.ProcessEnv = process.env, home: string = homedir()): string {
  return join(env.CLAUDE_CONFIG_DIR || join(home, '.claude'), '.credentials.json')
}

export interface ClaudeStateInput {
  // Settings > Accounts "Sign in with Claude" is in use (setting anthropicUseClaudeLogin).
  useLogin: boolean
  // CLAUDE_CODE_OAUTH_TOKEN is set in the environment.
  envToken: boolean
  // ~/.claude/.credentials.json exists (Linux, Windows, macOS fallback).
  credentialsFile: boolean
  // `claude auth status`: the parsed answer, 'missing' (no CLI), 'error' (failed or timed out),
  // undefined (not checked yet).
  cli: ClaudeAuthStatus | 'missing' | 'error' | undefined
  // The last request on the Claude login failed to authenticate.
  failed: boolean
  platform: NodeJS.Platform
  checkedAt?: number
}

const PLAN: Record<string, string> = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' }

export function loginFound(i: Pick<ClaudeStateInput, 'envToken' | 'credentialsFile' | 'cli'>): boolean | undefined {
  if (i.envToken) return true
  if (i.cli && typeof i.cli === 'object') return isSubscriptionLogin(i.cli)
  if (i.credentialsFile) return true
  // macOS keeps the login in the Keychain: unknown until the CLI answers.
  return undefined
}

export function claudeSignInStatus(i: ClaudeStateInput): SignInStatus {
  const base: SignInStatus = { method: 'claude', label: 'Sign in with Claude', state: 'signedOut', canCliLogout: i.cli !== 'missing', ...(i.checkedAt ? { checkedAt: i.checkedAt } : {}) }
  const cli = i.cli && typeof i.cli === 'object' ? i.cli : null
  const account = cli?.email ? [cli.email, cli.subscriptionType ? (PLAN[cli.subscriptionType.toLowerCase()] ?? cli.subscriptionType) : ''].filter(Boolean).join(' · ') : undefined
  const found = loginFound(i)
  const where = i.envToken ? 'CLAUDE_CODE_OAUTH_TOKEN from the environment' : 'Claude Code login on this computer'
  if (found === true) {
    if (i.useLogin && i.failed) return { ...base, state: 'expired', ...(account ? { account } : {}), detail: 'The last request could not authenticate. Sign in again.' }
    if (i.useLogin) return { ...base, state: 'signedIn', ...(account ? { account } : {}), detail: where }
    return { ...base, state: 'signedOut', foundButOff: true, ...(account ? { account } : {}), detail: `${where} found, not in use` }
  }
  if (i.cli === 'missing' && !i.credentialsFile) {
    return { ...base, state: 'unavailable', needs: 'Claude Code', needsUrl: 'https://code.claude.com/docs/en/setup', detail: 'The Claude Code CLI was not found.' }
  }
  if (found === undefined && i.useLogin) {
    if (i.failed) return { ...base, state: 'expired', detail: 'The last request could not authenticate. Sign in again.' }
    return { ...base, state: 'unknown', detail: i.platform === 'darwin' ? 'Login is in the macOS Keychain; use Test connection to check it.' : 'Could not check the Claude Code login.' }
  }
  return { ...base, detail: cli && cli.loggedIn && cli.authMethod !== 'none' ? `Claude Code is set up with ${cli.authMethod.replace(/_/g, ' ')}, not a subscription login` : undefined }
}

// Short text for a failed test or sign-in from CLI output (never echoes long output).
export function cliFailure(r: CliRunResult, what: string): string {
  if (r.cancelled) return `${what} cancelled`
  if (r.timedOut) return `${what} timed out`
  if (r.error) return `${what} could not start: ${r.error}`
  // The last meaningful line: stderr first, then stdout without prompts and JSON.
  const last = (text: string) =>
    text.split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^[{}]/.test(l) && !/paste code|opening browser|browser didn.t open/i.test(l)).pop() ?? ''
  const line = last(r.stderr) || last(r.stdout)
  return `${what} failed${r.code !== null ? ` (exit ${r.code})` : ''}${line ? `: ${line.slice(0, 200)}` : ''}`
}

// Parses the print-mode JSON result of CLAUDE_TEST_ARGS.
export function parseTestResult(r: CliRunResult): { ok: boolean; message: string; auth: boolean } {
  if (r.cancelled || r.timedOut || r.error) return { ok: false, message: cliFailure(r, 'Test'), auth: false }
  const start = r.stdout.indexOf('{')
  let j: any = null
  try {
    j = start >= 0 ? JSON.parse(r.stdout.slice(start, r.stdout.lastIndexOf('}') + 1)) : null
  } catch {
    j = null
  }
  const text = typeof j?.result === 'string' ? j.result : `${r.stderr} ${r.stdout}`
  if (j && j.is_error === false && r.code === 0) return { ok: true, message: 'Connected', auth: false }
  const auth = j?.api_error_status === 401 || /authenticat|not logged in|\/login|expired|invalid api key/i.test(text)
  return { ok: false, message: auth ? 'Sign-in expired or invalid. Sign in again.' : `Test failed: ${String(text).trim().slice(0, 200) || `exit ${r.code}`}`, auth }
}

export interface ClaudeProviderDeps {
  env: () => NodeJS.ProcessEnv
  platform?: NodeJS.Platform
  locate?: ClaudeCliLocator
  run?: (file: string, args: string[], opts: CliRunOptions) => Promise<CliRunResult>
  fileExists?: (p: string) => boolean
  useLogin: () => boolean
  setUseLogin: (on: boolean) => void
  // Last request on the Claude login failed (AuthHealth).
  failed: () => boolean
  // Records a test or sign-in outcome on the Claude login (AuthHealth).
  record: (ok: boolean, message?: string) => void
  statusTimeoutMs?: number
  testTimeoutMs?: number
}

// The Claude sign-in method. Also caches the last `auth status` answer for Credentials.
export class ClaudeAccount implements AccountProvider {
  readonly method = 'claude'
  readonly account = 'claude' as const
  readonly label = 'Sign in with Claude'
  private deps: ClaudeProviderDeps
  private cli: ClaudeAuthStatus | 'missing' | 'error' | undefined
  private checkedAt = 0
  private inflight: Promise<void> | null = null

  constructor(deps: ClaudeProviderDeps) {
    this.deps = deps
  }

  private platform(): NodeJS.Platform {
    return this.deps.platform ?? process.platform
  }

  private run(file: string, args: string[], opts: CliRunOptions): Promise<CliRunResult> {
    return (this.deps.run ?? runCli)(file, args, { cwd: tmpdir(), ...opts })
  }

  locate(): ClaudeCli | null {
    return findClaudeCli(this.deps.locate)
  }

  // Last CLI answer: true/false when known, undefined when not checked or unknown.
  cachedLogin(): boolean | undefined {
    return this.cli && typeof this.cli === 'object' ? isSubscriptionLogin(this.cli) : undefined
  }

  async refresh(): Promise<void> {
    if (this.inflight) return this.inflight
    this.inflight = (async () => {
      const cli = this.locate()
      if (!cli) {
        this.cli = 'missing'
      } else {
        const r = await this.run(cli.path, CLAUDE_STATUS_ARGS, { env: claudeCliEnv(this.deps.env()), timeoutMs: this.deps.statusTimeoutMs ?? 15_000 })
        this.cli = (r.error || r.timedOut ? null : parseAuthStatus(r.stdout, r.code)) ?? 'error'
      }
      this.checkedAt = Date.now()
    })().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  input(): ClaudeStateInput {
    const env = this.deps.env()
    return {
      useLogin: this.deps.useLogin(),
      envToken: !!env.CLAUDE_CODE_OAUTH_TOKEN,
      credentialsFile: (this.deps.fileExists ?? existsSync)(credentialsFile(env)),
      cli: this.cli,
      failed: this.deps.failed(),
      platform: this.platform(),
      ...(this.checkedAt ? { checkedAt: this.checkedAt } : {})
    }
  }

  async status(opts: { refresh?: boolean } = {}): Promise<SignInStatus> {
    if (opts.refresh || this.cli === undefined) await this.refresh()
    return claudeSignInStatus(this.input())
  }

  async signIn(ctl: SignInControl): Promise<{ ok: boolean; message?: string }> {
    const cli = this.locate()
    if (!cli) return { ok: false, message: 'The Claude Code CLI was not found. Install Claude Code, or use an API key.' }
    ctl.progress({ message: 'Opening your browser to sign in to Claude...' })
    let success = false
    let write: ((text: string) => void) | null = null
    ctl.onCode((code) => {
      const clean = code.trim()
      if (clean && write) write(`${clean}\n`)
    })
    const r = await this.run(cli.path, CLAUDE_LOGIN_ARGS, {
      env: claudeCliEnv(this.deps.env()),
      // The service's signal carries the overall timeout and the user's cancel.
      timeoutMs: 15 * 60_000,
      signal: ctl.signal,
      onStdin: (w) => {
        write = w
      },
      onLine: (line) => {
        const url = extractUrl(line)
        if (url) ctl.progress({ url, message: 'Finish signing in in your browser.' })
        else if (/paste code/i.test(line)) ctl.progress({ acceptsCode: true })
        else if (/login successful/i.test(line)) {
          success = true
          ctl.progress({ message: 'Signed in.' })
          // Newer CLIs wait for Enter after success.
          write?.('\n')
        }
      }
    })
    if (r.cancelled || r.timedOut) return { ok: false, message: cliFailure(r, 'Sign-in') }
    if (!success && r.code !== 0) return { ok: false, message: cliFailure(r, 'Sign-in') }
    await this.refresh()
    const found = this.cachedLogin()
    if (found === false) return { ok: false, message: 'Claude Code reports no subscription login after sign-in.' }
    this.deps.setUseLogin(true)
    this.deps.record(true)
    return { ok: true }
  }

  async signOut(opts: { cliLogout: boolean }): Promise<void> {
    this.deps.setUseLogin(false)
    if (!opts.cliLogout) return
    const cli = this.locate()
    if (!cli) return
    const r = await this.run(cli.path, CLAUDE_LOGOUT_ARGS, { env: claudeCliEnv(this.deps.env()), timeoutMs: 20_000 })
    if (r.code !== 0) throw new Error(cliFailure(r, 'claude auth logout'))
    await this.refresh()
  }

  async useExisting(): Promise<void> {
    this.deps.setUseLogin(true)
  }

  // One tiny turn through the CLI on the login (not an API key).
  async test(signal: AbortSignal): Promise<AccountCheck> {
    const cli = this.locate()
    if (!cli) return { ok: false, message: 'The Claude Code CLI was not found.', at: Date.now(), via: 'subscription' }
    const r = await this.run(cli.path, CLAUDE_TEST_ARGS, { env: claudeCliEnv(this.deps.env()), timeoutMs: this.deps.testTimeoutMs ?? 60_000, signal })
    const t = parseTestResult(r)
    if (t.ok || t.auth) this.deps.record(t.ok, t.ok ? undefined : t.message)
    return { ok: t.ok, message: t.message, at: Date.now(), via: 'subscription' }
  }
}
