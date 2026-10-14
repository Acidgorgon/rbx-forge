// Zip path safety for quick bundles (pure; tested). A bundle may only contain the app's own code
// folders, and no entry may point outside the folder it is unpacked into (zip slip), collide with
// another entry on a case-insensitive disk, or use names Windows cannot create.

export const BUNDLE_ROOTS = ['main', 'preload', 'renderer']
const MAX_PATH = 240
const MAX_FILES = 20000
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])(\..*)?$/i

// The normalized relative path ("main/app.js") or null when the name is unsafe. Directory entries
// ("renderer/assets/") are accepted with the trailing slash removed.
export function safeZipPath(name: unknown): string | null {
  if (typeof name !== 'string' || !name || name.length > MAX_PATH) return null
  // Backslashes (Windows separators), drive letters and alternate data streams, absolute paths.
  if (/[\\:\0]/.test(name) || name.startsWith('/')) return null
  // Control characters and characters Windows refuses in file names.
  if (/[\x00-\x1f\x7f<>"|?*]/.test(name)) return null
  const path = name.endsWith('/') ? name.slice(0, -1) : name
  const parts = path.split('/')
  for (const part of parts) {
    if (!part || part === '.' || part === '..') return null
    if (part.endsWith(' ') || part.endsWith('.')) return null
    if (WINDOWS_RESERVED.test(part)) return null
  }
  if (!BUNDLE_ROOTS.includes(parts[0])) return null
  return parts.join('/')
}

export interface ZipEntryName {
  name: string
  directory: boolean
}

// Checks a bundle's entries against the manifest's file list: every file entry is safe, listed and
// unique (also ignoring case), and every listed file is present. Throws with the first problem.
export function checkZipEntries(entries: ZipEntryName[], files: Record<string, string>): void {
  if (entries.length > MAX_FILES * 2) throw new Error('The bundle has too many entries')
  const seen = new Set<string>()
  for (const entry of entries) {
    const path = safeZipPath(entry.name)
    if (path === null) throw new Error(`Unsafe path in the bundle: ${JSON.stringify(String(entry.name).slice(0, 120))}`)
    if (entry.directory) continue
    if (!Object.prototype.hasOwnProperty.call(files, path)) throw new Error(`The bundle has a file the manifest does not list: ${path}`)
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Error(`The bundle lists ${path} twice`)
    seen.add(key)
  }
  for (const path of Object.keys(files)) {
    if (!seen.has(path.toLowerCase())) throw new Error(`The bundle is missing ${path}`)
  }
}

export function checkFileList(files: Record<string, string>): void {
  const keys = Object.keys(files)
  if (!keys.length || keys.length > MAX_FILES) throw new Error(`The manifest lists ${keys.length} files`)
  const seen = new Set<string>()
  for (const path of keys) {
    if (safeZipPath(path) !== path || !path.includes('/')) throw new Error(`Unsafe path in the manifest: ${JSON.stringify(path.slice(0, 120))}`)
    const key = path.toLowerCase()
    if (seen.has(key)) throw new Error(`The manifest lists ${path} twice`)
    seen.add(key)
    if (!/^[0-9a-f]{64}$/.test(files[path])) throw new Error(`Bad sha256 for ${path}`)
  }
}
