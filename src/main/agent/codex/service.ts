// Codex (ChatGPT plan) through the official Codex CLI. No electron imports.
//
// Forge never sees the user's credentials: `codex login` signs in (browser OAuth, run by the CLI),
// `codex login status` reports whether it worked, and every request is a `codex exec` run that
// authenticates itself. Forge does not read ~/.codex/auth.json and does not call ChatGPT endpoints.
//
// Three account operations (status / signIn / signOut) are the public surface the Settings
// "Sign in with ChatGPT" control uses; exec / oneShot / generateImages run work on the plan.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { defaultContext, envGet, toolEnv } from '../../services/tools.ts'
import { buildExecArgs, codexEnv, DEVICE_LOGIN_ARGS, LOGIN_ARGS, LOGIN_STATUS_ARGS, LOGOUT_ARGS, MODELS_ARGS, VERSION_ARGS, type CodexSandbox } from './args.ts'
import { DeviceAuthParser, deviceAuthUnsupported, findCodex, loginUrl, parseLoginStatus, parseModelCatalog, parseVersion, type CodexAuthMethod } from './binary.ts'
import { CODEX_INSTALL_DOCS, CODEX_NPM_VERSION, findNpm, installArgs, installEnv, installError, installProgressLine } from './install.ts'
import { CodexEventMapper, type CodexUpdate, type CodexUsage } from './events.ts'
import { GeneratedImageWatch } from './generated.ts'
import { lastErrorLine, runCli, type RunOptions, type SpawnedRun } from './process.ts'

export const CODEX_INSTALL_HINT = 'Install the Codex CLI (npm i -g @openai/codex, or brew install --cask codex on a Mac), then sign in.'

export interface CodexStatus {
  installed: boolean
  path?: string
  version?: string
  loggedIn: boolean
  method?: CodexAuthMethod
  // The binary is Forge's own copy under <userData>/tools/codex (install.ts).
  privateInstall?: boolean
  // Not installed, but npm is there, so signing in can install it first.
  canInstall?: boolean
  // One line for the UI.
  detail: string
  checkedAt: number
}

// installing: npm is fetching the CLI; device: waiting for the one-time code to be entered;
// browser: the CLI opened the browser login (older CLI or device code turned off).
export type CodexSignInStage = 'installing' | 'device' | 'browser'

export interface SignInUpdate {
  stage?: CodexSignInStage
  // device: the page to enter the code on; browser: the login page, for when the browser did not open.
  url?: string
  // device: the one-time code the CLI printed.
  userCode?: string
  message?: string
}

export interface SignInControl {
  signal: AbortSignal
  progress?: (u: SignInUpdate) => void
}

export interface SignInResult {
  ok: boolean
  message?: string
  // Where to read more when it failed for a reason the user has to fix (no npm).
  helpUrl?: string
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
  // Images the built-in image_gen tool saved during this run (generated.ts), as they appear: before
  // the next update is passed on, so a chat shows them where Codex made them. Awaited in order.
  onImages?: (paths: string[]) => Promise<void> | void
}

export interface ExecResult {
  threadId: string | null
  lastMessage: string
  usage: CodexUsage
  savedImages: string[]
  // Images this run made (onImages got each of them).
  images: string[]
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
  // Forge's private install folder (<userData>/tools/codex); null = never install.
  privatePrefix?: () => string | null
  // Locates npm for the install (tests pass a fake).
  findNpm?: () => string | null
  env?: () => NodeJS.ProcessEnv
  run?: CliRunner
  log?: (text: string, stream?: 'info' | 'stderr') => void
  tmpDir?: () => string
  now?: () => number
}

const STATUS_TTL = 30_000
// The device code expires after 15 minutes.
const SIGN_IN_TIMEOUT = 15 * 60_000
const INSTALL_TIMEOUT = 5 * 60_000
const MODELS_TTL = 10 * 60_000
const ONE_SHOT_TIMEOUT = 5 * 60_000

export class CodexService {
  private deps: CodexServiceDeps
  private cached: CodexStatus | null = null
  private pending: Promise<CodexStatus> | null = null
  private signingIn: AbortController | null = null
  private listeners = new Set<(s: CodexStatus) => void>()
  private modelList: { at: number; models: string[] } | null = null
  private modelsPending: Promise<string[]> | null = null
  // CLI warnings already written to the log (the same config warning comes with every run).
  private warned = new Set<string>()

  constructor(deps: CodexServiceDeps = {}) {
    this.deps = deps
  }

  private now(): number {
    return (this.deps.now ?? Date.now)()
  }

  private prefix(): string | null {
    return this.deps.privatePrefix?.() ?? null
  }

  bin(): string | null {
    const override = this.deps.binOverride?.() ?? null
    return (this.deps.findBin ?? ((o) => findCodex(defaultContext(), o, this.prefix())))(override)
  }

  private npm(): string | null {
    if (!this.prefix()) return null
    return (this.deps.findNpm ?? (() => findNpm(defaultContext())))()
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
    if (!path) {
      if (this.npm()) return this.publish({ installed: false, canInstall: true, loggedIn: false, detail: 'Signing in installs the Codex CLI for Forge first (about a minute).', checkedAt: at })
      const detail = this.prefix() ? 'Codex CLI not found, and Forge needs npm (it comes with Node.js) to install it. Install Node.js, or install the Codex CLI yourself.' : `Codex CLI not found. ${CODEX_INSTALL_HINT}`
      return this.publish({ installed: false, loggedIn: false, detail, checkedAt: at })
    }
    const prefix = this.prefix()
    const privateInstall = !!prefix && path.startsWith(prefix)
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
      return this.publish({ installed: true, path, ...(version ? { version } : {}), ...(privateInstall ? { privateInstall } : {}), ...parsed, checkedAt: at })
    } catch (e) {
      return this.publish({ installed: false, path, loggedIn: false, detail: `Could not run ${path}: ${(e as Error).message}`, checkedAt: at })
    }
  }

  signingInNow(): boolean {
    return !!this.signingIn
  }

  // One click: installs the CLI for Forge when there is none (install.ts), then runs
  // `codex login --device-auth` and reports the URL and one-time code it prints; the user enters the
  // code on the ChatGPT page and the CLI stores the login itself. Falls back to the browser login
  // (`codex login`) when the CLI cannot do device codes. Resolves when the CLI exits.
  async signIn(ctl: SignInControl): Promise<SignInResult> {
    if (this.signingIn) return { ok: false, message: 'A sign-in is already running. Finish it, or cancel it.' }
    const abort = new AbortController()
    this.signingIn = abort
    const onCancel = () => abort.abort()
    if (ctl.signal.aborted) abort.abort()
    else ctl.signal.addEventListener('abort', onCancel, { once: true })
    const cancelled = { ok: false, message: 'Sign-in cancelled.' }
    try {
      let path = this.bin()
      if (!path) {
        const inst = await this.install(ctl, abort.signal)
        if (!inst.ok) return inst
        path = inst.path
      }
      if (abort.signal.aborted) return cancelled
      // Already signed in with ChatGPT: a new device login would clear that login first.
      const before = await this.status({ refresh: true })
      if (abort.signal.aborted) return cancelled
      if (before.loggedIn && before.method === 'chatgpt') return { ok: true, message: before.detail }
      const r = await this.deviceLogin(path, ctl, abort.signal)
      if (r !== 'unsupported') return r
      return await this.browserLogin(path, ctl, abort.signal)
    } catch (e) {
      return { ok: false, message: `Could not run codex login: ${(e as Error).message}` }
    } finally {
      ctl.signal.removeEventListener('abort', onCancel)
      this.signingIn = null
      this.modelList = null
    }
  }

  // `npm install --prefix <userData>/tools/codex @openai/codex@<pinned>`. A failed or cancelled
  // install removes what it left, so a half-installed CLI is never picked up.
  private async install(ctl: SignInControl, signal: AbortSignal): Promise<{ ok: true; path: string } | (SignInResult & { ok: false })> {
    const prefix = this.prefix()
    if (!prefix) return { ok: false, message: `Codex CLI not found. ${CODEX_INSTALL_HINT}`, helpUrl: CODEX_INSTALL_DOCS }
    const npm = this.npm()
    if (!npm) {
      return {
        ok: false,
        message: 'The Codex CLI is not installed, and Forge needs npm (it comes with Node.js) to install it. Install Node.js, or install the Codex CLI yourself, then sign in again.',
        helpUrl: CODEX_INSTALL_DOCS
      }
    }
    ctl.progress?.({ stage: 'installing', message: `Installing the Codex CLI ${CODEX_NPM_VERSION} for Forge...` })
    this.deps.log?.(`installing @openai/codex@${CODEX_NPM_VERSION} into ${prefix}`)
    const cleanup = () => rm(join(prefix, 'node_modules'), { recursive: true, force: true }).catch(() => undefined)
    let output = ''
    let last = ''
    const onLine = (line: string) => {
      output = (output + line + '\n').slice(-16_000)
      const msg = installProgressLine(line)
      // Do not step back from "Downloading" to "Looking up" (npm interleaves cache lookups).
      if (msg && /^Looking up/.test(msg) && last && !/^Looking up/.test(last)) return
      if (msg && msg !== last) {
        last = msg
        ctl.progress?.({ stage: 'installing', message: msg })
      }
    }
    let r: SpawnedRun
    try {
      await mkdir(prefix, { recursive: true })
      r = await this.run({ bin: npm, args: installArgs(prefix), cwd: prefix, env: installEnv(this.deps.env?.() ?? toolEnv()), signal, timeoutMs: INSTALL_TIMEOUT, onStdoutLine: onLine, onStderr: (t) => t.split(/\r?\n/).forEach(onLine) })
    } catch (e) {
      await cleanup()
      return { ok: false, message: `Could not run npm: ${(e as Error).message}`, helpUrl: CODEX_INSTALL_DOCS }
    }
    if (r.aborted || r.timedOut || r.code !== 0) {
      await cleanup()
      if (r.aborted) return { ok: false, message: 'Sign-in cancelled.' }
      if (r.timedOut) return { ok: false, message: 'Installing the Codex CLI took too long (5 minutes). Check your connection and try again.' }
      this.deps.log?.(`npm install failed (${r.code}): ${installError(r.code, `${output}\n${r.stderr}`)}`, 'stderr')
      return { ok: false, message: `Could not install the Codex CLI: ${installError(r.code, `${output}\n${r.stderr}`)}`, helpUrl: CODEX_INSTALL_DOCS }
    }
    this.cached = null
    const path = this.bin()
    if (!path) return { ok: false, message: "npm finished, but the codex command is not in Forge's tools folder.", helpUrl: CODEX_INSTALL_DOCS }
    return { ok: true, path }
  }

  private async deviceLogin(path: string, ctl: SignInControl, signal: AbortSignal): Promise<SignInResult | 'unsupported'> {
    const parser = new DeviceAuthParser()
    let output = ''
    const feed = (line: string) => {
      output = (output + line + '\n').slice(-16_000)
      if (parser.line(line) && parser.code) {
        ctl.progress?.({ stage: 'device', userCode: parser.code, ...(parser.url ? { url: parser.url } : {}), message: 'Enter this code on the ChatGPT sign-in page. Waiting for you to finish...' })
      }
    }
    ctl.progress?.({ stage: 'device', message: 'Getting a sign-in code from ChatGPT...' })
    const r = await this.run({ bin: path, args: DEVICE_LOGIN_ARGS, cwd: this.cwd(), env: this.env(), signal, timeoutMs: SIGN_IN_TIMEOUT, onStdoutLine: feed, onStderr: (t) => t.split(/\r?\n/).forEach(feed) })
    if (r.aborted) return { ok: false, message: 'Sign-in cancelled.' }
    if (r.timedOut) return { ok: false, message: 'Sign-in timed out (the code expires after 15 minutes). Try again.' }
    if (r.code !== 0 && !parser.code && deviceAuthUnsupported(`${output}\n${r.stderr}`)) return 'unsupported'
    const st = await this.status({ refresh: true })
    if (st.loggedIn && r.code === 0) return { ok: true, message: st.detail }
    return { ok: false, message: lastErrorLine(r.stderr) || `codex login exited with code ${r.code ?? '?'}` }
  }

  // `codex login`: the CLI opens the browser for "Sign in with ChatGPT".
  private async browserLogin(path: string, ctl: SignInControl, signal: AbortSignal): Promise<SignInResult> {
    let sentUrl = false
    const watch = (text: string) => {
      const url = loginUrl(text)
      if (url && !sentUrl) {
        sentUrl = true
        ctl.progress?.({ stage: 'browser', url, message: 'Finish signing in in your browser.' })
      }
    }
    ctl.progress?.({ stage: 'browser', message: 'Opening the ChatGPT sign-in page...' })
    const r = await this.run({ bin: path, args: LOGIN_ARGS, cwd: this.cwd(), env: this.env(), signal, timeoutMs: SIGN_IN_TIMEOUT, onStderr: watch, onStdoutLine: watch })
    const st = await this.status({ refresh: true })
    if (r.aborted) return { ok: false, message: 'Sign-in cancelled.' }
    if (r.timedOut) return { ok: false, message: 'Sign-in timed out. Try again.' }
    if (st.loggedIn) return { ok: true, message: st.detail }
    return { ok: false, message: lastErrorLine(r.stderr) || `codex login exited with code ${r.code ?? '?'}` }
  }

  // The models the CLI offers for this login (`codex debug models`, best first), cached 10 minutes.
  // [] when the CLI is missing, signed out, or cannot list them (callers fall back to defaults).
  async models(opts: { refresh?: boolean } = {}): Promise<string[]> {
    if (!opts.refresh && this.modelList && this.now() - this.modelList.at < MODELS_TTL) return this.modelList.models
    if (this.modelsPending) return this.modelsPending
    this.modelsPending = (async () => {
      const s = await this.status()
      if (!s.installed || !s.loggedIn || !s.path) return []
      let out = ''
      const r = await this.run({ bin: s.path, args: MODELS_ARGS, cwd: this.cwd(), env: this.env(), timeoutMs: 20_000, onStdoutLine: (l) => (out += `${l}\n`) }).catch(() => null)
      const models = r && r.code === 0 ? parseModelCatalog(out) : []
      this.modelList = { at: this.now(), models }
      return models
    })().finally(() => {
      this.modelsPending = null
    })
    return this.modelsPending
  }

  cancelSignIn(): void {
    this.signingIn?.abort()
  }

  // `codex logout` removes the CLI's stored credentials (this signs the user out of Codex
  // everywhere on this machine, not only in Forge).
  async signOut(): Promise<CodexStatus> {
    const path = this.bin()
    if (path) await this.run({ bin: path, args: LOGOUT_ARGS, cwd: this.cwd(), env: this.env(), timeoutMs: 15_000 }).catch(() => null)
    this.modelList = null
    return this.status({ refresh: true })
  }

  // Why Codex cannot run right now, or null when it can.
  async notReady(): Promise<string | null> {
    const s = await this.status()
    if (!s.installed && s.canInstall) return 'Codex is not set up yet. Use "Sign in with ChatGPT (Codex)" in Settings > Accounts > OpenAI; it installs the Codex CLI for Forge.'
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
    const env = this.env()
    const pass = (updates: CodexUpdate[]) => {
      for (const u of updates) {
        // Warnings about the user's Codex setup go to the output log, never into a chat.
        if (u.kind === 'warning') this.warn(u.text)
        else i.onUpdate?.(u)
      }
    }
    // Image watch: with onImages, updates go through one queue so images found on disk are handed
    // over before the update that follows them ("Made two concepts above").
    const found: string[] = []
    const watch = i.onImages ? new GeneratedImageWatch({ home: codexHome(env), cwd: i.cwd, since: Date.now() }) : null
    if (watch) await watch.prime(i.resumeId).catch(() => undefined)
    let queue: Promise<void> = Promise.resolve()
    let lastScan = 0
    const flush = async () => {
      if (!watch || !i.onImages) return
      lastScan = Date.now()
      const fresh = await watch.scan(mapper.threadId).catch(() => [] as string[])
      if (!fresh.length) return
      found.push(...fresh)
      try {
        await i.onImages(fresh)
      } catch (e) {
        this.deps.log?.(`could not show generated images: ${(e as Error).message}`, 'stderr')
      }
    }
    const r = await this.run({
      bin: path,
      args,
      cwd: i.cwd,
      env,
      stdin: i.prompt,
      signal: i.signal,
      timeoutMs: i.timeoutMs,
      onStdoutLine: (line) => {
        const updates = mapper.line(line)
        if (!watch) return pass(updates)
        queue = queue.then(async () => {
          // Text and tool rows come after an image call; usage ends the turn. Commands stream many
          // updates, so other scans are spaced out.
          const key = updates.some((u) => u.kind === 'text' || u.kind === 'usage' || (u.kind === 'tool' && u.done))
          if (mapper.threadId && (key || Date.now() - lastScan > 500)) await flush()
          try {
            pass(updates)
          } catch (e) {
            this.deps.log?.(`chat update failed: ${(e as Error).message}`, 'stderr')
          }
        })
      }
    })
    await queue
    // Images made before a stop still belong to the chat.
    await flush()
    const out: ExecResult = { threadId: mapper.threadId, lastMessage: mapper.lastMessage, usage: mapper.usage, savedImages: mapper.savedImages, images: found, aborted: r.aborted }
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

  private warn(text: string): void {
    if (this.warned.has(text)) return
    this.warned.add(text)
    this.deps.log?.(`warning: ${text}`, 'info')
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
