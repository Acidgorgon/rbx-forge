// Codex (ChatGPT plan) through the official Codex CLI. No electron imports.
//
// Forge never sees the user's credentials: `codex login` signs in (browser OAuth, run by the CLI),
// `codex login status` reports whether it worked, and every request is a `codex exec` run that
// authenticates itself. Forge does not read ~/.codex/auth.json and does not call ChatGPT endpoints.
//
// Three account operations (status / signIn / signOut) are the public surface the Settings
// "Sign in with ChatGPT" control uses; exec / oneShot / generateImages run work on the plan.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultContext, envGet, toolEnv } from '../../services/tools.ts'
import { buildExecArgs, codexEnv, LOGIN_ARGS, LOGIN_STATUS_ARGS, LOGOUT_ARGS, VERSION_ARGS, type CodexSandbox } from './args.ts'
import { findCodex, loginUrl, parseLoginStatus, parseVersion, type CodexAuthMethod } from './binary.ts'
import { CodexEventMapper, type CodexUpdate, type CodexUsage } from './events.ts'
import { lastErrorLine, runCli, type RunOptions, type SpawnedRun } from './process.ts'

export const CODEX_INSTALL_HINT = 'Install the Codex CLI (npm i -g @openai/codex, or brew install --cask codex on a Mac), then sign in.'

export interface CodexStatus {
  installed: boolean
  path?: string
  version?: string
  loggedIn: boolean
  method?: CodexAuthMethod
  // One line for the UI.
  detail: string
  checkedAt: number
}

export interface SignInControl {
  signal: AbortSignal
  // url: the login page, for when the browser did not open.
  progress?: (u: { url?: string; message?: string }) => void
}

export interface ExecInput {
  cwd: string
  prompt: string
  sandbox: CodexSandbox
  model?: string
  resumeId?: string
  images?: string[]
  ephemeral?: boolean
  signal?: AbortSignal
  timeoutMs?: number
  onUpdate?: (u: CodexUpdate) => void
  // Root for relative paths in file-change chips (defaults to cwd).
  root?: string
}

export interface ExecResult {
  threadId: string | null
  lastMessage: string
  usage: CodexUsage
  savedImages: string[]
  aborted: boolean
  // Set when the run failed (turn.failed / error event / non-zero exit).
  error?: string
}

export type CliRunner = (o: RunOptions) => Promise<SpawnedRun>

export interface CodexServiceDeps {
  // The user's own codex path (Settings), tried first.
  binOverride?: () => string | null
  // Locates the binary (tests pass a fake).
  findBin?: (override: string | null) => string | null
  env?: () => NodeJS.ProcessEnv
  run?: CliRunner
  log?: (text: string, stream?: 'info' | 'stderr') => void
  tmpDir?: () => string
  now?: () => number
}

const STATUS_TTL = 30_000
const SIGN_IN_TIMEOUT = 10 * 60_000
const ONE_SHOT_TIMEOUT = 5 * 60_000

export class CodexService {
  private deps: CodexServiceDeps
  private cached: CodexStatus | null = null
  private pending: Promise<CodexStatus> | null = null
  private signingIn: AbortController | null = null
  private listeners = new Set<(s: CodexStatus) => void>()

  constructor(deps: CodexServiceDeps = {}) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  bin(): string | null {
    const override = this.deps.binOverride?.() ?? null
    return (this.deps.findBin ?? ((o) => findCodex(defaultContext(), o)))(override)
  }

  env(): NodeJS.ProcessEnv {
    return codexEnv(this.deps.env?.() ?? toolEnv())
  }

  private run(o: RunOptions): Promise<SpawnedRun> {
    return (this.deps.run ?? runCli)(o)
  }

  private cwd(): string {
    return this.deps.tmpDir?.() ?? tmpdir()
  }

  onStatus(fn: (s: CodexStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  private publish(s: CodexStatus): CodexStatus {
    this.cached = s
    for (const fn of this.listeners) {
      try {
        fn(s)
      } catch {
        // a listener must not break status
      }
    }
    return s
  }

  // Cached status (30 s); refresh forces a new `codex login status`.
  cachedStatus(): CodexStatus | null {
    return this.cached
  }

  async status(opts: { refresh?: boolean } = {}): Promise<CodexStatus> {
    if (!opts.refresh && this.cached && this.now() - this.cached.checkedAt < STATUS_TTL) return this.cached
    if (this.pending) return this.pending
    this.pending = this.check().finally(() => {
      this.pending = null
    })
    return this.pending
  }

  private async check(): Promise<CodexStatus> {
    const path = this.bin()
    const at = this.now()
    if (!path) return this.publish({ installed: false, loggedIn: false, detail: `Codex CLI not found. ${CODEX_INSTALL_HINT}`, checkedAt: at })
    const env = this.env()
    try {
      let verOut = ''
      let stOut = ''
      const [ver, st] = await Promise.all([
        this.run({ bin: path, args: VERSION_ARGS, cwd: this.cwd(), env, timeoutMs: 15_000, onStdoutLine: (l) => (verOut += `${l}\n`) }),
        this.run({ bin: path, args: LOGIN_STATUS_ARGS, cwd: this.cwd(), env, timeoutMs: 15_000, onStdoutLine: (l) => (stOut += `${l}\n`) })
      ])
      const version = parseVersion(`${verOut}\n${ver.stderr}`) ?? undefined
      // login status prints on stderr; stdout is read too in case a version moves it.
      const parsed = st.timedOut ? { loggedIn: false, detail: 'codex login status did not answer' } : parseLoginStatus(st.code ?? 1, `${st.stderr}\n${stOut}`)
      return this.publish({ installed: true, path, ...(version ? { version } : {}), ...parsed, checkedAt: at })
    } catch (e) {
      return this.publish({ installed: false, path, loggedIn: false, detail: `Could not run ${path}: ${(e as Error).message}`, checkedAt: at })
    }
  }

  signingInNow(): boolean {
    return !!this.signingIn
  }

  // Runs `codex login`: the CLI opens the browser for "Sign in with ChatGPT" and stores the
  // credentials itself. Resolves when the CLI exits (signed in, failed, cancelled or timed out).
  async signIn(ctl: SignInControl): Promise<{ ok: boolean; message?: string }> {
    if (this.signingIn) return { ok: false, message: 'A sign-in is already running. Finish it in the browser, or cancel it.' }
    const path = this.bin()
    if (!path) return { ok: false, message: `Codex CLI not found. ${CODEX_INSTALL_HINT}` }
    const abort = new AbortController()
    this.signingIn = abort
    const onCancel = () => abort.abort()
    ctl.signal.addEventListener('abort', onCancel, { once: true })
    let sentUrl = false
    const watch = (text: string) => {
      const url = loginUrl(text)
      if (url && !sentUrl) {
        sentUrl = true
        ctl.progress?.({ url, message: 'Finish signing in in your browser.' })
      }
    }
    try {
      ctl.progress?.({ message: 'Opening the ChatGPT sign-in page...' })
      const r = await this.run({ bin: path, args: LOGIN_ARGS, cwd: this.cwd(), env: this.env(), signal: abort.signal, timeoutMs: SIGN_IN_TIMEOUT, onStderr: watch, onStdoutLine: watch })
      const st = await this.status({ refresh: true })
      if (r.aborted) return { ok: false, message: 'Sign-in cancelled.' }
      if (r.timedOut) return { ok: false, message: 'Sign-in timed out after 10 minutes.' }
      if (st.loggedIn) return { ok: true, message: st.detail }
      return { ok: false, message: lastErrorLine(r.stderr) || `codex login exited with code ${r.code ?? '?'}` }
    } catch (e) {
      return { ok: false, message: `Could not run codex login: ${(e as Error).message}` }
    } finally {
      ctl.signal.removeEventListener('abort', onCancel)
      this.signingIn = null
    }
  }

  cancelSignIn(): void {
    this.signingIn?.abort()
  }

  // `codex logout` removes the CLI's stored credentials (this signs the user out of Codex
  // everywhere on this machine, not only in Forge).
  async signOut(): Promise<CodexStatus> {
    const path = this.bin()
    if (path) await this.run({ bin: path, args: LOGOUT_ARGS, cwd: this.cwd(), env: this.env(), timeoutMs: 15_000 }).catch(() => null)
    return this.status({ refresh: true })
  }

  // Why Codex cannot run right now, or null when it can.
  async notReady(): Promise<string | null> {
    const s = await this.status()
    if (!s.installed) return s.detail
    if (!s.loggedIn) return 'Codex is not signed in. Use "Sign in with ChatGPT (Codex)" in Settings > Accounts > OpenAI.'
    return null
  }

  // One `codex exec --json` run. Updates stream through onUpdate.
  async exec(i: ExecInput): Promise<ExecResult> {
    const path = this.bin()
    if (!path) throw new Error(`Codex CLI not found. ${CODEX_INSTALL_HINT}`)
    const mapper = new CodexEventMapper(i.root ?? i.cwd)
    const args = buildExecArgs({ cwd: i.cwd, sandbox: i.sandbox, model: i.model, resumeId: i.resumeId, images: i.images, ephemeral: i.ephemeral })
    const r = await this.run({
      bin: path,
      args,
      cwd: i.cwd,
      env: this.env(),
      stdin: i.prompt,
      signal: i.signal,
      timeoutMs: i.timeoutMs,
      onStdoutLine: (line) => {
        for (const u of mapper.line(line)) i.onUpdate?.(u)
      }
    })
    const out: ExecResult = { threadId: mapper.threadId, lastMessage: mapper.lastMessage, usage: mapper.usage, savedImages: mapper.savedImages, aborted: r.aborted }
    if (r.aborted) return out
    if (r.timedOut) out.error = 'Codex did not finish in time.'
    else if (mapper.failed) out.error = mapper.failed
    else if (r.code !== 0) out.error = lastErrorLine(r.stderr) || `codex exited with code ${r.code ?? '?'}`
    if (out.error && /not logged in|login|401|unauthorized/i.test(out.error)) {
      // The cached status is stale (signed out elsewhere, token expired).
      this.cached = null
    }
    return out
  }

  // A single answer (Labs, summaries, critiques): read-only sandbox, a scratch folder, nothing kept.
  async oneShot(system: string, prompt: string, opts: { images?: { mime: string; base64: string }[]; model?: string; signal?: AbortSignal } = {}): Promise<string> {
    const why = await this.notReady()
    if (why) throw new Error(why)
    const dir = await mkdtemp(join(this.cwd(), 'forge-codex-'))
    try {
      const images: string[] = []
      for (const [k, img] of (opts.images ?? []).entries()) {
        const ext = /jpe?g/.test(img.mime) ? 'jpg' : img.mime.includes('webp') ? 'webp' : img.mime.includes('gif') ? 'gif' : 'png'
        const file = join(dir, `image-${k + 1}.${ext}`)
        await writeFile(file, Buffer.from(img.base64, 'base64'))
        images.push(file)
      }
      const r = await this.exec({
        cwd: dir,
        prompt: `${system.trim()}\n\nAnswer directly in your reply. Do not run commands or edit files.\n\n${prompt}`,
        sandbox: 'read-only',
        ephemeral: true,
        images,
        model: opts.model,
        signal: opts.signal,
        timeoutMs: ONE_SHOT_TIMEOUT
      })
      if (r.aborted) throw new Error('cancelled')
      if (r.error) throw new Error(r.error)
      return r.lastMessage.trim()
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  }
}

// $CODEX_HOME (default ~/.codex): Codex saves generated images under generated_images/ there.
// Only that folder is ever read, never the credentials in the same home.
export function codexHome(env: NodeJS.ProcessEnv = process.env): string {
  const v = envGet(env, 'CODEX_HOME')?.trim()
  return v || join((process.platform === 'win32' && env.USERPROFILE) || homedir(), '.codex')
}

let shared: CodexService | null = null

// The process-wide service (main/index.ts configures it once; tests construct their own).
export function codexService(): CodexService {
  return (shared ??= new CodexService())
}

export function setCodexService(s: CodexService): void {
  shared = s
}
