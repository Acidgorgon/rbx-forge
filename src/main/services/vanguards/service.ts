// External subprocess manager for Vanguards CLIs (ror, rur, ree) and FM build pipeline.
// Strict GPL boundary: invokes external CLIs/scripts only; zero GPL source in RBX Forge. No electron imports.

import { execFileSync, type ChildProcess } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import {
  DEFAULT_VANGUARDS_MCP_PORT,
  FORBIDDEN_FCM_PLACE_ID,
  VANGUARDS_SETTINGS_KEYS,
  type FmEnvbuildRequest,
  type FmInsertRbxmRequest,
  type FmModelpreviewRequest,
  type ReeRunRequest,
  type RorRunRequest,
  type RurRunRequest,
  type VanguardsRunResult,
  type VanguardsSettings,
  type VanguardsStatus
} from '../../../shared/vanguardsTypes.ts'
import { defaultContext, findPythonCommand, spawnTool, toolEnv, type ToolContext } from '../tools.ts'
import { detectVanguards } from './detect.ts'

export interface VanguardsServiceDeps {
  root?: () => string | null
  settings?: { get<T>(key: string, fallback: T): T; set(key: string, value: unknown): void }
  emit?: (event: 'vanguards:status' | 'vanguards:log', payload: unknown) => void
  log?: (text: string, stream?: 'stdout' | 'stderr' | 'info') => void
  toolCtx?: ToolContext
  defaultMcpPort?: number
  // Optional hook used by insert_rbxm to verify the connected Studio's PlaceId before inserting.
  resolveStudioPlaceId?: (studioId: string) => Promise<number | null>
  // Optional FIFO lock wrapper for Studio-mutating operations (Phase 5 StudioTurnLock).
  withStudioLock?: <T>(owner: string, reason: string, fn: () => Promise<T>) => Promise<T>
}

const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i
const MAX_OUTPUT_CHARS = 128_000
const DEFAULT_RUN_TIMEOUT_MS = 120_000

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

function listImagesInDir(dir: string | undefined): Map<string, number> {
  const map = new Map<string, number>()
  if (!dir) return map
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile() || !IMAGE_EXT_RE.test(entry.name)) continue
      const full = join(dir, entry.name)
      map.set(full, safeMtimeMs(full))
    }
  } catch {
    // directory may not exist yet
  }
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

  constructor(deps: VanguardsServiceDeps = {}) {
    this.deps = deps
    this.bridgePort = deps.defaultMcpPort ?? DEFAULT_VANGUARDS_MCP_PORT
  }

  private ctx(): ToolContext {
    return this.deps.toolCtx ?? defaultContext()
  }

  private workingDir(cwd?: string): string {
    return cwd?.trim() || this.deps.root?.() || process.cwd()
  }

  private getConfiguredDirs(): { binDir?: string | null; fmDir?: string | null; packsDir?: string | null; lunePath?: string | null } {
    const s = this.deps.settings
    return {
      binDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.binDir, null),
      fmDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.fmDir, null),
      packsDir: s?.get<string | null>(VANGUARDS_SETTINGS_KEYS.packsDir, null),
      lunePath: s?.get<string | null>('tests.lunePath', null)
    }
  }

  status(): VanguardsStatus {
    const cfg = this.getConfiguredDirs()
    return detectVanguards({
      ...cfg,
      toolCtx: this.ctx(),
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
    }
    return this.refresh()
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

  dispose(): void {
    this.disposed = true
    const proc = this.bridgeProc
    this.bridgeProc = null
    if (proc && proc.exitCode === null) {
      if (proc.pid) killTree(proc.pid)
      else try { proc.kill() } catch { /* ignore */ }
    }
  }
}
