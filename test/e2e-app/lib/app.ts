// Launches the built app (out/) with Playwright's _electron API in an isolated sandbox: a temp HOME
// and XDG_CONFIG_HOME (so userData = <tmp>/config/rbx-forge, see src/main/index.ts), no API keys or
// cloud credentials in the environment, a pre-seeded settings.json (toolchain gate skipped, the
// fixture project as the last project) and main + renderer error collection.

import { execSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

export const REPO = resolve(import.meta.dirname, '..', '..', '..')
export const BRIDGE_PORT = 34877

// Playwright's types are not a dependency of this repo; the suite only uses this surface.
/* eslint-disable @typescript-eslint/no-explicit-any */
export type Page = any
export type ElectronApp = any

export interface AppError {
  source: 'main' | 'renderer' | 'pageerror'
  text: string
  at: number
  flow?: string
}

// Messages that are noise from running Chromium under Xvfb in a container, not app bugs.
export const IGNORED_ERRORS: RegExp[] = [
  /dbus/i,
  /Gtk-WARNING|GLib-GIO|libva|vaInitialize|VA-API/i,
  /gpu_init|GPU process|viz_main|gles2|angle|egl|Vulkan|vulkan|ContextResult::kFatalFailure|SharedImageManager/i,
  /Fontconfig/i,
  /Autofill\.(enable|setAddresses)/i,
  /ERROR:bus\.cc|ERROR:object_proxy|ERROR:kwallet|ERROR:browser_main_loop/i,
  /Failed to connect to the bus/i,
  /\[sync\]|\[studio\]/ // the app's own log lines that go to stderr are checked per flow, not here
]

export async function loadPlaywright(): Promise<{ _electron: { launch(opts: object): Promise<ElectronApp> } }> {
  const fromEnv = process.env.PLAYWRIGHT_PATH
  const dir = fromEnv || join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'playwright')
  return (await import(pathToFileURL(join(dir, 'index.mjs')).href)) as never
}

export async function portFree(port: number): Promise<boolean> {
  return new Promise((done) => {
    const s = createServer()
    s.once('error', () => done(false))
    s.listen(port, '127.0.0.1', () => s.close(() => done(true)))
  })
}

// Environment for the app: keep PATH/DISPLAY/locale, drop anything that could carry a credential.
const CREDENTIAL = /^GIT_|KEY|TOKEN|SECRET|PASSWORD|ANTHROPIC|CLAUDE|OPENAI|OPENROUTER|GEMINI|GOOGLE|AWS_|AZURE|BEDROCK|VERTEX|GH_|GITHUB|ROBLOX|PROXY/i

export function appEnv(home: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined || CREDENTIAL.test(k)) continue
    if (k === 'ELECTRON_RENDERER_URL' || k === 'ELECTRON_RUN_AS_NODE' || k === 'NODE_OPTIONS') continue
    env[k] = v
  }
  env.HOME = home
  env.XDG_CONFIG_HOME = join(home, 'config')
  env.XDG_DATA_HOME = join(home, 'data')
  env.XDG_CACHE_HOME = join(home, 'cache')
  env.GIT_CONFIG_NOSYSTEM = '1'
  env.FORGE_E2E = '1'
  return env
}

export interface Sandbox {
  home: string
  userData: string
  projectsDir: string
}

export function makeSandbox(): Sandbox {
  const home = mkdtempSync(join(tmpdir(), 'forge-e2e-home-'))
  const userData = join(home, 'config', 'rbx-forge')
  const projectsDir = join(home, 'Roblox')
  mkdirSync(userData, { recursive: true })
  mkdirSync(projectsDir, { recursive: true })
  writeFileSync(join(home, '.gitconfig'), '[user]\n\tname = Forge E2E\n\temail = e2e@forge.test\n[init]\n\tdefaultBranch = main\n')
  return { home, userData, projectsDir }
}

export function seedSettings(sandbox: Sandbox, settings: Record<string, unknown>): void {
  writeFileSync(join(sandbox.userData, 'settings.json'), JSON.stringify(settings, null, 2))
}

export interface Launched {
  app: ElectronApp
  page: Page
  errors: AppError[]
  mainLog: string[]
  currentFlow: { name?: string }
  // How many renderer / main errors earlier flows already accounted for.
  seen: { errors: number; main: number }
  // false when launched with WebGL turned off (the webgl-off flow).
  webgl: boolean
}

export interface LaunchOptions {
  width?: number
  height?: number
  // false: Chromium without WebGL (--disable-3d-apis), to check the previews' fallback message.
  webgl?: boolean
}

export async function launchApp(sandbox: Sandbox, opts: LaunchOptions = {}): Promise<Launched> {
  const { _electron } = await loadPlaywright()
  const executablePath = join(REPO, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  const errors: AppError[] = []
  const mainLog: string[] = []
  const currentFlow: { name?: string } = {}
  const push = (source: AppError['source'], text: string) => {
    if (IGNORED_ERRORS.some((r) => r.test(text))) return
    errors.push({ source, text: text.slice(0, 2000), at: Date.now(), flow: currentFlow.name })
  }
  const app = await _electron.launch({
    executablePath,
    // Software WebGL (SwiftShader) so the labs' three.js previews render under Xvfb.
    args: [REPO, '--no-sandbox', '--disable-gpu-sandbox', ...(opts.webgl === false ? ['--disable-3d-apis'] : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'])],
    cwd: REPO,
    env: appEnv(sandbox.home),
    timeout: 60_000
  })
  const proc = app.process()
  const onMain = (chunk: Buffer, stream: string) => {
    for (const line of chunk.toString('utf8').split('\n')) {
      if (!line.trim()) continue
      mainLog.push(`[${stream}] ${line}`)
      if (/Uncaught|Unhandled|UnhandledPromiseRejection|TypeError|ReferenceError|SyntaxError|A JavaScript error occurred/i.test(line)) push('main', line)
    }
  }
  proc.stdout?.on('data', (c: Buffer) => onMain(c, 'out'))
  proc.stderr?.on('data', (c: Buffer) => onMain(c, 'err'))
  // Main-process uncaught exceptions / rejections, recorded inside the app.
  await app.evaluate(() => {
    const g = globalThis as unknown as { __e2eErrors: string[] }
    g.__e2eErrors = []
    process.on('uncaughtException', (e) => g.__e2eErrors.push(`uncaughtException: ${e?.stack ?? e}`))
    process.on('unhandledRejection', (e) => g.__e2eErrors.push(`unhandledRejection: ${(e as Error)?.stack ?? e}`))
  })
  const page = await app.firstWindow({ timeout: 60_000 })
  page.on('console', (m: { type(): string; text(): string }) => {
    if (m.type() === 'error') push('renderer', m.text())
  })
  page.on('pageerror', (e: Error) => push('pageerror', `${e.message}\n${e.stack ?? ''}`))
  await page.waitForLoadState('domcontentloaded')
  if (opts.width || opts.height) await setWindowSize(app, opts.width ?? 1400, opts.height ?? 900)
  return { app, page, errors, mainLog, currentFlow, seen: { errors: 0, main: 0 }, webgl: opts.webgl !== false }
}

export async function mainErrors(app: ElectronApp): Promise<string[]> {
  return app.evaluate(() => (globalThis as unknown as { __e2eErrors?: string[] }).__e2eErrors ?? [])
}

export async function setWindowSize(app: ElectronApp, width: number, height: number): Promise<void> {
  await app.evaluate(({ BrowserWindow }: { BrowserWindow: { getAllWindows(): { setMinimumSize(w: number, h: number): void; setSize(w: number, h: number): void }[] } }, size: { width: number; height: number }) => {
    const w = BrowserWindow.getAllWindows()[0]
    w.setMinimumSize(Math.min(size.width, 400), Math.min(size.height, 300))
    w.setSize(size.width, size.height)
  }, { width, height })
}
