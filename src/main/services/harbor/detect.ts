// Project detection for Harbor Family Stack: Current, Ripple, Anchor, Tide, Lighthouse.
// Scans rokit.toml, wally.toml, src/, tools/, schema files (**/*.ripple, **/*.blink, current-schema.luau),
// LibsConfig.luau toggles, and CLI binaries (~/.rokit/bin + PATH). No electron imports.

import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { HARBOR_LIB_IDS, type HarborLibId, type HarborLibStatus, type HarborStatus } from '../../../shared/harborTypes.ts'
import { parseWallyManifest } from '../packages.ts'
import { aliasPath, parseRokitToml } from '../setup/toolchain.ts'
import { defaultContext, findTool, type ToolContext } from '../tools.ts'
import { findLibsConfigFile, mapKeyToHarborLib, parseLibsConfig } from './libsConfig.ts'

const DISPLAY_NAMES: Record<HarborLibId, string> = {
  current: 'Current',
  ripple: 'Ripple',
  anchor: 'Anchor',
  tide: 'Tide',
  lighthouse: 'Lighthouse'
}

const IGNORE_DIRS = new Set(['.git', '.forge', 'node_modules', 'Packages', 'DevPackages', 'ServerPackages', 'out', 'dist'])

function readTextSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

function matchLibFromName(name: string): HarborLibId | undefined {
  const lower = name.toLowerCase()
  for (const id of HARBOR_LIB_IDS) {
    if (lower === id || lower === `${id}.luau` || lower === `${id}.lua` || lower.startsWith(`${id}-`) || lower.endsWith(`.${id}`)) {
      return id
    }
  }
  return undefined
}

function resolveHarborCli(cmdName: string, ctx: ToolContext): string | undefined {
  const rokitShim = aliasPath(ctx, cmdName)
  if (existsSync(rokitShim)) return rokitShim
  return findTool(cmdName, ctx) ?? undefined
}

export function detectHarborProject(
  root: string | null,
  opts: { toolCtx?: ToolContext; watcherActive?: boolean; lastGenerate?: HarborStatus['lastGenerate'] } = {}
): HarborStatus {
  const ctx = opts.toolCtx ?? defaultContext()

  const libs: Record<HarborLibId, HarborLibStatus> = {
    current: { id: 'current', name: 'Current', detected: false, sourcePaths: [], schemaFiles: [] },
    ripple: { id: 'ripple', name: 'Ripple', detected: false, sourcePaths: [], schemaFiles: [] },
    anchor: { id: 'anchor', name: 'Anchor', detected: false, sourcePaths: [], schemaFiles: [] },
    tide: { id: 'tide', name: 'Tide', detected: false, sourcePaths: [], schemaFiles: [] },
    lighthouse: { id: 'lighthouse', name: 'Lighthouse', detected: false, sourcePaths: [], schemaFiles: [] }
  }

  // CLI lookup works globally (Rokit shims + PATH), refined below by project rokit.toml pins.
  const currentCli = resolveHarborCli('current', ctx)
  const blinkCli = resolveHarborCli('blink', ctx)
  const rippleCli = resolveHarborCli('ripple', ctx)
  if (currentCli || blinkCli) libs.current.cliPath = currentCli ?? blinkCli
  if (rippleCli) libs.ripple.cliPath = rippleCli

  if (!root || !existsSync(root)) {
    return {
      projectRoot: root,
      libs,
      toggles: [],
      watcherActive: opts.watcherActive ?? false,
      ...(opts.lastGenerate ? { lastGenerate: opts.lastGenerate } : {})
    }
  }

  // 1. rokit.toml
  const rokitText = readTextSafe(join(root, 'rokit.toml'))
  if (rokitText) {
    const pinned = parseRokitToml(rokitText)
    for (const [alias, spec] of pinned) {
      const libId = mapKeyToHarborLib(alias) ?? (spec.id.toLowerCase().includes('current') ? 'current' : undefined)
      if (!libId) continue
      libs[libId].detected = true
      libs[libId].version = spec.version
      const shim = resolveHarborCli(alias, ctx)
      if (shim) libs[libId].cliPath = shim
    }
  }

  // 2. wally.toml
  const wallyText = readTextSafe(join(root, 'wally.toml'))
  if (wallyText) {
    for (const dep of parseWallyManifest(wallyText)) {
      const libId = mapKeyToHarborLib(dep.alias) ?? HARBOR_LIB_IDS.find((id) => dep.name.toLowerCase().includes(id) || dep.scope.toLowerCase().includes(id))
      if (!libId) continue
      libs[libId].detected = true
      if (!libs[libId].version) libs[libId].version = dep.version
    }
  }

  // 3. Walk workspace for vendored src/* modules and schema files (.ripple, .blink, tools/current-schema.luau)
  const walk = (absDir: string, relDir: string, depth: number) => {
    let entries
    try {
      entries = readdirSync(absDir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      if (IGNORE_DIRS.has(e.name)) continue
      const rel = relDir ? `${relDir}/${e.name}` : e.name
      const abs = join(absDir, e.name)

      if (e.isDirectory()) {
        // Detect src/shared/<Lib> or top-level matching folders under src/
        if (relDir === 'src/shared' || relDir === 'src/server' || relDir === 'src/client' || relDir === 'src') {
          const id = matchLibFromName(e.name)
          if (id) {
            libs[id].detected = true
            if (!libs[id].sourcePaths.includes(rel)) libs[id].sourcePaths.push(rel)
          }
        }
        if (depth < 6) walk(abs, rel, depth + 1)
        continue
      }

      if (!e.isFile()) continue

      // Schema files
      if (rel === 'tools/current-schema.luau' || rel === 'tools/current-schema.lua' || e.name.endsWith('.blink')) {
        libs.current.detected = true
        if (!libs.current.schemaFiles.includes(rel)) libs.current.schemaFiles.push(rel)
      }
      if (e.name.endsWith('.ripple')) {
        libs.ripple.detected = true
        if (!libs.ripple.schemaFiles.includes(rel)) libs.ripple.schemaFiles.push(rel)
      }

      // Direct source file match under src/shared etc.
      if (relDir === 'src/shared' || relDir === 'src/server' || relDir === 'src/client') {
        const id = matchLibFromName(e.name)
        if (id) {
          libs[id].detected = true
          if (!libs[id].sourcePaths.includes(rel)) libs[id].sourcePaths.push(rel)
        }
      }
    }
  }
  walk(root, '', 0)

  // 4. LibsConfig.luau boolean toggles
  const libsConfigRel = findLibsConfigFile(root)
  const toggles = libsConfigRel ? parseLibsConfig(readTextSafe(join(root, ...libsConfigRel.split('/'))) ?? '') : []
  for (const t of toggles) {
    if (!t.libId) continue
    const entry = libs[t.libId]
    entry.detected = true
    if (entry.enabled === undefined) {
      entry.enabled = t.value
      entry.configKey = t.key
    }
  }

  for (const id of HARBOR_LIB_IDS) {
    libs[id].name = DISPLAY_NAMES[id]
    libs[id].sourcePaths.sort()
    libs[id].schemaFiles.sort()
  }

  return {
    projectRoot: root,
    ...(libsConfigRel ? { libsConfigPath: libsConfigRel } : {}),
    libs,
    toggles,
    watcherActive: opts.watcherActive ?? false,
    ...(opts.lastGenerate ? { lastGenerate: opts.lastGenerate } : {})
  }
}
