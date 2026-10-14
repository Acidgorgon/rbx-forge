// What a quick bundle must match in the installed app ("shell"): the Electron version (which fixes
// Node's ABI) and the exact version of every production package the app ships in its own
// node_modules. Quick bundles carry only out/ (main, preload, renderer); everything else comes
// from the installed app, so a bundle built against different packages could load the wrong code.
//
// Both sides read package-lock.json: electron.vite.config.ts bakes it into the app's bootstrap at
// build time, and build/quick-bundle.ts records it in the signed manifest. npm ci installs exactly
// the lockfile, so equal maps mean equal node_modules. Pure; no electron imports.

export interface ShellInfo {
  // Electron version (process.versions.electron); it determines the native module ABI.
  electron: string
  // Native packages (subset of deps), listed first when they differ.
  native: Record<string, string>
  // Every production package in the lockfile: install path below node_modules -> version.
  deps: Record<string, string>
}

// Packages with compiled code that is loaded into the main process.
export const NATIVE_PACKAGES = ['node-pty']

interface LockPackage {
  version?: string
  dev?: boolean
  devOptional?: boolean
  link?: boolean
}

export function shellInfoFromLock(lock: { packages?: Record<string, LockPackage> }): ShellInfo {
  const packages = lock?.packages ?? {}
  const electron = packages['node_modules/electron']?.version
  if (!electron) throw new Error('package-lock.json has no node_modules/electron')
  const deps: Record<string, string> = {}
  for (const [path, info] of Object.entries(packages)) {
    if (!path.startsWith('node_modules/') || info.dev || info.link || !info.version) continue
    deps[path.slice('node_modules/'.length)] = info.version
  }
  const native: Record<string, string> = {}
  for (const name of NATIVE_PACKAGES) if (deps[name]) native[name] = deps[name]
  return { electron, native, deps: sortKeys(deps) }
}

function sortKeys(map: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const key of Object.keys(map).sort()) out[key] = map[key]
  return out
}

export type CompatResult = { ok: true } | { ok: false; reasons: string[] }

// Can code built with `bundle` run in the installed app `shell`? Reasons are short, user-facing.
export function checkCompat(bundle: ShellInfo, shell: ShellInfo): CompatResult {
  const reasons: string[] = []
  if (bundle.electron !== shell.electron) reasons.push(`Electron ${shell.electron} -> ${bundle.electron}`)
  const names = new Set([...Object.keys(bundle.native ?? {}), ...Object.keys(shell.native ?? {})])
  for (const name of names) {
    const a = shell.native?.[name]
    const b = bundle.native?.[name]
    if (a !== b) reasons.push(`${name} ${a ?? 'missing'} -> ${b ?? 'removed'}`)
  }
  const changed: string[] = []
  for (const name of new Set([...Object.keys(bundle.deps ?? {}), ...Object.keys(shell.deps ?? {})])) {
    if (names.has(name)) continue
    const a = shell.deps?.[name]
    const b = bundle.deps?.[name]
    if (a !== b) changed.push(`${name} ${a ?? 'missing'} -> ${b ?? 'removed'}`)
  }
  changed.sort()
  if (changed.length > 3) reasons.push(`${changed.slice(0, 3).join(', ')} and ${changed.length - 3} more packages`)
  else reasons.push(...changed)
  return reasons.length ? { ok: false, reasons } : { ok: true }
}
