// Auto-detection of external Vanguards CLI wrappers (ror, rur, ree), Python, Lune, FM pipeline
// scripts, and asset packs. No electron imports; external binaries only (strict GPL boundary).

import { accessSync, constants, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import {
  DEFAULT_VANGUARDS_BIN_DIR,
  DEFAULT_VANGUARDS_FM_DIR,
  DEFAULT_VANGUARDS_PACKS_DIR,
  type FmScriptId,
  type VanguardsPackInfo,
  type VanguardsStatus,
  type VanguardsToolId,
  type VanguardsToolInfo
} from '../../../shared/vanguardsTypes.ts'
import { defaultContext, findPythonCommand, findTool, type ToolContext } from '../tools.ts'

export interface DetectVanguardsOptions {
  binDir?: string | null
  fmDir?: string | null
  packsDir?: string | null
  lunePath?: string | null
  toolCtx?: ToolContext
  mcpBridge?: VanguardsStatus['mcpBridge']
}

const FM_SCRIPT_FILES: Record<FmScriptId, string> = {
  envbuild: 'envbuild.py',
  modelpreview: 'modelpreview.py',
  insert_rbxm: 'insert_rbxm.py',
  mcp_bridge: 'mcp_bridge.py'
}

function isRunnableFile(file: string, platform: NodeJS.Platform = process.platform): boolean {
  try {
    if (!statSync(file).isFile()) return false
    if (platform !== 'win32') accessSync(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

function isExistingFile(file: string): boolean {
  try {
    return statSync(file).isFile()
  } catch {
    return false
  }
}

function resolveInDir(dir: string, name: string, platform: NodeJS.Platform): string | null {
  if (!dir) return null
  const exts = platform === 'win32' ? ['.cmd', '.exe', '.bat', ''] : ['', '.sh']
  for (const ext of exts) {
    const candidate = join(dir, name + ext)
    if (isRunnableFile(candidate, platform)) return candidate
  }
  return null
}

function detectCliTool(
  id: 'ror' | 'rur' | 'ree',
  binDir: string,
  configuredBin: boolean,
  ctx: ToolContext
): VanguardsToolInfo {
  const fromDir = resolveInDir(binDir, id, ctx.platform)
  if (fromDir) {
    return {
      id,
      found: true,
      path: fromDir,
      source: configuredBin ? 'configured' : 'default'
    }
  }
  const onPath = findTool(id, ctx)
  if (onPath) {
    return {
      id,
      found: true,
      path: onPath,
      source: 'path'
    }
  }
  return { id, found: false }
}

function detectPython(ctx: ToolContext): VanguardsToolInfo {
  const cmd = findPythonCommand(ctx)
  if (!cmd) return { id: 'python', found: false }
  return {
    id: 'python',
    found: true,
    path: cmd.file,
    source: 'path'
  }
}

function detectLune(lunePath: string | null | undefined, ctx: ToolContext): VanguardsToolInfo {
  const custom = lunePath?.trim()
  if (custom && isRunnableFile(custom, ctx.platform)) {
    return { id: 'lune', found: true, path: custom, source: 'configured' }
  }
  const onPath = findTool('lune', ctx)
  if (onPath) return { id: 'lune', found: true, path: onPath, source: 'path' }
  return { id: 'lune', found: false }
}

function countPackFiles(dir: string): number {
  let count = 0
  try {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile() && /\.(rbxm|rbxmx|lua|luau)$/i.test(entry.name)) {
        count++
      } else if (entry.isDirectory()) {
        try {
          for (const sub of readdirSync(join(dir, entry.name), { withFileTypes: true })) {
            if (sub.isFile() && /\.(rbxm|rbxmx|lua|luau)$/i.test(sub.name)) count++
          }
        } catch {
          // ignore unreadable subdirs
        }
      }
    }
  } catch {
    // ignore
  }
  return count
}

export function scanPacksDir(packsDir: string): VanguardsPackInfo[] {
  if (!packsDir) return []
  try {
    const entries = readdirSync(packsDir, { withFileTypes: true })
    const out: VanguardsPackInfo[] = []
    for (const e of entries) {
      const full = join(packsDir, e.name)
      if (e.isDirectory()) {
        out.push({ name: e.name, path: full, files: countPackFiles(full) })
      } else if (e.isFile() && /\.(rbxm|rbxmx)$/i.test(e.name)) {
        out.push({ name: e.name, path: full, files: 1 })
      }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name))
  } catch {
    return []
  }
}

export function detectVanguards(opts: DetectVanguardsOptions = {}): VanguardsStatus {
  const ctx = opts.toolCtx ?? defaultContext()
  const configuredBin = Boolean(opts.binDir?.trim())
  const binDir = opts.binDir?.trim() || DEFAULT_VANGUARDS_BIN_DIR
  const fmDir = opts.fmDir?.trim() || DEFAULT_VANGUARDS_FM_DIR
  const packsDir = opts.packsDir?.trim() || DEFAULT_VANGUARDS_PACKS_DIR

  const tools: Record<VanguardsToolId, VanguardsToolInfo> = {
    ror: detectCliTool('ror', binDir, configuredBin, ctx),
    rur: detectCliTool('rur', binDir, configuredBin, ctx),
    ree: detectCliTool('ree', binDir, configuredBin, ctx),
    python: detectPython(ctx),
    lune: detectLune(opts.lunePath, ctx)
  }

  const fmScripts: Record<FmScriptId, { found: boolean; path?: string }> = {
    envbuild: { found: false },
    modelpreview: { found: false },
    insert_rbxm: { found: false },
    mcp_bridge: { found: false }
  }
  for (const id of Object.keys(FM_SCRIPT_FILES) as FmScriptId[]) {
    const candidate = join(fmDir, FM_SCRIPT_FILES[id])
    if (isExistingFile(candidate)) {
      fmScripts[id] = { found: true, path: candidate }
    }
  }

  return {
    binDir,
    fmDir,
    packsDir,
    tools,
    fmScripts,
    packs: scanPacksDir(packsDir),
    mcpBridge: opts.mcpBridge ?? { running: false, port: 7655 }
  }
}
