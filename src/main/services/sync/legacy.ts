// The project's own Studio sync plugin (tools/studio-sync.py's StudioSyncPlugin), which the template
// and FSF dev scripts copy into the Studio plugins folder as RepoStudioSync.lua / FSFStudioSync.lua.
// With Forge Sync on, it would push into the same files a second time, so Forge offers to disable it
// (rename to *.disabled; only when the user clicks). No electron imports.

import { readdir, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'

const LEGACY = /studiosync.*\.(lua|luau|rbxm|rbxmx)$/i
const FORGE_OWN = /^forgebridge/i

export function isLegacyPlugin(name: string): boolean {
  return LEGACY.test(name) && !FORGE_OWN.test(name)
}

export async function findLegacyPlugins(dir: string | null): Promise<string[]> {
  if (!dir) return []
  try {
    return (await readdir(dir)).filter(isLegacyPlugin).sort().map((name) => join(dir, name))
  } catch {
    return []
  }
}

// Renames each legacy plugin to <name>.disabled (Studio only loads .lua/.luau/.rbxm/.rbxmx), replacing
// an older .disabled copy. Returns the renamed paths.
export async function disableLegacyPlugins(dir: string | null): Promise<string[]> {
  const found = await findLegacyPlugins(dir)
  const done: string[] = []
  for (const file of found) {
    await rm(`${file}.disabled`, { force: true })
    await rename(file, `${file}.disabled`)
    done.push(file)
  }
  return done
}
