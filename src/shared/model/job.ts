// "Build in Studio" for the Model Lab: the Forge Bridge job (plugin v10 'model' kind) that carries the
// BlockyKit module and the build script as two ModuleScripts. Roblox refuses a script Source of
// 200,000 characters or more, so the kit and the build script travel as separate modules and each
// is checked before the job is queued (ModuleTooLargeError explains which one and what to do).
// No electron imports.

import { BRIDGE_VERSION, type BridgeJob, type BridgeModule } from '../studio/protocol.ts'

export const MODEL_PLUGIN_VERSION = 10
export const SOURCE_LIMIT = 200_000
export const MAX_JOB_SOURCE = SOURCE_LIMIT - 1
export const KIT_MODULE = 'BlockyKit'
export const BUILD_MODULE = 'Build'

export class ModuleTooLargeError extends Error {}

// Roblox counts the Source in bytes (UTF-8); a JS string's length undercounts non-ASCII text.
export function sourceLength(source: string): number {
  return new TextEncoder().encode(String(source ?? '')).length
}

export function assertModuleSizes(modules: BridgeModule[], path: string[] = []): void {
  for (const m of modules) {
    const at = [...path, m.name]
    const n = m.source ? sourceLength(m.source) : 0
    if (n >= MAX_JOB_SOURCE) {
      const what = m.name === BUILD_MODULE ? 'the build script' : `the module ${at.join('.')}`
      throw new ModuleTooLargeError(
        `Forge: ${what} is ${n.toLocaleString('en-US')} characters, and Roblox only accepts scripts shorter than ${SOURCE_LIMIT.toLocaleString('en-US')}. ${m.name === BUILD_MODULE ? 'Shorten it (loops and helper functions instead of repeated lines) and try again.' : 'This is a Forge bug; please report it.'}`
      )
    }
    if (m.children) assertModuleSizes(m.children, at)
  }
}

// "Workspace.Guards.SharkGuard" -> ["Workspace", "Guards", "SharkGuard"] (game. prefix dropped).
export function guardPath(text: string | undefined | null): string[] {
  const parts = String(text ?? '')
    .split('.')
    .map((s) => s.trim())
    .filter(Boolean)
  if (parts[0]?.toLowerCase() === 'game') parts.shift()
  return parts.slice(0, 20)
}

export function modelJob(opts: { id: string; name: string; kit: string; script: string; guard?: string[]; areaId?: string }): BridgeJob {
  const modules: BridgeModule[] = [
    { name: KIT_MODULE, className: 'ModuleScript', source: opts.kit },
    { name: BUILD_MODULE, className: 'ModuleScript', source: opts.script }
  ]
  assertModuleSizes(modules)
  const name = String(opts.name ?? '').replace(/[^\w ()-]+/g, '').trim().slice(0, 80) || 'BlockModel'
  return {
    id: opts.id,
    version: BRIDGE_VERSION,
    kind: 'model',
    mode: 'realtime',
    name,
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: { pos: [0, 0, 0], target: [0, 0, -1], fov: 70 },
    modules,
    entry: BUILD_MODULE,
    calibrate: false,
    key: [0, 0, 0],
    linger: 0,
    timeout: 60,
    ...(opts.guard?.length || opts.areaId ? { model: { ...(opts.guard?.length ? { guard: opts.guard } : {}), ...(opts.areaId ? { areaId: opts.areaId } : {}) } } : {})
  }
}

// The plugin's report: the 'log' event of a model job carries {"built": name, "parts": n, "path": "Workspace.X"}.
export function parseBuiltLog(message: string): { name: string; parts: number; path: string } | null {
  try {
    const j = JSON.parse(message) as { built?: unknown; parts?: unknown; path?: unknown }
    if (typeof j.built !== 'string') return null
    return { name: j.built, parts: Number(j.parts) || 0, path: typeof j.path === 'string' ? j.path : `Workspace.${j.built}` }
  } catch {
    return null
  }
}
