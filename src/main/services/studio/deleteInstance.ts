// "Delete in Studio" (Game tab): queues a delete job for the connected Forge Bridge plugin (v7+) on the
// same job channel as Studio checks. Forge refuses services and anything the project maps (sync
// service deleteRefusal); the plugin refuses again against the live DataModel (same-name siblings,
// synced roots) and removes the instance inside a ChangeHistoryService recording, so Ctrl+Z in Studio
// restores it. No electron imports (tested in test/studioDelete.test.ts).

import { BridgeError, type EventHandler, type RunOptions } from './bridge.ts'
import { BRIDGE_VERSION, newJobId, type BridgeJob } from '../../../shared/studio/protocol.ts'
import { collapseInstancePaths } from '../../../shared/explorerSelection.ts'

// The first plugin version that knows delete jobs (an older one would treat it as an effect job).
export const DELETE_PLUGIN_VERSION = 7

export interface DeleteBridge {
  connected(): boolean
  studio(): { pluginVersion?: number } | null
  busy(): BridgeJob | null
  run(job: BridgeJob, handler: EventHandler, opts?: RunOptions): Promise<void>
}

export interface DeleteDeps {
  bridge: DeleteBridge
  // Why this path must not be deleted (project mapping, no sync session), or null.
  refusal: (path: string[]) => string | null | Promise<string | null>
  newId?: () => string
}

export function deleteJob(path: string[], className: string | undefined, id: string = newJobId()): BridgeJob {
  return {
    id,
    version: BRIDGE_VERSION,
    kind: 'delete',
    mode: 'realtime',
    name: path.join('.').slice(0, 200),
    rig: 'R15',
    duration: 0,
    beats: [],
    camera: { pos: [0, 0, 0], target: [0, 0, 0], fov: 70 },
    modules: [],
    calibrate: false,
    key: [0, 0, 0],
    linger: 0,
    timeout: 20,
    target: className ? { path: [...path], className } : { path: [...path] }
  }
}

// Why Delete in Studio is not available right now (for the menu's disabled reason), or null.
export async function deleteUnavailable(deps: DeleteDeps, path: string[]): Promise<string | null> {
  const b = deps.bridge
  if (!b.connected()) return 'Studio is not connected: open the place in Studio with the Forge Bridge plugin on'
  const v = b.studio()?.pluginVersion ?? 0
  if (v < DELETE_PLUGIN_VERSION) return `Studio runs Forge Bridge v${v || '?'}; restart Studio to load v${DELETE_PLUGIN_VERSION}, which can delete`
  return (await deps.refusal(path)) ?? null
}

export async function deleteInStudio(deps: DeleteDeps, path: string[], className?: string): Promise<void> {
  const why = await deleteUnavailable(deps, path)
  if (why) throw new Error(why)
  if (deps.bridge.busy()) throw new Error('A Studio check is running; delete again when it finishes')
  const job = deleteJob(path, className, deps.newId?.())
  try {
    await deps.bridge.run(job, () => ({}), { acceptTimeoutMs: 10_000, timeoutMs: 20_000 })
  } catch (e) {
    if (e instanceof BridgeError && e.code === 'plugin-error') throw new Error(e.message.replace(/^Studio: /, ''))
    if (e instanceof BridgeError && e.code === 'busy') throw new Error('A Studio check is running; delete again when it finishes')
    throw e
  }
}

export interface DeleteManyResult {
  deleted: string[][]
  failed: { instancePath: string[]; error: string }[]
}

// Explorer multi-select "Delete N in Studio": one delete job per instance, one after another (the
// bridge runs one job at a time), behind one confirmation. An instance inside another listed one goes
// with it; one that fails (refused, plugin error) is reported and the rest still run. Stops early only
// when Studio disconnects, reporting the rest as not deleted.
export async function deleteManyInStudio(deps: DeleteDeps, items: { instancePath: string[]; className?: string }[]): Promise<DeleteManyResult> {
  const result: DeleteManyResult = { deleted: [], failed: [] }
  for (const it of collapseInstancePaths(items)) {
    if (!deps.bridge.connected()) {
      result.failed.push({ instancePath: it.instancePath, error: 'Studio disconnected' })
      continue
    }
    try {
      await deleteInStudio(deps, it.instancePath, it.className)
      result.deleted.push(it.instancePath)
    } catch (e) {
      result.failed.push({ instancePath: it.instancePath, error: e instanceof Error ? e.message : String(e) })
    }
  }
  return result
}
