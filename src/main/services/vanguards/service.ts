// External subprocess manager for Vanguards CLIs (ror, rur, ree) and FM build pipeline.
// Strict GPL boundary: invokes external CLIs/scripts only; zero GPL source in RBX Forge. No electron imports.

import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  DEFAULT_VANGUARDS_BIN_DIR,
  DEFAULT_VANGUARDS_MCP_PORT,
  FORBIDDEN_FCM_PLACE_ID,
  VANGUARDS_SETTINGS_KEYS,
  type FmEnvbuildRequest,
  type FmInsertRbxmRequest,
  type FmModelpreviewRequest,
  type ReeRunRequest,
  type RorPreviewRequest,
  type RorRunRequest,
  type RurRunRequest,
  type RurStoriesResult,
  type RurStoryRenderRequest,
  type VanguardsImageData,
  type VanguardsRepoId,
  type VanguardsRepoUpdateInfo,
  type VanguardsRunResult,
  type VanguardsSettings,
  type VanguardsStatus,
  type VanguardsUpdateResult
} from '../../../shared/vanguardsTypes.ts'
import { MAX_IMAGE_BYTES, imageSize, sniffMime } from '../../agent/chatImages.ts'
import { defaultContext, findPythonCommand, findTool, spawnTool, toolEnv, type ToolContext } from '../tools.ts'
import { detectVanguards } from './detect.ts'

export interface VanguardsServiceDeps {
  root?: () => string | null
  settings?: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit?: (event: 'vanguards:status' | 'vanguards:updates' | 'vanguards:log', payload: unknown) => void
  log?: (text: string, stream?: 'stdout' | 'stderr' | 'info') => void
  toolCtx?: ToolContext
  defaultMcpPort?: number
  // Optional hook used by insert_rbxm to verify the connected Studio's PlaceId before inserting.
  resolveStudioPlaceId?: (studioId: string) => Promise<number | null>
  // Optional FIFO lock wrapper for Studio-mutating operations (Phase 5 StudioTurnLock).
  withStudioLock?: <T>(owner: string, reason: string, fn: () => Promise<T>) => Promise<T>
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp|gif)$/i
const MAX_OUTPUT_CHARS = 128_000
const DEFAULT_RUN_TIMEOUT_MS = 120_000
const PREVIEW_ROOT_DIR = join(tmpdir(), 'rbx-forge-vanguards-previews')
const AUTO_UPDATE_INTERVAL_MS = 15 * 60 * 1000
const REPO_DIRS: Record<VanguardsRepoId, string> = {
  ror: 'roblox-object-renderer',
  rur: 'roblox-ui-renderer',
  ree: 'roblox-engine-emulator'
}

function isInsideDir(targetAbs: string, rootDir: string | null | undefined): boolean {
  if (!rootDir) return false
  const a = process.platform === 'win32' ? resolve(targetAbs).toLowerCase() : resolve(targetAbs)
  const b = process.platform === 'win32' ? resolve(rootDir).toLowerCase() : resolve(rootDir)
  const rel = relative(b, a)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function trimOutput(s: string): string {
  if (s.length <= MAX_OUTPUT_CHARS) return s
  return s.slice(0, MAX_OUTPUT_CHARS) + '\n…(truncated)'
}

function safeMtimeMs(file: string): number {
  try {
    return statSync(file).mtimeMs
  } catch {
    return -1
  }
}

function listImagesInDir(dir: string | undefined, maxDepth = 2): Map<string, number> {
  const map = new Map<string, number>()
  if (!dir) return map
  const walk = (cur: string, depth: number) => {
    try {
      for (const entry of readdirSync(cur, { withFileTypes: true })) {
        const full = join(cur, entry.name)
        if (entry.isFile() && IMAGE_EXT_RE.test(entry.name)) {
          map.set(full, safeMtimeMs(full))
        } else if (entry.isDirectory() && depth < maxDepth) {
          walk(full, depth + 1)
        }
      }
    } catch {
      // directory may not exist yet
    }
  }
  walk(dir, 0)
  return map
}

function findOutArg(args: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if ((a === '--out' || a === '-o' || a === '--output') && args[i + 1]) return args[i + 1]
    if (a.startsWith('--out=')) return a.slice('--out='.length)
    if (a.startsWith('-o=')) return a.slice('-o='.length)
  }
  return undefined
}

function extractImagePathsFromText(text: string, cwd: string): string[] {
  const found = new Set<string>()
  const re = /(?:[A-Za-z]:[\\/][^\s"'<>|*?]+|(?:\.{0,2}[\\/])?[^\s"'<>|*?]+)\.(?:png|jpe?g|webp)\b/gi
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/^["']|["']$/g, '')
    const abs = isAbsolute(raw) ? raw : resolve(cwd, raw)
    if (existsSync(abs)) found.add(abs)
  }
  return [...found]
}

function killTree(pid: number): void {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' })
      return
    } catch {
      // process may already be gone
    }
  }
  try {
    process.kill(pid)
  } catch {
    // ignore
  }
}

export class VanguardsService {
  private deps: VanguardsServiceDeps
  private bridgeProc: ChildProcess | null = null
  private bridgePort: number
  private bridgeError: string | undefined
  private disposed = false
  private allowedImagePaths = new Set<string>()
  private repoStatus: Record<VanguardsRepoId, VanguardsRepoUpdateInfo> | undefined
  private updateTimer: ReturnType<typeof setInterval> | null = null
  private initialUpdateTimer: ReturnType<typeof setTimeout> | null = null

  constructor(deps: VanguardsServiceDeps = {}) {
    this.deps = deps
    this.bridgePort = deps.defaultMcpPort ?? DEFAULT_VANGUARDS_MCP_PORT
    this.syncAutoUpdateTimer()
  }

  private ctx(): ToolContext {
    return this.deps.toolCtx ?? defaultContext()
  }

  private workingDir(cwd?: string): string {
    return cwd?.trim() || this.deps.root?.() || process.cwd()
  }

  private getConfiguredDirs(): {
    binDir?: string | null
    fmDir?: string | null
    packsDir?: string | null
    lunePath?: string | null
    autoUpdateRepos?: boolean
  } {
    const s = this.deps.settings
    return {
      binDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.binDir, null),
      fmDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.fmDir, null),
      packsDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.packsDir, null),
      lunePath: s?.get<string | null>('tests.lunePath', null),
      autoUpdateRepos: Boolean(s?.get<boolean>(VANGUARDS_SETTINGS_KEYS.autoUpdateRepos, false))
    }
  }

  status(): VanguardsStatus {
    const cfg = this.getConfiguredDirs()
    const effectiveBinDir = cfg.binDir?.trim() || DEFAULT_VANGUARDS_BIN_DIR
    const base = basename(effectiveBinDir).toLowerCase() === 'bin' ? dirname(effectiveBinDir) : effectiveBinDir
    return detectVanguards({
      ...cfg,
      toolCtx: this.ctx(),
      repos: this.repoStatus ?? this.emptyRepoMap(base),
      mcpBridge: {
        running: Boolean(this.bridgeProc && this.bridgeProc.exitCode === null),
        port: this.bridgePort,
        ...(this.bridgeProc?.pid ? { pid: this.bridgeProc.pid } : {}),
        ...(this.bridgeError ? { lastError: this.bridgeError } : {})
      }
    })
  }

  refresh(): VanguardsStatus {
    const st = this.status()
    this.deps.emit?.('vanguards:status', st)
    return st
  }

  setSettings(patch: Partial<VanguardsSettings>): VanguardsStatus {
    const s = this.deps.settings
    if (s) {
      if (typeof patch.binDir === 'string') s.set(VANGUARDS_SETTINGS_KEYS.binDir, patch.binDir.trim() || null)
      if (typeof patch.fmDir === 'string') s.set(VANGUARDS_SETTINGS_KEYS.fmDir, patch.fmDir.trim() || null)
      if (typeof patch.packsDir === 'string') s.set(VANGUARDS_SETTINGS_KEYS.packsDir, patch.packsDir.trim() || null)
      if (typeof patch.autoUpdateRepos === 'boolean') s.set(VANGUARDS_SETTINGS_KEYS.autoUpdateRepos, patch.autoUpdateRepos)
    }
    this.syncAutoUpdateTimer()
    return this.refresh()
  }

  private rememberImages(paths: Iterable<string>): void {
    for (const p of paths) {
      const abs = resolve(p)
      this.allowedImagePaths.add(abs)
      if (this.allowedImagePaths.size > 500) {
        const oldest = this.allowedImagePaths.values().next().value
        if (oldest) this.allowedImagePaths.delete(oldest)
      }
    }
  }

  private buildEnv(extra: Record<string, string | undefined>, st: VanguardsStatus): NodeJS.ProcessEnv {
    const env = toolEnv(this.ctx())
    // Default VG_HOME when a custom binDir is structured as <vg_home>/bin
    if (!env.VG_HOME && /[\\/]bin$/i.test(st.binDir)) {
      env.VG_HOME = st.binDir.replace(/[\\/]bin$/i, '')
    }
    if (this.bridgeProc && this.bridgeProc.exitCode === null) {
      env.RUR_STUDIO_MCP_PORT = String(this.bridgePort)
      env.ROR_STUDIO_MCP = `127.0.0.1:${this.bridgePort}`
    }
    for (const [k, v] of Object.entries(extra)) {
      if (v !== undefined) env[k] = v
    }
    return env
  }

  private logLine(stream: 'stdout' | 'stderr' | 'info', text: string): void {
    const trimmed = text.trimEnd()
    if (!trimmed) return
    this.deps.log?.(trimmed, stream)
    this.deps.emit?.('vanguards:log', { stream, text: trimmed, at: Date.now() })
  }

  private spawnAndCollect(
    file: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    timeoutMs: number,
    watchOutDir?: string
  ): Promise<VanguardsRunResult> {
    const t0 = Date.now()
    const resolvedOut = watchOutDir ? (isAbsolute(watchOutDir) ? watchOutDir : resolve(cwd, watchOutDir)) : undefined
    const beforeImages = listImagesInDir(resolvedOut)

    return new Promise((resolveRun) => {
      let stdout = ''
      let stderr = ''
      let timedOut = false
      let settled = false

      let child: ChildProcess
      try {
        child = spawnTool(file, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
      } catch (e) {
        const msg = (e as Error).message
        resolveRun({
          ok: false,
          code: 1,
          stdout: '',
          stderr: msg,
          durationMs: Date.now() - t0,
          error: msg
        })
        return
      }

      const timer = setTimeout(() => {
        timedOut = true
        if (child.pid) killTree(child.pid)
        else child.kill()
      }, Math.max(1000, timeoutMs))
      ;(timer as { unref?: () => void }).unref?.()

      child.stdout?.setEncoding('utf8')
      child.stderr?.setEncoding('utf8')
      child.stdout?.on('data', (chunk: string) => {
        stdout = trimOutput(stdout + chunk)
        this.logLine('stdout', chunk)
      })
      child.stderr?.on('data', (chunk: string) => {
        stderr = trimOutput(stderr + chunk)
        this.logLine('stderr', chunk)
      })

      const finish = (code: number, errMsg?: string) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        const afterImages = listImagesInDir(resolvedOut)
        const images = new Set<string>()
        for (const [img, mtime] of afterImages) {
          const prev = beforeImages.get(img)
          if (prev === undefined || mtime > prev) images.add(img)
        }
        // If no newly timestamped images matched, include any images mentioned in output text.
        for (const img of extractImagePathsFromText(stdout + '\n' + stderr, cwd)) {
          images.add(img)
        }
        // Fallback: if resolvedOut exists and has sheet.jpg or *.png newly created/existing when none diffed
        if (images.size === 0 && afterImages.size > 0) {
          for (const img of afterImages.keys()) images.add(img)
        }

        let outputPath: string | undefined
        if (resolvedOut && existsSync(join(resolvedOut, 'final.rbxm'))) {
          outputPath = join(resolvedOut, 'final.rbxm')
        }
        if (images.size) this.rememberImages(images)

        const finalStderr = timedOut ? `${stderr}\nTimed out after ${timeoutMs} ms`.trim() : stderr
        resolveRun({
          ok: !timedOut && !errMsg && code === 0,
          code: timedOut ? 124 : code,
          stdout,
          stderr: finalStderr,
          durationMs: Date.now() - t0,
          ...(images.size ? { images: [...images] } : {}),
          ...(outputPath ? { outputPath } : {}),
          ...(timedOut ? { error: `Timed out after ${timeoutMs} ms` } : errMsg ? { error: errMsg } : {})
        })
      }

      child.on('error', (err) => finish(1, err.message))
      child.on('close', (code) => finish(code ?? 1))
    })
  }

  async runRor(req: RorRunRequest): Promise<VanguardsRunResult> {
    const st = this.status()
    const tool = st.tools.ror
    if (!tool.found || !tool.path) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `ror executable not found in ${st.binDir} or PATH` }
    }
    const cwd = this.workingDir(req.cwd)
    const outDir = req.outDir ?? findOutArg(req.args)
    const env = this.buildEnv({ ROR_BACKEND: 'dx12', ROR_MEMORY_FLOOR_GB: '2' }, st)
    return this.spawnAndCollect(tool.path, req.args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, outDir)
  }

  async runRur(req: RurRunRequest): Promise<VanguardsRunResult> {
    const st = this.status()
    const tool = st.tools.rur
    if (!tool.found || !tool.path) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `rur executable not found in ${st.binDir} or PATH` }
    }
    const cwd = this.workingDir(req.cwd)
    const outDir = req.outDir ?? findOutArg(req.args)
    const env = this.buildEnv({}, st)
    return this.spawnAndCollect(tool.path, req.args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, outDir)
  }

  async runRee(req: ReeRunRequest): Promise<VanguardsRunResult> {
    const st = this.status()
    const tool = st.tools.ree
    if (!tool.found || !tool.path) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `ree executable not found in ${st.binDir} or PATH` }
    }
    const cwd = this.workingDir(req.cwd)
    const env = this.buildEnv({}, st)
    return this.spawnAndCollect(tool.path, req.args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
  }

  private resolvePythonCmd(st: VanguardsStatus): { file: string; prefixArgs: string[] } | null {
    const cmd = findPythonCommand(this.ctx())
    if (cmd) return { file: cmd.file, prefixArgs: cmd.args }
    if (st.tools.python.found && st.tools.python.path) {
      return { file: st.tools.python.path, prefixArgs: [] }
    }
    return null
  }

  async fmEnvbuild(req: FmEnvbuildRequest): Promise<VanguardsRunResult> {
    const st = this.status()
    const script = st.fmScripts.envbuild
    if (!script.found || !script.path) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `envbuild.py not found in ${st.fmDir}` }
    }
    const py = this.resolvePythonCmd(st)
    if (!py) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: 'Python 3 executable not found' }
    }
    const args: string[] = [...py.prefixArgs, script.path, req.module]
    if (req.fn) args.push('--fn', req.fn)
    if (req.argsJson) args.push('--args', req.argsJson)
    if (req.time !== undefined) args.push('--time', String(req.time))
    if (req.views) args.push('--views', req.views)
    if (req.focus) args.push('--focus', req.focus)
    if (req.cameraJson) args.push('--camera', req.cameraJson)
    if (req.size) args.push('--size', req.size)
    if (req.outDir) args.push('--out', req.outDir)
    if (req.lightingFrom) args.push('--lighting-from', req.lightingFrom)

    const cwd = this.workingDir()
    const env = this.buildEnv({ ROR_BACKEND: 'dx12', ROR_MEMORY_FLOOR_GB: '2' }, st)
    return this.spawnAndCollect(py.file, args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, req.outDir)
  }

  async fmModelpreview(req: FmModelpreviewRequest): Promise<VanguardsRunResult> {
    const st = this.status()
    const script = st.fmScripts.modelpreview
    if (!script.found || !script.path) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `modelpreview.py not found in ${st.fmDir}` }
    }
    const py = this.resolvePythonCmd(st)
    if (!py) {
      return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: 'Python 3 executable not found' }
    }
    const args: string[] = [...py.prefixArgs, script.path, req.modelPath]
    if (req.views) args.push('--views', req.views)
    if (req.size) args.push('--size', req.size)
    if (req.focus) args.push('--focus', req.focus)
    if (req.background) args.push('--background', req.background)
    if (req.ids) args.push('--ids')
    if (req.outDir) args.push('--out', req.outDir)

    const cwd = this.workingDir()
    const env = this.buildEnv({ ROR_BACKEND: 'dx12', ROR_MEMORY_FLOOR_GB: '2' }, st)
    return this.spawnAndCollect(py.file, args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS, req.outDir)
  }

  async fmInsertRbxm(req: FmInsertRbxmRequest): Promise<VanguardsRunResult> {
    const blockedMsg = `Refused: place ${FORBIDDEN_FCM_PLACE_ID} is Football Club Manager (Forge-Sync linked); changes must go through its repo, never insert_rbxm`
    if (req.placeId === FORBIDDEN_FCM_PLACE_ID || req.studioId.includes(String(FORBIDDEN_FCM_PLACE_ID))) {
      return { ok: false, code: 1, stdout: '', stderr: blockedMsg, durationMs: 0, error: blockedMsg }
    }
    if (this.deps.resolveStudioPlaceId) {
      const detectedPlace = await this.deps.resolveStudioPlaceId(req.studioId).catch(() => null)
      if (detectedPlace === FORBIDDEN_FCM_PLACE_ID) {
        return { ok: false, code: 1, stdout: '', stderr: blockedMsg, durationMs: 0, error: blockedMsg }
      }
    }

    const runInsert = async (): Promise<VanguardsRunResult> => {
      const st = this.status()
      const script = st.fmScripts.insert_rbxm
      if (!script.found || !script.path) {
        return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: `insert_rbxm.py not found in ${st.fmDir}` }
      }
      const py = this.resolvePythonCmd(st)
      if (!py) {
        return { ok: false, code: 1, stdout: '', stderr: '', durationMs: 0, error: 'Python 3 executable not found' }
      }
      const args: string[] = [...py.prefixArgs, script.path, req.studioId, req.filePath]
      if (req.parent) args.push('--parent', req.parent)
      if (req.at) args.push('--at', req.at)
      if (req.replace) args.push('--replace')
      if (req.select) args.push('--select')

      const cwd = this.workingDir()
      const env = this.buildEnv({}, st)
      return this.spawnAndCollect(py.file, args, cwd, env, req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS)
    }

    if (this.deps.withStudioLock) {
      return this.deps.withStudioLock('vanguards:insert_rbxm', `Insert ${req.filePath} into Studio (${req.studioId})`, runInsert)
    }
    return runInsert()
  }

  async startMcpBridge(port = this.bridgePort): Promise<VanguardsStatus> {
    if (this.disposed) return this.status()
    if (this.bridgeProc && this.bridgeProc.exitCode === null) {
      if (this.bridgePort === port) return this.status()
      await this.stopMcpBridge()
    }
    const st = this.status()
    const script = st.fmScripts.mcp_bridge
    if (!script.found || !script.path) {
      this.bridgeError = `mcp_bridge.py not found in ${st.fmDir}`
      return this.refresh()
    }
    const py = this.resolvePythonCmd(st)
    if (!py) {
      this.bridgeError = 'Python 3 executable not found'
      return this.refresh()
    }

    this.bridgePort = Math.max(1024, Math.min(65535, Math.floor(port)))
    this.bridgeError = undefined
    const cwd = this.workingDir()
    const env = this.buildEnv({}, st)

    const proc = spawnTool(py.file, [...py.prefixArgs, script.path, String(this.bridgePort)], {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    this.bridgeProc = proc
    proc.stdout?.setEncoding('utf8')
    proc.stderr?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => this.logLine('stdout', `[mcp_bridge] ${chunk}`))
    proc.stderr?.on('data', (chunk: string) => {
      this.bridgeError = chunk.trim() || this.bridgeError
      this.logLine('stderr', `[mcp_bridge] ${chunk}`)
    })
    proc.on('error', (e) => {
      this.bridgeError = e.message
      if (this.bridgeProc === proc) this.bridgeProc = null
      this.refresh()
    })
    proc.on('close', () => {
      if (this.bridgeProc === proc) this.bridgeProc = null
      if (!this.disposed) this.refresh()
    })

    // Brief yield to catch immediate bind failure without delaying responsiveness.
    await new Promise<void>((r) => {
      const t = setTimeout(r, 120)
      ;(t as { unref?: () => void }).unref?.()
    })
    return this.refresh()
  }

  async stopMcpBridge(): Promise<VanguardsStatus> {
    const proc = this.bridgeProc
    this.bridgeProc = null
    if (proc) {
      if (proc.pid && proc.exitCode === null) killTree(proc.pid)
      else try { proc.kill() } catch { /* ignore */ }
    }
    return this.refresh()
  }

  private previewOutDir(prefix: string): string {
    const dir = join(PREVIEW_ROOT_DIR, `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`)
    mkdirSync(dir, { recursive: true })
    return dir
  }

  private resolveRurProjectArg(root: string): string {
    if (existsSync(join(root, 'rur.json'))) return root
    const rojoProj = join(root, 'default.project.json')
    if (existsSync(rojoProj)) return rojoProj
    return root
  }

  readImage(filePath: string): VanguardsImageData | null {
    const raw = filePath?.trim()
    if (!raw) return null
    const abs = resolve(raw)
    const st = this.status()
    const allowed =
      this.allowedImagePaths.has(abs) ||
      isInsideDir(abs, PREVIEW_ROOT_DIR) ||
      isInsideDir(abs, this.deps.root?.()) ||
      isInsideDir(abs, st.packsDir) ||
      isInsideDir(abs, st.fmDir)
    if (!allowed) return null

    try {
      const info = statSync(abs)
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return null
      const buf = readFileSync(abs)
      const mime = sniffMime(buf)
      if (!mime) return null
      const dims = imageSize(buf)
      return {
        path: abs,
        name: basename(abs),
        mime,
        bytes: buf.byteLength,
        ...(dims ? { width: dims.width, height: dims.height } : {}),
        dataUrl: `data:${mime};base64,${buf.toString('base64')}`
      }
    } catch {
      return null
    }
  }

  async listRurStories(projectRoot?: string): Promise<RurStoriesResult> {
    const root = projectRoot?.trim() || this.workingDir()
    const projArg = this.resolveRurProjectArg(root)
    const res = await this.runRur({
      args: ['stories', '--project', projArg],
      cwd: root,
      timeoutMs: 30_000
    })
    if (!res.ok) {
      return { ok: false, stories: [], error: res.error || res.stderr || 'Failed to list rur stories' }
    }
    const seen = new Set<string>()
    const stories: string[] = []
    for (const line of res.stdout.split(/\r?\n/)) {
      const trimmed = line.trim().replace(/^["']|["']$/g, '')
      if (!trimmed || !/\.story\.luau?$/i.test(trimmed)) continue
      const abs = isAbsolute(trimmed) ? resolve(trimmed) : resolve(root, trimmed)
      const out = isInsideDir(abs, root) ? relative(root, abs).replace(/\\/g, '/') : trimmed.replace(/\\/g, '/')
      if (!seen.has(out)) {
        seen.add(out)
        stories.push(out)
      }
    }
    return { ok: true, stories }
  }

  async renderRurStory(req: RurStoryRenderRequest): Promise<VanguardsRunResult> {
    const root = req.projectRoot?.trim() || this.workingDir()
    const storyAbs = isAbsolute(req.story) ? req.story : resolve(root, req.story)
    const outDir = this.previewOutDir(req.compare ? 'rur-cmp' : 'rur')
    const projArg = this.resolveRurProjectArg(root)

    const args: string[] = [
      req.compare ? 'compare' : 'render',
      '--story',
      storyAbs,
      '--project',
      projArg,
      '--out',
      outDir
    ]
    if (req.width && req.height) {
      args.push('--viewport', `${Math.round(req.width)}x${Math.round(req.height)}`)
    }
    if (req.compare) {
      if (req.time !== undefined) args.push('--time', String(req.time))
    } else {
      if (req.scale !== undefined) args.push('--scale', String(req.scale))
      if (req.device) args.push('--device', req.device)
      if (req.mode) args.push('--mode', req.mode)
      if (req.time !== undefined) args.push('--time', String(req.time))
      if (req.allLayers) args.push('--all-layers')
      if (req.placeholders) args.push('--placeholders')
      args.push('--json')
    }
    return this.runRur({ args, cwd: root, outDir, timeoutMs: req.timeoutMs ?? 60_000 })
  }

  async launchRurNative(storyFile?: string): Promise<{ ok: boolean; pid?: number; error?: string }> {
    const st = this.status()
    const tool = st.tools.rur
    if (!tool.found || !tool.path) {
      return { ok: false, error: `rur executable not found in ${st.binDir} or PATH` }
    }
    const root = this.workingDir()
    const projArg = this.resolveRurProjectArg(root)
    const args = ['native', '--project', projArg]
    if (storyFile?.trim()) {
      const storyAbs = isAbsolute(storyFile.trim()) ? storyFile.trim() : resolve(root, storyFile.trim())
      args.push('--story', storyAbs)
    }
    try {
      const child = spawnTool(tool.path, args, {
        cwd: root,
        env: this.buildEnv({}, st),
        stdio: 'ignore',
        detached: true
      })
      child.unref()
      return { ok: true, pid: child.pid }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  }

  async renderRorPreview(req: RorPreviewRequest): Promise<VanguardsRunResult> {
    const cwd = this.workingDir()
    const modelAbs = isAbsolute(req.modelPath) ? req.modelPath : resolve(cwd, req.modelPath)
    const outDir = this.previewOutDir(req.subcommand === 'cost' ? 'ror-cost' : 'ror')
    const subcommand = req.subcommand ?? 'render'
    const args: string[] = [subcommand, modelAbs, '--out', outDir]
    if (req.size?.trim()) args.push('--size', req.size.trim())
    if (req.views?.trim()) args.push('--views', req.views.trim())
    return this.runRor({ args, cwd, outDir, timeoutMs: req.timeoutMs ?? DEFAULT_RUN_TIMEOUT_MS })
  }

  private vgBaseDir(st: VanguardsStatus): string {
    return basename(st.binDir).toLowerCase() === 'bin' ? dirname(st.binDir) : st.binDir
  }

  private async execTool(file: string, args: string[], cwd: string, timeoutMs: number): Promise<VanguardsRunResult> {
    const st = this.status()
    const env = this.buildEnv({}, st)
    return this.spawnAndCollect(file, args, cwd, env, timeoutMs)
  }

  private gitCmd(): string {
    return findTool('git', this.ctx()) ?? 'git'
  }

  private async inspectSingleRepo(id: VanguardsRepoId, repoDir: string, fetchRemote: boolean): Promise<VanguardsRepoUpdateInfo> {
    const now = Date.now()
    if (!existsSync(join(repoDir, '.git'))) {
      return { id, repoDir, found: false, behind: 0, dirty: false, status: 'missing', lastCheckedAt: now }
    }
    const git = this.gitCmd()
    let lastError: string | undefined
    if (fetchRemote) {
      const f = await this.execTool(git, ['fetch', '--quiet'], repoDir, 30_000)
      if (!f.ok) lastError = f.stderr.trim() || f.error || 'git fetch failed'
    }
    const brRes = await this.execTool(git, ['rev-parse', '--abbrev-ref', 'HEAD'], repoDir, 10_000)
    const shaRes = await this.execTool(git, ['rev-parse', '--short', 'HEAD'], repoDir, 10_000)
    const upShaRes = await this.execTool(git, ['rev-parse', '--short', '@{u}'], repoDir, 10_000)
    const cntRes = await this.execTool(git, ['rev-list', '--count', 'HEAD..@{u}'], repoDir, 10_000)
    const stRes = await this.execTool(git, ['status', '--porcelain'], repoDir, 10_000)

    const behind = cntRes.ok ? Math.max(0, parseInt(cntRes.stdout.trim(), 10) || 0) : 0
    const dirty = stRes.ok && stRes.stdout.trim().length > 0
    const status: VanguardsRepoUpdateInfo['status'] = lastError && !upShaRes.ok
      ? 'error'
      : behind > 0
        ? 'update-available'
        : lastError
          ? 'error'
          : 'up-to-date'

    return {
      id,
      repoDir,
      found: true,
      ...(brRes.ok ? { branch: brRes.stdout.trim() } : {}),
      ...(shaRes.ok ? { localSha: shaRes.stdout.trim() } : {}),
      ...(upShaRes.ok ? { remoteSha: upShaRes.stdout.trim() } : {}),
      behind,
      dirty,
      status,
      lastCheckedAt: now,
      ...(lastError ? { lastError } : {})
    }
  }

  private emptyRepoMap(base: string): Record<VanguardsRepoId, VanguardsRepoUpdateInfo> {
    const fallback = (id: VanguardsRepoId): VanguardsRepoUpdateInfo => {
      if (this.repoStatus?.[id]) return this.repoStatus[id]
      const repoDir = join(base, REPO_DIRS[id])
      const found = existsSync(join(repoDir, '.git'))
      return { id, repoDir, found, behind: 0, dirty: false, status: found ? 'up-to-date' : 'missing' }
    }
    return {
      ror: fallback('ror'),
      rur: fallback('rur'),
      ree: fallback('ree')
    }
  }

  async checkRepoUpdates(): Promise<Record<VanguardsRepoId, VanguardsRepoUpdateInfo>> {
    const st = this.status()
    const base = this.vgBaseDir(st)
    const ids: VanguardsRepoId[] = ['ror', 'rur', 'ree']
    const next = this.emptyRepoMap(base)
    await Promise.all(
      ids.map(async (id) => {
        next[id] = await this.inspectSingleRepo(id, join(base, REPO_DIRS[id]), true)
      })
    )
    this.repoStatus = next
    this.deps.emit?.('vanguards:updates', next)
    this.refresh()
    return next
  }

  async updateTools(target: VanguardsRepoId | 'all'): Promise<VanguardsUpdateResult> {
    const st = this.status()
    const base = this.vgBaseDir(st)
    const ids: VanguardsRepoId[] = target === 'all' ? ['ror', 'rur', 'ree'] : [target]
    const repos = this.emptyRepoMap(base)
    const git = this.gitCmd()
    const results: VanguardsUpdateResult['results'] = []
    let allOk = true

    for (const id of ids) {
      const repoDir = join(base, REPO_DIRS[id])
      if (!existsSync(join(repoDir, '.git'))) {
        repos[id] = { id, repoDir, found: false, behind: 0, dirty: false, status: 'missing', lastCheckedAt: Date.now() }
        results.push({ id, updated: false, rebuilt: false, message: 'Repository not found' })
        continue
      }

      const dirtyRes = await this.execTool(git, ['status', '--porcelain'], repoDir, 10_000)
      if (dirtyRes.stdout.trim().length > 0) {
        allOk = false
        repos[id] = await this.inspectSingleRepo(id, repoDir, false)
        results.push({ id, updated: false, rebuilt: false, message: 'Skipped: local uncommitted changes in repo' })
        continue
      }

      const beforeRes = await this.execTool(git, ['rev-parse', 'HEAD'], repoDir, 10_000)
      const beforeSha = beforeRes.stdout.trim()

      repos[id] = { ...(repos[id] ?? { id, repoDir, found: true, behind: 0, dirty: false }), status: 'updating' }
      this.repoStatus = { ...repos }
      this.deps.emit?.('vanguards:updates', this.repoStatus)

      const pullRes = await this.execTool(git, ['pull', '--ff-only'], repoDir, 90_000)
      if (!pullRes.ok) {
        allOk = false
        repos[id] = { ...(await this.inspectSingleRepo(id, repoDir, false)), status: 'error', lastError: pullRes.stderr.trim() || pullRes.error || 'git pull failed' }
        results.push({ id, updated: false, rebuilt: false, message: pullRes.stderr.trim() || 'git pull --ff-only failed', output: pullRes.stdout })
        continue
      }

      const afterRes = await this.execTool(git, ['rev-parse', 'HEAD'], repoDir, 10_000)
      const afterSha = afterRes.stdout.trim()

      if (!beforeSha || beforeSha === afterSha) {
        repos[id] = await this.inspectSingleRepo(id, repoDir, false)
        results.push({ id, updated: false, rebuilt: false, message: 'Already up to date' })
        continue
      }

      const diffRes = await this.execTool(git, ['diff', '--name-only', beforeSha, afterSha], repoDir, 10_000)
      const changedFiles = diffRes.stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)

      let rebuilt = false
      let buildOutput = pullRes.stdout
      let buildFailed = false

      if (id === 'ror' || id === 'ree') {
        if (existsSync(join(repoDir, 'Cargo.toml'))) {
          const cargo = findTool('cargo', this.ctx())
          if (cargo) {
            this.logLine('info', `Rebuilding ${id} release binary via cargo build --release…`)
            const b = await this.execTool(cargo, ['build', '--release'], repoDir, 600_000)
            buildOutput = [buildOutput, b.stdout, b.stderr].filter(Boolean).join('\n')
            if (b.ok) rebuilt = true
            else {
              buildFailed = true
              allOk = false
            }
          }
        }
      } else if (id === 'rur') {
        if (changedFiles.some((f) => f === 'package.json' || f === 'package-lock.json') && existsSync(join(repoDir, 'package.json'))) {
          const npm = findTool('npm', this.ctx())
          if (npm) {
            const b = await this.execTool(npm, ['install'], repoDir, 180_000)
            buildOutput = [buildOutput, b.stdout, b.stderr].filter(Boolean).join('\n')
            if (b.ok) rebuilt = true
            else {
              buildFailed = true
              allOk = false
            }
          }
        }
        if (changedFiles.some((f) => f.startsWith('native/')) && existsSync(join(repoDir, 'native', 'Cargo.toml')) && existsSync(join(repoDir, 'native', 'target'))) {
          const cargo = findTool('cargo', this.ctx())
          if (cargo) {
            const b = await this.execTool(cargo, ['build', '--release'], join(repoDir, 'native'), 600_000)
            buildOutput = [buildOutput, b.stdout, b.stderr].filter(Boolean).join('\n')
            if (b.ok) rebuilt = true
            else {
              buildFailed = true
              allOk = false
            }
          }
        }
      }

      const inspected = await this.inspectSingleRepo(id, repoDir, false)
      repos[id] = {
        ...inspected,
        status: buildFailed ? 'error' : 'updated',
        ...(buildFailed ? { lastError: 'Rebuild failed after pull' } : {})
      }
      results.push({
        id,
        updated: true,
        rebuilt,
        message: buildFailed
          ? `Pulled ${afterSha.slice(0, 7)} but rebuild failed`
          : rebuilt
            ? `Updated to ${afterSha.slice(0, 7)} & rebuilt`
            : `Updated to ${afterSha.slice(0, 7)}`,
        output: buildOutput
      })
    }

    this.repoStatus = { ...this.emptyRepoMap(base), ...repos }
    this.deps.emit?.('vanguards:updates', this.repoStatus)
    this.refresh()
    return { ok: allOk, results, repos: this.repoStatus }
  }

  private syncAutoUpdateTimer(): void {
    const enabled = Boolean(this.deps.settings?.get<boolean>(VANGUARDS_SETTINGS_KEYS.autoUpdateRepos, false))
    if (!enabled) {
      if (this.updateTimer) {
        clearInterval(this.updateTimer)
        this.updateTimer = null
      }
      if (this.initialUpdateTimer) {
        clearTimeout(this.initialUpdateTimer)
        this.initialUpdateTimer = null
      }
      return
    }
    if (this.disposed || this.updateTimer) return

    const runCycle = async () => {
      if (this.disposed) return
      try {
        const repos = await this.checkRepoUpdates()
        const needsUpdate = (['ror', 'rur', 'ree'] as const).filter((id) => repos[id]?.found && !repos[id].dirty && repos[id].behind > 0)
        for (const id of needsUpdate) {
          await this.updateTools(id)
        }
      } catch {
        // background auto-update check should never throw unhandled rejections
      }
    }

    this.initialUpdateTimer = setTimeout(() => {
      this.initialUpdateTimer = null
      void runCycle()
    }, 5_000)
    ;(this.initialUpdateTimer as { unref?: () => void }).unref?.()

    this.updateTimer = setInterval(() => {
      void runCycle()
    }, AUTO_UPDATE_INTERVAL_MS)
    ;(this.updateTimer as { unref?: () => void }).unref?.()
  }

  dispose(): void {
    this.disposed = true
    if (this.updateTimer) {
      clearInterval(this.updateTimer)
      this.updateTimer = null
    }
    if (this.initialUpdateTimer) {
      clearTimeout(this.initialUpdateTimer)
      this.initialUpdateTimer = null
    }
    const proc = this.bridgeProc
    this.bridgeProc = null
    if (proc && proc.exitCode === null) {
      if (proc.pid) killTree(proc.pid)
      else try { proc.kill() } catch { /* ignore */ }
    }
  }
}
