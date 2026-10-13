// Loads node-pty (native) lazily, so a missing or broken binary disables the terminal instead of
// crashing the main process. node-pty 1.1.0 ships N-API prebuilds for darwin-arm64/x64 and
// win32-x64/arm64 (prebuilds/<platform>-<arch>), which load in Electron without a rebuild; Linux
// builds from source on install.

import { chmodSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { createRequire } from 'node:module'
import type { PtySpawn } from './ptyManager.ts'

export type PtyBackend = { spawn: PtySpawn; error?: undefined } | { spawn?: undefined; error: string }

let cached: Promise<PtyBackend> | null = null

// The npm tarball stores prebuilds/darwin-*/spawn-helper without the executable bit, and node-pty
// execs it for every terminal ("posix_spawnp failed" otherwise). Packaged apps get it fixed in
// build/afterPack.cjs; this covers development installs.
function fixSpawnHelper(): void {
  if (process.platform !== 'darwin') return
  try {
    const req = createRequire(import.meta.url)
    const root = dirname(dirname(req.resolve('node-pty')))
    for (const dir of [join(root, 'build', 'Release'), join(root, 'prebuilds', `darwin-${process.arch}`)]) {
      const helper = join(dir, 'spawn-helper').replace('/app.asar/', '/app.asar.unpacked/')
      try {
        const mode = statSync(helper).mode
        if ((mode & 0o111) !== 0o111) chmodSync(helper, mode | 0o755)
      } catch {
        // missing or read-only (packaged: already fixed)
      }
    }
  } catch {
    // resolve failed; the import below reports it
  }
}

// On Windows, node-pty starts a worker thread from a script next to its lib/ (conpty output) and
// only maps node_modules.asar paths to their unpacked copies, not app.asar. Loading it straight from
// app.asar.unpacked gives it real paths. macOS keeps the normal path: node-pty itself maps
// app.asar -> app.asar.unpacked for spawn-helper and would double that suffix.
function loadModule(): unknown {
  const req = createRequire(import.meta.url)
  const resolved = req.resolve('node-pty')
  const marker = `${sep}app.asar${sep}`
  if (process.platform === 'win32' && resolved.includes(marker)) {
    return req(resolved.replace(marker, `${sep}app.asar.unpacked${sep}`))
  }
  return req('node-pty')
}

export function loadPtyBackend(): Promise<PtyBackend> {
  cached ??= (async (): Promise<PtyBackend> => {
    try {
      fixSpawnHelper()
      const mod: any = loadModule()
      const spawn = mod.spawn ?? mod.default?.spawn
      if (typeof spawn !== 'function') return { error: 'node-pty has no spawn()' }
      return { spawn: (file, args, options) => spawn(file, args, options) }
    } catch (error) {
      return { error: `node-pty could not load: ${(error as Error).message}` }
    }
  })()
  return cached
}
