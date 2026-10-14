import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { defaultContext, envGet, findTool, toolEnv, type ToolContext } from '../tools.ts'
import { errorLine, spawnRunner, type CommandRunner } from './runner.ts'

// Forge's own toolchain: a rokit binary ships inside the app (build/rokit-binaries.mjs ->
// resources/rokit/<os>-<arch>, packaged as <resources>/rokit). On first launch the app runs the
// bundled `rokit self-install` (copies rokit to ~/.rokit/bin and adds that folder to PATH: shell
// env files on macOS/Linux, the user Path in the registry on Windows; no admin rights), then
// `rokit add --global --force <id>@<version> <alias>` for each pinned tool. --force is what lets a
// non-interactive caller install a tool rokit has not been told to trust (rokit's trust prompt
// bails when stderr is not a terminal; see rokit src/cli/add.rs and src/util/prompts.rs).
//
// Global tools are a fallback: inside a project, rokit's per-project rokit.toml still wins.

export const ROKIT_VERSION = '1.2.0'

export interface PinnedTool {
  alias: string
  id: string
  version: string
  purpose: string
}

// Versions match the GenTree template's rokit.toml (rojo, wally, blink) and the versions Forge's
// features are tested with (lune, luau-lsp, selene, stylua, wally-package-types).
export const PINNED_TOOLS: PinnedTool[] = [
  { alias: 'rojo', id: 'rojo-rbx/rojo', version: '7.7.0', purpose: 'Syncs files into Studio' },
  { alias: 'wally', id: 'UpliftGames/wally', version: '0.3.2', purpose: 'Package manager' },
  { alias: 'blink', id: '1Axen/blink', version: '0.18.1', purpose: 'Network event compiler' },
  { alias: 'lune', id: 'lune-org/lune', version: '0.11.0', purpose: 'Runs Luau tests' },
  { alias: 'luau-lsp', id: 'JohnnyMorganz/luau-lsp', version: '1.69.0', purpose: 'Editor language server' },
  { alias: 'selene', id: 'Kampfkarren/selene', version: '0.32.0', purpose: 'Linter' },
  { alias: 'stylua', id: 'JohnnyMorganz/StyLua', version: '2.5.2', purpose: 'Formatter' },
  { alias: 'wally-package-types', id: 'JohnnyMorganz/wally-package-types', version: '1.6.2', purpose: 'Types for Wally packages' }
]

// Tool ids Forge installs without rokit's trust prompt in a project's `rokit install`.
export const KNOWN_TOOL_IDS = new Set(PINNED_TOOLS.map((t) => t.id.toLowerCase()))

// ---------------------------------------------------------------- environment

export interface ToolchainFs {
  exists(file: string): boolean
  read(file: string): string | null
}

export const nodeFs: ToolchainFs = {
  exists: (file) => existsSync(file),
  read: (file) => {
    try {
      return readFileSync(file, 'utf8')
    } catch {
      return null
    }
  }
}

export interface ToolchainEnv {
  ctx: ToolContext
  fs: ToolchainFs
  runner: CommandRunner
  // The rokit binary shipped with the app, or null (development builds without one).
  bundledRokit: string | null
}

export function defaultToolchainEnv(bundledRokit: string | null): ToolchainEnv {
  return { ctx: defaultContext(), fs: nodeFs, runner: spawnRunner, bundledRokit }
}

function p(ctx: ToolContext): path.PlatformPath {
  return ctx.platform === 'win32' ? path.win32 : path.posix
}

function exe(ctx: ToolContext, name: string): string {
  return ctx.platform === 'win32' ? `${name}.exe` : name
}

// rokit's home: $ROKIT_ROOT, else ~/.rokit (rokit lib/storage/home.rs).
export function rokitHome(ctx: ToolContext): string {
  const root = envGet(ctx.env, 'ROKIT_ROOT', ctx.platform)
  if (root) return root
  const home = (ctx.platform === 'win32' && envGet(ctx.env, 'USERPROFILE', ctx.platform)) || ctx.home
  return p(ctx).join(home, '.rokit')
}

export function rokitPaths(ctx: ToolContext): { home: string; bin: string; rokit: string; manifest: string; storage: string } {
  const home = rokitHome(ctx)
  const j = p(ctx).join
  return { home, bin: j(home, 'bin'), rokit: j(home, 'bin', exe(ctx, 'rokit')), manifest: j(home, 'rokit.toml'), storage: j(home, 'tool-storage') }
}

// Where rokit keeps an installed tool version: tool-storage/<author>/<name>/<version>/<name>[.exe],
// author and name lower-cased (rokit lib/storage/tool_storage.rs tool_paths).
export function storedToolPath(ctx: ToolContext, id: string, version: string): string {
  const [author, name] = id.toLowerCase().split('/')
  return p(ctx).join(rokitPaths(ctx).storage, author, name, version, exe(ctx, name))
}

export function aliasPath(ctx: ToolContext, alias: string): string {
  return p(ctx).join(rokitPaths(ctx).bin, exe(ctx, alias.toLowerCase()))
}

export interface ToolSpec {
  id: string
  version: string
}

// [tools] of a rokit.toml: alias = "author/name@version". Comments and other tables are ignored.
export function parseRokitToml(text: string): Map<string, ToolSpec> {
  const out = new Map<string, ToolSpec>()
  let inTools = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, '').trim()
    if (!line || line.startsWith('#')) continue
    const table = /^\[\s*([^\]]+?)\s*\]$/.exec(line)
    if (table) {
      inTools = table[1] === 'tools'
      continue
    }
    if (!inTools) continue
    const m = /^(?:"([^"]+)"|'([^']+)'|([A-Za-z0-9_-]+))\s*=\s*["']([^"'@\s]+\/[^"'@\s]+)@([^"'\s]+)["']$/.exec(line)
    if (m) out.set((m[1] ?? m[2] ?? m[3]).toLowerCase(), { id: m[4], version: m[5].replace(/^v/, '') })
  }
  return out
}

// ---------------------------------------------------------------- status

export type ToolState = 'ok' | 'other' | 'broken' | 'external' | 'missing'

export interface ToolStatus {
  alias: string
  id: string
  purpose: string
  pinned: string
  // Version in rokit's global manifest, when rokit manages it.
  version: string | null
  // ok: pinned version installed; other: rokit has another version (after Update); broken: in
  // rokit's manifest but its files are gone; external: found on PATH outside rokit; missing.
  state: ToolState
  path: string | null
}

export interface RokitStatus {
  installed: boolean
  path: string | null
  version: string | null
  bundled: boolean
  bundledVersion: string
  // ~/.rokit/bin, which Forge always searches first (tools.ts buildToolPath).
  binDir: string
}

export interface GitInfo {
  available: boolean
  path: string | null
  version: string | null
  // Why git is missing and what to do about it (per platform).
  hint?: string
  downloadUrl?: string
}

export type SetupRecord = 'never' | 'done' | 'skipped'

export interface ToolchainStatus {
  platform: NodeJS.Platform
  rokit: RokitStatus
  tools: ToolStatus[]
  git: GitInfo
  // rokit or a pinned tool is missing or broken.
  needsSetup: boolean
  // What the person last did on the first-run screen.
  record: SetupRecord
}

export function detectTools(env: Pick<ToolchainEnv, 'ctx' | 'fs'>, tools: PinnedTool[] = PINNED_TOOLS): ToolStatus[] {
  const { ctx, fs } = env
  const manifest = parseRokitToml(fs.read(rokitPaths(ctx).manifest) ?? '')
  return tools.map((tool) => {
    const base = { alias: tool.alias, id: tool.id, purpose: tool.purpose, pinned: tool.version }
    const spec = manifest.get(tool.alias.toLowerCase())
    const link = aliasPath(ctx, tool.alias)
    if (spec) {
      const healthy = fs.exists(link) && fs.exists(storedToolPath(ctx, spec.id, spec.version))
      if (healthy) return { ...base, version: spec.version, state: spec.version === tool.version ? 'ok' : 'other', path: link }
      return { ...base, version: spec.version, state: 'broken', path: null }
    }
    const found = findTool(tool.alias, ctx)
    if (found) {
      // A rokit link from a project-only install also lives in ~/.rokit/bin.
      return { ...base, version: null, state: 'external', path: found }
    }
    return { ...base, version: null, state: 'missing', path: null }
  })
}

export async function detectRokit(env: ToolchainEnv): Promise<RokitStatus> {
  const { rokit, bin } = rokitPaths(env.ctx)
  const installed = env.fs.exists(rokit)
  const found = installed ? rokit : findTool('rokit', env.ctx)
  let version: string | null = null
  if (found) {
    const out = await env.runner(found, ['--version'], { cwd: env.ctx.home, env: toolEnv(env.ctx), timeoutMs: 15_000 })
    version = out.code === 0 ? (/(\d+\.\d+\.\d+)/.exec(out.output)?.[1] ?? null) : null
  }
  return { installed: !!found, path: found, version, bundled: !!env.bundledRokit, bundledVersion: ROKIT_VERSION, binDir: bin }
}

export function gitHint(platform: NodeJS.Platform): { hint: string; downloadUrl: string } {
  if (platform === 'win32') {
    return {
      hint: 'Git is not installed. Forge needs it to create and sync projects. Install Git for Windows (the defaults are fine), then press Check again.',
      downloadUrl: 'https://git-scm.com/downloads/win'
    }
  }
  if (platform === 'darwin') {
    return {
      hint: 'Git is not installed. Run "xcode-select --install" in Terminal (Apple\'s command line tools include git), or install it from git-scm.com.',
      downloadUrl: 'https://git-scm.com/downloads/mac'
    }
  }
  return { hint: 'Git is not installed. Install it with your package manager (for example "sudo apt install git").', downloadUrl: 'https://git-scm.com/downloads/linux' }
}

// Runs `git --version`: on macOS /usr/bin/git exists even without the command line tools and only
// works once they are installed, so finding the file is not enough.
export async function detectGit(env: ToolchainEnv): Promise<GitInfo> {
  const file = findTool('git', env.ctx)
  if (file) {
    const out = await env.runner(file, ['--version'], { cwd: env.ctx.home, env: toolEnv(env.ctx), timeoutMs: 15_000 })
    const version = /git version (\S+)/.exec(out.output)?.[1] ?? null
    if (out.code === 0 && version) return { available: true, path: file, version }
  }
  return { available: false, path: file, version: null, ...gitHint(env.ctx.platform) }
}

export async function toolchainStatus(env: ToolchainEnv, record: SetupRecord): Promise<ToolchainStatus> {
  const [rokit, git] = await Promise.all([detectRokit(env), detectGit(env)])
  const tools = detectTools(env)
  const needsSetup = !rokit.installed || tools.some((t) => t.state === 'missing' || t.state === 'broken')
  return { platform: env.ctx.platform, rokit, tools, git, needsSetup, record }
}

// ---------------------------------------------------------------- setup

export type SetupMode = 'install' | 'repair' | 'update'
export type SetupStepState = 'running' | 'done' | 'skipped' | 'failed'

export interface SetupProgress {
  // 'rokit' or a tool alias.
  step: string
  state: SetupStepState
  message?: string
}

export interface SetupStepResult {
  step: string
  state: Exclude<SetupStepState, 'running'>
  message?: string
}

export interface SetupResult {
  ok: boolean
  cancelled: boolean
  // Some step failed because GitHub could not be reached (offline, proxy, rate limit).
  network: boolean
  steps: SetupStepResult[]
}

export interface SetupOptions {
  mode: SetupMode
  // Aliases to work on; all pinned tools when omitted.
  tools?: string[]
  onProgress?: (progress: SetupProgress) => void
  signal?: AbortSignal
  timeoutMs?: number
}

const NETWORK = /error sending request|request failed|dns|resolve host|timed out|connection (refused|reset|closed)|network|unreachable|tcp connect|certificate|proxy|tls|offline/i
const RATE_LIMIT = /rate limit|403 forbidden|status code 403|API rate/i

// Turns a failed rokit run into one sentence the person can act on.
export function explainFailure(output: string): { message: string; network: boolean } {
  if (RATE_LIMIT.test(output)) {
    return { message: 'GitHub refused the download (rate limit). Wait a few minutes and press Retry, or sign rokit in with "rokit authenticate github".', network: true }
  }
  if (NETWORK.test(output)) {
    return { message: 'Could not reach GitHub to download the tool. Check your internet connection or proxy, then press Retry.', network: true }
  }
  const line = errorLine(output)
  return { message: line || 'rokit failed without saying why.', network: false }
}

function semverLess(a: string | null, b: string): boolean {
  if (!a) return true
  const x = a.split('.').map(Number)
  const y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) < (y[i] ?? 0)
  return false
}

export async function runSetup(env: ToolchainEnv, options: SetupOptions): Promise<SetupResult> {
  const progress = options.onProgress ?? (() => {})
  const steps: SetupStepResult[] = []
  let network = false
  const finish = (step: string, state: SetupStepResult['state'], message?: string) => {
    steps.push({ step, state, message })
    progress({ step, state, message })
  }
  const cancelled = () => !!options.signal?.aborted
  const runEnv = { ...toolEnv(env.ctx), CLICOLOR: '0', TERM: 'dumb', RUST_BACKTRACE: '0' }
  const run = (file: string, args: string[], step: string) =>
    env.runner(file, args, {
      cwd: env.ctx.home,
      env: runEnv,
      onLine: (line) => progress({ step, state: 'running', message: line }),
      signal: options.signal,
      timeoutMs: options.timeoutMs
    })
  const selected = PINNED_TOOLS.filter((t) => !options.tools || options.tools.includes(t.alias))

  // 1. rokit itself.
  const paths = rokitPaths(env.ctx)
  const status = await detectRokit(env)
  let rokit: string | null = env.fs.exists(paths.rokit) ? paths.rokit : status.path
  const wantSelfInstall =
    !!env.bundledRokit && (options.mode === 'repair' || !env.fs.exists(paths.rokit) || semverLess(status.version, ROKIT_VERSION))
  if (wantSelfInstall) {
    progress({ step: 'rokit', state: 'running', message: `rokit ${ROKIT_VERSION} self-install` })
    const out = await run(env.bundledRokit!, ['self-install'], 'rokit')
    if (cancelled()) {
      finish('rokit', 'skipped', 'Cancelled')
    } else if (out.code === 0 && env.fs.exists(paths.rokit)) {
      rokit = paths.rokit
      finish('rokit', 'done', `rokit ${ROKIT_VERSION} in ${paths.bin}`)
    } else if (rokit) {
      finish('rokit', 'failed', `Could not update rokit (${errorLine(out.output)}); using the installed one.`)
    } else {
      // The bundled binary still works from the app folder for this session.
      rokit = env.bundledRokit
      finish('rokit', 'failed', `rokit self-install failed: ${errorLine(out.output) || 'no output'}. Tools are installed with the bundled copy.`)
    }
  } else if (rokit) {
    finish('rokit', 'done', status.version ? `rokit ${status.version} already installed` : 'rokit already installed')
  } else {
    finish('rokit', 'failed', 'This build of Forge does not include rokit and it is not installed. Install it from github.com/rojo-rbx/rokit, then press Retry.')
  }

  // 2. tools.
  const current = new Map(detectTools(env).map((t) => [t.alias, t]))
  for (const tool of selected) {
    const step = tool.alias
    if (cancelled()) {
      finish(step, 'skipped', 'Cancelled')
      continue
    }
    if (!rokit) {
      finish(step, 'skipped', 'Needs rokit')
      continue
    }
    const now = current.get(tool.alias)
    if (options.mode === 'install' && now && (now.state === 'ok' || now.state === 'other' || now.state === 'external')) {
      finish(step, 'skipped', now.state === 'external' ? `Found at ${now.path}` : `${now.version} already installed`)
      continue
    }
    const update = options.mode === 'update' && now && now.version !== null && now.state !== 'broken'
    const args = update
      ? ['update', '--global', tool.alias]
      : ['add', '--global', '--force', options.mode === 'update' ? tool.id : `${tool.id}@${tool.version}`, tool.alias]
    progress({ step, state: 'running', message: `rokit ${args.join(' ')}` })
    const out = await run(rokit, args, step)
    if (cancelled()) {
      finish(step, 'skipped', 'Cancelled')
      continue
    }
    if (out.code === 0) {
      const after = detectTools(env, [tool])[0]
      finish(step, 'done', after.version ? `${after.version} installed` : 'Installed')
    } else {
      const why = explainFailure(out.output)
      network ||= why.network
      finish(step, 'failed', why.message)
    }
  }
  return { ok: steps.every((s) => s.state !== 'failed'), cancelled: cancelled(), network, steps }
}

// ---------------------------------------------------------------- per-project tools

export interface ProjectToolCheck {
  // Specs in the project's rokit.toml whose files are not in rokit's tool storage.
  missing: (ToolSpec & { alias: string })[]
  // Missing tools Forge does not know, so rokit would ask to trust them first.
  untrusted: string[]
}

export function checkProjectTools(env: Pick<ToolchainEnv, 'ctx' | 'fs'>, root: string): ProjectToolCheck {
  const text = env.fs.read(p(env.ctx).join(root, 'rokit.toml'))
  if (!text) return { missing: [], untrusted: [] }
  const missing = [...parseRokitToml(text)]
    .filter(([, spec]) => !env.fs.exists(storedToolPath(env.ctx, spec.id, spec.version)))
    .map(([alias, spec]) => ({ alias, ...spec }))
  const untrusted = missing.filter((m) => !KNOWN_TOOL_IDS.has(m.id.toLowerCase())).map((m) => m.id)
  return { missing, untrusted }
}

export interface ProjectInstallResult {
  state: 'none' | 'done' | 'failed' | 'needsTrust' | 'noRokit'
  message?: string
  tools: string[]
}

// `rokit install` in a project whose pinned tools are missing. Tools Forge knows are installed
// without a prompt (--no-trust-check); a project that pins other tools is left for the person to
// trust (Packages page, or `rokit install` in a terminal).
export async function installProjectTools(
  env: ToolchainEnv,
  root: string,
  onLine?: (line: string) => void,
  signal?: AbortSignal
): Promise<ProjectInstallResult> {
  const check = checkProjectTools(env, root)
  const tools = check.missing.map((m) => `${m.alias} ${m.version}`)
  if (!check.missing.length) return { state: 'none', tools }
  if (check.untrusted.length) {
    return {
      state: 'needsTrust',
      tools,
      message: `This project pins tools Forge has not vetted (${check.untrusted.join(', ')}). Install them from Packages > Rokit or run "rokit install" in a terminal.`
    }
  }
  const paths = rokitPaths(env.ctx)
  const rokit = env.fs.exists(paths.rokit) ? paths.rokit : findTool('rokit', env.ctx) ?? env.bundledRokit
  if (!rokit) return { state: 'noRokit', tools, message: 'rokit is not installed. Run the toolchain setup in Settings > Toolchain.' }
  const out = await env.runner(rokit, ['install', '--no-trust-check'], {
    cwd: root,
    env: { ...toolEnv(env.ctx), CLICOLOR: '0', TERM: 'dumb' },
    onLine,
    signal
  })
  if (out.code === 0) return { state: 'done', tools }
  return { state: 'failed', tools, message: explainFailure(out.output).message }
}
